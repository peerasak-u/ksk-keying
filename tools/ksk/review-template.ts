import { readFileSync } from "node:fs";

// Shared review UI template + data contract for review.ts (per _gate_groups group)
// and review-groups.ts (per _doc_groups bucket). The rendered page is a single-file
// Vue 3 app; DATA is embedded inline because file:// pages cannot fetch() local JSON.

export type CoaRow = {
	account_code: string;
	sub_code: string;
	name_th: string;
	name_en: string;
};

export type ReviewLine = {
	line_index: number;
	description: string | null;
	qty: number | null;
	unit: string | null;
	unit_price: number | null;
	amount: number | null;
	amount_includes_vat: boolean | null;
	// Per-line VAT treatment; used by expense/mixed buckets. Falls back to the
	// document-level facts.vat_treatment when absent.
	vat_treatment?: "vat_7" | "non_vat" | null;
	account_code: string;
	sub_code: string;
	account_name_th: string;
	confidence: "low" | "medium" | "high";
	reason: string;
	needs_review: boolean;
};

export type ReviewPage = {
	ref: string;
	short_ref: string;
	// Rasterized fallback image (legacy _pages/*.png), relative to the bucket.
	image_src: string | null;
	// Real source document to preview (PDF/image), relative to the bucket, with
	// the page to open to. Preferred over image_src when present.
	source_src?: string | null;
	source_page?: number | null;
	source_kind?: "pdf" | "image" | "other" | null;
	extract_path: string;
	categorize_path: string;
	// Present when the page belongs to a _doc_groups group inside a bucket page.
	group_id?: string;
	group_label?: string;
	facts: Record<string, string | number | null>;
	lines: ReviewLine[];
	initial_status: "reviewed" | "needs_attention";
};

export type ReviewData = {
	schema: "ksk_review_group_html_data.v1";
	client_dir: string;
	client_key: string;
	// _gate_groups name (expense_vat, ...) or _doc_groups bucket key
	// (expense/vat, expense/non_vat, expense/mixed, income/vat, income/non_vat,
	// bank_statement).
	group: string;
	group_dir: string;
	generated_at: string;
	content_fingerprint: string;
	coa_csv: string;
	coa_rows: CoaRow[];
	pages: ReviewPage[];
};

function parseCsvLine(line: string) {
	const out: string[] = [];
	let value = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (quoted && line[i + 1] === '"') {
				value += '"';
				i++;
			} else quoted = !quoted;
		} else if (ch === "," && !quoted) {
			out.push(value);
			value = "";
		} else value += ch;
	}
	out.push(value);
	return out;
}

export function loadCoaRows(path: string): CoaRow[] {
	const text = readFileSync(path, "utf8").trim();
	if (!text) return [];
	const rows = text.split(/\r?\n/);
	const header = parseCsvLine(rows[0] || "");
	const idx = new Map(header.map((name, i) => [name, i]));
	for (const name of ["account_code", "sub_code", "name_th", "name_en"])
		if (!idx.has(name)) throw new Error(`missing COA column: ${name}`);
	return rows.slice(1).map((line) => {
		const values = parseCsvLine(line);
		return {
			account_code: values[idx.get("account_code")!] || "",
			sub_code: values[idx.get("sub_code")!] || "",
			name_th: values[idx.get("name_th")!] || "",
			name_en: values[idx.get("name_en")!] || "",
		};
	});
}

