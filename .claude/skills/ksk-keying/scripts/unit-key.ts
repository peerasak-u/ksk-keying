// Single source of truth for the Page-Ledger unit-id format ("<file>#p<N>" /
// "<file>#s<Sheet>" / "<file>") and its NFC-normalization-for-matching rule.
//
// Before this file existed, `unitId`/`parseUnitId`/`norm` were reimplemented
// four times (ledger.ts, review-groups.ts's parseLedgerUnitId, merge-
// dispositions.ts's unitKey, and validate-interpretation.ts's ad-hoc id
// construction in page_disposition checks) — never actually divergent in
// FORMAT, but with no single place to add a shared invariant. ledger.ts,
// review-groups.ts, and merge-dispositions.ts now import from here. NOTE
// (2026-07-28): validate-interpretation.ts was NEVER actually migrated — it
// still builds `${entry.file}#p${entry.page}` inline for its duplicate_of
// check — this comment over-claimed "every call site" for a while. Verify
// against the source, don't trust this paragraph.
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

// Identifies one DOCUMENT among possibly several sharing a single physical
// page — unitId alone names the PAGE, not the document on it. Real defect
// (client 345, seg-012 page 77 of "เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf"):
// three separate handwritten payment slips were scanned onto one page; each
// became a links.yaml member with document_no: null, so all three were
// byte-for-byte identical entries — nothing downstream could tell them apart
// or map any of them back to a page, and the page silently never got claimed
// by any group. `ordinal` is the document's 1-based position among its
// page-mates, assigned by the caller in the order the documents appear in
// their source interpretation (stable across reruns because that order is
// itself stable) — NOT reassigned per group/segment, so the same physical
// document always gets the same key.
export function documentUnitId(file: string, page: number | null, sheet: string | null, ordinal: number): string {
	return `${unitId(file, page, sheet)}#d${ordinal}`;
}

export function parseDocumentUnitId(id: string): { file: string; page: number | null; sheet: string | null; ordinal: number | null } {
	const match = id.match(/^(.*)#d(\d+)$/);
	if (!match) return { ...parseUnitId(id), ordinal: null };
	return { ...parseUnitId(match[1]), ordinal: Number(match[2]) };
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
