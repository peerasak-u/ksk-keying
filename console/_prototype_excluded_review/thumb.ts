// PROTOTYPE — throwaway. A CSS-drawn document-page placeholder (no real
// scanned images in this mock). PDF pages get simulated text lines; XLSX
// sheets get a mini grid — different enough to read as "this is a
// spreadsheet, not a page" at a glance. A shared visual atom, not a layout.

import type { ExclusionClaim } from "./mock-data";

export function thumbHtml(kind: "pdf" | "xlsx", label: string, size: "sm" | "md" = "md"): string {
	const inner =
		kind === "pdf"
			? `<div class="thumb-lines">${Array.from({ length: 6 })
					.map((_, i) => `<span style="width:${70 - (i % 3) * 14}%;"></span>`)
					.join("")}</div>`
			: `<div class="thumb-grid">${Array.from({ length: 12 })
					.map(() => `<span></span>`)
					.join("")}</div>`;
	return `
	<div class="thumb thumb-${size} thumb-${kind}">
		<span class="thumb-badge">${kind.toUpperCase()}</span>
		${inner}
		<div class="thumb-label">${Bun.escapeHTML(label)}</div>
	</div>`;
}

export function claimThumb(claim: ExclusionClaim, size: "sm" | "md" = "md"): string {
	return thumbHtml(claim.kind, claim.unit, size);
}

export const THUMB_CSS = `
	.thumb {
		position: relative; background: #fff; border: 1px solid #e2e5ea; border-radius: 8px;
		width: 100%; aspect-ratio: 3 / 4; display: flex; flex-direction: column;
		justify-content: center; align-items: center; gap: 6px; padding: 10px;
		box-shadow: inset 0 0 0 1px rgba(0,0,0,0.02);
	}
	.thumb::after {
		content: ""; position: absolute; top: 0; right: 0; width: 0; height: 0;
		border-style: solid; border-width: 0 14px 14px 0; border-color: transparent #f1f2f4 transparent transparent;
	}
	.thumb-sm { max-width: 96px; }
	.thumb-badge {
		position: absolute; bottom: 6px; right: 6px; font-size: 9px; font-weight: 700;
		background: #1f2937; color: #fff; padding: 1px 5px; border-radius: 4px; letter-spacing: 0.02em;
	}
	.thumb-lines { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 0 6px; }
	.thumb-lines span { display: block; height: 4px; border-radius: 2px; background: #e2e5ea; }
	.thumb-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; width: 100%; padding: 0 6px; }
	.thumb-grid span { display: block; aspect-ratio: 1.4; background: #eef0f4; border: 1px solid #e2e5ea; border-radius: 1px; }
	.thumb-label { font-size: 10px; color: #9ca3af; text-align: center; }
`;
