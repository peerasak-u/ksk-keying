import { describe, expect, test } from "bun:test";
import {
	type DispositionEntry,
	type Fragment,
	mergeDispositions,
} from "../merge-dispositions";

const used = (file: string, page: number | null = null, sheet: string | null = null): DispositionEntry => ({
	file,
	page,
	sheet,
	disposition: "used",
});

const excluded = (
	file: string,
	page: number | null,
	reason: string,
	declared_by?: string,
): DispositionEntry => ({
	file,
	page,
	sheet: null,
	disposition: "excluded",
	reason,
	declared_by,
});

describe("mergeDispositions", () => {
	test("adds fragment entries and stamps declared_by agent + provenance note", () => {
		const fragment: Fragment = {
			name: "seg-001.yaml",
			entries: [used("บิลซื้อ.pdf", 5), excluded("บิลซื้อ.pdf", 6, "duplicate")],
		};
		const result = mergeDispositions([], [fragment]);
		expect(result.added).toBe(2);
		expect(result.replaced).toBe(0);
		expect(result.entries).toHaveLength(2);
		for (const entry of result.entries) {
			expect(entry.declared_by).toBe("agent");
			expect(entry.note).toBe("fragment:seg-001.yaml");
		}
	});

	test("preserves human and agent_policy entries over fragments, with a warning on disagreement", () => {
		const existing = [
			excluded("ไฟล์นำเข้า.xlsx", null, "reference_example", "agent_policy"),
			excluded("บิลซื้อ.pdf", 3, "duplicate", "human"),
		];
		const fragment: Fragment = {
			name: "seg-002.yaml",
			entries: [used("บิลซื้อ.pdf", 3), used("บิลซื้อ.pdf", 4)],
		};
		const result = mergeDispositions(existing, [fragment]);
		const page3 = result.entries.find((e) => e.file === "บิลซื้อ.pdf" && e.page === 3);
		expect(page3?.disposition).toBe("excluded");
		expect(page3?.declared_by).toBe("human");
		expect(result.protectedKept).toBe(1);
		expect(result.added).toBe(1);
		expect(result.warnings.some((w) => w.includes("human"))).toBe(true);
		// untouched policy entry survives
		expect(
			result.entries.some((e) => e.file === "ไฟล์นำเข้า.xlsx" && e.declared_by === "agent_policy"),
		).toBe(true);
	});

	test("re-running the same fragments is idempotent", () => {
		const fragment: Fragment = {
			name: "seg-001.yaml",
			entries: [used("a.pdf", 1), excluded("a.pdf", 2, "blank")],
		};
		const first = mergeDispositions([], [fragment]);
		const second = mergeDispositions(first.entries, [fragment]);
		expect(second.entries).toEqual(first.entries);
		expect(second.added).toBe(0);
		expect(second.replaced).toBe(2);
	});

	test("later fragment wins on the same unit and disagreement warns", () => {
		const older: Fragment = { name: "seg-001.yaml", entries: [used("a.pdf", 1)] };
		const newer: Fragment = {
			name: "seg-002.yaml",
			entries: [excluded("a.pdf", 1, "duplicate")],
		};
		const result = mergeDispositions([], [older, newer]);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].disposition).toBe("excluded");
		expect(result.entries[0].note).toBe("fragment:seg-002.yaml");
		expect(result.warnings.some((w) => w.includes("claimed by both"))).toBe(true);
	});

	test("sheet units and NFC-differing filenames merge onto one unit", () => {
		// same Thai filename in NFD vs NFC must be treated as one unit
		const nfd = "บิล.xlsx".normalize("NFD");
		const nfc = "บิล.xlsx".normalize("NFC");
		const older: Fragment = { name: "a.yaml", entries: [used(nfd, null, "Sheet1")] };
		const newer: Fragment = { name: "b.yaml", entries: [used(nfc, null, "Sheet1")] };
		const result = mergeDispositions([], [older, newer]);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].sheet).toBe("Sheet1");
	});

	test("a fragment claiming declared_by human is forced to agent with a warning", () => {
		const fragment: Fragment = {
			name: "seg-003.yaml",
			entries: [excluded("a.pdf", 1, "duplicate", "human")],
		};
		const result = mergeDispositions([], [fragment]);
		expect(result.entries[0].declared_by).toBe("agent");
		expect(result.warnings.some((w) => w.includes("forced to"))).toBe(true);
	});

	test("output is sorted by file, page, sheet", () => {
		const fragment: Fragment = {
			name: "seg-001.yaml",
			entries: [used("b.pdf", 2), used("a.pdf", 10), used("a.pdf", 2)],
		};
		const result = mergeDispositions([], [fragment]);
		expect(result.entries.map((e) => `${e.file}#${e.page}`)).toEqual([
			"a.pdf#2",
			"a.pdf#10",
			"b.pdf#2",
		]);
	});
});
