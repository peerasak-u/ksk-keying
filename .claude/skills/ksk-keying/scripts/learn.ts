// เรียนรู้ — the deterministic half of the learning loop (wayfinder ticket
// #43, mechanism decided by #37): walk every group's changes.json (#36's
// ksk_review_changes.v1, written at export time by the console's
// changelog.ts) across a WHOLE CLIENT — every month on record, not just the
// one that triggered the pass — and turn the account_code corrections a
// human made into a *proposed* set of coa_usage.json updates.
//
// This script never decides anything on its own beyond counting: it proposes
// (--propose) and it applies exactly what it is told to (--apply). The
// judgment in between — is this correction a real pattern or a one-off
// exception? — belongs to #37's light agent-review pass and then to the human
// pressing the button, both of which live in the console (console/app/learn.ts).
// Same "agents judge, scripts copy" split build-review-data.ts already states.
//
// Signal, per #36/#37: ONLY entries with `field: "account_code"`. Value/fact
// edits and `skipped` flags are real human edits but they are not COA
// mappings, so they teach coa_usage.json nothing.
//
// Aggregation is additive-only, no decay, carried over verbatim from the old
// (superseded) learn.ts: a correction either increments an existing hint's
// matching tax_id count or appends a brand-new hint. A tax_id can end up
// counted on two different hints (a vendor selling both goods and services) —
// poirot sorts by count and matches per-line, so that is expected, never
// resolved down to "one true mapping". Existing hints are never replaced:
// their label/notes/pair_account_code (often hand-written) survive untouched.
//
// Idempotency is per CORRECTION, not per file. coa_usage.json carries
// `learned_from`, keyed by each changes.json path RELATIVE TO THE CLIENT ROOT
// (a client has one per group per MONTH — keying on the bucket alone would let
// one month's learning mark another month's file as already-learned), holding
// the fingerprints of the corrections already consumed from that file.
//
// A file-level watermark would be wrong here: #36's changes.json is a SNAPSHOT
// diff recomputed at EVERY export with a fresh `computed_at`, so re-exporting
// an unchanged month would re-count every correction in it and inflate the
// hint counts once per export. A fingerprint over (line_id, before, after) is
// stable across re-exports and only changes when the human's correction
// itself changes.
//
// Note that --apply records EVERY correction it considered, including ones
// whose proposal the human rejected — otherwise a deliberately-rejected
// correction would resurface on every future pass. The cost: that rejected
// evidence no longer counts toward a later proposal for the same account, so a
// pattern only becomes visible from corrections made AFTER the rejection.
//
// Exit codes: 0 success (finding nothing to learn is not an error), 2
// usage/environment error.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DOC_GROUPS_DIR, SYS_DIR } from "./paths";

// ---------------------------------------------------------------------------
// Types

export type HintFamily = "expense_hints" | "income_hints" | "bank_hints";

export type UsageTaxId = { tax_id: string; count: number };
export type UsageHint = {
	account_code: string;
	sub_code: string;
	label: string;
	keywords: string[];
	tax_ids: UsageTaxId[];
	// Hand-written fields poirot reads (see ksk-poirot.md) — never written or
	// overwritten by this script, only preserved.
	vat_status?: string;
	pair_account_code?: string;
	notes?: string;
};
export type CoaUsage = {
	expense_hints?: UsageHint[];
	income_hints?: UsageHint[];
	bank_hints?: UsageHint[];
	/** changes.json path (client-root-relative) -> fingerprints of the
	 * corrections in it that have already been learned from. */
	learned_from?: Record<string, string[]>;
	learned_at?: string;
};

export type CoaRow = { account_code: string; sub_code: string; name_th: string; name_en: string };

/** One group's changes.json, located. `key` is the learned_from key. */
export type ChangesSource = {
	key: string;
	month_id: string;
	bucket: string;
	group_id: string;
};

/** A changes.json found on disk, with the bucket/group its position implies. */
type ChangesFileLocation = ChangesSource & { path: string; groupDir: string };

export type Correction = {
	source: ChangesSource;
	/** Stable fingerprint of this one correction — the idempotency key. */
	entry_id: string;
	line_id: string;
	/** coaKey ("<code>||<sub>") the AI had picked; "" when the line had no original. */
	before_key: string;
	/** coaKey the human corrected it to. */
	after_key: string;
	description: string | null;
	tax_id: string | null;
};