export function hashString(value: string) {
	let hash = 5381;
	for (let i = 0; i < value.length; i++)
		hash = (hash * 33) ^ value.charCodeAt(i);
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export const CDN_SCRIPTS = `<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
	<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
	<script src="https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js"></script>`;

export const VENDOR_FILES = [
	"vue.global.prod.js",
	"lucide.min.js",
	"xlsx.full.min.js",
] as const;

export const ASSET_SCRIPTS = VENDOR_FILES.map(
	(name) => `<script src="assets/${name}"></script>`,
).join("\n\t");

export function renderReviewHtml(
	data: ReviewData,
	scripts: string = CDN_SCRIPTS,
): string {
	const blob = JSON.stringify(data, null, 0).replaceAll("</", "<\\/");
	return HTML.replace("__SCRIPTS__", scripts).replace("__DATA__", blob);
}

const HTML = `<!doctype html>
<html lang="th">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>KSK Review</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&display=swap" rel="stylesheet">
	__SCRIPTS__
	<style>
		* { box-sizing: border-box; }
		body { margin: 0; font: 14px/1.4 "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f7fb; }
		button, input, select, textarea { font: inherit; }
		button:disabled { opacity: .55; cursor: not-allowed; }
		[v-cloak] { display: none; }
		.app { min-height: 100vh; }
		.navbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 8px 14px; background: rgba(255,255,255,.96); backdrop-filter: blur(8px); box-shadow: 0 1px 0 rgba(15,23,42,.04); }
		.brand { min-width: 0; }
		.brand h1 { margin: 0; display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
		.client-label { font-size: 14px; font-weight: 500; color: #65728a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: min(58vw, 100%); }
		.doc-count { flex: 0 0 auto; font-size: 12px; font-weight: 600; }
		.nav-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
		.main { padding: 0 14px 0 0; min-height: calc(100vh - 56px); }
		.feedback { margin: 12px 0 12px 14px; padding: 10px 12px; background: #eff6ff; border-radius: 10px; color: #1e40af; white-space: pre-wrap; }
		.feedback.warning { background: #fff7ed; color: #9a3412; }
		.feedback[hidden] { display: none !important; }
		.pane { display: grid; grid-template-columns: minmax(420px, 56%) minmax(360px, 1fr); gap: 14px; align-items: stretch; min-height: calc(100vh - 56px); }
		.card { min-width: 0; background: white; border-radius: 12px; padding: 14px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
		.evidence { position: sticky; top: 56px; height: calc(100vh - 56px); display: flex; flex-direction: column; min-width: 0; background: #e8ecf1; overflow: hidden; }
		.form-card { min-height: calc(100vh - 56px); margin: 14px 0; }
		.preview { position: relative; flex: 1 1 0; min-height: 0; width: 100%; }
		.image-wrap { height: 100%; width: 100%; overflow: hidden; background: #e8ecf1; border-radius: 0; cursor: grab; display: flex; align-items: center; justify-content: center; }
		.image-wrap.dragging { cursor: grabbing; }
		.image-wrap.empty { color: #64748b; font-weight: 700; }
			.pdf-frame { flex: 1 1 0; min-height: 0; width: 100%; height: 100%; border: 0; background: #e8ecf1; }
			.preview-file { display: flex; flex-direction: column; align-items: center; gap: 12px; color: #64748b; font-weight: 600; text-align: center; padding: 24px; }
			.preview-file a { text-decoration: none; padding: 9px 14px; border-radius: 8px; }
			.page-anchor { position: absolute; left: 12px; bottom: 12px; z-index: 2; padding: 4px 10px; background: rgba(255,255,255,.94); border-radius: 999px; box-shadow: 0 4px 16px rgba(15,23,42,.1); font-weight: 700; font-size: 12px; color: #334155; }
		#pageImage { width: 100%; height: 100%; object-fit: contain; transform-origin: center center; user-select: none; touch-action: none; }
		.zoombar { position: absolute; right: 12px; bottom: 12px; z-index: 2; display: flex; gap: 5px; align-items: center; padding: 5px 7px; background: rgba(255,255,255,.94); border-radius: 999px; box-shadow: 0 4px 16px rgba(15,23,42,.1); }
		.zoombar button { min-width: 28px; border-radius: 999px; padding: 5px 7px; display: inline-flex; align-items: center; justify-content: center; }
		.zoombar i, .zoombar svg { width: 16px; height: 16px; }
		.zoom-pill { background: #f3f4f6; border-radius: 999px; padding: 5px 9px; font-weight: 700; font-size: 12px; }
		.divider { width: 1px; height: 20px; background: #d1d5db; }
		.file-selector { flex: 0 0 auto; width: 100%; background: #fff; padding: 8px 0 10px; }
		.groups { display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; width: 100%; padding: 0 8px; scroll-snap-type: x proximity; overscroll-behavior-x: contain; scrollbar-color: #94a3b8 transparent; scrollbar-width: thin; }
		.groups::-webkit-scrollbar { height: 6px; }
		.groups::-webkit-scrollbar-track { background: transparent; }
		.groups::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 999px; }
		.group { flex: 0 0 168px; min-height: 76px; text-align: left; border: 0; background: #f8fafc; border-radius: 8px; padding: 8px; margin: 0; cursor: pointer; scroll-snap-align: start; }
		.group.reviewed { background: #f0fdf4; }
		.group.needs_attention { background: #fff7ed; }
		.group.unreviewed { background: #f8fafc; }
		.group.skipped { background: #f1f5f9; opacity: 0.7; }
		.group.active { background: #eff6ff; box-shadow: inset 0 0 0 2px #93c5fd; }
		.group-title { height: 36px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-weight: 600; font-size: 12px; line-height: 1.3; }
		.group-total { margin-top: 4px; font-weight: 700; color: #1e3a8a; font-size: 13px; }
		.group-source { margin-top: 2px; font-size: 11px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.muted { color: #65728a; font-size: 12px; }
		.badge { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 12px; background: #e5e7eb; }
		.badge.reviewed { background: #dcfce7; color: #166534; }
		.badge.needs_attention { background: #ffedd5; color: #9a3412; }
		.badge.unreviewed { background: #e5e7eb; color: #374151; }
		.badge.skipped { background: #e5e7eb; color: #6b7280; }
		.badge.group-tag { background: #eef2ff; color: #3730a3; }
		h1, h2, h3 { margin: 0 0 10px; }
		h1 { font-size: 20px; }
		h2 { font-size: 16px; margin-top: 0; }
		label { display: block; font-weight: 600; margin: 6px 0 4px; color: #64748b; font-size: 12px; }
		input, select, textarea { width: 100%; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; background: #fff; transition: border-color .15s ease, box-shadow .15s ease; }
		input:focus, select:focus, textarea:focus { outline: none; border-color: #93c5fd; box-shadow: 0 0 0 3px rgba(147,197,253,.22); }
		textarea { min-height: 68px; resize: vertical; }
		.doc-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 20px; margin: 10px 0 0; }
		.doc-meta-col { display: grid; gap: 10px; align-content: start; }
		.doc-meta input, .doc-meta select { height: 44px; padding: 8px 10px; }
		.doc-meta label { color: #64748b; font-weight: 600; font-size: 12px; }
		.form-section { margin-top: 28px; }
		.summary-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 20px; margin-top: 28px; }
		.summary-row input { height: 44px; font-weight: 700; }
		.summary-row label { color: #64748b; font-weight: 600; font-size: 12px; }
		.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
		.section-head { position: relative; margin: 0 0 12px; }
		.section-head h2 { margin: 0; font-size: 16px; font-weight: 700; color: #334155; }
		.section-head .actions { position: absolute; right: 0; top: -8px; margin-top: 0; }
		.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
		.primary, .secondary, .danger, .mini-danger { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
		.primary i, .secondary i, .danger i, .primary svg, .secondary svg, .danger svg { width: 16px; height: 16px; flex-shrink: 0; }
		.primary { background: #1d4ed8; color: white; border: 0; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
		.secondary { background: #f1f5f9; color: #334155; border: 0; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
		.danger { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; border-radius: 8px; padding: 6px 9px; cursor: pointer; }
		.items-list { display: grid; gap: 20px; }
		.line-card { padding: 0 0 20px; }
		.line-top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; align-items: start; }
		.line-numbers { display: grid; grid-template-columns: 82px 82px 120px 120px 36px; gap: 10px; align-items: end; margin-top: 8px; }
		.line-numbers.mixed { grid-template-columns: 72px 72px 104px 104px 110px 36px; }
		.line-card label { margin-top: 0; color: #475569; font-size: 12px; }
		.line-card input, .line-card select { height: 40px; }
		.line-card .amount input { font-weight: 700; text-align: right; }
		.line-desc-field { position: relative; }
		.line-desc-field.has-hint input { padding-right: 36px; }
		.line-hint-trigger { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); z-index: 2; }
		.hint-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 999px; background: transparent; color: #f59e0b; cursor: help; }
		.hint-icon:hover, .hint-icon:focus-visible { background: #fffbeb; color: #d97706; outline: none; }
		.hint-icon.warn { color: #ea580c; }
		.hint-icon.warn:hover, .hint-icon.warn:focus-visible { background: #fff7ed; color: #c2410c; }
		.hint-icon i, .hint-icon svg { width: 16px; height: 16px; }
		.hint-popup { display: none; position: absolute; right: 0; top: calc(100% + 6px); z-index: 6; width: min(340px, 72vw); padding: 10px 12px; background: #fff; border-radius: 10px; box-shadow: 0 10px 28px rgba(15,23,42,.14); font-size: 12px; line-height: 1.45; color: #9a3412; text-align: left; white-space: normal; pointer-events: none; }
		.line-hint-trigger:hover .hint-popup, .line-hint-trigger:focus-within .hint-popup { display: block; }
		.mini-danger { background: transparent; color: #991b1b; border: 0; cursor: pointer; padding: 4px; border-radius: 6px; height: 40px; }
		.mini-danger:hover { background: #fee2e2; }
		.mini-danger i, .mini-danger svg { width: 18px; height: 18px; }
		.coa-totals { margin-top: 4px; display: grid; gap: 6px; }
		.coa-total-row { display: grid; grid-template-columns: 1fr 120px; gap: 8px; padding: 2px 0; color: #64748b; font-size: 13px; }
		.coa-total-row b:last-child { text-align: right; }
		details { margin: 0; }
		details.form-section { margin-top: 28px; }
		summary { cursor: pointer; font-weight: 600; color: #475569; font-size: 14px; }
		.form-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 24px; padding-top: 0; }
		.modal-backdrop { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(15,23,42,.42); }
		.export-modal { width: min(1180px, 96vw); max-height: 92vh; display: flex; flex-direction: column; gap: 14px; overflow: hidden; }
		.modal-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
		.icon-button { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border: 0; border-radius: 999px; background: #f1f5f9; color: #334155; cursor: pointer; }
		.icon-button i, .icon-button svg { width: 17px; height: 17px; }
		.export-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
		.export-stat { padding: 10px 12px; border-radius: 10px; background: #f8fafc; }
		.export-stat b { display: block; font-size: 18px; color: #1d4ed8; }
		.export-warnings { max-height: 96px; overflow: auto; margin: 0; padding: 10px 12px 10px 28px; border-radius: 10px; background: #fff7ed; color: #9a3412; }
		.export-table-wrap { overflow: auto; border: 1px solid #e2e8f0; border-radius: 10px; }
		.export-table { width: 100%; min-width: 980px; border-collapse: collapse; font-size: 12px; }
		.export-table th, .export-table td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: left; white-space: nowrap; }
		.export-table th { position: sticky; top: 0; z-index: 1; background: #f8fafc; color: #475569; font-weight: 700; }
		.export-table td.number { text-align: right; }
		.export-table td.blank { background: #fff7ed; color: #c2410c; }
		.modal-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
		@media (max-width: 980px) { .navbar, .pane, .doc-meta, .summary-row, .line-top { display: block; } .main { padding: 0; } .navbar { position: static; } .nav-actions { justify-content: flex-start; margin-top: 8px; } .evidence { position: static; height: auto; } .preview { min-height: 70vh; } .form-card { margin: 14px; } .line-numbers, .line-numbers.mixed { grid-template-columns: repeat(2, minmax(0, 1fr)); } .export-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
		.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 50; padding: 10px 20px; border-radius: 10px; background: #1e3a8a; color: #fff; font-weight: 600; font-size: 13px; box-shadow: 0 8px 28px rgba(15,23,42,.18); opacity: 0; transition: opacity .25s ease; pointer-events: none; }
		.toast.show { opacity: 1; }
	</style>
</head>
<body>
<div id="app" class="app" v-cloak>
	<header class="navbar">
		<div class="brand">
			<h1>KSK <span class="client-label">{{ data.client_key }} · {{ data.group }}</span><span class="badge doc-count">{{ data.pages.length }} เอกสาร</span></h1>
			<div class="muted">{{ draftStatus || 'ฉบับร่างจะบันทึกในเบราว์เซอร์อัตโนมัติ' }}</div>
		</div>
		<div class="nav-actions">
			<button class="primary" type="button" @click="showExportPreview"><i data-lucide="file-spreadsheet"></i><span>ส่งออก XLSX</span></button>
		</div>
	</header>
	<main class="main">
		<div class="feedback warning" v-if="message">{{ message }}</div>
		<div class="toast" :class="{show: toast.visible}" v-if="toast.message">{{ toast.message }}</div>
		<div class="pane">
			<section class="evidence">
				<div class="preview">
					<iframe v-if="previewKind === 'pdf'" :key="'pdf-' + currentIndex" class="pdf-frame" :src="pdfSrc" title="source pdf"></iframe>
						<div v-else id="imageWrap" class="image-wrap" :class="{dragging: dragging, empty: previewKind !== 'image'}" @pointerdown="startPan" @pointermove="movePan" @pointerup="endPan" @pointerleave="endPan">
						<img v-if="previewKind === 'image'" id="pageImage" :src="imageSrc" alt="หลักฐานเอกสาร" :style="imageStyle" draggable="false" />
						<div v-else-if="previewKind === 'file'" class="preview-file"><div>ไฟล์ต้นฉบับเปิดในเบราว์เซอร์ไม่ได้ (เช่น .xlsx)</div><a class="secondary" :href="currentPage.source_src" target="_blank" rel="noopener"><i data-lucide="external-link"></i><span>เปิดไฟล์ต้นฉบับ</span></a></div>
							<div v-else>ไม่มีเอกสารต้นฉบับสำหรับหน้านี้</div>
					</div>
					<div class="page-anchor" v-if="previewKind === 'pdf' && currentPage.source_page">หน้า {{ currentPage.source_page }}</div>
						<div class="zoombar" aria-label="ควบคุมพรีวิว" v-if="previewKind === 'image'">
						<button class="secondary" type="button" @click="zoomOut" title="ซูมออก"><i data-lucide="zoom-out"></i></button>
						<span class="zoom-pill">{{ Math.round(zoom * 100) }}%</span>
						<button class="secondary" type="button" @click="zoomIn" title="ซูมเข้า"><i data-lucide="zoom-in"></i></button>
						<span class="divider"></span>
						<button class="secondary" type="button" @click="resetPreview" title="รีเซ็ตพรีวิว"><i data-lucide="maximize-2"></i></button>
					</div>
				</div>
				<div class="file-selector">
					<div class="groups" @wheel="scrollGroups">
						<button v-for="(page, index) in data.pages" :key="page.ref" class="group" :class="[pageStatus(index), {active: index === currentIndex}]" type="button" @click="selectPage(index)">
							<div class="group-title">{{ pageTitle(page) }}</div>
							<div class="group-total">{{ formatBaht(page.facts.total) }}</div>
							<div class="muted"><span class="badge" :class="pageStatus(index)">{{ statusLabel(pageStatus(index)) }}</span> · {{ page.short_ref }}</div>
							<div class="group-source" v-if="page.group_label || page.group_id">{{ page.group_label || page.group_id }}</div>
						</button>
					</div>
				</div>
			</section>
			<section class="card form-card">
				<h1>{{ pageTitle(currentPage) }}</h1>
				<div class="muted">{{ currentPage.ref }}<span v-if="currentPage.group_label || currentPage.group_id"> · <span class="badge group-tag">{{ currentPage.group_label || currentPage.group_id }}</span></span></div>
				<div class="doc-meta">
					<div class="doc-meta-col">
						<div v-for="field in primaryLeftFields" :key="field.key">
							<label>{{ field.label }}</label>
							<select v-if="field.key === 'vat_treatment'" v-model="currentState.facts[field.key]">
								<option value="">ว่าง</option>
								<option value="vat_7">VAT 7%</option>
								<option value="non_vat">ไม่มี VAT</option>
								<option value="unknown">ไม่ทราบ</option>
							</select>
							<input v-else v-model="currentState.facts[field.key]" />
						</div>
					</div>
					<div class="doc-meta-col">
						<div v-for="field in primaryRightFields" :key="field.key">
							<label>{{ field.label }}</label>
							<input v-model="currentState.facts[field.key]" />
						</div>
					</div>
				</div>
				<div class="form-section">
					<div class="section-head">
						<h2>รายการ</h2>
						<div class="actions"><button class="secondary" type="button" @click="addLine"><i data-lucide="plus"></i><span>เพิ่มรายการ</span></button></div>
					</div>
					<div class="items-list">
						<div class="line-card" v-for="(line, lineIndex) in currentState.lines" :key="line.local_id">
							<div class="line-top">
								<div>
									<label>ผังบัญชี</label>
									<select v-model="line.account_key">
										<option value="">ยังไม่ระบุ / ว่าง</option>
										<option v-for="row in data.coa_rows" :key="coaKey(row)" :value="coaKey(row)">{{ coaLabel(row) }}</option>
									</select>
								</div>
								<div>
									<label>รายละเอียด</label>
									<div class="line-desc-field" :class="{'has-hint': lineHint(line)}">
										<input v-model="line.description" />
										<div class="line-hint-trigger" v-if="lineHint(line)">
											<button class="hint-icon" :class="{warn: line.needs_review}" type="button" :title="line.needs_review ? 'ต้องตรวจสอบ' : 'เหตุผลการจัดหมวด'" aria-label="เหตุผลการจัดหมวด"><i data-lucide="triangle-alert"></i></button>
											<div class="hint-popup" role="tooltip">{{ lineHint(line) }}</div>
										</div>
									</div>
								</div>
							</div>
							<div class="line-numbers" :class="{mixed: isMixedBucket}">
								<div><label>จำนวน</label><input v-model="line.qty" /></div>
								<div><label>หน่วย</label><input v-model="line.unit" /></div>
								<div class="amount"><label>ราคา</label><input v-model="line.unit_price" /></div>
								<div class="amount"><label>ยอด</label><input v-model="line.amount" /></div>
								<div v-if="isMixedBucket">
									<label>VAT</label>
									<select v-model="line.vat_treatment">
										<option :value="null">ตามเอกสาร</option>
										<option value="vat_7">VAT 7%</option>
										<option value="non_vat">ไม่มี VAT</option>
									</select>
								</div>
								<button class="mini-danger" type="button" @click="removeLine(lineIndex)" title="ลบรายการ"><i data-lucide="trash-2"></i></button>
							</div>
						</div>
					</div>
					<div class="coa-totals" v-if="coaTotals.length">
						<div class="coa-total-row" v-for="row in coaTotals" :key="row.key"><span>{{ row.label }}</span><b>{{ formatBaht(row.total) }}</b></div>
					</div>
				</div>
				<div class="summary-row">
					<div v-for="field in summaryFields" :key="field.key">
						<label>{{ field.label }}</label>
						<input v-model="currentState.facts[field.key]" />
					</div>
				</div>
				<details class="form-section">
					<summary>ฟิลด์อื่นๆ</summary>
					<div class="grid">
						<div v-for="field in extraFields" :key="field.key"><label>{{ field.label }}</label><input v-model="currentState.facts[field.key]" /></div>
					</div>
				</details>
				<details class="form-section">
					<summary>บัญชี / ตัวควบคุมผู้ตรวจ</summary>
					<div class="grid">
						<div><label>สถานะ</label><select v-model="currentState.status"><option value="reviewed">ตรวจแล้ว</option><option value="needs_attention">ต้องตรวจสอบ</option></select></div>
					</div>
					<label>บันทึกผู้ตรวจ</label><textarea v-model="currentState.note" placeholder="จำเป็นเมื่อสถานะต้องตรวจสอบ"></textarea>
				</details>
				<div class="form-actions">
					<button class="secondary" type="button" @click="toggleSkip">{{ currentState.skipped ? 'ใช้หน้านี้' : 'ไม่ใช้ข้อมูลหน้านี้' }}</button>
					<button class="primary" type="button" @click="saveAndNext"><i data-lucide="save"></i><span>บันทึกและถัดไป</span><i data-lucide="arrow-right"></i></button>
				</div>
			</section>
		</div>
	</main>
	<div v-if="exportPreview" class="modal-backdrop" @click.self="closeExportPreview">
		<section class="card export-modal" role="dialog" aria-modal="true" aria-labelledby="exportPreviewTitle">
			<div class="modal-head">
				<div>
					<h2 id="exportPreviewTitle">ตรวจสอบก่อนส่งออก PEAK XLSX</h2>
					<div class="muted">ประเภทไฟล์ PEAK: {{ exportPreview.template_name }} · Sheet: {{ exportPreview.sheet_name }} · ไฟล์: {{ exportPreview.filename }}</div>
				</div>
				<button class="icon-button" type="button" @click="closeExportPreview" title="ปิด"><i data-lucide="x"></i></button>
			</div>
			<div class="export-stats">
				<div class="export-stat"><span class="muted">เอกสารที่ส่งออก</span><b>{{ exportPreview.committed_count }}</b></div>
				<div class="export-stat"><span class="muted">แถวในไฟล์</span><b>{{ exportPreview.rows.length }}</b></div>
				<div class="export-stat"><span class="muted">เอกสารที่ยังไม่ตรวจ</span><b>{{ exportPreview.uncommitted_count }}</b></div>
				<div class="export-stat"><span class="muted">คำเตือน</span><b>{{ exportPreview.warnings.length }}</b></div>
			</div>
			<ul class="export-warnings" v-if="exportPreview.warnings.length">
				<li v-for="(warning, warningIndex) in exportPreview.warnings" :key="warningIndex">{{ warning }}</li>
			</ul>
			<div class="export-table-wrap">
				<table class="export-table">
					<thead><tr><th v-for="column in exportPreview.preview_columns" :key="column.index">{{ column.label }}</th></tr></thead>
					<tbody>
						<tr v-for="(row, rowIndex) in exportPreview.rows" :key="rowIndex">
							<td v-for="column in exportPreview.preview_columns" :key="column.index" :class="[{blank: row.cells[column.index] === '' || row.cells[column.index] === null || row.cells[column.index] === undefined}, column.number ? 'number' : '']">{{ row.cells[column.index] }}</td>
						</tr>
					</tbody>
				</table>
			</div>
			<div class="modal-actions">
				<button class="secondary" type="button" @click="closeExportPreview">ยกเลิก</button>
				<button class="primary" type="button" :disabled="!exportPreview.rows.length" @click="downloadExportXlsx"><i data-lucide="download"></i><span>บันทึก XLSX</span></button>
			</div>
		</section>
	</div>
</div>
<script id="reviewData" type="application/json">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById('reviewData').textContent);
const DRAFT_SCHEMA = 'ksk_review_vue_draft.v1';
const PRIMARY_LEFT_FIELDS = [
	{key: 'date', label: 'วันที่'},
	{key: 'seller', label: 'ผู้ขาย'},
	{key: 'buyer', label: 'ผู้ซื้อ'},
	{key: 'vat_treatment', label: 'การจัดการ VAT'},
];
const PRIMARY_RIGHT_FIELDS = [
	{key: 'document_no', label: 'เลขที่เอกสาร'},
	{key: 'seller_tax_id', label: 'เลขประจำตัวผู้เสียภาษีผู้ขาย'},
	{key: 'buyer_tax_id', label: 'เลขประจำตัวผู้เสียภาษีผู้ซื้อ'},
];
const SUMMARY_FIELDS = [
	{key: 'subtotal', label: 'ยอดก่อนภาษี'},
	{key: 'total', label: 'ยอดรวม'},
];
const EXTRA_FIELDS = [
	{key: 'reference', label: 'อ้างอิง'},
	{key: 'vat', label: 'ภาษีมูลค่าเพิ่ม'},
	{key: 'paid', label: 'ชำระแล้ว'},
	{key: 'summary', label: 'จำนวนเงินตัวอักษร'},
];
const STATUS_LABELS = {reviewed: 'ตรวจแล้ว', needs_attention: 'ต้องตรวจสอบ', unreviewed: 'ยังไม่ตรวจ', skipped: 'ไม่ใช้'};
const PEAK_EXPENSE_HEADERS = ['ลำดับที่*', 'วันที่เอกสาร', 'อ้างอิงถึง', 'ผู้รับเงิน/คู่ค้า', 'เลขทะเบียน 13 หลัก', 'เลขสาขา 5 หลัก', 'เลขที่ใบกำกับฯ', 'วันที่ใบกำกับฯ', 'วันที่บันทึกภาษีซื้อ', 'ประเภทราคา', 'บัญชี', 'คำอธิบาย', 'จำนวน', 'ราคาต่อหน่วย', 'อัตราภาษี', 'หัก ณ ที่จ่าย', 'ชำระโดย', 'จำนวนเงินที่ชำระ', 'ภ.ง.ด.', 'หมายเหตุ', 'กลุ่มจัดประเภท'];
const PEAK_REVENUE_HEADERS = ['ลำดับที่*', 'วันที่เอกสาร', 'อ้างอิงจาก', 'ผู้รับเงิน/คู่ค้า', 'เลขทะเบียน 13 หลัก', 'เลขสาขา 5 หลัก', 'เลขที่ใบกำกับฯ', 'วันที่ใบกำกับฯ', 'วันที่บันทึกภาษีขาย', 'ประเภทราคา', 'บัญชี', 'คำอธิบาย', 'จำนวน', 'ราคาต่อหน่วย', 'อัตราภาษี', 'หัก ณ ที่จ่าย', 'รับชำระโดย', 'จำนวนเงินที่ได้รับ', 'ภ.ง.ด.', 'หมายเหตุ', 'กลุ่มจัดประเภท'];
const PEAK_JOURNAL_HEADERS = ['ลำดับที่*', 'วันที่เอกสาร', 'อ้างอิงถึง', 'คำอธิบาย', 'รหัสบัญชี', 'ชื่อบัญชี', 'เดบิต', 'เครดิต', 'หมายเหตุ'];
const EXPORT_PREVIEW_COLUMNS = [
	{index: 0, label: 'ลำดับที่'},
	{index: 1, label: 'วันที่เอกสาร'},
	{index: 4, label: 'เลขทะเบียน 13 หลัก'},
	{index: 5, label: 'เลขสาขา'},
	{index: 6, label: 'เลขที่ใบกำกับฯ'},
	{index: 9, label: 'ประเภทราคา'},
	{index: 10, label: 'บัญชี'},
	{index: 11, label: 'คำอธิบาย'},
	{index: 12, label: 'จำนวน', number: true},
	{index: 13, label: 'ราคาต่อหน่วย', number: true},
	{index: 14, label: 'อัตราภาษี'},
	{index: 16, label: 'ชำระโดย'},
	{index: 17, label: 'จำนวนเงินที่ชำระ', number: true},
];
const EXPORT_PREVIEW_COLUMNS_REVENUE = [
	{index: 0, label: 'ลำดับที่'},
	{index: 1, label: 'วันที่เอกสาร'},
	{index: 4, label: 'เลขทะเบียน 13 หลัก'},
	{index: 5, label: 'เลขสาขา'},
	{index: 6, label: 'เลขที่ใบกำกับฯ'},
	{index: 9, label: 'ประเภทราคา'},
	{index: 10, label: 'บัญชี'},
	{index: 11, label: 'คำอธิบาย'},
	{index: 12, label: 'จำนวน', number: true},
	{index: 13, label: 'ราคาต่อหน่วย', number: true},
	{index: 14, label: 'อัตราภาษี'},
	{index: 16, label: 'รับชำระโดย'},
	{index: 17, label: 'จำนวนเงินที่ได้รับ', number: true},
];
const EXPORT_PREVIEW_COLUMNS_JOURNAL = [
	{index: 0, label: 'ลำดับที่'},
	{index: 1, label: 'วันที่เอกสาร'},
	{index: 3, label: 'คำอธิบาย'},
	{index: 4, label: 'รหัสบัญชี'},
	{index: 5, label: 'ชื่อบัญชี'},
	{index: 6, label: 'เดบิต', number: true},
	{index: 7, label: 'เครดิต', number: true},
];
const THAI_MONTHS = {
	'มกราคม': '01', 'ม.ค.': '01', 'มค': '01',
	'กุมภาพันธ์': '02', 'ก.พ.': '02', 'กพ': '02',
	'มีนาคม': '03', 'มี.ค.': '03', 'มีค': '03',
	'เมษายน': '04', 'เม.ย.': '04', 'เมย': '04',
	'พฤษภาคม': '05', 'พ.ค.': '05', 'พค': '05',
	'มิถุนายน': '06', 'มิ.ย.': '06', 'มิย': '06',
	'กรกฎาคม': '07', 'ก.ค.': '07', 'กค': '07',
	'สิงหาคม': '08', 'ส.ค.': '08', 'สค': '08',
	'กันยายน': '09', 'ก.ย.': '09', 'กย': '09',
	'ตุลาคม': '10', 'ต.ค.': '10', 'ตค': '10',
	'พฤศจิกายน': '11', 'พ.ย.': '11', 'พย': '11',
	'ธันวาคม': '12', 'ธ.ค.': '12', 'ธค': '12',
};
function clone(value) { return JSON.parse(JSON.stringify(value || null)); }
function draftKey() { return 'ksk-review:draft:v1:' + DATA.client_key + ':' + DATA.group + ':' + DATA.content_fingerprint; }
function parseBucket(group) {
	const g = String(group || '');
	if (g === 'bank_statement') return {category: 'bank_statement', vat: null};
	const legacy = {expense_vat: ['expense', 'vat'], expense_nonvat: ['expense', 'non_vat'], income_vat: ['income', 'vat'], income_nonvat: ['income', 'non_vat']};
	if (legacy[g]) return {category: legacy[g][0], vat: legacy[g][1]};
	const parts = g.split('/');
	if ((parts[0] === 'expense' || parts[0] === 'income') && ['vat', 'non_vat', 'mixed'].includes(parts[1])) return {category: parts[0], vat: parts[1]};
	return null;
}
function peakTemplateForGroup(group) {
	const bucket = parseBucket(group);
	if (!bucket) return null;
	const filename = 'peak_import_' + bucket.category + (bucket.vat ? '_' + bucket.vat : '') + '.xlsx';
	if (bucket.category === 'expense') return {template_name: 'PEAK_ImportExpense', sheet_name: 'Import_Expenses', type: 'expense', filename};
	if (bucket.category === 'income') return {template_name: 'PEAK_ImportReceipt', sheet_name: 'Import_Receipts', type: 'revenue', filename};
	return {template_name: 'PEAK_ImportJournal', sheet_name: 'Import_Journal', type: 'journal', filename};
}
function splitAccountKey(key) {
	const parts = String(key || '').split('||');
	return {account_code: parts[0] || '', sub_code: parts[1] || ''};
}
function normalizePeakYear(year) {
	const n = Number(year);
	if (!Number.isFinite(n)) return String(year || '');
	return String(n > 2400 ? n - 543 : n).padStart(4, '0');
}
function normalizeDateForPeak(value) {
	const text = String(value ?? '').trim();
	if (!text) return '';
	const thai = text.replace(/[ ]+/g, ' ').split(' ');
	if (thai.length >= 3) {
		const day = thai[0].replace(/[^0-9]/g, '');
		const month = THAI_MONTHS[thai[1]];
		const year = thai[2].replace(/[^0-9]/g, '');
		if (day && month && year) return normalizePeakYear(year) + month + day.padStart(2, '0');
	}
	const ymd = text.match(/^([0-9]{4})[-/. ]([0-9]{1,2})[-/. ]([0-9]{1,2})$/);
	if (ymd) return normalizePeakYear(ymd[1]) + ymd[2].padStart(2, '0') + ymd[3].padStart(2, '0');
	const dmy = text.match(/^([0-9]{1,2})[-/. ]([0-9]{1,2})[-/. ]([0-9]{4})$/);
	if (dmy) return normalizePeakYear(dmy[3]) + dmy[2].padStart(2, '0') + dmy[1].padStart(2, '0');
	const digits = text.replace(/[^0-9]/g, '');
	if (digits.length === 8) return normalizePeakYear(digits.slice(0, 4)) + digits.slice(4);
	return text;
}
function normalizeTaxId(value) {
	return String(value ?? '').replace(/[^0-9]/g, '');
}
function amountNumberOrNull(value) {
	const text = String(value ?? '').replace(/,/g, '').trim();
	if (!text) return null;
	const n = Number(text);
	return Number.isFinite(n) ? n : null;
}
function makeState(page) {
	return {
		facts: clone(page.facts) || {},
		status: page.initial_status || 'reviewed',
		note: '',
		committed: false,
		skipped: false,
		lines: (page.lines || []).map(function(line, index) {
			const accountKey = (line.account_code || line.sub_code) ? (line.account_code || '') + '||' + (line.sub_code || '') : '';
			return {
				local_id: page.ref + ':' + index,
				description: line.description || '',
				qty: line.qty ?? '',
				unit: line.unit || '',
				unit_price: line.unit_price ?? '',
				amount: line.amount ?? '',
				amount_includes_vat: line.amount_includes_vat ?? null,
				vat_treatment: line.vat_treatment || null,
				account_key: accountKey,
				confidence: line.confidence || 'low',
				reason: line.reason || '',
				needs_review: !!line.needs_review,
			};
		}),
	};
}
function normalizeAmount(value) {
	const n = Number(String(value ?? '').replace(/,/g, ''));
	return Number.isFinite(n) ? n : 0;
}
function formatBaht(value) {
	const n = normalizeAmount(value);
	if (!n && value !== 0 && value !== '0') return '';
	return n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' บาท';
}
const app = Vue.createApp({
	data() {
		return {
			data: DATA,
			currentIndex: 0,
			states: DATA.pages.map(makeState),
			primaryLeftFields: PRIMARY_LEFT_FIELDS,
			primaryRightFields: PRIMARY_RIGHT_FIELDS,
			summaryFields: SUMMARY_FIELDS,
			extraFields: EXTRA_FIELDS,
			message: '',
			toast: { message: '', visible: false },
			toastTimer: null,
			exportPreview: null,
			draftStatus: '',
			draftTimer: null,
			zoom: 1,
			panX: 0,
			panY: 0,
			dragging: false,
			dragStartX: 0,
			dragStartY: 0,
			startPanX: 0,
			startPanY: 0,
		};
	},
	computed: {
		currentPage() { return this.data.pages[this.currentIndex]; },
		currentState() { return this.states[this.currentIndex]; },
			imageSrc() {
				const p = this.currentPage;
				return (p.source_kind === 'image' && p.source_src) ? p.source_src : p.image_src;
			},
			pdfSrc() {
				const p = this.currentPage;
				if (!p.source_src) return '';
				return p.source_src + '#page=' + (p.source_page || 1) + '&view=FitH&pagemode=none&toolbar=1';
			},
			previewKind() {
				const p = this.currentPage;
				if (p.source_kind === 'pdf' && p.source_src) return 'pdf';
				if ((p.source_kind === 'image' && p.source_src) || p.image_src) return 'image';
				if (p.source_kind === 'other' && p.source_src) return 'file';
				return 'none';
			},
		imageStyle() { return { transform: 'translate(' + this.panX + 'px, ' + this.panY + 'px) scale(' + this.zoom + ')' }; },
		isMixedBucket() {
			const bucket = parseBucket(this.data.group);
			return !!bucket && bucket.vat === 'mixed';
		},
		coaTotals() {
			const rows = new Map();
			for (const line of this.currentState.lines) {
				if (!line.account_key) continue;
				const current = rows.get(line.account_key) || {key: line.account_key, label: this.coaLabelByKey(line.account_key), total: 0};
				current.total += normalizeAmount(line.amount);
				rows.set(line.account_key, current);
			}
			return Array.from(rows.values());
		},
	},
	watch: {
		states: { deep: true, handler() { this.queueSaveDraft(); } },
	},
	mounted() {
		this.restoreDraft();
		this.refreshIcons();
	},
	updated() { this.refreshIcons(); },
	methods: {
		refreshIcons() { if (window.lucide) window.lucide.createIcons(); },
		coaKey(row) { return (row.account_code || '') + '||' + (row.sub_code || ''); },
		coaLabel(row) {
			const code = row.sub_code ? row.account_code + '/' + row.sub_code : row.account_code;
			const name = row.name_th || row.name_en || '';
			return name ? code + ' - ' + name : code;
		},
		coaLabelByKey(key) {
			const row = this.data.coa_rows.find((item) => this.coaKey(item) === key);
			return row ? this.coaLabel(row) : 'ยังไม่ระบุ';
		},
		formatBaht,
		statusLabel(status) { return STATUS_LABELS[status] || status; },
		pageStatus(index) {
			const state = this.states[index];
			if (state.skipped) return 'skipped';
			if (state.status === 'needs_attention') return 'needs_attention';
			return state.committed ? 'reviewed' : 'unreviewed';
		},
		pageTitle(page) {
			return [page.facts.seller, page.facts.document_no].filter(Boolean).join(' · ') || page.short_ref;
		},
		lineHint(line) {
			const parts = [];
			if (line.confidence) parts.push('confidence: ' + line.confidence);
			if (line.needs_review) parts.push('ต้องตรวจสอบ');
			if (line.reason) parts.push(line.reason);
			return parts.join(' · ');
		},
		scrollGroups(event) {
			const el = event.currentTarget;
			if (!el || el.scrollWidth <= el.clientWidth) return;
			const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
			if (!delta) return;
			const max = el.scrollWidth - el.clientWidth;
			const next = el.scrollLeft + delta;
			if ((delta < 0 && el.scrollLeft <= 0) || (delta > 0 && el.scrollLeft >= max)) return;
			event.preventDefault();
			el.scrollLeft = Math.max(0, Math.min(max, next));
		},
		selectPage(index) {
			this.currentIndex = index;
			this.resetPreview();
		},
		addLine() {
			this.currentState.lines.push({local_id: this.currentPage.ref + ':new:' + Date.now(), description: '', qty: '', unit: '', unit_price: '', amount: '', amount_includes_vat: null, vat_treatment: null, account_key: '', confidence: 'low', reason: '', needs_review: true});
		},
		removeLine(index) { this.currentState.lines.splice(index, 1); },
		toggleSkip() {
			this.currentState.skipped = !this.currentState.skipped;
		},
		saveAndNext() {
			this.currentState.committed = true;
			this.currentState.skipped = false;
			if (this.currentState.status === 'needs_attention') this.currentState.status = 'reviewed';
			this.saveDraft();
			if (this.currentIndex < this.data.pages.length - 1) this.selectPage(this.currentIndex + 1);
			else this.message = 'ตรวจครบทุกเอกสารในกลุ่มนี้แล้ว · กดส่งออก XLSX เพื่อดูตัวอย่างก่อนดาวน์โหลด';
		},
		showExportPreview() {
			const template = peakTemplateForGroup(this.data.group);
			if (!template) {
				this.exportPreview = null;
				this.message = 'ยังไม่รองรับการส่งออกสำหรับกลุ่มนี้';
				return;
			}
			const preview = this.buildExportPreview(template);
			if (!preview.committed_count) {
				this.exportPreview = null;
				this.message = 'ยังไม่มีเอกสารที่บันทึกแล้วสำหรับส่งออก';
				return;
			}
			this.exportPreview = preview;
			this.message = preview.warnings.length ? 'พบข้อมูลว่างในตัวอย่างส่งออก ตรวจสอบก่อนดาวน์โหลด XLSX' : '';
			this.saveDraft();
		},
		closeExportPreview() { this.exportPreview = null; },
		showToast(msg) {
			clearTimeout(this.toastTimer);
			this.toast = { message: msg, visible: false };
			this.$nextTick(() => {
				this.toast.visible = true;
				this.toastTimer = setTimeout(() => { this.toast.visible = false; }, 2500);
			});
		},
		buildExportPreview(template) {
			const { rows, warnings, committedCount } = template.type === 'journal'
				? this.buildJournalRows()
				: this.buildExpenseOrRevenueRows(template);

			const headers = template.type === 'journal' ? PEAK_JOURNAL_HEADERS
				: template.type === 'revenue' ? PEAK_REVENUE_HEADERS
				: PEAK_EXPENSE_HEADERS;
			const previewColumns = template.type === 'journal' ? EXPORT_PREVIEW_COLUMNS_JOURNAL
				: template.type === 'revenue' ? EXPORT_PREVIEW_COLUMNS_REVENUE
				: EXPORT_PREVIEW_COLUMNS;

			return {
				template_name: template.template_name,
				sheet_name: template.sheet_name,
				filename: template.filename,
				headers: headers,
				preview_columns: previewColumns,
				rows,
				warnings,
				committed_count: committedCount,
				uncommitted_count: this.states.length - committedCount,
			};
		},
		buildExpenseOrRevenueRows(template) {
			const rows = [];
			const warnings = [];
			let committedCount = 0;
			let sequence = 1;
			for (let index = 0; index < this.states.length; index++) {
				const state = this.states[index];
				if (!state.committed || state.skipped) continue;
				const page = this.data.pages[index];
				const title = this.pageTitle(page);
				const facts = state.facts || {};
				const docSequence = sequence++;
				const date = normalizeDateForPeak(facts.date);
				const taxId = normalizeTaxId(facts.seller_tax_id);
				const documentNo = String(facts.document_no ?? '').trim();
				const lineGroups = this.groupLinesForExport(state, page);
				committedCount++;
				if (!date) warnings.push(title + ': วันที่เอกสารว่าง');
				if (!taxId) warnings.push(title + ': เลขทะเบียนผู้ขายว่าง');
				if (!documentNo) warnings.push(title + ': เลขที่ใบกำกับฯว่าง');
				if (!lineGroups.length) warnings.push(title + ': ไม่มีรายการสำหรับส่งออก');
				for (const group of lineGroups) {
					if (!group.account_code) warnings.push(title + ': บัญชีว่าง');
					if (group.amount === '') warnings.push(title + ': จำนวนเงินว่าง');
					const vat = this.vatSettingsForLineGroup(group, state, page);
					rows.push({
						page_title: title,
						cells: [docSequence, date, '', '', taxId, '00000', documentNo, date, date, vat.price_type, group.account_code, group.description, 1, group.amount, vat.vat_rate, '', 'CSH001', group.amount, '', '', ''],
					});
				}
			}
			return { rows, warnings, committedCount };
		},
		buildJournalRows() {
			const rows = [];
			const warnings = [];
			let committedCount = 0;
			let sequence = 1;
			for (let index = 0; index < this.states.length; index++) {
				const state = this.states[index];
				if (!state.committed || state.skipped) continue;
				const page = this.data.pages[index];
				const title = this.pageTitle(page);
				const facts = state.facts || {};
				const docSequence = sequence++;
				const date = normalizeDateForPeak(facts.date);
				committedCount++;
				if (!date) warnings.push(title + ': วันที่เอกสารว่าง');
				for (const line of (state.lines || [])) {
					if (!line.account_key) {
						warnings.push(title + ': บัญชีว่างในรายการ');
						continue;
					}
					const amount = amountNumberOrNull(line.amount);
					if (amount === null) {
						warnings.push(title + ': จำนวนเงินว่างในรายการ');
						continue;
					}
					const account = splitAccountKey(line.account_key);
					const label = this.coaLabelByKey(line.account_key);
					const debit = amount > 0 ? amount : '';
					const credit = amount < 0 ? Math.abs(amount) : '';
					const description = String(line.description || '').trim();
					rows.push({
						page_title: title,
						cells: [docSequence, date, '', description, account.account_code, label, debit, credit, ''],
					});
				}
			}
			return { rows, warnings, committedCount };
		},
		groupLinesForExport(state, page) {
			const groups = new Map();
			for (let lineIndex = 0; lineIndex < (state.lines || []).length; lineIndex++) {
				const line = state.lines[lineIndex] || {};
				const source = (page.lines || [])[lineIndex] || {};
				const fallbackKey = (source.account_code || source.sub_code) ? (source.account_code || '') + '||' + (source.sub_code || '') : '';
				const rawKey = Object.prototype.hasOwnProperty.call(line, 'account_key') ? line.account_key : fallbackKey;
				const account = splitAccountKey(rawKey);
				const hasAccount = !!(account.account_code || account.sub_code);
				const lineVat = line.vat_treatment || source.vat_treatment || null;
				const groupKey = (hasAccount ? account.account_code + '||' + account.sub_code : '__blank__:' + lineIndex) + '@@' + (lineVat || 'doc');
				const current = groups.get(groupKey) || {account_key: hasAccount ? account.account_code + '||' + account.sub_code : '', account_code: account.account_code, amount: null, descriptions: [], vat_treatment: lineVat, amount_includes_vat: null};
				const amount = amountNumberOrNull(line.amount);
				if (amount !== null) current.amount = (current.amount === null ? 0 : current.amount) + amount;
				const description = String(line.description || source.description || '').trim();
				if (description && !current.descriptions.includes(description)) current.descriptions.push(description);
				const includesVat = typeof line.amount_includes_vat === 'boolean' ? line.amount_includes_vat : source.amount_includes_vat;
				if (typeof includesVat === 'boolean' && current.amount_includes_vat === null) current.amount_includes_vat = includesVat;
				groups.set(groupKey, current);
			}
			return Array.from(groups.values()).map((group) => ({
				account_code: group.account_code,
				description: group.account_key ? this.coaLabelByKey(group.account_key) : group.descriptions.join(' / '),
				amount: group.amount === null ? '' : group.amount,
				vat_treatment: group.vat_treatment,
				amount_includes_vat: group.amount_includes_vat,
			}));
		},
		amountIncludesVatForPage(state, page) {
			for (let index = 0; index < (state.lines || []).length; index++) {
				const line = state.lines[index] || {};
				const source = (page.lines || [])[index] || {};
				const value = typeof line.amount_includes_vat === 'boolean' ? line.amount_includes_vat : source.amount_includes_vat;
				if (typeof value === 'boolean') return value;
			}
			return null;
		},
		vatSettingsForLineGroup(group, state, page) {
			const treatment = group.vat_treatment || (state.facts || {}).vat_treatment;
			if (treatment === 'vat_7') {
				const includesVat = typeof group.amount_includes_vat === 'boolean' ? group.amount_includes_vat : this.amountIncludesVatForPage(state, page);
				return {price_type: includesVat === false ? '1' : '2', vat_rate: '0.07'};
			}
			return {price_type: '3', vat_rate: 'NO'};
		},
		async downloadExportXlsx() {
			if (!this.exportPreview || !this.exportPreview.rows.length) return;
			if (!window.XLSX) {
				this.message = 'โหลดตัวสร้าง XLSX ไม่สำเร็จ กรุณาเปิดหน้านี้ใหม่';
				return;
			}
			const workbook = window.XLSX.utils.book_new();
			const sheetRows = [this.exportPreview.headers].concat(this.exportPreview.rows.map((row) => row.cells));
			const sheet = window.XLSX.utils.aoa_to_sheet(sheetRows);
			window.XLSX.utils.book_append_sheet(workbook, sheet, this.exportPreview.sheet_name);
			const filename = this.exportPreview.filename;
			if (window.showSaveFilePicker) {
				try {
					const handle = await window.showSaveFilePicker({
						suggestedName: filename,
						types: [{description: 'Excel Workbook', accept: {'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']}}],
					});
					const buffer = window.XLSX.write(workbook, {type: 'array', bookType: 'xlsx'});
					const writable = await handle.createWritable();
					await writable.write(buffer);
					await writable.close();
					this.showToast('บันทึก XLSX แล้ว: ' + handle.name);
					this.closeExportPreview();
					return;
				} catch (error) {
					if (error && error.name === 'AbortError') return;
					// fall through to plain download on any other failure
				}
			}
			window.XLSX.writeFile(workbook, filename);
			this.showToast('ดาวน์โหลด XLSX แล้ว: ' + filename);
			this.closeExportPreview();
		},
		queueSaveDraft() {
			clearTimeout(this.draftTimer);
			this.draftTimer = setTimeout(() => this.saveDraft(), 300);
		},
		saveDraft() {
			try {
				localStorage.setItem(draftKey(), JSON.stringify({schema: DRAFT_SCHEMA, saved_at: new Date().toISOString(), states: this.states}));
				this.draftStatus = 'บันทึกฉบับร่างแล้ว ' + new Date().toLocaleTimeString();
			} catch (error) {
				this.draftStatus = 'บันทึกฉบับร่างไม่สำเร็จ';
			}
		},
		restoreDraft() {
			try {
				const raw = localStorage.getItem(draftKey());
				if (!raw) return;
				const draft = JSON.parse(raw);
				if (draft.schema !== DRAFT_SCHEMA || !Array.isArray(draft.states) || draft.states.length !== this.states.length) return;
				this.states = draft.states;
				this.draftStatus = 'คืนค่าฉบับร่างจากเบราว์เซอร์แล้ว';
			} catch (error) {
				this.draftStatus = 'อ่านฉบับร่างไม่สำเร็จ';
			}
		},
		zoomIn() { this.zoom = Math.min(4, Math.round((this.zoom + 0.1) * 10) / 10); },
		zoomOut() { this.zoom = Math.max(0.4, Math.round((this.zoom - 0.1) * 10) / 10); },
		resetPreview() { this.zoom = 1; this.panX = 0; this.panY = 0; },
		startPan(event) {
			if (this.previewKind !== 'image') return;
			this.dragging = true;
			this.dragStartX = event.clientX;
			this.dragStartY = event.clientY;
			this.startPanX = this.panX;
			this.startPanY = this.panY;
		},
		movePan(event) {
			if (!this.dragging) return;
			this.panX = this.startPanX + event.clientX - this.dragStartX;
			this.panY = this.startPanY + event.clientY - this.dragStartY;
		},
		endPan() { this.dragging = false; },
	},
});
app.mount('#app');
</script>
</body>
</html>`;
