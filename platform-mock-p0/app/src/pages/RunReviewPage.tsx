// ================= the run review screen (round 14) =================
//
// Round 13 built a summary page. Reviewing is not reading statistics: it is
// looking at the document while you correct the fields that were read off
// it. So this screen is the SAME layout as the pipeline's own ตรวจทาน.html
// (.claude/skills/ksk-keying/scripts/review-template.ts) — evidence column +
// gutter + form, one item at a time, with every item in the run reachable
// from the strip under the document. Field names, section order, statuses and
// the บันทึกและถัดไป action are that file's, not new ones:
// PRIMARY_LEFT_FIELDS / PRIMARY_RIGHT_FIELDS / SUMMARY_FIELDS / EXTRA_FIELDS,
// the รายการ line cards with ผังบัญชี / รายละเอียด / ยอด, the บัญชี /
// ตัวควบคุมผู้ตรวจ details block, and the statement table for the
// bank_statement bucket.
//
// The document itself is a STAND-IN and says so at the top of the pane: the
// real page renders the client's own PDF/image/xlsx out of the month folder,
// and a mock has no such file. Everything else about the screen — the layout,
// the navigation, the editing — is the working shape.
//
// Nothing here signs a Gate. Editing is in-memory and belongs to the run, not
// to the checklist; the tick and the ผู้สอบทาน signature stay on the project
// screen, with a person's name on them.
//
// Round 15 — the review flow has two steps, in the pipeline's own order: the
// pages the run proposed to CUT are decided first, and the rest of the review
// waits behind them. That is not a UI preference: an agent-declared exclusion
// is a proposal only (references/ledger-gates.md), and a page wrongly dropped
// is a page that never gets keyed and that nobody ever looks for again. This
// blocking lives INSIDE the workflow's review flow — it never reaches the
// Phase's Gate checklist, which no workflow may block.
import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { workflowByKey } from "../data/workflows";
import { jobTypeByKey } from "../domain/jobTypes";
import { projectById } from "../domain/projects";
import { wfRunData } from "../domain/runData";
import { getRun, getRunNo, onRunFinished } from "../domain/runs";
import { paths, useOpenProject } from "../navigation";
import { useApp } from "../state/AppContext";
import { ui } from "../state/ui";
import { ArrowLeftIcon } from "../components/Icons";
import type { RunArgs } from "./runReview/runModel";
import { runCurrentData, runPendingExcluded } from "./runReview/runModel";
import { useRunActions } from "./runReview/useRunActions";
import { RunHead } from "./runReview/RunHead";
import { RunStepRow } from "./runReview/RunActionBar";
import { RunExcludedStep } from "./runReview/RunExcludedStep";
import { RunDocumentsStep } from "./runReview/RunDocumentsStep";

