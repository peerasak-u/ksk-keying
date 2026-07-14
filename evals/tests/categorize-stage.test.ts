import { describe, expect, test } from "bun:test";
import {
	type CodedLine,
	classifyCode,
	computeAgreement,
	coverageComplete,
	gradeVsExpectedCoa,
	groupCoverage,
	isSuspense,
	lineKey,
	parseCoa,
} from "../specs/categorize-stage";

// Pure-function unit tests for the categorize (Stage 5 / poirot) grader. No live
// run, no gitignored data — every input is fabricated here. The build-review-data
// gate and the disk-walk in gradeSession are integration-tested separately.

// A tiny fabricated chart of accounts. Columns are the real coa.csv shape
// (account_code, sub_code, name_th, name_en); only the first two are load-bearing.
const COA_CSV = `account_code,sub_code,name_th,name_en
111101,,เงินสด,Cash
111101,CSH001,เงินสด - เงินสด,Cash - petty
111301,BSV002,ธนาคาร - ออมทรัพย์ กรุงไทย,Saving KTB
113101,,ลูกหนี้การค้า,Accounts receivable
510110,,ซื้อวัตถุดิบ,Raw materials
510201,,ค่าซ่อมแซม,Repairs
530501,,ค่าธรรมเนียมธนาคาร,Bank fee
999999,,บัญชีพัก,Suspense Account

`; // trailing blank + empty line — parser must skip both

// ---------------------------------------------------------------------------
// coa.csv membership — the code-validity bar.
// ---------------------------------------------------------------------------
describe("parseCoa + classifyCode", () => {
	const coa = parseCoa(COA_CSV);

	test("header row and blank lines are skipped", () => {
		expect(coa.accounts.has("account_code")).toBe(false);
		expect(coa.accounts.has("")).toBe(false);
		expect(coa.accounts.size).toBe(7); // 111101, 111301, 113101, 510110, 510201, 530501, 999999
	});

	test("a bare account_code is valid when the account exists (books to parent)", () => {
		expect(classifyCode(coa, "111101", "")).toBe("ok");
		expect(classifyCode(coa, "111301", "")).toBe("ok"); // account seen only via a sub row
		expect(classifyCode(coa, "510110", "")).toBe("ok");
	});

	test("an existing (account, sub) pair is valid", () => {
		expect(classifyCode(coa, "111101", "CSH001")).toBe("ok");
		expect(classifyCode(coa, "111301", "BSV002")).toBe("ok");
	});

	test("suspense (999999 / บัญชีพัก) is a VALID chart code", () => {
		expect(classifyCode(coa, "999999", "")).toBe("ok");
	});

	test("a code absent from the chart is the hard finding", () => {
		expect(classifyCode(coa, "777777", "")).toBe("missing_account");
		expect(classifyCode(coa, "510999", "")).toBe("missing_account");
	});

	test("a claimed sub-account that isn't in the chart also fails", () => {
		expect(classifyCode(coa, "111301", "BSV999")).toBe("missing_subcode");
		expect(classifyCode(coa, "111101", "NOPE")).toBe("missing_subcode");
	});

	test("null / whitespace codes normalize before lookup", () => {
		expect(classifyCode(coa, " 510110 ", " ")).toBe("ok");
		expect(classifyCode(coa, null, "")).toBe("missing_account");
	});
});

