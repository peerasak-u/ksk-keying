// Excluded/skip review page (wayfinder ticket #44, part of the #40 spec on
// issue #40). Same warm-stone neutrals and STATUS_META-style red/green
// pairing as dashboard.ts, so the two surfaces read as one app. XLSX claims
// render a real server-rendered table (ticket #45, xlsx-preview.ts) via a
// precomputed unitKey -> HTML map, keeping this render function itself free
// of file I/O — the same pure-render/thin-IO split as every other module here
// (server.ts builds the map before calling renderExcludedReview). The
// bring-back action (ticket #46) is wired end to end alongside confirm.
//
// LAYOUT — the reviewer's whole job here is looking at two near-identical
// pages and deciding whether they really are the same document, so the
// compare gets the screen and the list gets a rail:
//
//   [ cut page | kept page ] [ rail ]
//     full-bleed, 2px seam    280px, one line per claim
//
// Nothing on this page scrolls except the rail (and a pane, once zoomed past
// fit). Chosen from three throwaway variants built on this same route; see
// the commit that removed console/_prototype_excluded_layout/.
//
// PREVIEW — PDF.js, pinned to ONE page. Two reasons it isn't the native
// <embed> the first cut used: each embed boots Chrome's whole PDF-viewer
// extension (hundreds of requests of toolbar/annotation UI, doubled here
// because there are two panes), and a compare view has no use for a
// scrollable document — the claim is about one specific page, so that page is
// rendered alone, scaled to fit whole. The two sides then cannot drift onto
// different pages, and "หน้า 22" on screen is page 22 by construction rather
// than by scroll arithmetic.
import type { Claim, ClaimUnitRef } from "./review-claims";
import { isXlsxFile } from "./xlsx-preview";

export type ExcludedReviewGuard = { disabled: boolean; message: string | null };

export type ExcludedReviewPage = {
	clientId: string;
	monthId: string;
	companyName: string | null;
	claims: Claim[];
	guard: ExcludedReviewGuard;
	/** Whether this client-month has EVER had an excluded disposition entry.
	 * With zero claims, this distinguishes "reviewed to completion" (true)
	 * from "never had any exclusions to review" (false) — otherwise both
	 * render identically and a completed review reads as a broken/empty
	 * page on reload. */
	hasAnyExcludedEntries: boolean;
	/** unitKey -> rendered HTML, for every xlsx unit referenced by a claim or
	 * its duplicateOf counterpart (xlsx-preview.ts's buildXlsxPreviewMap). */
	xlsxPreviews: Map<string, string>;
};

export function unitLabel(page: number | null, sheet: string | null): string {
	if (page != null) return `หน้า ${page}`;
	if (sheet != null) return `ชีต ${sheet}`;
	return "ทั้งไฟล์";
}

function fileUrl(clientId: string, monthId: string, file: string): string {
	return `/files/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/${encodeURIComponent(file)}`;
}

/** What one pane needs to show one side of a claim. `file`/`unit` are kept
 * apart from the joined `label` because the chip bolds the unit (the part
 * that actually differs between the two sides) and ellipsises the file. */
export type SideView =
	| { kind: "pdf"; src: string; page: number; file: string; unit: string; label: string }
	| { kind: "xlsx"; tpl: string; file: string; unit: string; label: string };

export function sideView(clientId: string, monthId: string, ref: ClaimUnitRef, tplKey: string): SideView {
	const unit = unitLabel(ref.page, ref.sheet);
	const base = { file: ref.file, unit, label: `${ref.file} · ${unit}` };
	if (isXlsxFile(ref.file)) return { kind: "xlsx", tpl: tplKey, ...base };
	return { kind: "pdf", src: fileUrl(clientId, monthId, ref.file), page: ref.page ?? 1, ...base };
}

export type ClaimView = {
	unitKey: string;
	file: string;
	unit: string;
	reasonLabel: string;
	declaredBy: string;
	dupNote: string | null;
	cut: SideView;
	kept: SideView | null;
};

