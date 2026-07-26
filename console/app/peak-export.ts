// PEAK XLSX export row-builders (wayfinder ticket #42, server-side export
// decided in ticket #35: "the backend builds the XLSX ... no vendored
// client-side XLSX library"). Exact port of review-template.ts's
// buildExpenseOrRevenueRows/buildStatementJournalRows/groupLinesForExport/
// vatSettingsForLineGroup + the WHT/ภ.ง.ด./rule-11 date-shift helpers
// (snapWhtRate/inferPndType/yearFromPeakDate/modalYear/derivePeakDate),
// adapted to this app's actual schema: the old app kept a separate mutable
// "draft state" object overlaying the original page (state.lines vs
// page.lines), but here review-data.json's page.lines/rows already ARE the
// current (possibly human-edited) values directly — there is no second
// overlay to reconcile, which simplifies groupLinesForExport considerably
// versus the original.
import { utils as xlsxUtils, write as xlsxWrite } from "xlsx";
import { coaKey, coaLabel, splitCoaKey, type CoaRow } from "./coa";
import { formatStatementDate, normalizeDateForPeak } from "./peak-format";
import type { DocumentBucket, ReviewLine, ReviewPage, StatementEntry } from "./review-data";

// --- pure helpers ported verbatim from review-template.ts ------------------

/** Snap a document's printed WHT amount to a standard Thai withholding rate.
 * PEAK only accepts standard rates; a ratio that doesn't snap within
 * tolerance must go to a human, never be rounded to the nearest rate. */
export function snapWhtRate(wht: number | null, base: number | null): number | null {
	if (wht === null || base === null || !(wht > 0) || !(base > 0)) return null;
	const rates = [0.01, 0.015, 0.02, 0.03, 0.05, 0.1];
	const ratio = wht / base;
	for (const rate of rates) if (Math.abs(ratio - rate) <= 0.002) return rate;
	return null;
}

/** ภ.ง.ด. form from the counterparty name alone: 53 for juristic persons, 3
 * for individuals. Anything without an explicit marker returns null — the
 * form is a filing obligation, so it is never guessed. */
export function inferPndType(counterpartyName: string | null | undefined): "53" | "3" | null {
	const name = String(counterpartyName ?? "").trim();
	if (!name) return null;
	const juristicMarkers = ["บริษัท", "บจก", "บมจ", "หจก", "ห้างหุ้นส่วน", "จำกัด"];
	for (const marker of juristicMarkers) if (name.includes(marker)) return "53";
	if (/^(นางสาว|น\.ส\.|นาย|นาง)/.test(name)) return "3";
	return null;
}

/** Year of a normalizeDateForPeak() result ("YYYYMMDD", already CE-normalized).
 * Null when the value is not a fully normalized date. */
export function yearFromPeakDate(peakDate: string | null | undefined): number | null {
	const match = /^([0-9]{4})[0-9]{4}$/.exec(String(peakDate ?? ""));
	if (!match) return null;
	const year = Number(match[1]);
	return year > 0 ? year : null;
}

/** Accounting-period year of one bucket export: the modal year across every
 * document date in it. Ties break to the later year. */
export function modalYear(peakDates: (string | null | undefined)[]): number | null {
	const counts = new Map<number, number>();
	for (const value of peakDates) {
		const match = /^([0-9]{4})[0-9]{4}$/.exec(String(value ?? ""));
		if (!match) continue;
		const year = Number(match[1]);
		if (!(year > 0)) continue;
		counts.set(year, (counts.get(year) || 0) + 1);
	}
	let bestYear: number | null = null;
	let bestCount = 0;
	for (const [year, count] of counts) {
		if (count > bestCount || (count === bestCount && bestYear !== null && year > bestYear)) {
			bestYear = year;
			bestCount = count;
		}
	}
	return bestYear;
}

/** Decision Policy rule 11 ("ข้ามปี ให้ใช้วันที่ 1"): a document dated in a
 * year before the accounting period is keyed as Jan 1 of the period year;
 * the printed date stays in facts. A year *after* the period is likely a
 * misread — flagged via `suspicious`, never shifted. */
