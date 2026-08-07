// Everything the review flow does to itself: the two navigations, the filters,
// the excluded decisions, and the in-memory edits on the run's own result.
//
// In the legacy mock these were free functions that ended in
// `renderRunReview(currentPageArgs)`. Here the same functions end in `bump()`
// — the ones that repainted repaint, and the ones that deliberately did NOT
// (runSetFact / runSetNote, which only record what a field already shows)
// still do not, so a reviewer halfway through a form never has it redrawn
// underneath them.
import type { RunFacts } from "../../types";
import { useApp } from "../../state/AppContext";
import { ui } from "../../state/ui";
import type { RunArgs } from "./runModel";
import {
	runCoaFor, runCurrentData, runCurrentExcluded, runCurrentItem,
	runExcludedVisible, runItems, runPendingExcluded,
} from "./runModel";

export function useRunActions(args: RunArgs) {
	const { bump, showToast } = useApp();
	const ctx = () => runCurrentData(args);
	const item = () => runCurrentItem(ctx());

	function setRunItem(i: number) { ui.runItemIndex = i; ui.runZoom = 1; bump(); }
	// Round 19: step 2 gained the same ‹ › walk step 1 always had, so both
	// steps navigate the same way from the same place — and the arrow keys now
	// work on both, which is the point of a bar you press over and over.
	function stepRunItem(delta: number) {
		var c = ctx();
		if (!c) return;
		var items = runItems(c.d);
		if (!items.length) return;
		var next = Math.min(Math.max(ui.runItemIndex + delta, 0), items.length - 1);
		if (next === ui.runItemIndex) return;
		setRunItem(next);
	}
	function setRunStep(step: "excluded" | "documents") {
		var c = ctx();
		if (step === "documents" && c && runPendingExcluded(c.d)) {
			showToast("ยังตัดสินใจรายการที่ถูกตัดออกไม่ครบ — เหลืออีก " + runPendingExcluded(c.d) + " รายการ");
			return;
		}
		ui.runStep = step;
		ui.runZoom = 1;
		bump();
	}
	function setRunExItem(i: number) { ui.runExIndex = i; ui.runZoom = 1; bump(); }
	function stepRunEx(delta: number) {
		var c = ctx();
		if (!c) return;
		var list = runExcludedVisible(c.d);
		var next = ui.runExIndex + delta;
		if (next < 0 || next >= list.length) return;
		setRunExItem(next);
	}
	function setRunExFilter(reason: string) {
		ui.runExFilter = ui.runExFilter === reason ? "all" : reason;
		ui.runExIndex = 0;
		bump();
	}
	// The two decisions the pipeline actually recognises for a proposed
	// exclusion: a human re-records it (declared_by: human → it becomes a real
	// Exclusion Declaration), or the page is wanted back, which is resolved by
	// NEW EVIDENCE — i.e. it comes back on the next run, not by editing a
	// ledger. The copy says so rather than pretending the page reappears here.
	function decideExcluded(decision: string) {
		var c = ctx();
		if (!c) return;
		var e = runCurrentExcluded(c.d);
		if (!e) return;
		e.decision = e.decision === decision ? null : decision;
		showToast(e.decision === "confirmed"
			? "ยืนยันตัดออก — บันทึกเป็น Exclusion Declaration ของมนุษย์"
			: e.decision === "keep"
				? "ทำเครื่องหมายเอากลับ — หน้านี้จะกลับเข้ากระบวนการเมื่อรันรอบใหม่"
				: "ยกเลิกการตัดสินใจของรายการนี้");
		// Move to the next still-undecided item, so clearing the step is one
		// keypress per page rather than a hunt.
		if (e.decision) {
			var list = runExcludedVisible(c.d);
			for (var k = ui.runExIndex + 1; k < list.length; k++) {
				if (!list[k].decision) { ui.runExIndex = k; break; }
			}
		}
		bump();
	}
	function setRunFilterBucket(key: string) {
		ui.runFilterBucket = ui.runFilterBucket === key ? "all" : key;
		ui.runItemIndex = 0; ui.runZoom = 1;
		bump();
	}
	function toggleRunFilterAttention() {
		ui.runFilterAttention = !ui.runFilterAttention;
		ui.runItemIndex = 0; ui.runZoom = 1;
		bump();
	}
	function toggleRunHistory() { ui.runHistoryOpen = !ui.runHistoryOpen; bump(); }
	function setRunZoom(delta: number) {
		ui.runZoom = delta === 0 ? 1 : Math.min(2, Math.max(0.6, Math.round((ui.runZoom + delta) * 10) / 10));
		bump();
	}

	// ---- edits. In-memory, on the run's own result — a re-run produces a new
	// result set, so a correction belongs to the run it was made on.
	function runSetFact(field: string, value: string) {
		var it = item();
		if (!it) return;
		(it.g.facts as RunFacts)[field] = value;
	}
	function runSetFactAndRepaint(field: string, value: string) {
		runSetFact(field, value);
		bump();
	}
	function runSetLine(i: number, field: string, value: string) {
		var it = item();
		if (!it) return;
		var line = it.g.lines[i];
		if (field === "account") {
			var pair = runCoaFor(it.bucket.key).filter(function (c) { return c[0] === value; })[0];
			line.code = value;
			line.name = pair ? pair[1] : "";
		} else if (field === "amount") {
			line.amount = parseFloat(String(value).replace(/,/g, "")) || 0;
			it.g.total = it.g.lines.reduce(function (n, l) { return n + l.amount; }, 0);
			it.g.facts.subtotal = it.g.total;
			it.g.facts.vat = it.g.facts.vat_treatment === "vat_7" ? Math.round(it.g.total * 7) / 100 : 0;
			it.g.facts.total = Math.round(((it.g.facts.subtotal as number) + (it.g.facts.vat as number)) * 100) / 100;
		} else {
			line[field] = value;
		}
		bump();
	}
	function runAddLine() {
		var it = item();
		if (!it) return;
		var coa = runCoaFor(it.bucket.key)[0];
		it.g.lines.push({
			desc: "", code: coa[0], name: coa[1], amount: 0, date: it.g.isBank ? it.g.date : null,
			direction: it.g.isBank ? "เงินออก" : null, confidence: "—", needsReview: false,
			reason: "เพิ่มโดยผู้ตรวจ — ไม่ได้มาจากการอ่านเอกสาร",
		});
		bump();
	}
	function runRemoveLine(i: number) {
		var it = item();
		if (!it || it.g.lines.length <= 1) { showToast("ต้องเหลืออย่างน้อย 1 รายการ"); return; }
		it.g.lines.splice(i, 1);
		it.g.total = it.g.lines.reduce(function (n, l) { return n + l.amount; }, 0);
		bump();
	}
	function runSetStatus(value: string) {
		var it = item();
		if (!it) return;
		it.g.status = value;
		bump();
	}
	function runSetNote(value: string) {
		var it = item();
		if (it) it.g.note = value;
	}
	function runToggleSkip() {
		var it = item();
		if (!it) return;
		it.g.skipped = !it.g.skipped;
		showToast(it.g.skipped ? "ไม่ใช้ข้อมูลกลุ่มนี้ในไฟล์ส่งออก" : "ใช้กลุ่มนี้ในไฟล์ส่งออกตามปกติ");
		bump();
	}
	function runSaveNext() {
		var c = ctx();
		var it = runCurrentItem(c);
		if (!c || !it) return;
		it.g.saved = true;
		var items = runItems(c.d);
		if (ui.runItemIndex < items.length - 1) {
			ui.runItemIndex++;
			ui.runZoom = 1;
			showToast("บันทึกแล้ว — ไปรายการถัดไป (" + (ui.runItemIndex + 1) + "/" + items.length + ")");
		} else {
			showToast("บันทึกแล้ว — รายการสุดท้ายของรอบนี้");
		}
		bump();
	}

	return {
		setRunItem, stepRunItem, setRunStep, setRunExItem, stepRunEx, setRunExFilter,
		decideExcluded, setRunFilterBucket, toggleRunFilterAttention, toggleRunHistory, setRunZoom,
		runSetFact, runSetFactAndRepaint, runSetLine, runAddLine, runRemoveLine,
		runSetStatus, runSetNote, runToggleSkip, runSaveNext,
	};
}

export type RunActions = ReturnType<typeof useRunActions>;
