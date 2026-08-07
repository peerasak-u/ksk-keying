// ---- the invoice-shaped form: the real page's field order, section by
// section.
import { wfMoney } from "../../domain/runData";
import { AlertIcon, PlusIcon, TrashIcon } from "../../components/Icons";
import type { RunItem } from "./runModel";
import { runCoaFor } from "./runModel";
import type { RunActions } from "./useRunActions";
import { RunField, RunFlags, RunReviewerControls, RunStatusPill } from "./formParts";

export function RunDocForm({ x, actions }: { x: RunItem; actions: RunActions }) {
	const g = x.g, f = g.facts;
	const coa = runCoaFor(x.bucket.key);

	return (
		<section className="form-card">
			<h3>
				{g.label} <RunStatusPill status={g.status} />
				{g.skipped ? <> <span className="pill pill-optional">ไม่ใช้</span></> : null}
			</h3>
			<p className="form-sub">
				{x.bucket.path}/{g.id} <span className="pill job-type-pill">{x.bucket.label}</span>
			</p>
			<RunFlags g={g} />
			<div className="doc-meta">
				<div className="doc-meta-col">
					<RunField label="วันที่" field="date" value={f.date} actions={actions} />
					<RunField label="ผู้ขาย" field="seller" value={f.seller} actions={actions} />
					<RunField label="ผู้ซื้อ" field="buyer" value={f.buyer} actions={actions} />
					<RunField
						label="การจัดการ VAT"
						field="vat_treatment"
						value={f.vat_treatment}
						select={[["vat_7", "VAT 7%"], ["non_vat", "ไม่มี VAT"], ["unknown", "ไม่ทราบ"]]}
						actions={actions}
					/>
				</div>
				<div className="doc-meta-col">
					<RunField label="เลขที่เอกสาร" field="document_no" value={f.document_no} actions={actions} />
					<RunField label="เลขประจำตัวผู้เสียภาษีผู้ขาย" field="seller_tax_id" value={f.seller_tax_id} actions={actions} />
					<RunField label="เลขประจำตัวผู้เสียภาษีผู้ซื้อ" field="buyer_tax_id" value={f.buyer_tax_id} actions={actions} />
				</div>
			</div>
			<div className="form-section">
				<div className="section-head">
					<h4>รายการ</h4>
					<button type="button" className="btn btn-ghost btn-with-icon" onClick={actions.runAddLine}>
						<PlusIcon />เพิ่มรายการ
					</button>
				</div>
				<div className="items-list">
					{g.lines.map((l, i) => (
						<div className={"line-card" + (l.needsReview ? " attention" : "")} key={i + "|" + l.code + "|" + l.desc + "|" + l.amount}>
							<div className="line-row">
								<div className="line-coa">
									<label>ผังบัญชี</label>
									<select value={l.code} onChange={(e) => actions.runSetLine(i, "account", e.target.value)}>
										{coa.map((o, oi) => <option value={o[0]} key={o[0] + "-" + oi}>{o[0] + " " + o[1]}</option>)}
									</select>
								</div>
								<div className="line-desc">
									<label>รายละเอียด</label>
									<input defaultValue={l.desc} onBlur={(e) => actions.runSetLine(i, "desc", e.target.value)} />
								</div>
								<div className="amount">
									<label>ยอด</label>
									<input defaultValue={wfMoney(l.amount)} onBlur={(e) => actions.runSetLine(i, "amount", e.target.value)} />
								</div>
								<button type="button" className="line-remove" onClick={() => actions.runRemoveLine(i)} title="ลบรายการ">
									<TrashIcon />
								</button>
							</div>
							<div className="line-why">
								<AlertIcon />
								<span>{(l.needsReview ? "ต้องตรวจสอบ · " : "") + "ความมั่นใจ " + l.confidence + " — " + l.reason}</span>
							</div>
						</div>
					))}
				</div>
			</div>
			<div className="summary-row">
				<div key={"subtotal-" + wfMoney(f.subtotal as number)}>
					<label>ยอดก่อนภาษี</label>
					<input defaultValue={wfMoney(f.subtotal as number)} onBlur={(e) => actions.runSetFact("subtotal", e.target.value)} />
				</div>
				<div key={"total-" + wfMoney(f.total as number)}>
					<label>ยอดรวม</label>
					<input defaultValue={wfMoney(f.total as number)} onBlur={(e) => actions.runSetFact("total", e.target.value)} />
				</div>
			</div>
			<details>
				<summary>ฟิลด์อื่นๆ</summary>
				<div className="grid">
					<RunField label="อ้างอิง" field="reference" value={f.reference} actions={actions} />
					<RunField label="ภาษีมูลค่าเพิ่ม" field="vat" value={wfMoney(f.vat as number)} key={"vat-" + wfMoney(f.vat as number)} actions={actions} />
					<RunField label="ชำระแล้ว" field="paid" value={wfMoney(f.paid as number)} actions={actions} />
					<RunField label="หัก ณ ที่จ่าย (ตามเอกสาร)" field="wht" value={f.wht == null ? "" : wfMoney(f.wht as number)} actions={actions} />
				</div>
			</details>
			<RunReviewerControls g={g} actions={actions} />
			{/* Round 19: บันทึกและถัดไป is no longer the last thing at the foot
			    of this form (which put it below the fold on a laptop). It is in
			    the flow's sticky action bar, in the same slot as step 1's decision. */}
		</section>
	);
}
