import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareReviewPagesBySource,
	groupDir,
	isDocumentBucket,
	loadBucketPages,
	loadBucketStatements,
	parseDocumentGroupData,
	parseStatementGroupData,
	ReviewDataError,
	type DocumentGroupData,
	type ReviewPage,
	type StatementGroupData,
} from "./review-data";

// --- fixture builders --------------------------------------------------

function page(overrides: Partial<ReviewPage> = {}): ReviewPage {
	return {
		ref: "a.pdf p.1",
		short_ref: "p.1",
		source_src: "a.pdf",
		source_page: 1,
		source_sheet: null,
		image_src: null,
		extract_path: "x",
		categorize_path: "y",
		facts: {},
		lines: [],
		initial_status: "reviewed",
		skipped: false,
		...overrides,
	};
}

function docGroupData(overrides: Partial<DocumentGroupData> = {}): DocumentGroupData {
	return { schema: "ksk_review_group_data.v1", group_id: "seg-001", pages: [page()], ...overrides };
}

function statementGroupData(overrides: Partial<StatementGroupData> = {}): StatementGroupData {
	return {
		schema: "ksk_review_statement_data.v1",
		group_id: "seg-001",
		statement: {
			bank: "Kbank",
			account_no: "123",
			account_holder: null,
			period: null,
			opening_balance: 100,
			closing_balance: 100,
			bank_account_code: null,
			bank_sub_code: null,
		},
		source: { source_src: "stm.pdf", source_page: 1, source_sheet: null, image_src: null },
		rows: [],
		...overrides,
	};
}

// --- parseDocumentGroupData ------------------------------------------------

describe("isDocumentBucket", () => {
	test("accepts every one of the 5 real document buckets", () => {
		for (const key of ["expense/vat", "expense/non_vat", "expense/mixed", "income/vat", "income/non_vat"]) {
			expect(isDocumentBucket(key)).toBe(true);
		}
	});

	test("rejects bank_statement and any combination that isn't a real bucket", () => {
		expect(isDocumentBucket("bank_statement")).toBe(false);
		expect(isDocumentBucket("income/mixed")).toBe(false); // valid-looking, but mixed only exists under expense
		expect(isDocumentBucket("expense/bogus")).toBe(false);
		expect(isDocumentBucket("")).toBe(false);
	});
});

describe("parseDocumentGroupData", () => {
	test("parses a well-formed document group file", () => {
		const data = docGroupData();
		expect(parseDocumentGroupData(JSON.stringify(data), "x.json")).toEqual(data);
	});

	test("throws ReviewDataError on invalid JSON", () => {
		expect(() => parseDocumentGroupData("{not json", "x.json")).toThrow(ReviewDataError);
	});

	test("throws ReviewDataError on the wrong schema (e.g. a statement file in a document bucket)", () => {
		expect(() => parseDocumentGroupData(JSON.stringify(statementGroupData()), "x.json")).toThrow(/expected schema "ksk_review_group_data.v1"/);
	});

	test("throws ReviewDataError when pages[] is missing", () => {
		expect(() => parseDocumentGroupData(JSON.stringify({ schema: "ksk_review_group_data.v1", group_id: "x" }), "x.json")).toThrow(/missing pages/);
	});

	test("defaults a pre-#42 page missing `skipped` on disk to false", () => {
		const { skipped, ...pageWithoutSkipped } = page();
		const data = docGroupData({ pages: [pageWithoutSkipped as ReviewPage] });
		const parsed = parseDocumentGroupData(JSON.stringify(data), "x.json");
		expect(parsed.pages[0].skipped).toBe(false);
	});
});

// --- parseStatementGroupData -----------------------------------------------

describe("parseStatementGroupData", () => {
	test("parses a well-formed statement group file", () => {
		const data = statementGroupData();
		expect(parseStatementGroupData(JSON.stringify(data), "x.json")).toEqual(data);
	});

	test("throws ReviewDataError on the wrong schema (e.g. a document file in bank_statement)", () => {
		expect(() => parseStatementGroupData(JSON.stringify(docGroupData()), "x.json")).toThrow(/expected schema "ksk_review_statement_data.v1"/);
	});

	test("throws ReviewDataError when statement{} is missing", () => {
		const bad = { schema: "ksk_review_statement_data.v1", group_id: "x", source: {}, rows: [] };
		expect(() => parseStatementGroupData(JSON.stringify(bad), "x.json")).toThrow(/missing statement/);
	});

	test("throws ReviewDataError when rows[] is missing", () => {
		const { rows, ...rest } = statementGroupData();
		expect(() => parseStatementGroupData(JSON.stringify(rest), "x.json")).toThrow(/missing rows/);
	});

	test("defaults a pre-#42 row missing `skipped` on disk to false", () => {
		const rowWithoutSkipped = {
			row_index: 0,
			date_iso: "2026-05-01",
			time: null,
			description: null,
			counterparty: null,
			direction: "out",
			amount: 100,
			balance: null,
			account_code: "",
			sub_code: "",
			account_name_th: "",
			confidence: "low",
			reason: "",
			needs_review: true,
		};
		const data = statementGroupData({ rows: [rowWithoutSkipped as unknown as StatementGroupData["rows"][number]] });
		const parsed = parseStatementGroupData(JSON.stringify(data), "x.json");
		expect(parsed.rows[0].skipped).toBe(false);
	});
});

// --- compareReviewPagesBySource ---------------------------------------------

