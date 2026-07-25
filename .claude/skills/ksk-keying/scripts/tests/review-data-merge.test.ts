import { describe, expect, test } from "bun:test";
import {
	appendDroppedEdits,
	DROP_LIMIT,
	FLAG_BAILED,
	FLAG_NO_BASELINE,
	flagLostEdits,
	flagLostSkips,
	lineFingerprintOf,
	mergeReviewData,
	pageKeyOf,
	rowFingerprintOf,
	rowIdentityFingerprintOf,
	type BaselineState,
	type CurrentState,
	type DroppedEditsRebuild,
	type ReviewDataObject,
} from "../review-data-merge";

// --- fixtures ---------------------------------------------------------------

function clone<T>(v: T): T {
	return structuredClone(v);
}

function present(data: ReviewDataObject): BaselineState & CurrentState {
	return { kind: "present", data };
}
function absent(): BaselineState & CurrentState {
	return { kind: "absent" };
}
function unreadable(detail: string): BaselineState & CurrentState {
	return { kind: "unreadable", detail };
}

function line(overrides: Partial<ReviewDataObject> = {}): ReviewDataObject {
	return {
		line_index: 0,
		description: "ของ A",
		qty: 1,
		unit: null,
		unit_price: 1000,
		amount: 1000,
		amount_includes_vat: false,
		vat_treatment: null,
		account_code: "5300",
		sub_code: "01",
		account_name_th: "ค่าใช้จ่ายทั่วไป",
		confidence: "high",
		reason: "",
		needs_review: false,
		...overrides,
	};
}

function page(overrides: Partial<ReviewDataObject> = {}): ReviewDataObject {
	return {
		ref: "seg-001-INV-001/บิลซื้อ.pdf p.5",
		short_ref: "บิลซื้อ.pdf p.5",
		source_src: "บิลซื้อ.pdf",
		source_page: 5,
		source_pages: [5],
		source_sheet: null,
		image_src: null,
		extract_path: "seg-001-INV-001/interpretation.json",
		categorize_path: "seg-001-INV-001/categorize.json",
		facts: { date: "2026-05-22", total: 1000, seller: "หจก.ตัวอย่าง" },
		lines: [line()],
		initial_status: "reviewed",
		skipped: false,
		...overrides,
	};
}

function doc(pages: ReviewDataObject[], overrides: Partial<ReviewDataObject> = {}): ReviewDataObject {
	return {
		schema: "ksk_review_group_data.v1",
		group_id: "seg-001-INV-001",
		label: "test group",
		review_flags: [],
		pages,
		...overrides,
	};
}

function row(overrides: Partial<ReviewDataObject> = {}): ReviewDataObject {
	return {
		row_index: 0,
		date_iso: "2026-05-01",
		time: null,
		description: "โอนเงิน",
		counterparty: "บริษัท เอ",
		direction: "out",
		amount: 500,
		balance: 10000,
		account_code: "1000",
		sub_code: "",
		account_name_th: "เงินสด",
		confidence: "high",
		reason: "",
		needs_review: false,
		skipped: false,
		...overrides,
	};
}

function statement(rows: ReviewDataObject[], overrides: Partial<ReviewDataObject> = {}): ReviewDataObject {
	return {
		schema: "ksk_review_statement_data.v1",
		group_id: "bank-001",
		label: "test bank",
		statement: {
			bank: "SCB",
			account_no: "123",
			account_holder: "x",
			period: "2026-05",
			opening_balance: 0,
			closing_balance: 0,
			bank_account_code: "1000",
			bank_sub_code: "",
		},
		source: { source_src: "statement.pdf", source_page: 1, source_pages: [1], source_sheet: null, image_src: null },
		review_flags: [],
		questions_for_user: [],
		rows,
		...overrides,
	};
}

function pagesOf(data: ReviewDataObject): ReviewDataObject[] {
	return data.pages as ReviewDataObject[];
}
function rowsOf(data: ReviewDataObject): ReviewDataObject[] {
	return data.rows as ReviewDataObject[];
}
function statementOf(data: ReviewDataObject): ReviewDataObject {
	return data.statement as ReviewDataObject;
}
function flagsOf(data: ReviewDataObject): string[] {
	return (data.review_flags as string[]) ?? [];
}

// --- document mode, exact ----------------------------------------------------

