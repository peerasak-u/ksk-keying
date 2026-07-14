// Grading spec + grader for ksk-lestrade (Stage-2 exclusion-claim audit),
// scored as a CONFUSION MATRIX.
//
// lestrade AUDITS exclusion claims: watson/marple declared a page excluded
// (duplicate / blank / summary sheet / …); lestrade opens only the referenced
// pages and returns a binary verdict — `confirmed` (the exclusion is legit) or
// `refuted` (the exclusion is wrong; this page is really bookable). It never
// edits interpretations. Its quality = catching a BAD exclusion (a real
// primary bookable wrongly marked excluded) without falsely rejecting a GOOD one.
//
// So we frame catching a bad exclusion as the POSITIVE class. The decision we
// read from lestrade's output is: did it REFUTE (raise the alarm) or not?
//   alarm  = verdict === "refuted"
//   no-alarm = "confirmed" | missing verdict | unparseable
// A missing/garbled verdict is folded into no-alarm on purpose: the disposition
// merge leaves an un-refuted exclusion in place, so the page is dropped — same
// downstream danger as an explicit wrong `confirmed`.
//
// Ground truth per claim (from expected.yaml, derived from the pages' own
// content — never the answer key):
//   ground_truth: seeded_false   → a real primary bookable mislabeled excluded → expect REFUTE (POSITIVE)
//   ground_truth: true_exclusion → the page really is duplicate/blank/summary  → expect CONFIRM (NEGATIVE)
//
// Confusion matrix (positive = "should be refuted"):
//   TP  catch        alarm    ∧ seeded_false   — bad exclusion caught
//   FN  miss         no-alarm ∧ seeded_false   — bad exclusion SURVIVED (the dangerous error)
//   FP  false-alarm  alarm    ∧ true_exclusion — good exclusion wrongly rejected
//   TN  confirm      no-alarm ∧ true_exclusion — good exclusion upheld

import { loadYaml } from "../lib";

export type Verdict = "confirmed" | "refuted" | "unresolved";

// Map a raw verdict string to the ternary. Anything that is not clearly a
// confirm or a refute is "unresolved" (treated as no-alarm downstream).
export function normalizeVerdict(v: unknown): Verdict {
	const s = String(v ?? "").trim().toLowerCase();
	if (s === "confirmed" || s === "confirm" || s === "confirms") return "confirmed";
	if (s === "refuted" || s === "refute" || s === "refutes" || s === "rejected")
		return "refuted";
	return "unresolved";
}

// A claim is identified by its file BASENAME + its locus (page, or sheet for
// spreadsheet claims). Full paths differ between the eval clone and a real run,
// so we key on the basename — same convention as watson's page_disposition grader.
export function claimKey(c: any): string {
	const file = String(c?.file ?? "").split("/").pop() ?? "";
	const locus = c?.page ?? c?.sheet ?? "?";
	return `${file}#${locus}`;
}

// Read a lestrade claim-audit file (schema ksk_claim_audit.v1) into
// claimKey → Verdict. Duplicate keys keep the LAST verdict written.
export function normalizeAudit(path: string): Map<string, Verdict> {
	const doc = loadYaml<any>(path);
	const claims: any[] = doc?.claims ?? [];
	const m = new Map<string, Verdict>();
	for (const c of claims) m.set(claimKey(c), normalizeVerdict(c?.verdict));
	return m;
}

export type GroundTruth = "true_exclusion" | "seeded_false";

export interface ExpectedClaim {
	key: string;
	file: string;
	page: number | null;
	reason: string | null;
	ground_truth: GroundTruth;
	expected_verdict: "confirmed" | "refuted";
}

export function loadExpectedClaims(path: string): ExpectedClaim[] {
	const doc = loadYaml<any>(path);
	return (doc?.claims ?? []).map((c: any) => ({
		key: claimKey(c),
		file: String(c?.file ?? ""),
		page: c?.page ?? c?.sheet ?? null,
		reason: c?.reason ?? null,
		ground_truth: c?.ground_truth as GroundTruth,
		expected_verdict: c?.expected_verdict,
	}));
}

export interface ClaimResult {
	key: string;
	ground_truth: GroundTruth;
	got: Verdict;
	outcome: "TP" | "FN" | "FP" | "TN";
}

