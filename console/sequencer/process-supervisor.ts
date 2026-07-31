// Owns the lifecycle of every external command used by the sequencer.
//
// `Subprocess.exited` only describes the direct child.  A shell/Claude process
// can exit while a descendant keeps consuming CPU, so every command is started
// as a new POSIX session/process group and every return path tears that group
// down.  Do not call Bun.spawn directly from sequencer code.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// Windows has no POSIX process groups, no setsid, and no /proc. Every
// group-shaped mechanism below therefore needs a second implementation rather
// than a tweak — see processGroupAlive/signalOwnedProcesses for what replaces
// what, and MUST NOT be "fixed" by passing a negative pid to process.kill:
// that reaches libuv's uv_kill, where the negative number is cast to a DWORD
// that matches no real process, so the call reports ESRCH. Read literally,
// that says "the group is already gone" — which made cleanup a silent no-op
// and left a live `claude -p` behind on every cancelled or timed-out run.
const IS_WINDOWS = process.platform === "win32";

export type ProcessFailureReason = "exited" | "timeout" | "idle-timeout" | "aborted" | "spawn-error" | "cleanup-failed";

export type SupervisedProcessOptions = {
	cmd: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	stdin?: "ignore" | Uint8Array;
	/** Hard elapsed-time limit for the command. */
	timeoutMs?: number;
	/** Maximum time with no stdout or stderr activity. */
	idleTimeoutMs?: number;
	/** Bytes retained per output stream. Streams are still drained after this cap. */
	maxOutputBytes?: number;
	/**
	 * Time to allow SIGTERM before escalating the complete process group.
	 *
	 * POSIX only in practice. Windows has no graceful termination signal for a
	 * console child, so both rungs of the ladder force-kill and the grace
	 * window is skipped rather than spent waiting for a politeness the OS
	 * cannot deliver. It still bounds the post-kill "did they actually go away"
	 * waits on both platforms.
	 */
	termGraceMs?: number;
	/** Time to wait for the inherited output pipes to reach EOF after cleanup. */
	drainGraceMs?: number;
	onStdoutChunk?: (chunk: Uint8Array) => void;
	onStderrChunk?: (chunk: Uint8Array) => void;
	/**
	 * Human-readable name for this call site, logged verbatim on a non-"exited"
	 * reason. Two of the three halts documented in spawn-stage.ts's header
	 * comment were diagnosed only by correlating file mtimes against logs
	 * because nothing ever printed *which* deadline fired or for *what* work —
	 * every caller should pass something that answers "which supervised call
	 * was this" (script name + target, unit id, stage id, …), not just "a
	 * process died". Falls back to cmd[0] so an omission still logs something,
	 * but callers should not rely on that fallback: cmd[0] is usually just
	 * "bun" or "claude" and does not say which invocation.
	 */
	label?: string;
	/**
	 * Evidence check for D2 ("liveness must check evidence, not silence"):
	 * returns a non-negative progress counter (e.g. a file count on disk) that
	 * a healthy-but-silent child is expected to CHANGE over time, or null when
	 * no evidence is available. Called only when the idle timer has already
	 * expired — never on the hot poll path — so it can afford to touch the
	 * filesystem. A throw is treated as "no evidence" (see
	 * `maxLivenessExtensions` for why this can't extend forever).
	 *
	 * NOT REQUIRED TO BE MONOTONIC, and the supervisor deliberately does not
	 * assume it is. The one real probe in the tree (countPreparedPageArtifacts
	 * in spawn-stage.ts) counts files under a client's `_pages` tree, and
	 * prepare.ts does `rmSync(outputDir, {recursive:true})` at the START of
	 * every source it is about to (re-)render — so on any re-run after an
	 * earlier kill, leftover artifacts from a half-finished source vanish and
	 * the total DROPS mid-run while the child is rendering flat out. Requiring
	 * a strict increase would kill exactly that recovery run. So progress is
	 * "the reading CHANGED since the previous expiry", in either direction: a
	 * child that is adding or deleting files is a child doing work. Nothing is
	 * lost by accepting decreases — a genuinely stuck child changes neither.
	 */
	livenessProbe?: () => number | null;
	/**
	 * Caps how many times a changing livenessProbe reading may push the idle
	 * deadline back before this call site reverts to killing on idle silence
	 * regardless of probe evidence (D3: "alive != converging" — liveness earns
	 * more rope, never infinite rope).
	 *
	 * Default: `ceil(timeoutMs / idleTimeoutMs)` — i.e. exactly enough
	 * extensions to reach the wall and not one more. This is deliberately NOT
	 * a constant. A flat cap is the same disease this whole change set exists
	 * to cure, one layer up: at the previous flat default of 5 the effective
	 * idle budget was `idleTimeoutMs × 6` = 30 minutes for EVERY client
	 * regardless of size, so client 336 (2,799 inventory pages, ~85 min of
	 * rendering even after the DPI fix) would have been SIGTERM'd at 30 min,
	 * roughly 450 pages in, while provably converging — the exact failure mode
	 * of the client-345 incident with a bigger number on it.
	 *
	 * Deriving it from the two deadlines already in hand keeps D3 intact: the
	 * wall (timeoutMs) is untouched and still absolute (it is checked first,
	 * every iteration, against a startedAt that is never reset), so extensions
	 * can never outlive it — this cap simply stops being a second, redundant,
	 * size-blind deadline in front of it. It also means an operator has ONE
	 * knob for "let this run longer" (KSK_STAGE_TIMEOUT_MS, see
	 * spawn-stage.ts#deadlines) rather than needing a second env var to unblock
	 * a halt at 2am; raising the wall raises the extension budget with it.
	 */
	maxLivenessExtensions?: number;
};

