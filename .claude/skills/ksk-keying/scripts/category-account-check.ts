// Category / account cross-check (Completion check, alongside the reference-
// report cross-check) — deterministic instead of relying on a human reviewer
// to notice a group filed under the wrong category folder.
//
// Nothing in the pipeline reconciles a doc-group's category folder
// (ข้อมูลระบบ/_doc_groups/<category>/<vat>/<group>/) against the account code
// its OWN categorize.json confirms for it. group-skeleton assigns
// category/vat_treatment provisionally (from the segment interpretation's
// `direction`, or "no primary interpretation" placeholders for agent-populated
// groups); categorize.json is a later, more informed step that reads the
// group's actual interpretation/evidence and proposes a real COA account. The
// two can disagree — and when they do, the group is filed for review/export
// under the wrong P&L or balance-sheet bucket.
//
// Confirmed real case: client _336 groups 680-ID_NOT_FOUND_3 (฿230,000) and
// 628-ID_NOT_FOUND_1 (฿50,000) — promissory-note (ตั๋วสัญญาใช้เงิน) evidence —
// sit under expense/non_vat even though their own categorize.json maps them to
// account 113201 เงินให้กู้ยืม-บุคคลที่เกี่ยวข้องกัน, a 1xxxxx balance-sheet
// asset account, not a 5xxxxx P&L expense.
//
// Rule (leading digit of the Thai COA account code vs. category folder):
//   expense/**  expects 5xxxxx.
//     - 4xxxxx  -> HIGH: a revenue account under expense/ is very likely a
//                  mis-filed group (revenue booked as an expense).
//     - 1/2/3xxxxx -> REVIEW: a balance-sheet account under expense/ MAY be
//                  legitimate (fixed-asset purchase, deposit, employee
//                  advance, related-party loan, ...) but needs a human to
//                  confirm the group was filed in the right bucket at all.
//     - anything else (0,6,7,8,9xxxxx) -> REVIEW: unexpected leading digit.
//   income/**   expects 4xxxxx.
//     - 5xxxxx  -> HIGH: an expense account under income/ is very likely a
//                  mis-filed group (expense booked as revenue).
//     - 1/2/3xxxxx -> REVIEW: MAY be legitimate (customer deposit/advance
//                  received booking to a balance-sheet account) but needs a
//                  human to confirm.
//     - anything else -> REVIEW: unexpected leading digit.
//   bank_statement/** groups are out of scope — their categorize.json lines
//   are counter-accounts for a bank movement, not a category-vs-account claim.
//
// Flag-only: this script never moves files, never rewrites manifest.yaml, and
// never edits categorize.json. Same non-destructive contract as
// reference-report-check.ts — a flag is evidence for a human, never an
// automatic change to facts, and it never blocks a gate (exit 0 always).
//
// Usage: bun run category-account-check.ts -- [--out-dir DIR] <client-dir>
//
// --out-dir overrides where the snapshot YAML is written (default: the
// client's own ข้อมูลระบบ/_pages/). Useful for read-only verification runs
// against a client dir that must not be written to (e.g. samples/ fixtures).

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { docGroupsDir, pagesDir } from "./paths";
import type { GroupPlan } from "./groups-lib";

const SCHEMA = "ksk_category_account_check.v1";

type Args = { clientDir: string; outDir: string | null };

function usage(): never {
	console.error("Usage: bun run category-account-check.ts -- [--out-dir DIR] <client-dir>");
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const rest = argv.slice(2);
	const dashDash = rest.indexOf("--");
	const positional = dashDash >= 0 ? rest.slice(dashDash + 1) : rest;
	let outDir: string | null = null;
	const clientArgs: string[] = [];
	for (let i = 0; i < positional.length; i++) {
		if (positional[i] === "--out-dir") outDir = positional[++i];
		else clientArgs.push(positional[i]);
	}
	if (clientArgs.length < 1) usage();
	return { clientDir: clientArgs[0], outDir };
}

type CategorizeLine = {
	line_index?: number;
	account_code?: string | null;
	sub_code?: string | null;
	account_name_th?: string | null;
	confidence?: string;
	reason?: string;
	needs_review?: boolean;
};

type CategorizeFile = {
	group_id?: string;
	lines?: CategorizeLine[];
};

export type Severity = "high" | "review";