export type LineContext = { description: string | null; tax_id: string | null };
export type ContextLookup = (lineId: string) => LineContext;

export type LearnProposal = {
	/** "<family>:<coaKey>" — stable across a propose/apply round trip. */
	id: string;
	family: HintFamily;
	account_code: string;
	sub_code: string;
	label: string;
	/** false when the corrected-to code isn't in coa.csv — proposed anyway
	 * (the human is the authority) but flagged for the review pass. */
	in_coa: boolean;
	is_new_hint: boolean;
	correction_count: number;
	keywords: string[];
	tax_id_counts: UsageTaxId[];
	/** What the AI had chosen instead, with counts — the evidence #37's agent
	 * pass needs to tell "a real pattern" from "one odd document". */
	from_accounts: { account_key: string; count: number }[];
	/** The hint's tax_id history BEFORE this pass, when it already exists. */
	existing_tax_id_counts: UsageTaxId[];
	examples: { month_id: string; group_id: string; line_id: string; description: string | null; from_key: string }[];
};

export type LearnReport = {
	schema: "ksk_learn_report.v1";
	client_dir: string;
	scanned_files: number;
	skipped_already_learned: number;
	correction_count: number;
	/** changes.json keys carrying at least one not-yet-learned correction —
	 * the files --apply re-reads and stamps. */
	sources: string[];
	proposals: LearnProposal[];
};

export type LearningNote = { title: string; detail: string };

export type LearnDecision = {
	schema?: string;
	/** Proposal ids the human accepted. Anything not listed is rejected. */
	accept?: string[];
	sources?: string[];
	notes?: LearningNote[];
};

export const LEARNING_NOTES_FILE = "learning-notes.md";

// ---------------------------------------------------------------------------
// Pure core

export function familyForBucket(bucket: string): HintFamily {
	if (bucket.startsWith("income")) return "income_hints";
	if (bucket.startsWith("bank_statement")) return "bank_hints";
	return "expense_hints";
}

function splitCoaKey(key: string): { account_code: string; sub_code: string } {
	const at = key.indexOf("||");
	if (at === -1) return { account_code: key, sub_code: "" };
	return { account_code: key.slice(0, at), sub_code: key.slice(at + 2) };
}

/** Identity of one correction, independent of when its changes.json was last
 * recomputed: the same human edit re-exported ten times fingerprints the same
 * way, so it is learned from exactly once. */
export function correctionId(lineId: string, beforeKey: string, afterKey: string): string {
	return createHash("sha256").update(`${lineId}|${beforeKey}|${afterKey}`).digest("hex").slice(0, 16);
}

/** Pure: the account_code corrections inside one parsed changes.json. Anything
 * that isn't this schema, isn't an account_code entry, or whose `after` isn't
 * a non-empty string contributes nothing — a learning pass must never invent
 * signal out of a malformed file. */
export function accountCorrections(doc: unknown, source: ChangesSource, lookup: ContextLookup): Correction[] {
	const d = doc as { schema?: unknown; entries?: unknown } | null;
	if (!d || d.schema !== "ksk_review_changes.v1" || !Array.isArray(d.entries)) return [];
	const out: Correction[] = [];
	for (const raw of d.entries) {
		const entry = raw as { line_id?: unknown; field?: unknown; before?: unknown; after?: unknown };
		if (entry.field !== "account_code") continue;
		if (typeof entry.after !== "string" || !entry.after) continue;
		const lineId = typeof entry.line_id === "string" ? entry.line_id : "";
		const context = lookup(lineId);
		const beforeKey = typeof entry.before === "string" ? entry.before : "";
		out.push({
			source,
			entry_id: correctionId(lineId, beforeKey, entry.after),
			line_id: lineId,
			before_key: beforeKey,
			after_key: entry.after,
			description: context.description,
			tax_id: context.tax_id,
		});
	}
	return out;
}

const MAX_KEYWORD_LEN = 40;

