// Bun.serve entrypoint: API routes, SSE (replay + live + state + heartbeat),
// /files with a traversal guard, and static public/. Binds 127.0.0.1 only.
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, sep, extname } from "node:path";
import { config } from "./config.ts";
import {
  boot,
  createRun,
  getEventsFilePath,
  getRun,
  hasActiveRunForPath,
  listRuns,
  resumeRun,
  stopRun,
  subscribe,
} from "./engine.ts";
import { ensureDemoWorkspace } from "./mock-engine.ts";

const PUBLIC_DIR = join(import.meta.dir, "public");

function json(body: unknown, init: number | ResponseInit = 200): Response {
  const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
  return new Response(JSON.stringify(body), {
    ...responseInit,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(responseInit.headers ?? {}),
    },
  });
}

/** Resolve a POSIX-relative `path` under workspaceRoot, guarding traversal.
 * Returns null if the decoded+resolved path escapes the root. */
function resolveUnderRoot(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const resolved = resolve(config.workspaceRoot, "." + sep + decoded);
  const rel = relative(config.workspaceRoot, resolved);
  if (rel === "" ) return resolved; // root itself
  if (rel.startsWith("..") || resolve(config.workspaceRoot, rel) !== resolved) return null;
  // extra guard against absolute-path escape on odd platforms
  if (!resolved.startsWith(config.workspaceRoot + sep) && resolved !== config.workspaceRoot) {
    return null;
  }
  return resolved;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function listClients() {
  const clients: Array<{ name: string; path: string; months: Array<{ name: string; path: string }> }> = [];
  if (!existsSync(config.workspaceRoot)) return clients;
  const level1 = await readdir(config.workspaceRoot, { withFileTypes: true });
  const clientDirs = level1.filter(
    (e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules",
  );
  clientDirs.sort((a, b) => a.name.localeCompare(b.name, "th"));

  for (const clientDir of clientDirs) {
    const clientPath = join(config.workspaceRoot, clientDir.name);
    const level2 = await readdir(clientPath, { withFileTypes: true }).catch(() => []);
    const monthDirs = level2.filter(
      (e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules",
    );
    monthDirs.sort((a, b) => a.name.localeCompare(b.name, "th"));
    clients.push({
      name: clientDir.name,
      path: clientDir.name,
      months: monthDirs.map((m) => ({
        name: m.name,
        path: toPosix(join(clientDir.name, m.name)),
      })),
    });
  }
  return clients;
}

async function listHtmlFiles(rootPath: string) {
  const files: Array<{ name: string; relPath: string }> = [];

  async function walk(dir: string, relDir: string, depth: number) {
    if (depth > 3) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const entryPath = join(dir, entry.name);
      const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(entryPath, entryRel, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) {
        files.push({ name: entry.name, relPath: entryRel });
      }
    }
  }

  await walk(rootPath, "", 0);
  return files;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filePath = join(PUBLIC_DIR, rel);
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(PUBLIC_DIR) + sep) && resolved !== resolve(PUBLIC_DIR)) {
    return new Response("forbidden", { status: 403 });
  }
  if (!existsSync(resolved)) return new Response("not found", { status: 404 });
  const body = await readFile(resolved);
  return new Response(body, { headers: { "content-type": contentTypeFor(resolved) } });
}

function sseResponse(runId: string): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (msg: { event?: string; data: string }) => {
        let chunk = "";
        if (msg.event) chunk += `event: ${msg.event}\n`;
        chunk += `data: ${msg.data}\n\n`;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // controller already closed; subscriber cleanup happens on cancel
        }
      };

      // 1. Replay full jsonl history.
      const eventsPath = getEventsFilePath(runId);
      if (existsSync(eventsPath)) {
        const raw = await readFile(eventsPath, "utf-8").catch(() => "");
        for (const line of raw.split("\n")) {
          if (line.trim().length > 0) send({ data: line });
        }
      }

      // 2. Send current state once so the client is in sync before live events.
      const run = getRun(runId);
      if (run) send({ event: "state", data: JSON.stringify(run) });

      // 3. Subscribe to live events + state changes.
      unsubscribe = subscribe(runId, send);

      // 4. Heartbeat every 15s.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // stream closed
        }
      }, 15000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

