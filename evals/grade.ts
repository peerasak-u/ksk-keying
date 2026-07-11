// Deterministic grader: compare each case's outputs against its expected
// artifact under the agent's spec. No model in the loop.
//
//   bun run grade.ts -- <agent> --run <run-id | absolute run dir>
//
// watson: output-r*.json graded field-by-field vs expected.json (including
// page_disposition — the skip/use decisions). sherlock: client-r*/ clones
// graded cluster-by-cluster vs expected.yaml.
//
// Writes per-case grade.json and a run-level summary.json.

import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
	RUNS_ROOT,
	amountEq,
	casesDir,
	loadCase,
	loadJson,
	normText,
	normalizeInterp,
	parseArgs,
	writeJson,
	type NormDoc,
} from "./lib";
import {
	AMOUNT_FIELDS,
	CRITICAL_FIELDS,
	DOC_KIND_ALIASES,
	FLAG_KEYWORDS,
	NULL_ZERO_EQUIVALENT,
	SOFT_FIELDS,
	TEXT_NORMALIZED_FIELDS,
} from "./specs/watson";
import { gradeLinks } from "./specs/sherlock";

type FieldState =
	| "correct"
	| "wrong_flagged"
	| "wrong_silent"
	| "missing_value"
	| "spurious_value";

interface ReplicateGrade {
	case_id: string;
	provisional: boolean;
	replicate: string;
	case_pass: boolean;
	field_states: Record<string, FieldState[]>;
	counts: Record<string, number>;
	[extra: string]: unknown;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const agent = positional[0] ?? "watson";
const runArg = String(flags.run ?? "");
if (!runArg) {
	console.error("missing --run <run-id | run dir>");
	process.exit(2);
}
const runDir = isAbsolute(runArg) ? runArg : join(RUNS_ROOT, agent, runArg);
if (!existsSync(join(runDir, "run.json"))) {
	console.error(`not a run dir (no run.json): ${runDir}`);
	process.exit(1);
}
const runMeta = loadJson<any>(join(runDir, "run.json"));

function countsFrom(states: FieldState[]): Record<string, number> {
	const count = (s: FieldState) => states.filter((x) => x === s).length;
	return {
		fields_total: states.length,
		correct: count("correct"),
		wrong_flagged: count("wrong_flagged"),
		// Silent = any unflagged deviation: wrong, missing, or invented value.
		// All three walk into PEAK unnoticed; only flagged wrongs get caught.
		silent_total:
			count("wrong_silent") + count("missing_value") + count("spurious_value"),
		wrong_silent: count("wrong_silent"),
		missing_value: count("missing_value"),
		spurious_value: count("spurious_value"),
	};
}

// ---------------------------------------------------------------------------
// watson
// ---------------------------------------------------------------------------

function docKindEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	return DOC_KIND_ALIASES.some(
		([x, y]) => (a === x && b === y) || (a === y && b === x),
	);
}

function fieldValue(doc: NormDoc, field: string): unknown {
	if (field === "doc_kind") return doc.doc_kind;
	return doc.facts?.[field as keyof typeof doc.facts];
}

function valuesMatch(field: string, exp: unknown, out: unknown): boolean {
	if (exp == null && out == null) return true;
	if (NULL_ZERO_EQUIVALENT.has(field)) {
		const z = (v: unknown) => (v == null ? 0 : v);
		return amountEq(z(exp), z(out));
	}
	if (AMOUNT_FIELDS.has(field)) return amountEq(exp, out);
	if (field === "doc_kind") return docKindEq(exp, out);
	if (TEXT_NORMALIZED_FIELDS.has(field)) return normText(exp) === normText(out);
	return String(exp ?? "").trim() === String(out ?? "").trim();
}

function flagsMention(flagTexts: string[], field: string): boolean {
	const keywords = FLAG_KEYWORDS[field] ?? [field];
	const haystack = flagTexts.join(" | ").toLowerCase();
	return keywords.some((k) => haystack.includes(k.toLowerCase()));
}

