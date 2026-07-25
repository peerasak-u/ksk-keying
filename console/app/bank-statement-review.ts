// Bank-statement bucket review page (wayfinder ticket #41, the bank_statement
// slice of "category/group review pages + build-review-data.ts fix").
//
// Laid out as a SPLIT VIEW: the source statement pinned on the left in the
// shared PDF.js viewer, everything editable scrolling on the right. Chosen
// over a full-width table with an on-demand preview after prototyping all
// three (console/_prototype_stmt_layout, deleted) — the work here is checking
// 300+ rows against the statement image one at a time, so the document has to
// stay on screen; the cost is that the table's rightmost columns need a
// sideways scroll, which the sticky filter bar and the row counter mitigate.
//
// Renders one statement (bank account) at a time from loadBucketStatements()'s
// StatementEntry[] — never flattened/merged across accounts, unlike the
// document buckets someone else is building in parallel. Same warm-stone
// neutral palette, Bun.escapeHTML()-everywhere, and in-flight-disable/
// error-alert/restore save-button pattern as excluded-review.ts, so the two
// pages read as one app.
//
// The two calculations that matter most here — the integrity check (opening +
// Σin − Σout vs closing) and the per-account running subtotal — are ported
// verbatim from the old Vue console's review-template.ts (quoted in the
// wayfinder ticket) and exported as pure, independently unit-tested functions.
// The subtotal ALSO gets a plain vanilla-JS mirror in the inline <script>,
// since it must recompute live as a reviewer edits row amounts/reassigns
// accounts before ever hitting Save; the integrity check does not need a live
// mirror — it is computed once at render time (filters never affect it).
import { join } from "node:path";
import { coaKey, coaLabel, type CoaRow } from "./coa";
import { BREADCRUMB_CSS, breadcrumbHtml } from "./nav";
import { formatBaht, formatStatementDate, normalizeAmount } from "./peak-format";
import type { StatementEntry, StatementInfo, StatementRow, StatementSource } from "./review-data";
import { isXlsxFile, loadSheetTables, renderWorkbookPreviewHtml } from "./xlsx-preview";

export type BankStatementReviewGuard = { disabled: boolean; message: string | null };

export type BankStatementReviewPage = {
	clientId: string;
	monthId: string;
	companyName: string | null;
	coaRows: CoaRow[];
	guard: BankStatementReviewGuard;
	statements: StatementEntry[];
};

// ---------------------------------------------------------------------------
// Pure calculations — ported verbatim (see file header), unit tested in
// bank-statement-review.test.ts with fixed fixtures.

export type IntegrityCheckResult = { computed: number; diff: number; ok: boolean };

/** Opening + Σ(in) − Σ(out) vs closing, to the satang. Runs over ALL rows
 * passed in regardless of any filter currently applied in the UI (filters
 * only ever affect what's visually shown, never this number) — since this is
 * server-rendered, it's computed once here from whatever rows the caller
 * passes (the live/current, post-edit values), not recomputed client-side. */
export function computeIntegrityCheck(statement: StatementInfo, rows: StatementRow[]): IntegrityCheckResult {
	let sumIn = 0;
	let sumOut = 0;
	for (const row of rows) {
		const amount = normalizeAmount(row.amount);
		if (row.direction === "in") sumIn += amount;
		else sumOut += amount;
	}
	const opening = normalizeAmount(statement.opening_balance);
	const closing = normalizeAmount(statement.closing_balance);
	const computed = Math.round((opening + sumIn - sumOut) * 100) / 100;
	const diff = Math.round((computed - closing) * 100) / 100;
	return { computed, diff, ok: Math.abs(diff) < 0.005 };
}

export type AccountSubtotal = { key: string; label: string; total: number };

/** Per-account running subtotal, scoped to the rows passed in (the caller is
 * responsible for scoping this to ONE currently-open statement — never
 * bucket-wide). Key is coaKey() (account_code + "||" + sub_code); sums the
 * row's amount as-is (positive, direction not applied) — a faithful port of
 * the old behavior, not a signed net. A row with no account_code is skipped;
 * an account_code/sub_code pair absent from coaRows falls back to the raw key
 * as its own label rather than throwing. */
export function computeAccountSubtotals(rows: StatementRow[], coaRows: CoaRow[]): AccountSubtotal[] {
	const byKey = new Map<string, AccountSubtotal>();
	for (const row of rows) {
		if (!row.account_code) continue;
		const key = `${row.account_code}||${row.sub_code}`;
		const amount = normalizeAmount(row.amount);
		const existing = byKey.get(key);
		if (existing) {
			existing.total += amount;
			continue;
		}
		const coaRow = coaRows.find((c) => coaKey(c) === key);
		byKey.set(key, { key, label: coaRow ? coaLabel(coaRow) : key, total: amount });
	}
	return Array.from(byKey.values());
}

/** The COA row (or synthetic fallback key) the "ยังอยู่บัญชีพัก 999999" filter
 * button jumps the account filter to. */
function suspenseAccountKey(coaRows: CoaRow[]): string {
	const row = coaRows.find((r) => r.account_code === "999999");
	return row ? coaKey(row) : "999999||";
}

// ---------------------------------------------------------------------------
// Small rendering helpers.

function disabledAttr(guard: BankStatementReviewGuard): string {
	return guard.disabled ? "disabled" : "";
}

function confidenceLabel(confidence: StatementRow["confidence"]): string {
	if (confidence === "high") return "สูง";
	if (confidence === "medium") return "กลาง";
	return "ต่ำ";
}

function fileUrl(clientId: string, monthId: string, file: string): string {
	return `/files/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/${encodeURIComponent(file)}`;
}