export function claimViews(page: ExcludedReviewPage): ClaimView[] {
	return page.claims.map((claim, i) => ({
		unitKey: claim.unitKey,
		file: claim.file,
		unit: unitLabel(claim.page, claim.sheet),
		reasonLabel: claim.reasonLabel,
		declaredBy: claim.declaredBy === "agent" ? "Agent" : "นโยบายระบบ",
		dupNote: claim.duplicateOf
			? `ซ้ำกับ: ${claim.duplicateOf.file} · ${unitLabel(claim.duplicateOf.page, claim.duplicateOf.sheet)}`
			: null,
		cut: sideView(page.clientId, page.monthId, claim, `${i}-cut`),
		kept: claim.duplicateOf ? sideView(page.clientId, page.monthId, claim.duplicateOf, `${i}-kept`) : null,
	}));
}

/** JSON for the inline <script>. Escaping "<" is what stops a filename or a
 * reason label from closing the script element. */
function claimViewsJson(page: ExcludedReviewPage): string {
	return JSON.stringify(claimViews(page)).replace(/</g, "\\u003c");
}

/** Pre-rendered xlsx tables parked outside the layout; the script clones one
 * into a pane when that side of a claim is a spreadsheet. Keyed to match
 * sideView()'s tpl keys. */
function xlsxTemplates(page: ExcludedReviewPage): string {
	const out: string[] = [];
	const push = (ref: ClaimUnitRef, key: string) => {
		if (!isXlsxFile(ref.file)) return;
		const html =
			page.xlsxPreviews.get(ref.unitKey) ??
			`<div class="preview-placeholder">ไม่สามารถแสดงตัวอย่างไฟล์ Excel นี้ได้<br/>${Bun.escapeHTML(ref.file)}</div>`;
		out.push(`<template class="xlsx-tpl" data-key="${key}">${html}</template>`);
	};
	page.claims.forEach((claim, i) => {
		push(claim, `${i}-cut`);
		if (claim.duplicateOf) push(claim.duplicateOf, `${i}-kept`);
	});
	return out.join("");
}

function paneHtml(side: "cut" | "kept"): string {
	const chip = side === "cut" ? "หน้าที่ตัดออก" : "หน้าที่ซ้ำอยู่ (เก็บไว้)";
	// The chip carries the verdict word AND the provenance — "หน้าที่ตัดออก"
	// alone never says which file or page you are looking at.
	return `<div class="pane" data-side="${side}">
		<div class="pane-chip"><span class="chip-tag chip-${side}">${chip}</span><span class="chip-src" id="src-${side}"></span></div>
		<div class="pane-scroll" id="scroll-${side}" onscroll="onPaneScroll('${side}')"></div>
		<div class="pane-foot"><span id="lbl-${side}"></span></div>
	</div>`;
}

function railRowHtml(claim: Claim, index: number, guard: ExcludedReviewGuard): string {
	const warnings = [
		claim.conflictGroup
			? `❗ หน้านี้ถูกบันทึกเป็นรายการอยู่ในกลุ่ม "${Bun.escapeHTML(claim.conflictGroup)}" ด้วย — ตรวจสอบก่อนคอนฟิร์ม/เอากลับ`
			: "",
		claim.referenceReportCheckMissing
			? "❗ reference-report-check ยังไม่รัน (รันตอน Completion check) ยังไม่ทราบว่าแถวของรายงานนี้ถูกบันทึกที่อื่นหรือยัง"
			: "",
	]
		.filter(Boolean)
		.map((text) => `<div class="warn-note">${text}</div>`)
		.join("");
	return `<div class="rail-row${index === 0 ? " is-active" : ""}" data-index="${index}" onclick="selectClaim(${index})">
		<div class="rail-top">
			<span class="rail-dot reason-${claim.reasonCategory}"></span>
			<span class="rail-file">${Bun.escapeHTML(claim.file)}</span>
		</div>
		<div class="rail-sub">${Bun.escapeHTML(unitLabel(claim.page, claim.sheet))} · ${Bun.escapeHTML(claim.reasonLabel)}${claim.extraScrutiny ? ' <span class="rail-warn">⚠ ตรวจสอบเป็นพิเศษ</span>' : ""}</div>
		${warnings}
		<div class="rail-actions">
			<button class="btn btn-confirm"${guard.disabled ? " disabled" : ""} onclick="event.stopPropagation(); decide(this)">✓ ตัดออก</button>
			<button class="btn btn-bring-back"${guard.disabled ? " disabled" : ""} onclick="event.stopPropagation(); bringBack(this)">↩ เอากลับ</button>
		</div>
	</div>`;
}

