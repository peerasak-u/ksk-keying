// Job-level (layer-3) grader: compares a FINISHED ksk-keying run's proposed
// bookings against a client-month's PEAK-export answer key, producing a
// per-document report — recall / value-match (gross + date) / account_code /
// invented — plus summary aggregates. This is the "measurable" ruler for the
// whole project: it grades the pipeline's actual output, not one agent in
// isolation (contrast evals/stage-grade.ts, which grades one stage against
// itself/a partial expected set before a full run exists).
//
//   bun run grade-vs-answer-key.ts -- --run <client-dir> --key <answer-key-dir> [--out <path>]
//
//   --run   one client folder that finished Stage 5 (categorize), i.e. has
//           ข้อมูลระบบ/_doc_groups/manifest.yaml + built review-data.json per
//           group. Comma-separate several run dirs (repeated attempts of the
//           same client-month) to get true min/max-style worst-case framing;
//           a single dir still works (min == max == that run's own numbers).
//   --key   a client-month's answer-key folder — either the "File PEAK
//           import" folder itself, or its parent (this script looks inside
//           for it either way).
//   --out   optional path to write the machine JSON report (default: print
//           the report JSON to stdout after the scoreboard line).
//
// Ground truth is the PEAK export from a run that already went through the
// pipeline's own Ledger Gates and human review, produced OUTSIDE this
// pipeline (see CLAUDE.md "samples/answer-keys/" + "never peek at
// answer-keys/ mid-run"). This script is a post-run comparison tool, not a
// mid-run one — it is the one place allowed to read answer-keys/ freely.
//
// Hard rule baked into the framing: a disagreement between the run and the
// key is a FINDING this grader reports, never a reason to edit either side.
// The key is never "corrected" from model output/majority vote (see
// memory/dont-override-verified-answer-key.md) — low recall or wrong
// account_code get flagged for human review, full stop.
//
// Scope (first cut, see report to the board for the reasoning): grades
// document-shaped bookings only — PEAK_ImportExpense/PEAK_ImportReceipt rows
// on the key side, matched against expense/income doc-group review-data.json
// on the run side. bank_statement groups and PEAK_ImportJournal (ใบสำคัญจ่าย,
// Statement/) exports are out of scope here — they are debit/credit journal
// pairs with no single per-document account_code, a different grading shape
// entirely (tracked as an open question for a future grader, not silently
// dropped).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import XLSX from "xlsx";
import {
	type Identifiable,
	type KeyedDoc,
	amountEq,
	loadJson,
	loadYaml,
	matchDocs,
	normText,
	parseArgs,
	writeJson,
} from "./lib";

// ---------------------------------------------------------------------------
// Answer-key (PEAK export) parsing — generic: locates columns by header TEXT,
// never by fixed position, because the real PEAK_ImportExpense and
// PEAK_ImportReceipt templates do not share one column layout (verified
// against samples/answer-keys/.../File PEAK import/*.xlsx — the receipt
// template puts the document number in its own column and adds a discount
// column the expense template doesn't have).

export interface PeakColumnMap {
	seq: number; // "ลำดับที่" — PEAK's own row-grouping key: same seq = same document
	date: number; // "วันที่เอกสาร" — document date
	docNo: number; // "เลขที่เอกสาร" (receipt) or "เลขที่ใบกำกับ…" (expense)
	account: number; // "บัญชี" (exact) — COA account code
	qty: number | null; // "จำนวน" (exact) — defaults to 1 when absent
	unitPrice: number; // "ราคาต่อหน่วย"
	discount: number | null; // "ส่วนลดต่อหน่วย" (receipt only)
	vatRate: number; // "อัตราภาษี" — "NO", or a rate (0.07 / "7%")
	priceType: number; // "ประเภทราคา" — 1 excl-VAT, 2 incl-VAT, 3 no-VAT
	wht: number | null; // "…หัก ณ ที่จ่าย…"
}

function findExact(header: unknown[], text: string): number {
	return header.findIndex((h) => String(h ?? "").trim() === text);
}

function findIncludes(header: unknown[], patterns: string[]): number {
	for (const pattern of patterns) {
		const i = header.findIndex((h) => String(h ?? "").includes(pattern));
		if (i !== -1) return i;
	}
	return -1;
}

