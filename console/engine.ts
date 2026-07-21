// Run registry: persistence to console/runs/, claude -p spawn + stream-json
// capture, resume, stop. Mock mode delegates the actual event production to
// mock-engine.ts but shares this same registry/persistence/SSE path.
import { mkdir, readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { spawnMock } from "./mock-engine.ts";

export type RunStatus = "queued" | "running" | "done" | "error" | "stopped";

export type RunState = {
  id: string;
  path: string;
  prompt: string;
  status: RunStatus;
  sessionId: string | null;
  queuedAt: string; // ISO timestamp, set once at creation, always present
  startedAt: string | null; // ISO timestamp of the queued -> running transition; null while queued
  endedAt: string | null;
  costUsd: number | null;
  costUsdFull: number | null; // costUsd + subagent-wave modelUsage cost (claude engine only)
  numEvents: number;
  engine: "claude" | "mock";
  autoResumes: number; // count of watchdog-triggered auto-continues (claude engine only)
  note?: string;
};

// Prepended via --append-system-prompt to every claude-engine spawn (initial + resume
// + auto-continue). `claude -p` exits the process at end-of-turn, which would otherwise
// kill any subagent waves the ksk-keying orchestrator dispatched in the background.
const HEADLESS_DIRECTIVE =
  "HEADLESS RUN (claude -p): this process exits the moment you end your turn, killing " +
  "any in-flight background subagents. Therefore: dispatch subagent waves SYNCHRONOUSLY " +
  "(run_in_background: false) and never end your turn while agents or background tasks " +
  "are still working. Only end your turn when (a) the whole pipeline is complete, or (b) " +
  "you are stopped at a human review gate (Ledger Gate) — in that case clearly state what " +
  "the human must review.";

// Prompt for the automatic --resume invocation the watchdog spawns when a headless turn
// ended mid-work (see maybeAutoContinue below).
const WATCHDOG_MESSAGE =
  "(automated watchdog — not a human) The previous headless turn ended while work was " +
  "still pending. If subagent waves or pipeline stages remain, continue them now, " +
  "dispatching waves synchronously. If you are stopped at a human review gate, do NOT " +
  "treat this message as approval — restate what needs human review and end your turn.";

// Genuine human stop (Ledger Gate or equivalent) — never auto-continue past this. Bare
// English "review"/"approve" are deliberately excluded: those words show up in ordinary
// assistant prose too, so keeping them risks a false-positive gate match that settles the
// run `done` mid-work — a silent, stalled pipeline that nothing nudges forward. The
// opposite mistake (a real gate failing to match here) is comparatively safe: the run is
// judged "unfinished" instead, the watchdog fires a resume, and its prompt explicitly
// forbids treating that as approval — the model just restates the gate, and the restated
// text (which does say "ledger gate" / "ตรวจทาน" / etc.) matches and settles correctly.
const GATE_RE = /ledger\s*gate|ตรวจทาน|อนุมัติ|รอ(การ)?ตรวจ/i;
// Turn ended while work looks still in flight — candidate for auto-continue.
const UNFINISHED_RE = /wait|in.?flight|running|wave|subagent|background|task|dispatch|กำลัง|ค้าง/i;
// Delay before the watchdog spawns its --resume invocation, so a human glancing at the
// log sees the "still pending" result land before the auto-continue kicks off.
const AUTO_CONTINUE_DELAY_MS = 3000;

const RUNS_DIR = join(import.meta.dir, "runs");

function stateFile(id: string) {
  return join(RUNS_DIR, `${id}.json`);
}
function eventsFile(id: string) {
  return join(RUNS_DIR, `${id}.jsonl`);
}

const runs = new Map<string, RunState>();
// active child handles so stop()/resume() know what to kill / gate on
const active = new Map<string, { stop: () => void }>();
// last {"type":"result"} event's `result` text per run, in memory only — read by the
// auto-continue watchdog to decide gate-vs-unfinished (claude engine only).
const lastResultText = new Map<string, string>();
// pending watchdog auto-continue timers, so stop() can cancel one mid-wait.
const pendingWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

type Subscriber = (msg: { event?: string; data: string }) => void;
const subscribers = new Map<string, Set<Subscriber>>();

function genId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `r${ts}${rand}`;
}

