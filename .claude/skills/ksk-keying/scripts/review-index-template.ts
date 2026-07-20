// Templates for the two navigation pages review-groups.ts writes into
// ตรวจทาน/ alongside the per-bucket ตรวจทาน.html files:
//
//   ตรวจทาน/index.html          — hub: coverage stats + one card per bucket,
//                                 so the reviewer never has to hop folders
//                                 to find where to start.
//   ตรวจทาน/ที่ถูกตัดออก.html    — every page/sheet the pipeline excluded on
//                                 an AGENT's proposal (never a human's — a
//                                 human decision needs no second look here),
//                                 sourced straight from ข้อมูลระบบ/_pages/ledger.yaml,
//                                 with a live preview of the original document
//                                 so the reviewer can confirm the exclusion
//                                 without leaving the browser.
//
// Both are plain HTML/CSS/vanilla JS (no Vue, no vendored libs) — vastly
// simpler documents than the per-bucket review page, and PDF preview reuses
// the same bare <iframe src="file.pdf#page=N"> the per-bucket page defaults
// to (review-template.ts pdfSrc()), so no pdf.js is needed here either.
//
// Same embedding convention as review-template.ts: __DATA__ is replaced with
// a JSON blob via a replacer FUNCTION (never a string — minified content or
// Thai text containing "$&"-like sequences would otherwise corrupt the
// template), and "</" is escaped so the blob can't prematurely close the
// <script> tag it sits in.

import type { SheetPreview } from "./review-template";

export type ReviewIndexBucketCard = {
	bucket: string;
	label: string;
	href: string;
	groups: number;
	pages: number;
};

export type ReviewIndexData = {
	schema: "ksk_review_index_html_data.v1";
	client_key: string;
	generated_at: string;
	total_units: number | null;
	excluded_agent_count: number;
	excluded_human_count: number;
	buckets: ReviewIndexBucketCard[];
	excluded_href: string | null;
};

export type ReviewExcludedItem = {
	unit: string;
	file: string;
	page: number | null;
	sheet: string | null;
	reason: string | null;
	// Set when reason is "duplicate": the original (kept) page this one
	// duplicates, resolved the same way as the item's own source_* fields so
	// the review page can render it inline next to the excluded page for
	// side-by-side comparison — null when the claim carries no duplicate_of
	// (older data) or the original file can't be resolved on disk.
	duplicate_of: {
		file: string;
		page: number | null;
		sheet: string | null;
		href: string | null;
		source_src: string | null;
		source_page: number | null;
		source_kind: "pdf" | "image" | "other" | null;
		sheet_preview: SheetPreview | null;
	} | null;
	source_src: string | null;
	source_page: number | null;
	source_kind: "pdf" | "image" | "other" | null;
	sheet_preview: SheetPreview | null;
};

export type ReviewExcludedData = {
	schema: "ksk_review_excluded_html_data.v1";
	client_key: string;
	generated_at: string;
	index_href: string;
	items: ReviewExcludedItem[];
};

function escapeBlob(json: string) {
	return json.replaceAll("</", "<\\/");
}

const FONT_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&display=swap" rel="stylesheet">`;

// Shared with review-template.ts's own palette/type conventions (body font,
// #f6f7fb ground, #172033 ink, navbar blur, 12px card radius, badge colors) —
// these two pages must read as the same product, not a bolted-on report.
const BASE_STYLE = `
		* { box-sizing: border-box; }
		body { margin: 0; font: 14px/1.4 "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f7fb; }
		button, a { font: inherit; }
		.navbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 8px 14px; background: rgba(255,255,255,.96); backdrop-filter: blur(8px); box-shadow: 0 1px 0 rgba(15,23,42,.04); }
		.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
		.brand h1 { margin: 0; display: flex; align-items: center; gap: 10px; font-size: 15px; flex-wrap: wrap; }
		.back-link { display: inline-flex; align-items: center; gap: 5px; text-decoration: none; color: #65728a; font-size: 13px; font-weight: 600; flex: none; }
		.client-label { font-size: 14px; font-weight: 500; color: #65728a; }
		.muted { color: #65728a; font-size: 12px; }
		.badge { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 12px; background: #e5e7eb; }
		.badge.doc-count { background: #ffedd5; color: #9a3412; font-weight: 600; }
`;

