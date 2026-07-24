import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { docGroupsDir } from "../paths";
import { needsRebuild, runBuildReviewData } from "../build-review-data";

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

// --- needsRebuild (pure) ---------------------------------------------------

describe("needsRebuild", () => {
	test("no existing stamp at all needs a rebuild", () => {
		expect(needsRebuild("abc", undefined)).toBe(true);
	});

	test("existing file parsed but carries no source_content_hash (null) needs a rebuild", () => {
		expect(needsRebuild("abc", null)).toBe(true);
	});

	test("matching stamp does not need a rebuild", () => {
		expect(needsRebuild("abc", "abc")).toBe(false);
	});

	test("differing stamp needs a rebuild", () => {
		expect(needsRebuild("abc", "xyz")).toBe(true);
	});
});

// --- runBuildReviewData (integration over a fixture client dir) ----------

describe("runBuildReviewData", () => {
	test("a group with no existing review-data.json gets built and stamped with a hash", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g1", path: "expense/non_vat/g1" }]);
		writeGroupFiles(dir, "expense/non_vat/g1", groupInterpretation("g1"), categorizeFile("g1"));

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.unchanged).toBe(0);
		expect(result.skipped).toEqual([]);

		const written = JSON.parse(readFileSync(reviewDataPath(dir, "expense/non_vat/g1"), "utf8"));
		expect(written.schema).toBe("ksk_review_group_data.v1");
		expect(typeof written.source_content_hash).toBe("string");
		expect(written.source_content_hash.length).toBeGreaterThan(0);
	});

	test("a second run with unchanged interpretation/categorize leaves review-data.json byte-for-byte identical (human edit survives)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g2", path: "expense/non_vat/g2" }]);
		writeGroupFiles(dir, "expense/non_vat/g2", groupInterpretation("g2"), categorizeFile("g2"));
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "expense/non_vat/g2");
		const written = JSON.parse(readFileSync(path, "utf8"));
		written.pages[0].facts.total = 9999; // simulated human edit saved by the review console
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
		const edited = readFileSync(path, "utf8");

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(0);
		expect(result.unchanged).toBe(1);
		expect(result.skipped).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(edited); // untouched, byte-for-byte
		expect(JSON.parse(readFileSync(path, "utf8")).pages[0].facts.total).toBe(9999);
	});

	test("changing interpretation.json content causes the group to be rebuilt (human edit legitimately lost)", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g3", path: "expense/non_vat/g3" }]);
		writeGroupFiles(dir, "expense/non_vat/g3", groupInterpretation("g3", 1000), categorizeFile("g3"));
		expect(runBuildReviewData(dir).built).toBe(1);

		const path = reviewDataPath(dir, "expense/non_vat/g3");
		const written = JSON.parse(readFileSync(path, "utf8"));
		written.pages[0].facts.total = 4242; // human edit
		writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);

		// the underlying source genuinely changes
		writeGroupFiles(dir, "expense/non_vat/g3", groupInterpretation("g3", 2000), undefined);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.unchanged).toBe(0);
		const rebuilt = JSON.parse(readFileSync(path, "utf8"));
		// correct, expected: the human edit is gone because the source content
		// genuinely changed, not a bug
		expect(rebuilt.pages[0].facts.total).toBe(2000);
	});

	test("changing categorize.json content also causes the group to be rebuilt", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g3b", path: "expense/non_vat/g3b" }]);
		writeGroupFiles(dir, "expense/non_vat/g3b", groupInterpretation("g3b"), categorizeFile("g3b", "510110"));
		expect(runBuildReviewData(dir).built).toBe(1);

		writeGroupFiles(dir, "expense/non_vat/g3b", undefined, categorizeFile("g3b", "520199"));

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.unchanged).toBe(0);
		const rebuilt = JSON.parse(readFileSync(reviewDataPath(dir, "expense/non_vat/g3b"), "utf8"));
		expect(rebuilt.pages[0].lines[0].account_code).toBe("520199");
	});

	test("a review-data.json with no source_content_hash field (pre-fix file) is rebuilt once, not trusted as unchanged", () => {
		const dir = tmpClient();
		writeManifest(dir, [{ id: "g4", path: "expense/non_vat/g4" }]);
		writeGroupFiles(dir, "expense/non_vat/g4", groupInterpretation("g4"), categorizeFile("g4"));
		writeFileSync(
			reviewDataPath(dir, "expense/non_vat/g4"),
			JSON.stringify({
				schema: "ksk_review_group_data.v1",
				group_id: "g4",
				label: "pre-fix file, no hash stamp",
				review_flags: [],
				pages: [],
			}),
		);

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.unchanged).toBe(0);
		const rebuilt = JSON.parse(readFileSync(reviewDataPath(dir, "expense/non_vat/g4"), "utf8"));
		expect(typeof rebuilt.source_content_hash).toBe("string");
	});

	test("a mix of built + unchanged + missing-input groups in one run is reported correctly", () => {
		const dir = tmpClient();
		writeManifest(dir, [
			{ id: "g-built", path: "expense/non_vat/g-built" },
			{ id: "g-unchanged", path: "expense/non_vat/g-unchanged" },
			{ id: "g-missing", path: "expense/non_vat/g-missing" },
		]);
		// g-unchanged: give it real inputs and build it now, so the run under
		// test below sees it as already-built-and-unchanged.
		writeGroupFiles(
			dir,
			"expense/non_vat/g-unchanged",
			groupInterpretation("g-unchanged"),
			categorizeFile("g-unchanged"),
		);
		// g-missing: interpretation.json only — categorize.json never arrives.
		writeGroupFiles(dir, "expense/non_vat/g-missing", groupInterpretation("g-missing"), undefined);

		const warmup = runBuildReviewData(dir);
		expect(warmup.built).toBe(1); // only g-unchanged
		expect(warmup.skipped).toHaveLength(2); // g-built and g-missing both lack inputs so far

		// g-built: bring its inputs in now, fresh (no review-data.json yet).
		writeGroupFiles(dir, "expense/non_vat/g-built", groupInterpretation("g-built"), categorizeFile("g-built"));

		const result = runBuildReviewData(dir);
		expect(result.built).toBe(1);
		expect(result.unchanged).toBe(1);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toContain("g-missing");
	});
});
