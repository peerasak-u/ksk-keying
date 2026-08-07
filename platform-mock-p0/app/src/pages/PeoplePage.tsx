// พนักงานและทีม — the office structure, and the review ladder made visible.
//
// Round 21 packs teams two across and their people three across; round 22 moved
// the person row from a <button> back to the same clickable div every other card
// in this file uses, and dropped the avatar.
import { Fragment } from "react";
import { LIVE_STRUCTURE, PROJECTS, TEAMS, USERS } from "../state/stores";
import { POSITIONS, POSITION_ORDER } from "../data/office";
import { session } from "../state/session";
import { useApp } from "../state/AppContext";
import { PlusIcon, TeamHeadIcon, UsersIcon } from "../components/Icons";
import { THIS_YEAR } from "../domain/dates";
import { allUserNames, canReview, cooName, membersOfByRung } from "../domain/people";
import { projectFinished } from "../domain/work";
import { reviewQueueUnder } from "../domain/structure";
import { personEditor, usePersonModal } from "./people/PersonModal";
import { useTeamModal } from "./people/TeamModal";

// ---- round 21: what one person is carrying, and what they have closed.
//
// Every figure is counted out of PROJECTS and the Gate records already in
// the file — nothing is invented, and deliberately nothing is a rate, a
// score or a ranking. This is a WORKLOAD reading, which is a different
// question ("who is carrying too much") from a performance one.
//
// The unit is the office's own: a งวด (one project). "ปีนี้" is the พ.ศ.
// year of the งวด's own monthKey, not a rolling window.
function personLoad(name: string, queue: Record<string, string | null>) {
	const mine = PROJECTS.filter((p) => p.assignee === name);
	return {
		open: mine.filter((p) => !projectFinished(p)).length,
		closedThisYear: mine.filter((p) => projectFinished(p) && String(p.monthKey || "").indexOf(THIS_YEAR) === 0).length,
		// Only counted for people who are actually on the review ladder.
		waiting: Object.keys(queue).filter((k) => queue[k] === name).length,
	};
}

// Labels are short because the box is small (round 22): the full sense is on
// the element's own title, and the screen's caption states what the figures
// are once, at the top, rather than on all fourteen cards.
function PersonFigure({ value, label, title, attn }: { value: number; label: string; title: string; attn?: boolean }) {
	return (
		<span className={"person-fig" + (attn ? " attn" : "") + (value ? "" : " zero")} title={title}>
			<b>{value}</b> {label}
		</span>
	);
}

function PersonCard({ name, queue, onOpen }: { name: string; queue: Record<string, string | null>; onOpen: (n: string) => void }) {
	const load = personLoad(name, queue);
	return (
		<div className={"person-card" + (personEditor.editingPersonName === name ? " selected" : "")} onClick={() => onOpen(name)}>
			<div className="person-card-name">
				{name}
				{name === session.currentUserName ? <> <span className="permission-me-tag">(คุณ)</span></> : null}
				{(USERS[name] as { added?: boolean }).added ? <> <span className="pill pill-current">ใหม่</span></> : null}
			</div>
			<div className="person-figs">
				<PersonFigure value={load.open} label="ถืออยู่" title="งวดที่ยังไม่ปิดในมือ" />
				<PersonFigure value={load.closedThisYear} label="ปิดปีนี้" title={"งวดที่ปิดแล้วในปี " + THIS_YEAR} />
				{canReview(name) ? (
					<PersonFigure value={load.waiting} label="รอเซ็น" title="เกทที่รอลายเซ็นผู้สอบทานของคนนี้" attn={load.waiting > 0} />
				) : null}
			</div>
		</div>
	);
}

