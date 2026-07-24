import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoaRow } from "./coa";
import type { DocumentGroupData, ReviewLine, ReviewPage, StatementGroupData, StatementRow } from "./review-data";
import { applyPageEdit, applyRowEdit, applyStatementMetaEdit, saveRowEdit, savePageEdit, saveStatementMetaEdit } from "./review-edit";

// --- fixture builders --------------------------------------------------

function coaRows(): CoaRow[] {
	return [
		{ account_code: "530301", sub_code: "", name_th: "ค่าไฟฟ้า", name_en: "Electricity" },
		{ account_code: "530302", sub_code: "", name_th: "ค่าประปา", name_en: "Water" },
		{ account_code: "111301", sub_code: "", name_th: "เงินฝากออมทรัพย์", name_en: "Savings" },
	];
}

function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
	return {
		line_index: 0,
		description: "Electricity",
		qty: null,
		unit: null,
		unit_price: null,
		amount: 100,
		amount_includes_vat: false,
		vat_treatment: "vat_7",
		account_code: "530301",
		sub_code: "",
		account_name_th: "ค่าไฟฟ้า",
		confidence: "high",
		reason: "matched",
		needs_review: false,
		...overrides,
	};
}

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
		facts: { date: "2026-05-05", total: 100 },
		lines: [line()],
		initial_status: "reviewed",
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
		confidence: "medium",
		reason: "x",
		needs_review: true,
		...overrides,
	};
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
		rows: [statementRow()],
		...overrides,
	};
}

// --- applyPageEdit -----------------------------------------------------

describe("applyPageEdit", () => {
	test("merges facts edits, leaving unlisted keys untouched", () => {
		const doc = docGroupData();
		const result = applyPageEdit(doc, 0, { facts: { total: 200 } }, coaRows(), false);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages[0].facts).toEqual({ date: "2026-05-05", total: 200 });
	});

	test("patches a line's editable fields by line_index, preserving confidence/reason/needs_review", () => {
		const doc = docGroupData();
		const result = applyPageEdit(doc, 0, { lines: [{ line_index: 0, description: "Electricity (corrected)", amount: 150 }] }, coaRows(), false);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages[0].lines[0]).toEqual({
			...line(),
			description: "Electricity (corrected)",
			amount: 150,
		});
	});

	test("account_key reassignment resolves account_code/sub_code/account_name_th from coaRows", () => {
		const doc = docGroupData();
		const result = applyPageEdit(doc, 0, { lines: [{ line_index: 0, account_key: "530302||" }] }, coaRows(), false);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages[0].lines[0]).toMatchObject({ account_code: "530302", sub_code: "", account_name_th: "ค่าประปา" });
	});

	test("rejects an account_key not present in coaRows", () => {
		const doc = docGroupData();
		const result = applyPageEdit(doc, 0, { lines: [{ line_index: 0, account_key: "999999||" }] }, coaRows(), false);
		expect(result).toEqual({ ok: false, error: 'ไม่พบรหัสบัญชี "999999||" ในผังบัญชี' });
	});

	test("rejects an out-of-range pageIndex", () => {
		const doc = docGroupData();
		const result = applyPageEdit(doc, 5, {}, coaRows(), false);
		expect(result.ok).toBe(false);
	});

	test("rejects a line patch whose line_index doesn't exist on the page", () => {
		const doc = docGroupData();
		const result = applyPageEdit(doc, 0, { lines: [{ line_index: 9 }] }, coaRows(), false);
		expect(result.ok).toBe(false);
	});

	test("leaves other pages in the group untouched", () => {
		const doc = docGroupData({ pages: [page({ ref: "p1" }), page({ ref: "p2", facts: { total: 999 } })] });
		const result = applyPageEdit(doc, 0, { facts: { total: 1 } }, coaRows(), false);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages[1].facts).toEqual({ total: 999 });
	});

	test("allowVatTreatment=true applies a per-line vat_treatment patch (expense/mixed only)", () => {
		const doc = docGroupData({ pages: [page({ lines: [line({ vat_treatment: "vat_7" })] })] });
		const result = applyPageEdit(doc, 0, { lines: [{ line_index: 0, vat_treatment: "non_vat" }] }, coaRows(), true);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages[0].lines[0].vat_treatment).toBe("non_vat");
	});

	test("allowVatTreatment=false silently ignores a vat_treatment patch, keeping the line's existing value (every bucket except expense/mixed)", () => {
		const doc = docGroupData({ pages: [page({ lines: [line({ vat_treatment: "vat_7" })] })] });
		const result = applyPageEdit(doc, 0, { lines: [{ line_index: 0, vat_treatment: "non_vat" }] }, coaRows(), false);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.pages[0].lines[0].vat_treatment).toBe("vat_7");
	});
});

// --- applyRowEdit --------------------------------------------------------

describe("applyRowEdit", () => {
	test("edits description/amount by row_index", () => {
		const doc = statementGroupData();
		const result = applyRowEdit(doc, 0, { description: "โอนเงินแก้ไข", amount: 600 }, coaRows());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.rows[0]).toMatchObject({ description: "โอนเงินแก้ไข", amount: 600 });
	});

	test("account_key reassignment resolves via coaRows", () => {
		const doc = statementGroupData();
		const result = applyRowEdit(doc, 0, { account_key: "111301||" }, coaRows());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.rows[0]).toMatchObject({ account_code: "111301", sub_code: "", account_name_th: "เงินฝากออมทรัพย์" });
	});

	test("direction is never part of the edit surface (not accepted, stays as-is)", () => {
		const doc = statementGroupData({ rows: [statementRow({ direction: "in" })] });
		const result = applyRowEdit(doc, 0, { amount: 10 }, coaRows());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.rows[0].direction).toBe("in");
	});

	test("rejects an unknown row_index", () => {
		const doc = statementGroupData();
		const result = applyRowEdit(doc, 99, { amount: 1 }, coaRows());
		expect(result.ok).toBe(false);
	});

	test("rejects an unknown account_key", () => {
		const doc = statementGroupData();
		const result = applyRowEdit(doc, 0, { account_key: "000000||" }, coaRows());
		expect(result.ok).toBe(false);
	});
});

