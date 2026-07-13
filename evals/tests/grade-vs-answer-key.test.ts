import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import XLSX from "xlsx";
import { matchDocs, normalizeDocNo, normText, type Identifiable, type KeyedDoc } from "../lib";
import {
	detectPeakColumns,
	gradeRun,
	keyDocsFromRows,
	loadKeyDocs,
	loadRunDocs,
	normalizeDateCell,
	normalizeDocDate,
	parsePeakRows,
	runDocsFromReviewData,
	type KeyDoc,
	type RunDoc,
} from "../grade-vs-answer-key";

// PEAK's own template column labels (from the shipped PEAK_ImportExpense /
// PEAK_ImportReceipt templates — product schema text, not client data).
const EXPENSE_HEADER = [
	"ลำดับที่* ",
	"วันที่เอกสาร",
	"อ้างอิงถึง",
	"ผู้รับเงิน/คู่ค้า",
	"เลขทะเบียน 13 หลัก",
	"เลขสาขา 5 หลัก",
	"เลขที่ใบกำกับฯ (ถ้ามี)",
	"วันที่ใบกำกับฯ (ถ้ามี)",
	"วันที่บันทึกภาษีซื้อ (ถ้ามี)",
	"ประเภทราคา",
	"บัญชี",
	"คำอธิบาย",
	"จำนวน",
	"ราคาต่อหน่วย",
	"อัตราภาษี",
	"หัก ณ ที่จ่าย (ถ้ามี)",
	"ชำระโดย",
	"จำนวนเงินที่ชำระ",
	"ภ.ง.ด. (ถ้ามี)",
	"หมายเหตุ",
	"กลุ่มจัดประเภท",
];

// Real PEAK_ImportReceipt export template differs materially from the expense
// one (doc_no lives directly in its own column, an extra discount column, no
// separate "amount paid" column) — the detector must not assume fixed indices.
const RECEIPT_HEADER = [
	"ลำดับที่*",
	"วันที่เอกสาร",
	"เลขที่เอกสาร",
	"อ้างอิงถึง",
	"ลูกค้า",
	"เลขทะเบียน 13 หลัก",
	"เลขสาขา 5 หลัก",
	"การออกใบกำกับภาษี",
	"ประเภทราคา",
	"สินค้า/บริการ",
	"บัญชี",
	"คำอธิบาย",
	"จำนวน",
	"ราคาต่อหน่วย",
	"ส่วนลดต่อหน่วย",
	"อัตราภาษี",
	"ถูกหัก ณ ที่จ่าย(ถ้ามี)",
	"รับชำระโดย",
	"หมายเหตุ",
	"กลุ่มจัดประเภท",
];

const JOURNAL_HEADER = [
	"ลำดับที",
	"สมุดบัญชี",
	"วันที่รายการ (YYYYMMDD)",
	"อ้างอิง",
	"ผู้ติดต่อ",
	"คำอธิบายการบันทึกบัญชี",
	"เลขที่บัญชี*",
	"บัญชีย่อย",
	"คำอธิบายรายการ (ว่างเพื่อให้ระบบใส่ให้)",
	"เดบิต",
	"เครดิต",
	"กลุ่มจัดประเภท",
];

// Defect 1 (board T06): tier-1 doc_no matching in matchDocs compared normText
// output exactly, so separator-only and leading-zero variants of the SAME
// document number were falsely treated as different. normalizeDocNo unifies
// separators and strips leading zeros (digits-only) — but must NOT touch
// internal zero-runs, which is a different (unsafe to auto-merge) case left
// for the gross+date fallback tier instead. All values below are invented.
describe("normalizeDocNo", () => {
	test("slash vs dash separator normalize to the same value", () => {
		expect(normalizeDocNo(normText("690407/001"))).toBe(normalizeDocNo(normText("690407-001")));
	});

	test("a leading zero (all-digit doc_no) is stripped", () => {
		expect(normalizeDocNo(normText("055071207398"))).toBe(normalizeDocNo(normText("55071207398")));
	});

	test("genuinely distinct doc_nos stay distinct after normalization", () => {
		expect(normalizeDocNo(normText("690407/001"))).not.toBe(normalizeDocNo(normText("690407/002")));
	});

	test("does NOT collapse an internal zero-run difference (conservative — left for gross+date fallback)", () => {
		expect(normalizeDocNo(normText("BCUNS00066012604000124"))).not.toBe(
			normalizeDocNo(normText("BCUNS000660012604000124")),
		);
	});

	test("pure-separator tokens do NOT all collapse to the empty string and match each other", () => {
		expect(normalizeDocNo(normText("---"))).not.toBe(normalizeDocNo(normText("///")));
		expect(normalizeDocNo(normText("---"))).not.toBe("");
	});
});

