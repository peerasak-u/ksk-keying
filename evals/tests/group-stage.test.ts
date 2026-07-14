// group-stage grader — unit tests on FABRICATED data only.
//
// Pure-function coverage: manifest validation (schema/shape + the "one group
// per bookable_doc, never per transaction" invariant) and the per-bookable
// cross-session agreement comparator. Also covers the fs-touching helpers
// (populate coverage, bookable collection) against a hand-built temp client
// tree, and one full grade() smoke test with a STUBBED ctx.script (no real
// bun script invocation — the group-skeleton gate call itself is
// integration-tested later, per the task contract).
//
// No live stage run, no samples/evals/fixtures/ or samples/answer-keys/ data.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bookableAgreement,
	checkPopulateCoverage,
	collectBookables,
	groupStageGrader,
	validateManifest,
	type BookableKey,
	type ManifestGroup,
} from "../specs/group-stage";
import type { ScriptResult, StageRun, StageRunContext } from "../specs/stage-grader";

// ---------------------------------------------------------------------------
// fixtures (in-memory, fabricated — mirrors the shape group-skeleton writes)
// ---------------------------------------------------------------------------

function makeGroup(overrides: Partial<ManifestGroup> = {}): ManifestGroup {
	return {
		id: "004-TI2604-00191",
		path: "expense/vat/004-TI2604-00191",
		category: "expense",
		vat_treatment: "vat",
		bookable_doc: "TI2604-00191",
		transaction_id: "txn-004",
		populate: "script",
		...overrides,
	};
}

function validManifest(groups: ManifestGroup[] = [makeGroup()]) {
	return { schema: "ksk_doc_groups.v1", layout: "category_vat_tree.v1", groups };
}

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

describe("validateManifest", () => {
	test("accepts a well-formed manifest", () => {
		const v = validateManifest(validManifest());
		expect(v.ok).toBe(true);
		expect(v.detail).toBe("ok");
		expect(v.groups).toHaveLength(1);
	});

	test("rejects missing/non-object input", () => {
		expect(validateManifest(null).ok).toBe(false);
		expect(validateManifest(undefined).ok).toBe(false);
		expect(validateManifest("nope").ok).toBe(false);
	});

	test("rejects wrong schema", () => {
		const v = validateManifest({ ...validManifest(), schema: "something_else.v1" });
		expect(v.ok).toBe(false);
		expect(v.detail).toContain("schema");
	});

	test("rejects wrong layout", () => {
		const v = validateManifest({ ...validManifest(), layout: "flat.v1" });
		expect(v.ok).toBe(false);
		expect(v.detail).toContain("layout");
	});

	test("rejects empty groups[]", () => {
		expect(validateManifest(validManifest([])).ok).toBe(false);
		const v2 = validateManifest({ schema: "ksk_doc_groups.v1", layout: "category_vat_tree.v1" });
		expect(v2.ok).toBe(false);
	});

	test("rejects a group missing a required field", () => {
		const v = validateManifest(validManifest([makeGroup({ category: undefined as any })]));
		expect(v.ok).toBe(false);
		expect(v.detail).toContain('missing "category"');
	});

	test("rejects unknown category / vat_treatment / populate", () => {
		expect(validateManifest(validManifest([makeGroup({ category: "misc" })])).ok).toBe(false);
		expect(validateManifest(validManifest([makeGroup({ vat_treatment: "half" })])).ok).toBe(false);
		expect(validateManifest(validManifest([makeGroup({ populate: "auto" as any })])).ok).toBe(false);
	});

	test("allows bookable_doc: null (bank_statement groups)", () => {
		const v = validateManifest(
			validManifest([
				makeGroup({
					id: "001-seg-001",
					path: "bank_statement/001-seg-001",
					category: "bank_statement",
					vat_treatment: null,
					bookable_doc: null,
				}),
			]),
		);
		expect(v.ok).toBe(true);
	});

	test("allows several groups sharing one transaction_id (distinct bookable_docs)", () => {
		// e.g. a shared-cluster invoice + its credit note — both bookable, both
		// legitimately tagged with the same transaction_id.
		const v = validateManifest(
			validManifest([
				makeGroup({ id: "030-CN1", path: "expense/vat/030-CN1", bookable_doc: "CN1", transaction_id: "txn-030" }),
				makeGroup({ id: "031-TF1", path: "expense/vat/031-TF1", bookable_doc: "TF1", transaction_id: "txn-030" }),
			]),
		);
		expect(v.ok).toBe(true);
	});

	test("rejects a duplicate bookable_doc across groups (never per transaction)", () => {
		const v = validateManifest(
			validManifest([
				makeGroup({ id: "004-A", path: "expense/vat/004-A", bookable_doc: "SAME-DOC" }),
				makeGroup({ id: "005-B", path: "expense/vat/005-B", bookable_doc: "SAME-DOC" }),
			]),
		);
		expect(v.ok).toBe(false);
		expect(v.detail).toContain('bookable_doc "SAME-DOC" appears in 2 groups');
	});
});

