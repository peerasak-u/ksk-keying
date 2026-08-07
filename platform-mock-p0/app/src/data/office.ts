import type { Team, Position, PositionKey } from "../types";

// ---- round 10: the office's real structure replaces the flat role list.
//
// Three teams, each with a หัวหน้า and (except the consult/project team) a
// รองหัวหน้า, พนักงาน and นศ.ฝึกงาน under them, plus one named COO+CPA as
// the office's final reviewer. Teams and people are the client's own —
// taken from their KSK AI Monitoring demo, not invented here.
//
// The old flat `ROLES` catalog is gone rather than kept alongside this:
// a person's position IN A TEAM is now the only thing that decides what
// they may do, so there is one model, not two. The three capabilities the
// previous rounds established (canReview / canSeeOffice /
// canEditPermissions) survive unchanged — they just hang off the position
// instead of a standalone role.
//
// One consequence worth naming: พนักงาน can no longer sign ผู้สอบทาน.
// That is not a tightening for its own sake — the office's own review
// chain is doer → รองหัวหน้าทีม → หัวหน้าทีม → COO, and พนักงาน/นศ.ฝึกงาน
// are not on it. There is no separate "ผู้ดูแลระบบ" person either: the
// COO+CPA owns the ประเภทงาน templates, because that is the office's own
// process, not an IT function.
export const TEAM_SEED: Team[] = [
	{ key: "team1", name: "ทีมบัญชี 1", lead: "ปุ๊ก", deputy: "ตันหยง", staff: ["นัท", "ริบบิ้น"], interns: ["หยกหลิน", "หลิว"] },
	{ key: "team2", name: "ทีมบัญชี 2", lead: "เมย์", deputy: "นัทตี้", staff: ["แอ๊ว", "แพรว"], interns: ["เอิร์น", "บิ๋ม"] },
	{ key: "team3", name: "ทีมที่ปรึกษา + โปรเจค", lead: "ข้าวหอม", deputy: null, staff: [], interns: [] },
];
// The SEED value only. Round 17 made this rung editable like every other, so
// who the COO is at any moment is derived from the roster by cooName() —
// nothing reads this constant after buildUsers() has run.
export const COO_NAME = "ไหม";
export const COO_TEAM = "team3";   // the COO sits with the consult/project team


export const POSITIONS: Record<PositionKey, Position> = {
	intern: { label: "นศ.ฝึกงาน", canReview: false, canSeeOffice: false, canEditPermissions: false },
	staff: { label: "พนักงานบัญชี", canReview: false, canSeeOffice: false, canEditPermissions: false },
	deputy: { label: "รองหัวหน้าทีม", canReview: true, canSeeOffice: false, canEditPermissions: false },
	lead: { label: "หัวหน้าทีม", canReview: true, canSeeOffice: true, canEditPermissions: false },
	coo: { label: "COO + CPA", canReview: true, canSeeOffice: true, canEditPermissions: true },
};
export const POSITION_ORDER: PositionKey[] = ["intern", "staff", "deputy", "lead", "coo"];
// The review ladder itself, in order. The COO rung is conditional — the
// office's own chart says "COO Review (เฉพาะประเด็นสำคัญ)" — so a Gate only
// reaches it when the Gate template says so (`review: "coo"`).
export const REVIEW_LADDER: PositionKey[] = ["deputy", "lead", "coo"];
