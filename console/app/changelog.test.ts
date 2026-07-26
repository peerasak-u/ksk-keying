import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChangesFile, computeAndWriteChangesForGroup, diffDocumentGroup, diffStatementGroup } from "./changelog";
import type { DocumentGroupData, ReviewLine, ReviewPage, ReviewPageFacts, StatementGroupData, StatementRow } from "./review-data";

// --- fixture builders --------------------------------------------------

function facts(overrides: Partial<ReviewPageFacts> = {}): ReviewPageFacts {
	return { date: "2026-05-05", document_no: "RT-001", total: 380.92, vat: 24.92, subtotal: 356, vat_treatment: "vat_7", ...overrides };
}

function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
	return {
		line_index: 0,
		description: "อาหารและเครื่องดื่ม",
		qty: 1,
		unit: null,
		unit_price: null,
		amount: 356,
		amount_includes_vat: false,
		vat_treatment: null,
		account_code: "410101",
		sub_code: "",
		account_name_th: "รายได้จากการขายสินค้า",
		confidence: "high",
		reason: "matched",
		needs_review: false,
		...overrides,
	};
}

function page(overrides: Partial<ReviewPage> = {}): ReviewPage {
	return {
		ref: "seg-001/RT-001.pdf p.1",
		short_ref: "RT-001.pdf p.1",
		source_src: "RT-001.pdf",
		source_page: 1,
		source_sheet: null,
		image_src: null,
		extract_path: "x",
		categorize_path: "y",
		facts: facts(),
		lines: [line()],
		initial_status: "reviewed",
		skipped: false,
		...overrides,
	};
}

function docGroupData(overrides: Partial<DocumentGroupData> = {}): DocumentGroupData {
	return { schema: "ksk_review_group_data.v1", group_id: "seg-001", pages: [page()], ...overrides };
}

function statementRow(overrides: Partial<StatementRow> = {}): StatementRow {
	return {
		row_index: 0,
		date_iso: "2026-05-01",
		time: null,
		description: "โอนเงิน",
		counterparty: "X",
		direction: "out",
		amount: 500,
		balance: 1000,
		account_code: "530301",
		sub_code: "",
		account_name_th: "ค่าไฟฟ้า",
		confidence: "high",
		reason: "matched",
		needs_review: false,
		skipped: false,
		...overrides,
	};
}

function statementGroupData(overrides: Partial<StatementGroupData> = {}): StatementGroupData {
	return {
		schema: "ksk_review_statement_data.v1",
		group_id: "seg-001",
		statement: { bank: "Kbank", account_no: "123", account_holder: null, period: null, opening_balance: 100, closing_balance: 100, bank_account_code: null, bank_sub_code: null },
		source: { source_src: "stm.pdf", source_page: 1, source_sheet: null, image_src: null },
		rows: [statementRow()],
		...overrides,
	};
}

// --- diffDocumentGroup -------------------------------------------------

