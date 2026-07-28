// Server-rendered dashboard (wayfinder ticket #39): promoted from Variant A
// of the dashboard prototype (ticket #32, console/_prototype_dashboard/) —
// same unified table, search + status-filter chips, never-hiding client
// headers, centered max-width + mobile card reflow — now reading real
// sequencer run-state (orchestrator.ts) instead of mock-data.ts.
//
// Per ticket #30's decision: server-rendered HTML from a hand-rolled
// template function, vanilla JS for interactivity. No client-side
// framework, no partial-render machinery.
//
// MINOR 5 (validator finding): this comment used to describe the original
// 8s whole-page self-poll, which no longer exists — corrected to describe
// what the file actually does now (wayfinder ticket #49 and follow-on
// validator rounds): every row/client-header/card is rendered server-side
// exactly once (renderMonthRow/renderClientHeader/renderNoMatchRow/
// renderRunCard) and pushed to the browser over one shared SSE stream
// (server.ts's GET /api/events, with a sequence-number guard so an
// out-of-order delivery can never paint a stale row over a newer one), plus
// a 30s JSON fallback (GET /api/clients) that reconciles the whole
// dashboard's row/header MEMBERSHIP — not just content — for a proxy that
// blocks long-lived SSE connections (reconcileDashboard, further below).
// There is no whole-page reload anywhere in this file outside the operator's
// own start/stop/retry/repair/rebuild actions (postAction/rebuildReviewData).
import { STAGES, type Status } from "../sequencer/logic";
import type { RunSummary } from "./orchestrator";
import type { StageProgress } from "./stage-progress";

export type DisplayStatus = Status | "queued";

export type DashboardMonth = {
	monthId: string;
	relPath: string;
	displayStatus: DisplayStatus;
	stageLabel: string | null;
	reasonText: string | null;
	finishedAt: string | null;
	durationMin: number | null;
	units: { total: number; reviewed: number; excluded: number } | null;
	// Ticket #2 (the active-run card): everything below already crosses the
	// wire on every RunSummary — the dashboard used to throw it away. No new
	// data source, just no longer discarding what's already there.
	stageIndex: number;
	startedAt: string | null;
	// Optional/backward-compatible on RunRecord (run-store.ts) — null for a
	// run-state.yaml written before per-stage timing existed, or before the
	// current stage's first attempt has been persisted yet. renderRunCard
	// omits the "ขั้นนี้ N นาที" clause when this is null instead of guessing.
	stageStartedAt: string | null;
	log: string[];
	// Ticket #3: a real numerator/denominator for the stages where one exists
	// (segment/interpret/group/categorize) — null for the genuinely opaque
	// ones (profile/link/final) AND for any non-active month, since
	// stage-progress.ts is never read for a run that isn't active (see
	// server.ts's buildDashboardClients). Never fabricate a bar from this
	// being null; render the elapsed-time fallback instead (see renderRunCard).
	progress: StageProgress | null;
};

export type DashboardClient = {
	clientId: string;
	companyName: string | null;
	months: DashboardMonth[];
};

export function toDisplayStatus(run: RunSummary | null): DisplayStatus {
	if (!run) return "idle"; // never run at all
	if (run.queued) return "queued";
	if (run.active) return "stage-running";
	return run.state.status;
}

function reasonText(run: RunSummary | null): string | null {
	if (!run) return null;
	if (run.state.humanStopEntries.length > 0) {
		return run.state.humanStopEntries.map((e) => `${e.condition}: ${e.reason}`).join(" | ");
	}
	const lastLog = run.state.log[run.state.log.length - 1];
	return lastLog ?? null;
}

function durationMin(run: RunSummary | null): number | null {
	if (!run || !run.finishedAt) return null;
	const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
	return Math.round(ms / 60000);
}

export function toDashboardMonth(
	monthId: string,
	relPath: string,
	run: RunSummary | null,
	units: { total: number; reviewed: number; excluded: number } | null,
	// Resolved by the caller ONLY for an active run (server.ts's
	// buildDashboardClients) — this function stays pure/synchronous and never
	// itself decides when a disk read is warranted.
	progress: StageProgress | null = null,
): DashboardMonth {
	const displayStatus = toDisplayStatus(run);
	return {
		monthId,
		relPath,
		displayStatus,
		stageLabel: run?.active ? (STAGES[run.state.stageIndex]?.label ?? null) : null,
		reasonText: reasonText(run),
		finishedAt: run?.finishedAt ?? null,
		durationMin: durationMin(run),
		units: displayStatus === "done" ? units : null,
		stageIndex: run?.state.stageIndex ?? 0,
		startedAt: run?.startedAt ?? null,
		stageStartedAt: run?.stageStartedAt ?? null,
		log: run?.state.log ?? [],
		progress: run?.active ? progress : null,
	};
}

/** The statuses the active-run card (below) renders for — a run that's
 * queued or actually mid-stage. Shared by renderRunCards (which stage) and
 * the card strip's SSE re-render, so "is this card-worthy" has one
 * definition. */
function isCardworthy(displayStatus: DisplayStatus): boolean {
	return displayStatus === "queued" || displayStatus === "stage-running" || displayStatus === "gate-running";
}

const STATUS_META: Record<DisplayStatus, { label: string; fg: string; bg: string; urgent?: boolean }> = {
	idle: { label: "ยังไม่ได้รัน", fg: "#57534e", bg: "#f1efec" },
	queued: { label: "รอคิว", fg: "#92400e", bg: "#fef3c7" },
	"stage-running": { label: "กำลังทำงาน", fg: "#1d4ed8", bg: "#dbeafe" },
	"gate-running": { label: "กำลังตรวจสอบ", fg: "#1d4ed8", bg: "#dbeafe" },
	blocked: { label: "ติดขัด (ลองใหม่ได้)", fg: "#b45309", bg: "#fef3c7" },
	"env-error": { label: "ข้อผิดพลาดชั่วคราว (ลองใหม่ได้)", fg: "#b45309", bg: "#fef3c7" },
	"fatal-cleanup": { label: "หยุดระบบเพื่อความปลอดภัย", fg: "#b91c1c", bg: "#fee2e2", urgent: true },
	stopped: { label: "หยุดโดยผู้ใช้", fg: "#57534e", bg: "#f1efec" },
	"stopped-for-human": { label: "หยุดรอมนุษย์ตัดสินใจ", fg: "#b91c1c", bg: "#fee2e2", urgent: true },
	"blocked-for-human": { label: "ติดขัด รอคนตรวจสอบ", fg: "#b91c1c", bg: "#fee2e2", urgent: true },
	done: { label: "เสร็จแล้ว", fg: "#15803d", bg: "#dcfce7" },
};

const STATUS_FILTER_ORDER: DisplayStatus[] = [
	"stopped",
	"fatal-cleanup",
	"stopped-for-human",
	"blocked-for-human",
	"env-error",
	"blocked",
	"stage-running",
	"gate-running",
	"queued",
	"idle",
	"done",
];

function fmtDate(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear() + 543}`;
}

function detailCell(m: DashboardMonth): string {
	if (m.displayStatus === "done" && m.units) {
		return `${m.units.total} ชิ้น · ตรวจแล้ว ${m.units.reviewed} · ตัดออก ${m.units.excluded}`;
	}
	if (m.displayStatus === "stage-running" || m.displayStatus === "gate-running") {
		const stage = `กำลังอยู่ที่ขั้น ${m.stageLabel ? Bun.escapeHTML(m.stageLabel) : "?"}`;
		// Ticket #3: append a real "N/M unitLabel" only where one honestly
		// exists (m.progress is null for the opaque stages AND whenever this
		// isn't an active run) — the row otherwise keeps its pre-#3 text
		// unchanged rather than inventing a fraction.
		if (!m.progress) return stage;
		return `${stage} (${m.progress.done}/${m.progress.total} ${Bun.escapeHTML(m.progress.unitLabel)})`;
	}
	if (m.displayStatus === "queued") return "รอคิวอยู่";
	if (m.reasonText) return Bun.escapeHTML(m.reasonText);
	return "—";
}

function timeCell(m: DashboardMonth): string {
	if (m.displayStatus === "done") return `${fmtDate(m.finishedAt)} · ใช้เวลา ${m.durationMin ?? "?"} นาที`;
	if (m.displayStatus === "stage-running" || m.displayStatus === "gate-running") return "กำลังทำงานอยู่ตอนนี้";
	return "—";
}

/** Embeds a JS call safely inside a double-quoted HTML `onclick` attribute:
 * JSON.stringify gives correctly-escaped JS string literals, then `"` is
 * entity-escaped so it can't prematurely close the surrounding attribute. */
