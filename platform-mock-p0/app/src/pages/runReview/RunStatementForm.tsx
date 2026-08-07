// ---- the statement-shaped form, for the bank_statement bucket.
import { WF_COA_BANK } from "../../data/runTables";
import { wfMoney } from "../../domain/runData";
import type { RunItem } from "./runModel";
import type { RunActions } from "./useRunActions";
import { RunFlags, RunReviewerControls, RunStatusPill } from "./formParts";

export function RunStatementForm({ x, actions }: { x: RunItem; actions: RunActions }) {
	const g = x.g, f = g.facts;
	const coa = WF_COA_BANK;

	return (
		<section className="form-card">
			<h3>{g.label} <RunStatusPill status={g.status} /></h3>
			<p className="form-sub">
				{x.bucket.path}/{g.id} <span className="pill job-type-pill">{x.bucket.label}</span>
			</p>
			<RunFlags g={g} />
			<div className="doc-meta">
				<div className="doc-meta-col">
					<div><label>ธนาคาร</label><input value={String(f.bank)} readOnly /></div>
					<div><label>เลขที่บัญชี</label><input value={String(f.account_no)} readOnly /></div>
					<div><label>ชื่อบัญชี</label><input value={String(f.account_holder)} readOnly /></div>
				</div>
				<div className="doc-meta-col">
					<div><label>ยอดยกมา</label><input value={wfMoney(f.opening_balance as number)} readOnly /></div>
					<div><label>ยอดคงเหลือปลายงวด</label><input value={wfMoney(f.closing_balance as number)} readOnly /></div>
					<div><label>บัญชีธนาคาร (ผังบัญชี GL)</label><input value="111301 เงินฝากออมทรัพย์" readOnly /></div>
				</div>
			</div>
			<div className="form-section">
				<div className="section-head"><h4>รายการเดินบัญชี</h4></div>
				<div className="stm-table-wrap">
					<table className="stm-table">
						<thead>
							<tr>
								<th>#</th><th>วันที่</th><th>รายการ / คู่โอน</th>
								<th className="num">เงินเข้า</th><th className="num">เงินออก</th><th className="stm-coa">ผังบัญชี</th>
							</tr>
						</thead>
						<tbody>
							{g.lines.map((l, i) => (
								<tr className={l.needsReview ? "row-warn" : ""} key={i + "|" + l.code + "|" + l.desc + "|" + l.amount}>
									<td>{i + 1}</td>
									<td>{l.date}</td>
									<td>
										<input defaultValue={l.desc} onBlur={(e) => actions.runSetLine(i, "desc", e.target.value)} />
										<span className="stm-why">
											{(l.needsReview ? "ต้องตรวจสอบ · " : "") + "ความมั่นใจ " + l.confidence + " — " + l.reason}
										</span>
									</td>
									<td className="num">{l.direction === "เงินเข้า" ? wfMoney(l.amount) : ""}</td>
									<td className="num">{l.direction === "เงินออก" ? wfMoney(l.amount) : ""}</td>
									<td className="stm-coa">
										<select value={l.code} onChange={(e) => actions.runSetLine(i, "account", e.target.value)}>
											{coa.map((o, oi) => <option value={o[0]} key={o[0] + "-" + oi}>{o[0] + " " + o[1]}</option>)}
										</select>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
			<RunReviewerControls g={g} actions={actions} />
			{/* Round 19: บันทึกและถัดไป is no longer the last thing at the foot
			    of this form (which put it below the fold on a laptop). It is in
			    the flow's sticky action bar, in the same slot as step 1's decision. */}
		</section>
	);
}
