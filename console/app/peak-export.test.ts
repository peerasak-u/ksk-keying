import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import type { CoaRow } from "./coa";
import type { ReviewLine, ReviewPage, StatementEntry, StatementRow } from "./review-data";
import {
	buildExpenseOrRevenueRows,
	buildStatementJournalRows,
	buildXlsxWorkbook,
	derivePeakDate,
	groupLinesForExport,
	inferPndType,
	modalYear,
	peakTemplateForBucket,
	PEAK_EXPENSE_HEADERS,
	PEAK_REVENUE_HEADERS,
	snapWhtRate,
	STATEMENT_JOURNAL_HEADERS,
	vatSettingsForLineGroup,
	yearFromPeakDate,
} from "./peak-export";

// --- fixture builders --------------------------------------------------

function coaRows(): CoaRow[] {
	return [
		{ account_code: "520211", sub_code: "", name_th: "ค่าจ้างที่ปรึกษาการตลาด", name_en: "Marketing" },
		{ account_code: "410101", sub_code: "", name_th: "รายได้จากการขายสินค้า", name_en: "Sales" },
		{ account_code: "111301", sub_code: "", name_th: "เงินฝากออมทรัพย์", name_en: "Savings" },
	];
}

function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
	return {
		line_index: 0,
		description: "Performance Marketing",
		qty: 1,
		unit: null,
		unit_price: 22500,
		amount: 22500,
		amount_includes_vat: false,
		vat_treatment: null,
		account_code: "520211",
		sub_code: "",
		account_name_th: "ค่าจ้างที่ปรึกษาการตลาด",
		confidence: "high",
		reason: "matched",
		needs_review: false,
		...overrides,
	};
}

function page(overrides: Partial<ReviewPage> = {}): ReviewPage {
	return {
		ref: "seg-001/INV001.pdf p.1",
		short_ref: "INV001.pdf p.1",
		source_src: "INV001.pdf",
		source_page: 1,
		source_sheet: null,
		image_src: null,
		extract_path: "x",
		categorize_path: "y",
		facts: {
			date: "2026-04-07",
			document_no: "INV202604070001",
			seller: "บริษัท เอบีซี จำกัด",
			seller_tax_id: "0105564000000",
			buyer: "ลูกค้า",
			buyer_tax_id: "0105500000000",
			subtotal: 22500,
			vat: 1575,
			total: 24075,
			wht: null,
			vat_treatment: "vat_7",
		},
		lines: [line()],
		initial_status: "reviewed",
		skipped: false,
		group_label: "บริษัท เอบีซี จำกัด — INV202604070001",
		...overrides,
	};
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
		account_code: "520211",
		sub_code: "",
		account_name_th: "ค่าจ้างที่ปรึกษาการตลาด",
		confidence: "high",
		reason: "matched",
		needs_review: false,
		skipped: false,
		...overrides,
	};
}

function statementEntry(overrides: Partial<StatementEntry> = {}): StatementEntry {
	return {
		schema: "ksk_review_statement_data.v1",
		group_id: "seg-001",
		label: "Kbank — 123",
		group_dir: "seg-001",
		statement: { bank: "Kbank", account_no: "123", account_holder: null, period: null, opening_balance: 0, closing_balance: 0, bank_account_code: "111301", bank_sub_code: "" },
		source: { source_src: "stm.pdf", source_page: 1, source_sheet: null, image_src: null },
		rows: [statementRow()],
		...overrides,
	};
}

// --- ported pure helpers -----------------------------------------------

describe("snapWhtRate", () => {
	test("snaps within tolerance to a standard rate", () => {
		expect(snapWhtRate(30, 1000)).toBe(0.03);
	});
	test("null when the ratio doesn't snap to any standard rate", () => {
		expect(snapWhtRate(77, 1000)).toBeNull();
	});
	test("null when wht or base is missing/non-positive", () => {
		expect(snapWhtRate(null, 1000)).toBeNull();
		expect(snapWhtRate(30, 0)).toBeNull();
	});
});

describe("inferPndType", () => {
	test("juristic marker -> 53", () => {
		expect(inferPndType("บริษัท เอบีซี จำกัด")).toBe("53");
	});
	test("individual honorific -> 3", () => {
		expect(inferPndType("นายสมชาย ใจดี")).toBe("3");
	});
	test("no marker -> null", () => {
		expect(inferPndType("ร้านค้าทั่วไป")).toBeNull();
		expect(inferPndType(null)).toBeNull();
	});
});