export type SupervisedProcessResult = {
	pid: number | null;
	exitCode: number | null;
	reason: ProcessFailureReason;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	cleanupComplete: boolean;
};

// Last-resort fallback for a caller that (by omission, not by choice) never
// supplies its own timeoutMs/idleTimeoutMs — every real call site in this
// codebase now sets its own sane default sized for its own workload (see
// spawn-stage.ts, completion-check.ts, learn.ts, engine.ts), so this only
// bites a future caller that forgets to. Previously 60 min / 5 min, which a
// real incident showed was itself the exposure (a runaway leaf inherited the
// 60-minute wall and ran until the container OOM-killed it) — kept small on
// purpose so an omission here still dies in minutes, not an hour.
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TERM_GRACE_MS = 3_000;
// Cleanup has already finished by the time we wait on the pipes, so anything
// still holding fd 1/2 is a process we failed to kill, not a slow writer.
export const DEFAULT_DRAIN_GRACE_MS = 2_000;
/**
 * Default extension budget: exactly enough idle windows to reach the wall,
 * never more. See SupervisedProcessOptions.maxLivenessExtensions for why this
 * is derived rather than a constant. Guards a non-positive idleTimeoutMs
 * (which would otherwise divide to Infinity and mint unlimited extensions —
 * the unbounded wait D3 forbids) by granting none: with idleTimeoutMs <= 0 the
 * idle check fires on the first poll anyway, so there is no healthy work to
 * protect.
 */
export function defaultMaxLivenessExtensions(timeoutMs: number, idleTimeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return 0;
	return Math.max(0, Math.ceil(timeoutMs / idleTimeoutMs));
}
const POLL_MS = 25;
const OWNERSHIP_ENV = "KSK_SUPERVISED_TOKEN";

const executableCache = new Map<string, string>();