// --- applyStatementMetaEdit -----------------------------------------------

describe("applyStatementMetaEdit", () => {
	test("sets statement.bank_account_code/bank_sub_code from coaRows", () => {
		const doc = statementGroupData();
		const result = applyStatementMetaEdit(doc, { account_key: "111301||" }, coaRows());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.statement.bank_account_code).toBe("111301");
		expect(result.data.statement.bank_sub_code).toBe("");
	});

	test("rejects an unknown account_key", () => {
		const doc = statementGroupData();
		const result = applyStatementMetaEdit(doc, { account_key: "nope||" }, coaRows());
		expect(result.ok).toBe(false);
	});
});

// --- thin I/O wrappers ---------------------------------------------------

describe("savePageEdit / saveRowEdit / saveStatementMetaEdit", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ksk-review-edit-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("savePageEdit writes the edited doc back to the specific group's review-data.json", async () => {
		const gd = join(dir, "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "seg-001");
		mkdirSync(gd, { recursive: true });
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(docGroupData()));

		const result = await savePageEdit(dir, "expense/vat", "seg-001", 0, { facts: { total: 250 } }, coaRows());
		expect(result.ok).toBe(true);

		const onDisk = JSON.parse(readFileSync(join(gd, "review-data.json"), "utf8"));
		expect(onDisk.pages[0].facts.total).toBe(250);
	});

	test("savePageEdit derives allowVatTreatment from bucket: expense/vat ignores a vat_treatment patch", async () => {
		const gd = join(dir, "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "seg-001");
		mkdirSync(gd, { recursive: true });
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(docGroupData({ pages: [page({ lines: [line({ vat_treatment: "vat_7" })] })] })));

		const result = await savePageEdit(dir, "expense/vat", "seg-001", 0, { lines: [{ line_index: 0, vat_treatment: "non_vat" }] }, coaRows());
		expect(result.ok).toBe(true);

		const onDisk = JSON.parse(readFileSync(join(gd, "review-data.json"), "utf8"));
		expect(onDisk.pages[0].lines[0].vat_treatment).toBe("vat_7");
	});

	test("savePageEdit derives allowVatTreatment from bucket: expense/mixed applies a vat_treatment patch", async () => {
		const gd = join(dir, "ข้อมูลระบบ", "_doc_groups", "expense", "mixed", "seg-001");
		mkdirSync(gd, { recursive: true });
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(docGroupData({ pages: [page({ lines: [line({ vat_treatment: "vat_7" })] })] })));

		const result = await savePageEdit(dir, "expense/mixed", "seg-001", 0, { lines: [{ line_index: 0, vat_treatment: "non_vat" }] }, coaRows());
		expect(result.ok).toBe(true);

		const onDisk = JSON.parse(readFileSync(join(gd, "review-data.json"), "utf8"));
		expect(onDisk.pages[0].lines[0].vat_treatment).toBe("non_vat");
	});

	test("savePageEdit returns an error, and writes nothing, when review-data.json doesn't exist", async () => {
		const result = await savePageEdit(dir, "expense/vat", "seg-missing", 0, {}, coaRows());
		expect(result.ok).toBe(false);
	});

	test("savePageEdit propagates a validation error without writing (bad account_key)", async () => {
		const gd = join(dir, "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "seg-001");
		mkdirSync(gd, { recursive: true });
		const original = docGroupData();
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(original));

		const result = await savePageEdit(dir, "expense/vat", "seg-001", 0, { lines: [{ line_index: 0, account_key: "bogus||" }] }, coaRows());
		expect(result.ok).toBe(false);

		const onDisk = JSON.parse(readFileSync(join(gd, "review-data.json"), "utf8"));
		expect(onDisk).toEqual(original);
	});

	test("saveRowEdit writes the edited row back to the bank_statement group file", async () => {
		const gd = join(dir, "ข้อมูลระบบ", "_doc_groups", "bank_statement", "seg-001");
		mkdirSync(gd, { recursive: true });
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(statementGroupData()));

		const result = await saveRowEdit(dir, "seg-001", 0, { amount: 700 }, coaRows());
		expect(result.ok).toBe(true);

		const onDisk = JSON.parse(readFileSync(join(gd, "review-data.json"), "utf8"));
		expect(onDisk.rows[0].amount).toBe(700);
	});

	test("saveStatementMetaEdit writes the bank GL account back to the group file", async () => {
		const gd = join(dir, "ข้อมูลระบบ", "_doc_groups", "bank_statement", "seg-001");
		mkdirSync(gd, { recursive: true });
		writeFileSync(join(gd, "review-data.json"), JSON.stringify(statementGroupData()));

		const result = await saveStatementMetaEdit(dir, "seg-001", { account_key: "111301||" }, coaRows());
		expect(result.ok).toBe(true);

		const onDisk = JSON.parse(readFileSync(join(gd, "review-data.json"), "utf8"));
		expect(onDisk.statement.bank_account_code).toBe("111301");
	});
});
