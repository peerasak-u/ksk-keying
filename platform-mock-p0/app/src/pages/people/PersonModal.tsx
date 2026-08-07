// Round 18: adding and editing a person are the same dialog rather than a form
// unfolding under a row. The team cards stay on screen behind it, which matters
// here more than anywhere else — the whole point of the "ถ้าบันทึก:" panel is
// that you can see the structure you are about to change while you read it.
import { useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { PositionKey } from "../../types";
import { LIVE_STRUCTURE, NOTIFS, PROJECTS, TEAMS, USERS } from "../../state/stores";
import { POSITIONS, POSITION_ORDER } from "../../data/office";
import { session, showToast } from "../../state/session";
import { useApp } from "../../state/AppContext";
import { paths } from "../../navigation";
import { AlertIcon } from "../../components/Icons";
import { allUserNames, canEditTemplates, positionLabel, teamName, teamOf } from "../../domain/people";
import { projectFinished } from "../../domain/work";
import { applyPlacementTo, placementImpact, removalImpact } from "../../domain/structure";

export interface PersonEditorState { editingPersonName: string | null }

/** Which person's card carries the "selected" ring while the dialog is open. */
export const personEditor: PersonEditorState = { editingPersonName: null };

export function usePersonModal() {
	const { openModal, closeModal, bump } = useApp();
	const navigate = useNavigate();
	const form = useRef<{ name: string; team: string; position: PositionKey }>({ name: "", team: "team1", position: "staff" });
	const transferTarget = useRef("");

	const open = useCallback(
		(isAdd: boolean, name?: string) => {
			if (isAdd) {
				personEditor.editingPersonName = null;
				form.current = { name: "", team: TEAMS[0].key, position: "staff" };
			} else {
				personEditor.editingPersonName = name!;
				transferTarget.current = "";
				form.current = { name: name!, team: USERS[name!].team, position: USERS[name!].position };
			}
			bump();

			function submitAdd() {
				const n = form.current.name.trim();
				if (!n) { showToast("ใส่ชื่อพนักงานก่อน"); return; }
				if (USERS[n]) { showToast("มีพนักงานชื่อนี้อยู่แล้ว — ชื่อคือตัวระบุตัวตนในระบบนี้"); return; }
				const displaced = applyPlacementTo(LIVE_STRUCTURE, n, form.current.team, form.current.position);
				(USERS[n] as typeof USERS[string] & { added?: boolean }).added = true;
				showToast("เพิ่ม " + n + " เข้า" + teamName(form.current.team) + " เป็น" + POSITIONS[form.current.position].label +
					(displaced.length ? " — " + displaced.join(", ") + " ถูกย้ายลงเป็นพนักงานบัญชี" : ""));
				closeModal();
				bump();
			}

			function submitEdit() {
				const n = personEditor.editingPersonName;
				if (!n || !USERS[n]) return;
				const impact = placementImpact(n, form.current.team, form.current.position);
				if (impact.unchanged) { showToast("ไม่มีอะไรเปลี่ยน"); return; }
				const displaced = applyPlacementTo(LIVE_STRUCTURE, n, form.current.team, form.current.position);
				showToast(n + " → " + POSITIONS[form.current.position].label + " · " + teamName(form.current.team) +
					(impact.moved ? " — ย้ายผู้สอบทานของ " + impact.moved + " เกท" : "") +
					(displaced.length ? " · " + displaced.join(", ") + " ถูกย้ายลงเป็นพนักงานบัญชี" : ""));
				closeModal();
				bump();
				// A capability change can take the current user off this very screen.
				if (!canEditTemplates(session.currentUserName || "")) navigate(paths.myWork);
			}

			function transferWorkFrom(n: string) {
				if (!transferTarget.current || !USERS[transferTarget.current]) { showToast("เลือกคนที่จะรับโอนงานก่อน"); return; }
				const moved = PROJECTS.filter((p) => p.assignee === n && !projectFinished(p));
				moved.forEach((p) => { p.assignee = transferTarget.current; });
				showToast("โอนงานที่ยังไม่ปิด " + moved.length + " โปรเจกต์จาก " + n + " ไปให้ " + transferTarget.current + " แล้ว");
				transferTarget.current = "";
				// This one does change the screen underneath, and the dialog stays
				// open because removing them is usually the next thing.
				bump();
			}

			function removePerson(n: string) {
				const im = removalImpact(n);
				if (im.isCoo) {
					showToast("สำนักงานต้องมีผู้สอบทานขั้นสุดท้าย (COO) หนึ่งคนเสมอ — ตั้งคนอื่นเป็น COO ก่อน");
					return;
				}
				if (im.open > 0) {
					showToast(n + " ยังถือโปรเจกต์ที่ยังไม่ปิดอยู่ " + im.open + " โปรเจกต์ — โอนงานให้คนอื่นก่อนจึงจะเอาออกได้");
					return;
				}
				applyPlacementTo(LIVE_STRUCTURE, n, USERS[n].team, "staff");
				TEAMS.forEach((t) => {
					t.staff = t.staff.filter((x) => x !== n);
					t.interns = t.interns.filter((x) => x !== n);
				});
				delete USERS[n];
				for (let i = NOTIFS.length - 1; i >= 0; i--) if (NOTIFS[i].to === n) NOTIFS.splice(i, 1);
				showToast("เอา " + n + " ออกจากสำนักงานแล้ว" +
					(im.waiting > 0 ? " — เกทที่เคยค้างอยู่กับเขา " + im.waiting + " ข้อ เลื่อนขึ้นไปหารุ่นถัดไปของบันไดสอบทานแล้ว" : "") +
					" · ชื่อที่เคยเซ็นไว้ในเกทเดิมยังคงอยู่ เพราะเป็นบันทึกว่าใครทำอะไร");
				// Closed before the repaint: the dialog is about a person who no
				// longer exists.
				closeModal();
				bump();
			}

			openModal({
				title: isAdd ? "เพิ่มพนักงานใหม่" : "แก้ไข " + name,
				sub: isAdd
					? "ชื่อคือตัวระบุตัวตนในระบบนี้ ตั้งครั้งเดียวตอนเข้าทีม"
					: "ทีมและตำแหน่งเป็นตัวกำหนดว่าเกทของเขาไปค้างอยู่ในคิวสอบทานของใคร",
				render: () => {
					const editing = personEditor.editingPersonName;
					const impact = isAdd || !editing ? null : placementImpact(editing, form.current.team, form.current.position);
					const im = isAdd || !editing ? null : removalImpact(editing);
					const others = allUserNames().filter((n) => n !== editing).sort((a, b) => a.localeCompare(b, "th"));
					const cap = POSITIONS[form.current.position];
					return {
						body: (
							<>
								<div className="inline-grid">
									{isAdd ? (
										<label className="inline-field grow">ชื่อที่ใช้เรียก
											<input
												id="person-name-input"
												type="text"
												placeholder="เช่น พลอย"
												defaultValue={form.current.name}
												onChange={(e) => { form.current.name = e.target.value; }}
											/>
										</label>
									) : null}
									<label className="inline-field grow">ทีม
										<select
											id="person-team-input"
											value={form.current.team}
											onChange={(e) => { form.current.team = e.target.value; bump(); }}
										>
											{TEAMS.map((t) => <option value={t.key} key={t.key}>{t.name}</option>)}
										</select>
									</label>
									<label className="inline-field grow">ตำแหน่ง
										<select
											id="person-position-input"
											value={form.current.position}
											onChange={(e) => { form.current.position = e.target.value as PositionKey; bump(); }}
										>
											{POSITION_ORDER.slice().reverse().map((k) => <option value={k} key={k}>{POSITIONS[k].label}</option>)}
										</select>
									</label>
								</div>
								<p className="inline-note">
									{cap.canReview
										? "ตำแหน่งนี้อยู่บนบันไดสอบทาน — เซ็นช่องผู้สอบทานได้ (แต่ไม่ใช่เกทที่ตัวเองเป็นผู้ทำ)"
										: "ตำแหน่งนี้ไม่อยู่บนบันไดสอบทาน — ติ๊กเกทได้ แต่เซ็นผู้สอบทานไม่ได้"}
									{cap.canSeeOffice ? " · เห็นหน้าภาพรวมสำนักงาน" : ""}
									{cap.canEditPermissions ? " · แก้ไขประเภทงานและพนักงานได้" : ""}
								</p>
								{/* What this change actually does to work already in flight,
								    stated before it happens rather than discovered afterwards. */}
								{impact && impact.lines.length ? (
									<div className="gate-note" style={{ marginTop: "10px" }}>
										<AlertIcon />
										<span>
											<b>ถ้าบันทึก:</b><br />
											{impact.lines.map((l, i) => <span key={i}>{i > 0 ? <br /> : null}{l}</span>)}
										</span>
									</div>
								) : null}
								{isAdd || !im || !editing ? null : (
									<>
										<p className="rung-label" style={{ marginTop: "14px" }}>การออกจากสำนักงาน</p>
										<div className="inline-grid">
											<label className="inline-field grow">โอนงานที่ยังไม่ปิดทั้งหมดไปให้
												<select
													id="person-transfer-input"
													value={transferTarget.current}
													onChange={(e) => { transferTarget.current = e.target.value; bump(); }}
												>
													<option value="">— เลือกคน —</option>
													{others.map((n) => (
														<option value={n} key={n}>{n + " (" + positionLabel(n) + " · " + teamName(teamOf(n)) + ")"}</option>
													))}
												</select>
											</label>
											<button type="button" className="btn btn-ghost" onClick={() => transferWorkFrom(editing)} disabled={im.open === 0}>
												โอนงาน {im.open} โปรเจกต์
											</button>
										</div>
										<p className="inline-note">
											{im.isCoo ? "เอา COO ออกไม่ได้ — สำนักงานต้องมีผู้สอบทานขั้นสุดท้ายหนึ่งคนเสมอ"
												: im.open > 0 ? "ยังถือโปรเจกต์ที่ยังไม่ปิดอยู่ " + im.open + " โปรเจกต์ — ต้องโอนงานก่อนจึงจะเอาออกจากสำนักงานได้"
												: im.waiting > 0 ? "ไม่มีโปรเจกต์ค้างในมือแล้ว · เกทที่ค้างรอลายเซ็นของคนนี้ " + im.waiting + " ข้อ จะเลื่อนขึ้นไปหารุ่นถัดไปของบันไดสอบทานเอง"
												: "ไม่มีงานค้างในมือและไม่มีเกทค้างรอลายเซ็น — เอาออกได้"}
										</p>
									</>
								)}
							</>
						),
						// เอาออกจากสำนักงาน sits apart from บันทึก / ยกเลิก because it is
						// not a variant of saving, and it stays .btn-ghost rather than
						// borrowing red: red in this app means "somebody is blocked".
						actions: (
							<>
								<button type="button" className="btn btn-run" onClick={isAdd ? submitAdd : submitEdit}>
									{isAdd ? "เพิ่มพนักงาน" : "บันทึกการเปลี่ยนแปลง"}
								</button>
								<button type="button" className="btn btn-ghost" onClick={closeModal}>ยกเลิก</button>
								{isAdd || !editing ? null : (
									<button type="button" className="btn btn-ghost push-right" onClick={() => removePerson(editing)}>
										เอาออกจากสำนักงาน
									</button>
								)}
							</>
						),
					};
				},
				// The row's selected ring belongs to the dialog being open, so it
				// clears however the dialog was closed — Escape, cancel or save.
				onClose: () => { personEditor.editingPersonName = null; bump(); },
			});
		},
		[openModal, closeModal, bump, navigate],
	);

	return open;
}
