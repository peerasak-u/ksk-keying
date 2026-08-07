// ---- the registry card ----
// Round 16: what the office serves this customer is a fact about their
// packages, not something inferred from whichever projects happen to exist.
// Projects stay the fallback for a customer with no packages.
//
// The edit form below is the rest of the customer's field set, filled in here
// rather than being asked for at the moment they sign (round 17). Two of these
// are not cosmetic: จด VAT decides whether two Gates of the yearly checklist
// apply at all, and รอบปีบัญชี decides when a yearly package's งวด falls.
import { useRef } from "react";
import { CUSTOMERS } from "../../state/stores";
import { CUSTOMER_STATUS_LABEL } from "../../data/customers";
import { showToast } from "../../state/session";
import { useApp } from "../../state/AppContext";
import { ui } from "../../state/ui";
import { CheckCircleIcon } from "../../components/Icons";
import { THAI_MONTHS } from "../../domain/dates";
import { jobTypeByKey } from "../../domain/jobTypes";
import { projectsForCustomer } from "../../domain/projects";
import { customerPackages } from "../../domain/schedule";

function Kv({ k, value, muted }: { k: string; value: string; muted?: boolean }) {
	return (
		<div className="kv-row">
			<span className="kv-key">{k}</span>
			<span className={"kv-val" + (muted ? " muted" : "")}>{value}</span>
		</div>
	);
}

function ProfileForm({ id }: { id: string }) {
	const { bump } = useApp();
	const c = CUSTOMERS[id];
	const draft = useRef({
		display: c.displayName, legal: c.legalName, taxId: c.taxId || "",
		nature: c.businessNature, vat: c.vatRegistered ? "yes" : "no",
		fye: c.fiscalYearEnd, status: c.status, line: c.lineGroupId || "", note: c.note || "",
	});

	function submit() {
		const d = draft.current;
		const display = d.display.trim();
		if (!display) { showToast("ชื่อที่ใช้เรียกว่างไม่ได้"); return; }
		c.displayName = display;
		c.legalName = d.legal.trim() || display;
		c.taxId = d.taxId.trim() || null;
		c.businessNature = d.nature.trim() || c.businessNature;
		c.vatRegistered = d.vat === "yes";
		c.fiscalYearEnd = d.fye;
		c.status = d.status;
		c.lineGroupId = d.line.trim() || null;
		c.note = d.note.trim();
		ui.profileFormOpen = null;
		showToast("บันทึกข้อมูล " + c.displayName + " แล้ว");
		bump();
	}

	const fyeOptions = THAI_MONTHS.map((m, i) => {
		const label = (i === 1 ? "28/29 " : [3, 5, 8, 10].indexOf(i) !== -1 ? "30 " : "31 ") + m;
		return { label, selected: String(c.fiscalYearEnd).indexOf(m) !== -1 };
	});
	const fyeDefault = (fyeOptions.filter((o) => o.selected)[0] || fyeOptions[11]).label;

	return (
		<div className="inline-form" style={{ margin: 0 }}>
			<div className="inline-form-head">แก้ไขข้อมูลลูกค้า</div>
			<div className="inline-grid">
				<label className="inline-field grow">ชื่อที่ใช้เรียก
					<input id="cp-display" type="text" defaultValue={c.displayName} onChange={(e) => { draft.current.display = e.target.value; }} />
				</label>
				<label className="inline-field grow">ชื่อจดทะเบียน
					<input id="cp-legal" type="text" defaultValue={c.legalName} onChange={(e) => { draft.current.legal = e.target.value; }} />
				</label>
				<label className="inline-field grow">เลขผู้เสียภาษี
					<input id="cp-taxid" type="text" defaultValue={c.taxId || ""} placeholder="เว้นว่างถ้าเป็นบุคคลธรรมดา" onChange={(e) => { draft.current.taxId = e.target.value; }} />
				</label>
			</div>
			<div className="inline-grid" style={{ marginTop: "8px" }}>
				<label className="inline-field grow">ลักษณะธุรกิจ
					<input id="cp-nature" type="text" defaultValue={c.businessNature} onChange={(e) => { draft.current.nature = e.target.value; }} />
				</label>
				<label className="inline-field">จดทะเบียน VAT
					<select id="cp-vat" defaultValue={c.vatRegistered ? "yes" : "no"} onChange={(e) => { draft.current.vat = e.target.value; }}>
						<option value="yes">จดแล้ว</option>
						<option value="no">ยังไม่จด</option>
					</select>
				</label>
				<label className="inline-field">รอบปีบัญชีสิ้นสุด
					<select id="cp-fye" defaultValue={fyeDefault} onChange={(e) => { draft.current.fye = e.target.value; }}>
						{fyeOptions.map((o) => <option value={o.label} key={o.label}>{o.label}</option>)}
					</select>
				</label>
				<label className="inline-field">สถานะลูกค้า
					<select id="cp-status" defaultValue={c.status} onChange={(e) => { draft.current.status = e.target.value; }}>
						{Object.keys(CUSTOMER_STATUS_LABEL).map((k) => <option value={k} key={k}>{CUSTOMER_STATUS_LABEL[k]}</option>)}
					</select>
				</label>
			</div>
			<div className="inline-grid" style={{ marginTop: "8px" }}>
				<label className="inline-field grow">LINE กลุ่ม
					<input id="cp-line" type="text" defaultValue={c.lineGroupId || ""} placeholder="ไม่บังคับ" onChange={(e) => { draft.current.line = e.target.value; }} />
				</label>
				<label className="inline-field grow">หมายเหตุ
					<input id="cp-note" type="text" defaultValue={c.note || ""} placeholder="ไม่บังคับ" onChange={(e) => { draft.current.note = e.target.value; }} />
				</label>
			</div>
			<div className="inline-grid" style={{ marginTop: "10px" }}>
				<button type="button" className="btn btn-run" onClick={submit}>บันทึกข้อมูลลูกค้า</button>
				<button type="button" className="btn btn-ghost" onClick={() => { ui.profileFormOpen = null; bump(); }}>ยกเลิก</button>
			</div>
			<p className="inline-note">"จดทะเบียน VAT" มีผลกับเช็กลิสต์จริง — เกทของกลุ่มรายปีสองข้อระบุ "(ถ้าจด VAT)" ไว้ในตัวมันเอง ส่วน "รอบปีบัญชีสิ้นสุด" เป็นตัวกำหนดว่างวดของแพ็กเกจรายปีตกเดือนไหน</p>
		</div>
	);
}

