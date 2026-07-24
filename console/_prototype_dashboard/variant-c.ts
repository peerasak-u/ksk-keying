// PROTOTYPE — throwaway. Variant C: task-board mental model. A 4-lane
// Kanban board (queued / running / needs review / done) for "what's
// happening across everything", plus a search-first quick-picker up top for
// "I know which client I want, get me there fast" instead of browsing.

import { CLIENTS, STAGE_LABEL, allRuns, type Client, type MonthRun } from "./mock-data";
import { STATUS_META } from "./status-meta";
import { switcherHtml } from "./switcher";

function fmtDate(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear() + 543}`;
}

function card(client: Client, run: MonthRun): string {
	const meta = STATUS_META[run.status];
	let sub = "";
	if (run.status === "done" && run.units) sub = `${run.units.total} ชิ้น · ${run.durationMin} นาที · ${fmtDate(run.finishedAt)}`;
	else if (run.status === "stage-running" || run.status === "gate-running") sub = `ขั้น ${run.stage ? STAGE_LABEL[run.stage] : "?"}`;
	else if (run.status === "queued") sub = `ลำดับที่ ${run.queuePosition}`;
	else if (run.reason) sub = Bun.escapeHTML(run.reason);

	return `
	<div class="kcard ${meta.urgent ? "kcard-urgent" : ""} ${run.status === "stage-running" || run.status === "gate-running" ? "kcard-live" : ""}">
		<div class="kcard-top"><span class="kcode">${client.code}</span><span class="kmonth">${Bun.escapeHTML(run.month)}</span></div>
		<div class="kname">${Bun.escapeHTML(client.name)}</div>
		${sub ? `<div class="ksub">${sub}</div>` : ""}
		${meta.urgent ? `<button class="btn btn-attn">ตรวจสอบ</button>` : ""}
	</div>`;
}

function lane(title: string, count: number, cardsHtml: string, opts?: { collapsedAfter?: number; totalHidden?: number }): string {
	return `
	<div class="lane">
		<div class="lane-head"><h3>${title}</h3><span class="lane-count">${count}</span></div>
		<div class="lane-body">
			${cardsHtml || `<div class="lane-empty">ไม่มีรายการ</div>`}
			${opts?.totalHidden ? `<button class="btn btn-ghost lane-more">ดูประวัติทั้งหมด (+${opts.totalHidden})</button>` : ""}
		</div>
	</div>`;
}

export function renderVariantC(): string {
	const runs = allRuns();
	const queued = runs.filter((r) => r.run.status === "queued").sort((a, b) => (a.run.queuePosition ?? 0) - (b.run.queuePosition ?? 0));
	const running = runs.filter((r) => r.run.status === "stage-running" || r.run.status === "gate-running");
	const needsReview = runs.filter((r) => STATUS_META[r.run.status].urgent || r.run.status === "blocked" || r.run.status === "env-error");
	const doneAll = runs.filter((r) => r.run.status === "done");
	const DONE_SHOW = 5;
	const doneShown = doneAll.slice(0, DONE_SHOW);

	// Idle (not-yet-run) months per client, for the quick-picker dropdown.
	const pickerData = CLIENTS.map((c) => ({
		code: c.code,
		name: c.name,
		idleMonths: c.months.filter((m) => m.status === "idle").map((m) => m.month),
	})).filter((c) => c.idleMonths.length > 0);

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Just Key In — Dashboard (Variant C)</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #eef0f3; color: #1f2430; }
	header { background: #fff; padding: 18px 28px; border-bottom: 1px solid #e2e5ea; position: sticky; top: 0; z-index: 20; }
	header h1 { margin: 0 0 12px; font-size: 18px; }
	.picker { position: relative; max-width: 480px; }
	.picker input {
		width: 100%; padding: 10px 14px; border-radius: 10px; border: 1.5px solid #d7dbe1;
		font-size: 14px; background: #f8f9fb;
	}
	.picker input:focus { outline: none; border-color: #6366f1; background: #fff; }
	.picker-drop {
		display: none; position: absolute; top: calc(100% + 6px); left: 0; right: 0;
		background: #fff; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.14);
		max-height: 320px; overflow-y: auto; z-index: 30; border: 1px solid #e2e5ea;
	}
	.picker-drop.open { display: block; }
	.picker-row { padding: 10px 14px; border-bottom: 1px solid #f1f2f4; }
	.picker-row .pr-name { font-weight: 600; font-size: 13px; }
	.picker-row .pr-code { font-family: ui-monospace, monospace; font-size: 11px; color: #6b7280; margin-left: 6px; }
	.pr-months { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
	.pr-month-btn { border: 1px solid #c7d2fe; background: #eef2ff; color: #4338ca; border-radius: 999px; padding: 3px 10px; font-size: 11.5px; cursor: pointer; }
	main { padding: 20px 28px 80px; }
	.board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; align-items: start; }
	.lane { background: #f4f5f8; border-radius: 12px; padding: 12px; min-height: 120px; }
	.lane-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding: 0 2px; }
	.lane-head h3 { font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.04em; margin: 0; color: #4b5563; }
	.lane-count { background: #e2e5ea; color: #4b5563; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px; }
	.lane-empty { font-size: 12px; color: #9ca3af; padding: 10px 4px; }
	.kcard { background: #fff; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
	.kcard-urgent { border-left: 3px solid #ef4444; }
	.kcard-live { border-left: 3px solid #3b82f6; }
	.kcard-top { display: flex; justify-content: space-between; font-size: 11px; color: #6b7280; margin-bottom: 4px; }
	.kcode { font-family: ui-monospace, monospace; }
	.kname { font-weight: 600; font-size: 12.5px; margin-bottom: 3px; }
	.ksub { font-size: 11.5px; color: #6b7280; }
	.btn { border: none; border-radius: 7px; padding: 5px 10px; font-size: 11px; font-weight: 600; cursor: pointer; }
	.btn-attn { background: #b91c1c; color: #fff; margin-top: 6px; }
	.btn-ghost { background: #e5e7eb; color: #374151; width: 100%; margin-top: 4px; }
</style>
</head>
<body>
	<header>
		<h1>Just Key In</h1>
		<div class="picker">
			<input id="picker-input" type="text" placeholder="พิมพ์ชื่อหรือรหัสบริษัท เพื่อเริ่มงานใหม่..." oninput="filterPicker(this.value)" onfocus="filterPicker(this.value)" />
			<div class="picker-drop" id="picker-drop">
				${pickerData
					.map(
						(c) => `
					<div class="picker-row" data-name="${Bun.escapeHTML(c.name.toLowerCase())}" data-code="${c.code.toLowerCase()}">
						<span class="pr-name">${Bun.escapeHTML(c.name)}</span><span class="pr-code">${c.code}</span>
						<div class="pr-months">
							${c.idleMonths.map((m) => `<button class="pr-month-btn" onclick="queueRun('${c.code}','${Bun.escapeHTML(m)}')">+ ${Bun.escapeHTML(m)}</button>`).join("")}
						</div>
					</div>`,
					)
					.join("")}
			</div>
		</div>
	</header>
	<main>
		<div class="board">
			${lane("รอคิว", queued.length, queued.map((r) => card(r.client, r.run)).join(""))}
			${lane("กำลังทำงาน", running.length, running.map((r) => card(r.client, r.run)).join(""))}
			${lane("ต้องตรวจสอบ", needsReview.length, needsReview.map((r) => card(r.client, r.run)).join(""))}
			${lane("เสร็จแล้ว", doneAll.length, doneShown.map((r) => card(r.client, r.run)).join(""), { totalHidden: doneAll.length - doneShown.length })}
		</div>
	</main>
	<script>
		function filterPicker(q) {
			var drop = document.getElementById("picker-drop");
			q = q.trim().toLowerCase();
			var rows = drop.querySelectorAll(".picker-row");
			var anyMatch = false;
			rows.forEach(function (row) {
				var match = !q || row.getAttribute("data-name").indexOf(q) !== -1 || row.getAttribute("data-code").indexOf(q) !== -1;
				row.style.display = match ? "" : "none";
				if (match) anyMatch = true;
			});
			drop.classList.toggle("open", q.length > 0 && anyMatch);
		}
		function queueRun(code, month) {
			var lane = document.querySelector(".board .lane:first-child .lane-body");
			var el = document.createElement("div");
			el.className = "kcard kcard-live";
			el.innerHTML = "<div class=\\"kcard-top\\"><span class=\\"kcode\\">" + code + "</span><span class=\\"kmonth\\">" + month + "</span></div><div class=\\"kname\\">เพิ่มเข้าคิวแล้ว (ตัวอย่าง)</div>";
			lane.insertBefore(el, lane.firstChild);
			document.getElementById("picker-drop").classList.remove("open");
			document.getElementById("picker-input").value = "";
		}
		document.addEventListener("click", function (e) {
			if (!e.target.closest(".picker")) document.getElementById("picker-drop").classList.remove("open");
		});
	</script>
	${switcherHtml("C")}
</body>
</html>`;
}
