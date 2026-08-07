// ================= a customer's packages (round 16) =================
//
// The services this customer has actually bought from the office — the one
// place a person can look and know what work this customer generates for
// us. Editable here, because it is per-customer data and nowhere else owns
// it: adding, editing and ending a package all work, and each of those
// changes what the recurring schedule will open next.
import { useRef } from "react";
import { CUSTOMERS, JOB_TYPES, PROJECTS } from "../../state/stores";
import { showToast } from "../../state/session";
import { useApp } from "../../state/AppContext";
import { ui } from "../../state/ui";
import { CheckCircleIcon, PlusIcon } from "../../components/Icons";
import { daysUntil, fmtDate, monthLabel } from "../../domain/dates";
import { jobTypeByKey } from "../../domain/jobTypes";
import { MONTHS, customerName } from "../../domain/projects";
import { NOW_MONTH_KEY, monthIndexOf } from "../../domain/trail";
import {
	RECURRENCES,
	customerPackages,
	fmtFee,
	monthKeyFromIndex,
	nextOccurrence,
	occurrenceLabel,
	openPeriod,
	packageById,
	packageState,
	periodOpened,
	recurrenceByKey,
} from "../../domain/schedule";
import { useOpenProject } from "../../navigation";

export function customerPackagesCount(id: string) {
	const list = customerPackages(id);
	const activeN = list.filter((k) => !k.endedAt).length;
	return list.length === 0 ? "ยังไม่มีแพ็กเกจ" : list.length + " แพ็กเกจ · ใช้งานอยู่ " + activeN;
}

function PackageForm({ id }: { id: string }) {
	const { bump } = useApp();
	const pkg = ui.pkgFormId ? packageById(id, ui.pkgFormId) : null;
	const draft = useRef({
		jobType: pkg ? pkg.jobType : "monthly",
		recurrence: pkg ? pkg.recurrence : "monthly",
		// A customer signing today starts with the งวด the office is currently
		// working, which by its own convention is the month BEFORE now — a งวด
		// is worked in the month after it closes.
		start: pkg ? pkg.startedAt : monthKeyFromIndex(monthIndexOf(NOW_MONTH_KEY) - 1),
		fee: pkg ? String(pkg.fee) : "",
		note: pkg ? pkg.note : "",
	});

	function submit() {
		const d = draft.current;
		const fee = parseInt(String(d.fee).replace(/[^0-9]/g, ""), 10);
		if (!fee && fee !== 0) { showToast("ใส่ค่าบริการเป็นตัวเลขก่อน"); return; }
		const existing = ui.pkgFormId ? packageById(id, ui.pkgFormId) : null;
		if (existing) {
			existing.jobType = d.jobType; existing.recurrence = d.recurrence;
			existing.startedAt = d.start; existing.fee = fee; existing.note = d.note.trim();
			showToast("บันทึกแพ็กเกจแล้ว");
		} else {
			CUSTOMERS[id].packages = customerPackages(id).concat([{
				id: "pk-" + id + "-" + (customerPackages(id).length + 1) + "-" + PROJECTS.length,
				jobType: d.jobType, recurrence: d.recurrence, startedAt: d.start, endedAt: null, paused: false,
				fee: fee, note: d.note.trim(), skips: [],
			}]);
			showToast("เพิ่มแพ็กเกจแล้ว — รอบถัดไปจะขึ้นในรายการที่ถึงกำหนดเปิด");
		}
		ui.pkgFormCustomer = null; ui.pkgFormId = null;
		bump();
	}

	return (
		<div className="inline-form">
			<div className="inline-form-head">{pkg ? "แก้ไขแพ็กเกจ" : "เพิ่มแพ็กเกจ"}</div>
			<div className="inline-grid">
				<label className="inline-field">ประเภทงาน
					<select id="pkg-form-jobtype" defaultValue={draft.current.jobType} onChange={(e) => { draft.current.jobType = e.target.value; }}>
						{JOB_TYPES.map((jt) => <option value={jt.key} key={jt.key}>{jt.name}</option>)}
					</select>
				</label>
				<label className="inline-field">ความถี่
					<select id="pkg-form-recurrence" defaultValue={draft.current.recurrence} onChange={(e) => { draft.current.recurrence = e.target.value; }}>
						{RECURRENCES.map((r) => <option value={r.key} key={r.key}>{r.label}</option>)}
					</select>
				</label>
				<label className="inline-field">เริ่มงวด
					<select id="pkg-form-start" defaultValue={draft.current.start} onChange={(e) => { draft.current.start = e.target.value; }}>
						{MONTHS.slice().reverse().map((m) => <option value={m.key} key={m.key}>{monthLabel(m.key)}</option>)}
					</select>
				</label>
				<label className="inline-field">ค่าบริการ (บาท)
					<input id="pkg-form-fee" type="text" defaultValue={draft.current.fee} placeholder="เช่น 6500" onChange={(e) => { draft.current.fee = e.target.value; }} />
				</label>
				<label className="inline-field grow">หมายเหตุ
					<input id="pkg-form-note" type="text" defaultValue={draft.current.note} placeholder="ไม่บังคับ" onChange={(e) => { draft.current.note = e.target.value; }} />
				</label>
			</div>
			<div className="inline-grid" style={{ marginTop: "10px" }}>
				<button type="button" className="btn btn-run" onClick={submit}>บันทึกแพ็กเกจ</button>
				<button type="button" className="btn btn-ghost" onClick={() => { ui.pkgFormCustomer = null; ui.pkgFormId = null; bump(); }}>ยกเลิก</button>
			</div>
			<p className="inline-note">ความถี่ตัดสินว่าจะเกิดรอบใหม่เองหรือไม่ — "ทุกเดือน" และ "ปีละครั้ง" จะขึ้นในรายการรอบที่ถึงกำหนดเปิด ส่วน "ครั้งเดียว" เป็นงานชิ้นเดียว ไม่เกิดซ้ำ</p>
		</div>
	);
}

