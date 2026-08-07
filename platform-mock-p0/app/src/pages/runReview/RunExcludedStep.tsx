// ---- step 1. Rebuilt from ตรวจทาน/ที่ถูกตัดออก.html: evidence on the left
// with the page and its reason, ‹ › to walk the list, and the list on the
// right grouped by reason with the same chips. A duplicate claim shows the
// page it duplicates beside it, because "ซ้ำ" alone never told the reviewer
// which page to compare against.
import type { ReactNode } from "react";
import type { RunExclusion } from "../../types";
import { WF_EXCLUDE_REASON_TH } from "../../data/runTables";
import { AlertIcon, ArrowRightIcon, BanIcon, RerunIcon } from "../../components/Icons";
import { ui } from "../../state/ui";
import type { RunCtx } from "./runModel";
import { runCurrentExcluded, runExcludedVisible, runPendingExcluded } from "./runModel";
import type { RunActions } from "./useRunActions";
import { RunActionBar } from "./RunActionBar";

export function RunExcludedStep({ c, actions }: { c: RunCtx; actions: RunActions }) {
	const d = c.d;
	const pending = runPendingExcluded(d);
	const confirmed = d.excluded.filter(function (e) { return e.decision === "confirmed"; }).length;
	const kept = d.excluded.filter(function (e) { return e.decision === "keep"; }).length;
	const list = runExcludedVisible(d);
	const cur = runCurrentExcluded(d);
	const reasons: Record<string, number> = {};
	d.excluded.forEach(function (e) { reasons[e.reason] = (reasons[e.reason] || 0) + 1; });

	const gate = pending ? (
		<div className="gate-note">
			<AlertIcon />
			<span>
				<b>ต้องตัดสินใจให้ครบก่อนจึงจะไปตรวจเอกสารต่อได้</b> — รายการที่ระบบเสนอตัดออกเป็น <b>ข้อเสนอ</b> เท่านั้น ยังไม่ใช่ข้อสรุป
				{" ถ้าไม่มีใครดู หน้าที่ถูกตัดผิดจะไม่ถูกคีย์และไม่มีใครรู้ตัว · เหลือ " + pending + " จาก " + d.excluded.length + " รายการ"}
			</span>
		</div>
	) : (
		// The "go to step 2" button used to live here as a second blue
		// button; round 19 moved it into the action bar's primary slot,
		// because once nothing is pending that IS the next thing to press.
		<div className="gate-clear">
			{"ตัดสินใจครบทั้ง " + d.excluded.length + " รายการแล้ว — ยืนยันตัดออก " + confirmed + " · ทำเครื่องหมายเอากลับ " + kept}
			<br />
			{kept
				? "หน้าที่ทำเครื่องหมายเอากลับจะกลับเข้ากระบวนการเมื่อรันรอบใหม่ (ไปป์ไลน์คลายการบล็อกด้วยหลักฐานใหม่ ไม่ใช่ด้วยการแก้บันทึก)"
				: "ทุกรายการถูกยืนยันตัดออกและบันทึกเป็น Exclusion Declaration ของมนุษย์"}
		</div>
	);

	const items: ReactNode[] = [];
	let lastReason: string | null = null;
	list.forEach((e, i) => {
		if (e.reason !== lastReason) {
			items.push(
				<div className="item-group-label" key={"label-" + e.reason}>
					{(WF_EXCLUDE_REASON_TH[e.reason] || e.reason) + " (" + reasons[e.reason] + ")"}
				</div>,
			);
			lastReason = e.reason;
		}
		const state = !e.decision ? "pending" : e.decision === "keep" ? "kept decided" : "decided";
		items.push(
			<button
				type="button"
				className={"item " + state + (i === ui.runExIndex ? " active" : "")}
				key={e.unit + "-" + i}
				onClick={() => actions.setRunExItem(i)}
			>
				<span className="item-icon">{e.decision === "keep" ? <RerunIcon /> : <BanIcon />}</span>
				<span className="item-main">
					<span className="item-file">{e.file}</span>
					<span className="item-meta">
						{"หน้า " + e.page + " · " + (WF_EXCLUDE_REASON_TH[e.reason] || e.reason) +
							(e.duplicate_of ? " · ซ้ำกับ " + e.duplicate_of.file + " หน้า " + e.duplicate_of.page : "")}
					</span>
				</span>
				<span className="item-toggle">{!e.decision ? "รอตัดสินใจ" : e.decision === "keep" ? "เอากลับ" : "ตัดออก"}</span>
			</button>,
		);
	});

	return (
		<>
			{gate}
			<div className="pane pane-excluded">
				<section className="evidence">
					<div className="evidence-head">
						<div className="titles">
							<h4>{cur ? cur.file : "—"}</h4>
							<div className={"reason-line" + (cur && cur.decision ? " kept" : "")}>
								{cur
									? cur.decision === "keep" ? "ทำเครื่องหมายว่าจะเอากลับเข้ากระบวนการแล้ว"
										: cur.decision === "confirmed" ? "ยืนยันตัดออกแล้ว (Exclusion Declaration ของมนุษย์)"
										: "หน้า " + cur.page + " · " + (WF_EXCLUDE_REASON_TH[cur.reason] || cur.reason) +
											(cur.duplicate_of ? " · ซ้ำกับ " + cur.duplicate_of.file + " หน้า " + cur.duplicate_of.page : "")
									: ""}
							</div>
						</div>
						{/* ‹ › moved into the action bar (round 19), so walking the
						    list and deciding a page happen in one fixed place
						    rather than at opposite ends of this column. */}
					</div>
					<div className="preview">
						<div className="preview-note">
							เอกสารจำลองสำหรับมอค — ในระบบจริงช่องนี้คือหน้าต้นฉบับที่ถูกเสนอตัดออก เปิดตรงหน้านั้น
						</div>
						{cur ? <RunExPreview e={cur} /> : <div className="docpaper-blank">ไม่มีรายการในหมวดนี้</div>}
						{cur ? <div className="page-anchor">หน้า {cur.page}</div> : null}
					</div>
					{/* The decide buttons used to sit here, at the foot of this
					    column, where their y position moved with the preview's
					    own height. They are in the action bar now. */}
				</section>
				<div className="pane-gutter"></div>
				<section className="list-card">
					<div className="list-head">
						<h4>
							{d.excluded.length} รายการที่ระบบเสนอตัดออก
							{pending ? <> <span className="pill pill-attention">{pending} รอตัดสินใจ</span></> : null}
						</h4>
						<p className="list-lead">
							คลิกแต่ละรายการเพื่อดูต้นฉบับทางซ้าย หรือใช้ปุ่ม ‹ › ไล่ดูทีละรายการ — ข้อเสนอของระบบยังไม่ใช่ข้อสรุป ต้องมีคนยืนยันตัดออก (บันทึกเป็น Exclusion Declaration ของมนุษย์) หรือสั่งเอากลับเข้ากระบวนการ ทีละรายการจนครบ
						</p>
						<div className="run-filters" style={{ margin: 0 }}>
							<button
								type="button"
								className={"doc-step" + (ui.runExFilter === "all" ? " on" : "")}
								onClick={() => actions.setRunExFilter("all")}
							>
								ทั้งหมด {d.excluded.length}
							</button>
							{Object.keys(reasons).map((r) => (
								<button
									type="button"
									className={"doc-step" + (ui.runExFilter === r ? " on" : "")}
									key={r}
									onClick={() => actions.setRunExFilter(r)}
								>
									{(WF_EXCLUDE_REASON_TH[r] || r) + " " + reasons[r]}
								</button>
							))}
						</div>
					</div>
					<div className="item-list">
						{items.length ? items : <p className="run-empty" style={{ padding: "0 10px" }}>ไม่มีรายการในหมวดนี้</p>}
					</div>
				</section>
			</div>
			<RunExcludedBar list={list} cur={cur} pending={pending} actions={actions} />
		</>
	);
}

