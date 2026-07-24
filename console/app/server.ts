// Bun.serve entrypoint for the new review app (wayfinder ticket #38: plain
// Bun.serve, no framework — ticket #30). This is a SEPARATE process/app from
// console/server.ts (the old /ksk-keying interactive console, untouched) —
// they can run side by side, per the Phase 1 roadmap's naming note.
//
// Route surface is intentionally the foundation only: client/month listing,
// starting/retrying a run, and live status over SSE. The actual review UI
// (dashboard, excluded/skip review, category/group review) is tickets
// #39/#40/#41, layered on top of these same routes and the orchestrator.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { renderDashboard, toDashboardMonth, toDisplayStatus, type DashboardClient } from "./dashboard";
import { confirmClaim } from "./dispositions-writer";
import { renderExcludedReview, type ExcludedReviewGuard } from "./excluded-review";
import { config } from "./config";
import { orchestrator } from "./orchestrator";
import {
	buildClaims,
	hasAnyExcludedEntries,
	hasReferenceReportCheckFile,
	readDispositions,
	readReviewedUnitsByGroup,
} from "./review-claims";
import { listClientMonths, readCompanyName, readLedgerCounts, resolveUnderRoot } from "./workspace";
import { buildXlsxPreviewMap } from "./xlsx-preview";

const PUBLIC_DIR = join(import.meta.dir, "public");

function json(body: unknown, init: number | ResponseInit = 200): Response {
	const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
	return new Response(JSON.stringify(body), {
		...responseInit,
		headers: { "content-type": "application/json; charset=utf-8", ...(responseInit.headers ?? {}) },
	});
}

async function buildDashboardClients(): Promise<DashboardClient[]> {
	const clientMonths = await listClientMonths(config.workspaceRoot);
	const byClient = new Map<string, DashboardClient>();
	for (const cm of clientMonths) {
		let entry = byClient.get(cm.clientId);
		if (!entry) {
			entry = {
				clientId: cm.clientId,
				companyName: await readCompanyName(join(config.workspaceRoot, cm.clientId)),
				months: [],
			};
			byClient.set(cm.clientId, entry);
		}
		const run = orchestrator.getRun(cm.relPath) ?? null;
		const units = run?.state.status === "done" ? await readLedgerCounts(join(config.workspaceRoot, cm.relPath)) : null;
		entry.months.push(toDashboardMonth(cm.monthId, cm.relPath, run, units));
	}
	return [...byClient.values()];
}

/** Both confirm and (future) bring-back are only ever actionable once a run
 * has settled — reviewing a page that's about to change underneath you makes
 * no sense (ticket #40's spec). Derives from the same displayStatus
 * dashboard.ts already computes rather than re-deriving active/queued
 * directly, so there's exactly one definition of "is this run mid-flight". */
function reviewGuard(relPath: string): ExcludedReviewGuard {
	const status = toDisplayStatus(orchestrator.getRun(relPath) ?? null);
	if (status === "stage-running" || status === "gate-running") {
		return { disabled: true, message: "งานนี้กำลังทำงานอยู่ ไม่สามารถตรวจสอบได้ตอนนี้" };
	}
	if (status === "queued") return { disabled: true, message: "งานนี้กำลังรอคิวอยู่ ไม่สามารถตรวจสอบได้ตอนนี้" };
	return { disabled: false, message: null };
}

const FILE_CONTENT_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls": "application/vnd.ms-excel",
};

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
};

async function serveStatic(pathname: string): Promise<Response> {
	const rel = pathname.replace(/^\//, "");
	const filePath = join(PUBLIC_DIR, rel);
	const resolved = resolve(filePath);
	if (!resolved.startsWith(resolve(PUBLIC_DIR) + sep) && resolved !== resolve(PUBLIC_DIR)) {
		return new Response("forbidden", { status: 403 });
	}
	if (!existsSync(resolved)) return new Response("not found", { status: 404 });
	const body = await readFile(resolved);
	const contentType = CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
	return new Response(body, { headers: { "content-type": contentType } });
}

function sseResponse(relPath: string): Response {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					// controller already closed; cleanup happens on cancel
				}
			};
			const current = orchestrator.getRun(relPath);
			if (current) send(current);
			unsubscribe = orchestrator.subscribe(relPath, send);
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
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
	});
}

await orchestrator.boot(config.workspaceRoot, config.concurrency);