describe("mergeReviewData — document mode, exact", () => {
	test("no current file: outcome fresh, data deep-equals fresh", () => {
		const fresh = doc([page()]);
		const result = mergeReviewData({ groupId: fresh.group_id as string, fresh, baseline: absent(), current: absent() });
		expect(result.report.outcome).toBe("fresh");
		expect(result.data).toEqual(fresh);
		expect(result.report.dropped).toEqual([]);
	});

	test("current identical to baseline: outcome clean, zero carried, data deep-equals fresh", () => {
		const baseline = doc([page()]);
		const fresh = clone(baseline);
		const current = clone(baseline);
		const result = mergeReviewData({ groupId: fresh.group_id as string, fresh, baseline: present(baseline), current: present(current) });
		expect(result.report.outcome).toBe("clean");
		expect(result.report.carried).toBe(0);
		expect(result.report.dropped).toEqual([]);
		expect(result.data).toEqual(fresh);
	});

	test("human edited facts.total, AI unchanged: carried, merged value is human's", () => {
		const baseline = doc([page({ facts: { date: "2026-05-22", total: 1000, seller: "หจก.ตัวอย่าง" } })]);
		const fresh = clone(baseline);
		const current = clone(baseline);
		(pagesOf(current)[0].facts as ReviewDataObject).total = 1234;
		const result = mergeReviewData({ groupId: fresh.group_id as string, fresh, baseline: present(baseline), current: present(current) });
		expect(result.report.outcome).toBe("merged");
		expect(result.report.carried).toBeGreaterThanOrEqual(1);
		expect((pagesOf(result.data)[0].facts as ReviewDataObject).total).toBe(1234);
		expect(result.report.dropped).toEqual([]);
	});

	test("human edited facts.total AND AI changed it: fresh wins, dropped entry recorded, flagged, needs_attention", () => {
		const baseline = doc([page({ facts: { date: "2026-05-22", total: 1000, seller: "s" } })]);
		const current = clone(baseline);
		(pagesOf(current)[0].facts as ReviewDataObject).total = 1234;
		const fresh = clone(baseline);
		(pagesOf(fresh)[0].facts as ReviewDataObject).total = 2000;

		const result = mergeReviewData({ groupId: fresh.group_id as string, fresh, baseline: present(baseline), current: present(current) });

		expect((pagesOf(result.data)[0].facts as ReviewDataObject).total).toBe(2000);
		const drop = result.report.dropped.find((d) => d.field === "facts.total");
		expect(drop).toEqual({ item: expect.any(String), field: "facts.total", human_value: 1234, ai_before: 1000, ai_after: 2000, reason: "ai_changed" });
		expect(result.report.flags).toContain(flagLostEdits(1));
		for (const p of pagesOf(result.data)) expect(p.initial_status).toBe("needs_attention");
	});

	test("human changed a line's account, AI kept it: all three account fields carried together", () => {
		const baseline = doc([page({ lines: [line({ account_code: "5300", sub_code: "01", account_name_th: "A" })] })]);
		const fresh = clone(baseline);
		const current = clone(baseline);
		const cLine = pagesOf(current)[0].lines as ReviewDataObject[];
		cLine[0].account_code = "5310";
		cLine[0].sub_code = "02";
		cLine[0].account_name_th = "B";

		const result = mergeReviewData({ groupId: fresh.group_id as string, fresh, baseline: present(baseline), current: present(current) });
		const mergedLine = (pagesOf(result.data)[0].lines as ReviewDataObject[])[0];
		expect(mergedLine.account_code).toBe("5310");
		expect(mergedLine.sub_code).toBe("02");
		expect(mergedLine.account_name_th).toBe("B");
	});

	test("human edited line description AND AI re-categorized the same line: description carried, new account code kept", () => {
		const baseline = doc([page({ lines: [line({ description: "ของ A", account_code: "5300", sub_code: "01" })] })]);
		const current = clone(baseline);
		(pagesOf(current)[0].lines as ReviewDataObject[])[0].description = "ของ A แก้ไข";
		const fresh = clone(baseline);
		(pagesOf(fresh)[0].lines as ReviewDataObject[])[0].account_code = "5310";
		(pagesOf(fresh)[0].lines as ReviewDataObject[])[0].sub_code = "02";

		const result = mergeReviewData({ groupId: fresh.group_id as string, fresh, baseline: present(baseline), current: present(current) });
		const mergedLine = (pagesOf(result.data)[0].lines as ReviewDataObject[])[0];
		expect(mergedLine.description).toBe("ของ A แก้ไข");
		expect(mergedLine.account_code).toBe("5310");
	});

	// The whole reason line matching uses content fingerprints, not
	// line_index: a re-interpretation that inserts a new line at the front
	// shifts every following line_index by one, and a naive positional merge
	// would slam the old edit onto the wrong (brand-new) line.
	test("index shift: fresh inserts a new line at index 0 — edit lands on the fingerprint-matched line, not on line_index 1", () => {
		const baseline = doc([
			page({
				lines: [line({ line_index: 0, description: "A", amount: 1000 }), line({ line_index: 1, description: "B", amount: 500 })],
			}),
		]);
		const current = clone(baseline);
		(pagesOf(current)[0].lines as ReviewDataObject[])[1].description = "B แก้ไข";

		const fresh = doc([
			page({
				lines: [
					line({ line_index: 0, description: "รายการใหม่", amount: 200 }),
					line({ line_index: 1, description: "A", amount: 1000 }),
					line({ line_index: 2, description: "B", amount: 500 }),
				],
			}),
		]);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		const lines = pagesOf(result.data)[0].lines as ReviewDataObject[];
		expect(lines.find((l) => l.line_index === 2)?.description).toBe("B แก้ไข");
		expect(lines.find((l) => l.line_index === 1)?.description).toBe("A");
		expect(lines.find((l) => l.line_index === 0)?.description).toBe("รายการใหม่");
	});

	test("a line that vanished from the fresh build: its edits are dropped with reason item_not_matched", () => {
		const baseline = doc([
			page({
				lines: [line({ line_index: 0, description: "A", amount: 1000 }), line({ line_index: 1, description: "B", amount: 500 })],
			}),
		]);
		const current = clone(baseline);
		(pagesOf(current)[0].lines as ReviewDataObject[])[1].description = "B แก้ไข";
		const fresh = doc([page({ lines: [line({ line_index: 0, description: "A", amount: 1000 })] })]);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		const drop = result.report.dropped.find((d) => d.field === "description" && d.reason === "item_not_matched");
		expect(drop?.human_value).toBe("B แก้ไข");
		expect(drop?.ai_before).toBe("B");
		expect(drop?.ai_after).toBeNull();
	});

	test("skipped:true on a matched page survives", () => {
		const baseline = doc([page({ skipped: false })]);
		const current = clone(baseline);
		pagesOf(current)[0].skipped = true;
		const fresh = clone(baseline);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		expect(pagesOf(result.data)[0].skipped).toBe(true);
		expect(result.report.carried).toBeGreaterThanOrEqual(1);
	});

	test("skipped:true on a page whose source vanished: dropped, lostSkips 1, flagLostSkips injected", () => {
		const baseline = doc([page({ source_src: "a.pdf", ref: "g/a.pdf" })]);
		const current = clone(baseline);
		pagesOf(current)[0].skipped = true;
		const fresh = doc([page({ source_src: "b.pdf", ref: "g/b.pdf" })]);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		expect(result.report.lostSkips).toBe(1);
		expect(result.report.flags).toContain(flagLostSkips(1));
		const drop = result.report.dropped.find((d) => d.field === "skipped");
		expect(drop?.reason).toBe("item_not_matched");
		expect(drop?.human_value).toBe(true);
	});

	test("two lines_owner pages whose current lines diverged: each page merges independently", () => {
		const baseline = doc([
			page({ ref: "g/p1", source_src: "p1.pdf", lines: [line({ description: "X" })] }),
			page({ ref: "g/p2", source_src: "p2.pdf", lines: [line({ description: "X" })] }),
		]);
		const current = clone(baseline);
		(pagesOf(current)[0].lines as ReviewDataObject[])[0].description = "X แก้1";
		(pagesOf(current)[1].lines as ReviewDataObject[])[0].description = "X แก้2";
		const fresh = clone(baseline);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		const pages = pagesOf(result.data);
		const p1 = pages.find((p) => p.source_src === "p1.pdf");
		const p2 = pages.find((p) => p.source_src === "p2.pdf");
		expect((p1?.lines as ReviewDataObject[])[0].description).toBe("X แก้1");
		expect((p2?.lines as ReviewDataObject[])[0].description).toBe("X แก้2");
	});

	test("a human-added facts key not present in baseline or fresh is carried", () => {
		const baseline = doc([page({ facts: { total: 1000 } })]);
		const current = clone(baseline);
		(pagesOf(current)[0].facts as ReviewDataObject).note = "human note";
		const fresh = clone(baseline);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		expect((pagesOf(result.data)[0].facts as ReviewDataObject).note).toBe("human note");
	});
});

