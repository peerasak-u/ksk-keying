// Test-only helpers, shared by every suite that proves the supervisor really
// killed something. These assert against the OS rather than against a mock on
// purpose: the incident behind process-supervisor.ts was a process that the
// pipeline believed was gone while it kept burning CPU, so a test that trusts
// our own bookkeeping would have passed straight through it.

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		// EPERM proves the process exists, so only ESRCH means gone.
		return error?.code !== "ESRCH";
	}
}

export async function waitUntilGone(pid: number): Promise<void> {
	for (let i = 0; i < 80; i++) {
		if (!isAlive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`child ${pid} was still alive after supervisor cleanup`);
}

/**
 * Last-resort teardown for pids a suite recorded. Every assertion should
 * already have proven the supervisor did this itself — this only keeps a
 * failed test from leaving a runaway behind and making the rerun unsafe.
 */
export function killRecorded(childPids: number[]): void {
	for (const pid of childPids.splice(0)) {
		if (isAlive(pid)) process.kill(pid, "SIGKILL");
	}
}
