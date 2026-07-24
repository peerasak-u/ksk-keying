// PROTOTYPE — throwaway. Variant C: a gallery grouped by reason category —
// scan many small thumbnails at once (duplicates next to duplicates makes
// them easy to spot-check), click one to open a detail modal with the
// actions.

import { CLAIMS, CLIENT_LABEL, REASON_EXTRA_SCRUTINY, REASON_LABEL, type ExclusionClaim, type ReasonKind } from "./mock-data";
import { claimThumb, thumbHtml, THUMB_CSS } from "./thumb";
import { switcherHtml } from "./switcher";

const REASON_ORDER: ReasonKind[] = ["summary_report", "duplicate", "context_file", "blank"];

function galleryCard(claim: ExclusionClaim): string {
	return `
	<div class="gcard" id="gcard-${claim.id}" data-id="${claim.id}" onclick="openModal('${claim.id}')">
		${claimThumb(claim, "sm")}
		<div class="gcard-file">${Bun.escapeHTML(claim.file.split("/").pop() || claim.file)}</div>
		<div class="gcard-done" id="gcard-done-${claim.id}"></div>
	</div>`;
}

function modalContent(claim: ExclusionClaim): string {
	const extra = REASON_EXTRA_SCRUTINY[claim.reason];
	const preview = claim.duplicateOf
		? `<div class="modal-dup">
			<div><div class="modal-thumb-label">ที่ถูกตัดออก</div>${claimThumb(claim, "md")}</div>
			<span class="dup-eq">=</span>
			<div><div class="modal-thumb-label">ต้นฉบับที่เก็บไว้</div>${thumbHtml(claim.kind, claim.duplicateOf.unit, "md")}</div>
		</div>`
		: `<div class="modal-single">${claimThumb(claim, "md")}</div>`;

	return `
	<div class="modal-body" id="modal-body-${claim.id}">
		${preview}
		<div class="modal-info">
			<div class="claim-file">${Bun.escapeHTML(claim.file)} <span class="claim-unit">· ${Bun.escapeHTML(claim.unit)}</span></div>
			<div class="claim-meta">
				<span class="reason-badge reason-${claim.reason}">${REASON_LABEL[claim.reason]}</span>
				<span class="declared-by">ระบุโดย ${claim.declaredBy === "agent" ? "Agent" : "นโยบายระบบ"}</span>
			</div>
			${claim.duplicateOf ? `<div class="dup-note">ซ้ำกับ: ${Bun.escapeHTML(claim.duplicateOf.file)} · ${Bun.escapeHTML(claim.duplicateOf.unit)}</div>` : ""}
			${extra ? `<div class="extra-scrutiny">⚠ ${extra}</div>` : ""}
			<div class="modal-actions">
				<button class="btn btn-confirm" onclick="decide('${claim.id}', 'confirmed')">✓ ตัดออก (ถูกต้องแล้ว)</button>
				<button class="btn btn-restore" onclick="decide('${claim.id}', 'brought_back')">↩ เอากลับเข้า workflow</button>
			</div>
		</div>
	</div>`;
}

