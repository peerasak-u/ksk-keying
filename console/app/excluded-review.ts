// Excluded/skip review page (wayfinder ticket #44, part of the #40 spec on
// issue #40). Promotes Variant A's validated split-screen layout from
// console/_prototype_excluded_review/ (ticket #34) into a real render
// function over real Claim[] data — same warm-stone neutrals and STATUS_META-
// style red/green pairing as dashboard.ts, so the two surfaces read as one
// app. XLSX claims render a real server-rendered table (ticket #45,
// xlsx-preview.ts) via a precomputed unitKey -> HTML map, keeping this
// render function itself free of file I/O — the same pure-render/thin-IO
// split as every other module here (server.ts builds the map before
// calling renderExcludedReview). The bring-back action (ticket #46) is now
// wired end to end alongside confirm.
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

function unitLabel(page: number | null, sheet: string | null): string {
	if (page != null) return `หน้า ${page}`;
	if (sheet != null) return `ชีต ${Bun.escapeHTML(sheet)}`;
	return "ทั้งไฟล์";
}

function fileUrl(clientId: string, monthId: string, file: string): string {
	return `/files/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/${encodeURIComponent(file)}`;
}

function previewHtml(
	clientId: string,
	monthId: string,
	ref: ClaimUnitRef,
	xlsxPreviews: Map<string, string>,
): string {
	if (isXlsxFile(ref.file)) {
		return (
			xlsxPreviews.get(ref.unitKey) ??
			`<div class="preview-placeholder">ไม่สามารถแสดงตัวอย่างไฟล์ Excel นี้ได้<br/>${Bun.escapeHTML(ref.file)}</div>`
		);
	}
	const src = fileUrl(clientId, monthId, ref.file) + (ref.page != null ? `#page=${ref.page}` : "");
	return `<embed class="pdf-embed" src="${src}" type="application/pdf" />`;
}

function viewerPanel(clientId: string, monthId: string, claim: Claim, index: number, xlsxPreviews: Map<string, string>): string {
	const content = claim.duplicateOf
		? `<div class="viewer-dup">
			<div class="viewer-col">
				<div class="viewer-label viewer-label-cut">หน้าที่ตัดออก</div>
				${previewHtml(clientId, monthId, claim, xlsxPreviews)}
			</div>
			<div class="viewer-col">
				<div class="viewer-label viewer-label-kept">หน้าที่ซ้ำอยู่ (เก็บไว้)</div>
				${previewHtml(clientId, monthId, claim.duplicateOf, xlsxPreviews)}
			</div>
		</div>`
		: `<div class="viewer-single">
			<div class="viewer-label">เอกสารที่ AI แนะนำให้ตัดออก</div>
			${previewHtml(clientId, monthId, claim, xlsxPreviews)}
		</div>`;
	return `<div class="viewer-panel" data-index="${index}" style="display:${index === 0 ? "flex" : "none"};">${content}</div>`;
}

