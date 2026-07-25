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
// detail panels are pre-rendered up front (display:none for inactive ones)
// and toggled client-side by selectPage() — no framework, no per-page
// re-fetch, same "everything baked into one document" posture as
// excluded-review.ts's viewer-panel toggling.
import { join } from "node:path";
import { type CoaRow, coaKey, coaLabel } from "./coa";
import { formatNumber, normalizeDateForPeak } from "./peak-format";
import { type DocumentBucket, isMixedBucket, type ReviewLine, type ReviewPage } from "./review-data";
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

async function pagePreviewHtml(clientMonthDir: string, clientId: string, monthId: string, p: ReviewPage): Promise<string> {
	if (!p.source_src) {
		return `<div class="preview-placeholder">ไม่มีเอกสารตัวอย่าง</div>`;
	}
	if (isXlsxFile(p.source_src)) {
		const absPath = join(clientMonthDir, p.source_src);
		const tables = loadSheetTables(absPath, p.source_sheet);
		if (tables === null) {
			return `<div class="preview-placeholder">ไม่สามารถแสดงตัวอย่างไฟล์ Excel นี้ได้<br/>${Bun.escapeHTML(p.source_src)}</div>`;
		}
		return renderWorkbookPreviewHtml(tables);
	}
	const src = fileUrl(clientId, monthId, p.source_src) + (p.source_page != null ? `#page=${p.source_page}` : "");
	return `<embed class="pdf-embed" src="${src}" type="application/pdf" />`;
}

function pageListRowHtml(p: ReviewPage, index: number): string {
	const flags = p.group_review_flags ?? [];
	const flagIcon = flags.length ? `<span class="flag-icon" title="${Bun.escapeHTML(flags.join("\n"))}">⚠</span>` : "";
	const attentionBadge = p.initial_status === "needs_attention" ? `<span class="badge-attention">ต้องตรวจสอบ</span>` : "";
	return `<div class="list-row ${index === 0 ? "is-active" : ""}" data-index="${index}" onclick="selectPage(${index})">
		<div class="row-title">${Bun.escapeHTML(p.group_label ?? "")} ${flagIcon}</div>
		<div class="row-sub">${Bun.escapeHTML(p.short_ref)}</div>
		${attentionBadge}
	</div>`;
}

function factFieldHtml(key: string, value: string | number | null, disabledAttr: string): string {
	const label = factLabel(key);
	const escapedKey = Bun.escapeHTML(key);

	if (key === "vat_treatment") {
		const current = value == null ? "" : String(value);
		const options = ["", "vat_7", "non_vat", "unknown"]
			.map((opt) => `<option value="${opt}" ${opt === current ? "selected" : ""}>${opt === "" ? "(ไม่ระบุ)" : opt}</option>`)
			.join("");
		return `<div class="field"><label>${Bun.escapeHTML(label)}</label><select data-fact-key="${escapedKey}"${disabledAttr}>${options}</select></div>`;
	}

	const numeric = isNumericFactKey(key);
	const inputType = numeric ? "number" : "text";
	const stepAttr = numeric ? ` step="any"` : "";
	const escapedValue = Bun.escapeHTML(value == null ? "" : String(value));
	const hintText = key === "date" ? peakDateHint(value) : "";
	const hint = hintText ? `<div class="peak-hint">${Bun.escapeHTML(hintText)}</div>` : "";
	return `<div class="field"><label>${Bun.escapeHTML(label)}</label><input type="${inputType}"${stepAttr} data-fact-key="${escapedKey}" data-fact-numeric="${numeric}" value="${escapedValue}"${disabledAttr} />${hint}</div>`;
}