function gradeField(
	field: string,
	exp: unknown,
	out: unknown,
	outFlags: string[],
): FieldState {
	if (valuesMatch(field, exp, out)) return "correct";
	const flagged = flagsMention(outFlags, field);
	if (exp != null && out == null) return flagged ? "wrong_flagged" : "missing_value";
	if (exp == null && out != null) return flagged ? "wrong_flagged" : "spurious_value";
	return flagged ? "wrong_flagged" : "wrong_silent";
}

function matchDocs(expected: NormDoc[], output: NormDoc[]) {
	const pairs: Array<{ exp: NormDoc; out: NormDoc }> = [];
	const outLeft = [...output];
	const expLeft: NormDoc[] = [];
	const take = (pred: (o: NormDoc) => boolean): NormDoc | null => {
		const i = outLeft.findIndex(pred);
		return i === -1 ? null : outLeft.splice(i, 1)[0];
	};
	for (const exp of expected) {
		const no = exp.facts?.document_no;
		let out = no != null ? take((o) => o.facts?.document_no === no) : null;
		out ??=
			exp.source_page != null
				? take((o) => o.source_page === exp.source_page)
				: null;
		out ??= take((o) => amountEq(o.facts?.gross_total, exp.facts?.gross_total));
		if (out) pairs.push({ exp, out });
		else expLeft.push(exp);
	}
	return { pairs, missingDocs: expLeft, spuriousDocs: outLeft };
}

function gradeLineItems(exp: any[], out: any[]) {
	const outLeft = [...out];
	let matched = 0;
	for (const e of exp) {
		const i = outLeft.findIndex((o) => amountEq(o?.amount, e?.amount));
		if (i !== -1) {
			outLeft.splice(i, 1);
			matched++;
		}
	}
	return { expected: exp.length, matched, missing: exp.length - matched, spurious: outLeft.length };
}

// Skip/use decisions: every expected page must appear with the same
// disposition. Keyed by basename#page — eval inputs live under input/, so
// full paths differ from the production run's by design.
function gradePages(exp: any[], out: any[]): FieldState[] {
	const key = (p: any) => `${String(p?.file ?? "").split("/").pop()}#${p?.page}`;
	const outMap = new Map(out.map((p) => [key(p), p?.disposition]));
	const states: FieldState[] = [];
	const seen = new Set<string>();
	for (const p of exp) {
		const k = key(p);
		seen.add(k);
		const od = outMap.get(k);
		if (od === undefined) states.push("missing_value");
		else states.push(od === p?.disposition ? "correct" : "wrong_silent");
	}
	for (const p of out) if (!seen.has(key(p))) states.push("spurious_value");
	return states;
}

function gradeWatsonReplicate(caseDir: string, outputPath: string): ReplicateGrade {
	const spec = loadCase(caseDir);
	const expRaw = loadJson<any>(join(caseDir, "expected.json"));
	const outRaw = loadJson<any>(outputPath);
	const expected = normalizeInterp(expRaw);
	const output = normalizeInterp(outRaw);

	const allOutFlags = [...output.flags, ...output.docs.flatMap((d) => d.flags)];
	const { pairs, missingDocs, spuriousDocs } = matchDocs(expected.docs, output.docs);

	const docs = pairs.map(({ exp, out }) => {
		const outFlags = [...out.flags, ...output.flags];
		const fields: Record<string, FieldState> = {};
		for (const f of CRITICAL_FIELDS)
			fields[f] = gradeField(f, fieldValue(exp, f), fieldValue(out, f), outFlags);
		const soft: Record<string, FieldState> = {};
		for (const f of SOFT_FIELDS)
			soft[f] = gradeField(f, fieldValue(exp, f), fieldValue(out, f), outFlags);
		return {
			document_no: exp.facts?.document_no ?? null,
			source_page: exp.source_page,
			fields,
			soft,
			line_items: gradeLineItems(exp.line_items as any[], out.line_items as any[]),
		};
	});

	const pageStates = gradePages(
		expRaw.page_disposition ?? [],
		outRaw.page_disposition ?? [],
	);

	const expectedFlagResults: Record<string, "present" | "missing"> = {};
	for (const token of spec.expected_flags ?? []) {
		expectedFlagResults[token] = flagsMention(allOutFlags, token)
			? "present"
			: "missing";
	}
	const flagMisses = Object.values(expectedFlagResults).filter(
		(v) => v === "missing",
	).length;

	const field_states: Record<string, FieldState[]> = {};
	for (const f of CRITICAL_FIELDS)
		field_states[f] = docs.map((d) => d.fields[f]);
	field_states.page_disposition = pageStates;

	const states = Object.values(field_states).flat();
	const counts = {
		...countsFrom(states),
		missing_documents: missingDocs.length,
		spurious_documents: spuriousDocs.length,
		expected_flags_missing: flagMisses,
	};
	const casePass =
		missingDocs.length === 0 &&
		spuriousDocs.length === 0 &&
		flagMisses === 0 &&
		states.every((s) => s === "correct");

	return {
		case_id: spec.case_id,
		provisional: spec.provisional === true,
		replicate: basename(outputPath).match(/-r(\d+)\./)?.[1] ?? "1",
		case_pass: casePass,
		field_states,
		counts,
		docs,
		missing_documents: missingDocs.map((d) => d.facts?.document_no ?? d.source_page),
		spurious_documents: spuriousDocs.map((d) => d.facts?.document_no ?? d.source_page),
		expected_flags: expectedFlagResults,
	};
}