export function CustomerPackages({ id }: { id: string }) {
	const { bump } = useApp();
	const openProject = useOpenProject();
	const list = customerPackages(id);

	// Opening a package's next occurrence from the customer page. Deliberately
	// the same openPeriod() the schedule uses, with the same label rule — a
	// second creation path would be a second thing that can drift.
	function openPackageOccurrence(customerId: string, pkgId: string) {
		const pkg = packageById(customerId, pkgId);
		if (!pkg) return;
		const next = nextOccurrence(customerId, pkg);
		if (!next) { showToast("ยังไม่มีรอบที่ถึงกำหนดเปิดของแพ็กเกจนี้"); return; }
		const p = openPeriod(customerId, pkg.jobType, next.monthKey, {
			how: "recurring",
			periodLabel: occurrenceLabel(pkg.jobType, next.monthKey, pkg.recurrence),
		});
		if (!p) { bump(); return; }
		showToast("เปิดงวดแล้ว: " + customerName(p.customerId) + " · " + p.periodLabel + " · ผู้รับผิดชอบ " + p.assignee);
		openProject(p.id);
	}

	// Ending a package stops it recurring; it never deletes the work already
	// opened under it, and it can be undone. `endedAt` records the LAST งวด the
	// package covers — defaulted to the most recent งวด actually opened under it.
	function endPackage(pkgId: string) {
		const pkg = packageById(id, pkgId);
		if (!pkg) return;
		const opened = PROJECTS.filter((p) => p.customerId === id && p.jobType === pkg.jobType).map((p) => monthIndexOf(p.monthKey));
		const last = opened.length ? Math.max.apply(null, opened) : monthIndexOf(NOW_MONTH_KEY) - 1;
		pkg.endedAt = monthKeyFromIndex(Math.max(last, monthIndexOf(pkg.startedAt) - 1));
		pkg.paused = false;
		showToast("สิ้นสุดแพ็กเกจแล้ว — หลังงวด" + monthLabel(pkg.endedAt) + " จะไม่เปิดงวดใหม่อีก");
		bump();
	}
	function reopenPackage(pkgId: string) {
		const pkg = packageById(id, pkgId);
		if (!pkg) return;
		pkg.endedAt = null;
		showToast("กลับมาใช้งานแพ็กเกจนี้แล้ว");
		bump();
	}
	function pausePackage(pkgId: string) {
		const pkg = packageById(id, pkgId);
		if (!pkg) return;
		pkg.paused = true;
		showToast("พักการเกิดซ้ำของแพ็กเกจนี้แล้ว — จะไม่เปิดงวดใหม่จนกว่าจะให้เกิดซ้ำต่อ");
		bump();
	}
	function resumePackage(pkgId: string) {
		const pkg = packageById(id, pkgId);
		if (!pkg) return;
		pkg.paused = false;
		showToast("ให้แพ็กเกจนี้เกิดซ้ำต่อแล้ว");
		bump();
	}

	const rows = list.map((pkg) => {
		const state = packageState(pkg);
		const rec = recurrenceByKey(pkg.recurrence);
		const statePill = state === "ended"
			? <span className="pill pill-passed">สิ้นสุดแล้ว</span>
			: state === "paused" ? <span className="pill pill-waiting">พักการเกิดซ้ำ</span>
			: <span className="pill pill-current">ใช้งานอยู่</span>;
		const next = state === "active" ? nextOccurrence(id, pkg) : null;
		const nextLine = state === "ended"
			? "สิ้นสุดหลังงวด" + monthLabel(pkg.endedAt!) + " — ไม่เปิดงวดใหม่อีก"
			: state === "paused"
				? "พักไว้ — จะไม่เปิดงวดใหม่จนกว่าจะให้เกิดซ้ำต่อ"
				: next
					? "รอบถัดไป: " + occurrenceLabel(pkg.jobType, next.monthKey, pkg.recurrence) + " — กำหนดเปิด " + fmtDate(next.opensOn) +
						(daysUntil(next.opensOn) < 0 ? " (เลยกำหนดมาแล้ว " + -daysUntil(next.opensOn) + " วัน)" : "")
					: pkg.recurrence === "oneoff"
						? "งานครั้งเดียว — เปิดเป็นโปรเจกต์แล้ว"
						: "ยังไม่มีรอบถัดไปในช่วงนี้";
		const skips = (pkg.skips || []).filter((s) => !periodOpened(id, pkg.jobType, s.period));
		return (
			<div className={"contact-row pkg-row" + (state === "ended" ? " pkg-ended" : "")} key={pkg.id}>
				<div className="contact-main">
					<span className="contact-name">
						<span className="pill job-type-pill">{jobTypeByKey(pkg.jobType)!.name}</span> {rec.label} {statePill}
					</span>
					<span className="contact-role">
						{"เริ่มงวด" + monthLabel(pkg.startedAt) + " · ค่าบริการ " + fmtFee(pkg.fee) + " " + rec.feeUnit + (pkg.note ? " · " + pkg.note : "")}
					</span>
					<span className="pkg-line">{nextLine}</span>
					{skips.length ? (
						<span className="pkg-line muted">
							{"ข้ามไว้ " + skips.length + " รอบ: " + skips.map((s) => monthLabel(s.period) + " (" + s.reason + ")").join(" · ")}
						</span>
					) : null}
				</div>
				<div className="row-actions">
					{/* Round 17: when a package's next occurrence is already due,
					    opening it is offered right here — the same openPeriod()
					    the month board's schedule calls. */}
					{next && daysUntil(next.opensOn) <= 0 ? (
						<button type="button" className="btn btn-run" onClick={() => openPackageOccurrence(id, pkg.id)}>
							เปิด{occurrenceLabel(pkg.jobType, next.monthKey, pkg.recurrence)}
						</button>
					) : null}
					<button type="button" className="btn btn-ghost" onClick={() => { ui.pkgFormCustomer = id; ui.pkgFormId = pkg.id; bump(); }}>แก้ไข</button>
					{state === "active" && pkg.recurrence !== "oneoff" ? (
						<button type="button" className="btn btn-ghost" onClick={() => pausePackage(pkg.id)}>พัก</button>
					) : null}
					{state === "paused" ? (
						<button type="button" className="btn btn-ghost" onClick={() => resumePackage(pkg.id)}>ให้เกิดซ้ำต่อ</button>
					) : null}
					{state === "ended" ? (
						<button type="button" className="btn btn-ghost" onClick={() => reopenPackage(pkg.id)}>กลับมาใช้งาน</button>
					) : (
						<button type="button" className="btn btn-ghost" onClick={() => endPackage(pkg.id)}>สิ้นสุดแพ็กเกจ</button>
					)}
				</div>
			</div>
		);
	});

	const formOpen = ui.pkgFormCustomer === id;
	return (
		<>
			{list.length ? rows : (
				<div className="all-clear"><CheckCircleIcon />ลูกค้ารายนี้ยังไม่ได้ซื้อแพ็กเกจงานใดไว้ — จึงยังไม่มีงานที่เกิดซ้ำเอง</div>
			)}
			{formOpen ? <PackageForm id={id} key={ui.pkgFormId || "add"} /> : (
				<button
					type="button"
					className="btn btn-ghost btn-with-icon"
					style={{ marginTop: "8px" }}
					onClick={() => { ui.pkgFormCustomer = id; ui.pkgFormId = null; bump(); }}
				>
					<PlusIcon />
					เพิ่มแพ็กเกจ
				</button>
			)}
		</>
	);
}