describe("compareReviewPagesBySource", () => {
	test("orders by source_src first", () => {
		const a = page({ ref: "a", source_src: "b.pdf" });
		const b = page({ ref: "b", source_src: "a.pdf" });
		expect(compareReviewPagesBySource(a, b)).toBeGreaterThan(0);
	});

	test("same source_src orders by source_page", () => {
		const a = page({ ref: "a", source_src: "x.pdf", source_page: 3 });
		const b = page({ ref: "b", source_src: "x.pdf", source_page: 1 });
		expect(compareReviewPagesBySource(a, b)).toBeGreaterThan(0);
	});

	test("same source_src and source_page falls back to ref", () => {
		const a = page({ ref: "b", source_src: "x.pdf", source_page: 1 });
		const b = page({ ref: "a", source_src: "x.pdf", source_page: 1 });
		expect(compareReviewPagesBySource(a, b)).toBeGreaterThan(0);
	});

	test("a page with no source (image_src fallback) sorts after any page with a source", () => {
		const a = page({ ref: "a", source_src: null, image_src: null });
		const b = page({ ref: "b", source_src: "x.pdf" });
		expect(compareReviewPagesBySource(a, b)).toBeGreaterThan(0);
		expect(compareReviewPagesBySource(b, a)).toBeLessThan(0);
	});

	test("falls back to image_src when source_src is absent", () => {
		const a = page({ ref: "a", source_src: null, image_src: "b.png" });
		const b = page({ ref: "b", source_src: null, image_src: "a.png" });
		expect(compareReviewPagesBySource(a, b)).toBeGreaterThan(0);
	});
});

// --- groupDir ----------------------------------------------------------

describe("groupDir", () => {
	test("joins bucket segments and groupId under _doc_groups", () => {
		expect(groupDir("/client/month", "expense/vat", "seg-001")).toBe(join("/client/month", "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "seg-001"));
	});

	test("bank_statement has no vat segment", () => {
		expect(groupDir("/client/month", "bank_statement", "seg-001")).toBe(join("/client/month", "ข้อมูลระบบ", "_doc_groups", "bank_statement", "seg-001"));
	});
});

// --- loadBucketPages / loadBucketStatements (thin I/O) ---------------------

describe("loadBucketPages", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ksk-review-data-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeGroup(bucket: string, groupId: string, data: DocumentGroupData) {
		const gd = join(dir, "ข้อมูลระบบ", "_doc_groups", ...bucket.split("/"), groupId);
		mkdirSync(gd, { recursive: true });
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(data));
	}

	test("merges multiple groups' pages into one reading-order list, stamping group_id/group_label/page_index_in_group", async () => {
		writeGroup(
			"expense/vat",
			"seg-002",
			docGroupData({ group_id: "seg-002", label: "Seg 2", pages: [page({ ref: "r1", source_src: "z.pdf" })] }),
		);
		writeGroup(
			"expense/vat",
			"seg-001",
			docGroupData({
				group_id: "seg-001",
				label: "Seg 1",
				review_flags: ["flag-a"],
				pages: [page({ ref: "r2", source_src: "a.pdf" }), page({ ref: "r3", source_src: "a.pdf", source_page: 2 })],
			}),
		);
		const result = await loadBucketPages(dir, "expense/vat");
		expect(result.errors).toEqual([]);
		// sorted by source_src ("a.pdf" before "z.pdf") regardless of group folder order
		expect(result.pages.map((p) => p.ref)).toEqual(["r2", "r3", "r1"]);
		expect(result.pages[0].group_id).toBe("seg-001");
		expect(result.pages[0].group_label).toBe("Seg 1");
		expect(result.pages[0].group_review_flags).toEqual(["flag-a"]);
		expect(result.pages[0].page_index_in_group).toBe(0);
		expect(result.pages[1].page_index_in_group).toBe(1);
	});

	test("a group folder with no review-data.json yet is silently skipped, not an error", async () => {
		mkdirSync(join(dir, "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "seg-not-ready"), { recursive: true });
		const result = await loadBucketPages(dir, "expense/vat");
		expect(result.pages).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("a malformed review-data.json is reported per-group, not thrown", async () => {
		const gd = join(dir, "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "seg-bad");
		mkdirSync(gd, { recursive: true });
		writeFileSync(join(gd, "review-data.json"), "{not json");
		const result = await loadBucketPages(dir, "expense/vat");
		expect(result.pages).toEqual([]);
		expect(result.errors.length).toBe(1);
	});

	test("the bucket dir not existing at all returns an empty, error-free result", async () => {
		const result = await loadBucketPages(dir, "income/non_vat");
		expect(result).toEqual({ pages: [], errors: [] });
	});

	test("excludes an 'assets' sibling folder from group enumeration", async () => {
		mkdirSync(join(dir, "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "assets"), { recursive: true });
		writeGroup("expense/vat", "seg-001", docGroupData());
		const result = await loadBucketPages(dir, "expense/vat");
		expect(result.pages.length).toBe(1);
	});
});

describe("loadBucketStatements", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ksk-review-data-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("one entry per group folder, folder-name order, no row flattening", async () => {
		for (const groupId of ["seg-002", "seg-001"]) {
			const gd = join(dir, "ข้อมูลระบบ", "_doc_groups", "bank_statement", groupId);
			mkdirSync(gd, { recursive: true });
			writeFileSync(join(gd, "review-data.json"), JSON.stringify(statementGroupData({ group_id: groupId })));
		}
		const result = await loadBucketStatements(dir);
		expect(result.errors).toEqual([]);
		expect(result.statements.map((s) => s.group_id)).toEqual(["seg-001", "seg-002"]);
		expect(result.statements[0].group_dir).toBe("seg-001");
	});
});