// --- statement mode, exact ---------------------------------------------------

describe("mergeReviewData — statement mode, exact", () => {
	test("row amount edit carried", () => {
		const baseline = statement([row({ row_index: 0, amount: 500 })]);
		const current = clone(baseline);
		(rowsOf(current)[0]).amount = 600;
		const fresh = clone(baseline);

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: present(baseline), current: present(current) });
		expect(rowsOf(result.data)[0].amount).toBe(600);
		expect(result.report.carried).toBeGreaterThanOrEqual(1);
	});

	test("duplicate-fingerprint rows match by ordinal; edits stay on their own row", () => {
		const dupe = () => row({ date_iso: "2026-05-01", direction: "out" as const, amount: 100, description: "transfer", counterparty: "X" });
		const baseline = statement([{ ...dupe(), row_index: 0 }, { ...dupe(), row_index: 1 }]);
		const current = clone(baseline);
		rowsOf(current)[0].amount = 150; // edit only row_index 0
		const fresh = statement([{ ...dupe(), row_index: 0 }, { ...dupe(), row_index: 1 }]);

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: present(baseline), current: present(current) });
		const rows = rowsOf(result.data);
		expect(rows.find((r) => r.row_index === 0)?.amount).toBe(150);
		expect(rows.find((r) => r.row_index === 1)?.amount).toBe(100);
	});

	test("three old duplicates vs two new: the third is item_not_matched", () => {
		const dupe = () => row({ date_iso: "2026-05-01", direction: "out" as const, amount: 100, description: "transfer", counterparty: "X" });
		const baseline = statement([{ ...dupe(), row_index: 0 }, { ...dupe(), row_index: 1 }, { ...dupe(), row_index: 2 }]);
		const current = clone(baseline);
		rowsOf(current)[2].amount = 999;
		const fresh = statement([{ ...dupe(), row_index: 0 }, { ...dupe(), row_index: 1 }]);

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: present(baseline), current: present(current) });
		const drop = result.report.dropped.find((d) => d.field === "amount" && d.reason === "item_not_matched");
		expect(drop?.human_value).toBe(999);
		expect(drop?.ai_before).toBe(100);
	});

	test("confirmed bank_account_code carried when the AI proposal is unchanged", () => {
		const baseline = statement([row()], { statement: { bank_account_code: "1000", bank_sub_code: "" } });
		const current = clone(baseline);
		statementOf(current).bank_account_code = "1010";
		statementOf(current).bank_sub_code = "01";
		const fresh = clone(baseline);

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: present(baseline), current: present(current) });
		expect(statementOf(result.data).bank_account_code).toBe("1010");
		expect(statementOf(result.data).bank_sub_code).toBe("01");
	});

	test("confirmed bank_account_code vs a changed AI proposal: AI wins, recorded, flagged", () => {
		const baseline = statement([row()], { statement: { bank_account_code: "1000", bank_sub_code: "" } });
		const current = clone(baseline);
		statementOf(current).bank_account_code = "1010";
		statementOf(current).bank_sub_code = "01";
		const fresh = clone(baseline);
		statementOf(fresh).bank_account_code = "2000";
		statementOf(fresh).bank_sub_code = "";

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: present(baseline), current: present(current) });
		expect(statementOf(result.data).bank_account_code).toBe("2000");
		const drop = result.report.dropped.find((d) => d.field === "statement.bank_account_key");
		expect(drop?.human_value).toBe("1010||01");
		expect(result.report.flags).toContain(flagLostEdits(1));
	});

	test("row skipped survives an index shift caused by a new transaction appearing earlier", () => {
		const baseline = statement([row({ row_index: 0, description: "r0", amount: 111 }), row({ row_index: 1, description: "r1", amount: 222 })]);
		const current = clone(baseline);
		rowsOf(current)[1].skipped = true;
		const fresh = statement([
			row({ row_index: 0, description: "new-txn", amount: 999 }),
			row({ row_index: 1, description: "r0", amount: 111 }),
			row({ row_index: 2, description: "r1", amount: 222 }),
		]);

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: present(baseline), current: present(current) });
		const rows = rowsOf(result.data);
		expect(rows.find((r) => r.row_index === 2)?.skipped).toBe(true);
		expect(rows.find((r) => r.row_index === 1)?.skipped).toBe(false);
	});
});

