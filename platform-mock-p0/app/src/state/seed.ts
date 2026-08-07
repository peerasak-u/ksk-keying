// Everything the legacy mock's top-level IIFEs did, in the same order.
// Imported once by main.tsx, before the first render.
import { CUSTOMERS, PROJECTS, WF_RUNS, counters } from "./stores";
import { seedOfficeScale } from "../data/officeScale";
import { seedNotifications } from "../domain/notifications";
import { projectById } from "../domain/projects";
import { runKey } from "../domain/runs";
import { workflowByKey } from "../data/workflows";

let seeded = false;

export function seedEverything() {
	if (seeded) return;
	seeded = true;

	seedOfficeScale(CUSTOMERS, PROJECTS);
	seedWorkflowRuns();
	seedScheduleExceptions();
	seedNotifications(PROJECTS);
}

// Two workflow runs already in the demo state, so both terminal outcomes
// are on screen without anybody having to wait five seconds for one:
//   - a finished keying run on a project whose documents are in, and
//   - a failed one on the project whose document ladder says the customer
//     had nothing to give — the same rule a live run uses, not a special case.
// Both sit on Phase 2 (บันทึกบัญชี), which is where the keying pipeline is
// attached. Note the second one's project has not even REACHED Phase 2: a
// run neither waits for the checklist nor holds it up.
function seedWorkflowRuns() {
	var seed = function (projectId: string, pi: number, wfKey: string, state: string, at: string) {
		var p = projectById(projectId);
		var wf = workflowByKey(wfKey);
		if (!p || !wf) return;
		var k = runKey(projectId, pi, wfKey);
		(WF_RUNS[k] = WF_RUNS[k] || []).push({
			no: ++counters.wfRunSeq, state: state, step: state === "failed" ? 1 : wf.steps.length - 1, timer: null,
			customerId: p.customerId, monthKey: p.monthKey, periodLabel: p.periodLabel,
			failStep: state === "failed" ? 1 : -1,
			// The seeded failures state the situation AT THE TIME they ran —
			// ex3's documents have since arrived, which is exactly why its
			// next run went through.
			failWhy: state === "failed"
				? 'หยุดที่ขั้น "' + wf.steps[1] + '" — ตอนนั้นเอกสารของงวดนี้ยังไม่ครบในโฟลเดอร์'
				: null,
			data: null, startedAt: at, finishedAt: at,
		});
	};
	// ex3 shows the sequence the demo needs to be able to tell: a run that
	// failed while the documents were still incomplete, then the run that
	// went through once they were in.
	seed("ex3-monthly-may", 1, "ksk-keying", "failed", "2/8/2569");
	seed("ex3-monthly-may", 1, "ksk-keying", "done", "4/8/2569");
	seed("ex2-monthly-jun", 1, "ksk-keying", "failed", "4/8/2569");
}

// One occurrence deliberately skipped and one recurrence paused, seeded so
// both states are on the schedule from the start rather than only being
// reachable by pressing the buttons during a demo.
function seedScheduleExceptions() {
	var skipped = CUSTOMERS.c7 && CUSTOMERS.c7.packages[0];
	if (skipped) skipped.skips.push({
		period: "2569-08", reason: "ลูกค้าหยุดกิจการชั่วคราวเดือนนี้ ไม่มีเอกสารให้ทำ",
		by: "ปุ๊ก", at: "2/8/2569",
	});
	var paused = CUSTOMERS.c13 && CUSTOMERS.c13.packages[0];
	if (paused) paused.paused = true;
}
