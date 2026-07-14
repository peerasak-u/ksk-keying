import { describe, expect, test } from "bun:test";
import {
	manifestPartitionKeys,
	partitionAgreement,
	segmentPartitionKey,
	segmentUnitKeys,
	totalInventoryUnits,
	validateManifest,
} from "../specs/segment-stage";

// All fixtures here are hand-built JS objects — no file I/O, no live run, no
// samples/ data. The `ledger --gate segment` call segment-stage.ts makes via
// ctx.script is integration-tested elsewhere (a real run + real gate).

// ---------------------------------------------------------------------------
// validateManifest — ksk_segments.v1 shape check
// ---------------------------------------------------------------------------
describe("validateManifest", () => {
	test("a well-formed manifest (pages range + sheets sources) is ok", () => {
		const doc = {
			schema: "ksk_segments.v1",
			segments: [
				{ segment_id: "seg-001", sources: [{ file: "a.pdf", pages: [1, 5], sheets: null }] },
				{ segment_id: "seg-002", sources: [{ file: "b.xls", pages: null, sheets: ["Sheet1"] }] },
			],
		};
		const v = validateManifest(doc);
		expect(v.ok).toBe(true);
		expect(v.detail).toBe("ok");
		expect(v.invalidSegments).toEqual([]);
	});

	test("rejects a schema mismatch", () => {
		const v = validateManifest({ schema: "something_else.v1", segments: [] });
		expect(v.ok).toBe(false);
		expect(v.detail).toContain("schema mismatch");
	});

	test("rejects a missing/empty segments[] array", () => {
		expect(validateManifest({ schema: "ksk_segments.v1" }).ok).toBe(false);
		expect(validateManifest({ schema: "ksk_segments.v1", segments: [] }).ok).toBe(false);
		expect(validateManifest({ schema: "ksk_segments.v1", segments: [] }).detail).toBe("no segments[] array");
	});

	test("flags a segment missing segment_id", () => {
		const doc = {
			schema: "ksk_segments.v1",
			segments: [{ sources: [{ file: "a.pdf", pages: [1, 2] }] }],
		};
		const v = validateManifest(doc);
		expect(v.ok).toBe(false);
		expect(v.invalidSegments).toEqual(["#0"]);
		expect(v.detail).toBe("1 invalid segments");
	});

	test("flags a segment whose source has neither a usable pages range nor sheets", () => {
		const doc = {
			schema: "ksk_segments.v1",
			segments: [
				{ segment_id: "seg-001", sources: [{ file: "a.pdf", pages: null, sheets: null }] },
				{ segment_id: "seg-002", sources: [{ file: "b.pdf", pages: [], sheets: [] }] },
			],
		};
		const v = validateManifest(doc);
		expect(v.ok).toBe(false);
		expect(v.invalidSegments).toEqual(["seg-001", "seg-002"]);
	});

	test("flags a segment with zero sources", () => {
		const doc = { schema: "ksk_segments.v1", segments: [{ segment_id: "seg-001", sources: [] }] };
		expect(validateManifest(doc).invalidSegments).toEqual(["seg-001"]);
	});

	test("a malformed pages tuple (not a 2-int range) is invalid, even alongside a valid sheets source elsewhere", () => {
		const doc = {
			schema: "ksk_segments.v1",
			segments: [
				{ segment_id: "seg-001", sources: [{ file: "a.pdf", pages: [5], sheets: null }] }, // 1-element — bad
				{ segment_id: "seg-002", sources: [{ file: "b.pdf", pages: [3, 1], sheets: null }] }, // end < start — bad
			],
		};
		const v = validateManifest(doc);
		expect(v.invalidSegments).toEqual(["seg-001", "seg-002"]);
	});

	test("a segment with multiple sources is valid as long as at least one carries units", () => {
		const doc = {
			schema: "ksk_segments.v1",
			segments: [
				{
					segment_id: "seg-001",
					sources: [
						{ file: "a.pdf", pages: null, sheets: null }, // unusable
						{ file: "b.pdf", pages: [1, 3], sheets: null }, // usable
					],
				},
			],
		};
		expect(validateManifest(doc).ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// segmentUnitKeys / segmentPartitionKey — segment_id-INDEPENDENT page-set
// identity: expands a [start,end] range to individual page units, sheets to
// one unit per sheet name, and normalizes (sorts) so declaration order and
// segment_id never affect the key.
// ---------------------------------------------------------------------------
describe("segmentUnitKeys / segmentPartitionKey", () => {
	test("expands an inclusive pages range to per-page unit ids", () => {
		const seg = { segment_id: "seg-001", sources: [{ file: "a.pdf", pages: [1, 3], sheets: null }] };
		expect(segmentUnitKeys(seg).sort()).toEqual(["a.pdf#p1", "a.pdf#p2", "a.pdf#p3"]);
	});

	test("expands sheets to one unit per sheet name", () => {
		const seg = { segment_id: "seg-003", sources: [{ file: "x.xls", pages: null, sheets: ["S1", "S2"] }] };
		expect(segmentUnitKeys(seg).sort()).toEqual(["x.xls#sS1", "x.xls#sS2"]);
	});

	test("unions units across multiple sources in one segment", () => {
		const seg = {
			segment_id: "seg-004",
			sources: [
				{ file: "a.pdf", pages: [1, 2], sheets: null },
				{ file: "b.xls", pages: null, sheets: ["Sheet1"] },
			],
		};
		expect(segmentUnitKeys(seg).sort()).toEqual(["a.pdf#p1", "a.pdf#p2", "b.xls#sSheet1"]);
	});

	test("ignores sub_ranges — they are provisional dispatch splits, not boundaries", () => {
		const seg = {
			segment_id: "seg-005",
			sources: [{ file: "a.pdf", pages: [1, 30], sheets: null }],
			sub_ranges: [{ pages: [1, 15] }, { pages: [16, 30] }],
		};
		expect(segmentUnitKeys(seg)).toHaveLength(30);
	});

	test("the partition key is IDENTICAL for the same page-set under two different segment_ids", () => {
		const segA = { segment_id: "seg-alpha", sources: [{ file: "a.pdf", pages: [1, 3], sheets: null }] };
		const segB = { segment_id: "seg-zzz-99", sources: [{ file: "a.pdf", pages: [1, 3], sheets: null }] };
		expect(segmentPartitionKey(segA)).toBe(segmentPartitionKey(segB));
	});

	test("the partition key is order-independent across multiple sources", () => {
		const segA = {
			segment_id: "s1",
			sources: [
				{ file: "a.pdf", pages: [1, 2], sheets: null },
				{ file: "b.pdf", pages: [1, 1], sheets: null },
			],
		};
		const segB = {
			segment_id: "s2",
			sources: [
				{ file: "b.pdf", pages: [1, 1], sheets: null },
				{ file: "a.pdf", pages: [1, 2], sheets: null },
			],
		};
		expect(segmentPartitionKey(segA)).toBe(segmentPartitionKey(segB));
	});

	test("a different page-set produces a different key", () => {
		const segA = { segment_id: "s1", sources: [{ file: "a.pdf", pages: [1, 3], sheets: null }] };
		const segB = { segment_id: "s1", sources: [{ file: "a.pdf", pages: [1, 4], sheets: null }] };
		expect(segmentPartitionKey(segA)).not.toBe(segmentPartitionKey(segB));
	});
});

describe("manifestPartitionKeys", () => {
	test("skips segments with an empty unit-set (already flagged invalid) so they can't falsely collide", () => {
		const doc = {
			schema: "ksk_segments.v1",
			segments: [
				{ segment_id: "seg-001", sources: [{ file: "a.pdf", pages: [1, 2], sheets: null }] },
				{ segment_id: "seg-002", sources: [{ file: "b.pdf", pages: null, sheets: null }] }, // empty
			],
		};
		expect(manifestPartitionKeys(doc)).toEqual(["a.pdf#p1|a.pdf#p2"]);
	});
});

// ---------------------------------------------------------------------------
// partitionAgreement — the cross-session comparator on FABRICATED page-sets
// ---------------------------------------------------------------------------
describe("partitionAgreement", () => {
	test("identical partitions across sessions, under different arbitrary segment_ids, agree 100%", () => {
		// session 1 groups pages differently-labeled than session 2, but the same
		// underlying page-sets — segment_id must not matter.
		const s1 = [
			segmentPartitionKey({ segment_id: "seg-001", sources: [{ file: "a.pdf", pages: [1, 5] }] }),
			segmentPartitionKey({ segment_id: "seg-002", sources: [{ file: "b.pdf", pages: [1, 2] }] }),
		];
		const s2 = [
			segmentPartitionKey({ segment_id: "seg-A", sources: [{ file: "b.pdf", pages: [1, 2] }] }),
			segmentPartitionKey({ segment_id: "seg-B", sources: [{ file: "a.pdf", pages: [1, 5] }] }),
		];
		const result = partitionAgreement([s1, s2]);
		expect(result.equal).toBe(true);
		expect(result.agreement).toBe("2/2 (100.0%)");
		expect(result.droppedKeys).toEqual([]);
	});

	test("a session that splits one segment into two disagrees with a session that kept it whole", () => {
		const whole = [segmentPartitionKey({ segment_id: "seg-001", sources: [{ file: "a.pdf", pages: [1, 30] }] })];
		const split = [
			segmentPartitionKey({ segment_id: "seg-001a", sources: [{ file: "a.pdf", pages: [1, 15] }] }),
			segmentPartitionKey({ segment_id: "seg-001b", sources: [{ file: "a.pdf", pages: [16, 30] }] }),
		];
		const result = partitionAgreement([whole, split]);
		expect(result.equal).toBe(false);
		// none of the 3 distinct cells (1 whole + 2 halves) is reproduced in BOTH sessions
		expect(result.keysInAll).toEqual([]);
		expect(result.allKeys).toHaveLength(3);
		expect(result.agreement).toBe("0/3 (0.0%)");
	});

	test("a partially-overlapping set of sessions reports the shared cells and the dropped ones", () => {
		const commonPage = segmentPartitionKey({ segment_id: "x", sources: [{ file: "a.pdf", pages: [1, 1] }] });
		const onlyS1 = segmentPartitionKey({ segment_id: "x", sources: [{ file: "b.pdf", pages: [1, 1] }] });
		const onlyS2 = segmentPartitionKey({ segment_id: "x", sources: [{ file: "c.pdf", pages: [1, 1] }] });
		const result = partitionAgreement([
			[commonPage, onlyS1],
			[commonPage, onlyS2],
		]);
		expect(result.keysInAll).toEqual([commonPage]);
		expect(result.droppedKeys.sort()).toEqual([onlyS1, onlyS2].sort());
		expect(result.equal).toBe(false);
	});

	test("a session that failed to parse contributes an empty set, correctly dragging agreement down", () => {
		const good = [segmentPartitionKey({ segment_id: "x", sources: [{ file: "a.pdf", pages: [1, 1] }] })];
		const failed: string[] = []; // manifest missing/unparsable — no partition contributed
		const result = partitionAgreement([good, failed]);
		expect(result.equal).toBe(false);
		expect(result.keysInAll).toEqual([]);
		expect(result.agreement).toBe("0/1 (0.0%)");
	});

	test("no sessions produced any valid segment → agreement is n/a, not a divide-by-zero artifact", () => {
		const result = partitionAgreement([[], []]);
		expect(result.allKeys).toEqual([]);
		expect(result.agreement).toBe("n/a");
		expect(result.equal).toBe(false);
	});

	test("a single session trivially agrees with itself", () => {
		const only = [segmentPartitionKey({ segment_id: "x", sources: [{ file: "a.pdf", pages: [1, 2] }] })];
		const result = partitionAgreement([only]);
		expect(result.equal).toBe(true);
		expect(result.agreement).toBe("1/1 (100.0%)");
	});
});

// ---------------------------------------------------------------------------
// totalInventoryUnits — pdf page_count, spreadsheet sheets, other/whole-file
// ---------------------------------------------------------------------------
describe("totalInventoryUnits", () => {
	test("sums pdf page_count, one unit per sheet, and one unit per other file", () => {
		const inv = {
			files: [
				{ path: "a.pdf", kind: "pdf", page_count: 5, sheets: null },
				{ path: "b.xls", kind: "spreadsheet", page_count: 1, sheets: ["S1", "S2"] },
				{ path: "c.jpg", kind: "image", page_count: 1, sheets: null },
			],
		};
		// 5 (pdf pages) + 2 (sheets) + 1 (whole-file image) = 8
		expect(totalInventoryUnits(inv)).toBe(8);
	});

	test("empty/missing files[] is zero units", () => {
		expect(totalInventoryUnits({})).toBe(0);
		expect(totalInventoryUnits({ files: [] })).toBe(0);
	});
});
