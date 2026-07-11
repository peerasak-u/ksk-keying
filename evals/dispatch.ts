// Prepare an eval run: create the run directory and print, per case, the
// exact dispatch prompt the parent session must send to the agent under test
// (via the Agent tool — same harness, same template shape as SKILL.md).
//
//   bun run dispatch.ts -- watson [--cases id1,id2] [--replicates N] [--run-id name]
//
// The parent then spawns one ksk-watson per printed block (parallel batches),
// waits for completion, and runs grade.ts + report.ts on the run dir.

import { cpSync } from "node:fs";
import { join } from "node:path";
import {
	RUNS_ROOT,
	datasetVersion,
	ensureDir,
	listCaseDirs,
	loadCase,
	parseArgs,
	writeJson,
} from "./lib";

const { positional, flags } = parseArgs(process.argv.slice(2));
const agent = positional[0] ?? "watson";
const replicates = Number(flags.replicates ?? 1);
const only =
	typeof flags.cases === "string"
		? new Set((flags.cases as string).split(",").map((s) => s.trim()))
		: null;

const stamp = new Date()
	.toISOString()
	.slice(0, 16)
	.replace(/[-:]/g, "")
	.replace("T", "-");
const runId = typeof flags["run-id"] === "string" ? (flags["run-id"] as string) : stamp;
const runDir = join(RUNS_ROOT, agent, runId);

const caseDirs = listCaseDirs(agent).filter(
	(d) => !only || only.has(loadCase(d).case_id),
);
if (caseDirs.length === 0) {
	console.error("no cases matched");
	process.exit(1);
}

ensureDir(runDir);
writeJson(join(runDir, "run.json"), {
	schema: "ksk_eval_run.v1",
	agent: `ksk-${agent}`,
	run_id: runId,
	dataset_version: datasetVersion(agent),
	replicates,
	cases: caseDirs.map((d) => loadCase(d).case_id),
	created: new Date().toISOString(),
	note: typeof flags.note === "string" ? flags.note : null,
});

console.log(`run dir: ${runDir}`);
console.log(`cases: ${caseDirs.length}, replicates: ${replicates}\n`);

for (const caseDir of caseDirs) {
	const spec = loadCase(caseDir);
	const caseOut = join(runDir, spec.case_id);
	ensureDir(caseOut);

	if (agent === "sherlock") {
		// sherlock writes links.yaml at a fixed path inside the client folder,
		// so each replicate gets its own clone of the case's input snapshot.
		const interpretations = (spec.dispatch as any).interpretations as string[];
		for (let r = 1; r <= replicates; r++) {
			const clone = join(caseOut, `client-r${r}`);
			cpSync(join(caseDir, "client"), clone, { recursive: true });
			const interpList = interpretations.map((p) => join(clone, p)).join(", ");
			console.log(`### ${spec.case_id} r${r}  [agent: ${spec.agent}]`);
			console.log(
				`Link segments for client "${clone}". ` +
					`Draft: ${join(clone, "ข้อมูลระบบ/_doc_groups/links.draft.yaml")}. ` +
					`Interpretation files: ${interpList}. ` +
					`Write ${join(clone, "ข้อมูลระบบ/_doc_groups/links.yaml")}.`,
			);
			console.log("");
		}
		continue;
	}

	const fileList = spec.dispatch.files.map((f) => join(caseDir, f)).join(", ");
	const pages = spec.dispatch.pages ? ` (pages ${spec.dispatch.pages})` : "";
	for (let r = 1; r <= replicates; r++) {
		const resultPath = join(caseOut, `output-r${r}.json`);
		const fragmentPath = join(caseOut, `fragment-r${r}.yaml`);
		console.log(`### ${spec.case_id} r${r}  [agent: ${spec.agent}]`);
		console.log(
			`Segment ${spec.dispatch.segment_id}. Client "${caseDir}". ` +
				`Images: ${fileList}${pages}. ` +
				`Write full interpretation to ${resultPath} + Page Disposition fragment to ${fragmentPath}. ` +
				`Reply digest only.`,
		);
		console.log("");
	}
}