describe("matchDocs (doc_no normalization tier)", () => {
	function keyed(overrides: Partial<KeyedDoc>): KeyedDoc {
		return { key: "run:1", docNo: "", docDate: "2026-04-01", gross: 100, ...overrides };
	}
	function ident(overrides: Partial<Identifiable>): Identifiable {
		return { docNo: "", docDate: "2026-04-01", gross: 100, ...overrides };
	}

	test("slash vs dash doc_no variants match via the new normalization tier", () => {
		const actual = [keyed({ key: "run:1", docNo: normText("690407-001"), gross: 24650 })];
		const expected = [ident({ docNo: normText("690407/001"), gross: 24650 })];
		const { matched, missed } = matchDocs(actual, expected);
		expect(matched).toHaveLength(1);
		expect(missed).toEqual([]);
	});

	test("leading-zero doc_no variants match via the new normalization tier", () => {
		const actual = [keyed({ key: "run:1", docNo: normText("55071207398"), gross: 500 })];
		const expected = [ident({ docNo: normText("055071207398"), gross: 500 })];
		const { matched, missed } = matchDocs(actual, expected);
		expect(matched).toHaveLength(1);
		expect(missed).toEqual([]);
	});

	test("the normalization tier requires gross agreement — separator-equal doc_nos with different gross do NOT match", () => {
		// "12/34" and "1234" both normalize to "1234"; without a gross guard the
		// weaker-identity tier would merge two unrelated documents. tier-3 (gross+
		// date) can't rescue it here either (gross and date both differ).
		const actual = [keyed({ key: "run:1", docNo: normText("12/34"), gross: 100, docDate: "2026-04-01" })];
		const expected = [ident({ docNo: normText("1234"), gross: 999, docDate: "2020-01-01" })];
		const { matched, missed } = matchDocs(actual, expected);
		expect(matched).toHaveLength(0);
		expect(missed).toHaveLength(1);
	});
});

describe("detectPeakColumns", () => {
	test("locates every logical column on the expense template by header text, not fixed index", () => {
		const cols = detectPeakColumns(EXPENSE_HEADER);
		expect(cols).not.toBeNull();
		expect(cols!.seq).toBe(0);
		expect(cols!.date).toBe(1);
		expect(cols!.docNo).toBe(6); // "เลขที่ใบกำกับฯ (ถ้ามี)"
		expect(cols!.priceType).toBe(9);
		expect(cols!.account).toBe(10);
		expect(cols!.qty).toBe(12);
		expect(cols!.unitPrice).toBe(13);
		expect(cols!.vatRate).toBe(14);
		expect(cols!.wht).toBe(15);
	});

	test("locates columns on the receipt template even though the layout differs from expense", () => {
		const cols = detectPeakColumns(RECEIPT_HEADER);
		expect(cols).not.toBeNull();
		expect(cols!.docNo).toBe(2); // "เลขที่เอกสาร" — its own column, not "อ้างอิงถึง"
		expect(cols!.account).toBe(10);
		expect(cols!.discount).toBe(14);
	});

	test("a journal/statement-shaped sheet (no exact 'บัญชี' column) is rejected — out of scope for this grader", () => {
		expect(detectPeakColumns(JOURNAL_HEADER)).toBeNull();
	});
});

