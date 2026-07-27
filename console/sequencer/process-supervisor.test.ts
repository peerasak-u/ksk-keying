import { afterEach, describe, expect, test } from "bun:test";
import { abortAllSupervisedProcesses, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, runSupervisedProcess } from "./process-supervisor";
import { isAlive, killRecorded, waitUntilGone } from "./process-liveness.testing";

const childPids: number[] = [];

afterEach(async () => {
	killRecorded(childPids);
});

describe("runSupervisedProcess", () => {
	test("reaps a CPU child after its parent exits successfully", async () => {
		const result = await runSupervisedProcess({
			cmd: ["sh", "-c", "(while :; do :; done) & child=$!; echo $child; exit 0"],
			timeoutMs: 2_000,
			idleTimeoutMs: 2_000,
			termGraceMs: 100,
		});
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("exited");
		expect(result.exitCode).toBe(0);
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	test("reaps a descendant that escapes the original process group with setsid", async () => {
		const result = await runSupervisedProcess({
			cmd: ["sh", "-c", "setsid sleep 30 >/dev/null 2>&1 & child=$!; echo $child; exit 0"],
			timeoutMs: 2_000,
			idleTimeoutMs: 2_000,
			termGraceMs: 100,
		});
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("exited");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	test("does not spawn when the caller signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runSupervisedProcess({
			cmd: ["sh", "-c", "exit 99"],
			signal: controller.signal,
		});
		expect(result.reason).toBe("aborted");
		expect(result.pid).toBeNull();
		expect(result.exitCode).toBeNull();
		expect(result.cleanupComplete).toBe(true);
	});

	test("kills a silent CPU child on the idle deadline", async () => {
		const result = await runSupervisedProcess({
			cmd: ["sh", "-c", "(while :; do :; done) & child=$!; echo $child; wait"],
			timeoutMs: 2_000,
			idleTimeoutMs: 100,
			termGraceMs: 100,
		});
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("idle-timeout");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	test("aborts the complete process group and waits for cleanup", async () => {
		const controller = new AbortController();
		const pending = runSupervisedProcess({
			cmd: ["sh", "-c", "sleep 30 & child=$!; echo $child; wait"],
			signal: controller.signal,
			timeoutMs: 30_000,
			idleTimeoutMs: 30_000,
			termGraceMs: 100,
		});
		await new Promise((resolve) => setTimeout(resolve, 75));
		controller.abort();
		const result = await pending;
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("aborted");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	test("global shutdown waits for detached supervisors and escaped descendants", async () => {
		const pending = runSupervisedProcess({
			cmd: ["sh", "-c", "setsid sleep 30 >/dev/null 2>&1 & child=$!; echo $child; wait"],
			timeoutMs: 30_000,
			idleTimeoutMs: 30_000,
			termGraceMs: 100,
		});
		await new Promise((resolve) => setTimeout(resolve, 75));
		await abortAllSupervisedProcesses();
		const result = await pending;
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("aborted");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	test("the module's own last-resort default is minutes, not the old 60-minute wall / never the sole line of defense", () => {
		// Every real call site in this codebase now supplies its own sane
		// fallback (see sequencer/spawn-stage.ts, sequencer/completion-check.ts,
		// app/learn.ts, engine.ts) — this default only bites a future caller
		// that forgets its own. It used to be 60 min / 5 min, which is exactly
		// the gap the incident this file's header describes exploited.
		expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(15 * 60 * 1_000);
		expect(DEFAULT_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60 * 1_000);
	});

	test("an omitted timeoutMs really does fall back to the module default and still kills a runaway child", async () => {
		const result = await runSupervisedProcess({
			cmd: ["sh", "-c", "(while :; do :; done) & child=$!; echo $child; wait"],
			// timeoutMs/idleTimeoutMs both omitted on purpose — proves the
			// fallback path itself still bounds a real process, not just that
			// the constants are small numbers.
			idleTimeoutMs: 100,
			termGraceMs: 100,
		});
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("idle-timeout");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	// A descendant that both leaves the process group (setsid) and scrubs the
	// ownership token defeats every mechanism we have for killing it. It still
	// holds the inherited stdout pipe, and that is the tell: the call must come
	// back on time and must report the cleanup as unproven rather than certify a
	// process it never killed.
	test("returns on time and reports unproven cleanup when an untrackable descendant holds the pipe", async () => {
		const startedAt = Date.now();
		const result = await runSupervisedProcess({
			cmd: ["sh", "-c", "setsid env -u KSK_SUPERVISED_TOKEN sleep 25 & echo spawned; exit 0"],
			timeoutMs: 3_000,
			idleTimeoutMs: 3_000,
			termGraceMs: 200,
			drainGraceMs: 300,
		});
		const elapsed = Date.now() - startedAt;

		expect(elapsed).toBeLessThan(10_000);
		expect(result.cleanupComplete).toBe(false);
		expect(result.reason).toBe("cleanup-failed");
		// Output captured before we gave up on EOF is still returned.
		expect(result.stdout).toContain("spawned");
	});

	test("the wall deadline bounds the call, not merely the direct child", async () => {
		const startedAt = Date.now();
		const result = await runSupervisedProcess({
			cmd: ["sh", "-c", "setsid env -u KSK_SUPERVISED_TOKEN sleep 25 & sleep 25"],
			timeoutMs: 500,
			idleTimeoutMs: 5_000,
			termGraceMs: 200,
			drainGraceMs: 300,
		});
		const elapsed = Date.now() - startedAt;

		expect(elapsed).toBeLessThan(10_000);
		expect(result.cleanupComplete).toBe(false);
		expect(result.reason).toBe("cleanup-failed");
	});

	test("caps retained output while continuing to drain the child", async () => {
		const result = await runSupervisedProcess({
			cmd: ["sh", "-c", "i=0; while [ $i -lt 1000 ]; do printf x; i=$((i + 1)); done"],
			maxOutputBytes: 16,
			timeoutMs: 2_000,
			idleTimeoutMs: 2_000,
			termGraceMs: 100,
		});
		expect(result.reason).toBe("exited");
		expect(result.stdout).toHaveLength(16);
		expect(result.stdoutTruncated).toBe(true);
	});
});