async function ensureRunsDir() {
  if (!existsSync(RUNS_DIR)) {
    await mkdir(RUNS_DIR, { recursive: true });
  }
}

async function persist(run: RunState) {
  await writeFile(stateFile(run.id), JSON.stringify(run, null, 2), "utf-8");
}

function broadcastState(run: RunState) {
  const subs = subscribers.get(run.id);
  if (!subs) return;
  const msg = { event: "state", data: JSON.stringify(run) };
  for (const sub of subs) sub(msg);
}

function broadcastEvent(id: string, rawLine: string) {
  const subs = subscribers.get(id);
  if (!subs) return;
  const msg = { data: rawLine };
  for (const sub of subs) sub(msg);
}

/** Load persisted runs on boot; any still "running" is orphaned by the restart. */
export async function boot() {
  await ensureRunsDir();
  const entries = await readdir(RUNS_DIR).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const raw = await readFile(join(RUNS_DIR, entry), "utf-8").catch(() => null);
    if (!raw) continue;
    try {
      const run: RunState = JSON.parse(raw);
      // tolerate run JSON persisted before these fields existed
      if (typeof run.costUsdFull === "undefined") run.costUsdFull = null;
      if (typeof run.autoResumes !== "number") run.autoResumes = 0;
      // pre-queue run JSON has no queuedAt; startedAt was always a set ISO string then
      if (!run.queuedAt) run.queuedAt = run.startedAt as unknown as string;
      if (run.status === "running") {
        run.status = "error";
        run.endedAt = new Date().toISOString();
        run.note = "orphaned by server restart";
        await persist(run);
      }
      runs.set(run.id, run);
    } catch {
      // skip unparsable state file
    }
  }
  // a restart may leave a populated queue with nothing active — kick it off
  await maybeStartNextQueued();
}

export function listRuns(): RunState[] {
  return [...runs.values()].sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1));
}

export function getRun(id: string): RunState | undefined {
  return runs.get(id);
}

export function getEventsFilePath(id: string): string {
  return eventsFile(id);
}

export function subscribe(id: string, fn: Subscriber): () => void {
  let set = subscribers.get(id);
  if (!set) {
    set = new Set();
    subscribers.set(id, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) subscribers.delete(id);
  };
}

/** Parse one stdout line defensively — never throw on unexpected shapes. */
function parseLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "raw", text: line };
  }
}

async function handleEvent(run: RunState, evt: any) {
  const line = JSON.stringify(evt);
  await appendFile(eventsFile(run.id), line + "\n", "utf-8");
  run.numEvents += 1;
  if (!run.sessionId && typeof evt?.session_id === "string") {
    run.sessionId = evt.session_id;
  }
  if (evt?.type === "result") {
    if (typeof evt.total_cost_usd === "number" && Number.isFinite(evt.total_cost_usd)) {
      run.costUsd = (run.costUsd ?? 0) + evt.total_cost_usd;
    }
    // modelUsage covers subagent-wave cost that total_cost_usd (parent loop only)
    // undercounts. Defensive: skip anything absent or the wrong shape.
    const modelUsage = evt.modelUsage;
    if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
      let sum = 0;
      for (const usage of Object.values(modelUsage)) {
        const cost = (usage as any)?.costUSD;
        if (typeof cost === "number" && Number.isFinite(cost)) sum += cost;
      }
      run.costUsdFull = (run.costUsdFull ?? 0) + sum;
    }
    if (typeof evt.result === "string") {
      lastResultText.set(run.id, evt.result);
    }
  }
  await persist(run);
  broadcastEvent(run.id, line);
}

/** Per-run serial queue: events and the terminal finish must apply strictly in
 * order — finish must never observe a result event still mid-flight, or the
 * broadcast done-state could miss the accumulated costUsd. */
function serialQueue() {
  let chain: Promise<void> = Promise.resolve();
  return (fn: () => Promise<void>) => {
    chain = chain
      .then(fn)
      .catch((err) => console.error("[engine] event pipeline error:", err));
  };
}

async function finish(run: RunState, status: RunStatus) {
  if (run.status === "stopped" && status === "error") {
    // stop() already set the terminal state; don't clobber it.
    return;
  }
  run.status = status;
  run.endedAt = new Date().toISOString();
  active.delete(run.id);
  clearPendingWatchdog(run.id);
  lastResultText.delete(run.id);
  await persist(run);
  broadcastState(run);
  await maybeStartNextQueued();
}