export function derivePeakDate(peakDate: string, periodYear: number | null): { date: string; shifted: boolean; suspicious: boolean } {
	const match = /^([0-9]{4})[0-9]{4}$/.exec(String(peakDate ?? ""));
	const year = match ? Number(match[1]) : null;
	if (year === null || !(year > 0) || periodYear === null) return { date: peakDate, shifted: false, suspicious: false };
	if (year < periodYear) return { date: `${String(periodYear).padStart(4, "0")}0101`, shifted: true, suspicious: false };
	if (year > periodYear) return { date: peakDate, shifted: false, suspicious: true };
	return { date: peakDate, shifted: false, suspicious: false };
}

function normalizeTaxId(value: string | number | null | undefined): string {
	return String(value ?? "").replace(/[^0-9]/g, "");
}

function numberOrNull(value: string | number | null | undefined): number | null {
	const text = String(value ?? "").replace(/,/g, "").trim();
	if (!text) return null;
	const n = Number(text);
	return Number.isFinite(n) ? n : null;
}

function pageTitle(page: ReviewPage): string {
	return page.group_label ? `${page.group_label} · ${page.short_ref}` : page.short_ref;
}

// --- PEAK sheet layouts (verified against samples/export-file/*.xlsx by
// peak-export-layout.test.ts's real-template technique, mirrored below) -----

export const PEAK_EXPENSE_HEADERS = [
	"ลำดับที่*", "วันที่เอกสาร", "อ้างอิงถึง", "ผู้รับเงิน/คู่ค้า", "เลขทะเบียน 13 หลัก", "เลขสาขา 5 หลัก",
	"เลขที่ใบกำกับฯ", "วันที่ใบกำกับฯ", "วันที่บันทึกภาษีซื้อ", "ประเภทราคา", "บัญชี", "คำอธิบาย",
	"จำนวน", "ราคาต่อหน่วย", "อัตราภาษี", "หัก ณ ที่จ่าย", "ชำระโดย", "จำนวนเงินที่ชำระ", "ภ.ง.ด.",
	"หมายเหตุ", "กลุ่มจัดประเภท",
];

// PEAK_ImportReceipt is NOT an expense sheet with renamed columns — its own
// 20-column layout: เลขที่เอกสาร sits at C, counterparty is ลูกค้า/E, an extra
// การออกใบกำกับภาษี/H and สินค้า/บริการ/J and ส่วนลดต่อหน่วย/O, no ภ.ง.ด. and no
// "amount paid" column at all.
export const PEAK_REVENUE_HEADERS = [
	"ลำดับที่*", "วันที่เอกสาร", "เลขที่เอกสาร", "อ้างอิงถึง", "ลูกค้า", "เลขทะเบียน 13 หลัก", "เลขสาขา 5 หลัก",
	"การออกใบกำกับภาษี", "ประเภทราคา", "สินค้า/บริการ", "บัญชี", "คำอธิบาย", "จำนวน", "ราคาต่อหน่วย",
	"ส่วนลดต่อหน่วย", "อัตราภาษี", "ถูกหัก ณ ที่จ่าย(ถ้ามี)", "รับชำระโดย", "หมายเหตุ", "กลุ่มจัดประเภท",
];

// PEAK_ImportJournal, "Import Multiple Journal" sheet, 12 columns — used for
// the bank_statement bucket's statement journal export.
export const STATEMENT_JOURNAL_HEADERS = [
	"ลำดับที", "สมุดบัญชี", "วันที่รายการ (YYYYMMDD)", "อ้างอิง", "ผู้ติดต่อ", "คำอธิบายการบันทึกบัญชี",
	"เลขที่บัญชี*", "บัญชีย่อย", "คำอธิบายรายการ (ว่างเพื่อให้ระบบใส่ให้)", "เดบิต", "เครดิต", "กลุ่มจัดประเภท",
];

const STATEMENT_JOURNAL_BOOK_NAME = "รายวันทั่วไป";
const STATEMENT_JOURNAL_SHEET_NAME = "Import Multiple Journal";
const EXPENSE_SHEET_NAME = "Import_Expenses";
const REVENUE_SHEET_NAME = "Import_Receipt";

export function peakTemplateForBucket(bucket: DocumentBucket): { headers: string[]; sheetName: string; isRevenue: boolean } {
	const isRevenue = bucket.startsWith("income/");
	return { headers: isRevenue ? PEAK_REVENUE_HEADERS : PEAK_EXPENSE_HEADERS, sheetName: isRevenue ? REVENUE_SHEET_NAME : EXPENSE_SHEET_NAME, isRevenue };
}

// --- line grouping + VAT settings --------------------------------------

type LineGroup = { account_code: string; description: string; amount: number | null; vat_treatment: string | null; amount_includes_vat: boolean | null };

