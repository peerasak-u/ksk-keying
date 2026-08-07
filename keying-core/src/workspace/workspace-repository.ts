// The workspace adapter: the two-level client/month walk, the month-format
// rule and its warnings, and the few artifact reads the run projection needs.
//
// Plan §14.3 for `console/app/workspace.ts` is "Reuse path guards and
// discovery … Infrastructure adapter behind application interface". This is
// that adapter. It differs from the runtime's walk in exactly one respect, and
// deliberately: a month directory whose name fails the `YY-MM` regex is skipped
// AND REPORTED (plan §9.2 [r3]), where the runtime's walk simply listed every
// directory. "A silently ignored folder is the failure mode this rule exists to
// prevent."
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { isMonthId } from "../identity/month";
import type { Logger } from "../observability/logger";

/** review-data.ts:132-141 — the closed bucket set, as the artifact tree lays it
 * out on disk. */
export const BUCKET_KEYS = [
	"expense/vat",
	"expense/non_vat",
	"expense/mixed",
	"income/vat",
	"income/non_vat",
	"bank_statement",
] as const;

export type ClientMonth = {
	clientKey: string;
	monthId: string;
	/** `<clientKey>/<monthId>`, POSIX (§1.4). */
	workspaceRelPath: string;
};

/** §5.2's `warnings[]` entry. `name` is the offending directory name VERBATIM —
 * a trailing space or a full-width digit must be visible, not normalised
 * away. */
export type MonthFolderWarning = {
	code: "month_folder_ignored";
	clientKey: string;
	name: string;
	message: string;
};

const MONTH_FOLDER_IGNORED_TH = "ชื่อโฟลเดอร์เดือนไม่ตรงรูปแบบ YY-MM จึงข้ามไป";

export type WorkspaceScan = {
	clientMonths: ClientMonth[];
	warnings: MonthFolderWarning[];
	clients: number;
	months: number;
};

function subdirNames(dir: string): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** Plan §9.2 step 4: dot-directories are excluded from the walk entirely and
 * produce NO warning — "they are known non-month entries, and warning about
 * them would train the operator to ignore the warning list". `node_modules` is
 * excluded at the CLIENT level only, matching `workspace.ts:25`; inside a
 * client folder every non-dot directory is supposed to be a month, so one that
 * is not gets a warning rather than a silent skip. */
function isExcludedFromWalk(name: string): boolean {
	return name.startsWith(".");
}

/** The runtime's collation, reused so the API order, the CLI order and the disk
 * order are one order ([C-16]; `workspace.ts:26-27`). */
export function compareThai(a: string, b: string): number {
	return a.localeCompare(b, "th");
}

/** The two-level walk. Sorted at both levels, so a restart drill and a paged
 * `GET /v1/jobs` see the same sequence. */
export function scanWorkspace(workspaceRoot: string, logger?: Logger): WorkspaceScan {
	const clientMonths: ClientMonth[] = [];
	const warnings: MonthFolderWarning[] = [];
	if (!existsSync(workspaceRoot)) return { clientMonths, warnings, clients: 0, months: 0 };

	const clientKeys = subdirNames(workspaceRoot)
		.filter((name) => !isExcludedFromWalk(name) && name !== "node_modules")
		.sort(compareThai);

	for (const clientKey of clientKeys) {
		for (const name of subdirNames(join(workspaceRoot, clientKey)).sort(compareThai)) {
			if (isExcludedFromWalk(name)) continue;
			if (!isMonthId(name)) {
				warnings.push({ code: "month_folder_ignored", clientKey, name, message: MONTH_FOLDER_IGNORED_TH });
				// Plan §9.2 step 3: one structured log line per offending
				// directory, at every discovery pass, carrying the name verbatim.
				logger?.warn("workspace.month_folder_ignored", { clientKey, name });
				continue;
			}
			clientMonths.push({ clientKey, monthId: name, workspaceRelPath: `${clientKey}/${name}` });
		}
	}

	return { clientMonths, warnings, clients: clientKeys.length, months: clientMonths.length };
}

// Matches a `client_name: "..."` line inside CLIENT.md's YAML frontmatter —
// deliberately narrow, exactly as `workspace.ts:30-42` reads it.
const CLIENT_NAME_RE = /^client_name:\s*"([^"]*)"/m;

/** §5.3's `companyName`. A convenience for the CLI's human output; the office
 * platform has its own customer record and should not use it. */
export async function readCompanyName(clientDir: string): Promise<string | null> {
	const raw = await readFile(join(clientDir, "CLIENT.md"), "utf-8").catch(() => null);
	if (!raw) return null;
	const match = CLIENT_NAME_RE.exec(raw);
	return match ? match[1] : null;
}

export type LedgerCounts = { totalUnits: number; reviewed: number; excluded: number };

