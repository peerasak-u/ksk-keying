import { describe, expect, test } from "bun:test";
import {
	containsExportDir,
	isAnswerKeyPath,
	isExportDir,
	isExportFile,
} from "../export-dir";

// Every one of these is a real folder name observed in the (พร้อมทดสอบ)_*
// client folders. The predicate replaced an exact-match set holding only
// "เตรียมไฟล์นำเข้า", which let the other four through — and a missed export
// dir means the answer key gets copied into the sample client folder.
describe("isExportDir — real client spellings", () => {
	const exportDirs = [
		"File PEAK import",
		"File Peak Import",
		"เตรียมไฟล์นำเข้า",
		"STM ไฟล์นำเข้า",
		"ไฟล์นำเข้า Peak",
	];
	for (const name of exportDirs) {
		test(`matches ${name}`, () => {
			expect(isExportDir(name)).toBe(true);
		});
	}

	// Same list, drawn from the same census — none of these may be excluded,
	// or the run loses real source documents.
	const sourceDirs = [
		"STM",
		"Statement",
		"รายได้",
		"รายได้ vat",
		"ค่าใช้จ่าย",
		"ค่าใช้จ่าย Non vat",
		"ค่าใช้จ่ายภงด.53 และ vat",
		"เอกสารรายได้",
		"เอกสารค่าใช้จ่าย",
		"เอกสารเงินกู้",
		"เอกสาร Non vat",
		"ดอกเบี้ยเงินกู้",
		"ตรวจทาน",
		"ภาษีขาย",
		"ภาษีซื้อ 69-03",
	];
	for (const name of sourceDirs) {
		test(`does not match source folder ${name}`, () => {
			expect(isExportDir(name)).toBe(false);
		});
	}
});

describe("isExportDir — boundaries", () => {
	// "นำเข้า" alone means imported goods. Excluding this would drop real
	// documents from the run, which is the worse of the two failures.
	test("bare นำเข้า is a source folder, not an export folder", () => {
		expect(isExportDir("เอกสารนำเข้า")).toBe(false);
		expect(isExportDir("สินค้านำเข้า")).toBe(false);
	});

	test("english pair matches in either order and any case", () => {
		expect(isExportDir("PEAK IMPORT")).toBe(true);
		expect(isExportDir("import peak")).toBe(true);
		expect(isExportDir("Peak  Import  Files")).toBe(true);
	});

	test("one english word alone is not enough", () => {
		expect(isExportDir("Peak season")).toBe(false);
		expect(isExportDir("Import docs")).toBe(false);
	});

	test("whitespace variants normalize", () => {
		expect(isExportDir("  File   PEAK   import  ")).toBe(true);
	});
});

describe("containsExportDir", () => {
	// The workbooks live under subfolders of the export dir, so a check that
	// only looked at the leaf segment would wave them through.
	test("taints every path below an export dir", () => {
		expect(containsExportDir("03-69/File Peak Import/รายได้/a.xlsx")).toBe(true);
		expect(containsExportDir("04-69/เตรียมไฟล์นำเข้า/b.xlsx")).toBe(true);
	});

	test("leaves clean paths alone", () => {
		expect(containsExportDir("03-69/เอกสารรายได้/inv.pdf")).toBe(false);
		expect(containsExportDir("")).toBe(false);
	});

	test("tolerates leading and doubled separators", () => {
		expect(containsExportDir("//03-69//File PEAK import//x.xlsx")).toBe(true);
	});
});