// ---------------------------------------------------------------------------
// sherlock
// ---------------------------------------------------------------------------

function gradeSherlockReplicate(
	caseDir: string,
	cloneDir: string,
	replicate: string,
): ReplicateGrade | null {
	const spec = loadCase(caseDir);
	const outputPath = join(cloneDir, "ข้อมูลระบบ/_doc_groups/links.yaml");
	if (!existsSync(outputPath)) {
		console.error(`  ${spec.case_id} r${replicate}: no links.yaml written`);
		return null;
	}
	const g = gradeLinks(join(caseDir, "expected.yaml"), outputPath);

	// Membership: each expected cluster reproduced exactly = correct; a
	// missing cluster is silent (nothing downstream flags it); spurious
	// clusters are invented groupings.
	const membership: FieldState[] = [
		...Array(g.clusters_exact).fill("correct" as FieldState),
		...g.missing_clusters.map(() => "missing_value" as FieldState),
		...g.spurious_clusters.map(() => "spurious_value" as FieldState),
	];
	const bookable: FieldState[] = [
		...Array(g.bookable_correct).fill("correct" as FieldState),
		...g.bookable_mismatches.map(() => "wrong_silent" as FieldState),
	];
	const multi: FieldState[] = [
		...Array(g.multi_exact).fill("correct" as FieldState),
		...Array(g.multi_expected - g.multi_exact).fill("wrong_silent" as FieldState),
	];

	const field_states: Record<string, FieldState[]> = {
		cluster_membership: membership,
		bookable_docs: bookable,
		multi_member_clusters: multi,
	};
	const states = [...membership, ...bookable];
	const casePass = states.every((s) => s === "correct");

	return {
		case_id: spec.case_id,
		provisional: spec.provisional === true,
		replicate,
		case_pass: casePass,
		field_states,
		counts: {
			...countsFrom(states),
			missing_documents: 0,
			spurious_documents: g.spurious_clusters.length,
			expected_flags_missing: 0,
		},
		detail: g,
	};
}

// ---------------------------------------------------------------------------
// walk the run
// ---------------------------------------------------------------------------

