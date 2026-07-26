// The per-month review hub — the index every review surface hangs off.
//
// Chosen from prototype variant B: the hub is a WORK QUEUE, not a menu. Each
// surface is one card carrying its own weight (title, what's inside it, the
// headline count, money, warnings, progress), ordered by priority, and the
// excluded-documents gate sits above all of them.
//
// The gate is the point: until every agent-excluded page has a human decision,
// the other surfaces render visible but locked — keying a month whose
// exclusions are unconfirmed produces wrong books, so the reviewer is told
// why rather than silently allowed through. Locking is presentational (the
// detail routes still answer a typed URL); it steers the normal path.
import { BREADCRUMB_CSS, hubBreadcrumbHtml } from "./nav";
import { STATEMENT_LABEL, type BucketStat, type HubStats } from "./review-hub-stats";

export type ReviewHubPage = {
	monthId: string;
	companyName: string | null;
	clientId: string;
	stats: HubStats;
};

const LOCK_MSG = "ยังตรวจ “เอกสารที่ตัดออก” ไม่ครบ — ต้องยืนยันทุกรายการก่อน ไม่งั้นตัวเลขที่คีย์จะผิด";

const esc = (s: string) => Bun.escapeHTML(s);
const n = (v: number) => v.toLocaleString("th-TH");
const money = (v: number) => v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** One queue card. `big`/`bigUnit` is the headline count; `done`/`all` drives
 * the progress bar. A surface with nothing in it collapses to a thin row —
 * still listed (so "empty" reads as a checked fact, not an omission) but not
 * competing for attention with the ones holding real work. */
function card(opts: {
	label: string;
	sub: string;
	href: string;
	big: number;
	bigUnit: string;
	money: string;
	done: number;
	all: number;
	needsAttention: number;
	locked: boolean;
}): string {
	const cls = `card hub-card${opts.locked ? " locked" : ""}`;
	const href = opts.locked ? "#" : opts.href;
	if (opts.big === 0) {
		return `<a class="${cls} is-empty" href="${href}">
			<div class="hub-top"><div><div class="hub-t">${esc(opts.label)}</div></div><div class="hub-big"><span>ไม่มีเอกสาร</span></div></div>
		</a>`;
	}
	return `<a class="${cls}" href="${href}">
		<div class="hub-top">
			<div>
				<div class="hub-t">${esc(opts.label)}${opts.locked ? '<span class="pill lock">ล็อก</span>' : ""}</div>
				<div class="hub-s">${esc(opts.sub)}</div>
			</div>
			<div class="hub-big"><b>${n(opts.big)}</b><span>${esc(opts.bigUnit)}</span></div>
		</div>
		<div class="hub-foot">
			<span class="hub-money">${esc(opts.money)}</span>
			${opts.needsAttention ? `<span class="pill warn">ต้องดู ${n(opts.needsAttention)}</span>` : ""}
			<span class="bar"><i style="width:${pct(opts.done, opts.all)}%"></i></span>
			<span class="hub-pct">${n(opts.done)}/${n(opts.all)}</span>
		</div>
	</a>`;
}

function bucketCard(b: BucketStat, locked: boolean): string {
	const parts = [`${n(b.groups)} เอกสาร`, `${n(b.files)} ไฟล์`, `${n(b.lines)} บรรทัด`];
	if (b.skipped) parts.push(`ข้าม ${n(b.skipped)}`);
	return card({
		label: b.label,
		sub: parts.join(" · "),
		href: b.href,
		big: b.pages,
		bigUnit: "หน้า",
		money: `${money(b.total)} บาท`,
		done: b.reviewed,
		// A bucket where every page is skipped would divide by zero; the card
		// is only rendered at all when pages > 0, so clamp rather than branch.
		all: Math.max(1, b.pages - b.skipped),
		needsAttention: b.needsAttention,
		locked,
	});
}

