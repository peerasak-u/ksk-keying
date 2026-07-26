// Direct-save editing for category/group review (wayfinder ticket #41): "a
// value/account-code edit on the review page is a direct, immediate save
// into review-data.json — never a pipeline re-run" (ticket #35's resolution,
// echoed in #41's own body). applyPageEdit/applyRowEdit/applyStatementMetaEdit
// are the pure core (existing group doc + an edit -> next group doc);
// savePageEdit/saveRowEdit/saveStatementMetaEdit are their thin I/O wrappers,
// atomic-writing the SPECIFIC group's review-data.json the same way
// dispositions-writer.ts / run-store.ts write their files
// (temp-file-then-rename).
//
// Scope is deliberately narrow, matching the ticket's own words ("value
// corrections, account-code reassignment") rather than the old app's full
// commit/skip/status workflow: no line add/remove, no per-page
// reviewed/skipped/note state — those were bound up with PEAK export-row
// inclusion, which is ticket #42's job, not this one's.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoaRow } from "./coa";
import { coaKey } from "./coa";
import {
	type DocumentGroupData,
	type StatementGroupData,
	groupDir,
	type BucketKey,
	parseDocumentGroupData,
	parseStatementGroupData,
} from "./review-data";

export type EditResult<T> = { ok: true; data: T } | { ok: false; error: string };

function resolveCoaKey(key: string, coaRows: CoaRow[]): CoaRow | null {
	return coaRows.find((row) => coaKey(row) === key) ?? null;
}

export type PageFactsEdit = Record<string, string | number | null>;

export type PageLinePatch = {
	line_index: number;
	description?: string | null;
	qty?: number | null;
	unit?: string | null;
	unit_price?: number | null;
	amount?: number | null;
	amount_includes_vat?: boolean | null;
	vat_treatment?: "vat_7" | "non_vat" | null;
	/** coaKey() composite (account_code||sub_code); when present, resolves
	 * account_code/sub_code/account_name_th server-side from coaRows rather
	 * than trusting a client-sent label — an unknown key is rejected outright
	 * rather than silently accepted with a stale/blank name. */
	account_key?: string;
};

export type PageEdit = {
	facts?: PageFactsEdit;
	lines?: PageLinePatch[];
	/** Ticket #42's export-gate escape hatch — flips ReviewPage.skipped. */
	skipped?: boolean;
};

/** Pure: apply one page's facts/line edits within its OWN group document
 * (never the merged bucket view — that's a read-only flattening). Addressed
 * by pageIndex (position in this group's own pages[]), not by `ref` — ref is
 * a display label with no uniqueness guarantee. `allowVatTreatment` must be
 * true only for the expense/mixed bucket (review-data-schema.md: "set per
 * line only in expense/mixed groups; leave null elsewhere") — when false, a
 * patch's vat_treatment is silently ignored (the line's existing value is
 * kept) rather than trusted from the request, so a raw POST to any other
 * bucket's edit endpoint can't smuggle a per-line VAT override the schema
 * forbids there. */
export function applyPageEdit(
	doc: DocumentGroupData,
	pageIndex: number,
	edit: PageEdit,
	coaRows: CoaRow[],
	allowVatTreatment: boolean,
): EditResult<DocumentGroupData> {
	if (pageIndex < 0 || pageIndex >= doc.pages.length) return { ok: false, error: `ไม่พบเอกสารลำดับที่ ${pageIndex} ในกลุ่มนี้` };
	const page = doc.pages[pageIndex];
	const nextFacts = edit.facts ? { ...page.facts, ...edit.facts } : page.facts;

	let nextLines = page.lines;
	if (edit.lines) {
		nextLines = [...page.lines];
		for (const patch of edit.lines) {
			const lineIndex = nextLines.findIndex((l) => l.line_index === patch.line_index);
			if (lineIndex === -1) return { ok: false, error: `ไม่พบบรรทัดที่ ${patch.line_index} ในเอกสารนี้` };
			const current = nextLines[lineIndex];
			let account_code = current.account_code;
			let sub_code = current.sub_code;
			let account_name_th = current.account_name_th;
			if (patch.account_key !== undefined) {
				const resolved = resolveCoaKey(patch.account_key, coaRows);
				if (!resolved) return { ok: false, error: `ไม่พบรหัสบัญชี "${patch.account_key}" ในผังบัญชี` };
				account_code = resolved.account_code;
				sub_code = resolved.sub_code;
				account_name_th = resolved.name_th;
			}
			nextLines[lineIndex] = {
				...current,
				description: patch.description !== undefined ? patch.description : current.description,
				qty: patch.qty !== undefined ? patch.qty : current.qty,
				unit: patch.unit !== undefined ? patch.unit : current.unit,
				unit_price: patch.unit_price !== undefined ? patch.unit_price : current.unit_price,
				amount: patch.amount !== undefined ? patch.amount : current.amount,
				amount_includes_vat: patch.amount_includes_vat !== undefined ? patch.amount_includes_vat : current.amount_includes_vat,
				vat_treatment: allowVatTreatment && patch.vat_treatment !== undefined ? patch.vat_treatment : current.vat_treatment,
				account_code,
				sub_code,
				account_name_th,
			};
		}
	}

	const nextSkipped = edit.skipped !== undefined ? edit.skipped : page.skipped;

	const nextPages = [...doc.pages];
	// A save through this endpoint IS the human review signal for this page —
	// initial_status otherwise never moves off the pipeline's own one-time
	// guess, which left the review hub's progress bar stuck reporting the
	// AI's original confidence split forever, never reflecting any amount of
	// actual human review (real finding: 216's expense/vat bucket showed
	// 0/31 "reviewed" after a full human pass saved every page).
	nextPages[pageIndex] = { ...page, facts: nextFacts, lines: nextLines, skipped: nextSkipped, initial_status: "reviewed" };
	return { ok: true, data: { ...doc, pages: nextPages } };
}

