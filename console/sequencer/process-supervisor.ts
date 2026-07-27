// Owns the lifecycle of every external command used by the sequencer.
//
// `Subprocess.exited` only describes the direct child.  A shell/Claude process
// can exit while a descendant keeps consuming CPU, so every command is started
// as a new POSIX session/process group and every return path tears that group
// down.  Do not call Bun.spawn directly from sequencer code.

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

function processGroupAlive(pgid: number): boolean {
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
	const startedAt = Date.now();
	let lastActivityAt = startedAt;
	const touch = () => {
		lastActivityAt = Date.now();
	};
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
				reason = "idle-timeout";
				break;
			}
			await delay(POLL_MS);
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