await boot();
await ensureDemoWorkspace();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/config" && req.method === "GET") {
        return json({
          workspaceRoot: config.workspaceRoot,
          engineMode: config.engineMode,
          permissionMode: config.permissionMode,
          model: config.model ?? null,
          port: config.port,
        });
      }

      if (pathname === "/api/clients" && req.method === "GET") {
        return json({ clients: await listClients() });
      }

      if (pathname === "/api/runs" && req.method === "POST") {
        const body = await req.json().catch(() => ({}) as any);
        const rawPath: string = typeof body?.path === "string" ? body.path : "";
        const resolved = resolveUnderRoot(rawPath);
        if (!resolved || !existsSync(resolved) || !(await stat(resolved)).isDirectory()) {
          return json({ error: "ไม่พบโฟลเดอร์ที่เลือก" }, 400);
        }
        const relPosix = toPosix(relative(config.workspaceRoot, resolved));
        if (hasActiveRunForPath(relPosix)) {
          return json({ error: "ลูกค้ารายนี้กำลังทำงานหรืออยู่ในคิวอยู่แล้ว" }, 409);
        }
        const run = await createRun(relPosix, typeof body?.prompt === "string" ? body.prompt : undefined);
        return json({ run }, 201);
      }

      if (pathname === "/api/runs" && req.method === "GET") {
        return json({ runs: listRuns() });
      }

      const runIdMatch = pathname.match(/^\/api\/runs\/([^/]+)(\/(events|resume|stop))?$/);
      if (runIdMatch) {
        const runId = decodeURIComponent(runIdMatch[1]);
        const sub = runIdMatch[3];

        if (!sub && req.method === "GET") {
          const run = getRun(runId);
          if (!run) return json({ error: "ไม่พบงานนี้" }, 404);
          return json({ run });
        }

        if (sub === "events" && req.method === "GET") {
          if (!getRun(runId)) return json({ error: "ไม่พบงานนี้" }, 404);
          return sseResponse(runId);
        }

        if (sub === "resume" && req.method === "POST") {
          const body = await req.json().catch(() => ({}) as any);
          const message = typeof body?.message === "string" ? body.message : "";
          const result = await resumeRun(runId, message);
          if (!result.ok) return json({ error: result.error }, result.code);
          return json({ run: result.run });
        }

        if (sub === "stop" && req.method === "POST") {
          const result = await stopRun(runId);
          if (!result.ok) return json({ error: result.error }, result.code);
          return json({ run: result.run });
        }
      }

      if (pathname === "/api/html" && req.method === "GET") {
        const rawPath = url.searchParams.get("path") ?? "";
        const resolved = resolveUnderRoot(rawPath);
        if (!resolved || !existsSync(resolved) || !(await stat(resolved)).isDirectory()) {
          return json({ error: "path is not an existing directory under workspaceRoot" }, 400);
        }
        return json({ files: await listHtmlFiles(resolved) });
      }

      if (pathname.startsWith("/files/")) {
        if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
        const rawPath = pathname.slice("/files/".length);
        const resolved = resolveUnderRoot(rawPath);
        if (!resolved) return new Response("forbidden", { status: 403 });
        if (!existsSync(resolved) || !(await stat(resolved)).isFile()) {
          return new Response("not found", { status: 404 });
        }
        const body = await readFile(resolved);
        return new Response(body, { headers: { "content-type": contentTypeFor(resolved) } });
      }

      if (
        pathname === "/" ||
        pathname === "/app.js" ||
        pathname === "/style.css" ||
        pathname.startsWith("/public/")
      ) {
        return serveStatic(pathname === "/" ? "/index.html" : pathname);
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: "เกิดข้อผิดพลาดภายในระบบ" }, 500);
    }
  },
});

console.log(
  `KSK console listening on http://127.0.0.1:${server.port} ` +
    `(engine=${config.engineMode}, workspaceRoot=${config.workspaceRoot})`,
);