function lineRowHtml(line: ReviewLine, coaRows: CoaRow[], mixed: boolean, disabledAttr: string): string {
	const currentKey = coaKey({ account_code: line.account_code, sub_code: line.sub_code });
	const accountOptions = coaRows
		.map((row) => {
			const key = coaKey(row);
			return `<option value="${Bun.escapeHTML(key)}" ${key === currentKey ? "selected" : ""}>${Bun.escapeHTML(coaLabel(row))}</option>`;
		})
		.join("");
	const confMeta = CONFIDENCE_META[line.confidence];
	const vatCell = mixed
		? `<td><select data-field="vat_treatment" data-line-index="${line.line_index}"${disabledAttr}>
			<option value="" ${!line.vat_treatment ? "selected" : ""}>ตามเอกสาร</option>
			<option value="vat_7" ${line.vat_treatment === "vat_7" ? "selected" : ""}>vat_7</option>
			<option value="non_vat" ${line.vat_treatment === "non_vat" ? "selected" : ""}>non_vat</option>
		</select></td>`
		: "";
	return `<tr class="line-row" data-line-index="${line.line_index}">
		<td>${line.line_index}</td>
		<td><input type="text" data-field="description" data-line-index="${line.line_index}" value="${Bun.escapeHTML(line.description ?? "")}"${disabledAttr} /></td>
		<td><input type="number" step="any" data-field="qty" data-line-index="${line.line_index}" value="${line.qty ?? ""}"${disabledAttr} /></td>
		<td><input type="text" data-field="unit" data-line-index="${line.line_index}" value="${Bun.escapeHTML(line.unit ?? "")}"${disabledAttr} /></td>
		<td><input type="number" step="any" data-field="unit_price" data-line-index="${line.line_index}" value="${line.unit_price ?? ""}"${disabledAttr} /></td>
		<td><input type="number" step="any" class="amount-input" data-field="amount" data-line-index="${line.line_index}" value="${line.amount ?? ""}"${disabledAttr} /></td>
		<td><select data-field="account_key" data-line-index="${line.line_index}"${disabledAttr}>${accountOptions}</select></td>
		${vatCell}
		<td><span class="badge-confidence" style="color:${confMeta.fg};background:${confMeta.bg};">${confMeta.label}</span></td>
		<td class="reason-cell" title="${Bun.escapeHTML(line.reason)}">${Bun.escapeHTML(line.reason)}</td>
		<td>${line.needs_review ? `<span class="badge-needs-review">⚠ ต้องตรวจสอบ</span>` : "—"}</td>
	</tr>`;
}

function renderSubtotalsHtml(subtotals: LineSubtotal[]): string {
	if (subtotals.length === 0) return `<div class="subtotals-empty">ไม่มีบรรทัดรายการ</div>`;
	const rows = subtotals
		.map((s) => `<div class="subtotal-row"><span class="subtotal-label">${Bun.escapeHTML(s.label)}</span><span class="subtotal-total">${formatNumber(s.total)}</span></div>`)
		.join("");
	return `<div class="subtotals-title">ยอดรวมตามบัญชี (เอกสารนี้)</div>${rows}`;
}