function coaLabelByKey(key: string, coaRows: CoaRow[]): string {
	const row = coaRows.find((r) => coaKey(r) === key);
	return row ? coaLabel(row) : key;
}

/** Groups a page's current lines by (account, per-line vat_treatment),
 * summing amounts and collecting descriptions — one PEAK row per group. When
 * a group has a real account assigned, the exported "คำอธิบาย" is the COA
 * account's own label (matching the old app's behavior exactly), not the raw
 * line description; a blank-account group falls back to joining the raw
 * line descriptions instead. */
export function groupLinesForExport(lines: ReviewLine[], coaRows: CoaRow[]): LineGroup[] {
	const groups = new Map<string, { account_key: string; account_code: string; amount: number | null; descriptions: string[]; vat_treatment: string | null; amount_includes_vat: boolean | null }>();
	for (const line of lines) {
		const hasAccount = !!(line.account_code || line.sub_code);
		const accountKey = hasAccount ? coaKey({ account_code: line.account_code, sub_code: line.sub_code }) : "";
		const lineVat = line.vat_treatment ?? null;
		const groupKey = `${hasAccount ? accountKey : `__blank__:${line.line_index}`}@@${lineVat ?? "doc"}`;
		const current = groups.get(groupKey) ?? { account_key: accountKey, account_code: line.account_code, amount: null, descriptions: [] as string[], vat_treatment: lineVat, amount_includes_vat: null as boolean | null };
		if (line.amount != null) current.amount = (current.amount ?? 0) + line.amount;
		const description = String(line.description ?? "").trim();
		if (description && !current.descriptions.includes(description)) current.descriptions.push(description);
		if (typeof line.amount_includes_vat === "boolean" && current.amount_includes_vat === null) current.amount_includes_vat = line.amount_includes_vat;
		groups.set(groupKey, current);
	}
	return [...groups.values()].map((g) => ({
		account_code: g.account_code,
		description: g.account_key ? coaLabelByKey(g.account_key, coaRows) : g.descriptions.join(" / "),
		amount: g.amount,
		vat_treatment: g.vat_treatment,
		amount_includes_vat: g.amount_includes_vat,
	}));
}

function amountIncludesVatForPage(lines: ReviewLine[]): boolean | null {
	for (const line of lines) if (typeof line.amount_includes_vat === "boolean") return line.amount_includes_vat;
	return null;
}

/** price_type/vat_rate for one line group — vat_7 groups need to know
 * whether the line amount already includes VAT (falls back to the page's
 * first line when the group itself carries no signal); non_vat/unknown
 * groups are always price_type 3 ("ไม่มีภาษี"). */
export function vatSettingsForLineGroup(group: LineGroup, docVatTreatment: string | null, lines: ReviewLine[]): { price_type: string; vat_rate: string } {
	const treatment = group.vat_treatment || docVatTreatment;
	if (treatment === "vat_7") {
		const includesVat = typeof group.amount_includes_vat === "boolean" ? group.amount_includes_vat : amountIncludesVatForPage(lines);
		return { price_type: includesVat === false ? "1" : "2", vat_rate: "0.07" };
	}
	return { price_type: "3", vat_rate: "NO" };
}

// --- row builders --------------------------------------------------------

export type ExportRow = { pageTitle: string; cells: (string | number)[] };
export type BuildRowsResult = { rows: ExportRow[]; warnings: string[]; committedCount: number };

/** Builds PEAK_ImportExpense/PEAK_ImportReceipt rows for one document
 * bucket's already-merged page list — excludes any page with `skipped:
 * true` (ticket #42's export gate). Exact port of
 * review-template.ts's buildExpenseOrRevenueRows. */