const caseGrades: Array<{ replicates: ReplicateGrade[]; agreement: unknown }> = [];
for (const caseId of runMeta.cases as string[]) {
	const caseDir = join(casesDir(agent), caseId);
	const caseOut = join(runDir, caseId);
	if (!existsSync(caseOut)) {
		console.error(`skip ${caseId}: no output dir`);
		continue;
	}

	let replicates: ReplicateGrade[] = [];
	if (agent === "sherlock") {
		replicates = readdirSync(caseOut)
			.filter((f) => /^client-r\d+$/.test(f))
			.sort()
			.map((d) =>
				gradeSherlockReplicate(caseDir, join(caseOut, d), d.match(/r(\d+)$/)![1]),
			)
			.filter((r): r is ReplicateGrade => r !== null);
	} else {
		replicates = readdirSync(caseOut)
			.filter((f) => /^output-r\d+\.json$/.test(f))
			.sort()
			.map((f) => gradeWatsonReplicate(caseDir, join(caseOut, f)));
	}
	if (replicates.length === 0) {
		console.error(`skip ${caseId}: no outputs`);
		continue;
	}

	// Cross-replicate agreement per graded dimension (meaningful when >1).
	let agreement: Record<string, boolean> | null = null;
	if (replicates.length > 1) {
		agreement = {};
		for (const f of Object.keys(replicates[0].field_states)) {
			const per = replicates.map((r) => (r.field_states[f] ?? []).join(","));
			agreement[f] = new Set(per).size === 1;
		}
	}

	const grade = { schema: "ksk_eval_grade.v2", replicates, agreement };
	writeJson(join(caseOut, "grade.json"), grade);
	caseGrades.push(grade);
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const firstReplicates = caseGrades.map((g) => g.replicates[0]);
const solid = firstReplicates.filter((r) => !r.provisional);
const sum = (rs: ReplicateGrade[], key: string) =>
	rs.reduce((acc, r) => acc + (r.counts[key] ?? 0), 0);

const fieldNames = [
	...new Set(firstReplicates.flatMap((r) => Object.keys(r.field_states))),
];
const fieldTable: Record<string, Record<string, number>> = {};
for (const f of fieldNames) {
	const states = firstReplicates.flatMap((r) => r.field_states[f] ?? []);
	fieldTable[f] = {
		correct: states.filter((s) => s === "correct").length,
		wrong_flagged: states.filter((s) => s === "wrong_flagged").length,
		wrong_silent: states.filter((s) => s === "wrong_silent").length,
		missing_value: states.filter((s) => s === "missing_value").length,
		spurious_value: states.filter((s) => s === "spurious_value").length,
	};
}

const summary = {
	schema: "ksk_eval_summary.v1",
	agent: runMeta.agent,
	run_id: runMeta.run_id,
	dataset_version: runMeta.dataset_version,
	graded_at: new Date().toISOString(),
	note: runMeta.note ?? null,
	cases_graded: firstReplicates.length,
	cases_passed: firstReplicates.filter((r) => r.case_pass).length,
	solid: {
		cases: solid.length,
		passed: solid.filter((r) => r.case_pass).length,
		fields_total: sum(solid, "fields_total"),
		silent_total: sum(solid, "silent_total"),
		silent_error_rate:
			sum(solid, "fields_total") === 0
				? null
				: sum(solid, "silent_total") / sum(solid, "fields_total"),
	},
	all: {
		fields_total: sum(firstReplicates, "fields_total"),
		correct: sum(firstReplicates, "correct"),
		wrong_flagged: sum(firstReplicates, "wrong_flagged"),
		silent_total: sum(firstReplicates, "silent_total"),
		wrong_silent: sum(firstReplicates, "wrong_silent"),
		missing_value: sum(firstReplicates, "missing_value"),
		spurious_value: sum(firstReplicates, "spurious_value"),
		missing_documents: sum(firstReplicates, "missing_documents"),
		spurious_documents: sum(firstReplicates, "spurious_documents"),
		expected_flags_missing: sum(firstReplicates, "expected_flags_missing"),
	},
	fields: fieldTable,
	cases: firstReplicates.map((r) => ({
		case_id: r.case_id,
		provisional: r.provisional,
		pass: r.case_pass,
		silent_total: r.counts.silent_total,
		replicate_count:
			caseGrades.find((g) => g.replicates[0] === r)?.replicates.length ?? 1,
	})),
};
writeJson(join(runDir, "summary.json"), summary);
console.log(
	`graded ${firstReplicates.length} case(s) → ${join(runDir, "summary.json")}`,
);