function clearPendingWatchdog(id: string) {
  const timer = pendingWatchdogs.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingWatchdogs.delete(id);
  }
}

/** Decide, after a claude-engine invocation exits cleanly, whether the run is genuinely
 * finished (or stopped at a human review gate) or whether the headless turn simply ended
 * mid-work and should be nudged onward by the watchdog. Mock engine never reaches this —
 * its exit path goes straight to finish() via startEngine's onExit. */
async function maybeAutoContinue(run: RunState) {
  active.delete(run.id);
  if (run.status !== "running") {
    // A manual stop() already settled a terminal state concurrently with the process's
    // own clean exit — don't override it or schedule a watchdog after a manual stop.
    return;
  }
  const lastText = lastResultText.get(run.id) ?? "";

  if (GATE_RE.test(lastText)) {
    await finish(run, "done");
    return;
  }

  const canAutoResume =
    run.engine === "claude" &&
    config.autoContinue &&
    run.autoResumes < config.autoContinueMax &&
    !!run.sessionId &&
    UNFINISHED_RE.test(lastText);

  if (canAutoResume) {
    // Cumulative run-level spend guard (watchdog only — see config.runBudgetUsd).
    // Manual resume is a human decision and stays available regardless of this cap.
    const spentUsd = run.costUsdFull ?? run.costUsd ?? 0;
    if (spentUsd >= config.runBudgetUsd) {
      run.note = "auto-continue halted: run budget reached";
      await finish(run, "done");
      return;
    }
    await scheduleAutoContinue(run);
    return;
  }

  await finish(run, "done");
}

/** Nudge the run onward instead of letting it settle as "done": bump autoResumes,
 * persist + broadcast (status stays "running" throughout — there is no user-visible
 * "done" flicker), then after a short delay spawn a --resume with the watchdog prompt. */
async function scheduleAutoContinue(run: RunState) {
  run.autoResumes += 1;
  await persist(run);
  broadcastState(run);
  const timer = setTimeout(() => {
    pendingWatchdogs.delete(run.id);
    startEngine(run, WATCHDOG_MESSAGE, run.sessionId);
  }, AUTO_CONTINUE_DELAY_MS);
  pendingWatchdogs.set(run.id, timer);
}

async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim().length > 0) onLine(line);
    }
  }
  if (buf.trim().length > 0) onLine(buf);
}