function decideOnclick(unitKey: string): string {
	const call = `decide(${JSON.stringify(unitKey)}, this)`;
	return call.replace(/"/g, "&quot;");
}

function bringBackOnclick(unitKey: string): string {
	const call = `bringBack(${JSON.stringify(unitKey)}, this)`;
	return call.replace(/"/g, "&quot;");
}

function listRow(claim: Claim, index: number, guard: ExcludedReviewGuard): string {
	return `
	<div class="list-row ${index === 0 ? "is-active" : ""}" data-index="${index}" onclick="selectClaim(${index})">
		<div class="row-main">
			<div class="claim-file">${Bun.escapeHTML(claim.file)} <span class="claim-unit">· ${unitLabel(claim.page, claim.sheet)}</span></div>
			<div class="claim-meta">
				<span class="reason-badge reason-${claim.reasonCategory}">${Bun.escapeHTML(claim.reasonLabel)}</span>
				${claim.extraScrutiny ? `<span class="scrutiny-flag">⚠ ตรวจสอบเป็นพิเศษ</span>` : ""}
				<span class="declared-by">ระบุโดย ${claim.declaredBy === "agent" ? "Agent" : "นโยบายระบบ"}</span>
			</div>
			${claim.duplicateOf ? `<div class="dup-note">ซ้ำกับ: ${Bun.escapeHTML(claim.duplicateOf.file)} · ${unitLabel(claim.duplicateOf.page, claim.duplicateOf.sheet)}</div>` : ""}
			${claim.conflictGroup ? `<div class="warn-note">❗ หน้านี้ถูกบันทึกเป็นรายการอยู่ในกลุ่ม "${Bun.escapeHTML(claim.conflictGroup)}" ด้วย — ตรวจสอบก่อนคอนฟิร์ม/เอากลับ</div>` : ""}
			${claim.referenceReportCheckMissing ? `<div class="warn-note">❗ reference-report-check ยังไม่รัน (รันตอน Completion check) ยังไม่ทราบว่าแถวของรายงานนี้ถูกบันทึกที่อื่นหรือยัง</div>` : ""}
		</div>
		<div class="row-actions">
			<button class="btn btn-confirm" ${guard.disabled ? "disabled" : ""} onclick="event.stopPropagation(); ${decideOnclick(claim.unitKey)}">✓ ตัดออก</button>
			<button class="btn btn-bring-back" ${guard.disabled ? "disabled" : ""} onclick="event.stopPropagation(); ${bringBackOnclick(claim.unitKey)}">↩ เอากลับ</button>
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
				<div class="viewer-pane">
					${page.claims.map((c, i) => viewerPanel(page.clientId, page.monthId, c, i, page.xlsxPreviews)).join("")}
				</div>
				<div class="list-pane">
					${page.claims.map((c, i) => listRow(c, i, page.guard)).join("")}
				</div>
			</div>
			<div id="complete-banner" class="complete-banner" style="display:none;">✓ ตรวจสอบครบทุกรายการแล้ว</div>`;

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>รีวิวเอกสารที่ถูกตัดออก — ${Bun.escapeHTML(displayName)}</title>
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
	#progress { font-size: 12.5px; font-weight: 600; background: #292524; padding: 4px 11px; border-radius: 999px; }
	.guard-banner {
		background: #fef3c7; color: #92400e; padding: 10px 20px; font-size: 13px; font-weight: 600;
		border-bottom: 1px solid #fde68a;
	}
	.empty-state, .complete-banner {
		margin: 60px auto; max-width: 480px; text-align: center; font-size: 15px; font-weight: 600;
		color: #57534e; background: #fff; padding: 30px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}
	.layout { display: flex; height: calc(100vh - 50px); }
	.viewer-pane {
		flex: 1.4; background: #ece9e3; display: flex; align-items: center; justify-content: center;
		padding: 28px; position: relative; overflow: hidden; border-right: 1px solid #ddd9d0;
	}
	.viewer-panel { width: 100%; height: 100%; align-items: center; justify-content: center; }
	.viewer-single, .viewer-dup { display: flex; height: 100%; align-items: center; justify-content: center; gap: 30px; }
	.viewer-col { display: flex; flex-direction: column; align-items: center; height: 100%; gap: 10px; }
	.viewer-single { flex-direction: column; }
	.viewer-label {
		font-size: 12.5px; font-weight: 700; color: #57534e; background: #fff;
		padding: 5px 14px; border-radius: 999px; letter-spacing: 0.02em; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}
	.viewer-label-cut { background: #fee2e2; color: #b91c1c; }
	.viewer-label-kept { background: #dcfce7; color: #15803d; }
	.pdf-embed { width: auto; height: 100%; max-height: calc(100vh - 170px); border: none; }
	.viewer-single .pdf-embed { max-height: calc(100vh - 190px); }
	.preview-placeholder {
		background: #fff; border-radius: 10px; padding: 24px; max-width: 320px; text-align: center;
		color: #78716c; font-size: 13px;
	}
	.xlsx-sheet-table {
		background: #fff; border-radius: 10px; padding: 16px; max-width: 100%; max-height: 100%;
		display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}
	.xlsx-sheet-name { font-size: 12.5px; font-weight: 700; color: #57534e; }
	.xlsx-table-scroll { overflow: auto; max-height: calc(100vh - 260px); border: 1px solid #ece9e3; border-radius: 6px; }
	.xlsx-table-scroll table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
	.xlsx-table-scroll td { border: 1px solid #ece9e3; padding: 4px 8px; }
	.xlsx-table-scroll tr.xlsx-header-row td { background: #ece9e3; font-weight: 700; }
	.xlsx-truncated-note { font-size: 11px; color: #a8a29e; }
	.xlsx-empty { color: #78716c; font-size: 13px; padding: 12px; }
	.xlsx-sheet-divider { height: 1px; background: #ece9e3; margin: 4px 0; }
	.list-pane { flex: 1; overflow-y: auto; background: #f7f6f3; padding: 14px; }
	.list-row {
		background: #fff; border-radius: 10px; padding: 14px; margin-bottom: 10px; cursor: pointer;
		border: 2px solid transparent; display: flex; flex-direction: column; gap: 10px;
	}
	.list-row:hover { border-color: #d6d3cd; }
	.list-row.is-active { border-color: #1d4ed8; box-shadow: 0 2px 10px rgba(29,78,216,0.14); }
	.claim-file { font-weight: 700; font-size: 13.5px; color: #292524; }
	.claim-unit { font-weight: 400; color: #78716c; }
	.claim-meta { display: flex; gap: 8px; align-items: center; margin-top: 5px; flex-wrap: wrap; }
	.reason-badge { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
	.reason-context_file { background: #e0e7ff; color: #3730a3; }
	.reason-duplicate { background: #fef3c7; color: #92400e; }
	.reason-blank_or_separator { background: #e5e7eb; color: #374151; }
	.reason-reference_example { background: #e0f2fe; color: #075985; }
	.reason-superseded_by { background: #ede9fe; color: #5b21b6; }
	.reason-redundant_archive { background: #f3f4f6; color: #4b5563; }
	.reason-reference_report { background: #fee2e2; color: #b91c1c; }
	.reason-unknown { background: #f1efec; color: #57534e; }
	.scrutiny-flag { font-size: 11px; font-weight: 700; color: #b91c1c; }
	.declared-by { font-size: 11.5px; color: #a8a29e; }
	.dup-note { font-size: 11.5px; color: #78716c; margin-top: 2px; }
	.warn-note { font-size: 11.5px; color: #b91c1c; font-weight: 600; margin-top: 2px; }
	.row-actions { display: flex; gap: 8px; }
	.btn { border: none; border-radius: 7px; padding: 8px 10px; font-size: 12px; font-weight: 700; cursor: pointer; flex: 1; }
	.btn-confirm { background: #15803d; color: #fff; }
	.btn-bring-back { background: #fef3c7; color: #92400e; }
	.btn[disabled] { opacity: 0.5; cursor: default; }

	@media (max-width: 860px) {
		.layout { flex-direction: column; height: auto; }
		body { overflow: auto; }
		.viewer-pane { height: 50vh; padding: 16px; }
		.pdf-embed { max-height: calc(50vh - 90px); }
		.list-pane { max-height: none; }
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
	<script>
		var guardDisabled = ${page.guard.disabled ? "true" : "false"};

		function selectClaim(index) {
			document.querySelectorAll(".viewer-panel").forEach(function (p) { p.style.display = "none"; });
			document.querySelectorAll(".list-row").forEach(function (r) { r.classList.remove("is-active"); });
			var viewer = document.querySelector('.viewer-panel[data-index="' + index + '"]');
			var row = document.querySelector('.list-row[data-index="' + index + '"]');
			if (viewer) viewer.style.display = "flex";
			if (row) row.classList.add("is-active");
		}

		function remainingRows() {
			return Array.prototype.slice.call(document.querySelectorAll(".list-row"));
		}

		function updateProgress() {
			var remaining = remainingRows().length;
			var progressEl = document.getElementById("progress");
			if (progressEl) progressEl.textContent = remaining + " รายการที่ต้องตรวจสอบ";
			if (remaining === 0) {
				var layout = document.querySelector(".layout");
				if (layout) layout.style.display = "none";
				var banner = document.getElementById("complete-banner");
				if (banner) banner.style.display = "block";
			}
		}

		function nextPendingIndex() {
			var rows = remainingRows();
			return rows.length ? parseInt(rows[0].getAttribute("data-index"), 10) : -1;
		}

		async function decide(unitKey, buttonEl) {
			if (guardDisabled) return;
			var originalText = buttonEl.textContent;
			buttonEl.disabled = true;
			buttonEl.textContent = "กำลังบันทึก...";
			try {
				var res = await fetch("${confirmUrl}", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ unitKey: unitKey }),
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
			var row = buttonEl.closest(".list-row");
			var index = row.getAttribute("data-index");
			var viewer = document.querySelector('.viewer-panel[data-index="' + index + '"]');
			if (viewer) viewer.remove();
			row.remove();
			updateProgress();
			var next = nextPendingIndex();
			if (next !== -1) selectClaim(next);
		}

		async function bringBack(unitKey, buttonEl) {
			if (guardDisabled) return;
			var originalText = buttonEl.textContent;
			buttonEl.disabled = true;
			buttonEl.textContent = "กำลังบันทึก...";
			try {
				var res = await fetch("${bringBackUrl}", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ unitKey: unitKey }),
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
	</script>
</body>
</html>`;
}
