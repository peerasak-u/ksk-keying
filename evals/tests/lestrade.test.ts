import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	aggregateMatrix,
	claimKey,
	gradeAudit,
	normalizeVerdict,
	type LestradeGrade,
} from "../specs/lestrade";

// The grader reads YAML files; JSON is valid YAML, so we synthesize the two
// inputs (an expected.yaml + a fake lestrade claim-audit.yaml) as JSON. No live
// agent is dispatched here — this only exercises the confusion-matrix math.
const scratch = mkdtempSync(join(tmpdir(), "ksk-lestrade-grade-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type ExpClaim = {
	file: string;
	page: number;
	ground_truth: "true_exclusion" | "seeded_false";
	expected_verdict: "confirmed" | "refuted";
};
type OutClaim = { file: string; page?: number; verdict?: string };

let n = 0;
function grade(expected: ExpClaim[], output: OutClaim[]): LestradeGrade {
	const dir = join(scratch, `case-${n++}`);
	const expPath = join(dir, "expected.yaml");
	const outPath = join(dir, "audit.yaml");
	require("node:fs").mkdirSync(dir, { recursive: true });
	writeFileSync(
		expPath,
		JSON.stringify({ schema: "ksk_lestrade_expected.v1", segment_id: "seg-x", claims: expected }),
	);
	writeFileSync(
		outPath,
		JSON.stringify({ schema: "ksk_claim_audit.v1", segment_id: "seg-x", claims: output }),
	);
	return gradeAudit(expPath, outPath);
}

describe("normalizeVerdict", () => {
	test("confirmed / refuted spellings map to the two decisions", () => {
		expect(normalizeVerdict("confirmed")).toBe("confirmed");
		expect(normalizeVerdict("Confirm")).toBe("confirmed");
		expect(normalizeVerdict("REFUTED")).toBe("refuted");
		expect(normalizeVerdict("refute")).toBe("refuted");
		expect(normalizeVerdict("rejected")).toBe("refuted");
	});
	test("empty / unknown / null verdicts are unresolved (treated as no-alarm downstream)", () => {
		expect(normalizeVerdict("")).toBe("unresolved");
		expect(normalizeVerdict("maybe")).toBe("unresolved");
		expect(normalizeVerdict(undefined)).toBe("unresolved");
		expect(normalizeVerdict(null)).toBe("unresolved");
	});
});

describe("claimKey", () => {
	test("keys on file BASENAME + page so clone paths and run paths align", () => {
		expect(claimKey({ file: "a/b/c.pdf", page: 3 })).toBe("c.pdf#3");
		expect(claimKey({ file: "c.pdf", page: 3 })).toBe("c.pdf#3");
	});
	test("falls back to sheet locus for spreadsheet claims", () => {
		expect(claimKey({ file: "x.xlsx", sheet: "Sheet1" })).toBe("x.xlsx#Sheet1");
	});
});

// The ruler itself: a hand-built 6-claim scenario covering every outcome a real
// audit run can produce — TP (bad exclusion caught), FN (bad exclusion missed:
// both an explicit wrong `confirmed` AND a silently-dropped claim), FP (good
// exclusion wrongly refuted), TN (good exclusion upheld: both an explicit
// `confirmed` AND an unparseable verdict that defaults to no-alarm).
describe("gradeAudit — confusion matrix over all four outcomes", () => {
	const expected: ExpClaim[] = [
		{ file: "a.pdf", page: 2, ground_truth: "seeded_false", expected_verdict: "refuted" }, // -> TP
		{ file: "b.pdf", page: 5, ground_truth: "seeded_false", expected_verdict: "refuted" }, // -> FN (wrong confirm)
		{ file: "c.pdf", page: 1, ground_truth: "true_exclusion", expected_verdict: "confirmed" }, // -> FP
		{ file: "d.pdf", page: 3, ground_truth: "true_exclusion", expected_verdict: "confirmed" }, // -> TN
		{ file: "e.pdf", page: 7, ground_truth: "seeded_false", expected_verdict: "refuted" }, // -> FN (unresolved)
		{ file: "f.pdf", page: 9, ground_truth: "true_exclusion", expected_verdict: "confirmed" }, // -> TN (unparseable)
	];
	const output: OutClaim[] = [
		{ file: "a.pdf", page: 2, verdict: "refuted" },
		{ file: "b.pdf", page: 5, verdict: "confirmed" },
		{ file: "run/clone/เดือน/c.pdf", page: 1, verdict: "refuted" }, // full path — must match c.pdf via basename
		{ file: "d.pdf", page: 3, verdict: "confirmed" },
		// e.pdf: no entry at all -> unresolved
		{ file: "f.pdf", page: 9, verdict: "???" }, // garbage -> unresolved
	];
	const g = grade(expected, output);

	test("counts land in the right cells", () => {
		expect(g.tp).toBe(1);
		expect(g.fn).toBe(2);
		expect(g.fp).toBe(1);
		expect(g.tn).toBe(2);
		expect(g.positives).toBe(3);
		expect(g.negatives).toBe(3);
	});
	test("a missing output verdict AND a garbage verdict both count as unresolved (no-alarm)", () => {
		expect(g.unresolved).toBe(2);
		expect(g.unresolved_claims.map((u) => u.key).sort()).toEqual(["e.pdf#7", "f.pdf#9"]);
	});
	test("rates match the hand-computed values", () => {
		expect(g.catch_rate).toBeCloseTo(1 / 3, 10); // TP / positives
		expect(g.miss_rate).toBeCloseTo(2 / 3, 10); // FN / positives
		expect(g.false_alarm_rate).toBeCloseTo(1 / 3, 10); // FP / negatives
		expect(g.confirm_rate).toBeCloseTo(2 / 3, 10); // TN / negatives
		expect(g.precision).toBeCloseTo(1 / 2, 10); // TP / (TP+FP)
		expect(g.accuracy).toBeCloseTo(0.5, 10); // (TP+TN) / total
	});
	test("miss-rate is exactly 1 - catch-rate", () => {
		expect(g.miss_rate! + g.catch_rate!).toBeCloseTo(1, 10);
	});
	test("the dangerous list names both kinds of miss (wrong-confirm and dropped)", () => {
		expect(g.misses.map((m) => m.key).sort()).toEqual(["b.pdf#5", "e.pdf#7"]);
		const bMiss = g.misses.find((m) => m.key === "b.pdf#5");
		const eMiss = g.misses.find((m) => m.key === "e.pdf#7");
		expect(bMiss!.got).toBe("confirmed");
		expect(eMiss!.got).toBe("unresolved");
	});
	test("false alarms name the wrongly-refuted good exclusion", () => {
		expect(g.false_alarms.map((f) => f.key)).toEqual(["c.pdf#1"]);
	});
	test("each expected claim is present once in claims[] with its outcome tag", () => {
		expect(g.claims).toHaveLength(6);
		const byKey = Object.fromEntries(g.claims.map((c) => [c.key, c.outcome]));
		expect(byKey).toMatchObject({
			"a.pdf#2": "TP",
			"b.pdf#5": "FN",
			"c.pdf#1": "FP",
			"d.pdf#3": "TN",
			"e.pdf#7": "FN",
			"f.pdf#9": "TN",
		});
	});
});

describe("gradeAudit — a perfect run passes with zero miss/false-alarm", () => {
	const g = grade(
		[
			{ file: "dup.pdf", page: 2, ground_truth: "true_exclusion", expected_verdict: "confirmed" },
			{ file: "real.pdf", page: 1, ground_truth: "seeded_false", expected_verdict: "refuted" },
		],
		[
			{ file: "dup.pdf", page: 2, verdict: "confirmed" },
			{ file: "real.pdf", page: 1, verdict: "refuted" },
		],
	);
	test("all correct → miss-rate 0, false-alarm-rate 0, accuracy 1", () => {
		expect(g.fn).toBe(0);
		expect(g.fp).toBe(0);
		expect(g.unresolved).toBe(0);
		expect(g.miss_rate).toBe(0);
		expect(g.false_alarm_rate).toBe(0);
		expect(g.accuracy).toBe(1);
	});
});

describe("gradeAudit — divide-by-zero denominators are null, not NaN", () => {
	test("an all-positive case has null false_alarm_rate / confirm_rate", () => {
		const g = grade(
			[{ file: "x.pdf", page: 1, ground_truth: "seeded_false", expected_verdict: "refuted" }],
			[{ file: "x.pdf", page: 1, verdict: "refuted" }],
		);
		expect(g.negatives).toBe(0);
		expect(g.false_alarm_rate).toBeNull();
		expect(g.confirm_rate).toBeNull();
		expect(g.catch_rate).toBe(1);
	});
	test("never refuting → precision null (no positives predicted), miss-rate 1", () => {
		const g = grade(
			[{ file: "x.pdf", page: 1, ground_truth: "seeded_false", expected_verdict: "refuted" }],
			[{ file: "x.pdf", page: 1, verdict: "confirmed" }],
		);
		expect(g.tp + g.fp).toBe(0);
		expect(g.precision).toBeNull();
		expect(g.miss_rate).toBe(1);
	});
});

describe("aggregateMatrix", () => {
	test("pools per-case matrices and recomputes rates over the pooled totals", () => {
		const g1 = grade(
			[{ file: "a.pdf", page: 1, ground_truth: "seeded_false", expected_verdict: "refuted" }],
			[{ file: "a.pdf", page: 1, verdict: "refuted" }], // TP
		);
		const g2 = grade(
			[
				{ file: "b.pdf", page: 1, ground_truth: "seeded_false", expected_verdict: "refuted" },
				{ file: "c.pdf", page: 1, ground_truth: "true_exclusion", expected_verdict: "confirmed" },
			],
			[
				{ file: "b.pdf", page: 1, verdict: "confirmed" }, // FN
				{ file: "c.pdf", page: 1, verdict: "confirmed" }, // TN
			],
		);
		const m = aggregateMatrix([g1, g2]);
		expect(m).toMatchObject({ tp: 1, fn: 1, fp: 0, tn: 1, positives: 2, negatives: 1, total: 3 });
		expect(m.catch_rate).toBeCloseTo(1 / 2, 10);
		expect(m.miss_rate).toBeCloseTo(1 / 2, 10);
		expect(m.confirm_rate).toBe(1);
		expect(m.false_alarm_rate).toBe(0);
	});
});
