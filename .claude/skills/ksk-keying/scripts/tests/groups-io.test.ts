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
