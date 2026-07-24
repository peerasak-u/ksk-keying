// Fakes SequencerDeps throughout — never spawns a real `claude -p`. Exercises
// the orchestrator through its public API only (boot/enqueueRun/retryRun/
// getRun/subscribe), the same "test behavior, not implementation" standard
// as sequencer/logic.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { initialState, type GateResult, type HumanStopEntry, type SequencerDeps, type StageOutcome } from "../sequencer/logic";
import { createOrchestrator } from "./orchestrator";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ksk-orchestrator-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function alwaysPassDeps(): SequencerDeps {
	return {
		runStageProcess: async () => "success" as StageOutcome,
		runGate: async () => ({ exitCode: 0, stdout: "ok" }) as GateResult,
		checkHumanStop: async () => [] as HumanStopEntry[],
	};
}

/** Flush pending microtasks until `predicate()` is true or attempts run out —
 * every fake `deps` call here resolves same-tick, but the drive loop still
 * chains several `await`s per stage, so a handful of ticks are needed. */
async function waitUntil(predicate: () => boolean, attempts = 50) {
	for (let i = 0; i < attempts; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 0));
	}
	throw new Error("waitUntil: condition never became true");
}

describe("enqueueRun — fresh run drives to done", () => {
	test("a client-month with no prior record runs every stage to done", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		const result = await orchestrator.enqueueRun("A/month-1");
		expect(result.ok).toBe(true);

		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		const run = orchestrator.getRun("A/month-1")!;
		expect(run.state.status).toBe("done");
		expect(run.active).toBe(false);
		expect(run.queued).toBe(false);
	});

	test("re-enqueuing an already-done run is rejected, not restarted", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");

		const again = await orchestrator.enqueueRun("A/month-1");
		expect(again.ok).toBe(false);
	});
});

describe("concurrency limit", () => {
	test("a second run stays queued while the first holds the only slot", async () => {
		let resolveFirstGate: ((r: GateResult) => void) | null = null;
		let firstGateCalled = false;
		const deps: SequencerDeps = {
			runStageProcess: async () => "success",
			runGate: async (stage, targetDir) => {
				if (targetDir.endsWith("A/month-1") && !firstGateCalled) {
					firstGateCalled = true;
					return new Promise<GateResult>((resolve) => {
						resolveFirstGate = resolve;
					});
				}
				return { exitCode: 0, stdout: "ok" };
			},
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);

		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => firstGateCalled);
		await orchestrator.enqueueRun("B/month-1");
		// give B's enqueue a tick to settle into the queue
		await waitUntil(() => orchestrator.getRun("B/month-1")?.queued === true);

		expect(orchestrator.getRun("A/month-1")?.active).toBe(true);
		expect(orchestrator.getRun("B/month-1")?.active).toBe(false);
		expect(orchestrator.getRun("B/month-1")?.queued).toBe(true);

		resolveFirstGate!({ exitCode: 0, stdout: "ok" });
		await waitUntil(() => orchestrator.getRun("B/month-1")?.state.status === "done");
		expect(orchestrator.getRun("A/month-1")?.state.status).toBe("done");
	});
});

describe("retryRun", () => {
	test("a blocked run resumes forward on explicit retry and continues to done", async () => {
		let gateCalls = 0;
		const deps: SequencerDeps = {
			runStageProcess: async () => "success",
			runGate: async () => {
				gateCalls++;
				return gateCalls === 1 ? { exitCode: 1, stdout: "missing thing" } : { exitCode: 0, stdout: "ok" };
			},
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);

		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "blocked");
		expect(orchestrator.getRun("A/month-1")?.active).toBe(false); // released its slot

		const retried = await orchestrator.retryRun("A/month-1");
		expect(retried.ok).toBe(true);
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
	});

	test("retrying a run that isn't blocked/env-error is rejected", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");

		const result = await orchestrator.retryRun("A/month-1");
		expect(result.ok).toBe(false);
	});

	test("retrying a client-month with no run at all is rejected", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		const result = await orchestrator.retryRun("nonexistent/month");
		expect(result.ok).toBe(false);
	});
});

describe("boot() crash-resume", () => {
	test("re-enqueues an idle (mid-run) record found on disk without an explicit enqueueRun call", async () => {
		const targetDir = join(root, "A", "month-1");
		mkdirSync(join(targetDir, "ข้อมูลระบบ", "_pages"), { recursive: true });
		const midRunState = { ...initialState(), stageIndex: 3 }; // "link", idle
		writeFileSync(
			join(targetDir, "ข้อมูลระบบ", "_pages", "run-state.yaml"),
			yamlStringify({
				schema: "ksk_run_state.v1",
				started_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				finished_at: null,
				state: midRunState,
			}),
			"utf8",
		);

		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);

		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		expect(orchestrator.getRun("A/month-1")?.state.status).toBe("done");
	});

	test("does NOT auto-resume a blocked/terminal record — that still needs an explicit human action", async () => {
		const targetDir = join(root, "A", "month-1");
		mkdirSync(join(targetDir, "ข้อมูลระบบ", "_pages"), { recursive: true });
		const blockedState = { ...initialState(), status: "blocked" as const };
		writeFileSync(
			join(targetDir, "ข้อมูลระบบ", "_pages", "run-state.yaml"),
			yamlStringify({
				schema: "ksk_run_state.v1",
				started_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				finished_at: null,
				state: blockedState,
			}),
			"utf8",
		);

		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(orchestrator.getRun("A/month-1")?.state.status).toBe("blocked");
		expect(orchestrator.getRun("A/month-1")?.active).toBe(false);
	});
});

describe("subscribe", () => {
	test("receives a notification as the run progresses", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		const seen: string[] = [];
		const unsubscribe = orchestrator.subscribe("A/month-1", (summary) => seen.push(summary.state.status));
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		unsubscribe();
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[seen.length - 1]).toBe("done");
	});
});