/** First `where` hit for a bare command name on Windows, or null. */
function whereMatches(name: string): string[] {
	const result = spawnSync("where", [name], { encoding: "utf8" });
	if (result.status !== 0) return [];
	return (result.stdout || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Resolve argv[0] to something the OS can actually exec.
 *
 * Applied at the spawn itself rather than at the ~12 call sites, so callers
 * (and the tests that stub runSupervised and match on `cmd[0] === "bun"`)
 * keep using logical names and only the real spawn sees a concrete path.
 *
 * Two cases matter:
 *
 *  - `bun`: always substituted with process.execPath. We ARE the Bun that
 *    should run these scripts, so this is more correct everywhere; on Windows
 *    it also sidesteps a `bun` on PATH that is an npm-installed `.cmd` shim.
 *
 *  - `claude`: honours KSK_CLAUDE_BIN, else on Windows resolves through
 *    `where` and insists on a real `.exe`. Claude Code's native installer
 *    (`irm https://claude.ai/install.ps1 | iex`) puts a genuine
 *    `%USERPROFILE%\.local\bin\claude.exe` on PATH, but `npm i -g` instead
 *    creates `.cmd`/`.ps1` shims — and since the CVE-2024-27980 hardening,
 *    libuv (and therefore Bun) refuses to exec a batch file without a shell.
 *    We deliberately do NOT paper over that by wrapping in `cmd.exe /c`: the
 *    argv we would have to escape includes multi-KB `claude -p` prompts with
 *    Thai text, quotes and newlines, plus a JSON `--settings` blob, and a
 *    subtly wrong escaping there corrupts a run rather than failing it. A
 *    clear error naming the fix is worth more than a fragile quoting layer.
 *
 * Anything already carrying a separator is an explicit path and is returned
 * untouched.
 */
function resolveExecutable(name: string): string {
	if (name.includes("/") || name.includes("\\")) return name;
	const cached = executableCache.get(name);
	if (cached !== undefined) return cached;

	let resolved = name;
	if (name === "bun") {
		resolved = process.execPath;
	} else if (name === "claude" && process.env.KSK_CLAUDE_BIN) {
		const override = process.env.KSK_CLAUDE_BIN;
		if (!existsSync(override))
			throw new Error(`KSK_CLAUDE_BIN points at ${override}, which does not exist.`);
		if (IS_WINDOWS && !override.toLowerCase().endsWith(".exe"))
			throw new Error(
				`KSK_CLAUDE_BIN points at ${override}, which is not an .exe. Windows cannot spawn a ` +
					`.cmd/.bat/.ps1 shim directly — point it at the real executable.`,
			);
		resolved = override;
	} else if (IS_WINDOWS) {
		const matches = whereMatches(name);
		const executable = matches.find((match) => match.toLowerCase().endsWith(".exe"));
		if (executable) resolved = executable;
		else if (matches.length)
			throw new Error(
				`${name} resolves only to a shim (${matches[0]}), which cannot be spawned directly on Windows. ` +
					`Install the native build — for claude: \`irm https://claude.ai/install.ps1 | iex\` — ` +
					`or point KSK_${name.toUpperCase()}_BIN at a real .exe.`,
			);
		// No match at all: leave the bare name so the spawn's own ENOENT is the
		// error the operator sees, rather than us guessing at a reason. NOT
		// cached — the operator may well install the missing tool and expect the
		// next run to find it without restarting the server.
		else return name;
	}
	executableCache.set(name, resolved);
	return resolved;
}

type ActiveProcess = {
	controller: AbortController;
	done: Promise<void>;
	resolveDone: () => void;
};

const activeProcesses = new Set<ActiveProcess>();

/** Abort all supervised work and return only after every owned process is gone. */
export async function abortAllSupervisedProcesses(): Promise<void> {
	for (;;) {
		const active = [...activeProcesses];
		if (active.length === 0) return;
		for (const process of active) process.controller.abort();
		await Promise.allSettled(active.map((process) => process.done));
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Existence probe for ONE pid. Signal 0 never changes process state. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		if (error?.code === "ESRCH") return false;
		// EPERM still proves that the process exists; treating it as gone would
		// violate the supervisor's ownership guarantee.
		return true;
	}
}

function processGroupAlive(pgid: number): boolean {
	// On Windows the "group" is only ever the direct child: there is nothing to
	// broadcast a probe to, and a negative pid would misreport ESRCH (see
	// IS_WINDOWS above). Descendants are not probed here — they are handled by
	// taskkill's own tree walk, and anything that survives it is caught by the
	// output-pipe drain in runSupervisedProcess, which is the honest signal on
	// every platform.
	if (IS_WINDOWS) return processAlive(pgid);
	try {
		// A negative pid targets the whole POSIX process group.
		process.kill(-pgid, 0);
		return true;
	} catch (error: any) {
		if (error?.code === "ESRCH") return false;
		// EPERM still proves that the group exists; treating it as gone would
		// violate the supervisor's ownership guarantee.
		return true;
	}
}

/**
 * Windows tree termination. Bun exposes no Job Object handle to userland (its
 * own CLI uses one internally, and the in-flight Subprocess.killTree PR falls
 * back to root-only on win32), so `taskkill /T` walking the parent/child table
 * from `pid` down is the available mechanism.
 *
 * Always /F. Windows has no graceful signal for a console child — Node
 * documents SIGTERM, SIGKILL, SIGINT and SIGQUIT as all collapsing to an
 * immediate, forceful termination — so a "polite first pass" would be theatre
 * that only spends termGraceMs. Callers should not expect a grace window here.
 */
function terminateWindowsTree(pid: number): void {
	const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
	// 128 == "process not found", i.e. it exited between our probe and this
	// call. That is the outcome we wanted, not a failure worth logging.
	if (result.status === 0 || result.status === 128) return;
	if (result.error) {
		console.error(`process-supervisor: taskkill for pid ${pid} could not run:`, result.error);
		return;
	}
	console.error(
		`process-supervisor: taskkill /T /F pid ${pid} exited ${result.status}: ${(result.stderr || "").trim()}`,
	);
}

/**
 * A descendant can call setsid()/setpgid() and leave the original group.
 * Linux descendants therefore also inherit a unique ownership token that we
 * resolve through /proc. The PGID path remains the portable baseline.
 */
function taggedProcessIds(token: string): number[] {
	if (process.platform !== "linux") return [];
	const needle = `${OWNERSHIP_ENV}=${token}`;
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return [];
	}
	const pids: number[] = [];
	for (const entry of entries) {
		if (!/^[1-9]\d*$/.test(entry)) continue;
		try {
			const env = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
			if (env.includes(needle)) pids.push(Number(entry));
		} catch {
			// The process exited or changed credentials between list and read.
		}
	}
	return pids;
}

function signalOwnedProcesses(pgid: number, token: string, signal: "SIGTERM" | "SIGKILL"): void {
	if (IS_WINDOWS) {
		// Both rungs of the TERM -> grace -> KILL ladder land here, because
		// Windows offers only the one outcome. Unconditional for the same
		// reason as cleanupOwnedProcesses' win32 branch: a dead direct child
		// does not mean a dead tree, and taskkill self-reports when there is
		// nothing to kill.
		terminateWindowsTree(pgid);
		return;
	}
	try {
		process.kill(-pgid, signal);
	} catch (error: any) {
		if (error?.code !== "ESRCH") console.error(`process-supervisor: ${signal} process group ${pgid} failed:`, error);
	}
	for (const pid of taggedProcessIds(token)) {
		try {
			process.kill(pid, signal);
		} catch (error: any) {
			if (error?.code !== "ESRCH") console.error(`process-supervisor: ${signal} tagged process ${pid} failed:`, error);
		}
	}
}

async function waitForOwnedExit(pgid: number, token: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (processGroupAlive(pgid) || taggedProcessIds(token).length > 0) {
		if (Date.now() >= deadline) return false;
		await delay(POLL_MS);
	}
	return true;
}

/** TERM -> grace -> KILL, including after a normally exited direct child. */
async function cleanupOwnedProcesses(pgid: number, token: string, termGraceMs: number): Promise<boolean> {
	if (IS_WINDOWS) {
		// Deliberately NOT gated on the direct child's own liveness.
		//
		// runSupervisedProcess calls this unconditionally, including on the
		// ordinary reason === "exited" path — where pgid is dead by definition.
		// The POSIX guard below survives that because `process.kill(-pgid, 0)`
		// is a GROUP broadcast that still finds a live descendant; Windows has
		// no such probe, so on win32 the same guard collapses to "the direct
		// child is gone, therefore everything is gone" and skips the only
		// reaping mechanism we have. That is exactly the orphaned-grandchild
		// case this function exists for.
		//
		// taskkill is idempotent and reports 128 ("not found") when there is
		// nothing left, so attempting it unconditionally costs one cheap call.
		// What we CANNOT do on Windows is prove the tree is gone — a descendant
		// that re-parented away from pgid is unreachable (there is no /proc
		// token scan to fall back on). The output-pipe drain in
		// runSupervisedProcess remains the honest check, and reports
		// cleanup-failed when something still holds the pipe.
		terminateWindowsTree(pgid);
		return waitForOwnedExit(pgid, token, termGraceMs);
	}
	if (!processGroupAlive(pgid) && taggedProcessIds(token).length === 0) return true;
	signalOwnedProcesses(pgid, token, "SIGTERM");
	if (await waitForOwnedExit(pgid, token, termGraceMs)) return true;
	signalOwnedProcesses(pgid, token, "SIGKILL");
	return waitForOwnedExit(pgid, token, termGraceMs);
}

type CapturedStream = {
	text: Promise<string>;
	truncated: () => boolean;
	/** What has been kept so far, for the case where EOF never arrives. */
	partial: () => string;
	/** Release our end of the pipe when we give up waiting for EOF. */
	cancel: () => void;
};

function captureStream(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	onChunk: ((chunk: Uint8Array) => void) | undefined,
	onActivity: () => void,
): CapturedStream {
	let truncated = false;
	let kept = 0;
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	const text = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			onActivity();
			try {
				onChunk?.(value);
			} catch (error) {
				// Observers (for example stream-json parsing) must never make us
				// stop draining a pipe and deadlock the child.
				console.error("process-supervisor: output observer failed:", error);
			}
			const remaining = maxBytes - kept;
			if (remaining <= 0) {
				truncated = true;
				continue;
			}
			if (value.byteLength <= remaining) {
				chunks.push(value);
				kept += value.byteLength;
			} else {
				chunks.push(value.slice(0, remaining));
				kept += remaining;
				truncated = true;
			}
		}
		return new TextDecoder().decode(Buffer.concat(chunks));
	})();
	return {
		text,
		truncated: () => truncated,
		partial: () => new TextDecoder().decode(Buffer.concat(chunks)),
		cancel: () => {
			void reader.cancel().catch(() => {});
		},
	};
}