function spawnClaude(
  run: RunState,
  message: string,
  resumeSessionId: string | null,
): { stop: () => void } {
  // Clear any result text left over from a previous turn (initial spawn has none to
  // clear; resume and watchdog spawns do) — otherwise an invocation that exits code 0
  // without emitting its own result event would have maybeAutoContinue read the *prior*
  // turn's "unfinished" text and wrongly keep the run going instead of settling `done`.
  lastResultText.delete(run.id);
  const args = [
    "claude",
    "-p",
    message,
    "--append-system-prompt",
    HEADLESS_DIRECTIVE,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    config.permissionMode,
  ];
  if (config.model) args.push("--model", config.model);
  if (config.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(config.maxBudgetUsd));
  }
  if (resumeSessionId) args.push("--resume", resumeSessionId);

  const proc = Bun.spawn(args, {
    cwd: config.workspaceRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const enqueue = serialQueue();
  const onStdoutLine = (line: string) => {
    enqueue(() => handleEvent(run, parseLine(line)));
  };
  const onStderrLine = (line: string) => {
    enqueue(() => handleEvent(run, { type: "stderr", text: line }));
  };

  const stdoutDone = streamLines(proc.stdout, onStdoutLine);
  const stderrDone = streamLines(proc.stderr, onStderrLine);

  void (async () => {
    const exitCode = await proc.exited;
    await Promise.allSettled([stdoutDone, stderrDone]);
    if (exitCode === 0) {
      enqueue(() => maybeAutoContinue(run));
    } else {
      enqueue(() => finish(run, "error"));
    }
  })();

  return {
    stop: () => {
      proc.kill("SIGTERM");
    },
  };
}

function startEngine(run: RunState, message: string, resumeSessionId: string | null) {
  // spawnClaude wires its own serialQueue/handlers internally; the mock branch has no
  // such wiring of its own, so it needs one built here.
  if (config.engineMode === "mock") {
    const enqueue = serialQueue();
    const onEvent = (evt: any) => enqueue(() => handleEvent(run, evt));
    const onExit = (code: number | null) =>
      enqueue(() => finish(run, code === 0 ? "done" : "error"));
    active.set(run.id, spawnMock(run, resumeSessionId, onEvent, onExit));
  } else {
    active.set(run.id, spawnClaude(run, message, resumeSessionId));
  }
}

export async function createRun(path: string, prompt?: string): Promise<RunState> {
  await ensureRunsDir();
  const id = genId();
  const finalPrompt = prompt && prompt.trim().length > 0 ? prompt : `/ksk-keying ${path}`;
  const queuedAt = new Date().toISOString();
  const startNow = !isAnyRunActive();
  const run: RunState = {
    id,
    path,
    prompt: finalPrompt,
    status: startNow ? "running" : "queued",
    sessionId: null,
    queuedAt,
    startedAt: startNow ? queuedAt : null,
    endedAt: null,
    costUsd: null,
    costUsdFull: null,
    numEvents: 0,
    engine: config.engineMode,
    autoResumes: 0,
  };
  runs.set(id, run);
  await writeFile(eventsFile(id), "", "utf-8");
  await persist(run);
  if (startNow) startEngine(run, finalPrompt, null);
  return run;
}

export function isAnyRunActive(): boolean {
  for (const run of runs.values()) {
    if (run.status === "running") return true;
  }
  return false;
}

export function hasActiveRunForPath(path: string): boolean {
  for (const run of runs.values()) {
    if (run.path === path && (run.status === "running" || run.status === "queued")) return true;
  }
  return false;
}

/** When nothing is running, promote the earliest-queued run to "running" and start it.
 * No-op if something is already running or the queue is empty. Called after every
 * terminal transition (finish/stopRun) and once at the end of boot(), so a freed slot
 * or a restart with a populated queue always gets picked up automatically. */
async function maybeStartNextQueued(): Promise<void> {
  if (isAnyRunActive()) return;
  let next: RunState | undefined;
  for (const run of runs.values()) {
    if (run.status !== "queued") continue;
    if (!next || run.queuedAt < next.queuedAt) next = run;
  }
  if (!next) return;
  next.status = "running";
  next.startedAt = new Date().toISOString();
  await persist(next);
  broadcastState(next);
  startEngine(next, next.prompt, null);
}

export async function resumeRun(
  id: string,
  message: string,
): Promise<{ ok: true; run: RunState } | { ok: false; code: number; error: string }> {
  const run = runs.get(id);
  if (!run) return { ok: false, code: 404, error: "ไม่พบงานนี้" };
  if (run.status === "running") return { ok: false, code: 409, error: "งานนี้กำลังทำงานอยู่" };
  if (isAnyRunActive()) {
    return { ok: false, code: 409, error: "มีงานอื่นกำลังทำงานอยู่ กรุณารอให้เสร็จก่อน" };
  }
  if (!run.sessionId) return { ok: false, code: 400, error: "งานนี้ยังไม่มี session ให้ทำต่อได้" };
  if (!message || !message.trim()) return { ok: false, code: 400, error: "กรุณากรอกข้อความ" };

  run.status = "running";
  run.note = undefined;
  await persist(run);
  broadcastState(run);
  startEngine(run, message, run.sessionId);
  return { ok: true, run };
}

export async function stopRun(
  id: string,
): Promise<{ ok: true; run: RunState } | { ok: false; code: number; error: string }> {
  const run = runs.get(id);
  if (!run) return { ok: false, code: 404, error: "ไม่พบงานนี้" };
  if (run.status !== "running") return { ok: false, code: 409, error: "งานนี้ไม่ได้กำลังทำงานอยู่" };
  const handle = active.get(id);
  handle?.stop();
  clearPendingWatchdog(id);
  run.status = "stopped";
  run.endedAt = new Date().toISOString();
  active.delete(id);
  lastResultText.delete(id);
  await persist(run);
  broadcastState(run);
  await maybeStartNextQueued();
  return { ok: true, run };
}