function detailPanelHtml(pageData: DocumentReviewPage, p: ReviewPage, index: number, previewHtml: string, category: string, vat: string, mixed: boolean): string {
	const disabledAttr = pageData.guard.disabled ? " disabled" : "";
	const flags = p.group_review_flags ?? [];
	const flagsBanner = flags.length ? `<div class="flags-banner">⚠ ${flags.map((f) => Bun.escapeHTML(f)).join(" · ")}</div>` : "";
	const factsHtml = Object.entries(p.facts)
		.map(([key, value]) => factFieldHtml(key, value, disabledAttr))
		.join("");
	const linesHeader = `<tr><th>#</th><th>รายละเอียด</th><th>จำนวน</th><th>หน่วย</th><th>ราคา/หน่วย</th><th>จำนวนเงิน</th><th>บัญชี</th>${mixed ? "<th>VAT</th>" : ""}<th>ความมั่นใจ</th><th>เหตุผล</th><th>ต้องตรวจสอบ</th></tr>`;
	const linesRows = p.lines.map((line) => lineRowHtml(line, pageData.coaRows, mixed, disabledAttr)).join("");
	const subtotalsHtml = renderSubtotalsHtml(computeLineSubtotals(p.lines, pageData.coaRows));
	const saveUrl = pageEditUrl(pageData.clientId, pageData.monthId, category, vat, p.group_id ?? "", p.page_index_in_group ?? 0);

	return `<div class="detail-panel" data-index="${index}" data-save-url="${Bun.escapeHTML(saveUrl)}" style="display:${index === 0 ? "block" : "none"};">
		<div class="detail-header">
			<div class="detail-title">${Bun.escapeHTML(p.group_label ?? "")} <span class="detail-ref">· ${Bun.escapeHTML(p.short_ref)}</span></div>
			${p.initial_status === "needs_attention" ? `<span class="badge-attention">ต้องตรวจสอบ</span>` : ""}
		</div>
		${flagsBanner}
		<div class="preview-box">${previewHtml}</div>
		<div class="facts-form">${factsHtml}</div>
		<div class="lines-wrap">
			<table class="lines-table"><thead>${linesHeader}</thead><tbody>${linesRows}</tbody></table>
		</div>
		<div class="subtotals-box" data-subtotals>${subtotalsHtml}</div>
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
	for (let i = 0; i < page.pages.length; i++) {
		const p = page.pages[i];
		const previewHtml = await pagePreviewHtml(clientMonthDir, page.clientId, page.monthId, p);
		panels.push(detailPanelHtml(page, p, i, previewHtml, category, vat, mixed));
	}

	const body =
		page.pages.length === 0
			? `<div class="empty-state">ไม่มีเอกสารในหมวดนี้</div>`
			: `<div class="layout">
				<div class="list-pane">${listRows}</div>
				<div class="detail-pane">${panels.join("")}</div>
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
	body { font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f7f6f3; color: #292524; }
	header {
		background: #1c1917; color: #fafaf9; padding: 12px 20px; display: flex;
		align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
	}
	header a.back { color: #a8a29e; font-size: 12px; text-decoration: none; }
	header h1 { font-size: 15px; margin: 0; }
	header .sub { font-size: 11.5px; color: #a8a29e; }
	#count { font-size: 12.5px; font-weight: 600; background: #292524; padding: 4px 11px; border-radius: 999px; }
	.guard-banner {
		background: #fef3c7; color: #92400e; padding: 10px 20px; font-size: 13px; font-weight: 600;
		border-bottom: 1px solid #fde68a;
	}
	.empty-state {
		margin: 60px auto; max-width: 480px; text-align: center; font-size: 15px; font-weight: 600;
		color: #57534e; background: #fff; padding: 30px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}
	.layout { display: flex; height: calc(100vh - 50px); }
	.list-pane { flex: 0 0 300px; overflow-y: auto; background: #f7f6f3; padding: 14px; border-right: 1px solid #ddd9d0; }
	.list-row {
		background: #fff; border-radius: 10px; padding: 12px; margin-bottom: 8px; cursor: pointer;
		border: 2px solid transparent; display: flex; flex-direction: column; gap: 4px;
	}
	.list-row:hover { border-color: #d6d3cd; }
	.list-row.is-active { border-color: #1d4ed8; box-shadow: 0 2px 10px rgba(29,78,216,0.14); }
	.row-title { font-weight: 700; font-size: 13px; color: #292524; }
	.row-sub { font-size: 11.5px; color: #78716c; }
	.flag-icon { color: #b45309; font-weight: 700; cursor: help; }
	.badge-attention { align-self: flex-start; font-size: 10.5px; font-weight: 700; color: #b91c1c; background: #fee2e2; padding: 2px 8px; border-radius: 999px; }
	.detail-pane { flex: 1; overflow-y: auto; padding: 20px; }
	.detail-panel { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); max-width: 1100px; }
	.detail-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
	.detail-title { font-weight: 700; font-size: 14.5px; }
	.detail-ref { font-weight: 400; color: #78716c; }
	.flags-banner { background: #fef3c7; color: #92400e; font-size: 12.5px; font-weight: 600; padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; }
	.preview-box {
		background: #ece9e3; border-radius: 10px; padding: 14px; margin-bottom: 18px;
		display: flex; align-items: center; justify-content: center; min-height: 200px; overflow: auto;
	}
	.pdf-embed { width: 100%; height: 60vh; border: none; }
	.preview-placeholder { color: #78716c; font-size: 13px; text-align: center; padding: 20px; }
	.xlsx-sheet-table { background: #fff; border-radius: 10px; padding: 16px; max-width: 100%; display: flex; flex-direction: column; gap: 8px; width: 100%; }
	.xlsx-sheet-name { font-size: 12.5px; font-weight: 700; color: #57534e; }
	.xlsx-table-scroll { overflow: auto; max-height: 50vh; border: 1px solid #ece9e3; border-radius: 6px; }
	.xlsx-table-scroll table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
	.xlsx-table-scroll td { border: 1px solid #ece9e3; padding: 4px 8px; }
	.xlsx-table-scroll tr.xlsx-header-row td { background: #ece9e3; font-weight: 700; }
	.xlsx-truncated-note { font-size: 11px; color: #a8a29e; }
	.xlsx-empty { color: #78716c; font-size: 13px; padding: 12px; }
	.xlsx-sheet-divider { height: 1px; background: #ece9e3; margin: 4px 0; }
	.facts-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-bottom: 18px; }
	.field { display: flex; flex-direction: column; gap: 3px; }
	.field label { font-size: 11px; font-weight: 700; color: #78716c; }
	.field input, .field select { font: inherit; padding: 6px 8px; border: 1px solid #ddd9d0; border-radius: 6px; background: #fff; color: #292524; }
	.field input:disabled, .field select:disabled { background: #f1efec; color: #78716c; }
	.peak-hint { font-size: 10.5px; color: #a8a29e; }
	.lines-wrap { overflow-x: auto; margin-bottom: 12px; }
	.lines-table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
	.lines-table th { text-align: left; font-size: 11px; color: #78716c; padding: 6px 8px; border-bottom: 2px solid #ece9e3; white-space: nowrap; }
	.lines-table td { padding: 4px 6px; border-bottom: 1px solid #ece9e3; vertical-align: middle; }
	.lines-table input, .lines-table select { font: inherit; font-size: 12.5px; padding: 4px 6px; border: 1px solid #ddd9d0; border-radius: 5px; width: 100%; min-width: 70px; background: #fff; color: #292524; }
	.lines-table input:disabled, .lines-table select:disabled { background: #f1efec; color: #78716c; }
	.reason-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #57534e; }
	.badge-confidence { font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
	.badge-needs-review { font-size: 10.5px; font-weight: 700; color: #b91c1c; white-space: nowrap; }
	.subtotals-box { background: #f7f6f3; border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; max-width: 420px; }
	.subtotals-title { font-size: 11.5px; font-weight: 700; color: #78716c; margin-bottom: 6px; }
	.subtotal-row { display: flex; justify-content: space-between; font-size: 12.5px; padding: 2px 0; }
	.subtotal-label { color: #57534e; }
	.subtotal-total { font-weight: 700; }
	.subtotals-empty { font-size: 12.5px; color: #a8a29e; }
	.save-bar { display: flex; align-items: center; gap: 12px; }
	.skip-toggle { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #57534e; cursor: pointer; }
	.btn-save { border: none; border-radius: 7px; padding: 9px 18px; font-size: 13px; font-weight: 700; cursor: pointer; background: #15803d; color: #fff; }
	.btn-save[disabled] { opacity: 0.5; cursor: default; }
	.save-indicator { font-size: 12.5px; font-weight: 700; color: #15803d; }
	.btn-export { border: none; border-radius: 7px; padding: 8px 16px; font-size: 12.5px; font-weight: 700; cursor: pointer; background: #b45309; color: #fff; }
	.btn-export[disabled] { opacity: 0.5; cursor: default; }

	@media (max-width: 860px) {
		.layout { flex-direction: column; height: auto; }
		body { overflow: auto; }
		.list-pane { flex: none; max-height: 40vh; }
		.detail-pane { padding: 12px; }
		.detail-panel { max-width: none; }
	}
</style>
</head>
<body>
	<header>
		<div>
			<a class="back" href="/">← กลับไปที่ Dashboard</a>
			<h1>ตรวจทานเอกสาร — ${Bun.escapeHTML(bucketLabel(page.bucket))}</h1>
			<div class="sub">${Bun.escapeHTML(displayName)} — ${Bun.escapeHTML(page.monthId)}</div>
		</div>
		<span id="count">${page.pages.length} เอกสาร</span>
		<button id="exportBtn" class="btn-export"${page.guard.disabled ? " disabled" : ""} onclick="exportBucket()">ส่งออก PEAK XLSX</button>
	</header>
	${page.guard.disabled && page.guard.message ? `<div class="guard-banner">⏳ ${Bun.escapeHTML(page.guard.message)}</div>` : ""}
	${body}
	<script>
		var guardDisabled = ${page.guard.disabled ? "true" : "false"};
		var exportUrl = ${JSON.stringify(bucketExportUrl(page.clientId, page.monthId, category, vat))};

		function selectPage(index) {
			document.querySelectorAll(".detail-panel").forEach(function (p) { p.style.display = "none"; });
			document.querySelectorAll(".list-row").forEach(function (r) { r.classList.remove("is-active"); });
			var panel = document.querySelector('.detail-panel[data-index="' + index + '"]');
			var row = document.querySelector('.list-row[data-index="' + index + '"]');
			if (panel) panel.style.display = "block";
			if (row) row.classList.add("is-active");
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
		}
	</script>
</body>
</html>`;
}
