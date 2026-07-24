// PROTOTYPE — WIPE ME. A tiny synthetic month folder the REAL ledger.ts /
// stage-shape-check.ts can be pointed at, plus a few mutators so the TUI can
// flip evidence live and watch the real completion checks' exit codes
// respond. 3 Page-Ledger units total: invoice.pdf (2 pages) + statement.xlsx
// (1 sheet, "Jan"), both in one segment (seg-01).
//
// Hand-written YAML (no "yaml" package dependency here — console/ doesn't
// have it installed and this is throwaway) matching exactly the schema
// ledger.ts's/stage-shape-check.ts's loaders expect.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
export const FIXTURE_DIR = join(HERE, "_scratch-month");
const SYS = join(FIXTURE_DIR, "ข้อมูลระบบ");
const PAGES = join(SYS, "_pages");
const SEGMENTS = join(SYS, "_segments");
const DOC_GROUPS = join(SYS, "_doc_groups");

const INVENTORY_YAML = `schema: ksk_inventory.v1
files:
  - path: invoice.pdf
    kind: pdf
    page_count: 2
    sheets: null
  - path: statement.xlsx
    kind: spreadsheet
    page_count: 0
    sheets:
      - Jan
`;

const MANIFEST_YAML = `segments:
  - segment_id: seg-01
    sources:
      - file: invoice.pdf
        pages: [1, 2]
        sheets: null
      - file: statement.xlsx
        pages: null
        sheets:
          - Jan
`;

const DISPOSITIONS_YAML = `entries:
  - file: invoice.pdf
    page: 1
    sheet: null
    disposition: used
  - file: invoice.pdf
    page: 2
    sheet: null
    disposition: used
  - file: statement.xlsx
    page: null
    sheet: Jan
    disposition: used
`;

const REVIEW_DATA_JSON = JSON.stringify(
	{
		pages: [
			{ source_src: "invoice.pdf", source_pages: [1, 2] },
			{ source_src: "statement.xlsx", source_sheet: "Jan" },
		],
	},
	null,
	2,
);

const CLIENT_MD = `---
name: Test Co (prototype fixture)
tax_id: "0000000000000"
business_nature: "prototype sequencer fixture — not a real client"
---

# Test Co

Synthetic client for the sequencer prototype. Never a real client's data.
`;

const COA_CSV = `account_code,sub_code,name_th,name_en
1000,,เงินสด,Cash
4000,,รายได้,Income
5000,,ค่าใช้จ่าย,Expense
`;

const SEGMENT_INTERPRETATION_JSON = JSON.stringify(
	{ documents: [{ source_file: "invoice.pdf", source_page: 1, doc_kind: "normal_bill_or_invoice" }] },
	null,
	2,
);

const LINKS_DRAFT_YAML = `transactions: []\nresidue:\n  - seg-01\n`;
const LINKS_YAML = `transactions:\n  - transaction_id: t1\n    segments: [seg-01]\n    bookable_docs: [INV-001]\n`;

const DOC_GROUP_MANIFEST_YAML = `schema: ksk_doc_groups.v1
layout: category_vat_tree.v1
groups:
  - id: g1
    path: expense/vat/g1
    label: seg-01 INV-001
    category: expense
    vat_treatment: vat
    segments: [seg-01]
    bookable_doc: INV-001
    populate: script
`;

const GROUP_INTERPRETATION_JSON = JSON.stringify(
	{
		group_id: "g1",
		facts: { direction: "expense", document_no: "INV-001", gross_total: 1070, vat: 70, net_paid: 1070 },
		line_items: [],
		documents: [{ source_file: "invoice.pdf", source_page: 1, lines_owner: true, doc_kind: "normal_bill_or_invoice" }],
		review_flags: [],
		questions_for_user: [],
	},
	null,
	2,
);

const GROUP_CATEGORIZE_JSON = JSON.stringify({ group_id: "g1", lines: [], questions_for_user: [] }, null, 2);

export function resetFixture() {
	rmSync(FIXTURE_DIR, { recursive: true, force: true });
	mkdirSync(PAGES, { recursive: true });
	writeInventory();
}

export function writeInventory() {
	mkdirSync(PAGES, { recursive: true });
	writeFileSync(join(PAGES, "inventory.yaml"), INVENTORY_YAML);
}

export function deleteInventory() {
	rmSync(join(PAGES, "inventory.yaml"), { force: true });
}

export function segmentAllUnits() {
	mkdirSync(SEGMENTS, { recursive: true });
	writeFileSync(join(SEGMENTS, "manifest.yaml"), MANIFEST_YAML);
}

export function clearSegments() {
	rmSync(SEGMENTS, { recursive: true, force: true });
}

export function dispositionAllUnitsUsed() {
	mkdirSync(PAGES, { recursive: true });
	writeFileSync(join(PAGES, "dispositions.yaml"), DISPOSITIONS_YAML);
}

export function clearDispositions() {
	rmSync(join(PAGES, "dispositions.yaml"), { force: true });
}

