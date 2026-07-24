// PROTOTYPE — throwaway. Variant B: single-item focus/triage mode. One
// claim large and centered at a time (side-by-side comparison for
// duplicates), a rail of every claim to jump between, decide-and-auto-advance
// like a moderation queue.

import { CLAIMS, CLIENT_LABEL, REASON_EXTRA_SCRUTINY, REASON_LABEL } from "./mock-data";
import { claimThumb, thumbHtml, THUMB_CSS } from "./thumb";
import { switcherHtml } from "./switcher";

export function renderVariantB(): string {
	const railItems = CLAIMS.map(
		(c, i) => `
		<div class="rail-item" id="rail-${c.id}" data-index="${i}" onclick="goTo(${i})">
			${thumbHtml(c.kind, "", "sm")}
			<div class="rail-file">${Bun.escapeHTML(c.file.split("/").pop() || c.file)}</div>
			<div class="rail-check" id="rail-check-${c.id}"></div>
		</div>`,
	).join("");

	const focusPanels = CLAIMS.map((claim, i) => {
		const extra = REASON_EXTRA_SCRUTINY[claim.reason];
		const preview = claim.duplicateOf
			? `<div class="focus-dup">
				<div class="focus-thumb-col"><div class="focus-thumb-label">ที่ถูกตัดออก</div>${claimThumb(claim, "md")}</div>
				<span class="dup-eq">=</span>
				<div class="focus-thumb-col"><div class="focus-thumb-label">ต้นฉบับที่เก็บไว้</div>${thumbHtml(claim.kind, claim.duplicateOf.unit, "md")}</div>
			</div>`
			: `<div class="focus-single">${claimThumb(claim, "md")}</div>`;

		return `
		<div class="focus-panel" id="panel-${i}" data-id="${claim.id}" style="display:${i === 0 ? "flex" : "none"};">
			${preview}
			<div class="focus-info">
				<div class="claim-file">${Bun.escapeHTML(claim.file)} <span class="claim-unit">· ${Bun.escapeHTML(claim.unit)}</span></div>
				<div class="claim-meta">
					<span class="reason-badge reason-${claim.reason}">${REASON_LABEL[claim.reason]}</span>
					<span class="declared-by">ระบุโดย ${claim.declaredBy === "agent" ? "Agent" : "นโยบายระบบ"}</span>
				</div>
				${claim.duplicateOf ? `<div class="dup-note">ซ้ำกับ: ${Bun.escapeHTML(claim.duplicateOf.file)} · ${Bun.escapeHTML(claim.duplicateOf.unit)}</div>` : ""}
				${extra ? `<div class="extra-scrutiny">⚠ ${extra}</div>` : ""}
				<div class="focus-actions">
					<button class="btn btn-confirm" onclick="decide('${claim.id}', 'confirmed')">✓ ตัดออก (ถูกต้องแล้ว) <kbd>A</kbd></button>
					<button class="btn btn-restore" onclick="decide('${claim.id}', 'brought_back')">↩ เอากลับเข้า workflow <kbd>R</kbd></button>
				</div>
			</div>
		</div>`;
	}).join("");

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>รีวิวเอกสารที่ถูกตัดออก (Variant B)</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #14171c; color: #e5e7eb; }
	header { padding: 14px 24px; border-bottom: 1px solid #262b34; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
	header h1 { font-size: 15px; margin: 0; }
	header .sub { font-size: 11.5px; color: #6b7280; }
	#progress { font-size: 13px; font-weight: 600; background: #1f2430; padding: 5px 12px; border-radius: 999px; }
	.layout { display: flex; min-height: calc(100vh - 58px); }
	.rail { width: 220px; overflow-y: auto; border-right: 1px solid #262b34; padding: 12px; flex-shrink: 0; }
	.rail-item {
		display: grid; grid-template-columns: 40px 1fr 18px; align-items: center; gap: 8px;
		padding: 8px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; position: relative;
	}
	.rail-item .thumb { width: 40px; }
	.rail-item:hover { background: #1f2430; }
	.rail-item.is-current { background: #1e2a44; outline: 1px solid #3b82f6; }
	.rail-file { font-size: 11.5px; color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rail-check { font-size: 13px; }
	.focus-wrap { flex: 1; padding: 30px 24px; display: flex; align-items: flex-start; justify-content: center; }
	.focus-panel { max-width: 720px; width: 100%; gap: 28px; align-items: center; }
	.focus-single, .focus-dup { display: flex; align-items: center; gap: 18px; justify-content: center; }
	.focus-thumb-col { width: 200px; text-align: center; }
	.focus-thumb-label { font-size: 11px; color: #9ca3af; margin-bottom: 6px; }
	.focus-single .thumb { width: 220px; }
	.dup-eq { font-size: 22px; color: #4b5563; }
	${THUMB_CSS}
	.focus-info { background: #1a1e26; border-radius: 14px; padding: 20px; width: 100%; }
	.claim-file { font-weight: 700; font-size: 16px; color: #f9fafb; }
	.claim-unit { font-weight: 400; color: #9ca3af; }
	.claim-meta { display: flex; gap: 10px; align-items: center; margin: 10px 0 8px; flex-wrap: wrap; }
	.reason-badge { font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
	.reason-duplicate { background: #fef3c7; color: #92400e; }
	.reason-context_file { background: #e0e7ff; color: #3730a3; }
	.reason-summary_report { background: #fee2e2; color: #b91c1c; }
	.reason-blank { background: #e5e7eb; color: #374151; }
	.declared-by { font-size: 12px; color: #9ca3af; }
	.dup-note { font-size: 12.5px; color: #9ca3af; }
	.extra-scrutiny { font-size: 12.5px; color: #fca5a5; font-weight: 700; margin-top: 4px; }
	.focus-actions { display: flex; gap: 10px; margin-top: 18px; }
	.btn { border: none; border-radius: 9px; padding: 12px 16px; font-size: 13.5px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 8px; }
	.btn-confirm { background: #16a34a; color: #fff; }
	.btn-restore { background: #2a2f3a; color: #e5e7eb; }
	kbd { background: rgba(255,255,255,0.15); border-radius: 4px; padding: 1px 6px; font-size: 11px; }
	.all-done { text-align: center; color: #9ca3af; font-size: 15px; padding: 60px 0; }
	@media (max-width: 720px) {
		.layout { flex-direction: column; }
		.rail { width: 100%; border-right: none; border-bottom: 1px solid #262b34; display: flex; overflow-x: auto; }
		.rail-item { flex-shrink: 0; width: 140px; }
		.focus-single, .focus-dup { flex-direction: column; }
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
		<aside class="rail">${railItems}</aside>
		<div class="focus-wrap">
			${focusPanels}
			<div class="all-done" id="all-done" style="display:none;">✓ ตรวจสอบครบทุกรายการแล้ว</div>
		</div>
	</div>
	<script>
		var total = ${CLAIMS.length};
		var done = 0;
		var current = 0;
		var statuses = {};

		function goTo(i) {
			document.querySelectorAll(".focus-panel").forEach(function (p) { p.style.display = "none"; });
			document.getElementById("all-done").style.display = "none";
			document.getElementById("panel-" + i).style.display = "flex";
			document.querySelectorAll(".rail-item").forEach(function (r) { r.classList.remove("is-current"); });
			document.querySelector('.rail-item[data-index="' + i + '"]').classList.add("is-current");
			current = i;
		}

		function nextPending() {
			for (var offset = 1; offset <= total; offset++) {
				var idx = (current + offset) % total;
				var panel = document.getElementById("panel-" + idx);
				if (!statuses[panel.getAttribute("data-id")]) return idx;
			}
			return -1;
		}

		function decide(id, status) {
			if (statuses[id]) return;
			statuses[id] = status;
			var check = document.getElementById("rail-check-" + id);
			check.textContent = status === "confirmed" ? "✓" : "↩";
			check.style.color = status === "confirmed" ? "#4ade80" : "#60a5fa";
			done++;
			document.getElementById("progress").textContent = done + "/" + total + " ตรวจสอบแล้ว";
			var next = nextPending();
			if (next === -1) {
				document.querySelectorAll(".focus-panel").forEach(function (p) { p.style.display = "none"; });
				document.getElementById("all-done").style.display = "block";
			} else {
				goTo(next);
			}
		}

		document.addEventListener("keydown", function (e) {
			var tag = (document.activeElement && document.activeElement.tagName) || "";
			if (tag === "INPUT" || tag === "TEXTAREA") return;
			var panel = document.getElementById("panel-" + current);
			if (!panel) return;
			var id = panel.getAttribute("data-id");
			if (e.key === "a" || e.key === "A") decide(id, "confirmed");
			if (e.key === "r" || e.key === "R") decide(id, "brought_back");
		});
	</script>
	${switcherHtml("B")}
</body>
</html>`;
}