export function buildExpenseOrRevenueRows(pages: ReviewPage[], isRevenue: boolean, coaRows: CoaRow[]): BuildRowsResult {
	const rows: ExportRow[] = [];
	const warnings: string[] = [];
	let committedCount = 0;
	let sequence = 1;
	const exportable = pages.filter((p) => !p.skipped);
	// Decision Policy rule 11: the accounting period's year is the modal year
	// across every document date in this export.
	const periodYear = modalYear(exportable.map((p) => normalizeDateForPeak(p.facts.date)));

	for (const page of exportable) {
		const title = pageTitle(page);
		const facts = page.facts;
		const docSequence = sequence++;
		const printedDate = normalizeDateForPeak(facts.date);
		const derived = derivePeakDate(printedDate, periodYear);
		const date = derived.date;
		const noteParts: string[] = [];
		if (derived.shifted) noteParts.push(`วันที่จริงบนใบ: ${String(facts.date ?? "").trim()}`);
		if (derived.suspicious) warnings.push(`${title}: ปีของวันที่เอกสาร (${String(facts.date ?? "").trim()}) อยู่หลังปีของงวด ${periodYear} — น่าจะอ่านวันที่ผิด ตรวจสอบก่อนส่งออก`);
		const note = noteParts.join(" · ");

		// The 13-digit registration column is the COUNTERPARTY's, which flips
		// with direction: an expense's counterparty is the seller; a revenue
		// document's counterparty is the buyer.
		const taxId = normalizeTaxId(isRevenue ? facts.buyer_tax_id : facts.seller_tax_id);
		const documentNo = String(facts.document_no ?? "").trim();
		const lineGroups = groupLinesForExport(page.lines, coaRows);
		committedCount++;
		if (!date) warnings.push(`${title}: วันที่เอกสารว่าง`);
		if (!taxId) warnings.push(`${title}: เลขทะเบียน${isRevenue ? "ผู้ซื้อ" : "ผู้ขาย"}ว่าง`);
		if (!documentNo) warnings.push(`${title}${isRevenue ? ": เลขที่เอกสารว่าง — PEAK จะ running เลขให้เอง" : ": เลขที่ใบกำกับฯว่าง"}`);
		if (!lineGroups.length) warnings.push(`${title}: ไม่มีรายการสำหรับส่งออก`);

		// WHT columns come from the document's printed withheld amount only —
		// the ratio must snap to a standard rate, otherwise stay empty and flag
		// a human. Never key a guessed rate.
		let whtRate = "";
		let pnd = "";
		const whtAmount = numberOrNull(facts.wht);
		if (whtAmount !== null && whtAmount > 0) {
			const subtotal = numberOrNull(facts.subtotal);
			const total = numberOrNull(facts.total);
			const vatAmount = numberOrNull(facts.vat);
			const base = subtotal !== null ? subtotal : total !== null && vatAmount !== null ? total - vatAmount : null;
			const rate = snapWhtRate(whtAmount, base);
			if (rate === null) {
				if (base === null || !(base > 0)) warnings.push(`${title}: มีหัก ณ ที่จ่าย ${whtAmount} แต่ไม่มียอดฐานก่อน VAT สำหรับคำนวณอัตรา — กรอกอัตราเอง`);
				else warnings.push(`${title}: อัตราหัก ณ ที่จ่าย ${(whtAmount / base).toFixed(4)} (${whtAmount} / ${base}) ไม่ตรงกับอัตรามาตรฐาน — กรอกอัตราเอง`);
			} else {
				whtRate = String(rate);
				// ภ.ง.ด. is an expense-sheet column only (the receipt sheet has none);
				// the client withholds from the seller, so the seller's name decides
				// the form.
				if (!isRevenue) {
					const pndType = inferPndType(facts.seller);
					if (pndType === null) warnings.push(`${title}: ระบุ ภ.ง.ด. จากชื่อคู่ค้า "${String(facts.seller ?? "").trim()}" ไม่ได้ — กรอกเอง`);
					else pnd = pndType;
				}
			}
		}

		for (const group of lineGroups) {
			if (!group.account_code) warnings.push(`${title}: บัญชีว่าง`);
			if (group.amount === null) warnings.push(`${title}: จำนวนเงินว่าง`);
			const vat = vatSettingsForLineGroup(group, String(facts.vat_treatment ?? ""), page.lines);
			const amount = group.amount ?? "";
			// Blank cells are deliberate: ลูกค้า/ผู้รับเงิน (PEAK contact code) and
			// สินค้า/บริการ (PEAK product code) are master-data ids we do not hold
			// (the template resolves the contact from the 13-digit id instead);
			// ส่วนลดต่อหน่วย has no source on our documents; กลุ่มจัดประเภท (PEAK tag)
			// is not modelled yet.
			const cells = isRevenue
				? [docSequence, date, documentNo, "", "", taxId, "00000", vat.price_type === "3" ? "2" : "1", vat.price_type, "", group.account_code, group.description, 1, amount, "", vat.vat_rate, whtRate, "CSH001", note, ""]
				: [docSequence, date, "", "", taxId, "00000", documentNo, date, date, vat.price_type, group.account_code, group.description, 1, amount, vat.vat_rate, whtRate, "CSH001", amount, pnd, note, ""];
			rows.push({ pageTitle: title, cells });
		}
	}
	return { rows, warnings, committedCount };
}