// Returns null when the sheet isn't a document-shaped PEAK export this grader
// understands (e.g. the "Description" tab, or a journal/statement sheet whose
// account column is "เลขที่บัญชี*"/"บัญชีย่อย" rather than exact "บัญชี").
export function detectPeakColumns(header: unknown[]): PeakColumnMap | null {
	const seq = findIncludes(header, ["ลำดับที่"]);
	const account = findExact(header, "บัญชี");
	if (seq === -1 || account === -1) return null;
	const docNo = findIncludes(header, ["เลขที่เอกสาร", "เลขที่ใบกำกับ"]);
	const date = findIncludes(header, ["วันที่เอกสาร"]);
	const unitPrice = findIncludes(header, ["ราคาต่อหน่วย"]);
	const vatRate = findIncludes(header, ["อัตราภาษี"]);
	const priceType = findIncludes(header, ["ประเภทราคา"]);
	if (docNo === -1 || date === -1 || unitPrice === -1 || vatRate === -1 || priceType === -1)
		return null;
	const qty = findExact(header, "จำนวน");
	const discount = findIncludes(header, ["ส่วนลดต่อหน่วย"]);
	const wht = findIncludes(header, ["หัก ณ ที่จ่าย"]);
	return {
		seq,
		date,
		docNo,
		account,
		qty: qty === -1 ? null : qty,
		unitPrice,
		discount: discount === -1 ? null : discount,
		vatRate,
		priceType,
		wht: wht === -1 ? null : wht,
	};
}

