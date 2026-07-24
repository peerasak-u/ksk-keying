import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coaKey, coaLabel, loadCoaRows, parseCoaCsv, splitCoaKey, type CoaRow } from "./coa";

describe("parseCoaCsv", () => {
	test("parses a well-formed CSV into rows", () => {
		const text = "account_code,sub_code,name_th,name_en\n111301,,เงินสด,Cash\n520211,001,ค่าที่ปรึกษา,Consulting";
		expect(parseCoaCsv(text)).toEqual([
			{ account_code: "111301", sub_code: "", name_th: "เงินสด", name_en: "Cash" },
			{ account_code: "520211", sub_code: "001", name_th: "ค่าที่ปรึกษา", name_en: "Consulting" },
		]);
	});

	test("handles quoted fields containing commas", () => {
		const text = 'account_code,sub_code,name_th,name_en\n111301,,"เงินสด, ในมือ",Cash';
		expect(parseCoaCsv(text)).toEqual([{ account_code: "111301", sub_code: "", name_th: "เงินสด, ในมือ", name_en: "Cash" }]);
	});

	test("handles escaped double quotes inside a quoted field", () => {
		const text = 'account_code,sub_code,name_th,name_en\n111301,,"ค่า ""พิเศษ""",Cash';
		expect(parseCoaCsv(text)).toEqual([{ account_code: "111301", sub_code: "", name_th: 'ค่า "พิเศษ"', name_en: "Cash" }]);
	});

	test("column order in the header doesn't matter", () => {
		const text = "name_en,account_code,name_th,sub_code\nCash,111301,เงินสด,";
		expect(parseCoaCsv(text)).toEqual([{ account_code: "111301", sub_code: "", name_th: "เงินสด", name_en: "Cash" }]);
	});

	test("throws when a required column is missing", () => {
		const text = "account_code,name_th,name_en\n111301,เงินสด,Cash";
		expect(() => parseCoaCsv(text)).toThrow(/missing COA column: sub_code/);
	});

	test("empty/whitespace-only text returns []", () => {
		expect(parseCoaCsv("")).toEqual([]);
		expect(parseCoaCsv("   \n  ")).toEqual([]);
	});
});

describe("coaKey / splitCoaKey", () => {
	test("round-trips account_code + sub_code", () => {
		const row: CoaRow = { account_code: "520211", sub_code: "001", name_th: "x", name_en: "y" };
		const key = coaKey(row);
		expect(key).toBe("520211||001");
		expect(splitCoaKey(key)).toEqual({ account_code: "520211", sub_code: "001" });
	});

	test("splitCoaKey on a key with no separator falls back to a blank sub_code", () => {
		expect(splitCoaKey("999999")).toEqual({ account_code: "999999", sub_code: "" });
	});
});

describe("coaLabel", () => {
	test("includes sub_code when present", () => {
		expect(coaLabel({ account_code: "520211", sub_code: "001", name_th: "ค่าที่ปรึกษา", name_en: "x" })).toBe("520211-001 ค่าที่ปรึกษา");
	});

	test("omits the dash when sub_code is blank", () => {
		expect(coaLabel({ account_code: "111301", sub_code: "", name_th: "เงินสด", name_en: "x" })).toBe("111301 เงินสด");
	});
});

describe("loadCoaRows", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ksk-coa-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("reads coa.csv from the month dir itself when present", async () => {
		writeFileSync(join(dir, "coa.csv"), "account_code,sub_code,name_th,name_en\n111301,,เงินสด,Cash");
		const rows = await loadCoaRows(dir);
		expect(rows).toEqual([{ account_code: "111301", sub_code: "", name_th: "เงินสด", name_en: "Cash" }]);
	});

	test("falls back to the parent client dir when the month dir has no coa.csv", async () => {
		const monthDir = join(dir, "เดือนพฤษภาคม");
		mkdirSync(monthDir);
		writeFileSync(join(dir, "coa.csv"), "account_code,sub_code,name_th,name_en\n520211,,ค่าที่ปรึกษา,Consulting");
		const rows = await loadCoaRows(monthDir);
		expect(rows).toEqual([{ account_code: "520211", sub_code: "", name_th: "ค่าที่ปรึกษา", name_en: "Consulting" }]);
	});

	test("returns [] when coa.csv exists at neither location", async () => {
		const monthDir = join(dir, "เดือนพฤษภาคม");
		mkdirSync(monthDir);
		expect(await loadCoaRows(monthDir)).toEqual([]);
	});
});