// ---------------------------------------------------------------------------
// checkPopulateCoverage / collectBookables — fs-touching helpers, exercised
// against a hand-built temp client tree (fabricated data, no live run).
// ---------------------------------------------------------------------------

describe("checkPopulateCoverage + collectBookables", () => {
	let client: string;

	beforeAll(() => {
		client = mkdtempSync(join(tmpdir(), "group-stage-test-"));
		const groupsRoot = join(client, "ข้อมูลระบบ", "_doc_groups");

		// populated group, script-copied
		mkdirSync(join(groupsRoot, "expense/vat/004-TI2604-00191"), { recursive: true });
		writeFileSync(
			join(groupsRoot, "expense/vat/004-TI2604-00191/interpretation.json"),
			JSON.stringify({
				schema: "ksk_group_interpretation.v1",
				category: "expense",
				vat_treatment: "vat",
				line_items: [
					{ description: "a", amount: 100 },
					{ description: "b", amount: 50 },
				],
			}),
		);

		// group folder exists but interpretation.json was never written (agent
		// populate step dropped it)
		mkdirSync(join(groupsRoot, "expense/vat/005-TI2604-00259"), { recursive: true });

		// interpretation.json present but malformed (no line_items array)
		mkdirSync(join(groupsRoot, "expense/non_vat/006-42"), { recursive: true });
		writeFileSync(
			join(groupsRoot, "expense/non_vat/006-42/interpretation.json"),
			JSON.stringify({ schema: "ksk_group_interpretation.v1", category: "expense", vat_treatment: "non_vat" }),
		);

		// interpretation.json present but invalid JSON
		mkdirSync(join(groupsRoot, "expense/vat/007-BAD"), { recursive: true });
		writeFileSync(join(groupsRoot, "expense/vat/007-BAD/interpretation.json"), "{ not json");

		// bank_statement group — bookable_doc: null, still populated
		mkdirSync(join(groupsRoot, "bank_statement/001-seg-001"), { recursive: true });
		writeFileSync(
			join(groupsRoot, "bank_statement/001-seg-001/interpretation.json"),
			JSON.stringify({ schema: "ksk_group_interpretation.v1", category: "bank_statement", line_items: [] }),
		);
	});

	afterAll(() => rmSync(client, { recursive: true, force: true }));

	const groups: ManifestGroup[] = [
		makeGroup({ id: "004-TI2604-00191", path: "expense/vat/004-TI2604-00191", bookable_doc: "TI2604-00191" }),
		makeGroup({ id: "005-TI2604-00259", path: "expense/vat/005-TI2604-00259", bookable_doc: "TI2604-00259" }),
		makeGroup({
			id: "006-42",
			path: "expense/non_vat/006-42",
			category: "expense",
			vat_treatment: "non_vat",
			bookable_doc: "42",
		}),
		makeGroup({ id: "007-BAD", path: "expense/vat/007-BAD", bookable_doc: "BAD" }),
		makeGroup({
			id: "001-seg-001",
			path: "bank_statement/001-seg-001",
			category: "bank_statement",
			vat_treatment: null,
			bookable_doc: null,
		}),
	];

	test("populate coverage flags missing / malformed / invalid-JSON groups", () => {
		const cov = checkPopulateCoverage(client, groups);
		expect(cov.total).toBe(5);
		expect(cov.covered).toBe(2); // 004 and the bank_statement group
		expect(cov.missing.sort()).toEqual(["005-TI2604-00259", "006-42", "007-BAD"]);
	});

	test("collectBookables reads category/vat_treatment/line stats from interpretation.json", () => {
		const bookables = collectBookables(client, groups);
		// bank_statement group (bookable_doc null) never enters the map — only
		// the 4 bookable-doc-bearing groups do.
		expect(bookables.size).toBe(4);
		expect([...bookables.keys()].sort()).toEqual(["42", "BAD", "TI2604-00191", "TI2604-00259"]);

		const populated = bookables.get("TI2604-00191")!;
		expect(populated.category).toBe("expense");
		expect(populated.vatTreatment).toBe("vat");
		expect(populated.liCount).toBe(2);
		expect(populated.liSum).toBe(150);

		// missing interpretation.json — falls back to manifest category/vat, 0 lines
		const missing = bookables.get("TI2604-00259")!;
		expect(missing.category).toBe("expense");
		expect(missing.liCount).toBe(0);
		expect(missing.liSum).toBeNull();

		// malformed JSON — same fallback behavior, doesn't throw
		const bad = bookables.get("BAD")!;
		expect(bad.liCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// bookableAgreement — pure, in-memory Maps only
// ---------------------------------------------------------------------------

function bk(overrides: Partial<BookableKey> = {}): BookableKey {
	return { key: "DOC-1", category: "expense", vatTreatment: "vat", liCount: 1, liSum: 100, ...overrides };
}

describe("bookableAgreement", () => {
	test("full agreement across all sessions", () => {
		const s1 = new Map([["DOC-1", bk()], ["DOC-2", bk({ key: "DOC-2", liSum: 200 })]]);
		const s2 = new Map([["DOC-1", bk()], ["DOC-2", bk({ key: "DOC-2", liSum: 200 })]]);
		const s3 = new Map([["DOC-1", bk()], ["DOC-2", bk({ key: "DOC-2", liSum: 200 })]]);
		const r = bookableAgreement([s1, s2, s3]);
		expect(r.keysInAll.sort()).toEqual(["DOC-1", "DOC-2"]);
		expect(r.droppedKeys).toEqual([]);
		expect(r.agreeing.sort()).toEqual(["DOC-1", "DOC-2"]);
	});

	test("category disagreement excludes a bookable_doc from agreeing", () => {
		const s1 = new Map([["DOC-1", bk({ category: "expense" })]]);
		const s2 = new Map([["DOC-1", bk({ category: "income" })]]);
		const r = bookableAgreement([s1, s2]);
		expect(r.keysInAll).toEqual(["DOC-1"]);
		expect(r.agreeing).toEqual([]);
	});

	test("vat_treatment / line-count disagreement excludes from agreeing", () => {
		const base = bk();
		expect(bookableAgreement([new Map([["D", base]]), new Map([["D", { ...base, vatTreatment: "non_vat" }]])]).agreeing).toEqual(
			[],
		);
		expect(bookableAgreement([new Map([["D", base]]), new Map([["D", { ...base, liCount: 2 }]])]).agreeing).toEqual([]);
	});

	test("line-sum agreement uses amountEq tolerance", () => {
		const s1 = new Map([["D", bk({ liSum: 100.0 })]]);
		const s2 = new Map([["D", bk({ liSum: 100.005 })]]); // within tolerance
		const s3 = new Map([["D", bk({ liSum: 101.5 })]]); // outside tolerance
		expect(bookableAgreement([s1, s2]).agreeing).toEqual(["D"]);
		expect(bookableAgreement([s1, s3]).agreeing).toEqual([]);
	});

	test("a bookable_doc missing from one session is dropped, not disagreeing", () => {
		const s1 = new Map([["DOC-1", bk()], ["DOC-2", bk({ key: "DOC-2" })]]);
		const s2 = new Map([["DOC-1", bk()]]); // DOC-2 never landed in a group this session
		const r = bookableAgreement([s1, s2]);
		expect(r.keysInAll).toEqual(["DOC-1"]);
		expect(r.droppedKeys).toEqual(["DOC-2"]);
		expect(r.agreeing).toEqual(["DOC-1"]);
	});

	test("empty sessions yield no comparable keys", () => {
		const r = bookableAgreement([new Map(), new Map()]);
		expect(r.keysInAll).toEqual([]);
		expect(r.agreeing).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// groupStageGrader.grade() — full-shape smoke test over a fabricated 2-session
// run dir, with a STUBBED ctx.script (no real group-skeleton invocation; that
// gate call is integration-tested later per the task contract).
// ---------------------------------------------------------------------------

describe("groupStageGrader.grade()", () => {
	let runDir: string;

	function writeSession(session: number) {
		const client = join(runDir, `s${session}`, "client");
		const groupsRoot = join(client, "ข้อมูลระบบ", "_doc_groups");
		mkdirSync(join(groupsRoot, "expense/vat/004-TI2604-00191"), { recursive: true });
		mkdirSync(join(groupsRoot, "bank_statement/001-seg-001"), { recursive: true });

		writeFileSync(
			join(groupsRoot, "manifest.yaml"),
			[
				"schema: ksk_doc_groups.v1",
				"layout: category_vat_tree.v1",
				"groups:",
				"  - id: 001-seg-001",
				"    path: bank_statement/001-seg-001",
				"    category: bank_statement",
				"    vat_treatment: null",
				"    bookable_doc: null",
				"    transaction_id: txn-001",
				"    populate: script",
				"  - id: 004-TI2604-00191",
				"    path: expense/vat/004-TI2604-00191",
				"    category: expense",
				"    vat_treatment: vat",
				"    bookable_doc: TI2604-00191",
				"    transaction_id: txn-004",
				"    populate: script",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(groupsRoot, "bank_statement/001-seg-001/interpretation.json"),
			JSON.stringify({ schema: "ksk_group_interpretation.v1", category: "bank_statement", line_items: [] }),
		);
		writeFileSync(
			join(groupsRoot, "expense/vat/004-TI2604-00191/interpretation.json"),
			JSON.stringify({
				schema: "ksk_group_interpretation.v1",
				category: "expense",
				vat_treatment: "vat",
				line_items: [{ description: "x", amount: 500 }],
			}),
		);
	}

	beforeAll(() => {
		runDir = mkdtempSync(join(tmpdir(), "group-stage-run-"));
		writeSession(1);
		writeSession(2);
	});

	afterAll(() => rmSync(runDir, { recursive: true, force: true }));

	test("session 1 passes, session 2 fails the completeness gate — shape + headline numbers", () => {
		const run: StageRun = { sessions: 2, fixture: "fab-fixture" };
		const script = (cmd: string, clientAbs: string): ScriptResult => {
			expect(cmd).toBe("group-skeleton");
			if (clientAbs.includes(`${join("s2", "client")}`))
				return {
					code: 2,
					out: "bookable documents dropped between Stage-2 and grouping (segment_id / document_no): seg-005 / TI2604-00259 — links.yaml/clustering lost these. Re-run Stage 3 linking or inspect links.yaml; not auto-recovered.",
				};
			return { code: 0, out: "wrote manifest.yaml: 2 group(s) — 2 populate: script, 0 populate: agent" };
		};
		const ctx: StageRunContext = {
			stage: "group",
			runId: "20260714-fab",
			runDir,
			run,
			clientDir: (s) => join(runDir, `s${s}`, "client"),
			script,
		};

		const result = groupStageGrader.grade(ctx);

		expect(result.sessionGrades).toHaveLength(2);
		expect(result.sessionGrades.map((g) => g.session)).toEqual([1, 2]);
		expect(result.sessionGrades[0].pass).toBe(true);
		expect(result.sessionGrades[1].pass).toBe(false);
		expect((result.sessionGrades[1] as any).dropped).toEqual(["seg-005 / TI2604-00259"]);

		expect(result.summary.reliability).toBe("1/2");
		expect(result.summary.ground_truth).toBeNull();
		// both sessions agree on TI2604-00191 (identical category/vat/line-sum);
		// bookables_compared counts only bookable_doc-bearing groups (bank_statement excluded).
		expect((result.summary as any).bookables_compared).toBe(1);
		expect((result.summary as any).tree_agreement).toBe("1/1 (100.0%)");

		expect(result.scoreboard.length).toBeGreaterThan(0);
		expect(result.scoreboard[0]).toContain("stage-group");
		expect(result.scoreboard[0]).toContain("fab-fixture");
	});

	test("grader.stage matches its registry key", () => {
		expect(groupStageGrader.stage).toBe("group");
	});
});