export type Flag = {
	group_id: string;
	group_path: string;
	line_index: number;
	account_code: string;
	account_name_th: string | null;
	category: "expense" | "income";
	severity: Severity;
	message: string;
};

// Only expense/income buckets carry a category-vs-account claim worth
// checking — see the header comment for why bank_statement is out of scope.
export type CheckableCategory = "expense" | "income";

export function assessLine(
	category: CheckableCategory,
	accountCode: string,
): { severity: Severity; message: string } | null {
	const digit = accountCode.trim().charAt(0);
	const categoryTh = category === "expense" ? "ค่าใช้จ่าย (expense)" : "รายได้ (income)";
	const expectedDigit = category === "expense" ? "5" : "4";
	const oppositeDigit = category === "expense" ? "4" : "5";
	const oppositeNoun = category === "expense" ? "a revenue" : "an expense";

	if (digit === expectedDigit) return null; // clean — matches the folder

	if (digit === oppositeDigit) {
		return {
			severity: "high",
			message: `account ${accountCode} is ${oppositeNoun} account (leading digit ${digit}) confirmed for a group filed under ${categoryTh} — very likely mis-filed; verify the category/VAT bucket and re-file if wrong`,
		};
	}

	if (digit === "1" || digit === "2" || digit === "3") {
		return {
			severity: "review",
			message: `account ${accountCode} is a balance-sheet account (leading digit ${digit}) confirmed for a group filed under ${categoryTh} — MAY be legitimate (e.g. a fixed-asset purchase, a deposit, an employee advance, or a related-party loan booking to a non-P&L account instead) but a human must confirm the group belongs under ${category}/ at all`,
		};
	}

	return {
		severity: "review",
		message: `account ${accountCode} (leading digit ${digit}) is unexpected for a group filed under ${categoryTh} — expected a ${expectedDigit}xxxxx account; verify manually`,
	};
}

export function loadManifestGroups(clientDir: string): GroupPlan[] | null {
	const path = join(docGroupsDir(clientDir), "manifest.yaml");
	if (!existsSync(path)) return null;
	let doc: { groups?: GroupPlan[] } | null;
	try {
		doc = yamlParse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(`failed to parse doc-group manifest (${path}): ${(err as Error).message}`);
	}
	return Array.isArray(doc?.groups) ? doc.groups : [];
}

function loadCategorize(path: string): CategorizeFile | { error: string } {
	if (!existsSync(path)) return { error: "missing categorize.json" };
	try {
		return JSON.parse(readFileSync(path, "utf8")) as CategorizeFile;
	} catch (err) {
		return { error: `malformed categorize.json: ${(err as Error).message}` };
	}
}

export type CheckResult = {
	schema: string;
	manifest_found: boolean;
	groups_checked: number;
	groups_skipped_missing_categorize: number;
	groups_skipped_malformed_categorize: number;
	flags: Flag[];
};

