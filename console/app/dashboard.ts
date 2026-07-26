// Server-rendered dashboard (wayfinder ticket #39): promoted from Variant A
// of the dashboard prototype (ticket #32, console/_prototype_dashboard/) —
// same unified table, search + status-filter chips, never-hiding client
// headers, centered max-width + mobile card reflow — now reading real
// sequencer run-state (orchestrator.ts) instead of mock-data.ts.
//
// Per ticket #30's decision: server-rendered HTML from a hand-rolled
// template function, vanilla JS for interactivity. No client-side
// framework, no partial-render machinery — an action (start/retry) posts to
// the existing #38 routes and reloads the page; a page with any active or
// queued run polls itself every 8s so "look and instantly know" stays true
// without the operator manually refreshing.
import { STAGES, type Status } from "../sequencer/logic";
import type { RunSummary } from "./orchestrator";

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
	};
}

const STATUS_META: Record<DisplayStatus, { label: string; fg: string; bg: string; urgent?: boolean }> = {
	idle: { label: "ยังไม่ได้รัน", fg: "#57534e", bg: "#f1efec" },
	queued: { label: "รอคิว", fg: "#92400e", bg: "#fef3c7" },
	"stage-running": { label: "กำลังทำงาน", fg: "#1d4ed8", bg: "#dbeafe" },
	"gate-running": { label: "กำลังตรวจสอบ", fg: "#1d4ed8", bg: "#dbeafe" },
	blocked: { label: "ติดขัด (ลองใหม่ได้)", fg: "#b45309", bg: "#fef3c7" },
	"env-error": { label: "ข้อผิดพลาดชั่วคราว (ลองใหม่ได้)", fg: "#b45309", bg: "#fef3c7" },
	"stopped-for-human": { label: "หยุดรอมนุษย์ตัดสินใจ", fg: "#b91c1c", bg: "#fee2e2", urgent: true },
	"blocked-for-human": { label: "ติดขัด รอคนตรวจสอบ", fg: "#b91c1c", bg: "#fee2e2", urgent: true },
	done: { label: "เสร็จแล้ว", fg: "#15803d", bg: "#dcfce7" },
};

const STATUS_FILTER_ORDER: DisplayStatus[] = [
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
		return `กำลังอยู่ที่ขั้น ${m.stageLabel ? Bun.escapeHTML(m.stageLabel) : "?"}`;
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
	if (m.displayStatus === "queued") return `<button class="btn btn-ghost" disabled>รออยู่</button>`;
	if (m.displayStatus === "stage-running" || m.displayStatus === "gate-running") {
		return `<button class="btn btn-ghost" disabled>กำลังทำงาน...</button>`;
	}
	if (m.displayStatus === "blocked" || m.displayStatus === "env-error") {
		return `<button class="btn btn-attn" onclick="${onclickAttr("retryRun", clientId, m.monthId)}">🔁 ลองใหม่</button>`;
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
	if (busy || m.displayStatus === "idle") return [];

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

export function renderDashboard(clients: DashboardClient[]): string {
	const allMonths = clients.flatMap((c) => c.months);
	const attn = allMonths.filter(
		(m) => m.displayStatus === "stopped-for-human" || m.displayStatus === "blocked-for-human",
	).length;
	const hasActiveOrQueued = allMonths.some(
		(m) => m.displayStatus === "stage-running" || m.displayStatus === "gate-running" || m.displayStatus === "queued",
	);
	const statusCounts = STATUS_FILTER_ORDER.map((s) => ({
		status: s,
		count: allMonths.filter((m) => m.displayStatus === s).length,
	})).filter((s) => s.count > 0);

	const rows = clients
		.map((client) => {
			const done = client.months.filter((m) => m.displayStatus === "done").length;
			const displayName = client.companyName ?? client.clientId;
			const monthRows = client.months
				.map((m) => {
					const meta = STATUS_META[m.displayStatus];
					return `
				<tr class="run-row ${meta.urgent ? "row-attn" : ""}" data-name="${Bun.escapeHTML(displayName)}" data-code="${Bun.escapeHTML(client.clientId)}" data-status="${m.displayStatus}">
					<td class="cell-month" data-label="เดือน">${Bun.escapeHTML(m.monthId)}</td>
					<td data-label="สถานะ"><span class="pill" style="color:${meta.fg}; background:${meta.bg};">${meta.label}</span></td>
					<td class="cell-detail" data-label="รายละเอียด">${detailCell(m)}</td>
					<td class="cell-time" data-label="เวลา">${timeCell(m)}</td>
					<td class="cell-action">${actionCell(client.clientId, m)}</td>
				</tr>`;
				})
				.join("");

			return `
			<tr class="client-header" data-name="${Bun.escapeHTML(displayName)}" data-code="${Bun.escapeHTML(client.clientId)}">
				<td colspan="5">
					<span class="client-code">${Bun.escapeHTML(client.clientId)}</span>
					<span class="client-name">${Bun.escapeHTML(displayName)}</span>
					<span class="client-progress">${done}/${client.months.length} เดือนเสร็จแล้ว</span>
				</td>
			</tr>
			${monthRows}
			<tr class="no-match-row" data-code="${Bun.escapeHTML(client.clientId)}" style="display:none;">
				<td colspan="5">ไม่มีเดือนที่ตรงกับตัวกรองในบริษัทนี้</td>
			</tr>`;
		})
		.join("");

	const chips = statusCounts
		.map(({ status, count }) => {
			const meta = STATUS_META[status];
			return `<button class="chip" data-status="${status}" style="--chip-fg:${meta.fg}; --chip-bg:${meta.bg};" onclick="toggleStatus('${status}', this)">${meta.label} <span class="chip-count">${count}</span></button>`;
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
			${attn > 0 ? `<span class="summary-pill attn">⚠ ${attn} รายการต้องตรวจสอบ</span>` : ""}
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

		function applyFilters() {
			var q = document.getElementById("search").value.trim().toLowerCase();
			var visibleCountByClient = {};
			document.querySelectorAll("tr.run-row").forEach(function (row) {
				var name = row.getAttribute("data-name").toLowerCase();
				var code = row.getAttribute("data-code").toLowerCase();
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

		function closeMenus(except) {
			document.querySelectorAll(".menu-wrap.is-open").forEach(function (w) {
				if (w === except) return;
				w.classList.remove("is-open");
				var t = w.querySelector(".btn-menu");
				if (t) t.setAttribute("aria-expanded", "false");
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

		${
			hasActiveOrQueued
				? `// The 8s poll must never yank a menu — or a half-reviewed เรียนรู้
		// dialog — out from under a click, so it waits for them to be closed
		// again rather than skipping the refresh.
		setInterval(function () {
			if (document.querySelector(".menu-wrap.is-open")) return;
			if (!document.getElementById("learn-modal").hidden) return;
			location.reload();
		}, 8000);`
				: ""
		}
	</script>
</body>
</html>`;
}