// Excel's day-0 epoch (1899-12-30 — the traditional off-by-two vs the real
// calendar, harmless for any modern accounting date). loadKeyDocs reads with
// { cellDates: false }, so genuinely date-formatted cells arrive as bare
// integer serials counted from this epoch and are converted here (rather than
// as SheetJS Date objects, which shift to local-midnight-minus-epsilon and
// drop a day under getUTC*).
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function isoFromUtcDate(d: Date): string {
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Accepts whatever shape a date cell arrives in: a real Date (cellDates:
// true), a raw Excel serial number, an 8-digit YYYYMMDD number/string (the
// template's own documented format), or an already-ISO string.
export function normalizeDateCell(value: unknown): string {
	// Every branch funnels its computed date through normalizeDocDate for one
	// consistent last step: a Buddhist-era year (2400-2600) is converted to
	// Gregorian, while a plausible Gregorian year is left untouched. A serial or
	// Date-cell that decodes to year 2400-2600 is unambiguously a BE entry (no
	// real Gregorian accounting date is 400+ years out), so that conversion is
	// safe. It deliberately does NOT touch a year like 1969 (an Excel 2-digit-
	// year pivot artifact in the source): 1969 is a legitimate Gregorian year
	// with no safe correction rule, so it stays a FINDING for human review
	// rather than being silently masked.
	if (value instanceof Date) {
		// A date-formatted cell can arrive as a Date shifted to local-midnight-
		// minus-epsilon (e.g. "2026-04-02T16:59:56Z" for the intended
		// 2026-04-03) depending on how the workbook was read; round to the
		// nearest UTC day before formatting so getUTC* doesn't drop a day.
		// (With cellDates:false — what loadKeyDocs now uses — this branch rarely
		// fires; kept correct defensively.)
		return normalizeDocDate(isoFromUtcDate(new Date(value.getTime() + 12 * 3600 * 1000)));
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value >= 19000101 && value <= 21001231) {
			// YYYYMMDD literal
			const s = String(Math.trunc(value));
			return normalizeDocDate(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
		}
		// Round the serial to guard against a fractional serial slipping in.
		return normalizeDocDate(
			isoFromUtcDate(new Date(EXCEL_EPOCH_UTC + Math.round(value) * 86400000)),
		);
	}
	// String cell: normalizeDocDate also parses DD/MM/YYYY and plain ISO/YYYYMMDD.
	return normalizeDocDate(String(value ?? "").trim());
}

function toNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value == null || String(value).trim() === "") return fallback;
	const parsed = Number(String(value).trim());
	return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumberOrNull(value: unknown): number | null {
	if (value == null || value === "") return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	const parsed = Number(String(value).trim());
	return Number.isFinite(parsed) ? parsed : null;
}

// "อัตราภาษี" ("VAT rate"): "NO" (no VAT), a fraction (0.07), or a percent
// string ("7%"). Returns null for "NO"/unrecoverable — callers treat that as
// no-VAT via priceType instead.
function parseVatRate(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	const s = String(value ?? "").trim();
	if (/^no$/i.test(s)) return 0;
	if (s.endsWith("%")) {
		const pct = Number(s.slice(0, -1));
		return Number.isFinite(pct) ? pct / 100 : 0;
	}
	const n = Number(s);
	return Number.isFinite(n) ? n : 0;
}

// "ส่วนลดต่อหน่วย" ("discount per unit"): an absolute amount, or a percent of
// unit price ("25%").
function parseDiscountPerUnit(value: unknown, unitPrice: number): number {
	if (value == null || value === "") return 0;
	const s = String(value).trim();
	if (s.endsWith("%")) {
		const pct = Number(s.slice(0, -1));
		return Number.isFinite(pct) ? unitPrice * (pct / 100) : 0;
	}
	const n = Number(s);
	return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export interface PeakRow {
	source: string; // originating file [+ sheet], for diagnostics
	seq: number; // "ลำดับที่" — PEAK's own document-grouping key
	docNo: string; // raw, trimmed
	docDate: string; // ISO yyyy-mm-dd ("" when unrecoverable)
	accountCode: string;
	gross: number; // this row's own VAT-inclusive contribution
	vat: number; // this row's own VAT contribution
}

// Parses every non-blank data row of one already-column-mapped PEAK export
// sheet into per-row bookings. A "row" here is one (document, account-code)
// line, matching how PEAK itself represents a multi-account document — see
// the template's own rule: "ถ้าเลขที่ลำดับเป็นเลขที่เดียวกัน จะถือเป็นเอกสารเดียวกัน"
// ("rows sharing one ลำดับที่ are the same document"). keyDocsFromRows groups
// these back into one record per document.
export function parsePeakRows(cols: PeakColumnMap, rows: unknown[][], source: string): PeakRow[] {
	const out: PeakRow[] = [];
	for (const row of rows) {
		const seq = toNumberOrNull(row[cols.seq]);
		if (seq == null) continue; // blank/trailing row — end of data
		const accountCode = String(row[cols.account] ?? "").trim();
		const docNo = String(row[cols.docNo] ?? "").trim();
		const unitPrice = toNumber(row[cols.unitPrice], 0);
		const qty = cols.qty != null ? toNumber(row[cols.qty], 1) : 1;
		const discountPerUnit =
			cols.discount != null ? parseDiscountPerUnit(row[cols.discount], unitPrice) : 0;
		const base = qty * (unitPrice - discountPerUnit);
		const priceType = toNumber(row[cols.priceType], 1);
		const vatRate = parseVatRate(row[cols.vatRate]);
		let gross: number;
		let vat: number;
		if (priceType === 3) {
			gross = base;
			vat = 0;
		} else if (priceType === 2) {
			gross = base;
			vat = vatRate > 0 ? base - base / (1 + vatRate) : 0;
		} else {
			vat = base * vatRate;
			gross = base + vat;
		}
		out.push({
			source,
			seq,
			docNo,
			docDate: normalizeDateCell(row[cols.date]),
			accountCode,
			gross: round2(gross),
			vat: round2(vat),
		});
	}
	return out;
}

export interface KeyDoc extends Identifiable {
	docNoRaw: string;
	accountCodes: string[]; // unique, sorted — every account code this document booked to
	primaryAccountCode: string; // dominant (largest-gross) line's code
	vat: number | null;
	sources: string[]; // originating file(s), for diagnostics
}

// Groups PEAK rows back into one record per document, using PEAK's own
// document-identity rule (same "ลำดับที่" + source file = same document — see
// parsePeakRows). A document whose rows split across several account codes
// (a mixed-account invoice) keeps every code in accountCodes for visibility,
// but grades account_code against a single primaryAccountCode (the largest
// line, ties broken by first-seen) — see the report's open-question note on
// multi-account documents.
export function keyDocsFromRows(rows: PeakRow[]): KeyDoc[] {
	const groups = new Map<string, PeakRow[]>();
	for (const row of rows) {
		const groupKey = `${row.source}#${row.seq}`;
		const list = groups.get(groupKey) ?? [];
		list.push(row);
		groups.set(groupKey, list);
	}
	const docs: KeyDoc[] = [];
	for (const list of groups.values()) {
		const gross = round2(list.reduce((sum, r) => sum + r.gross, 0));
		const vat = round2(list.reduce((sum, r) => sum + r.vat, 0));
		const accountCodes = [...new Set(list.map((r) => r.accountCode).filter(Boolean))].sort();
		const primary = [...list].sort((a, b) => Math.abs(b.gross) - Math.abs(a.gross))[0];
		const docNoRaw = list.find((r) => r.docNo)?.docNo ?? "";
		docs.push({
			docNo: normText(docNoRaw),
			docNoRaw,
			docDate: list.find((r) => r.docDate)?.docDate ?? "",
			gross,
			vat,
			accountCodes,
			primaryAccountCode: primary?.accountCode ?? "",
			sources: [...new Set(list.map((r) => r.source))],
		});
	}
	return docs;
}

// ---------------------------------------------------------------------------
// Run output (review-data.json) parsing — ksk_review_group_data.v1 only
// (bank_statement's ksk_review_statement_data.v1 has no single per-document
// account_code and is out of scope here, see the header note).

export interface RunDoc extends KeyedDoc {
	docNoRaw: string;
	accountCodes: string[];
	primaryAccountCode: string;
	vat: number | null;
	groupId: string;
	groupPath: string;
}

function numOrNull(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// The run side's facts.date arrives as whatever the categorize wave wrote —
// often a Thai/Buddhist-era "DD/MM/YYYY" (e.g. "01/04/2569") rather than the
// ISO the key side already uses (via normalizeDateCell above), so a raw
// string compare in gradeRun fails on a date-format artifact even when the
// documents genuinely match. Brings the run side to the same ISO shape.
export function normalizeDocDate(raw: string): string {
	const s = String(raw ?? "").trim();
	if (!s) return "";
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
		// ISO shape — but the year may be Buddhist-era (e.g. "2569-03-18");
		// convert BE→Gregorian, leave a genuine Gregorian year untouched.
		const y = +s.slice(0, 4);
		if (y >= 2400 && y <= 2600) return `${y - 543}-${s.slice(5, 7)}-${s.slice(8, 10)}`;
		return s.slice(0, 10);
	}
	if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; // YYYYMMDD
	// DD/MM/YYYY or D/M/YYYY with / - or . separators (also handle YYYY/MM/DD)
	const m = s.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/);
	if (m) {
		const [, a, b, c] = m;
		let y: number;
		let mo: number;
		let d: number;
		if (a.length === 4) {
			y = +a;
			mo = +b;
			d = +c; // YYYY/MM/DD
		} else {
			d = +a;
			mo = +b;
			y = +c; // DD/MM/YYYY
		}
		if (y >= 2400 && y <= 2600) y -= 543; // Buddhist BE -> Gregorian
		if (y < 100) y += 2000; // 2-digit year -> 20xx
		if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900) return `${y}-${pad2(mo)}-${pad2(d)}`;
	}
	return "";
}

