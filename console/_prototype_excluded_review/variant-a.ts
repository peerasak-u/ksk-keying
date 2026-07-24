// PROTOTYPE — throwaway. Variant A: full-height split screen. Left is a
// real document-viewer pane (fills the screen height) showing whichever
// claim is currently selected — one labeled pane for a plain exclusion, two
// labeled panes side by side ("หน้าที่ตัดออก" / "หน้าที่ซ้ำอยู่") when the
// reason is a duplicate. Right is the scrollable list of every claim
// (metadata + actions, no thumbnail — the big preview on the left carries
// that job now) that you click through to change what the viewer shows.
// Second revision after feedback: the first pass's cards were still too
// small and both panes fought for the same space; a review page needs the
// preview to dominate, with the list as pure navigation.

import { CLAIMS, CLIENT_LABEL, REASON_EXTRA_SCRUTINY, REASON_LABEL, type ExclusionClaim } from "./mock-data";
import { claimThumb, thumbHtml, THUMB_CSS } from "./thumb";
import { switcherHtml } from "./switcher";

function viewerPanel(claim: ExclusionClaim, index: number): string {
	const content = claim.duplicateOf
		? `<div class="viewer-dup">
			<div class="viewer-col">
				<div class="viewer-label viewer-label-cut">หน้าที่ตัดออก</div>
				${claimThumb(claim, "md")}
			</div>
			<div class="viewer-col">
				<div class="viewer-label viewer-label-kept">หน้าที่ซ้ำอยู่ (เก็บไว้)</div>
				${thumbHtml(claim.kind, claim.duplicateOf.unit, "md")}
			</div>
		</div>`
		: `<div class="viewer-single">
			<div class="viewer-label">เอกสารที่ AI แนะนำให้ตัดออก</div>
			${claimThumb(claim, "md")}
		</div>`;

	return `<div class="viewer-panel" id="viewer-${claim.id}" data-index="${index}" style="display:${index === 0 ? "flex" : "none"};">${content}</div>`;
}

function listRow(claim: ExclusionClaim, index: number): string {
	const extra = REASON_EXTRA_SCRUTINY[claim.reason];
	return `
	<div class="list-row ${index === 0 ? "is-active" : ""}" id="row-${claim.id}" data-id="${claim.id}" data-index="${index}" onclick="selectClaim(${index})">
		<div class="row-main">
			<div class="claim-file">${Bun.escapeHTML(claim.file)} <span class="claim-unit">· ${Bun.escapeHTML(claim.unit)}</span></div>
			<div class="claim-meta">
				<span class="reason-badge reason-${claim.reason}">${REASON_LABEL[claim.reason]}</span>
				<span class="declared-by">ระบุโดย ${claim.declaredBy === "agent" ? "Agent" : "นโยบายระบบ"}</span>
			</div>
			${claim.duplicateOf ? `<div class="dup-note">ซ้ำกับ: ${Bun.escapeHTML(claim.duplicateOf.file)} · ${Bun.escapeHTML(claim.duplicateOf.unit)}</div>` : ""}
			${extra ? `<div class="extra-scrutiny">⚠ ${extra}</div>` : ""}
			<div class="claim-status" style="display:none;"></div>
		</div>
		<div class="row-actions">
			<button class="btn btn-confirm" onclick="event.stopPropagation(); decide('${claim.id}', 'confirmed')">✓ ตัดออก</button>
			<button class="btn btn-restore" onclick="event.stopPropagation(); decide('${claim.id}', 'brought_back')">↩ เอากลับ</button>
		</div>
	</div>`;
}

