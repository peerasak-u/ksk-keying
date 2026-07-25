import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountCorrections,
	appendLearningNotes,
	applyDecision,
	applyProposals,
	buildProposals,
	buildReport,
	correctionId,
	familyForBucket,
	freshCorrections,
	isAlreadyLearned,
	type ChangesSource,
	type Correction,
	type CoaUsage,
} from "../learn";

const src = (over: Partial<ChangesSource> = {}): ChangesSource => ({
	key: "เดือนพฤษภาคม/ข้อมูลระบบ/_doc_groups/expense/vat/seg-001/changes.json",
	month_id: "เดือนพฤษภาคม",
	bucket: "expense/vat",
	group_id: "seg-001",
	...over,
});

const correction = (over: Partial<Correction> = {}): Correction => ({
	source: src(),
	entry_id: correctionId("seg-001-p1#L0", "510110||", "530407||"),
	line_id: "seg-001-p1#L0",
	before_key: "510110||",
	after_key: "530407||",
	description: "ค่าจ้างทำของ ติดตั้งป้าย",
	tax_id: "0105556090377",
	...over,
});

const COA = [
	{ account_code: "530407", sub_code: "", name_th: "ค่าจ้างทำของ", name_en: "hire of work" },
	{ account_code: "510110", sub_code: "", name_th: "ซื้อวัตถุดิบ", name_en: "raw material" },
	{ account_code: "410201", sub_code: "", name_th: "รายได้จากการให้บริการ", name_en: "service income" },
];

describe("familyForBucket", () => {
	test("routes each bucket to the coa_usage hint family it belongs to", () => {
		expect(familyForBucket("expense/vat")).toBe("expense_hints");
		expect(familyForBucket("expense/mixed")).toBe("expense_hints");
		expect(familyForBucket("income/non_vat")).toBe("income_hints");
		expect(familyForBucket("bank_statement")).toBe("bank_hints");
	});
});

describe("accountCorrections", () => {
	const doc = {
		schema: "ksk_review_changes.v1",
		group_id: "seg-001",
		computed_at: "2026-07-20T00:00:00.000Z",
		entries: [
			{ line_id: "p1#L0", field: "account_code", before: "510110||", after: "530407||" },
			{ line_id: "p1#L0", field: "facts.total", before: 100, after: 120 },
			{ line_id: "p1#L1", field: "skipped", before: false, after: true },
			{ line_id: "p1#L2", field: "account_code", before: "510110||", after: 42 },
			{ line_id: "p1#L3", field: "account_code", before: "510110||", after: "" },
		],
	};

	test("only account_code entries with a real string target count as signal", () => {
		const found = accountCorrections(doc, src(), () => ({ description: null, tax_id: null }));
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ line_id: "p1#L0", before_key: "510110||", after_key: "530407||" });
	});

	test("a wrong or missing schema contributes nothing rather than throwing", () => {
		expect(accountCorrections({ ...doc, schema: "something_else" }, src(), () => ({ description: null, tax_id: null }))).toEqual([]);
		expect(accountCorrections(null, src(), () => ({ description: null, tax_id: null }))).toEqual([]);
	});

	test("context (description/tax_id) is pulled per line through the injected lookup", () => {
		const found = accountCorrections(doc, src(), (lineId) => ({ description: `desc:${lineId}`, tax_id: "0105556090377" }));
		expect(found[0].description).toBe("desc:p1#L0");
		expect(found[0].tax_id).toBe("0105556090377");
	});
});