/** Keywords for a hint, taken from the corrected line's own description. Thai
 * is written without spaces, so a whitespace split alone would yield one
 * sentence-long token for most lines — the whole (bounded) description is kept
 * as a keyword too, which is what poirot can actually substring-match against.
 * No Thai word segmentation is attempted here. */
function keywordsFrom(description: string | null): string[] {
	if (!description) return [];
	const whole = description.trim();
	const words = whole.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 3);
	const out = whole.length >= 3 && whole.length <= MAX_KEYWORD_LEN ? [whole] : [];
	for (const w of words) if (!out.includes(w)) out.push(w);
	return out;
}

const MAX_KEYWORDS = 8;
const MAX_EXAMPLES = 3;

function labelFor(coaRows: CoaRow[], code: string, sub: string): { label: string; in_coa: boolean } {
	const row = coaRows.find((r) => r.account_code === code && (r.sub_code || "") === sub);
	if (row) return { label: row.name_th || code, in_coa: true };
	return { label: sub ? `${code}-${sub}` : code, in_coa: false };
}

function findHint(usage: CoaUsage, family: HintFamily, code: string, sub: string): UsageHint | undefined {
	return (usage[family] ?? []).find((h) => h.account_code === code && (h.sub_code || "") === sub);
}

/** Pure: fold corrections into one proposal per (hint family, account). */
export function buildProposals(corrections: Correction[], coaRows: CoaRow[], usage: CoaUsage): LearnProposal[] {
	const byId = new Map<string, LearnProposal>();
	const taxCounts = new Map<string, Map<string, number>>();
	const fromCounts = new Map<string, Map<string, number>>();

	for (const c of corrections) {
		const family = familyForBucket(c.source.bucket);
		const { account_code, sub_code } = splitCoaKey(c.after_key);
		const id = `${family}:${account_code}||${sub_code}`;
		let proposal = byId.get(id);
		if (!proposal) {
			const { label, in_coa } = labelFor(coaRows, account_code, sub_code);
			const existing = findHint(usage, family, account_code, sub_code);
			proposal = {
				id,
				family,
				account_code,
				sub_code,
				label,
				in_coa,
				is_new_hint: !existing,
				correction_count: 0,
				keywords: [],
				tax_id_counts: [],
				from_accounts: [],
				existing_tax_id_counts: existing ? existing.tax_ids.map((t) => ({ ...t })) : [],
				examples: [],
			};
			byId.set(id, proposal);
			taxCounts.set(id, new Map());
			fromCounts.set(id, new Map());
		}
		proposal.correction_count += 1;
		for (const word of keywordsFrom(c.description)) {
			if (proposal.keywords.length >= MAX_KEYWORDS) break;
			if (!proposal.keywords.includes(word)) proposal.keywords.push(word);
		}
		if (c.tax_id) {
			const m = taxCounts.get(id)!;
			m.set(c.tax_id, (m.get(c.tax_id) ?? 0) + 1);
		}
		if (c.before_key) {
			const m = fromCounts.get(id)!;
			m.set(c.before_key, (m.get(c.before_key) ?? 0) + 1);
		}
		if (proposal.examples.length < MAX_EXAMPLES) {
			proposal.examples.push({
				month_id: c.source.month_id,
				group_id: c.source.group_id,
				line_id: c.line_id,
				description: c.description,
				from_key: c.before_key,
			});
		}
	}

	for (const [id, proposal] of byId) {
		proposal.tax_id_counts = [...taxCounts.get(id)!].map(([tax_id, count]) => ({ tax_id, count }));
		proposal.from_accounts = [...fromCounts.get(id)!].map(([account_key, count]) => ({ account_key, count }));
	}
	return [...byId.values()];
}

/** True when this exact correction has already been consumed from this file. */
export function isAlreadyLearned(usage: CoaUsage, key: string, entryId: string): boolean {
	return (usage.learned_from?.[key] ?? []).includes(entryId);
}

/** Splits one file's corrections into the fresh ones and the count of ones
 * already learned — the whole of the idempotency rule, in one pure place. */
export function freshCorrections(usage: CoaUsage, corrections: Correction[]): { fresh: Correction[]; skipped: number } {
	const fresh = corrections.filter((c) => !isAlreadyLearned(usage, c.source.key, c.entry_id));
	return { fresh, skipped: corrections.length - fresh.length };
}

