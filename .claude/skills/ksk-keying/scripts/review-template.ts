import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Shared review UI template + data contract for review.ts (per _gate_groups group)
// and review-groups.ts (per _doc_groups bucket). The rendered page is a single-file
// Vue 3 app; DATA is embedded inline because file:// pages cannot fetch() local JSON.

export type CoaRow = {
	account_code: string;
	sub_code: string;
	name_th: string;
	name_en: string;
};

export type ReviewLine = {
	line_index: number;
	description: string | null;
	qty: number | null;
	unit: string | null;
	unit_price: number | null;
	amount: number | null;
	amount_includes_vat: boolean | null;
	// Per-line VAT treatment; used by expense/mixed buckets. Falls back to the
	// document-level facts.vat_treatment when absent.
	vat_treatment?: "vat_7" | "non_vat" | null;
	account_code: string;
	sub_code: string;
	account_name_th: string;
	confidence: "low" | "medium" | "high";
	reason: string;
	needs_review: boolean;
};

// Inlined rows of one workbook sheet, embedded at generation time because a
// file:// page cannot fetch() the .xlsx it sits next to. Cell values are the
// formatted display strings (sheet_to_json raw:false), capped by
// SHEET_MAX_ROWS/COLS in review-groups.ts.
export type SheetPreview = {
	sheet: string;
	rows: (string | number | null)[][];
	total_rows: number;
	truncated: boolean;
};

export type ReviewPage = {
	ref: string;
	short_ref: string;
	// Rasterized fallback image (legacy _pages/*.png), relative to the bucket.
	image_src: string | null;
	// Real source document to preview (PDF/image), relative to the bucket, with
	// the page to open to. Preferred over image_src when present.
	source_src?: string | null;
	source_page?: number | null;
	source_kind?: "pdf" | "image" | "other" | null;
	// Exact workbook sheet this page came from (review-data-schema.md) and the
	// embedded table the generator builds from it for spreadsheet sources.
	source_sheet?: string | null;
	sheet_preview?: SheetPreview | null;
	extract_path: string;
	categorize_path: string;
	// Present when the page belongs to a _doc_groups group inside a bucket page.
	group_id?: string;
	group_label?: string;
	// Group-level review flags surfaced to the reviewer (from review-data.json's
	// review_flags) — explains WHY a needs_attention group is flagged.
	group_review_flags?: string[];
	facts: Record<string, string | number | null>;
	lines: ReviewLine[];
	initial_status: "reviewed" | "needs_attention";
};

export type ReviewData = {
	schema: "ksk_review_group_html_data.v1";
	// Discriminant for the embedded-payload union (see StatementHtmlData below).
	// Optional (rather than a required literal) so review.ts's _gate_groups path
	// (which never sets it) keeps compiling unchanged; treat an absent/undefined
	// kind as "documents".
	kind?: "documents";
	client_dir: string;
	client_key: string;
	// _gate_groups name (expense_vat, ...) or _doc_groups bucket key
	// (expense/vat, expense/non_vat, expense/mixed, income/vat, income/non_vat,
	// bank_statement).
	group: string;
	group_dir: string;
	// Thai bucket label ("ค่าใช้จ่าย มีภาษี") used for the exported PEAK filename.
	review_label?: string;
	generated_at: string;
	content_fingerprint: string;
	coa_csv: string;
	coa_rows: CoaRow[];
	pages: ReviewPage[];
};

// ---------------------------------------------------------------------------
// Bank statement schemas (PRD docs/improve-bank-stm-review/PRD.md §D1/§D3/§D4).
// A statement is a chronological transaction table, not an invoice-shaped
// document, so it gets its own group-level file schema, its own embedded HTML
// payload variant (branch of the DATA.kind union), and its own localStorage
// draft schema. The existing ksk_review_group_data.v1 / ReviewData /
// ksk_review_vue_draft.v1 shapes for document buckets are unchanged.
// ---------------------------------------------------------------------------

// Group-level review-data.json shape for `_doc_groups/bank_statement/<group-id>/`
// (schema ksk_review_statement_data.v1). Field mapping: PRD §D1.
export type StatementInfo = {
	bank: string | null;
	account_no: string | null;
	account_holder: string | null;
	// e.g. "01/04/2026 - 31/05/2026"; 1:1 copy of interpretation.json's
	// statement_period.
	period: string | null;
	opening_balance: number | null;
	closing_balance: number | null;
	// GL contra account for this bank account (COA account_code); proposed by
	// poirot during categorize, reviewer-editable in the UI. null blocks export.
	bank_account_code: string | null;
	bank_sub_code: string | null;
};

export type StatementSource = {
	// Source document to preview (PDF/image), client-root-relative in
	// review-data.json; rewritten bucket-relative when embedded (see
	// resolveSource/rewriteImageSrc in review-groups.ts).
	source_src: string | null;
	source_page: number | null;
	// Rasterized fallback image, same convention as ReviewPage.image_src.
	image_src: string | null;
	// Same convention as ReviewPage.source_sheet/sheet_preview.
	source_sheet?: string | null;
	sheet_preview?: SheetPreview | null;
};

export type StatementRow = {
	row_index: number;
	date_iso: string;
	time: string | null;
	description: string | null;
	counterparty: string | null;
	direction: "in" | "out";
	// Always positive; direction carries the sign.
	amount: number;
	balance: number | null;
	account_code: string;
	sub_code: string;
	account_name_th: string;
	confidence: "low" | "medium" | "high";
	reason: string;
	needs_review: boolean;
};

export type StatementGroupData = {
	schema: "ksk_review_statement_data.v1";
	group_id: string;
	label?: string;
	statement: StatementInfo;
	source: StatementSource;
	rows: StatementRow[];
};

// One group folder's worth of statement data as embedded in the bucket's
// review.html payload (statements[] entry). Same fields as StatementGroupData
// but source is bucket-relative (rewritten the same way ReviewPage's
// image_src/source_src are for document buckets).
export type StatementEmbedded = {
	group_id: string;
	label?: string;
	statement: StatementInfo;
	source: StatementSource;
	rows: StatementRow[];
};

// Embedded HTML payload for the bank_statement bucket (schema
// ksk_review_statement_html_data.v1), the "kind": "statement" branch of the
// DATA union alongside ReviewData's "kind": "documents" (default) branch.
// One entry per group folder (bank account) in `statements[]`; multiple
// entries when a bucket has more than one statement group.
export type StatementHtmlData = {
	schema: "ksk_review_statement_html_data.v1";
	kind: "statement";
	client_dir: string;
	client_key: string;
	// _doc_groups bucket key, always "bank_statement" today.
	group: string;
	group_dir: string;
	// Thai bucket label ("รายการเดินบัญชี") used for the exported PEAK filename.
	review_label?: string;
	generated_at: string;
	content_fingerprint: string;
	coa_csv: string;
	coa_rows: CoaRow[];
	statements: StatementEmbedded[];
};

// Discriminated union of the two embedded-payload shapes a rendered
// review.html can carry, keyed on DATA.kind ("documents" | "statement").
export type ReviewHtmlData = ReviewData | StatementHtmlData;

// Per-row localStorage draft state for one statement (schema
// ksk_review_statement_draft.v1). Mirrors the existing document draft's
// {schema, saved_at, states[]} envelope (see DRAFT_SCHEMA /
// ksk_review_vue_draft.v1 below), one StatementDraftState per statement group
// in `statements[]`.
export type StatementDraftRow = {
	account_key: string;
	description: string | null;
	amount: number | null;
	reviewed: boolean;
	skipped: boolean;
	note: string | null;
};

export type StatementDraftState = {
	group_id: string;
	// COA key for the bank GL account, seeded from
	// statement.bank_account_code/bank_sub_code, editable in the UI.
	bank_account_key: string;
	rows: StatementDraftRow[];
};

export type StatementDraft = {
	schema: "ksk_review_statement_draft.v1";
	saved_at: string;
	states: StatementDraftState[];
};

function parseCsvLine(line: string) {
	const out: string[] = [];
	let value = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (quoted && line[i + 1] === '"') {
				value += '"';
				i++;
			} else quoted = !quoted;
		} else if (ch === "," && !quoted) {
			out.push(value);
			value = "";
		} else value += ch;
	}
	out.push(value);
	return out;
}

export function loadCoaRows(path: string): CoaRow[] {
	const text = readFileSync(path, "utf8").trim();
	if (!text) return [];
	const rows = text.split(/\r?\n/);
	const header = parseCsvLine(rows[0] || "");
	const idx = new Map(header.map((name, i) => [name, i]));
	for (const name of ["account_code", "sub_code", "name_th", "name_en"])
		if (!idx.has(name)) throw new Error(`missing COA column: ${name}`);
	return rows.slice(1).map((line) => {
		const values = parseCsvLine(line);
		return {
			account_code: values[idx.get("account_code")!] || "",
			sub_code: values[idx.get("sub_code")!] || "",
			name_th: values[idx.get("name_th")!] || "",
			name_en: values[idx.get("name_en")!] || "",
		};
	});
}

export function hashString(value: string) {
	let hash = 5381;
	for (let i = 0; i < value.length; i++)
		hash = (hash * 33) ^ value.charCodeAt(i);
	return (hash >>> 0).toString(16).padStart(8, "0");
}

// Pure helpers for the PEAK expense/revenue export, shared with the page script:
// each is self-contained (no closure over module scope) and injected into the
// embedded <script> via Function.prototype.toString(), so the browser and the
// unit tests exercise one implementation. Keep them dependency-free.

// Snap a document's printed WHT amount to a standard Thai withholding rate.
// PEAK only accepts standard rates; a ratio that doesn't snap within tolerance
// must go to a human, never be rounded to the nearest rate.
export function snapWhtRate(wht: number | null, base: number | null): number | null {
	if (wht === null || base === null || !(wht > 0) || !(base > 0)) return null;
	const rates = [0.01, 0.015, 0.02, 0.03, 0.05, 0.1];
	const ratio = wht / base;
	for (const rate of rates) if (Math.abs(ratio - rate) <= 0.002) return rate;
	return null;
}

// ภ.ง.ด. form from the counterparty name alone: 53 for juristic persons, 3 for
// individuals. Anything without an explicit marker returns null — the form is
// a filing obligation, so it is never guessed.
export function inferPndType(counterpartyName: string | null | undefined): "53" | "3" | null {
	const name = String(counterpartyName ?? "").trim();
	if (!name) return null;
	const juristicMarkers = ["บริษัท", "บจก", "บมจ", "หจก", "ห้างหุ้นส่วน", "จำกัด"];
	for (const marker of juristicMarkers) if (name.includes(marker)) return "53";
	if (/^(นางสาว|น\.ส\.|นาย|นาง)/.test(name)) return "3";
	return null;
}

// Year of a normalizeDateForPeak() result ("YYYYMMDD", already CE-normalized).
// Null when the value is not a fully normalized date.
export function yearFromPeakDate(peakDate: string | null | undefined): number | null {
	const match = /^([0-9]{4})[0-9]{4}$/.exec(String(peakDate ?? ""));
	if (!match) return null;
	const year = Number(match[1]);
	return year > 0 ? year : null;
}

// Accounting-period year of one review page: the modal year across the page's
// normalized document dates. Ties break to the later year.
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

// Decision Policy rule 11 ("ข้ามปี ให้ใช้วันที่ 1"): a document dated in a year
// before the accounting period is keyed as Jan 1 of the period year; the printed
// date stays in facts. A year *after* the period is likely a misread — flagged
// via `suspicious`, never shifted.
export function derivePeakDate(peakDate: string, periodYear: number | null): { date: string; shifted: boolean; suspicious: boolean } {
	const match = /^([0-9]{4})[0-9]{4}$/.exec(String(peakDate ?? ""));
	const year = match ? Number(match[1]) : null;
	if (year === null || !(year > 0) || periodYear === null) return { date: peakDate, shifted: false, suspicious: false };
	if (year < periodYear) return { date: String(periodYear).padStart(4, "0") + "0101", shifted: true, suspicious: false };
	if (year > periodYear) return { date: peakDate, shifted: false, suspicious: true };
	return { date: peakDate, shifted: false, suspicious: false };
}

export const CDN_SCRIPTS = `<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
	<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
	<script src="https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js"></script>`;

export const VENDOR_FILES = [
	"vue.global.prod.js",
	"lucide.min.js",
	"xlsx.full.min.js",
] as const;

export const ASSET_SCRIPTS = VENDOR_FILES.map(
	(name) => `<script src="assets/${name}"></script>`,
).join("\n\t");

const VENDOR_DIR = join(dirname(new URL(import.meta.url).pathname), "vendor");

// Inline the vendored libs directly into the page so each generated review file
// is a single self-contained .html (no assets/ folder next to it) — the whole
// point of the ตรวจทาน/ deliverable tree being friendly to open. The only
// sequence that could break an inline <script> is the ETAGO `</script`; it never
// appears in these minified libs, but we neutralize it defensively so a future
// vendor bump can't silently emit broken HTML.
export function inlineVendorScripts(): string {
	return VENDOR_FILES.map((name) => {
		const source = join(VENDOR_DIR, name);
		const js = readFileSync(source, "utf8").replaceAll(/<\/script/gi, "<\\/script");
		return `<script>\n${js}\n</script>`;
	}).join("\n");
}

export function renderReviewHtml(
	data: ReviewHtmlData,
	scripts: string = CDN_SCRIPTS,
): string {
	const blob = JSON.stringify(data, null, 0).replaceAll("</", "<\\/");
	// Replacer FUNCTIONS, not strings: minified vendor JS (and potentially the
	// data blob) contains $-patterns ($', $&, $\`) that String.replace expands,
	// re-injecting chunks of the template into the output as garbage.
	return HTML.replace("__SCRIPTS__", () => scripts).replace("__DATA__", () => blob);
}

