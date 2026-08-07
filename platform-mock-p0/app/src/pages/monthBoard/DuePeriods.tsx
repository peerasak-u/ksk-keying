// ================= the schedule, on the month board (round 16) =================
//
// "So how does next month's work come into existence?" — answered here.
// Everything below reads scheduleSnapshot(), which derives its rows from
// the customers' packages, so nothing on this screen is a hand-written
// list. Opening is the default: every row's first action is เปิดตอนนี้,
// and skipping a cycle is a deliberate second action that has to carry a
// reason, so a งวด that never happened is visible as a decision rather
// than as an absence.
import { useEffect, useRef, useState } from "react";
import type { DueRow } from "../../types";
import { CUSTOMERS, JOB_TYPES } from "../../state/stores";
import { TODAY, fmtDate } from "../../domain/dates";
import { showToast, session } from "../../state/session";
import { useApp } from "../../state/AppContext";
import { CappedList } from "../../components/CappedList";
import { jobTypeByKey } from "../../domain/jobTypes";
import { MONTHS, customerName } from "../../domain/projects";
import {
	customerPackages,
	occurrenceLabel,
	openPeriod,
	packageById,
	periodOpened,
	recurrenceByKey,
	scheduleSnapshot,
} from "../../domain/schedule";
import { useOpenProject } from "../../navigation";

function dueKey(row: DueRow) { return row.customerId + "|" + row.pkg.id + "|" + row.monthKey; }
function parseDueKey(key: string) {
	const a = String(key).split("|");
	return { customerId: a[0], pkg: packageById(a[0], a[1]), monthKey: a[2] };
}

// The manual path — same action, triggered by a person. A late-signed
// customer, a backdated month, a re-open: all of them are just this form
// calling openPeriod(), which is the only creation path there is.
function ManualOpenForm({ onOpened }: { onOpened: () => void }) {
	const openProject = useOpenProject();
	const ids = Object.keys(CUSTOMERS).sort((a, b) => CUSTOMERS[a].displayName.localeCompare(CUSTOMERS[b].displayName, "th"));
	const [form, setForm] = useState({
		customerId: ids[0],
		jobType: "monthly",
		monthKey: MONTHS[MONTHS.length - 1].key,
	});
	const hasPackage = customerPackages(form.customerId).some((k) => k.jobType === form.jobType && !k.endedAt);
	const already = periodOpened(form.customerId, form.jobType, form.monthKey);

	function submit() {
		// If the customer holds a package for this job type, the period is
		// named the way that package's own occurrences are.
		const pkg = customerPackages(form.customerId).filter((k) => k.jobType === form.jobType && !k.endedAt)[0];
		const p = openPeriod(form.customerId, form.jobType, form.monthKey, {
			how: "manual",
			periodLabel: pkg ? occurrenceLabel(pkg.jobType, form.monthKey, pkg.recurrence) : undefined,
		});
		if (!p) return;
		onOpened();
		showToast("เปิดงวดแล้ว: " + customerName(p.customerId) + " · " + p.periodLabel);
		openProject(p.id);
	}

	return (
		<div className="inline-form">
			<div className="inline-form-head">เปิดงวดด้วยตนเอง</div>
			<div className="inline-grid">
				<label className="inline-field">ลูกค้า
					<select name="manual-customerId" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
						{ids.map((id) => <option value={id} key={id}>{CUSTOMERS[id].displayName + " (#" + CUSTOMERS[id].code + ")"}</option>)}
					</select>
				</label>
				<label className="inline-field">ประเภทงาน
					<select name="manual-jobType" value={form.jobType} onChange={(e) => setForm({ ...form, jobType: e.target.value })}>
						{JOB_TYPES.map((jt) => <option value={jt.key} key={jt.key}>{jt.name}</option>)}
					</select>
				</label>
				<label className="inline-field">งวด
					<select name="manual-monthKey" value={form.monthKey} onChange={(e) => setForm({ ...form, monthKey: e.target.value })}>
						{MONTHS.slice().reverse().map((m) => <option value={m.key} key={m.key}>{"งวด" + m.label}</option>)}
					</select>
				</label>
				<button type="button" className="btn btn-run" onClick={submit} disabled={already}>เปิดงวดนี้</button>
			</div>
			<p className="inline-note">
				{already
					? "งวดนี้เปิดไว้แล้วสำหรับลูกค้ารายนี้ — เลือกงวดอื่น"
					: hasPackage
						? "เปิดแล้วจะได้โปรเจกต์แบบเดียวกับที่รอบอัตโนมัติสร้างทุกประการ — เฟสและเกทมาจากเทมเพลตของประเภทงาน และกำหนดวันของเกทคิดจากวันที่เปิดจริง"
						: "ลูกค้ารายนี้ไม่มีแพ็กเกจของประเภทงานนี้ — จะเปิดเป็นงานนอกแพ็กเกจ (เปิดครั้งเดียว ไม่เกิดซ้ำ)"}
			</p>
		</div>
	);
}