const INDEX_HTML = `<!doctype html>
<html lang="th">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>KSK Review — หน้ารวม</title>
	${FONT_HEAD}
	<style>${BASE_STYLE}
		.wrap { max-width: 1040px; margin: 0 auto; padding: 0 14px 60px; }
		.coverage { display: flex; flex-wrap: wrap; gap: 0; align-items: stretch; background: #fff; border-radius: 12px; box-shadow: 0 1px 2px rgba(15,23,42,.04); margin: 18px 0; overflow: hidden; }
		.cov-stat { flex: 1 1 140px; padding: 14px 18px; border-right: 1px solid #eef1f6; }
		.cov-stat:last-child { border-right: none; }
		.cov-stat b { display: block; font-size: 21px; font-variant-numeric: tabular-nums; }
		.cov-stat span { font-size: 12px; color: #65728a; }
		.cov-stat.warn b { color: #9a3412; }
		.section-label { margin: 26px 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: #65728a; }
		.section-label:first-of-type { margin-top: 0; }
		.section-hint { margin: -6px 0 12px; font-size: 12.5px; color: #94a3b8; }
		.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
		@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
		a.card { display: block; text-decoration: none; color: inherit; background: #fff; border-radius: 12px; box-shadow: 0 1px 2px rgba(15,23,42,.04); padding: 14px 16px; position: relative; overflow: hidden; transition: box-shadow .12s ease; }
		a.card:hover { box-shadow: 0 4px 16px rgba(15,23,42,.1); }
		a.card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--cat-color, #1d4ed8); }
		.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
		.card-title { font-size: 14px; font-weight: 700; }
		.card-title .path { display: block; font-size: 11.5px; font-weight: 500; color: #65728a; margin-top: 2px; }
		.chev { color: #94a3b8; flex: none; margin-top: 2px; }
		.card-counts { display: flex; gap: 16px; margin-top: 10px; }
		.card-counts div b { display: block; font-size: 17px; font-variant-numeric: tabular-nums; }
		.card-counts div span { font-size: 11.5px; color: #65728a; }
		a.card.excluded-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
		a.card.excluded-card::before { background: #9a3412; }
		.excl-summary { display: flex; align-items: baseline; gap: 8px; }
		.excl-summary b { font-size: 19px; font-variant-numeric: tabular-nums; color: #9a3412; }
		.excl-summary span { font-size: 12.5px; color: #65728a; }
		.excl-cta { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: #1d4ed8; }
	</style>
</head>
<body>
<div id="app"></div>
<script id="data" type="application/json">__DATA__</script>
<script>
(function () {
	var data = JSON.parse(document.getElementById('data').textContent);
	var CATEGORY_COLOR = { expense: '#dc2626', income: '#16a34a', bank_statement: '#1d4ed8' };
	function colorFor(bucket) {
		var head = bucket.split('/')[0];
		return CATEGORY_COLOR[head] || '#1d4ed8';
	}
	function chev() {
		return '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>';
	}
	var totalGrouped = data.buckets.reduce(function (n, b) { return n + b.pages; }, 0);
	var cov = ''
		+ '<div class="cov-stat"><b>' + (data.total_units != null ? data.total_units : '—') + '</b><span>หน้า/รายการทั้งหมดในคลัง</span></div>'
		+ '<div class="cov-stat"><b>' + totalGrouped + '</b><span>จัดกลุ่มแล้ว (อยู่ในหมวดด้านล่าง)</span></div>'
		+ '<div class="cov-stat warn"><b>' + data.excluded_agent_count + '</b><span>ถูกตัดออก — รอตัดสินใจ</span></div>';

	var cards = data.buckets.map(function (b) {
		return '<a class="card" style="--cat-color:' + colorFor(b.bucket) + '" href="' + b.href + '">'
			+ '<div class="card-head"><div class="card-title">' + b.label + '<span class="path">' + b.href + '</span></div>' + chev() + '</div>'
			+ '<div class="card-counts"><div><b>' + b.groups + '</b><span>กลุ่มเอกสาร</span></div><div><b>' + b.pages + '</b><span>หน้าเอกสาร</span></div></div>'
			+ '</a>';
	}).join('');

	var excludedSection = '';
	if (data.excluded_href && data.excluded_agent_count > 0) {
		excludedSection = ''
			+ '<div class="section-label">ไม่ได้จัดกลุ่ม</div>'
			+ '<p class="section-hint">หน้า/รายการที่ agent เสนอตัดออกระหว่างทาง — ข้อเสนอเท่านั้น ยังไม่ใช่ข้อสรุป ควรเข้าไปเช็คว่าตัดถูกจริงไหม</p>'
			+ '<a class="card excluded-card" href="' + data.excluded_href + '">'
			+ '<div class="excl-summary"><b>' + data.excluded_agent_count + '</b><span>รายการรอตัดสินใจ</span></div>'
			+ '<div class="excl-cta">ดูรายการทั้งหมด' + chev() + '</div>'
			+ '</a>';
	}

	document.getElementById('app').innerHTML = ''
		+ '<header class="navbar"><div class="brand"><h1>KSK <span class="client-label">' + data.client_key + ' · ตรวจทาน</span></h1><div class="muted">สร้างเมื่อ ' + new Date(data.generated_at).toLocaleString('th-TH') + '</div></div></header>'
		+ '<div class="wrap">'
		+ '<div class="coverage">' + cov + '</div>'
		+ '<div class="section-label">หมวดที่จัดกลุ่มแล้ว</div>'
		+ '<div class="grid">' + cards + '</div>'
		+ excludedSection
		+ '</div>';
})();
</script>
</body>
</html>`;

