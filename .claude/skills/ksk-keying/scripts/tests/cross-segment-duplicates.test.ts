import { describe, expect, test } from "bun:test";
import { computeCrossSegmentDuplicateCandidates } from "../cross-segment-duplicates";
import type { InterpFile, Interpretation } from "../groups-lib";

function bundledFile(
	segmentId: string,
	path: string,
	docs: Record<string, unknown>[],
): InterpFile {
	return {
		path,
		segmentId,
		json: { documents: docs } as Interpretation,
	};
}

describe("computeCrossSegmentDuplicateCandidates", () => {
	test("flags the same document_no in two different segments when the date also agrees", () => {
		const segA = bundledFile("seg-003", "ข้อมูลระบบ/_segments/seg-003/interpretation.json", [
			{
				source_file: "บิลซื้อ.pdf",
				source_page: 5,
				accounting_facts: { document_no: "JTI69050020", document_date: "2026-05-22", gross_total: 1234.56 },
			},
		]);
		const segB = bundledFile("seg-011", "ข้อมูลระบบ/_segments/seg-011/interpretation.json", [
			{
				source_file: "บิลซื้อ.pdf",
				source_page: 47,
				accounting_facts: { document_no: "JTI69050020", document_date: "2026-05-22", gross_total: 1234.56 },
			},
		]);
		const candidates = computeCrossSegmentDuplicateCandidates([segA, segB]);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].document_no).toBe("JTI69050020");
		expect(candidates[0].members.map((m) => m.segment).sort()).toEqual(["seg-003", "seg-011"]);
	});

	test("does NOT flag the same document_no across segments when nothing else corroborates it", () => {
		// handwritten receipt books commonly reuse small numbers across
		// unrelated documents (real regression in prelink.ts's own history) —
		// a bare document_no collision with no agreeing date/amount/tax id is
		// too weak evidence to hide a page from the books.
		const segA = bundledFile("seg-001", "ข้อมูลระบบ/_segments/seg-001/interpretation.json", [
			{
				source_file: "a.pdf",
				source_page: 1,
				accounting_facts: {
					document_no: "46",
					document_date: "2026-05-01",
					gross_total: 1400,
					seller_tax_id: "1111111111111",
				},
			},
		]);
		const segB = bundledFile("seg-002", "ข้อมูลระบบ/_segments/seg-002/interpretation.json", [
			{
				source_file: "b.pdf",
				source_page: 1,
				accounting_facts: {
					document_no: "46",
					document_date: "2026-06-15",
					gross_total: 45,
					seller_tax_id: "2222222222222",
				},
			},
		]);
		expect(computeCrossSegmentDuplicateCandidates([segA, segB])).toHaveLength(0);
	});

	test("does not flag one document split across two dispatch windows of the SAME segment", () => {
		const windowA = bundledFile("seg-012", "ข้อมูลระบบ/_segments/seg-012/interpretation-p1-15.json", [
			{
				source_file: "a.pdf",
				source_page: 7,
				accounting_facts: { document_no: "INV-7", document_date: "2026-05-01", gross_total: 100 },
			},
		]);
		const windowB = bundledFile("seg-012", "ข้อมูลระบบ/_segments/seg-012/interpretation-p16-30.json", [
			{
				source_file: "a.pdf",
				source_page: 7,
				accounting_facts: { document_no: "INV-7", document_date: "2026-05-01", gross_total: 100 },
			},
		]);
		expect(computeCrossSegmentDuplicateCandidates([windowA, windowB])).toHaveLength(0);
	});

	test("resolves source_file/source_page for a Shape-A (single-document, no nested facts) file", () => {
		const segA: InterpFile = {
			path: "ข้อมูลระบบ/_segments/seg-001/interpretation.json",
			segmentId: "seg-001",
			json: {
				documents: [{ source_file: "a.pdf", source_page: 5, doc_kind: "normal_bill_or_invoice" }],
				accounting_facts: { document_no: "INV-9", document_date: "2026-05-01", gross_total: 500 },
			} as Interpretation,
		};
		const segB: InterpFile = {
			path: "ข้อมูลระบบ/_segments/seg-002/interpretation.json",
			segmentId: "seg-002",
			json: {
				documents: [{ source_file: "a.pdf", source_page: 41, doc_kind: "normal_bill_or_invoice" }],
				accounting_facts: { document_no: "INV-9", document_date: "2026-05-01", gross_total: 500 },
			} as Interpretation,
		};
		const [candidate] = computeCrossSegmentDuplicateCandidates([segA, segB]);
		expect(candidate.members.map((m) => m.source_page).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([5, 41]);
		expect(candidate.members.every((m) => m.source_file === "a.pdf")).toBe(true);
	});
});