export type ApplyResult = { hintsAdded: number; hintsUpdated: number; taxIdCounts: number };

/** Mutates `usage` in place: appends/increments the accepted proposals' hints
 * and records EVERY correction this pass considered (accepted or rejected) so
 * none of them is ever counted twice. Additive-only — an existing hint keeps
 * its label, notes, vat_status and pair_account_code. */
export function applyProposals(
	usage: CoaUsage,
	proposals: LearnProposal[],
	accepted: Set<string>,
	consumed: Correction[],
	nowIso: string,
): ApplyResult {
	usage.expense_hints ??= [];
	usage.income_hints ??= [];
	usage.bank_hints ??= [];
	usage.learned_from ??= {};

	const result: ApplyResult = { hintsAdded: 0, hintsUpdated: 0, taxIdCounts: 0 };
	for (const proposal of proposals) {
		if (!accepted.has(proposal.id)) continue;
		const hints = usage[proposal.family]!;
		let hint = hints.find((h) => h.account_code === proposal.account_code && (h.sub_code || "") === proposal.sub_code);
		if (!hint) {
			hint = { account_code: proposal.account_code, sub_code: proposal.sub_code, label: proposal.label, keywords: [], tax_ids: [] };
			hints.push(hint);
			result.hintsAdded += 1;
		} else {
			result.hintsUpdated += 1;
		}
		hint.keywords ??= [];
		for (const word of proposal.keywords) {
			if (hint.keywords.length >= MAX_KEYWORDS) break;
			if (!hint.keywords.includes(word)) hint.keywords.push(word);
		}
		hint.tax_ids ??= [];
		for (const { tax_id, count } of proposal.tax_id_counts) {
			let entry = hint.tax_ids.find((t) => t.tax_id === tax_id);
			if (!entry) {
				entry = { tax_id, count: 0 };
				hint.tax_ids.push(entry);
			}
			entry.count += count;
			result.taxIdCounts += count;
		}
	}

	for (const correction of consumed) {
		const seen = (usage.learned_from[correction.source.key] ??= []);
		if (!seen.includes(correction.entry_id)) seen.push(correction.entry_id);
	}
	usage.learned_at = nowIso;
	return result;
}

/** Pure: append one dated section of notes to learning-notes.md's text. The
 * broader signal #37 left open — a correction pattern that deserves more than
 * a coa_usage.json bump (e.g. a missing CLIENT.md coa_convention) — lands here
 * as a note for a human to act on, never as an automatic edit to CLIENT.md. */