function onclickAttr(fn: string, ...args: string[]): string {
	const call = `${fn}(${args.map((a) => JSON.stringify(a)).join(", ")})`;
	return call.replace(/"/g, "&quot;");
}

function reviewHref(clientId: string, monthId: string): string {
	return `/clients/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/excluded-review`;
}

/** Hub linking every review surface (excluded/skip + all 6 category/group
 * buckets, wayfinder ticket #41) for one client-month — where a "done" run
 * lands, since by then every review surface is equally relevant, not just
 * the excluded/skip flow. */
function reviewHubHref(clientId: string, monthId: string): string {
	return `/clients/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/review`;
}

function primaryAction(clientId: string, m: DashboardMonth): string {
	if (m.displayStatus === "idle") {
		return `<button class="btn btn-run" onclick="${onclickAttr("startRun", clientId, m.monthId)}">▶ เริ่มงาน</button>`;
	}
	if (m.displayStatus === "queued") {
		return `<button class="btn btn-attn" onclick="${onclickAttr("stopRun", clientId, m.monthId)}">■ ยกเลิกคิว</button>`;
	}
	if (m.displayStatus === "stage-running" || m.displayStatus === "gate-running") {
		return `<button class="btn btn-attn" onclick="${onclickAttr("stopRun", clientId, m.monthId)}">■ หยุดงาน</button>`;
	}
	if (m.displayStatus === "blocked" || m.displayStatus === "env-error") {
		return `<button class="btn btn-attn" onclick="${onclickAttr("retryRun", clientId, m.monthId)}">🔁 ลองใหม่</button>`;
	}
	if (m.displayStatus === "stopped") {
		return `<button class="btn btn-attn" onclick="${onclickAttr("repairRun", clientId, m.monthId)}">▶ เริ่มใหม่</button>`;
	}
	if (m.displayStatus === "fatal-cleanup") {
		return `<button class="btn btn-attn" onclick="${onclickAttr("repairRun", clientId, m.monthId)}" title="ก่อน restart ระบบ API จะปฏิเสธคำสั่งนี้เพื่อความปลอดภัย">♻️ เริ่มใหม่หลัง restart</button>`;
	}
	if (m.displayStatus === "stopped-for-human" || m.displayStatus === "blocked-for-human") {
		return `<a class="btn btn-attn" href="${reviewHref(clientId, m.monthId)}">ต้องตรวจสอบ</a>`;
	}
	if (m.displayStatus === "done") {
		return `<a class="btn btn-ghost" href="${reviewHubHref(clientId, m.monthId)}">ตรวจทานเอกสาร</a>`;
	}
	return `<button class="btn btn-ghost" disabled title="หน้ารายงานยังไม่มี — เร็วๆ นี้">ดูรายงาน</button>`;
}

/** The per-month "⋯" menu. Only ever holds actions that apply RIGHT NOW —
 * an action that can't run is omitted, not rendered disabled, so the menu
 * never invites a click that only produces an error toast. A month that has
 * never run has no artifacts to rebuild or repair and therefore no menu at
 * all; a busy one has no menu either, since every entry here would race the
 * running pipeline (the server rejects them anyway — this just doesn't offer
 * them). */
function menuItems(clientId: string, m: DashboardMonth): string[] {
	const busy = m.displayStatus === "queued" || m.displayStatus === "stage-running" || m.displayStatus === "gate-running";
	if (busy || m.displayStatus === "idle" || m.displayStatus === "fatal-cleanup") return [];

	const items = [
		`<a class="menu-item" href="${reviewHubHref(clientId, m.monthId)}">📋 ตรวจทานเอกสาร</a>`,
		`<a class="menu-item" href="${reviewHref(clientId, m.monthId)}">🚫 รายการที่ตัดออก</a>`,
		`<div class="menu-sep"></div>`,
		`<button class="menu-item" onclick="${onclickAttr("rebuildReviewData", clientId, m.monthId)}">🔄 สร้างข้อมูลรีวิวใหม่<span class="menu-note">ประกอบข้อมูลจากที่อ่านไว้แล้ว ไม่เรียก AI ใหม่</span></button>`,
	];
	if (m.displayStatus === "blocked" || m.displayStatus === "env-error") {
		items.push(
			`<button class="menu-item" onclick="${onclickAttr("retryRun", clientId, m.monthId)}">🔁 ลองขั้นที่ค้างใหม่</button>`,
		);
	}
	// Learning is CLIENT-scoped, not month-scoped (it reads every month's
	// changes.json), so the label says so — it is reached from a month row
	// only because that is where the menu already lives.
	items.push(
		`<div class="menu-sep"></div>`,
		`<button class="menu-item" onclick="${onclickAttr("openLearn", clientId)}">🎓 เรียนรู้จากการแก้ไข<span class="menu-note">อ่านการแก้ผังบัญชีของบริษัทนี้ทุกเดือน แล้วเสนอปรับ coa_usage.json</span></button>`,
	);
	items.push(
		`<div class="menu-sep"></div>`,
		`<button class="menu-item menu-item-danger" onclick="${onclickAttr("repairRun", clientId, m.monthId)}">♻️ รันซ่อมใหม่ทั้งเดือน<span class="menu-note">อ่านเอกสารใหม่ตั้งแต่ต้น ใช้เวลาและค่าใช้จ่ายเต็ม</span></button>`,
	);
	return items;
}

function actionCell(clientId: string, m: DashboardMonth): string {
	const items = menuItems(clientId, m);
	const menu =
		items.length === 0
			? ""
			: `<span class="menu-wrap">
				<button class="btn btn-menu" aria-haspopup="true" aria-expanded="false" title="ตัวเลือกเพิ่มเติม" onclick="toggleMenu(this)">⋯</button>
				<span class="menu" role="menu">${items.join("")}</span>
			</span>`;
	return `${primaryAction(clientId, m)}${menu}`;
}

/** The one and only renderer for a month's `<tr>` — the initial page
 * (renderDashboard, below) and the live-updates SSE stream (server.ts's
 * GET /api/events) both call this and nothing else, so a row painted by a
 * push update is byte-for-byte what a full page load would have produced.
 * No "data-name": search-by-company-name is resolved client-side from the
 * (never-swapped) client-header row instead, since this function only ever
 * sees a clientId + one month, not the company name. `data-relpath` is the
 * row's stable identity for the client to find and swap it by. */
export function renderMonthRow(clientId: string, m: DashboardMonth): string {
	const meta = STATUS_META[m.displayStatus];
	return `
				<tr class="run-row ${meta.urgent ? "row-attn" : ""}" data-code="${Bun.escapeHTML(clientId)}" data-status="${m.displayStatus}" data-relpath="${Bun.escapeHTML(m.relPath)}">
					<td class="cell-month" data-label="เดือน">${Bun.escapeHTML(m.monthId)}</td>
					<td data-label="สถานะ"><span class="pill" style="color:${meta.fg}; background:${meta.bg};">${meta.label}</span></td>
					<td class="cell-detail" data-label="รายละเอียด">${detailCell(m)}</td>
					<td class="cell-time" data-label="เวลา">${timeCell(m)}</td>
					<td class="cell-action">${actionCell(clientId, m)}</td>
				</tr>`;
}

// Circled digits for the step strip's numbering (①…) — a lookup, not a
// literal "7" anywhere, so the strip still renders sanely if STAGES ever
// grows past what a circled-digit glyph exists for (falls back to a plain
// parenthesised number).
const CIRCLED_DIGITS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];

function stepNumber(index: number): string {
	return CIRCLED_DIGITS[index] ?? `(${index + 1})`;
}

/** ①✓ ②✓ ③● ④○ … — one glyph pair per STAGES entry (never a hardcoded 7):
 * done stages get a check, the current stage a filled dot, the rest a hollow
 * one. Each stage's own label is the tooltip, since the strip itself has no
 * room for prose. */
function stepStrip(stageIndex: number): string {
	return STAGES.map((stage, i) => {
		const marker = i < stageIndex ? "✓" : i === stageIndex ? "●" : "○";
		const cls = i < stageIndex ? "step-done" : i === stageIndex ? "step-current" : "step-pending";
		return `<span class="step ${cls}" title="${Bun.escapeHTML(stage.label)}">${stepNumber(i)}${marker}</span>`;
	}).join(" ");
}

/** "ผ่านไป N นาที" always (startedAt is set the moment a run-state.yaml first
 * exists); " · ขั้นนี้ N นาที" only when stageStartedAt is present — a
 * pre-existing run-state.yaml written before that field existed, or one
 * whose current-stage transition hasn't persisted yet, simply omits the
 * clause rather than showing a fabricated number.
 *
 * This is only ever the INITIAL render: the card re-renders on an orchestrator
 * notification, which fires at stage/attempt boundaries only (minutes to an
 * hour apart per a long stage like interpret) — so a number computed here at
 * render time would freeze for the entire stage if that were the only place
 * it updated. The client-side script re-derives the identical text every 30s
 * from data-started-at/data-stage-started-at (see the inline
 * computeElapsedText()), so it stays live between pushes; this stays the
 * correct value for a page load with JS disabled.
 *
 * MINOR 4 (validator finding): exported so a test can call this directly and
 * assert it produces byte-identical output to the emitted computeElapsedText
 * across a table of inputs, rather than the two only ever being compared by
 * eye — see dashboard.test.ts's own parity test. */
export function elapsedText(m: DashboardMonth): string {
	if (!m.startedAt) return "";
	const totalMin = Math.max(0, Math.round((Date.now() - new Date(m.startedAt).getTime()) / 60000));
	let text = `ผ่านไป ${totalMin} นาที`;
	if (m.stageStartedAt) {
		const stageMin = Math.max(0, Math.round((Date.now() - new Date(m.stageStartedAt).getTime()) / 60000));
		text += ` · ขั้นนี้ ${stageMin} นาที`;
	}
	return text;
}

/** All 8 log lines (state.log's own cap — see sequencer/logic.ts's withLog),
 * not just the last one reasonText() reads — the free win ticket #2 calls
 * out: every entry already crosses the wire on every update, so this is
 * strictly "stop discarding it," not a new data source. Newest first, and
 * escaped since a log line can embed a completion-check's real stdout
 * (unreadable-source names, gate error text, etc. — see logic.ts's withLog
 * call sites), which is client-derived text, not ours to trust raw. */