export function duePeriodsCount() {
	const snap = scheduleSnapshot();
	return snap.due.length === 0 ? "ไม่มีรอบที่ถึงกำหนด" : snap.due.length + " รอบ";
}

export function DuePeriods() {
	const { bump } = useApp();
	const openProject = useOpenProject();
	const [skipFormKey, setSkipFormKey] = useState<string | null>(null);
	const [manualOpenShown, setManualOpenShown] = useState(false);
	const skipReason = useRef("");
	const skipInput = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (skipFormKey && skipInput.current) skipInput.current.focus();
	}, [skipFormKey]);

	const snap = scheduleSnapshot();
	const overdue = snap.due.filter((r) => r.overdue);
	const upcoming = snap.due.filter((r) => !r.overdue);

	function openDuePeriod(key: string) {
		const t = parseDueKey(key);
		if (!t.pkg) return;
		const p = openPeriod(t.customerId, t.pkg.jobType, t.monthKey, {
			how: "recurring",
			periodLabel: occurrenceLabel(t.pkg.jobType, t.monthKey, t.pkg.recurrence),
		});
		if (!p) { bump(); return; }
		showToast("เปิดงวดแล้ว: " + customerName(p.customerId) + " · " + p.periodLabel);
		openProject(p.id);
	}
	function openAllOverdue() {
		const rows = scheduleSnapshot().due.filter((r) => r.overdue);
		rows.forEach((r) => {
			openPeriod(r.customerId, r.pkg.jobType, r.monthKey, {
				how: "recurring",
				periodLabel: occurrenceLabel(r.pkg.jobType, r.monthKey, r.pkg.recurrence),
			});
		});
		showToast("เปิดงวดที่เลยกำหนดแล้ว " + rows.length + " รอบ");
		bump();
	}
	function confirmSkip(key: string) {
		const reason = skipReason.current.trim();
		if (!reason) { showToast("ต้องระบุเหตุผลก่อนจึงจะข้ามรอบได้"); return; }
		const t = parseDueKey(key);
		if (!t.pkg) return;
		(t.pkg.skips = t.pkg.skips || []).push({
			period: t.monthKey, reason: reason, by: session.currentUserName || "", at: TODAY,
		});
		setSkipFormKey(null);
		skipReason.current = "";
		showToast("บันทึกการข้ามรอบแล้ว — " + customerName(t.customerId));
		bump();
	}
	function undoSkip(key: string) {
		const t = parseDueKey(key);
		if (!t.pkg) return;
		t.pkg.skips = (t.pkg.skips || []).filter((s) => s.period !== t.monthKey);
		showToast("ยกเลิกการข้ามรอบแล้ว — งวดกลับมาอยู่ในรายการที่ถึงกำหนดเปิด");
		bump();
	}
	function pausePackage(customerId: string, pkgId: string) {
		const pkg = packageById(customerId, pkgId);
		if (!pkg) return;
		pkg.paused = true;
		showToast("พักการเกิดซ้ำแล้ว — " + customerName(customerId) + " · " + jobTypeByKey(pkg.jobType)!.name);
		bump();
	}

	const Row = (r: DueRow) => {
		const pkg = r.pkg;
		const k = dueKey(r);
		return (
			<div className="contact-row due-row" key={k}>
				<div className="contact-main">
					<span className="contact-name">
						{customerName(r.customerId)} <span className="pill job-type-pill">{jobTypeByKey(pkg.jobType)!.name}</span>
						{pkg.recurrence === "oneoff" ? <> <span className="pill pill-optional">งานครั้งเดียว</span></> : null}
					</span>
					<span className="contact-role">
						{occurrenceLabel(pkg.jobType, r.monthKey, pkg.recurrence) + " · " + recurrenceByKey(pkg.recurrence).label}
					</span>
					<span className="pkg-line">
						{r.overdue ? (
							<span className="due-when overdue">{"เลยกำหนดเปิดมาแล้ว " + -r.days + " วัน (" + fmtDate(r.opensOn) + ")"}</span>
						) : (
							<span className="due-when">{"กำหนดเปิด " + fmtDate(r.opensOn) + " (อีก " + r.days + " วัน)"}</span>
						)}
					</span>
				</div>
				<div className="row-actions">
					<button type="button" className="btn btn-ghost" onClick={() => openDuePeriod(k)}>เปิดตอนนี้</button>
					{pkg.recurrence === "oneoff" ? null : (
						<>
							<button type="button" className="btn btn-ghost" onClick={() => { skipReason.current = ""; setSkipFormKey(k); }}>ข้ามรอบนี้</button>
							<button type="button" className="btn btn-ghost" onClick={() => pausePackage(r.customerId, pkg.id)}>พักการเกิดซ้ำ</button>
						</>
					)}
				</div>
				{skipFormKey === k ? (
					<div className="inline-form" style={{ flex: "1 1 100%", margin: "10px 0 0" }}>
						<div className="inline-form-head">ข้ามรอบนี้ — ระบุเหตุผล</div>
						<div className="inline-grid">
							<label className="inline-field grow">เหตุผล
								<input
									id="skip-reason-input"
									ref={skipInput}
									type="text"
									placeholder="เช่น ลูกค้าไม่มีรายการเดือนนี้"
									onChange={(e) => { skipReason.current = e.target.value; }}
								/>
							</label>
							<button type="button" className="btn btn-ghost" onClick={() => confirmSkip(k)}>ยืนยันการข้าม</button>
							<button type="button" className="btn btn-ghost" onClick={() => setSkipFormKey(null)}>ยกเลิก</button>
						</div>
						<p className="inline-note">การข้ามจะถูกบันทึกไว้ให้เห็น พร้อมชื่อคนที่ข้ามและเหตุผล — งวดจะไม่หายไปเงียบๆ</p>
					</div>
				) : null}
			</div>
		);
	};

	return (
		<div id="month-due-body">
			<p className="ov-note">
				รอบงานเกิดจาก "แพ็กเกจงานที่ซื้อไว้" ของลูกค้าแต่ละราย — รายการนี้คำนวณจากแพ็กเกจที่ยังใช้งานอยู่ ไม่ได้พิมพ์ไว้ล่วงหน้า
				ระบบจะเปิดให้เองเมื่อถึงวันกำหนด (ในมอคนี้กดเปิดเองได้เลย)
			</p>
			<div className="due-toolbar">
				{/* Deliberately NOT the blue primary: this one action opens several
				    projects at once, and the loudest button on a screen should not
				    be the one with the widest blast radius. */}
				{overdue.length > 0 ? (
					<button type="button" className="btn btn-ghost" onClick={openAllOverdue}>เปิดทุกรอบที่เลยกำหนด ({overdue.length})</button>
				) : null}
				<button type="button" className="btn btn-ghost" onClick={() => setManualOpenShown(!manualOpenShown)}>
					{manualOpenShown ? "ปิดฟอร์มเปิดงวดด้วยตนเอง" : "เปิดงวดด้วยตนเอง"}
				</button>
			</div>

			{manualOpenShown ? <ManualOpenForm onOpened={() => setManualOpenShown(false)} /> : null}

			<div className="sub-head sub-head-attn">เลยกำหนดเปิดแล้ว<span className="sub-count">{overdue.length} รอบ</span></div>
			<p className="sub-desc">ถึงวันที่ควรเปิดแล้วแต่ยังไม่มีโปรเจกต์ — เปิดเลย หรือบันทึกว่าข้ามรอบนี้พร้อมเหตุผล</p>
			<CappedList listKey="due-overdue" rows={overdue.map(Row)} emptyText="ไม่มีรอบที่เลยกำหนดเปิด" cap={6} wrapClass={null} unit="รอบ" />
			<div className="sub-head">กำลังจะถึงกำหนด<span className="sub-count">{upcoming.length} รอบ</span></div>
			<p className="sub-desc">จะเปิดอัตโนมัติในวันที่กำหนด — เปิดก่อนได้ถ้าจำเป็น</p>
			<CappedList listKey="due-upcoming" rows={upcoming.map(Row)} emptyText="ไม่มีรอบที่กำลังจะถึงกำหนด" cap={6} wrapClass={null} unit="รอบ" />

			{snap.skipped.length ? (
				<>
					<div className="sub-head">ข้ามรอบนี้ไว้<span className="sub-count">{snap.skipped.length} รอบ</span></div>
					{snap.skipped.map((r) => (
						<div className="contact-row due-row pkg-ended" key={dueKey(r)}>
							<div className="contact-main">
								<span className="contact-name">
									{customerName(r.customerId)} <span className="pill job-type-pill">{jobTypeByKey(r.pkg.jobType)!.name}</span>{" "}
									<span className="pill pill-passed">ข้ามแล้ว</span>
								</span>
								<span className="contact-role">{occurrenceLabel(r.pkg.jobType, r.monthKey, r.pkg.recurrence)}</span>
								<span className="pkg-line">
									{"เหตุผล: " + r.skip!.reason + " · โดย " + (r.skip!.by || "—") + " เมื่อ " + (r.skip!.at || "—")}
								</span>
							</div>
							<div className="row-actions">
								<button type="button" className="btn btn-ghost" onClick={() => undoSkip(dueKey(r))}>ยกเลิกการข้าม</button>
							</div>
						</div>
					))}
				</>
			) : null}

			{snap.paused.length ? (
				<p className="inline-note">
					{"พักการเกิดซ้ำไว้ " + snap.paused.length + " แพ็กเกจ: " +
						snap.paused.slice(0, 4).map((r) => customerName(r.customerId) + " (" + jobTypeByKey(r.pkg.jobType)!.name + ")").join(" · ") +
						(snap.paused.length > 4 ? " และอีก " + (snap.paused.length - 4) + " ราย" : "") +
						" — กลับมาให้เกิดซ้ำได้ที่การ์ดแพ็กเกจในหน้าลูกค้า"}
				</p>
			) : null}
		</div>
	);
}
