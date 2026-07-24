// PROTOTYPE — throwaway. Variant B: client-first browsing (cards + a
// per-client month timeline you drill into) plus a persistent sidebar rail
// that always shows what's active/queued/needing attention, regardless of
// which client you're currently looking at.

import { CLIENTS, STAGE_LABEL, type Client, type MonthRun } from "./mock-data";
import { STATUS_META } from "./status-meta";
import { switcherHtml } from "./switcher";

function fmtDate(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear() + 543}`;
}

function monthDot(run: MonthRun): string {
	const meta = STATUS_META[run.status];
	return `<span class="dot" title="${Bun.escapeHTML(run.month)} — ${meta.label}" style="background:${meta.fg};"></span>`;
}

function timelineChip(run: MonthRun): string {
	const meta = STATUS_META[run.status];
	let detail = "—";
	if (run.status === "done" && run.units) detail = `${run.units.total} ชิ้น · ${run.durationMin} นาที · ${fmtDate(run.finishedAt)}`;
	else if (run.status === "stage-running" || run.status === "gate-running") detail = `ขั้น ${run.stage ? STAGE_LABEL[run.stage] : "?"}`;
	else if (run.status === "queued") detail = `ลำดับที่ ${run.queuePosition} ในคิว`;
	else if (run.reason) detail = Bun.escapeHTML(run.reason);

	return `
	<div class="chip ${meta.urgent ? "chip-urgent" : ""}">
		<div class="chip-month">${Bun.escapeHTML(run.month)}</div>
		<div class="chip-status" style="color:${meta.fg}; background:${meta.bg};">${meta.label}</div>
		<div class="chip-detail">${detail}</div>
		${run.status === "idle" ? `<button class="btn btn-run">▶ เริ่มงาน</button>` : ""}
		${meta.urgent ? `<button class="btn btn-attn">ตรวจสอบ</button>` : ""}
	</div>`;
}

function clientCard(client: Client): string {
	const done = client.months.filter((m) => m.status === "done").length;
	const needsAttn = client.months.some((m) => STATUS_META[m.status].urgent);
	return `
	<div class="client-card ${needsAttn ? "card-attn" : ""}" onclick="toggleClient('${client.code}')">
		<div class="card-top">
			<span class="client-code">${client.code}</span>
			${needsAttn ? `<span class="attn-badge">⚠</span>` : ""}
		</div>
		<div class="client-name">${Bun.escapeHTML(client.name)}</div>
		<div class="dots">${client.months.map(monthDot).join("")}</div>
		<div class="progress-text">${done}/${client.months.length} เดือนเสร็จแล้ว</div>
	</div>
	<div class="client-timeline" id="timeline-${client.code}" style="display:none;">
		${client.months.map(timelineChip).join("")}
	</div>`;
}

function sidebarSection(title: string, items: string[], empty: string): string {
	return `
	<div class="rail-section">
		<h3>${title}</h3>
		${items.length ? items.join("") : `<div class="rail-empty">${empty}</div>`}
	</div>`;
}

export function renderVariantB(): string {
	const running = CLIENTS.flatMap((c) => c.months.filter((m) => m.status === "stage-running" || m.status === "gate-running").map((m) => ({ c, m })));
	const queued = CLIENTS.flatMap((c) => c.months.filter((m) => m.status === "queued").map((m) => ({ c, m }))).sort(
		(a, b) => (a.m.queuePosition ?? 0) - (b.m.queuePosition ?? 0),
	);
	const attention = CLIENTS.flatMap((c) => c.months.filter((m) => STATUS_META[m.status].urgent).map((m) => ({ c, m })));

	const runningHtml = running.map(
		({ c, m }) => `
		<div class="rail-item rail-running">
			<span class="pulse"></span>
			<div><b>${c.code}</b> — ${Bun.escapeHTML(m.month)}<br><span class="rail-sub">${m.stage ? STAGE_LABEL[m.stage] : ""}</span></div>
		</div>`,
	);
	const queuedHtml = queued.map(
		({ c, m }) => `
		<div class="rail-item">
			<span class="queue-num">${m.queuePosition}</span>
			<div><b>${c.code}</b> — ${Bun.escapeHTML(m.month)}</div>
		</div>`,
	);
	const attentionHtml = attention.map(
		({ c, m }) => `
		<div class="rail-item rail-attn">
			<span>⚠</span>
			<div><b>${c.code}</b> — ${Bun.escapeHTML(m.month)}<br><span class="rail-sub">${STATUS_META[m.status].label}</span></div>
		</div>`,
	);

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Just Key In — Dashboard (Variant B)</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f4f5f7; color: #1f2430; display: flex; }
	.rail { width: 260px; min-height: 100vh; background: #191d27; color: #e5e7eb; padding: 20px 16px; position: sticky; top: 0; align-self: flex-start; }
	.rail h2 { font-size: 15px; margin: 0 0 16px; }
	.rail-section { margin-bottom: 22px; }
	.rail-section h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #9ca3af; margin: 0 0 8px; }
	.rail-item { display: flex; gap: 8px; align-items: flex-start; padding: 8px; border-radius: 8px; font-size: 12.5px; margin-bottom: 6px; background: #232838; }
	.rail-item b { font-family: ui-monospace, monospace; }
	.rail-sub { color: #9ca3af; font-size: 11px; }
	.rail-running { border-left: 3px solid #60a5fa; }
	.rail-attn { border-left: 3px solid #f87171; background: #2e2020; }
	.rail-empty { font-size: 12px; color: #6b7280; padding: 4px 0; }
	.pulse { width: 8px; height: 8px; border-radius: 50%; background: #60a5fa; margin-top: 4px; flex-shrink: 0; animation: pulse 1.4s infinite; }
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
	.queue-num { width: 18px; height: 18px; border-radius: 50%; background: #4b5563; color: #fff; font-size: 10px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
	main { flex: 1; padding: 24px 28px 80px; }
	main h1 { font-size: 18px; margin: 0 0 18px; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
	.client-card { background: #fff; border-radius: 12px; padding: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); cursor: pointer; border: 1px solid transparent; }
	.client-card:hover { border-color: #c7d2fe; }
	.card-attn { border-left: 4px solid #ef4444; }
	.card-top { display: flex; justify-content: space-between; align-items: center; }
	.client-code { font-family: ui-monospace, monospace; font-size: 11px; color: #6b7280; background: #f1f5f9; padding: 2px 6px; border-radius: 6px; }
	.attn-badge { color: #ef4444; }
	.client-name { font-weight: 600; font-size: 13.5px; margin: 8px 0 10px; min-height: 34px; }
	.dots { display: flex; gap: 4px; margin-bottom: 8px; }
	.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
	.progress-text { font-size: 11.5px; color: #6b7280; }
	.client-timeline { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 10px; background: #eef0f4; border-radius: 12px; padding: 14px; margin: -4px 0 4px; }
	.chip { background: #fff; border-radius: 10px; padding: 10px 12px; min-width: 160px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
	.chip-urgent { border: 1px solid #fecaca; }
	.chip-month { font-weight: 600; font-size: 12.5px; margin-bottom: 4px; }
	.chip-status { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; margin-bottom: 6px; }
	.chip-detail { font-size: 11.5px; color: #57534e; margin-bottom: 6px; }
	.btn { border: none; border-radius: 7px; padding: 5px 10px; font-size: 11.5px; font-weight: 600; cursor: pointer; margin-right: 4px; }
	.btn-run { background: #1d4ed8; color: #fff; }
	.btn-attn { background: #b91c1c; color: #fff; }
</style>
</head>
<body>
	<aside class="rail">
		<h2>Just Key In</h2>
		${sidebarSection("ต้องตรวจสอบด่วน", attentionHtml, "ไม่มีรายการ")}
		${sidebarSection("กำลังทำงานตอนนี้", runningHtml, "ไม่มีงานกำลังรัน")}
		${sidebarSection("รอคิว", queuedHtml, "ไม่มีงานรอคิว")}
	</aside>
	<main>
		<h1>บริษัททั้งหมด (${CLIENTS.length})</h1>
		<div class="grid">
			${CLIENTS.map(clientCard).join("")}
		</div>
	</main>
	<script>
		function toggleClient(code) {
			var el = document.getElementById("timeline-" + code);
			el.style.display = el.style.display === "none" ? "flex" : "none";
		}
	</script>
	${switcherHtml("B")}
</body>
</html>`;
}
