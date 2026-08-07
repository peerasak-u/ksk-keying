// ---- the stand-in document. Drawn as the document it stands for, so the
// left pane behaves the way the real one does — you read it, then correct
// the form beside it.
import { wfMoney } from "../../domain/runData";
import { ui } from "../../state/ui";
import type { RunItem } from "./runModel";

export function RunPaper({ x }: { x: RunItem }) {
	const g = x.g, f = g.facts;
	const style = { transform: "scale(" + ui.runZoom + ")" };

	if (g.isBank) {
		const opening = f.opening_balance as number;
		return (
			<div className="docpaper" style={style}>
				<div className="docpaper-head">
					<div className="docpaper-seller">{f.bank}</div>
					<div className="docpaper-sub">{f.account_holder} · เลขที่บัญชี {f.account_no}</div>
					<div className="docpaper-title">STATEMENT / รายการเดินบัญชี</div>
				</div>
				<div className="docpaper-meta">
					<div>งวด<b>{f.period}</b></div>
					<div>ยอดยกมา<b>{wfMoney(opening)}</b></div>
					<div>ยอดคงเหลือปลายงวด<b>{wfMoney(f.closing_balance as number)}</b></div>
				</div>
				<table>
					<thead>
						<tr><th>วันที่</th><th>รายการ</th><th className="num">ถอน</th><th className="num">ฝาก</th><th className="num">คงเหลือ</th></tr>
					</thead>
					<tbody>
						{g.lines.map((l, i) => {
							const bal = opening + g.lines.slice(0, i + 1).reduce(function (n, y) {
								return n + (y.direction === "เงินเข้า" ? y.amount : -y.amount);
							}, 0);
							return (
								<tr key={i}>
									<td>{l.date}</td>
									<td>{l.desc}</td>
									<td className="num">{l.direction === "เงินออก" ? wfMoney(l.amount) : ""}</td>
									<td className="num">{l.direction === "เงินเข้า" ? wfMoney(l.amount) : ""}</td>
									<td className="num">{wfMoney(Math.round(bal * 100) / 100)}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
				<div className="docpaper-foot">{g.src} · {g.pages} หน้า</div>
			</div>
		);
	}

	return (
		<div className="docpaper" style={style}>
			<div className="docpaper-head">
				<div className="docpaper-seller">{f.seller}</div>
				<div className="docpaper-sub">เลขประจำตัวผู้เสียภาษี {f.seller_tax_id || "—"}</div>
				<div className="docpaper-title">{f.vat_treatment === "vat_7" ? "ใบกำกับภาษี / ใบเสร็จรับเงิน" : "ใบเสร็จรับเงิน"}</div>
			</div>
			<div className="docpaper-meta">
				<div>เลขที่เอกสาร<b>{f.document_no}</b></div>
				<div>วันที่<b>{f.date}</b></div>
				<div>ลูกค้า<b>{f.buyer}</b></div>
			</div>
			<table>
				<thead>
					<tr><th>รายการ</th><th className="num">จำนวน</th><th className="num">ราคา/หน่วย</th><th className="num">จำนวนเงิน</th></tr>
				</thead>
				<tbody>
					{g.lines.map((l, i) => (
						<tr key={i}>
							<td>{l.desc}</td>
							<td className="num">1</td>
							<td className="num">{wfMoney(l.amount)}</td>
							<td className="num">{wfMoney(l.amount)}</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className="docpaper-totals">
				<div><span>ยอดก่อนภาษี</span><span>{wfMoney(f.subtotal as number)}</span></div>
				<div><span>ภาษีมูลค่าเพิ่ม 7%</span><span>{wfMoney(f.vat as number)}</span></div>
				<div className="grand"><span>ยอดรวมทั้งสิ้น</span><span>{wfMoney(f.total as number)}</span></div>
			</div>
			<div className="docpaper-foot">{g.src} · {g.pages} หน้า</div>
		</div>
	);
}
