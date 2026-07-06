// Single source of truth for the client-folder layout the ksk-keying pipeline
// writes into. Two audiences, two trees:
//
//   <client>/ตรวจทาน/         — the human deliverable. Thai names only, one
//                              self-contained ตรวจทาน.html per category/VAT
//                              folder. This is what the reviewer opens.
//   <client>/ข้อมูลระบบ/       — the machinery. Everything the agents and the
//                              deterministic scripts read/write (segments,
//                              pages/ledger, doc-group JSON/YAML). The reviewer
//                              never opens it; internal file names stay English.
//
// Historically the three machinery folders (_segments, _doc_groups, _pages)
// lived at the client root with underscore prefixes. They now live under
// ข้อมูลระบบ/ so the client-facing view is all-Thai with no underscores. The
// leaf names keep their underscores/English on purpose — they only ever appear
// inside ข้อมูลระบบ/, so changing them would churn every schema reference for no
// user-visible gain.

import { join } from "node:path";

// --- Human deliverable tree ------------------------------------------------
export const REVIEW_DIR = "ตรวจทาน";
export const REVIEW_HTML_NAME = "ตรวจทาน.html";

// --- Machinery container ---------------------------------------------------
export const SYS_DIR = "ข้อมูลระบบ";
export const SEGMENTS_DIR = "_segments";
export const DOC_GROUPS_DIR = "_doc_groups";
export const PAGES_DIR = "_pages";

// Build a path inside the machinery container: sysPath(client, "_pages",
// "inventory.yaml") -> <client>/ข้อมูลระบบ/_pages/inventory.yaml
export function sysPath(clientDir: string, ...parts: string[]): string {
	return join(clientDir, SYS_DIR, ...parts);
}

export function segmentsDir(clientDir: string): string {
	return sysPath(clientDir, SEGMENTS_DIR);
}
export function docGroupsDir(clientDir: string): string {
	return sysPath(clientDir, DOC_GROUPS_DIR);
}
export function pagesDir(clientDir: string): string {
	return sysPath(clientDir, PAGES_DIR);
}

// Folders the inventory census must never descend into (they are generated, not
// client input). Includes the legacy top-level names so a half-migrated folder
// from an older run is still skipped.
export const GENERATED_DIRS: readonly string[] = [
	SYS_DIR,
	REVIEW_DIR,
	SEGMENTS_DIR,
	DOC_GROUPS_DIR,
	PAGES_DIR,
];

// English bucket keys (as used throughout the machinery: category folders and
// _doc_groups paths) -> Thai folder names for the deliverable tree.
export const CATEGORY_TH: Record<string, string> = {
	expense: "ค่าใช้จ่าย",
	income: "รายได้",
	bank_statement: "รายการเดินบัญชี",
};

export const VAT_TH: Record<string, string> = {
	vat: "มีภาษี",
	non_vat: "ไม่มีภาษี",
	mixed: "คละภาษี",
};

// Map an English bucket key ("expense/vat", "bank_statement") to the Thai
// path segments under ตรวจทาน/. Unknown segments fall back to the raw key so a
// new bucket never silently vanishes from the deliverable tree.
export function reviewBucketSegments(bucketKey: string): string[] {
	const parts = bucketKey.split("/");
	const category = CATEGORY_TH[parts[0]] ?? parts[0];
	if (parts.length === 1) return [category];
	const vat = VAT_TH[parts[1]] ?? parts[1];
	return [category, vat];
}

// Human-facing Thai description for one bucket, used for the exported PEAK
// filename so downloads from different buckets do not collide in the browser's
// Downloads folder. e.g. "ค่าใช้จ่าย มีภาษี", "รายการเดินบัญชี".
export function reviewBucketLabel(bucketKey: string): string {
	return reviewBucketSegments(bucketKey).join(" ");
}
