// ---- round 19: the flow's one action bar, built once and used by both
// steps. A caller supplies where it is, what ‹ › do, and its actions; the
// bar decides where those sit — and it puts the primary hard right in both
// steps, which is the entire point. Secondary actions stay .btn-ghost
// beside it rather than becoming a row of equal buttons.
import type { ReactNode } from "react";
import { ArrowRightIcon, BanIcon, ChevronLeftIcon, ChevronRightIcon, DocIcon, LockIcon } from "../../components/Icons";
import { ui } from "../../state/ui";
import type { RunCtx } from "./runModel";
import { runPendingExcluded } from "./runModel";
import type { RunActions } from "./useRunActions";

export function RunActionBar(b: {
	where: ReactNode;
	onPrev: () => void;
	onNext: () => void;
	prevOff: boolean;
	nextOff: boolean;
	secondary?: ReactNode;
	primary: ReactNode;
	hint?: string;
}) {
	return (
		<div className="run-actionbar">
			<div className="run-bar-nav">
				<button type="button" className="nav-btn" onClick={b.onPrev} disabled={b.prevOff} title="รายการก่อนหน้า">
					<ChevronLeftIcon />
				</button>
				<button type="button" className="nav-btn" onClick={b.onNext} disabled={b.nextOff} title="รายการถัดไป">
					<ChevronRightIcon />
				</button>
			</div>
			<div className="run-bar-where">{b.where}</div>
			<div className="run-bar-actions">
				{b.hint ? <span className="run-bar-hint">{b.hint}</span> : null}
				{b.secondary || null}
				{b.primary}
			</div>
		</div>
	);
}

// The flow's two steps, in the pipeline's order. Step 2 is genuinely shut
// until step 1 is cleared — inside this review flow only.
export function RunStepRow({ c, actions }: { c: RunCtx; actions: RunActions }) {
	const pending = runPendingExcluded(c.d);
	const total = c.d.excluded.length;
	return (
		<div className="step-row">
			<button
				type="button"
				className={"step-btn" + (ui.runStep === "excluded" ? " current" : "")}
				onClick={() => actions.setRunStep("excluded")}
			>
				<BanIcon />1. ตรวจรายการที่ถูกตัดออก {pending ? "(เหลือ " + pending + "/" + total + ")" : "(ครบแล้ว)"}
			</button>
			<span className="step-arrow"><ArrowRightIcon /></span>
			<button
				type="button"
				className={"step-btn" + (ui.runStep === "documents" ? " current" : "")}
				disabled={!!pending}
				onClick={() => actions.setRunStep("documents")}
			>
				{pending ? <LockIcon /> : <DocIcon />}2. ตรวจเอกสารที่จัดกลุ่มแล้ว ({c.d.groupCount} กลุ่ม)
			</button>
		</div>
	);
}