describe("buildProposals", () => {
	test("corrections to the same account collapse into one proposal with counts", () => {
		const proposals = buildProposals(
			[correction(), correction({ line_id: "p1#L1", description: "ติดตั้งระบบไฟ" })],
			COA,
			{},
		);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({
			family: "expense_hints",
			account_code: "530407",
			sub_code: "",
			label: "ค่าจ้างทำของ",
			correction_count: 2,
			is_new_hint: true,
			in_coa: true,
		});
		expect(proposals[0].tax_id_counts).toEqual([{ tax_id: "0105556090377", count: 2 }]);
	});

	test("what the AI had chosen before is carried as evidence for the judgment pass", () => {
		const [proposal] = buildProposals([correction(), correction({ before_key: "510113||" })], COA, {});
		expect(proposal.from_accounts).toEqual([
			{ account_key: "510110||", count: 1 },
			{ account_key: "510113||", count: 1 },
		]);
	});

	test("an existing hint's history rides along so a one-off can be told from a pattern", () => {
		const usage: CoaUsage = {
			expense_hints: [{ account_code: "530407", sub_code: "", label: "ค่าจ้างทำของ", keywords: ["ค่าจ้าง"], tax_ids: [{ tax_id: "0105556090377", count: 12 }] }],
		};
		const [proposal] = buildProposals([correction()], COA, usage);
		expect(proposal.is_new_hint).toBe(false);
		expect(proposal.existing_tax_id_counts).toEqual([{ tax_id: "0105556090377", count: 12 }]);
	});

	test("an account that isn't in coa.csv is proposed but flagged, never silently dropped", () => {
		const [proposal] = buildProposals([correction({ after_key: "999999||X" })], COA, {});
		expect(proposal).toMatchObject({ account_code: "999999", sub_code: "X", in_coa: false, label: "999999-X" });
	});

	test("income buckets land in income_hints, statements in bank_hints", () => {
		const proposals = buildProposals(
			[
				correction({ source: src({ bucket: "income/vat" }), after_key: "410201||" }),
				correction({ source: src({ bucket: "bank_statement" }), after_key: "410201||", tax_id: null }),
			],
			COA,
			{},
		);
		expect(proposals.map((p) => p.family).sort()).toEqual(["bank_hints", "income_hints"]);
	});

	test("keywords come from the corrected lines' own descriptions, deduped", () => {
		const [proposal] = buildProposals([correction({ description: "ค่าจ้างทำของ ติดตั้ง" }), correction({ description: "ค่าจ้างทำของ ป้าย" })], COA, {});
		expect(proposal.keywords).toContain("ค่าจ้างทำของ");
		expect(proposal.keywords.filter((k) => k === "ค่าจ้างทำของ")).toHaveLength(1);
	});

	test("examples are carried for the reviewer but bounded", () => {
		const many = Array.from({ length: 9 }, (_, i) => correction({ line_id: `p1#L${i}` }));
		const [proposal] = buildProposals(many, COA, {});
		expect(proposal.correction_count).toBe(9);
		expect(proposal.examples.length).toBeLessThanOrEqual(3);
		expect(proposal.examples[0]).toMatchObject({ month_id: "เดือนพฤษภาคม", group_id: "seg-001" });
	});
});

describe("applyProposals", () => {
	const proposalsOf = (usage: CoaUsage = {}) => buildProposals([correction()], COA, usage);

	test("an accepted proposal appends a brand-new hint with its evidence", () => {
		const usage: CoaUsage = {};
		const result = applyProposals(usage, proposalsOf(), new Set(["expense_hints:530407||"]), [correction()], "2026-07-26T00:00:00.000Z");
		expect(result.hintsAdded).toBe(1);
		expect(usage.expense_hints).toHaveLength(1);
		expect(usage.expense_hints![0]).toMatchObject({ account_code: "530407", label: "ค่าจ้างทำของ" });
		expect(usage.expense_hints![0].tax_ids).toEqual([{ tax_id: "0105556090377", count: 1 }]);
	});

	test("an existing hint is incremented, never replaced — history is additive-only", () => {
		const usage: CoaUsage = {
			expense_hints: [{ account_code: "530407", sub_code: "", label: "ค่าจ้างทำของ (เดิม)", keywords: ["เดิม"], tax_ids: [{ tax_id: "0105556090377", count: 3 }], notes: "ห้ามหาย" }],
		};
		applyProposals(usage, proposalsOf(usage), new Set(["expense_hints:530407||"]), [correction()], "2026-07-26T00:00:00.000Z");
		expect(usage.expense_hints).toHaveLength(1);
		const hint = usage.expense_hints![0];
		expect(hint.label).toBe("ค่าจ้างทำของ (เดิม)");
		expect(hint.notes).toBe("ห้ามหาย");
		expect(hint.tax_ids).toEqual([{ tax_id: "0105556090377", count: 4 }]);
		expect(hint.keywords).toContain("เดิม");
	});

	test("a rejected proposal writes nothing at all", () => {
		const usage: CoaUsage = {};
		const result = applyProposals(usage, proposalsOf(), new Set(), [correction()], "2026-07-26T00:00:00.000Z");
		expect(result.hintsAdded).toBe(0);
		expect(usage.expense_hints).toEqual([]);
	});

	test("every correction considered is recorded — including rejected ones, so they don't come back forever", () => {
		const usage: CoaUsage = {};
		applyProposals(usage, proposalsOf(), new Set(), [correction()], "2026-07-26T00:00:00.000Z");
		expect(usage.learned_from![src().key]).toEqual([correction().entry_id]);
		expect(usage.learned_at).toBe("2026-07-26T00:00:00.000Z");
	});

	test("recording the same correction twice leaves one fingerprint, not two", () => {
		const usage: CoaUsage = {};
		applyProposals(usage, proposalsOf(), new Set(), [correction(), correction()], "2026-07-26T00:00:00.000Z");
		expect(usage.learned_from![src().key]).toHaveLength(1);
	});
});

