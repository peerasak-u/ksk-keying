import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { buildReviewDataStalePath, docGroupsDir, segmentsDir } from "../paths";
import { PreflightFailedError, preflightBuiltGroups, runBuildReviewData } from "../build-review-data";
import type { GroupInterpretation } from "../groups-lib";
import { REVIEW_DATA_AI_FILE, REVIEW_DATA_SUPERSEDED_FILE, DROPPED_EDITS_FILE } from "../review-data-merge";

// --- fixtures ------------------------------------------------------------

const tmps: string[] = [];
function tmpClient(): string {
	const dir = mkdtempSync(join(tmpdir(), "ksk-build-review-data-"));
	tmps.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

type GroupSpec = { id: string; path: string; category?: "expense" | "income" | "bank_statement"; segments?: string[] };

function writeManifest(clientDir: string, specs: GroupSpec[]) {
	const dgDir = docGroupsDir(clientDir);
	mkdirSync(dgDir, { recursive: true });
	const groups = specs.map((s) => ({
		id: s.id,
		path: s.path,
		label: s.id,
		category: s.category ?? "expense",
		vat_treatment: "non_vat",
		segments: s.segments ?? [],
		bookable_doc: null,
		transaction_id: null,
		confidence: "medium",
		populate: "script",
		primary_interpretation: null,
		evidence_interpretations: [],
		source_ref: null,
		warnings: [],
	}));
	writeFileSync(
		join(dgDir, "manifest.yaml"),
		yamlStringify({ schema: "ksk_doc_groups.v1", layout: "category_vat_tree.v1", groups }),
	);
}

// A minimal-but-valid ksk_group_interpretation.v1 body (the shape
// group-populate/ksk-marple write into <group>/interpretation.json) — one
// expense document with one line item, enough for buildDocumentReviewData to
// produce a real review-data.json.
function groupInterpretation(groupId: string, grossTotal = 1000): Record<string, unknown> {
	return {
		schema: "ksk_group_interpretation.v1",
		group_id: groupId,
		category: "expense",
		vat_treatment: "non_vat",
		bookable_doc: "INV-001",
		segments: ["seg-001"],
		transaction: null,
		facts: {
			direction: "expense",
			document_date: "2026-01-01",
			document_no: "INV-001",
			seller_name: "Test Seller",
			seller_tax_id: "1234567890123",
			buyer_name: null,
			buyer_tax_id: null,
			gross_total: grossTotal,
			vat: 0,
			net_paid: grossTotal,
		},
		documents: [
			{
				source_file: "invoice.pdf",
				source_page: 1,
				source_pages: [1],
				doc_kind: "tax_invoice",
				usable_for_booking: true,
				lines_owner: true,
			},
		],
		line_items: [{ description: "Widget", qty: 1, unit_price: grossTotal, amount: grossTotal, vat_rate: 0 }],
		review_flags: [],
		questions_for_user: [],
	};
}

function categorizeFile(groupId: string, accountCode = "510110"): Record<string, unknown> {
	return {
		group_id: groupId,
		lines: [
			{
				line_index: 0,
				account_code: accountCode,
				sub_code: "",
				account_name_th: "ซื้อสินค้า",
				confidence: "high",
				reason: "",
				needs_review: false,
			},
		],
		questions_for_user: [],
	};
}

// A minimal bank_statement interpretation with `count` transactions, each
// with distinct content so fingerprint identity has something to key on.
function statementInterpretation(groupId: string, txns: Array<Record<string, unknown>>): Record<string, unknown> {
	return {
		schema: "ksk_group_interpretation.v1",
		group_id: groupId,
		category: "bank_statement",
		vat_treatment: "non_vat",
		bookable_doc: null,
		segments: ["seg-001"],
		transaction: null,
		statement: {
			bank: "Test Bank",
			account_no: "111-1-11111-1",
			account_holder: "Test Co",
			period: "2026-01",
			opening_balance: 0,
			closing_balance: 0,
		},
		source: { source_src: "statement.pdf", source_page: 1, source_pages: [1], source_sheet: null },
		documents: [
			{
				source_file: "statement.pdf",
				source_page: 1,
				source_pages: [1],
				doc_kind: "bank_statement",
				usable_for_booking: true,
				lines_owner: true,
			},
		],
		transactions: txns,
		facts: {},
		review_flags: [],
		questions_for_user: [],
	};
}

function statementCategorizeFile(
	groupId: string,
	count: number,
	accountCode = "111100",
	bankAccountCode = "111100",
): Record<string, unknown> {
	return {
		group_id: groupId,
		lines: Array.from({ length: count }, (_, i) => ({
			line_index: i,
			account_code: accountCode,
			sub_code: "",
			account_name_th: "เงินฝากธนาคาร",
			confidence: "high",
			reason: "",
			needs_review: false,
		})),
		bank_account_code: bankAccountCode,
		bank_sub_code: "",
		questions_for_user: [],
	};
}

function groupDir(clientDir: string, path: string): string {
	return join(docGroupsDir(clientDir), path);
}

// Writes whichever of interpretation.json/categorize.json are given (pass
// undefined to leave an existing one alone, or to deliberately simulate a
// group missing that input).
function writeGroupFiles(
	clientDir: string,
	path: string,
	interp: Record<string, unknown> | undefined,
	categorize: Record<string, unknown> | undefined,
) {
	const dir = groupDir(clientDir, path);
	mkdirSync(dir, { recursive: true });
	if (interp !== undefined) writeFileSync(join(dir, "interpretation.json"), JSON.stringify(interp, null, 2));
	if (categorize !== undefined)
		writeFileSync(join(dir, "categorize.json"), JSON.stringify(categorize, null, 2));
}

function reviewDataPath(clientDir: string, path: string): string {
	return join(groupDir(clientDir, path), "review-data.json");
}
function aiDataPath(clientDir: string, path: string): string {
	return join(groupDir(clientDir, path), REVIEW_DATA_AI_FILE);
}
function supersededPath(clientDir: string, path: string): string {
	return join(groupDir(clientDir, path), REVIEW_DATA_SUPERSEDED_FILE);
}
function droppedEditsPath(clientDir: string, path: string): string {
	return join(groupDir(clientDir, path), DROPPED_EDITS_FILE);
}

function readJsonFile(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8"));
}

// --- runBuildReviewData (integration over a fixture client dir) ----------

describe("runBuildReviewData", () => {
	test("first-ever build writes review-data.json and review-data.ai.json, both stamped and byte-identical", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g1", path: "expense/non_vat/g1" }]);
		writeGroupFiles(dir, "expense/non_vat/g1", groupInterpretation("g1"), categorizeFile("g1"));

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.skipped).toEqual([]);
		expect(result.lostEdits).toEqual([]);

		const reviewText = readFileSync(reviewDataPath(dir, "expense/non_vat/g1"), "utf8");
		const aiText = readFileSync(aiDataPath(dir, "expense/non_vat/g1"), "utf8");
		expect(reviewText).toBe(aiText);
		const written = JSON.parse(reviewText);
		expect(written.schema).toBe("ksk_review_group_data.v1");
		expect(typeof written.source_content_hash).toBe("string");
		expect(written.source_content_hash.length).toBeGreaterThan(0);
	});

	test("rebuild with unchanged sources and no human edit stays byte-identical", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g2", path: "expense/non_vat/g2" }]);
		writeGroupFiles(dir, "expense/non_vat/g2", groupInterpretation("g2"), categorizeFile("g2"));
		expect(runBuildReviewData(dir).built).toBe(1);
		const before = readFileSync(reviewDataPath(dir, "expense/non_vat/g2"), "utf8");

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.lostEdits).toEqual([]);
		const after = readFileSync(reviewDataPath(dir, "expense/non_vat/g2"), "utf8");
		expect(after).toBe(before);
		const aiAfter = readFileSync(aiDataPath(dir, "expense/non_vat/g2"), "utf8");
		expect(aiAfter).toBe(after);
	});

	test("transition path: no sidecar, matching stamp — a hand-edit to a pre-existing review-data.json survives a rebuild", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g3", path: "expense/non_vat/g3" }]);
		writeGroupFiles(dir, "expense/non_vat/g3", groupInterpretation("g3"), categorizeFile("g3"));
		expect(runBuildReviewData(dir).built).toBe(1);

		// simulate the pre-this-change installed base: no sidecar on disk.
		rmSync(aiDataPath(dir, "expense/non_vat/g3"));

		const path = reviewDataPath(dir, "expense/non_vat/g3");
		const written = readJsonFile(path);
		(written as any).pages[0].facts.total = 9999; // human edit saved by the review console
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		const rebuilt = readJsonFile(path);
		expect((rebuilt as any).pages[0].facts.total).toBe(9999);
		expect(existsSync(aiDataPath(dir, "expense/non_vat/g3"))).toBe(true);
		// The transition path (no sidecar, matching stamp) carries the edit
		// forward silently from the human's point of view, but it is still
		// recorded — a dropped-edits.json entry with zero dropped[] and a note —
		// so a maintainer can audit the one run per group where the baseline was
		// reconstructed rather than read verbatim (finding #5).
		const droppedFile = readJsonFile(droppedEditsPath(dir, "expense/non_vat/g3"));
		const entry = (droppedFile as any).rebuilds.at(-1);
		expect(entry.dropped).toEqual([]);
		expect(entry.carried).toBe(1);
		expect(entry.notes.some((n: string) => n.includes("transition baseline"))).toBe(true);
	});

	test("transition path, degraded: no sidecar + stale stamp — skipped carries, fact takes new AI value, superseded copy + dropped-edits + flag written", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g4", path: "expense/non_vat/g4" }]);
		writeGroupFiles(dir, "expense/non_vat/g4", groupInterpretation("g4", 1000), categorizeFile("g4"));
		expect(runBuildReviewData(dir).built).toBe(1);
		rmSync(aiDataPath(dir, "expense/non_vat/g4"));

		const path = reviewDataPath(dir, "expense/non_vat/g4");
		const written = readJsonFile(path);
		(written as any).pages[0].skipped = true;
		(written as any).pages[0].facts.total = 4242;
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
		const preRebuildBytes = readFileSync(path, "utf8");

		// source genuinely changes, invalidating the stamp
		writeGroupFiles(dir, "expense/non_vat/g4", groupInterpretation("g4", 2000), undefined);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.lostEdits).toHaveLength(1);
		expect(result.lostEdits[0].outcome).toBe("degraded");

		const rebuilt = readJsonFile(path);
		expect((rebuilt as any).pages[0].skipped).toBe(true);
		expect((rebuilt as any).pages[0].facts.total).toBe(2000);
		expect(Array.isArray((rebuilt as any).review_flags)).toBe(true);
		expect((rebuilt as any).review_flags.length).toBeGreaterThan(0);

		const supersededText = readFileSync(supersededPath(dir, "expense/non_vat/g4"), "utf8");
		expect(supersededText).toBe(preRebuildBytes);

		const droppedFile = readJsonFile(droppedEditsPath(dir, "expense/non_vat/g4"));
		expect((droppedFile as any).rebuilds).toHaveLength(1);
		expect((droppedFile as any).rebuilds[0].outcome).toBe("degraded");
	});

	test("human edit + genuinely changed AI source: new AI value wins, dropped-edits records ai_changed, review flagged needs_attention", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g5", path: "expense/non_vat/g5" }]);
		writeGroupFiles(dir, "expense/non_vat/g5", groupInterpretation("g5", 1000), categorizeFile("g5"));
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "expense/non_vat/g5");
		const written = readJsonFile(path);
		(written as any).pages[0].facts.total = 4242; // human edit
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		// source genuinely changes — the AI's new value differs from both
		// baseline and the human's edit
		writeGroupFiles(dir, "expense/non_vat/g5", groupInterpretation("g5", 2000), undefined);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.lostEdits).toHaveLength(1);
		expect(result.lostEdits[0].dropped).toBeGreaterThan(0);

		const rebuilt = readJsonFile(path);
		expect((rebuilt as any).pages[0].facts.total).toBe(2000); // AI wins
		expect((rebuilt as any).pages[0].initial_status).toBe("needs_attention");

		const droppedFile = readJsonFile(droppedEditsPath(dir, "expense/non_vat/g5"));
		const entry = (droppedFile as any).rebuilds.at(-1);
		expect(entry.dropped.some((d: any) => d.reason === "ai_changed")).toBe(true);
		expect((rebuilt as any).review_flags.length).toBeGreaterThan(0);
	});

	test("skipped: true survives a rebuild that also changed the source (matched item)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g6", path: "expense/non_vat/g6" }]);
		writeGroupFiles(dir, "expense/non_vat/g6", groupInterpretation("g6", 1000), categorizeFile("g6"));
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "expense/non_vat/g6");
		const written = readJsonFile(path);
		(written as any).pages[0].skipped = true;
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		writeGroupFiles(dir, "expense/non_vat/g6", groupInterpretation("g6", 2000), undefined);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		const rebuilt = readJsonFile(path);
		expect((rebuilt as any).pages[0].skipped).toBe(true);
	});

	test("corrupt review-data.json bails: rebuild still succeeds, outcome bailed, superseded copy holds the corrupt bytes verbatim", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g7", path: "expense/non_vat/g7" }]);
		writeGroupFiles(dir, "expense/non_vat/g7", groupInterpretation("g7"), categorizeFile("g7"));
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "expense/non_vat/g7");
		const corrupt = "{ not valid json,,,";
		writeFileSync(path, corrupt);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.lostEdits).toHaveLength(1);
		expect(result.lostEdits[0].outcome).toBe("bailed");

		const supersededText = readFileSync(supersededPath(dir, "expense/non_vat/g7"), "utf8");
		expect(supersededText).toBe(corrupt);
		// the freshly built file is valid JSON, unmerged
		expect(() => readJsonFile(path)).not.toThrow();
	});

	test("idempotency: running twice after a human edit (no further source change) produces byte-identical review-data.json and no new dropped-edits entry", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g8", path: "expense/non_vat/g8" }]);
		writeGroupFiles(dir, "expense/non_vat/g8", groupInterpretation("g8", 1000), categorizeFile("g8"));
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "expense/non_vat/g8");
		const written = readJsonFile(path);
		(written as any).pages[0].facts.total = 7777; // human edit; AI value (1000) never changes
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		// first rebuild under test: source unchanged, so this is a clean carry,
		// not a conflict — sets up the steady state we then check is stable.
		const result1 = runBuildReviewData(dir);
		expect(result1.built).toBe(1);
		const firstRun = readFileSync(path, "utf8");
		expect(JSON.parse(firstRun).pages[0].facts.total).toBe(7777);
		const droppedPath = droppedEditsPath(dir, "expense/non_vat/g8");
		const droppedAfterFirst = existsSync(droppedPath) ? readJsonFile(droppedPath) : null;

		// second run: nothing changed since the first rebuild
		const result2 = runBuildReviewData(dir);
		expect(result2.built).toBe(1);
		const secondRun = readFileSync(path, "utf8");
		expect(secondRun).toBe(firstRun);

		const droppedAfterSecond = existsSync(droppedPath) ? readJsonFile(droppedPath) : null;
		expect((droppedAfterSecond as any)?.rebuilds?.length ?? 0).toBe(
			(droppedAfterFirst as any)?.rebuilds?.length ?? 0,
		);
	});

	test("bank_statement group: row skipped + amount edit survive a rebuild that inserts a new transaction before them (index shift)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "gs1", path: "bank_statement/gs1", category: "bank_statement" }]);
		const txnA = { date_iso: "2026-01-05", direction: "out", amount: 500, balance: 1500, description: "A", counterparty: "Vendor A" };
		const txnB = { date_iso: "2026-01-06", direction: "out", amount: 800, balance: 700, description: "B", counterparty: "Vendor B" };
		writeGroupFiles(
			dir,
			"bank_statement/gs1",
			statementInterpretation("gs1", [txnA, txnB]),
			statementCategorizeFile("gs1", 2),
		);
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "bank_statement/gs1");
		const written = readJsonFile(path);
		// txnB is rows[1] before the insert
		(written as any).rows[1].skipped = true;
		(written as any).rows[1].amount = 999;
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		// a new transaction is inserted BEFORE txnA/txnB, shifting every index
		const txnNew = { date_iso: "2026-01-01", direction: "in", amount: 100, balance: 2000, description: "New", counterparty: "New Co" };
		writeGroupFiles(
			dir,
			"bank_statement/gs1",
			statementInterpretation("gs1", [txnNew, txnA, txnB]),
			statementCategorizeFile("gs1", 3),
		);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		const rebuilt = readJsonFile(path);
		const rows = (rebuilt as any).rows as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(3);
		const rowB = rows.find((r) => r.counterparty === "Vendor B");
		expect(rowB).toBeTruthy();
		expect(rowB!.skipped).toBe(true);
		expect(rowB!.amount).toBe(999);
	});

	test("bank_statement: a human-confirmed bank_account_code survives an exact-mode rebuild over a differing new AI proposal (finding #3a)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "gs2", path: "bank_statement/gs2", category: "bank_statement" }]);
		const txn = { date_iso: "2026-01-05", direction: "out", amount: 500, balance: 1500, description: "A", counterparty: "Vendor A" };
		writeGroupFiles(dir, "bank_statement/gs2", statementInterpretation("gs2", [txn]), statementCategorizeFile("gs2", 1, "111100", "111100"));
		expect(runBuildReviewData(dir).built).toBe(1);

		// reviewer confirms a DIFFERENT bank contra account than poirot proposed
		const path = reviewDataPath(dir, "bank_statement/gs2");
		const written = readJsonFile(path);
		(written as any).statement.bank_account_code = "111200";
		(written as any).statement.bank_sub_code = "01";
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		// sources unchanged: a repair re-run over this group re-proposes 111100
		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.carried).toBeGreaterThanOrEqual(1);

		const rebuilt = readJsonFile(path);
		expect((rebuilt as any).statement.bank_account_code).toBe("111200");
		expect((rebuilt as any).statement.bank_sub_code).toBe("01");
	});

	test("bank_statement, degraded mode: a confirmed bank_account_code is still kept (asymmetric rule) (finding #3b)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "gs3", path: "bank_statement/gs3", category: "bank_statement" }]);
		const txn = { date_iso: "2026-01-05", direction: "out", amount: 500, balance: 1500, description: "A", counterparty: "Vendor A" };
		writeGroupFiles(dir, "bank_statement/gs3", statementInterpretation("gs3", [txn]), statementCategorizeFile("gs3", 1, "111100", "111100"));
		expect(runBuildReviewData(dir).built).toBe(1);
		rmSync(aiDataPath(dir, "bank_statement/gs3"));

		const path = reviewDataPath(dir, "bank_statement/gs3");
		const written = readJsonFile(path);
		(written as any).statement.bank_account_code = "111200";
		(written as any).statement.bank_sub_code = "01";
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		// stamp goes stale: source genuinely changes, forcing degraded mode
		writeGroupFiles(
			dir,
			"bank_statement/gs3",
			statementInterpretation("gs3", [{ ...txn, amount: 600 }]),
			statementCategorizeFile("gs3", 1, "111100", "111100"),
		);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.lostEdits[0]?.outcome).toBe("degraded");

		const rebuilt = readJsonFile(path);
		expect((rebuilt as any).statement.bank_account_code).toBe("111200");
		expect((rebuilt as any).statement.bank_sub_code).toBe("01");
	});

	test("skipped: true whose row disappears on re-interpretation is recorded as lostSkips + item_not_matched + a review flag (finding #3c)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "gs4", path: "bank_statement/gs4", category: "bank_statement" }]);
		const txnA = { date_iso: "2026-01-05", direction: "out", amount: 500, balance: 1500, description: "A", counterparty: "Vendor A" };
		const txnB = { date_iso: "2026-01-06", direction: "out", amount: 800, balance: 700, description: "B", counterparty: "Vendor B" };
		writeGroupFiles(dir, "bank_statement/gs4", statementInterpretation("gs4", [txnA, txnB]), statementCategorizeFile("gs4", 2));
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "bank_statement/gs4");
		const written = readJsonFile(path);
		(written as any).rows[1].skipped = true; // txnB
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		// re-interpretation drops txnB entirely — its fingerprint no longer exists
		writeGroupFiles(dir, "bank_statement/gs4", statementInterpretation("gs4", [txnA]), statementCategorizeFile("gs4", 1));

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.lostEdits).toHaveLength(1);
		expect(result.lostEdits[0].lostSkips).toBeGreaterThan(0);

		const droppedFile = readJsonFile(droppedEditsPath(dir, "bank_statement/gs4"));
		const entry = (droppedFile as any).rebuilds.at(-1);
		expect(entry.dropped.some((d: any) => d.field === "skipped" && d.reason === "item_not_matched")).toBe(true);

		const rebuilt = readJsonFile(path);
		expect((rebuilt as any).review_flags.length).toBeGreaterThan(0);
	});

	test("two lossy rebuilds append two dropped-edits.json entries, newest last, first entry's dropped[] intact (finding #4)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g9", path: "expense/non_vat/g9" }]);
		writeGroupFiles(dir, "expense/non_vat/g9", groupInterpretation("g9", 1000), categorizeFile("g9"));
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "expense/non_vat/g9");

		// first lossy rebuild: human edit + genuinely changed AI source
		let written = readJsonFile(path);
		(written as any).pages[0].facts.total = 4242;
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
		writeGroupFiles(dir, "expense/non_vat/g9", groupInterpretation("g9", 2000), undefined);
		expect(runBuildReviewData(dir).built).toBe(1);

		const droppedPathG9 = droppedEditsPath(dir, "expense/non_vat/g9");
		const afterFirst = readJsonFile(droppedPathG9);
		expect((afterFirst as any).rebuilds).toHaveLength(1);
		const firstDropped = (afterFirst as any).rebuilds[0].dropped;

		// second lossy rebuild: another human edit + another genuine AI change
		written = readJsonFile(path);
		(written as any).pages[0].facts.total = 5555;
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
		writeGroupFiles(dir, "expense/non_vat/g9", groupInterpretation("g9", 3000), undefined);
		expect(runBuildReviewData(dir).built).toBe(1);

		const afterSecond = readJsonFile(droppedPathG9);
		const rebuilds = (afterSecond as any).rebuilds;
		expect(rebuilds).toHaveLength(2);
		expect(new Date(rebuilds[0].rebuilt_at).getTime()).toBeLessThanOrEqual(new Date(rebuilds[1].rebuilt_at).getTime());
		expect(rebuilds[0].dropped).toEqual(firstDropped);
	});

	test("sticky warning: a later clean rebuild over unchanged sources keeps the review_flags + needs_attention from an earlier lossy rebuild (finding #1)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g10", path: "expense/non_vat/g10" }]);
		writeGroupFiles(dir, "expense/non_vat/g10", groupInterpretation("g10", 1000), categorizeFile("g10"));
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "expense/non_vat/g10");
		const written = readJsonFile(path);
		(written as any).pages[0].facts.total = 4242; // human edit
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		// genuine AI change: the human's edit is dropped, this run flags it
		writeGroupFiles(dir, "expense/non_vat/g10", groupInterpretation("g10", 2000), undefined);
		const first = runBuildReviewData(dir);
		expect(first.lostEdits).toHaveLength(1);
		const afterFirst = readJsonFile(path);
		expect((afterFirst as any).review_flags.length).toBeGreaterThan(0);
		expect((afterFirst as any).pages[0].initial_status).toBe("needs_attention");

		// second rebuild: sources unchanged (same hash) — nothing new is dropped,
		// but the warning must survive, not vanish.
		const second = runBuildReviewData(dir);
		expect(second.built).toBe(1);
		const afterSecond = readJsonFile(path);
		expect((afterSecond as any).review_flags.length).toBeGreaterThan(0);
		expect((afterSecond as any).pages[0].initial_status).toBe("needs_attention");

		// once sources genuinely change again, the sticky flag is governed by
		// the NEW rebuild's own outcome (this one is clean: fresh AI value
		// matches carried human edit is moot since no human edit remains) —
		// verifying the mechanism keys off source_content_hash, not history length.
		writeGroupFiles(dir, "expense/non_vat/g10", groupInterpretation("g10", 3000), undefined);
		const third = runBuildReviewData(dir);
		expect(third.built).toBe(1);
		const afterThird = readJsonFile(path);
		expect((afterThird as any).review_flags.length).toBe(0);
		expect((afterThird as any).pages[0].initial_status).not.toBe("needs_attention");
	});

	test("a truncated/unreadable review-data.ai.json still uses the exact rule-2 baseline when the stamp matches — no worse than a missing sidecar (finding #2)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g11", path: "expense/non_vat/g11" }]);
		writeGroupFiles(dir, "expense/non_vat/g11", groupInterpretation("g11"), categorizeFile("g11"));
		expect(runBuildReviewData(dir).built).toBe(1);

		// simulate an interrupted/half-written sidecar copy — unreadable JSON,
		// but review-data.json's stamp still matches the current inputs.
		writeFileSync(aiDataPath(dir, "expense/non_vat/g11"), '{"schema": "ksk_review_group');

		const path = reviewDataPath(dir, "expense/non_vat/g11");
		const written = readJsonFile(path);
		(written as any).pages[0].facts.total = 9999; // human edit saved by the review console
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		// rule 2 fires (baseline = fresh) despite the sidecar being unreadable —
		// exact merge, edit survives, no degraded outcome, no flags.
		expect(result.lostEdits).toEqual([]);
		const rebuilt = readJsonFile(path);
		expect((rebuilt as any).pages[0].facts.total).toBe(9999);
		expect(Array.isArray((rebuilt as any).review_flags) ? (rebuilt as any).review_flags.length : 0).toBe(0);
	});

	test("missing-input groups still land in skipped[], and their existing review-data.json is left untouched", () => {
		const dir = tmpClient();
		writeManifest(dir, [
			{ id: "g-built", path: "expense/non_vat/g-built" },
			{ id: "g-missing", path: "expense/non_vat/g-missing" },
		]);
		writeGroupFiles(dir, "expense/non_vat/g-missing", groupInterpretation("g-missing"), undefined);

		const warmup = runBuildReviewData(dir);
		expect(warmup.skipped).toHaveLength(2); // g-built and g-missing both lack inputs so far

		writeGroupFiles(dir, "expense/non_vat/g-built", groupInterpretation("g-built"), categorizeFile("g-built"));
		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toContain("g-missing");
		expect(existsSync(reviewDataPath(dir, "expense/non_vat/g-missing"))).toBe(false);
	});
});