// --- degraded mode ------------------------------------------------------------

describe("mergeReviewData — degraded mode (no baseline)", () => {
	test("page skipped carried by source_src", () => {
		const fresh = doc([page({ source_src: "a.pdf", skipped: false })]);
		const current = clone(fresh);
		pagesOf(current)[0].skipped = true;

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: absent(), current: present(current) });
		expect(result.report.outcome).toBe("degraded");
		expect(pagesOf(result.data)[0].skipped).toBe(true);
	});

	test("row skipped carried by identity fingerprint even though amount and description were also edited", () => {
		const fresh = statement([row({ row_index: 0, date_iso: "2026-05-01", direction: "out", counterparty: "X", balance: 900, description: "orig", amount: 100 })]);
		const current = clone(fresh);
		rowsOf(current)[0].description = "edited";
		rowsOf(current)[0].amount = 555;
		rowsOf(current)[0].skipped = true;

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: absent(), current: present(current) });
		const mergedRow = rowsOf(result.data)[0];
		expect(mergedRow.skipped).toBe(true);
		expect(mergedRow.description).toBe("orig");
		expect(mergedRow.amount).toBe(100);
		expect(result.report.dropped.some((d) => d.field === "description" && d.reason === "no_baseline")).toBe(true);
		expect(result.report.dropped.some((d) => d.field === "amount" && d.reason === "no_baseline")).toBe(true);
	});

	test("human's bank_account_code is kept over a differing fresh proposal, with a note", () => {
		const fresh = statement([row()], { statement: { bank_account_code: "2000", bank_sub_code: "" } });
		const current = clone(fresh);
		statementOf(current).bank_account_code = "1010";
		statementOf(current).bank_sub_code = "01";

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: absent(), current: present(current) });
		expect(statementOf(result.data).bank_account_code).toBe("1010");
		expect(result.report.notes.some((n) => n.includes("bank_account_key"))).toBe(true);
	});

	test("an edited facts value is overwritten by fresh and recorded with reason no_baseline", () => {
		const fresh = doc([page({ facts: { total: 1000 } })]);
		const current = clone(fresh);
		(pagesOf(current)[0].facts as ReviewDataObject).total = 1234;

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: absent(), current: present(current) });
		expect((pagesOf(result.data)[0].facts as ReviewDataObject).total).toBe(1000);
		const drop = result.report.dropped.find((d) => d.field === "facts.total");
		expect(drop).toEqual({ item: expect.any(String), field: "facts.total", human_value: 1234, ai_before: null, ai_after: 1000, reason: "no_baseline" });
	});

	test("FLAG_NO_BASELINE injected and pages forced to needs_attention", () => {
		const fresh = doc([page()]);
		const current = clone(fresh);
		pagesOf(current)[0].skipped = true;

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: absent(), current: present(current) });
		expect(flagsOf(result.data)).toContain(FLAG_NO_BASELINE);
		for (const p of pagesOf(result.data)) expect(p.initial_status).toBe("needs_attention");
	});
});