// One `pages[]` entry with a non-empty `lines[]` = one bookable document (see
// review-data-schema.md: evidence-only pages of the same group carry an empty
// `lines[]` and must not be counted as separate documents). A document whose
// categorize wave split its lines across several account codes keeps every
// code in accountCodes, graded against a single primaryAccountCode (largest
// |amount| line) — same simplification as the key side, so both sides are
// compared on equal footing.
export function runDocsFromReviewData(
	groupId: string,
	groupPath: string,
	data: { pages?: unknown[] },
): RunDoc[] {
	const pages = Array.isArray(data?.pages) ? data.pages : [];
	const docs: RunDoc[] = [];
	pages.forEach((page: any, i: number) => {
		const lines = Array.isArray(page?.lines) ? page.lines : [];
		if (!lines.length) return; // evidence-only page — not its own booking
		const facts = page?.facts ?? {};
		const docNoRaw = String(facts.document_no ?? "").trim();
		const accountCodes = [
			...new Set(lines.map((l: any) => String(l?.account_code ?? "").trim()).filter(Boolean)),
		].sort();
		const primary = [...lines].sort(
			(a: any, b: any) => Math.abs(numOrNull(b.amount) ?? 0) - Math.abs(numOrNull(a.amount) ?? 0),
		)[0];
		docs.push({
			key: `${groupPath}:${page.ref ?? i}`,
			docNo: normText(docNoRaw),
			docNoRaw,
			docDate: normalizeDocDate(String(facts.date ?? "").trim()),
			gross: numOrNull(facts.total),
			vat: numOrNull(facts.vat),
			accountCodes,
			primaryAccountCode: String(primary?.account_code ?? "").trim(),
			groupId,
			groupPath,
		});
	});
	return docs;
}