function gateHtml(st: HubStats): string {
	const x = st.excluded;
	const chips = [
		...x.byReason.map((r) => `<span class="pill">${esc(r.label)} ${n(r.count)}</span>`),
		x.conflicts ? `<span class="pill bad">ขัดแย้งกับกลุ่มที่คีย์แล้ว ${n(x.conflicts)}</span>` : "",
		x.missingChecks ? `<span class="pill bad">reference-report-check ยังไม่รัน ${n(x.missingChecks)}</span>` : "",
	].join("");
	const desc = x.clear
		? x.hadAny
			? "ยืนยันครบทุกรายการแล้ว — หมวดอื่นปลดล็อกแล้ว"
			: "เดือนนี้ไม่มีหน้าที่ถูกข้าม"
		: `${n(x.pending)} หน้าจาก ${n(x.files)} ไฟล์ ที่ agent ตัดออกและยังไม่มีคนยืนยัน`;
	return `<a class="gate${x.clear ? " clear" : ""}" href="${x.href}">
		<div class="gate-head">
			<div class="gate-main">
				<div class="gate-flag">${x.clear ? "ผ่านด่านแล้ว" : "ต้องเคลียร์ก่อนเริ่มหมวดอื่น"}</div>
				<h2>เอกสารที่ตัดออก</h2>
				<div class="gate-desc">${esc(desc)}</div>
			</div>
			<div class="gate-num"><b>${x.clear ? "✓" : n(x.pending)}</b><span>${x.clear ? "เรียบร้อย" : "รอตรวจ"}</span></div>
		</div>
		${x.clear ? "" : `<div class="gate-chips">${chips}</div>`}
	</a>`;
}