function logList(log: string[]): string {
	if (log.length === 0) return "";
	const items = [...log]
		.reverse()
		.map((line) => `<li>${Bun.escapeHTML(line)}</li>`)
		.join("");
	// MINOR 6 (validator finding): this used to render a literal "▸" AND rely
	// on the browser's own native <summary> marker at the same time — two
	// triangles, one of which (the native one) rotates on open and one of
	// which (the literal glyph) doesn't, so an expanded panel showed a
	// contradictory pair. The native marker is hidden via CSS
	// (.run-card-log summary::-webkit-details-marker / list-style: none) and
	// a single ::before triangle is drawn and rotated on [open] instead — see
	// that CSS rule for the actual rotation.
	return `<details class="run-card-log"><summary>บันทึกการทำงาน (${log.length})</summary><ul>${items}</ul></details>`;
}

/** The bar+fraction block for a stage with an honest numerator/denominator
 * (ticket #3) — clamped to [0, 100] since a live count can transiently read a
 * hair past `total` (e.g. a pdftoppm temp file mid-render, see
 * stage-progress.ts's countPreparedPageFiles comment) and a >100% bar would
 * just look broken, not "more done than done". */
function progressBlock(progress: StageProgress): string {
	const pct = progress.total > 0 ? Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100))) : 0;
	return `
				<div class="run-card-bar"><div class="run-card-bar-fill" style="width:${pct}%;"></div></div>
				<div class="run-card-progress">${progress.done}/${progress.total} ${Bun.escapeHTML(progress.unitLabel)}</div>`;
}

/** One card for one active/queued client-month — always visible above the
 * table, never inline in its row (the operator's approved sketch). Ticket #2
 * kept the progress bar COARSE ("ขั้นที่ X จาก N stages"); ticket #3 replaces
 * that with a real numerator/denominator wherever stage-progress.ts can
 * honestly produce one (m.progress). For the genuinely opaque stages
 * (profile/link/final) m.progress is always null — rendering an invented bar
 * there would be worse than none, so those get NOTHING but the plain
 * "กำลังทำงาน" line; the already-live elapsed clause just below it still
 * carries "ผ่านไป N นาที". */
export function renderRunCard(clientId: string, companyName: string | null, m: DashboardMonth): string {
	const displayName = companyName ?? clientId;
	const stageLabel = STAGES[m.stageIndex]?.label ?? "?";
	return `
			<div class="run-card" data-relpath="${Bun.escapeHTML(m.relPath)}" data-started-at="${m.startedAt ? Bun.escapeHTML(m.startedAt) : ""}" data-stage-started-at="${m.stageStartedAt ? Bun.escapeHTML(m.stageStartedAt) : ""}">
				<div class="run-card-head">
					<span>${Bun.escapeHTML(clientId)} ${Bun.escapeHTML(displayName)} · เดือน ${Bun.escapeHTML(m.monthId)}</span>
				</div>
				<div class="run-card-steps">${stepStrip(m.stageIndex)}</div>
				<div class="run-card-stage">${Bun.escapeHTML(stageLabel)}</div>
				${m.progress ? progressBlock(m.progress) : `<div class="run-card-progress">กำลังทำงาน</div>`}
				<div class="run-card-time">
					<span class="run-card-elapsed">${elapsedText(m)}</span>
					<button class="btn btn-attn" onclick="${onclickAttr("stopRun", clientId, m.monthId)}">■ หยุด</button>
				</div>
				${logList(m.log)}
			</div>`;
}

/** The whole strip of active/queued cards, above the table — empty string
 * when nothing qualifies (renderDashboard and server.ts's SSE push both rely
 * on this to mean "hide the container", not "render an empty one"). */
export function renderRunCards(clients: DashboardClient[]): string {
	const cards = clients.flatMap((c) => c.months.filter((m) => isCardworthy(m.displayStatus)).map((m) => renderRunCard(c.clientId, c.companyName, m)));
	if (cards.length === 0) return "";
	return `<div class="run-cards">${cards.join("")}</div>`;
}

/** The client-header `<tr>` for one client — MAJOR 1 (validator finding):
 * exported so the browser's fallback-poll reconciliation (reconcileDashboard,
 * below) never has to construct this markup itself when a wholly new client
 * appears between polls. renderDashboard (below) calls this too, so the two
 * can never drift — same "one renderer, shared" rule as renderMonthRow. */
export function renderClientHeader(client: DashboardClient): string {
	const done = client.months.filter((m) => m.displayStatus === "done").length;
	const displayName = client.companyName ?? client.clientId;
	return `
				<tr class="client-header" data-name="${Bun.escapeHTML(displayName)}" data-code="${Bun.escapeHTML(client.clientId)}">
					<td colspan="5">
						<span class="client-code">${Bun.escapeHTML(client.clientId)}</span>
						<span class="client-name">${Bun.escapeHTML(displayName)}</span>
						<span class="client-progress" data-code="${Bun.escapeHTML(client.clientId)}">${done}/${client.months.length} เดือนเสร็จแล้ว</span>
					</td>
				</tr>`;
}

/** The "no months match the current filter" placeholder row for one client —
 * exported for the same reason as renderClientHeader (MAJOR 1): a wholly new
 * client arriving via the fallback-poll reconciliation needs this row
 * inserted fresh, same as the initial page load already does for every
 * client up front. */
export function renderNoMatchRow(clientId: string): string {
	return `
				<tr class="no-match-row" data-code="${Bun.escapeHTML(clientId)}" style="display:none;">
					<td colspan="5">ไม่มีเดือนที่ตรงกับตัวกรองในบริษัทนี้</td>
				</tr>`;
}

/** The full per-client shape GET /api/clients responds with (server.ts) — every
 * client carries its own pre-rendered headerHtml/noMatchHtml alongside each
 * month's own pre-rendered html, so reconcileDashboard (dashboard.ts's inline
 * script) can insert a brand-new row/header/no-match-row without ever
 * building markup itself (MAJOR 1's "one-renderer rule"). Pure and
 * synchronous, like toDashboardMonth — no I/O, just reshaping what the caller
 * already built via buildDashboardClients(). */
export type DashboardClientPayload = {
	clientId: string;
	companyName: string | null;
	headerHtml: string;
	noMatchHtml: string;
	months: (DashboardMonth & { html: string })[];
};

export function buildClientsPayload(clients: DashboardClient[]): DashboardClientPayload[] {
	return clients.map((client) => ({
		clientId: client.clientId,
		companyName: client.companyName,
		headerHtml: renderClientHeader(client),
		noMatchHtml: renderNoMatchRow(client.clientId),
		months: client.months.map((m) => ({ ...m, html: renderMonthRow(client.clientId, m) })),
	}));
}

