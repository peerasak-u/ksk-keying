// Deterministic, killable spreadsheet-sheet preparation for Stage 2.
// This runs as a supervised subprocess so a corrupt/huge workbook cannot
// block the app event loop or outlive cancellation.
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { readFile as readWorkbook, utils as xlsxUtils } from "xlsx";

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 500;
const MAX_CELLS = 1_000_000;

function fail(message: string): never {
	throw new Error(message);
}

function main() {
	const [sourcePath, sheetName, outputPath, sourceFile] = Bun.argv.slice(2);
	if (!sourcePath || !sheetName || !outputPath || !sourceFile)
		fail("usage: bun run prepare-sheet.ts -- <source-path> <sheet-name> <output-path> <source-file>");
	if (!isAbsolute(sourcePath) || !isAbsolute(outputPath))
		fail("source-path and output-path must be absolute");
	if (statSync(sourcePath).size > MAX_SOURCE_BYTES)
		fail(`spreadsheet exceeds ${MAX_SOURCE_BYTES} byte preparation limit`);

	const workbook = readWorkbook(sourcePath, { cellDates: false });
	const sheet = workbook.Sheets[sheetName];
	if (!sheet) fail(`spreadsheet has no assigned sheet ${JSON.stringify(sheetName)}`);
	const range = sheet["!ref"] ? xlsxUtils.decode_range(sheet["!ref"]) : null;
	const rows = range ? range.e.r - range.s.r + 1 : 0;
	const columns = range ? range.e.c - range.s.c + 1 : 0;
	if (rows > MAX_ROWS || columns > MAX_COLUMNS || rows * columns > MAX_CELLS)
		fail(`sheet exceeds preparation bounds (${rows} rows x ${columns} columns)`);

	const prepared = {
		schema: "ksk_prepared_sheet.v1",
		source_file: sourceFile,
		sheet: sheetName,
		rows: xlsxUtils.sheet_to_json(sheet, { header: 1, defval: null, raw: false }),
	};
	mkdirSync(dirname(outputPath), { recursive: true });
	const temporary = `${outputPath}.tmp-${process.pid}`;
	try {
		writeFileSync(temporary, JSON.stringify(prepared));
		renameSync(temporary, outputPath);
	} finally {
		rmSync(temporary, { force: true });
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