export function renderReviewHub(page: ReviewHubPage): string {
	const st = page.stats;
	const displayName = page.companyName ?? page.clientId;
	const cards = [
		...st.buckets.map((b) => bucketCard(b, st.locked)),
		card({
			label: STATEMENT_LABEL,
			sub: `${n(st.statement.accounts)} บัญชี · เข้า ${money(st.statement.inflow)} · ออก ${money(st.statement.outflow)}`,
			href: st.statement.href,
			big: st.statement.rows,
			bigUnit: "รายการ",
			money: `สุทธิ ${money(st.statement.inflow - st.statement.outflow)} บาท`,
			done: st.statement.rows - st.statement.skipped - st.statement.needsAttention,
			all: Math.max(1, st.statement.rows - st.statement.skipped),
			needsAttention: st.statement.needsAttention,
			locked: st.locked,
		}),
	].join("");

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ตรวจทานเอกสาร — ${esc(displayName)}</title>
<style>
	* { box-sizing: border-box; }
	html { background: #f7f6f3; color-scheme: light; }
	body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f7f6f3; color: #292524; }
	header { background: #1c1917; color: #fafaf9; padding: 10px 20px 12px; }
	header h1 { font-size: 15px; margin: 4px 0 0; }
	header .sub { font-size: 11.5px; color: #a8a29e; }
	${BREADCRUMB_CSS}
	main { max-width: 720px; margin: 20px auto 40px; padding: 0 20px; display: flex; flex-direction: column; gap: 12px; }
	a { color: inherit; }
	.card { display: block; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-decoration: none; }
	.card:hover { box-shadow: 0 3px 12px rgba(0,0,0,0.13); }
	.locked { opacity: .55; }
	.locked:hover { box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
	.pill { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #f5f5f4; color: #57534e; }
	.pill.warn { background: #fef3c7; color: #92400e; }
	.pill.bad { background: #fee2e2; color: #991b1b; }
	.pill.lock { background: #e7e5e4; color: #57534e; font-weight: 600; }
	.bar { height: 5px; border-radius: 999px; background: #e7e5e4; overflow: hidden; }
	.bar > i { display: block; height: 100%; background: #0d9488; }

	.gate {
		display: block; text-decoration: none; background: #fff; border-radius: 12px; padding: 16px 18px;
		box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-left: 5px solid #b45309;
	}
	.gate:hover { box-shadow: 0 3px 12px rgba(0,0,0,0.13); }
	.gate.clear { border-left-color: #15803d; }
	.gate-head { display: flex; align-items: flex-start; gap: 14px; }
	.gate-main { flex: 1; min-width: 0; }
	.gate-flag { font-size: 11px; font-weight: 700; letter-spacing: .04em; color: #b45309; text-transform: uppercase; }
	.gate.clear .gate-flag { color: #15803d; }
	.gate-head h2 { font-size: 16px; margin: 3px 0 2px; }
	.gate-desc { font-size: 12px; color: #78716c; }
	.gate-num { text-align: right; white-space: nowrap; }
	.gate-num b { display: block; font-size: 34px; line-height: 1; font-weight: 700; color: #b45309; font-variant-numeric: tabular-nums; }
	.gate-num span { font-size: 11px; color: #78716c; }
	.gate.clear .gate-num b { color: #15803d; font-size: 22px; }
	.gate-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }

	.stack-hd { font-size: 11px; color: #78716c; margin: 12px 2px -4px; letter-spacing: .03em; }
	.stack-hd .lockflag { color: #b45309; font-weight: 700; }
	.hub-card { padding: 13px 16px; }
	.hub-top { display: flex; align-items: flex-start; gap: 16px; }
	.hub-top > div:first-child { flex: 1; min-width: 0; }
	.hub-t { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 7px; }
	.hub-s { font-size: 11.5px; color: #78716c; margin-top: 2px; }
	.hub-big { text-align: right; white-space: nowrap; }
	.hub-big b { display: block; font-size: 24px; line-height: 1.05; font-weight: 700; font-variant-numeric: tabular-nums; }
	.hub-big span { font-size: 10.5px; color: #a8a29e; }
	.hub-foot { display: flex; align-items: center; gap: 10px; margin-top: 9px; }
	.hub-foot .bar { flex: 1; }
	.hub-money { font-size: 12px; color: #44403c; font-variant-numeric: tabular-nums; }
	.hub-pct { font-size: 10.5px; color: #a8a29e; font-variant-numeric: tabular-nums; }
	.hub-card.is-empty { padding: 9px 16px; }
	.hub-card.is-empty .hub-t { font-size: 12.5px; font-weight: 500; color: #78716c; }

	.shake { animation: shake .32s; }
	@keyframes shake { 25% { transform: translateX(-5px) } 50% { transform: translateX(5px) } 75% { transform: translateX(-3px) } }
	#toast {
		position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: 560px;
		background: #7c2d12; color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 13px;
		box-shadow: 0 6px 20px rgba(0,0,0,.28); opacity: 0; pointer-events: none; transition: opacity .18s; z-index: 40;
	}
	#toast.on { opacity: 1; }
</style>
</head>
<body>
	<header>
		${hubBreadcrumbHtml()}
		<h1>ตรวจทานเอกสาร</h1>
		<div class="sub">${esc(displayName)} — ${esc(page.monthId)}</div>
	</header>
	<main>
		${gateHtml(st)}
		<div class="stack-hd">${st.locked ? '<span class="lockflag">ล็อกอยู่</span> — ' : ""}หมวดเอกสาร · ${n(st.totals.documents)} เอกสาร / ${n(st.totals.pages)} หน้า จาก ${n(st.totals.files)} ไฟล์${st.totals.needsAttention ? ` · ต้องดู ${n(st.totals.needsAttention)}` : ""}</div>
		${cards}
	</main>
	<div id="toast"></div>
<script>
// One delegated capture-phase handler: a locked card must not navigate, and
// must say WHY rather than looking broken.
var toastTimer = null;
document.addEventListener("click", function (e) {
	var lock = e.target.closest(".locked");
	if (!lock) return;
	e.preventDefault();
	var t = document.getElementById("toast");
	t.textContent = ${JSON.stringify(LOCK_MSG).replace(/</g, "\\u003c")};
	t.classList.add("on");
	lock.classList.remove("shake");
	void lock.offsetWidth;
	lock.classList.add("shake");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(function () { t.classList.remove("on"); }, 3200);
}, true);
</script>
</body>
</html>`;
}
