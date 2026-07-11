// Deterministic grader: compare each case's output-r*.json against
// expected.json under the agent's field spec. No model in the loop.
//
//   bun run grade.ts -- watson --run <run-id | absolute run dir>
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

type FieldState =
	| "correct"
	| "wrong_flagged"
	| "wrong_silent"
	| "missing_value"
	| "spurious_value";

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

// --- field comparison ------------------------------------------------------

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

// --- document matching -----------------------------------------------------

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
		let out =
			no != null
				? take((o) => o.facts?.document_no === no)
				: null;
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

// --- line items (soft) ------------------------------------------------------

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

// --- grade one replicate ----------------------------------------------------

function gradeReplicate(caseDir: string, outputPath: string) {
	const spec = loadCase(caseDir);
	const expected = normalizeInterp(loadJson(join(caseDir, "expected.json")));
	const output = normalizeInterp(loadJson(outputPath));

	const allOutFlags = [
		...output.flags,
		...output.docs.flatMap((d) => d.flags),
	];

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

	const expectedFlagResults: Record<string, "present" | "missing"> = {};
	for (const token of spec.expected_flags ?? []) {
		expectedFlagResults[token] = flagsMention(allOutFlags, token)
			? "present"
			: "missing";
	}

	const states = docs.flatMap((d) => Object.values(d.fields));
	const count = (s: FieldState) => states.filter((x) => x === s).length;
	// Silent = any unflagged deviation: wrong value, missing value, or invented
	// value. All three walk into PEAK unnoticed; only flagged wrongs get caught.
	const silentTotal =
		count("wrong_silent") + count("missing_value") + count("spurious_value");
	const flagMisses = Object.values(expectedFlagResults).filter(
		(v) => v === "missing",
	).length;
	const casePass =
		missingDocs.length === 0 &&
		spuriousDocs.length === 0 &&
		flagMisses === 0 &&
		states.every((s) => s === "correct");

	return {
		case_id: spec.case_id,
		provisional: spec.provisional === true,
		replicate: basename(outputPath).match(/-r(\d+)\.json$/)?.[1] ?? "1",
		case_pass: casePass,
		docs,
		missing_documents: missingDocs.map((d) => d.facts?.document_no ?? d.source_page),
		spurious_documents: spuriousDocs.map((d) => d.facts?.document_no ?? d.source_page),
		expected_flags: expectedFlagResults,
		counts: {
			fields_total: states.length,
			correct: count("correct"),
			wrong_flagged: count("wrong_flagged"),
			silent_total: silentTotal,
			wrong_silent: count("wrong_silent"),
			missing_value: count("missing_value"),
			spurious_value: count("spurious_value"),
			missing_documents: missingDocs.length,
			spurious_documents: spuriousDocs.length,
			expected_flags_missing: flagMisses,
		},
	};
}

// --- walk the run -----------------------------------------------------------

const caseGrades: any[] = [];
for (const caseId of runMeta.cases as string[]) {
	const caseDir = join(casesDir(agent), caseId);
	const caseOut = join(runDir, caseId);
	if (!existsSync(caseOut)) {
		console.error(`skip ${caseId}: no output dir`);
		continue;
	}
	const outputs = readdirSync(caseOut)
		.filter((f) => /^output-r\d+\.json$/.test(f))
		.sort();
	if (outputs.length === 0) {
		console.error(`skip ${caseId}: no output-r*.json`);
		continue;
	}
	const replicates = outputs.map((f) => gradeReplicate(caseDir, join(caseOut, f)));

	// Cross-replicate agreement per critical field (only meaningful when >1).
	let agreement: Record<string, boolean> | null = null;
	if (replicates.length > 1) {
		agreement = {};
		for (const f of CRITICAL_FIELDS) {
			const perReplicate = replicates.map((r) =>
				r.docs.map((d: any) => d.fields[f]).join(","),
			);
			agreement[f] = new Set(perReplicate).size === 1;
		}
	}

	const grade = { schema: "ksk_eval_grade.v1", replicates, agreement };
	writeJson(join(caseOut, "grade.json"), grade);
	caseGrades.push(grade);
}

// --- summary -----------------------------------------------------------------

const firstReplicates = caseGrades.map((g) => g.replicates[0]);
const solid = firstReplicates.filter((r) => !r.provisional);
const sum = (rs: any[], key: string) =>
	rs.reduce((acc, r) => acc + r.counts[key], 0);

const fieldTable: Record<string, Record<string, number>> = {};
for (const f of CRITICAL_FIELDS) {
	const states = firstReplicates.flatMap((r) =>
		r.docs.map((d: any) => d.fields[f] as FieldState),
	);
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
		replicate_count: caseGrades.find((g) => g.replicates[0] === r)?.replicates.length ?? 1,
	})),
};
writeJson(join(runDir, "summary.json"), summary);
console.log(`graded ${firstReplicates.length} case(s) → ${join(runDir, "summary.json")}`);
