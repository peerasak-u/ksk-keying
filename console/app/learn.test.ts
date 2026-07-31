import { describe, expect, test } from "bun:test";
import {
	buildReviewPrompt,
	decorateProposals,
	hasAnythingToConfirm,
	parseAgentReview,
	parseDecisionBody,
	summarizeReport,
	summarizeWithNotes,
	type LearnReport,
	type StoredNote,
} from "./learn";

const PROPOSAL = {
	id: "expense_hints:530407||",
	family: "expense_hints" as const,
	account_code: "530407",
	sub_code: "",
	label: "ค่าจ้างทำของ",
	in_coa: true,
	is_new_hint: true,
	correction_count: 4,
	keywords: ["ค่าจ้างทำของ", "ติดตั้ง"],
	tax_id_counts: [{ tax_id: "0105556090377", count: 4 }],
	from_accounts: [{ account_key: "510110||", count: 4 }],
	existing_tax_id_counts: [],
	examples: [{ month_id: "เดือนพฤษภาคม", group_id: "seg-001", line_id: "INV-1#L0", description: "ติดตั้งป้าย", from_key: "510110||" }],
};

function report(over: Partial<LearnReport> = {}): LearnReport {
	return {
		schema: "ksk_learn_report.v1",
		client_dir: "/w/216",
		scanned_files: 3,
		skipped_already_learned: 0,
		correction_count: 4,
		sources: ["เดือนพฤษภาคม/.../changes.json"],
		proposals: [PROPOSAL],
		learning_notes: [],
		...over,
	};
}

function note(over: Partial<StoredNote> = {}): StoredNote {
	return { id: "abc123", date: "2026-07-20", title: "หัวข้อ", detail: "รายละเอียด", handled: false, ...over };
}

describe("summarizeReport", () => {
	test("a client that has never exported is told to export first, not that learning failed", () => {
		const s = summarizeReport(report({ scanned_files: 0, correction_count: 0, proposals: [], sources: [] }));
		expect(s.hasWork).toBe(false);
		expect(s.message).toContain("ส่งออก");
	});

	test("everything already learned reads as up-to-date, not as an empty result", () => {
		const s = summarizeReport(report({ scanned_files: 3, skipped_already_learned: 3, correction_count: 0, proposals: [], sources: [] }));
		expect(s.hasWork).toBe(false);
		expect(s.message).toContain("เรียนรู้ครบแล้ว");
	});

	test("exports exist but nobody corrected an account code — also nothing to learn", () => {
		const s = summarizeReport(report({ correction_count: 0, proposals: [], sources: [] }));
		expect(s.hasWork).toBe(false);
		expect(s.message).toContain("ไม่พบการแก้ผังบัญชี");
	});

	test("real proposals report their counts", () => {
		const s = summarizeReport(report());
		expect(s.hasWork).toBe(true);
		expect(s.message).toContain("1");
		expect(s.message).toContain("4");
	});
});

describe("buildReviewPrompt", () => {
	const prompt = buildReviewPrompt(report(), "/w/216");

	test("the judge gets the evidence it needs and the client's own context paths", () => {
		expect(prompt).toContain("expense_hints:530407||");
		expect(prompt).toContain("510110||"); // what the AI had picked
		expect(prompt).toContain("/w/216/CLIENT.md");
		expect(prompt).toContain("/w/216/coa.csv");
	});

	test("the review spawn refuses the write tools outright, not just by instruction", () => {
		// asserted on the module source: the flags are the only real guarantee
		// import.meta.dir, not new URL(...).pathname: the latter yields "/C:/..."
		// on Windows, which is not a path any fs call can open.
		const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "learn.ts"), "utf8");
		expect(src).toContain('"--disallowedTools"');
		expect(src).toContain("Write,Edit,NotebookEdit,Bash");
	});

	test("it asks for one verdict per proposal in a fixed JSON shape, and nothing written", () => {
		expect(prompt).toContain('"verdicts"');
		expect(prompt).toContain('"proposal_id"');
		expect(prompt).toContain('"notes"');
		expect(prompt).toMatch(/ห้ามแก้ไข|do not (write|edit)/i);
	});

	test("the one-off-vs-pattern question #37 named is actually asked", () => {
		expect(prompt).toMatch(/one-off|ครั้งเดียว/i);
	});
});

describe("parseAgentReview", () => {
	const body = { verdicts: [{ proposal_id: "expense_hints:530407||", verdict: "reject", reason: "เอกสารใบเดียว" }], notes: [{ title: "t", detail: "d" }] };

	test("a fenced JSON block is read out of the surrounding prose", () => {
		const parsed = parseAgentReview(`ตรวจแล้วครับ\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`);
		expect(parsed?.verdicts[0]).toMatchObject({ proposal_id: "expense_hints:530407||", verdict: "reject" });
		expect(parsed?.notes).toEqual([{ title: "t", detail: "d" }]);
	});

	test("bare JSON works too", () => {
		expect(parseAgentReview(JSON.stringify(body))?.verdicts).toHaveLength(1);
	});

	test("prose with no JSON at all degrades to null rather than throwing", () => {
		expect(parseAgentReview("ผมคิดว่าน่าจะโอเคนะครับ")).toBeNull();
		expect(parseAgentReview("")).toBeNull();
	});

	test("a verdict that isn't accept/reject, or has no id, is dropped", () => {
		const parsed = parseAgentReview(JSON.stringify({ verdicts: [{ proposal_id: "x", verdict: "maybe" }, { verdict: "accept" }, { proposal_id: "y", verdict: "accept" }] }));
		expect(parsed?.verdicts).toEqual([{ proposal_id: "y", verdict: "accept", reason: "" }]);
	});

	test("malformed notes are filtered, not trusted through to the notes file", () => {
		const parsed = parseAgentReview(JSON.stringify({ verdicts: [], notes: [{ title: "ok", detail: "d" }, { title: 5 }, "nope"] }));
		expect(parsed?.notes).toEqual([{ title: "ok", detail: "d" }]);
	});
});