// ---------------------------------------------------------------------------
// Grading — the four metrics the board task asked for, per document:
//   recall        matched key docs / total key docs (identity via matchDocs's
//                 3-tier matcher: exact doc_no, then เลขที่ tail+gross, then
//                 gross+date — never a reason to "fix" the key, see header).
//   value_match   of matched, gross (VAT-incl) AND date agree.
//   account_match of matched, the run's primaryAccountCode == the key's.
//   invented      run docs matching no key doc.
// A disagreement is a FINDING (reported per-doc below), never something this
// grader edits on either side.

export interface DocGrade {
	key_doc_no: string;
	run_key: string | null;
	matched: boolean;
	value_match: boolean;
	account_match: boolean;
	gross_expected: number | null;
	gross_actual: number | null;
	account_expected: string;
	account_actual: string | null;
}

export interface RunVsKeyGrade {
	schema: "ksk_run_vs_answer_key_grade.v1";
	key_docs: number;
	matched: number;
	recall: string;
	value_match: string; // "n/matched"
	account_match: string; // "n/matched"
	invented: number;
	missed: string[]; // key doc_no not found in the run
	invented_keys: string[]; // run keys matching no key doc
	docs: DocGrade[];
}

export function gradeRun(runDocs: RunDoc[], keyDocs: KeyDoc[]): RunVsKeyGrade {
	const { matched, missed, invented } = matchDocs(runDocs, keyDocs);
	let valueMatchCount = 0;
	let accountMatchCount = 0;
	const docs: DocGrade[] = [];
	for (const { expected: key, actual: run } of matched) {
		const valueMatch = amountEq(run.gross, key.gross) && run.docDate === key.docDate;
		const accountMatch = !!run.primaryAccountCode && run.primaryAccountCode === key.primaryAccountCode;
		if (valueMatch) valueMatchCount++;
		if (accountMatch) accountMatchCount++;
		docs.push({
			key_doc_no: key.docNoRaw || "(blank)",
			run_key: run.key,
			matched: true,
			value_match: valueMatch,
			account_match: accountMatch,
			gross_expected: key.gross,
			gross_actual: run.gross,
			account_expected: key.primaryAccountCode,
			account_actual: run.primaryAccountCode || null,
		});
	}
	for (const key of missed) {
		docs.push({
			key_doc_no: key.docNoRaw || "(blank)",
			run_key: null,
			matched: false,
			value_match: false,
			account_match: false,
			gross_expected: key.gross,
			gross_actual: null,
			account_expected: key.primaryAccountCode,
			account_actual: null,
		});
	}
	return {
		schema: "ksk_run_vs_answer_key_grade.v1",
		key_docs: keyDocs.length,
		matched: matched.length,
		recall: `${matched.length}/${keyDocs.length}`,
		value_match: `${valueMatchCount}/${matched.length}`,
		account_match: `${accountMatchCount}/${matched.length}`,
		invented: invented.length,
		missed: missed.map((k) => k.docNoRaw || "(blank)"),
		invented_keys: invented.map((r) => r.key),
		docs,
	};
}

// ---------------------------------------------------------------------------
// IO — answer-key side (walks every *.xlsx under the key dir; parses whatever
// sheet detectPeakColumns recognizes as document-shaped, so PEAK_ImportExpense
// and PEAK_ImportReceipt are both picked up regardless of subfolder name, and
// journal/statement-shaped sheets are skipped automatically rather than by
// hardcoded folder names).

function resolveKeyRoot(keyDir: string): string {
	const nested = join(keyDir, "File PEAK import");
	if (existsSync(nested) && statSync(nested).isDirectory()) return nested;
	return keyDir;
}

function findXlsxFiles(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (name.startsWith("~$")) continue; // Excel lock file
			const full = join(dir, name);
			if (statSync(full).isDirectory()) stack.push(full);
			else if (name.toLowerCase().endsWith(".xlsx")) out.push(full);
		}
	}
	return out.sort();
}