// --- preflightBuiltGroups (client-345 regressions) ------------------------
//
// Both defects are proven on disk in client 345's run: (Bug 2) a
// populate:agent group's documents[].source_file named the interpretation
// ARTIFACT it was copied from instead of the candidate's own source_file
// ("ข้อมูลระบบ/_segments/seg-010/interpretation-u002.json"), producing a claim
// ledger.ts can never match against the Inventory; and (page-77 signature) two
// DIFFERENT groups both populated with source_page: 77 as their OWN primary
// booking document, while the pages that were actually theirs (62, 63) went
// unclaimed by any group. These tests would FAIL (return []) against
// pre-fix build-review-data.ts, which had no cross-group or inventory
// awareness at all.
import { buildDocumentReviewData } from "../groups-lib";

// Convenience for tests: `preflightBuiltGroups`'s third argument is the same
// shape `stage2DocumentCountByPage` produces (key "<file>#p<N>" -> distinct
// approved-bookable Stage-2 document count) — most tests here only care about
// the count for the ONE page under test, so build the map from a plain object.
function pageCounts(counts: Record<string, number>): Map<string, number> {
	return new Map(Object.entries(counts));
}

// Same key format as stage2DocumentCountByPage / preflightBuiltGroups's own
// `owners` map — lets a test that isn't exercising the page-collision rule
// neutralize it by declaring exactly as many Stage-2 documents as owners.
function pageKey(file: string, page: number): string {
	return `${file.normalize("NFC")}#p${page}`;
}

