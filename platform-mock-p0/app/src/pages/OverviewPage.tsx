// ================= the executive view (round 10) =================
//
// One screen, five sections (six since round 30c), in the order a manager
// actually asks them. Above them: one period switch (defaulting to now), one
// team filter, and exactly one visual — the closed/open/late meter, every band
// a button. There is no second chart, no AI layer, no score, no ranking, no
// revenue and no single progress percentage anywhere on this screen.
import { PROJECTS, TEAMS } from "../state/stores";
import { ui } from "../state/ui";
import { useApp } from "../state/AppContext";
import { MONTHS } from "../domain/projects";
import { teamOf } from "../domain/people";
import { projectLate } from "../domain/trail";
import { projectFinished } from "../domain/work";
import { OverviewSections } from "./overview/OverviewSections";
import { useSetOverviewSection } from "./overview/OvSection";

// The one scope the whole screen shares: a งวด filter and a team filter.
// "now" is not "this calendar month" — it is every งวด that is still open,
// which is the only thing a manager is ever actually asked about.
export function overviewScope() {
	return PROJECTS.filter(function (p) {
		if (ui.overviewTeamKey !== "all" && teamOf(p.assignee) !== ui.overviewTeamKey) return false;
		if (ui.overviewPeriodKey === "now") return true;
		return p.monthKey === ui.overviewPeriodKey;
	});
}

export function OverviewPage() {
	const { bump, version } = useApp();
	void version;
	const setSection = useSetOverviewSection();
	const scope = overviewScope();
	const closed = scope.filter(projectFinished).length;
	const late = scope.filter(projectLate).length;
	const open = scope.length - closed - late;

	// ---- period switch: "now" first, then the individual งวด ----
	// "ตอนนี้" first and selected by default — a manager's question is
	// almost always about open งวด whatever month they belong to.
	const periods = [{ key: "now", label: "ตอนนี้ (ทุกงวดที่ยังไม่ปิด)" }].concat(
		MONTHS.slice(-4).reverse().map((m) => ({ key: m.key, label: "งวด" + m.label })),
	);
	const teamOpts = [{ key: "all", label: "ทั้งสำนักงาน" }].concat(TEAMS.map((t) => ({ key: t.key, label: t.name })));

	// ---- the one visual on the screen ----
	const total = Math.max(1, scope.length);
	const seg = (cls: string, n: number, key: string, label: string) =>
		n === 0 ? null : (
			<button
				key={key}
				type="button"
				className={cls}
				style={{ width: (n / total) * 100 + "%" }}
				onClick={() => setSection(key)}
				title={label + " " + n + " โปรเจกต์"}
			></button>
		);
	const band = (key: string, n: number, label: string, tone: string) => (
		<button
			key={key}
			type="button"
			className={"btn btn-ghost figure " + (n === 0 ? "figure-zero" : tone) + (ui.overviewOpenSection === key ? " selected" : "")}
			onClick={() => setSection(key)}
		>
			<span className="figure-n">{n}</span>{label}
		</button>
	);

	return (
		<>
			<div className="page-header">
				<h2>ภาพรวมสำนักงาน</h2>
				<p className="page-sub">
					งานของทุกคนในสำนักงาน ณ วันพุธที่ 5 สิงหาคม 2569 — ทุกตัวเลขกดเปิดรายการจริงที่อยู่เบื้องหลังได้ และทุกแถวเปิดหน้าทำงานของโปรเจกต์นั้น
				</p>
			</div>

			<div className="filter-row">
				<span className="filter-label">งวด</span>
				{periods.map((o) => (
					<button
						key={o.key}
						type="button"
						className={"btn btn-ghost figure" + (ui.overviewPeriodKey === o.key ? " selected" : "")}
						onClick={() => { ui.overviewPeriodKey = o.key; ui.expandedLists = {}; bump(); }}
					>
						{o.label}
					</button>
				))}
			</div>

			<div className="filter-row">
				<span className="filter-label">ทีม</span>
				{teamOpts.map((o) => {
					const n = PROJECTS.filter((p) => (o.key === "all" || teamOf(p.assignee) === o.key) && !projectFinished(p)).length;
					return (
						<button
							key={o.key}
							type="button"
							className={"btn btn-ghost figure" + (ui.overviewTeamKey === o.key ? " selected" : "")}
							onClick={() => { ui.overviewTeamKey = o.key; ui.overviewPerson = null; ui.expandedLists = {}; bump(); }}
						>
							<span className="figure-n">{n}</span>{o.label}
						</button>
					);
				})}
			</div>

			<div>
				<div className="overview-meter">
					{seg("seg-closed", closed, "closed", "ปิดแล้ว")}
					{seg("seg-open", open, "open", "ยังไม่ปิด แต่ยังไม่ล่าช้า")}
					{seg("seg-late", late, "late", "ล่าช้า")}
				</div>
			</div>
			<div className="figure-row">
				{band("closed", closed, "ปิดแล้ว", "")}
				{band("open", open, "อยู่ในรอบปกติ", "")}
				{band("late", late, "ล่าช้า", "figure-late")}
			</div>

			<div>
				<OverviewSections scope={scope} />
			</div>
		</>
	);
}
