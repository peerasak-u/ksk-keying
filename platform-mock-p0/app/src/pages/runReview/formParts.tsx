// The pieces both right-hand forms share: the status pill, one labelled
// field of the invoice form, the run's own review_flags, and the
// บัญชี / ตัวควบคุมผู้ตรวจ block at the foot.
//
// Every field here is uncontrolled with an `onBlur` commit, which is what the
// legacy markup's `onchange="…"` actually meant: the model is written when a
// person leaves the field, never on every keystroke. Where the model value can
// change underneath a mounted field (a line's ยอด rewrites ยอดก่อนภาษี /
// ภาษีมูลค่าเพิ่ม / ยอดรวม), the caller passes a React `key` carrying that
// value so the field is remounted with it — the same trick the Gate sheet uses.
import type { RunGroup } from "../../types";
import { AlertIcon } from "../../components/Icons";
import type { RunActions } from "./useRunActions";

export function RunStatusPill({ status }: { status: string }) {
	return status === "needs_attention"
		? <span className="pill pill-attention">ต้องตรวจสอบ</span>
		: <span className="pill pill-reviewed">ตรวจแล้ว</span>;
}

// ---- the invoice-shaped form: the real page's field order, section by
// section.
export function RunField({ label, field, value, select, actions }: {
	label: string;
	field: string;
	value: string | number | null | undefined;
	select?: [string, string][];
	actions: RunActions;
}) {
	if (select) {
		return (
			<div>
				<label>{label}</label>
				<select value={value == null ? "" : String(value)} onChange={(e) => actions.runSetFactAndRepaint(field, e.target.value)}>
					{select.map((o) => <option value={o[0]} key={o[0]}>{o[1]}</option>)}
				</select>
			</div>
		);
	}
	return (
		<div>
			<label>{label}</label>
			<input defaultValue={value == null ? "" : String(value)} onBlur={(e) => actions.runSetFact(field, e.target.value)} />
		</div>
	);
}

export function RunFlags({ g }: { g: RunGroup }) {
	if (!g.flags.length) return null;
	return (
		<ul className="group-flags">
			{g.flags.map((fl) => <li key={fl}><AlertIcon /><span>{fl}</span></li>)}
		</ul>
	);
}

// ---- บัญชี / ตัวควบคุมผู้ตรวจ, and the save action. This is the reviewer's
// own record ON THE RUN — it is not, and never becomes, a Gate signature.
export function RunReviewerControls({ g, actions }: { g: RunGroup; actions: RunActions }) {
	return (
		<details open>
			<summary>บัญชี / ตัวควบคุมผู้ตรวจ</summary>
			<div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
				<div>
					<label>สถานะ</label>
					<select value={g.status} onChange={(e) => actions.runSetStatus(e.target.value)}>
						<option value="reviewed">ตรวจแล้ว</option>
						<option value="needs_attention">ต้องตรวจสอบ</option>
					</select>
				</div>
			</div>
			<label style={{ marginTop: "10px" }}>บันทึกผู้ตรวจ</label>
			<textarea
				placeholder="จำเป็นเมื่อสถานะต้องตรวจสอบ"
				defaultValue={g.note || ""}
				onBlur={(e) => actions.runSetNote(e.target.value)}
			/>
			<p className="checklist-legend" style={{ margin: "8px 0 0" }}>
				บันทึกนี้อยู่กับรอบการรัน ไม่ใช่การเซ็นเกท — เกทในเฟสยังต้องมีคนติ๊กและผู้สอบทานเซ็นตามเดิม
			</p>
		</details>
	);
}
