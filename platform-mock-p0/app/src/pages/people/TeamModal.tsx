// ================= round 21: creating a team =================
//
// Adding a person existed since round 17; adding a TEAM did not, so the
// office's structure was only editable within a shape that was seeded once.
// It uses round 18's dialog, exactly as adding a person does, and it is
// consequential the same way: the new team can take people immediately, and
// its review ladder is not stored anywhere — reviewerIn() derives it from
// whoever ends up holding หัวหน้าทีม / รองหัวหน้าทีม on it.
import { Fragment, useCallback, useRef } from "react";
import { LIVE_STRUCTURE, TEAMS, USERS } from "../../state/stores";
import { showToast } from "../../state/session";
import { useApp } from "../../state/AppContext";
import { AlertIcon } from "../../components/Icons";
import { allUserNames, cooName, positionLabel, teamByKey, teamName, teamOf } from "../../domain/people";
import { applyPlacementTo, newTeamImpact } from "../../domain/structure";

export function useTeamModal() {
	const { openModal, closeModal, bump } = useApp();
	const form = useRef({ name: "", lead: "", deputy: "" });

	return useCallback(() => {
		form.current = { name: "", lead: "", deputy: "" };

		function submit() {
			const name = String(form.current.name || "").trim();
			if (!name) { showToast("ตั้งชื่อทีมก่อน"); return; }
			if (TEAMS.some((t) => t.name === name)) { showToast("มีทีมชื่อนี้อยู่แล้ว"); return; }
			if (form.current.lead && form.current.lead === form.current.deputy) {
				showToast("หัวหน้าทีมกับรองหัวหน้าทีมต้องเป็นคนละคน");
				return;
			}
			let key = "team" + (TEAMS.length + 1);
			while (teamByKey(key)) key += "x";
			TEAMS.push({ key: key, name: name, lead: null, deputy: null, staff: [], interns: [] });
			let displaced: string[] = [];
			// The SAME seating function every other placement on this screen uses,
			// so a person moved in here cannot behave differently.
			if (form.current.lead) displaced = displaced.concat(applyPlacementTo(LIVE_STRUCTURE, form.current.lead, key, "lead"));
			if (form.current.deputy) displaced = displaced.concat(applyPlacementTo(LIVE_STRUCTURE, form.current.deputy, key, "deputy"));
			showToast("ตั้ง" + name + "แล้ว" +
				(form.current.lead ? " — หัวหน้าทีม " + form.current.lead : " — ยังไม่มีหัวหน้าทีม งานจะขึ้นตรงถึง COO") +
				(displaced.length ? " · " + displaced.join(", ") + " ถูกย้ายลงเป็นพนักงานบัญชี" : ""));
			closeModal();
			bump();
		}

		openModal({
			title: "ตั้งทีมใหม่",
			sub: "บันไดสอบทานของทีมมาจากคนที่ถือตำแหน่ง ไม่ได้เก็บไว้ต่างหาก",
			render: () => {
				const impact = newTeamImpact(form.current, cooName());
				const peopleOptions = (exclude: string) =>
					allUserNames()
						.filter((n) => n !== exclude)
						.sort((a, b) => a.localeCompare(b, "th"))
						.map((n) => (
							<option value={n} key={n}>{n + " (" + positionLabel(n) + " · " + teamName(teamOf(n)) + ")"}</option>
						));
				return {
					body: (
						<>
							<div className="inline-grid">
								<label className="inline-field grow">ชื่อทีม
									<input
										id="team-name-input"
										type="text"
										placeholder="เช่น ทีมบัญชี 3"
										defaultValue={form.current.name}
										onChange={(e) => { form.current.name = e.target.value; }}
									/>
								</label>
							</div>
							<div className="inline-grid">
								<label className="inline-field grow">หัวหน้าทีม
									<select id="team-lead-input" value={form.current.lead} onChange={(e) => { form.current.lead = e.target.value; bump(); }}>
										<option value="">— ยังไม่ตั้ง —</option>
										{peopleOptions(form.current.deputy)}
									</select>
								</label>
							</div>
							<div className="inline-grid">
								<label className="inline-field grow">รองหัวหน้าทีม
									<select id="team-deputy-input" value={form.current.deputy} onChange={(e) => { form.current.deputy = e.target.value; bump(); }}>
										<option value="">— ยังไม่ตั้ง —</option>
										{peopleOptions(form.current.lead)}
									</select>
								</label>
							</div>
							<p className="inline-note">
								ตั้งทีมได้โดยยังไม่ต้องมีสมาชิก — ย้ายคนเข้ามาทีหลังได้จากการ์ดของแต่ละคน คนที่เลือกเป็นหัวหน้า/รองหัวหน้าจะย้ายมาอยู่ทีมนี้ทันที
							</p>
							{impact.lines.length ? (
								<div className="gate-note" style={{ marginTop: "10px" }}>
									<AlertIcon />
									<span>
										<b>ถ้าบันทึก:</b><br />
										{impact.lines.map((l, i) => <Fragment key={i}>{i > 0 ? <br /> : null}{l}</Fragment>)}
									</span>
								</div>
							) : null}
						</>
					),
					actions: (
						<>
							<button type="button" className="btn btn-run" onClick={submit}>ตั้งทีมนี้</button>
							<button type="button" className="btn btn-ghost" onClick={closeModal}>ยกเลิก</button>
						</>
					),
				};
			},
		});
		void USERS;
	}, [openModal, closeModal, bump]);
}
