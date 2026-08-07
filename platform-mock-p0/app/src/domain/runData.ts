// ================= what a finished run produced (round 13) =================
//
// The pipeline in this repo already writes its own review surfaces. What this
// builds is the same shape, simulated: buckets of doc groups, each group's own
// facts and รายการ lines, and the pages the run proposed to cut. Deterministic
// from the project id and the run number, so a refresh prints the same result
// and a re-run produces a genuinely new one beside it.
import type { Project, RunBucket, RunExclusion, RunGroup, RunLine, WorkflowRun, WorkflowRunData } from "../types";
import { CUSTOMERS } from "../state/stores";
import { GEN_PLACE, GEN_TRADE } from "../data/officeScale";
import {
	WF_BUCKETS, WF_COA_BANK, WF_COA_EXPENSE, WF_COA_INCOME, WF_EXCLUDE_REASONS,
	WF_FLAGS, WF_REASONS_SURE, WF_REASONS_UNSURE, WF_SRC_FILES,
} from "../data/runTables";
import { customerName } from "./projects";
import { wfSeedNumber } from "./runs";

// Deterministic pseudo-random: same inputs, same screen on every refresh.
export function wfHash(n: number) {
	n = (n * 1103515245 + 12345) & 0x7fffffff;
	n = (n ^ (n >> 13)) & 0x7fffffff;
	return n;
}
export function wfPick<T>(list: T[], n: number): T { return list[n % list.length]; }
export function wfMoney(n: number) { return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }


export function wfGroupOf(p: Project, base: number, b: (typeof WF_BUCKETS)[number], bi: number, gi: number): RunGroup {
	var h = wfHash(base + bi * 9973 + gi * 131);
	var isIncome = b.key.indexOf("income") === 0;
	var isBank = b.key === "bank_statement";
	var coa = isBank ? WF_COA_BANK : isIncome ? WF_COA_INCOME : WF_COA_EXPENSE;
	var party = (h % 9 === 4 ? "หจก. " : "บจก. ") + wfPick(GEN_PLACE, h >> 3) + wfPick(GEN_TRADE, h >> 7);
	var docNo = (isIncome ? "INV" : "PV") + "2569" + (1000 + (h % 8999));
	var lineCount = isBank ? 6 + (h % 12) : 1 + (h % 3);
	var lines: RunLine[] = [];
	for (var i = 0; i < lineCount; i++) {
		var lh = wfHash(h + i * 7717);
		var acct = wfPick(coa, lh);
		var amount = Math.round((isBank ? 800 + (lh % 90000) : 450 + (lh % 42000)) * 100) / 100;
		var low = lh % 11 === 3;
		lines.push({
			desc: acct[2],
			code: acct[0], name: acct[1], amount: amount,
			date: isBank ? (1 + (lh % 28)) + "/7/2569" : null,
			direction: isBank ? (acct as [string,string,string,string])[3] : null,
			confidence: low ? "ต่ำ" : lh % 4 === 0 ? "ปานกลาง" : "สูง",
			needsReview: low,
			reason: wfPick(low ? WF_REASONS_UNSURE : WF_REASONS_SURE, lh >> 9),
		});
	}
	// A statement reads in date order — that is what makes it a statement.
	if (isBank) lines.sort(function (a, b2) { return parseInt(a.date!, 10) - parseInt(b2.date!, 10); });
	var flags = h % 8 === 2 ? [wfPick(WF_FLAGS, h >> 11)] : [];
	var needs = flags.length > 0 || lines.some(function (l) { return l.needsReview; });
	var total = Math.round(lines.reduce(function (n, l) { return n + l.amount; }, 0) * 100) / 100;
	var date = (1 + (h % 28)) + "/7/2569";
	var vatTreatment = b.key.indexOf("/vat") > 0 ? "vat_7" : b.key.indexOf("mixed") > 0 ? "unknown" : "non_vat";
	var vat = vatTreatment === "vat_7" ? Math.round(total * 7) / 100 : 0;
	var acctNo = "221-1-9094" + (h % 10) + "-4";
	// The document's own fields, in the shape review-data.json carries them
	// (schema: pages[].facts / statement) — so the form on the right is
	// filling in the same things the real review page fills in.
	var facts: Record<string, string | number | null> = isBank
		? {
			bank: "Kasikornbank K-Deposit", account_no: acctNo,
			account_holder: CUSTOMERS[p.customerId] ? CUSTOMERS[p.customerId].legalName : customerName(p.customerId),
			period: "01/07/2569 - 31/07/2569",
			opening_balance: Math.round((48000 + (h % 90000)) * 100) / 100,
			closing_balance: 0,
		}
		: {
			date: date, document_no: docNo, reference: null,
			seller: isIncome ? (CUSTOMERS[p.customerId] ? CUSTOMERS[p.customerId].legalName : customerName(p.customerId)) : party,
			seller_tax_id: h % 11 === 3 ? null : "0-0000-00000-0" + (h % 10) + "-0",
			buyer: isIncome ? party : (CUSTOMERS[p.customerId] ? CUSTOMERS[p.customerId].legalName : customerName(p.customerId)),
			buyer_tax_id: "0-0000-00000-00-0",
			subtotal: total, vat: vat, total: Math.round((total + vat) * 100) / 100,
			paid: Math.round((total + vat) * 100) / 100, wht: h % 6 === 1 ? Math.round(total * 3) / 100 : null,
			vat_treatment: vatTreatment,
		};
	if (isBank) {
		var running = 0, lowest = 0;
		lines.forEach(function (l) {
			running += l.direction === "เงินเข้า" ? l.amount : -l.amount;
			if (running < lowest) lowest = running;
		});
		var floor = 12000 + (h % 9000);   // not a round number — a real balance never is
		if ((facts.opening_balance as number) + lowest < floor) facts.opening_balance = Math.round((floor - lowest) * 100) / 100;
		facts.closing_balance = Math.round(((facts.opening_balance as number) + running) * 100) / 100;
	}
	return {
		id: b.key.replace("/", "-") + "-" + (gi + 1),
		label: isBank
			? "Kasikornbank K-Deposit — บัญชีออมทรัพย์ " + acctNo
			: party + " — " + docNo,
		party: party, docNo: docNo, isBank: isBank,
		pages: isBank ? 4 + (h % 5) : 2 + (h % 3),
		date: date,
		total: total,
		status: needs ? "needs_attention" : "reviewed",
		flags: flags, lines: lines, facts: facts,
		// the reviewer's own record on this run — never a Gate signature
		note: "", skipped: false, saved: false, kept: false,
		src: wfPick(WF_SRC_FILES[b.key.split("/")[0]] || WF_SRC_FILES.expense, h >> 2),
	};
}