export function claimAllUnitsReviewed() {
	const dir = join(DOC_GROUPS, "expense", "vat", "group-01");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "review-data.json"), REVIEW_DATA_JSON);
}

export function clearReviewClaims() {
	rmSync(DOC_GROUPS, { recursive: true, force: true });
}

// --- profile stage --------------------------------------------------------

export function writeClientProfile() {
	writeFileSync(join(FIXTURE_DIR, "CLIENT.md"), CLIENT_MD);
	writeFileSync(join(FIXTURE_DIR, "coa.csv"), COA_CSV);
}

export function clearClientProfile() {
	rmSync(join(FIXTURE_DIR, "CLIENT.md"), { force: true });
	rmSync(join(FIXTURE_DIR, "coa.csv"), { force: true });
}

// --- link stage -------------------------------------------------------------

export function writeSegmentInterpretation() {
	const dir = join(SEGMENTS, "seg-01");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "interpretation.json"), SEGMENT_INTERPRETATION_JSON);
}

export function clearSegmentInterpretation() {
	rmSync(join(SEGMENTS, "seg-01", "interpretation.json"), { force: true });
}

export function writeLinks() {
	mkdirSync(DOC_GROUPS, { recursive: true });
	writeFileSync(join(DOC_GROUPS, "links.draft.yaml"), LINKS_DRAFT_YAML);
	writeFileSync(join(DOC_GROUPS, "links.yaml"), LINKS_YAML);
}

export function clearLinks() {
	rmSync(join(DOC_GROUPS, "links.draft.yaml"), { force: true });
	rmSync(join(DOC_GROUPS, "links.yaml"), { force: true });
}

// --- group stage ------------------------------------------------------------

export function writeDocGroupManifest() {
	mkdirSync(DOC_GROUPS, { recursive: true });
	writeFileSync(join(DOC_GROUPS, "manifest.yaml"), DOC_GROUP_MANIFEST_YAML);
}

export function clearDocGroupManifest() {
	rmSync(join(DOC_GROUPS, "manifest.yaml"), { force: true });
}

export function writeGroupInterpretation() {
	const dir = join(DOC_GROUPS, "expense", "vat", "g1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "interpretation.json"), GROUP_INTERPRETATION_JSON);
}

export function clearGroupInterpretation() {
	rmSync(join(DOC_GROUPS, "expense", "vat", "g1", "interpretation.json"), { force: true });
}

// categorize.json is Stage 5's own output (poirot), but build-review-data.ts
// (the categorize completion check) requires it alongside interpretation.json
// for every group — the fixture writes both so the fixture-driven walkthrough
// can reach a real PASS at the categorize stage, not just at link/group.
export function writeGroupCategorize() {
	const dir = join(DOC_GROUPS, "expense", "vat", "g1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "categorize.json"), GROUP_CATEGORIZE_JSON);
}

export function clearGroupCategorize() {
	rmSync(join(DOC_GROUPS, "expense", "vat", "g1", "categorize.json"), { force: true });
}

// --- human-stop.yaml ----------------------------------------------------

export function writeHumanStopEntry() {
	mkdirSync(PAGES, { recursive: true });
	writeFileSync(
		join(PAGES, "human-stop.yaml"),
		`schema: ksk_human_stop.v1\nentries:\n  - stage: interpret\n    unit: seg-01\n    condition: no_rule_ambiguity\n    reason: "prototype fixture — simulated hard blocker"\n`,
	);
}

export function clearHumanStop() {
	rmSync(join(PAGES, "human-stop.yaml"), { force: true });
}

export function fixtureSummary(): string[] {
	const has = (p: string) => (existsSync(p) ? "present" : "MISSING");
	return [
		`inventory.yaml:        ${has(join(PAGES, "inventory.yaml"))}`,
		`CLIENT.md / coa.csv:   ${has(join(FIXTURE_DIR, "CLIENT.md"))} / ${has(join(FIXTURE_DIR, "coa.csv"))}`,
		`manifest.yaml:         ${has(join(SEGMENTS, "manifest.yaml"))}`,
		`dispositions.yaml:     ${has(join(PAGES, "dispositions.yaml"))}`,
		`seg-01 interpretation: ${has(join(SEGMENTS, "seg-01", "interpretation.json"))}`,
		`links.draft/links:     ${has(join(DOC_GROUPS, "links.draft.yaml"))} / ${has(join(DOC_GROUPS, "links.yaml"))}`,
		`doc-group manifest:    ${has(join(DOC_GROUPS, "manifest.yaml"))}`,
		`group g1 interpretation: ${has(join(DOC_GROUPS, "expense", "vat", "g1", "interpretation.json"))}`,
		`group g1 categorize:    ${has(join(DOC_GROUPS, "expense", "vat", "g1", "categorize.json"))}`,
		`review-data.json:      ${existsSync(join(DOC_GROUPS, "expense", "vat", "group-01")) ? "present" : "MISSING"}`,
		`human-stop.yaml:       ${has(join(PAGES, "human-stop.yaml"))}`,
	];
}