describe("idempotency is per correction, not per file", () => {
	const usage: CoaUsage = { learned_from: { "a/changes.json": ["abc123"] } };

	test("a correction is skipped only when that exact fingerprint was recorded for that file", () => {
		expect(isAlreadyLearned(usage, "a/changes.json", "abc123")).toBe(true);
		expect(isAlreadyLearned(usage, "a/changes.json", "def456")).toBe(false);
		expect(isAlreadyLearned(usage, "b/changes.json", "abc123")).toBe(false);
	});

	test("the fingerprint depends on the edit itself, never on when it was exported", () => {
		expect(correctionId("p1#L0", "510110||", "530407||")).toBe(correctionId("p1#L0", "510110||", "530407||"));
		expect(correctionId("p1#L0", "510110||", "530407||")).not.toBe(correctionId("p1#L1", "510110||", "530407||"));
		expect(correctionId("p1#L0", "510110||", "530407||")).not.toBe(correctionId("p1#L0", "510110||", "530408||"));
	});

	test("freshCorrections keeps the unlearned ones and counts the rest", () => {
		const learned: CoaUsage = { learned_from: { [src().key]: [correction().entry_id] } };
		const other = correction({ entry_id: "not-learned-yet", line_id: "p1#L9" });
		expect(freshCorrections(learned, [correction(), other])).toEqual({ fresh: [other], skipped: 1 });
	});
});

describe("appendLearningNotes", () => {
	test("notes are appended under a dated heading, never overwriting what's there", () => {
		const existing = "# บันทึกการเรียนรู้\n\n## 2026-07-01\n\n- ของเดิม\n";
		const out = appendLearningNotes(existing, [{ title: "รายได้ค่าก่อสร้างถูกแก้ซ้ำ", detail: "ควรตั้ง coa_conventions" }], "2026-07-26T00:00:00.000Z");
		expect(out.startsWith(existing)).toBe(true);
		expect(out).toContain("## 2026-07-26");
		expect(out).toContain("รายได้ค่าก่อสร้างถูกแก้ซ้ำ");
		expect(out).toContain("ควรตั้ง coa_conventions");
	});

	test("an empty file gets its own header first", () => {
		const out = appendLearningNotes("", [{ title: "x", detail: "y" }], "2026-07-26T00:00:00.000Z");
		expect(out).toContain("# บันทึกการเรียนรู้");
	});

	test("no notes means the file is left byte-identical", () => {
		expect(appendLearningNotes("keep me", [], "2026-07-26T00:00:00.000Z")).toBe("keep me");
	});
});

// --- end-to-end against a real client folder -------------------------------