export interface LestradeGrade {
	claims_expected: number;
	positives: number; // seeded_false claims (expect refute)
	negatives: number; // true_exclusion claims (expect confirm)
	tp: number;
	fn: number;
	fp: number;
	tn: number;
	unresolved: number; // claims with no matching / unparseable output verdict (also folded into the matrix as no-alarm)
	// rates — null when the denominator is 0
	catch_rate: number | null; // TP / positives  (recall / sensitivity)
	miss_rate: number | null; // FN / positives  = 1 - catch_rate  ← the dangerous rate
	false_alarm_rate: number | null; // FP / negatives
	confirm_rate: number | null; // TN / negatives  (specificity)
	precision: number | null; // TP / (TP + FP)  — when it refutes, how often right
	accuracy: number | null; // (TP + TN) / total
	misses: ClaimResult[]; // FN — the dangerous errors
	false_alarms: ClaimResult[]; // FP
	unresolved_claims: Array<{ key: string; ground_truth: GroundTruth }>;
	claims: ClaimResult[]; // every expected claim, in order
}

const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d);

export function gradeAudit(expectedPath: string, outputPath: string): LestradeGrade {
	const expected = loadExpectedClaims(expectedPath);
	const audit = normalizeAudit(outputPath);

	let tp = 0;
	let fn = 0;
	let fp = 0;
	let tn = 0;
	let unresolved = 0;
	const misses: ClaimResult[] = [];
	const false_alarms: ClaimResult[] = [];
	const unresolved_claims: LestradeGrade["unresolved_claims"] = [];
	const claims: ClaimResult[] = [];

	for (const e of expected) {
		const got = audit.get(e.key) ?? "unresolved";
		const alarm = got === "refuted";
		if (got === "unresolved") {
			unresolved++;
			unresolved_claims.push({ key: e.key, ground_truth: e.ground_truth });
		}
		let outcome: ClaimResult["outcome"];
		if (e.ground_truth === "seeded_false") {
			// positive: should be refuted
			if (alarm) {
				tp++;
				outcome = "TP";
			} else {
				fn++;
				outcome = "FN";
			}
		} else {
			// true_exclusion → negative: should be confirmed
			if (alarm) {
				fp++;
				outcome = "FP";
			} else {
				tn++;
				outcome = "TN";
			}
		}
		const result: ClaimResult = { key: e.key, ground_truth: e.ground_truth, got, outcome };
		claims.push(result);
		if (outcome === "FN") misses.push(result);
		if (outcome === "FP") false_alarms.push(result);
	}

	const positives = tp + fn;
	const negatives = fp + tn;
	const total = positives + negatives;
	return {
		claims_expected: expected.length,
		positives,
		negatives,
		tp,
		fn,
		fp,
		tn,
		unresolved,
		catch_rate: rate(tp, positives),
		miss_rate: rate(fn, positives),
		false_alarm_rate: rate(fp, negatives),
		confirm_rate: rate(tn, negatives),
		precision: rate(tp, tp + fp),
		accuracy: rate(tp + tn, total),
		misses,
		false_alarms,
		unresolved_claims,
		claims,
	};
}

// Combine several per-case grades into one confusion matrix (sums + pooled
// rates). Used by the run summary and the multi-case aggregate.
export interface LestradeMatrix {
	tp: number;
	fn: number;
	fp: number;
	tn: number;
	unresolved: number;
	positives: number;
	negatives: number;
	total: number;
	catch_rate: number | null;
	miss_rate: number | null;
	false_alarm_rate: number | null;
	confirm_rate: number | null;
	precision: number | null;
	accuracy: number | null;
}

export function aggregateMatrix(grades: LestradeGrade[]): LestradeMatrix {
	const tp = grades.reduce((a, g) => a + g.tp, 0);
	const fn = grades.reduce((a, g) => a + g.fn, 0);
	const fp = grades.reduce((a, g) => a + g.fp, 0);
	const tn = grades.reduce((a, g) => a + g.tn, 0);
	const unresolved = grades.reduce((a, g) => a + g.unresolved, 0);
	const positives = tp + fn;
	const negatives = fp + tn;
	const total = positives + negatives;
	return {
		tp,
		fn,
		fp,
		tn,
		unresolved,
		positives,
		negatives,
		total,
		catch_rate: rate(tp, positives),
		miss_rate: rate(fn, positives),
		false_alarm_rate: rate(fp, negatives),
		confirm_rate: rate(tn, negatives),
		precision: rate(tp, tp + fp),
		accuracy: rate(tp + tn, total),
	};
}