// --- bail ----------------------------------------------------------------------

describe("mergeReviewData — bail", () => {
	test("current unreadable: outcome bailed, dropped empty, note carries the detail", () => {
		const fresh = doc([page()]);
		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: absent(), current: unreadable("permission denied") });
		expect(result.report.outcome).toBe("bailed");
		expect(result.report.dropped).toEqual([]);
		expect(result.report.notes.some((n) => n.includes("permission denied"))).toBe(true);
		expect(flagsOf(result.data)).toContain(FLAG_BAILED);
		for (const p of pagesOf(result.data)) expect(p.initial_status).toBe("needs_attention");
	});

	test("current is a statement document while fresh is a document group: bail", () => {
		const fresh = doc([page()]);
		const currentData = statement([row()]);
		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: absent(), current: present(currentData) });
		expect(result.report.outcome).toBe("bailed");
	});

	test("current pages missing: bail", () => {
		const fresh = doc([page()]);
		const currentData: ReviewDataObject = { schema: "ksk_review_group_data.v1", group_id: "seg-001-INV-001" };
		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: absent(), current: present(currentData) });
		expect(result.report.outcome).toBe("bailed");
	});

	test("current group_id differs: not a bail, just a note", () => {
		const baseline = doc([page()]);
		const current = clone(baseline);
		current.group_id = "different-id";
		const fresh = clone(baseline);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		expect(result.report.outcome).not.toBe("bailed");
		expect(result.report.notes.some((n) => n.includes("group_id"))).toBe(true);
	});
});

// --- contracts -------------------------------------------------------------

describe("mergeReviewData — contracts", () => {
	test("mutates none of fresh/baseline.data/current.data", () => {
		const baseline = doc([page({ facts: { total: 1000 } })]);
		const current = clone(baseline);
		(pagesOf(current)[0].facts as ReviewDataObject).total = 1234;
		const fresh = clone(baseline);
		(pagesOf(fresh)[0].facts as ReviewDataObject).total = 2000;

		const freshSnapshot = clone(fresh);
		const baselineSnapshot = clone(baseline);
		const currentSnapshot = clone(current);

		mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });

		expect(fresh).toEqual(freshSnapshot);
		expect(baseline).toEqual(baselineSnapshot);
		expect(current).toEqual(currentSnapshot);
	});

	test("baseline: {kind: 'present', data: fresh} (transition case) behaves as exact mode and does not corrupt data", () => {
		const fresh = doc([page({ facts: { total: 1000 } })]);
		const current = clone(fresh);
		(pagesOf(current)[0].facts as ReviewDataObject).total = 1234;

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: { kind: "present", data: fresh }, current: present(current) });
		expect(result.report.outcome).toBe("merged");
		expect((pagesOf(result.data)[0].facts as ReviewDataObject).total).toBe(1234);
		expect(result.report.carried).toBeGreaterThanOrEqual(1);
	});

	test("> DROP_LIMIT drops truncate and set droppedTruncated", () => {
		const n = DROP_LIMIT + 20;
		const baselineLines = Array.from({ length: n }, (_, i) => line({ line_index: i, description: `d${i}`, amount: i }));
		const currentLines = baselineLines.map((l, i) => ({ ...l, description: `human-${i}` }));
		const freshLines = baselineLines.map((l, i) => ({ ...l, description: `ai-${i}` }));
		const baseline = doc([page({ lines: baselineLines })]);
		const current = doc([page({ lines: currentLines })]);
		const fresh = doc([page({ lines: freshLines })]);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		expect(result.report.dropped.length).toBe(DROP_LIMIT);
		expect(result.report.droppedTruncated).toBe(true);
		expect(result.report.notes.some((note) => note.includes("truncated"))).toBe(true);
	});
});