describe("yearFromPeakDate / modalYear", () => {
	test("yearFromPeakDate reads the leading 4 digits of a normalized date", () => {
		expect(yearFromPeakDate("20260405")).toBe(2026);
		expect(yearFromPeakDate("not-a-date")).toBeNull();
	});

	test("modalYear picks the most common year, ties break to the later year", () => {
		expect(modalYear(["20260101", "20260201", "20250101"])).toBe(2026);
		expect(modalYear(["20260101", "20250101"])).toBe(2026);
	});
});

describe("derivePeakDate", () => {
	test("a year before the period shifts to Jan 1 of the period year", () => {
		expect(derivePeakDate("20250615", 2026)).toEqual({ date: "20260101", shifted: true, suspicious: false });
	});
	test("a year after the period is flagged suspicious, never shifted", () => {
		expect(derivePeakDate("20270615", 2026)).toEqual({ date: "20270615", shifted: false, suspicious: true });
	});
	test("matching year passes through untouched", () => {
		expect(derivePeakDate("20260615", 2026)).toEqual({ date: "20260615", shifted: false, suspicious: false });
	});
	test("no period year -> no shift, no suspicion", () => {
		expect(derivePeakDate("20250615", null)).toEqual({ date: "20250615", shifted: false, suspicious: false });
	});
});

// --- groupLinesForExport / vatSettingsForLineGroup --------------------------

describe("groupLinesForExport", () => {
	test("sums amounts for lines sharing the same account, using the COA label as description", () => {
		const lines = [line({ line_index: 0, amount: 100 }), line({ line_index: 1, amount: 200 })];
		const groups = groupLinesForExport(lines, coaRows());
		expect(groups).toEqual([{ account_code: "520211", description: "520211 ค่าจ้างที่ปรึกษาการตลาด", amount: 300, vat_treatment: null, amount_includes_vat: false }]);
	});

	test("a blank-account line groups separately per line_index and falls back to its own description", () => {
		const lines = [line({ line_index: 0, account_code: "", sub_code: "", description: "misc A" }), line({ line_index: 1, account_code: "", sub_code: "", description: "misc B" })];
		const groups = groupLinesForExport(lines, coaRows());
		expect(groups).toHaveLength(2);
		expect(groups.map((g) => g.description)).toEqual(["misc A", "misc B"]);
	});

	test("expense/mixed lines with different per-line vat_treatment stay in separate groups even with the same account", () => {
		const lines = [line({ line_index: 0, vat_treatment: "vat_7", amount: 100 }), line({ line_index: 1, vat_treatment: "non_vat", amount: 50 })];
		const groups = groupLinesForExport(lines, coaRows());
		expect(groups).toHaveLength(2);
	});
});

describe("vatSettingsForLineGroup", () => {
	test("vat_7 with amount_includes_vat=false -> price_type 1 (excl.)", () => {
		const group = { account_code: "520211", description: "x", amount: 100, vat_treatment: "vat_7", amount_includes_vat: false };
		expect(vatSettingsForLineGroup(group, "", [])).toEqual({ price_type: "1", vat_rate: "0.07" });
	});
	test("vat_7 with amount_includes_vat=true -> price_type 2 (incl.)", () => {
		const group = { account_code: "520211", description: "x", amount: 100, vat_treatment: "vat_7", amount_includes_vat: true };
		expect(vatSettingsForLineGroup(group, "", [])).toEqual({ price_type: "2", vat_rate: "0.07" });
	});
	test("non_vat -> price_type 3, vat_rate NO", () => {
		const group = { account_code: "520211", description: "x", amount: 100, vat_treatment: "non_vat", amount_includes_vat: null };
		expect(vatSettingsForLineGroup(group, "", [])).toEqual({ price_type: "3", vat_rate: "NO" });
	});
	test("falls back to the document-level vat_treatment when the group has none", () => {
		const group = { account_code: "520211", description: "x", amount: 100, vat_treatment: null, amount_includes_vat: null };
		expect(vatSettingsForLineGroup(group, "vat_7", [line({ amount_includes_vat: true })]).price_type).toBe("2");
	});
});