describe("diffDocumentGroup", () => {
	test("no entries when current matches the original exactly", () => {
		const doc = docGroupData();
		const entries = diffDocumentGroup(doc, { facts: facts(), lines: [line()] });
		expect(entries).toEqual([]);
	});

	test("emits one entry per changed fact field", () => {
		const doc = docGroupData({ pages: [page({ facts: facts({ total: 500 }) })] });
		const entries = diffDocumentGroup(doc, { facts: facts(), lines: [line()] });
		expect(entries).toEqual([{ line_id: doc.pages[0].ref, field: "facts.total", before: 380.92, after: 500 }]);
	});

	test("emits a line-level entry keyed by page.ref#L<line_index>", () => {
		const doc = docGroupData({ pages: [page({ lines: [line({ amount: 999 })] })] });
		const entries = diffDocumentGroup(doc, { facts: facts(), lines: [line()] });
		expect(entries).toContainEqual({ line_id: `${doc.pages[0].ref}#L0`, field: "amount", before: 356, after: 999 });
	});

	test("account reassignment emits an account_code entry as a coaKey composite (ticket #37 filters changelog entries on this exact field name)", () => {
		const doc = docGroupData({ pages: [page({ lines: [line({ account_code: "410102", sub_code: "01" })] })] });
		const entries = diffDocumentGroup(doc, { facts: facts(), lines: [line()] });
		expect(entries).toContainEqual({ line_id: `${doc.pages[0].ref}#L0`, field: "account_code", before: "410101||", after: "410102||01" });
	});

	test("skipped=true emits a skipped entry with before:false", () => {
		const doc = docGroupData({ pages: [page({ skipped: true })] });
		const entries = diffDocumentGroup(doc, { facts: facts(), lines: [line()] });
		expect(entries).toContainEqual({ line_id: doc.pages[0].ref, field: "skipped", before: false, after: true });
	});

	test("a line missing from the original (no categorize entry at build time) diffs against nulls, not a crash", () => {
		const doc = docGroupData({ pages: [page({ lines: [line({ line_index: 5, amount: 10 })] })] });
		const entries = diffDocumentGroup(doc, { facts: facts(), lines: [] });
		expect(entries).toContainEqual({ line_id: `${doc.pages[0].ref}#L5`, field: "amount", before: null, after: 10 });
		expect(entries).toContainEqual({ line_id: `${doc.pages[0].ref}#L5`, field: "account_code", before: "", after: "410101||" });
	});

	test("multiple pages in the same group each diff independently against the SAME shared original facts", () => {
		const doc = docGroupData({
			pages: [page({ ref: "p1", facts: facts({ total: 1 }) }), page({ ref: "p2", facts: facts() })],
		});
		const entries = diffDocumentGroup(doc, { facts: facts(), lines: [line()] });
		const p1Entries = entries.filter((e) => e.line_id === "p1");
		const p2Entries = entries.filter((e) => e.line_id === "p2" || e.line_id.startsWith("p2#"));
		expect(p1Entries).toContainEqual({ line_id: "p1", field: "facts.total", before: 380.92, after: 1 });
		// p2 unchanged from original facts -> only its (identical) line contributes no entries either
		expect(p2Entries.filter((e) => e.field.startsWith("facts."))).toEqual([]);
	});
});

// --- diffStatementGroup ------------------------------------------------

function originalRow(overrides: Partial<Omit<StatementRow, "skipped">> = {}): Omit<StatementRow, "skipped"> {
	const { skipped, ...rest } = statementRow(overrides);
	return rest;
}

describe("diffStatementGroup", () => {
	test("no entries when current matches the original exactly", () => {
		const doc = statementGroupData();
		const entries = diffStatementGroup(doc, { bankAccountKey: null, rows: [originalRow()] });
		expect(entries).toEqual([]);
	});

	test("bank_account_key reassignment emits a statement.bank_account_key entry keyed by group_id", () => {
		const doc = statementGroupData({ statement: { ...statementGroupData().statement, bank_account_code: "111301", bank_sub_code: "" } });
		const entries = diffStatementGroup(doc, { bankAccountKey: null, rows: [originalRow()] });
		expect(entries).toContainEqual({ line_id: "seg-001", field: "statement.bank_account_key", before: null, after: "111301||" });
	});

	test("row edits emit description/amount/account_key/skipped entries keyed by group_id#R<row_index>", () => {
		const doc = statementGroupData({ rows: [statementRow({ description: "corrected", amount: 700, account_code: "111301", skipped: true })] });
		const entries = diffStatementGroup(doc, { bankAccountKey: null, rows: [originalRow()] });
		expect(entries).toContainEqual({ line_id: "seg-001#R0", field: "description", before: "โอนเงิน", after: "corrected" });
		expect(entries).toContainEqual({ line_id: "seg-001#R0", field: "amount", before: 500, after: 700 });
		expect(entries).toContainEqual({ line_id: "seg-001#R0", field: "account_code", before: "530301||", after: "111301||" });
		expect(entries).toContainEqual({ line_id: "seg-001#R0", field: "skipped", before: false, after: true });
	});
});