// --- statement-mode lostSkips (untested destructive branches, per review) ---

describe("mergeReviewData — statement lostSkips branches", () => {
	test("exact mode: a skipped row whose source vanished from the fresh build is dropped, lostSkips 1, flagged", () => {
		const baseline = statement([row({ row_index: 0, date_iso: "2026-05-01", description: "r0", amount: 111 }), row({ row_index: 1, date_iso: "2026-05-02", description: "r1", amount: 222 })]);
		const current = clone(baseline);
		rowsOf(current)[1].skipped = true;
		// fresh drops row_index 1 entirely (re-interpretation merged it away)
		const fresh = statement([row({ row_index: 0, date_iso: "2026-05-01", description: "r0", amount: 111 })]);

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: present(baseline), current: present(current) });
		expect(result.report.lostSkips).toBe(1);
		expect(result.report.flags).toContain(flagLostSkips(1));
		const drop = result.report.dropped.find((d) => d.field === "skipped");
		expect(drop?.reason).toBe("item_not_matched");
		expect(drop?.human_value).toBe(true);
	});

	test("degraded mode: a skipped row whose identity fingerprint no longer matches any fresh row is dropped, lostSkips 1", () => {
		const fresh = statement([row({ row_index: 0, date_iso: "2026-05-01", direction: "out", counterparty: "X", balance: 900, description: "r0", amount: 100 })]);
		const current = clone(fresh);
		rowsOf(current)[0].skipped = true;
		// balance drifted on re-read: current's identity fingerprint (balance
		// included) no longer matches any fresh row, so it can't be carried.
		rowsOf(current)[0].balance = 850;

		const result = mergeReviewData({ groupId: "bank-001", fresh, baseline: absent(), current: present(current) });
		expect(result.report.outcome).toBe("degraded");
		expect(result.report.lostSkips).toBe(1);
		expect(result.report.flags).toContain(flagLostSkips(1));
	});
});

// --- baseline unusable -> degraded (untested destructive branches) ---------

describe("mergeReviewData — unusable baseline falls back to degraded", () => {
	test("baseline: {kind: 'unreadable'} runs degraded with a note", () => {
		const fresh = doc([page()]);
		const current = clone(fresh);
		pagesOf(current)[0].skipped = true;

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: unreadable("bad json"), current: present(current) });
		expect(result.report.outcome).toBe("degraded");
		expect(result.report.notes.some((n) => n.includes("bad json"))).toBe(true);
	});

	test("baseline present but wrong shape (missing pages[]) runs degraded with a note, not a bail", () => {
		const fresh = doc([page()]);
		const current = clone(fresh);
		pagesOf(current)[0].skipped = true;
		const badBaseline: ReviewDataObject = { schema: "ksk_review_group_data.v1", group_id: "seg-001-INV-001" };

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(badBaseline), current: present(current) });
		expect(result.report.outcome).toBe("degraded");
		expect(result.report.notes.some((n) => n.includes("baseline unusable"))).toBe(true);
	});
});

// --- fingerprint normalization (published API, table-driven) ---------------

describe("fingerprint helpers — null/undefined/NaN/empty-string normalization", () => {
	test("pageKeyOf: missing fields normalize to empty string, not 'null'/'undefined'", () => {
		expect(pageKeyOf({})).toBe(" ");
		expect(pageKeyOf({ source_src: "a.pdf", source_sheet: null })).toBe("a.pdf ");
		expect(pageKeyOf({ source_src: "a.pdf", source_sheet: undefined })).toBe(pageKeyOf({ source_src: "a.pdf", source_sheet: null }));
	});

	test("lineFingerprintOf: NaN/non-numeric amount collapses to empty string like a missing amount", () => {
		const withNaN = lineFingerprintOf({ description: "x", amount: NaN });
		const withMissing = lineFingerprintOf({ description: "x" });
		expect(withNaN).toBe(withMissing);
		expect(lineFingerprintOf({ description: "x", amount: "1000" })).toBe(withMissing); // string amount is non-numeric per num()
	});

	test("lineFingerprintOf: amount_includes_vat bool() distinguishes true/false/absent", () => {
		const t = lineFingerprintOf({ amount_includes_vat: true });
		const f = lineFingerprintOf({ amount_includes_vat: false });
		const u = lineFingerprintOf({});
		expect(new Set([t, f, u]).size).toBe(3);
	});

	test("rowFingerprintOf and rowIdentityFingerprintOf: null vs undefined collapse identically", () => {
		const a = rowFingerprintOf({ date_iso: null, direction: undefined, amount: 5, description: "d", counterparty: "c" });
		const b = rowFingerprintOf({ direction: null, amount: 5, description: "d", counterparty: "c" });
		expect(a).toBe(b);

		const ia = rowIdentityFingerprintOf({ date_iso: "2026-01-01", direction: "out", counterparty: undefined, balance: NaN });
		const ib = rowIdentityFingerprintOf({ date_iso: "2026-01-01", direction: "out", counterparty: null, balance: "not-a-number" });
		expect(ia).toBe(ib);
	});
});