export function loadKeyDocs(keyDir: string): KeyDoc[] {
	const root = resolveKeyRoot(keyDir);
	const rows: PeakRow[] = [];
	for (const file of findXlsxFiles(root)) {
		// cellDates:false so date-formatted cells arrive as raw integer serials
		// and hit normalizeDateCell's serial branch — cellDates:true returns Date
		// objects shifted to local-midnight-minus-epsilon, which getUTC* then
		// rounds down a day (the value_match date artifact). Amount/text columns
		// are unaffected by this flag.
		const wb = XLSX.readFile(file, { cellDates: false });
		for (const sheetName of wb.SheetNames) {
			if (sheetName === "Description") continue;
			const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
				header: 1,
				defval: null,
				raw: true,
			}) as unknown[][];
			if (!grid.length) continue;
			const cols = detectPeakColumns(grid[0]);
			if (!cols) continue; // not a document-shaped sheet — out of scope
			rows.push(...parsePeakRows(cols, grid.slice(1), `${relative(root, file)}#${sheetName}`));
		}
	}
	return keyDocsFromRows(rows);
}

// ---------------------------------------------------------------------------
// IO — run-output side (ข้อมูลระบบ/_doc_groups/manifest.yaml + each group's
// review-data.json). bank_statement groups are skipped (out of scope, see
// header); a group whose review-data.json hasn't been built yet is skipped
// too — that's Stage 5's problem to report, not this grader's.

export function loadRunDocs(clientDir: string): RunDoc[] {
	const groupsRoot = join(clientDir, "ข้อมูลระบบ", "_doc_groups");
	const manifestPath = join(groupsRoot, "manifest.yaml");
	if (!existsSync(manifestPath))
		throw new Error(`missing doc-group manifest: ${manifestPath} — run must reach Stage 4/5 first`);
	const manifest = loadYaml<{ groups?: Array<{ id: string; path: string; category: string }> }>(
		manifestPath,
	);
	const docs: RunDoc[] = [];
	for (const group of manifest.groups ?? []) {
		if (group.category === "bank_statement") continue;
		const reviewPath = join(groupsRoot, group.path, "review-data.json");
		if (!existsSync(reviewPath)) continue;
		const data = loadJson<{ pages?: unknown[] }>(reviewPath);
		docs.push(...runDocsFromReviewData(group.id, group.path, data));
	}
	return docs;
}

// ---------------------------------------------------------------------------
// CLI

function usage(): never {
	console.error(`Usage: bun run grade-vs-answer-key.ts -- --run <client-dir>[,<client-dir>...] --key <answer-key-dir> [--out <path>]

  --run   one finished run's client folder (comma-separate several attempts
          of the same client-month for a true worst-case min/max across runs)
  --key   the client-month's answer-key folder ("File PEAK import" or its
          parent) — see samples/answer-keys/<client>/<month>/
  --out   write the machine JSON report here (default: print to stdout)
`);
	process.exit(2);
}

function scoreboardLine(grade: RunVsKeyGrade): string {
	return (
		`recall ${grade.recall} · value-match ${grade.value_match} · ` +
		`account-match ${grade.account_match} · invented ${grade.invented}`
	);
}

function main() {
	const { flags } = parseArgs(process.argv.slice(2));
	const runArg = String(flags.run ?? "").trim();
	const keyArg = String(flags.key ?? "").trim();
	if (!runArg || !keyArg) usage();
	const runDirs = runArg
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	const keyDocs = loadKeyDocs(keyArg);
	const grades = runDirs.map((dir) => gradeRun(loadRunDocs(dir), keyDocs));

	// worst-case framing across attempts (single run: these equal that run's
	// own numbers) — same vocabulary as stage-grade.ts's cross-session view,
	// so a future multi-run comparison slots in without a schema change.
	const minRecall = Math.min(...grades.map((g) => g.matched));
	const maxInvented = Math.max(...grades.map((g) => g.invented));

	const report = {
		schema: "ksk_run_vs_answer_key_report.v1",
		key_dir: keyArg,
		run_dirs: runDirs,
		key_docs: keyDocs.length,
		min_recall: minRecall,
		max_invented: maxInvented,
		runs: grades,
	};

	console.log(`\ngrade-vs-answer-key · ${keyDocs.length} key docs · ${runDirs.length} run(s)`);
	grades.forEach((g, i) => console.log(`  ${runDirs[i]}: ${scoreboardLine(g)}`));
	if (grades.length > 1)
		console.log(`\n  worst-case: min-recall ${minRecall}/${keyDocs.length} · max-invented ${maxInvented}`);
	console.log(
		"\nDisagreements above are FINDINGS for human review — never a reason to edit the answer key.",
	);

	if (typeof flags.out === "string") {
		writeJson(flags.out, report);
		console.log(`\nwrote ${flags.out}`);
	} else {
		console.log(`\n${JSON.stringify(report, null, 2)}`);
	}
}

if (import.meta.main) main();
