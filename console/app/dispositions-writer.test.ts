// Pure applyDecision tests, same "existing + change -> next entries" shape
// and assertion style as merge-dispositions.test.ts's mergeDispositions
// coverage. The "confirm" branch is this ticket's scope; "bring_back" is
// ticket #46's (Build: excluded-review bring-back + repairRun).
import { describe, expect, test } from "bun:test";
import { applyDecision, type DispositionEntry } from "./dispositions-writer";

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

describe("applyDecision", () => {
	test("confirm preserves reason and duplicate_of, seals declared_by human", () => {
		const existing = [excluded("a.pdf", 1, "duplicate", "agent", "b.pdf#p1")];
		const result = applyDecision(existing, "a.pdf#p1", "confirm");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toEqual({
			file: "a.pdf",
			page: 1,
			sheet: null,
			disposition: "excluded",
			reason: "duplicate",
			declared_by: "human",
			duplicate_of: "b.pdf#p1",
		});
	});

	test("confirm leaves every other entry untouched", () => {
		const existing = [excluded("a.pdf", 1, "duplicate", "agent"), excluded("b.pdf", 2, "blank_or_separator", "agent")];
		const result = applyDecision(existing, "a.pdf#p1", "confirm");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.entries.find((e) => e.file === "b.pdf")).toEqual(existing[1]);
	});

	test("rejects when the target unit key isn't found", () => {
		const existing = [excluded("a.pdf", 1, "duplicate", "agent")];
		const result = applyDecision(existing, "missing.pdf#p1", "confirm");
		expect(result.ok).toBe(false);
	});

	test("rejects when the entry is already declared_by human", () => {
		const existing = [excluded("a.pdf", 1, "duplicate", "human")];
		const result = applyDecision(existing, "a.pdf#p1", "confirm");
		expect(result.ok).toBe(false);
	});

	test("rejects when the entry has no reason (reason-required-when-excluded, re-checked at write time)", () => {
		const existing: DispositionEntry[] = [
			{ file: "a.pdf", page: 1, sheet: null, disposition: "excluded", declared_by: "agent" },
		];
		const result = applyDecision(existing, "a.pdf#p1", "confirm");
		expect(result.ok).toBe(false);
	});

	test("rejects when the entry's disposition is used, not excluded", () => {
		const existing: DispositionEntry[] = [
			{ file: "a.pdf", page: 1, sheet: null, disposition: "used", declared_by: "agent" },
		];
		const result = applyDecision(existing, "a.pdf#p1", "confirm");
		expect(result.ok).toBe(false);
	});

	test("matches file-level (bare) unit keys", () => {
		const existing = [excluded("coa.xlsx", null, "context_file", "agent_policy")];
		const result = applyDecision(existing, "coa.xlsx", "confirm");
		expect(result.ok).toBe(true);
	});
});
