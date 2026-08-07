// ---- one simulated run, in memory, keyed by (project, phase, workflow).
// Never persisted, never sent anywhere: pressing เริ่มรัน walks a timer
// through queued → running (one step at a time) → เสร็จ / ล้มเหลว.
// One key holds the run HISTORY for that (project, phase, workflow), oldest
// first. A re-run never overwrites the run before it — "ran, reviewed,
// re-ran" is exactly the sequence this has to be able to show, and a run
// that has been read by a person is a record, not a cache entry.
import type { Project, WorkflowRun } from "../types";
import { WF_RUNS, counters } from "../state/stores";
import { bumpApp, session, showToast } from "../state/session";
import { workflowByKey } from "../data/workflows";
import { TODAY } from "./dates";
import { customerName, projectById } from "./projects";
import { docCustomerHasNothing, docSituation } from "./docs";
import { pendingCustomerGates } from "./work";
import { notifyRunFinished } from "./notifications";
import { wfRunData } from "./runData";

export function runKey(projectId: string, pi: number, wfKey: string) { return projectId + "|" + pi + "|" + wfKey; }
export function getRuns(projectId: string, pi: number, wfKey: string): WorkflowRun[] {
	return WF_RUNS[runKey(projectId, pi, wfKey)] || [];
}
export function getRun(projectId: string, pi: number, wfKey: string): WorkflowRun | null {
	var a = getRuns(projectId, pi, wfKey);
	return a.length ? a[a.length - 1] : null;
}
export function getRunNo(projectId: string, pi: number, wfKey: string, no: number): WorkflowRun | null {
	var a = getRuns(projectId, pi, wfKey);
	for (var i = 0; i < a.length; i++) if (a[i].no === no) return a[i];
	return null;
}
// A stable number per project, so the simulated result reads the same on
// every refresh instead of moving every time somebody reloads.
export function wfSeedNumber(id: string) {
	var h = 0;
	for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000;
	return h;
}
// Whether the folder this run reads actually has the งวด's documents in it.
// Round 20: read off the Phase 1 Gates rather than the deleted ladder. The
// documents are in when every customer-facing Gate the project has reached
// is closed — and NOT when the customer has said there is nothing to give,
// because there is then nothing to key. A run fired before that stops at
// the first stage, exactly as the real pipeline would.
export function wfDocsReady(p: Project) {
	if (docCustomerHasNothing(p)) return false;
	return pendingCustomerGates(p).length === 0;
}

export function wfElementId(projectId: string, pi: number, wfKey: string) {
	var safe = function (x: string) { return String(x).replace(/[^a-zA-Z0-9]/g, ""); };
	return "wf-" + safe(projectId) + "-" + pi + "-" + safe(wfKey);
}

export function startWorkflowRun(projectId: string, pi: number, wfKey: string) {
	var p = projectById(projectId);
	var wf = workflowByKey(wfKey);
	if (!p || !wf) return;
	var k = runKey(projectId, pi, wfKey);
	var prev = getRun(projectId, pi, wfKey);
	if (prev && prev.timer) clearTimeout(prev.timer);
	var run: WorkflowRun = {
		no: ++counters.wfRunSeq, state: "queued", step: -1, timer: null,
		// A run is always scoped to the project's own customer and งวด —
		// recorded here so the screen can SHOW that scope, never ask for it.
		customerId: p.customerId, monthKey: p.monthKey, periodLabel: p.periodLabel,
		failStep: wfDocsReady(p) ? -1 : 1, failWhy: null, startedAt: TODAY, finishedAt: null,
		// Who fired it, so the run's outcome can be told back to them even
		// when the project belongs to somebody else (round 17).
		startedBy: session.currentUserName || undefined,
		data: null,
	};
	(WF_RUNS[k] = WF_RUNS[k] || []).push(run);
	showToast("สั่งรัน " + wf.name + " — ลูกค้า " + customerName(p.customerId) + " · " + p.periodLabel);
	bumpApp();
	wfTick(projectId, pi, wfKey);
}

export function wfTick(projectId: string, pi: number, wfKey: string) {
	var run = getRun(projectId, pi, wfKey);
	if (!run) return;
	var wf = workflowByKey(wfKey)!;
	run.timer = setTimeout(function () {
		var p = projectById(projectId);
		run!.step++;
		run!.state = "running";
		if (run!.step === run!.failStep) {
			run!.state = "failed";
			run!.finishedAt = TODAY;
			run!.failWhy = 'หยุดที่ขั้น "' + wf.steps[run!.step] + '" — เอกสารของงวดนี้ยังไม่ครบในโฟลเดอร์ (' +
				(p ? docSituation(p).text : "ไม่พบโปรเจกต์") + ")";
			if (p) notifyRunFinished(p, pi, wfKey, run!);
			wfFinished(projectId, pi, wfKey);
			return;
		}
		if (run!.step >= wf.steps.length) {
			run!.state = "done";
			run!.step = wf.steps.length - 1;
			run!.finishedAt = TODAY;
			if (p) { wfRunData(p, run!); notifyRunFinished(p, pi, wfKey, run!); }
			wfFinished(projectId, pi, wfKey);
			return;
		}
		bumpApp();
		wfTick(projectId, pi, wfKey);
	}, run.state === "queued" ? 700 : 850);
}

// A run reaching a terminal state has to be able to say so on whichever screen
// is showing. The legacy mock reached into the DOM for this; here the screens
// subscribe to the repaint, and the two that need a toast register a listener.
type RunListener = (projectId: string, pi: number, wfKey: string) => void;
const runListeners: RunListener[] = [];
export function onRunFinished(fn: RunListener) {
	runListeners.push(fn);
	return () => {
		const i = runListeners.indexOf(fn);
		if (i !== -1) runListeners.splice(i, 1);
	};
}
function wfFinished(projectId: string, pi: number, wfKey: string) {
	bumpApp();
	runListeners.slice().forEach(function (fn) { fn(projectId, pi, wfKey); });
}
