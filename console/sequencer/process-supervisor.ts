// Owns the lifecycle of every external command used by the sequencer.
//
// `Subprocess.exited` only describes the direct child.  A shell/Claude process
// can exit while a descendant keeps consuming CPU, so every command is started
// as a new POSIX session/process group and every return path tears that group
// down.  Do not call Bun.spawn directly from sequencer code.
//
// WINDOWS (win32) has no POSIX session/process group, and every primitive this
// module was originally built on is silently a no-op there: `process.kill()`
// with a NEGATIVE pid throws ESRCH rather than signalling a group, which made
// processGroupAlive() answer "dead" for a process that was still running and
// made every teardown path claim success while killing nothing. Measured, not
// assumed — a supervised child given a 2s wall survived its own timeout and its
// own abort(), and both calls returned `cleanup-failed` with the child still
// alive. That is the worst of both worlds for the console: the stop button and
// every stage deadline leak a live `claude -p` (still spending, still writing
// to a client folder under bypassPermissions) AND poison the run, since
// unproven cleanup is deliberately fatal everywhere downstream.
//
// So win32 gets its own teardown built on the primitives it actually has:
//   * liveness  -> `process.kill(pid, 0)` on the DIRECT child. A positive pid
//                  does work on Windows; only the negative-pid group form does
//                  not.
//   * teardown  -> `taskkill /PID <pid> /T /F`. `/T` makes taskkill walk the
//                  parent/child table and take the whole tree itself, which is
//                  the closest Windows equivalent to signalling a process
//                  group, and it is the reason teardown must be issued while
//                  the direct child is still alive — once the child exits, its
//                  descendants are reparented and `/T` can no longer reach
//                  them from our pid.
// The guarantee is therefore weaker than the POSIX one in exactly one case: a
// descendant that outlives its own parent cannot be reached by pid alone (there
// is no job object here, and Win32_Process does not expose the ownership token
// that /proc does on Linux). That case is not silently accepted — it is exactly
// what the bounded drain below still catches, and it still reports
// `cleanup-failed` rather than a false success.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

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
	/** Time to allow SIGTERM before escalating the complete process group. */
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

const IS_WINDOWS = process.platform === "win32";

/** Existence probe for ONE pid. Signal 0 never changes process state, and a
 * positive pid is the one `process.kill` form that behaves the same on win32
 * as it does on POSIX. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		if (error?.code === "ESRCH") return false;
		// EPERM still proves the process exists; treating it as gone would
		// violate the supervisor's ownership guarantee.
		return true;
	}
}

function processGroupAlive(pgid: number): boolean {
	// win32 has no process group to signal — the negative-pid form throws ESRCH
	// and would report every live child as dead (see this file's header). The
	// direct child is the portable baseline; its descendants are reached by
	// taskkill's own `/T` walk rather than by a pid set tracked here.
	if (IS_WINDOWS) return pidAlive(pgid);
	try {
		// A negative pid targets the whole POSIX process group. Signal 0 only
		// probes existence and never changes process state.
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
 * `taskkill /PID <pid> /T /F` — the win32 stand-in for signalling a POSIX
 * process group. `/T` makes taskkill itself walk the parent/child table and
 * take every descendant, in-process and natively, which is the whole reason
 * this module does not maintain a pid snapshot of its own on Windows: an
 * equivalent enumeration from userland costs a `Get-CimInstance Win32_Process`
 * shell-out, measured at ~28s on the development machine (PowerShell startup
 * under AV), against ~0.6s for taskkill doing the same walk itself. `wmic` is
 * the fast alternative at ~0.9s but is deprecated and already absent from
 * current Windows builds, so it is not something a shipped deliverable can
 * depend on.
 *
 * Always `/F`, never the polite form, and mapped to BOTH the TERM and the KILL
 * step: Windows has no graceful stop signal for a console process. Node's own
 * `process.kill(pid, "SIGTERM")` is already a TerminateProcess call, and
 * taskkill without `/F` only posts WM_CLOSE, which a console child ignores.
 * Modelling a grace period here would therefore not buy the child a flush — it
 * would only add a full termGraceMs of dead latency to every stop and every
 * deadline. The console loses nothing by this: run events are appended to the
 * `.jsonl` as they stream, so there is no buffered state a graceful exit would
 * have saved.
 */
function windowsTaskkillTree(pid: number): void {
	try {
		Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
	} catch (error) {
		console.error(`process-supervisor: taskkill on pid ${pid} failed:`, error);
	}
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
		// Both steps force-kill the tree — see windowsTaskkillTree for why a
		// graceful step does not exist on this platform.
		windowsTaskkillTree(pgid);
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

/** Every owned pid still running: the process group on POSIX (the direct child
 * on win32, which has none), plus any ownership-tagged descendant that escaped
 * the group on Linux. */
function ownedStillAlive(pgid: number, token: string): boolean {
	if (processGroupAlive(pgid)) return true;
	return taggedProcessIds(token).length > 0;
}

async function waitForOwnedExit(pgid: number, token: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (ownedStillAlive(pgid, token)) {
		if (Date.now() >= deadline) return false;
		await delay(POLL_MS);
	}
	return true;
}

/** TERM -> grace -> KILL, including after a normally exited direct child. (On
 * win32 both steps force-kill the tree; the grace window still exists but is
 * only ever spent waiting for the kill to land, never on a flush the platform
 * cannot offer — see windowsTaskkillTree.) */
async function cleanupOwnedProcesses(pgid: number, token: string, termGraceMs: number): Promise<boolean> {
	if (!ownedStillAlive(pgid, token)) return true;
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
		proc = Bun.spawn(options.cmd, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env, [OWNERSHIP_ENV]: ownershipToken },
			stdin: options.stdin ?? "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Bun uses setsid() on POSIX: `proc.pid` is also the new PGID.
			detached: true,
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