function rowEditUrl(clientId: string, monthId: string, groupId: string, rowIndex: number): string {
	return `/api/review/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/bank_statement/${encodeURIComponent(groupId)}/rows/${rowIndex}`;
}

function statementMetaEditUrl(clientId: string, monthId: string, groupId: string): string {
	return `/api/review/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/bank_statement/${encodeURIComponent(groupId)}/statement`;
}

/** Ticket #42's bucket-wide PEAK export endpoint URL — spans every statement
 * group (bank account) in the bucket, one combined journal export. */
export function bucketExportUrl(clientId: string, monthId: string): string {
	return `/api/export/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/bank_statement`;
}

/** JSON-stringifies its args (plus the triggering button element, `this`),
 * then HTML-attribute-escapes the whole call — same xOnclick shape as
 * excluded-review.ts's decideOnclick/bringBackOnclick, generalized to an
 * arbitrary function name/arg list since this page has more distinct actions. */
function onclickCall(fn: string, args: unknown[]): string {
	const call = `${fn}(${[...args.map((a) => JSON.stringify(a)), "this"].join(", ")})`;
	return call.replace(/"/g, "&quot;");
}

function saveRowOnclick(url: string): string {
	return onclickCall("saveRow", [url]);
}

function saveStatementMetaOnclick(url: string, panelIndex: number): string {
	return onclickCall("saveStatementMeta", [url, panelIndex]);
}

function setDirectionFilterOnclick(panelIndex: number, direction: string): string {
	return onclickCall("setDirectionFilter", [panelIndex, direction]);
}

function setAccountFilterOnclick(panelIndex: number, key: string): string {
	return onclickCall("setAccountFilter", [panelIndex, key]);
}

/** Options for a COA <select>, in coaRows order, with `selectedKey` (if any)
 * marked selected. */
function coaSelectOptions(coaRows: CoaRow[], selectedKey: string | null): string {
	return coaRows
		.map((row) => {
			const key = coaKey(row);
			const selected = key === selectedKey ? " selected" : "";
			return `<option value="${Bun.escapeHTML(key)}"${selected}>${Bun.escapeHTML(coaLabel(row))}</option>`;
		})
		.join("");
}

/** Same as coaSelectOptions, but when selectedKey isn't found in coaRows at
 * all (an account code the CSV no longer has, or a row that was never
 * classified), synthesizes one extra selected option so the select doesn't
 * silently jump to some unrelated first entry. */
function coaSelectOptionsWithFallback(coaRows: CoaRow[], selectedKey: string, fallbackLabel: string): string {
	const hasMatch = coaRows.some((row) => coaKey(row) === selectedKey);
	const fallback = hasMatch ? "" : `<option value="${Bun.escapeHTML(selectedKey)}" selected>${Bun.escapeHTML(fallbackLabel || selectedKey)}</option>`;
	return fallback + coaSelectOptions(coaRows, selectedKey);
}

// --- preview ---------------------------------------------------------------
// ONE preview stage shared by every statement, not one per panel — the same
// arrangement document-review.ts uses. PDF sources are drawn by the
// client-side PDF.js viewer (see PDF viewer note in pageScript); workbook
// sheets and missing sources are pre-rendered here as hidden panes that the
// statement selector switches between.

type PreviewMeta = { kind: "pdf" | "static"; src: string | null; page: number };

function previewMeta(clientId: string, monthId: string, source: StatementSource): PreviewMeta {
	const isPdf = !!source.source_src && !isXlsxFile(source.source_src);
	return {
		kind: isPdf ? "pdf" : "static",
		src: isPdf && source.source_src ? fileUrl(clientId, monthId, source.source_src) : null,
		page: source.source_page ?? 1,
	};
}

/** The non-PDF panes only. Rendered for every statement up front (there is one
 * per bank account, never dozens) and revealed by index on selection. */
function staticPreviewHtml(index: number, clientMonthDir: string, source: StatementSource): string {
	if (!source.source_src) {
		return `<div class="static-preview" data-index="${index}"><div class="preview-placeholder">ไม่มีเอกสารต้นทางสำหรับบัญชีนี้</div></div>`;
	}
	if (!isXlsxFile(source.source_src)) return "";
	const tables = loadSheetTables(join(clientMonthDir, source.source_src), source.source_sheet ?? null);
	const inner = tables
		? renderWorkbookPreviewHtml(tables)
		: `<div class="preview-placeholder">ไม่สามารถแสดงตัวอย่างไฟล์ Excel นี้ได้<br/>${Bun.escapeHTML(source.source_src)}</div>`;
	return `<div class="static-preview" data-index="${index}">${inner}</div>`;
}

function previewColumnHtml(statements: StatementEntry[], clientMonthDir: string): string {
	const statics = statements.map((entry, index) => staticPreviewHtml(index, clientMonthDir, entry.source)).join("");
	return `<div class="preview-col">
		<div class="preview-box" id="previewStage">
			<div class="pdf-scroll" id="pdfScroll"></div>
			${statics}
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
	</div>`;
}

function metaCardHtml(statement: StatementInfo): string {
	const field = (label: string, value: string | null) =>
		`<div class="meta-field"><div class="meta-label">${Bun.escapeHTML(label)}</div><div class="meta-value">${value ? Bun.escapeHTML(value) : "—"}</div></div>`;
	return `<div class="meta-card">
		${field("ธนาคาร", statement.bank)}
		${field("เลขที่บัญชี", statement.account_no)}
		${field("ชื่อบัญชี", statement.account_holder)}
		${field("งวด", statement.period)}
		${field("ยอดยกมา", formatBaht(statement.opening_balance) || null)}
		${field("ยอดคงเหลือ (งบ)", formatBaht(statement.closing_balance) || null)}
	</div>`;
}

function integrityBannerHtml(check: IntegrityCheckResult): string {
	if (check.ok) {
		return `<div class="integrity-banner integrity-ok">✓ ยอดตรงกัน — คำนวณได้ ${Bun.escapeHTML(formatBaht(check.computed))}</div>`;
	}
	return `<div class="integrity-banner integrity-bad">✗ ยอดไม่ตรง — คำนวณได้ ${Bun.escapeHTML(formatBaht(check.computed))} ต่างจากยอดคงเหลือ ${Bun.escapeHTML(formatBaht(check.diff))}</div>`;
}

function statementMetaFormHtml(
	panelIndex: number,
	clientId: string,
	monthId: string,
	groupId: string,
	statement: StatementInfo,
	coaRows: CoaRow[],
	guard: BankStatementReviewGuard,
): string {
	const selectedKey = statement.bank_account_code != null ? coaKey({ account_code: statement.bank_account_code, sub_code: statement.bank_sub_code ?? "" }) : null;
	const blankSelected = selectedKey === null ? " selected" : "";
	const options = `<option value=""${blankSelected}>— ยังไม่กำหนด —</option>` + coaSelectOptions(coaRows, selectedKey);
	const url = statementMetaEditUrl(clientId, monthId, groupId);
	return `<div class="stmt-meta-form">
		<div class="meta-label">บัญชีคู่ (GL contra account) ของบัญชีธนาคารนี้</div>
		<div class="meta-form-row">
			<select id="stmt-acct-${panelIndex}" class="stmt-acct-select" ${disabledAttr(guard)}>${options}</select>
			<button class="btn btn-save-meta" ${disabledAttr(guard)} onclick="${saveStatementMetaOnclick(url, panelIndex)}">บันทึก</button>
		</div>
	</div>`;
}

function filterBarHtml(panelIndex: number, coaRows: CoaRow[], suspenseKey: string): string {
	const accountOptions = `<option value="">ทุกบัญชี</option>` + coaSelectOptions(coaRows, null);
	return `<div class="filter-bar">
		<div class="chip-group">
			<button class="chip direction-chip is-active" data-direction="all" onclick="${setDirectionFilterOnclick(panelIndex, "all")}">ทั้งหมด</button>
			<button class="chip direction-chip" data-direction="in" onclick="${setDirectionFilterOnclick(panelIndex, "in")}">เงินเข้า</button>
			<button class="chip direction-chip" data-direction="out" onclick="${setDirectionFilterOnclick(panelIndex, "out")}">เงินออก</button>
		</div>
		<label class="needs-review-filter">
			<input type="checkbox" onchange="setNeedsReviewOnly(${panelIndex}, this)" /> ต้องตรวจสอบเท่านั้น
		</label>
		<select class="filter-account-select" onchange="setAccountFilterFromSelect(${panelIndex}, this)">${accountOptions}</select>
		<button class="chip" onclick="${setAccountFilterOnclick(panelIndex, suspenseKey)}">ยังอยู่บัญชีพัก 999999</button>
		<input type="text" class="filter-search-input" placeholder="ค้นหาคู่ค้า / รายละเอียด" oninput="setSearch(${panelIndex}, this)" />
		<span class="row-counter" id="row-counter-${panelIndex}"></span>
	</div>`;
}

function rowHtml(
	panelIndex: number,
	clientId: string,
	monthId: string,
	groupId: string,
	row: StatementRow,
	coaRows: CoaRow[],
	guard: BankStatementReviewGuard,
): string {
	const selectedKey = coaKey({ account_code: row.account_code, sub_code: row.sub_code });
	const acctOptions = coaSelectOptionsWithFallback(coaRows, selectedKey, row.account_name_th || "— ยังไม่ระบุบัญชี —");
	const url = rowEditUrl(clientId, monthId, groupId, row.row_index);
	const counterpartyLower = Bun.escapeHTML((row.counterparty ?? "").toLowerCase());

	return `<tr class="row-tr" data-row-index="${row.row_index}" data-direction="${row.direction}" data-needs-review="${row.needs_review}" data-counterparty="${counterpartyLower}">
		<td class="date-cell">${Bun.escapeHTML(formatStatementDate(row.date_iso))}${row.time ? `<div class="time-note">${Bun.escapeHTML(row.time)}</div>` : ""}</td>
		<td><input type="text" class="row-desc-input" id="desc-${panelIndex}-${row.row_index}" value="${Bun.escapeHTML(row.description ?? "")}" ${disabledAttr(guard)} /></td>
		<td class="readonly-cell">${Bun.escapeHTML(row.counterparty ?? "")}</td>
		<td><span class="dir-badge dir-${row.direction}">${row.direction === "in" ? "เข้า" : "ออก"}</span></td>
		<td><input type="number" step="0.01" class="row-amount-input" id="amt-${panelIndex}-${row.row_index}" value="${normalizeAmount(row.amount)}" ${disabledAttr(guard)} oninput="recomputeSubtotals(${panelIndex})" /></td>
		<td class="readonly-cell">${Bun.escapeHTML(formatBaht(row.balance))}</td>
		<td><select class="row-account-select" id="acct-${panelIndex}-${row.row_index}" ${disabledAttr(guard)} onchange="recomputeSubtotals(${panelIndex})">${acctOptions}</select></td>
		<td>${row.needs_review ? `<span class="needs-review-badge">ต้องตรวจสอบ</span>` : ""}</td>
		<td><span class="conf-badge conf-${row.confidence}" title="${Bun.escapeHTML(row.reason)}">${confidenceLabel(row.confidence)}</span></td>
		<td><label class="row-skip-toggle"><input type="checkbox" id="skip-${panelIndex}-${row.row_index}" ${row.skipped ? "checked" : ""} ${disabledAttr(guard)} /> ข้าม</label></td>
		<td><button class="btn btn-save-row" ${disabledAttr(guard)} onclick="${saveRowOnclick(url)}">บันทึก</button></td>
	</tr>`;
}

function rowsTableHtml(
	panelIndex: number,
	clientId: string,
	monthId: string,
	groupId: string,
	rows: StatementRow[],
	coaRows: CoaRow[],
	guard: BankStatementReviewGuard,
): string {
	const rowsHtml = rows.map((row) => rowHtml(panelIndex, clientId, monthId, groupId, row, coaRows, guard)).join("");
	return `<div class="rows-table-wrap">
		<table class="rows-table">
			<thead>
				<tr>
					<th>วันที่</th><th>รายการ</th><th>คู่ค้า</th><th>ประเภท</th><th>จำนวนเงิน</th>
					<th>ยอดคงเหลือ</th><th>บัญชี</th><th>ตรวจสอบ</th><th>ความเชื่อมั่น</th><th>ข้าม</th><th></th>
				</tr>
			</thead>
			<tbody>
				${rowsHtml}
				<tr id="no-match-${panelIndex}" class="no-match-row" style="display:none;"><td colspan="11">ไม่พบรายการที่ตรงกับตัวกรอง</td></tr>
			</tbody>
		</table>
	</div>`;
}

function subtotalRowsHtml(subtotals: AccountSubtotal[]): string {
	if (subtotals.length === 0) return `<tr><td colspan="2" class="subtotal-empty">ไม่มีรายการ</td></tr>`;
	return subtotals.map((s) => `<tr><td>${Bun.escapeHTML(s.label)}</td><td class="subtotal-amount">${Bun.escapeHTML(formatBaht(s.total))}</td></tr>`).join("");
}

function subtotalTableHtml(panelIndex: number, rows: StatementRow[], coaRows: CoaRow[]): string {
	const subtotals = computeAccountSubtotals(rows, coaRows);
	return `<div class="subtotal-box">
		<div class="meta-label">ยอดรวมแยกตามบัญชี</div>
		<table class="subtotal-table"><tbody id="subtotal-${panelIndex}">${subtotalRowsHtml(subtotals)}</tbody></table>
	</div>`;
}

function statementSelectorHtml(statements: StatementEntry[]): string {
	return `<div class="stmt-strip">
		${statements
			.map(
				(entry, index) =>
					`<button class="stmt-chip ${index === 0 ? "is-active" : ""}" data-index="${index}" onclick="selectStatement(${index}, this)">${Bun.escapeHTML(entry.label ?? entry.group_id)}</button>`,
			)
			.join("")}
	</div>`;
}

/** Everything for ONE statement except the preview, which is shared — this is
 * what fills the scrolling work column to the right of the pinned preview. */
function statementPanelHtml(
	panelIndex: number,
	clientId: string,
	monthId: string,
	entry: StatementEntry,
	coaRows: CoaRow[],
	guard: BankStatementReviewGuard,
	suspenseKey: string,
): string {
	const check = computeIntegrityCheck(entry.statement, entry.rows);
	return `<div class="stmt-panel" data-index="${panelIndex}" style="display:${panelIndex === 0 ? "block" : "none"};">
		<div class="info-strip">
			${metaCardHtml(entry.statement)}
			<div class="info-side">
				${integrityBannerHtml(check)}
				${statementMetaFormHtml(panelIndex, clientId, monthId, entry.group_dir, entry.statement, coaRows, guard)}
			</div>
		</div>
		${filterBarHtml(panelIndex, coaRows, suspenseKey)}
		${rowsTableHtml(panelIndex, clientId, monthId, entry.group_dir, entry.rows, coaRows, guard)}
		${subtotalTableHtml(panelIndex, entry.rows, coaRows)}
	</div>`;
}

// ---------------------------------------------------------------------------
// Client-side script: statement selection, filter/search (in-memory, ANDed,
// same predicate structure as the old app's filteredRows), and the live
// subtotal mirror. Row/statement-meta saves follow the exact
// in-flight-disable/error-alert/restore pattern as excluded-review.ts.

function pageScript(guardDisabled: boolean, statementCount: number, exportUrl: string, previews: PreviewMeta[]): string {
	return `<script src="/public/vendor/pdf.min.js"></script>
	<script>
		var guardDisabled = ${guardDisabled ? "true" : "false"};
		var exportUrl = ${JSON.stringify(exportUrl)};
		var PREVIEWS = ${JSON.stringify(previews).replace(/</g, "\\u003c")};
		var filterState = {};
		for (var i = 0; i < ${statementCount}; i++) {
			filterState[i] = { direction: "all", needsReviewOnly: false, accountKeyFilter: "", search: "" };
		}

		// --- PDF.js viewer --------------------------------------------------
		// Same viewer as document-review.ts, and for the same reasons: the
		// native <embed> boots Chrome's whole PDF-viewer extension (its own
		// toolbar, hundreds of requests), ignores #page= after load, and
		// exposes nothing across the plugin boundary — so it can neither be
		// driven by the rows nor report which page the reviewer is looking at.
		// The file is laid out as placeholder divs and a page is painted only
		// once it comes near the viewport.
		//
		// Two counters, deliberately separate:
		//   token — one preview switch; a slow load that lost the race gives up.
		//   build — one set of placeholder divs; lazy rendering keys off THIS,
		//           since the observer outlives the switch that created it.
		var pdfLib = window.pdfjsLib || null;
		if (pdfLib) pdfLib.GlobalWorkerOptions.workerSrc = "/public/vendor/pdf.worker.min.js";
		var docCache = {};
		var pdfView = {
			token: 0, build: 0, doc: null, docUrl: null, numPages: 0, visiblePage: 1,
			fitScale: 1, zoom: 1, pages: [], rendered: {}, observer: null,
		};

		function pdfScrollEl() { return document.getElementById("pdfScroll"); }

		function setPageLabel() {
			var el = document.getElementById("pdfPageLabel");
			if (el) el.textContent = pdfView.numPages ? "หน้า " + pdfView.visiblePage + " / " + pdfView.numPages : "";
			var zoomEl = document.getElementById("pdfZoomLabel");
			if (zoomEl) zoomEl.textContent = Math.round(pdfView.zoom * 100) + "%";
		}

		function showPreviewMessage(text) {
			var stage = document.getElementById("previewStage");
			if (!stage) return;
			var existing = stage.querySelector(".preview-loading");
			if (!text) { if (existing) existing.remove(); return; }
			if (!existing) { existing = document.createElement("div"); existing.className = "preview-loading"; stage.appendChild(existing); }
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
			var doc = await pdfLib.getDocument({ url: url }).promise;
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
			var build = ++pdfView.build;
			var base = first.getViewport({ scale: 1 });
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
				entries.forEach(function (entry) { if (entry.isIntersecting) renderPdfPage(Number(entry.target.dataset.page), build); });
			}, { root: container, rootMargin: "600px 0px" });
			pdfView.pages.forEach(function (wrap) { pdfView.observer.observe(wrap); });
		}

		async function renderPdfPage(num, build) {
			if (build !== pdfView.build || pdfView.rendered[num] || !pdfView.doc) return;
			// Claimed up front so two observer hits on the same page can't both
			// render it; released again on every bail-out below, or the page
			// would stay permanently blank-but-"rendered".
			pdfView.rendered[num] = true;
			var page = await pdfView.doc.getPage(num);
			if (build !== pdfView.build) { pdfView.rendered[num] = false; return; }
			var viewport = page.getViewport({ scale: pdfView.fitScale * pdfView.zoom });
			var wrap = pdfView.pages[num - 1];
			if (!wrap) { pdfView.rendered[num] = false; return; }
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
			if (build !== pdfView.build && canvas.parentNode === wrap) wrap.removeChild(canvas);
		}

		function scrollPdfTo(num) {
			var container = pdfScrollEl();
			var wrap = pdfView.pages[num - 1];
			if (!container || !wrap) return;
			container.scrollTo({ top: Math.max(0, wrap.offsetTop - 10) });
			pdfView.visiblePage = num;
			setPageLabel();
		}

		function onPdfScroll() {
			var container = pdfScrollEl();
			if (!container || !pdfView.pages.length) return;
			var center = container.scrollTop + container.clientHeight / 2;
			var best = 1, bestDistance = Infinity;
			pdfView.pages.forEach(function (wrap) {
				var d = Math.abs(wrap.offsetTop + wrap.offsetHeight / 2 - center);
				if (d < bestDistance) { bestDistance = d; best = Number(wrap.dataset.page); }
			});
			if (best !== pdfView.visiblePage) { pdfView.visiblePage = best; setPageLabel(); }
		}

		function pdfZoom(direction) {
			if (!pdfView.doc) return;
			if (direction === 0) pdfView.zoom = 1;
			else pdfView.zoom = Math.min(3, Math.max(0.5, pdfView.zoom + direction * 0.25));
			var at = pdfView.visiblePage;
			var token = ++pdfView.token;
			buildPdfPages(pdfView.doc, token).then(function () { if (token === pdfView.token) scrollPdfTo(at); });
			setPageLabel();
		}

		async function showPreview(index) {
			var meta = PREVIEWS[index];
			var scroll = pdfScrollEl();
			if (!scroll) return;
			document.querySelectorAll(".static-preview").forEach(function (el) { el.classList.remove("is-active"); });
			clearFallback();
			var token = ++pdfView.token;
			if (!meta || meta.kind !== "pdf" || !meta.src) {
				scroll.classList.remove("is-active");
				var stat = document.querySelector('.static-preview[data-index="' + index + '"]');
				if (stat) stat.classList.add("is-active");
				pdfView.numPages = 0;
				setPageLabel();
				return;
			}
			scroll.classList.add("is-active");
			if (!pdfLib) { pdfFallback(meta.src, meta.page); return; }
			if (pdfView.docUrl === meta.src && pdfView.doc) { showPreviewMessage(""); scrollPdfTo(meta.page); return; }
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
				scrollPdfTo(meta.page);
			} catch (err) {
				if (token !== pdfView.token) return;
				showPreviewMessage("");
				scroll.classList.remove("is-active");
				pdfFallback(meta.src, meta.page);
			}
		}

		function selectStatement(index, btn) {
			document.querySelectorAll(".stmt-panel").forEach(function (p) { p.style.display = "none"; });
			document.querySelectorAll(".stmt-chip").forEach(function (c) { c.classList.remove("is-active"); });
			var panel = document.querySelector('.stmt-panel[data-index="' + index + '"]');
			if (panel) panel.style.display = "block";
			if (btn) btn.classList.add("is-active");
			showPreview(index);
		}

		function applyFilters(panelIndex) {
			var state = filterState[panelIndex] || { direction: "all", needsReviewOnly: false, accountKeyFilter: "", search: "" };
			var s = (state.search || "").trim().toLowerCase();
			var rows = document.querySelectorAll('.stmt-panel[data-index="' + panelIndex + '"] tr.row-tr');
			var anyVisible = false;
			var shown = 0;
			rows.forEach(function (tr) {
				var direction = tr.getAttribute("data-direction");
				var needsReview = tr.getAttribute("data-needs-review") === "true";
				var acctSelect = tr.querySelector(".row-account-select");
				var acctKey = acctSelect ? acctSelect.value : "";
				var descInput = tr.querySelector(".row-desc-input");
				var counterparty = tr.getAttribute("data-counterparty") || "";
				var description = descInput ? descInput.value : "";
				var haystack = (counterparty + " " + description).toLowerCase();
				var visible = true;
				if (state.direction !== "all" && direction !== state.direction) visible = false;
				if (visible && state.needsReviewOnly && !needsReview) visible = false;
				if (visible && state.accountKeyFilter && acctKey !== state.accountKeyFilter) visible = false;
				if (visible && s && haystack.indexOf(s) === -1) visible = false;
				tr.style.display = visible ? "" : "none";
				if (visible) { anyVisible = true; shown++; }
			});
			var noMatch = document.getElementById("no-match-" + panelIndex);
			if (noMatch) noMatch.style.display = anyVisible ? "none" : "";
			// A filtered long table hides how much it hid; say it out loud.
			var counter = document.getElementById("row-counter-" + panelIndex);
			if (counter) counter.textContent = "แสดง " + shown + " / " + rows.length + " รายการ";
		}

		function setDirectionFilter(panelIndex, direction, btn) {
			filterState[panelIndex].direction = direction;
			document.querySelectorAll('.stmt-panel[data-index="' + panelIndex + '"] .direction-chip').forEach(function (c) {
				c.classList.remove("is-active");
			});
			if (btn) btn.classList.add("is-active");
			applyFilters(panelIndex);
		}

		function setNeedsReviewOnly(panelIndex, checkboxEl) {
			filterState[panelIndex].needsReviewOnly = !!checkboxEl.checked;
			applyFilters(panelIndex);
		}

		function setAccountFilterFromSelect(panelIndex, selectEl) {
			filterState[panelIndex].accountKeyFilter = selectEl.value;
			applyFilters(panelIndex);
		}

		function setAccountFilter(panelIndex, key) {
			filterState[panelIndex].accountKeyFilter = key;
			var select = document.querySelector('.stmt-panel[data-index="' + panelIndex + '"] .filter-account-select');
			if (select) select.value = key;
			applyFilters(panelIndex);
		}

		function setSearch(panelIndex, inputEl) {
			filterState[panelIndex].search = inputEl.value;
			applyFilters(panelIndex);
		}

		function escapeHtmlJs(s) {
			return String(s).replace(/[&<>"']/g, function (c) {
				return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
			});
		}

		function formatBahtJs(n) {
			var v = Number(n) || 0;
			return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท";
		}

		function recomputeSubtotals(panelIndex) {
			var rows = document.querySelectorAll('.stmt-panel[data-index="' + panelIndex + '"] tr.row-tr');
			var totals = {};
			var order = [];
			rows.forEach(function (tr) {
				var select = tr.querySelector(".row-account-select");
				var amtInput = tr.querySelector(".row-amount-input");
				if (!select || !amtInput || !select.value) return;
				var key = select.value;
				var label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].text : key;
				var amount = parseFloat(amtInput.value);
				if (!isFinite(amount)) amount = 0;
				if (!totals[key]) {
					totals[key] = { label: label, total: 0 };
					order.push(key);
				}
				totals[key].total += amount;
			});
			var tbody = document.getElementById("subtotal-" + panelIndex);
			if (!tbody) return;
			if (order.length === 0) {
				tbody.innerHTML = '<tr><td colspan="2" class="subtotal-empty">ไม่มีรายการ</td></tr>';
				return;
			}
			tbody.innerHTML = order
				.map(function (key) {
					var t = totals[key];
					return "<tr><td>" + escapeHtmlJs(t.label) + '</td><td class="subtotal-amount">' + formatBahtJs(t.total) + "</td></tr>";
				})
				.join("");
		}

		async function saveRow(url, buttonEl) {
			if (guardDisabled) return;
			var tr = buttonEl.closest("tr");
			var descInput = tr.querySelector(".row-desc-input");
			var amtInput = tr.querySelector(".row-amount-input");
			var acctSelect = tr.querySelector(".row-account-select");
			var skipCheckbox = tr.querySelector('input[id^="skip-"]');
			var amount = Number(amtInput.value);
			if (!isFinite(amount)) {
				alert("จำนวนเงินไม่ถูกต้อง");
				return;
			}
			var originalText = buttonEl.textContent;
			buttonEl.disabled = true;
			buttonEl.textContent = "กำลังบันทึก...";
			try {
				var res = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ description: descInput.value, amount: amount, account_key: acctSelect.value, skipped: skipCheckbox ? !!skipCheckbox.checked : false }),
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
		}

		async function saveStatementMeta(url, panelIndex, buttonEl) {
			if (guardDisabled) return;
			var select = document.getElementById("stmt-acct-" + panelIndex);
			if (!select || !select.value) {
				alert("กรุณาเลือกบัญชี");
				return;
			}
			var originalText = buttonEl.textContent;
			buttonEl.disabled = true;
			buttonEl.textContent = "กำลังบันทึก...";
			try {
				var res = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ account_key: select.value }),
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

		var pdfScroll = pdfScrollEl();
		if (pdfScroll) pdfScroll.addEventListener("scroll", onPdfScroll, { passive: true });
		for (var pi = 0; pi < ${statementCount}; pi++) applyFilters(pi);
		if (${statementCount}) showPreview(0);
	</script>`;
}

// ---------------------------------------------------------------------------

/** Renders the whole bank_statement bucket review page as a split view: the
 * source document pinned on the left in the shared PDF.js viewer, and on the
 * right — scrolling independently — a statement selector strip plus, per
 * statement, read-only metadata, the integrity-check banner, an editable
 * GL-contra-account reassignment, the filter/search bar, the editable rows
 * table, and the per-account subtotal table. Reviewing 300+ rows means
 * checking each one against the statement image, so neither side may push the
 * other off-screen. Async because it reads xlsx sheet previews off disk for
 * statement sources that are workbook sheets. */
export async function renderBankStatementReviewPage(clientMonthDir: string, page: BankStatementReviewPage): Promise<string> {
	const displayName = page.companyName ?? page.clientId;
	const suspenseKey = suspenseAccountKey(page.coaRows);
	const previews = page.statements.map((entry) => previewMeta(page.clientId, page.monthId, entry.source));

	const body =
		page.statements.length === 0
			? `<div class="empty-state">ไม่มีข้อมูลบัญชีธนาคารสำหรับเดือนนี้</div>`
			: `<div class="layout">
					${previewColumnHtml(page.statements, clientMonthDir)}
					<div class="work-col">
						${statementSelectorHtml(page.statements)}
						${page.statements
							.map((entry, index) => statementPanelHtml(index, page.clientId, page.monthId, entry, page.coaRows, page.guard, suspenseKey))
							.join("")}
					</div>
				</div>`;

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>รีวิวสมุดบัญชีธนาคาร — ${Bun.escapeHTML(displayName)}</title>
<style>
	* { box-sizing: border-box; }
	html { background: #f7f6f3; color-scheme: light; }
	html, body { height: 100%; margin: 0; }
	/* Split view: the page body itself never scrolls — the preview and the
	   work column each scroll on their own, so neither can push the other off. */
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
	.guard-banner {
		flex: none;
		background: #fef3c7; color: #92400e; padding: 10px 20px; font-size: 13px; font-weight: 600;
		border-bottom: 1px solid #fde68a;
	}
	.empty-state {
		margin: 60px auto; max-width: 480px; text-align: center; font-size: 15px; font-weight: 600;
		color: #57534e; background: #fff; padding: 30px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}
	/* The two columns of the split. */
	.layout { display: flex; flex: 1; min-height: 0; }
	.preview-col { flex: 0 0 46%; min-width: 360px; display: flex; flex-direction: column; gap: 6px; padding: 12px 6px 12px 14px; min-height: 0; }
	.work-col { flex: 1; min-width: 0; overflow-y: auto; padding-bottom: 40px; }
	.stmt-strip { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 16px; background: #ece9e3; border-bottom: 1px solid #ddd9d0; }
	.stmt-chip {
		border: 2px solid transparent; background: #fff; border-radius: 999px; padding: 7px 15px;
		font-size: 12.5px; font-weight: 600; color: #57534e; cursor: pointer;
	}
	.stmt-chip.is-active { border-color: #1d4ed8; color: #1d4ed8; box-shadow: 0 2px 8px rgba(29,78,216,0.14); }
	.stmt-panel { padding: 14px 16px; }
	.info-strip { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
	.info-strip > * { flex: 1; min-width: 240px; }
	.info-side { display: flex; flex-direction: column; gap: 8px; }
	.meta-card {
		background: #fff; border-radius: 10px; padding: 12px 14px; display: grid;
		grid-template-columns: 1fr 1fr; gap: 8px 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
	}
	.meta-label { font-size: 10.5px; font-weight: 700; color: #78716c; text-transform: uppercase; letter-spacing: 0.03em; }
	.meta-value { font-size: 13px; color: #292524; }
	.integrity-banner { border-radius: 10px; padding: 9px 13px; font-size: 12.5px; font-weight: 700; }
	.integrity-ok { background: #dcfce7; color: #166534; }
	.integrity-bad { background: #fee2e2; color: #991b1b; }
	.stmt-meta-form { background: #fff; border-radius: 10px; padding: 11px 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
	.meta-form-row { display: flex; gap: 8px; margin-top: 5px; }
	.meta-form-row select { flex: 1; min-width: 0; }
	/* Preview stage: the PDF.js scroll container free-scrolls over the WHOLE
	   file, with only the pages near the viewport painted to a canvas. */
	.preview-box { flex: 1; min-height: 0; position: relative; background: #ece9e3; border-radius: 10px; }
	.pdf-scroll { position: absolute; inset: 0; overflow: auto; padding: 10px 0 30px; display: none; }
	.pdf-scroll.is-active { display: block; }
	.pdf-page { position: relative; margin: 0 auto 10px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.15); }
	.pdf-page canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
	.pdf-fallback { position: absolute; inset: 0; width: 100%; height: 100%; border: none; }
	.static-preview { position: absolute; inset: 0; overflow: auto; padding: 10px; display: none; }
	.static-preview.is-active { display: flex; flex-direction: column; }
	.preview-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #78716c; font-size: 13px; }
	.preview-footer { flex: none; display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; color: #78716c; min-height: 22px; }
	.preview-zoom { display: flex; align-items: center; gap: 4px; }
	.zoom-btn { border: 1px solid #ddd9d0; background: #fff; color: #57534e; border-radius: 6px; padding: 2px 8px; font: inherit; font-size: 11.5px; cursor: pointer; }
	.zoom-btn:hover { background: #f1efec; }
	.preview-placeholder { margin: auto; text-align: center; color: #78716c; font-size: 13px; padding: 20px; }
	.xlsx-sheet-table { background: #fff; border-radius: 10px; padding: 16px; max-width: 100%; width: 100%; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
	.xlsx-sheet-name { font-size: 12.5px; font-weight: 700; color: #57534e; }
	.xlsx-table-scroll { overflow: auto; border: 1px solid #ece9e3; border-radius: 6px; }
	.xlsx-table-scroll table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
	.xlsx-table-scroll td { border: 1px solid #ece9e3; padding: 4px 8px; }
	.xlsx-table-scroll tr.xlsx-header-row td { background: #ece9e3; font-weight: 700; }
	.xlsx-truncated-note { font-size: 11px; color: #a8a29e; }
	.xlsx-empty { color: #78716c; font-size: 13px; padding: 12px; }
	.xlsx-sheet-divider { height: 1px; background: #ece9e3; margin: 4px 0; }
	/* Sticky so the filters stay reachable while scrolling a 300-row table. */
	.filter-bar {
		position: sticky; top: 0; z-index: 3;
		display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: #fff;
		border-radius: 10px; padding: 9px 13px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
	}
	.chip-group { display: flex; gap: 6px; }
	.chip {
		border: 2px solid #e7e5e4; background: #fff; border-radius: 999px; padding: 6px 12px;
		font-size: 12px; font-weight: 600; color: #57534e; cursor: pointer;
	}
	.chip.is-active { border-color: #1d4ed8; color: #1d4ed8; }
	.needs-review-filter { font-size: 12.5px; color: #57534e; display: flex; align-items: center; gap: 4px; }
	.filter-account-select { font-size: 12.5px; padding: 4px 6px; max-width: 220px; }
	.filter-search-input { font-size: 12.5px; padding: 5px 8px; border: 1px solid #e7e5e4; border-radius: 6px; flex: 1; min-width: 120px; }
	.row-counter { font-size: 11.5px; color: #78716c; font-weight: 600; white-space: nowrap; }
	.rows-table-wrap { overflow-x: auto; background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 12px; }
	.rows-table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
	.rows-table th, .rows-table td { padding: 6px 8px; border-bottom: 1px solid #f1efec; text-align: left; white-space: nowrap; }
	.rows-table th { background: #ece9e3; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; color: #57534e; }
	.rows-table .row-desc-input { width: 150px; font-size: 12.5px; padding: 3px 6px; }
	.rows-table .row-amount-input { width: 92px; font-size: 12.5px; padding: 3px 6px; text-align: right; }
	.rows-table .row-account-select { max-width: 160px; font-size: 12.5px; padding: 3px 6px; }
	.readonly-cell { color: #57534e; }
	.time-note { font-size: 10.5px; color: #a8a29e; }
	.dir-badge { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; }
	.dir-in { background: #dcfce7; color: #166534; }
	.dir-out { background: #e5e7eb; color: #374151; }
	.needs-review-badge { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; background: #fef3c7; color: #92400e; }
	.conf-badge { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
	.conf-high { background: #dcfce7; color: #166534; }
	.conf-medium { background: #fef3c7; color: #92400e; }
	.conf-low { background: #fee2e2; color: #991b1b; }
	.no-match-row td { text-align: center; color: #a8a29e; padding: 16px; }
	.btn { border: none; border-radius: 7px; padding: 7px 12px; font-size: 12px; font-weight: 700; cursor: pointer; }
	.btn-save-row, .btn-save-meta { background: #15803d; color: #fff; }
	.btn[disabled] { opacity: 0.5; cursor: default; }
	.subtotal-box { background: #fff; border-radius: 10px; padding: 12px 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); max-width: 420px; }
	.subtotal-table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin-top: 6px; }
	.subtotal-table td { padding: 5px 4px; border-bottom: 1px solid #f1efec; }
	.subtotal-amount { text-align: right; font-weight: 600; }
	.subtotal-empty { color: #a8a29e; text-align: center; }
	.row-skip-toggle { display: flex; align-items: center; gap: 4px; font-size: 11.5px; color: #57534e; cursor: pointer; white-space: nowrap; }
	.btn-export { border: none; border-radius: 7px; padding: 8px 16px; font-size: 12.5px; font-weight: 700; cursor: pointer; background: #b45309; color: #fff; }
	.btn-export[disabled] { opacity: 0.5; cursor: default; }

	/* Too narrow to hold both columns: stack them and give the page back its
	   own scroll, rather than squeezing the split into unusable slivers. */
	@media (max-width: 900px) {
		body { overflow: auto; }
		.layout { flex-direction: column; }
		.preview-col { flex: none; height: 60vh; padding: 12px 14px 0; }
		.work-col { overflow: visible; }
	}
</style>
</head>
<body>
	<header>
		<div>
			${breadcrumbHtml(page.clientId, page.monthId, "รายการเดินบัญชีธนาคาร")}
			<h1>รีวิวสมุดบัญชีธนาคาร</h1>
			<div class="sub">${Bun.escapeHTML(displayName)} — ${Bun.escapeHTML(page.monthId)}</div>
		</div>
		<button id="exportBtn" class="btn-export"${page.guard.disabled ? " disabled" : ""} onclick="exportBucket()">ส่งออก PEAK XLSX</button>
	</header>
	${page.guard.disabled && page.guard.message ? `<div class="guard-banner">⏳ ${Bun.escapeHTML(page.guard.message)}</div>` : ""}
	${body}
	${pageScript(page.guard.disabled, page.statements.length, bucketExportUrl(page.clientId, page.monthId), previews)}
</body>
</html>`;
}
