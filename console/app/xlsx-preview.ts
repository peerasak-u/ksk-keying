// Ports review-groups.ts's buildSheetPreview technique (sheet_to_json with
// raw:false, trailing-blank-row trim, 500-row/40-col cap) into the new
// console's excluded-review page: pure table-shaping/rendering functions
// (real unit tests) plus a thin file-reading wrapper (not unit tested the
// same way — mirrors review-claims.ts's convention).
import { readFile, utils as xlsxUtils, type WorkBook } from "xlsx";
import { join } from "node:path";
import type { Claim, ClaimUnitRef } from "./review-claims";

export type SheetTable = {
	name: string;
	rows: (string | number | null)[][];
	totalRows: number;
	truncated: boolean;
};

const SHEET_MAX_ROWS = 500;
const SHEET_MAX_COLS = 40;

/** Which sheet names to render for a claim. `requestedSheet === null` means a
 * file-level claim (context_file/reference_example applied to the whole
 * workbook) — show every sheet. A stale/mismatched requested sheet name
 * falls back to the first sheet, mirroring review-groups.ts's own forgiving
 * fallback. */
export function resolveSheetNames(sheetNames: string[], requestedSheet: string | null): string[] {
	if (requestedSheet === null) return [...sheetNames];
	if (sheetNames.includes(requestedSheet)) return [requestedSheet];
	return sheetNames.length ? [sheetNames[0]] : [];
}

/** Shapes one sheet's raw sheet_to_json rows into a bounded preview table. */
export function toSheetTable(name: string, allRows: (string | number | null)[][]): SheetTable {
	const trimmed = [...allRows];
	while (trimmed.length && trimmed[trimmed.length - 1].every((cell) => cell == null)) trimmed.pop();

	const totalRows = trimmed.length;
	let truncated = totalRows > SHEET_MAX_ROWS;
	const rows = trimmed.slice(0, SHEET_MAX_ROWS).map((row) => {
		if (row.length > SHEET_MAX_COLS) truncated = true;
		return row.slice(0, SHEET_MAX_COLS);
	});

	return { name, rows, totalRows, truncated };
}

function cellHtml(cell: string | number | null): string {
	if (cell == null) return "";
	return Bun.escapeHTML(String(cell));
}

/** Renders one sheet's table as a scrollable HTML block. The first row gets
 * a distinct CSS class (visual hint only, not a semantic <thead> — real
 * spreadsheets rarely have a clean single header row). */
export function renderSheetTableHtml(table: SheetTable): string {
	const heading = `<div class="xlsx-sheet-name">${Bun.escapeHTML(table.name)}</div>`;

	if (table.rows.length === 0) {
		return `<div class="xlsx-sheet-table">${heading}<div class="xlsx-empty">ไม่มีข้อมูลในชีตนี้</div></div>`;
	}

	const rowsHtml = table.rows
		.map((row, i) => {
			const cellsHtml = row.map((cell) => `<td>${cellHtml(cell)}</td>`).join("");
			return `<tr class="${i === 0 ? "xlsx-header-row" : ""}">${cellsHtml}</tr>`;
		})
		.join("");

	const note =
		table.truncated && table.rows.length < table.totalRows
			? `<div class="xlsx-truncated-note">แสดง ${table.rows.length} จาก ${table.totalRows} แถว (บางส่วนถูกตัด)</div>`
			: table.truncated
				? `<div class="xlsx-truncated-note">บางส่วนถูกตัด</div>`
				: "";

	return `<div class="xlsx-sheet-table">${heading}<div class="xlsx-table-scroll"><table>${rowsHtml}</table></div>${note}</div>`;
}

/** Joins the per-sheet tables for a workbook-level (possibly multi-sheet)
 * preview, separated by a visual divider. */
export function renderWorkbookPreviewHtml(tables: SheetTable[]): string {
	if (tables.length === 0) return `<div class="xlsx-empty">ไม่มีชีตให้แสดง</div>`;
	return tables.map((t) => renderSheetTableHtml(t)).join(`<div class="xlsx-sheet-divider"></div>`);
}

/** Shared by selectXlsxRefs here and excluded-review.ts's previewHtml — one
 * definition of "is this an xlsx unit" so the two never drift apart. */