/** Resolves to false if `promise` has not settled within `ms`, without leaking a timer. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([promise.then(() => true), expired]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Spawn one fully-owned command. The result is returned only after its process
 * group has been cleaned up, including the orphan-child case where the direct
 * parent exited successfully before its descendants.
 */
export async function runSupervisedProcess(options: SupervisedProcessOptions): Promise<SupervisedProcessResult> {
	if (options.signal?.aborted) {
		return {
			pid: null, exitCode: null, reason: "aborted", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true,
		};
	}
	const controller = new AbortController();
	let resolveDone!: () => void;
	const active: ActiveProcess = {
		controller,
		done: new Promise<void>((resolve) => {
			resolveDone = resolve;
		}),
		resolveDone: () => resolveDone(),
	};
	activeProcesses.add(active);
	const relayAbort = () => controller.abort();
	options.signal?.addEventListener("abort", relayAbort, { once: true });
	let registered = true;
	const unregister = () => {
		if (!registered) return;
		registered = false;
		options.signal?.removeEventListener("abort", relayAbort);
		activeProcesses.delete(active);
		active.resolveDone();
	};
	if (options.signal?.aborted) controller.abort();
	const ownershipToken = randomUUID();

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		if (controller.signal.aborted) {
			unregister();
			return {
				pid: null, exitCode: null, reason: "aborted", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true,
			};
		}
		proc = Bun.spawn([resolveExecutable(options.cmd[0] ?? ""), ...options.cmd.slice(1)], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env, [OWNERSHIP_ENV]: ownershipToken },
			stdin: options.stdin ?? "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Bun uses setsid() on POSIX: `proc.pid` is also the new PGID.
			//
			// Deliberately NOT set on Windows. There is no process group for it
			// to create, so it buys nothing, and libuv maps it to
			// DETACHED_PROCESS — which severs the child from our console while
			// (per oven-sh/bun#31603) still leaving it inside Bun's job object
			// anyway. Left off, the child stays in that job and dies with the
			// server, which is the cleanup behaviour we want; mid-run
			// termination is taskkill's job, not detach's.
			detached: !IS_WINDOWS,
			// Keep spawned console children from flashing a window when the
			// server runs interactively on a Windows desktop.
			windowsHide: true,
		});
	} catch (error) {
		unregister();
		return {
			pid: null,
			exitCode: null,
			reason: "spawn-error",
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			stdoutTruncated: false,
			stderrTruncated: false,
			cleanupComplete: true,
		};
	}

	const pid = proc.pid;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
	const label = options.label ?? options.cmd[0] ?? "unknown";
	const livenessProbe = options.livenessProbe;
	const maxLivenessExtensions = options.maxLivenessExtensions ?? defaultMaxLivenessExtensions(timeoutMs, idleTimeoutMs);
	const startedAt = Date.now();
	let lastActivityAt = startedAt;
	// Separate from lastActivityAt, which a granted liveness extension moves
	// forward to restart the idle window. Only real stdout/stderr moves this
	// one, so the post-mortem log line below can report how long the process
	// was ACTUALLY silent instead of "since the last extension" — a process
	// that printed nothing for 30 minutes was reporting sinceActivityMs≈0 once
	// extensions were in play, which is worse than useless in the one line
	// whose entire job is diagnosis.
	let lastRealActivityAt = startedAt;
	const touch = () => {
		lastActivityAt = Date.now();
		lastRealActivityAt = lastActivityAt;
	};
	// D2: the progress reading seen at the PREVIOUS idle expiry (not a
	// high-water mark — see livenessProbe's doc for why the one real probe is
	// not monotonic), so the next expiry can tell "the probe moved" from "the
	// probe is just reporting the same number it always did". null means "no
	// reading yet" and is intentionally distinct from 0 (a probe legitimately
	// starting at zero must still be allowed to prove progress on its first
	// extension).
	let lastProbeValue: number | null = null;
	let livenessExtensionsUsed = 0;
	let probeErrorLogged = false;
	const stdout = captureStream(proc.stdout, maxOutputBytes, options.onStdoutChunk, touch);
	const stderr = captureStream(proc.stderr, maxOutputBytes, options.onStderrChunk, touch);
	let exitCode: number | null = null;
	let exited = false;
	void proc.exited.then((code) => {
		exitCode = code;
		exited = true;
	});

	let reason: ProcessFailureReason = "exited";
	try {
		while (!exited) {
			if (controller.signal.aborted) {
				reason = "aborted";
				break;
			}
			const now = Date.now();
			if (now - startedAt >= timeoutMs) {
				reason = "timeout";
				break;
			}
			if (now - lastActivityAt >= idleTimeoutMs) {
				// D2: silence alone is not proof of a stuck process. Before killing,
				// ask the probe (if any) whether externally-observable evidence has
				// moved since the last time this idle window expired.
				let probeValue: number | null = null;
				if (livenessProbe) {
					try {
						probeValue = livenessProbe();
					} catch (error) {
						if (!probeErrorLogged) {
							probeErrorLogged = true;
							console.error(`process-supervisor: ${label} livenessProbe threw, treating as no evidence:`, error);
						}
						probeValue = null;
					}
				}
				// Change, not increase — see livenessProbe's doc comment: the
				// prepare-pages probe legitimately drops when prepare.ts wipes a
				// half-rendered source dir before re-rendering it, and a strict-
				// increase test would kill that recovery run outright.
				const madeProgress = probeValue !== null && (lastProbeValue === null || probeValue !== lastProbeValue);
				if (madeProgress && livenessExtensionsUsed < maxLivenessExtensions) {
					livenessExtensionsUsed += 1;
					lastProbeValue = probeValue;
					console.error(
						`process-supervisor: ${label} idle-extended pid=${pid ?? "unknown"} probeValue=${probeValue} extension=${livenessExtensionsUsed}/${maxLivenessExtensions} elapsedMs=${now - startedAt} sinceOutputMs=${now - lastRealActivityAt} timeoutMs=${timeoutMs} idleTimeoutMs=${idleTimeoutMs}`,
					);
					// Reset the idle clock: the next expiry is a fresh idleTimeoutMs
					// window, not an immediate re-check against the same silence.
					lastActivityAt = now;
					await delay(POLL_MS);
					continue;
				}
				reason = "idle-timeout";
				break;
			}
			await delay(POLL_MS);
		}

		// Emitted before cleanup (which can itself take up to termGraceMs*2) so
		// the reason is on the record even if cleanup then hangs. Deliberately
		// omits stdout/stderr content: a `claude -p` argv/prompt can run to
		// multi-KB and logging it here would be the exact regression this line
		// exists to avoid causing.
		if (reason !== "exited") {
			const now = Date.now();
			console.error(
				// sinceOutputMs is measured from the last REAL stdout/stderr byte,
				// never from a granted liveness extension — see lastRealActivityAt.
				`process-supervisor: ${label} ${reason} pid=${pid ?? "unknown"} elapsedMs=${now - startedAt} sinceOutputMs=${now - lastRealActivityAt} extensionsUsed=${livenessExtensionsUsed}/${maxLivenessExtensions} timeoutMs=${timeoutMs} idleTimeoutMs=${idleTimeoutMs}`,
			);
		}

		// This is deliberately unconditional. `proc.exited` is not enough:
		// descendants may still be alive in the group's session.
		const killedCleanly = await cleanupOwnedProcesses(pid, ownershipToken, termGraceMs);

		// The pipes are inherited, so EOF arrives only once *every* holder of the
		// child's fd 1/2 has closed it. Waiting unbounded here would hand a
		// surviving descendant the power to pin this call open forever — which
		// also makes the cleanup-failed result (and every fatal latch built on
		// it) unreachable in exactly the case it exists for. So the drain is
		// bounded, and a drain that does not finish is itself proof that
		// something we do not own is still holding the pipe.
		const drained = await settlesWithin(Promise.all([proc.exited, stdout.text, stderr.text]), drainGraceMs);
		if (!drained) {
			console.error(
				`process-supervisor: pid ${pid} left an output pipe open ${drainGraceMs}ms after cleanup — treating as unproven cleanup`,
			);
			stdout.cancel();
			stderr.cancel();
		}
		const cleanupComplete = killedCleanly && drained;
		return {
			pid,
			exitCode,
			reason: cleanupComplete ? reason : "cleanup-failed",
			stdout: drained ? await stdout.text : stdout.partial(),
			stderr: drained ? await stderr.text : stderr.partial(),
			stdoutTruncated: stdout.truncated(),
			stderrTruncated: stderr.truncated(),
			cleanupComplete,
		};
	} finally {
		unregister();
	}
}