/** `ข้อมูลระบบ/_pages/ledger.yaml`'s `counts` block, written by the `final`
 * gate (`workspace.ts:76-95`). Real data already on disk — not recomputed here.
 * `null` until that gate has written it, which is exactly when §1.7 says the
 * run object's `counts` is null. */
export async function readLedgerCounts(monthDir: string): Promise<LedgerCounts | null> {
	const path = join(monthDir, "ข้อมูลระบบ", "_pages", "ledger.yaml");
	if (!existsSync(path)) return null;
	try {
		const doc = yamlParse(await readFile(path, "utf8"));
		const counts = doc?.counts;
		if (!counts || typeof counts.units !== "number") return null;
		return {
			totalUnits: counts.units,
			reviewed: typeof counts.reviewed === "number" ? counts.reviewed : 0,
			excluded: typeof counts.excluded === "number" ? counts.excluded : 0,
		};
	} catch {
		return null;
	}
}

function docGroupsRoot(monthDir: string): string {
	return join(monthDir, "ข้อมูลระบบ", "_doc_groups");
}

/** Every group directory under `_doc_groups/<bucket>/`, as `review-data.ts`'s
 * own `listGroupFolders` selects them: directories, not `assets`, not
 * dot-names. */
function listGroupDirs(monthDir: string): string[] {
	const dirs: string[] = [];
	for (const bucket of BUCKET_KEYS) {
		const bucketDir = join(docGroupsRoot(monthDir), ...bucket.split("/"));
		for (const name of subdirNames(bucketDir)) {
			if (name === "assets" || name.startsWith(".")) continue;
			dirs.push(join(bucketDir, name));
		}
	}
	return dirs;
}

export type GroupTotals = { groupCount: number; attention: number };

/** The group/attention halves of §1.7's `counts`. `attention` is the page count
 * with `initial_status: "needs_attention"` — the same predicate the review hub
 * uses (`review-hub-stats.ts:154`), read narrowly here rather than through the
 * full review read model, which is §5.15's job and a later slice.
 *
 * A group whose `review-data.json` is missing or unreadable contributes 0
 * attention rather than failing the read: this total is a headline number on a
 * run that has reached `final`, and §5.15 is where a malformed group document
 * is a hard `422`. */
export async function readGroupTotals(monthDir: string): Promise<GroupTotals> {
	const groupDirs = listGroupDirs(monthDir);
	let attention = 0;
	for (const dir of groupDirs) {
		const path = join(dir, "review-data.json");
		if (!existsSync(path)) continue;
		try {
			const doc = JSON.parse(await readFile(path, "utf8"));
			const pages = Array.isArray(doc?.pages) ? doc.pages : [];
			for (const page of pages) {
				if (page?.initial_status === "needs_attention") attention += 1;
			}
		} catch {
			continue;
		}
	}
	return { groupCount: groupDirs.length, attention };
}

/** §1.7 / [C-38] — what a `repair` would throw away right now. */
export type RepairImpact = {
	destroys: boolean;
	editedGroups: number;
	groupCount: number;
	lastHumanEditAt: string | null;
};

function mtimeMs(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/** [C-38]: "A group counts as *edited* when its `review-data.json` has been
 * written since the `categorize` stage produced it — the same mtime comparison
 * [C-22] already permits for the `ETag`, so no new bookkeeping is introduced."
 *
 * The marker for "when the categorize stage produced it" is the pristine
 * sidecar `review-data.ai.json`, which `build-review-data.ts` writes
 * immediately AFTER `review-data.json` in the same pass, and which the console's
 * review edit path never touches (`review-edit.ts:185-217` writes
 * `review-data.json` alone). So right after a build the sidecar is the newer of
 * the two, and any later human save makes `review-data.json` strictly newer —
 * which is the comparison, with no tolerance to guess at. Where the sidecar is
 * absent (a group built before it existed) the fallback marker is
 * `categorize.json`, the stage's own output the build reads from. */
export async function measureRepairImpact(monthDir: string): Promise<RepairImpact> {
	const groupDirs = listGroupDirs(monthDir);
	let editedGroups = 0;
	let lastHumanEditMs: number | null = null;

	for (const dir of groupDirs) {
		const reviewMs = mtimeMs(join(dir, "review-data.json"));
		if (reviewMs === null) continue;
		const baselineMs = mtimeMs(join(dir, "review-data.ai.json")) ?? mtimeMs(join(dir, "categorize.json"));
		if (baselineMs === null) continue;
		if (reviewMs <= baselineMs) continue;
		editedGroups += 1;
		if (lastHumanEditMs === null || reviewMs > lastHumanEditMs) lastHumanEditMs = reviewMs;
	}

	return {
		// "`destroys` is `false` exactly when `editedGroups` is `0` (including
		// `hasRunRecord: false`, where there is nothing on disk to lose)."
		destroys: editedGroups > 0,
		editedGroups,
		groupCount: groupDirs.length,
		lastHumanEditAt: lastHumanEditMs === null ? null : new Date(lastHumanEditMs).toISOString(),
	};
}
