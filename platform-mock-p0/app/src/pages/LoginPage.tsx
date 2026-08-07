// ================= screen 1: login / session =================
//
// มอค — there is no authentication. The demo accounts are the office's own
// people, one per rung of the real structure; every person in the office is
// reachable underneath them, because work can be handed to anybody and
// somebody added on the พนักงานและทีม screen has to be loginable.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { USERS } from "../state/stores";
import { POSITION_ORDER } from "../data/office";
import { session } from "../state/session";
import { useApp } from "../state/AppContext";
import { ui } from "../state/ui";
import { paths } from "../navigation";
import { allUserNames, personCaption, positionOf, teamOf } from "../domain/people";

export const DEMO_USERS = [
	{ name: "นัท", why: "พนักงานบัญชี ทีม 1 — มีงานในมือ ติ๊กเกทได้ แต่เซ็นผู้สอบทานไม่ได้" },
	{ name: "หยกหลิน", why: "นศ.ฝึกงาน ทีม 1 — ทำงานได้ ส่งงานขึ้นไปให้รองหัวหน้าทีมสอบทาน" },
	{ name: "ตันหยง", why: "รองหัวหน้าทีม 1 — รุ่นแรกของบันไดสอบทาน มีเกทของทีมรอเซ็น" },
	{ name: "ปุ๊ก", why: 'หัวหน้าทีม 1 — เห็น "ภาพรวมสำนักงาน" และงานที่ค้างถึงรุ่นหัวหน้าทีม' },
	{ name: "เมย์", why: "หัวหน้าทีม 2 — ภาพรวมเดียวกัน แต่กรองดูเฉพาะทีมตัวเองได้" },
	{ name: "ไหม", why: "COO + CPA — ผู้สอบทานขั้นสุดท้ายเฉพาะประเด็นสำคัญ + แก้ไขประเภทงานได้" },
];

/** Everything login() did beyond setting the name: a fresh login must not
 *  inherit the last user's selections. A team lead lands on their own team;
 *  the COO lands on the whole office. */
export function applyLoginDefaults(name: string) {
	ui.overviewOpenSection = "late";
	ui.overviewPerson = null;
	ui.overviewPeriodKey = "now";
	ui.overviewTeamKey = positionOf(name) === "lead" ? teamOf(name) || "all" : "all";
	ui.expandedLists = {};
}

export function LoginPage() {
	const { setCurrentUserName, closeModal, bump } = useApp();
	const navigate = useNavigate();
	const [email, setEmail] = useState("");
	const [pass, setPass] = useState("");

	function login(name: string) {
		if (!USERS[name]) name = DEMO_USERS[0].name;
		session.currentUserName = name;
		applyLoginDefaults(name);
		closeModal();
		setCurrentUserName(name);
		bump();
		navigate(paths.myWork);
	}

	const curated = DEMO_USERS.filter((d) => !!USERS[d.name]);
	const named: Record<string, boolean> = {};
	curated.forEach((d) => { named[d.name] = true; });
	const others = allUserNames()
		.filter((n) => !named[n])
		.sort((a, b) => {
			const d = POSITION_ORDER.indexOf(USERS[b].position) - POSITION_ORDER.indexOf(USERS[a].position);
			return d !== 0 ? d : a.localeCompare(b, "th");
		});
	// A person added during the session is shown without having to expand
	// anything — otherwise the change would be invisible from here.
	const anyAdded = others.some((n) => (USERS[n] as { added?: boolean }).added);
	const open = ui.otherUsersShown || anyAdded;

	const DemoUserButton = ({ name, why }: { name: string; why: string }) => (
		<button className="demo-user" onClick={() => login(name)}>
			<span className="avatar">{USERS[name].initials}</span>
			<span>
				<span className="demo-user-name" style={{ display: "block" }}>{name}</span>
				<span className="demo-user-role">{why}</span>
			</span>
		</button>
	);

	return (
		<div id="screen-login" style={{ display: "flex" }}>
			<div className="login-card">
				<p className="login-wordmark">KSK</p>
				<p className="login-sub">ระบบจัดการเอกสารลูกค้า — เข้าสู่ระบบ</p>

				<div className="field">
					<label htmlFor="login-email">อีเมล</label>
					<input id="login-email" type="text" placeholder="ชื่อ@ksk.co.th" value={email} onChange={(e) => setEmail(e.target.value)} />
				</div>
				<div className="field">
					<label htmlFor="login-pass">รหัสผ่าน</label>
					<input id="login-pass" type="password" placeholder="••••••••" value={pass} onChange={(e) => setPass(e.target.value)} />
				</div>
				<button className="btn btn-run login-submit" onClick={() => login("นัท")}>เข้าสู่ระบบ</button>

				<div className="login-note">
					<p>มอค — ไม่มีการยืนยันตัวตนจริง กรอกอะไรก็เข้าได้ หรือเลือกบัญชีตัวอย่างเพื่อดูว่าหน้าจอต่างกันตามตำแหน่งในทีมอย่างไร:</p>
					<div id="demo-users">
						{curated.map((d) => <DemoUserButton key={d.name} name={d.name} why={d.why} />)}
						{others.length === 0 ? null : (
							<>
								<button
									type="button"
									className="btn btn-ghost"
									style={{ width: "100%", marginTop: "6px" }}
									onClick={() => { ui.otherUsersShown = !ui.otherUsersShown; bump(); }}
								>
									{open ? "ซ่อนพนักงานคนอื่น" : "พนักงานคนอื่นในสำนักงาน (" + others.length + " คน)"}
								</button>
								{open ? (
									<div style={{ marginTop: "6px" }}>
										{others.map((n) => (
											<DemoUserButton
												key={n}
												name={n}
												why={personCaption(n) + ((USERS[n] as { added?: boolean }).added ? " — เพิ่มเข้ามาใหม่ในรอบนี้" : "")}
											/>
										))}
									</div>
								) : null}
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