const tmps: string[] = [];
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function fixtureClient(): string {
	const dir = mkdtempSync(join(tmpdir(), "ksk-learn-"));
	tmps.push(dir);
	writeFileSync(join(dir, "CLIENT.md"), '---\nclient_name: "ทดสอบ"\ntax_id: "0105556000001"\n---\n');
	writeFileSync(join(dir, "coa.csv"), "account_code,sub_code,name_th,name_en\n530407,,ค่าจ้างทำของ,hire of work\n510110,,ซื้อวัตถุดิบ,raw material\n");

	const groupDir = join(dir, "เดือนพฤษภาคม", "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "seg-001");
	mkdirSync(groupDir, { recursive: true });
	writeFileSync(
		join(groupDir, "changes.json"),
		JSON.stringify({
			schema: "ksk_review_changes.v1",
			group_id: "seg-001",
			computed_at: "2026-07-20T00:00:00.000Z",
			entries: [
				{ line_id: "INV-1#L0", field: "account_code", before: "510110||", after: "530407||" },
				{ line_id: "INV-1#L0", field: "facts.total", before: 1, after: 2 },
			],
		}),
	);
	writeFileSync(
		join(groupDir, "review-data.json"),
		JSON.stringify({
			schema: "ksk_review_group_data.v1",
			group_id: "seg-001",
			pages: [
				{
					ref: "INV-1",
					facts: { seller_tax_id: "0105556090377", buyer_tax_id: "0105556000001" },
					lines: [{ line_index: 0, description: "ค่าจ้างทำของ ติดตั้งป้าย", account_code: "530407", sub_code: "" }],
				},
			],
		}),
	);
	return dir;
}

describe("buildReport / applyDecision (real folder)", () => {
	test("walks every month's groups, pulls tax_id + keywords from review-data, and proposes", () => {
		const report = buildReport(fixtureClient());
		expect(report).toMatchObject({ schema: "ksk_learn_report.v1", scanned_files: 1, skipped_already_learned: 0, correction_count: 1 });
		expect(report.sources).toEqual(["เดือนพฤษภาคม/ข้อมูลระบบ/_doc_groups/expense/vat/seg-001/changes.json"]);
		expect(report.proposals).toHaveLength(1);
		// the client's own tax_id is never the counterparty
		expect(report.proposals[0].tax_id_counts).toEqual([{ tax_id: "0105556090377", count: 1 }]);
		expect(report.proposals[0].keywords).toContain("ค่าจ้างทำของ");
	});

	test("applying writes coa_usage.json + learning-notes.md, and a second pass then finds nothing", () => {
		const dir = fixtureClient();
		const report = buildReport(dir);
		const result = applyDecision(
			dir,
			{ accept: report.proposals.map((p) => p.id), sources: report.sources, notes: [{ title: "ควรตั้ง convention", detail: "ค่าจ้างทำของถูกแก้ซ้ำ" }] },
			"2026-07-26T00:00:00.000Z",
		);
		expect(result).toMatchObject({ hintsAdded: 1, notesWritten: 1 });

		const usage = JSON.parse(readFileSync(join(dir, "coa_usage.json"), "utf8"));
		expect(usage.expense_hints[0]).toMatchObject({ account_code: "530407", label: "ค่าจ้างทำของ" });
		expect(readFileSync(join(dir, "learning-notes.md"), "utf8")).toContain("ควรตั้ง convention");

		const second = buildReport(dir);
		expect(second).toMatchObject({ scanned_files: 1, skipped_already_learned: 1, correction_count: 0 });
		expect(second.proposals).toEqual([]);

		// A re-export rewrites changes.json with a fresh computed_at and the SAME
		// correction — the count must not creep up (the bug a file-level
		// watermark would have).
		const changesPath = join(dir, "เดือนพฤษภาคม", "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "seg-001", "changes.json");
		const reExported = JSON.parse(readFileSync(changesPath, "utf8"));
		reExported.computed_at = "2026-07-27T00:00:00.000Z";
		writeFileSync(changesPath, JSON.stringify(reExported));
		expect(buildReport(dir)).toMatchObject({ skipped_already_learned: 1, correction_count: 0 });
		applyDecision(dir, { accept: [], sources: [], notes: [] }, "2026-07-27T00:00:00.000Z");
		const usageAfter = JSON.parse(readFileSync(join(dir, "coa_usage.json"), "utf8"));
		expect(usageAfter.expense_hints[0].tax_ids).toEqual([{ tax_id: "0105556090377", count: 1 }]);
	});

	test("a client with no exported changes.json at all yields an empty report, not an error", () => {
		const dir = mkdtempSync(join(tmpdir(), "ksk-learn-empty-"));
		tmps.push(dir);
		expect(buildReport(dir)).toMatchObject({ scanned_files: 0, correction_count: 0, proposals: [], sources: [] });
	});
});