export function renderVariantA(): string {
	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>รีวิวเอกสารที่ถูกตัดออก (Variant A)</title>
<style>
	* { box-sizing: border-box; }
	html, body { height: 100%; margin: 0; }
	body { font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f7f6f3; color: #292524; overflow: hidden; }
	header {
		background: #1c1917; color: #fafaf9; padding: 12px 20px; display: flex;
		align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; height: 50px;
	}
	header h1 { font-size: 15px; margin: 0; }
	header .sub { font-size: 11.5px; color: #a8a29e; }
	#progress { font-size: 12.5px; font-weight: 600; background: #292524; padding: 4px 11px; border-radius: 999px; }
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
		padding: 5px 14px; border-radius: 999px; letter-spacing: 0.02em;
		box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}
	/* Same fg/bg pairing as the dashboard's STATUS_META (urgent / done) —
	   ties this page's color language to the rest of the app. */
	.viewer-label-cut { background: #fee2e2; color: #b91c1c; }
	.viewer-label-kept { background: #dcfce7; color: #15803d; }
	${THUMB_CSS}
	/* Override the shared thumb sizing for the viewer: fill available
	   height instead of a fixed width, so it reads as a real large page. */
	.viewer-pane .thumb { width: auto; height: 100%; max-height: calc(100vh - 170px); }
	.viewer-single .thumb { max-height: calc(100vh - 190px); }

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
	.reason-duplicate { background: #fef3c7; color: #92400e; }
	.reason-context_file { background: #e0e7ff; color: #3730a3; }
	.reason-summary_report { background: #fee2e2; color: #b91c1c; }
	.reason-blank { background: #e5e7eb; color: #374151; }
	.declared-by { font-size: 11.5px; color: #a8a29e; }
	.dup-note, .extra-scrutiny { font-size: 11.5px; color: #78716c; margin-top: 2px; }
	.extra-scrutiny { color: #b91c1c; font-weight: 600; }
	.row-actions { display: flex; gap: 8px; }
	.btn { border: none; border-radius: 7px; padding: 8px 10px; font-size: 12px; font-weight: 700; cursor: pointer; flex: 1; }
	.btn-confirm { background: #15803d; color: #fff; }
	.btn-restore { background: #f1efec; color: #44403c; }
	.list-row.is-confirmed, .list-row.is-brought_back { opacity: 0.55; }
	.list-row.is-confirmed .row-actions, .list-row.is-brought_back .row-actions { display: none; }
	.claim-status { font-size: 12px; font-weight: 700; }
	.list-row.is-confirmed .claim-status { color: #15803d; }
	.list-row.is-brought_back .claim-status { color: #1d4ed8; }

	@media (max-width: 860px) {
		.layout { flex-direction: column; height: auto; overflow: visible; }
		body { overflow: auto; }
		.viewer-pane { height: 50vh; padding: 16px; }
		.viewer-pane .thumb { max-height: calc(50vh - 90px); }
		.list-pane { max-height: none; }
	}
</style>
</head>
<body>
	<header>
		<div>
			<h1>รีวิวเอกสารที่ถูกตัดออก</h1>
			<div class="sub">${CLIENT_LABEL}</div>
		</div>
		<span id="progress">0/${CLAIMS.length} ตรวจสอบแล้ว</span>
	</header>
	<div class="layout">
		<div class="viewer-pane">
			${CLAIMS.map(viewerPanel).join("")}
		</div>
		<div class="list-pane">
			${CLAIMS.map(listRow).join("")}
		</div>
	</div>
	<script>
		var total = ${CLAIMS.length};
		var done = 0;
		var current = 0;

		function selectClaim(index) {
			document.querySelectorAll(".viewer-panel").forEach(function (p) { p.style.display = "none"; });
			document.querySelectorAll(".list-row").forEach(function (r) { r.classList.remove("is-active"); });
			document.querySelector('.viewer-panel[data-index="' + index + '"]').style.display = "flex";
			document.querySelector('.list-row[data-index="' + index + '"]').classList.add("is-active");
			current = index;
		}

		function nextPending() {
			var rows = document.querySelectorAll(".list-row");
			for (var offset = 1; offset <= total; offset++) {
				var idx = (current + offset) % total;
				var row = rows[idx];
				if (!row.classList.contains("is-confirmed") && !row.classList.contains("is-brought_back")) return idx;
			}
			return -1;
		}

		function decide(id, status) {
			var row = document.getElementById("row-" + id);
			if (row.classList.contains("is-confirmed") || row.classList.contains("is-brought_back")) return;
			row.classList.add("is-" + status);
			var statusEl = row.querySelector(".claim-status");
			statusEl.style.display = "block";
			statusEl.textContent = status === "confirmed" ? "✓ ยืนยันตัดออกแล้ว" : "↩ นำกลับเข้า workflow แล้ว";
			done++;
			document.getElementById("progress").textContent = done + "/" + total + " ตรวจสอบแล้ว";
			var next = nextPending();
			if (next !== -1) selectClaim(next);
		}
	</script>
	${switcherHtml("A")}
</body>
</html>`;
}
