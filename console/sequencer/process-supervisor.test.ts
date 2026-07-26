import { afterEach, describe, expect, test } from "bun:test";
import { abortAllSupervisedProcesses, runSupervisedProcess } from "./process-supervisor";

const childPids: number[] = [];

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code !== "ESRCH";
	}
}

async function waitUntilGone(pid: number): Promise<void> {
	for (let i = 0; i < 80; i++) {
		if (!isAlive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`child ${pid} was still alive after supervisor cleanup`);
}

afterEach(async () => {
	// Leave a failed test safe to rerun. This is intentionally a last-resort
	// test cleanup; each assertion proves the supervisor performed this itself.
	for (const pid of childPids.splice(0)) {
		if (isAlive(pid)) process.kill(pid, "SIGKILL");
	}
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
