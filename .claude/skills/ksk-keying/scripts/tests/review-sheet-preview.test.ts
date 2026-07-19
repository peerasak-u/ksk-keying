import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils as xlsxUtils, writeFile as writeWorkbook } from "xlsx";

const SCRIPT = join(import.meta.dir, "..", "review-groups.ts");

const tmps: string[] = [];
function tempRunRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "ksk-sheet-preview-"));
	tmps.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const COA_CSV = `account_code,sub_code,name_th,name_en
530101,,ค่าใช้จ่ายเบ็ดเตล็ด,Miscellaneous expense
`;

// A page whose evidence is an .xlsx must get an embedded sheet_preview table in
// the generated ตรวจทาน.html (a file:// page cannot fetch() the workbook), so
// the reviewer sees the sheet's rows instead of "ไฟล์ต้นฉบับเปิดในเบราว์เซอร์ไม่ได้".
describe("review-groups xlsx sheet preview", () => {
	test("embeds the referenced sheet's rows into the review HTML", () => {
		const runRoot = tempRunRoot();
		writeFileSync(join(runRoot, "coa.csv"), COA_CSV);

		// The evidence workbook, sitting in the month folder like a real client
		// spreadsheet. Distinctive Thai cell values prove the right sheet landed.
		const workbook = xlsxUtils.book_new();
		const sheet = xlsxUtils.aoa_to_sheet([
			["วันที่", "รายการ", "จำนวนเงิน"],
			["01/05/2026", "ค่าน้ำมันทดสอบพรีวิว", 1234.5],
		]);
		xlsxUtils.book_append_sheet(workbook, sheet, "รายการเดือนพค");
		writeWorkbook(workbook, join(runRoot, "สมุดรายวัน.xlsx"));

		const groupDir = join(
			runRoot,
			"ข้อมูลระบบ",
			"_doc_groups",
			"expense",
			"vat",
			"g-0001",
		);
		mkdirSync(groupDir, { recursive: true });
		const reviewData = {
			schema: "ksk_review_group_data.v1",
			group_id: "g-0001",
			label: "ทดสอบสเปรดชีต",
			pages: [
				{
					ref: "สมุดรายวัน.xlsx",
					short_ref: "สมุดรายวัน.xlsx",
					image_src: null,
					source_src: "สมุดรายวัน.xlsx",
					source_page: null,
					source_sheet: "รายการเดือนพค",
					extract_path: "",
					categorize_path: "",
					facts: { doc_no: "TEST-1" },
					lines: [],
					initial_status: "reviewed" as const,
				},
			],
		};
		writeFileSync(
			join(groupDir, "review-data.json"),
			JSON.stringify(reviewData, null, 2),
		);

		const run = spawnSync("bun", [SCRIPT, "--force", runRoot], {
			encoding: "utf8",
		});
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);

		const htmlPath = join(runRoot, "ตรวจทาน", "ค่าใช้จ่าย", "มีภาษี", "ตรวจทาน.html");
		expect(existsSync(htmlPath)).toBe(true);
		const html = readFileSync(htmlPath, "utf8");
		// The embedded payload carries the preview object with the sheet's rows…
		expect(html).toContain('"sheet_preview"');
		expect(html).toContain("รายการเดือนพค");
		expect(html).toContain("ค่าน้ำมันทดสอบพรีวิว");
		// …and the page classifies the source as a non-PDF/image file, which the
		// template renders via the previewKind === 'sheet' branch.
		expect(html).toContain('"source_kind":"other"');
	});
});
