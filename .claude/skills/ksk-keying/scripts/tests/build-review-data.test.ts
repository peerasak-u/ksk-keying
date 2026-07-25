import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { docGroupsDir } from "../paths";
import { runBuildReviewData } from "../build-review-data";
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

type GroupSpec = { id: string; path: string; category?: "expense" | "income" | "bank_statement" };

function writeManifest(clientDir: string, specs: GroupSpec[]) {
	const dgDir = docGroupsDir(clientDir);
	mkdirSync(dgDir, { recursive: true });
	const groups = specs.map((s) => ({
		id: s.id,
		path: s.path,
		label: s.id,
		category: s.category ?? "expense",
		vat_treatment: "non_vat",
		segments: [],
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