export function PeoplePage() {
	const { version } = useApp();
	void version;
	const openPerson = usePersonModal();
	const openTeam = useTeamModal();
	// Computed once per render — reviewQueueUnder() walks every open project,
	// and a page listing ~20 people must not walk it twenty times.
	const queue = reviewQueueUnder(LIVE_STRUCTURE);
	const coo = cooName();
	const total = allUserNames().length;

	return (
		<>
			<div className="page-header">
				<h2>พนักงานและทีม</h2>
				<p className="page-sub">
					โครงสร้างทีมและบันไดสอบทานของสำนักงาน — ย้ายคนหรือเปลี่ยนตำแหน่งแล้วคิวสอบทาน สิทธิ์ และการจัดกลุ่มในภาพรวมสำนักงานเปลี่ยนตามทันที (มอค — รีเฟรชแล้วรีเซ็ต)
				</p>
			</div>
			<div id="people-body">
				<p className="checklist-legend" style={{ marginTop: 0 }}>
					{"พนักงาน " + total + " คน · " + TEAMS.length + " ทีม · " +
						"บันไดสอบทาน ผู้ทำ → รองหัวหน้าทีม → หัวหน้าทีม → COO (เฉพาะประเด็นสำคัญ) — ไม่ได้เก็บไว้ที่ไหน แต่คำนวณจากทีมและตำแหน่งทุกครั้ง · " +
						"ตัวเลขบนการ์ดคือปริมาณงาน ไม่ใช่คะแนน"}
				</p>
				{/* Always just buttons — what they open are dialogs over this screen,
				    so the team cards never move to make room for a form. */}
				<div className="people-toolbar">
					<button type="button" className="btn btn-ghost btn-with-icon" onClick={() => openPerson(true)}>
						<PlusIcon />
						เพิ่มพนักงานใหม่
					</button>
					<button type="button" className="btn btn-ghost btn-with-icon" onClick={openTeam}>
						<UsersIcon />
						ตั้งทีมใหม่
					</button>
				</div>
				<div className="team-grid">
					{TEAMS.map((t) => {
						const members = membersOfByRung(t.key);
						const teamLoad = members.reduce(
							(a, n) => {
								const l = personLoad(n, queue);
								a.open += l.open; a.closed += l.closedThisYear;
								return a;
							},
							{ open: 0, closed: 0 },
						);
						return (
							<div className="permissions-card team-card" key={t.key}>
								<div className="permissions-head">
									<TeamHeadIcon />
									{t.name}
								</div>
								{/* Round 22: on its own line, not squeezed into the head
								    beside a team name that can be any length. */}
								<div className="team-load">
									<span><b>{members.length}</b> คน</span>
									<span><b>{teamLoad.open}</b> ถืออยู่</span>
									<span><b>{teamLoad.closed}</b> ปิดปีนี้</span>
								</div>
								<p className="permissions-caption">
									{"บันไดสอบทาน: ผู้ทำ → " +
										(t.deputy ? t.deputy + " (รองหัวหน้าทีม) → " : "") +
										(t.lead ? t.lead + " (หัวหน้าทีม) → " : "") +
										(coo || "—") + " (COO เฉพาะประเด็นสำคัญ)"}
								</p>
								{members.length ? (
									// The rung is still the heading — that is the review
									// ladder made visible, which is the point of the screen.
									POSITION_ORDER.slice().reverse().map((rung) => {
										const here = members.filter((n) => USERS[n].position === rung);
										if (!here.length) return null;
										return (
											// A Fragment, not a wrapper div: .rung-label must stay a direct
											// child of .team-card, or `.rung-label:first-child` zeroes the
											// 11px top margin on every rung heading.
											<Fragment key={rung}>
												<p className="rung-label">{POSITIONS[rung].label}</p>
												<div className="people-grid">
													{here.map((n) => <PersonCard key={n} name={n} queue={queue} onOpen={(x) => openPerson(false, x)} />)}
												</div>
											</Fragment>
										);
									})
								) : (
									<p className="team-empty">ยังไม่มีใครอยู่ในทีมนี้ — ย้ายคนเข้ามาได้จากการ์ดของแต่ละคน</p>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</>
	);
}
