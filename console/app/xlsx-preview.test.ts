// Pure xlsx-preview tests — fixed fixture rows/tables/claims, no file I/O for
// the pure functions (same describe/test + fixture-builder style as
// review-claims.test.ts). loadSheetTables/buildXlsxPreviewMap are the thin
// I/O layer and get real integration tests against generated .xlsx fixtures
// instead (mirrors orchestrator.test.ts's mkdtempSync/rmSync scratch-dir
// pattern).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils as xlsxUtils, writeFile as writeWorkbook } from "xlsx";
import type { Claim, ClaimUnitRef } from "./review-claims";
import {
	buildXlsxPreviewMap,
	loadSheetTables,
	renderSheetTableHtml,
	renderWorkbookPreviewHtml,
	resolveSheetNames,
	selectXlsxRefs,
	toSheetTable,
	type SheetTable,
} from "./xlsx-preview";

// --- fixture builders --------------------------------------------------

function claim(overrides: Partial<Claim> = {}): Claim {
	return {
		unitKey: overrides.file ?? "a.pdf",
		file: "a.pdf",
		page: 1,
		sheet: null,
		fileKind: "pdf",
		reasonRaw: "duplicate",
		reasonCategory: "duplicate",
		reasonLabel: "ซ้ำกับเอกสารอื่น",
		extraScrutiny: false,
		declaredBy: "agent",
		duplicateOf: null,
		conflictGroup: null,
		referenceReportCheckMissing: false,
		...overrides,
	};
}

function dupRef(overrides: Partial<ClaimUnitRef> = {}): ClaimUnitRef {
	return { file: "orig.xlsx", page: null, sheet: "Sheet1", unitKey: "orig.xlsx#sSheet1", ...overrides };
}

function table(overrides: Partial<SheetTable> = {}): SheetTable {
	return { name: "Sheet1", rows: [], totalRows: 0, truncated: false, ...overrides };
}

// --- resolveSheetNames ---------------------------------------------------

describe("resolveSheetNames", () => {
	test("exact match returns a single-element array", () => {
		expect(resolveSheetNames(["Sheet1", "Sheet2"], "Sheet2")).toEqual(["Sheet2"]);
	});

	test("requested sheet missing falls back to the first sheet", () => {
		expect(resolveSheetNames(["Sheet1", "Sheet2"], "Nope")).toEqual(["Sheet1"]);
	});

	test("null requested returns everything in order", () => {
		expect(resolveSheetNames(["Sheet1", "Sheet2", "Sheet3"], null)).toEqual(["Sheet1", "Sheet2", "Sheet3"]);
	});

	test("empty sheetNames with a requested sheet returns []", () => {
		expect(resolveSheetNames([], "Sheet1")).toEqual([]);
	});
});

// --- toSheetTable ---------------------------------------------------------

describe("toSheetTable", () => {
	test("trims trailing all-null rows but keeps a trailing row with at least one non-null cell", () => {
		const rows: (string | number | null)[][] = [
			["a", "b"],
			["c", null],
			[null, null],
			[null, null],
		];
		const result = toSheetTable("Sheet1", rows);
		expect(result.rows).toEqual([
			["a", "b"],
			["c", null],
		]);
		expect(result.totalRows).toBe(2);
		expect(result.truncated).toBe(false);
	});

	test("a table with <=500 rows and <=40 cols is not flagged truncated and totalRows equals the row count", () => {
		const rows: (string | number | null)[][] = Array.from({ length: 10 }, (_, i) => [`r${i}`, i]);
		const result = toSheetTable("Sheet1", rows);
		expect(result.truncated).toBe(false);
		expect(result.totalRows).toBe(10);
		expect(result.rows.length).toBe(10);
	});

	test("a table with >500 rows is flagged truncated, only the first 500 rows appear, totalRows reflects pre-truncation count", () => {
		const rows: (string | number | null)[][] = Array.from({ length: 600 }, (_, i) => [`r${i}`]);
		const result = toSheetTable("Sheet1", rows);
		expect(result.truncated).toBe(true);
		expect(result.totalRows).toBe(600);
		expect(result.rows.length).toBe(500);
		expect(result.rows[0]).toEqual(["r0"]);
		expect(result.rows[499]).toEqual(["r499"]);
	});

	test("a row wider than 40 columns is flagged truncated and that row is cut to 40 cells", () => {
		const wideRow = Array.from({ length: 45 }, (_, i) => i);
		const rows: (string | number | null)[][] = [wideRow];
		const result = toSheetTable("Sheet1", rows);
		expect(result.truncated).toBe(true);
		expect(result.rows[0].length).toBe(40);
		expect(result.rows[0]).toEqual(wideRow.slice(0, 40));
	});

	test("name passes through unchanged", () => {
		const result = toSheetTable("My Sheet", [["a"]]);
		expect(result.name).toBe("My Sheet");
	});
});

// --- renderSheetTableHtml --------------------------------------------------

