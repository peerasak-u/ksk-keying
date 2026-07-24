// PROTOTYPE — throwaway. Same floating variant switcher pattern as
// _prototype_dashboard/switcher.ts, kept as its own copy so each prototype
// directory stays independently disposable (per the prototype skill: delete
// or fold in, don't leave shared throwaway infra behind).

export type VariantKey = "A" | "B" | "C";

export const VARIANT_NAMES: Record<VariantKey, string> = {
	A: "A — รายการรีวิวแนวตั้ง + พรีวิวในบรรทัด",
	B: "B — โฟกัสทีละรายการ + เทียบซ้าย-ขวา",
	C: "C — แกลเลอรีจัดกลุ่มตามเหตุผล",
};

const ORDER: VariantKey[] = ["A", "B", "C"];

export function switcherHtml(current: VariantKey): string {
	const idx = ORDER.indexOf(current);
	const prev = ORDER[(idx - 1 + ORDER.length) % ORDER.length];
	const next = ORDER[(idx + 1) % ORDER.length];
	return `
<div id="proto-switcher" style="
	position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
	display: flex; align-items: center; gap: 10px;
	background: #111827; color: #f9fafb; padding: 8px 10px; border-radius: 999px;
	box-shadow: 0 6px 20px rgba(0,0,0,0.35); font: 13px/1.2 system-ui, sans-serif;
	z-index: 9999; user-select: none;
">
	<a href="?variant=${prev}" style="color:#f9fafb; text-decoration:none; padding:4px 10px; border-radius:999px; background:#1f2937;">&larr;</a>
	<span style="min-width: 260px; text-align:center; font-weight:600;">${VARIANT_NAMES[current]}</span>
	<a href="?variant=${next}" style="color:#f9fafb; text-decoration:none; padding:4px 10px; border-radius:999px; background:#1f2937;">&rarr;</a>
</div>
<script>
	(function () {
		document.addEventListener("keydown", function (e) {
			var tag = (document.activeElement && document.activeElement.tagName) || "";
			if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable)) return;
			if (e.key === "ArrowLeft") window.location.href = "?variant=${prev}";
			if (e.key === "ArrowRight") window.location.href = "?variant=${next}";
		});
	})();
</script>`;
}