// Step 1's slice of the shared bar. The primary slot carries the decision
// while anything is pending, and becomes "go to step 2" the moment nothing
// is — which is exactly the button somebody clearing a run wants next.
function RunExcludedBar({ list, cur, pending, actions }: {
	list: RunExclusion[];
	cur: RunExclusion | null;
	pending: number;
	actions: RunActions;
}) {
	const where = list.length ? (
		<>
			รายการที่ <b>{ui.runExIndex + 1}</b> จาก <b>{list.length}</b>
			{pending ? <> · เหลือ <b>{pending}</b> รอตัดสินใจ</> : " · ตัดสินใจครบแล้ว"}
		</>
	) : "ไม่มีรายการในหมวดนี้";

	let primary: ReactNode;
	let secondary: ReactNode = "";
	if (!pending) {
		primary = (
			<button type="button" className="btn btn-run" onClick={() => actions.setRunStep("documents")}>
				<ArrowRightIcon />ไปตรวจเอกสารที่จัดกลุ่มแล้ว
			</button>
		);
		// Still reversible once cleared — it just stops being the loudest
		// thing on the bar.
		if (cur) {
			secondary = (
				<button type="button" className="btn btn-ghost" onClick={() => actions.decideExcluded(cur.decision === "keep" ? "keep" : "confirmed")}>
					{cur.decision === "keep" ? "ยกเลิกการเอากลับ" : "ยกเลิกการยืนยัน"}
				</button>
			);
		}
	} else if (cur) {
		secondary = (
			<button type="button" className="btn btn-ghost" onClick={() => actions.decideExcluded("keep")}>
				{cur.decision === "keep" ? "ยกเลิกการเอากลับ" : "เอากลับเข้ากระบวนการ"}
			</button>
		);
		primary = (
			<button type="button" className={"btn " + (cur.decision === "confirmed" ? "btn-ghost" : "btn-run")} onClick={() => actions.decideExcluded("confirmed")}>
				{cur.decision === "confirmed" ? "ยกเลิกการยืนยัน" : "ยืนยันตัดออก"}
			</button>
		);
	} else {
		primary = <button type="button" className="btn btn-ghost" disabled>ยืนยันตัดออก</button>;
	}

	return (
		<RunActionBar
			where={where}
			onPrev={() => actions.stepRunEx(-1)}
			onNext={() => actions.stepRunEx(1)}
			prevOff={ui.runExIndex <= 0}
			nextOff={ui.runExIndex >= list.length - 1}
			secondary={secondary}
			primary={primary}
			hint="ลูกศรซ้าย/ขวาเลื่อนทีละรายการ"
		/>
	);
}