// --- buildChangesFile ----------------------------------------------------

describe("buildChangesFile", () => {
	test("stamps schema/group_id/computed_at/entries", () => {
		const result = buildChangesFile("seg-001", [{ line_id: "x", field: "amount", before: 1, after: 2 }], "2026-07-25T00:00:00.000Z");
		expect(result).toEqual({
			schema: "ksk_review_changes.v1",
			group_id: "seg-001",
			computed_at: "2026-07-25T00:00:00.000Z",
			entries: [{ line_id: "x", field: "amount", before: 1, after: 2 }],
		});
	});
});

// --- computeAndWriteChangesForGroup (thin I/O) ------------------------------

describe("computeAndWriteChangesForGroup", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ksk-changelog-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function groupPath(...segments: string[]) {
		return join(dir, "ข้อมูลระบบ", "_doc_groups", ...segments);
	}

	test("writes changes.json for a document group with a real human edit", async () => {
		const gd = groupPath("income", "vat", "seg-001");
		mkdirSync(gd, { recursive: true });
		writeFileSync(
			join(gd, "interpretation.json"),
			JSON.stringify({
				category: "income",
				vat_treatment: "vat",
				facts: { document_date: "2026-05-05", gross_total: 380.92, vat: 24.92, seller_name: "S", buyer_name: "B" },
				line_items: [{ description: "อาหาร", amount: 356 }],
			}),
		);
		writeFileSync(
			join(gd, "categorize.json"),
			JSON.stringify({ lines: [{ line_index: 0, account_code: "410101", sub_code: "", account_name_th: "รายได้", confidence: "high", reason: "x", needs_review: false }] }),
		);
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(docGroupData({ pages: [page({ lines: [line({ amount: 999 })] })] })));

		const result = await computeAndWriteChangesForGroup(dir, "income/vat", "seg-001", null);
		expect(result).not.toBeNull();
		expect(result?.entries).toContainEqual(expect.objectContaining({ field: "amount", after: 999 }));

		const onDisk = JSON.parse(await readFile(join(gd, "changes.json"), "utf8"));
		expect(onDisk.schema).toBe("ksk_review_changes.v1");
		expect(onDisk.group_id).toBe("seg-001");
	});

	test("writes changes.json for a bank_statement group", async () => {
		const gd = groupPath("bank_statement", "seg-001");
		mkdirSync(gd, { recursive: true });
		writeFileSync(join(gd, "interpretation.json"), JSON.stringify({ category: "bank_statement", transactions: [{ date_iso: "2026-05-01", direction: "out", amount: 500 }] }));
		writeFileSync(join(gd, "categorize.json"), JSON.stringify({ lines: [], bank_account_code: null, bank_sub_code: null }));
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(statementGroupData({ statement: { ...statementGroupData().statement, bank_account_code: "111301", bank_sub_code: "" } })));

		const result = await computeAndWriteChangesForGroup(dir, "bank_statement", "seg-001", null);
		expect(result).not.toBeNull();
		expect(result?.entries).toContainEqual(expect.objectContaining({ field: "statement.bank_account_key", after: "111301||" }));
		expect(existsSync(join(gd, "changes.json"))).toBe(true);
	});

	test("returns null without writing when review-data.json doesn't exist", async () => {
		const result = await computeAndWriteChangesForGroup(dir, "income/vat", "seg-missing", null);
		expect(result).toBeNull();
	});

	test("returns null without writing when interpretation.json/categorize.json are missing", async () => {
		const gd = groupPath("income", "vat", "seg-002");
		mkdirSync(gd, { recursive: true });
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(docGroupData({ group_id: "seg-002" })));

		const result = await computeAndWriteChangesForGroup(dir, "income/vat", "seg-002", null);
		expect(result).toBeNull();
		expect(existsSync(join(gd, "changes.json"))).toBe(false);
	});
});