// ---------------------------------------------------------------------------
// Suspense detection (counted apart from confident code swings).
// ---------------------------------------------------------------------------
describe("isSuspense", () => {
	test("the 999999 suspense code", () => {
		expect(isSuspense("999999")).toBe(true);
		expect(isSuspense(" 999999 ")).toBe(true);
	});
	test("name-based fallback (in case a chart uses a different suspense code)", () => {
		expect(isSuspense("880000", "บัญชีพัก")).toBe(true);
		expect(isSuspense("123456", "Suspense Account")).toBe(true);
	});
	test("a real expense/AR code is not suspense", () => {
		expect(isSuspense("510110", "ซื้อวัตถุดิบ")).toBe(false);
		expect(isSuspense("113101")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Coverage — one categorize line per interpretation row.
// ---------------------------------------------------------------------------
describe("groupCoverage", () => {
	test("non-bank group: matches interpretation line_items", () => {
		const c = groupCoverage("004-INV", "expense", { line_items: [1, 2, 3] }, { lines: [1, 2, 3] });
		expect(c).toMatchObject({ isBank: false, expected: 3, got: 3, ok: true });
	});

	test("non-bank line-count mismatch is not covered", () => {
		const c = groupCoverage("004-INV", "expense", { line_items: [1, 2, 3] }, { lines: [1, 2] });
		expect(c).toMatchObject({ expected: 3, got: 2, ok: false });
	});

	test("missing categorize.json → got null, not covered", () => {
		const c = groupCoverage("004-INV", "income", { line_items: [1] }, null);
		expect(c).toMatchObject({ got: null, ok: false });
	});

	test("bank group counts transactions, not line_items", () => {
		const c = groupCoverage(
			"001-seg",
			"bank_statement",
			{ line_items: [], transactions: [1, 2, 3, 4, 5, 6, 7] },
			{ lines: [1, 2, 3, 4, 5, 6, 7] },
		);
		expect(c).toMatchObject({ isBank: true, expected: 7, got: 7, ok: true });
	});
});

describe("coverageComplete", () => {
	const ok = groupCoverage("g", "expense", { line_items: [1] }, { lines: [1] });
	const bad = groupCoverage("g2", "expense", { line_items: [1] }, { lines: [] });
	test("empty coverage list is not complete", () => {
		expect(coverageComplete([])).toBe(false);
	});
	test("all groups covered → complete", () => {
		expect(coverageComplete([ok, ok])).toBe(true);
	});
	test("one uncovered group → not complete", () => {
		expect(coverageComplete([ok, bad])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Cross-session per-line account-code agreement — the KEY metric.
// ---------------------------------------------------------------------------
function cl(
	label: string,
	idx: number,
	code: string,
	sub = "",
	opts: { needsReview?: boolean; suspense?: boolean } = {},
): CodedLine {
	return {
		key: lineKey(label, idx),
		label,
		lineIndex: idx,
		accountCode: code,
		subCode: sub,
		needsReview: opts.needsReview ?? false,
		suspense: opts.suspense ?? false,
	};
}

describe("computeAgreement", () => {
	// 3 sessions. DOC-A/0 agrees; DOC-A/1 is a confident near-synonym swing;
	// DOC-B/0 disagrees but is parked in suspense (soft); DOC-D/0 disagrees on a
	// sub_code with one session flagging needs_review (soft); DOC-C/0 exists in
	// only two sessions (dropped from the compared set).
	const s1 = [
		cl("DOC-A", 0, "510110"),
		cl("DOC-A", 1, "510110"),
		cl("DOC-B", 0, "999999", "", { suspense: true }),
		cl("DOC-D", 0, "113101", ""),
		cl("DOC-C", 0, "530501"),
	];
	const s2 = [
		cl("DOC-A", 0, "510110"),
		cl("DOC-A", 1, "510201"), // the swing
		cl("DOC-B", 0, "510110"),
		cl("DOC-D", 0, "113101", "SUBX", { needsReview: true }),
		cl("DOC-C", 0, "530501"),
	];
	const s3 = [
		cl("DOC-A", 0, "510110"),
		cl("DOC-A", 1, "510110"),
		cl("DOC-B", 0, "999999", "", { suspense: true }),
		cl("DOC-D", 0, "113101", ""),
		// DOC-C absent in s3
	];
	const r = computeAgreement([s1, s2, s3]);

	test("only lines present in every session are compared", () => {
		expect(r.linesCompared).toBe(4); // DOC-A/0, DOC-A/1, DOC-B/0, DOC-D/0
		expect(r.droppedKeys).toEqual(["DOC-C"]);
	});

	test("agreeing = identical account_code (+ sub_code) across all sessions", () => {
		expect(r.agreeing).toBe(1); // only DOC-A/0
		expect(r.disagreements).toHaveLength(3);
	});

	test("disagreements are sorted and carry per-session codes-seen", () => {
		expect(r.disagreements.map((d) => `${d.bookable_doc}#${d.line_index}`)).toEqual([
			"DOC-A#1",
			"DOC-B#0",
			"DOC-D#0",
		]);
		const swing = r.disagreements[0];
		expect(swing.codes).toEqual(["510110", "510201", "510110"]); // session order
		expect(swing.distinct).toEqual(["510110", "510201"]);
	});

	test("only confident disagreements (no suspense / needs_review) are swings", () => {
		expect(r.confidentSwings).toHaveLength(1);
		expect(r.confidentSwings[0]).toMatchObject({ bookable_doc: "DOC-A", line_index: 1 });
	});

	test("a suspense-parked disagreement is tracked but not a confident swing", () => {
		const docB = r.disagreements.find((d) => d.bookable_doc === "DOC-B")!;
		expect(docB.suspense).toBe(true);
		expect(r.confidentSwings).not.toContainEqual(docB);
	});

	test("a sub_code difference is a disagreement (code = account + sub)", () => {
		const docD = r.disagreements.find((d) => d.bookable_doc === "DOC-D")!;
		expect(docD.needs_review).toBe(true);
		expect(docD.distinct).toEqual(["113101", "113101/SUBX"]);
	});

	test("full agreement → zero disagreements", () => {
		const a = [cl("X", 0, "510110"), cl("X", 1, "530501")];
		const b = [cl("X", 0, "510110"), cl("X", 1, "530501")];
		const res = computeAgreement([a, b]);
		expect(res.agreeing).toBe(2);
		expect(res.linesCompared).toBe(2);
		expect(res.disagreements).toHaveLength(0);
		expect(res.confidentSwings).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// tier-B seam — grade coded lines against an expected per-line COA map.
// ---------------------------------------------------------------------------
describe("gradeVsExpectedCoa", () => {
	const expected = [
		{ bookable_doc: "DOC-A", line_index: 0, account_code: "510110" },
		{ bookable_doc: "DOC-A", line_index: 1, account_code: "510201" },
	];

	test("exact-code rate and account-code recall, per session + worst-case min-exact", () => {
		const s1 = [cl("DOC-A", 0, "510110"), cl("DOC-A", 1, "510110")]; // 1 wrong
		const s2 = [cl("DOC-A", 0, "510110"), cl("DOC-A", 1, "510201")]; // both right
		const s3 = [cl("DOC-A", 0, "510110")]; // one line missing
		const gt = gradeVsExpectedCoa([s1, s2, s3], expected);

		expect(gt.expected_lines).toBe(2);
		expect(gt.per_session[0]).toMatchObject({ matched: 2, exact: 1, exact_code: "1/2", account_code_recall: "2/2" });
		expect(gt.per_session[1]).toMatchObject({ matched: 2, exact: 2, exact_code: "2/2" });
		expect(gt.per_session[2]).toMatchObject({ matched: 1, exact: 1, account_code_recall: "1/2" });
		expect(gt.min_exact).toBe(1); // min(1, 2, 1)
	});

	test("an expected sub_code is graded too", () => {
		const exp = [{ bookable_doc: "DOC-B", line_index: 0, account_code: "111301", sub_code: "BSV002" }];
		const right = [cl("DOC-B", 0, "111301", "BSV002")];
		const wrongSub = [cl("DOC-B", 0, "111301", "")];
		expect(gradeVsExpectedCoa([right], exp).per_session[0].exact).toBe(1);
		expect(gradeVsExpectedCoa([wrongSub], exp).per_session[0].exact).toBe(0);
	});
});