describe("parsePeakRows", () => {
	const cols = detectPeakColumns(EXPENSE_HEADER)!;

	// Made-up values only (never real 345 figures): one document split across
	// two account codes (seq 1, excl-VAT line + incl-VAT line), one plain
	// no-VAT document (seq 2) whose date cell is an Excel serial number
	// instead of a Date/string, exercising the non-Date date path.
	function row(overrides: Record<number, unknown>): unknown[] {
		const base: unknown[] = new Array(EXPENSE_HEADER.length).fill(null);
		for (const [i, v] of Object.entries(overrides)) base[Number(i)] = v;
		return base;
	}

	const rows = [
		row({
			[cols.seq]: 1,
			[cols.date]: new Date(Date.UTC(2026, 3, 20)),
			[cols.docNo]: "TEST-001",
			[cols.priceType]: 1, // excl-VAT
			[cols.account]: 510110,
			[cols.qty]: 1,
			[cols.unitPrice]: 1000,
			[cols.vatRate]: 0.07,
		}),
		row({
			[cols.seq]: 1,
			[cols.date]: new Date(Date.UTC(2026, 3, 20)),
			[cols.docNo]: "TEST-001",
			[cols.priceType]: 2, // incl-VAT
			[cols.account]: 520211,
			[cols.qty]: 1,
			[cols.unitPrice]: 214,
			[cols.vatRate]: 0.07,
		}),
		row({
			[cols.seq]: 2,
			[cols.date]: 46132, // excel serial for 2026-04-20 — the non-Date path
			[cols.docNo]: "TEST-002",
			[cols.priceType]: 3, // no VAT
			[cols.account]: 530306,
			[cols.qty]: 2,
			[cols.unitPrice]: 500,
			[cols.vatRate]: "NO",
		}),
	];

	test("computes each row's own VAT-inclusive gross from qty/unit-price/price-type/vat-rate", () => {
		const parsed = parsePeakRows(cols, rows, "fake.xlsx");
		expect(parsed).toHaveLength(3);
		expect(parsed[0]).toMatchObject({ seq: 1, docNo: "TEST-001", accountCode: "510110", gross: 1070, vat: 70 });
		expect(parsed[1]).toMatchObject({ seq: 1, docNo: "TEST-001", accountCode: "520211", gross: 214 });
		expect(parsed[1].vat).toBeCloseTo(14, 2);
		expect(parsed[2]).toMatchObject({ seq: 2, docNo: "TEST-002", accountCode: "530306", gross: 1000, vat: 0 });
	});

	test("normalizes both a Date cell and a raw Excel-serial-number cell to the same ISO date", () => {
		const parsed = parsePeakRows(cols, rows, "fake.xlsx");
		expect(parsed[0].docDate).toBe("2026-04-20");
		expect(parsed[2].docDate).toBe("2026-04-20");
	});

	test("blank trailing rows (no seq) are skipped", () => {
		const withBlankTail = [...rows, row({})];
		expect(parsePeakRows(cols, withBlankTail, "fake.xlsx")).toHaveLength(3);
	});
});

describe("keyDocsFromRows", () => {
	const cols = detectPeakColumns(EXPENSE_HEADER)!;
	function row(overrides: Record<number, unknown>): unknown[] {
		const base: unknown[] = new Array(EXPENSE_HEADER.length).fill(null);
		for (const [i, v] of Object.entries(overrides)) base[Number(i)] = v;
		return base;
	}

	test("sums a multi-account document's rows into one key doc, picking the largest-amount line as primary", () => {
		const rows = parsePeakRows(
			cols,
			[
				row({
					[cols.seq]: 5,
					[cols.date]: "2026-04-20",
					[cols.docNo]: "TEST-A",
					[cols.priceType]: 1,
					[cols.account]: 510110,
					[cols.unitPrice]: 1000,
					[cols.vatRate]: 0.07,
				}),
				row({
					[cols.seq]: 5,
					[cols.date]: "2026-04-20",
					[cols.docNo]: "TEST-A",
					[cols.priceType]: 3,
					[cols.account]: 520211,
					[cols.unitPrice]: 100,
					[cols.vatRate]: "NO",
				}),
			],
			"fake.xlsx",
		);
		const docs = keyDocsFromRows(rows);
		expect(docs).toHaveLength(1);
		expect(docs[0].docNoRaw).toBe("TEST-A");
		expect(docs[0].gross).toBeCloseTo(1170, 2); // 1070 + 100
		expect(docs[0].accountCodes).toEqual(["510110", "520211"]);
		expect(docs[0].primaryAccountCode).toBe("510110"); // larger line wins
	});

	test("two different sequence numbers become two separate key docs even if doc_no happens to repeat", () => {
		const rows = parsePeakRows(
			cols,
			[
				row({ [cols.seq]: 1, [cols.date]: "2026-04-01", [cols.docNo]: "DUP", [cols.priceType]: 3, [cols.account]: 1, [cols.unitPrice]: 10 }),
				row({ [cols.seq]: 2, [cols.date]: "2026-04-02", [cols.docNo]: "DUP", [cols.priceType]: 3, [cols.account]: 1, [cols.unitPrice]: 20 }),
			],
			"fake.xlsx",
		);
		expect(keyDocsFromRows(rows)).toHaveLength(2);
	});
});

