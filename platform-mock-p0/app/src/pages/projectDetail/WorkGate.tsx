// One Gate row of the checklist, and the rest of the sheet's columns inline
// under it — never a modal.
import type { ReactNode } from "react";
import type { Project } from "../../types";
import { ACTOR_CUSTOMER } from "../../data/jobTypes";
import { session } from "../../state/session";
import { useApp } from "../../state/AppContext";
import { ui } from "../../state/ui";
import { AlertIcon, ChevronIcon, LinkIcon, LockIcon, StepperCheckIcon } from "../../components/Icons";
import { TODAY, daysUntil, fmtDate } from "../../domain/dates";
import { dueRuleText, gateDueDate, gateEvidenceFrom, jobTypeByKey } from "../../domain/jobTypes";
import { allUserNames, canReview } from "../../domain/people";
import { getRun } from "../../domain/runs";
import { workflowByKey } from "../../data/workflows";
import {
	STATUS_DOING,
	STATUS_DONE,
	STATUS_ORDER,
	expectedReviewer,
	gateAwaitingReview,
	gateClosed,
	gateRecord,
} from "../../domain/work";
import { commonFreq, gateKey, setGateField, signOffGate, toggleGateNoDocs, toggleGateTick } from "../../domain/gateActions";
import { useOpenRunReview } from "../../navigation";

// The machine evidence behind one Gate, stated in the row where the person
// is about to tick it: which workflow, what it reported, and — every time —
// that the tick and the signature are still theirs to give.
function GateEvidence({ p, pi, gi }: { p: Project; pi: number; gi: number }) {
	const openRunReview = useOpenRunReview();
	const g = jobTypeByKey(p.jobType)!.phases[pi].gates[gi];
	const atts = gateEvidenceFrom(p, pi, g.code);
	if (!atts.length) return null;
	return (
		<>
			{atts.map((att) => {
				const wf = workflowByKey(att.key)!;
				const run = getRun(p.id, pi, att.key);
				const line = !run ? "ยังไม่เคยรันในงวดนี้ — ติ๊กเองได้ตามปกติ"
					: run.state === "done" ? "รอบที่ " + run.no + " เสร็จ " + run.finishedAt + " — เปิดผลได้ที่แถบเวิร์กโฟลว์ด้านบนของเฟสนี้"
					: run.state === "failed" ? "รอบที่ " + run.no + " ไม่สำเร็จ — ยังติ๊กเองได้ ไม่ต้องรอรันใหม่"
					: "รอบที่ " + run.no + " กำลังรันอยู่ — ไม่ต้องรอ ติ๊กเองได้";
				return (
					<div className="wf-evidence" style={{ borderTop: "none", paddingTop: 0 }} key={att.key}>
						<LinkIcon />
						<span>
							<strong>{wf.name}</strong> — {line}
							{run && run.state === "done" ? (
								<>
									{" "}
									<button
										type="button"
										className="btn btn-ghost"
										style={{ padding: "3px 9px", fontSize: "11px" }}
										onClick={() => openRunReview(p.id, pi, att.key, run.no)}
									>
										เปิดผลการรัน
									</button>
								</>
							) : null}
							<br />ผลจากระบบเป็นหลักฐานประกอบเท่านั้น ผู้ทำและผู้สอบทานยังต้องเป็นคน
						</span>
					</div>
				);
			})}
		</>
	);
}