// --- buildExpenseOrRevenueRows ---------------------------------------------

describe("buildExpenseOrRevenueRows", () => {
	test("builds one row per line group for an expense page", () => {
		const result = buildExpenseOrRevenueRows([page()], false, coaRows());
		expect(result.committedCount).toBe(1);
		expect(result.rows).toHaveLength(1);
		const cells = result.rows[0].cells;
		expect(cells[0]).toBe(1); // ลำดับที่
		expect(cells[1]).toBe("20260407"); // วันที่เอกสาร
		expect(cells[4]).toBe("0105564000000"); // เลขทะเบียน (seller, expense)
		expect(cells[6]).toBe("INV202604070001"); // เลขที่ใบกำกับฯ
		expect(cells[10]).toBe("520211"); // บัญชี
		expect(cells[13]).toBe(22500); // จำนวนเงิน
	});

	test("builds a revenue row keyed off the buyer's tax id, not the seller's", () => {
		const result = buildExpenseOrRevenueRows([page({ lines: [line({ account_code: "410101", account_name_th: "รายได้จากการขายสินค้า" })] })], true, coaRows());
		const cells = result.rows[0].cells;
		expect(cells[2]).toBe("INV202604070001"); // เลขที่เอกสาร (revenue layout)
		expect(cells[5]).toBe("0105500000000"); // เลขทะเบียน (buyer, revenue)
	});

	test("excludes a page with skipped:true entirely", () => {
		const result = buildExpenseOrRevenueRows([page({ skipped: true })], false, coaRows());
		expect(result.rows).toHaveLength(0);
		expect(result.committedCount).toBe(0);
	});

	test("flags a WHT amount that doesn't snap to a standard rate", () => {
		const result = buildExpenseOrRevenueRows([page({ facts: { ...page().facts, wht: 77 } })], false, coaRows());
		expect(result.warnings.some((w) => w.includes("ไม่ตรงกับอัตรามาตรฐาน"))).toBe(true);
	});

	test("a standard WHT rate fills whtRate and infers ภ.ง.ด. from the seller name (expense only)", () => {
		const result = buildExpenseOrRevenueRows([page({ facts: { ...page().facts, wht: 675, subtotal: 22500 } })], false, coaRows());
		const cells = result.rows[0].cells;
		expect(cells[15]).toBe("0.03"); // หัก ณ ที่จ่าย: 675 / 22500 snaps to 3%
		expect(cells[18]).toBe("53"); // ภ.ง.ด.: seller "บริษัท เอบีซี จำกัด" is juristic
	});

	test("warns when the document date is blank", () => {
		const result = buildExpenseOrRevenueRows([page({ facts: { ...page().facts, date: "" } })], false, coaRows());
		expect(result.warnings.some((w) => w.includes("วันที่เอกสารว่าง"))).toBe(true);
	});

	test("rule 11: a document dated a year before the export's modal year is shifted to Jan 1 with a note", () => {
		const pages = [page({ ref: "a", facts: { ...page().facts, date: "2026-04-07" } }), page({ ref: "b", facts: { ...page().facts, date: "2025-01-15" } })];
		const result = buildExpenseOrRevenueRows(pages, false, coaRows());
		const shiftedRow = result.rows.find((r) => r.cells[1] === "20260101");
		expect(shiftedRow).toBeDefined();
	});
});

// --- buildStatementJournalRows -----------------------------------------