export function renderVariantC(): string {
	const sections = REASON_ORDER.map((reason) => {
		const items = CLAIMS.filter((c) => c.reason === reason);
		if (!items.length) return "";
		return `
		<section class="reason-section">
			<h2><span class="reason-badge reason-${reason}">${REASON_LABEL[reason]}</span><span class="reason-count">${items.length}</span></h2>
			<div class="gallery">${items.map(galleryCard).join("")}</div>
		</section>`;
	}).join("");

	const modals = CLAIMS.map((c) => `<div class="modal-slot" id="modal-slot-${c.id}" style="display:none;">${modalContent(c)}</div>`).join("");

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>รีวิวเอกสารที่ถูกตัดออก (Variant C)</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f4f5f7; color: #1f2430; }
	header { background: #fff; border-bottom: 1px solid #e2e5ea; padding: 16px 24px; position: sticky; top: 0; z-index: 10; }
	.header-inner { max-width: 1000px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
	header h1 { font-size: 16px; margin: 0; }
	header .sub { font-size: 12px; color: #6b7280; }
	#progress { font-size: 13px; font-weight: 600; background: #eef0f4; padding: 5px 12px; border-radius: 999px; }
	main { max-width: 1000px; margin: 0 auto; padding: 20px 24px 90px; }
	.reason-section { margin-bottom: 26px; }
	.reason-section h2 { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 0 0 10px; }
	.reason-count { color: #9ca3af; font-weight: 600; font-size: 12px; }
	.gallery { display: flex; flex-wrap: wrap; gap: 12px; }
	.gcard { width: 120px; cursor: pointer; position: relative; background: #fff; border-radius: 10px; padding: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
	.gcard:hover { box-shadow: 0 3px 10px rgba(0,0,0,0.1); }
	.gcard-file { font-size: 10.5px; color: #6b7280; margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.gcard-done { position: absolute; top: 6px; left: 6px; font-size: 14px; font-weight: 800; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
	${THUMB_CSS}
	.reason-badge { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
	.reason-duplicate { background: #fef3c7; color: #92400e; }
	.reason-context_file { background: #e0e7ff; color: #3730a3; }
	.reason-summary_report { background: #fee2e2; color: #b91c1c; }
	.reason-blank { background: #e5e7eb; color: #374151; }
	.declared-by { font-size: 11.5px; color: #9ca3af; }
	.dup-note, .extra-scrutiny { font-size: 12px; color: #6b7280; margin-top: 4px; }
	.extra-scrutiny { color: #b91c1c; font-weight: 600; }
	#overlay {
		display: none; position: fixed; inset: 0; background: rgba(15,17,21,0.6);
		z-index: 100; align-items: center; justify-content: center; padding: 20px;
	}
	#overlay.open { display: flex; }
	.modal-card { background: #fff; border-radius: 14px; padding: 24px; max-width: 620px; width: 100%; max-height: 90vh; overflow-y: auto; position: relative; }
	.modal-close { position: absolute; top: 12px; right: 14px; border: none; background: transparent; font-size: 18px; cursor: pointer; color: #9ca3af; }
	.modal-body { display: flex; flex-direction: column; gap: 18px; }
	.modal-single, .modal-dup { display: flex; gap: 16px; justify-content: center; }
	.modal-single .thumb { width: 200px; }
	.modal-thumb-label { font-size: 11px; color: #9ca3af; margin-bottom: 6px; text-align: center; }
	.dup-eq { font-size: 20px; color: #9ca3af; align-self: center; }
	.claim-file { font-weight: 700; font-size: 15px; }
	.claim-unit { font-weight: 400; color: #6b7280; }
	.claim-meta { display: flex; gap: 8px; align-items: center; margin: 8px 0 4px; flex-wrap: wrap; }
	.modal-actions { display: flex; gap: 10px; margin-top: 14px; }
	.btn { border: none; border-radius: 9px; padding: 10px 14px; font-size: 13px; font-weight: 700; cursor: pointer; }
	.btn-confirm { background: #16a34a; color: #fff; }
	.btn-restore { background: #f1f5f9; color: #334155; }
	@media (max-width: 640px) {
		.modal-single, .modal-dup { flex-direction: column; align-items: center; }
	}
</style>
</head>
<body>
	<header>
		<div class="header-inner">
			<div>
				<h1>รีวิวเอกสารที่ถูกตัดออก</h1>
				<div class="sub">${CLIENT_LABEL}</div>
			</div>
			<span id="progress">0/${CLAIMS.length} ตรวจสอบแล้ว</span>
		</div>
	</header>
	<main>${sections}</main>
	<div id="overlay" onclick="if(event.target===this) closeModal()">
		<div class="modal-card">
			<button class="modal-close" onclick="closeModal()">✕</button>
			<div id="modal-mount"></div>
		</div>
	</div>
	${modals}
	<script>
		var total = ${CLAIMS.length};
		var done = 0;

		function openModal(id) {
			var mount = document.getElementById("modal-mount");
			mount.innerHTML = document.getElementById("modal-slot-" + id).innerHTML;
			document.getElementById("overlay").classList.add("open");
		}
		function closeModal() {
			document.getElementById("overlay").classList.remove("open");
		}
		function decide(id, status) {
			var gcard = document.getElementById("gcard-" + id);
			if (gcard.getAttribute("data-status")) return;
			gcard.setAttribute("data-status", status);
			var badge = document.getElementById("gcard-done-" + id);
			badge.textContent = status === "confirmed" ? "✓" : "↩";
			badge.style.background = status === "confirmed" ? "#16a34a" : "#1d4ed8";
			badge.style.color = "#fff";
			done++;
			document.getElementById("progress").textContent = done + "/" + total + " ตรวจสอบแล้ว";
			closeModal();
		}
		document.addEventListener("keydown", function (e) {
			if (e.key === "Escape") closeModal();
		});
	</script>
	${switcherHtml("C")}
</body>
</html>`;
}