export function appendLearningNotes(existing: string, notes: LearningNote[], nowIso: string): string {
	if (notes.length === 0) return existing;
	const date = nowIso.slice(0, 10);
	const header = existing.trim() ? "" : "# บันทึกการเรียนรู้\n\nข้อสังเกตจากการกด “เรียนรู้” ที่ใหญ่กว่าการปรับ coa_usage.json — คนต้องอ่านและตัดสินใจเอง\n";
	const body = notes.map((n) => `- **${n.title}** — ${n.detail}`).join("\n");
	const base = existing.endsWith("\n") || !existing ? existing : `${existing}\n`;
	return `${base}${header}\n## ${date}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Thin I/O

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");

function usage(): never {
	console.error(`Usage:
  bun run learn -- --propose <clientDir>          # prints a ksk_learn_report.v1 JSON to stdout
  bun run learn -- --apply <clientDir> < decision.json

--propose walks every <clientDir>/<month>/ข้อมูลระบบ/_doc_groups/**/changes.json
and proposes coa_usage.json updates from the account_code corrections it finds.
--apply reads a decision JSON on stdin ({accept: [proposalId], sources: [...],
notes: [...]}) and writes coa_usage.json (+ learning-notes.md when notes are
given). Nothing is written by --propose.

Exit codes: 0 success (nothing to learn is not an error), 2 usage/environment error.
`);
	process.exit(2);
}

function resolveClientDir(input: string): string {
	const path = resolve(input);
	if (existsSync(path) && statSync(path).isDirectory()) return path;
	const fromRoot = resolve(PROJECT_ROOT, input);
	if (existsSync(fromRoot) && statSync(fromRoot).isDirectory()) return fromRoot;
	console.error(`not a client directory: ${input}`);
	process.exit(2);
}

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

function subdirNames(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => !name.startsWith(".") && name !== "node_modules" && statSync(join(dir, name)).isDirectory());
	} catch {
		return [];
	}
}

/** Every changes.json under a client's months, with its bucket/group derived
 * from its position in the _doc_groups tree (bucket = the path between
 * _doc_groups/ and the group folder). */
function findChangesFiles(clientDir: string): ChangesFileLocation[] {
	const found: ChangesFileLocation[] = [];
	for (const monthId of subdirNames(clientDir)) {
		const root = join(clientDir, monthId, SYS_DIR, DOC_GROUPS_DIR);
		if (!existsSync(root)) continue;
		walk(clientDir, root, root, monthId, found);
	}
	return found;
}

function walk(clientDir: string, dir: string, groupsRoot: string, monthId: string, out: ChangesFileLocation[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(clientDir, p, groupsRoot, monthId, out);
		else if (name === "changes.json") {
			const rel = toPosix(relative(groupsRoot, dir)).split("/");
			const group_id = rel[rel.length - 1] ?? "";
			out.push({
				path: p,
				groupDir: dir,
				key: toPosix(relative(clientDir, p)),
				month_id: monthId,
				bucket: rel.slice(0, -1).join("/"),
				group_id,
			});
		}
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

const CLIENT_TAX_ID_RE = /^tax_id:\s*"?([0-9]{10,13})"?\s*$/m;

function readClientTaxId(clientDir: string): string | null {
	const path = join(clientDir, "CLIENT.md");
	if (!existsSync(path)) return null;
	const match = CLIENT_TAX_ID_RE.exec(readFileSync(path, "utf8"));
	return match ? match[1] : null;
}

function parseCoaCsv(text: string): CoaRow[] {
	const lines = text.trim().split(/\r?\n/);
	if (lines.length === 0) return [];
	const header = lines[0].split(",").map((h) => h.trim());
	const idx = (name: string) => header.indexOf(name);
	const [ci, si, ti, ei] = [idx("account_code"), idx("sub_code"), idx("name_th"), idx("name_en")];
	if (ci === -1) return [];
	return lines.slice(1).map((line) => {
		const v = line.split(",");
		return {
			account_code: (v[ci] ?? "").trim(),
			sub_code: si === -1 ? "" : (v[si] ?? "").trim(),
			name_th: ti === -1 ? "" : (v[ti] ?? "").trim(),
			name_en: ei === -1 ? "" : (v[ei] ?? "").trim(),
		};
	});
}

function loadCoaRows(clientDir: string): CoaRow[] {
	const path = join(clientDir, "coa.csv");
	if (!existsSync(path)) return [];
	try {
		return parseCoaCsv(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
}

/** line_id -> {description, tax_id} for one group, read from the
 * review-data.json sitting next to its changes.json. The line_id shapes are
 * changelog.ts's own: "<page.ref>#L<line_index>" for documents,
 * "<group_id>#R<row_index>" for bank statements. A group whose review-data is
 * missing/unreadable simply contributes no context — its corrections still
 * count, they just carry no tax_id or keywords. */
function buildContextLookup(groupDir: string, clientTaxId: string | null): ContextLookup {
	const data = readJson(join(groupDir, "review-data.json")) as any;
	const map = new Map<string, LineContext>();
	if (data && Array.isArray(data.pages)) {
		for (const page of data.pages) {
			const facts = page?.facts ?? {};
			const seller = typeof facts.seller_tax_id === "string" ? facts.seller_tax_id : null;
			const buyer = typeof facts.buyer_tax_id === "string" ? facts.buyer_tax_id : null;
			const counterparty = seller && seller !== clientTaxId ? seller : buyer && buyer !== clientTaxId ? buyer : null;
			for (const line of page?.lines ?? []) {
				map.set(`${page.ref}#L${line.line_index}`, { description: typeof line.description === "string" ? line.description : null, tax_id: counterparty });
			}
		}
	}
	if (data && Array.isArray(data.rows)) {
		for (const row of data.rows) {
			map.set(`${data.group_id}#R${row.row_index}`, { description: typeof row.description === "string" ? row.description : null, tax_id: null });
		}
	}
	return (lineId) => map.get(lineId) ?? { description: null, tax_id: null };
}