export type StatementJournalResult = BuildRowsResult & { totalCount: number; debitTotal: number; creditTotal: number };

/** Builds PEAK_ImportJournal rows for the WHOLE bank_statement bucket —
 * spans every statement group (bank account) in it, each contributing its
 * own GL contra-account. Excludes any row with `skipped: true`. Exact port
 * of review-template.ts's buildStatementJournalRows. */
export function buildStatementJournalRows(entries: StatementEntry[]): StatementJournalResult {
	const rows: ExportRow[] = [];
	const warnings: string[] = [];
	let committedCount = 0;
	let totalCount = 0;
	let sequence = 1;
	let debitTotal = 0;
	let creditTotal = 0;

	for (const entry of entries) {
		const bankAccount = splitCoaKey(entry.statement.bank_account_code ? `${entry.statement.bank_account_code}||${entry.statement.bank_sub_code ?? ""}` : "||");
		for (const row of entry.rows) {
			totalCount++;
			if (row.skipped) continue;
			const title = `${row.counterparty || row.description || `รายการที่ ${row.row_index + 1}`} (${formatStatementDate(row.date_iso)})`;
			const date = normalizeDateForPeak(row.date_iso);
			const mapped = { account_code: row.account_code, sub_code: row.sub_code };
			const amount = Math.round(Math.abs(row.amount) * 100) / 100;
			if (!date) warnings.push(`${title}: วันที่รายการว่าง`);
			if (!mapped.account_code) warnings.push(`${title}: ยังไม่ได้แมปบัญชี`);
			if (amount === 0) warnings.push(`${title}: จำนวนเงินว่างหรือเป็นศูนย์`);
			if (mapped.account_code === "999999") warnings.push(`${title}: ยังอยู่ในบัญชีพัก (999999) — ตรวจสอบก่อนนำเข้า PEAK`);
			committedCount++;
			const seq = sequence++;
			const description = String(row.counterparty || row.description || "").trim();
			// direction 'out': debit = mapped account, credit = bank account.
			// direction 'in': debit = bank account, credit = mapped account.
			const debitAccount = row.direction === "out" ? mapped : bankAccount;
			const creditAccount = row.direction === "out" ? bankAccount : mapped;
			rows.push({ pageTitle: title, cells: [seq, STATEMENT_JOURNAL_BOOK_NAME, date, "", "", description, debitAccount.account_code, debitAccount.sub_code, "", amount, "", ""] });
			rows.push({ pageTitle: title, cells: [seq, "", "", "", "", "", creditAccount.account_code, creditAccount.sub_code, "", "", amount, ""] });
			debitTotal += amount;
			creditTotal += amount;
		}
	}
	debitTotal = Math.round(debitTotal * 100) / 100;
	creditTotal = Math.round(creditTotal * 100) / 100;
	if (Math.abs(debitTotal - creditTotal) >= 0.01) warnings.push(`ยอดเดบิตรวม (${debitTotal.toFixed(2)}) ไม่เท่ากับยอดเครดิตรวม (${creditTotal.toFixed(2)})`);
	return { rows, warnings, committedCount, totalCount, debitTotal, creditTotal };
}

export const STATEMENT_JOURNAL_TEMPLATE = { headers: STATEMENT_JOURNAL_HEADERS, sheetName: STATEMENT_JOURNAL_SHEET_NAME };

// ---------------------------------------------------------------------------
// Workbook assembly — real I/O-adjacent (the `xlsx` package), not unit tested
// against fixture data the same way the pure row-builders above are;
// peak-export.test.ts covers this by round-tripping through XLSX.read.

/** Builds the actual .xlsx bytes for one export: one data sheet (headers +
 * rows). Returns a Buffer suitable for an HTTP response body. */
export function buildXlsxWorkbook(headers: string[], sheetName: string, rows: ExportRow[]): Buffer {
	const sheetRows = [headers, ...rows.map((r) => r.cells)];
	const sheet = xlsxUtils.aoa_to_sheet(sheetRows);
	const workbook = xlsxUtils.book_new();
	xlsxUtils.book_append_sheet(workbook, sheet, sheetName);
	return xlsxWrite(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
