// Chart-of-accounts CSV loader (wayfinder ticket #41, part of the #40 spec's
// sibling — category/group review pages). Ported from
// .claude/skills/ksk-keying/scripts/review-template.ts's loadCoaRows/CoaRow
// (not imported — that file is a giant embedded Vue-template string, not
// designed as a library; same "reimplement the small shared shape" call
// review-claims.ts already made for DispositionEntry/unitKey).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type CoaRow = {
	account_code: string;
	sub_code: string;
	name_th: string;
	name_en: string;
};

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let value = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (quoted && line[i + 1] === '"') {
				value += '"';
				i++;
			} else quoted = !quoted;
		} else if (ch === "," && !quoted) {
			out.push(value);
			value = "";
		} else value += ch;
	}
	out.push(value);
	return out;
}

/** Pure: parse coa.csv's text into rows. Throws if any of the 4 required
 * columns is missing from the header — a malformed COA is a hard stop, not
 * a silent partial load (same posture as the original loadCoaRows). */
export function parseCoaCsv(text: string): CoaRow[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const lines = trimmed.split(/\r?\n/);
	const header = parseCsvLine(lines[0] || "");
	const idx = new Map(header.map((name, i) => [name, i]));
	for (const name of ["account_code", "sub_code", "name_th", "name_en"])
		if (!idx.has(name)) throw new Error(`missing COA column: ${name}`);
	return lines.slice(1).map((line) => {
		const values = parseCsvLine(line);
		return {
			account_code: values[idx.get("account_code")!] || "",
			sub_code: values[idx.get("sub_code")!] || "",
			name_th: values[idx.get("name_th")!] || "",
			name_en: values[idx.get("name_en")!] || "",
		};
	});
}

/** account_code + sub_code composite, the same join key the old review UI
 * used for its COA <select> value/grouping — kept identical so a document's
 * lines[]/rows[] account_code+sub_code pair round-trips through one string. */
export function coaKey(row: { account_code: string; sub_code: string }): string {
	return `${row.account_code}||${row.sub_code}`;
}

export function splitCoaKey(key: string): { account_code: string; sub_code: string } {
	const sep = key.indexOf("||");
	if (sep === -1) return { account_code: key, sub_code: "" };
	return { account_code: key.slice(0, sep), sub_code: key.slice(sep + 2) };
}

export function coaLabel(row: CoaRow): string {
	return row.sub_code ? `${row.account_code}-${row.sub_code} ${row.name_th}` : `${row.account_code} ${row.name_th}`;
}

/** Thin I/O: coa.csv is client-level context, same lookup order as every
 * other client-context file (paths.ts's resolveContextFile) — the month
 * dir itself first (legacy/self-contained layouts), then its parent client
 * root. Returns [] if neither exists (caller decides whether that's fatal). */
export async function loadCoaRows(clientMonthDir: string): Promise<CoaRow[]> {
	const local = join(clientMonthDir, "coa.csv");
	const path = existsSync(local) ? local : join(dirname(clientMonthDir), "coa.csv");
	if (!existsSync(path)) return [];
	return parseCoaCsv(await readFile(path, "utf8"));
}