function loadUsage(clientDir: string): CoaUsage {
	const path = join(clientDir, "coa_usage.json");
	if (!existsSync(path)) return {};
	const parsed = readJson(path);
	if (!parsed || typeof parsed !== "object") {
		console.error(`failed to parse coa_usage.json — refusing to overwrite it`);
		process.exit(2);
	}
	return parsed as CoaUsage;
}

function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

/** Reads one client's changes.json tree and returns every correction in it,
 * split into the not-yet-learned ones and a count of the rest. Shared by
 * --propose and --apply so the two can never disagree about what is fresh. */
function scanCorrections(
	clientDir: string,
	usage: CoaUsage,
	only?: Set<string>,
): { fresh: Correction[]; skipped: number; scanned: number } {
	const clientTaxId = readClientTaxId(clientDir);
	const all: Correction[] = [];
	let scanned = 0;
	for (const file of findChangesFiles(clientDir)) {
		if (only && !only.has(file.key)) continue;
		const doc = readJson(file.path);
		if (!doc) continue;
		scanned += 1;
		const source: ChangesSource = { key: file.key, month_id: file.month_id, bucket: file.bucket, group_id: file.group_id };
		all.push(...accountCorrections(doc, source, buildContextLookup(file.groupDir, clientTaxId)));
	}
	return { ...freshCorrections(usage, all), scanned };
}

export function buildReport(clientDir: string): LearnReport {
	const usage = loadUsage(clientDir);
	const coaRows = loadCoaRows(clientDir);
	const { fresh, skipped, scanned } = scanCorrections(clientDir, usage);
	const corrections = fresh;
	const sources = [...new Set(corrections.map((c) => c.source.key))];

	return {
		schema: "ksk_learn_report.v1",
		client_dir: clientDir,
		scanned_files: scanned,
		skipped_already_learned: skipped,
		correction_count: corrections.length,
		sources,
		proposals: buildProposals(corrections, coaRows, usage),
	};
}

export function applyDecision(clientDir: string, decision: LearnDecision, nowIso: string): ApplyResult & { notesWritten: number } {
	const usageData = loadUsage(clientDir);
	const coaRows = loadCoaRows(clientDir);

	// Recompute the proposals from the decision's own source list rather than
	// trusting proposal bodies sent by a caller — the accept list is the only
	// thing taken on faith, and it is just a set of ids. Corrections already
	// learned are re-filtered here too, so a replayed or stale POST from a
	// still-open dialog can never double-count them.
	const { fresh } = scanCorrections(clientDir, usageData, new Set(decision.sources ?? []));
	const proposals = buildProposals(fresh, coaRows, usageData);
	const result = applyProposals(usageData, proposals, new Set(decision.accept ?? []), fresh, nowIso);
	writeAtomic(join(clientDir, "coa_usage.json"), `${JSON.stringify(usageData, null, 2)}\n`);

	const notes = (decision.notes ?? []).filter((n) => n && typeof n.title === "string" && typeof n.detail === "string");
	if (notes.length > 0) {
		const notesPath = join(clientDir, LEARNING_NOTES_FILE);
		const existing = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
		writeAtomic(notesPath, appendLearningNotes(existing, notes, nowIso));
	}
	return { ...result, notesWritten: notes.length };
}

async function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length !== 2) usage();
	const [mode, dirArg] = argv;
	const clientDir = resolveClientDir(dirArg);

	if (mode === "--propose") {
		console.log(JSON.stringify(buildReport(clientDir), null, 2));
		return;
	}
	if (mode === "--apply") {
		let decision: LearnDecision;
		try {
			decision = JSON.parse(await Bun.stdin.text());
		} catch {
			console.error("--apply expects a decision JSON on stdin");
			process.exit(2);
		}
		const result = applyDecision(clientDir, decision, new Date().toISOString());
		console.log(
			`learned: ${result.hintsAdded} hint(s) added, ${result.hintsUpdated} hint(s) updated, ` +
				`${result.taxIdCounts} tax_id count(s) added, ${result.notesWritten} note(s) recorded`,
		);
		return;
	}
	usage();
}

if (import.meta.main) await main();
