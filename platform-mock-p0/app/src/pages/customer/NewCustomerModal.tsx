// ================= taking on a new customer (round 17) =================
//
// The form asks ONLY what an office genuinely has at the moment a customer
// signs. Everything else in the customer schema — เลขผู้เสียภาษี, จด VAT,
// รอบปีบัญชี, LINE กลุ่ม, หมายเหตุ — is filled in afterwards on the customer
// page, which is where that field set is defined.
//
// Round 18: this is a dialog rather than a block that unfolds into the
// ลูกค้า screen. The list of 113 stays visible behind it, and saving closes
// the dialog and carries straight on to their package.
import { useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { CUSTOMERS } from "../../state/stores";
import { showToast } from "../../state/session";
import { useApp } from "../../state/AppContext";
import { ui } from "../../state/ui";
import { paths } from "../../navigation";
import { TODAY } from "../../domain/dates";

// The office's own running code, continued — not a random id.
function nextCustomerCode() {
	var max = 0;
	Object.keys(CUSTOMERS).forEach(function (id) {
		var n = parseInt(CUSTOMERS[id].code, 10);
		if (!isNaN(n) && n > max) max = n;
	});
	return String(max + 1);
}

interface Draft { code: string; display: string; legal: string; nature: string; contact: string; phone: string }

export function useNewCustomerModal() {
	const { openModal, closeModal, bump } = useApp();
	const navigate = useNavigate();
	const draft = useRef<Draft>({ code: "", display: "", legal: "", nature: "", contact: "", phone: "" });

	const submit = useCallback(() => {
		const d = draft.current;
		const display = d.display.trim(), legal = d.legal.trim(), code = d.code.trim();
		if (!display) { showToast("ใส่ชื่อที่ใช้เรียกลูกค้าก่อน"); return; }
		if (!code) { showToast("ใส่รหัสลูกค้าก่อน"); return; }
		const clash = Object.keys(CUSTOMERS).filter((id) => CUSTOMERS[id].code === code)[0];
		if (clash) { showToast("รหัส " + code + " ถูกใช้แล้วโดย " + CUSTOMERS[clash].displayName); return; }
		let id = "cust-" + code;
		while (CUSTOMERS[id]) id += "x";
		CUSTOMERS[id] = {
			code: code, legalName: legal || display, displayName: display,
			// Left blank on purpose rather than defaulted to a fake number:
			// the customer page renders a missing tax id as "ไม่มี (บุคคลธรรมดา)"
			// already, and it is one of the fields filled in there afterwards.
			taxId: null,
			businessNature: d.nature.trim() || "ยังไม่ได้ระบุลักษณะธุรกิจ",
			status: "active", lineGroupId: null, note: "",
			onboardedAt: TODAY, vatRegistered: false, fiscalYearEnd: "31 ธันวาคม",
			// The list shows 113 customers 25 at a time, so a customer taken on
			// just now would otherwise land past the fold and read as lost.
			addedNow: true,
			packages: [],
			contacts: d.contact.trim() || d.phone.trim()
				? [{ name: d.contact.trim() || "ผู้ประสานงานฝ่ายบัญชี", role: "ผู้ติดต่อหลัก", phone: d.phone.trim() || null, email: null, lineId: null, isPrimary: true }]
				: [],
		} as (typeof CUSTOMERS)[string];
		closeModal();
		// Straight into attaching what they bought — the next thing that has to
		// happen, with the form already open rather than one more button away.
		ui.pkgFormCustomer = id; ui.pkgFormId = null;
		showToast("รับ " + display + " เป็นลูกค้าแล้ว — ผูกแพ็กเกจงานที่ซื้อไว้ต่อได้เลย");
		bump();
		navigate(paths.customerDetail(id));
	}, [closeModal, bump, navigate]);

	return useCallback(() => {
		draft.current = { code: nextCustomerCode(), display: "", legal: "", nature: "", contact: "", phone: "" };
		openModal({
			title: "รับลูกค้าใหม่",
			sub: "ถามเท่าที่สำนักงานมีข้อมูลตอนลูกค้าเซ็น",
			render: () => ({
				// Six fields, two of which are the same name twice — the form
				// stayed exactly as round 17 sized it, which is what lets the
				// dialog fit a laptop screen without becoming a scroll of its own.
				body: (
					<>
						<div className="inline-grid">
							<label className="inline-field">รหัสลูกค้า
								<input id="nc-code" type="text" defaultValue={draft.current.code} onChange={(e) => { draft.current.code = e.target.value; }} />
							</label>
							<label className="inline-field grow">ชื่อที่ใช้เรียก
								<input id="nc-display" type="text" placeholder="เช่น บจก. ขอนแก่นพาณิชย์" onChange={(e) => { draft.current.display = e.target.value; }} />
							</label>
						</div>
						<div className="inline-grid">
							<label className="inline-field grow">ชื่อจดทะเบียน
								<input id="nc-legal" type="text" placeholder="เช่น บริษัท ขอนแก่นพาณิชย์ จำกัด" onChange={(e) => { draft.current.legal = e.target.value; }} />
							</label>
						</div>
						<div className="inline-grid">
							<label className="inline-field grow">ลักษณะธุรกิจ
								<input id="nc-nature" type="text" placeholder="เช่น ค้าส่ง–ค้าปลีกในจังหวัด" onChange={(e) => { draft.current.nature = e.target.value; }} />
							</label>
						</div>
						<div className="inline-grid">
							<label className="inline-field grow">ผู้ติดต่อหลัก
								<input id="nc-contact" type="text" placeholder="เช่น ฝ่ายบัญชี" onChange={(e) => { draft.current.contact = e.target.value; }} />
							</label>
							<label className="inline-field">เบอร์ติดต่อ
								<input id="nc-phone" type="text" placeholder="0X-XXX-XXXX" onChange={(e) => { draft.current.phone = e.target.value; }} />
							</label>
						</div>
						<p className="inline-note">
							เลขผู้เสียภาษี การจด VAT รอบปีบัญชี และ LINE กลุ่ม กรอกทีหลังได้ที่การ์ด "ข้อมูลลูกค้า" ในหน้าลูกค้ารายนี้
							บันทึกแล้วจะพาไปหน้าลูกค้าพร้อมเปิดฟอร์มแพ็กเกจให้ทันที เพราะแพ็กเกจคือสิ่งที่ทำให้งวดแรกเกิดขึ้น
						</p>
					</>
				),
				actions: (
					<>
						<button type="button" className="btn btn-run" onClick={submit}>รับเป็นลูกค้า แล้วไปผูกแพ็กเกจ</button>
						<button type="button" className="btn btn-ghost" onClick={closeModal}>ยกเลิก</button>
					</>
				),
			}),
		});
	}, [openModal, closeModal, submit]);
}