// --- sticky flags: NOT this module's job (blocker #1) -----------------------
//
// The adversarial review's blocker #1 (merge-injected review_flags erased by
// the very next, automatic build-review-data invocation) is fixed in the
// WIRING lane, not here — see the NOTE above flagLostSkips in
// review-data-merge.ts and stickyFlagsFor/reconstructFlags in
// build-review-data.ts. A core-side "carry forward any flag this module ever
// wrote" was tried and reverted: this module has no source_content_hash to
// key on, so it cannot distinguish "still the same lossy build" from "sources
// genuinely changed and this rebuild is clean" and would keep every warning
// forever. That is exactly what build-review-data.test.ts's "sticky warning"
// test (finding #1) asserts must NOT happen once the hash moves on. Confirming
// mergeReviewData itself stays hash-agnostic and non-sticky, as designed:

describe("mergeReviewData — review_flags come only from fresh + this run's own drops (stickiness lives in the wiring lane)", () => {
	test("a flag string sitting in current.data.review_flags from a prior run is not carried forward by mergeReviewData on its own", () => {
		const fresh = doc([page()]);
		const current = clone(fresh);
		current.review_flags = [flagLostSkips(1)]; // as if a prior run's wiring-level re-injection left this here
		// nothing this run would drop or degrade — mergeReviewData must not
		// echo the stale flag back out on its own; that decision belongs to
		// build-review-data.ts's stickyFlagsFor, keyed on source_content_hash.
		const baseline = clone(fresh);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		expect(result.report.outcome).toBe("clean");
		expect(flagsOf(result.data)).toEqual([]);
	});
});

// --- page-level missing-baseline (major fix) --------------------------------

describe("mergeReviewData — a page missing from the baseline (stale sidecar) does not silently lose its line edits", () => {
	test("exact mode overall, but this page has no baseline counterpart: line edits are recorded as no_baseline, not silently dropped", () => {
		const fresh = doc([page({ source_src: "a.pdf", ref: "g/a.pdf", lines: [line({ description: "A", amount: 1000 })] })]);
		const current = clone(fresh);
		(pagesOf(current)[0].lines as ReviewDataObject[])[0].description = "มนุษย์แก้";
		(pagesOf(current)[0].lines as ReviewDataObject[])[0].amount = 9999;
		// baseline has a DIFFERENT page only — this page's key is absent from it
		// (the sidecar is one build stale relative to review-data.json).
		const baseline = doc([page({ source_src: "other.pdf", ref: "g/other.pdf" })]);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });

		// The human's edit must NOT silently win as if nothing happened, and
		// must NOT be silently discarded either — it must be recorded.
		const mergedLine = (pagesOf(result.data)[0].lines as ReviewDataObject[])[0];
		expect(mergedLine.description).toBe("A"); // fresh AI value wins (no baseline to arbitrate)
		const drop = result.report.dropped.find((d) => d.field === "lines" && d.reason === "no_baseline");
		expect(drop).toBeTruthy();
		expect(result.report.outcome).not.toBe("clean");
		expect(result.report.flags).toContain(FLAG_NO_BASELINE);
	});

	test("unmatched current page with no baseline counterpart either: its facts/lines are recorded no_baseline, not silently skipped", () => {
		const fresh = doc([page({ source_src: "b.pdf", ref: "g/b.pdf" })]); // current page's source doesn't survive into fresh at all
		const current = doc([page({ source_src: "a.pdf", ref: "g/a.pdf", facts: { total: 4242 }, lines: [line({ description: "human line" })] })]);
		const baseline = doc([page({ source_src: "c.pdf", ref: "g/c.pdf" })]); // baseline doesn't have this page either

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		const factDrop = result.report.dropped.find((d) => d.field === "facts.total" && d.reason === "no_baseline");
		const lineDrop = result.report.dropped.find((d) => d.field === "lines" && d.reason === "no_baseline");
		expect(factDrop?.human_value).toBe(4242);
		expect(lineDrop).toBeTruthy();
	});
});

// --- deep clone (minor fix) --------------------------------------------------

describe("mergeReviewData — result.data does not alias fresh's sub-objects", () => {
	test("an unmatched fresh page/statement is still a fresh copy, not the same object as fresh.pages[i]/fresh.statement", () => {
		const freshDoc = doc([page({ source_src: "only-in-fresh.pdf" })]);
		const currentDoc = doc([page({ source_src: "only-in-current.pdf" })]);
		const rDoc = mergeReviewData({ groupId: "seg-001-INV-001", fresh: freshDoc, baseline: absent(), current: present(currentDoc) });
		expect(rDoc.data.pages).not.toBe(freshDoc.pages);
		expect((rDoc.data.pages as ReviewDataObject[])[0]).not.toBe((freshDoc.pages as ReviewDataObject[])[0]);

		const freshStmt = statement([row()]);
		const rStmt = mergeReviewData({ groupId: "bank-001", fresh: freshStmt, baseline: { kind: "present", data: freshStmt }, current: present(clone(freshStmt)) });
		expect(rStmt.data.statement).not.toBe(freshStmt.statement);
	});
});