// Client 218 keeps these two loose inside statement/, next to the bank
// statement PDF they were produced from — no export folder anywhere in the
// path. A folder-only rule copies them into the sample as source material.
describe("isExportFile", () => {
	const keyWorkbooks = [
		"PEAK_ImportJournal ฝาก 01-04.xlsx",
		"PEAK_ImportJournal ถอน 01-04.xlsx",
		"PEAK_ImportExpense vat.xlsx",
		"PEAK_ImportReceipt ขาย - Amazon 02.xlsx",
		"peak_importexpense.xls",
	];
	for (const name of keyWorkbooks) {
		test(`matches ${name}`, () => {
			expect(isExportFile(name)).toBe(true);
		});
	}

	// A scan is a real document no matter what it is called — excluding one
	// removes evidence the run needs.
	test("only the Excel family qualifies", () => {
		expect(isExportFile("PEAK_ImportJournal 01-04.pdf")).toBe(false);
		expect(isExportFile("peak import.png")).toBe(false);
	});

	// 281 names an export in Thai with no "PEAK" anywhere.
	test("matches the Thai import-file compound in a filename", () => {
		expect(
			isExportFile("ไฟล์นำเข้า รายรับ หจก.รุ่งเรืองก่อสร้าง03-69.xlsx"),
		).toBe(true);
	});

	test("ordinary client workbooks are untouched", () => {
		expect(isExportFile("ผังบัญชี.xlsx")).toBe(false);
		expect(isExportFile("ผังบัญชี รุ่งเรืองก่อสร้าง.xlsx")).toBe(false);
		expect(isExportFile("รายงานภาษีซื้อ 69-03.xlsx")).toBe(false);
		expect(isExportFile("บจก.เจบีคลูเทค.xlsx")).toBe(false);
	});

	test("the extension itself cannot supply the match", () => {
		// guards against matching on the full name where a hypothetical
		// ".import" or vendor extension would leak in
		expect(isExportFile("peak.xlsx")).toBe(false);
		expect(isExportFile("import.xlsx")).toBe(false);
	});
});

describe("isAnswerKeyPath", () => {
	test("catches both the folder case and the loose-workbook case", () => {
		expect(isAnswerKeyPath("03-69/File Peak Import/รายได้/a.xlsx")).toBe(true);
		expect(isAnswerKeyPath("statement/PEAK_ImportJournal ฝาก 01-04.xlsx")).toBe(
			true,
		);
	});

	test("leaves real source documents alone", () => {
		expect(isAnswerKeyPath("statement/01-04.pdf")).toBe(false);
		expect(isAnswerKeyPath("02-69/ขาย.pdf")).toBe(false);
		expect(isAnswerKeyPath("ผังบัญชี.xlsx")).toBe(false);
	});

	// 281 names its bank-statement folder "STM ไฟล์นำเข้า" and keeps the source
	// statement PDFs inside it. Excluding the folder wholesale would delete the
	// documents the run has to read — the failure that loses evidence.
	test("a PDF inside an export-named folder is still source material", () => {
		expect(isAnswerKeyPath("69-03/STM ไฟล์นำเข้า/69-03.pdf")).toBe(false);
		expect(isAnswerKeyPath("69-03/STM ไฟล์นำเข้า/69-03 อรัญญา.pdf")).toBe(false);
	});

	test("the workbooks in that same folder are still caught", () => {
		expect(
			isAnswerKeyPath("69-03/STM ไฟล์นำเข้า/ธ.กสิกรไทย 03-69/PEAK_ImportJournal จ่าย.xlsx"),
		).toBe(true);
	});

	// 281 again: an export filed under a source folder, named in Thai only.
	test("catches a Thai-named export sitting in a source folder", () => {
		expect(
			isAnswerKeyPath("69-03/รายได้/ไฟล์นำเข้า รายรับ หจก.รุ่งเรืองก่อสร้าง03-69.xlsx"),
		).toBe(true);
		expect(isAnswerKeyPath("69-03/รายได้/ใบสำคัญรับ.pdf")).toBe(false);
	});

	// The case names cannot reach: 339's byte-identical copies. Documented here
	// so the gap is a known one covered by the copier's content pass, not a
	// silent hole.
	test("an export copy with an innocent name is NOT caught by name alone", () => {
		expect(isAnswerKeyPath("03-69/รายได้/รายได้.xlsx")).toBe(false);
		expect(isAnswerKeyPath("03-69/STM/03-69 ถอน.xlsx")).toBe(false);
	});
});
