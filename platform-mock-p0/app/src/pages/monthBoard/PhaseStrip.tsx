// "Where is the whole book of work bunched this งวด" — one row per Phase
// per job type, counting the projects sitting in it, with the late portion
// in red. It lives here rather than on the executive screen because it is
// a planning question ("where do I move people next week"), not a question
// about today. No percentages: a count of projects is a fact, a percentage
// across Phases of unequal size is decoration.
import type { Project } from "../../types";
import { jobTypeByKey } from "../../domain/jobTypes";
import { projectLate } from "../../domain/trail";
import { projectFinished } from "../../domain/work";

const STRIP_MIN = 5;

export function MonthPhaseStrip({ month, projects }: { month: { key: string; label: string }; projects: Project[] }) {
	const open = projects.filter((p) => !projectFinished(p));
	if (open.length === 0) return null;

	const byType: Record<string, Project[]> = {};
	open.forEach((p) => {
		if (!byType[p.jobType]) byType[p.jobType] = [];
		byType[p.jobType].push(p);
	});
	// Only the job types actually carrying the month get a phase breakdown;
	// a 5-row strip for a job type with two live projects is noise. The
	// rest are still counted, on one line, so nothing is silently dropped.
	const ordered = Object.keys(byType).sort((a, b) => byType[b].length - byType[a].length);
	const small = ordered.filter((k) => byType[k].length < STRIP_MIN);
	const groups = ordered.filter((k) => byType[k].length >= STRIP_MIN).map((key) => {
		const jt = jobTypeByKey(key)!;
		const list = byType[key];
		const max = jt.phases.reduce((m, _ph, pi) => Math.max(m, list.filter((p) => p.phaseIndex === pi).length), 1);
		return (
			<div className="phase-strip-group" key={key}>
				<div className="phase-strip-title">{jt.name} · {list.length} โปรเจกต์ที่ยังไม่ปิด</div>
				{jt.phases.map((ph, pi) => {
					const here = list.filter((p) => p.phaseIndex === pi);
					const lateN = here.filter(projectLate).length;
					return (
						<div className="phase-strip-row" key={pi}>
							<span className="phase-strip-name">{pi + 1 + ". " + ph.name}</span>
							<span className="phase-strip-bar">
								{here.length - lateN > 0 ? <span className="fill" style={{ width: ((here.length - lateN) / max) * 100 + "%" }}></span> : null}
								{lateN > 0 ? <span className="fill-late" style={{ width: (lateN / max) * 100 + "%" }}></span> : null}
							</span>
							<span className="phase-strip-n">{here.length}</span>
						</div>
					);
				})}
			</div>
		);
	});

	return (
		<div className="phase-strip">
			<div className="phase-strip-head">งานกองอยู่ที่เฟสไหน</div>
			<p className="phase-strip-sub">นับเฉพาะโปรเจกต์ที่ยังไม่ปิดใน{month.label} — แถบแดงคือส่วนที่ล่าช้า</p>
			{groups}
			{small.length ? (
				<p className="phase-strip-title" style={{ margin: 0 }}>
					{"ประเภทงานที่มีงานน้อยกว่า " + STRIP_MIN + " โปรเจกต์เดือนนี้: " +
						small.map((k) => jobTypeByKey(k)!.name + " " + byType[k].length).join(" · ")}
				</p>
			) : null}
		</div>
	);
}
