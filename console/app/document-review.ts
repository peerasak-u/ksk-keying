// Category/group document review page (wayfinder ticket #41): the 5
// "document"-shaped buckets (expense/vat, expense/non_vat, expense/mixed,
// income/vat, income/non_vat) — bank_statement is a differently-shaped
// bucket built separately, not touched here. Same split-screen shape and
// warm-stone neutral palette as excluded-review.ts (page-selector list +
// a detail pane), server-rendered with no framework, inline <script> doing
// fetch() POSTs — matching that file's code style: Bun.escapeHTML() on
// every piece of untrusted/Thai text, JSON.stringify-then-&quot;-escape
// onclick builders, small pure helper functions kept independently
// testable (document-review.test.ts).
//
// Unlike excluded-review.ts (one claim = one action = one viewer), each
// page here carries a facts form + an editable lines table, so ALL pages'
// detail panels are pre-rendered up front (only the active one carries
// .is-open) and toggled client-side by selectPage() — no framework, no
// per-page re-fetch, same "everything baked into one document" posture as
// excluded-review.ts's viewer-panel toggling.
//
// Layout is three fixed-height columns — page list | document preview |
// edit form — each with its OWN scrollbar, so the page itself never
// scrolls: a reviewer working a bucket of ~30 documents keeps the form
// fields and the Save button in exactly the same screen position for every
// document, and only ever scrolls the preview to read the source. The
// preview column is rendered ONCE, outside the per-page panels, because it
// hosts a single PDF.js viewer shared by every document (the panels hold
// only forms) — see the PDF viewer note in the inline <script>. The
// list/preview/form panes stay in sync in both directions: picking a
// document scrolls the PDF to its page, and scrolling the PDF onto another
// document's page moves the selection.
// The
// lines table is deliberately narrower than a full-width table would be
// (reason + needs-review folded into the confidence badge's tooltip, same
// as bank-statement-review.ts's conf-badge) so it fits the form column.
import { join } from "node:path";
import { type CoaRow, coaKey, coaLabel } from "./coa";
import { BREADCRUMB_CSS, breadcrumbHtml, reviewHubUrl } from "./nav";
import { formatNumber, normalizeDateForPeak } from "./peak-format";
import { type DocumentBucket, isMixedBucket, type ReviewLine, type ReviewPage, type ReviewPageFacts } from "./review-data";
import { isXlsxFile, loadSheetTables, renderWorkbookPreviewHtml } from "./xlsx-preview";

export type DocumentReviewGuard = { disabled: boolean; message: string | null };

export type DocumentReviewPage = {
	clientId: string;
	monthId: string;
	companyName: string | null;
	bucket: DocumentBucket; // "expense/vat" etc — split on "/" to build the category/vat URL segments
	coaRows: CoaRow[];
	guard: DocumentReviewGuard;
	pages: ReviewPage[]; // already loaded + merged + sorted by the caller via loadBucketPages
};

// ---------------------------------------------------------------------------
// Pure helpers — independently unit-tested (document-review.test.ts).

export type LineSubtotal = { key: string; label: string; total: number };

/** Per-account running subtotal for ONE page's lines[] (not the whole
 * bucket): group by account_code + "||" + sub_code (coaKey's own format),
 * summing `amount` with null treated as 0, first-seen order preserved. The
 * label prefers the real COA row (coaLabel()); when a line's account_code
 * isn't present in coaRows (a stale/orphaned code), falls back to building
 * the same coaLabel() shape from the line's own account_name_th rather than
 * dropping the group or showing a bare key. Mirrored (duplicated, not
 * shared) by a vanilla-JS equivalent inline in the rendered <script> so the
 * reviewer sees live totals as they edit amounts/accounts before saving. */
export function computeLineSubtotals(lines: ReviewLine[], coaRows: CoaRow[]): LineSubtotal[] {
	const order: string[] = [];
	const totals = new Map<string, number>();
	const labels = new Map<string, string>();
	for (const line of lines) {
		const key = coaKey({ account_code: line.account_code, sub_code: line.sub_code });
		if (!totals.has(key)) {
			order.push(key);
			totals.set(key, 0);
			const matched = coaRows.find((row) => coaKey(row) === key);
			labels.set(
				key,
				matched
					? coaLabel(matched)
					: coaLabel({ account_code: line.account_code, sub_code: line.sub_code, name_th: line.account_name_th, name_en: "" }),
			);
		}
		totals.set(key, (totals.get(key) ?? 0) + (line.amount ?? 0));
	}
	return order.map((key) => ({ key, label: labels.get(key) ?? key, total: totals.get(key) ?? 0 }));
}

/** Early-warning hint next to the document-date fact field: shows what
 * normalizeDateForPeak() will turn the current value into, so a reviewer
 * spots an unparseable date before the (later, #42) PEAK export runs.
 * "" (no hint shown) when the field is blank; a distinct warning shape when
 * normalizeDateForPeak() couldn't produce a clean PEAK YYYYMMDD. */
export function peakDateHint(value: string | number | null | undefined): string {
	const text = String(value ?? "").trim();
	if (!text) return "";
	const normalized = normalizeDateForPeak(value);
	return /^[0-9]{8}$/.test(normalized) ? `PEAK: ${normalized}` : `⚠ PEAK: รูปแบบวันที่ไม่ชัดเจน ("${normalized}")`;
}

const BUCKET_LABELS: Record<DocumentBucket, string> = {
	"expense/vat": "รายจ่าย — มี VAT",
	"expense/non_vat": "รายจ่าย — ไม่มี VAT",
	"expense/mixed": "รายจ่าย — ผสม VAT/ไม่มี VAT",
	"income/vat": "รายรับ — มี VAT",
	"income/non_vat": "รายรับ — ไม่มี VAT",
};

export function bucketLabel(bucket: DocumentBucket): string {
	return BUCKET_LABELS[bucket] ?? bucket;
}

const FACT_LABELS: Record<string, string> = {
	date: "วันที่เอกสาร",
	seller: "ผู้ขาย",
	buyer: "ผู้ซื้อ",
	seller_tax_id: "เลขผู้เสียภาษี (ผู้ขาย)",
	buyer_tax_id: "เลขผู้เสียภาษี (ผู้ซื้อ)",
	document_no: "เลขที่เอกสาร",
	subtotal: "ยอดก่อนภาษี",
	vat: "ภาษีมูลค่าเพิ่ม",
	total: "ยอดรวม",
	paid: "ยอดที่ชำระจริง",
	wht: "ภาษีหัก ณ ที่จ่าย",
	reference: "อ้างอิง",
	summary: "สรุปรายการ",
	vat_treatment: "ประเภทภาษี (เอกสาร)",
};

/** Thai label for a facts[] key; falls back to the raw key for anything not
 * in the well-known set (review-data-schema.md's documented fact fields plus
 * the FX-visibility quartet) rather than hiding an unrecognized field. */
export function factLabel(key: string): string {
	return FACT_LABELS[key] ?? key;
}

// Facts are grouped rather than dumped as one flat grid: on a real
// client-month ~29% of a document's fact fields are blank, so a uniform grid
// of equal-weight boxes spends a third of its space saying nothing. Grouping
// (plus dimming the blanks) lets a reviewer's eye skip whole blocks.
const IDENTITY_FACT_KEYS = ["date", "document_no", "reference", "vat_treatment"];
const PARTY_FACT_KEYS = ["seller", "seller_tax_id", "buyer", "buyer_tax_id"];
const MONEY_FACT_KEYS = ["subtotal", "vat", "total", "wht", "paid"];
const OTHER_FACT_KEYS = ["summary", "currency", "original_currency", "original_amount", "exchange_rate"];

export type FactGroup = { title: string; keys: string[] };

/** Splits a page's facts into the four display blocks, keeping ONLY keys the
 * page actually carries and preserving each block's canonical field order.
 * Anything unrecognized lands in "อื่นๆ" rather than being dropped — an
 * unknown fact key must stay visible and editable (same posture as
 * factLabel()'s raw-key fallback). Empty blocks are omitted. */
