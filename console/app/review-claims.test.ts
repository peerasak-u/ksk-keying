// Pure buildClaims tests — fixed fixture input/output, no file I/O. Same
// "assert on the returned list" style as merge-dispositions.test.ts's coverage
// of mergeDispositions.
import { describe, expect, test } from "bun:test";
import { buildClaims, hasAnyExcludedEntries, type DispositionEntry } from "./review-claims";

const used = (file: string, page: number | null = null, sheet: string | null = null): DispositionEntry => ({
	file,
	page,
	sheet,
	disposition: "used",
	declared_by: "agent",
});

const excluded = (
	file: string,
	page: number | null,
	reason: string,
	declared_by: string,
	duplicate_of?: string,
): DispositionEntry => ({
	file,
	page,
	sheet: null,
	disposition: "excluded",
	reason,
	declared_by,
	duplicate_of,
});

describe("buildClaims", () => {
	test("scopes to excluded + declared_by agent/agent_policy, excludes human-sealed entries", () => {
		const entries = [
			excluded("a.pdf", 1, "duplicate", "agent"),
			excluded("b.pdf", 1, "blank_or_separator", "agent_policy"),
			excluded("c.pdf", 1, "duplicate", "human"),
			used("d.pdf", 1),
		];
		const claims = buildClaims(entries, new Map(), true);
		expect(claims.map((c) => c.file)).toEqual(["a.pdf", "b.pdf"]);
	});

	test("labels the real 7 reason categories and falls back gracefully for an unknown reason", () => {
		const entries = [
			excluded("a.pdf", 1, "context_file", "agent_policy"),
			excluded("b.pdf", 1, "duplicate", "agent"),
			excluded("c.pdf", 1, "blank_or_separator", "agent"),
			excluded("d.xlsx", null, "reference_example", "agent_policy"),
			excluded("e.xlsx", null, "superseded_by seg-004", "agent_policy"),
			excluded("f.zip", null, "redundant_archive", "agent_policy"),
			excluded("g.xlsx", null, "reference_report", "agent"),
			excluded("h.pdf", 1, "some_future_reason", "agent"),
		];
		const claims = buildClaims(entries, new Map(), true);
		const byFile = Object.fromEntries(claims.map((c) => [c.file, c]));
		expect(byFile["a.pdf"].reasonCategory).toBe("context_file");
		expect(byFile["b.pdf"].reasonCategory).toBe("duplicate");
		expect(byFile["c.pdf"].reasonCategory).toBe("blank_or_separator");
		expect(byFile["d.xlsx"].reasonCategory).toBe("reference_example");
		expect(byFile["e.xlsx"].reasonCategory).toBe("superseded_by");
		expect(byFile["e.xlsx"].reasonLabel).toContain("seg-004");
		expect(byFile["f.zip"].reasonCategory).toBe("redundant_archive");
		expect(byFile["g.xlsx"].reasonCategory).toBe("reference_report");
		expect(byFile["g.xlsx"].extraScrutiny).toBe(true);
		expect(byFile["h.pdf"].reasonCategory).toBe("unknown");
		expect(byFile["h.pdf"].reasonLabel).toBe("some_future_reason");
		expect(byFile["a.pdf"].extraScrutiny).toBe(false);
	});

	test("orders reference_report claims first, otherwise stable", () => {
		const entries = [
			excluded("a.pdf", 1, "duplicate", "agent"),
			excluded("b.xlsx", null, "reference_report", "agent"),
			excluded("c.pdf", 1, "blank_or_separator", "agent"),
			excluded("d.xlsx", null, "reference_report", "agent"),
		];
		const claims = buildClaims(entries, new Map(), true);
		expect(claims.map((c) => c.file)).toEqual(["b.xlsx", "d.xlsx", "a.pdf", "c.pdf"]);
	});

	test("resolves a duplicate claim's counterpart from duplicate_of, matching the real unit", () => {
		const entries = [
			used("original.pdf", 1),
			excluded("dup.pdf", 1, "duplicate", "agent", "original.pdf#p1"),
		];
		const claims = buildClaims(entries, new Map(), true);
		const dup = claims.find((c) => c.file === "dup.pdf")!;
		expect(dup.duplicateOf).toEqual({ file: "original.pdf", page: 1, sheet: null, unitKey: "original.pdf#p1" });
	});

	test("falls back to the raw duplicate_of key when the counterpart unit can't be found", () => {
		const entries = [excluded("dup.pdf", 1, "duplicate", "agent", "missing.pdf#p9")];
		const claims = buildClaims(entries, new Map(), true);
		expect(claims[0].duplicateOf).toEqual({ file: "missing.pdf#p9", page: null, sheet: null, unitKey: "missing.pdf#p9" });
	});

	test("surfaces the conflict-warning group name when a unit is also reviewed elsewhere", () => {
		const entries = [excluded("a.pdf", 1, "blank_or_separator", "agent")];
		const reviewed = new Map([["a.pdf#p1", "รายได้ - มีภาษี"]]);
		const claims = buildClaims(entries, reviewed, true);
		expect(claims[0].conflictGroup).toBe("รายได้ - มีภาษี");
	});

	test("conflictGroup is null when the unit isn't reviewed elsewhere", () => {
		const entries = [excluded("a.pdf", 1, "blank_or_separator", "agent")];
		const claims = buildClaims(entries, new Map(), true);
		expect(claims[0].conflictGroup).toBeNull();
	});

	test("flags reference_report claims when reference-report-check hasn't run yet", () => {
		const entries = [excluded("a.xlsx", null, "reference_report", "agent")];
		const withoutCheck = buildClaims(entries, new Map(), false);
		const withCheck = buildClaims(entries, new Map(), true);
		expect(withoutCheck[0].referenceReportCheckMissing).toBe(true);
		expect(withCheck[0].referenceReportCheckMissing).toBe(false);
	});

	test("referenceReportCheckMissing is always false for non-reference_report claims", () => {
		const entries = [excluded("a.pdf", 1, "duplicate", "agent")];
		const claims = buildClaims(entries, new Map(), false);
		expect(claims[0].referenceReportCheckMissing).toBe(false);
	});

	test("file-level claims (page and sheet both null) carry a bare-file unit key", () => {
		const entries = [excluded("coa.xlsx", null, "context_file", "agent_policy")];
		const claims = buildClaims(entries, new Map(), true);
		expect(claims[0].unitKey).toBe("coa.xlsx");
		expect(claims[0].page).toBeNull();
		expect(claims[0].sheet).toBeNull();
	});

	test("derives fileKind from the real extension", () => {
		const entries = [excluded("a.pdf", 1, "duplicate", "agent"), excluded("b.xlsx", null, "context_file", "agent_policy")];
		const claims = buildClaims(entries, new Map(), true);
		expect(claims.find((c) => c.file === "a.pdf")!.fileKind).toBe("pdf");
		expect(claims.find((c) => c.file === "b.xlsx")!.fileKind).toBe("xlsx");
	});
});

describe("hasAnyExcludedEntries", () => {
	test("true when at least one entry (any declared_by) is excluded", () => {
		expect(hasAnyExcludedEntries([excluded("a.pdf", 1, "duplicate", "human")])).toBe(true);
		expect(hasAnyExcludedEntries([excluded("a.pdf", 1, "duplicate", "agent")])).toBe(true);
	});

	test("false when there are no excluded entries at all", () => {
		expect(hasAnyExcludedEntries([used("a.pdf", 1)])).toBe(false);
		expect(hasAnyExcludedEntries([])).toBe(false);
	});
});