// Built once, the moment a run finishes, and then kept on the run — so a
// re-run produces a genuinely NEW result set beside the old one rather than
// the same numbers twice.
export function wfRunData(p: Project, run: WorkflowRun): WorkflowRunData {
	if (run.data) return run.data;
	var base = wfSeedNumber(p.id) + run.no * 7919;
	var buckets: RunBucket[] = WF_BUCKETS.map(function (b, bi) {
		var count = Math.max(1, b.n + (wfHash(base + bi) % 5) - 2);
		var groups: RunGroup[] = [];
		for (var gi = 0; gi < count; gi++) groups.push(wfGroupOf(p, base, b, bi, gi));
		return {
			key: b.key, label: b.label, path: b.path, groups: groups,
			pages: groups.reduce(function (n, g) { return n + g.pages; }, 0),
			attention: groups.filter(function (g) { return g.status === "needs_attention"; }).length,
		};
	});
	var excluded: RunExclusion[] = [];
	var exCount = 9 + (wfHash(base + 77) % 14);
	for (var i = 0; i < exCount; i++) {
		var eh = wfHash(base + 313 * (i + 1));
		var file = wfPick(WF_SRC_FILES.expense.concat(WF_SRC_FILES.income), eh);
		var page = 1 + (eh % 60);
		var reason = wfPick(WF_EXCLUDE_REASONS, eh >> 6);
		excluded.push({
			// "<file>#p<N>" — the Page-Ledger unit id form.
			unit: file + "#p" + page,
			file: file, page: page, reason: reason,
			duplicate_of: reason === "duplicate"
				? { file: file, page: 1 + ((eh >> 3) % 60) }
				: null,
			// An agent-declared exclusion is a PROPOSAL. It stays pending
			// until a human either re-records it (declared_by: human) or
			// asks for the page back — see references/ledger-gates.md.
			decision: null,
		});
	}
	excluded.sort(function (a, b2) { return a.reason < b2.reason ? -1 : a.reason > b2.reason ? 1 : 0; });
	var grouped = buckets.reduce(function (n, b) { return n + b.pages; }, 0);
	run.data = {
		buckets: buckets, excluded: excluded,
		groupCount: buckets.reduce(function (n, b) { return n + b.groups.length; }, 0),
		pageCount: grouped, totalUnits: grouped + excluded.length,
		attention: buckets.reduce(function (n, b) { return n + b.attention; }, 0),
	};
	return run.data;
}
