// Bank-statement bucket review page (wayfinder ticket #41, the bank_statement
// slice of "category/group review pages + build-review-data.ts fix").
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

function statementPreviewHtml(clientMonthDir: string, clientId: string, monthId: string, source: StatementSource): string {
	if (!source.source_src) {
		return `<div class="preview-placeholder">ไม่มีเอกสารต้นทางสำหรับบัญชีนี้</div>`;
	}
	if (isXlsxFile(source.source_src)) {
		const absPath = join(clientMonthDir, source.source_src);
		const tables = loadSheetTables(absPath, source.source_sheet ?? null);
		if (!tables) {
			return `<div class="preview-placeholder">ไม่สามารถแสดงตัวอย่างไฟล์ Excel นี้ได้<br/>${Bun.escapeHTML(source.source_src)}</div>`;
		}
		return renderWorkbookPreviewHtml(tables);
	}
	const src = fileUrl(clientId, monthId, source.source_src) + (source.source_page != null ? `#page=${source.source_page}` : "");
	return `<embed class="pdf-embed" src="${src}" type="application/pdf" />`;
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
					<th>ยอดคงเหลือ</th><th>บัญชี</th><th>ตรวจสอบ</th><th>ความเชื่อมั่น</th><th></th>
				</tr>
			</thead>
			<tbody>
				${rowsHtml}
				<tr id="no-match-${panelIndex}" class="no-match-row" style="display:none;"><td colspan="10">ไม่พบรายการที่ตรงกับตัวกรอง</td></tr>
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

function statementPanelHtml(
	panelIndex: number,
	clientId: string,
	monthId: string,
	clientMonthDir: string,
	entry: StatementEntry,
	coaRows: CoaRow[],
	guard: BankStatementReviewGuard,
	suspenseKey: string,
): string {
	const check = computeIntegrityCheck(entry.statement, entry.rows);
	return `<div class="stmt-panel" data-index="${panelIndex}" style="display:${panelIndex === 0 ? "block" : "none"};">
		<div class="stmt-top">
			<div class="stmt-info-col">
				${metaCardHtml(entry.statement)}
				${integrityBannerHtml(check)}
				${statementMetaFormHtml(panelIndex, clientId, monthId, entry.group_dir, entry.statement, coaRows, guard)}
			</div>
			<div class="stmt-preview-col">
				<div class="preview-box">${statementPreviewHtml(clientMonthDir, clientId, monthId, entry.source)}</div>
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

function pageScript(guardDisabled: boolean, statementCount: number): string {
	return `<script>
		var guardDisabled = ${guardDisabled ? "true" : "false"};
		var filterState = {};
		for (var i = 0; i < ${statementCount}; i++) {
			filterState[i] = { direction: "all", needsReviewOnly: false, accountKeyFilter: "", search: "" };
		}

		function selectStatement(index, btn) {
			document.querySelectorAll(".stmt-panel").forEach(function (p) { p.style.display = "none"; });
			document.querySelectorAll(".stmt-chip").forEach(function (c) { c.classList.remove("is-active"); });
			var panel = document.querySelector('.stmt-panel[data-index="' + index + '"]');
			if (panel) panel.style.display = "block";
			if (btn) btn.classList.add("is-active");
		}

		function applyFilters(panelIndex) {
			var state = filterState[panelIndex] || { direction: "all", needsReviewOnly: false, accountKeyFilter: "", search: "" };
			var s = (state.search || "").trim().toLowerCase();
			var rows = document.querySelectorAll('.stmt-panel[data-index="' + panelIndex + '"] tr.row-tr');
			var anyVisible = false;
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
				if (visible) anyVisible = true;
			});
			var noMatch = document.getElementById("no-match-" + panelIndex);
			if (noMatch) noMatch.style.display = anyVisible ? "none" : "";
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
					body: JSON.stringify({ description: descInput.value, amount: amount, account_key: acctSelect.value }),
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

		for (var pi = 0; pi < ${statementCount}; pi++) applyFilters(pi);
	</script>`;
}

// ---------------------------------------------------------------------------

/** Renders the whole bank_statement bucket review page: a statement selector
 * strip (one per bank account) plus, per statement, read-only metadata, the
 * integrity-check banner, an editable GL-contra-account reassignment, a
 * document preview (PDF embed or rendered xlsx sheet table), the
 * filter/search bar, the editable rows table, and the per-account subtotal
 * table. Async because it reads xlsx sheet previews off disk for statement
 * sources that are workbook sheets. */
export async function renderBankStatementReviewPage(clientMonthDir: string, page: BankStatementReviewPage): Promise<string> {
	const displayName = page.companyName ?? page.clientId;
	const suspenseKey = suspenseAccountKey(page.coaRows);

	const body =
		page.statements.length === 0
			? `<div class="empty-state">ไม่มีข้อมูลบัญชีธนาคารสำหรับเดือนนี้</div>`
			: `${statementSelectorHtml(page.statements)}
				${page.statements
					.map((entry, index) => statementPanelHtml(index, page.clientId, page.monthId, clientMonthDir, entry, page.coaRows, page.guard, suspenseKey))
					.join("")}`;

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>รีวิวสมุดบัญชีธนาคาร — ${Bun.escapeHTML(displayName)}</title>
<style>
	* { box-sizing: border-box; }
	html, body { margin: 0; }
	body { font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f7f6f3; color: #292524; }
	header {
		background: #1c1917; color: #fafaf9; padding: 12px 20px; display: flex;
		align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
	}
	header a.back { color: #a8a29e; font-size: 12px; text-decoration: none; }
	header h1 { font-size: 15px; margin: 0; }
	header .sub { font-size: 11.5px; color: #a8a29e; }
	.guard-banner {
		background: #fef3c7; color: #92400e; padding: 10px 20px; font-size: 13px; font-weight: 600;
		border-bottom: 1px solid #fde68a;
	}
	.empty-state {
		margin: 60px auto; max-width: 480px; text-align: center; font-size: 15px; font-weight: 600;
		color: #57534e; background: #fff; padding: 30px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}
	.stmt-strip { display: flex; gap: 8px; flex-wrap: wrap; padding: 14px 20px; background: #ece9e3; border-bottom: 1px solid #ddd9d0; }
	.stmt-chip {
		border: 2px solid transparent; background: #fff; border-radius: 999px; padding: 8px 16px;
		font-size: 12.5px; font-weight: 600; color: #57534e; cursor: pointer;
	}
	.stmt-chip.is-active { border-color: #1d4ed8; color: #1d4ed8; box-shadow: 0 2px 8px rgba(29,78,216,0.14); }
	.stmt-panel { padding: 20px; }
	.stmt-top { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 16px; }
	.stmt-info-col { flex: 1; min-width: 280px; display: flex; flex-direction: column; gap: 12px; }
	.stmt-preview-col { flex: 1.2; min-width: 320px; }
	.meta-card {
		background: #fff; border-radius: 10px; padding: 14px 16px; display: grid;
		grid-template-columns: 1fr 1fr; gap: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
	}
	.meta-label { font-size: 11px; font-weight: 700; color: #78716c; text-transform: uppercase; letter-spacing: 0.03em; }
	.meta-value { font-size: 13.5px; color: #292524; margin-top: 2px; }
	.integrity-banner { border-radius: 10px; padding: 10px 14px; font-size: 13px; font-weight: 700; }
	.integrity-ok { background: #dcfce7; color: #166534; }
	.integrity-bad { background: #fee2e2; color: #991b1b; }
	.stmt-meta-form { background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
	.meta-form-row { display: flex; gap: 8px; margin-top: 6px; }
	.meta-form-row select { flex: 1; }
	.preview-box {
		background: #ece9e3; border-radius: 10px; padding: 16px; height: 100%; min-height: 320px;
		max-height: 560px; overflow: auto; display: flex; align-items: flex-start; justify-content: center;
	}
	.pdf-embed { width: 100%; height: 520px; border: none; }
	.preview-placeholder { background: #fff; border-radius: 10px; padding: 24px; max-width: 320px; text-align: center; color: #78716c; font-size: 13px; margin: auto; }
	.xlsx-sheet-table { background: #fff; border-radius: 10px; padding: 16px; max-width: 100%; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
	.xlsx-sheet-name { font-size: 12.5px; font-weight: 700; color: #57534e; }
	.xlsx-table-scroll { overflow: auto; max-height: 460px; border: 1px solid #ece9e3; border-radius: 6px; }
	.xlsx-table-scroll table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
	.xlsx-table-scroll td { border: 1px solid #ece9e3; padding: 4px 8px; }
	.xlsx-table-scroll tr.xlsx-header-row td { background: #ece9e3; font-weight: 700; }
	.xlsx-truncated-note { font-size: 11px; color: #a8a29e; }
	.xlsx-empty { color: #78716c; font-size: 13px; padding: 12px; }
	.xlsx-sheet-divider { height: 1px; background: #ece9e3; margin: 4px 0; }
	.filter-bar {
		display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: #fff;
		border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
	}
	.chip-group { display: flex; gap: 6px; }
	.chip {
		border: 2px solid #e7e5e4; background: #fff; border-radius: 999px; padding: 6px 12px;
		font-size: 12px; font-weight: 600; color: #57534e; cursor: pointer;
	}
	.chip.is-active { border-color: #1d4ed8; color: #1d4ed8; }
	.needs-review-filter { font-size: 12.5px; color: #57534e; display: flex; align-items: center; gap: 4px; }
	.filter-account-select { font-size: 12.5px; padding: 4px 6px; }
	.filter-search-input { font-size: 12.5px; padding: 5px 8px; border: 1px solid #e7e5e4; border-radius: 6px; flex: 1; min-width: 160px; }
	.rows-table-wrap { overflow-x: auto; background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 14px; }
	.rows-table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
	.rows-table th, .rows-table td { padding: 7px 9px; border-bottom: 1px solid #f1efec; text-align: left; white-space: nowrap; }
	.rows-table th { background: #ece9e3; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: #57534e; }
	.rows-table .row-desc-input { width: 220px; font-size: 12.5px; padding: 4px 6px; }
	.rows-table .row-amount-input { width: 100px; font-size: 12.5px; padding: 4px 6px; text-align: right; }
	.rows-table .row-account-select { max-width: 220px; font-size: 12.5px; padding: 4px 6px; }
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
	.subtotal-box { background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); max-width: 420px; }
	.subtotal-table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin-top: 6px; }
	.subtotal-table td { padding: 5px 4px; border-bottom: 1px solid #f1efec; }
	.subtotal-amount { text-align: right; font-weight: 600; }
	.subtotal-empty { color: #a8a29e; text-align: center; }

	@media (max-width: 860px) {
		.stmt-top { flex-direction: column; }
		.rows-table .row-desc-input { width: 140px; }
	}
</style>
</head>
<body>
	<header>
		<div>
			<a class="back" href="/">← กลับไปที่ Dashboard</a>
			<h1>รีวิวสมุดบัญชีธนาคาร</h1>
			<div class="sub">${Bun.escapeHTML(displayName)} — ${Bun.escapeHTML(page.monthId)}</div>
		</div>
	</header>
	${page.guard.disabled && page.guard.message ? `<div class="guard-banner">⏳ ${Bun.escapeHTML(page.guard.message)}</div>` : ""}
	${body}
	${pageScript(page.guard.disabled, page.statements.length)}
</body>
</html>`;
}
