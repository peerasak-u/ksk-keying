// Single source of truth for the Page-Ledger unit-id format ("<file>#p<N>" /
// "<file>#s<Sheet>" / "<file>") and its NFC-normalization-for-matching rule.
//
// Before this file existed, `unitId`/`parseUnitId`/`norm` were reimplemented
// four times (ledger.ts, review-groups.ts's parseLedgerUnitId, merge-
// dispositions.ts's unitKey, and validate-interpretation.ts's ad-hoc id
// construction in page_disposition checks) — never actually divergent in
// FORMAT, but with no single place to add a shared invariant. This module is
// that place; every call site above now imports from here instead of holding
// its own copy.
//
// NFC-normalize for MATCHING only — stored/display ids always keep the
// source's exact bytes (never mangle Thai filenames). Two Thai paths that are
// byte-different (NFC vs NFD) but visually/canonically the same string must
// still resolve to the same unit; `norm` is the one place that decision is
// made.

import { SYS_DIR } from "./paths";

export function norm(text: string): string {
	return text.normalize("NFC");
}

export function unitId(file: string, page: number | null, sheet: string | null): string {
	if (page != null) return `${file}#p${page}`;
	if (sheet != null) return `${file}#s${sheet}`;
	return file;
}

export function parseUnitId(id: string): { file: string; page: number | null; sheet: string | null } {
	const pageMatch = id.match(/^(.*)#p(\d+)$/);
	if (pageMatch) return { file: pageMatch[1], page: Number(pageMatch[2]), sheet: null };
	const sheetMatch = id.match(/^(.*)#s(.+)$/);
	if (sheetMatch) return { file: sheetMatch[1], page: null, sheet: sheetMatch[2] };
	return { file: id, page: null, sheet: null };
}

// Rejects a claim's source file when it names a pipeline artifact path
// (anything under ข้อมูลระบบ/, e.g. "ข้อมูลระบบ/_segments/seg-010/
// interpretation-u002.json" — a real client-345 regression: ksk-marple cited
// the candidate interpretation FILE instead of copying its source_file) or
// when the file is simply absent from the Inventory. Either case can never be
// matched by the Page Ledger — ledger.ts keys claims by the SOURCE DOCUMENT
// path, always, never an intermediate artifact path — so a claim naming one
// would silently never reach Reviewed, and a genuinely-reviewed page would
// stay non-terminal forever. Returns an error message naming the problem, or
// null when `file` is a valid Inventory source.
export function inventorySourceError(file: string, inventoryFiles: ReadonlySet<string>): string | null {
	if (file === SYS_DIR || file.startsWith(`${SYS_DIR}/`))
		return `source file "${file}" is a pipeline artifact path (under ${SYS_DIR}/), not a client document — copy the candidate's own source_file/source_page instead of citing the interpretation file`;
	if (!inventoryFiles.has(norm(file)))
		return `source file "${file}" is not in the Inventory (ข้อมูลระบบ/_pages/inventory.yaml) — a claim on it can never reach Reviewed at the Page Ledger`;
	return null;
}
