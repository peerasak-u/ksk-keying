import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, RUNS_ROOT, loadJson } from "../lib";
import type { ScriptRunner, StageRun } from "../specs/stage-grader";
import { STAGE_GRADERS, getStageGrader } from "../specs/stage-registry";

// ---------------------------------------------------------------------------
// Registry — every pipeline stage resolves to a grader whose `.stage` matches
// its registry key. Each grader's own behavior is covered by its dedicated
// spec test (segment/link/group/categorize-stage.test.ts + this file's
// interpret smoke test below).
// ---------------------------------------------------------------------------
describe("stage-grader registry", () => {
	const STAGES = ["segment", "interpret", "link", "group", "categorize"] as const;

	test("resolves all 5 stages", () => {
		for (const s of STAGES) {
			const g = getStageGrader(s);
			expect(g, `stage "${s}" must be registered`).toBeDefined();
			expect(g!.stage).toBe(s); // grader.stage === its registry key
		}
		expect(Object.keys(STAGE_GRADERS).sort()).toEqual([...STAGES].sort());
	});

	test("unknown stage resolves to undefined", () => {
		expect(getStageGrader("nope")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Interpret grader smoke test — drive the real grader over the recorded run
// (samples/evals/_runs/stage-interpret/20260713-1846) and check the headline
// numbers. grade() re-runs the bundled gate scripts (idempotent) and RETURNS
// its result WITHOUT writing into the run dir, so this is side-effect-light and
// repeatable. Skipped when the gitignored recorded run isn't on this machine.
// ---------------------------------------------------------------------------
const RECORDED_RUN = join(RUNS_ROOT, "stage-interpret", "20260713-1846");
const SCRIPTS = join(REPO_ROOT, ".claude/skills/ksk-keying/scripts");

const script: ScriptRunner = (cmd, clientAbs, argsBefore = []) => {
	try {
		const out = execFileSync("bun", ["run", "--cwd", SCRIPTS, cmd, "--", ...argsBefore, clientAbs], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (e: any) {
		return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
};

describe.skipIf(!existsSync(join(RECORDED_RUN, "run.json")))(
	"interpret grader — recorded-run smoke",
	() => {
		const grader = getStageGrader("interpret")!;
		const run = loadJson<StageRun>(join(RECORDED_RUN, "run.json"));
		const result = grader.grade({
			stage: "interpret",
			runId: "20260713-1846",
			runDir: RECORDED_RUN,
			run,
			clientDir: (s) => join(RECORDED_RUN, `s${s}`, "client"),
			script,
		});

		test("shape: one grade per session + a summary + scoreboard lines", () => {
			expect(result.sessionGrades).toHaveLength(run.sessions);
			expect(result.sessionGrades.map((g) => g.session)).toEqual([1, 2, 3]);
			expect(result.scoreboard.length).toBeGreaterThan(0);
			expect(result.scoreboard[0]).toContain("stage-interpret");
		});

		test("headline reliability + agreement match the pinned baseline", () => {
			expect(result.summary.reliability).toBe("3/3");
			expect(result.summary.value_agreement).toBe("0/24 (0.0%)");
			expect(result.summary.docs_compared).toBe(24);
			expect(result.summary.dropped_keys).toEqual(["seg-001:1"]);
			expect(result.sessionGrades.every((g) => g.pass)).toBe(true);
		});

		test("tier-B ground truth matches the pinned baseline", () => {
			const gt = result.summary.ground_truth as any;
			expect(gt).not.toBeNull();
			expect(gt.expected_docs).toBe(20);
			expect(gt.min_recall).toBe(20);
			expect(gt.max_invented).toBe(5);
			expect(gt.per_session.map((t: any) => t.value_match)).toEqual(["14/20", "5/20", "19/20"]);
		});
	},
);
