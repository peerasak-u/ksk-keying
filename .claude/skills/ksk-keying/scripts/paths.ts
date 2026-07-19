// Single source of truth for the folder layout the ksk-keying pipeline writes
// into. A client folder holds month subfolders; every pipeline run is scoped to
// ONE month folder — the "run root" every script takes as its directory
// argument. Two audiences, two trees, both inside the month being keyed:
//
//   <client>/<month>/ตรวจทาน/    — the human deliverable. Thai names only, one
//                                 self-contained ตรวจทาน.html per category/VAT
//                                 folder. This is what the reviewer opens.
//   <client>/<month>/ข้อมูลระบบ/ — the machinery. Everything the agents and the
//                                 deterministic scripts read/write (segments,
//                                 pages/ledger, doc-group JSON/YAML). The
//                                 reviewer never opens it; internal file names
//                                 stay English.
//
// Month-invariant client context (CLIENT.md, coa.csv, coa_usage.json) lives one
// level up, at the client root, shared by every month's run. Scripts locate it
// with resolveContextFile(): run root first (so a legacy everything-at-client-
// root layout and self-contained eval fixtures keep working unchanged), then
// the parent directory.
//
// Historically the three machinery folders (_segments, _doc_groups, _pages)
// lived at the client root with underscore prefixes. They now live under
// ข้อมูลระบบ/ so the client-facing view is all-Thai with no underscores. The
// leaf names keep their underscores/English on purpose — they only ever appear
// inside ข้อมูลระบบ/, so changing them would churn every schema reference for no
// user-visible gain.

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

// --- Human deliverable tree ------------------------------------------------
export const REVIEW_DIR = "ตรวจทาน";
export const REVIEW_HTML_NAME = "ตรวจทาน.html";
// Hub page at the root of ตรวจทาน/ linking to every bucket's ตรวจทาน.html and
// (when non-empty) the excluded-items list, so the reviewer never has to hop
// folders to find where to start.
export const REVIEW_INDEX_HTML_NAME = "index.html";
// Every page/sheet an agent proposed excluding (ledger.yaml
// agent_declared_exclusions), with a live preview, so the reviewer can
// confirm each exclusion without leaving the browser.
export const REVIEW_EXCLUDED_HTML_NAME = "ที่ถูกตัดออก.html";

// --- Machinery container ---------------------------------------------------
export const SYS_DIR = "ข้อมูลระบบ";
export const SEGMENTS_DIR = "_segments";
export const DOC_GROUPS_DIR = "_doc_groups";
export const PAGES_DIR = "_pages";

// Build a path inside the machinery container: sysPath(runDir, "_pages",
// "inventory.yaml") -> <month>/ข้อมูลระบบ/_pages/inventory.yaml
export function sysPath(runDir: string, ...parts: string[]): string {
	return join(runDir, SYS_DIR, ...parts);
}

export function segmentsDir(runDir: string): string {
	return sysPath(runDir, SEGMENTS_DIR);
}
export function docGroupsDir(runDir: string): string {
	return sysPath(runDir, DOC_GROUPS_DIR);
}
export function pagesDir(runDir: string): string {
	return sysPath(runDir, PAGES_DIR);
}

// --- Client-level context ----------------------------------------------------
// Month-invariant files shared by every month's run.
export const CLIENT_CONTEXT_FILES = [
	"CLIENT.md",
	"coa.csv",
	"coa_usage.json",
] as const;

// Locate a client-context file from a run root: the run root itself first
// (legacy layouts and self-contained eval fixtures), then the parent client
// root. Returns null when neither exists.
export function resolveContextFile(
	runDir: string,
	name: string,
): string | null {
	const local = join(runDir, name);
	if (existsSync(local)) return local;
	const up = join(dirname(runDir), name);
	if (existsSync(up)) return up;
	return null;
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