function GateDetail({ p, pi, gi, editable }: { p: Project; pi: number; gi: number; editable: boolean }) {
	const rec = gateRecord(p, pi, gi);
	const me = session.currentUserName || "";
	const mayReview = editable && canReview(me);
	const selfDone = rec.doer === me;
	const g = jobTypeByKey(p.jobType)!.phases[pi].gates[gi];

	const people = (value: string | null, includeAll: boolean) => (
		<>
			<option value="">—</option>
			{allUserNames().filter((n) => includeAll || canReview(n)).map((n) => <option value={n} key={n}>{n}</option>)}
			{/* A name recorded on the Gate whose person has since left the office
			    still has to be selectable-as-current, so the record keeps reading
			    the way it was signed. */}
			{value && allUserNames().indexOf(value) === -1 ? <option value={value}>{value}</option> : null}
		</>
	);

	// Round 20: the second way a customer-facing Gate can end. It is not a
	// new widget and not a fourth สถานะ — it sets the same สถานะ เสร็จ the
	// tick sets, writes the same หมายเหตุ field, and still has to be signed
	// by a ผู้สอบทาน like anything else.
	const noDocsBtn = editable && g.actor === ACTOR_CUSTOMER ? (
		<button type="button" className="btn btn-ghost" onClick={() => toggleGateNoDocs(p.id, pi, gi)}>
			{rec.noDocs ? "ยกเลิก — ลูกค้ามีเอกสารส่งให้" : "ปิดเกทนี้: ลูกค้าไม่มีเอกสารให้"}
		</button>
	) : null;

	let signBtn: ReactNode = null;
	if (rec.status === STATUS_DONE && !rec.reviewer) {
		if (!mayReview) signBtn = <span className="work-gate-hint"><LockIcon />บทบาทของคุณเซ็นผู้สอบทานไม่ได้</span>;
		else if (selfDone) signBtn = <span className="work-gate-hint"><LockIcon />คุณเป็นผู้ทำข้อนี้เอง — ผู้สอบทานต้องเป็นคนละคน</span>;
		else signBtn = (
			<button type="button" className="btn btn-run" onClick={() => signOffGate(p.id, pi, gi)}>
				เซ็นสอบทานข้อนี้ (ผู้สอบทาน: {me})
			</button>
		);
	}

	return (
		<div className="work-gate-detail">
			<div className="work-gate-fields">
				<label className="field"><span>ผู้ทำ</span>
					<select value={rec.doer || ""} onChange={(e) => setGateField(p.id, pi, gi, "doer", e.target.value)} disabled={!editable}>
						{people(rec.doer, true)}
					</select>
				</label>
				<label className="field"><span>ผู้สอบทาน</span>
					<select value={rec.reviewer || ""} onChange={(e) => setGateField(p.id, pi, gi, "reviewer", e.target.value)} disabled={!mayReview}>
						{people(rec.reviewer, false)}
					</select>
				</label>
				<label className="field"><span>วันที่เสร็จ</span>
					<input
						type="text"
						placeholder={TODAY}
						defaultValue={rec.doneAt || ""}
						key={rec.doneAt || ""}
						onChange={(e) => setGateField(p.id, pi, gi, "doneAt", e.target.value)}
						disabled={!editable}
					/>
				</label>
				<label className="field"><span>สถานะ</span>
					<select value={rec.status} onChange={(e) => setGateField(p.id, pi, gi, "status", e.target.value)} disabled={!editable}>
						{STATUS_ORDER.map((s) => <option value={s} key={s}>{s}</option>)}
					</select>
				</label>
			</div>
			<label className="field work-gate-note-field"><span>หมายเหตุ</span>
				<input
					type="text"
					placeholder="เช่น รอเอกสารเพิ่มจากลูกค้า"
					defaultValue={rec.note || ""}
					key={rec.note || ""}
					onChange={(e) => setGateField(p.id, pi, gi, "note", e.target.value)}
					disabled={!editable}
				/>
			</label>
			{noDocsBtn || signBtn ? <div className="work-gate-signoff">{noDocsBtn}{signBtn}</div> : null}
			{rec.noDocs ? (
				<p className="work-gate-hint attn">
					<AlertIcon />
					ปิดเพราะลูกค้าไม่มีเอกสารให้ — ไม่ใช่เพราะเก็บเอกสารได้ครบ · หน้าภาพรวมสำนักงานจะนับงวดนี้อยู่ในกลุ่ม “ขอแล้วลูกค้าไม่มีเอกสาร” ที่ต้องตัดสินใจ ไม่ใช่กลุ่มที่ทวงต่อ
				</p>
			) : null}
			<GateEvidence p={p} pi={pi} gi={gi} />
		</div>
	);
}