export function CustomerProfile({ id }: { id: string }) {
	const { bump } = useApp();
	const c = CUSTOMERS[id];
	if (ui.profileFormOpen === id) return <ProfileForm id={id} />;

	const jobTypeNames: string[] = [];
	let served = customerPackages(id).filter((k) => !k.endedAt).map((k) => k.jobType);
	if (!served.length) served = projectsForCustomer(id).map((p) => p.jobType);
	served.forEach((key) => {
		const n = jobTypeByKey(key)!.name;
		if (jobTypeNames.indexOf(n) === -1) jobTypeNames.push(n);
	});
	return (
		<>
			<Kv k="รหัสลูกค้า" value={c.code} />
			<Kv k="ชื่อจดทะเบียน" value={c.legalName} />
			<Kv k="เลขผู้เสียภาษี" value={c.taxId || "ไม่มี (บุคคลธรรมดา)"} muted={!c.taxId} />
			{/* Two Gates in the yearly checklist are literally conditioned on
			    "(ถ้าจด VAT)", so this is a field the checklist itself needs. */}
			<Kv
				k="จดทะเบียน VAT"
				value={c.vatRegistered ? "จดแล้ว — เกท ภ.พ.30 / รายงานภาษีซื้อ-ขาย ใช้บังคับ" : "ยังไม่จด — ข้ามเกทที่ระบุ (ถ้าจด VAT)"}
				muted={!c.vatRegistered}
			/>
			<Kv k="ลักษณะธุรกิจ" value={c.businessNature} />
			<Kv k="รอบปีบัญชีสิ้นสุด" value={c.fiscalYearEnd} />
			<Kv k="สถานะลูกค้า" value={CUSTOMER_STATUS_LABEL[c.status]} />
			<Kv k="เข้าเป็นลูกค้าตั้งแต่" value={c.onboardedAt} />
			<Kv k="ประเภทงานที่ให้บริการ" value={jobTypeNames.length ? jobTypeNames.join(" · ") : "ยังไม่มีแพ็กเกจที่ใช้งานอยู่"} muted={!jobTypeNames.length} />
			<Kv k="LINE กลุ่ม" value={c.lineGroupId || "ยังไม่ได้ผูกกลุ่ม"} muted={!c.lineGroupId} />
			<Kv k="หมายเหตุ" value={c.note || "—"} muted={!c.note} />
			<div style={{ marginTop: "10px" }}>
				<button type="button" className="btn btn-ghost" onClick={() => { ui.profileFormOpen = id; bump(); }}>แก้ไขข้อมูลลูกค้า</button>
			</div>
		</>
	);
}

export function CustomerContacts({ id }: { id: string }) {
	const c = CUSTOMERS[id];
	if (c.contacts.length === 0) {
		return <div className="all-clear"><CheckCircleIcon />ยังไม่ได้บันทึกผู้ติดต่อของลูกค้ารายนี้</div>;
	}
	return (
		<>
			{c.contacts.map((ct, i) => (
				<div className="contact-row" key={i}>
					<div className="contact-main">
						<span className="contact-name">
							{ct.name}
							{ct.isPrimary ? <> <span className="pill job-type-pill">ผู้ติดต่อหลัก</span></> : null}
						</span>
						<span className="contact-role">{ct.role}</span>
					</div>
					<div className="contact-meta">
						{ct.phone ? ct.phone : "—"}
						{ct.email ? " · " + ct.email : ""}
						{ct.lineId ? " · LINE " + ct.lineId : ""}
					</div>
				</div>
			))}
		</>
	);
}
