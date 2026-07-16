import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { assessLine, runCategoryAccountCheck } from "../category-account-check";

// --- fixtures ----------------------------------------------------------

const tmps: string[] = [];
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

type GroupFixture = {
	id: string;
	path: string; // e.g. "expense/non_vat/001-INV1"
	category: "expense" | "income" | "bank_statement";
	lines: { account_code: string; account_name_th?: string; line_index?: number }[] | null; // null => no categorize.json at all
	// Escape hatch: write an arbitrary categorize.json body verbatim instead of
	// the well-formed one built from `lines`. Used to exercise malformed /
	// non-array-lines / empty-group_id shapes. When set, `lines` is ignored.
	categorizeRaw?: unknown;
	// When categorizeRaw is used but you still want the well-formed group_id
	// preserved in the manifest, `id` above is what lands in the manifest.
};

// Builds a minimal client dir: ข้อมูลระบบ/_doc_groups/manifest.yaml plus one
// categorize.json per group (unless lines is null, simulating a group not
// populated yet). Mirrors the real shape read from
// samples/clients/_336 บจก ฮัก ดีไซน์/ข้อมูลระบบ/_doc_groups/{manifest.yaml,<path>/categorize.json}.
function clientWithGroups(groups: GroupFixture[]): { dir: string; outDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "ksk-catcheck-"));
	tmps.push(dir);
	const dgDir = join(dir, "ข้อมูลระบบ", "_doc_groups");
	mkdirSync(dgDir, { recursive: true });

	const manifestGroups = groups.map((g) => ({
		id: g.id,
		path: g.path,
		label: g.id,
		category: g.category,
		vat_treatment: "non_vat",
		segments: [],
		bookable_doc: null,
		transaction_id: null,
		confidence: "medium",
		populate: "agent",
		primary_interpretation: null,
		evidence_interpretations: [],
		source_ref: null,
		warnings: [],
	}));
	// Serialize with the same YAML serializer the module under test uses to
	// read it back — no hand-written template string to drift out of sync.
	writeFileSync(
		join(dgDir, "manifest.yaml"),
		yamlStringify({ schema: "ksk_doc_groups.v1", layout: "category_vat_tree.v1", groups: manifestGroups }),
	);

	for (const g of groups) {
		if (g.categorizeRaw === undefined && g.lines === null) continue; // simulate a not-yet-categorized group
		const groupDir = join(dgDir, g.path);
		mkdirSync(groupDir, { recursive: true });
		const body =
			g.categorizeRaw !== undefined
				? g.categorizeRaw
				: {
						group_id: g.id,
						lines: (g.lines ?? []).map((l, i) => ({
							line_index: l.line_index ?? i,
							account_code: l.account_code,
							sub_code: "",
							account_name_th: l.account_name_th ?? "",
							confidence: "medium",
							reason: "test fixture",
							needs_review: true,
						})),
						questions_for_user: [],
					};
		writeFileSync(join(groupDir, "categorize.json"), JSON.stringify(body));
	}

	const outDir = mkdtempSync(join(tmpdir(), "ksk-catcheck-out-"));
	tmps.push(outDir);
	return { dir, outDir };
}

// --- assessLine (pure) ---------------------------------------------------

describe("assessLine", () => {
	test("expense + 5xxxxx is clean", () => {
		expect(assessLine("expense", "510110")).toBeNull();
	});

	test("expense + 4xxxxx (revenue under expense) is flagged high", () => {
		const r = assessLine("expense", "410101");
		expect(r?.severity).toBe("high");
		expect(r?.message).toMatch(/revenue/i);
	});

	test("expense + 1xxxxx (asset under expense) is flagged review, not high", () => {
		const r = assessLine("expense", "113201");
		expect(r?.severity).toBe("review");
		expect(r?.message).toMatch(/MAY be legitimate/);
	});

	test("expense + 2xxxxx (liability under expense) is flagged review", () => {
		const r = assessLine("expense", "212201");
		expect(r?.severity).toBe("review");
	});

	test("income + 4xxxxx is clean", () => {
		expect(assessLine("income", "410101")).toBeNull();
	});

	test("income + 5xxxxx (expense under income) is flagged high", () => {
		const r = assessLine("income", "520101");
		expect(r?.severity).toBe("high");
		expect(r?.message).toMatch(/expense/i);
	});

	test("income + 1xxxxx is flagged review", () => {
		const r = assessLine("income", "113201");
		expect(r?.severity).toBe("review");
	});
});

// --- runCategoryAccountCheck (integration over a fixture client dir) ----