export function renderDashboard(clients: DashboardClient[]): string {
	const allMonths = clients.flatMap((c) => c.months);
	const attn = allMonths.filter(
		(m) => m.displayStatus === "stopped-for-human" || m.displayStatus === "blocked-for-human",
	).length;
	// Rendered for EVERY status in STATUS_FILTER_ORDER, not just the ones with
	// a nonzero count at page load — with the reload gone, nothing else would
	// ever grow a chip bar for a status that first appears later. Zero-count
	// chips are emitted but hidden via CSS; recomputeStatusUI() flips `hidden`
	// live as counts change (see its own comment).
	const statusCounts = STATUS_FILTER_ORDER.map((s) => ({
		status: s,
		count: allMonths.filter((m) => m.displayStatus === s).length,
	}));

	const rows = clients
		.map((client) => {
			const monthRows = client.months.map((m) => renderMonthRow(client.clientId, m)).join("");
			return `${renderClientHeader(client)}
			${monthRows}
			${renderNoMatchRow(client.clientId)}`;
		})
		.join("");

	const chips = statusCounts
		.map(({ status, count }) => {
			const meta = STATUS_META[status];
			return `<button class="chip" data-status="${status}" style="--chip-fg:${meta.fg}; --chip-bg:${meta.bg};" onclick="toggleStatus('${status}', this)"${count === 0 ? " hidden" : ""}>${meta.label} <span class="chip-count">${count}</span></button>`;
		})
		.join("");

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>จัดการเอกสารลูกค้า - KSK — Dashboard</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f7f6f3; color: #292524; }
	:root { --content-max: 1100px; }
	header.topbar { background: #1c1917; color: #fafaf9; position: sticky; top: 0; z-index: 10; }
	.topbar-inner {
		max-width: var(--content-max); margin: 0 auto; display: flex; align-items: center;
		gap: 16px; padding: 16px 24px; flex-wrap: wrap;
	}
	header.topbar h1 { font-size: 18px; margin: 0; font-weight: 700; letter-spacing: 0.2px; }
	.summary-pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: #292524; }
	.summary-pill.attn { background: #b91c1c; }
	#search {
		margin-left: auto; padding: 7px 12px; border-radius: 8px; border: 1px solid #44403c;
		background: #292524; color: #fafaf9; min-width: 240px; font-size: 13px;
	}
	#search::placeholder { color: #a8a29e; }
	.filter-bar {
		background: #292524; border-bottom: 1px solid #3a3634;
		position: sticky; top: 53px; z-index: 9;
	}
	.filter-bar-inner {
		max-width: var(--content-max); margin: 0 auto; display: flex; align-items: center;
		gap: 8px; flex-wrap: wrap; padding: 10px 24px;
	}
	.filter-bar-inner .filter-label { color: #a8a29e; font-size: 12px; margin-right: 4px; }
	.chip {
		border: 1.5px solid transparent; background: #1c1917; color: #d6d3cd;
		border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600;
		cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
	}
	/* .chip's own display: inline-flex above outranks the UA default
	   [hidden] { display: none } (equal specificity, later rule), so a chip
	   whose count drops to 0 needs this explicit override to actually vanish
	   instead of showing an empty flex box. */
	.chip[hidden] { display: none; }
	.chip .chip-count { background: rgba(255,255,255,0.12); border-radius: 999px; padding: 1px 6px; font-size: 11px; }
	.chip.chip-active { background: var(--chip-bg); color: var(--chip-fg); border-color: var(--chip-fg); }
	.chip.chip-active .chip-count { background: rgba(0,0,0,0.08); }
	.chip-clear { background: transparent; color: #a8a29e; text-decoration: underline; border: none; font-size: 12px; cursor: pointer; padding: 4px 4px; }
	main { max-width: var(--content-max); margin: 0 auto; padding: 16px 24px 80px; }
	table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
	td { padding: 9px 14px; border-bottom: 1px solid #f0eee9; font-size: 13px; vertical-align: middle; }
	tr.client-header td {
		background: #ede9e3; font-weight: 600; padding-top: 10px; padding-bottom: 10px;
		border-top: 2px solid #d6d3cd;
	}
	.client-code { font-family: ui-monospace, monospace; color: #78716c; margin-right: 8px; font-size: 12px; }
	.client-name { font-size: 14px; }
	.client-progress { float: right; color: #57534e; font-weight: 500; font-size: 12px; }
	tr.run-row:hover { background: #fbfaf8; }
	tr.row-attn { background: #fef2f2; }
	tr.no-match-row td { color: #a8a29e; font-style: italic; font-size: 12px; padding: 8px 14px; }
	.cell-month { width: 110px; color: #57534e; }
	.pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
	.cell-detail { color: #44403c; }
	.cell-time { color: #78716c; font-size: 12px; white-space: nowrap; }
	.cell-action { text-align: right; white-space: nowrap; }
	.btn {
		border: none; border-radius: 7px; padding: 6px 12px; font-size: 12px; font-weight: 600;
		cursor: pointer; display: inline-block; text-decoration: none; line-height: 1.4;
	}
	.btn-run { background: #1d4ed8; color: #fff; }
	.btn-ghost { background: #f1efec; color: #57534e; }
	.btn-attn { background: #b91c1c; color: #fff; }
	.btn[disabled] { opacity: 0.5; cursor: default; }

	/* The active-run card (ticket #2) — one per active/queued run, always
	   above the table, never inline in a row. Same stone/blue/green palette
	   as STATUS_META/the topbar rather than any new colour. */
	.run-cards { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
	.run-card {
		background: #fff; border: 1px solid #ece9e4; border-radius: 10px;
		padding: 12px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
	}
	.run-card-head { font-weight: 700; font-size: 13.5px; color: #1c1917; margin-bottom: 6px; }
	.run-card-steps { font-size: 15px; letter-spacing: 2px; margin-bottom: 6px; }
	.run-card-steps .step { margin-right: 4px; }
	.run-card-steps .step-done { color: #15803d; }
	.run-card-steps .step-current { color: #1d4ed8; font-weight: 700; }
	.run-card-steps .step-pending { color: #d6d3cd; }
	.run-card-stage { font-size: 12.5px; color: #44403c; margin-bottom: 6px; }
	.run-card-bar { background: #f1efec; border-radius: 999px; height: 8px; overflow: hidden; margin-bottom: 4px; }
	.run-card-bar-fill { background: #1d4ed8; height: 100%; }
	.run-card-progress { font-size: 11.5px; color: #78716c; margin-bottom: 8px; }
	.run-card-time {
		display: flex; align-items: center; justify-content: space-between;
		gap: 10px; font-size: 12px; color: #78716c; margin-bottom: 4px;
	}
	.run-card-log { font-size: 12px; color: #57534e; margin-top: 4px; }
	/* MINOR 6: exactly one disclosure marker, not two — the native one is
	   hidden (both the WebKit pseudo-element and list-style, for Firefox's
	   own default marker) and a single ::before triangle takes its place,
	   rotating on [open] the way the native one otherwise would have. */
	.run-card-log summary {
		cursor: pointer; color: #78716c; list-style: none;
		display: flex; align-items: center; gap: 4px;
	}
	.run-card-log summary::-webkit-details-marker { display: none; }
	.run-card-log summary::before { content: "▸"; display: inline-block; transition: transform 0.1s ease; }
	.run-card-log[open] summary::before { transform: rotate(90deg); }
	.run-card-log ul { margin: 6px 0 0; padding-left: 18px; }
	.run-card-log li { margin-bottom: 3px; font-family: ui-monospace, monospace; font-size: 11.5px; word-break: break-word; }

	/* Per-month "⋯" menu. The panel is position:FIXED, not absolute: the table
	   carries overflow:hidden (so its border-radius can clip the row
	   backgrounds), which would otherwise cut the panel off at the table edge.
	   Fixed takes it out of every ancestor's clipping box, so placeMenu() below
	   sets left/top from the trigger's viewport rect instead of CSS. */
	.menu-wrap { display: inline-block; margin-left: 4px; vertical-align: middle; }
	.btn-menu { background: transparent; color: #78716c; padding: 6px 8px; font-size: 15px; line-height: 1; }
	.btn-menu:hover, .menu-wrap.is-open .btn-menu { background: #f1efec; color: #292524; }
	.menu {
		display: none; position: fixed; left: 0; top: 0; z-index: 60;
		min-width: 250px; padding: 5px; text-align: left; white-space: normal;
		background: #fff; border: 1px solid #e7e5e4; border-radius: 10px;
		box-shadow: 0 8px 24px rgba(28, 25, 23, 0.14);
	}
	.menu-wrap.is-open .menu { display: block; }
	.menu-item {
		display: block; width: 100%; box-sizing: border-box; text-align: left;
		border: none; background: none; border-radius: 7px; padding: 7px 9px;
		font: inherit; font-size: 12.5px; color: #292524; text-decoration: none; cursor: pointer;
	}
	.menu-item:hover { background: #f5f4f2; }
	.menu-item-danger { color: #b91c1c; }
	.menu-item-danger:hover { background: #fef2f2; }
	.menu-note { display: block; margin-top: 1px; font-size: 11px; color: #a8a29e; font-weight: 400; }
	.menu-item-danger .menu-note { color: #d19d9d; }
	.menu-sep { height: 1px; margin: 4px 6px; background: #f0eee9; }

	/* "เรียนรู้" review dialog (ticket #43). Kept on the dashboard as an
	   overlay rather than a route of its own: the whole interaction is one
	   confirm step, and nothing about it is worth a back-button entry. */
	.modal-backdrop {
		position: fixed; inset: 0; z-index: 80; background: rgba(28, 25, 23, 0.45);
		display: flex; align-items: center; justify-content: center; padding: 24px;
	}
	.modal-backdrop[hidden] { display: none; }
	.modal {
		background: #fff; border-radius: 12px; width: min(760px, 100%); max-height: 88vh;
		display: flex; flex-direction: column; box-shadow: 0 18px 48px rgba(28, 25, 23, 0.28);
	}
	.modal-head { padding: 16px 20px 10px; border-bottom: 1px solid #f0eee9; }
	.modal-head h2 { margin: 0; font-size: 16px; }
	.modal-head .modal-sub { color: #78716c; font-size: 12px; margin-top: 3px; }
	.modal-body { padding: 12px 20px; overflow-y: auto; }
	.modal-foot { padding: 12px 20px; border-top: 1px solid #f0eee9; display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
	.modal-foot .foot-note { margin-right: auto; color: #78716c; font-size: 12px; }
	.learn-msg { color: #57534e; font-size: 13px; margin: 8px 0; }
	.learn-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 8px; border-bottom: 1px solid #f5f4f2; }
	.learn-row input { margin-top: 3px; }
	.learn-main { flex: 1; min-width: 0; }
	.learn-title { font-weight: 600; font-size: 13px; }
	.learn-meta { color: #78716c; font-size: 12px; margin-top: 2px; }
	.learn-example { color: #a8a29e; font-size: 11.5px; margin-top: 2px; }
	.verdict { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; margin-left: 6px; }
	.verdict-accept { background: #dcfce7; color: #15803d; }
	.verdict-reject { background: #fee2e2; color: #b91c1c; }
	.verdict-unreviewed { background: #f1efec; color: #78716c; }
	.learn-notes { margin-top: 14px; padding: 10px 12px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; }
	.learn-notes h3 { margin: 0 0 6px; font-size: 13px; }
	.learn-notes li { font-size: 12.5px; margin-bottom: 4px; }

	/* "บันทึกที่ค้างอยู่" (ticket #47) — the footer of the dialog, deliberately
	   quieter than the proposal rows above: smaller type, muted border, no
	   accent background. Proposals are the main event; notes are housekeeping. */
	.learn-note-section { margin-top: 16px; padding-top: 10px; border-top: 1px dashed #e7e5e4; }
	.learn-note-heading { margin: 0 0 4px; font-size: 12.5px; color: #78716c; font-weight: 600; }
	.learn-note-empty { color: #a8a29e; font-size: 12px; margin: 4px 0; }
	.learn-note-row { display: flex; gap: 8px; align-items: flex-start; padding: 6px 4px; font-size: 12.5px; }
	.learn-note-row input { margin-top: 3px; }
	.learn-note-main { flex: 1; min-width: 0; }
	.learn-note-title { font-weight: 600; color: #44403c; }
	.learn-note-meta { color: #a8a29e; font-size: 11.5px; margin-top: 1px; }
	.learn-note-handled { margin-top: 4px; }
	.learn-note-handled summary { cursor: pointer; color: #a8a29e; font-size: 12px; padding: 4px; }

	@media (max-width: 640px) {
		.topbar-inner { padding: 12px 16px; gap: 10px; }
		header.topbar h1 { width: 100%; }
		#search { margin-left: 0; width: 100%; min-width: 0; }
		.filter-bar-inner { padding: 8px 16px; }
		main { padding: 12px 12px 80px; }

		.run-card { padding: 10px 12px; }
		.run-card-steps { letter-spacing: 1px; font-size: 13px; }
		.run-card-time { flex-wrap: wrap; }

		table { background: transparent; box-shadow: none; border-radius: 0; }
		table, tbody { display: block; width: 100%; }

		tr.client-header { display: block; }
		tr.client-header td { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
		.client-progress { float: none; }

		tr.run-row {
			display: block; background: #fff; border: 1px solid #ece9e4; border-radius: 10px;
			margin: 0 0 8px; padding: 4px 12px;
		}
		tr.run-row td {
			display: flex; justify-content: space-between; align-items: center; gap: 12px;
			padding: 7px 0; border-bottom: 1px dashed #f0eee9; width: auto; text-align: left;
		}
		tr.run-row td:last-child { border-bottom: none; }
		tr.run-row td[data-label]::before {
			content: attr(data-label); font-weight: 600; color: #a8a29e; font-size: 10.5px;
			text-transform: uppercase; letter-spacing: 0.03em; flex-shrink: 0;
		}
		.cell-action { justify-content: flex-end; }
		/* Only the primary action stretches — the "⋯" trigger keeps its own
		   width, and its panel is capped so it can't push the card sideways. */
		.cell-action > .btn { flex: 1; text-align: center; }
		.cell-action .menu-wrap { flex: none; }
		.menu { min-width: 0; width: max-content; max-width: min(280px, calc(100vw - 60px)); }

		tr.no-match-row { display: block; }
		tr.no-match-row td { padding: 8px 2px; }
	}
</style>
</head>
<body>
	<header class="topbar">
		<div class="topbar-inner">
			<h1>จัดการเอกสารลูกค้า - KSK</h1>
			<span class="summary-pill">${clients.length} บริษัท</span>
			<span id="attn-pill" class="summary-pill attn"${attn > 0 ? "" : " hidden"}>⚠ ${attn} รายการต้องตรวจสอบ</span>
			<input id="search" type="text" placeholder="ค้นหาบริษัท (ชื่อหรือรหัส)..." oninput="applyFilters()" />
		</div>
	</header>
	<div class="filter-bar">
		<div class="filter-bar-inner">
			<span class="filter-label">กรองตามสถานะ:</span>
			${chips}
			<button class="chip-clear" onclick="clearStatusFilters()">ล้างตัวกรอง</button>
		</div>
	</div>
	<main>
		<div id="run-cards-container">${renderRunCards(clients)}</div>
		<table>
			<tbody>
				${rows}
			</tbody>
		</table>
	</main>
	<div id="learn-modal" class="modal-backdrop" hidden onclick="if (event.target === this) closeLearn()">
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="learn-title">
			<div class="modal-head">
				<h2 id="learn-title">เรียนรู้จากการแก้ไข</h2>
				<div class="modal-sub" id="learn-sub"></div>
			</div>
			<div class="modal-body" id="learn-body"></div>
			<div class="modal-foot">
				<span class="foot-note" id="learn-foot-note"></span>
				<button class="btn btn-ghost" onclick="closeLearn()">ปิด</button>
				<button class="btn btn-run" id="learn-confirm" onclick="confirmLearn()" hidden>บันทึกที่เลือกไว้</button>
			</div>
		</div>
	</div>
	<script>
		var activeStatuses = new Set();

		function toggleStatus(status, el) {
			if (activeStatuses.has(status)) { activeStatuses.delete(status); el.classList.remove("chip-active"); }
			else { activeStatuses.add(status); el.classList.add("chip-active"); }
			applyFilters();
		}

		function clearStatusFilters() {
			activeStatuses.clear();
			document.querySelectorAll(".chip.chip-active").forEach(function (c) { c.classList.remove("chip-active"); });
			applyFilters();
		}

		// Month rows carry only data-code (renderMonthRow, shared with the SSE
		// push, never learns the company name — see its own comment) — the
		// company name for search comes from the client-header row instead,
		// which a swap never touches, so this map always stays correct.
		function codeToNameMap() {
			var map = {};
			document.querySelectorAll("tr.client-header").forEach(function (h) {
				map[h.getAttribute("data-code").toLowerCase()] = (h.getAttribute("data-name") || "").toLowerCase();
			});
			return map;
		}

		function applyFilters() {
			var q = document.getElementById("search").value.trim().toLowerCase();
			var names = codeToNameMap();
			var visibleCountByClient = {};
			document.querySelectorAll("tr.run-row").forEach(function (row) {
				var code = row.getAttribute("data-code").toLowerCase();
				var name = names[code] || "";
				var status = row.getAttribute("data-status");
				var matchesSearch = !q || name.indexOf(q) !== -1 || code.indexOf(q) !== -1;
				var matchesStatus = activeStatuses.size === 0 || activeStatuses.has(status);
				var visible = matchesSearch && matchesStatus;
				row.style.display = visible ? "" : "none";
				if (visible) visibleCountByClient[code] = (visibleCountByClient[code] || 0) + 1;
			});
			document.querySelectorAll("tr.no-match-row").forEach(function (row) {
				var code = row.getAttribute("data-code").toLowerCase();
				row.style.display = !visibleCountByClient[code] ? "" : "none";
			});
		}

		// Status-chip counts, the "⚠ N รายการต้องตรวจสอบ" pill, and each
		// client's "N/M เดือนเสร็จแล้ว" progress are all derived FROM THE DOM
		// every time, not tracked in a parallel counter — a row's data-status
		// attribute is the single source of truth, so none of this can drift
		// from what applyFilters() itself is looking at. Every chip in
		// STATUS_FILTER_ORDER is always present in the DOM (see renderDashboard),
		// so a status that newly appears gets its chip un-hidden here instead of
		// having no chip to filter by at all, and a status that empties out
		// hides its chip instead of leaving a stale "0" filter a click could
		// zero out every row with.
		function recomputeStatusUI() {
			var counts = {};
			document.querySelectorAll("tr.run-row").forEach(function (row) {
				var s = row.getAttribute("data-status");
				counts[s] = (counts[s] || 0) + 1;
			});
			document.querySelectorAll(".chip").forEach(function (chip) {
				var s = chip.getAttribute("data-status");
				var n = counts[s] || 0;
				var countEl = chip.querySelector(".chip-count");
				if (countEl) countEl.textContent = String(n);
				chip.hidden = n === 0;
				if (n === 0 && activeStatuses.has(s)) {
					activeStatuses.delete(s);
					chip.classList.remove("chip-active");
				}
			});
			var attn = (counts["stopped-for-human"] || 0) + (counts["blocked-for-human"] || 0);
			var pill = document.getElementById("attn-pill");
			if (pill) {
				pill.textContent = "⚠ " + attn + " รายการต้องตรวจสอบ";
				pill.hidden = attn === 0;
			}
			var doneByClient = {};
			var totalByClient = {};
			document.querySelectorAll("tr.run-row").forEach(function (row) {
				var code = row.getAttribute("data-code");
				totalByClient[code] = (totalByClient[code] || 0) + 1;
				if (row.getAttribute("data-status") === "done") doneByClient[code] = (doneByClient[code] || 0) + 1;
			});
			document.querySelectorAll(".client-progress").forEach(function (span) {
				var code = span.getAttribute("data-code");
				span.textContent = (doneByClient[code] || 0) + "/" + (totalByClient[code] || 0) + " เดือนเสร็จแล้ว";
			});
		}

		async function postAction(url, btn, busyText, failMessage, body) {
			var originalText = btn.textContent;
			btn.disabled = true;
			btn.textContent = busyText;
			try {
				var res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body || "{}" });
				if (!res.ok) {
					var errBody = await res.json().catch(function () { return {}; });
					alert(errBody.error || failMessage);
					btn.disabled = false;
					btn.textContent = originalText;
					return;
				}
				location.reload();
			} catch (err) {
				alert(failMessage);
				btn.disabled = false;
				btn.textContent = originalText;
			}
		}

		function startRun(clientId, monthId) {
			postAction(
				"/api/runs",
				event.target,
				"กำลังเริ่ม...",
				"เริ่มงานไม่สำเร็จ",
				JSON.stringify({ path: clientId + "/" + monthId }),
			);
		}

		function retryRun(clientId, monthId) {
			postAction(
				"/api/runs/" + encodeURIComponent(clientId) + "/" + encodeURIComponent(monthId) + "/retry",
				event.target,
				"กำลังลองใหม่...",
				"ลองใหม่ไม่สำเร็จ",
			);
		}

		function stopRun(clientId, monthId) {
			postAction(
				"/api/runs/" + encodeURIComponent(clientId) + "/" + encodeURIComponent(monthId) + "/stop",
				event.target,
				"กำลังหยุด...",
				"หยุดงานไม่สำเร็จ",
			);
		}

		function repairRun(clientId, monthId) {
			// Full pipeline restart from Stage 1 — real time and real money, and
			// there is no undo, so it asks first. The other menu entries don't.
			if (!confirm("รันซ่อมใหม่ทั้งเดือน " + monthId + " ?\\n\\nระบบจะอ่านเอกสารใหม่ตั้งแต่ต้นด้วย AI ใช้เวลาและค่าใช้จ่ายเต็มรอบ\\n\\nถ้าแค่อยากให้ข้อมูลรีวิวตรงกับผลล่าสุด ให้ใช้ \\"สร้างข้อมูลรีวิวใหม่\\" แทน")) return;
			postAction(
				"/api/runs/" + encodeURIComponent(clientId) + "/" + encodeURIComponent(monthId) + "/repair",
				event.target,
				"กำลังเข้าคิว...",
				"สั่งรันซ่อมไม่สำเร็จ",
			);
		}

		// Not postAction: this one has a result worth reading (how many edits
		// were carried, how many were overwritten), so it reports before it
		// reloads instead of silently refreshing.
		async function rebuildReviewData(clientId, monthId) {
			var btn = event.target.closest(".menu-item");
			var originalText = btn.innerHTML;
			btn.disabled = true;
			btn.textContent = "กำลังสร้างใหม่...";
			try {
				var res = await fetch(
					"/api/runs/" + encodeURIComponent(clientId) + "/" + encodeURIComponent(monthId) + "/rebuild-review-data",
					{ method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
				);
				var body = await res.json().catch(function () { return {}; });
				if (!res.ok) {
					alert(body.error || "สร้างข้อมูลรีวิวใหม่ไม่สำเร็จ");
					btn.disabled = false;
					btn.innerHTML = originalText;
					return;
				}
				alert(body.message || "สร้างข้อมูลรีวิวใหม่เรียบร้อย");
				location.reload();
			} catch (err) {
				alert("สร้างข้อมูลรีวิวใหม่ไม่สำเร็จ");
				btn.disabled = false;
				btn.innerHTML = originalText;
			}
		}

		// --- "เรียนรู้" (ticket #43) -------------------------------------
		// Client-scoped, three steps behind one click: the deterministic script
		// proposes, a bounded agent pass pre-ticks what looks like a real
		// pattern, and NOTHING is written until the human presses บันทึก. Every
		// bit of text below comes from client documents, so rows are built with
		// textContent — never innerHTML.
		var learnState = null;

		function mkEl(tag, className, text) {
			var node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined && text !== null) node.textContent = text;
			return node;
		}

		function accountLabel(key) {
			var parts = String(key).split("||");
			return parts[1] ? parts[0] + "-" + parts[1] : parts[0];
		}

		function learnRow(p) {
			var row = mkEl("label", "learn-row");
			var cb = mkEl("input", "learn-cb");
			cb.type = "checkbox";
			cb.checked = !!p.checked;
			cb.value = p.id;
			row.appendChild(cb);

			var main = mkEl("div", "learn-main");
			var title = mkEl("div", "learn-title", accountLabel(p.account_code + "||" + p.sub_code) + " " + p.label);
			var verdictText = p.verdict === "accept" ? "AI: ควรเรียน" : p.verdict === "reject" ? "AI: น่าจะเป็นข้อยกเว้น" : "AI: ไม่ได้ตรวจ";
			title.appendChild(mkEl("span", "verdict verdict-" + p.verdict, verdictText));
			if (!p.in_coa) title.appendChild(mkEl("span", "verdict verdict-reject", "ไม่มีรหัสนี้ใน coa.csv"));
			main.appendChild(title);

			var from = (p.from_accounts || []).map(function (f) { return accountLabel(f.account_key) + " ×" + f.count; }).join(", ");
			main.appendChild(mkEl("div", "learn-meta",
				"คนแก้มา " + p.correction_count + " ครั้ง" + (from ? " (เดิม AI เลือก " + from + ")" : "") +
				(p.is_new_hint ? " · เพิ่ม hint ใหม่" : " · เพิ่มน้ำหนัก hint เดิม")));
			if (p.reason) main.appendChild(mkEl("div", "learn-meta", "เหตุผลของ AI: " + p.reason));
			var ex = (p.examples || [])[0];
			if (ex) main.appendChild(mkEl("div", "learn-example", ex.month_id + " / " + ex.group_id + " — " + (ex.description || "(ไม่มีคำอธิบาย)")));
			row.appendChild(main);
			return row;
		}

		// Ticket #47: whether the dialog has anything at all to act on this
		// round — fresh proposals, or unhandled stored notes, or both. Mirrors
		// console/app/learn.ts's hasAnythingToConfirm exactly (same name, same
		// condition) so the two never drift: a client with pending notes and no
		// fresh corrections must still get a working confirm button, or those
		// notes could never be marked handled.
		function hasAnythingToConfirm(proposalsLength, storedNotes) {
			return proposalsLength > 0 || (storedNotes || []).some(function (n) { return !n.handled; });
		}

		function noteRow(n) {
			var row = mkEl("label", "learn-note-row");
			var cb = mkEl("input", "learn-note-cb");
			cb.type = "checkbox";
			cb.checked = n.handled;
			cb.value = n.id;
			row.appendChild(cb);
			var main = mkEl("div", "learn-note-main");
			main.appendChild(mkEl("div", "learn-note-title", n.title));
			main.appendChild(mkEl("div", "learn-note-meta", (n.date ? n.date + " — " : "") + n.detail));
			row.appendChild(main);
			return row;
		}

		// Renders REGARDLESS of hasWork — a client with pending notes and no
		// fresh corrections must still be able to open the dialog, tick notes,
		// and confirm. Ticking here is a local edit only; nothing is written
		// until confirmLearn() posts.
		function renderNotes(storedNotes) {
			var section = mkEl("div", "learn-note-section");
			section.appendChild(mkEl("h3", "learn-note-heading", "บันทึกที่ค้างอยู่"));
			var unhandled = storedNotes.filter(function (n) { return !n.handled; });
			var handled = storedNotes.filter(function (n) { return n.handled; });
			if (unhandled.length === 0 && handled.length === 0) {
				section.appendChild(mkEl("p", "learn-note-empty", "ยังไม่มีบันทึกการเรียนรู้"));
				return section;
			}
			if (unhandled.length === 0) {
				section.appendChild(mkEl("p", "learn-note-empty", "ไม่มีบันทึกที่ค้างอยู่ — ดูรายการที่จัดการแล้วด้านล่าง"));
			} else {
				unhandled.forEach(function (n) { section.appendChild(noteRow(n)); });
			}
			if (handled.length > 0) {
				var details = document.createElement("details");
				details.className = "learn-note-handled";
				var summary = document.createElement("summary");
				summary.textContent = "จัดการแล้ว (" + handled.length + ")";
				details.appendChild(summary);
				handled.forEach(function (n) { details.appendChild(noteRow(n)); });
				section.appendChild(details);
			}
			return section;
		}

		function renderLearn(data) {
			var body = document.getElementById("learn-body");
			body.textContent = "";
			body.appendChild(mkEl("p", "learn-msg", data.message || ""));
			var proposals = data.proposals || [];
			proposals.forEach(function (p) { body.appendChild(learnRow(p)); });

			var notes = data.notes || [];
			if (notes.length > 0) {
				var box = mkEl("div", "learn-notes");
				box.appendChild(mkEl("h3", null, "ข้อสังเกตที่ใหญ่กว่าการปรับ coa_usage.json"));
				var list = mkEl("ul");
				notes.forEach(function (n) { list.appendChild(mkEl("li", null, n.title + " — " + n.detail)); });
				box.appendChild(list);
				var toggleRow = mkEl("label", "learn-meta");
				var toggle = mkEl("input");
				toggle.type = "checkbox";
				toggle.id = "learn-notes-toggle";
				toggle.checked = true;
				toggleRow.appendChild(toggle);
				toggleRow.appendChild(document.createTextNode(" บันทึกข้อสังเกตนี้ไว้ใน learning-notes.md ให้คนไปอ่านต่อ"));
				box.appendChild(toggleRow);
				body.appendChild(box);
			}

			var storedNotes = data.storedNotes || [];
			body.appendChild(renderNotes(storedNotes));

			if (!hasAnythingToConfirm(proposals.length, storedNotes)) return;
			document.getElementById("learn-confirm").hidden = false;
			document.getElementById("learn-foot-note").textContent = proposals.length === 0
				? "ติ๊กข้อสังเกตที่จัดการแล้ว — ที่ยังไม่ติ๊กจะถูกส่งให้ AI อ่านตอนเริ่มงานรอบหน้า"
				: data.agentReviewed
					? "AI ช่วยติ๊กไว้ให้แล้ว — ปรับได้ตามต้องการก่อนกดบันทึก"
					: "⚠ AI ตรวจให้ไม่สำเร็จรอบนี้ — ต้องเลือกเองทั้งหมด";
		}

		async function openLearn(clientId) {
			closeMenus(null);
			learnState = null;
			document.getElementById("learn-modal").hidden = false;
			document.getElementById("learn-sub").textContent = "บริษัท " + clientId + " · อ่านการแก้ไขของทุกเดือนที่ส่งออกแล้ว";
			var confirmBtn = document.getElementById("learn-confirm");
			confirmBtn.hidden = true;
			confirmBtn.disabled = false;
			confirmBtn.textContent = "บันทึกที่เลือกไว้";
			document.getElementById("learn-foot-note").textContent = "";
			var body = document.getElementById("learn-body");
			body.textContent = "";
			body.appendChild(mkEl("p", "learn-msg", "กำลังอ่านบันทึกการแก้ไข แล้วให้ AI ช่วยคัดว่าอันไหนเป็นรูปแบบจริง — อาจใช้เวลาสักครู่..."));
			try {
				var res = await fetch("/api/learn/" + encodeURIComponent(clientId), {
					method: "POST", headers: { "content-type": "application/json" }, body: "{}",
				});
				var data = await res.json().catch(function () { return {}; });
				if (!res.ok) {
					body.textContent = "";
					body.appendChild(mkEl("p", "learn-msg", data.error || "เรียนรู้ไม่สำเร็จ"));
					return;
				}
				learnState = { clientId: clientId, sources: data.sources || [], notes: data.notes || [] };
				renderLearn(data);
			} catch (err) {
				body.textContent = "";
				body.appendChild(mkEl("p", "learn-msg", "เรียนรู้ไม่สำเร็จ (ติดต่อเซิร์ฟเวอร์ไม่ได้)"));
			}
		}

		async function confirmLearn() {
			if (!learnState) return;
			var btn = document.getElementById("learn-confirm");
			var accept = [];
			document.querySelectorAll("#learn-body .learn-cb").forEach(function (cb) { if (cb.checked) accept.push(cb.value); });
			var toggle = document.getElementById("learn-notes-toggle");
			var notes = toggle && toggle.checked ? learnState.notes : [];
			// Every ticked box in the "บันทึกที่ค้างอยู่" section — whether it
			// started unhandled (now ticked to mark handled) or started handled
			// (still ticked, so it stays handled) — becomes the authoritative
			// handled set: applyNoteHandling rewrites every note's checkbox from
			// this set, so an unticked previously-handled note reverts to pending.
			var handled = [];
			document.querySelectorAll("#learn-body .learn-note-cb").forEach(function (cb) { if (cb.checked) handled.push(cb.value); });
			btn.disabled = true;
			btn.textContent = "กำลังบันทึก...";
			try {
				var res = await fetch("/api/learn/" + encodeURIComponent(learnState.clientId) + "/apply", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ accept: accept, sources: learnState.sources, notes: notes, handled: handled }),
				});
				var data = await res.json().catch(function () { return {}; });
				if (!res.ok) {
					alert(data.error || "บันทึกการเรียนรู้ไม่สำเร็จ");
					btn.disabled = false;
					btn.textContent = "บันทึกที่เลือกไว้";
					return;
				}
				alert(data.message || "บันทึกเรียบร้อย");
				closeLearn();
			} catch (err) {
				alert("บันทึกการเรียนรู้ไม่สำเร็จ");
				btn.disabled = false;
				btn.textContent = "บันทึกที่เลือกไว้";
			}
		}

		function closeLearn() {
			document.getElementById("learn-modal").hidden = true;
			learnState = null;
		}

		// A live push that arrived while this row's "⋯" menu was open is held
		// here instead of applied immediately (a swap mid-click would destroy
		// the very button the operator is pressing) — closeMenus() below
		// flushes it the moment the menu closes.
		var pendingSwaps = {};

		// Shared by closeMenus() (menu closed by clicking elsewhere / Escape /
		// opening a different row's menu) AND toggleMenu() (menu closed by
		// clicking its OWN "⋯" button again) — the latter never reaches
		// closeMenus() for its own wrap, since closeMenus(wrap) explicitly
		// skips except and toggleMenu() calls event.stopPropagation() so the
		// document-level closeMenus(null) never fires either. Without this,
		// closing a menu that way stranded any swap deferred while it was open.
		// Only one deferral queue (pendingSwaps): both the SSE push and the 30s
		// fallback poll now deliver full row markup through swapRow, so there is
		// never a bare status patch to track separately.
		function flushPending(row) {
			var relPath = row ? row.getAttribute("data-relpath") : null;
			if (!relPath) return;
			if (pendingSwaps[relPath]) {
				var html = pendingSwaps[relPath];
				delete pendingSwaps[relPath];
				applyRowSwap(row, html);
			}
		}

		function closeMenus(except) {
			document.querySelectorAll(".menu-wrap.is-open").forEach(function (w) {
				if (w === except) return;
				w.classList.remove("is-open");
				var t = w.querySelector(".btn-menu");
				if (t) t.setAttribute("aria-expanded", "false");
				flushPending(w.closest("tr.run-row"));
			});
		}

		// The panel is fixed-positioned, so its place has to be computed against
		// the trigger's viewport rect — after it is visible, since an unrendered
		// panel measures 0. Clamped to the viewport on both axes and flipped
		// above the trigger when the last row would otherwise push it off the
		// bottom of the screen.
		function placeMenu(wrap) {
			var btn = wrap.querySelector(".btn-menu");
			var panel = wrap.querySelector(".menu");
			var r = btn.getBoundingClientRect();
			var w = panel.offsetWidth;
			var h = panel.offsetHeight;
			var left = Math.min(r.right - w, window.innerWidth - w - 8);
			var top = r.bottom + 4;
			if (top + h > window.innerHeight - 8) top = r.top - h - 4;
			panel.style.left = Math.max(8, left) + "px";
			panel.style.top = Math.max(8, top) + "px";
		}

		function toggleMenu(btn) {
			var wrap = btn.closest(".menu-wrap");
			var willOpen = !wrap.classList.contains("is-open");
			closeMenus(wrap);
			wrap.classList.toggle("is-open", willOpen);
			btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
			if (willOpen) placeMenu(wrap);
			// Closing THIS wrap's own menu never goes through closeMenus (it is
			// except there) and event.stopPropagation() below stops the
			// document-level closeMenus(null) too — flush directly or a swap
			// deferred while this menu was open is stranded.
			else flushPending(wrap.closest("tr.run-row"));
			event.stopPropagation();
		}

		// Fixed panels don't travel with the row they belong to, so follow it.
		function repositionOpenMenu() {
			var wrap = document.querySelector(".menu-wrap.is-open");
			if (wrap) placeMenu(wrap);
		}
		window.addEventListener("scroll", repositionOpenMenu, { passive: true });
		window.addEventListener("resize", repositionOpenMenu);

		// A click inside the panel keeps it open, so the pressed item can show
		// its own "กำลัง..." state instead of vanishing mid-action.
		document.addEventListener("click", function (e) {
			if (e.target.closest && e.target.closest(".menu")) return;
			closeMenus(null);
		});
		document.addEventListener("keydown", function (e) {
			if (e.key !== "Escape") return;
			closeMenus(null);
			closeLearn();
		});

		// --- Live updates over SSE (replaces the old whole-page 8s reload) ----
		// The server renders every row exactly once (renderMonthRow — shared
		// with the initial page load) and pushes that same markup here; this
		// script only ever swaps a row's outerHTML, never recomputes a status
		// label or a detail/time line itself.
		function findRunRow(relPath) {
			var rows = document.querySelectorAll("tr.run-row");
			for (var i = 0; i < rows.length; i++) {
				if (rows[i].getAttribute("data-relpath") === relPath) return rows[i];
			}
			return null;
		}

		function isMenuOpenRow(row) {
			var wrap = row.querySelector(".menu-wrap");
			return !!(wrap && wrap.classList.contains("is-open"));
		}

		// Parses ONE top-level element out of a trusted, server-rendered outerHTML
		// string — shared by every insertion/swap path below (a <tbody> wrapper
		// parses a <tr> correctly; using <div> would not, since a <tr> outside a
		// table context is dropped by the HTML parser).
		function htmlToElement(outerHtml) {
			var tmp = document.createElement("tbody");
			tmp.innerHTML = outerHtml;
			return tmp.firstElementChild;
		}

		// The content-replace half of applyRowSwap, WITHOUT the
		// recomputeStatusUI()/applyFilters() calls — MAJOR 1 (validator
		// finding): reconcileDashboard (below) swaps and inserts many rows in
		// one pass and must recompute the chip counts/filters exactly once at
		// the end, not once per row. Returns the new element (or null if the
		// markup somehow didn't parse to anything) so a caller can keep
		// tracking it (e.g. as its own "cursor" for ordering).
		function applyRowSwapQuiet(row, outerHtml) {
			var next = htmlToElement(outerHtml);
			if (!next) return null;
			row.replaceWith(next);
			return next;
		}

		function applyRowSwap(row, outerHtml) {
			applyRowSwapQuiet(row, outerHtml);
			recomputeStatusUI();
			applyFilters();
		}

		// Search box text and the status-filter chips live in plain JS vars
		// (activeStatuses, the #search value) untouched by any of this — only
		// the row DOM changes, so a swap can never wipe what the operator typed
		// or had ticked, unlike the reload this replaces.
		//
		// "seq" is optional: the SSE push and the 30s fallback both stamp a
		// server-assigned sequence number off the SAME eventSeq counter
		// (server.ts), and a message whose seq is lower than the last one
		// already applied to THIS relPath is dropped rather than painting a
		// stale row over a newer one. Correction (MAJOR 2 validator finding):
		// this comment used to claim server.ts "serialises every dashboard
		// rebuild onto one broadcastChain, so seq order === real order" and
		// that no seq-less caller exists — both were never quite true for the
		// /api/clients fallback path, which runs its own workspace scan
		// OUTSIDE broadcastChain (only the SSE broadcaster is chained). That is
		// exactly why the ordering guarantee here does NOT come from chaining:
		// server.ts's /api/clients handler snapshots eventSeq BEFORE that
		// scan starts (never after it resolves), so a broadcast that completes
		// while the scan is in flight is guaranteed a strictly higher seq and
		// correctly outranks it once both arrive here. A caller that omits seq
		// entirely (typeof seq !== "number") always applies, same as before —
		// today's one real caller of swapRow itself (the SSE onmessage handler,
		// below) always passes one; reconcileDashboard (MAJOR 1, further below)
		// mirrors this same guard directly against the /api/clients fallback
		// payload rather than calling swapRow, since it also needs to insert a
		// row swapRow would otherwise just ignore (its own no-op "not found" guard).
		var lastRowSeq = {};
		function swapRow(relPath, outerHtml, seq) {
			if (typeof seq === "number") {
				if (typeof lastRowSeq[relPath] === "number" && seq < lastRowSeq[relPath]) return;
				lastRowSeq[relPath] = seq;
			}
			var row = findRunRow(relPath);
			if (!row) return; // month not present on this page load — ignore
			if (isMenuOpenRow(row)) { pendingSwaps[relPath] = outerHtml; return; }
			// A newer update always invalidates an older deferred one — clear the
			// queue so a later menu-close can never replay stale HTML over a row
			// this direct apply just brought up to date.
			delete pendingSwaps[relPath];
			applyRowSwap(row, outerHtml);
		}

		// Reuses the SAME push a row swap rides on (server.ts's /api/events):
		// every message now also carries the server-rendered active-run card
		// strip (renderRunCards), so the card re-renders exactly like a row —
		// no client-side recomputation of steps/progress, just an innerHTML swap
		// of the one container mounted above <table>. Before replacing it,
		// remember which cards had their "บันทึกการทำงาน" <details> open (keyed
		// by data-relpath, the card's stable identity) and re-open the matching
		// ones afterward — otherwise every push snapped the log panel shut on
		// the operator, which defeats the ticket's own headline feature.
		var lastCardsSeq = 0;
		function swapCards(cardsHtml, seq) {
			if (typeof seq === "number") {
				if (seq < lastCardsSeq) return;
				lastCardsSeq = seq;
			}
			var container = document.getElementById("run-cards-container");
			if (!container) return;
			var openRelPaths = {};
			container.querySelectorAll(".run-card-log[open]").forEach(function (details) {
				var card = details.closest(".run-card");
				if (card) openRelPaths[card.getAttribute("data-relpath")] = true;
			});
			container.innerHTML = cardsHtml;
			container.querySelectorAll(".run-card").forEach(function (card) {
				if (!openRelPaths[card.getAttribute("data-relpath")]) return;
				var details = card.querySelector(".run-card-log");
				if (details) details.open = true;
			});
		}

		// Recomputes "ผ่านไป N นาที · ขั้นนี้ N นาที" client-side every 30s —
		// mirrors dashboard.ts's own elapsedText() exactly. A push only arrives
		// at stage/attempt boundaries (minutes to an hour apart for a stage like
		// interpret), so without this the card's headline elapsed time would be
		// frozen for the entire stage; this keeps it live between pushes while
		// the server-rendered text (elapsedText()) stays correct for a page load
		// with JS disabled.
		function computeElapsedText(startedAt, stageStartedAt) {
			if (!startedAt) return "";
			var totalMin = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 60000));
			var text = "ผ่านไป " + totalMin + " นาที";
			if (stageStartedAt) {
				var stageMin = Math.max(0, Math.round((Date.now() - new Date(stageStartedAt).getTime()) / 60000));
				text += " · ขั้นนี้ " + stageMin + " นาที";
			}
			return text;
		}
		function tickRunCards() {
			document.querySelectorAll(".run-card").forEach(function (card) {
				var span = card.querySelector(".run-card-elapsed");
				if (!span) return;
				span.textContent = computeElapsedText(card.getAttribute("data-started-at") || null, card.getAttribute("data-stage-started-at") || null);
			});
		}
		setInterval(tickRunCards, 30000);

		var eventSource = new EventSource("/api/events");
		eventSource.onmessage = function (ev) {
			try {
				var msg = JSON.parse(ev.data);
				if (msg && typeof msg.cardsHtml === "string") swapCards(msg.cardsHtml, msg.seq);
				if (msg && typeof msg.relPath === "string" && typeof msg.html === "string") swapRow(msg.relPath, msg.html, msg.seq);
			} catch (err) {
				// heartbeat comments never reach onmessage; a malformed payload is
				// simply dropped — the 30s fallback below still keeps status correct.
			}
		};

		// --- MAJOR 1 (validator finding): membership reconciliation, not just
		// content --------------------------------------------------------------
		// swapRow() only ever UPDATES a row that's already in the DOM
		// (its own no-op "not found" guard), and the old per-month loop here only ever
		// iterated months that already resolved to a row. A client-month that
		// appears on disk AFTER page load (a month folder syncing in from
		// Dropbox, a run started from a second tab) never showed up, and one
		// that disappears never went away — there is no other refresh
		// affordance anywhere in the UI now that the old 8s location.reload()
		// is gone, so a stale row set would sit there indefinitely. The
		// membership semantics below (which relPath/client codes need
		// inserting vs. removing) mirror app/dashboard-reconcile.ts's pure
		// diffDashboardMembership() exactly — same elapsedText()/
		// computeElapsedText() relationship as this file's own comment on that
		// pairing describes, just for membership instead of elapsed time.
		function findClientHeader(code) {
			var rows = document.querySelectorAll("tr.client-header");
			for (var i = 0; i < rows.length; i++) {
				if (rows[i].getAttribute("data-code") === code) return rows[i];
			}
			return null;
		}

		function findNoMatchRow(code) {
			var rows = document.querySelectorAll("tr.no-match-row");
			for (var i = 0; i < rows.length; i++) {
				if (rows[i].getAttribute("data-code") === code) return rows[i];
			}
			return null;
		}

		// Keeps insertion ordered so rows stay grouped under their client
		// header in the same order renderDashboard() would have produced: a
		// "cursor" tracks the last element already confirmed to be in the
		// right spot, and each subsequent header/row/no-match-row is moved (or
		// inserted) right after it. insertAdjacentElement is a no-op move when
		// the element is already exactly there, so a steady-state poll (nothing
		// changed) never touches the DOM at all.
		function ensurePosition(cursor, el, tbody) {
			var expectedNext = cursor ? cursor.nextElementSibling : tbody.firstElementChild;
			if (expectedNext !== el) {
				if (cursor) cursor.insertAdjacentElement("afterend", el);
				else tbody.insertBefore(el, tbody.firstElementChild);
			}
			return el;
		}

		// Reconciles the whole dashboard against one /api/clients payload:
		// inserts a row/header/no-match-row for anything new, removes anything
		// the payload no longer lists, and updates the content of everything
		// that's staying — all in one pass. recomputeStatusUI()/applyFilters()
		// run exactly ONCE at the end (validator finding, part (c)), not once
		// per swapped/inserted/removed row — a page with dozens of
		// client-months would otherwise recompute the same chip counts/filter
		// pass dozens of times on every single 30s tick.
		function reconcileDashboard(data) {
			var tbody = document.querySelector("tbody");
			if (!tbody) return;
			var seenRelPaths = {};
			var seenCodes = {};
			var cursor = null;

			(data.clients || []).forEach(function (client) {
				seenCodes[client.clientId] = true;

				var header = findClientHeader(client.clientId) || htmlToElement(client.headerHtml);
				cursor = ensurePosition(cursor, header, tbody);

				(client.months || []).forEach(function (m) {
					seenRelPaths[m.relPath] = true;
					var row = findRunRow(m.relPath);
					if (!row) {
						// Brand new — nothing to defer or guard against yet, just
						// insert and start tracking its seq like any other applied row.
						if (typeof data.seq === "number") lastRowSeq[m.relPath] = data.seq;
						row = htmlToElement(m.html);
					} else if (typeof data.seq === "number" && typeof lastRowSeq[m.relPath] === "number" && data.seq < lastRowSeq[m.relPath]) {
						// A stale response for a row a newer update already corrected —
						// keep the row exactly as-is, just don't touch its content.
					} else {
						// Mirrors swapRow's own seq/menu-open guard exactly, but calls
						// applyRowSwapQuiet (no per-row recompute/applyFilters — see
						// this function's own comment above) instead of swapRow itself.
						if (typeof data.seq === "number") lastRowSeq[m.relPath] = data.seq;
						if (isMenuOpenRow(row)) {
							pendingSwaps[m.relPath] = m.html;
						} else {
							delete pendingSwaps[m.relPath];
							row = applyRowSwapQuiet(row, m.html) || row;
						}
					}
					cursor = ensurePosition(cursor, row, tbody);
				});

				var noMatch = findNoMatchRow(client.clientId) || htmlToElement(client.noMatchHtml);
				cursor = ensurePosition(cursor, noMatch, tbody);
			});

			// Anything left in the DOM that the payload no longer lists is gone
			// from the workspace (or filtered out of this scan) — remove it.
			document.querySelectorAll("tr.run-row").forEach(function (row) {
				if (!seenRelPaths[row.getAttribute("data-relpath")]) row.remove();
			});
			document.querySelectorAll("tr.client-header, tr.no-match-row").forEach(function (row) {
				if (!seenCodes[row.getAttribute("data-code")]) row.remove();
			});

			recomputeStatusUI();
			applyFilters();
		}

		// Fallback for a proxy that won't let a long-lived SSE connection
		// through: every 30s, reconcile the whole dashboard against a plain
		// JSON fetch. It must NOT call location.reload() — that is exactly the
		// behavior this replaces.
		//
		// swapCards(data.cardsHtml) runs UNCONDITIONALLY on every tick, not only
		// when a row's status changed — this is the only refresh path for the
		// active-run card strip when the SSE stream itself never connects (a
		// proxy blocking text/event-stream), so without this the card would
		// render once at page load and then never update for the life of the
		// session — stale stage, stale log, a "■ หยุด" button offered for a run
		// that has since finished.
		async function pollClientsFallback() {
			try {
				var res = await fetch("/api/clients");
				if (!res.ok) return;
				var data = await res.json();
				// data.seq (validator finding): server.ts stamps this response with
				// the SAME eventSeq counter the SSE push uses, snapshotted BEFORE
				// buildDashboardClients() starts — threading it through swapCards
				// and reconcileDashboard lets their existing seq guards drop this
				// response if a newer SSE notification (e.g. a run reaching
				// done/blocked/stopped) already landed while this fetch was in
				// flight. Without it, an in-flight fallback response could repaint
				// a pre-terminal row/card on top of that newer state, and nothing
				// would ever correct it since a finished run emits no further
				// notifications.
				if (typeof data.cardsHtml === "string") swapCards(data.cardsHtml, data.seq);
				reconcileDashboard(data);
			} catch (err) {
				// network hiccup — the next tick tries again.
			}
		}
		setInterval(pollClientsFallback, 30000);
	</script>
</body>
</html>`;
}