export function WorkGate({ p, pi, gi, editable }: { p: Project; pi: number; gi: number; editable: boolean }) {
	const { bump } = useApp();
	const g = jobTypeByKey(p.jobType)!.phases[pi].gates[gi];
	const rec = gateRecord(p, pi, gi);
	const closed = gateClosed(rec);
	const awaiting = gateAwaitingReview(rec);
	const key = gateKey(pi, gi);
	const expanded = ui.openGateKey === key;

	const tickClass = closed ? "closed" : awaiting ? "awaiting" : rec.status === STATUS_DOING ? "doing" : "";

	const meta: string[] = [];
	// The workbook repeats the same ความถี่ down almost every row, so printing
	// it on all 37 of them would be noise. Only the exceptions are shown.
	if (g.freq && g.freq !== commonFreq(p.jobType)) meta.push("ความถี่: " + g.freq);
	// The Gate's own due RULE, and the date it works out to for this งวด.
	const dueDate = gateDueDate(p, g);
	if (dueDate && !closed) {
		const dd = daysUntil(dueDate);
		meta.push("กำหนด " + fmtDate(dueDate) + " (" + dueRuleText(g.due) + ")" +
			(dd < 0 ? " — เลยกำหนด " + -dd + " วัน" : dd <= 7 ? " — อีก " + dd + " วัน" : ""));
	}
	if (g.note) meta.push(g.note);

	const chips: ReactNode[] = [];
	// Which rung of the review ladder it is sitting on, on the row itself.
	if (awaiting) {
		const at = expectedReviewer(p, pi, gi);
		chips.push(<span className="pill pill-waiting" key="await">รอ {at.name} ({at.rungLabel})</span>);
	} else if (closed) chips.push(<span className="pill pill-passed" key="closed">เสร็จ · สอบทานแล้ว</span>);
	else if (rec.status === STATUS_DOING) chips.push(<span className="pill pill-doing" key="doing">กำลังทำ</span>);
	// A Gate that ended because there was nothing to collect reads differently
	// from one that ended because everything came in.
	if (rec.noDocs) chips.push(<span className="pill pill-attention" key="nodocs">ลูกค้าไม่มีเอกสาร</span>);
	if (g.required === false) chips.push(<span className="pill pill-optional" key="opt">ไม่บังคับ</span>);
	// Whose court the ball is in, on the row itself.
	if (g.actor === ACTOR_CUSTOMER && !closed && !awaiting && !rec.noDocs) {
		chips.push(<span className="pill pill-optional" key="cust">รอฝั่งลูกค้า</span>);
	}
	// This Gate has a machine result standing behind it as evidence. A label on
	// the row, never a substitute for the tick.
	const evAtts = gateEvidenceFrom(p, pi, g.code);
	if (evAtts.length) {
		const anyDone = evAtts.some((a) => (getRun(p.id, pi, a.key) || { state: "" }).state === "done");
		chips.push(<span className="pill pill-auto" key="auto"> {anyDone ? "มีผลจากระบบอัตโนมัติ" : "มีเวิร์กโฟลว์รองรับ"}</span>);
	}

	const stamp: string[] = [];
	if (rec.doer) stamp.push("ผู้ทำ: " + rec.doer);
	if (rec.reviewer) stamp.push("ผู้สอบทาน: " + rec.reviewer);
	if (rec.doneAt) stamp.push("วันที่เสร็จ: " + rec.doneAt);

	return (
		<div className={"work-gate" + (expanded ? " expanded" : "") + (awaiting ? " awaiting" : "")}>
			<div className="work-gate-row">
				<button
					type="button"
					className={"work-gate-tick " + tickClass}
					onClick={editable ? () => toggleGateTick(p.id, pi, gi) : undefined}
					disabled={!editable}
					title={closed || awaiting ? "ยกเลิกการติ๊ก" : "ติ๊กว่าทำเสร็จแล้ว"}
				>
					{closed || awaiting ? <StepperCheckIcon /> : null}
				</button>
				<button
					type="button"
					className="work-gate-body"
					onClick={() => { ui.openGateKey = ui.openGateKey === key ? null : key; bump(); }}
				>
					<span className="work-gate-name">
						<span className="work-gate-code">{g.code}</span> {g.name} {chips}
					</span>
					{meta.length ? <span className="work-gate-meta">{meta.join(" · ")}</span> : null}
					{stamp.length ? <span className="work-gate-stamp">{stamp.join(" · ")}</span> : null}
					{rec.note ? <span className="work-gate-usernote">หมายเหตุ: {rec.note}</span> : null}
				</button>
				<ChevronIcon />
			</div>
			{expanded ? <GateDetail p={p} pi={pi} gi={gi} editable={editable} /> : null}
		</div>
	);
}