export function isXlsxFile(file: string): boolean {
	const lower = file.toLowerCase();
	return lower.endsWith(".xlsx") || lower.endsWith(".xls");
}

/** The deduplicated (by unitKey) list of xlsx unit refs the review page needs
 * a preview for: each claim itself (trusting its own fileKind field), plus
 * its duplicateOf counterpart when present (checked by file extension, since
 * ClaimUnitRef carries no fileKind). First occurrence wins; order follows
 * claims as walked, claim-then-counterpart. */
export function selectXlsxRefs(claims: Claim[]): ClaimUnitRef[] {
	const seen = new Set<string>();
	const refs: ClaimUnitRef[] = [];

	const add = (ref: ClaimUnitRef) => {
		if (seen.has(ref.unitKey)) return;
		seen.add(ref.unitKey);
		refs.push(ref);
	};

	for (const claim of claims) {
		if (claim.fileKind === "xlsx") {
			add({ file: claim.file, page: claim.page, sheet: claim.sheet, unitKey: claim.unitKey });
		}
		if (claim.duplicateOf && isXlsxFile(claim.duplicateOf.file)) {
			add(claim.duplicateOf);
		}
	}

	return refs;
}

// ---------------------------------------------------------------------------
// Thin I/O wrappers — read real on-disk workbooks, tested via generated real
// .xlsx fixtures (see xlsx-preview.test.ts) rather than fixture-object unit
// tests, same convention as review-claims.ts's thin readers.

/** Reads the workbook at absPath. Returns null if it can't be read/parsed at
 * all — separated from sheet-shaping so buildXlsxPreviewMap can cache one
 * parsed workbook across several units that share the same file (a common
 * shape: two sheets of one report each excluded as their own claim). */
function loadWorkbook(absPath: string): WorkBook | null {
	try {
		return readFile(absPath);
	} catch {
		return null;
	}
}

function sheetTablesFromWorkbook(workbook: WorkBook, requestedSheet: string | null): SheetTable[] {
	const names = resolveSheetNames(workbook.SheetNames, requestedSheet);
	return names.map((name) => {
		const sheet = workbook.Sheets[name];
		const rawRows = xlsxUtils.sheet_to_json(sheet, { header: 1, raw: false, defval: null }) as (string | number | null)[][];
		return toSheetTable(name, rawRows);
	});
}

/** Reads the workbook at absPath and shapes the resolved sheet(s) into bounded
 * preview tables. Returns null if the file can't be read/parsed at all (that's
 * different from an empty array, which means "read fine, but no sheets to
 * show"). */
export function loadSheetTables(absPath: string, requestedSheet: string | null): SheetTable[] | null {
	const workbook = loadWorkbook(absPath);
	return workbook ? sheetTablesFromWorkbook(workbook, requestedSheet) : null;
}

/** Builds the unitKey -> rendered-HTML map the excluded-review page needs for
 * every xlsx unit referenced by claims/duplicateOf pairs. Unreadable files get
 * a graceful Thai placeholder instead of failing the whole page. Caches each
 * workbook by absPath for the lifetime of this call only (not module-level —
 * the server is long-running, so a cache that outlived one render could serve
 * stale content after a file changes on disk). */
export function buildXlsxPreviewMap(targetDir: string, claims: Claim[]): Map<string, string> {
	const map = new Map<string, string>();
	const workbookCache = new Map<string, WorkBook | null>();
	for (const ref of selectXlsxRefs(claims)) {
		const absPath = join(targetDir, ref.file);
		let workbook = workbookCache.get(absPath);
		if (workbook === undefined) {
			workbook = loadWorkbook(absPath);
			workbookCache.set(absPath, workbook);
		}
		if (workbook === null) {
			map.set(ref.unitKey, `<div class="xlsx-empty">ไม่สามารถอ่านไฟล์ Excel นี้ได้: ${Bun.escapeHTML(ref.file)}</div>`);
		} else {
			map.set(ref.unitKey, renderWorkbookPreviewHtml(sheetTablesFromWorkbook(workbook, ref.sheet)));
		}
	}
	return map;
}