// --- unrecognized fresh schema with no current file (minor fix) ------------

describe("mergeReviewData — unrecognized fresh schema with no prior file is not a bail", () => {
	test("current absent: outcome fresh, no flags, no FLAG_BAILED", () => {
		const fresh = { schema: "something_else", pages: [] };
		const result = mergeReviewData({ groupId: "g1", fresh, baseline: absent(), current: absent() });
		expect(result.report.outcome).toBe("fresh");
		expect(result.report.flags.length).toBe(0);
		expect(flagsOf(result.data)).not.toContain(FLAG_BAILED);
	});

	test("current present: still bails (there IS human work at risk)", () => {
		const fresh = { schema: "something_else", pages: [] };
		const result = mergeReviewData({ groupId: "g1", fresh, baseline: absent(), current: absent(), });
		// sanity: the above is the no-current case; re-assert the present case bails
		const withCurrent = mergeReviewData({ groupId: "g1", fresh, baseline: absent(), current: present({ schema: "ksk_review_group_data.v1", group_id: "g1", pages: [] }) });
		expect(withCurrent.report.outcome).toBe("bailed");
	});
});

// --- flagLostEdits counts from the untruncated list (minor fix) ------------

describe("flagLostEdits count reflects the untruncated drop total", () => {
	test("with > DROP_LIMIT non-skip drops, the flag's count is not silently capped at DROP_LIMIT", () => {
		const n = DROP_LIMIT + 20;
		const baselineLines = Array.from({ length: n }, (_, i) => line({ line_index: i, description: `d${i}`, amount: i }));
		const currentLines = baselineLines.map((l) => ({ ...l, description: `human-${l.description}` }));
		const freshLines = baselineLines.map((l) => ({ ...l, description: `ai-${l.description}` }));
		const baseline = doc([page({ lines: baselineLines })]);
		const current = doc([page({ lines: currentLines })]);
		const fresh = doc([page({ lines: freshLines })]);

		const result = mergeReviewData({ groupId: "seg-001-INV-001", fresh, baseline: present(baseline), current: present(current) });
		expect(result.report.dropped.length).toBe(DROP_LIMIT); // report payload still capped
		expect(result.report.flags).toContain(flagLostEdits(n)); // but the flag reports the true, untruncated count
	});
});

// --- appendDroppedEdits: non-array rebuilds field ---------------------------

describe("appendDroppedEdits — malformed existing.rebuilds", () => {
	test("existing.rebuilds present but not an array is treated as empty history", () => {
		const existing = { schema: "ksk_review_dropped_edits.v1", group_id: "g1", rebuilds: "not-an-array" };
		const result = appendDroppedEdits(existing, "g1", rebuildEntry());
		expect(result.rebuilds.length).toBe(1);
	});
});

// --- appendDroppedEdits ------------------------------------------------------

function rebuildEntry(overrides: Partial<DroppedEditsRebuild> = {}): DroppedEditsRebuild {
	return { rebuilt_at: "2026-07-25T00:00:00.000Z", outcome: "merged", source_content_hash: "hash", carried: 1, notes: [], dropped: [], ...overrides };
}

describe("appendDroppedEdits", () => {
	test("existing null starts a fresh history", () => {
		const result = appendDroppedEdits(null, "g1", rebuildEntry());
		expect(result.rebuilds.length).toBe(1);
		expect(result.group_id).toBe("g1");
	});

	test("existing garbage is treated as empty history", () => {
		const result = appendDroppedEdits("not an object", "g1", rebuildEntry());
		expect(result.rebuilds.length).toBe(1);
	});

	test("a full 20-entry history evicts the oldest, keeps 20, newest last", () => {
		const existingRebuilds = Array.from({ length: 20 }, (_, i) => rebuildEntry({ source_content_hash: `h${i}` }));
		const existing = { schema: "ksk_review_dropped_edits.v1", group_id: "g1", rebuilds: existingRebuilds };
		const newEntry = rebuildEntry({ source_content_hash: "h20" });

		const result = appendDroppedEdits(existing, "g1", newEntry);
		expect(result.rebuilds.length).toBe(20);
		expect(result.rebuilds[19].source_content_hash).toBe("h20");
		expect(result.rebuilds.find((r) => r.source_content_hash === "h0")).toBeUndefined();
		expect(existing.rebuilds.length).toBe(20); // never mutates existing
	});
});