// Made-up ksk_review_group_data.v1 shape (see
// .claude/skills/ksk-keying/references/review-data-schema.md) — never real
// client fields/values.
describe("runDocsFromReviewData", () => {
	test("one pages[] entry with lines becomes one run doc; account_code taken from the largest line", () => {
		const reviewData = {
			schema: "ksk_review_group_data.v1",
			group_id: "001-FAKE-1",
			pages: [
				{
					ref: "001-FAKE-1/fake.pdf p.1",
					facts: { date: "2026-04-20", document_no: "FAKE-1", total: 1284, vat: 84 },
					lines: [
						{ line_index: 0, amount: 1000, account_code: "510110" },
						{ line_index: 1, amount: 200, account_code: "520211" },
					],
				},
			],
		};
		const docs = runDocsFromReviewData("001-FAKE-1", "expense/vat/001-FAKE-1", reviewData);
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({
			docNoRaw: "FAKE-1",
			docDate: "2026-04-20",
			gross: 1284,
			vat: 84,
			primaryAccountCode: "510110",
			groupId: "001-FAKE-1",
		});
		expect(docs[0].accountCodes).toEqual(["510110", "520211"]);
		expect(docs[0].key).toContain("001-FAKE-1");
	});

	test("an evidence-only page (empty lines[]) is not counted as its own document", () => {
		const reviewData = {
			pages: [
				{ ref: "p1", facts: { document_no: "FAKE-2", date: "2026-04-01", total: 500 }, lines: [{ amount: 500, account_code: "111" }] },
				{ ref: "p2", facts: {}, lines: [] },
			],
		};
		expect(runDocsFromReviewData("g", "expense/vat/g", reviewData)).toHaveLength(1);
	});
});

// Defect 2b (board T06, round 2): the value_match date artifact is actually on
// the KEY-parsing side. loadKeyDocs read XLSX with { cellDates: true }, so
// date-formatted cells arrived as Date objects shifted to local-midnight-minus-
// epsilon (e.g. "2026-04-02T16:59:56Z" for the intended 2026-04-03), and
// getUTC* dropped a day. Reading with { cellDates: false } routes those cells
// through the raw-serial branch instead (correct), and normalizeDateCell is
// hardened for the Date branch (round-to-nearest-day) and the string branch
// (Buddhist-era ISO like "2569-03-18" → Gregorian). YYYYMMDD-number cells (the
// fuel/journal sheets) must stay correct. All values below are synthetic.
describe("normalizeDateCell (key-side date parsing)", () => {
	test("a raw Excel serial number converts to the correct ISO date (no day drop)", () => {
		expect(normalizeDateCell(46115)).toBe("2026-04-03");
	});

	test("a Date shifted to local-midnight-minus-epsilon rounds to the intended day, not one day earlier", () => {
		expect(normalizeDateCell(new Date("2026-04-02T16:59:56.000Z"))).toBe("2026-04-03");
	});

	test("a Buddhist-era ISO string converts to Gregorian", () => {
		expect(normalizeDateCell("2569-03-18")).toBe("2026-03-18");
	});

	test("an 8-digit YYYYMMDD number literal stays correct (fuel/journal sheets)", () => {
		expect(normalizeDateCell(20260408)).toBe("2026-04-08");
	});

	test("a Buddhist-era Excel serial (year in 2400-2600) converts to Gregorian", () => {
		// serial 244427 decodes to 2569-03-19 (Buddhist) — the same value the key
		// shows as a Date '2569-03-18T…' under cellDates:true. Year 2400-2600 is
		// impossible for a real Gregorian accounting date, so BE→Gregorian is safe.
		expect(normalizeDateCell(244427)).toBe("2026-03-19");
	});

	test("a plausible Gregorian year (1969) is NOT auto-shifted — left as a finding", () => {
		// serial 25313 decodes to 1969-04-20 (an Excel 2-digit-year pivot artifact:
		// "69" read as 1969, not Buddhist 2569). 1969 is a legitimate Gregorian
		// year with no safe correction rule, so the grader must NOT mask it — the
		// disagreement stays a FINDING for human review (never override the key).
		expect(normalizeDateCell(25313)).toBe("1969-04-20");
	});
});

