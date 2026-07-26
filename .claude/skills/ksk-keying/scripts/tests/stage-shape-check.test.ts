import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docGroupsDir, pagesDir, segmentsDir } from "../paths";
import { runStageShapeCheck } from "../stage-shape-check";

const tmps: string[] = [];
function tmpClient(): string {
	const dir = mkdtempSync(join(tmpdir(), "ksk-shape-check-"));
	tmps.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe("stage-shape-check — profile", () => {
	test("empty client dir is incomplete on all three fronts", () => {
		const dir = tmpClient();
		const offenses = runStageShapeCheck(dir, "profile");
		expect(offenses.some((o) => o.includes("CLIENT.md"))).toBe(true);
		expect(offenses.some((o) => o.includes("coa.csv"))).toBe(true);
		expect(offenses.some((o) => o.includes("inventory.yaml"))).toBe(true);
	});

	test("passes once CLIENT.md + coa.csv + inventory.yaml all exist and parse", () => {
		const dir = tmpClient();
		writeFileSync(join(dir, "CLIENT.md"), `---\nname: Test Co\n---\n\nbody\n`);
		writeFileSync(join(dir, "coa.csv"), "code,name\n1000,cash\n");
		mkdirSync(pagesDir(dir), { recursive: true });
		writeFileSync(
			join(pagesDir(dir), "inventory.yaml"),
			`schema: ksk_inventory.v1\nfiles:\n  - path: invoice.pdf\n    kind: pdf\n    page_count: 1\n    sheets: null\n`,
		);
		expect(runStageShapeCheck(dir, "profile")).toEqual([]);
	});

	test("CLIENT.md with malformed frontmatter is flagged, not thrown", () => {
		const dir = tmpClient();
		writeFileSync(join(dir, "CLIENT.md"), `---\n[unterminated\n---\n`);
		const offenses = runStageShapeCheck(dir, "profile");
		expect(offenses.some((o) => o.includes("not valid YAML"))).toBe(true);
	});
});

describe("stage-shape-check — link", () => {
	function seedInterpretation(dir: string, segmentId: string) {
		const segDir = join(segmentsDir(dir), segmentId);
		mkdirSync(segDir, { recursive: true });
		writeFileSync(join(segDir, "interpretation.json"), JSON.stringify({ documents: [] }));
	}

	test("missing links.draft.yaml and links.yaml are both flagged", () => {
		const dir = tmpClient();
		const offenses = runStageShapeCheck(dir, "link");
		expect(offenses.some((o) => o.includes("links.draft.yaml"))).toBe(true);
		expect(offenses.some((o) => o.includes("links.yaml"))).toBe(true);
	});

	test("a segment with an interpretation but no covering cluster is flagged", () => {
		const dir = tmpClient();
		seedInterpretation(dir, "seg-001");
		seedInterpretation(dir, "seg-002");
		mkdirSync(docGroupsDir(dir), { recursive: true });
		writeFileSync(join(docGroupsDir(dir), "links.draft.yaml"), "transactions: []\n");
		writeFileSync(
			join(docGroupsDir(dir), "links.yaml"),
			`transactions:\n  - transaction_id: t1\n    segments: [seg-001]\n`,
		);
		const offenses = runStageShapeCheck(dir, "link");
		expect(offenses.some((o) => o.includes("seg-002"))).toBe(true);
		expect(offenses.some((o) => o.includes("seg-001"))).toBe(false);
	});

	test("every segment covered (including standalone clusters) passes", () => {
		const dir = tmpClient();
		seedInterpretation(dir, "seg-001");
		mkdirSync(docGroupsDir(dir), { recursive: true });
		writeFileSync(join(docGroupsDir(dir), "links.draft.yaml"), "transactions: []\n");
		writeFileSync(
			join(docGroupsDir(dir), "links.yaml"),
			`transactions:\n  - transaction_id: t1\n    segments: [seg-001]\n`,
		);
		expect(runStageShapeCheck(dir, "link")).toEqual([]);
	});
});

describe("stage-shape-check — group", () => {
	test("missing manifest.yaml is flagged", () => {
		const dir = tmpClient();
		const offenses = runStageShapeCheck(dir, "group");
		expect(offenses.some((o) => o.includes("manifest.yaml"))).toBe(true);
	});

	test("a group listed in the manifest with no interpretation.json is flagged", () => {
		const dir = tmpClient();
		mkdirSync(docGroupsDir(dir), { recursive: true });
		writeFileSync(
			join(docGroupsDir(dir), "manifest.yaml"),
			`schema: ksk_doc_groups.v1\ngroups:\n  - id: g1\n    path: expense/vat/g1\n`,
		);
		const offenses = runStageShapeCheck(dir, "group");
		expect(offenses.some((o) => o.includes("g1"))).toBe(true);
	});

	test("every group with an interpretation.json passes", () => {
		const dir = tmpClient();
		mkdirSync(docGroupsDir(dir), { recursive: true });
		writeFileSync(
			join(docGroupsDir(dir), "manifest.yaml"),
			`schema: ksk_doc_groups.v1\ngroups:\n  - id: g1\n    path: expense/vat/g1\n`,
		);
		const groupDir = join(docGroupsDir(dir), "expense", "vat", "g1");
		mkdirSync(groupDir, { recursive: true });
		writeFileSync(join(groupDir, "interpretation.json"), JSON.stringify({}));
		expect(runStageShapeCheck(dir, "group")).toEqual([]);
	});
});