describe("decorateProposals", () => {
	test("with no agent review at all, every proposal is still shown — unchecked, and said so", () => {
		const decorated = decorateProposals(report().proposals, null);
		expect(decorated[0]).toMatchObject({ id: PROPOSAL.id, checked: false, verdict: "unreviewed" });
	});

	test("an accepted verdict pre-checks the row; a rejected one leaves it off with the reason", () => {
		const decorated = decorateProposals([PROPOSAL, { ...PROPOSAL, id: "expense_hints:510110||" }], {
			verdicts: [
				{ proposal_id: PROPOSAL.id, verdict: "accept", reason: "ซ้ำหลายเดือน" },
				{ proposal_id: "expense_hints:510110||", verdict: "reject", reason: "ครั้งเดียว" },
			],
			notes: [],
		});
		expect(decorated[0]).toMatchObject({ checked: true, verdict: "accept", reason: "ซ้ำหลายเดือน" });
		expect(decorated[1]).toMatchObject({ checked: false, verdict: "reject", reason: "ครั้งเดียว" });
	});

	test("a proposal the agent never mentioned stays unreviewed rather than silently accepted", () => {
		const decorated = decorateProposals([PROPOSAL], { verdicts: [{ proposal_id: "other", verdict: "accept", reason: "" }], notes: [] });
		expect(decorated[0]).toMatchObject({ checked: false, verdict: "unreviewed" });
	});

	test("an account missing from coa.csv is never pre-checked, whatever the agent said", () => {
		const decorated = decorateProposals([{ ...PROPOSAL, in_coa: false }], { verdicts: [{ proposal_id: PROPOSAL.id, verdict: "accept", reason: "" }], notes: [] });
		expect(decorated[0].checked).toBe(false);
	});
});

describe("parseDecisionBody", () => {
	test("only strings survive from the accept, source and handled lists", () => {
		const d = parseDecisionBody({
			accept: ["a", 5, null, "b"],
			sources: ["k", 1, null],
			notes: [{ title: "t", detail: "d" }, { title: "no detail" }],
			handled: ["n1", 2, null, "n2"],
		});
		expect(d.accept).toEqual(["a", "b"]);
		expect(d.sources).toEqual(["k"]);
		expect(d.notes).toEqual([{ title: "t", detail: "d" }]);
		expect(d.handled).toEqual(["n1", "n2"]);
	});

	test("a body with nothing usable becomes an empty decision, not a crash", () => {
		expect(parseDecisionBody(null)).toEqual({ accept: [], sources: [], notes: [], handled: undefined });
		expect(parseDecisionBody({ accept: "all" })).toEqual({ accept: [], sources: [], notes: [], handled: undefined });
	});

	test("an EMPTY handled list survives as [] — it means 'un-handle every note', not 'no opinion'", () => {
		expect(parseDecisionBody({ handled: [] }).handled).toEqual([]);
	});

	test("a missing handled field stays undefined, so an --apply caller that ignores notes never clears anyone's ticks", () => {
		expect(parseDecisionBody({ accept: ["a"] }).handled).toBeUndefined();
	});
});

describe("hasAnythingToConfirm", () => {
	test("fresh proposals alone are enough to show the confirm button", () => {
		expect(hasAnythingToConfirm(true, [])).toBe(true);
	});

	test("no proposals and no notes at all — nothing to confirm", () => {
		expect(hasAnythingToConfirm(false, [])).toBe(false);
	});

	test("no proposals but an unhandled note pending — the load-bearing case from #47: the dialog must still open", () => {
		expect(hasAnythingToConfirm(false, [note({ handled: false })])).toBe(true);
	});

	test("no proposals and every stored note already handled — truly nothing left to do", () => {
		expect(hasAnythingToConfirm(false, [note({ handled: true })])).toBe(false);
	});
});

describe("summarizeWithNotes", () => {
	test("no unhandled notes leaves the original summary untouched", () => {
		const summary = summarizeReport(report({ correction_count: 0, proposals: [], sources: [] }));
		expect(summarizeWithNotes(summary, [])).toEqual(summary);
		expect(summarizeWithNotes(summary, [note({ handled: true })])).toEqual(summary);
	});

	test("an empty-proposals summary gains a note count instead of just reading as 'nothing to do'", () => {
		const summary = summarizeReport(report({ correction_count: 0, proposals: [], sources: [] }));
		const withNotes = summarizeWithNotes(summary, [note({ handled: false }), note({ id: "def", handled: true })]);
		expect(withNotes.message).toContain(summary.message);
		expect(withNotes.message).toContain("1");
		expect(withNotes.hasWork).toBe(false);
	});

	test("the four distinct hasWork:true / hasWork:false messages stay distinguishable even with notes appended", () => {
		const noExport = summarizeWithNotes(summarizeReport(report({ scanned_files: 0, correction_count: 0, proposals: [], sources: [] })), [note()]);
		const upToDate = summarizeWithNotes(summarizeReport(report({ skipped_already_learned: 3, correction_count: 0, proposals: [], sources: [] })), [note()]);
		const nothingCorrected = summarizeWithNotes(summarizeReport(report({ correction_count: 0, proposals: [], sources: [] })), [note()]);
		expect(noExport.message).toContain("ส่งออก");
		expect(upToDate.message).toContain("เรียนรู้ครบแล้ว");
		expect(nothingCorrected.message).toContain("ไม่พบการแก้ผังบัญชี");
		expect(new Set([noExport.message, upToDate.message, nothingCorrected.message]).size).toBe(3);
	});
});