// Defect 2 (board T06): the RUN side of gradeRun's value_match compared a
// raw docDate string (often Thai/Buddhist-era, e.g. "01/04/2569") against the
// KEY side's already-ISO docDate, so an otherwise-correct match failed
// value_match on a date-format artifact alone. normalizeDocDate brings the
// run side to the same ISO shape the key side already uses.
describe("normalizeDocDate", () => {
	test("Thai Buddhist-era DD/MM/YYYY converts to ISO Gregorian", () => {
		expect(normalizeDocDate("01/04/2569")).toBe("2026-04-01");
	});

	test("single-digit day/month Buddhist-era date converts to ISO Gregorian", () => {
		expect(normalizeDocDate("1/4/2569")).toBe("2026-04-01");
	});

	test("already-ISO date passes through unchanged", () => {
		expect(normalizeDocDate("2026-04-01")).toBe("2026-04-01");
	});

	test("8-digit YYYYMMDD converts to ISO", () => {
		expect(normalizeDocDate("20260401")).toBe("2026-04-01");
	});

	test("Gregorian-era DD/MM/YYYY (year already < 2400) passes through as ISO", () => {
		expect(normalizeDocDate("01/04/2026")).toBe("2026-04-01");
	});

	test("blank input returns empty string", () => {
		expect(normalizeDocDate("")).toBe("");
	});
});

// This is the ruler itself — every metric the board task asked for, on a
// hand-built (made-up) key/run pair covering the 4 outcomes a real grading
// run can produce: correct match, wrong account_code, wrong value (gross),
// a key doc the run never found (recall miss), and a run doc matching no key
// doc (invented).
describe("gradeRun", () => {
	function key(overrides: Partial<KeyDoc>): KeyDoc {
		return {
			docNo: "",
			docNoRaw: "",
			docDate: "2026-04-01",
			gross: 100,
			vat: 0,
			accountCodes: ["510110"],
			primaryAccountCode: "510110",
			sources: ["fake.xlsx"],
			...overrides,
		};
	}
	function run(overrides: Partial<RunDoc>): RunDoc {
		return {
			key: "expense/vat/x:p1",
			docNo: "",
			docNoRaw: "",
			docDate: "2026-04-01",
			gross: 100,
			vat: 0,
			accountCodes: ["510110"],
			primaryAccountCode: "510110",
			groupId: "x",
			groupPath: "expense/vat/x",
			...overrides,
		};
	}

	test("perfect match: recall, value-match, and account_code all pass", () => {
		const keyDocs = [key({ docNo: "doc-a", docNoRaw: "DOC-A" })];
		const runDocs = [run({ docNo: "doc-a", docNoRaw: "DOC-A" })];
		const grade = gradeRun(runDocs, keyDocs);
		expect(grade.recall).toBe("1/1");
		expect(grade.value_match).toBe("1/1");
		expect(grade.account_match).toBe("1/1");
		expect(grade.invented).toBe(0);
		expect(grade.missed).toEqual([]);
	});

	test("matched but wrong account_code: recall/value pass, account_match fails, reported per-doc", () => {
		const keyDocs = [key({ docNo: "doc-b", docNoRaw: "DOC-B", primaryAccountCode: "510110" })];
		const runDocs = [run({ docNo: "doc-b", docNoRaw: "DOC-B", primaryAccountCode: "999999" })];
		const grade = gradeRun(runDocs, keyDocs);
		expect(grade.recall).toBe("1/1");
		expect(grade.value_match).toBe("1/1");
		expect(grade.account_match).toBe("0/1");
		expect(grade.docs[0]).toMatchObject({
			matched: true,
			account_match: false,
			account_expected: "510110",
			account_actual: "999999",
		});
	});

	test("matched but wrong gross: value_match fails while recall still counts it found", () => {
		const keyDocs = [key({ docNo: "doc-c", docNoRaw: "DOC-C", gross: 100 })];
		const runDocs = [run({ docNo: "doc-c", docNoRaw: "DOC-C", gross: 250 })];
		const grade = gradeRun(runDocs, keyDocs);
		expect(grade.recall).toBe("1/1");
		expect(grade.value_match).toBe("0/1");
	});

	// Exercises the actual fix site (runDocsFromReviewData's raw facts.date ->
	// normalizeDocDate), not a hand-set RunDoc.docDate — gradeRun's own compare
	// (`run.docDate === key.docDate`) is untouched by Defect 2's fix, so the
	// run side must come from real facts.date to prove the artifact is gone.
	test("value_match survives a Thai/Buddhist-era run docDate vs an ISO key docDate (Defect 2)", () => {
		const keyDocs = [key({ docNo: "doc-e", docNoRaw: "DOC-E", gross: 250, docDate: "2026-04-01" })];
		const runDocs = runDocsFromReviewData("g", "expense/vat/g", {
			pages: [
				{
					ref: "p1",
					facts: { document_no: "doc-e", date: "01/04/2569", total: 250 },
					lines: [{ amount: 250, account_code: "510110" }],
				},
			],
		});
		const grade = gradeRun(runDocs, keyDocs);
		expect(grade.recall).toBe("1/1");
		expect(grade.value_match).toBe("1/1");
	});

	test("a key doc with no run match is a recall miss, listed by doc_no", () => {
		const keyDocs = [key({ docNo: "doc-d", docNoRaw: "DOC-D" })];
		const grade = gradeRun([], keyDocs);
		expect(grade.recall).toBe("0/1");
		expect(grade.missed).toEqual(["DOC-D"]);
	});

	test("a run doc matching no key doc is invented, listed by its run key", () => {
		const runDocs = [run({ key: "expense/vat/ghost:p1", docNo: "ghost", docNoRaw: "GHOST", gross: 999 })];
		const grade = gradeRun(runDocs, []);
		expect(grade.key_docs).toBe(0);
		expect(grade.invented).toBe(1);
		expect(grade.invented_keys).toEqual(["expense/vat/ghost:p1"]);
	});
});