export function RunReviewPage() {
	const params = useParams();
	const args: RunArgs = {
		id: params.id || "",
		pi: parseInt(params.pi || "0", 10),
		key: params.key || "",
		no: parseInt(params.no || "0", 10),
	};
	const { version, showToast, modal } = useApp();
	void version;
	const navigate = useNavigate();
	const openProject = useOpenProject();
	const actions = useRunActions(args);

	// Landing on a run. The legacy openRunReview() decided which step to open
	// on just before it navigated; a route cannot carry that, so it is decided
	// here instead — once per run, not on every repaint, or pressing "ไปตรวจ
	// เอกสารที่จัดกลุ่มแล้ว" would be undone by the next render.
	const opened = args.id + "|" + args.pi + "|" + args.key + "|" + args.no;
	const lastOpened = useRef<string | null>(null);
	if (lastOpened.current !== opened) {
		lastOpened.current = opened;
		// Always land on step 1 while anything is still undecided.
		const run0 = getRunNo(args.id, args.pi, args.key, args.no);
		const p0 = projectById(args.id);
		ui.runStep = run0 && p0 && runPendingExcluded(wfRunData(p0, run0)) ? "excluded" : "documents";
	}

	// A re-run fired from this screen lands the reviewer on the NEW run's
	// result rather than leaving them on the old one with no sign anything
	// happened (the legacy wfRepaint's own run-review branch).
	useEffect(
		() => onRunFinished((projectId, pi, wfKey) => {
			if (projectId !== args.id) return;
			const fresh = getRun(projectId, pi, wfKey);
			const wfx = workflowByKey(wfKey)!;
			if (fresh && fresh.state === "done") {
				ui.runItemIndex = 0; ui.runFilterBucket = "all"; ui.runFilterAttention = false; ui.runZoom = 1;
				// A new run means new proposed exclusions, so the flow restarts
				// at step 1 — last round's decisions were about other pages.
				ui.runStep = "excluded"; ui.runExIndex = 0; ui.runExFilter = "all";
				navigate(paths.runReview(projectId, pi, wfKey, fresh.no), { replace: true });
				showToast(wfx.name + " รอบที่ " + fresh.no + " เสร็จแล้ว — นี่คือผลของรอบใหม่");
			} else {
				showToast(wfx.name + " รันไม่สำเร็จ — ผลรอบก่อนหน้ายังอยู่ในประวัติ");
			}
		}),
		[args.id, navigate, showToast],
	);

	// The selected card is kept in view in whichever list the current step
	// draws — walking with ‹ › past the edge of the strip must not leave the
	// reviewer looking at a card they did not select.
	useEffect(() => {
		const strip = document.querySelector(".groups .group.active, .item-list .item.active");
		if (strip && strip.scrollIntoView) strip.scrollIntoView({ block: "nearest", inline: "center" });
	});

	// ‹ › and the arrow keys both walk the excluded list — the same shortcut the
	// pipeline's own ที่ถูกตัดออก page binds. Registered on every render so it
	// always closes over the current run.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// A dialog owns the keyboard while it is open (ModalRoot binds
			// Escape/Tab itself); the shortcuts belonging to the screen behind
			// it stay quiet rather than firing at a page nobody is looking at.
			if (modal) return;
			// Never while somebody is in a field — they are typing an amount, not
			// asking for the next document.
			const t = e.target as HTMLElement | null;
			if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
			// Round 19: both steps walk with the arrow keys, because both steps now
			// have the same ‹ › in the same bar. Step 1 kept the pipeline's own
			// binding; step 2 gained the matching one.
			const walk = ui.runStep === "excluded" ? actions.stepRunEx : actions.stepRunItem;
			if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); walk(1); }
			else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); walk(-1); }
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});

	const c = runCurrentData(args);

	return (
		<>
			{/* Always back to the project's own working screen, opened on the
			    Phase the run belongs to — never a dead end. */}
			<button className="back-link" onClick={() => openProject(args.id, args.pi)}>
				<ArrowLeftIcon />
				กลับไปเช็กลิสต์ของเฟสนี้
			</button>
			<div id="run-review-head">
				{c
					? <RunHead
						c={c}
						wf={workflowByKey(c.args.key)!}
						phaseName={jobTypeByKey(c.p.jobType)!.phases[c.args.pi].name}
						actions={actions}
					/>
					: (
						// A run that was re-run away, or never finished — say so and
						// leave the way back rather than rendering an empty screen.
						<div className="run-head">
							<div className="run-head-name">ไม่พบผลของรอบนี้</div>
							<div className="run-head-meta">รอบนี้อาจยังรันไม่เสร็จ หรือถูกแทนที่ด้วยรอบใหม่แล้ว</div>
						</div>
					)}
			</div>
			<div id="run-review-pane">
				{c ? (
					<>
						<RunStepRow c={c} actions={actions} />
						{ui.runStep === "excluded"
							? <RunExcludedStep c={c} actions={actions} />
							: <RunDocumentsStep c={c} actions={actions} />}
					</>
				) : null}
			</div>
		</>
	);
}