const EXCLUDED_HTML = `<!doctype html>
<html lang="th">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>KSK Review — รายการที่ถูกตัดออก</title>
	${FONT_HEAD}
	<style>${BASE_STYLE}
		.nav-counts { display: flex; gap: 14px; font-size: 12px; color: #65728a; }
		.nav-counts b { font-variant-numeric: tabular-nums; }
		.main { padding: 0 14px 0 0; min-height: calc(100vh - 56px); }
		.pane { display: grid; grid-template-columns: minmax(380px, 52%) 10px minmax(360px, 1fr); min-height: calc(100vh - 56px); }
		.pane-gutter { position: relative; align-self: stretch; }
		.pane-gutter::before { content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; transform: translateX(-50%); background: #cbd5e1; border-radius: 2px; }
		.evidence { position: sticky; top: 56px; height: calc(100vh - 56px); display: flex; flex-direction: column; min-width: 0; background: #fff; overflow: hidden; }
		.evidence-head { flex: none; padding: 12px 16px; border-bottom: 1px solid #eef1f6; display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
		.evidence-head .titles { min-width: 0; }
		.evidence-head h1 { margin: 0; font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.evidence-head .reason-line { margin-top: 2px; font-size: 12.5px; color: #9a3412; }
		.evidence-nav { flex: none; display: flex; gap: 4px; }
		.nav-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; border: 1px solid #e2e8f0; background: #fff; color: #475569; cursor: pointer; }
		.nav-btn:hover { background: #f8fafc; }
		.nav-btn:disabled { opacity: .4; cursor: not-allowed; }
		.preview { position: relative; flex: 1 1 0; min-height: 0; width: 100%; background: #e8ecf1; }
		.preview iframe, .preview img { width: 100%; height: 100%; border: 0; object-fit: contain; display: block; }
		.preview .empty { height: 100%; display: flex; align-items: center; justify-content: center; color: #64748b; font-weight: 600; text-align: center; padding: 0 16px; }
		.preview-split { display: flex; height: 100%; width: 100%; }
		.preview-half { flex: 1 1 50%; min-width: 0; display: flex; flex-direction: column; }
		.preview-half + .preview-half { border-left: 2px solid #cbd5e1; }
		.preview-half-head { flex: none; padding: 6px 10px; font-size: 11px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
		.preview-half-head.cut { color: #9a3412; background: #fff7ed; }
		.preview-half-head.orig { color: #166534; background: #f0fdf4; }
		.preview-half-head span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
		.preview-half-open { flex: none; color: inherit; opacity: .75; text-decoration: none; font-weight: 600; }
		.preview-half-open:hover { opacity: 1; text-decoration: underline; }
		.preview-half-body { position: relative; flex: 1 1 auto; min-height: 0; }
		.preview-half-body iframe, .preview-half-body img { width: 100%; height: 100%; border: 0; object-fit: contain; display: block; }
		.preview-half-body .empty { height: 100%; display: flex; align-items: center; justify-content: center; color: #64748b; font-weight: 600; font-size: 12.5px; text-align: center; padding: 0 12px; }
		.sheet-scroll { height: 100%; overflow: auto; background: #fff; }
		.sheet-table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
		.sheet-table td, .sheet-table th { border: 1px solid #e2e8f0; padding: 3px 8px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
		.sheet-table .sheet-header-row td { position: sticky; top: 0; background: #f1f5f9; font-weight: 700; }
		.page-anchor { position: absolute; left: 12px; bottom: 12px; z-index: 2; padding: 4px 10px; background: rgba(255,255,255,.94); border-radius: 999px; box-shadow: 0 4px 16px rgba(15,23,42,.1); font-weight: 700; font-size: 12px; color: #334155; }
		.list-card { min-width: 0; margin: 14px 14px 14px 0; background: #fff; border-radius: 12px; box-shadow: 0 1px 2px rgba(15,23,42,.04); display: flex; flex-direction: column; max-height: calc(100vh - 84px); }
		.list-head { padding: 14px 16px 10px; border-bottom: 1px solid #eef1f6; }
		.list-head h2 { margin: 0 0 8px; font-size: 14px; }
		.list-lead { margin: 0 0 10px; font-size: 12.5px; color: #65728a; line-height: 1.5; }
		.chip-group { display: flex; gap: 6px; flex-wrap: wrap; }
		.chip { border: 1px solid #e2e8f0; background: #fff; border-radius: 999px; padding: 5px 11px; cursor: pointer; font-size: 12px; font-weight: 600; color: #475569; }
		.chip.active { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
		.item-list { flex: 1 1 auto; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; scroll-behavior: smooth; }
		.item-group-label { padding: 10px 8px 4px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #94a3b8; }
		.item { display: flex; align-items: flex-start; gap: 10px; width: 100%; text-align: left; border: 0; border-radius: 10px; padding: 9px 10px; cursor: pointer; background: transparent; min-height: 52px; }
		.item:hover { background: #f8fafc; }
		.item.active { background: #eff6ff; box-shadow: inset 0 0 0 2px #93c5fd; }
		.item.kept { opacity: .55; }
		.item-icon { flex: none; width: 30px; height: 30px; border-radius: 8px; background: #f1f5f9; display: flex; align-items: center; justify-content: center; color: #64748b; margin-top: 1px; }
		.item.kept .item-icon { background: #dcfce7; color: #166534; }
		.item-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding-right: 4px; }
		.item-file { display: block; width: 100%; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.item-meta { display: block; width: 100%; font-size: 11.5px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.item-toggle { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 999px; border: 0; background: #f1f5f9; color: #64748b; align-self: center; }
		.item.kept .item-toggle { background: #dcfce7; color: #166534; }
	</style>
</head>
<body>
<div id="app"></div>
<script id="data" type="application/json">__DATA__</script>
<script>
(function () {
	var data = JSON.parse(document.getElementById('data').textContent);
	var ICON_BAN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/></svg>';
	var ICON_RESTORE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
	var ICON_DOC = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></svg>';

	var STORAGE_KEY = 'ksk-excluded-kept:' + data.client_key;
	var kept;
	try { kept = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); } catch (e) { kept = new Set(); }
	function persistKept() {
		try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(kept))); } catch (e) {}
	}

	var reasonCounts = {};
	data.items.forEach(function (it) {
		var r = it.reason || '(ไม่ระบุเหตุผล)';
		reasonCounts[r] = (reasonCounts[r] || 0) + 1;
	});
	var reasons = Object.keys(reasonCounts).sort(function (a, b) { return reasonCounts[b] - reasonCounts[a]; });

	var state = { active: data.items.length ? data.items[0].unit : null, filter: 'all' };

	function visibleItems() {
		if (state.filter === 'all') return data.items;
		return data.items.filter(function (it) { return (it.reason || '(ไม่ระบุเหตุผล)') === state.filter; });
	}

	function duplicateOfLabel(d) {
		var loc = d.page != null ? ('หน้า ' + d.page) : (d.sheet != null ? ('ชีท ' + d.sheet) : '');
		return d.file + (loc ? ' ' + loc : '');
	}

	function itemLabel(it) {
		var bits = [];
		if (it.page != null) bits.push('หน้า ' + it.page);
		if (it.sheet != null) bits.push('ชีท ' + it.sheet);
		if (it.reason) bits.push(it.reason);
		if (it.duplicate_of) bits.push('ซ้ำกับ ' + duplicateOfLabel(it.duplicate_of));
		return bits.join(' · ');
	}

	function renderList() {
		var items = visibleItems();
		var html = '';
		var lastReason = null;
		items.forEach(function (it) {
			var r = it.reason || '(ไม่ระบุเหตุผล)';
			if (r !== lastReason) { html += '<div class="item-group-label">' + r + ' (' + reasonCounts[r] + ')</div>'; lastReason = r; }
			var isKept = kept.has(it.unit);
			var isActive = state.active === it.unit;
			html += '<button type="button" class="item' + (isActive ? ' active' : '') + (isKept ? ' kept' : '') + '" data-unit="' + it.unit.replace(/"/g, '&quot;') + '">'
				+ '<span class="item-icon">' + ICON_DOC + '</span>'
				+ '<span class="item-main"><span class="item-file">' + it.file + '</span><span class="item-meta">' + itemLabel(it) + '</span></span>'
				+ '<span class="item-toggle" data-toggle="' + it.unit.replace(/"/g, '&quot;') + '" title="' + (isKept ? 'ยืนยันตัดออกอีกครั้ง' : 'ทำเครื่องหมายว่าจะเอากลับ') + '">' + (isKept ? ICON_RESTORE : ICON_BAN) + '</span>'
				+ '</button>';
		});
		document.getElementById('itemList').innerHTML = html || '<div class="muted" style="padding:16px">ไม่มีรายการในหมวดนี้</div>';
	}

	function currentItem() {
		return data.items.find(function (it) { return it.unit === state.active; }) || null;
	}

	// Shared by the single-pane preview and each half of the duplicate
	// split view — same source_kind/source_src/source_page/sheet_preview
	// shape on both the item itself and its duplicate_of.
	function previewInnerHtml(src) {
		if (src.source_kind === 'pdf' && src.source_src) {
			return '<iframe src="' + src.source_src + '#page=' + (src.source_page || 1) + '&view=FitH&pagemode=none&toolbar=1" title="เอกสารต้นฉบับ"></iframe>';
		} else if (src.source_kind === 'image' && src.source_src) {
			return '<img src="' + src.source_src + '" alt="เอกสารต้นฉบับ" />';
		} else if (src.sheet_preview && src.sheet_preview.rows && src.sheet_preview.rows.length) {
			var rows = src.sheet_preview.rows.map(function (row, ri) {
				var cells = row.map(function (cell) { return '<td>' + (cell == null ? '' : String(cell)) + '</td>'; }).join('');
				return '<tr' + (ri === 0 ? ' class="sheet-header-row"' : '') + '>' + cells + '</tr>';
			}).join('');
			return '<div class="sheet-scroll"><table class="sheet-table"><tbody>' + rows + '</tbody></table></div>';
		} else if (src.source_src) {
			return '<div class="empty">เปิดไฟล์ต้นฉบับไม่ได้ในเบราว์เซอร์ — <a href="' + src.source_src + '" target="_blank" rel="noopener">เปิดไฟล์แยก</a></div>';
		}
		return '<div class="empty">ไม่พบเอกสารต้นฉบับสำหรับรายการนี้</div>';
	}

	function renderEvidence() {
		var cur = currentItem();
		var fileEl = document.getElementById('evFile');
		var reasonEl = document.getElementById('evReason');
		var previewEl = document.getElementById('previewBody');
		var anchorEl = document.getElementById('pageAnchor');
		if (!cur) {
			fileEl.textContent = '—';
			reasonEl.textContent = '';
			previewEl.innerHTML = '<div class="empty">ไม่มีรายการ</div>';
			anchorEl.style.display = 'none';
			return;
		}
		var isKept = kept.has(cur.unit);
		fileEl.textContent = cur.file;
		reasonEl.textContent = isKept ? 'ทำเครื่องหมายว่าจะเอากลับเข้ากลุ่มแล้ว' : itemLabel(cur);
		reasonEl.style.color = isKept ? '#166534' : '#9a3412';

		var dup = !isKept ? cur.duplicate_of : null;
		if (dup && (dup.source_src || dup.sheet_preview)) {
			// Duplicate claim with a resolvable original — show both pages
			// side by side so the reviewer never has to hop tabs to compare.
			anchorEl.style.display = 'none';
			var cutLabel = cur.page != null ? ('หน้า ' + cur.page) : (cur.sheet != null ? ('ชีท ' + cur.sheet) : cur.file);
			previewEl.innerHTML = ''
				+ '<div class="preview-split">'
				+ '<div class="preview-half"><div class="preview-half-head cut"><span>ตัดออก — ' + cutLabel + '</span></div>'
				+ '<div class="preview-half-body">' + previewInnerHtml(cur) + '</div></div>'
				+ '<div class="preview-half"><div class="preview-half-head orig"><span>ต้นฉบับที่ซ้ำด้วย — ' + duplicateOfLabel(dup) + '</span>'
				+ (dup.href ? '<a class="preview-half-open" href="' + dup.href + '" target="_blank" rel="noopener">เปิดแยกแท็บ ↗</a>' : '')
				+ '</div><div class="preview-half-body">' + previewInnerHtml(dup) + '</div></div>'
				+ '</div>';
			return;
		}

		if (cur.page != null) { anchorEl.textContent = 'หน้า ' + cur.page; anchorEl.style.display = ''; }
		else { anchorEl.style.display = 'none'; }
		previewEl.innerHTML = previewInnerHtml(cur);
	}

	function scrollActiveIntoView() {
		var el = document.querySelector('#itemList .item.active');
		if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}

	function updateNavButtons() {
		var items = visibleItems();
		var idx = items.findIndex(function (it) { return it.unit === state.active; });
		document.getElementById('prevBtn').disabled = idx <= 0;
		document.getElementById('nextBtn').disabled = idx === -1 || idx >= items.length - 1;
	}

	function renderCounts() {
		document.getElementById('cntCut').textContent = data.items.length - kept.size;
		document.getElementById('cntKeep').textContent = kept.size;
		document.getElementById('pendingBadge').textContent = (data.items.length - kept.size) + ' รอตัดสินใจ';
	}

	function setActive(unit, opts) {
		state.active = unit;
		renderList();
		renderEvidence();
		updateNavButtons();
		if (!opts || opts.scrollList !== false) scrollActiveIntoView();
	}

	function step(delta) {
		var items = visibleItems();
		var idx = items.findIndex(function (it) { return it.unit === state.active; });
		var next = items[idx + delta];
		if (next) setActive(next.unit);
	}

	var chipsHtml = '<button class="chip active" data-filter="all">ทั้งหมด ' + data.items.length + '</button>'
		+ reasons.map(function (r) { return '<button class="chip" data-filter="' + r.replace(/"/g, '&quot;') + '">' + r + ' ' + reasonCounts[r] + '</button>'; }).join('');

	// Build the DOM first — every listener attached below targets an element
	// this innerHTML assignment just created, so it must run before them.
	document.getElementById('app').innerHTML = ''
		+ '<header class="navbar"><div class="brand"><a class="back-link" href="' + data.index_href + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg>กลับหน้ารวม</a>'
		+ '<h1>รายการที่ถูกตัดออก <span class="badge doc-count" id="pendingBadge">' + data.items.length + ' รอตัดสินใจ</span></h1></div>'
		+ '<div class="nav-counts"><span>ตัดออก <b id="cntCut">' + data.items.length + '</b></span><span>ทำเครื่องหมายเอากลับ <b id="cntKeep">0</b></span></div>'
		+ '</header>'
		+ '<main class="main"><div class="pane">'
		+ '<section class="evidence">'
		+ '<div class="evidence-head"><div class="titles"><h1 id="evFile"></h1><div class="reason-line" id="evReason"></div></div>'
		+ '<div class="evidence-nav"><button class="nav-btn" id="prevBtn" title="รายการก่อนหน้า"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg></button>'
		+ '<button class="nav-btn" id="nextBtn" title="รายการถัดไป"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></button></div></div>'
		+ '<div class="preview" id="previewBody"></div>'
		+ '<div class="page-anchor" id="pageAnchor"></div>'
		+ '</section>'
		+ '<div class="pane-gutter"></div>'
		+ '<section class="list-card"><div class="list-head"><h2>' + data.items.length + ' รายการที่ agent เสนอตัดออก</h2>'
		+ '<p class="list-lead">คลิกแต่ละรายการเพื่อดูต้นฉบับทางซ้าย หรือใช้ปุ่ม ‹ › ไล่ดูทีละรายการ — ปุ่มวงกลมท้ายแถวแค่ทำเครื่องหมายไว้ดูภายหลัง (เก็บในเบราว์เซอร์นี้เท่านั้น) ยังไม่ได้แก้ไฟล์จริง บอกผู้ดูแล pipeline ให้บันทึกเป็น Exclusion Declaration ของมนุษย์ถ้าจะเอากลับเข้ากลุ่มจริง</p>'
		+ '<div class="chip-group" id="chipGroup">' + chipsHtml + '</div></div>'
		+ '<div class="item-list" id="itemList"></div></section>'
		+ '</div></main>';

	document.getElementById('itemList').addEventListener('click', function (e) {
		var toggleEl = e.target.closest('[data-toggle]');
		if (toggleEl) {
			var u = toggleEl.getAttribute('data-toggle');
			if (kept.has(u)) kept.delete(u); else kept.add(u);
			persistKept();
			setActive(u, { scrollList: false });
			renderCounts();
			return;
		}
		var itemEl = e.target.closest('.item');
		if (itemEl) setActive(itemEl.getAttribute('data-unit'), { scrollList: false });
	});

	document.getElementById('prevBtn').addEventListener('click', function () { step(-1); });
	document.getElementById('nextBtn').addEventListener('click', function () { step(1); });
	document.addEventListener('keydown', function (e) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); step(1); }
		else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
	});

	document.getElementById('chipGroup').addEventListener('click', function (e) {
		var chip = e.target.closest('.chip');
		if (!chip) return;
		document.querySelectorAll('#chipGroup .chip').forEach(function (c) { c.classList.remove('active'); });
		chip.classList.add('active');
		state.filter = chip.getAttribute('data-filter');
		var items = visibleItems();
		if (!items.some(function (it) { return it.unit === state.active; }) && items.length) state.active = items[0].unit;
		renderList();
		renderEvidence();
		updateNavButtons();
		scrollActiveIntoView();
	});

	renderList();
	renderEvidence();
	renderCounts();
	updateNavButtons();
})();
</script>
</body>
</html>`;

export function renderReviewIndexHtml(data: ReviewIndexData): string {
	const blob = escapeBlob(JSON.stringify(data, null, 0));
	return INDEX_HTML.replace("__DATA__", () => blob);
}

export function renderReviewExcludedHtml(data: ReviewExcludedData): string {
	const blob = escapeBlob(JSON.stringify(data, null, 0));
	return EXCLUDED_HTML.replace("__DATA__", () => blob);
}
