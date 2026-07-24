// PROTOTYPE — throwaway. Variant A: one unified table. Spreadsheet mental
// model — every client × month combination is a row, grouped visually under
// a client header row. Optimizes for scanning a lot of history at once.

import { CLIENTS, needsAttentionCount, STAGE_LABEL, type MonthRun, type Status } from "./mock-data";
import { STATUS_META } from "./status-meta";
import { switcherHtml } from "./switcher";

// Display order for the status filter chips — most urgent first, so the
// thing you'd scan for ("what needs me right now") is leftmost.
const STATUS_FILTER_ORDER: Status[] = [
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

function fmtDate(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear() + 543}`;
}

function detailCell(run: MonthRun): string {
	if (run.status === "done" && run.units) {
		return `${run.units.total} ชิ้น · ตรวจแล้ว ${run.units.reviewed} · ตัดออก ${run.units.excluded}`;
	}
	if (run.status === "stage-running" || run.status === "gate-running") {
		return `กำลังอยู่ที่ขั้น ${run.stage ? STAGE_LABEL[run.stage] : "?"}`;
	}
	if (run.status === "queued") {
		return `ลำดับที่ ${run.queuePosition} ในคิว`;
	}
	if (run.reason) {
		return Bun.escapeHTML(run.reason);
	}
	return "—";
}

function timeCell(run: MonthRun): string {
	if (run.status === "done") return `${fmtDate(run.finishedAt)} · ใช้เวลา ${run.durationMin} นาที`;
	if (run.status === "stage-running" || run.status === "gate-running") return "กำลังทำงานอยู่ตอนนี้";
	return "—";
}

function actionCell(run: MonthRun): string {
	if (run.status === "idle") return `<button class="btn btn-run">▶ เริ่มงาน</button>`;
	if (run.status === "done") return `<button class="btn btn-ghost">ดูรายงาน</button>`;
	if (run.status === "stopped-for-human" || run.status === "blocked-for-human")
		return `<button class="btn btn-attn">ตรวจสอบ</button>`;
	if (run.status === "queued") return `<button class="btn btn-ghost" disabled>รออยู่</button>`;
	return `<button class="btn btn-ghost">ดูสถานะ</button>`;
}

export function renderVariantA(): string {
	const attn = needsAttentionCount();
	const allRuns = CLIENTS.flatMap((c) => c.months);
	const statusCounts = STATUS_FILTER_ORDER.map((s) => ({ status: s, count: allRuns.filter((r) => r.status === s).length })).filter(
		(s) => s.count > 0,
	);

	const rows = CLIENTS.map((client) => {
		const done = client.months.filter((m) => m.status === "done").length;
		const monthRows = client.months
			.map((run) => {
				const meta = STATUS_META[run.status];
				return `
			<tr class="run-row ${meta.urgent ? "row-attn" : ""}" data-name="${Bun.escapeHTML(client.name)}" data-code="${client.code}" data-status="${run.status}">
				<td class="cell-month" data-label="เดือน">${Bun.escapeHTML(run.month)}</td>
				<td data-label="สถานะ"><span class="pill" style="color:${meta.fg}; background:${meta.bg};">${meta.label}</span></td>
				<td class="cell-detail" data-label="รายละเอียด">${detailCell(run)}</td>
				<td class="cell-time" data-label="เวลา">${timeCell(run)}</td>
				<td class="cell-action">${actionCell(run)}</td>
			</tr>`;
			})
			.join("");

		return `
		<tr class="client-header" data-name="${Bun.escapeHTML(client.name)}" data-code="${client.code}">
			<td colspan="5">
				<span class="client-code">${client.code}</span>
				<span class="client-name">${Bun.escapeHTML(client.name)}</span>
				<span class="client-progress">${done}/${client.months.length} เดือนเสร็จแล้ว</span>
			</td>
		</tr>
		${monthRows}
		<tr class="no-match-row" data-code="${client.code}" style="display:none;">
			<td colspan="5">ไม่มีเดือนที่ตรงกับตัวกรองในบริษัทนี้</td>
		</tr>`;
	}).join("");

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
<title>Just Key In — Dashboard (Variant A)</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f7f6f3; color: #292524; }
	:root { --content-max: 1100px; }
	/* Full-bleed color bars; the flex row inside each is what's actually
	   width-constrained and centered, so background/border always spans the
	   viewport even on an ultra-wide monitor while the content doesn't. */
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
	.btn { border: none; border-radius: 7px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
	.btn-run { background: #1d4ed8; color: #fff; }
	.btn-ghost { background: #f1efec; color: #57534e; }
	.btn-attn { background: #b91c1c; color: #fff; }
	.btn[disabled] { opacity: 0.5; cursor: default; }

	/* Below this width a table stops being readable — reflow each run-row
	   into a small card (label:value stacked lines) instead of squeezing
	   five columns into a phone screen. */
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
		.cell-action .btn { width: 100%; text-align: center; }

		tr.no-match-row { display: block; }
		tr.no-match-row td { padding: 8px 2px; }
	}
</style>
</head>
<body>
	<header class="topbar">
		<div class="topbar-inner">
			<h1>Just Key In</h1>
			<span class="summary-pill">${CLIENTS.length} บริษัท</span>
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
			// Client-header rows are never hidden by filtering — the company
			// name is the one thing that must stay visible no matter what's
			// filtered, per feedback on this prototype.
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
			// A client whose header matches the search but has zero visible
			// months (e.g. a status filter excludes all of them) gets a
			// placeholder row instead of just vanishing silently.
			document.querySelectorAll("tr.no-match-row").forEach(function (row) {
				var code = row.getAttribute("data-code");
				row.style.display = !visibleCountByClient[code] ? "" : "none";
			});
		}
	</script>
	${switcherHtml("A")}
</body>
</html>`;
}
