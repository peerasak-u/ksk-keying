import { describe, expect, test } from "bun:test";
import { buildHubStats, type HubStatsInput } from "./review-hub-stats";
import type { Claim } from "./review-claims";
import type { DocumentBucket, ReviewPage, StatementGroupData } from "./review-data";

function page(over: Partial<ReviewPage> = {}): ReviewPage {
	return {
		ref: "r",
		short_ref: "r",
		source_src: "a.pdf",
		source_page: 1,
		source_sheet: null,
		image_src: null,
		extract_path: "",
		categorize_path: "",
		facts: { total: 100 },
		lines: [{ line_index: 0 } as never],
		initial_status: "needs_attention",
		skipped: false,
		group_id: "g1",
		...over,
	} as ReviewPage;
}

function claim(over: Partial<Claim> = {}): Claim {
	return {
		unitKey: "a.pdf#1",
		file: "a.pdf",
		page: 1,
		sheet: null,
		reasonLabel: "ซ้ำกับเอกสารอื่น",
		conflictGroup: null,
		referenceReportCheckMissing: false,
		...over,
	} as Claim;
}

function input(over: Partial<HubStatsInput> = {}): HubStatsInput {
	return {
		clientId: "216",
		monthId: "เดือนเมษายน",
		claims: [],
		hadAnyExcluded: false,
		bucketPages: new Map<DocumentBucket, ReviewPage[]>(),
		statements: [],
		...over,
	};
}

describe("buildHubStats — the excluded gate", () => {
	test("pending claims lock every other surface", () => {
		const st = buildHubStats(input({ claims: [claim()], hadAnyExcluded: true }));
		expect(st.locked).toBe(true);
		expect(st.excluded.clear).toBe(false);
		expect(st.excluded.pending).toBe(1);
	});

	test("no pending claims unlocks, whether or not the month ever had exclusions", () => {
		expect(buildHubStats(input({ hadAnyExcluded: true })).locked).toBe(false);
		expect(buildHubStats(input({ hadAnyExcluded: false })).locked).toBe(false);
	});

	test("counts distinct files, groups reasons by frequency, and surfaces risk flags", () => {
		const st = buildHubStats(
			input({
				hadAnyExcluded: true,
				claims: [
					claim({ file: "a.pdf" }),
					claim({ file: "a.pdf", page: 2 }),
					claim({ file: "b.pdf", reasonLabel: "ไฟล์อ้างอิง (ผังบัญชี)", referenceReportCheckMissing: true }),
					claim({ file: "b.pdf", page: 9, conflictGroup: "grp-1" }),
				],
			}),
		);
		expect(st.excluded.files).toBe(2);
		expect(st.excluded.byReason).toEqual([
			{ label: "ซ้ำกับเอกสารอื่น", count: 3 },
			{ label: "ไฟล์อ้างอิง (ผังบัญชี)", count: 1 },
		]);
		expect(st.excluded.conflicts).toBe(1);
		expect(st.excluded.missingChecks).toBe(1);
	});

	test("hrefs are percent-encoded so a Thai month folder stays one path segment", () => {
		const st = buildHubStats(input());
		expect(st.excluded.href).toBe("/clients/216/%E0%B9%80%E0%B8%94%E0%B8%B7%E0%B8%AD%E0%B8%99%E0%B9%80%E0%B8%A1%E0%B8%A9%E0%B8%B2%E0%B8%A2%E0%B8%99/excluded-review");
		expect(st.buckets[0].href).toContain("/review/expense/vat");
	});
});

describe("buildHubStats — bucket numbers", () => {
	test("every bucket is present even when empty, so 'nothing here' is a stated fact", () => {
		const st = buildHubStats(input());
		expect(st.buckets.map((b) => b.key)).toEqual(["expense/vat", "expense/non_vat", "expense/mixed", "income/vat", "income/non_vat"]);
		expect(st.buckets.every((b) => b.pages === 0 && b.total === 0)).toBe(true);
	});

	test("documents are counted by group, pages by page, files by distinct source", () => {
		const st = buildHubStats(
			input({
				bucketPages: new Map([
					[
						"expense/vat" as DocumentBucket,
						[
							page({ group_id: "g1", source_src: "a.pdf" }),
							page({ group_id: "g1", source_src: "a.pdf" }),
							page({ group_id: "g2", source_src: "b.pdf" }),
						],
					],
				]),
			}),
		);
		const b = st.buckets[0];
		expect({ groups: b.groups, pages: b.pages, files: b.files, lines: b.lines }).toEqual({ groups: 2, pages: 3, files: 2, lines: 3 });
	});

	test("skipped pages are excluded from the total and the progress denominator", () => {
		const st = buildHubStats(
			input({
				bucketPages: new Map([
					[
						"expense/vat" as DocumentBucket,
						[
							page({ facts: { total: 100 }, initial_status: "reviewed" }),
							page({ facts: { total: 50 }, skipped: true }),
							page({ facts: { total: 25 } }),
						],
					],
				]),
			}),
		);
		const b = st.buckets[0];
		expect(b.total).toBe(125);
		expect(b.skipped).toBe(1);
		expect(b.reviewed).toBe(1);
		expect(b.needsAttention).toBe(1);
	});

	test("a non-numeric or missing total contributes zero rather than NaN", () => {
		const st = buildHubStats(
			input({
				bucketPages: new Map([["income/vat" as DocumentBucket, [page({ facts: {} }), page({ facts: { total: "800" as never } }), page({ facts: { total: 200 } })]]]),
			}),
		);
		expect(st.buckets.find((b) => b.key === "income/vat")!.total).toBe(200);
	});
});

describe("buildHubStats — statement and month totals", () => {
	const stmt = (rows: object[]): StatementGroupData =>
		({ schema: "ksk_review_statement_data.v1", group_id: "s", statement: {}, source: {}, rows }) as StatementGroupData;

	test("inflow/outflow split by direction, skipped rows left out of both", () => {
		const st = buildHubStats(
			input({
				statements: [
					stmt([
						{ direction: "in", amount: 300, skipped: false, needs_review: false },
						{ direction: "out", amount: 120, skipped: false, needs_review: true },
						{ direction: "in", amount: 999, skipped: true, needs_review: false },
					]),
				],
			}),
		);
		expect(st.statement).toMatchObject({ accounts: 1, rows: 3, inflow: 300, outflow: 120, needsAttention: 1, skipped: 1 });
	});

	test("month totals separate expense from income and count files across buckets once", () => {
		const st = buildHubStats(
			input({
				bucketPages: new Map([
					["expense/vat" as DocumentBucket, [page({ facts: { total: 10 }, source_src: "shared.pdf" })]],
					["expense/non_vat" as DocumentBucket, [page({ facts: { total: 5 }, source_src: "shared.pdf" })]],
					["income/vat" as DocumentBucket, [page({ facts: { total: 70 }, source_src: "other.pdf", initial_status: "reviewed" })]],
				]),
				statements: [stmt([{ direction: "in", amount: 1, skipped: false, needs_review: true }])],
			}),
		);
		expect(st.totals).toMatchObject({ documents: 3, pages: 3, files: 2, expense: 15, income: 70, reviewed: 1, reviewable: 3 });
		// bucket warnings + statement warnings, one number for the header line
		expect(st.totals.needsAttention).toBe(3);
	});
});
