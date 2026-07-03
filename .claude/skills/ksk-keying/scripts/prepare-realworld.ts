import { basename, dirname, join, resolve } from "node:path";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");
const SKIP_FILENAMES = new Set([".DS_Store", "Thumbs.db"]);
const EXCLUDE_DIRS = new Set(["เตรียมไฟล์นำเข้า"]);

type Args = {
	source: string;
	target: string;
	businessName: string;
	taxId: string;
	vat: boolean;
	coa: string;
	json: boolean;
};

function usage(): never {
	console.error(`Usage: bun run prepare-realworld -- [options] <source> <target>

Arguments:
  source            Source folder (ข้อมูลครบ/_NNN ...)
  target            Target folder (realworld/_NNN ...)

Options:
  --business-name   Full Thai business name (required)
  --tax-id          13-digit Thai tax ID (required)
  --vat             VAT registered (flag)
  --coa             COA workbook filename (default: ผังบัญชี.xlsx)
  --json            Print machine-readable JSON
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		source: "",
		target: "",
		businessName: "",
		taxId: "",
		vat: false,
		coa: "ผังบัญชี.xlsx",
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--business-name") args.businessName = argv[++i];
		else if (arg === "--tax-id") args.taxId = argv[++i];
		else if (arg === "--vat") args.vat = true;
		else if (arg === "--coa") args.coa = argv[++i];
		else if (arg === "--json") args.json = true;
		else if (arg === "--help" || arg === "-h") usage();
		else if (arg.startsWith("--")) usage();
		else if (!args.source) args.source = arg;
		else if (!args.target) args.target = arg;
		else usage();
	}
	if (!args.source || !args.target) usage();
	if (!args.businessName) {
		console.error("missing required option: --business-name");
		process.exit(2);
	}
	if (!args.taxId) {
		console.error("missing required option: --tax-id");
		process.exit(2);
	}
	return args;
}

function collectSourceFiles(src: string) {
	const files: string[] = [];
	const entries = readdirSync(src).sort();

	// Root-level files
	for (const name of entries) {
		const path = join(src, name);
		if (statSync(path).isFile() && !SKIP_FILENAMES.has(name)) files.push(path);
	}

	// Flatten subdirectories (excluding special dirs)
	for (const name of entries) {
		const path = join(src, name);
		if (statSync(path).isDirectory() && !EXCLUDE_DIRS.has(name)) {
			for (const sub of readdirSync(path).sort()) {
				const subPath = join(path, sub);
				if (statSync(subPath).isFile() && !SKIP_FILENAMES.has(sub))
					files.push(subPath);
			}
		}
	}
	return files;
}

function copyFiles(files: string[], dst: string) {
	mkdirSync(dst, { recursive: true });
	let copied = 0;
	for (const file of files) {
		const name = basename(file);
		let dest = join(dst, name);
		let counter = 1;
		while (existsSync(dest)) {
			const extIdx = name.lastIndexOf(".");
			const stem = extIdx > 0 ? name.slice(0, extIdx) : name;
			const suffix = extIdx > 0 ? name.slice(extIdx) : "";
			dest = join(dst, `${stem} (${counter})${suffix}`);
			counter++;
		}
		copyFileSync(file, dest);
		copied++;
	}
	return copied;
}

function writeClientJson(
	dst: string,
	businessName: string,
	taxId: string,
	vat: boolean,
	coa: string,
) {
	const data = {
		business_name: businessName,
		vat,
		tax_id: taxId,
		coa,
	};
	const path = join(dst, "client.json");
	writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
	return path;
}

function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const root = resolve(process.env.KSK_WORKSPACE_ROOT || PROJECT_ROOT);
	const src = resolve(root, args.source);
	const tgt = resolve(root, args.target);

	if (!existsSync(src) || !statSync(src).isDirectory()) {
		console.error(JSON.stringify({ error: `source not found: ${src}` }));
		process.exit(1);
	}

	const files = collectSourceFiles(src);
	if (!files.length) {
		const msg = `No files found in ${src}`;
		if (args.json) console.log(JSON.stringify({ error: msg }));
		else console.error(msg);
		process.exit(1);
	}

	const copied = copyFiles(files, tgt);
	const clientPath = writeClientJson(
		tgt,
		args.businessName,
		args.taxId,
		args.vat,
		args.coa,
	);

	const summary = {
		source: src,
		target: tgt,
		files_copied: copied,
		client_json: clientPath,
	};

	if (args.json) console.log(JSON.stringify(summary));
	else {
		console.log(`Prepared ${tgt}`);
		console.log(`  Files copied: ${copied}`);
		console.log(`  client_json:  ${clientPath}`);
	}
}

main();
