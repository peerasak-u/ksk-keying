import { describe, expect, test } from "bun:test";
import { createInterpretPlan } from "./interpret-plan";

const root = "/work/client/month";
const inventory = { files: [
	{ path: "ซื้อ/scan.pdf", kind: "pdf" as const, page_count: 31, sheets: null },
	{ path: "bank.xlsx", kind: "spreadsheet" as const, page_count: 2, sheets: ["April", "May"] },
] };

describe("createInterpretPlan", () => {
	test("uses exact contained paths and chunks visual work at 15 pages", () => {
		const plan = createInterpretPlan({ runRoot: root, inventory, manifest: { schema: "ksk_segments.v1", segments: [{ segment_id: "seg-001", type: "pdf_range", sources: [{ file: "ซื้อ/scan.pdf", pages: [1, 31], sheets: null }] }] } });
		expect(plan.units.map((unit) => unit.pages.length)).toEqual([15, 15, 1]);
		expect(plan.units.map((unit) => unit.id)).toEqual(["seg-001-u001", "seg-001-u002", "seg-001-u003"]);
		expect(plan.units[0].pages[0].artifactPath).toBe("/work/client/month/_pages/ซื้อ/scan/page-001.png");
		expect(plan.units[0].resultPath).toBe("/work/client/month/ข้อมูลระบบ/_segments/seg-001/interpretation-u001.json");
	});

	test("plans one spreadsheet sheet per marple unit and preserves exact sheet names", () => {
		const plan = createInterpretPlan({ runRoot: root, inventory, manifest: { schema: "ksk_segments.v1", segments: [{ segment_id: "seg-bank", type: "spreadsheet", sources: [{ file: "bank.xlsx", pages: null, sheets: null }] }] } });
		expect(plan.units.map((unit) => [unit.agent, unit.sheets[0].sheet])).toEqual([["ksk-marple", "April"], ["ksk-marple", "May"]]);
	});

	test("honours Columbo sub_ranges, while rejecting gaps and overlaps instead of broadening a leaf", () => {
		const manifest = { schema: "ksk_segments.v1" as const, segments: [{ segment_id: "seg-sub", type: "pdf_range", sources: [{ file: "ซื้อ/scan.pdf", pages: [1, 31] as [number, number], sheets: null }], sub_ranges: [{ pages: [1, 9] as [number, number] }, { pages: [10, 24] as [number, number] }, { pages: [25, 31] as [number, number] }] }] };
		const plan = createInterpretPlan({ runRoot: root, inventory, manifest });
		expect(plan.units.map((unit) => unit.pages.length)).toEqual([9, 15, 7]);
		expect(() => createInterpretPlan({ runRoot: root, inventory, manifest: { ...manifest, segments: [{ ...manifest.segments[0], sub_ranges: [{ pages: [1, 15] }, { pages: [15, 31] }] }] } })).toThrow("overlap");
	});

	test("does not dispatch derived reports unless policy/human dispositions already exclude every unit", () => {
		const manifest = { schema: "ksk_segments.v1" as const, segments: [{ segment_id: "seg-report", type: "pdf_range", source_class: "derived_report", sources: [{ file: "ซื้อ/scan.pdf", pages: [1, 2] as [number, number], sheets: null }] }] };
		expect(() => createInterpretPlan({ runRoot: root, inventory, manifest })).toThrow("without an existing human/agent_policy exclusion");
		const plan = createInterpretPlan({ runRoot: root, inventory, manifest, dispositions: { entries: [
			{ file: "ซื้อ/scan.pdf", page: 1, disposition: "excluded", declared_by: "agent_policy" },
			{ file: "ซื้อ/scan.pdf", page: 2, disposition: "excluded", declared_by: "agent_policy" },
		] } });
		expect(plan).toMatchObject({ units: [], skipped: [{ segmentId: "seg-report" }] });
		const fileExcluded = createInterpretPlan({ runRoot: root, inventory, manifest, dispositions: { entries: [{ file: "ซื้อ/scan.pdf", disposition: "excluded", declared_by: "agent_policy" }] } });
		expect(fileExcluded).toMatchObject({ units: [], skipped: [{ segmentId: "seg-report" }] });
	});

	test("rejects traversal and mixed source modalities rather than asking Claude to resolve them", () => {
		expect(() => createInterpretPlan({ runRoot: root, inventory, manifest: { schema: "ksk_segments.v1", segments: [{ segment_id: "seg-bad", type: "single_file", sources: [{ file: "../secret.pdf", pages: null, sheets: null }] }] } })).toThrow("without '..'");
		expect(() => createInterpretPlan({ runRoot: root, inventory, manifest: { schema: "ksk_segments.v1", segments: [{ segment_id: "seg-mixed", type: "transaction_folder", sources: [{ file: "ซื้อ/scan.pdf", pages: [1, 1], sheets: null }, { file: "bank.xlsx", pages: null, sheets: ["April"] }] }] } })).toThrow("mixes visual and spreadsheet");
	});

	test("fails explicitly for an opaque source unless policy already excluded the whole file", () => {
		const opaqueInventory = { files: [{ path: "archive.bin", kind: "other" as const, page_count: 1, sheets: null }] };
		const manifest = { schema: "ksk_segments.v1" as const, segments: [{ segment_id: "seg-opaque", type: "single_file", sources: [{ file: "archive.bin", pages: null, sheets: null }] }] };
		expect(() => createInterpretPlan({ runRoot: root, inventory: opaqueInventory, manifest })).toThrow("unsupported opaque source");
		expect(createInterpretPlan({
			runRoot: root,
			inventory: opaqueInventory,
			manifest,
			dispositions: { entries: [{ file: "archive.bin", disposition: "excluded", declared_by: "agent_policy" }] },
		})).toMatchObject({ units: [], skipped: [{ segmentId: "seg-opaque" }] });
	});
});
