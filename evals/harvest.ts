// Build one eval case from a *verified* client run.
//
//   bun run harvest.ts -- watson \
//     --client "samples/ready-for-test/<client>/<month>" \
//     --case-id 216-may-seg006-income \
//     --segment seg-006 \
//     --files "รายได้ vat/Doc_ RT-20260500001.pdf" \
//     --expected "ข้อมูลระบบ/_segments/seg-006/interpretation.json" \
//     --verified-by "answer_key+ledger_gate" \
//     [--pages 1-4] [--expected-flags "wht,..."] [--provisional] [--note "..."]
//
// Refuses to harvest unless the month's ledger gate is final+pass — unverified
// pipeline output must never become ground truth.

import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import YAML from "yaml";
import {
	REPO_ROOT,
	casesDir,
	copyInto,
	ensureDir,
	loadYaml,
	nowIso,
	parseArgs,
} from "./lib";
import { writeFileSync } from "node:fs";

const { positional, flags } = parseArgs(process.argv.slice(2));
const agent = positional[0];
if (agent !== "watson") {
	console.error(`unsupported agent "${agent}" — only watson is implemented`);
	process.exit(2);
}

function req(name: string): string {
	const v = flags[name];
	if (typeof v !== "string" || !v) {
		console.error(`missing required --${name}`);
		process.exit(2);
	}
	return v;
}

const clientDir = resolve(REPO_ROOT, req("client"));
const caseId = req("case-id");
const segmentId = req("segment");
const files = req("files")
	.split(",")
	.map((f) => f.trim())
	.filter(Boolean);
const expectedPath = join(clientDir, req("expected"));
const verifiedBy = req("verified-by");

// Gate check: only harvest from a month whose ledger passed.
const ledgerPath = join(clientDir, "ข้อมูลระบบ/_pages/ledger.yaml");
if (!existsSync(ledgerPath)) {
	console.error(`no ledger at ${ledgerPath} — run the pipeline gates first`);
	process.exit(1);
}
const ledger = loadYaml<{ gate?: string; result?: string }>(ledgerPath);
if (ledger.gate !== "final" || ledger.result !== "pass") {
	console.error(
		`ledger gate is ${ledger.gate}/${ledger.result} — refusing to harvest from an unverified run`,
	);
	process.exit(1);
}
if (!existsSync(expectedPath)) {
	console.error(`expected file not found: ${expectedPath}`);
	process.exit(1);
}

const caseDir = join(casesDir(agent), caseId);
if (existsSync(join(caseDir, "case.yaml"))) {
	console.error(`case ${caseId} already exists — delete it first to re-harvest`);
	process.exit(1);
}
ensureDir(join(caseDir, "input"));

const inputFiles: string[] = [];
for (const rel of files) {
	const src = join(clientDir, rel);
	if (!existsSync(src)) {
		console.error(`input file not found: ${src}`);
		process.exit(1);
	}
	copyInto(src, join(caseDir, "input"));
	inputFiles.push(join("input", basename(rel)));
}
copyInto(expectedPath, caseDir, "expected.json");
const clientMd = join(clientDir, "CLIENT.md");
if (existsSync(clientMd)) copyInto(clientMd, caseDir, "CLIENT.md");
else console.warn("warning: no CLIENT.md in client dir — case has no client context");

const spec = {
	schema: "ksk_eval_case.v1",
	agent: `ksk-${agent}`,
	case_id: caseId,
	provisional: flags.provisional === true,
	dispatch: {
		segment_id: segmentId,
		files: inputFiles,
		...(typeof flags.pages === "string" ? { pages: flags.pages } : {}),
	},
	expected_flags:
		typeof flags["expected-flags"] === "string"
			? (flags["expected-flags"] as string)
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: [],
	provenance: {
		client: basename(resolve(clientDir, "..")),
		month: basename(clientDir),
		source: files.join(", "),
		verified_by: verifiedBy,
		harvested: nowIso(),
		...(typeof flags.note === "string" ? { note: flags.note } : {}),
	},
};
writeFileSync(join(caseDir, "case.yaml"), YAML.stringify(spec));
console.log(`harvested ${caseId} → ${caseDir}`);
console.log(`  inputs: ${inputFiles.length} file(s), provisional: ${spec.provisional}`);
