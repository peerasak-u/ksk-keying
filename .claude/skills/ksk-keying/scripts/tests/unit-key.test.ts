import { describe, expect, test } from "bun:test";
import { documentUnitId, parseDocumentUnitId } from "../unit-key";

describe("documentUnitId", () => {
	test("names a document by file + page + ordinal, distinct from a bare page unit", () => {
		const a = documentUnitId("เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf", 77, null, 1);
		const b = documentUnitId("เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf", 77, null, 2);
		// real client-345 shape: three physically distinct documents on one
		// scanned page must resolve to three DIFFERENT keys, even though
		// document_no is null on all three and the page unit id is identical
		expect(a).not.toBe(b);
		expect(a).toBe("เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf#p77#d1");
	});

	test("round-trips through parseDocumentUnitId", () => {
		const id = documentUnitId("a/b.pdf", 12, null, 3);
		expect(parseDocumentUnitId(id)).toEqual({ file: "a/b.pdf", page: 12, sheet: null, ordinal: 3 });
	});

	test("parseDocumentUnitId on a plain (non-document) unit id returns ordinal: null", () => {
		expect(parseDocumentUnitId("a/b.pdf#p12")).toEqual({ file: "a/b.pdf", page: 12, sheet: null, ordinal: null });
	});

	test("sheet-based unit still gets an ordinal suffix", () => {
		expect(documentUnitId("book.xlsx", null, "Sheet1", 2)).toBe("book.xlsx#sSheet1#d2");
	});
});