const server = Bun.serve({
	hostname: config.host,
	port: config.port,
	async fetch(req) {
		const url = new URL(req.url);
		const { pathname } = url;

		try {
			if (pathname === "/api/config" && req.method === "GET") {
				return json({ workspaceRoot: config.workspaceRoot, concurrency: config.concurrency, port: config.port });
			}

			if (pathname === "/api/clients" && req.method === "GET") {
				return json({ clients: await buildDashboardClients() });
			}

			if (pathname === "/api/runs" && req.method === "GET") {
				return json({ runs: orchestrator.listRuns() });
			}

			if (pathname === "/api/runs" && req.method === "POST") {
				const body = await req.json().catch(() => ({}) as any);
				const rawPath: string = typeof body?.path === "string" ? body.path : "";
				const resolved = resolveUnderRoot(config.workspaceRoot, rawPath);
				if (!resolved || !existsSync(resolved) || !(await stat(resolved)).isDirectory()) {
					return json({ error: "ไม่พบโฟลเดอร์ที่เลือก" }, 400);
				}
				const relPath = rawPath.replace(/^\/+/, "");
				const result = await orchestrator.enqueueRun(relPath);
				if (!result.ok) return json({ error: result.error }, result.code);
				return json({ run: result.run }, 201);
			}

			const runMatch = pathname.match(/^\/api\/runs\/([^/]+)\/([^/]+)(\/(events|retry|claims\/confirm))?$/);
			if (runMatch) {
				const relPath = `${decodeURIComponent(runMatch[1])}/${decodeURIComponent(runMatch[2])}`;
				const sub = runMatch[4];

				if (!sub && req.method === "GET") {
					const run = orchestrator.getRun(relPath);
					if (!run) return json({ error: "ยังไม่เคยรันงานนี้" }, 404);
					return json({ run });
				}

				if (sub === "events" && req.method === "GET") {
					return sseResponse(relPath);
				}

				if (sub === "retry" && req.method === "POST") {
					const result = await orchestrator.retryRun(relPath);
					if (!result.ok) return json({ error: result.error }, result.code);
					return json({ run: result.run });
				}

				if (sub === "claims/confirm" && req.method === "POST") {
					const guard = reviewGuard(relPath);
					if (guard.disabled) return json({ error: guard.message }, 409);
					const body = await req.json().catch(() => ({}) as any);
					const unitKey = typeof body?.unitKey === "string" ? body.unitKey : "";
					const targetDir = join(config.workspaceRoot, relPath);
					if (!existsSync(targetDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);
					const result = await confirmClaim(targetDir, unitKey);
					if (!result.ok) return json({ error: result.error }, 400);
					return json({ ok: true });
				}
			}

			const reviewPageMatch = pathname.match(/^\/clients\/([^/]+)\/([^/]+)\/excluded-review$/);
			if (reviewPageMatch && req.method === "GET") {
				const clientId = decodeURIComponent(reviewPageMatch[1]);
				const monthId = decodeURIComponent(reviewPageMatch[2]);
				const relPath = `${clientId}/${monthId}`;
				const targetDir = join(config.workspaceRoot, relPath);
				if (!existsSync(targetDir)) return new Response("not found", { status: 404 });

				const [companyName, dispositions, reviewedByGroup] = await Promise.all([
					readCompanyName(join(config.workspaceRoot, clientId)),
					readDispositions(targetDir),
					readReviewedUnitsByGroup(targetDir),
				]);
				const claims = buildClaims(dispositions, reviewedByGroup, hasReferenceReportCheckFile(targetDir));
				return new Response(
					renderExcludedReview({
						clientId,
						monthId,
						companyName,
						claims,
						guard: reviewGuard(relPath),
						hasAnyExcludedEntries: hasAnyExcludedEntries(dispositions),
						xlsxPreviews: buildXlsxPreviewMap(targetDir, claims),
					}),
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				);
			}

			const fileMatch = pathname.match(/^\/files\/([^/]+)\/([^/]+)\/(.+)$/);
			if (fileMatch && req.method === "GET") {
				const clientId = decodeURIComponent(fileMatch[1]);
				const monthId = decodeURIComponent(fileMatch[2]);
				const targetDir = join(config.workspaceRoot, clientId, monthId);
				const resolved = resolveUnderRoot(targetDir, fileMatch[3]);
				if (!resolved || !existsSync(resolved) || !(await stat(resolved)).isFile()) {
					return new Response("not found", { status: 404 });
				}
				const contentType = FILE_CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
				return new Response(await readFile(resolved), { headers: { "content-type": contentType } });
			}

			if (pathname === "/" && req.method === "GET") {
				return new Response(renderDashboard(await buildDashboardClients()), {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			if (pathname.startsWith("/public/") || pathname.endsWith(".css") || pathname.endsWith(".js")) {
				return serveStatic(pathname);
			}

			return new Response("not found", { status: 404 });
		} catch (err) {
			console.error(err);
			return json({ error: "เกิดข้อผิดพลาดภายในระบบ" }, 500);
		}
	},
});

console.log(
	`KSK review app listening on http://${config.host}:${server.port} ` +
		`(concurrency=${config.concurrency}, workspaceRoot=${config.workspaceRoot})`,
);
