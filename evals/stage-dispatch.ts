// Prepare a STAGE eval run (Tier 2): clone a frozen stage fixture N times and
// print, per session, the instruction to run the stage skill on that clone in a
// FRESH top-level session.
//
//   bun run stage-dispatch.ts -- interpret --fixture 345-04-69 --sessions 3 --note "baseline"
//
// Why separate sessions, not subagents: a stage runs fan-out waves
// (watson/marple/lestrade), and a subagent cannot spawn its own subagents — only
// a top-level session (this Claude Code session, or a headless `claude -p`) can.
// So each replicate is an INDEPENDENT session on its own clone: no context bleed,
// and with no mid-stage answer key the N runs are each other's reference.
//
// This script only prepares clones + prints instructions. The runner then either
// runs each `claude -p` line, or drives each clone in a fresh Claude Code window.
// Grade with stage-grade.ts once every session's ข้อมูลระบบ tree is written.

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, RUNS_ROOT, ensureDir, parseArgs, writeJson } from "./lib";

const STAGE_SKILL: Record<string, string> = {
	interpret: "ksk-stage-interpret",
	segment: "ksk-stage-segment",
	link: "ksk-stage-link",
	group: "ksk-stage-group",
	categorize: "ksk-stage-categorize",
	profile: "ksk-stage-profile",
};

const { positional, flags } = parseArgs(process.argv.slice(2));
const stage = positional[0] ?? "interpret";
const skill = STAGE_SKILL[stage];
if (!skill) {
	console.error(`unknown stage "${stage}" — one of: ${Object.keys(STAGE_SKILL).join(", ")}`);
	process.exit(1);
}

const fixtureName = typeof flags.fixture === "string" ? (flags.fixture as string) : "";
if (!fixtureName) {
	console.error("--fixture <name> is required (a dir under samples/evals/fixtures/<stage>/)");
	process.exit(1);
}
const sessions = Number(flags.sessions ?? flags.replicates ?? 3);

const fixtureDir = join(DATA_ROOT, "fixtures", stage, fixtureName);
if (!existsSync(fixtureDir)) {
	console.error(`fixture not found: ${fixtureDir}`);
	process.exit(1);
}

const stamp = new Date()
	.toISOString()
	.slice(0, 16)
	.replace(/[-:]/g, "")
	.replace("T", "-");
const runId = typeof flags["run-id"] === "string" ? (flags["run-id"] as string) : stamp;
const runDir = join(RUNS_ROOT, `stage-${stage}`, runId);
ensureDir(runDir);

const clones: string[] = [];
for (let s = 1; s <= sessions; s++) {
	const clone = join(runDir, `s${s}`, "client");
	cpSync(fixtureDir, clone, { recursive: true });
	clones.push(clone);
}

writeJson(join(runDir, "run.json"), {
	schema: "ksk_stage_eval_run.v1",
	stage,
	skill,
	fixture: fixtureName,
	run_id: runId,
	sessions,
	clones: clones.map((c) => c.replace(`${RUNS_ROOT}/`, "")),
	created: new Date().toISOString(),
	note: typeof flags.note === "string" ? flags.note : null,
});

console.log(`run dir: ${runDir}`);
console.log(`stage: ${stage} (${skill}) · fixture: ${fixtureName} · sessions: ${sessions}\n`);
console.log(
	"Run each line below in a SEPARATE fresh session (independent context).\n" +
		"Each writes its ข้อมูลระบบ tree into its own clone; then: bun run stage-grade.ts -- " +
		`${stage} --run ${runId}\n`,
);

for (let s = 1; s <= sessions; s++) {
	console.log(`### session ${s}/${sessions}`);
	console.log(
		`claude -p 'Run the ${skill} skill on the client folder "${clones[s - 1]}". ` +
			`Do only that one stage, then stop and reply with a short digest ` +
			`(segments interpreted, pages accounted, any gate result).'`,
	);
	console.log("");
}
