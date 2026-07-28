import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLinks } from "../groups-io";

const tmps: string[] = [];
function clientWithLinks(yaml: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ksk-links-"));
	tmps.push(dir);
	const dgDir = join(dir, "ข้อมูลระบบ", "_doc_groups");
	mkdirSync(dgDir, { recursive: true });
	writeFileSync(join(dgDir, "links.yaml"), yaml);
	return dir;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// Regression: a Stage-3 child that writes a numeric-looking document_no UNQUOTED
// in links.yaml must not lose precision or a leading zero at parse time — else
// planGroups's `typeof === "string"` filter silently drops the whole document
// (real bug on run full-345/20260713-1819b: 036808260410000014, 065091238867).
describe("loadLinks — unquoted numeric document_no keeps its exact string form", () => {
	test("an 18-digit unquoted document_no stays an exact string (no float precision loss)", () => {
		const dir = clientWithLinks(`transactions:
  - transaction_id: t1
    bookable_docs:
      - 036808260410000014
    members:
      - {segment: seg-005, document_no: 036808260410000014, role: primary_document}
`);
		const c = loadLinks(dir)!.clusters[0];
		expect(c.bookable_docs).toEqual(["036808260410000014"]);
		expect(c.members![0].document_no).toBe("036808260410000014");
	});

	test("a leading-zero unquoted document_no keeps its leading zero and stays a string", () => {
		const dir = clientWithLinks(`transactions:
  - transaction_id: t2
    bookable_docs:
      - 065091238867
`);
		const c = loadLinks(dir)!.clusters[0];
		expect(c.bookable_docs).toEqual(["065091238867"]);
		expect(typeof c.bookable_docs![0]).toBe("string");
	});

	test("null and quoted document numbers are unaffected by the string-scalar parse", () => {
		const dir = clientWithLinks(`transactions:
  - transaction_id: t3
    bookable_docs:
      - "46"
      - "100297"
    members:
      - {segment: seg-006, document_no: null, role: primary_document}
`);
		const c = loadLinks(dir)!.clusters[0];
		expect(c.bookable_docs).toEqual(["46", "100297"]);
		expect(c.members![0].document_no).toBeNull();
	});
});

// Regression (2026-07-28 validation of the evidence-page-claim fix): the very
// string-scalar parse tested above also turns a member's `source_page: 62` /
// `unit_ordinal: 3` into the STRINGS "62"/"3". evidenceUnitsOf's original
// `typeof === "number"` test therefore nulled the page of EVERY unit in every
// real run — proved against samples/_incidents/345-04-69: all 218 manifest
// evidence_units came out `source_page: null`, `unit_key: "<file>#d1"`, so the
// three page-77 payment slips were indistinguishable again, withEvidenceClaims
// added nothing, and the reciprocal preflight check silently verified nothing.
// Every existing unit test built LinkMember objects in TypeScript with numeric
// pages, so none of them could see it. This test goes through links.yaml on
// disk, the way a real run does.
describe("loadLinks + evidenceUnitsOf — unit identity survives the string-scalar parse", () => {
	test("unquoted source_page/unit_ordinal still resolve to a page and a distinct unit_key", async () => {
		const { evidenceUnitsOf } = await import("../groups-lib");
		const dir = clientWithLinks(`transactions:
  - transaction_id: txn-173
    bookable_docs: [null]
    members:
      - {segment: seg-012, document_no: null, role: primary_invoice,
         source_file: "PSL.pdf", source_page: 77, source_sheet: null, unit_ordinal: 1}
      - {segment: seg-012, document_no: null, role: primary_invoice,
         source_file: "PSL.pdf", source_page: 77, source_sheet: null, unit_ordinal: 2}
      - {segment: seg-012, document_no: null, role: primary_invoice,
         source_file: "PSL.pdf", source_page: 77, source_sheet: null, unit_ordinal: 3}
`);
		const { units, missing } = evidenceUnitsOf(loadLinks(dir)!.clusters[0]);
		expect(missing).toBe(0);
		expect(units.map((u) => u.source_page)).toEqual([77, 77, 77]);
		expect(units.map((u) => u.unit_key)).toEqual([
			"PSL.pdf#p77#d1",
			"PSL.pdf#p77#d2",
			"PSL.pdf#p77#d3",
		]);
	});
});
