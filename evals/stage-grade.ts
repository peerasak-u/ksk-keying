// Grade a STAGE eval run (Tier 2). Deterministic only — each stage's grader
// (specs/<stage>-stage.ts, resolved via specs/stage-registry.ts) reads that
// stage's ข้อมูลระบบ artifacts + re-runs the production gates, then compares the
// sessions to each other (with no mid-stage answer key, the runs are each
// other's reference).
//
//   bun run stage-grade.ts -- interpret --run <run-id>
//
// This file is a THIN DRIVER: parse `<stage> --run`, look the grader up, run it,
// write grade-s<N>.json per session + summary.json, and print the scoreboard.
// All stage-specific logic lives in the grader module. Never edits a session's
// output; a malformed/missing artifact is a finding the grader reports as a
// failing metric.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, RUNS_ROOT, loadJson, parseArgs, writeJson } from "./lib";
import { getStageGrader, STAGE_GRADERS } from "./specs/stage-registry";
import type { ScriptRunner, StageRun } from "./specs/stage-grader";

const SCRIPTS = join(REPO_ROOT, ".claude/skills/ksk-keying/scripts");

// Run a bundled workflow/gate script against a client dir; capture exit + stdout.
// The client dir is always the trailing arg (the scripts' convention); argsBefore
// carries gate flags, e.g. script("ledger", client, ["--gate","interpret"]).
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

const { positional, flags } = parseArgs(process.argv.slice(2));
const stage = positional[0] ?? "interpret";
const runId = String(flags.run ?? "");

const grader = getStageGrader(stage);
if (!grader) {
	console.error(
		`unknown stage "${stage}" — one of: ${Object.keys(STAGE_GRADERS).join(", ")}`,
	);
	process.exit(1);
}
if (!runId) {
	console.error("--run <run-id> is required");
	process.exit(1);
}

const runDir = join(RUNS_ROOT, `stage-${stage}`, runId);
const run = loadJson<StageRun>(join(runDir, "run.json"));

const result = grader.grade({
	stage,
	runId,
	runDir,
	run,
	clientDir: (s) => join(runDir, `s${s}`, "client"),
	script,
});

// summary.json = standard envelope + the grader's stage-specific body.
const summary = {
	schema: "ksk_stage_eval_summary.v1",
	stage,
	run_id: runId,
	fixture: run.fixture,
	sessions: run.sessions,
	...result.summary,
};
writeJson(join(runDir, "summary.json"), summary);
result.sessionGrades.forEach((g) => writeJson(join(runDir, `grade-s${g.session}.json`), g));

result.scoreboard.forEach((line) => console.log(line));