// End-to-end (real files, made-up values): a tiny fake PEAK_ImportExpense.xlsx
// answer key + a tiny fake run-output client tree (manifest.yaml +
// review-data.json per group), exactly the shape T04's DoD asks for. Proves
// the whole IO path — xlsx discovery/parsing, manifest walking,
// review-data.json merge — works file-to-file, not just against in-memory
// fixtures. All figures below are invented for this test only.
describe("loadKeyDocs + loadRunDocs + gradeRun (fixture files on disk)", () => {
	const scratch = mkdtempSync(join(tmpdir(), "ksk-grade-vs-answer-key-"));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	const keyDir = join(scratch, "key");
	const runDir = join(scratch, "run");

	function writeKeyXlsx() {
		const dir = join(keyDir, "File PEAK import", "เอกสารค่าใช้จ่าย");
		mkdirSync(dir, { recursive: true });
		const header = [
			"ลำดับที่*",
			"วันที่เอกสาร",
			"อ้างอิงถึง",
			"ผู้รับเงิน/คู่ค้า",
			"เลขทะเบียน 13 หลัก",
			"เลขสาขา 5 หลัก",
			"เลขที่ใบกำกับฯ (ถ้ามี)",
			"วันที่ใบกำกับฯ (ถ้ามี)",
			"วันที่บันทึกภาษีซื้อ (ถ้ามี)",
			"ประเภทราคา",
			"บัญชี",
			"คำอธิบาย",
			"จำนวน",
			"ราคาต่อหน่วย",
			"อัตราภาษี",
			"หัก ณ ที่จ่าย (ถ้ามี)",
			"ชำระโดย",
			"จำนวนเงินที่ชำระ",
			"ภ.ง.ด. (ถ้ามี)",
			"หมายเหตุ",
			"กลุ่มจัดประเภท",
		];
		const rows = [
			// seq, date, ref, payee, taxid, branch, docNo, invDate, taxDate, priceType, account, desc, qty, unitPrice, vatRate, wht, paidBy, paidAmt, pnd, note, group
			[1, "2026-04-05", "", "Fake Supplier A", "", "", "FUEL-001", "2026-04-05", "2026-04-05", 1, 530306, "เชื้อเพลิง", 1, 1000, 0.07, null, "CSH001", 1070, "", "", ""],
			[2, "2026-04-06", "", "Fake Supplier B", "", "", "FUEL-002", "2026-04-06", "2026-04-06", 3, 530306, "เชื้อเพลิง", 1, 500, "NO", null, "CSH001", 500, "", "", ""],
		];
		const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "Import_Expenses");
		XLSX.writeFile(wb, join(dir, "PEAK_ImportExpense เชื้อเพลิง (fake).xlsx"));
	}

	function writeReviewData(groupPath: string, data: unknown) {
		const dir = join(runDir, "ข้อมูลระบบ", "_doc_groups", groupPath);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "review-data.json"), JSON.stringify(data, null, 2));
	}

	function writeRunTree() {
		const groupsDir = join(runDir, "ข้อมูลระบบ", "_doc_groups");
		mkdirSync(groupsDir, { recursive: true });
		writeFileSync(
			join(groupsDir, "manifest.yaml"),
			[
				"schema: ksk_doc_groups.v1",
				"layout: category_vat_tree.v1",
				"groups:",
				"  - id: 001-FUEL-001",
				"    path: expense/vat/001-FUEL-001",
				"    category: expense",
				"  - id: 002-FUEL-002",
				"    path: expense/non_vat/002-FUEL-002",
				"    category: expense",
				"  - id: 003-GHOST",
				"    path: expense/non_vat/003-GHOST",
				"    category: expense",
				"  - id: 004-bank",
				"    path: bank_statement/004-bank",
				"    category: bank_statement",
				"",
			].join("\n"),
		);
		// exact match on doc_no/gross/date/account
		writeReviewData("expense/vat/001-FUEL-001", {
			schema: "ksk_review_group_data.v1",
			group_id: "001-FUEL-001",
			pages: [
				{
					ref: "001-FUEL-001/fake.pdf p.1",
					facts: { document_no: "FUEL-001", date: "2026-04-05", total: 1070, vat: 70 },
					lines: [{ line_index: 0, amount: 1000, account_code: "530306" }],
				},
			],
		});
		// right value, WRONG account_code — the account_match metric this
		// grader adds beyond stage-grade
		writeReviewData("expense/non_vat/002-FUEL-002", {
			schema: "ksk_review_group_data.v1",
			group_id: "002-FUEL-002",
			pages: [
				{
					ref: "002-FUEL-002/fake.pdf p.1",
					facts: { document_no: "FUEL-002", date: "2026-04-06", total: 500, vat: 0 },
					lines: [{ line_index: 0, amount: 500, account_code: "999999" }],
				},
			],
		});
		// matches no key doc at all — invented
		writeReviewData("expense/non_vat/003-GHOST", {
			schema: "ksk_review_group_data.v1",
			group_id: "003-GHOST",
			pages: [
				{
					ref: "003-GHOST/fake.pdf p.1",
					facts: { document_no: "GHOST-999", date: "2026-04-09", total: 42, vat: 0 },
					lines: [{ line_index: 0, amount: 42, account_code: "530306" }],
				},
			],
		});
		// bank_statement group deliberately has NO review-data.json written —
		// must be skipped by category alone, never even attempted
	}

	writeKeyXlsx();
	writeRunTree();

	test("loadKeyDocs parses the real xlsx into 2 key docs", () => {
		const keyDocs = loadKeyDocs(keyDir);
		expect(keyDocs).toHaveLength(2);
		expect(keyDocs.map((d) => d.docNoRaw).sort()).toEqual(["FUEL-001", "FUEL-002"]);
	});

	test("loadRunDocs walks the manifest + review-data.json tree, skipping bank_statement", () => {
		const runDocs = loadRunDocs(runDir);
		expect(runDocs).toHaveLength(3); // FUEL-001, FUEL-002, GHOST — bank group excluded
	});

	test("gradeRun end-to-end: recall 2/2, value-match 2/2, account-match 1/2, one invented", () => {
		const grade = gradeRun(loadRunDocs(runDir), loadKeyDocs(keyDir));
		expect(grade.key_docs).toBe(2);
		expect(grade.recall).toBe("2/2");
		expect(grade.value_match).toBe("2/2");
		expect(grade.account_match).toBe("1/2");
		expect(grade.invented).toBe(1);
		expect(grade.invented_keys[0]).toContain("GHOST");
		const fuel2 = grade.docs.find((d) => d.key_doc_no === "FUEL-002");
		expect(fuel2).toMatchObject({ matched: true, value_match: true, account_match: false });
	});
});
