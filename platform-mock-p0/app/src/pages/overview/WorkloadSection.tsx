// Distribution of open work across the office, by team. The bar is
// relative to the busiest person, so the longest bar IS the one carrying
// most; the red part of it is their late work. There is no rate, no
// score and no ordering by performance — people stay in team order.
import type { ReactNode } from "react";
import type { Project } from "../../types";
import { TEAMS, USERS } from "../../state/stores";
import { ui } from "../../state/ui";
import { useApp } from "../../state/AppContext";
import { CappedList } from "../../components/CappedList";
import { ProjectCard } from "../../components/ProjectCard";
import { cooName, membersOf, positionLabel } from "../../domain/people";
import { projectLate } from "../../domain/trail";
import { awaitingGates, isAwaitingReview, projectFinished } from "../../domain/work";
import { docCustomerHasNothing, docWaitingForCustomer } from "../../domain/docs";
import { customerNote, lateNote, reviewNote } from "./notes";
import { projectRows } from "./projectRows";

export function OverviewWorkload({ scope }: { scope: Project[] }) {
	const { bump } = useApp();
	const teamsToShow = TEAMS.filter((t) => ui.overviewTeamKey === "all" || t.key === ui.overviewTeamKey);
	const everyone: string[] = [];
	teamsToShow.forEach((t) => { membersOf(t.key).forEach((n) => everyone.push(n)); });
	const stat: Record<string, { open: number; late: number; toSign: number }> = {};
	everyone.forEach((name) => {
		const openList = scope.filter((p) => p.assignee === name && !projectFinished(p));
		let toSign = 0;
		scope.forEach((p) => {
			if (projectFinished(p)) return;
			awaitingGates(p).forEach((a) => { if (a.at.name === name) toSign++; });
		});
		stat[name] = { open: openList.length, late: openList.filter(projectLate).length, toSign: toSign };
	});
	const max = everyone.reduce((m, n) => Math.max(m, stat[n].open), 1);

	function setOverviewPerson(name: string) {
		ui.overviewPerson = ui.overviewPerson === name ? null : name;
		ui.overviewOpenSection = ui.overviewPerson ? "people" : ui.overviewOpenSection;
		bump();
	}

	const body = teamsToShow.map((t) => {
		const rows = membersOf(t.key).map((name) => {
			const r = stat[name];
			const bits: ReactNode[] = [<span key="pos">{positionLabel(name)}</span>];
			if (r.late > 0) bits.push(<span className="attn" key="late">ล่าช้า {r.late}</span>);
			if (r.toSign > 0) bits.push(<span className="attn" key="sign">รอเซ็นสอบทาน {r.toSign} เกท</span>);
			return (
				<div
					key={name}
					className={"customer-row workload-row" + (ui.overviewPerson === name ? " selected" : "")}
					onClick={() => setOverviewPerson(name)}
				>
					<span className="avatar">{USERS[name].initials}</span>
					<div className="workload-main">
						<span className="customer-row-name">{name}</span>
						<div className="workload-meta">
							{bits.map((b, i) => <span key={i}>{i > 0 ? " · " : ""}{b}</span>)}
						</div>
						<div className="workload-bar">
							{r.open - r.late > 0 ? <span className="fill" style={{ width: ((r.open - r.late) / max) * 100 + "%" }}></span> : null}
							{r.late > 0 ? <span className="fill-late" style={{ width: (r.late / max) * 100 + "%" }}></span> : null}
						</div>
					</div>
					<span className={"customer-row-meta" + (r.open === 0 ? " workload-empty" : "")}>{r.open} โปรเจกต์</span>
				</div>
			);
		});
		const teamOpen = membersOf(t.key).reduce((n, name) => n + stat[name].open, 0);
		return (
			<div key={t.key}>
				<div className="sub-head">
					{t.name}
					<span className="sub-count">
						{teamOpen} โปรเจกต์ที่ยังไม่ปิด · หัวหน้า {t.lead}{t.deputy ? " · รองหัวหน้า " + t.deputy : ""}
					</span>
				</div>
				{rows}
			</div>
		);
	});

	let picked: ReactNode = null;
	if (ui.overviewPerson) {
		const who = ui.overviewPerson;
		const list = scope.filter((p) => p.assignee === who && !projectFinished(p));
		picked = (
			<>
				<div className="sub-head">
					งานที่ยังไม่ปิดของ {who}
					<span className="sub-count">{list.length} โปรเจกต์ · กดชื่อเดิมอีกครั้งเพื่อปิด</span>
				</div>
				<CappedList
					listKey={"person-" + who}
					rows={projectRows(list, (p) => (
						projectLate(p) ? lateNote(p)
							: isAwaitingReview(p) ? reviewNote(p)
							: docWaitingForCustomer(p) || docCustomerHasNothing(p) ? customerNote(p)
							: null
					))}
					emptyText={who + " ไม่มีโปรเจกต์ที่ยังไม่ปิด"}
				/>
			</>
		);
	}
	return (
		<>
			{body}
			{picked}
			<p className="ov-note" style={{ marginTop: "12px" }}>
				{"COO + CPA: " + (cooName() || "— ยังไม่ได้ตั้ง") + " — ผู้สอบทานขั้นสุดท้ายเฉพาะประเด็นสำคัญของทุกทีม"}
			</p>
		</>
	);
}

export { ProjectCard };