describe("runCategoryAccountCheck", () => {
	test("flags a 1xxxxx account confirmed under an expense group (the _336 680/628 bug shape)", () => {
		const { dir, outDir } = clientWithGroups([
			{
				id: "680-ID_NOT_FOUND_3",
				path: "expense/non_vat/680-ID_NOT_FOUND_3",
				category: "expense",
				lines: [{ account_code: "113201", account_name_th: "เงินให้กู้ยืม-บุคคลที่เกี่ยวข้องกัน" }],
			},
		]);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.manifest_found).toBe(true);
		expect(result.groups_checked).toBe(1);
		expect(result.flags).toHaveLength(1);
		expect(result.flags[0]).toMatchObject({
			group_id: "680-ID_NOT_FOUND_3",
			account_code: "113201",
			category: "expense",
			severity: "review",
		});
	});

	test("a 5xxxxx account under expense is clean (no flags)", () => {
		const { dir, outDir } = clientWithGroups([
			{
				id: "001-INV1",
				path: "expense/vat/001-INV1",
				category: "expense",
				lines: [{ account_code: "510110", account_name_th: "ซื้อสินค้า" }],
			},
		]);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.groups_checked).toBe(1);
		expect(result.flags).toHaveLength(0);
	});

	test("a 4xxxxx account under income is clean (no flags)", () => {
		const { dir, outDir } = clientWithGroups([
			{
				id: "001-CA1",
				path: "income/vat/001-CA1",
				category: "income",
				lines: [{ account_code: "410101", account_name_th: "รายได้จากการขายสินค้า" }],
			},
		]);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.groups_checked).toBe(1);
		expect(result.flags).toHaveLength(0);
	});

	test("a missing categorize.json is tolerated — skipped, not a crash or a flag", () => {
		const { dir, outDir } = clientWithGroups([
			{
				id: "002-INV2",
				path: "expense/vat/002-INV2",
				category: "expense",
				lines: null,
			},
		]);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.groups_checked).toBe(0);
		expect(result.groups_skipped_missing_categorize).toBe(1);
		expect(result.flags).toHaveLength(0);
	});

	test("bank_statement groups are out of scope even with a 1xxxxx-looking counter-account", () => {
		const { dir, outDir } = clientWithGroups([
			{
				id: "001-seg-001",
				path: "bank_statement/001-seg-001",
				category: "bank_statement",
				lines: [{ account_code: "212306", account_name_th: "เจ้าหนี้อื่น" }],
			},
		]);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.groups_checked).toBe(0);
		expect(result.flags).toHaveLength(0);
	});

	test("4xxxxx under expense is flagged high (revenue booked as expense — definitely wrong)", () => {
		const { dir, outDir } = clientWithGroups([
			{
				id: "003-INV3",
				path: "expense/vat/003-INV3",
				category: "expense",
				lines: [{ account_code: "410101", account_name_th: "รายได้จากการขายสินค้า" }],
			},
		]);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.flags).toHaveLength(1);
		expect(result.flags[0].severity).toBe("high");
	});

	test("a client dir with no doc-group manifest at all is a clean no-op (never crashes)", () => {
		const dir = mkdtempSync(join(tmpdir(), "ksk-catcheck-nomanifest-"));
		tmps.push(dir);
		const outDir = mkdtempSync(join(tmpdir(), "ksk-catcheck-out-"));
		tmps.push(outDir);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.manifest_found).toBe(false);
		expect(result.flags).toHaveLength(0);
	});

	test("a categorize.json whose `lines` is not an array is tolerated — counted malformed, never crashes", () => {
		const { dir, outDir } = clientWithGroups([
			{
				id: "005-INV5",
				path: "expense/vat/005-INV5",
				category: "expense",
				lines: [],
				categorizeRaw: {}, // structurally valid JSON, but no `lines` array
			},
		]);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.groups_checked).toBe(0);
		expect(result.groups_skipped_malformed_categorize).toBe(1);
		expect(result.flags).toHaveLength(0);
	});

	test("an empty-string group_id falls back to the manifest group id (|| not ??)", () => {
		const { dir, outDir } = clientWithGroups([
			{
				id: "006-INV6",
				path: "expense/vat/006-INV6",
				category: "expense",
				lines: [],
				categorizeRaw: {
					group_id: "", // empty string must fall back, not be used verbatim
					lines: [
						{
							line_index: 0,
							account_code: "410101",
							account_name_th: "รายได้",
						},
					],
				},
			},
		]);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.flags).toHaveLength(1);
		expect(result.flags[0].group_id).toBe("006-INV6");
	});

	test("multiple lines in one categorize.json are each assessed independently", () => {
		const { dir, outDir } = clientWithGroups([
			{
				id: "004-INV4",
				path: "expense/vat/004-INV4",
				category: "expense",
				lines: [
					{ account_code: "520103", account_name_th: "ค่าบริการ shopee", line_index: 0 },
					{ account_code: "113201", account_name_th: "เงินให้กู้ยืม", line_index: 1 },
				],
			},
		]);
		const result = runCategoryAccountCheck(dir, outDir);
		expect(result.flags).toHaveLength(1);
		expect(result.flags[0].line_index).toBe(1);
	});
});