const HTML = `<!doctype html>
<html lang="th">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>KSK Review</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&display=swap" rel="stylesheet">
	__SCRIPTS__
	<style>
		* { box-sizing: border-box; }
		body { margin: 0; font: 14px/1.4 "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f7fb; }
		button, input, select, textarea { font: inherit; }
		button:disabled { opacity: .55; cursor: not-allowed; }
		[v-cloak] { display: none; }
		.app { min-height: 100vh; }
		.navbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 8px 14px; background: rgba(255,255,255,.96); backdrop-filter: blur(8px); box-shadow: 0 1px 0 rgba(15,23,42,.04); }
		.brand { min-width: 0; }
		.brand h1 { margin: 0; display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
		.client-label { font-size: 14px; font-weight: 500; color: #65728a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: min(58vw, 100%); }
		.doc-count { flex: 0 0 auto; font-size: 12px; font-weight: 600; }
		.nav-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
		.main { padding: 0 14px 0 0; min-height: calc(100vh - 56px); }
		.feedback { margin: 12px 0 12px 14px; padding: 10px 12px; background: #eff6ff; border-radius: 10px; color: #1e40af; white-space: pre-wrap; }
		.feedback.warning { background: #fff7ed; color: #9a3412; }
		.feedback[hidden] { display: none !important; }
		.pane { display: grid; grid-template-columns: minmax(420px, 56%) 10px minmax(360px, 1fr); gap: 0; align-items: stretch; min-height: calc(100vh - 56px); }
		.pane.pane-statement { grid-template-columns: minmax(300px, 34%) 10px minmax(560px, 1fr); }
		.pane.resizing { cursor: col-resize; user-select: none; }
		.pane-gutter { position: relative; align-self: stretch; cursor: col-resize; touch-action: none; }
		.pane-gutter::before { content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; transform: translateX(-50%); background: #cbd5e1; border-radius: 2px; transition: background .15s ease, width .15s ease; }
		.pane-gutter:hover::before, .pane.resizing .pane-gutter::before { background: #2563eb; width: 4px; }
		.card { min-width: 0; background: white; border-radius: 12px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
		.evidence { position: sticky; top: 56px; height: calc(100vh - 56px); display: flex; flex-direction: column; min-width: 0; background: #e8ecf1; overflow: hidden; }
		.form-card { min-height: calc(100vh - 56px); margin: 14px 0; }
		.preview { position: relative; flex: 1 1 0; min-height: 0; width: 100%; }
		.image-wrap { height: 100%; width: 100%; overflow: hidden; background: #e8ecf1; border-radius: 0; cursor: grab; display: flex; align-items: center; justify-content: center; }
		.image-wrap.dragging { cursor: grabbing; }
		.image-wrap.empty { color: #64748b; font-weight: 700; }
			.pdf-frame { flex: 1 1 0; min-height: 0; width: 100%; height: 100%; border: 0; background: #e8ecf1; }
			.preview-file { display: flex; flex-direction: column; align-items: center; gap: 12px; color: #64748b; font-weight: 600; text-align: center; padding: 24px; }
			.preview-file a { text-decoration: none; padding: 9px 14px; border-radius: 8px; }
			.sheet-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; background: #fff; }
			.sheet-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 12px; flex: 0 0 auto; }
			.sheet-head .sheet-name { background: #eff6ff; color: #1d4ed8; }
			.sheet-head .sheet-open { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; padding: 5px 10px; border-radius: 8px; font-size: 12px; }
			.sheet-scroll { flex: 1 1 0; min-height: 0; overflow: auto; }
			.sheet-table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
			.sheet-table td, .sheet-table th { border: 1px solid #e2e8f0; padding: 3px 8px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
			.sheet-table .sheet-rownum { position: sticky; left: 0; background: #f8fafc; color: #94a3b8; font-weight: 500; text-align: right; min-width: 34px; z-index: 1; }
			.sheet-table .sheet-header-row td { position: sticky; top: 0; background: #f1f5f9; font-weight: 700; z-index: 2; }
			.sheet-table .sheet-header-row .sheet-rownum { top: 0; z-index: 3; }
			.page-anchor { position: absolute; left: 12px; bottom: 12px; z-index: 2; padding: 4px 10px; background: rgba(255,255,255,.94); border-radius: 999px; box-shadow: 0 4px 16px rgba(15,23,42,.1); font-weight: 700; font-size: 12px; color: #334155; }
		#pageImage { width: 100%; height: 100%; object-fit: contain; transform-origin: center center; user-select: none; touch-action: none; }
		.zoombar { position: absolute; right: 12px; bottom: 12px; z-index: 2; display: flex; gap: 5px; align-items: center; padding: 5px 7px; background: rgba(255,255,255,.94); border-radius: 999px; box-shadow: 0 4px 16px rgba(15,23,42,.1); }
		.zoombar button { min-width: 28px; border-radius: 999px; padding: 5px 7px; display: inline-flex; align-items: center; justify-content: center; }
		.zoombar i, .zoombar svg { width: 16px; height: 16px; }
		.zoom-pill { background: #f3f4f6; border-radius: 999px; padding: 5px 9px; font-weight: 700; font-size: 12px; }
		.divider { width: 1px; height: 20px; background: #d1d5db; }
		.file-selector { flex: 0 0 auto; width: 100%; background: #fff; padding: 8px 0 10px; }
		.groups { display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; width: 100%; padding: 0 8px; scroll-snap-type: x proximity; overscroll-behavior-x: contain; scrollbar-color: #94a3b8 transparent; scrollbar-width: thin; }
		.groups::-webkit-scrollbar { height: 6px; }
		.groups::-webkit-scrollbar-track { background: transparent; }
		.groups::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 999px; }
		.group { flex: 0 0 168px; min-height: 76px; text-align: left; border: 0; background: #f8fafc; border-radius: 8px; padding: 8px; margin: 0; cursor: pointer; scroll-snap-align: start; }
		.group.reviewed { background: #f0fdf4; }
		.group.needs_attention { background: #fff7ed; }
		.group.unreviewed { background: #f8fafc; }
		.group.skipped { background: #f1f5f9; opacity: 0.7; }
		.group.active { background: #eff6ff; box-shadow: inset 0 0 0 2px #93c5fd; }
		.group-title { height: 36px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-weight: 600; font-size: 12px; line-height: 1.3; }
		.group-total { margin-top: 4px; font-weight: 700; color: #1e3a8a; font-size: 13px; }
		.group-source { margin-top: 2px; font-size: 11px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.muted { color: #65728a; font-size: 12px; }
		.badge { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 12px; background: #e5e7eb; }
		.badge.reviewed { background: #dcfce7; color: #166534; }
		.badge.needs_attention { background: #ffedd5; color: #9a3412; }
		.badge.unreviewed { background: #e5e7eb; color: #374151; }
		.badge.skipped { background: #e5e7eb; color: #6b7280; }
		.badge.group-tag { background: #eef2ff; color: #3730a3; }
		.group-flags { list-style: none; margin: 8px 0 4px; padding: 8px 10px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; }
		.group-flags li { display: flex; align-items: flex-start; gap: 6px; color: #9a3412; font-size: 12px; line-height: 1.4; }
		.group-flags li + li { margin-top: 4px; }
		.group-flags li svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }
		h1, h2, h3 { margin: 0 0 10px; }
		h1 { font-size: 20px; }
		h2 { font-size: 16px; margin-top: 0; }
		label { display: block; font-weight: 600; margin: 6px 0 4px; color: #64748b; font-size: 12px; }
		input, select, textarea { width: 100%; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; background: #fff; transition: border-color .15s ease, box-shadow .15s ease; }
		input:focus, select:focus, textarea:focus { outline: none; border-color: #93c5fd; box-shadow: 0 0 0 3px rgba(147,197,253,.22); }
		textarea { min-height: 68px; resize: vertical; }
		.doc-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 20px; margin: 10px 0 0; }
		.doc-meta-col { display: grid; gap: 10px; align-content: start; }
		.doc-meta input, .doc-meta select { height: 44px; padding: 8px 10px; }
		.doc-meta label { color: #64748b; font-weight: 600; font-size: 12px; }
		.form-section { margin-top: 28px; }
		.summary-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 20px; margin-top: 28px; }
		.summary-row input { height: 44px; font-weight: 700; }
		.summary-row label { color: #64748b; font-weight: 600; font-size: 12px; }
		.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
		.section-head { position: relative; margin: 0 0 12px; }
		.section-head h2 { margin: 0; font-size: 16px; font-weight: 700; color: #334155; }
		.section-head .actions { position: absolute; right: 0; top: -8px; margin-top: 0; }
		.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
		.primary, .secondary, .danger, .mini-danger { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
		.primary i, .secondary i, .danger i, .primary svg, .secondary svg, .danger svg { width: 16px; height: 16px; flex-shrink: 0; }
		.primary { background: #1d4ed8; color: white; border: 0; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
		.secondary { background: #f1f5f9; color: #334155; border: 0; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
		.danger { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; border-radius: 8px; padding: 6px 9px; cursor: pointer; }
		.items-list { display: grid; gap: 12px; }
		.line-card { padding: 0 0 12px; }
		.line-row { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.5fr) 140px 36px; gap: 12px; align-items: end; }
		.line-row.mixed { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 130px 120px 36px; }
		.line-card label { margin-top: 0; color: #475569; font-size: 12px; }
		.line-card input, .line-card select { height: 40px; }
		.line-card .amount input { font-weight: 700; text-align: right; }
		.line-desc-field { position: relative; }
		.line-desc-field.has-hint input { padding-right: 36px; }
		.line-hint-trigger { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); z-index: 2; }
		.hint-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 999px; background: transparent; color: #f59e0b; cursor: help; }
		.hint-icon:hover, .hint-icon:focus-visible { background: #fffbeb; color: #d97706; outline: none; }
		.hint-icon.warn { color: #ea580c; }
		.hint-icon.warn:hover, .hint-icon.warn:focus-visible { background: #fff7ed; color: #c2410c; }
		.hint-icon i, .hint-icon svg { width: 16px; height: 16px; }
		.hint-popup { display: none; position: absolute; right: 0; top: calc(100% + 6px); z-index: 6; width: min(340px, 72vw); padding: 10px 12px; background: #fff; border-radius: 10px; box-shadow: 0 10px 28px rgba(15,23,42,.14); font-size: 12px; line-height: 1.45; color: #9a3412; text-align: left; white-space: normal; pointer-events: none; }
		.line-hint-trigger:hover .hint-popup, .line-hint-trigger:focus-within .hint-popup { display: block; }
		.mini-danger { background: transparent; color: #991b1b; border: 0; cursor: pointer; padding: 4px; border-radius: 6px; height: 40px; }
		.mini-danger:hover { background: #fee2e2; }
		.mini-danger i, .mini-danger svg { width: 18px; height: 18px; }
		.coa-totals { margin-top: 4px; display: grid; gap: 6px; }
		.coa-total-row { display: grid; grid-template-columns: 1fr 120px; gap: 8px; padding: 2px 0; color: #64748b; font-size: 13px; }
		.coa-total-row b:last-child { text-align: right; }
		details { margin: 0; }
		details.form-section { margin-top: 28px; }
		summary { cursor: pointer; font-weight: 600; color: #475569; font-size: 14px; }
		.form-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 24px; padding-top: 0; }
		.modal-backdrop { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(15,23,42,.42); }
		.export-modal { width: min(1180px, 96vw); max-height: 92vh; display: flex; flex-direction: column; gap: 14px; overflow: hidden; }
		.modal-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
		.icon-button { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border: 0; border-radius: 999px; background: #f1f5f9; color: #334155; cursor: pointer; }
		.icon-button i, .icon-button svg { width: 17px; height: 17px; }
		.export-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
		.export-stat { padding: 10px 12px; border-radius: 10px; background: #f8fafc; }
		.export-stat b { display: block; font-size: 18px; color: #1d4ed8; }
		.export-warnings { max-height: 96px; overflow: auto; margin: 0; padding: 10px 12px 10px 28px; border-radius: 10px; background: #fff7ed; color: #9a3412; }
		.export-table-wrap { overflow: auto; border: 1px solid #e2e8f0; border-radius: 10px; }
		.export-table { width: 100%; min-width: 980px; border-collapse: collapse; font-size: 12px; }
		.export-table th, .export-table td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: left; white-space: nowrap; }
		.export-table th { position: sticky; top: 0; z-index: 1; background: #f8fafc; color: #475569; font-weight: 700; }
		.export-table td.number { text-align: right; }
		.export-table td.blank { background: #fff7ed; color: #c2410c; }
		.modal-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
		@media (max-width: 980px) { .navbar, .pane, .doc-meta, .summary-row { display: block; } .pane-gutter { display: none; } .main { padding: 0; } .navbar { position: static; } .nav-actions { justify-content: flex-start; margin-top: 8px; } .evidence { position: static; height: auto; } .preview { min-height: 70vh; } .form-card { margin: 14px; } .line-row, .line-row.mixed { grid-template-columns: minmax(0, 1fr) 120px 36px; } .line-row .line-desc, .line-row .line-vat { grid-column: 1 / -1; } .export-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
		.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 50; padding: 10px 20px; border-radius: 10px; background: #1e3a8a; color: #fff; font-weight: 600; font-size: 13px; box-shadow: 0 8px 28px rgba(15,23,42,.18); opacity: 0; transition: opacity .25s ease; pointer-events: none; }
		.toast.show { opacity: 1; }
		.statement-card { display: flex; flex-direction: column; }
		.integrity-check { margin-top: 14px; padding: 10px 12px; border-radius: 10px; font-weight: 600; background: #f1f5f9; color: #334155; }
		.integrity-check.ok { background: #dcfce7; color: #166534; }
		.integrity-check.bad { background: #fee2e2; color: #991b1b; }
		.filter-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 20px; }
		.chip-group { display: flex; gap: 6px; }
		.chip { border: 1px solid #e2e8f0; background: #fff; border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 12px; font-weight: 600; color: #475569; }
		.chip.active { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
		.check-inline { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #475569; margin: 0; }
		.check-inline input { width: auto; }
		.filter-bar select, .filter-bar input[type=search] { width: auto; min-width: 140px; }
		.stm-table-wrap { margin-top: 14px; max-height: calc(100vh - 430px); overflow: auto; border: 1px solid #e2e8f0; border-radius: 10px; }
		.stm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
		.stm-table th, .stm-table td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: middle; }
		.stm-table th { position: sticky; top: 0; z-index: 1; background: #f8fafc; color: #475569; font-weight: 700; text-align: left; }
		.stm-table td.number, .stm-table th.number { text-align: right; white-space: nowrap; }
		.stm-table td.number input { width: 92px; text-align: right; }
		.stm-table td.date { white-space: nowrap; }
		.stm-table input, .stm-table select { height: 34px; padding: 5px 8px; }
		.stm-desc { width: 200px; }
		.stm-desc-field { display: flex; align-items: center; gap: 6px; }
		.stm-desc-field input { flex: 1 1 auto; min-width: 0; }
		.stm-table .stm-coa { min-width: 200px; }
		.stm-table .stm-coa select { width: 100%; min-width: 190px; }
		.stm-table tr.row-warn { background: #fff7ed; }
		.stm-table tr.row-skip { opacity: .5; }
		.hint-cell { position: relative; display: inline-flex; width: 24px; height: 24px; flex: 0 0 auto; }
		.row-check { display: flex; align-items: center; gap: 6px; }
		.stm-footer { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; justify-content: space-between; }
		.stm-counts { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: #475569; }
		.stm-counts b { color: #1d4ed8; }
	</style>
</head>
<body>
<div id="app" class="app" v-cloak>
	<header class="navbar">
		<div class="brand">
			<h1>KSK <span class="client-label">{{ data.client_key }} · {{ data.group }}</span><span class="badge doc-count">{{ navCountLabel }}</span></h1>
			<div class="muted">{{ draftStatus || 'ฉบับร่างจะบันทึกในเบราว์เซอร์อัตโนมัติ' }}</div>
		</div>
		<div class="nav-actions">
			<button class="primary" type="button" :disabled="exportDisabled" @click="showExportPreview"><i data-lucide="file-spreadsheet"></i><span>ส่งออก XLSX</span></button>
		</div>
	</header>
	<main class="main">
		<div class="feedback warning" v-if="message">{{ message }}</div>
		<div class="toast" :class="{show: toast.visible}" v-if="toast.message">{{ toast.message }}</div>
		<div class="pane" :class="{'pane-statement': isStatement, resizing: paneResize.active}" :style="paneStyle">
			<section class="evidence">
				<div class="preview">
					<iframe v-if="previewKind === 'pdf'" :key="'pdf-' + currentIndex" class="pdf-frame" :src="pdfSrc" title="source pdf"></iframe>
						<div v-else-if="previewKind === 'sheet'" class="sheet-wrap">
							<div class="sheet-head">
								<span class="badge sheet-name">{{ evidenceMeta.sheet_preview.sheet }}</span>
								<span class="muted" v-if="evidenceMeta.sheet_preview.rows.length < evidenceMeta.sheet_preview.total_rows">แสดง {{ evidenceMeta.sheet_preview.rows.length }} จาก {{ evidenceMeta.sheet_preview.total_rows }} แถว</span>
								<span class="muted" v-else-if="evidenceMeta.sheet_preview.truncated">บางคอลัมน์ถูกตัด — เปิดไฟล์ต้นฉบับเพื่อดูทั้งหมด</span>
								<a class="secondary sheet-open" v-if="evidenceMeta.source_src" :href="evidenceMeta.source_src" target="_blank" rel="noopener"><i data-lucide="external-link"></i><span>เปิดไฟล์ต้นฉบับ</span></a>
							</div>
							<div class="sheet-scroll">
								<table class="sheet-table">
									<tbody>
										<tr v-for="(row, ri) in evidenceMeta.sheet_preview.rows" :key="ri" :class="{'sheet-header-row': ri === 0}">
											<th class="sheet-rownum">{{ ri + 1 }}</th>
											<td v-for="(cell, ci) in row" :key="ci" :title="cell == null ? '' : String(cell)">{{ cell == null ? '' : cell }}</td>
										</tr>
									</tbody>
								</table>
							</div>
						</div>
						<div v-else id="imageWrap" class="image-wrap" :class="{dragging: dragging, empty: previewKind !== 'image'}" @pointerdown="startPan" @pointermove="movePan" @pointerup="endPan" @pointerleave="endPan">
						<img v-if="previewKind === 'image'" id="pageImage" :src="imageSrc" alt="หลักฐานเอกสาร" :style="imageStyle" draggable="false" />
						<div v-else-if="previewKind === 'file'" class="preview-file"><div>ไฟล์ต้นฉบับเปิดในเบราว์เซอร์ไม่ได้ (เช่น .xlsx)</div><a class="secondary" :href="evidenceMeta.source_src" target="_blank" rel="noopener"><i data-lucide="external-link"></i><span>เปิดไฟล์ต้นฉบับ</span></a></div>
							<div v-else>ไม่มีเอกสารต้นฉบับสำหรับหน้านี้</div>
					</div>
					<div class="page-anchor" v-if="previewKind === 'pdf' && evidenceMeta.source_page">หน้า {{ evidenceMeta.source_page }}</div>
						<div class="zoombar" aria-label="ควบคุมพรีวิว" v-if="previewKind === 'image'">
						<button class="secondary" type="button" @click="zoomOut" title="ซูมออก"><i data-lucide="zoom-out"></i></button>
						<span class="zoom-pill">{{ Math.round(zoom * 100) }}%</span>
						<button class="secondary" type="button" @click="zoomIn" title="ซูมเข้า"><i data-lucide="zoom-in"></i></button>
						<span class="divider"></span>
						<button class="secondary" type="button" @click="resetPreview" title="รีเซ็ตพรีวิว"><i data-lucide="maximize-2"></i></button>
					</div>
				</div>
				<div class="file-selector">
					<div class="groups" @wheel="scrollGroups">
						<button v-for="(page, index) in selectorItems" :key="selectorKey(page, index)" class="group" :class="[pageStatus(index), {active: index === currentIndex}]" type="button" @click="selectPage(index)">
							<div class="group-title">{{ pageTitle(page) }}</div>
							<div class="group-total">{{ selectorTotal(page) }}</div>
							<div class="muted"><span class="badge" :class="pageStatus(index)">{{ statusLabel(pageStatus(index)) }}</span> · {{ selectorSubtitle(page) }}</div>
							<div class="group-source" v-if="selectorTag(page)">{{ selectorTag(page) }}</div>
						</button>
					</div>
				</div>
			</section>
			<div class="pane-gutter" @pointerdown="startPaneResize" @dblclick="resetPaneWidth" title="ลากเพื่อปรับขนาด · ดับเบิลคลิกเพื่อรีเซ็ต"></div>
			<section class="card form-card" v-if="!isStatement">
				<h1>{{ pageTitle(currentPage) }}</h1>
				<div class="muted">{{ currentPage.ref }}<span v-if="currentPage.group_label || currentPage.group_id"> · <span class="badge group-tag">{{ currentPage.group_label || currentPage.group_id }}</span></span></div>
				<ul class="group-flags" v-if="currentPage.group_review_flags && currentPage.group_review_flags.length">
					<li v-for="(flag, fi) in currentPage.group_review_flags" :key="fi"><i data-lucide="triangle-alert"></i><span>{{ flag }}</span></li>
				</ul>
				<div class="doc-meta">
					<div class="doc-meta-col">
						<div v-for="field in primaryLeftFields" :key="field.key">
							<label>{{ field.label }}</label>
							<select v-if="field.key === 'vat_treatment'" v-model="currentState.facts[field.key]">
								<option value="">ว่าง</option>
								<option value="vat_7">VAT 7%</option>
								<option value="non_vat">ไม่มี VAT</option>
								<option value="unknown">ไม่ทราบ</option>
							</select>
							<input v-else v-model="currentState.facts[field.key]" />
						</div>
					</div>
					<div class="doc-meta-col">
						<div v-for="field in primaryRightFields" :key="field.key">
							<label>{{ field.label }}</label>
							<input v-model="currentState.facts[field.key]" />
						</div>
					</div>
				</div>
				<div class="form-section">
					<div class="section-head">
						<h2>รายการ</h2>
						<div class="actions"><button class="secondary" type="button" @click="addLine"><i data-lucide="plus"></i><span>เพิ่มรายการ</span></button></div>
					</div>
					<div class="items-list">
						<div class="line-card" v-for="(line, lineIndex) in currentState.lines" :key="line.local_id">
							<div class="line-row" :class="{mixed: isMixedBucket}">
								<div class="line-coa">
									<label>ผังบัญชี</label>
									<select v-model="line.account_key">
										<option value="">ยังไม่ระบุ / ว่าง</option>
										<option v-for="row in data.coa_rows" :key="coaKey(row)" :value="coaKey(row)">{{ coaLabel(row) }}</option>
									</select>
								</div>
								<div class="line-desc">
									<label>รายละเอียด</label>
									<div class="line-desc-field" :class="{'has-hint': lineHint(line)}">
										<input v-model="line.description" />
										<div class="line-hint-trigger" v-if="lineHint(line)">
											<button class="hint-icon" :class="{warn: line.needs_review}" type="button" :title="line.needs_review ? 'ต้องตรวจสอบ' : 'เหตุผลการจัดหมวด'" aria-label="เหตุผลการจัดหมวด"><i data-lucide="triangle-alert"></i></button>
											<div class="hint-popup" role="tooltip">{{ lineHint(line) }}</div>
										</div>
									</div>
								</div>
								<div class="line-amount amount">
									<label>ยอด</label>
									<input v-model="line.amount" />
								</div>
								<div class="line-vat" v-if="isMixedBucket">
									<label>VAT</label>
									<select v-model="line.vat_treatment">
										<option :value="null">ตามเอกสาร</option>
										<option value="vat_7">VAT 7%</option>
										<option value="non_vat">ไม่มี VAT</option>
									</select>
								</div>
								<button class="mini-danger" type="button" @click="removeLine(lineIndex)" title="ลบรายการ"><i data-lucide="trash-2"></i></button>
							</div>
						</div>
					</div>
					<div class="coa-totals" v-if="coaTotals.length">
						<div class="coa-total-row" v-for="row in coaTotals" :key="row.key"><span>{{ row.label }}</span><b>{{ formatBaht(row.total) }}</b></div>
					</div>
				</div>
				<div class="summary-row">
					<div v-for="field in summaryFields" :key="field.key">
						<label>{{ field.label }}</label>
						<input v-model="currentState.facts[field.key]" />
					</div>
					<div v-if="currentState.facts.wht != null && currentState.facts.wht !== ''">
						<label>หัก ณ ที่จ่าย (ตามเอกสาร)</label>
						<input v-model="currentState.facts.wht" />
					</div>
				</div>
				<details class="form-section">
					<summary>ฟิลด์อื่นๆ</summary>
					<div class="grid">
						<div v-for="field in extraFields" :key="field.key"><label>{{ field.label }}</label><input v-model="currentState.facts[field.key]" /></div>
					</div>
				</details>
				<details class="form-section">
					<summary>บัญชี / ตัวควบคุมผู้ตรวจ</summary>
					<div class="grid">
						<div><label>สถานะ</label><select v-model="currentState.status"><option value="reviewed">ตรวจแล้ว</option><option value="needs_attention">ต้องตรวจสอบ</option></select></div>
					</div>
					<label>บันทึกผู้ตรวจ</label><textarea v-model="currentState.note" placeholder="จำเป็นเมื่อสถานะต้องตรวจสอบ"></textarea>
				</details>
				<div class="form-actions">
					<button class="secondary" type="button" @click="toggleSkip">{{ currentState.skipped ? 'ใช้หน้านี้' : 'ไม่ใช้ข้อมูลหน้านี้' }}</button>
					<button class="primary" type="button" @click="saveAndNext"><i data-lucide="save"></i><span>บันทึกและถัดไป</span><i data-lucide="arrow-right"></i></button>
				</div>
			</section>
			<section class="card statement-card" v-else>
				<h1>{{ pageTitle(currentStatement) }}</h1>
				<div class="muted">{{ currentStatement.statement.period || 'ไม่ระบุงวด' }}<span v-if="currentStatement.label"> · <span class="badge group-tag">{{ currentStatement.label }}</span></span></div>
				<div class="doc-meta">
					<div class="doc-meta-col">
						<div><label>ธนาคาร</label><input :value="currentStatement.statement.bank || ''" readonly /></div>
						<div><label>เลขที่บัญชี</label><input :value="currentStatement.statement.account_no || ''" readonly /></div>
						<div><label>ชื่อบัญชี</label><input :value="currentStatement.statement.account_holder || ''" readonly /></div>
					</div>
					<div class="doc-meta-col">
						<div><label>ยอดยกมา</label><input :value="formatBaht(currentStatement.statement.opening_balance)" readonly /></div>
						<div><label>ยอดคงเหลือปลายงวด</label><input :value="formatBaht(currentStatement.statement.closing_balance)" readonly /></div>
						<div>
							<label>บัญชีธนาคาร (ผังบัญชี GL)</label>
							<select v-model="currentStatementState.bank_account_key">
								<option value="">ยังไม่ระบุ / ว่าง</option>
								<option v-for="row in data.coa_rows" :key="coaKey(row)" :value="coaKey(row)">{{ coaLabel(row) }}</option>
							</select>
						</div>
					</div>
				</div>
				<div class="integrity-check" v-if="integrityCheck" :class="{ok: integrityCheck.ok, bad: !integrityCheck.ok}">
					ยอดยกมา + เงินเข้า − เงินออก = {{ formatBaht(integrityCheck.computed) }}
					<template v-if="integrityCheck.ok"> · ตรงกับยอดคงเหลือปลายงวด ✓</template>
					<template v-else> · ต่างจากยอดคงเหลือปลายงวด {{ formatBaht(integrityCheck.diff) }}</template>
				</div>
				<div class="filter-bar">
					<div class="chip-group">
						<button v-for="opt in directionOptions" :key="opt.value" type="button" class="chip" :class="{active: filterDirection === opt.value}" @click="filterDirection = opt.value">{{ opt.label }}</button>
					</div>
					<label class="check-inline"><input type="checkbox" v-model="filterNeedsReviewOnly" /> ต้องตรวจสอบเท่านั้น</label>
					<select v-model="filterAccountKeyFilter">
						<option value="">ทุกผังบัญชี</option>
						<option v-for="row in data.coa_rows" :key="coaKey(row)" :value="coaKey(row)">{{ coaLabel(row) }}</option>
					</select>
					<button class="secondary" type="button" @click="setSuspenseFilter">ยังอยู่บัญชีพัก 999999</button>
					<input type="search" v-model="filterSearch" placeholder="ค้นหาคู่โอน / รายการ" />
				</div>
				<div class="stm-table-wrap">
					<table class="stm-table">
						<thead>
							<tr>
								<th>#</th>
								<th>วันที่</th>
								<th>รายการ / คู่โอน</th>
								<th class="number">เงินเข้า</th>
								<th class="number">เงินออก</th>
								<th class="number">คงเหลือ</th>
								<th class="stm-coa">ผังบัญชี</th>
								<th>ตรวจแล้ว</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="entry in filteredRows" :key="entry.row.row_index" :class="{'row-warn': entry.row.needs_review && !entry.row.reviewed, 'row-skip': entry.row.skipped}">
								<td>{{ entry.index + 1 }}</td>
								<td class="date">{{ formatStatementDate(entry.row.date_iso) }}</td>
								<td class="stm-desc">
									<div class="stm-desc-field">
										<input v-model="entry.row.description" />
										<div class="hint-cell" v-if="lineHint(entry.row)">
											<button class="hint-icon" :class="{warn: entry.row.needs_review}" type="button" title="เหตุผลการจัดหมวด" aria-label="เหตุผลการจัดหมวด"><i data-lucide="triangle-alert"></i></button>
											<div class="hint-popup" role="tooltip">{{ lineHint(entry.row) }}</div>
										</div>
									</div>
									<div class="muted" v-if="entry.row.counterparty">{{ entry.row.counterparty }}</div>
								</td>
								<td class="number"><input v-if="entry.row.direction === 'in'" v-model="entry.row.amount" /></td>
								<td class="number"><input v-if="entry.row.direction === 'out'" v-model="entry.row.amount" /></td>
								<td class="number">{{ formatNumber(entry.row.balance) }}</td>
								<td class="stm-coa">
									<select v-model="entry.row.account_key">
										<option value="">ยังไม่ระบุ / ว่าง</option>
										<option v-for="row in data.coa_rows" :key="coaKey(row)" :value="coaKey(row)">{{ coaLabel(row) }}</option>
									</select>
								</td>
								<td>
									<div class="row-check">
										<input type="checkbox" v-model="entry.row.reviewed" title="ตรวจแล้ว" />
										<button class="mini-danger" type="button" @click="toggleRowSkip(entry.row)" :title="entry.row.skipped ? 'ใช้รายการนี้' : 'ไม่ใช้รายการนี้'"><i :data-lucide="entry.row.skipped ? 'rotate-ccw' : 'ban'"></i></button>
									</div>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
				<div class="stm-footer">
					<div class="coa-totals" v-if="coaTotals.length">
						<div class="coa-total-row" v-for="row in coaTotals" :key="row.key"><span>{{ row.label }}</span><b>{{ formatBaht(row.total) }}</b></div>
					</div>
					<div class="stm-counts" v-if="currentStatementCounts">
						<span>ตรวจแล้ว <b>{{ currentStatementCounts.reviewed }}</b></span>
						<span>ต้องตรวจสอบ <b>{{ currentStatementCounts.needsReview }}</b></span>
						<span>ไม่ใช้ <b>{{ currentStatementCounts.skipped }}</b></span>
						<span>ทั้งหมด <b>{{ currentStatementCounts.total }}</b></span>
					</div>
					<button class="primary" type="button" :disabled="exportDisabled" @click="showExportPreview"><i data-lucide="file-spreadsheet"></i><span>ส่งออก XLSX</span></button>
				</div>
			</section>
		</div>
	</main>
	<div v-if="exportPreview" class="modal-backdrop" @click.self="closeExportPreview">
		<section class="card export-modal" role="dialog" aria-modal="true" aria-labelledby="exportPreviewTitle">
			<div class="modal-head">
				<div>
					<h2 id="exportPreviewTitle">ตรวจสอบก่อนส่งออก PEAK XLSX</h2>
					<div class="muted">ประเภทไฟล์ PEAK: {{ exportPreview.template_name }} · Sheet: {{ exportPreview.sheet_name }} · ไฟล์: {{ exportPreview.filename }}</div>
				</div>
				<button class="icon-button" type="button" @click="closeExportPreview" title="ปิด"><i data-lucide="x"></i></button>
			</div>
			<div class="export-stats">
				<div class="export-stat"><span class="muted">{{ isStatement ? 'รายการที่ส่งออก' : 'เอกสารที่ส่งออก' }}</span><b>{{ exportPreview.committed_count }}</b></div>
				<div class="export-stat"><span class="muted">แถวในไฟล์</span><b>{{ exportPreview.rows.length }}</b></div>
				<div class="export-stat"><span class="muted">แก้ไข</span><b>{{ exportPreview.change_count }}</b></div>
				<div class="export-stat"><span class="muted">{{ isStatement ? 'รายการที่ยังไม่ตรวจ' : 'เอกสารที่ยังไม่ตรวจ' }}</span><b>{{ exportPreview.uncommitted_count }}</b></div>
				<div class="export-stat"><span class="muted">คำเตือน</span><b>{{ exportPreview.warnings.length }}</b></div>
			</div>
			<div class="export-stats" v-if="exportPreview.balance">
				<div class="export-stat"><span class="muted">เดบิตรวม</span><b>{{ formatNumber(exportPreview.balance.debit) }}</b></div>
				<div class="export-stat"><span class="muted">เครดิตรวม</span><b>{{ formatNumber(exportPreview.balance.credit) }}</b></div>
				<div class="export-stat"><span class="muted">ยอดตรงกัน (เดบิต = เครดิต)</span><b>{{ exportPreview.balance.ok ? 'ตรงกัน' : 'ไม่ตรงกัน' }}</b></div>
			</div>
			<ul class="export-warnings" v-if="exportPreview.warnings.length">
				<li v-for="(warning, warningIndex) in exportPreview.warnings" :key="warningIndex">{{ warning }}</li>
			</ul>
			<div class="export-table-wrap">
				<table class="export-table">
					<thead><tr><th v-for="column in exportPreview.preview_columns" :key="column.index">{{ column.label }}</th></tr></thead>
					<tbody>
						<tr v-for="(row, rowIndex) in exportPreview.rows" :key="rowIndex">
							<td v-for="column in exportPreview.preview_columns" :key="column.index" :class="[{blank: row.cells[column.index] === '' || row.cells[column.index] === null || row.cells[column.index] === undefined}, column.number ? 'number' : '']">{{ row.cells[column.index] }}</td>
						</tr>
					</tbody>
				</table>
			</div>
			<div class="modal-actions">
				<button class="secondary" type="button" @click="closeExportPreview">ยกเลิก</button>
				<button class="primary" type="button" :disabled="!exportPreview.rows.length" @click="downloadExportXlsx"><i data-lucide="download"></i><span>บันทึก XLSX</span></button>
			</div>
		</section>
	</div>
</div>
<script id="reviewData" type="application/json">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById('reviewData').textContent);
const DRAFT_SCHEMA = 'ksk_review_vue_draft.v1';
const STATEMENT_DRAFT_SCHEMA = 'ksk_review_statement_draft.v1';
const DIRECTION_OPTIONS = [
	{value: 'all', label: 'ทั้งหมด'},
	{value: 'in', label: 'เงินเข้า'},
	{value: 'out', label: 'เงินออก'},
];
const PRIMARY_LEFT_FIELDS = [
	{key: 'date', label: 'วันที่'},
	{key: 'seller', label: 'ผู้ขาย'},
	{key: 'buyer', label: 'ผู้ซื้อ'},
	{key: 'vat_treatment', label: 'การจัดการ VAT'},
];
const PRIMARY_RIGHT_FIELDS = [
	{key: 'document_no', label: 'เลขที่เอกสาร'},
	{key: 'seller_tax_id', label: 'เลขประจำตัวผู้เสียภาษีผู้ขาย'},
	{key: 'buyer_tax_id', label: 'เลขประจำตัวผู้เสียภาษีผู้ซื้อ'},
];
const SUMMARY_FIELDS = [
	{key: 'subtotal', label: 'ยอดก่อนภาษี'},
	{key: 'total', label: 'ยอดรวม'},
];
const EXTRA_FIELDS = [
	{key: 'reference', label: 'อ้างอิง'},
	{key: 'vat', label: 'ภาษีมูลค่าเพิ่ม'},
	{key: 'paid', label: 'ชำระแล้ว'},
	{key: 'summary', label: 'จำนวนเงินตัวอักษร'},
	// FX visibility (THB contract): the money fields above are THB; these carry
	// the document's own foreign-currency face value so the reviewer can see the
	// conversion. currency is null/THB in the normal case.
	{key: 'currency', label: 'สกุลเงิน'},
	{key: 'original_currency', label: 'สกุลเงินเดิม'},
	{key: 'original_amount', label: 'ยอดเงินสกุลเดิม'},
	{key: 'exchange_rate', label: 'อัตราแลกเปลี่ยน'},
];
const STATUS_LABELS = {reviewed: 'ตรวจแล้ว', needs_attention: 'ต้องตรวจสอบ', unreviewed: 'ยังไม่ตรวจ', skipped: 'ไม่ใช้'};
const PEAK_EXPENSE_HEADERS = ['ลำดับที่*', 'วันที่เอกสาร', 'อ้างอิงถึง', 'ผู้รับเงิน/คู่ค้า', 'เลขทะเบียน 13 หลัก', 'เลขสาขา 5 หลัก', 'เลขที่ใบกำกับฯ', 'วันที่ใบกำกับฯ', 'วันที่บันทึกภาษีซื้อ', 'ประเภทราคา', 'บัญชี', 'คำอธิบาย', 'จำนวน', 'ราคาต่อหน่วย', 'อัตราภาษี', 'หัก ณ ที่จ่าย', 'ชำระโดย', 'จำนวนเงินที่ชำระ', 'ภ.ง.ด.', 'หมายเหตุ', 'กลุ่มจัดประเภท'];
const PEAK_REVENUE_HEADERS = ['ลำดับที่*', 'วันที่เอกสาร', 'อ้างอิงจาก', 'ผู้รับเงิน/คู่ค้า', 'เลขทะเบียน 13 หลัก', 'เลขสาขา 5 หลัก', 'เลขที่ใบกำกับฯ', 'วันที่ใบกำกับฯ', 'วันที่บันทึกภาษีขาย', 'ประเภทราคา', 'บัญชี', 'คำอธิบาย', 'จำนวน', 'ราคาต่อหน่วย', 'อัตราภาษี', 'หัก ณ ที่จ่าย', 'รับชำระโดย', 'จำนวนเงินที่ได้รับ', 'ภ.ง.ด.', 'หมายเหตุ', 'กลุ่มจัดประเภท'];
const PEAK_JOURNAL_HEADERS = ['ลำดับที่*', 'วันที่เอกสาร', 'อ้างอิงถึง', 'คำอธิบาย', 'รหัสบัญชี', 'ชื่อบัญชี', 'เดบิต', 'เครดิต', 'หมายเหตุ'];
const EXPORT_PREVIEW_COLUMNS = [
	{index: 0, label: 'ลำดับที่'},
	{index: 1, label: 'วันที่เอกสาร'},
	{index: 4, label: 'เลขทะเบียน 13 หลัก'},
	{index: 5, label: 'เลขสาขา'},
	{index: 6, label: 'เลขที่ใบกำกับฯ'},
	{index: 9, label: 'ประเภทราคา'},
	{index: 10, label: 'บัญชี'},
	{index: 11, label: 'คำอธิบาย'},
	{index: 12, label: 'จำนวน', number: true},
	{index: 13, label: 'ราคาต่อหน่วย', number: true},
	{index: 14, label: 'อัตราภาษี'},
	{index: 16, label: 'ชำระโดย'},
	{index: 17, label: 'จำนวนเงินที่ชำระ', number: true},
];
const EXPORT_PREVIEW_COLUMNS_REVENUE = [
	{index: 0, label: 'ลำดับที่'},
	{index: 1, label: 'วันที่เอกสาร'},
	{index: 4, label: 'เลขทะเบียน 13 หลัก'},
	{index: 5, label: 'เลขสาขา'},
	{index: 6, label: 'เลขที่ใบกำกับฯ'},
	{index: 9, label: 'ประเภทราคา'},
	{index: 10, label: 'บัญชี'},
	{index: 11, label: 'คำอธิบาย'},
	{index: 12, label: 'จำนวน', number: true},
	{index: 13, label: 'ราคาต่อหน่วย', number: true},
	{index: 14, label: 'อัตราภาษี'},
	{index: 16, label: 'รับชำระโดย'},
	{index: 17, label: 'จำนวนเงินที่ได้รับ', number: true},
];
const EXPORT_PREVIEW_COLUMNS_JOURNAL = [
	{index: 0, label: 'ลำดับที่'},
	{index: 1, label: 'วันที่เอกสาร'},
	{index: 3, label: 'คำอธิบาย'},
	{index: 4, label: 'รหัสบัญชี'},
	{index: 5, label: 'ชื่อบัญชี'},
	{index: 6, label: 'เดบิต', number: true},
	{index: 7, label: 'เครดิต', number: true},
];
// Real PEAK_ImportJournal layout (PRD §D5), verified against
// samples/export-file/PEAK_ImportJournal.xlsx: sheet "Import Multiple Journal",
// 12 columns. Used only for the bank_statement bucket's statement journal
// export (DATA.kind === 'statement'); the legacy 9-column PEAK_JOURNAL_HEADERS
// above stays as-is for the (now unreachable via bank_statement, but otherwise
// untouched) document-shaped "journal" template type.
const STATEMENT_JOURNAL_HEADERS = ['ลำดับที', 'สมุดบัญชี', 'วันที่รายการ (YYYYMMDD)', 'อ้างอิง', 'ผู้ติดต่อ', 'คำอธิบายการบันทึกบัญชี', 'เลขที่บัญชี*', 'บัญชีย่อย', 'คำอธิบายรายการ (ว่างเพื่อให้ระบบใส่ให้)', 'เดบิต', 'เครดิต', 'กลุ่มจัดประเภท'];
const CHANGE_LOG_HEADERS = ['เอกสาร/กลุ่ม', 'บรรทัด', 'ฟิลด์', 'ค่าจาก AI', 'ค่าหลังตรวจ', 'AI confidence', 'เหตุผล AI', 'ประเภทการแก้'];
const EXPORT_PREVIEW_COLUMNS_STATEMENT = [
	{index: 0, label: 'ลำดับที'},
	{index: 2, label: 'วันที่รายการ'},
	{index: 5, label: 'คำอธิบาย'},
	{index: 6, label: 'เลขที่บัญชี'},
	{index: 7, label: 'บัญชีย่อย'},
	{index: 9, label: 'เดบิต', number: true},
	{index: 10, label: 'เครดิต', number: true},
];
const STATEMENT_JOURNAL_BOOK_NAME = 'รายวันทั่วไป';
const CHANGE_LOG_FACT_FIELDS = [
	{key: 'date', label: 'วันที่'},
	{key: 'seller', label: 'ผู้ขาย'},
	{key: 'buyer', label: 'ผู้ซื้อ'},
	{key: 'seller_tax_id', label: 'เลขประจำตัวผู้เสียภาษีผู้ขาย'},
	{key: 'buyer_tax_id', label: 'เลขประจำตัวผู้เสียภาษีผู้ซื้อ'},
	{key: 'document_no', label: 'เลขที่เอกสาร'},
	{key: 'vat_treatment', label: 'การจัดการ VAT'},
	{key: 'subtotal', label: 'ยอดก่อนภาษี'},
	{key: 'total', label: 'ยอดรวม'},
	{key: 'reference', label: 'อ้างอิง'},
	{key: 'vat', label: 'ภาษีมูลค่าเพิ่ม'},
	{key: 'wht', label: 'หัก ณ ที่จ่าย'},
	{key: 'paid', label: 'ชำระแล้ว'},
	{key: 'summary', label: 'จำนวนเงินตัวอักษร'},
];
const CHANGE_LOG_LINE_FIELDS = [
	{key: 'account_key', label: 'ผังบัญชี'},
	{key: 'description', label: 'รายละเอียด'},
	{key: 'qty', label: 'จำนวน'},
	{key: 'unit', label: 'หน่วย'},
	{key: 'unit_price', label: 'ราคาต่อหน่วย'},
	{key: 'amount', label: 'ยอด'},
	{key: 'vat_treatment', label: 'VAT'},
];
const CHANGE_LOG_STATEMENT_ROW_FIELDS = [
	{key: 'account_key', label: 'ผังบัญชี'},
	{key: 'description', label: 'รายละเอียด'},
	{key: 'amount', label: 'ยอด'},
	{key: 'reviewed', label: 'ตรวจแล้ว'},
	{key: 'skipped', label: 'ไม่ใช้รายการนี้', changeType: 'skipped'},
];
const THAI_MONTHS = {
	'มกราคม': '01', 'ม.ค.': '01', 'มค': '01',
	'กุมภาพันธ์': '02', 'ก.พ.': '02', 'กพ': '02',
	'มีนาคม': '03', 'มี.ค.': '03', 'มีค': '03',
	'เมษายน': '04', 'เม.ย.': '04', 'เมย': '04',
	'พฤษภาคม': '05', 'พ.ค.': '05', 'พค': '05',
	'มิถุนายน': '06', 'มิ.ย.': '06', 'มิย': '06',
	'กรกฎาคม': '07', 'ก.ค.': '07', 'กค': '07',
	'สิงหาคม': '08', 'ส.ค.': '08', 'สค': '08',
	'กันยายน': '09', 'ก.ย.': '09', 'กย': '09',
	'ตุลาคม': '10', 'ต.ค.': '10', 'ตค': '10',
	'พฤศจิกายน': '11', 'พ.ย.': '11', 'พย': '11',
	'ธันวาคม': '12', 'ธ.ค.': '12', 'ธค': '12',
};
function clone(value) { return JSON.parse(JSON.stringify(value || null)); }
function draftKey() { return 'ksk-review:draft:v1:' + DATA.client_key + ':' + DATA.group + ':' + DATA.content_fingerprint; }
function parseBucket(group) {
	const g = String(group || '');
	if (g === 'bank_statement') return {category: 'bank_statement', vat: null};
	const legacy = {expense_vat: ['expense', 'vat'], expense_nonvat: ['expense', 'non_vat'], income_vat: ['income', 'vat'], income_nonvat: ['income', 'non_vat']};
	if (legacy[g]) return {category: legacy[g][0], vat: legacy[g][1]};
	const parts = g.split('/');
	if ((parts[0] === 'expense' || parts[0] === 'income') && ['vat', 'non_vat', 'mixed'].includes(parts[1])) return {category: parts[0], vat: parts[1]};
	return null;
}
function peakTemplateForGroup(group) {
	const bucket = parseBucket(group);
	if (!bucket) return null;
	const label = (DATA.review_label && String(DATA.review_label).trim()) || (bucket.category + (bucket.vat ? ' ' + bucket.vat : ''));
	const filename = 'นำเข้า PEAK - ' + label + '.xlsx';
	if (bucket.category === 'expense') return {template_name: 'PEAK_ImportExpense', sheet_name: 'Import_Expenses', type: 'expense', filename};
	if (bucket.category === 'income') return {template_name: 'PEAK_ImportReceipt', sheet_name: 'Import_Receipts', type: 'revenue', filename};
	return {template_name: 'PEAK_ImportJournal', sheet_name: 'Import_Journal', type: 'journal', filename};
}
function splitAccountKey(key) {
	const parts = String(key || '').split('||');
	return {account_code: parts[0] || '', sub_code: parts[1] || ''};
}
function normalizePeakYear(year) {
	const n = Number(year);
	if (!Number.isFinite(n)) return String(year || '');
	return String(n > 2400 ? n - 543 : n).padStart(4, '0');
}
function normalizeDateForPeak(value) {
	const text = String(value ?? '').trim();
	if (!text) return '';
	const thai = text.replace(/[ ]+/g, ' ').split(' ');
	if (thai.length >= 3) {
		const day = thai[0].replace(/[^0-9]/g, '');
		const month = THAI_MONTHS[thai[1]];
		const year = thai[2].replace(/[^0-9]/g, '');
		if (day && month && year) return normalizePeakYear(year) + month + day.padStart(2, '0');
	}
	const ymd = text.match(/^([0-9]{4})[-/. ]([0-9]{1,2})[-/. ]([0-9]{1,2})$/);
	if (ymd) return normalizePeakYear(ymd[1]) + ymd[2].padStart(2, '0') + ymd[3].padStart(2, '0');
	const dmy = text.match(/^([0-9]{1,2})[-/. ]([0-9]{1,2})[-/. ]([0-9]{4})$/);
	if (dmy) return normalizePeakYear(dmy[3]) + dmy[2].padStart(2, '0') + dmy[1].padStart(2, '0');
	const digits = text.replace(/[^0-9]/g, '');
	if (digits.length === 8) return normalizePeakYear(digits.slice(0, 4)) + digits.slice(4);
	return text;
}
function normalizeTaxId(value) {
	return String(value ?? '').replace(/[^0-9]/g, '');
}
function amountNumberOrNull(value) {
	const text = String(value ?? '').replace(/,/g, '').trim();
	if (!text) return null;
	const n = Number(text);
	return Number.isFinite(n) ? n : null;
}
// Shared with the generator module (single implementation, unit-tested there):
// snapWhtRate / inferPndType / yearFromPeakDate / modalYear / derivePeakDate.
${snapWhtRate.toString()}
${inferPndType.toString()}
${yearFromPeakDate.toString()}
${modalYear.toString()}
${derivePeakDate.toString()}
function makeState(page) {
	return {
		facts: clone(page.facts) || {},
		status: page.initial_status || 'reviewed',
		note: '',
		committed: false,
		skipped: false,
		lines: (page.lines || []).map(function(line, index) {
			const accountKey = (line.account_code || line.sub_code) ? (line.account_code || '') + '||' + (line.sub_code || '') : '';
			return {
				local_id: page.ref + ':' + index,
				description: line.description || '',
				qty: line.qty ?? '',
				unit: line.unit || '',
				unit_price: line.unit_price ?? '',
				amount: line.amount ?? '',
				amount_includes_vat: line.amount_includes_vat ?? null,
				vat_treatment: line.vat_treatment || null,
				account_key: accountKey,
				confidence: line.confidence || 'low',
				reason: line.reason || '',
				needs_review: !!line.needs_review,
			};
		}),
	};
}
function normalizeAmount(value) {
	const n = Number(String(value ?? '').replace(/,/g, ''));
	return Number.isFinite(n) ? n : 0;
}
function formatBaht(value) {
	const n = normalizeAmount(value);
	if (!n && value !== 0 && value !== '0') return '';
	return n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' บาท';
}
function formatNumber(value) {
	const n = normalizeAmount(value);
	if (!n && value !== 0 && value !== '0') return '';
	return n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}
function formatStatementDate(iso) {
	const match = String(iso || '').match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})/);
	if (!match) return iso || '';
	return match[3] + '/' + match[2] + '/' + match[1];
}
// Statement source (StatementSource) carries no precomputed source_kind (unlike
// ReviewPage, where review-groups.ts's resolveSource does it server-side) — the
// bank_statement bucket's resolveStatementSource only rewrites paths, so infer
// pdf/image/other from the file extension client-side.
function sourceKindFromExt(path) {
	if (!path) return null;
	const match = String(path).toLowerCase().match(/\.[a-z0-9]+$/);
	if (!match) return 'other';
	if (match[0] === '.pdf') return 'pdf';
	if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(match[0])) return 'image';
	return 'other';
}
// Per-statement draft state (schema ksk_review_statement_draft.v1, PRD §D4):
// one entry per statements[] group folder, seeding bank_account_key from the
// schema's proposed statement.bank_account_code/bank_sub_code (reviewer-editable)
// and copying each row's static fields alongside the editable/review ones.
function makeStatementState(entry) {
	const statement = entry.statement || {};
	const bankAccount = statement.bank_account_code;
	const bankSub = statement.bank_sub_code;
	return {
		group_id: entry.group_id,
		bank_account_key: bankAccount ? (bankAccount + '||' + (bankSub || '')) : '',
		rows: (entry.rows || []).map(function(row) {
			const accountKey = (row.account_code || row.sub_code) ? (row.account_code || '') + '||' + (row.sub_code || '') : '';
			return {
				row_index: row.row_index,
				date_iso: row.date_iso,
				time: row.time,
				counterparty: row.counterparty,
				direction: row.direction,
				balance: row.balance,
				description: row.description || '',
				amount: row.amount ?? '',
				account_key: accountKey,
				confidence: row.confidence || 'low',
				reason: row.reason || '',
				needs_review: !!row.needs_review,
				reviewed: false,
				skipped: false,
				note: '',
			};
		}),
	};
}
const app = Vue.createApp({
	data() {
		return {
			data: DATA,
			currentIndex: 0,
			states: DATA.kind === 'statement' ? DATA.statements.map(makeStatementState) : DATA.pages.map(makeState),
			primaryLeftFields: PRIMARY_LEFT_FIELDS,
			primaryRightFields: PRIMARY_RIGHT_FIELDS,
			summaryFields: SUMMARY_FIELDS,
			extraFields: EXTRA_FIELDS,
			directionOptions: DIRECTION_OPTIONS,
			filterDirection: 'all',
			filterNeedsReviewOnly: false,
			filterAccountKeyFilter: '',
			filterSearch: '',
			message: '',
			toast: { message: '', visible: false },
			toastTimer: null,
			exportPreview: null,
			draftStatus: '',
			draftTimer: null,
			zoom: 1,
			panX: 0,
			panY: 0,
			dragging: false,
			dragStartX: 0,
			dragStartY: 0,
			startPanX: 0,
			startPanY: 0,
			evidenceWidth: null,
			paneResize: { active: false, startX: 0, startWidth: 0 },
		};
	},
	computed: {
		// DATA.kind is optional/absent for document buckets (see ReviewData.kind
		// in review-template.ts) and "statement" for the bank_statement bucket's
		// ksk_review_statement_html_data.v1 payload (PRD §D2/§D3).
		isStatement() { return this.data.kind === 'statement'; },
		// Draggable pane divider: when the user has dragged the gutter, override the
		// CSS-default grid ratio with an explicit evidence-pane pixel width; before
		// any drag (evidenceWidth === null) fall back to the responsive class default.
		paneStyle() {
			if (this.evidenceWidth == null) return {};
			return { gridTemplateColumns: this.evidenceWidth + 'px 10px minmax(0, 1fr)' };
		},
		currentPage() { return this.data.pages[this.currentIndex]; },
		currentState() { return this.states[this.currentIndex]; },
		// Statement analogs of currentPage/currentState: currentStatement is the
		// static embedded entry (statements[i]), currentStatementState is its
		// mutable draft (states[i], a StatementDraftState).
		currentStatement() { return this.isStatement ? this.data.statements[this.currentIndex] : null; },
		currentStatementState() { return this.isStatement ? this.states[this.currentIndex] : null; },
		// Selector strip ("like pages today", PRD §D3) iterates document pages or
		// statement groups depending on kind; selectorKey/Total/Subtitle/Tag below
		// normalize the differing shapes for the shared .groups markup.
		selectorItems() { return this.isStatement ? this.data.statements : this.data.pages; },
		// Evidence pane (PDF/image preview) is shared as-is; StatementSource has
		// no precomputed source_kind (unlike ReviewPage), so derive it here.
		evidenceMeta() {
			if (!this.isStatement) return this.currentPage;
			const source = (this.currentStatement && this.currentStatement.source) || {};
			return {
				source_src: source.source_src || null,
				source_page: source.source_page || null,
				source_kind: sourceKindFromExt(source.source_src),
				image_src: source.image_src || null,
				sheet_preview: source.sheet_preview || null,
			};
		},
			imageSrc() {
				const p = this.evidenceMeta;
				return (p.source_kind === 'image' && p.source_src) ? p.source_src : p.image_src;
			},
			pdfSrc() {
				const p = this.evidenceMeta;
				if (!p.source_src) return '';
				return p.source_src + '#page=' + (p.source_page || 1) + '&view=FitH&pagemode=none&toolbar=1';
			},
			previewKind() {
				const p = this.evidenceMeta;
				if (p.source_kind === 'pdf' && p.source_src) return 'pdf';
				if (p.sheet_preview && p.sheet_preview.rows && p.sheet_preview.rows.length) return 'sheet';
				if ((p.source_kind === 'image' && p.source_src) || p.image_src) return 'image';
				if (p.source_kind === 'other' && p.source_src) return 'file';
				return 'none';
			},
		imageStyle() { return { transform: 'translate(' + this.panX + 'px, ' + this.panY + 'px) scale(' + this.zoom + ')' }; },
		isMixedBucket() {
			const bucket = parseBucket(this.data.group);
			return !!bucket && bucket.vat === 'mixed';
		},
		// Navbar count: document buckets show the static bucket-wide page count;
		// statements show reviewed-row progress across the whole bucket instead
		// (PRD §D4 "navbar count shows reviewed progress x/66").
		navCountLabel() {
			if (!this.isStatement) return this.data.pages.length + ' เอกสาร';
			const totals = this.statementTotals;
			return totals.reviewed + '/' + totals.total + ' ตรวจแล้ว';
		},
		statementTotals() {
			let total = 0, reviewed = 0;
			if (this.isStatement) {
				for (const state of this.states) for (const row of state.rows) { total++; if (row.reviewed) reviewed++; }
			}
			return { total, reviewed };
		},
		// Footer counts (PRD §D3 point 4), scoped to the currently open statement
		// (mirrors coaTotals being scoped to the current document below).
		currentStatementCounts() {
			if (!this.isStatement) return null;
			const rows = (this.currentStatementState && this.currentStatementState.rows) || [];
			let reviewed = 0, needsReview = 0, skipped = 0;
			for (const row of rows) {
				if (row.skipped) { skipped++; continue; }
				if (row.reviewed) reviewed++;
				if (row.needs_review) needsReview++;
			}
			return { total: rows.length, reviewed, needsReview, skipped };
		},
		// Integrity check (PRD §D3 point 1): opening + Σ(in) − Σ(out) vs closing,
		// to the satang.
		integrityCheck() {
			if (!this.isStatement || !this.currentStatement) return null;
			const statement = this.currentStatement.statement || {};
			const rows = (this.currentStatementState && this.currentStatementState.rows) || [];
			let sumIn = 0, sumOut = 0;
			for (const row of rows) {
				const amount = normalizeAmount(row.amount);
				if (row.direction === 'in') sumIn += amount; else sumOut += amount;
			}
			const opening = normalizeAmount(statement.opening_balance);
			const closing = normalizeAmount(statement.closing_balance);
			const computed = Math.round((opening + sumIn - sumOut) * 100) / 100;
			const diff = Math.round((computed - closing) * 100) / 100;
			return { computed, diff, ok: Math.abs(diff) < 0.005 };
		},
		// Filter bar (PRD §D3 point 2): direction / needs-review-only / COA / free text.
		filteredRows() {
			if (!this.isStatement || !this.currentStatementState) return [];
			const search = this.filterSearch.trim().toLowerCase();
			return this.currentStatementState.rows
				.map((row, index) => ({ row, index }))
				.filter(({ row }) => {
					if (this.filterDirection !== 'all' && row.direction !== this.filterDirection) return false;
					if (this.filterNeedsReviewOnly && !row.needs_review) return false;
					if (this.filterAccountKeyFilter && row.account_key !== this.filterAccountKeyFilter) return false;
					if (search) {
						const haystack = ((row.counterparty || '') + ' ' + (row.description || '')).toLowerCase();
						if (!haystack.includes(search)) return false;
					}
					return true;
				});
		},
		// Export blocker (PRD §D5): bank_account_code/bank_account_key unset
		// disables export. See buildStatementJournalRows below for the row builder.
		exportDisabled() {
			if (!this.isStatement) return false;
			return !(this.currentStatementState && this.currentStatementState.bank_account_key);
		},
		draftSchema() { return this.isStatement ? STATEMENT_DRAFT_SCHEMA : DRAFT_SCHEMA; },
		coaTotals() {
			const items = this.isStatement ? ((this.currentStatementState && this.currentStatementState.rows) || []) : this.currentState.lines;
			const rows = new Map();
			for (const item of items) {
				if (item.skipped) continue;
				if (!item.account_key) continue;
				const current = rows.get(item.account_key) || {key: item.account_key, label: this.coaLabelByKey(item.account_key), total: 0};
				current.total += normalizeAmount(item.amount);
				rows.set(item.account_key, current);
			}
			return Array.from(rows.values());
		},
	},
	watch: {
		states: { deep: true, handler() { this.queueSaveDraft(); } },
	},
	mounted() {
		this.restoreDraft();
		this.refreshIcons();
	},
	updated() { this.refreshIcons(); },
	methods: {
		refreshIcons() { if (window.lucide) window.lucide.createIcons(); },
		coaKey(row) { return (row.account_code || '') + '||' + (row.sub_code || ''); },
		coaLabel(row) {
			const code = row.sub_code ? row.account_code + '/' + row.sub_code : row.account_code;
			const name = row.name_th || row.name_en || '';
			return name ? code + ' - ' + name : code;
		},
		coaLabelByKey(key) {
			const row = this.data.coa_rows.find((item) => this.coaKey(item) === key);
			return row ? this.coaLabel(row) : 'ยังไม่ระบุ';
		},
		formatBaht,
		formatNumber,
		formatStatementDate,
		statusLabel(status) { return STATUS_LABELS[status] || status; },
		pageStatus(index) {
			const state = this.states[index];
			if (this.isStatement) {
				const rows = state.rows;
				if (!rows.length) return 'unreviewed';
				if (rows.every((row) => row.skipped)) return 'skipped';
				const pending = rows.filter((row) => !row.skipped);
				if (pending.every((row) => row.reviewed)) return 'reviewed';
				if (pending.some((row) => row.needs_review && !row.reviewed)) return 'needs_attention';
				return 'unreviewed';
			}
			if (state.skipped) return 'skipped';
			if (state.status === 'needs_attention') return 'needs_attention';
			return state.committed ? 'reviewed' : 'unreviewed';
		},
		pageTitle(page) {
			if (this.isStatement) {
				const statement = page.statement || {};
				return page.label || [statement.bank, statement.account_no].filter(Boolean).join(' · ') || page.group_id;
			}
			return [page.facts.seller, page.facts.document_no].filter(Boolean).join(' · ') || page.short_ref;
		},
		// Selector strip normalizers (documents use ReviewPage fields, statements
		// use StatementEmbedded fields) — keeps the shared .groups markup as-is.
		selectorKey(item, index) { return this.isStatement ? (item.group_id || index) : item.ref; },
		selectorTotal(item) {
			if (this.isStatement) return formatBaht((item.statement || {}).closing_balance);
			return formatBaht(item.facts.total);
		},
		selectorSubtitle(item) { return this.isStatement ? (item.group_id || '') : item.short_ref; },
		selectorTag(item) {
			if (this.isStatement) return (item.statement || {}).account_no || null;
			return item.group_label || item.group_id || null;
		},
		toggleRowSkip(row) { row.skipped = !row.skipped; },
		setSuspenseFilter() {
			const row = this.data.coa_rows.find((item) => item.account_code === '999999');
			this.filterAccountKeyFilter = row ? this.coaKey(row) : '999999||';
		},
		lineHint(line) {
			const parts = [];
			if (line.confidence) parts.push('confidence: ' + line.confidence);
			if (line.needs_review) parts.push('ต้องตรวจสอบ');
			if (line.reason) parts.push(line.reason);
			return parts.join(' · ');
		},
		scrollGroups(event) {
			const el = event.currentTarget;
			if (!el || el.scrollWidth <= el.clientWidth) return;
			// Horizontal-dominant gestures (trackpad swipe) scroll natively via
			// overflow-x with momentum intact; only translate vertical-dominant
			// input (mouse wheel) into horizontal scroll.
			if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
			let delta = event.deltaY;
			if (!delta) return;
			if (event.deltaMode === 1) delta *= 16;
			const max = el.scrollWidth - el.clientWidth;
			if ((delta < 0 && el.scrollLeft <= 0) || (delta > 0 && el.scrollLeft >= max)) return;
			event.preventDefault();
			el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + delta));
		},
		selectPage(index) {
			this.currentIndex = index;
			this.resetPreview();
		},
		addLine() {
			this.currentState.lines.push({local_id: this.currentPage.ref + ':new:' + Date.now(), description: '', qty: '', unit: '', unit_price: '', amount: '', amount_includes_vat: null, vat_treatment: null, account_key: '', confidence: 'low', reason: '', needs_review: true});
		},
		removeLine(index) { this.currentState.lines.splice(index, 1); },
		toggleSkip() {
			this.currentState.skipped = !this.currentState.skipped;
		},
		saveAndNext() {
			this.currentState.committed = true;
			this.currentState.skipped = false;
			if (this.currentState.status === 'needs_attention') this.currentState.status = 'reviewed';
			this.saveDraft();
			if (this.currentIndex < this.data.pages.length - 1) this.selectPage(this.currentIndex + 1);
			else this.message = 'ตรวจครบทุกเอกสารในกลุ่มนี้แล้ว · กดส่งออก XLSX เพื่อดูตัวอย่างก่อนดาวน์โหลด';
		},
		showExportPreview() {
			if (this.exportDisabled) {
				this.exportPreview = null;
				this.message = 'กรุณาเลือกผังบัญชีธนาคาร (บัญชีธนาคาร GL) ก่อนส่งออก';
				return;
			}
			// Statement export routes on DATA.kind (PRD §D5), replacing the
			// peakTemplateForGroup('bank_statement') name-parsing path with the
			// real PEAK_ImportJournal layout; expense/revenue routing (and the
			// legacy document-shaped 'journal' type) still go through
			// peakTemplateForGroup unchanged.
			const template = this.isStatement
				? {template_name: 'PEAK_ImportJournal', sheet_name: 'Import Multiple Journal', type: 'statement_journal', filename: 'peak_import_bank_statement.xlsx'}
				: peakTemplateForGroup(this.data.group);
			if (!template) {
				this.exportPreview = null;
				this.message = 'ยังไม่รองรับการส่งออกสำหรับกลุ่มนี้';
				return;
			}
			const preview = this.buildExportPreview(template);
			if (!preview.committed_count) {
				this.exportPreview = null;
				this.message = 'ยังไม่มีเอกสารที่บันทึกแล้วสำหรับส่งออก';
				return;
			}
			this.exportPreview = preview;
			this.message = preview.warnings.length ? 'พบข้อมูลว่างในตัวอย่างส่งออก ตรวจสอบก่อนดาวน์โหลด XLSX' : '';
			this.saveDraft();
		},
		closeExportPreview() { this.exportPreview = null; },
		showToast(msg) {
			clearTimeout(this.toastTimer);
			this.toast = { message: msg, visible: false };
			this.$nextTick(() => {
				this.toast.visible = true;
				this.toastTimer = setTimeout(() => { this.toast.visible = false; }, 2500);
			});
		},
		buildExportPreview(template) {
			const result = this.isStatement
				? this.buildStatementJournalRows()
				: template.type === 'journal'
				? this.buildJournalRows()
				: this.buildExpenseOrRevenueRows(template);
			const { rows, warnings, committedCount } = result;
			const changeLog = this.buildChangeLog();

			const headers = template.type === 'statement_journal' ? STATEMENT_JOURNAL_HEADERS
				: template.type === 'journal' ? PEAK_JOURNAL_HEADERS
				: template.type === 'revenue' ? PEAK_REVENUE_HEADERS
				: PEAK_EXPENSE_HEADERS;
			const previewColumns = template.type === 'statement_journal' ? EXPORT_PREVIEW_COLUMNS_STATEMENT
				: template.type === 'journal' ? EXPORT_PREVIEW_COLUMNS_JOURNAL
				: template.type === 'revenue' ? EXPORT_PREVIEW_COLUMNS_REVENUE
				: EXPORT_PREVIEW_COLUMNS;

			// Preview stats (PRD §D5): for the statement journal, rows.length is
			// 2x the entry (transaction) count since each transaction emits a
			// balanced debit/credit leg pair; the balance block surfaces
			// Sigma-debit vs Sigma-credit as an explicit reconciliation check.
			return {
				template_name: template.template_name,
				sheet_name: template.sheet_name,
				filename: template.filename,
				headers: headers,
				preview_columns: previewColumns,
				rows,
				warnings,
				committed_count: committedCount,
				uncommitted_count: this.isStatement ? (result.totalCount - committedCount) : (this.states.length - committedCount),
				change_log: changeLog,
				change_count: changeLog.length,
				balance: this.isStatement ? {debit: result.debitTotal, credit: result.creditTotal, ok: Math.abs(result.debitTotal - result.creditTotal) < 0.005} : null,
			};
		},
		buildChangeLog() {
			return this.isStatement ? this.buildStatementChangeLog() : this.buildDocumentChangeLog();
		},
		changeDisplayValue(value) {
			if (value === null || value === undefined) return '';
			if (typeof value === 'boolean') return value ? 'ใช่' : 'ไม่ใช่';
			if (typeof value === 'object') return JSON.stringify(value);
			return value;
		},
		changeComparableValue(value) {
			const display = this.changeDisplayValue(value);
			return String(display ?? '').trim();
		},
		accountLabelFromParts(accountCode, subCode, accountName) {
			const code = String(accountCode || '');
			const sub = String(subCode || '');
			const label = sub ? code + ':' + sub : code;
			const name = String(accountName || '');
			return label && name ? label + ' - ' + name : label;
		},
		accountLabelFromKey(key) {
			if (!key) return '';
			const account = splitAccountKey(key);
			return this.coaLabelByKey(account.account_code + '||' + account.sub_code);
		},
		sourceAccountLabel(source) {
			source = source || {};
			return this.accountLabelFromParts(source.account_code, source.sub_code, source.account_name_th || source.account_name_en);
		},
		changeDocumentLabel(page) {
			const facts = (page && page.facts) || {};
			const title = page ? this.pageTitle(page) : '';
			const docNo = String(facts.document_no || '').trim();
			return docNo && !String(title).includes(docNo) ? title + ' (' + docNo + ')' : title;
		},
		changeStatementLabel(entry) {
			if (!entry) return '';
			const statement = entry.statement || {};
			const title = this.pageTitle(entry);
			const accountNo = String(statement.account_no || '').trim();
			return accountNo && !String(title).includes(accountNo) ? title + ' (' + accountNo + ')' : title;
		},
		addChangeLogRow(rows, docLabel, lineLabel, fieldLabel, aiValue, humanValue, confidence, reason, changeType, aiCompareValue, humanCompareValue) {
			const hasCompareOverride = aiCompareValue !== undefined || humanCompareValue !== undefined;
			const aiCompare = hasCompareOverride ? aiCompareValue : aiValue;
			const humanCompare = hasCompareOverride ? humanCompareValue : humanValue;
			if (this.changeComparableValue(aiCompare) === this.changeComparableValue(humanCompare)) return;
			rows.push({
				cells: [
					docLabel || '',
					lineLabel || '',
					fieldLabel || '',
					this.changeDisplayValue(aiValue),
					this.changeDisplayValue(humanValue),
					confidence || '',
					reason || '',
					changeType || 'changed',
				],
			});
		},
		lineSourceIndex(page, line, fallbackIndex) {
			if (!line || !line.local_id || !page || !page.ref) return fallbackIndex;
			const prefix = page.ref + ':';
			if (!String(line.local_id).startsWith(prefix)) return fallbackIndex;
			const rest = String(line.local_id).slice(prefix.length);
			if (rest.startsWith('new:')) return -1;
			const value = Number(rest);
			return Number.isInteger(value) ? value : fallbackIndex;
		},
		sourceLineValue(source, key) {
			source = source || {};
			if (key === 'account_key') return this.sourceAccountLabel(source);
			return source[key];
		},
		sourceLineAccountKey(source) {
			source = source || {};
			return (source.account_code || source.sub_code) ? (source.account_code || '') + '||' + (source.sub_code || '') : '';
		},
		stateLineValue(line, key) {
			line = line || {};
			if (key === 'account_key') return this.accountLabelFromKey(line.account_key);
			return line[key];
		},
		buildDocumentChangeLog() {
			const rows = [];
			for (let index = 0; index < this.states.length; index++) {
				const page = this.data.pages[index] || {};
				const state = this.states[index] || {};
				const docLabel = this.changeDocumentLabel(page);
				const sourceFacts = page.facts || {};
				const stateFacts = state.facts || {};
				for (const field of CHANGE_LOG_FACT_FIELDS) {
					this.addChangeLogRow(rows, docLabel, '', field.label, sourceFacts[field.key], stateFacts[field.key], '', '', 'changed');
				}
				this.addChangeLogRow(rows, docLabel, '', 'สถานะ', page.initial_status || 'reviewed', state.status || '', '', '', 'changed');
				this.addChangeLogRow(rows, docLabel, '', 'ไม่ใช้ข้อมูลหน้านี้', false, !!state.skipped, '', '', 'skipped');
				if (this.changeComparableValue(state.note)) this.addChangeLogRow(rows, docLabel, '', 'บันทึกผู้ตรวจ', '', state.note, '', '', 'added-note');

				const sourceLines = page.lines || [];
				const seenSourceIndexes = new Set();
				const stateLines = state.lines || [];
				for (let lineIndex = 0; lineIndex < stateLines.length; lineIndex++) {
					const line = stateLines[lineIndex] || {};
					const sourceIndex = this.lineSourceIndex(page, line, lineIndex);
					const source = sourceIndex >= 0 ? (sourceLines[sourceIndex] || {}) : {};
					if (sourceIndex >= 0) seenSourceIndexes.add(sourceIndex);
					const lineLabel = sourceIndex >= 0 ? ('บรรทัด ' + (sourceIndex + 1)) : ('บรรทัดใหม่ ' + (lineIndex + 1));
					for (const field of CHANGE_LOG_LINE_FIELDS) {
						const isAccount = field.key === 'account_key';
						this.addChangeLogRow(
							rows,
							docLabel,
							lineLabel,
							field.label,
							this.sourceLineValue(source, field.key),
							this.stateLineValue(line, field.key),
							source.confidence || line.confidence || '',
							source.reason || line.reason || '',
							'changed',
							isAccount ? this.sourceLineAccountKey(source) : undefined,
							isAccount ? line.account_key : undefined,
						);
					}
				}
				for (let sourceIndex = 0; sourceIndex < sourceLines.length; sourceIndex++) {
					if (seenSourceIndexes.has(sourceIndex)) continue;
					const source = sourceLines[sourceIndex] || {};
					const lineLabel = 'บรรทัด ' + (sourceIndex + 1);
					for (const field of CHANGE_LOG_LINE_FIELDS) {
						const isAccount = field.key === 'account_key';
						this.addChangeLogRow(
							rows,
							docLabel,
							lineLabel,
							field.label,
							this.sourceLineValue(source, field.key),
							'',
							source.confidence || '',
							source.reason || '',
							'changed',
							isAccount ? this.sourceLineAccountKey(source) : undefined,
							'',
						);
					}
				}
			}
			return rows;
		},
		buildStatementChangeLog() {
			const rows = [];
			for (let index = 0; index < this.states.length; index++) {
				const entry = this.data.statements[index] || {};
				const state = this.states[index] || {};
				const docLabel = this.changeStatementLabel(entry);
				const statement = entry.statement || {};
				const sourceBankKey = statement.bank_account_code ? (statement.bank_account_code + '||' + (statement.bank_sub_code || '')) : '';
				this.addChangeLogRow(rows, docLabel, '', 'บัญชีธนาคาร (ผังบัญชี GL)', this.accountLabelFromKey(sourceBankKey), this.accountLabelFromKey(state.bank_account_key), '', '', 'changed', sourceBankKey, state.bank_account_key);

				const sourceByIndex = new Map();
				for (const sourceRow of (entry.rows || [])) sourceByIndex.set(sourceRow.row_index, sourceRow);
				for (const row of (state.rows || [])) {
					const source = sourceByIndex.get(row.row_index) || {};
					const lineLabel = 'รายการ ' + (Number(row.row_index) + 1);
					for (const field of CHANGE_LOG_STATEMENT_ROW_FIELDS) {
						const isAccount = field.key === 'account_key';
						const aiValue = field.key === 'account_key'
							? this.sourceAccountLabel(source)
							: field.key === 'reviewed' || field.key === 'skipped'
							? false
							: source[field.key];
						const humanValue = field.key === 'account_key' ? this.accountLabelFromKey(row.account_key) : row[field.key];
						this.addChangeLogRow(
							rows,
							docLabel,
							lineLabel,
							field.label,
							aiValue,
							humanValue,
							source.confidence || row.confidence || '',
							source.reason || row.reason || '',
							field.changeType || 'changed',
							isAccount ? this.sourceLineAccountKey(source) : undefined,
							isAccount ? row.account_key : undefined,
						);
					}
				}
			}
			return rows;
		},
		buildExpenseOrRevenueRows(template) {
			const rows = [];
			const warnings = [];
			let committedCount = 0;
			let sequence = 1;
			// Decision Policy rule 11: the accounting period's year is the modal
			// year across every document date on this page (ties → later year).
			const periodYear = modalYear(this.states.map((state) => normalizeDateForPeak(((state || {}).facts || {}).date)));
			for (let index = 0; index < this.states.length; index++) {
				const state = this.states[index];
				if (!state.committed || state.skipped) continue;
				const page = this.data.pages[index];
				const title = this.pageTitle(page);
				const facts = state.facts || {};
				const docSequence = sequence++;
				const printedDate = normalizeDateForPeak(facts.date);
				const derived = derivePeakDate(printedDate, periodYear);
				const date = derived.date;
				const noteParts = [];
				if (derived.shifted) noteParts.push('วันที่จริงบนใบ: ' + String(facts.date ?? '').trim());
				if (derived.suspicious) warnings.push(title + ': ปีของวันที่เอกสาร (' + String(facts.date ?? '').trim() + ') อยู่หลังปีของงวด ' + periodYear + ' — น่าจะอ่านวันที่ผิด ตรวจสอบก่อนส่งออก');
				const note = noteParts.join(' · ');
				const taxId = normalizeTaxId(facts.seller_tax_id);
				const documentNo = String(facts.document_no ?? '').trim();
				const lineGroups = this.groupLinesForExport(state, page);
				committedCount++;
				if (!date) warnings.push(title + ': วันที่เอกสารว่าง');
				if (!taxId) warnings.push(title + ': เลขทะเบียนผู้ขายว่าง');
				if (!documentNo) warnings.push(title + ': เลขที่ใบกำกับฯว่าง');
				if (!lineGroups.length) warnings.push(title + ': ไม่มีรายการสำหรับส่งออก');
				// WHT columns come from the document's printed withheld amount only:
				// the ratio must snap to a standard rate, otherwise the columns stay
				// empty and a human resolves the warning. Never key a guessed rate.
				let whtRate = '';
				let pnd = '';
				const whtAmount = amountNumberOrNull(facts.wht);
				if (whtAmount !== null && whtAmount > 0) {
					const subtotal = amountNumberOrNull(facts.subtotal);
					const total = amountNumberOrNull(facts.total);
					const vatAmount = amountNumberOrNull(facts.vat);
					const base = subtotal !== null ? subtotal : (total !== null && vatAmount !== null ? total - vatAmount : null);
					const rate = snapWhtRate(whtAmount, base);
					if (rate === null) {
						if (base === null || !(base > 0)) warnings.push(title + ': มีหัก ณ ที่จ่าย ' + whtAmount + ' แต่ไม่มียอดฐานก่อน VAT สำหรับคำนวณอัตรา — กรอกอัตราเอง');
						else warnings.push(title + ': อัตราหัก ณ ที่จ่าย ' + (whtAmount / base).toFixed(4) + ' (' + whtAmount + ' / ' + base + ') ไม่ตรงกับอัตรามาตรฐาน — กรอกอัตราเอง');
					} else {
						whtRate = String(rate);
						// ภ.ง.ด.: expense withholds from the seller, revenue is
						// withheld by the customer (buyer on the document).
						const counterparty = template.type === 'revenue' ? facts.buyer : facts.seller;
						const pndType = inferPndType(counterparty);
						if (pndType === null) warnings.push(title + ': ระบุ ภ.ง.ด. จากชื่อคู่ค้า "' + String(counterparty ?? '').trim() + '" ไม่ได้ — กรอกเอง');
						else pnd = pndType;
					}
				}
				for (const group of lineGroups) {
					if (!group.account_code) warnings.push(title + ': บัญชีว่าง');
					if (group.amount === '') warnings.push(title + ': จำนวนเงินว่าง');
					const vat = this.vatSettingsForLineGroup(group, state, page);
					rows.push({
						page_title: title,
						cells: [docSequence, date, '', '', taxId, '00000', documentNo, date, date, vat.price_type, group.account_code, group.description, 1, group.amount, vat.vat_rate, whtRate, 'CSH001', group.amount, pnd, note, ''],
					});
				}
			}
			return { rows, warnings, committedCount };
		},
		// Real PEAK_ImportJournal builder (PRD §D5), verified against
		// samples/export-file/PEAK_ImportJournal.xlsx: sheet "Import Multiple
		// Journal", 12 columns, one journal entry per transaction (only rows with
		// reviewed && !skipped), two balanced rows sharing one ลำดับที. Row layout
		// mirrors the template's own example (row2/row3 in the sample file): the
		// first physical row of an entry ("header" row) is always the debit leg
		// and carries สมุดบัญชี/วันที่รายการ/คำอธิบายการบันทึกบัญชี; the second
		// ("continuation") row is always the credit leg and repeats only ลำดับที
		// + its own account/sub-code + the credit amount, leaving the rest blank.
		buildStatementJournalRows() {
			const rows = [];
			const warnings = [];
			let committedCount = 0;
			let totalCount = 0;
			let sequence = 1;
			let debitTotal = 0;
			let creditTotal = 0;
			for (const state of this.states) {
				const bankAccount = splitAccountKey(state.bank_account_key);
				for (const row of (state.rows || [])) {
					totalCount++;
					if (!row.reviewed || row.skipped) continue;
					const title = (row.counterparty || row.description || ('รายการที่ ' + (row.row_index + 1))) + ' (' + formatStatementDate(row.date_iso) + ')';
					const date = normalizeDateForPeak(row.date_iso);
					const mapped = splitAccountKey(row.account_key);
					const amountValue = amountNumberOrNull(row.amount);
					const amount = amountValue === null ? 0 : Math.round(Math.abs(amountValue) * 100) / 100;
					if (!date) warnings.push(title + ': วันที่รายการว่าง');
					if (!mapped.account_code) warnings.push(title + ': ยังไม่ได้แมปบัญชี');
					if (amountValue === null || amountValue === 0) warnings.push(title + ': จำนวนเงินว่างหรือเป็นศูนย์');
					if (mapped.account_code === '999999') warnings.push(title + ': ยังอยู่ในบัญชีพัก (999999) — ตรวจสอบก่อนนำเข้า PEAK');
					committedCount++;
					const seq = sequence++;
					const description = String(row.counterparty || row.description || '').trim();
					// direction 'out': debit = mapped account, credit = bank account.
					// direction 'in': debit = bank account, credit = mapped account.
					const debitAccount = row.direction === 'out' ? mapped : bankAccount;
					const creditAccount = row.direction === 'out' ? bankAccount : mapped;
					rows.push({
						page_title: title,
						cells: [seq, STATEMENT_JOURNAL_BOOK_NAME, date, '', '', description, debitAccount.account_code, debitAccount.sub_code, '', amount, '', ''],
					});
					rows.push({
						page_title: title,
						cells: [seq, '', '', '', '', '', creditAccount.account_code, creditAccount.sub_code, '', '', amount, ''],
					});
					debitTotal += amount;
					creditTotal += amount;
				}
			}
			debitTotal = Math.round(debitTotal * 100) / 100;
			creditTotal = Math.round(creditTotal * 100) / 100;
			if (Math.abs(debitTotal - creditTotal) >= 0.01) warnings.push('ยอดเดบิตรวม (' + formatNumber(debitTotal) + ') ไม่เท่ากับยอดเครดิตรวม (' + formatNumber(creditTotal) + ')');
			return { rows, warnings, committedCount, totalCount, debitTotal, creditTotal };
		},
		buildJournalRows() {
			const rows = [];
			const warnings = [];
			let committedCount = 0;
			let sequence = 1;
			for (let index = 0; index < this.states.length; index++) {
				const state = this.states[index];
				if (!state.committed || state.skipped) continue;
				const page = this.data.pages[index];
				const title = this.pageTitle(page);
				const facts = state.facts || {};
				const docSequence = sequence++;
				const date = normalizeDateForPeak(facts.date);
				committedCount++;
				if (!date) warnings.push(title + ': วันที่เอกสารว่าง');
				for (const line of (state.lines || [])) {
					if (!line.account_key) {
						warnings.push(title + ': บัญชีว่างในรายการ');
						continue;
					}
					const amount = amountNumberOrNull(line.amount);
					if (amount === null) {
						warnings.push(title + ': จำนวนเงินว่างในรายการ');
						continue;
					}
					const account = splitAccountKey(line.account_key);
					const label = this.coaLabelByKey(line.account_key);
					const debit = amount > 0 ? amount : '';
					const credit = amount < 0 ? Math.abs(amount) : '';
					const description = String(line.description || '').trim();
					rows.push({
						page_title: title,
						cells: [docSequence, date, '', description, account.account_code, label, debit, credit, ''],
					});
				}
			}
			return { rows, warnings, committedCount };
		},
		groupLinesForExport(state, page) {
			const groups = new Map();
			for (let lineIndex = 0; lineIndex < (state.lines || []).length; lineIndex++) {
				const line = state.lines[lineIndex] || {};
				const source = (page.lines || [])[lineIndex] || {};
				const fallbackKey = (source.account_code || source.sub_code) ? (source.account_code || '') + '||' + (source.sub_code || '') : '';
				const rawKey = Object.prototype.hasOwnProperty.call(line, 'account_key') ? line.account_key : fallbackKey;
				const account = splitAccountKey(rawKey);
				const hasAccount = !!(account.account_code || account.sub_code);
				const lineVat = line.vat_treatment || source.vat_treatment || null;
				const groupKey = (hasAccount ? account.account_code + '||' + account.sub_code : '__blank__:' + lineIndex) + '@@' + (lineVat || 'doc');
				const current = groups.get(groupKey) || {account_key: hasAccount ? account.account_code + '||' + account.sub_code : '', account_code: account.account_code, amount: null, descriptions: [], vat_treatment: lineVat, amount_includes_vat: null};
				const amount = amountNumberOrNull(line.amount);
				if (amount !== null) current.amount = (current.amount === null ? 0 : current.amount) + amount;
				const description = String(line.description || source.description || '').trim();
				if (description && !current.descriptions.includes(description)) current.descriptions.push(description);
				const includesVat = typeof line.amount_includes_vat === 'boolean' ? line.amount_includes_vat : source.amount_includes_vat;
				if (typeof includesVat === 'boolean' && current.amount_includes_vat === null) current.amount_includes_vat = includesVat;
				groups.set(groupKey, current);
			}
			return Array.from(groups.values()).map((group) => ({
				account_code: group.account_code,
				description: group.account_key ? this.coaLabelByKey(group.account_key) : group.descriptions.join(' / '),
				amount: group.amount === null ? '' : group.amount,
				vat_treatment: group.vat_treatment,
				amount_includes_vat: group.amount_includes_vat,
			}));
		},
		amountIncludesVatForPage(state, page) {
			for (let index = 0; index < (state.lines || []).length; index++) {
				const line = state.lines[index] || {};
				const source = (page.lines || [])[index] || {};
				const value = typeof line.amount_includes_vat === 'boolean' ? line.amount_includes_vat : source.amount_includes_vat;
				if (typeof value === 'boolean') return value;
			}
			return null;
		},
		vatSettingsForLineGroup(group, state, page) {
			const treatment = group.vat_treatment || (state.facts || {}).vat_treatment;
			if (treatment === 'vat_7') {
				const includesVat = typeof group.amount_includes_vat === 'boolean' ? group.amount_includes_vat : this.amountIncludesVatForPage(state, page);
				return {price_type: includesVat === false ? '1' : '2', vat_rate: '0.07'};
			}
			return {price_type: '3', vat_rate: 'NO'};
		},
		async downloadExportXlsx() {
			if (!this.exportPreview || !this.exportPreview.rows.length) return;
			if (!window.XLSX) {
				this.message = 'โหลดตัวสร้าง XLSX ไม่สำเร็จ กรุณาเปิดหน้านี้ใหม่';
				return;
			}
			const workbook = window.XLSX.utils.book_new();
			const sheetRows = [this.exportPreview.headers].concat(this.exportPreview.rows.map((row) => row.cells));
			const sheet = window.XLSX.utils.aoa_to_sheet(sheetRows);
			window.XLSX.utils.book_append_sheet(workbook, sheet, this.exportPreview.sheet_name);
			const changeSheetRows = [CHANGE_LOG_HEADERS].concat((this.exportPreview.change_log || []).map((row) => row.cells));
			const changeSheet = window.XLSX.utils.aoa_to_sheet(changeSheetRows);
			window.XLSX.utils.book_append_sheet(workbook, changeSheet, 'Change_Log');
			const filename = this.exportPreview.filename;
			if (window.showSaveFilePicker) {
				try {
					const handle = await window.showSaveFilePicker({
						suggestedName: filename,
						types: [{description: 'Excel Workbook', accept: {'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']}}],
					});
					const buffer = window.XLSX.write(workbook, {type: 'array', bookType: 'xlsx'});
					const writable = await handle.createWritable();
					await writable.write(buffer);
					await writable.close();
					this.showToast('บันทึก XLSX แล้ว: ' + handle.name);
					this.closeExportPreview();
					return;
				} catch (error) {
					if (error && error.name === 'AbortError') return;
					// fall through to plain download on any other failure
				}
			}
			window.XLSX.writeFile(workbook, filename);
			this.showToast('ดาวน์โหลด XLSX แล้ว: ' + filename);
			this.closeExportPreview();
		},
		queueSaveDraft() {
			clearTimeout(this.draftTimer);
			this.draftTimer = setTimeout(() => this.saveDraft(), 300);
		},
		saveDraft() {
			try {
				localStorage.setItem(draftKey(), JSON.stringify({schema: this.draftSchema, saved_at: new Date().toISOString(), states: this.states}));
				this.draftStatus = 'บันทึกฉบับร่างแล้ว ' + new Date().toLocaleTimeString();
			} catch (error) {
				this.draftStatus = 'บันทึกฉบับร่างไม่สำเร็จ';
			}
		},
		restoreDraft() {
			try {
				const raw = localStorage.getItem(draftKey());
				if (!raw) return;
				const draft = JSON.parse(raw);
				if (draft.schema !== this.draftSchema || !Array.isArray(draft.states) || draft.states.length !== this.states.length) return;
				this.states = draft.states;
				this.draftStatus = 'คืนค่าฉบับร่างจากเบราว์เซอร์แล้ว';
			} catch (error) {
				this.draftStatus = 'อ่านฉบับร่างไม่สำเร็จ';
			}
		},
		zoomIn() { this.zoom = Math.min(4, Math.round((this.zoom + 0.1) * 10) / 10); },
		zoomOut() { this.zoom = Math.max(0.4, Math.round((this.zoom - 0.1) * 10) / 10); },
		resetPreview() { this.zoom = 1; this.panX = 0; this.panY = 0; },
		startPan(event) {
			if (this.previewKind !== 'image') return;
			this.dragging = true;
			this.dragStartX = event.clientX;
			this.dragStartY = event.clientY;
			this.startPanX = this.panX;
			this.startPanY = this.panY;
		},
		movePan(event) {
			if (!this.dragging) return;
			this.panX = this.startPanX + event.clientX - this.dragStartX;
			this.panY = this.startPanY + event.clientY - this.dragStartY;
		},
		endPan() { this.dragging = false; },
		// Pane divider drag: resize the evidence pane by pixel width, clamped so both
		// the evidence pane and the review/table pane keep a usable minimum.
		startPaneResize(event) {
			const evidence = document.querySelector('.evidence');
			this.paneResize.active = true;
			this.paneResize.startX = event.clientX;
			this.paneResize.startWidth = evidence ? evidence.getBoundingClientRect().width : 0;
			window.addEventListener('pointermove', this.movePaneResize);
			window.addEventListener('pointerup', this.endPaneResize);
			event.preventDefault();
		},
		movePaneResize(event) {
			if (!this.paneResize.active) return;
			const pane = document.querySelector('.pane');
			const paneWidth = pane ? pane.getBoundingClientRect().width : 0;
			let width = this.paneResize.startWidth + (event.clientX - this.paneResize.startX);
			const min = 260;
			const max = Math.max(min, paneWidth - 380);
			this.evidenceWidth = Math.round(Math.min(Math.max(width, min), max));
		},
		endPaneResize() {
			this.paneResize.active = false;
			window.removeEventListener('pointermove', this.movePaneResize);
			window.removeEventListener('pointerup', this.endPaneResize);
		},
		resetPaneWidth() { this.evidenceWidth = null; },
	},
});
app.mount('#app');
</script>
</body>
</html>`;
