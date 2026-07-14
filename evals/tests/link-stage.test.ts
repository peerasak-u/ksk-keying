// Unit tests for link-stage.ts's PURE grading logic: shape validation,
// bookable→interpretation traceability, dropped-pairs parsing, and
// cross-session cluster-agreement multiset math. All inputs are fabricated
// in-memory or written to a scratch tmpdir — no live run, no gitignored
// samples/ data, no group-skeleton invocation (that gate is
// integration-tested against a real run elsewhere).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { normalizeLinks } from "../specs/sherlock";
import {
	buildSegmentDocIndex,
	crossSessionClusterAgreement,
	docIndexFromInterpretations,
	extractDroppedPairs,
	toClusterMultiset,
	untracedBookables,
	validateShape,
	type SegDocIndex,
} from "../specs/link-stage";

const scratch = mkdtempSync(join(tmpdir(), "ksk-link-stage-grade-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// validateShape
// ---------------------------------------------------------------------------

describe("validateShape", () => {
	test("valid doc: every transaction has ≥1 member and an array bookable_docs", () => {
		const doc = {
			transactions: [
				{ transaction_id: "txn-001", members: [{ segment: "seg-001", document_no: null }], bookable_docs: [] },
				{
					transaction_id: "txn-002",
					members: [{ segment: "seg-002", document_no: "INV-1" }],
					bookable_docs: ["INV-1"],
				},
			],
		};
		const shape = validateShape(doc);
		expect(shape.ok).toBe(true);
		expect(shape.transactionCount).toBe(2);
		expect(shape.emptyMemberTxns).toEqual([]);
		expect(shape.detail).toBe("ok");
	});

	test("missing/non-array transactions[] fails with a clear detail", () => {
		expect(validateShape({}).ok).toBe(false);
		expect(validateShape({ transactions: "nope" }).ok).toBe(false);
		expect(validateShape(null).detail).toContain("missing/malformed transactions[]");
	});

	test("a transaction with 0 members is flagged by id (or #index when unnamed)", () => {
		const doc = {
			transactions: [
				{ transaction_id: "txn-empty", members: [], bookable_docs: [] },
				{ members: [], bookable_docs: [] }, // no transaction_id at all
			],
		};
		const shape = validateShape(doc);
		expect(shape.ok).toBe(false);
		expect(shape.emptyMemberTxns).toEqual(["txn-empty", "#1"]);
		expect(shape.detail).toContain("2 txn(s) with 0 members");
	});

	test("bookable_docs not an array is flagged separately from empty-members", () => {
		const doc = {
			transactions: [{ transaction_id: "txn-x", members: [{ segment: "seg-001" }], bookable_docs: null }],
		};
		const shape = validateShape(doc);
		expect(shape.ok).toBe(false);
		expect(shape.malformedBookable).toEqual(["txn-x"]);
		expect(shape.detail).toContain("1 txn(s) missing bookable_docs[]");
	});
});

// ---------------------------------------------------------------------------
// docIndexFromInterpretations / untracedBookables
// ---------------------------------------------------------------------------

function interp(docs: Array<{ document_no: string | null; source_page?: number }>) {
	return {
		schema: "ksk_segment_interpretation.v1",
		documents: docs.map((d, i) => ({
			source_page: d.source_page ?? i + 1,
			doc_kind: "invoice",
			accounting_facts: { document_no: d.document_no, gross_total: 100 },
			line_items: [{ description: "x", amount: 100 }],
		})),
	};
}

describe("docIndexFromInterpretations", () => {
	test("indexes normalized document_no per segment and flags blank-doc-no segments", () => {
		const bySeg = new Map<string, unknown[]>([
			["seg-001", [interp([{ document_no: "INV-001" }, { document_no: null }])]],
			["seg-002", [interp([{ document_no: "INV-002" }])]],
		]);
		const idx = docIndexFromInterpretations(bySeg);
		expect(idx.get("seg-001")!.docNos.has("inv-001")).toBe(true);
		expect(idx.get("seg-001")!.hasBlankDocNo).toBe(true);
		expect(idx.get("seg-002")!.docNos.has("inv-002")).toBe(true);
		expect(idx.get("seg-002")!.hasBlankDocNo).toBe(false);
	});
});

describe("buildSegmentDocIndex (disk I/O wrapper)", () => {
	test("reads real interpretation*.json files off a fabricated client clone", () => {
		const client = join(scratch, "client-a");
		const segDir = join(client, "ข้อมูลระบบ", "_segments", "seg-001");
		mkdirSync(segDir, { recursive: true });
		writeFileSync(join(segDir, "interpretation.json"), JSON.stringify(interp([{ document_no: "AB-9" }])));
		const idx = buildSegmentDocIndex(client, ["seg-001", "seg-missing"]);
		expect(idx.get("seg-001")!.docNos.has("ab-9")).toBe(true);
		expect(idx.get("seg-missing")).toEqual({ docNos: new Set(), hasBlankDocNo: false });
	});
});

describe("untracedBookables", () => {
	const segIndex = new Map<string, SegDocIndex>([
		["seg-001", { docNos: new Set(["inv-001"]), hasBlankDocNo: false }],
		["seg-002", { docNos: new Set(), hasBlankDocNo: true }], // has a real no-doc-no document
	]);

	test("a bookable_doc matching a real document_no (case/whitespace-insensitive) traces cleanly", () => {
		const txn = {
			transaction_id: "txn-001",
			segments: ["seg-001"],
			members: [{ segment: "seg-001", document_no: "INV-001" }],
			bookable_docs: [" inv-001 "],
		};
		expect(untracedBookables(txn, segIndex)).toEqual([]);
	});

	test("a bookable_doc naming no real document is untraced", () => {
		const txn = {
			transaction_id: "txn-002",
			segments: ["seg-001"],
			members: [{ segment: "seg-001", document_no: "GHOST-1" }],
			bookable_docs: ["GHOST-1"],
		};
		expect(untracedBookables(txn, segIndex)).toEqual(["GHOST-1"]);
	});

	test("a NODOC-* placeholder traces when the txn has a null-document_no member in a blank-doc-no segment", () => {
		const txn = {
			transaction_id: "txn-003",
			segments: ["seg-002"],
			members: [{ segment: "seg-002", document_no: null }],
			bookable_docs: ["NODOC-seg002-p3-2026-04-01-800.00"],
		};
		expect(untracedBookables(txn, segIndex)).toEqual([]);
	});

	test("a NODOC-* placeholder is untraced when no member actually has a null document_no", () => {
		const txn = {
			transaction_id: "txn-004",
			segments: ["seg-002"],
			members: [{ segment: "seg-002", document_no: "SOMETHING" }],
			bookable_docs: ["NODOC-seg002-p3-2026-04-01-800.00"],
		};
		expect(untracedBookables(txn, segIndex)).toEqual(["NODOC-seg002-p3-2026-04-01-800.00"]);
	});

	test("blank bookable_docs entries are skipped, not reported as untraced", () => {
		const txn = { transaction_id: "txn-005", segments: ["seg-001"], members: [], bookable_docs: ["", null] };
		expect(untracedBookables(txn, segIndex)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// extractDroppedPairs — parses group-skeleton's completeness-gate error text
// (groups-lib.ts's findDroppedBookableUnits / planGroups)
// ---------------------------------------------------------------------------

describe("extractDroppedPairs", () => {
	test("parses the real group-skeleton error message shape", () => {
		const out =
			`bookable documents dropped between Stage-2 and grouping (segment_id / document_no): ` +
			`seg-004 / 12345; seg-005 / 67890 — links.yaml/clustering lost these. Re-run Stage 3 linking or inspect links.yaml; not auto-recovered.\n`;
		expect(extractDroppedPairs(out)).toEqual(["seg-004 / 12345", "seg-005 / 67890"]);
	});

	test("a single dropped pair", () => {
		const out =
			`bookable documents dropped between Stage-2 and grouping (segment_id / document_no): seg-006 / 46 — links.yaml/clustering lost these.`;
		expect(extractDroppedPairs(out)).toEqual(["seg-006 / 46"]);
	});

	test("an unrelated usage error (no dropped-pairs marker) yields an empty list, not a crash", () => {
		expect(extractDroppedPairs("not a client directory: /nope\n")).toEqual([]);
		expect(extractDroppedPairs("")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// crossSessionClusterAgreement / toClusterMultiset — built on real
// normalizeLinks output from fabricated links.yaml files (same "write to a
// scratch dir, drive the real parser" pattern as lestrade.test.ts).
// ---------------------------------------------------------------------------

function writeLinks(name: string, transactions: unknown[]): string {
	const path = join(scratch, `${name}.yaml`);
	writeFileSync(path, yamlStringify({ transactions }));
	return path;
}

describe("toClusterMultiset", () => {
	test("counts duplicate (member-set + bookable_docs) clusters instead of collapsing them", () => {
		const path = writeLinks("dup-clusters", [
			{ transaction_id: "txn-a", members: [{ segment: "seg-006", document_no: "46" }], bookable_docs: ["46"] },
			{ transaction_id: "txn-b", members: [{ segment: "seg-006", document_no: "46" }], bookable_docs: ["46"] },
		]);
		const clusters = normalizeLinks(path);
		const ms = toClusterMultiset(clusters);
		expect(ms.size).toBe(1);
		expect([...ms.values()][0].count).toBe(2);
	});
});

describe("crossSessionClusterAgreement", () => {
	test("identical clusters in every session score 100% agreement", () => {
		const a = writeLinks("agree-a", [
			{ transaction_id: "t1", members: [{ segment: "seg-001", document_no: "X1" }], bookable_docs: ["X1"] },
			{ transaction_id: "t2", members: [{ segment: "seg-002", document_no: "X2" }], bookable_docs: ["X2"] },
		]);
		const b = writeLinks("agree-b", [
			{ transaction_id: "t1", members: [{ segment: "seg-001", document_no: "X1" }], bookable_docs: ["X1"] },
			{ transaction_id: "t2", members: [{ segment: "seg-002", document_no: "X2" }], bookable_docs: ["X2"] },
		]);
		const result = crossSessionClusterAgreement([normalizeLinks(a), normalizeLinks(b)]);
		expect(result).toEqual({
			agreement: "2/2 (100.0%)",
			identical: 2,
			total: 2,
			multi: { agreement: "n/a", identical: 0, total: 0 },
		});
	});

	test("a merge in one session vs a split in another scores partial agreement", () => {
		// session 1: two documents fused into one multi-member cluster
		const s1 = writeLinks("split-merge-1", [
			{
				transaction_id: "t1",
				members: [
					{ segment: "seg-005", document_no: "INV-A" },
					{ segment: "seg-005", document_no: "INV-B" },
				],
				bookable_docs: ["INV-A", "INV-B"],
			},
		]);
		// session 2: kept as two standalone clusters
		const s2 = writeLinks("split-merge-2", [
			{ transaction_id: "t1", members: [{ segment: "seg-005", document_no: "INV-A" }], bookable_docs: ["INV-A"] },
			{ transaction_id: "t2", members: [{ segment: "seg-005", document_no: "INV-B" }], bookable_docs: ["INV-B"] },
		]);
		const result = crossSessionClusterAgreement([normalizeLinks(s1), normalizeLinks(s2)]);
		// 3 distinct cluster-instances total across the two sessions, 0 reproduced
		// identically in BOTH (the multi-member cluster only exists in s1; the two
		// standalone clusters only exist in s2).
		expect(result.identical).toBe(0);
		expect(result.total).toBe(3);
		expect(result.agreement).toBe("0/3 (0.0%)");
		// the multi-member cluster (INV-A + INV-B) is the multi-doc submetric
		expect(result.multi.total).toBe(1);
		expect(result.multi.identical).toBe(0);
	});

	test("bookable_docs mismatch on an otherwise-identical member-set breaks agreement", () => {
		// same members, but session 2 booked only one of the two documents —
		// downstream (group-skeleton) this would also trip the completeness gate,
		// but the cluster-agreement metric should independently catch it too.
		const s1 = writeLinks("bookable-mismatch-1", [
			{
				transaction_id: "t1",
				members: [
					{ segment: "seg-005", document_no: "CN-1" },
					{ segment: "seg-005", document_no: "TF-1" },
				],
				bookable_docs: ["CN-1", "TF-1"],
			},
		]);
		const s2 = writeLinks("bookable-mismatch-2", [
			{
				transaction_id: "t1",
				members: [
					{ segment: "seg-005", document_no: "CN-1" },
					{ segment: "seg-005", document_no: "TF-1" },
				],
				bookable_docs: ["TF-1"],
			},
		]);
		const result = crossSessionClusterAgreement([normalizeLinks(s1), normalizeLinks(s2)]);
		expect(result.identical).toBe(0);
		expect(result.total).toBe(2); // two distinct extended-keys (different bookable_docs)
	});

	test("empty input (e.g. a session whose links.yaml failed to load) never divides by zero", () => {
		const result = crossSessionClusterAgreement([[], []]);
		expect(result).toEqual({
			agreement: "n/a",
			identical: 0,
			total: 0,
			multi: { agreement: "n/a", identical: 0, total: 0 },
		});
	});
});
