// ---- step 2: evidence | gutter | form.
import type { ReactNode } from "react";
import { wfMoney } from "../../domain/runData";
import { ArrowRightIcon, FitIcon, SaveIcon, ZoomInIcon, ZoomOutIcon } from "../../components/Icons";
import { ui } from "../../state/ui";
import type { RunCtx, RunItem } from "./runModel";
import { runItems } from "./runModel";
import type { RunActions } from "./useRunActions";
import { RunActionBar } from "./RunActionBar";
import { RunPaper } from "./RunPaper";
import { RunDocForm } from "./RunDocForm";
import { RunStatementForm } from "./RunStatementForm";

export function RunDocumentsStep({ c, actions }: { c: RunCtx; actions: RunActions }) {
	const items = runItems(c.d);
	const it = items.length ? items[Math.min(ui.runItemIndex, items.length - 1)] : null;

	return (
		<>
			<RunFilters c={c} actions={actions} />
			<div className="pane">
				<section className="evidence">
					<div className="preview">
						<div className="preview-note">
							เอกสารจำลองสำหรับมอค — ในระบบจริงช่องนี้คือไฟล์ต้นฉบับของลูกค้า (PDF / รูปสแกน / ชีท) เปิดตรงหน้าที่อ้างถึง
						</div>
						{it ? <RunPaper x={it} /> : <div className="docpaper-blank">ไม่มีรายการตามตัวกรองนี้</div>}
						{it ? <div className="page-anchor">{it.g.src} · หน้า 1 / {it.g.pages}</div> : null}
						<div className="zoombar">
							<button type="button" onClick={() => actions.setRunZoom(-0.1)} title="ซูมออก"><ZoomOutIcon /></button>
							<span className="zoom-pill">{Math.round(ui.runZoom * 100)}%</span>
							<button type="button" onClick={() => actions.setRunZoom(0.1)} title="ซูมเข้า"><ZoomInIcon /></button>
							<button type="button" onClick={() => actions.setRunZoom(0)} title="รีเซ็ต"><FitIcon /></button>
						</div>
					</div>
					<div className="file-selector">
						<div className="groups">
							{items.map((x, i) => <RunStripCard x={x} i={i} key={x.bucket.key + "/" + x.g.id} actions={actions} />)}
						</div>
					</div>
				</section>
				<div className="pane-gutter"></div>
				{it
					? (it.g.isBank
						? <RunStatementForm x={it} actions={actions} key={it.bucket.key + "/" + it.g.id} />
						: <RunDocForm x={it} actions={actions} key={it.bucket.key + "/" + it.g.id} />)
					: <section className="form-card"><p className="run-empty">ไม่มีรายการตามตัวกรองนี้ — ล้างตัวกรองด้านบนเพื่อดูทั้งรอบ</p></section>}
			</div>
			<RunDocsBar c={c} it={it} items={items} actions={actions} />
		</>
	);
}

function RunFilters({ c, actions }: { c: RunCtx; actions: RunActions }) {
	return (
		<div className="run-filters">
			<span className="filter-label">หมวด</span>
			<button
				type="button"
				className={"doc-step" + (ui.runFilterBucket === "all" ? " on" : "")}
				onClick={() => actions.setRunFilterBucket("all")}
			>
				ทั้งหมด {c.d.groupCount}
			</button>
			{c.d.buckets.map((b) => (
				<button
					type="button"
					className={"doc-step" + (ui.runFilterBucket === b.key ? " on" : "")}
					key={b.key}
					onClick={() => actions.setRunFilterBucket(b.key)}
				>
					{b.label} {b.groups.length}
				</button>
			))}
			<button
				type="button"
				className={"doc-step" + (ui.runFilterAttention ? " on" : "")}
				onClick={actions.toggleRunFilterAttention}
			>
				ต้องตรวจสอบเท่านั้น {c.d.attention}
			</button>
			{/* "รายการที่ n / m" used to sit here as well; round 19 left it only
			    in the action bar, which is always on screen — the same figure in
			    two places is just two places to check. */}
		</div>
	);
}

function RunStripCard({ x, i, actions }: { x: RunItem; i: number; actions: RunActions }) {
	const g = x.g;
	return (
		<button
			type="button"
			className={"group " + g.status + (i === ui.runItemIndex ? " active" : "") + (g.skipped ? " skipped" : "")}
			onClick={() => actions.setRunItem(i)}
		>
			<div className="group-title">{g.label}</div>
			<div className="group-total">{wfMoney(g.total)}</div>
			<div className="group-line">
				{(g.status === "needs_attention" ? "ต้องตรวจสอบ" : g.saved ? "บันทึกแล้ว" : "ตรวจแล้ว") + " · " + x.bucket.label}
			</div>
		</button>
	);
}

// Step 2's slice of the shared bar — the same shape as step 1's, so
// บันทึกและถัดไป lands in the same place as ยืนยันตัดออก did.
function RunDocsBar({ c, it, items, actions }: { c: RunCtx; it: RunItem | null; items: RunItem[]; actions: RunActions }) {
	const last = ui.runItemIndex >= items.length - 1;
	const where: ReactNode = items.length ? (
		<>
			รายการที่ <b>{ui.runItemIndex + 1}</b> จาก <b>{items.length}</b>
			{c.d.attention ? <> · <b>{c.d.attention}</b> ต้องตรวจสอบ</> : null}
		</>
	) : "ไม่มีรายการตามตัวกรองนี้";
	const primary = it ? (
		<button type="button" className="btn btn-run" onClick={actions.runSaveNext}>
			<SaveIcon />{last ? "บันทึก" : "บันทึกและถัดไป"}{last ? null : <ArrowRightIcon />}
		</button>
	) : (
		<button type="button" className="btn btn-run" disabled>บันทึกและถัดไป</button>
	);
	const secondary = it ? (
		<button type="button" className="btn btn-ghost" onClick={actions.runToggleSkip}>
			{it.g.skipped ? "ใช้ข้อมูลกลุ่มนี้" : "ไม่ใช้ข้อมูลกลุ่มนี้"}
		</button>
	) : "";

	return (
		<RunActionBar
			where={where}
			onPrev={() => actions.stepRunItem(-1)}
			onNext={() => actions.stepRunItem(1)}
			prevOff={ui.runItemIndex <= 0}
			nextOff={last}
			secondary={secondary}
			primary={primary}
			hint="ลูกศรซ้าย/ขวาเลื่อนทีละรายการ"
		/>
	);
}