export type RowEdit = {
	description?: string | null;
	amount?: number;
	/** coaKey() composite; resolved server-side same as PageLinePatch's. */
	account_key?: string;
	/** Ticket #42's export-gate escape hatch — flips StatementRow.skipped. */
	skipped?: boolean;
};

/** Pure: apply one transaction row's edit within a bank_statement group
 * document. `direction` is never editable here (matches the old UI: the
 * amount input for the non-matching direction column was always read-only). */
export function applyRowEdit(doc: StatementGroupData, rowIndex: number, edit: RowEdit, coaRows: CoaRow[]): EditResult<StatementGroupData> {
	const index = doc.rows.findIndex((r) => r.row_index === rowIndex);
	if (index === -1) return { ok: false, error: `ไม่พบรายการลำดับที่ ${rowIndex}` };
	const current = doc.rows[index];
	let account_code = current.account_code;
	let sub_code = current.sub_code;
	let account_name_th = current.account_name_th;
	if (edit.account_key !== undefined) {
		const resolved = resolveCoaKey(edit.account_key, coaRows);
		if (!resolved) return { ok: false, error: `ไม่พบรหัสบัญชี "${edit.account_key}" ในผังบัญชี` };
		account_code = resolved.account_code;
		sub_code = resolved.sub_code;
		account_name_th = resolved.name_th;
	}
	const nextRows = [...doc.rows];
	nextRows[index] = {
		...current,
		description: edit.description !== undefined ? edit.description : current.description,
		amount: edit.amount !== undefined ? edit.amount : current.amount,
		account_code,
		sub_code,
		account_name_th,
		skipped: edit.skipped !== undefined ? edit.skipped : current.skipped,
		// Same rationale as applyPageEdit's initial_status flip: a save IS the
		// human review signal for this row.
		needs_review: false,
	};
	return { ok: true, data: { ...doc, rows: nextRows } };
}

export type StatementMetaEdit = { account_key: string };

/** Pure: reassign the bank account's own GL contra account
 * (statement.bank_account_code/bank_sub_code). */
export function applyStatementMetaEdit(doc: StatementGroupData, edit: StatementMetaEdit, coaRows: CoaRow[]): EditResult<StatementGroupData> {
	const resolved = resolveCoaKey(edit.account_key, coaRows);
	if (!resolved) return { ok: false, error: `ไม่พบรหัสบัญชี "${edit.account_key}" ในผังบัญชี` };
	return {
		ok: true,
		data: { ...doc, statement: { ...doc.statement, bank_account_code: resolved.account_code, bank_sub_code: resolved.sub_code } },
	};
}

// ---------------------------------------------------------------------------
// Thin I/O wrappers — read the specific group's review-data.json, apply one
// edit, write back atomically (temp-file-then-rename, same as
// dispositions-writer.ts's writeDispositionsFile / run-store.ts).

function writeReviewDataFile(path: string, data: unknown): void {
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	renameSync(tmpPath, path);
}

export async function savePageEdit(
	clientMonthDir: string,
	bucket: BucketKey,
	groupId: string,
	pageIndex: number,
	edit: PageEdit,
	coaRows: CoaRow[],
): Promise<EditResult<void>> {
	const path = join(groupDir(clientMonthDir, bucket, groupId), "review-data.json");
	if (!existsSync(path)) return { ok: false, error: "ไม่พบ review-data.json สำหรับกลุ่มนี้" };
	let doc: DocumentGroupData;
	try {
		doc = parseDocumentGroupData(await readFile(path, "utf8"), path);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	const result = applyPageEdit(doc, pageIndex, edit, coaRows, bucket === "expense/mixed");
	if (!result.ok) return result;
	writeReviewDataFile(path, result.data);
	return { ok: true, data: undefined };
}

async function loadStatementDoc(clientMonthDir: string, groupId: string): Promise<EditResult<{ path: string; doc: StatementGroupData }>> {
	const path = join(groupDir(clientMonthDir, "bank_statement", groupId), "review-data.json");
	if (!existsSync(path)) return { ok: false, error: "ไม่พบ review-data.json สำหรับกลุ่มนี้" };
	try {
		return { ok: true, data: { path, doc: parseStatementGroupData(await readFile(path, "utf8"), path) } };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function saveRowEdit(clientMonthDir: string, groupId: string, rowIndex: number, edit: RowEdit, coaRows: CoaRow[]): Promise<EditResult<void>> {
	const loaded = await loadStatementDoc(clientMonthDir, groupId);
	if (!loaded.ok) return loaded;
	const result = applyRowEdit(loaded.data.doc, rowIndex, edit, coaRows);
	if (!result.ok) return result;
	writeReviewDataFile(loaded.data.path, result.data);
	return { ok: true, data: undefined };
}

export async function saveStatementMetaEdit(clientMonthDir: string, groupId: string, edit: StatementMetaEdit, coaRows: CoaRow[]): Promise<EditResult<void>> {
	const loaded = await loadStatementDoc(clientMonthDir, groupId);
	if (!loaded.ok) return loaded;
	const result = applyStatementMetaEdit(loaded.data.doc, edit, coaRows);
	if (!result.ok) return result;
	writeReviewDataFile(loaded.data.path, result.data);
	return { ok: true, data: undefined };
}
