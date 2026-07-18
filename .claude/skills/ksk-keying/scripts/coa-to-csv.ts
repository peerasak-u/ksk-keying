import { dirname, extname, join, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readFile, utils } from "xlsx";
import { GENERATED_DIRS } from "./paths";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");
const OUT_COLUMNS = ["account_code", "sub_code", "name_th", "name_en"] as const;
const HEADER_MARK = "ลำดับที่";
const COL_ACCOUNT = "รหัสบัญชี";

type Args = {
	clientDir: string;
	workbook?: string;
	out?: string;
	json: boolean;
};

type CsvRecord = globalThis.Record<(typeof OUT_COLUMNS)[number], string>;

function usage(): never {
	console.error(`Usage: bun run coa-to-csv -- [options] <client-dir>

Options:
  --workbook PATH     Explicit ผังบัญชี .xls/.xlsx path
  --out PATH          Output CSV path (default: <client>/coa.csv)
  --json              Print machine-readable JSON
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = { clientDir: "", json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--workbook") args.workbook = argv[++i];
		else if (arg === "--out") args.out = argv[++i];
		else if (arg === "--json") args.json = true;
		else if (arg === "--help" || arg === "-h") usage();
		else if (arg.startsWith("--")) usage();
		else if (!args.clientDir) args.clientDir = arg;
		else usage();
	}
	if (!args.clientDir) usage();
	return args;
}

function cell(value: unknown) {
	return value == null ? "" : String(value).trim();
}

function findCoaWorkbook(clientDir: string) {
	const candidates: string[] = [];
	const add = (dir: string, prefixOnly: boolean) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const ext = extname(name).toLowerCase();
			if (
				statSync(path).isFile() &&
				(ext === ".xlsx" || ext === ".xls") &&
				(!prefixOnly || name.startsWith("ผังบัญชี"))
			)
				candidates.push(path);
		}
	};
	add(clientDir, true);
	// Clients often keep the workbook inside a month subfolder — scan one level
	// down too (skipping generated artifact folders).
	for (const name of readdirSync(clientDir).sort()) {
		const sub = join(clientDir, name);
		if (GENERATED_DIRS.includes(name) || !statSync(sub).isDirectory()) continue;
		add(sub, true);
	}
	const nested = join(clientDir, "ข้อมูล", "ผังบัญชี");
	if (existsSync(nested) && statSync(nested).isDirectory()) add(nested, false);
	const unique = [...new Map(candidates.map((p) => [resolve(p), p])).values()];
	if (unique.length === 0)
		throw new Error(`no ผังบัญชี .xls/.xlsx under: ${clientDir}`);
	if (unique.length > 1)
		throw new Error(
			`multiple COA workbooks; pass --workbook explicitly: ${unique.join(", ")}`,
		);
	return unique[0];
}

function loadRows(workbook: string) {
	const ext = extname(workbook).toLowerCase();
	if (ext !== ".xlsx" && ext !== ".xls")
		throw new Error(`unsupported workbook: ${workbook} (expected .xls or .xlsx)`);
	const book = readFile(workbook, { cellDates: false, bookVBA: false });
	const sheet = book.Sheets[book.SheetNames[0]];
	return utils.sheet_to_json<unknown[]>(sheet, {
		header: 1,
		raw: false,
		defval: "",
	});
}

function parseRows(rows: unknown[][]) {
	const hdrIdx = rows.findIndex(
		(row) =>
			cell(row[0]) === HEADER_MARK && row.some((c) => cell(c) === COL_ACCOUNT),
	);
	if (hdrIdx === -1)
		throw new Error("could not find header row (ลำดับที่, รหัสบัญชี, …)");

	const header = rows[hdrIdx];
	const idx = new Map(header.map((h, i) => [cell(h), i]));
	for (const name of ["ลำดับที่", "รหัสบัญชี", "ชื่อบัญชี (ไทย)"])
		if (!idx.has(name))
			throw new Error(`missing column ${JSON.stringify(name)}`);

	const get = (row: unknown[], name: string) => {
		const i = idx.get(name);
		return i == null ? "" : cell(row[i]);
	};
	const out: CsvRecord[] = [];
	for (const row of rows.slice(hdrIdx + 1)) {
		if (!row.some((c) => cell(c))) continue;
		const code = get(row, "รหัสบัญชี");
		if (!/^\d+$/.test(code)) continue;
		out.push({
			account_code: code,
			sub_code: get(row, "รหัสบัญชีย่อย"),
			name_th: get(row, "ชื่อบัญชี (ไทย)"),
			name_en: get(row, "ชื่อบัญชี (อังกฤษ)"),
		});
	}
	return out;
}

function csvEscape(value: string) {
	return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function toCsv(records: CsvRecord[]) {
	const lines = [OUT_COLUMNS.join(",")];
	for (const row of records)
		lines.push(OUT_COLUMNS.map((c) => csvEscape(row[c])).join(","));
	return `${lines.join("\n")}\n`;
}

async function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const root = resolve(process.env.KSK_WORKSPACE_ROOT || PROJECT_ROOT);
	const client = resolve(root, args.clientDir);
	const workbook = args.workbook
		? resolve(root, args.workbook)
		: findCoaWorkbook(client);
	const out = args.out ? resolve(root, args.out) : join(client, "coa.csv");
	const records = parseRows(loadRows(workbook));
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, toCsv(records));
	const summary = {
		ok: true,
		client_dir: client,
		source_workbook: workbook,
		rows: records.length,
		csv: out,
		columns: OUT_COLUMNS,
	};
	if (args.json) console.log(JSON.stringify(summary, null, 2));
	else
		for (const [k, v] of Object.entries(summary))
			if (k !== "ok") console.log(`${k}: ${v}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