describe("preflightBuiltGroups", () => {
	function interpWithDoc(
		groupId: string,
		overrides: {
			sourceFile: string;
			sourcePage: number;
			linesOwner: boolean;
			documentNo?: string;
		},
	): GroupInterpretation {
		return {
			schema: "ksk_group_interpretation.v1",
			group_id: groupId,
			category: "expense",
			vat_treatment: "non_vat",
			bookable_doc: overrides.documentNo ?? null,
			segments: ["seg-010"],
			transaction: null,
			facts: {
				direction: "expense",
				document_no: overrides.documentNo ?? null,
				gross_total: 100,
				vat: 0,
			},
			documents: [
				{
					source_file: overrides.sourceFile,
					source_page: overrides.sourcePage,
					source_pages: [overrides.sourcePage],
					doc_kind: "handwritten_bill",
					usable_for_booking: true,
					lines_owner: overrides.linesOwner,
				},
			],
			line_items: [],
			review_flags: [],
			questions_for_user: [],
		} as unknown as GroupInterpretation;
	}

	function fresh(interp: GroupInterpretation, groupPath: string): Record<string, unknown> {
		return buildDocumentReviewData(interp, categorizeFile(interp.group_id), null, groupPath);
	}

	test("RED->GREEN Bug 2: a claim naming a pipeline artifact path (under ข้อมูลระบบ/) is rejected regardless of the inventory", () => {
		const interp = interpWithDoc("seg-010-46-txn-113", {
			sourceFile: "ข้อมูลระบบ/_segments/seg-010/interpretation-u002.json",
			sourcePage: 29,
			linesOwner: true,
			documentNo: "46",
		});
		const entry = {
			groupId: "seg-010-46-txn-113",
			groupPath: "expense/non_vat/seg-010-46-txn-113",
			category: "expense",
			interp,
			fresh: fresh(interp, "expense/non_vat/seg-010-46-txn-113"),
		};
		const issues = preflightBuiltGroups(
			[entry],
			new Set(["บิลเงินสด PSL.pdf"]),
			pageCounts({
				[pageKey("ข้อมูลระบบ/_segments/seg-010/interpretation-u002.json", 29)]: 1,
			}),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].groupId).toBe("seg-010-46-txn-113");
		expect(issues[0].message).toMatch(/pipeline artifact path/);
	});

	test("a claim naming a file absent from the Inventory is rejected", () => {
		const interp = interpWithDoc("g1", { sourceFile: "not-in-inventory.pdf", sourcePage: 1, linesOwner: true });
		const entry = { groupId: "g1", groupPath: "expense/non_vat/g1", category: "expense", interp, fresh: fresh(interp, "expense/non_vat/g1") };
		const issues = preflightBuiltGroups(
			[entry],
			new Set(["invoice.pdf"]),
			pageCounts({ [pageKey("not-in-inventory.pdf", 1)]: 1 }),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toMatch(/not in the Inventory/);
	});

	test("a claim naming a real Inventory file is accepted", () => {
		const interp = interpWithDoc("g1", { sourceFile: "invoice.pdf", sourcePage: 1, linesOwner: true });
		const entry = { groupId: "g1", groupPath: "expense/non_vat/g1", category: "expense", interp, fresh: fresh(interp, "expense/non_vat/g1") };
		expect(
			preflightBuiltGroups([entry], new Set(["invoice.pdf"]), pageCounts({ [pageKey("invoice.pdf", 1)]: 1 })),
		).toEqual([]);
	});

	test("no inventory available yet — inventory validation is skipped rather than false-flagging every claim", () => {
		const interp = interpWithDoc("g1", { sourceFile: "whatever.pdf", sourcePage: 1, linesOwner: true });
		const entry = { groupId: "g1", groupPath: "expense/non_vat/g1", category: "expense", interp, fresh: fresh(interp, "expense/non_vat/g1") };
		expect(preflightBuiltGroups([entry], null, pageCounts({ [pageKey("whatever.pdf", 1)]: 1 }))).toEqual([]);
	});

	// Builds N one-document, single-page groups all claiming (lines_owner)
	// the SAME (file, page) as PRIMARY — the shape a real page-77-style run
	// produces once Fix 1 lets the linker give each distinct unnumbered
	// document its own group.
	function ownersOfSamePage(file: string, page: number, n: number) {
		return Array.from({ length: n }, (_, i) => {
			const groupId = `seg-012-p${page}-${i}`;
			const interp = interpWithDoc(groupId, { sourceFile: file, sourcePage: page, linesOwner: true });
			return {
				groupId,
				groupPath: `expense/non_vat/${groupId}`,
				category: "expense",
				interp,
				fresh: fresh(interp, `expense/non_vat/${groupId}`),
			};
		});
	}

	test("RED->GREEN page-77 signature: two groups both claim a page Stage-2 recorded only ONE document on", () => {
		const entries = ownersOfSamePage("ใบสำคัญจ่าย PSL.pdf", 77, 2);
		const issues = preflightBuiltGroups(
			entries,
			new Set(["ใบสำคัญจ่าย PSL.pdf"]),
			pageCounts({ [pageKey("ใบสำคัญจ่าย PSL.pdf", 77)]: 1 }),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toMatch(/claimed as the PRIMARY booking document by 2 different group\(s\)/);
		expect(issues[0].message).toMatch(/Stage-2 recorded only 1 distinct document\(s\)/);
	});

	test("a page genuinely holding 3 distinct Stage-2 documents, owned by 3 groups, is NOT a collision", () => {
		const entries = ownersOfSamePage("ใบสำคัญจ่าย PSL.pdf", 77, 3);
		const issues = preflightBuiltGroups(
			entries,
			new Set(["ใบสำคัญจ่าย PSL.pdf"]),
			pageCounts({ [pageKey("ใบสำคัญจ่าย PSL.pdf", 77)]: 3 }),
		);
		expect(issues).toEqual([]);
	});

	test("the same 3-document page owned by 4 groups IS a genuine collision", () => {
		const entries = ownersOfSamePage("ใบสำคัญจ่าย PSL.pdf", 77, 4);
		const issues = preflightBuiltGroups(
			entries,
			new Set(["ใบสำคัญจ่าย PSL.pdf"]),
			pageCounts({ [pageKey("ใบสำคัญจ่าย PSL.pdf", 77)]: 3 }),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toMatch(/claimed as the PRIMARY booking document by 4 different group\(s\)/);
		expect(issues[0].message).toMatch(/Stage-2 recorded only 3 distinct document\(s\)/);
	});

	test("the same 3-document page owned by only 1 group is the dropped-document case, reported here (not double-reported with Fix 1's segment-level count)", () => {
		const entries = ownersOfSamePage("ใบสำคัญจ่าย PSL.pdf", 77, 1);
		const issues = preflightBuiltGroups(
			entries,
			new Set(["ใบสำคัญจ่าย PSL.pdf"]),
			pageCounts({ [pageKey("ใบสำคัญจ่าย PSL.pdf", 77)]: 3 }),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toMatch(/holds 3 distinct Stage-2 document\(s\) but only 1 group\(s\) claim ownership/);
		expect(issues[0].message).toMatch(/2 document\(s\) actually on this page have no owning group/);
	});

	// BUG-2/BUG-4 FIX (client _345, pages 62/63/80): a page Stage-2 recorded a
	// document on, but that NO group claims at all, never became a key in the
	// `owners` map the old code iterated — so it was structurally invisible to
	// this check, not merely under-reported. This is the "one physical page
	// left with no owner at all" case the block comment above always claimed
	// to catch. This test would FAIL (return []) against the pre-fix code.
	test("RED->GREEN client-345 zero-owner signature: a page Stage-2 recorded a document on, claimed by NO group at all, is reported (not silently skipped)", () => {
		const owned = interpWithDoc("g1", { sourceFile: "invoice.pdf", sourcePage: 1, linesOwner: true });
		const entry = { groupId: "g1", groupPath: "expense/non_vat/g1", category: "expense", interp: owned, fresh: fresh(owned, "expense/non_vat/g1") };
		// invoice.pdf page 2 has a real Stage-2 document, but no group here owns
		// it — the exact seg-012 p62/p63/p80 signature (claimed by no group).
		const issues = preflightBuiltGroups(
			[entry],
			new Set(["invoice.pdf"]),
			pageCounts({ [pageKey("invoice.pdf", 1)]: 1, [pageKey("invoice.pdf", 2)]: 1 }),
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toMatch(/invoice\.pdf#p2/);
		expect(issues[0].message).toMatch(/holds 1 distinct Stage-2 document\(s\) but only 0 group\(s\) claim ownership/);
		expect(issues[0].message).toMatch(/1 document\(s\) actually on this page have no owning group/);
	});

	test("no false positive: a shared supporting document (lines_owner: false) claimed as evidence by two groups is legitimate, not a collision", () => {
		// group A owns page 1 of invoice.pdf, cites the shared receipt (page 9,
		// evidence only) for context; group B owns page 2, cites the SAME
		// shared receipt page 9 as its own evidence too — page 9 is deliberately
		// claimed by both, but neither group claims it as ITS OWN document.
		const interpA: GroupInterpretation = {
			schema: "ksk_group_interpretation.v1",
			group_id: "gA",
			category: "expense",
			vat_treatment: "non_vat",
			bookable_doc: "INV-A",
			segments: ["seg-001"],
			transaction: null,
			facts: { direction: "expense", document_no: "INV-A", gross_total: 100, vat: 0 },
			documents: [
				{ source_file: "invoice.pdf", source_page: 1, source_pages: [1], doc_kind: "tax_invoice", usable_for_booking: true, lines_owner: true },
				{ source_file: "receipt.pdf", source_page: 9, source_pages: [9], doc_kind: "receipt", usable_for_booking: true, lines_owner: false },
			],
			line_items: [],
			review_flags: [],
			questions_for_user: [],
		} as unknown as GroupInterpretation;
		const interpB: GroupInterpretation = {
			...interpA,
			group_id: "gB",
			bookable_doc: "INV-B",
			facts: { direction: "expense", document_no: "INV-B", gross_total: 200, vat: 0 },
			documents: [
				{ source_file: "invoice.pdf", source_page: 2, source_pages: [2], doc_kind: "tax_invoice", usable_for_booking: true, lines_owner: true },
				{ source_file: "receipt.pdf", source_page: 9, source_pages: [9], doc_kind: "receipt", usable_for_booking: true, lines_owner: false },
			],
		} as unknown as GroupInterpretation;
		const entries = [
			{ groupId: "gA", groupPath: "expense/non_vat/gA", category: "expense", interp: interpA, fresh: fresh(interpA, "expense/non_vat/gA") },
			{ groupId: "gB", groupPath: "expense/non_vat/gB", category: "expense", interp: interpB, fresh: fresh(interpB, "expense/non_vat/gB") },
		];
		expect(
			preflightBuiltGroups(
				entries,
				new Set(["invoice.pdf", "receipt.pdf"]),
				pageCounts({ [pageKey("invoice.pdf", 1)]: 1, [pageKey("invoice.pdf", 2)]: 1 }),
			),
		).toEqual([]);
	});

	test("bank_statement groups are never subject to the reciprocal lines_owner check", () => {
		const interp = interpWithDoc("stmt-1", { sourceFile: "statement.pdf", sourcePage: 1, linesOwner: true });
		const entries = [
			{ groupId: "stmt-1", groupPath: "bank_statement/stmt-1", category: "bank_statement", interp, fresh: fresh(interp, "bank_statement/stmt-1") },
			{ groupId: "stmt-2", groupPath: "bank_statement/stmt-2", category: "bank_statement", interp: { ...interp, group_id: "stmt-2" }, fresh: fresh(interp, "bank_statement/stmt-2") },
		];
		expect(preflightBuiltGroups(entries, new Set(["statement.pdf"]), pageCounts({}))).toEqual([]);
	});
});

// --- runBuildReviewData: exit-3 preflight failure & the stale-build sentinel
//
// Fix 3: a preflight failure must (a) throw PreflightFailedError — never
// process.exit inside the core function, so this stays callable from tests —
// and (b) write the stale-build sentinel (paths.ts's buildReviewDataStalePath)
// so a previous successful build's review-data.json is never mistaken for
// current by anything reading it later (ledger.ts's final gate).

describe("runBuildReviewData — preflight failure (exit 3) and stale-build sentinel", () => {
	// Writes one Stage-2 (whole-file, Shape-A) interpretation reporting exactly
	// ONE approved-bookable document on `${file}` page `${page}` — real-shape
	// input for stage2DocumentCountByPage, per groups-lib.ts's documentRecordsOf
	// whole-file fallback (no per-entry document_no/nested facts, so the file's
	// own top-level accounting_facts + single documents[] entry become the one
	// DocRecord).
	function writeStage2OneDocOnPage(clientDir: string, segmentId: string, file: string, page: number) {
		const dir = join(segmentsDir(clientDir), segmentId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "interpretation.json"),
			JSON.stringify({
				segment_id: segmentId,
				documents: [{ source_file: file, source_page: page, doc_kind: "handwritten_bill" }],
				accounting_facts: { direction: "expense", document_no: null, gross_total: 100, vat: 0 },
				line_items: [],
				review_flags: [],
				questions_for_user: [],
			}),
		);
	}

	// Two finished groups both populated with the SAME page as their own
	// PRIMARY (lines_owner: true) booking document — the page-77 shape (Fix 2)
	// — while Stage-2 truth above says only one document actually lives there.
	function writeTwoGroupsClaimingSamePage(clientDir: string, file: string, page: number) {
		writeManifest(clientDir, [
			{ id: "gA", path: "expense/non_vat/gA", segments: ["seg-stale"] },
			{ id: "gB", path: "expense/non_vat/gB", segments: ["seg-stale"] },
		]);
		const claim = (groupId: string) => ({
			schema: "ksk_group_interpretation.v1",
			group_id: groupId,
			category: "expense",
			vat_treatment: "non_vat",
			bookable_doc: null,
			segments: ["seg-stale"],
			transaction: null,
			facts: { direction: "expense", document_no: null, gross_total: 100, vat: 0 },
			documents: [
				{
					source_file: file,
					source_page: page,
					source_pages: [page],
					doc_kind: "handwritten_bill",
					usable_for_booking: true,
					lines_owner: true,
				},
			],
			line_items: [],
			review_flags: [],
			questions_for_user: [],
		});
		writeGroupFiles(clientDir, "expense/non_vat/gA", claim("gA"), categorizeFile("gA"));
		writeGroupFiles(clientDir, "expense/non_vat/gB", claim("gB"), categorizeFile("gB"));
	}

	test("preflight failure throws PreflightFailedError (not process.exit) and writes nothing", () => {
		const dir = tmpClient();
		writeStage2OneDocOnPage(dir, "seg-stale", "receipt.pdf", 5);
		writeTwoGroupsClaimingSamePage(dir, "receipt.pdf", 5);

		expect(() => runBuildReviewData(dir)).toThrow(PreflightFailedError);
		expect(existsSync(reviewDataPath(dir, "expense/non_vat/gA"))).toBe(false);
		expect(existsSync(reviewDataPath(dir, "expense/non_vat/gB"))).toBe(false);
	});

	test("preflight failure writes the stale-build sentinel naming the offending page", () => {
		const dir = tmpClient();
		writeStage2OneDocOnPage(dir, "seg-stale", "receipt.pdf", 5);
		writeTwoGroupsClaimingSamePage(dir, "receipt.pdf", 5);

		expect(() => runBuildReviewData(dir)).toThrow();
		const stalePath = buildReviewDataStalePath(dir);
		expect(existsSync(stalePath)).toBe(true);
		const sentinel = readFileSync(stalePath, "utf8");
		expect(sentinel).toMatch(/preflight-failed/);
		expect(sentinel).toMatch(/receipt\.pdf/);
	});

	test("a successful build clears a stale-build sentinel left by an earlier failed run", () => {
		const dir = tmpClient();
		writeStage2OneDocOnPage(dir, "seg-stale", "receipt.pdf", 5);
		writeTwoGroupsClaimingSamePage(dir, "receipt.pdf", 5);
		expect(() => runBuildReviewData(dir)).toThrow();
		expect(existsSync(buildReviewDataStalePath(dir))).toBe(true);

		// Fix the inconsistency: only gA still claims the page now.
		rmSync(groupDir(dir, "expense/non_vat/gB"), { recursive: true, force: true });
		writeManifest(dir, [{ id: "gA", path: "expense/non_vat/gA", segments: ["seg-stale"] }]);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(existsSync(buildReviewDataStalePath(dir))).toBe(false);
	});

	test("a clean build with no preflight issue never creates a sentinel", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g1", path: "expense/non_vat/g1" }]);
		writeGroupFiles(dir, "expense/non_vat/g1", groupInterpretation("g1"), categorizeFile("g1"));
		expect(runBuildReviewData(dir).built).toBe(1);
		expect(existsSync(buildReviewDataStalePath(dir))).toBe(false);
	});

	// BUG-3 FIX (client _345): a run that SKIPS a group for missing populate/
	// categorize input must not clear a sentinel left by an earlier failed run
	// — that group's own review-data.json (from an even earlier, successful
	// build) is still on disk and still counted by ledger.ts's manifest-
	// independent claim walk, so the sentinel must keep blocking until every
	// manifest group has gone through pass 2 again.
	test("a run that skips a group does NOT clear a stale-build sentinel", () => {
		const dir = tmpClient();
		writeStage2OneDocOnPage(dir, "seg-stale", "receipt.pdf", 5);
		writeTwoGroupsClaimingSamePage(dir, "receipt.pdf", 5);
		expect(() => runBuildReviewData(dir)).toThrow();
		expect(existsSync(buildReviewDataStalePath(dir))).toBe(true);

		// Fix the inconsistency (only gA claims the page now), but also remove
		// gB's categorize.json so gB is `skipped` rather than dropped from the
		// manifest entirely — gB's OLD review-data.json (from before the failed
		// run overwrote nothing) is still on disk.
		writeManifest(dir, [
			{ id: "gA", path: "expense/non_vat/gA", segments: ["seg-stale"] },
			{ id: "gB", path: "expense/non_vat/gB", segments: ["seg-stale"] },
		]);
		rmSync(join(groupDir(dir, "expense/non_vat/gB"), "categorize.json"), { force: true });

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.skipped.length).toBe(1);
		expect(existsSync(buildReviewDataStalePath(dir))).toBe(true);
	});
});
