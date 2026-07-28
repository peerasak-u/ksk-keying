import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLeaks, planSplit } from "../prepare-sample";

const tmps: string[] = [];
function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmps.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// Distinct content per file. Real documents are never byte-identical, and a
// fixture where they all are would make the content pass match everything.
function touch(root: string, rel: string, body?: string) {
	const full = join(root, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, body ?? `contents of ${rel}`.padEnd(600, "."));
}

// Mirrors the shape of (พร้อมทดสอบ)_339: months holding both source folders
// and a differently-spelled export folder.
function fakeClient(): string {
	const src = temp("ksk-sample-src-");
	touch(src, "ผังบัญชี.xlsx");
	touch(src, "03-69/รายได้/inv-1.pdf");
	touch(src, "03-69/ค่าใช้จ่าย/exp-1.xlsx");
	touch(src, "03-69/STM/statement.pdf");
	touch(src, "03-69/ไฟล์นำเข้า Peak/รายได้/PEAK_ImportReceipt.xlsx");
	touch(src, "04-69/รายได้/inv-2.pdf");
	touch(src, "04-69/เตรียมไฟล์นำเข้า/PEAK_ImportExpense.xlsx");
	// 218's shape: export workbooks loose beside the source PDF they came
	// from, with no export folder anywhere in the path.
	touch(src, "statement/01-04.pdf");
	touch(src, "statement/PEAK_ImportJournal ฝาก 01-04.xlsx");
	return src;
}

describe("planSplit", () => {
	test("routes export workbooks to the key root and nothing else", () => {
		const plan = planSplit(fakeClient(), "/C", "/K");
		const keys = plan.key.map((p) => p.to).sort();
		expect(keys).toEqual([
			"/K/03-69/ไฟล์นำเข้า Peak/รายได้/PEAK_ImportReceipt.xlsx",
			"/K/04-69/เตรียมไฟล์นำเข้า/PEAK_ImportExpense.xlsx",
			"/K/statement/PEAK_ImportJournal ฝาก 01-04.xlsx",
		]);
	});

	test("keeps every source document, preserving its subfolder structure", () => {
		const plan = planSplit(fakeClient(), "/C", "/K");
		expect(plan.client.map((p) => p.to).sort()).toEqual([
			"/C/03-69/STM/statement.pdf",
			"/C/03-69/ค่าใช้จ่าย/exp-1.xlsx",
			"/C/03-69/รายได้/inv-1.pdf",
			"/C/04-69/รายได้/inv-2.pdf",
			// the statement PDF stays with the client; only its export twin left
			"/C/statement/01-04.pdf",
			"/C/ผังบัญชี.xlsx",
		]);
	});

	test("no file is routed to both halves", () => {
		const plan = planSplit(fakeClient(), "/C", "/K");
		const froms = [...plan.client, ...plan.key].map((p) => p.from);
		expect(new Set(froms).size).toBe(froms.length);
	});

	// A stale ข้อมูลระบบ/ in the Dropbox source would hand the run a
	// half-finished state instead of the starting state.
	test("drops pipeline output and names it as skipped", () => {
		const src = fakeClient();
		touch(src, "03-69/ข้อมูลระบบ/_pages/ledger.yaml");
		const plan = planSplit(src, "/C", "/K");
		expect(plan.client.some((p) => p.to.includes("ข้อมูลระบบ"))).toBe(false);
		expect(plan.skipped.join()).toContain("ข้อมูลระบบ");
	});

	test("ignores Excel lock files and OS junk", () => {
		const src = fakeClient();
		touch(src, "03-69/รายได้/~$inv-1.pdf");
		touch(src, "03-69/รายได้/.DS_Store");
		const plan = planSplit(src, "/C", "/K");
		expect(plan.client.some((p) => p.to.includes("~$"))).toBe(false);
		expect(plan.client.some((p) => p.to.includes(".DS_Store"))).toBe(false);
	});
});