describe("renderSheetTableHtml", () => {
	test("escapes a cell value containing unsafe characters", () => {
		const t = table({ rows: [["<script>alert(1)</script>"]], totalRows: 1 });
		const html = renderSheetTableHtml(t);
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("a null cell renders as an empty cell, not the string 'null'", () => {
		const t = table({ rows: [["a", null, "b"]], totalRows: 1 });
		const html = renderSheetTableHtml(t);
		expect(html).not.toContain(">null<");
		expect(html).toContain("<td></td>");
	});

	test("the truncation note appears only when truncated is true", () => {
		const truncatedTable = table({ rows: [["a"]], totalRows: 5, truncated: true });
		const notTruncatedTable = table({ rows: [["a"]], totalRows: 1, truncated: false });
		expect(renderSheetTableHtml(truncatedTable)).toContain("บางส่วนถูกตัด");
		expect(renderSheetTableHtml(notTruncatedTable)).not.toContain("บางส่วนถูกตัด");
	});

	test("renders the 'no data' message when rows is empty", () => {
		const html = renderSheetTableHtml(table({ rows: [], totalRows: 0 }));
		expect(html).toContain("ไม่มีข้อมูลในชีตนี้");
	});

	test("includes the sheet name heading", () => {
		const html = renderSheetTableHtml(table({ name: "รายรับ", rows: [["a"]], totalRows: 1 }));
		expect(html).toContain("รายรับ");
	});
});

// --- renderWorkbookPreviewHtml ---------------------------------------------

describe("renderWorkbookPreviewHtml", () => {
	test("multiple tables each produce their own heading/content, in order", () => {
		const tables = [
			table({ name: "First", rows: [["a1"]], totalRows: 1 }),
			table({ name: "Second", rows: [["b1"]], totalRows: 1 }),
		];
		const html = renderWorkbookPreviewHtml(tables);
		expect(html.indexOf("First")).toBeGreaterThanOrEqual(0);
		expect(html.indexOf("Second")).toBeGreaterThan(html.indexOf("First"));
		expect(html).toContain("a1");
		expect(html).toContain("b1");
	});

	test("empty array renders the 'no sheets' message", () => {
		expect(renderWorkbookPreviewHtml([])).toContain("ไม่มีชีตให้แสดง");
	});
});

// --- selectXlsxRefs ---------------------------------------------------------

describe("selectXlsxRefs", () => {
	test("a plain xlsx claim with no duplicate is included", () => {
		const c = claim({ unitKey: "a.xlsx#sSheet1", file: "a.xlsx", page: null, sheet: "Sheet1", fileKind: "xlsx" });
		const refs = selectXlsxRefs([c]);
		expect(refs).toEqual([{ file: "a.xlsx", page: null, sheet: "Sheet1", unitKey: "a.xlsx#sSheet1" }]);
	});

	test("a pdf claim is excluded", () => {
		const c = claim({ unitKey: "a.pdf#p1", file: "a.pdf", page: 1, fileKind: "pdf" });
		expect(selectXlsxRefs([c])).toEqual([]);
	});

	test("a duplicate claim whose duplicateOf is xlsx includes both the claim's own unitKey and the counterpart's", () => {
		const c = claim({
			unitKey: "dup.pdf#p1",
			file: "dup.pdf",
			page: 1,
			fileKind: "pdf",
			duplicateOf: dupRef({ unitKey: "orig.xlsx#sSheet1" }),
		});
		const refs = selectXlsxRefs([c]);
		expect(refs.map((r) => r.unitKey)).toEqual(["orig.xlsx#sSheet1"]);
	});

	test("a duplicate xlsx claim includes both the claim's own unitKey and the counterpart's", () => {
		const c = claim({
			unitKey: "dup.xlsx#sSheet1",
			file: "dup.xlsx",
			page: null,
			sheet: "Sheet1",
			fileKind: "xlsx",
			duplicateOf: dupRef({ unitKey: "orig.xlsx#sSheet1" }),
		});
		const refs = selectXlsxRefs([c]);
		expect(refs.map((r) => r.unitKey)).toEqual(["dup.xlsx#sSheet1", "orig.xlsx#sSheet1"]);
	});

	test("two claims sharing the same xlsx duplicateOf counterpart produce only one entry for that shared unitKey", () => {
		const c1 = claim({
			unitKey: "dup1.pdf#p1",
			file: "dup1.pdf",
			page: 1,
			fileKind: "pdf",
			duplicateOf: dupRef({ unitKey: "orig.xlsx#sSheet1" }),
		});
		const c2 = claim({
			unitKey: "dup2.pdf#p1",
			file: "dup2.pdf",
			page: 1,
			fileKind: "pdf",
			duplicateOf: dupRef({ unitKey: "orig.xlsx#sSheet1" }),
		});
		const refs = selectXlsxRefs([c1, c2]);
		expect(refs.filter((r) => r.unitKey === "orig.xlsx#sSheet1").length).toBe(1);
	});

	test("a duplicate claim whose counterpart is a .pdf does not add the counterpart to the result", () => {
		const c = claim({
			unitKey: "dup.pdf#p1",
			file: "dup.pdf",
			page: 1,
			fileKind: "pdf",
			duplicateOf: { file: "orig.pdf", page: 1, sheet: null, unitKey: "orig.pdf#p1" },
		});
		expect(selectXlsxRefs([c])).toEqual([]);
	});

	test("preserves the order refs were first encountered: claim before its own duplicateOf", () => {
		const c = claim({
			unitKey: "dup.xlsx#sSheet1",
			file: "dup.xlsx",
			page: null,
			sheet: "Sheet1",
			fileKind: "xlsx",
			duplicateOf: dupRef({ unitKey: "orig.xlsx#sSheet2", sheet: "Sheet2" }),
		});
		const refs = selectXlsxRefs([c]);
		expect(refs.map((r) => r.unitKey)).toEqual(["dup.xlsx#sSheet1", "orig.xlsx#sSheet2"]);
	});
});

// --- thin I/O: loadSheetTables / buildXlsxPreviewMap -----------------------

describe("loadSheetTables / buildXlsxPreviewMap (real .xlsx fixtures)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ksk-xlsx-preview-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeXlsx(path: string, sheets: Record<string, (string | number | null)[][]>) {
		const wb = xlsxUtils.book_new();
		for (const [name, rows] of Object.entries(sheets)) {
			const ws = xlsxUtils.aoa_to_sheet(rows);
			xlsxUtils.book_append_sheet(wb, ws, name);
		}
		writeWorkbook(wb, path);
	}

	test("reads back a real single-sheet file for a specific requested sheet name", () => {
		const path = join(dir, "single.xlsx");
		writeXlsx(path, { Sheet1: [["a", "b"], [1, 2]] });
		const tables = loadSheetTables(path, "Sheet1");
		expect(tables).not.toBeNull();
		expect(tables!.length).toBe(1);
		expect(tables![0].name).toBe("Sheet1");
		expect(tables![0].rows.length).toBe(2);
	});

	test("reads back a real multi-sheet file with requestedSheet: null returns all sheets", () => {
		const path = join(dir, "multi.xlsx");
		writeXlsx(path, {
			First: [["a"]],
			Second: [["b"]],
		});
		const tables = loadSheetTables(path, null);
		expect(tables).not.toBeNull();
		expect(tables!.map((t) => t.name)).toEqual(["First", "Second"]);
	});

	test("returns null for a nonexistent path", () => {
		const path = join(dir, "does-not-exist.xlsx");
		expect(loadSheetTables(path, null)).toBeNull();
	});

	test("buildXlsxPreviewMap end-to-end against fixture Claim objects", () => {
		writeXlsx(join(dir, "readable.xlsx"), { Sheet1: [["header"], ["value1"]] });

		const goodClaim = claim({
			unitKey: "readable.xlsx#sSheet1",
			file: "readable.xlsx",
			page: null,
			sheet: "Sheet1",
			fileKind: "xlsx",
		});
		const badClaim = claim({
			unitKey: "missing.xlsx#sSheet1",
			file: "missing.xlsx",
			page: null,
			sheet: "Sheet1",
			fileKind: "xlsx",
		});

		const map = buildXlsxPreviewMap(dir, [goodClaim, badClaim]);

		expect(map.get("readable.xlsx#sSheet1")).toContain("header");
		expect(map.get("readable.xlsx#sSheet1")).toContain("value1");
		expect(map.get("missing.xlsx#sSheet1")).toContain("ไม่สามารถอ่านไฟล์ Excel นี้ได้");
		expect(map.get("missing.xlsx#sSheet1")).toContain("missing.xlsx");
	});

	test("two claims against different sheets of the SAME workbook file each get their own sheet's content (cache doesn't cross-contaminate)", () => {
		writeXlsx(join(dir, "shared.xlsx"), {
			รายได้: [["income-row"]],
			รายจ่าย: [["expense-row"]],
		});

		const incomeClaim = claim({
			unitKey: "shared.xlsx#sรายได้",
			file: "shared.xlsx",
			page: null,
			sheet: "รายได้",
			fileKind: "xlsx",
		});
		const expenseClaim = claim({
			unitKey: "shared.xlsx#sรายจ่าย",
			file: "shared.xlsx",
			page: null,
			sheet: "รายจ่าย",
			fileKind: "xlsx",
		});

		const map = buildXlsxPreviewMap(dir, [incomeClaim, expenseClaim]);

		expect(map.get("shared.xlsx#sรายได้")).toContain("income-row");
		expect(map.get("shared.xlsx#sรายได้")).not.toContain("expense-row");
		expect(map.get("shared.xlsx#sรายจ่าย")).toContain("expense-row");
		expect(map.get("shared.xlsx#sรายจ่าย")).not.toContain("income-row");
	});
});
