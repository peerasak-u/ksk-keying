import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { utils as xlsxUtils, writeFile as writeWorkbook } from "xlsx";
import { runSupervisedProcess } from "./process-supervisor";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prepare-sheet subprocess", () => {
	test("materializes only the assigned sheet as bounded JSON", async () => {
		const root = mkdtempSync(join(tmpdir(), "ksk-sheet-"));
		roots.push(root);
		const source = join(root, "bank.xlsx");
		const output = join(root, "_pages", "bank", "sheet-April.json");
		const workbook = xlsxUtils.book_new();
		xlsxUtils.book_append_sheet(workbook, xlsxUtils.aoa_to_sheet([["date", "amount"], ["2026-04-01", 125]]), "April");
		xlsxUtils.book_append_sheet(workbook, xlsxUtils.aoa_to_sheet([["secret"]]), "May");
		writeWorkbook(workbook, source);

		const script = resolve(dirname(fileURLToPath(import.meta.url)), "prepare-sheet.ts");
		const result = await runSupervisedProcess({
			cmd: ["bun", "run", script, "--", source, "April", output, "bank.xlsx"],
			timeoutMs: 5_000,
			idleTimeoutMs: 2_000,
			termGraceMs: 100,
		});
		expect(result).toMatchObject({ reason: "exited", exitCode: 0, cleanupComplete: true });
		const prepared = JSON.parse(readFileSync(output, "utf8"));
		expect(prepared).toMatchObject({
			schema: "ksk_prepared_sheet.v1",
			source_file: "bank.xlsx",
			sheet: "April",
			rows: [["date", "amount"], ["2026-04-01", "125"]],
		});
		expect(JSON.stringify(prepared)).not.toContain("secret");
	});
});