export function renderExcludedReview(page: ExcludedReviewPage): string {
	const displayName = page.companyName ?? page.clientId;
	const confirmUrl = `/api/runs/${encodeURIComponent(page.clientId)}/${encodeURIComponent(page.monthId)}/claims/confirm`;
	const bringBackUrl = `/api/runs/${encodeURIComponent(page.clientId)}/${encodeURIComponent(page.monthId)}/claims/bring-back`;

	const body =
		page.claims.length === 0
			? page.hasAnyExcludedEntries
				? `<div class="empty-state">✓ ตรวจสอบครบทุกรายการแล้ว</div>`
				: `<div class="empty-state">ไม่มีรายการที่ต้องตรวจสอบสำหรับเดือนนี้</div>`
			: `<div class="layout">
				<div class="viewer">
					<div class="compare" id="compare">${paneHtml("cut")}<div class="pane-split"></div>${paneHtml("kept")}</div>
					<div class="viewer-tools">
						<label class="lock"><input type="checkbox" id="lockScroll" checked /> เลื่อนพร้อมกัน</label>
						<button class="tool" onclick="zoomAll(-1)">−</button>
						<span id="zoomLabel" class="tool-label">100%</span>
						<button class="tool" onclick="zoomAll(1)">+</button>
						<button class="tool" onclick="zoomAll(0)">พอดีหน้า</button>
					</div>
				</div>
				<div class="rail">${page.claims.map((c, i) => railRowHtml(c, i, page.guard)).join("")}</div>
			</div>
			<div id="complete-banner" class="complete-banner" style="display:none;">✓ ตรวจสอบครบทุกรายการแล้ว</div>
			${xlsxTemplates(page)}`;

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>รีวิวเอกสารที่ถูกตัดออก — ${Bun.escapeHTML(displayName)}</title>
<style>
	* { box-sizing: border-box; }
	html, body { height: 100%; margin: 0; }
	/* Page body never scrolls; the rail (and a zoomed pane) own their own. */
	body {
		font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f7f6f3; color: #292524;
		display: flex; flex-direction: column; overflow: hidden;
	}
	header {
		flex: none; background: #1c1917; color: #fafaf9; padding: 10px 20px;
		display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
	}
	header a.back { color: #a8a29e; font-size: 12px; text-decoration: none; }
	header h1 { font-size: 15px; margin: 0; }
	header .sub { font-size: 11.5px; color: #a8a29e; }
	#progress { font-size: 12.5px; font-weight: 600; background: #292524; padding: 4px 11px; border-radius: 999px; }
	.guard-banner {
		flex: none; background: #fef3c7; color: #92400e; padding: 10px 20px; font-size: 13px;
		font-weight: 600; border-bottom: 1px solid #fde68a;
	}
	.empty-state, .complete-banner {
		margin: 60px auto; max-width: 480px; text-align: center; font-size: 15px; font-weight: 600;
		color: #57534e; background: #fff; padding: 30px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}

	.layout { flex: 1; min-height: 0; display: flex; }
	.viewer { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; background: #ece9e3; }

	/* Full-bleed compare: the two pages meet at a 2px seam, no padded gap. */
	.compare { flex: 1; min-height: 0; display: flex; }
	.pane { flex: 1; min-width: 0; position: relative; display: flex; flex-direction: column; background: #ece9e3; }
	.pane-split { flex: none; width: 2px; background: #1c1917; opacity: 0.25; }
	/* Nothing to compare against (not a duplicate claim): the one page gets
	   the whole viewer instead of half of it. */
	.compare.is-single .pane[data-side="kept"], .compare.is-single .pane-split { display: none; }
	/* "safe center" keeps the page centred while it fits, but leaves the
	   top/left reachable once zoom makes it overflow (plain center clips). */
	.pane-scroll {
		flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column;
		align-items: safe center; justify-content: safe center;
	}
	.pane-scroll .pdf-page { flex: none; position: relative; background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,0.18); }
	.pane-chip {
		position: absolute; top: 8px; left: 10px; right: 10px; z-index: 3;
		display: flex; align-items: center; gap: 8px; justify-content: center;
		background: rgba(255,255,255,0.96); border: 1px solid #ddd9d0; border-radius: 999px;
		padding: 3px 5px 3px 4px; box-shadow: 0 1px 5px rgba(0,0,0,0.12); pointer-events: none;
	}
	.chip-tag { flex: none; font-size: 11.5px; font-weight: 700; padding: 2px 11px; border-radius: 999px; }
	.chip-src {
		font-size: 11.5px; color: #57534e; min-width: 0; overflow: hidden;
		text-overflow: ellipsis; white-space: nowrap; padding-right: 8px;
	}
	.chip-src b { color: #1c1917; }
	.chip-cut { background: #fee2e2; color: #b91c1c; }
	.chip-kept { background: #dcfce7; color: #15803d; }
	.pane-foot {
		flex: none; font-size: 11px; color: #78716c; text-align: center; padding: 3px;
		background: #e4e0d8; border-top: 1px solid #d6d3cd;
	}
	.pane-msg { font-size: 12.5px; color: #78716c; padding: 24px; }
	/* Top margin clears the floating chip: a PDF page is centred so the chip
	   lands on empty stage, but sheet/placeholder content starts at the top. */
	.preview-placeholder {
		background: #fff; border-radius: 10px; padding: 24px; margin: 44px 20px 20px; max-width: 320px;
		text-align: center; color: #78716c; font-size: 13px;
	}
	.xlsx-sheet-table { background: #fff; border-radius: 8px; padding: 12px; margin: 44px 10px 10px; width: calc(100% - 20px); }
	.xlsx-sheet-name { font-size: 12px; font-weight: 700; color: #57534e; }
	.xlsx-table-scroll { overflow: auto; border: 1px solid #ece9e3; border-radius: 6px; margin-top: 6px; }
	.xlsx-table-scroll table { border-collapse: collapse; font-size: 11.5px; white-space: nowrap; }
	.xlsx-table-scroll td { border: 1px solid #ece9e3; padding: 3px 7px; }
	.xlsx-table-scroll tr.xlsx-header-row td { background: #ece9e3; font-weight: 700; }
	.xlsx-truncated-note, .xlsx-empty { font-size: 11px; color: #a8a29e; }
	.xlsx-sheet-divider { height: 1px; background: #ece9e3; margin: 4px 0; }

	.viewer-tools {
		flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 12px;
		background: #e4e0d8; border-top: 1px solid #d6d3cd; font-size: 12px;
	}
	.tool { border: 1px solid #d6d3cd; background: #fff; border-radius: 6px; padding: 2px 9px; cursor: pointer; font-size: 12px; }
	.tool-label { font-size: 11.5px; color: #57534e; min-width: 38px; text-align: center; }
	.lock { display: flex; align-items: center; gap: 5px; color: #57534e; margin-right: auto; cursor: pointer; }

	/* The list is a queue, not a reading surface — one line per claim, and
	   the actions only appear on the one you are actually looking at. */
	.rail { flex: 0 0 280px; overflow-y: auto; background: #f7f6f3; border-left: 1px solid #ddd9d0; padding: 8px; }
	.rail-row { padding: 8px 10px; border-radius: 8px; cursor: pointer; border-left: 3px solid transparent; }
	.rail-row:hover { background: #efece7; }
	.rail-row.is-active { background: #fff; border-left-color: #1d4ed8; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
	.rail-top { display: flex; align-items: center; gap: 6px; }
	.rail-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
	/* rtl keeps the END of a long path visible — that's where the filename is. */
	.rail-file {
		font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden;
		text-overflow: ellipsis; direction: rtl; text-align: left;
	}
	.rail-sub { font-size: 11px; color: #78716c; padding-left: 14px; }
	.rail-warn { color: #b91c1c; font-weight: 700; }
	.warn-note { font-size: 11px; color: #b91c1c; font-weight: 600; padding-left: 14px; margin-top: 3px; }
	.rail-actions { display: none; gap: 6px; margin-top: 8px; }
	.rail-row.is-active .rail-actions { display: flex; }

	.reason-context_file { background: #6366f1; } .reason-duplicate { background: #d97706; }
	.reason-blank_or_separator { background: #9ca3af; } .reason-reference_example { background: #0284c7; }
	.reason-superseded_by { background: #7c3aed; } .reason-redundant_archive { background: #6b7280; }
	.reason-reference_report { background: #dc2626; } .reason-unknown { background: #a8a29e; }

	.btn { border: none; border-radius: 7px; padding: 7px 10px; font-size: 12px; font-weight: 700; cursor: pointer; flex: 1; }
	.btn-confirm { background: #15803d; color: #fff; }
	.btn-bring-back { background: #fef3c7; color: #92400e; }
	.btn[disabled] { opacity: 0.5; cursor: default; }

	/* Too narrow for a side-by-side compare plus a rail: stack it and let the
	   page scroll. The full-bleed compare is a wide-screen affordance. */
	@media (max-width: 900px) {
		html, body { height: auto; }
		body { overflow: auto; }
		.layout { flex-direction: column; flex: none; min-height: 0; }
		.viewer { flex: none; height: 70vh; }
		.rail { flex: none; border-left: none; border-top: 1px solid #ddd9d0; }
	}
</style>
</head>
<body>
	<header>
		<div>
			<a class="back" href="/">← กลับไปที่ Dashboard</a>
			<h1>รีวิวเอกสารที่ถูกตัดออก</h1>
			<div class="sub">${Bun.escapeHTML(displayName)} — ${Bun.escapeHTML(page.monthId)}</div>
		</div>
		<span id="progress">${page.claims.length} รายการที่ต้องตรวจสอบ</span>
	</header>
	${page.guard.disabled && page.guard.message ? `<div class="guard-banner">⏳ ${Bun.escapeHTML(page.guard.message)}</div>` : ""}
	${body}
	<script src="/public/vendor/pdf.min.js"></script>
	<script>
		var CLAIMS = ${claimViewsJson(page)};
		var guardDisabled = ${page.guard.disabled ? "true" : "false"};
		var currentIndex = 0;

		var pdfLib = window.pdfjsLib || null;
		if (pdfLib) pdfLib.GlobalWorkerOptions.workerSrc = "/public/vendor/pdf.worker.min.js";

		// Both panes usually point at the SAME file (a duplicate pair is two
		// pages of one PDF), so cache by url and load it once.
		var docCache = {};
		function loadDoc(url) {
			if (!docCache[url]) docCache[url] = pdfLib.getDocument({ url: url }).promise;
			return docCache[url];
		}

		// One PDF.js pane per compare side, PINNED to a single page: the claim
		// is about one page, so that page is rendered alone and scaled to fit
		// whole. Nothing to scroll, nothing to get lost in, and the two sides
		// cannot drift onto different pages. Scrolling only becomes possible
		// past fit, where it means panning.
		function makePane(side) {
			return { side: side, el: document.getElementById("scroll-" + side), token: 0,
				doc: null, url: null, num: 0, pageNum: 1, zoom: 1, syncing: false };
		}
		var panes = {};

		function setFoot(pane, text) {
			var el = document.getElementById("lbl-" + pane.side);
			if (el) el.textContent = text;
		}

		/** Draw pane.pageNum only, at fit x zoom. Re-run on zoom and resize. */
		async function drawPage(pane, token) {
			if (!pane.doc) return;
			var pg = await pane.doc.getPage(pane.pageNum);
			if (token !== pane.token) return;
			var base = pg.getViewport({ scale: 1 });
			// Fit BOTH axes: a page you must scroll to see end-to-end isn't
			// "locked" in any useful sense.
			var availW = Math.max(120, pane.el.clientWidth - 12);
			var availH = Math.max(120, pane.el.clientHeight - 12);
			var fit = Math.min(availW / base.width, availH / base.height);
			var vp = pg.getViewport({ scale: fit * pane.zoom });
			var wrap = document.createElement("div");
			wrap.className = "pdf-page";
			wrap.style.width = Math.floor(vp.width) + "px";
			wrap.style.height = Math.floor(vp.height) + "px";
			var canvas = document.createElement("canvas");
			var dpr = Math.min(window.devicePixelRatio || 1, 2);
			canvas.width = Math.floor(vp.width * dpr);
			canvas.height = Math.floor(vp.height * dpr);
			wrap.appendChild(canvas);
			await pg.render({ canvasContext: canvas.getContext("2d"), viewport: vp,
				transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
			// Swap in only once painted, so the old page never blanks first.
			if (token !== pane.token) return;
			pane.el.innerHTML = "";
			pane.el.appendChild(wrap);
			setFoot(pane, "หน้า " + pane.pageNum + " จากทั้งหมด " + pane.num + " หน้าในไฟล์");
		}

		function setChipSource(side, meta) {
			var el = document.getElementById("src-" + side);
			if (!el) return;
			if (!meta) { el.textContent = ""; el.removeAttribute("title"); return; }
			el.textContent = "";
			el.title = meta.label;
			el.appendChild(document.createTextNode(meta.file + " · "));
			var unit = document.createElement("b");
			unit.textContent = meta.unit;
			el.appendChild(unit);
		}

		async function showSide(side, meta) {
			var pane = panes[side];
			if (!pane || !pane.el) return;
			setChipSource(side, meta);
			var token = ++pane.token;
			if (!meta) {
				pane.el.innerHTML = "";
				pane.doc = null; pane.url = null;
				setFoot(pane, "");
				return;
			}
			if (meta.kind === "xlsx") {
				var tpl = document.querySelector('.xlsx-tpl[data-key="' + meta.tpl + '"]');
				pane.el.innerHTML = tpl ? tpl.innerHTML : '<div class="pane-msg">ไม่มีตัวอย่าง</div>';
				pane.doc = null; pane.url = null;
				setFoot(pane, meta.label);
				return;
			}
			// Last resort if PDF.js itself failed to load: the native embed,
			// heavy toolbar and all — better than an empty pane.
			if (!pdfLib) {
				pane.el.innerHTML = '<embed style="width:100%;height:100%" type="application/pdf" src="' + meta.src + '#page=' + meta.page + '" />';
				return;
			}
			pane.pageNum = meta.page;
			pane.zoom = 1;
			if (pane.url === meta.src && pane.doc) { await drawPage(pane, token); return; }
			pane.el.innerHTML = '<div class="pane-msg">กำลังโหลด PDF…</div>';
			try {
				var doc = await loadDoc(meta.src);
				if (token !== pane.token) return;
				pane.doc = doc; pane.url = meta.src; pane.num = doc.numPages;
				await drawPage(pane, token);
			} catch (err) {
				if (token !== pane.token) return;
				pane.el.innerHTML = '<div class="pane-msg">เปิดไฟล์ไม่ได้: ' + meta.label + '</div>';
			}
		}

		/** Only meaningful once zoomed past fit, where scrolling = panning:
		 * keep the two sides looking at the same corner of the page. */
		function onPaneScroll(side) {
			var lock = document.getElementById("lockScroll");
			var pane = panes[side];
			if (!pane || pane.syncing) return;
			if (!lock || !lock.checked) return;
			var other = panes[side === "cut" ? "kept" : "cut"];
			if (!other || !other.el || !other.doc) return;
			other.syncing = true;
			other.el.scrollTop = pane.el.scrollTop;
			other.el.scrollLeft = pane.el.scrollLeft;
			setTimeout(function () { other.syncing = false; }, 60);
		}

		/** 100% IS fit-to-page, so there is nothing useful below it. */
		function zoomAll(dir) {
			Object.keys(panes).forEach(function (k) {
				var pane = panes[k];
				if (!pane.doc) return;
				if (dir === 0) pane.zoom = 1;
				else pane.zoom = Math.min(4, Math.max(1, pane.zoom + dir * 0.25));
				drawPage(pane, ++pane.token);
			});
			var any = panes.cut && panes.cut.doc ? panes.cut : panes.kept;
			var lbl = document.getElementById("zoomLabel");
			if (lbl && any) lbl.textContent = Math.round(any.zoom * 100) + "%";
		}

		/** Window resized: re-fit at the SAME zoom (zoomAll would change it). */
		function refitAll() {
			Object.keys(panes).forEach(function (k) {
				if (panes[k].doc) drawPage(panes[k], ++panes[k].token);
			});
		}

		function selectClaim(index) {
			var claim = CLAIMS[index];
			if (!claim) return;
			currentIndex = index;
			document.querySelectorAll(".rail-row").forEach(function (r) {
				r.classList.toggle("is-active", Number(r.dataset.index) === index);
			});
			var compare = document.getElementById("compare");
			if (compare) compare.classList.toggle("is-single", !claim.kept);
			showSide("cut", claim.cut);
			showSide("kept", claim.kept);
		}

		function claimIndexFor(el) {
			var host = el.closest("[data-index]");
			return host ? Number(host.dataset.index) : currentIndex;
		}

		async function post(url, unitKey) {
			var res = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ unitKey: unitKey }),
			});
			if (!res.ok) {
				var body = await res.json().catch(function () { return {}; });
				throw new Error(body.error || "บันทึกไม่สำเร็จ");
			}
		}

		async function decide(buttonEl) {
			if (guardDisabled) return;
			var index = claimIndexFor(buttonEl);
			var claim = CLAIMS[index];
			if (!claim) return;
			var originalText = buttonEl.textContent;
			buttonEl.disabled = true;
			buttonEl.textContent = "กำลังบันทึก...";
			try {
				await post(${JSON.stringify(confirmUrl)}, claim.unitKey);
			} catch (err) {
				alert(err.message);
				buttonEl.disabled = false;
				buttonEl.textContent = originalText;
				return;
			}
			CLAIMS[index] = null;
			var row = document.querySelector('.rail-row[data-index="' + index + '"]');
			if (row) row.remove();
			var remaining = CLAIMS.filter(Boolean).length;
			document.getElementById("progress").textContent = remaining + " รายการที่ต้องตรวจสอบ";
			if (remaining === 0) {
				var layout = document.querySelector(".layout");
				if (layout) layout.style.display = "none";
				var banner = document.getElementById("complete-banner");
				if (banner) banner.style.display = "block";
				return;
			}
			var next = CLAIMS.findIndex(Boolean);
			if (next !== -1) selectClaim(next);
		}

		async function bringBack(buttonEl) {
			if (guardDisabled) return;
			var claim = CLAIMS[claimIndexFor(buttonEl)];
			if (!claim) return;
			var originalText = buttonEl.textContent;
			buttonEl.disabled = true;
			buttonEl.textContent = "กำลังบันทึก...";
			try {
				await post(${JSON.stringify(bringBackUrl)}, claim.unitKey);
			} catch (err) {
				alert(err.message);
				buttonEl.disabled = false;
				buttonEl.textContent = originalText;
				return;
			}
			// Unlike decide(), do NOT remove just this row: bring_back resets
			// the WHOLE client-month's run back to the segment stage, which
			// will eventually regenerate dispositions.yaml/doc_groups for
			// every other pending claim on this same page too. This page's
			// whole premise (its claim list AND its guard state) is about to
			// go stale the moment the repaired run starts, so a reload is the
			// only way to see the correctly-disabled guard banner once the
			// orchestrator marks the run active again, rather than pretending
			// single-row removal is still meaningful.
			window.location.reload();
		}

		if (CLAIMS.length) {
			panes.cut = makePane("cut");
			panes.kept = makePane("kept");
			selectClaim(0);
			var resizeTimer = null;
			window.addEventListener("resize", function () {
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(refitAll, 200);
			});
		}
	</script>
</body>
</html>`;
}