describe("buildStatementJournalRows", () => {
	test("emits a balanced debit/credit leg pair per row, direction 'out' debits the mapped account", () => {
		const result = buildStatementJournalRows([statementEntry()]);
		expect(result.rows).toHaveLength(2);
		expect(result.rows[0].cells[6]).toBe("520211"); // debit leg: mapped account
		expect(result.rows[1].cells[6]).toBe("111301"); // credit leg: bank account
		expect(result.debitTotal).toBe(500);
		expect(result.creditTotal).toBe(500);
	});

	test("direction 'in' debits the bank account instead", () => {
		const result = buildStatementJournalRows([statementEntry({ rows: [statementRow({ direction: "in" })] })]);
		expect(result.rows[0].cells[6]).toBe("111301");
		expect(result.rows[1].cells[6]).toBe("520211");
	});

	test("excludes a row with skipped:true, still counting it in totalCount", () => {
		const result = buildStatementJournalRows([statementEntry({ rows: [statementRow({ skipped: true })] })]);
		expect(result.rows).toHaveLength(0);
		expect(result.totalCount).toBe(1);
		expect(result.committedCount).toBe(0);
	});

	test("flags a row still mapped to the 999999 suspense account", () => {
		const result = buildStatementJournalRows([statementEntry({ rows: [statementRow({ account_code: "999999" })] })]);
		expect(result.warnings.some((w) => w.includes("บัญชีพัก"))).toBe(true);
	});

	test("spans multiple statement groups (bank accounts) in one export", () => {
		const result = buildStatementJournalRows([
			statementEntry({ group_id: "seg-001", rows: [statementRow({ row_index: 0 })] }),
			statementEntry({ group_id: "seg-002", statement: { ...statementEntry().statement, bank_account_code: "410101", bank_sub_code: "" }, rows: [statementRow({ row_index: 0, direction: "in", amount: 50 })] }),
		]);
		expect(result.committedCount).toBe(2);
	});
});

// --- peakTemplateForBucket ------------------------------------------------

describe("peakTemplateForBucket", () => {
	test("expense buckets use the expense headers/sheet", () => {
		expect(peakTemplateForBucket("expense/vat")).toEqual({ headers: PEAK_EXPENSE_HEADERS, sheetName: "Import_Expenses", isRevenue: false });
	});
	test("income buckets use the revenue headers/sheet", () => {
		expect(peakTemplateForBucket("income/vat")).toEqual({ headers: PEAK_REVENUE_HEADERS, sheetName: "Import_Receipt", isRevenue: true });
	});
});

// --- buildXlsxWorkbook (real xlsx round-trip) -------------------------------

describe("buildXlsxWorkbook", () => {
	test("round-trips headers and row cells through a real .xlsx buffer", () => {
		const buffer = buildXlsxWorkbook(["A", "B"], "Sheet1", [{ pageTitle: "x", cells: [1, "two"] }]);
		const workbook = XLSX.read(buffer, { type: "buffer" });
		expect(workbook.SheetNames).toEqual(["Sheet1"]);
		const data = XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1, { header: 1 }) as unknown[][];
		expect(data[0]).toEqual(["A", "B"]);
		expect(data[1]).toEqual([1, "two"]);
	});
});

// --- real-template header verification (defense in depth, mirrors
// .claude/skills/ksk-keying/scripts/tests/peak-export-layout.test.ts's own
// technique) — samples/ is gitignored, so a checkout without it skips. ------

const EXPORT_DIR = join(import.meta.dir, "..", "..", "samples", "export-file");
const haveTemplates = existsSync(EXPORT_DIR);
const describeIf = haveTemplates ? describe : describe.skip;

function templateHeaders(file: string, sheet: string): string[] {
	const wb = XLSX.readFile(join(EXPORT_DIR, file));
	const ws = wb.Sheets[sheet];
	if (!ws) throw new Error(`no sheet "${sheet}" in ${file}; has ${JSON.stringify(wb.SheetNames)}`);
	const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
	return (rows[0] ?? []).map((c) => String(c).trim());
}

const normalize = (s: string) => s.replace(/\s*\(ถ้ามี\)\s*/g, "").replace(/\s+/g, " ").trim();

describeIf("PEAK header layout vs real templates", () => {
	test("PEAK_EXPENSE_HEADERS matches PEAK_ImportExpense.xlsx", () => {
		expect(PEAK_EXPENSE_HEADERS.map(normalize)).toEqual(templateHeaders("PEAK_ImportExpense.xlsx", "Import_Expenses").map(normalize));
	});
	test("PEAK_REVENUE_HEADERS matches PEAK_ImportReceipt.xlsx", () => {
		expect(PEAK_REVENUE_HEADERS.map(normalize)).toEqual(templateHeaders("PEAK_ImportReceipt.xlsx", "Import_Receipt").map(normalize));
	});
	test("STATEMENT_JOURNAL_HEADERS matches PEAK_ImportJournal.xlsx", () => {
		expect(STATEMENT_JOURNAL_HEADERS.map(normalize)).toEqual(templateHeaders("PEAK_ImportJournal.xlsx", "Import Multiple Journal").map(normalize));
	});
});