// Core logic, no process.exit — safe to call from tests. Writes the snapshot
// YAML into outDir (never into the client dir itself unless outDir defaults
// to it — callers pass an override for read-only verification runs) and
// returns the same data so callers/tests don't have to re-parse stdout.
export function runCategoryAccountCheck(clientDir: string, outDir: string): CheckResult {
	const outPath = join(outDir, "category-account-check.yaml");
	const groups = loadManifestGroups(clientDir);

	if (groups === null) {
		const result: CheckResult = {
			schema: SCHEMA,
			manifest_found: false,
			groups_checked: 0,
			groups_skipped_missing_categorize: 0,
			groups_skipped_malformed_categorize: 0,
			flags: [],
		};
		mkdirSync(outDir, { recursive: true });
		writeFileSync(outPath, yamlStringify(result));
		return result;
	}

	const checkable = groups.filter(
		(g): g is GroupPlan & { category: CheckableCategory } =>
			g.category === "expense" || g.category === "income",
	);

	let groupsChecked = 0;
	let groupsSkippedMissing = 0;
	let groupsSkippedMalformed = 0;
	const flags: Flag[] = [];

	for (const group of checkable) {
		const catPath = join(docGroupsDir(clientDir), group.path, "categorize.json");
		const loaded = loadCategorize(catPath);
		if ("error" in loaded) {
			// Missing categorize.json is normal for groups not yet populated /
			// categorized — nothing to check yet, skip silently (no P&L claim
			// exists to reconcile). A malformed file is unusual enough to count
			// separately, but this check still never blocks on it.
			if (loaded.error.startsWith("missing")) groupsSkippedMissing++;
			else groupsSkippedMalformed++;
			continue;
		}
		// A structurally-valid JSON whose `lines` is not an array (e.g. `{}` or
		// `{"lines": {}}`) would crash the for-of below — treat it the same as a
		// malformed categorize.json (count as skipped, never block).
		if (!Array.isArray(loaded.lines)) {
			groupsSkippedMalformed++;
			continue;
		}
		groupsChecked++;

		for (const line of loaded.lines) {
			const accountCode = (line.account_code ?? "").trim();
			if (!accountCode) continue; // no confirmed account for this line — nothing to reconcile
			const assessment = assessLine(group.category, accountCode);
			if (!assessment) continue;
			flags.push({
				group_id: loaded.group_id || group.id,
				group_path: group.path,
				line_index: line.line_index ?? 0,
				account_code: accountCode,
				account_name_th: line.account_name_th ?? null,
				category: group.category,
				severity: assessment.severity,
				message: assessment.message,
			});
		}
	}

	const result: CheckResult = {
		schema: SCHEMA,
		manifest_found: true,
		groups_checked: groupsChecked,
		groups_skipped_missing_categorize: groupsSkippedMissing,
		groups_skipped_malformed_categorize: groupsSkippedMalformed,
		flags,
	};

	mkdirSync(outDir, { recursive: true });
	writeFileSync(outPath, yamlStringify(result));
	return result;
}

// Human-readable stdout rendering, printed unconditionally — same reasoning
// as reference-report-check.ts: a mismatch must never be silently possible to
// miss in a transcript.
export function formatReport(result: CheckResult, outPath: string): string {
	const lines: string[] = [];
	lines.push(`Category/account cross-check`);

	if (!result.manifest_found) {
		lines.push("No doc-group manifest found (run group-skeleton first) — nothing to cross-check.");
		lines.push(`snapshot: ${outPath}`);
		return lines.join("\n");
	}

	lines.push(
		`${result.groups_checked} group(s) checked (expense/income only), ${result.groups_skipped_missing_categorize} skipped (no categorize.json yet)${result.groups_skipped_malformed_categorize ? `, ${result.groups_skipped_malformed_categorize} skipped (malformed categorize.json)` : ""}`,
	);

	const highFlags = result.flags.filter((f) => f.severity === "high");
	const reviewFlags = result.flags.filter((f) => f.severity === "review");

	if (result.flags.length === 0) {
		lines.push("  ✓ every confirmed account code matches its group's category folder.");
	} else {
		for (const f of [...highFlags, ...reviewFlags]) {
			const marker = f.severity === "high" ? "⚠ HIGH" : "⚠ review";
			lines.push(
				`  ${marker} ${f.group_path} (line ${f.line_index}, ${f.account_code} ${f.account_name_th ?? ""}) — ${f.message}`,
			);
		}
	}

	lines.push(`snapshot: ${outPath}`);
	lines.push(
		result.flags.length > 0
			? "RESULT: REVIEW POINTS FOUND — surface every ⚠ line in the completion report; this never blocks the run or edits facts automatically."
			: "RESULT: all confirmed account codes agree with their category folder.",
	);
	return lines.join("\n");
}

function main() {
	const args = parseArgs(process.argv);
	const clientDir = args.clientDir;
	if (!existsSync(clientDir)) {
		console.error(`client dir not found: ${clientDir}`);
		process.exit(2);
	}

	const outDir = args.outDir ?? pagesDir(clientDir);
	const outPath = join(outDir, "category-account-check.yaml");

	let result: CheckResult;
	try {
		result = runCategoryAccountCheck(clientDir, outDir);
	} catch (err) {
		console.error((err as Error).message);
		process.exit(2);
	}

	console.log(formatReport(result, outPath));

	// Never blocks the run — flag-only, same contract as
	// reference-report-check.ts. Exit 0 always; the parent's completion report
	// is the enforcement point (it must not omit a flagged group).
	process.exit(0);
}

// Only run the CLI entrypoint when this file is executed directly (`bun run
// category-account-check.ts`), not when its functions are imported by tests.
if (import.meta.main) main();