// findLeaks reads the finished folder off disk rather than trusting the plan —
// it is the check that must fail if planSplit itself is wrong.
describe("findLeaks", () => {
	test("reports an export folder that reached the client tree", () => {
		const root = temp("ksk-sample-leak-");
		touch(root, "03-69/รายได้/inv.pdf");
		touch(root, "03-69/File Peak Import/รายได้/key.xlsx");
		expect(findLeaks(root)).toEqual(["03-69/File Peak Import/รายได้/key.xlsx"]);
	});

	// Reporting is per FILE, not per folder: an export-named folder can hold
	// real source documents too (281 keeps its statement PDFs in one), so the
	// folder alone is not the unit of contamination.
	test("names every leaked workbook, and only the workbooks", () => {
		const root = temp("ksk-sample-leak-");
		touch(root, "04-69/เตรียมไฟล์นำเข้า/a.xlsx");
		touch(root, "04-69/เตรียมไฟล์นำเข้า/nested/c.xlsx");
		touch(root, "04-69/เตรียมไฟล์นำเข้า/69-04 statement.pdf");
		expect(findLeaks(root)).toEqual([
			"04-69/เตรียมไฟล์นำเข้า/a.xlsx",
			"04-69/เตรียมไฟล์นำเข้า/nested/c.xlsx",
		]);
	});

	test("passes a correctly split client folder", () => {
		const src = fakeClient();
		const clientRoot = temp("ksk-sample-out-");
		const plan = planSplit(src, clientRoot, join(clientRoot, "..", "keys"));
		for (const { to } of plan.client) touch(clientRoot, to.slice(clientRoot.length + 1));
		expect(findLeaks(clientRoot)).toEqual([]);
	});

	test("reports a loose export workbook with no export folder above it", () => {
		const root = temp("ksk-sample-leak-");
		touch(root, "statement/01-04.pdf");
		touch(root, "statement/PEAK_ImportJournal ถอน 01-04.xlsx");
		expect(findLeaks(root)).toEqual([
			"statement/PEAK_ImportJournal ถอน 01-04.xlsx",
		]);
	});

	// The name rules are blind to 339's disguised copies; the hash pass is not.
	test("catches a byte-identical copy only when given the key root", () => {
		const clientRoot = temp("ksk-sample-dup-");
		const keyRoot = temp("ksk-sample-key-");
		const full = join(keyRoot, "ไฟล์นำเข้า Peak/รายได้.xlsx");
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, "IDENTICAL-EXPORT-BYTES".padEnd(600, "."));
		mkdirSync(join(clientRoot, "รายได้"), { recursive: true });
		writeFileSync(join(clientRoot, "รายได้/รายได้.xlsx"), "IDENTICAL-EXPORT-BYTES".padEnd(600, "."));
		writeFileSync(join(clientRoot, "รายได้/เอกสารรายได้.pdf"), "a real scan");

		expect(findLeaks(clientRoot)).toEqual([]); // name rules see nothing
		expect(findLeaks(clientRoot, keyRoot)).toEqual([
			"รายได้/รายได้.xlsx (byte-identical to an answer-key workbook)",
		]);
	});

	test("a source workbook that merely sits near the exports is not a leak", () => {
		const clientRoot = temp("ksk-sample-dup-");
		const keyRoot = temp("ksk-sample-key-");
		mkdirSync(keyRoot, { recursive: true });
		writeFileSync(join(keyRoot, "PEAK_ImportExpense.xlsx"), "EXPORT".padEnd(600, "."));
		writeFileSync(join(clientRoot, "ผังบัญชี.xlsx"), "a different workbook".padEnd(600, "-"));
		expect(findLeaks(clientRoot, keyRoot)).toEqual([]);
	});

	test("missing folder is not a leak", () => {
		expect(findLeaks(join(tmpdir(), "ksk-does-not-exist-xyz"))).toEqual([]);
	});
});