// A duplicate claim is shown beside the page it duplicates — the one thing
// the real page does that a plain list cannot.
function RunExPreview({ e }: { e: RunExclusion }) {
	if (e.duplicate_of && !e.decision) {
		return (
			<div className="preview-split">
				<div className="preview-half">
					<div className="preview-half-head cut">ตัดออก — หน้า {e.page}</div>
					<div className="preview-half-body"><ExSheet file={e.file} page={e.page} kind="หน้าที่ระบบเสนอตัดออก" /></div>
				</div>
				<div className="preview-half">
					<div className="preview-half-head orig">ต้นฉบับที่ซ้ำด้วย — หน้า {e.duplicate_of.page}</div>
					<div className="preview-half-body"><ExSheet file={e.duplicate_of.file} page={e.duplicate_of.page} kind="หน้าที่เก็บไว้ในกลุ่ม" /></div>
				</div>
			</div>
		);
	}
	return <ExSheet file={e.file} page={e.page} kind={WF_EXCLUDE_REASON_TH[e.reason] || e.reason} />;
}

function ExSheet({ file, page, kind }: { file: string; page: number; kind: string }) {
	return (
		<div className="docpaper" style={{ transform: "scale(" + ui.runZoom + ")" }}>
			<div className="docpaper-blank">{file} · หน้า {page}<br />{kind}</div>
		</div>
	);
}
