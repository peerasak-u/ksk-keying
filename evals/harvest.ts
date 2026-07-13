// Build one eval case from a *verified* client run.
//
// watson (one visual segment):
//   bun run harvest.ts -- watson \
//     --client "samples/clients/<client>/<month>" \
//     --case-id 216-may-seg006-income --segment seg-006 \
//     --files "รายได้ vat/Doc_ RT-20260500001.pdf" \
//     --expected "ข้อมูลระบบ/_segments/seg-006/interpretation.json" \
//     --verified-by "answer_key+ledger_gate" \
//     [--pages 1-4] [--expected-flags "wht,..."] [--provisional] [--note "..."]
//
// sherlock (one client-month linking snapshot):
//   bun run harvest.ts -- sherlock \
//     --client "samples/clients/<client>" \
//     --case-id 356-full-links \
//     --verified-by "answer_key comparison + ledger_gate" [--provisional] [--note "..."]
//   Copies CLIENT.md + all _segments/**/interpretation*.json + links.draft.yaml
//   into <case>/client/, and the verified links.yaml to <case>/expected.yaml.
//
// Refuses to harvest unless the month's ledger gate is final+pass — unverified
// pipeline output must never become ground truth.

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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

const { positional, flags } = parseArgs(process.argv.slice(2));
const agent = positional[0];
if (agent !== "watson" && agent !== "sherlock") {
	console.error(`unsupported agent "${agent}" — watson | sherlock`);
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
const verifiedBy = req("verified-by");

// Gate check: only harvest from a run whose ledger passed.
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

const caseDir = join(casesDir(agent), caseId);
if (existsSync(join(caseDir, "case.yaml"))) {
	console.error(`case ${caseId} already exists — delete it first to re-harvest`);
	process.exit(1);
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

let spec: Record<string, unknown>;

if (agent === "watson") {
	const segmentId = req("segment");
	const files = req("files")
		.split(",")
		.map((f) => f.trim())
		.filter(Boolean);
	const expectedPath = join(clientDir, req("expected"));
	if (!existsSync(expectedPath)) {
		console.error(`expected file not found: ${expectedPath}`);
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
	// The dispatch must cover every file the expected disposition accounts
	// for — a narrower input list silently turns correct skip decisions into
	// "missing" grades (found the hard way on a duplicate-source file).
	const expDisp = JSON.parse(
		require("node:fs").readFileSync(join(caseDir, "expected.json"), "utf8"),
	)?.page_disposition ?? [];
	const provided = new Set(inputFiles.map((f) => basename(f)));
	const uncovered = [
		...new Set(
			expDisp
				.map((p: any) => String(p?.file ?? "").split("/").pop()!)
				.filter((b: string) => b && !provided.has(b)),
		),
	];
	if (uncovered.length > 0) {
		console.error(
			`expected.json page_disposition covers files missing from --files: ${uncovered.join(", ")}`,
		);
		process.exit(1);
	}
	const clientMd = join(clientDir, "CLIENT.md");
	if (existsSync(clientMd)) copyInto(clientMd, caseDir, "CLIENT.md");
	else console.warn("warning: no CLIENT.md in client dir");

	spec = {
		schema: "ksk_eval_case.v1",
		agent: "ksk-watson",
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
} else {
	// sherlock: snapshot the linking inputs, expected = verified links.yaml.
	const expectedSrc = join(clientDir, "ข้อมูลระบบ/_doc_groups/links.yaml");
	const draftSrc = join(clientDir, "ข้อมูลระบบ/_doc_groups/links.draft.yaml");
	if (!existsSync(expectedSrc)) {
		console.error(`no verified links.yaml at ${expectedSrc}`);
		process.exit(1);
	}
	if (!existsSync(draftSrc)) {
		console.error(`no links.draft.yaml at ${draftSrc} — sherlock needs the prelink draft`);
		process.exit(1);
	}
	const segRoot = join(clientDir, "ข้อมูลระบบ/_segments");
	const interpretations = walk(segRoot).filter((p) =>
		/interpretation[^/]*\.json$/.test(basename(p)),
	);
	if (interpretations.length === 0) {
		console.error("no interpretation files found");
		process.exit(1);
	}
	const clientClone = join(caseDir, "client");
	const relPaths: string[] = [];
	for (const src of interpretations) {
		const rel = relative(clientDir, src);
		ensureDir(join(clientClone, dirname(rel)));
		copyInto(src, join(clientClone, dirname(rel)));
		relPaths.push(rel);
	}
	ensureDir(join(clientClone, "ข้อมูลระบบ/_doc_groups"));
	copyInto(draftSrc, join(clientClone, "ข้อมูลระบบ/_doc_groups"));
	const clientMd = join(clientDir, "CLIENT.md");
	if (existsSync(clientMd)) copyInto(clientMd, clientClone, "CLIENT.md");
	copyInto(expectedSrc, caseDir, "expected.yaml");

	spec = {
		schema: "ksk_eval_case.v1",
		agent: "ksk-sherlock",
		case_id: caseId,
		provisional: flags.provisional === true,
		dispatch: { interpretations: relPaths.sort() },
		provenance: {
			client: basename(clientDir),
			month: null,
			source: "ข้อมูลระบบ/_segments + links.draft.yaml snapshot",
			verified_by: verifiedBy,
			harvested: nowIso(),
			...(typeof flags.note === "string" ? { note: flags.note } : {}),
		},
	};
}

writeFileSync(join(caseDir, "case.yaml"), YAML.stringify(spec));
console.log(`harvested ${caseId} → ${caseDir}`);