export function factGroups(facts: ReviewPageFacts): FactGroup[] {
	const present = new Set(Object.keys(facts));
	const claimed = new Set([...IDENTITY_FACT_KEYS, ...PARTY_FACT_KEYS, ...MONEY_FACT_KEYS, ...OTHER_FACT_KEYS]);
	const pick = (keys: string[]) => keys.filter((key) => present.has(key));
	const unknown = Object.keys(facts).filter((key) => !claimed.has(key));
	return [
		{ title: "เอกสาร", keys: pick(IDENTITY_FACT_KEYS) },
		{ title: "คู่ค้า", keys: pick(PARTY_FACT_KEYS) },
		{ title: "ยอดเงิน", keys: pick(MONEY_FACT_KEYS) },
		{ title: "อื่นๆ", keys: [...pick(OTHER_FACT_KEYS), ...unknown] },
	].filter((group) => group.keys.length > 0);
}

export type ReconciliationRow = { label: string; ok: boolean; detail: string };

function factNumber(facts: ReviewPageFacts, key: string): number | null {
	const value = facts[key];
	if (value === null || value === undefined || String(value).trim() === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The arithmetic a document promises about itself, checked to the satang.
 * Each check is skipped (not failed) when one of its inputs is blank — a
 * missing field is "nothing to check here", and flagging it as a mismatch
 * would cry wolf on the ~29% of fact fields that are legitimately empty.
 * This is deliberately NOT driven by the AI's own `needs_review` /
 * `initial_status` flags: on real data those fire on 74% / 92% of documents
 * respectively, so they can't rank anything. Recomputed arithmetic can. */
export function reconcileFacts(facts: ReviewPageFacts, lines: ReviewLine[]): ReconciliationRow[] {
	const rows: ReconciliationRow[] = [];
	const subtotal = factNumber(facts, "subtotal");
	const vat = factNumber(facts, "vat");
	const total = factNumber(facts, "total");
	const wht = factNumber(facts, "wht");
	const paid = factNumber(facts, "paid");

	if (subtotal !== null && vat !== null && total !== null) {
		const expected = round2(subtotal + vat);
		const ok = Math.abs(expected - total) < 0.01;
		rows.push({ label: "ก่อนภาษี + VAT = ยอดรวม", ok, detail: ok ? formatNumber(total) : `ควรเป็น ${formatNumber(expected)} แต่กรอก ${formatNumber(total)}` });
	}
	if (total !== null && wht !== null && paid !== null) {
		const expected = round2(total - wht);
		const ok = Math.abs(expected - paid) < 0.01;
		rows.push({ label: "ยอดรวม − หัก ณ ที่จ่าย = ชำระจริง", ok, detail: ok ? formatNumber(paid) : `ควรเป็น ${formatNumber(expected)} แต่กรอก ${formatNumber(paid)}` });
	}
	if (subtotal !== null && lines.length > 0) {
		const lineSum = round2(lines.reduce((sum, line) => sum + (line.amount ?? 0), 0));
		const ok = Math.abs(lineSum - subtotal) < 0.01;
		rows.push({ label: "ผลรวมบรรทัดรายการ = ยอดก่อนภาษี", ok, detail: ok ? formatNumber(subtotal) : `บรรทัดรวม ${formatNumber(lineSum)} · ก่อนภาษี ${formatNumber(subtotal)}` });
	}
	return rows;
}

const NUMERIC_FACT_KEYS = new Set(["subtotal", "vat", "total", "paid", "wht", "exchange_rate", "original_amount"]);

/** Whether a facts[] key holds a money/number value (vs. free text) — drives
 * both the server-rendered <input type="number"> and the client-side
 * gather-on-save numeric parsing (kept in sync manually, same duplication
 * posture as computeLineSubtotals' JS mirror). */
export function isNumericFactKey(key: string): boolean {
	return NUMERIC_FACT_KEYS.has(key);
}

/** Builds the exact edit-endpoint URL the Save button posts to — matches the
 * route someone else wires: POST /api/review/:clientId/:monthId/:category/:vat/:groupId/pages/:pageIndex.
 * category/vat are always one of the 5 known bucket literals (never
 * URL-encoded, same posture as review-data.ts's own bucket.split("/") calls);
 * clientId/monthId/groupId are arbitrary and always encoded. */
export function pageEditUrl(clientId: string, monthId: string, category: string, vat: string, groupId: string, pageIndex: number): string {
	return `/api/review/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/${category}/${vat}/${encodeURIComponent(groupId)}/pages/${pageIndex}`;
}

/** Ticket #42's bucket-wide PEAK export endpoint URL. */
export function bucketExportUrl(clientId: string, monthId: string, category: string, vat: string): string {
	return `/api/export/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/${category}/${vat}`;
}

const CONFIDENCE_META: Record<ReviewLine["confidence"], { label: string; fg: string; bg: string }> = {
	low: { label: "ความมั่นใจต่ำ", fg: "#b91c1c", bg: "#fee2e2" },
	medium: { label: "ความมั่นใจปานกลาง", fg: "#92400e", bg: "#fef3c7" },
	high: { label: "ความมั่นใจสูง", fg: "#15803d", bg: "#dcfce7" },
};

// ---------------------------------------------------------------------------
// Rendering — thin string-building helpers over the pure data above, plus one
// bit of real (but unavoidable) I/O: xlsx sheet previews.

function fileUrl(clientId: string, monthId: string, file: string): string {
	return `/files/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/${encodeURIComponent(file)}`;
}

/** Save button's onclick: JSON.stringify gives a correctly-escaped JS literal
 * for the index, then `"` is entity-escaped so it can't prematurely close the
 * surrounding attribute — same technique as excluded-review.ts's
 * decideOnclick/bringBackOnclick and dashboard.ts's onclickAttr. `this` is
 * appended raw (a live DOM reference, not data to escape). */
function saveOnclick(index: number): string {
	const call = `savePage(${JSON.stringify(index)}, this)`;
	return call.replace(/"/g, "&quot;");
}

/** A page previews through the shared PDF.js viewer when its source is
 * anything but a workbook (i.e. a real PDF); workbooks and missing sources
 * render to static HTML server-side instead. */
export function isPdfSourced(p: ReviewPage): boolean {
	return p.source_src !== null && !isXlsxFile(p.source_src);
}

/** Server-rendered preview for the NON-pdf cases only — a workbook sheet
 * table or a placeholder. PDFs are deliberately absent here: they're drawn by
 * the one shared client-side PDF.js viewer (see PDF_VIEWER_SCRIPT), not by 31
 * separate embeds. */
function staticPreviewHtml(clientMonthDir: string, p: ReviewPage): string {
	if (!p.source_src) {
		return `<div class="preview-placeholder">ไม่มีเอกสารตัวอย่าง</div>`;
	}
	const absPath = join(clientMonthDir, p.source_src);
	const tables = loadSheetTables(absPath, p.source_sheet);
	if (tables === null) {
		return `<div class="preview-placeholder">ไม่สามารถแสดงตัวอย่างไฟล์ Excel นี้ได้<br/>${Bun.escapeHTML(p.source_src)}</div>`;
	}
	return renderWorkbookPreviewHtml(tables);
}

/** Per-page facts the client-side viewer + header need, as a JS literal.
 * `<` is escaped so no field value can close the surrounding <script>. */
function pagesJsonForScript(pages: ReviewPage[], clientId: string, monthId: string): string {
	const meta = pages.map((p) => ({
		kind: isPdfSourced(p) ? "pdf" : "static",
		src: p.source_src && isPdfSourced(p) ? fileUrl(clientId, monthId, p.source_src) : null,
		page: p.source_page ?? 1,
		title: p.group_label ?? "",
		ref: p.short_ref,
		attention: p.initial_status === "needs_attention",
		flags: p.group_review_flags ?? [],
		// Already-skipped documents are nothing left to key, so they seed the
		// done set: otherwise "ครบทุกใบ" could never be reached in a bucket
		// holding one.
		skipped: p.skipped,
	}));
	return JSON.stringify(meta).replace(/</g, "\\u003c");
}

function pageListRowHtml(p: ReviewPage, index: number): string {
	const flags = p.group_review_flags ?? [];
	const flagIcon = flags.length ? `<span class="flag-icon" title="${Bun.escapeHTML(flags.join("\n"))}">⚠</span>` : "";
	const attentionBadge = p.initial_status === "needs_attention" ? `<span class="badge-attention">ต้องตรวจสอบ</span>` : "";
	return `<div class="list-row ${index === 0 ? "is-active" : ""}${p.skipped ? " is-done" : ""}" data-index="${index}" onclick="selectPage(${index})">
		<div class="row-title"><span class="row-check" aria-hidden="true">✓</span>${Bun.escapeHTML(p.group_label ?? "")} ${flagIcon}</div>
		<div class="row-sub">${Bun.escapeHTML(p.short_ref)}</div>
		${attentionBadge}
	</div>`;
}

/** One fact as a label·value row. Deliberately borderless: the input only
 * grows a rule on hover/focus, so a screenful of facts reads as reference
 * text to scan rather than a wall of boxes to fill in. A blank value dims the
 * whole row (undimmed on focus) instead of holding full visual weight. */
function factRowHtml(key: string, value: string | number | null, disabledAttr: string): string {
	const escapedKey = Bun.escapeHTML(key);
	const blank = value === null || value === undefined || String(value).trim() === "";
	const labelHtml = `<span class="fact-key">${Bun.escapeHTML(factLabel(key))}</span>`;

	if (key === "vat_treatment") {
		const current = value == null ? "" : String(value);
		const options = ["", "vat_7", "non_vat", "unknown"]
			.map((opt) => `<option value="${opt}"${opt === current ? " selected" : ""}>${opt === "" ? "(ไม่ระบุ)" : opt}</option>`)
			.join("");
		return `<div class="fact-row${blank ? " is-blank" : ""}">${labelHtml}<select class="fact-in" data-fact-key="${escapedKey}"${disabledAttr}>${options}</select></div>`;
	}

	const numeric = isNumericFactKey(key);
	const stepAttr = numeric ? ` step="any"` : "";
	const escapedValue = Bun.escapeHTML(value == null ? "" : String(value));
	const hintText = key === "date" ? peakDateHint(value) : "";
	const hint = hintText ? `<span class="peak-hint">${Bun.escapeHTML(hintText)}</span>` : "";
	return `<div class="fact-row${blank ? " is-blank" : ""}">${labelHtml}<input class="fact-in${numeric ? " fact-num" : ""}" type="${numeric ? "number" : "text"}"${stepAttr} data-fact-key="${escapedKey}" data-fact-numeric="${numeric}" value="${escapedValue}"${disabledAttr} />${hint}</div>`;
}

function factGroupHtml(group: FactGroup, facts: ReviewPageFacts, disabledAttr: string): string {
	const rows = group.keys.map((key) => factRowHtml(key, facts[key] ?? null, disabledAttr)).join("");
	return `<div class="fact-block"><div class="fact-block-title">${Bun.escapeHTML(group.title)}</div>${rows}</div>`;
}

function reconciliationHtml(rows: ReconciliationRow[]): string {
	if (rows.length === 0) return `<div class="recon is-ok">ไม่มียอดให้ตรวจ</div>`;
	const allOk = rows.every((r) => r.ok);
	const parts = rows.map((r) => `${r.ok ? "✓" : "✗"} ${Bun.escapeHTML(r.label)}${r.ok ? "" : ` — ${Bun.escapeHTML(r.detail)}`}`);
	return `<div class="recon ${allOk ? "is-ok" : "is-bad"}">${parts.join(" · ")}</div>`;
}

/** One line item as a card. The two fields that carry the accounting decision
 * — which account, how much — take the top row at full size; description and
 * the qty × unit_price arithmetic sit underneath as supporting detail. The
 * AI's reason rides along as the confidence badge's tooltip rather than a
 * visible sentence: it is near-identical boilerplate across every line of a
 * 40-line invoice, so on screen it reads as noise exactly where vertical
 * space is scarcest. */
function lineCardHtml(line: ReviewLine, coaRows: CoaRow[], mixed: boolean, disabledAttr: string): string {
	const currentKey = coaKey({ account_code: line.account_code, sub_code: line.sub_code });
	const known = coaRows.some((row) => coaKey(row) === currentKey);
	const fallbackOption = known
		? ""
		: `<option value="${Bun.escapeHTML(currentKey)}" selected>${Bun.escapeHTML(line.account_name_th || currentKey || "— ยังไม่ระบุบัญชี —")}</option>`;
	const accountOptions = coaRows
		.map((row) => {
			const key = coaKey(row);
			return `<option value="${Bun.escapeHTML(key)}"${key === currentKey ? " selected" : ""}>${Bun.escapeHTML(coaLabel(row))}</option>`;
		})
		.join("");
	const confMeta = CONFIDENCE_META[line.confidence];
	const vatSelect = mixed
		? `<select class="line-mini" data-field="vat_treatment" data-line-index="${line.line_index}"${disabledAttr}>
			<option value=""${!line.vat_treatment ? " selected" : ""}>ตามเอกสาร</option>
			<option value="vat_7"${line.vat_treatment === "vat_7" ? " selected" : ""}>vat_7</option>
			<option value="non_vat"${line.vat_treatment === "non_vat" ? " selected" : ""}>non_vat</option>
		</select>`
		: "";

	return `<div class="line-row line-card" data-line-index="${line.line_index}">
		<div class="line-top">
			<span class="line-no">${line.line_index + 1}</span>
			<select class="line-account" data-field="account_key" data-line-index="${line.line_index}"${disabledAttr}>${fallbackOption}${accountOptions}</select>
			<input class="line-amount" type="number" step="any" data-field="amount" data-line-index="${line.line_index}" value="${line.amount ?? ""}"${disabledAttr} />
		</div>
		<div class="line-bottom">
			<input class="line-desc" type="text" data-field="description" data-line-index="${line.line_index}" value="${Bun.escapeHTML(line.description ?? "")}"${disabledAttr} />
			<span class="line-meta">
				<input class="line-mini" type="number" step="any" data-field="qty" data-line-index="${line.line_index}" value="${line.qty ?? ""}"${disabledAttr} /><span class="line-x">×</span><input class="line-mini" type="number" step="any" data-field="unit_price" data-line-index="${line.line_index}" value="${line.unit_price ?? ""}"${disabledAttr} />
				<input class="line-mini line-unit" type="text" data-field="unit" data-line-index="${line.line_index}" value="${Bun.escapeHTML(line.unit ?? "")}"${disabledAttr} />
				${vatSelect}
				<span class="badge-confidence" style="color:${confMeta.fg};background:${confMeta.bg};" title="${Bun.escapeHTML(line.reason)}">${confMeta.label}</span>
				${line.needs_review ? `<span class="badge-needs-review" title="ต้องตรวจสอบ">⚠</span>` : ""}
			</span>
		</div>
	</div>`;
}

function renderSubtotalsHtml(subtotals: LineSubtotal[]): string {
	if (subtotals.length === 0) return `<div class="subtotals-empty">ไม่มีบรรทัดรายการ</div>`;
	const rows = subtotals
		.map((s) => `<div class="subtotal-row"><span class="subtotal-label">${Bun.escapeHTML(s.label)}</span><span class="subtotal-total">${formatNumber(s.total)}</span></div>`)
		.join("");
	return `<div class="subtotals-title">ยอดรวมตามบัญชี (เอกสารนี้)</div>${rows}`;
}

/** The form column's per-page panel. Holds ONLY the form: the document
 * preview lives once, outside the panels, in the shared preview column —
 * otherwise a 31-document bucket would mean 31 PDF viewers. */
function detailPanelHtml(pageData: DocumentReviewPage, p: ReviewPage, index: number, category: string, vat: string, mixed: boolean): string {
	const disabledAttr = pageData.guard.disabled ? " disabled" : "";
	const factsHtml = factGroups(p.facts)
		.map((group) => factGroupHtml(group, p.facts, disabledAttr))
		.join("");
	const linesHtml = p.lines.map((line) => lineCardHtml(line, pageData.coaRows, mixed, disabledAttr)).join("");
	const subtotalsHtml = renderSubtotalsHtml(computeLineSubtotals(p.lines, pageData.coaRows));
	const saveUrl = pageEditUrl(pageData.clientId, pageData.monthId, category, vat, p.group_id ?? "", p.page_index_in_group ?? 0);

	return `<div class="detail-panel${index === 0 ? " is-open" : ""}" data-index="${index}" data-save-url="${Bun.escapeHTML(saveUrl)}">
		<div class="form-scroll">
			<div class="facts-form">${factsHtml}</div>
			${reconciliationHtml(reconcileFacts(p.facts, p.lines))}
			<div class="lines-title">ลงบัญชี · ${p.lines.length} บรรทัด</div>
			<div class="lines-list">${linesHtml}</div>
			<div class="subtotals-box" data-subtotals>${subtotalsHtml}</div>
		</div>
		<div class="save-bar">
			<label class="skip-toggle"><input type="checkbox" data-skip-checkbox ${p.skipped ? "checked" : ""}${disabledAttr} /> ข้ามเอกสารนี้ (ไม่ส่งออก)</label>
			<button class="btn-save"${disabledAttr} onclick="${saveOnclick(index)}">บันทึก</button>
			<span class="save-indicator" data-save-indicator></span>
		</div>
	</div>`;
}

/** Async because it computes xlsx sheet previews itself (loadSheetTables per
 * xlsx-sourced page) — clientMonthDir is needed only to resolve those
 * absolute paths. */
export async function renderDocumentReviewPage(clientMonthDir: string, page: DocumentReviewPage): Promise<string> {
	const displayName = page.companyName ?? page.clientId;
	const [category, vat] = page.bucket.split("/");
	const mixed = isMixedBucket(page.bucket);

	const listRows = page.pages.map((p, i) => pageListRowHtml(p, i)).join("");
	const panels: string[] = [];
	const staticPreviews: string[] = [];
	for (let i = 0; i < page.pages.length; i++) {
		const p = page.pages[i];
		panels.push(detailPanelHtml(page, p, i, category, vat, mixed));
		if (!isPdfSourced(p)) {
			staticPreviews.push(`<div class="static-preview" data-index="${i}">${staticPreviewHtml(clientMonthDir, p)}</div>`);
		}
	}

	const body =
		page.pages.length === 0
			? `<div class="empty-state">ไม่มีเอกสารในหมวดนี้</div>`
			: `<div class="layout">
				<div class="list-pane">${listRows}</div>
				<div class="preview-col">
					<div class="detail-header">
						<div class="detail-title" id="previewTitle"></div>
						<span class="badge-attention" id="previewAttention" style="display:none;">ต้องตรวจสอบ</span>
					</div>
					<div class="flags-banner" id="previewFlags" style="display:none;"></div>
					<div class="preview-box" id="previewStage">
						<div class="pdf-scroll" id="pdfScroll"></div>
						${staticPreviews.join("")}
					</div>
					<div class="preview-footer">
						<span id="pdfPageLabel"></span>
						<span class="preview-zoom">
							<button type="button" class="zoom-btn" onclick="pdfZoom(-1)" title="ย่อ">−</button>
							<span id="pdfZoomLabel">100%</span>
							<button type="button" class="zoom-btn" onclick="pdfZoom(1)" title="ขยาย">+</button>
							<button type="button" class="zoom-btn zoom-fit" onclick="pdfZoom(0)" title="พอดีความกว้าง">พอดีจอ</button>
						</span>
					</div>
				</div>
				<div class="form-col">${panels.join("")}</div>
			</div>`;

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ตรวจทานเอกสาร — ${Bun.escapeHTML(bucketLabel(page.bucket))} — ${Bun.escapeHTML(displayName)}</title>
<style>
	* { box-sizing: border-box; }
	html, body { height: 100%; margin: 0; }
	body {
		font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f7f6f3; color: #292524;
		display: flex; flex-direction: column; overflow: hidden;
	}
	header {
		flex: none;
		background: #1c1917; color: #fafaf9; padding: 12px 20px; display: flex;
		align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
	}
${BREADCRUMB_CSS}
	header h1 { font-size: 15px; margin: 0; }
	header .sub { font-size: 11.5px; color: #a8a29e; }
	#count { font-size: 12.5px; font-weight: 600; background: #292524; padding: 4px 11px; border-radius: 999px; }
	.guard-banner {
		flex: none;
		background: #fef3c7; color: #92400e; padding: 10px 20px; font-size: 13px; font-weight: 600;
		border-bottom: 1px solid #fde68a;
	}
	.empty-state {
		margin: 60px auto; max-width: 480px; text-align: center; font-size: 15px; font-weight: 600;
		color: #57534e; background: #fff; padding: 30px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}
	/* Three columns, each scrolling on its own; the page body never scrolls. */
	.layout { display: flex; flex: 1; min-height: 0; }
	.list-pane { flex: 0 0 260px; overflow-y: auto; background: #f7f6f3; padding: 14px; border-right: 1px solid #ddd9d0; }
	.list-row {
		background: #fff; border-radius: 10px; padding: 12px; margin-bottom: 8px; cursor: pointer;
		border: 2px solid transparent; display: flex; flex-direction: column; gap: 4px;
	}
	.list-row:hover { border-color: #d6d3cd; }
	.list-row.is-active { border-color: #1d4ed8; box-shadow: 0 2px 10px rgba(29,78,216,0.14); }
	.row-title { font-weight: 700; font-size: 13px; color: #292524; }
	.row-sub { font-size: 11.5px; color: #78716c; }
	/* Saved rows stay legible but visibly settled, so what's LEFT is what
	   stands out when scanning the list. */
	.row-check { color: #15803d; font-weight: 700; margin-right: 4px; display: none; }
	.list-row.is-done .row-check { display: inline; }
	.list-row.is-done { background: #f4f7f4; }
	.list-row.is-done .row-title, .list-row.is-done .row-sub { color: #78716c; }
	.flag-icon { color: #b45309; font-weight: 700; cursor: help; }
	.badge-attention { align-self: flex-start; font-size: 10.5px; font-weight: 700; color: #b91c1c; background: #fee2e2; padding: 2px 8px; border-radius: 999px; }
	/* ONE preview column shared by every document (not one per panel) — see
	   the PDF.js viewer note in this file's header. */
	.preview-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; padding: 14px; }
	.form-col {
		flex: 0 0 clamp(400px, 38vw, 820px); min-width: 0; display: flex; flex-direction: column;
		background: #fff; border-left: 1px solid #ddd9d0;
	}
	.detail-panel { display: none; flex: 1; min-height: 0; flex-direction: column; }
	.detail-panel.is-open { display: flex; }
	.form-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
	.detail-header { flex: none; display: flex; align-items: center; gap: 10px; }
	.detail-title { font-weight: 700; font-size: 14.5px; }
	.detail-ref { font-weight: 400; color: #78716c; }
	.flags-banner { flex: none; background: #fef3c7; color: #92400e; font-size: 12.5px; font-weight: 600; padding: 8px 12px; border-radius: 8px; }
	.preview-box {
		flex: 1; min-height: 0; position: relative;
		background: #ece9e3; border-radius: 10px;
	}
	/* The PDF.js scroll container: free-scrolling over the WHOLE file, with
	   only the pages near the viewport actually painted to a canvas. */
	.pdf-scroll { position: absolute; inset: 0; overflow: auto; padding: 10px 0 40px; display: none; }
	.pdf-scroll.is-active { display: block; }
	.pdf-page { position: relative; margin: 0 auto 10px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.15); }
	.pdf-page canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
	.pdf-fallback { position: absolute; inset: 0; width: 100%; height: 100%; border: none; }
	.static-preview { position: absolute; inset: 0; overflow: auto; padding: 10px; display: none; }
	.static-preview.is-active { display: flex; flex-direction: column; }
	.preview-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #78716c; font-size: 13px; }
	.preview-footer {
		flex: none; display: flex; align-items: center; justify-content: space-between;
		font-size: 11.5px; color: #78716c; min-height: 22px;
	}
	.preview-zoom { display: flex; align-items: center; gap: 4px; }
	.zoom-btn { border: 1px solid #ddd9d0; background: #fff; color: #57534e; border-radius: 6px; padding: 2px 8px; font: inherit; font-size: 11.5px; cursor: pointer; }
	.zoom-btn:hover { background: #f1efec; }
	.preview-placeholder { margin: auto; color: #78716c; font-size: 13px; text-align: center; padding: 20px; }
	.xlsx-sheet-table { background: #fff; border-radius: 10px; padding: 16px; max-width: 100%; display: flex; flex-direction: column; gap: 8px; width: 100%; }
	.xlsx-sheet-name { font-size: 12.5px; font-weight: 700; color: #57534e; }
	.xlsx-table-scroll { overflow: auto; border: 1px solid #ece9e3; border-radius: 6px; }
	.xlsx-table-scroll table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
	.xlsx-table-scroll td { border: 1px solid #ece9e3; padding: 4px 8px; }
	.xlsx-table-scroll tr.xlsx-header-row td { background: #ece9e3; font-weight: 700; }
	.xlsx-truncated-note { font-size: 11px; color: #a8a29e; }
	.xlsx-empty { color: #78716c; font-size: 13px; padding: 12px; }
	.xlsx-sheet-divider { height: 1px; background: #ece9e3; margin: 4px 0; }
	/* Facts read as reference text, not a form: no borders until you touch a
	   field, and blank fields recede instead of holding equal weight. */
	.facts-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 20px; align-items: start; margin-bottom: 12px; }
	.fact-block { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
	.fact-block-title { font-size: 10px; font-weight: 700; color: #a8a29e; letter-spacing: 0.06em; margin-bottom: 3px; }
	.fact-row { display: grid; grid-template-columns: 104px 1fr; gap: 6px; align-items: baseline; padding: 1px 0; min-width: 0; }
	.fact-row.is-blank { opacity: 0.45; }
	.fact-row.is-blank:focus-within { opacity: 1; }
	.fact-key { font-size: 11px; color: #78716c; text-align: right; line-height: 1.35; }
	.fact-in {
		font: inherit; font-size: 12.5px; width: 100%; min-width: 0; color: #292524;
		border: none; border-bottom: 1px dotted #d6d3d1; border-radius: 0; background: transparent; padding: 1px 2px;
	}
	.fact-in:hover:not(:disabled) { border-bottom-color: #78716c; background: #fafaf9; }
	.fact-in:focus { outline: none; border-bottom: 1px solid #1d4ed8; background: #fff; }
	.fact-in:disabled { color: #78716c; border-bottom-style: solid; }
	.fact-num { font-variant-numeric: tabular-nums; }
	.peak-hint { grid-column: 2; font-size: 10.5px; color: #a8a29e; }
	.recon { font-size: 11px; padding: 5px 8px; border-radius: 6px; line-height: 1.6; margin-bottom: 14px; }
	.recon.is-ok { color: #15803d; background: #f0fdf4; }
	.recon.is-bad { color: #b91c1c; background: #fef2f2; }

	/* Line items are cards, not table rows: the account + amount ARE the
	   accounting decision, so they get the top row at full size. */
	.lines-title { font-size: 10px; font-weight: 700; color: #a8a29e; letter-spacing: 0.06em; border-top: 1px solid #ece9e3; padding-top: 8px; margin-bottom: 8px; }
	.lines-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
	.line-card { background: #fafaf9; border: 1px solid #ece9e3; border-radius: 10px; padding: 8px 10px; }
	.line-card:focus-within { border-color: #d6d3d1; background: #fff; }
	.line-top { display: flex; gap: 8px; align-items: center; }
	.line-no { flex: none; width: 18px; font-size: 10.5px; color: #d6d3d1; text-align: right; }
	.line-account {
		flex: 1; min-width: 0; font: inherit; font-size: 13px; font-weight: 600; color: #292524;
		padding: 5px 7px; border: 1px solid #ddd9d0; border-radius: 7px; background: #fff;
	}
	.line-amount {
		width: 110px; flex: none; font: inherit; font-size: 15px; font-weight: 700; text-align: right;
		font-variant-numeric: tabular-nums; color: #292524;
		border: 1px solid #ddd9d0; border-radius: 7px; padding: 5px 7px; background: #fff;
	}
	.line-bottom { display: flex; gap: 8px; align-items: center; margin-top: 5px; padding-left: 26px; }
	.line-desc {
		flex: 1; min-width: 0; font: inherit; font-size: 12px; color: #57534e;
		border: none; border-bottom: 1px solid transparent; background: transparent; padding: 2px 0;
	}
	.line-desc:hover:not(:disabled) { border-bottom-color: #e7e5e4; }
	.line-desc:focus { outline: none; border-bottom-color: #1d4ed8; }
	.line-meta { display: flex; align-items: center; gap: 4px; }
	.line-mini {
		width: 66px; font: inherit; font-size: 11px; text-align: right; color: #57534e;
		border: none; background: #f1efec; border-radius: 5px; padding: 2px 5px;
	}
	.line-unit { text-align: left; width: 48px; }
	.line-x { color: #a8a29e; font-size: 10px; }
	.line-card input:disabled, .line-card select:disabled { background: #f1efec; color: #78716c; }
	.badge-confidence { font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 999px; white-space: nowrap; cursor: help; }
	.badge-needs-review { font-size: 12px; font-weight: 700; color: #b91c1c; cursor: help; }
	.subtotals-box { background: #f7f6f3; border-radius: 10px; padding: 12px 14px; }
	.subtotals-title { font-size: 11.5px; font-weight: 700; color: #78716c; margin-bottom: 6px; }
	.subtotal-row { display: flex; justify-content: space-between; font-size: 12.5px; padding: 2px 0; }
	.subtotal-label { color: #57534e; }
	.subtotal-total { font-weight: 700; }
	.subtotals-empty { font-size: 12.5px; color: #a8a29e; }
	/* Pinned to the bottom of the form column — Save never scrolls away. */
	.save-bar {
		flex: none; display: flex; align-items: center; gap: 12px;
		padding: 12px 16px; background: #fff; border-top: 1px solid #ece9e3;
	}
	.skip-toggle { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #57534e; cursor: pointer; }
	.btn-save { border: none; border-radius: 7px; padding: 9px 18px; font-size: 13px; font-weight: 700; cursor: pointer; background: #15803d; color: #fff; }
	.btn-save[disabled] { opacity: 0.5; cursor: default; }
	.save-indicator { font-size: 12.5px; font-weight: 700; color: #15803d; }
	.btn-export { border: none; border-radius: 7px; padding: 8px 16px; font-size: 12.5px; font-weight: 700; cursor: pointer; background: #b45309; color: #fff; }
	.btn-export[disabled] { opacity: 0.5; cursor: default; }

	/* Save feedback: a toast for the ordinary case (saved, moved on) and a
	   modal for the one that ends the bucket. */
	#toast {
		position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 60;
		background: #14532d; color: #fff; padding: 9px 16px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
		box-shadow: 0 6px 20px rgba(0,0,0,.25); opacity: 0; pointer-events: none; transition: opacity .18s;
	}
	#toast.on { opacity: 1; }
	#doneModal { position: fixed; inset: 0; z-index: 70; background: rgba(28,25,23,.55); display: none; align-items: center; justify-content: center; }
	#doneModal.on { display: flex; }
	.done-box {
		background: #fff; border-radius: 14px; padding: 26px 28px; max-width: 420px; text-align: center;
		box-shadow: 0 18px 50px rgba(0,0,0,.3);
	}
	.done-box .done-mark { font-size: 34px; color: #15803d; line-height: 1; }
	.done-box h2 { font-size: 17px; margin: 10px 0 6px; }
	.done-box p { font-size: 13px; color: #57534e; margin: 0 0 18px; }
	.done-actions { display: flex; flex-direction: column; gap: 8px; }
	.done-actions button, .done-actions a {
		border: none; border-radius: 8px; padding: 10px 16px; font-size: 13px; font-weight: 700; cursor: pointer;
		text-decoration: none; display: block; font-family: inherit;
	}
	.done-primary { background: #b45309; color: #fff; }
	.done-secondary { background: #1c1917; color: #fafaf9; }
	.done-ghost { background: #f5f5f4; color: #44403c; }

	/* Too narrow for three columns: fall back to one stacked, page-scrolling
	   column — the sticky form is a wide-screen affordance, not a hard rule. */
	@media (max-width: 1100px) {
		html, body { height: auto; }
		body { overflow: auto; }
		.layout { flex-direction: column; flex: none; min-height: 0; }
		.list-pane { flex: none; max-height: 40vh; border-right: none; border-bottom: 1px solid #ddd9d0; }
		.preview-col { flex: none; }
		.form-col { flex: none; border-left: none; border-top: 1px solid #ddd9d0; }
		.form-scroll { overflow-y: visible; min-height: 0; }
		.preview-box { min-height: 480px; }
		.facts-form { grid-template-columns: 1fr; }
	}
</style>
</head>
<body>
	<header>
		<div>
			${breadcrumbHtml(page.clientId, page.monthId, bucketLabel(page.bucket))}
			<h1>ตรวจทานเอกสาร — ${Bun.escapeHTML(bucketLabel(page.bucket))}</h1>
			<div class="sub">${Bun.escapeHTML(displayName)} — ${Bun.escapeHTML(page.monthId)}</div>
		</div>
		<span id="count">${page.pages.length} เอกสาร</span>
		<button id="exportBtn" class="btn-export"${page.guard.disabled ? " disabled" : ""} onclick="exportBucket()">ส่งออก PEAK XLSX</button>
	</header>
	${page.guard.disabled && page.guard.message ? `<div class="guard-banner">⏳ ${Bun.escapeHTML(page.guard.message)}</div>` : ""}
	${body}
	<div id="toast"></div>
	<div id="doneModal" role="dialog" aria-modal="true" aria-labelledby="doneTitle">
		<div class="done-box">
			<div class="done-mark">✓</div>
			<h2 id="doneTitle">บันทึกครบทุกเอกสารแล้ว</h2>
			<p id="doneSub"></p>
			<div class="done-actions">
				<button type="button" class="done-primary"${page.guard.disabled ? " disabled" : ""} onclick="closeDone(); exportBucket();">ส่งออก PEAK XLSX</button>
				<a class="done-secondary" href="${reviewHubUrl(page.clientId, page.monthId)}">กลับไปหน้ารวม</a>
				<button type="button" class="done-ghost" onclick="closeDone()">อยู่หน้านี้ต่อ</button>
			</div>
		</div>
	</div>
	<script src="/public/vendor/pdf.min.js"></script>
	<script>
		var guardDisabled = ${page.guard.disabled ? "true" : "false"};
		var exportUrl = ${JSON.stringify(bucketExportUrl(page.clientId, page.monthId, category, vat))};
		var PAGES = ${pagesJsonForScript(page.pages, page.clientId, page.monthId)};
		var currentIndex = 0;

		// --- shared PDF.js viewer ------------------------------------------
		// Replaces the native <embed>, which boots Chrome's whole PDF-viewer
		// extension (~417 requests of toolbar/annotation UI, re-paid on every
		// document switch), ignores #page= changes after load, and exposes no
		// scroll events across the plugin boundary — so it can neither follow
		// the selection nor drive it. Same approach the pre-rewrite review.html
		// settled on (see ksk-keying/scripts/review-template.ts's own note).
		//
		// The whole file is laid out as placeholder divs so the reviewer can
		// scroll it freely, but a page is only painted to a canvas once it
		// comes near the viewport (IntersectionObserver, 600px margin).
		var pdfLib = window.pdfjsLib || null;
		if (pdfLib) pdfLib.GlobalWorkerOptions.workerSrc = "/public/vendor/pdf.worker.min.js";

		var docCache = {};
		var pdfView = {
			token: 0, doc: null, docUrl: null, numPages: 0, visiblePage: 1,
			baseWidth: 0, baseHeight: 0, fitScale: 1, zoom: 1,
			pages: [], rendered: {}, observer: null,
			programmatic: false, settleTimer: null, rafPending: false,
		};

		function pdfScrollEl() { return document.getElementById("pdfScroll"); }

		function setPageLabel() {
			var el = document.getElementById("pdfPageLabel");
			if (!el) return;
			el.textContent = pdfView.numPages ? "หน้า " + pdfView.visiblePage + " / " + pdfView.numPages : "";
			var zoomEl = document.getElementById("pdfZoomLabel");
			if (zoomEl) zoomEl.textContent = Math.round(pdfView.zoom * 100) + "%";
		}

		function showPreviewMessage(text) {
			var stage = document.getElementById("previewStage");
			var existing = stage.querySelector(".preview-loading");
			if (!text) { if (existing) existing.remove(); return; }
			if (!existing) {
				existing = document.createElement("div");
				existing.className = "preview-loading";
				stage.appendChild(existing);
			}
			existing.textContent = text;
		}

		/** Last resort when PDF.js can't load a file at all: the native embed,
		 * heavy toolbar and all — better than an empty pane. */
		function pdfFallback(url, pageNum) {
			var stage = document.getElementById("previewStage");
			var old = stage.querySelector(".pdf-fallback");
			if (old) old.remove();
			var embed = document.createElement("embed");
			embed.className = "pdf-fallback";
			embed.type = "application/pdf";
			embed.src = url + "#page=" + pageNum;
			stage.appendChild(embed);
		}

		function clearFallback() {
			var old = document.querySelector(".pdf-fallback");
			if (old) old.remove();
		}

		async function loadPdf(url) {
			if (docCache[url]) return docCache[url];
			var task = pdfLib.getDocument({ url: url });
			var doc = await task.promise;
			docCache[url] = doc;
			return doc;
		}

		async function buildPdfPages(doc, token) {
			var container = pdfScrollEl();
			if (!container) return;
			if (pdfView.observer) pdfView.observer.disconnect();
			container.innerHTML = "";
			pdfView.rendered = {};
			pdfView.pages = [];

			var first = await doc.getPage(1);
			if (token !== pdfView.token) return;
			var base = first.getViewport({ scale: 1 });
			pdfView.baseWidth = base.width;
			pdfView.baseHeight = base.height;
			pdfView.fitScale = Math.max(200, container.clientWidth - 24) / base.width;
			var scale = pdfView.fitScale * pdfView.zoom;

			for (var i = 1; i <= doc.numPages; i++) {
				var wrap = document.createElement("div");
				wrap.className = "pdf-page";
				wrap.dataset.page = String(i);
				wrap.style.width = Math.floor(base.width * scale) + "px";
				wrap.style.height = Math.floor(base.height * scale) + "px";
				container.appendChild(wrap);
				pdfView.pages.push(wrap);
			}

			pdfView.observer = new IntersectionObserver(function (entries) {
				entries.forEach(function (entry) {
					if (entry.isIntersecting) renderPdfPage(Number(entry.target.dataset.page), token);
				});
			}, { root: container, rootMargin: "600px 0px" });
			pdfView.pages.forEach(function (wrap) { pdfView.observer.observe(wrap); });
		}

		async function renderPdfPage(num, token) {
			if (token !== pdfView.token || pdfView.rendered[num] || !pdfView.doc) return;
			pdfView.rendered[num] = true;
			var page = await pdfView.doc.getPage(num);
			if (token !== pdfView.token) return;
			var viewport = page.getViewport({ scale: pdfView.fitScale * pdfView.zoom });
			var wrap = pdfView.pages[num - 1];
			if (!wrap) return;
			// Page 1 sized every placeholder; correct this page to its real size.
			wrap.style.width = Math.floor(viewport.width) + "px";
			wrap.style.height = Math.floor(viewport.height) + "px";
			var canvas = document.createElement("canvas");
			var dpr = Math.min(window.devicePixelRatio || 1, 2);
			canvas.width = Math.floor(viewport.width * dpr);
			canvas.height = Math.floor(viewport.height * dpr);
			wrap.appendChild(canvas);
			await page.render({
				canvasContext: canvas.getContext("2d"),
				viewport: viewport,
				transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
			}).promise;
			if (token !== pdfView.token && canvas.parentNode === wrap) wrap.removeChild(canvas);
		}

		function scrollPdfTo(num, smooth) {
			var container = pdfScrollEl();
			var wrap = pdfView.pages[num - 1];
			if (!container || !wrap) return;
			// Mute scroll→selection while this programmatic scroll plays out, so
			// it can't fight the selection that triggered it.
			pdfView.programmatic = true;
			clearTimeout(pdfView.settleTimer);
			pdfView.settleTimer = setTimeout(function () { pdfView.programmatic = false; }, smooth ? 700 : 200);
			container.scrollTo({ top: Math.max(0, wrap.offsetTop - 10), behavior: smooth ? "smooth" : "auto" });
			pdfView.visiblePage = num;
			setPageLabel();
		}

		function onPdfScroll() {
			if (!pdfView.pages.length || pdfView.rafPending) return;
			pdfView.rafPending = true;
			requestAnimationFrame(function () {
				pdfView.rafPending = false;
				var container = pdfScrollEl();
				if (!container) return;
				var center = container.scrollTop + container.clientHeight / 2;
				var best = 1, bestDistance = Infinity;
				pdfView.pages.forEach(function (wrap) {
					var distance = Math.abs(wrap.offsetTop + wrap.offsetHeight / 2 - center);
					if (distance < bestDistance) { bestDistance = distance; best = Number(wrap.dataset.page); }
				});
				if (best !== pdfView.visiblePage) { pdfView.visiblePage = best; setPageLabel(); }
				if (!pdfView.programmatic) syncSelectionToPdfPage(best);
			});
		}

		/** Inverted sync: the reviewer scrolled the PDF onto another document's
		 * page, so move the list selection + form to match. Sets state directly
		 * rather than calling selectPage, which would scroll the PDF right back. */
		function syncSelectionToPdfPage(pageNum) {
			var current = PAGES[currentIndex];
			if (current && current.src === pdfView.docUrl && current.page === pageNum) return;
			for (var i = 0; i < PAGES.length; i++) {
				if (PAGES[i].src === pdfView.docUrl && PAGES[i].page === pageNum) {
					if (i !== currentIndex) applySelection(i);
					return;
				}
			}
		}

		async function showPdfFor(meta, token) {
			var scroll = pdfScrollEl();
			if (!pdfLib) { showPreviewMessage(""); clearFallback(); pdfFallback(meta.src, meta.page); return; }
			clearFallback();
			scroll.classList.add("is-active");
			if (pdfView.docUrl === meta.src && pdfView.doc) {
				showPreviewMessage("");
				scrollPdfTo(meta.page, false);
				return;
			}
			showPreviewMessage("กำลังโหลด PDF…");
			try {
				var doc = await loadPdf(meta.src);
				if (token !== pdfView.token) return;
				pdfView.doc = doc;
				pdfView.docUrl = meta.src;
				pdfView.numPages = doc.numPages;
				await buildPdfPages(doc, token);
				if (token !== pdfView.token) return;
				showPreviewMessage("");
				scrollPdfTo(meta.page, false);
			} catch (err) {
				if (token !== pdfView.token) return;
				showPreviewMessage("");
				scroll.classList.remove("is-active");
				pdfFallback(meta.src, meta.page);
			}
		}

		function pdfZoom(direction) {
			if (!pdfView.doc) return;
			if (direction === 0) pdfView.zoom = 1;
			else pdfView.zoom = Math.min(3, Math.max(0.5, pdfView.zoom + direction * 0.25));
			var at = pdfView.visiblePage;
			var token = ++pdfView.token;
			buildPdfPages(pdfView.doc, token).then(function () {
				if (token === pdfView.token) scrollPdfTo(at, false);
			});
			setPageLabel();
		}

		// --- selection ------------------------------------------------------

		/** Everything a selection change does EXCEPT moving the PDF — so the
		 * scroll→selection direction can reuse it without recursing. */
		function applySelection(index) {
			currentIndex = index;
			var meta = PAGES[index];
			document.querySelectorAll(".detail-panel").forEach(function (p) { p.classList.remove("is-open"); });
			document.querySelectorAll(".list-row").forEach(function (r) { r.classList.remove("is-active"); });
			var panel = document.querySelector('.detail-panel[data-index="' + index + '"]');
			var row = document.querySelector('.list-row[data-index="' + index + '"]');
			if (panel) panel.classList.add("is-open");
			if (row) {
				row.classList.add("is-active");
				row.scrollIntoView({ block: "nearest" });
			}

			var titleEl = document.getElementById("previewTitle");
			titleEl.textContent = meta.title;
			var refEl = document.createElement("span");
			refEl.className = "detail-ref";
			refEl.textContent = " · " + meta.ref;
			titleEl.appendChild(refEl);
			document.getElementById("previewAttention").style.display = meta.attention ? "" : "none";
			var flagsEl = document.getElementById("previewFlags");
			flagsEl.style.display = meta.flags.length ? "" : "none";
			flagsEl.textContent = meta.flags.length ? "⚠ " + meta.flags.join(" · ") : "";

			document.querySelectorAll(".static-preview").forEach(function (el) {
				el.classList.toggle("is-active", Number(el.dataset.index) === index);
			});
		}

		function selectPage(index) {
			applySelection(index);
			var meta = PAGES[index];
			var token = ++pdfView.token;
			if (meta.kind === "pdf" && meta.src) {
				showPdfFor(meta, token);
			} else {
				clearFallback();
				showPreviewMessage("");
				pdfScrollEl().classList.remove("is-active");
				pdfView.docUrl = null;
				pdfView.doc = null;
				pdfView.numPages = 0;
				setPageLabel();
			}
		}

		function escapeHtml(s) {
			return String(s).replace(/[&<>"']/g, function (c) {
				return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
			});
		}

		// Vanilla-JS mirror of computeLineSubtotals() (document-review.ts) — reads
		// the CURRENT DOM state (not the original server-rendered values) so the
		// reviewer sees running totals update live as they edit amounts/reassign
		// accounts, before ever hitting Save. Duplicated logic is expected: the
		// two can't share code across the script-string boundary.
		function recomputeSubtotals(panel) {
			var box = panel.querySelector("[data-subtotals]");
			if (!box) return;
			var order = [];
			var totals = {};
			panel.querySelectorAll(".line-row").forEach(function (row) {
				var select = row.querySelector('[data-field="account_key"]');
				var amountInput = row.querySelector('[data-field="amount"]');
				if (!select || !amountInput) return;
				var key = select.value;
				var opt = select.options[select.selectedIndex];
				var label = opt ? opt.textContent : key;
				var amount = parseFloat(amountInput.value);
				if (!isFinite(amount)) amount = 0;
				if (!(key in totals)) {
					totals[key] = { label: label, total: 0 };
					order.push(key);
				}
				totals[key].total += amount;
			});
			if (order.length === 0) {
				box.innerHTML = '<div class="subtotals-empty">ไม่มีบรรทัดรายการ</div>';
				return;
			}
			var html = '<div class="subtotals-title">ยอดรวมตามบัญชี (เอกสารนี้)</div>';
			order.forEach(function (key) {
				var item = totals[key];
				html += '<div class="subtotal-row"><span class="subtotal-label">' + escapeHtml(item.label) +
					'</span><span class="subtotal-total">' +
					item.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
					"</span></div>";
			});
			box.innerHTML = html;
		}

		document.addEventListener("input", function (e) {
			var el = e.target;
			if (!el || !el.getAttribute || el.getAttribute("data-field") !== "amount") return;
			var panel = el.closest(".detail-panel");
			if (panel) recomputeSubtotals(panel);
		});
		document.addEventListener("change", function (e) {
			var el = e.target;
			if (!el || !el.getAttribute || el.getAttribute("data-field") !== "account_key") return;
			var panel = el.closest(".detail-panel");
			if (panel) recomputeSubtotals(panel);
		});

		function gatherPageEdit(panel) {
			var facts = {};
			panel.querySelectorAll(".facts-form [data-fact-key]").forEach(function (el) {
				var key = el.getAttribute("data-fact-key");
				var raw = el.value;
				if (key === "vat_treatment") {
					facts[key] = raw; // "" is itself a legitimate value for this field
					return;
				}
				if (el.getAttribute("data-fact-numeric") === "true") {
					facts[key] = raw === "" ? null : (isFinite(parseFloat(raw)) ? parseFloat(raw) : null);
				} else {
					facts[key] = raw === "" ? null : raw;
				}
			});

			var lines = [];
			panel.querySelectorAll(".line-row").forEach(function (row) {
				var patch = { line_index: parseInt(row.getAttribute("data-line-index"), 10) };
				row.querySelectorAll("[data-field]").forEach(function (el) {
					var field = el.getAttribute("data-field");
					var raw = el.value;
					if (field === "qty" || field === "unit_price" || field === "amount") {
						patch[field] = raw === "" ? null : (isFinite(parseFloat(raw)) ? parseFloat(raw) : null);
					} else if (field === "description" || field === "unit") {
						patch[field] = raw === "" ? null : raw;
					} else if (field === "account_key") {
						patch.account_key = raw;
					} else if (field === "vat_treatment") {
						patch.vat_treatment = raw === "" ? null : raw;
					}
				});
				lines.push(patch);
			});

			var skipCheckbox = panel.querySelector("[data-skip-checkbox]");
			return { facts: facts, lines: lines, skipped: skipCheckbox ? !!skipCheckbox.checked : false };
		}

		async function exportBucket() {
			if (guardDisabled) return;
			var btn = document.getElementById("exportBtn");
			var originalText = btn.textContent;
			btn.disabled = true;
			btn.textContent = "กำลังส่งออก...";
			try {
				var res = await fetch(exportUrl, { method: "POST" });
				var body = await res.json().catch(function () { return {}; });
				if (!res.ok) {
					alert(body.error || "ส่งออกไม่สำเร็จ");
					return;
				}
				if (body.warnings && body.warnings.length) {
					alert("พบข้อควรตรวจสอบ " + body.warnings.length + " รายการ:\\n" + body.warnings.slice(0, 20).join("\\n"));
				}
				var binary = atob(body.dataBase64);
				var bytes = new Uint8Array(binary.length);
				for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
				var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
				var url = URL.createObjectURL(blob);
				var a = document.createElement("a");
				a.href = url;
				a.download = body.filename || "export.xlsx";
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
			} catch (err) {
				alert("ส่งออกไม่สำเร็จ");
			} finally {
				btn.disabled = false;
				btn.textContent = originalText;
			}
		}

		async function savePage(index, buttonEl) {
			if (guardDisabled) return;
			var panel = document.querySelector('.detail-panel[data-index="' + index + '"]');
			if (!panel) return;
			var indicator = panel.querySelector("[data-save-indicator]");
			var originalText = buttonEl.textContent;
			buttonEl.disabled = true;
			buttonEl.textContent = "กำลังบันทึก...";
			if (indicator) indicator.textContent = "";
			var edit = gatherPageEdit(panel);
			try {
				var res = await fetch(panel.getAttribute("data-save-url"), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(edit),
				});
				if (!res.ok) {
					var errBody = await res.json().catch(function () { return {}; });
					alert(errBody.error || "บันทึกไม่สำเร็จ");
					buttonEl.disabled = false;
					buttonEl.textContent = originalText;
					return;
				}
			} catch (err) {
				alert("บันทึกไม่สำเร็จ");
				buttonEl.disabled = false;
				buttonEl.textContent = originalText;
				return;
			}
			buttonEl.disabled = false;
			buttonEl.textContent = originalText;
			if (indicator) {
				indicator.textContent = "✓ บันทึกแล้ว";
				setTimeout(function () { indicator.textContent = ""; }, 3000);
			}
			markDone(index);
			advanceAfterSave(index);
		}

		// --- progress + auto-advance -----------------------------------------
		// "Done" is session state, not something the artifacts record: a
		// reviewer who reloads starts the count over. It exists to move the
		// cursor along and to know when a sitting is finished, not to certify
		// the bucket — the ledger gates do that.
		var doneSet = {};
		var doneAnnounced = false;

		function pendingCount() {
			var left = 0;
			for (var i = 0; i < PAGES.length; i++) if (!doneSet[i]) left++;
			return left;
		}

		function updateCount() {
			var el = document.getElementById("count");
			if (!el) return;
			var done = PAGES.length - pendingCount();
			el.textContent = PAGES.length + " เอกสาร · บันทึกแล้ว " + done + "/" + PAGES.length;
		}

		function markDone(index) {
			doneSet[index] = true;
			var row = document.querySelector('.list-row[data-index="' + index + '"]');
			if (row) row.classList.add("is-done");
			updateCount();
		}

		function toast(msg) {
			var t = document.getElementById("toast");
			if (!t) return;
			t.textContent = msg;
			t.classList.add("on");
			clearTimeout(toast.timer);
			toast.timer = setTimeout(function () { t.classList.remove("on"); }, 2400);
		}

		/** Next document still needing a save, searching forward from the one
		 * just saved and wrapping — so saving out of order still lands on real
		 * remaining work rather than dead-ending at the bottom of the list. */
		function nextPending(from) {
			for (var step = 1; step <= PAGES.length; step++) {
				var i = (from + step) % PAGES.length;
				if (!doneSet[i]) return i;
			}
			return -1;
		}

		function advanceAfterSave(index) {
			var next = nextPending(index);
			if (next === -1) {
				if (!doneAnnounced) {
					doneAnnounced = true;
					showDone();
				}
				return;
			}
			selectPage(next);
			toast("บันทึกแล้ว → เอกสารถัดไป (เหลืออีก " + pendingCount() + ")");
		}

		function showDone() {
			var sub = document.getElementById("doneSub");
			if (sub) sub.textContent = "ตรวจและบันทึกครบทั้ง " + PAGES.length + " เอกสารในหมวดนี้แล้ว";
			var modal = document.getElementById("doneModal");
			if (modal) modal.classList.add("on");
		}

		function closeDone() {
			var modal = document.getElementById("doneModal");
			if (modal) modal.classList.remove("on");
		}

		document.addEventListener("keydown", function (e) {
			if (e.key === "Escape") closeDone();
		});

		// --- viewer wiring ---------------------------------------------------
		if (PAGES.length) {
			var scrollEl = pdfScrollEl();
			if (scrollEl) scrollEl.addEventListener("scroll", onPdfScroll, { passive: true });

			// Re-fit when the preview column's width changes (window resize):
			// fitScale is derived from it, so stale placeholders would misalign.
			if (window.ResizeObserver && scrollEl) {
				var resizeTimer = null;
				var lastWidth = scrollEl.clientWidth;
				new ResizeObserver(function () {
					if (scrollEl.clientWidth === lastWidth || !pdfView.doc) return;
					lastWidth = scrollEl.clientWidth;
					clearTimeout(resizeTimer);
					resizeTimer = setTimeout(function () {
						var at = pdfView.visiblePage;
						var token = ++pdfView.token;
						buildPdfPages(pdfView.doc, token).then(function () {
							if (token === pdfView.token) scrollPdfTo(at, false);
						});
					}, 150);
				}).observe(scrollEl);
			}

			for (var seed = 0; seed < PAGES.length; seed++) {
				if (PAGES[seed].skipped) markDone(seed);
			}
			updateCount();
			selectPage(0);
		}
	</script>
</body>
</html>`;
}
