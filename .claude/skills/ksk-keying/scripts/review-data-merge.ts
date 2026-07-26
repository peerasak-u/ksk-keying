// Pure three-way merge for review-data.json rebuilds (wayfinder deterministic-
// flow ticket). Deleted the old "skip an unchanged group's rebuild" guard —
// build-review-data.ts now rebuilds EVERY group every run — so this module is
// what keeps a repair re-run from silently discarding a human reviewer's
// saved edits: it merges (baseline AI output, current possibly-edited file,
// fresh AI output) and hands back a document plus a full account of anything
// it could not carry forward.
//
// Zero imports, on purpose: no node:fs, no node:path, no Bun.*, no clock, no
// process.*, no randomness. Every JSON-shaped value comes in as a parameter
// and the caller (build-review-data.ts) owns all I/O and timestamps. This
// keeps the merge testable with plain in-memory fixtures and keeps the
// module honest that it never has side effects.
//
// The core distinction this file exists to make: "did the human change this
// field, or did the AI?" cannot be answered by comparing current-vs-fresh
// alone — a repair re-run's improved re-read looks identical to a human edit
// from that angle, and would revert the very fields a repair exists to fix.
// The baseline (the previous build's own output) is what makes the question
// answerable exactly: current !== baseline IS the definition of a human
// edit, nothing inferred.

export type ReviewDataObject = Record<string, unknown>;

export type BaselineState =
	| { kind: "absent" }
	| { kind: "unreadable"; detail: string }
	| { kind: "present"; data: ReviewDataObject };

export type CurrentState =
	| { kind: "absent" }
	| { kind: "unreadable"; detail: string }
	| { kind: "present"; data: ReviewDataObject };

export type MergeInput = {
	/** Manifest group id — used only for DroppedEdit item labels and notes. */
	groupId: string;
	/** Freshly built AI output, BEFORE source_content_hash is stamped. */
	fresh: ReviewDataObject;
	baseline: BaselineState;
	current: CurrentState;
};

export type DropReason = "ai_changed" | "item_not_matched" | "no_baseline";

export type DroppedEdit = {
	item: string;
	field: string;
	human_value: unknown;
	ai_before: unknown;
	ai_after: unknown;
	reason: DropReason;
};

export type MergeOutcome = "fresh" | "clean" | "merged" | "degraded" | "bailed";

export type MergeReport = {
	outcome: MergeOutcome;
	carried: number;
	lostSkips: number;
	dropped: DroppedEdit[];
	droppedTruncated: boolean;
	flags: string[];
	notes: string[];
};

export type MergeResult = { data: ReviewDataObject; report: MergeReport };

export const DROP_LIMIT = 200;
export const DROPPED_EDITS_HISTORY_LIMIT = 20;
export const REVIEW_DATA_FILE = "review-data.json";
export const REVIEW_DATA_AI_FILE = "review-data.ai.json";
export const REVIEW_DATA_SUPERSEDED_FILE = "review-data.superseded.json";
export const DROPPED_EDITS_FILE = "dropped-edits.json";
export const DROPPED_EDITS_SCHEMA = "ksk_review_dropped_edits.v1";

// NOTE on the adversarial review's blocker #1 (merge-injected review_flags /
// needs_attention being erased by the very next, automatic build-review-data
// invocation): fixed in the WIRING lane (build-review-data.ts's
// stickyFlagsFor/reconstructFlags), not here. That fix keys stickiness off
// dropped-edits.json's newest entry matching the CURRENT source_content_hash
// — exactly the alternative the reviewer's own suggested fix named as
// preferable ("if stickiness-forever is unacceptable... key durability off
// dropped-edits.json's newest entry") — and it requires no change to this
// module's exported surface at all: reconstructFlags rebuilds the same
// strings via flagLostSkips/flagLostEdits/FLAG_NO_BASELINE/FLAG_BAILED and
// build-review-data.ts re-injects them itself when the hash still matches. A
// core-side "carry forward any flag this module ever wrote, forever" was
// tried here first and reverted: it cannot see source_content_hash (out of
// scope for a pure function keyed only on ReviewDataObject content) and so
// cannot tell "still the same lossy build" from "sources changed and this
// rebuild is genuinely clean" — it would keep the warning forever, which
// conflicts with the wiring lane's (correct) hash-scoped behavior and its
// tests. See build-review-data.ts's comment above stickyFlagsFor for the
// full rationale.

export function flagLostSkips(count: number): string {
	return `⚠ สร้างข้อมูลตรวจทานใหม่: มีรายการที่เคยสั่ง "ข้าม" (ไม่ส่งออก) ${count} รายการที่ยกมาไม่ได้ และจะกลับมาถูกส่งออกอีกครั้ง — ตรวจสอบก่อนส่งออก PEAK`;
}

export function flagLostEdits(count: number): string {
	return `⚠ สร้างข้อมูลตรวจทานใหม่: การแก้ไขของผู้ตรวจทาน ${count} รายการถูกทับด้วยค่าที่ AI อ่านใหม่ — ดูรายละเอียดใน dropped-edits.json`;
}

export const FLAG_NO_BASELINE =
	'⚠ สร้างข้อมูลตรวจทานใหม่โดยไม่มีฐานเปรียบเทียบ (review-data.ai.json) — ค่าที่ผู้ตรวจทานเคยแก้ไว้อาจถูกทับ (ยกมาให้เฉพาะสถานะ "ข้าม" และบัญชีธนาคาร) ไฟล์เดิมเก็บไว้ที่ review-data.superseded.json — กรุณาตรวจสอบกลุ่มนี้ทั้งกลุ่ม';

export const FLAG_BAILED = "⚠ อ่านไฟล์ตรวจทานเดิมไม่ได้ จึงสร้างใหม่ทั้งหมด — ไฟล์เดิมเก็บไว้ที่ review-data.superseded.json";

// ---------------------------------------------------------------------------
// Fingerprints. All content-only — never a positional index — because a
// re-interpretation can change how many transactions/line items a group has,
// which shifts every index after the change. Matching on content is the only
// way to land an edit back on the SAME conceptual item after that shift.

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function num(v: unknown): string {
	return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function bool(v: unknown): string {
	return v === true ? "1" : v === false ? "0" : "";
}

/** Claim key buildDocumentReviewData builds its pages[] from (`${file}#${sheet}`
 * in spirit) — unique within a group by construction, and neither field is
 * human-editable, so it is also a safe key across baseline/current/fresh.
 * Deliberately excludes source_page/source_pages: a re-read that widens a
 * page span is still the same document and must keep its edits. */
export function pageKeyOf(page: ReviewDataObject): string {
	return `${str(page.source_src)} ${str(page.source_sheet)}`;
}

/** Content only — not account_code/sub_code/confidence/reason/needs_review,
 * because poirot legitimately re-categorizes on a rebuild and that must not
 * cost the line its description/amount edits. */
export function lineFingerprintOf(line: ReviewDataObject): string {
	return [str(line.description), num(line.qty), str(line.unit), num(line.unit_price), num(line.amount), bool(line.amount_includes_vat)].join(" ");
}

/** Excludes balance (the most OCR-fragile derived number) and the account
 * fields. Used for the baseline<->fresh hop, where both sides are pristine
 * AI output and fingerprinting on content is legitimate. */
export function rowFingerprintOf(row: ReviewDataObject): string {
	return [str(row.date_iso), str(row.direction), num(row.amount), str(row.description), str(row.counterparty)].join(" ");
}

/** The human-uneditable subset of a row's fields — description/amount are
 * editable via RowEdit so they cannot be in a degraded-mode key (the
 * "current" side has already been edited when there is no baseline). */
export function rowIdentityFingerprintOf(row: ReviewDataObject): string {
	return [str(row.date_iso), str(row.direction), str(row.counterparty), num(row.balance)].join(" ");
}

// ---------------------------------------------------------------------------
// Small generic helpers.

function isRecord(v: unknown): v is ReviewDataObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

function asRecordArray(v: unknown): ReviewDataObject[] {
	return asArray(v).map((x) => (isRecord(x) ? x : {}));
}

function asRecordOr(v: unknown, fallback: ReviewDataObject): ReviewDataObject {
	return isRecord(v) ? v : fallback;
}

function clone<T>(v: T): T {
	// Inputs are always JSON-shaped per this module's contract, so a
	// structured clone is exact and needs no imports.
	return structuredClone(v);
}

/** Duplicates within an array get an occurrence ordinal in array order; the
 * actual match key is `${fingerprint}#${ordinal}`. Deterministic, and a
 * mis-assignment can only happen between items that are byte-identical in
 * every fingerprinted field. */
function ordinalKeys<T>(items: T[], keyFn: (item: T) => string): string[] {
	const counts = new Map<string, number>();
	return items.map((item) => {
		const base = keyFn(item);
		const n = counts.get(base) ?? 0;
		counts.set(base, n + 1);
		return `${base}#${n}`;
	});
}

function accountComposite(row: ReviewDataObject): string {
	return `${(row.account_code as string | undefined) ?? ""}||${(row.sub_code as string | undefined) ?? ""}`;
}

/** Same composite shape as accountComposite, but for the statement's OWN
 * bank contra-account fields (bank_account_code/bank_sub_code) rather than a
 * line/row's account_code/sub_code — a distinct pair of keys on a distinct
 * object (statement{}, not a row). */
function bankAccountComposite(statement: ReviewDataObject): string {
	return `${(statement.bank_account_code as string | undefined) ?? ""}||${(statement.bank_sub_code as string | undefined) ?? ""}`;
}

function normalize(v: unknown): unknown {
	return v === undefined ? null : v;
}

function differs(a: unknown, b: unknown): boolean {
	return normalize(a) !== normalize(b);
}

// ---------------------------------------------------------------------------
// The three-way rule, applied to every human-writable field except `skipped`
// (skipped is "always-carry-forward" — handled separately, never via this
// rule, because it has no AI source at all: b is always false/absent).

type ThreeWay = { value: unknown; carried: boolean };

function threeWay(item: string, field: string, b: unknown, c: unknown, f: unknown, dropped: DroppedEdit[]): ThreeWay {
	const bn = normalize(b);
	const cn = normalize(c);
	const fn = normalize(f);
	if (cn === bn) return { value: f, carried: false }; // no human edit
	if (fn === bn) return { value: c, carried: true }; // human edited, AI unchanged
	if (fn === cn) return { value: f, carried: false }; // AI converged on the human's value
	dropped.push({ item, field, human_value: c, ai_before: b, ai_after: f, reason: "ai_changed" });
	return { value: f, carried: false }; // both changed — new AI value wins
}

// ---------------------------------------------------------------------------
// Shape checks (step 1/2/3 of the algorithm).

type Mode = "document" | "statement";

function shapeError(data: unknown, mode: Mode, expectedSchema: unknown, label: string): string | null {
	if (!isRecord(data)) return `${label} is not an object`;
	if (data.schema !== expectedSchema) return `schema mismatch: expected ${JSON.stringify(expectedSchema)}, got ${JSON.stringify(data.schema)}`;
	if (mode === "document") {
		if (!Array.isArray(data.pages)) return "missing pages[]";
	} else {
		if (!Array.isArray(data.rows)) return "missing rows[]";
		if (!isRecord(data.statement)) return "missing statement{}";
	}
	return null;
}

function pushFlags(data: ReviewDataObject, flags: string[]): void {
	const existing = Array.isArray(data.review_flags) ? (data.review_flags as unknown[]) : [];
	data.review_flags = [...existing, ...flags];
}

/** Document-mode pages forced to needs_attention when any flag was injected —
 * a no-op for statement-mode data (no `pages[]` there) so this can be called
 * unconditionally regardless of mode. */
function forceNeedsAttention(data: ReviewDataObject): void {
	if (!Array.isArray(data.pages)) return;
	data.pages = data.pages.map((p) => (isRecord(p) ? { ...p, initial_status: "needs_attention" } : p));
}

function bail(fresh: ReviewDataObject, notes: string[]): MergeResult {
	const data = clone(fresh);
	pushFlags(data, [FLAG_BAILED]);
	forceNeedsAttention(data);
	return {
		data,
		report: { outcome: "bailed", carried: 0, lostSkips: 0, dropped: [], droppedTruncated: false, flags: [FLAG_BAILED], notes },
	};
}

// ---------------------------------------------------------------------------
// Document mode.

const LINE_FIELDS = ["description", "qty", "unit", "unit_price", "amount", "amount_includes_vat", "vat_treatment"] as const;

function lineItemLabel(pageRef: string, lineIndex: unknown): string {
	return `${pageRef}#L${String(lineIndex)}`;
}

function pageRefLabel(freshPage: ReviewDataObject, currentPage: ReviewDataObject | undefined): string {
	if (currentPage && typeof currentPage.ref === "string") return currentPage.ref;
	if (typeof freshPage.ref === "string") return freshPage.ref;
	return pageKeyOf(freshPage);
}

/** Merges one page's `lines[]` in exact mode: current<->baseline paired by
 * stored line_index (edits patch in place, never reorder), baseline<->fresh
 * paired by lineFingerprintOf+ordinal (across a re-interpretation, indices
 * shift, so content is the only safe key). */
function mergeLinesExact(pageRef: string, freshLines: ReviewDataObject[], baselineLines: ReviewDataObject[], currentLines: ReviewDataObject[], dropped: DroppedEdit[]): { lines: ReviewDataObject[]; carried: number } {
	const baselineFpKeys = ordinalKeys(baselineLines, lineFingerprintOf);
	const baselineByFp = new Map(baselineFpKeys.map((k, i) => [k, baselineLines[i]]));
	const currentByIndex = new Map(currentLines.map((l) => [String(l.line_index), l]));
	const freshFpKeys = ordinalKeys(freshLines, lineFingerprintOf);
	const usedBaselineFp = new Set<string>();
	let carried = 0;

	const mergedLines = freshLines.map((f, i) => {
		const fpKey = freshFpKeys[i];
		const b = baselineByFp.get(fpKey);
		if (!b) return f;
		usedBaselineFp.add(fpKey);
		const c = currentByIndex.get(String(b.line_index));
		if (!c) return f;
		const item = lineItemLabel(pageRef, c.line_index);
		const merged: ReviewDataObject = { ...f };
		for (const key of LINE_FIELDS) {
			const r = threeWay(item, key, b[key], c[key], f[key], dropped);
			merged[key] = r.value;
			if (r.carried) carried++;
		}
		const rAccount = threeWay(item, "account_code", accountComposite(b), accountComposite(c), accountComposite(f), dropped);
		if (rAccount.carried) {
			merged.account_code = c.account_code;
			merged.sub_code = c.sub_code;
			merged.account_name_th = c.account_name_th;
			carried++;
		}
		return merged;
	});

	// Baseline lines with no fresh counterpart: a matched (via line_index)
	// current edit on them is genuinely gone — record it, don't silently drop.
	for (let i = 0; i < baselineLines.length; i++) {
		const fpKey = baselineFpKeys[i];
		if (usedBaselineFp.has(fpKey)) continue;
		const b = baselineLines[i];
		const c = currentByIndex.get(String(b.line_index));
		if (!c) continue;
		const item = lineItemLabel(pageRef, c.line_index);
		for (const key of LINE_FIELDS) {
			if (differs(c[key], b[key])) dropped.push({ item, field: key, human_value: c[key], ai_before: b[key], ai_after: null, reason: "item_not_matched" });
		}
		const bAccount = accountComposite(b);
		const cAccount = accountComposite(c);
		if (cAccount !== bAccount) dropped.push({ item, field: "account_code", human_value: cAccount, ai_before: bAccount, ai_after: null, reason: "item_not_matched" });
	}

	return { lines: mergedLines, carried };
}

const HUMAN_LINE_PROJECTION = [...LINE_FIELDS, "account_code", "sub_code", "account_name_th"] as const;

function lineProjection(line: ReviewDataObject): unknown {
	const out: ReviewDataObject = {};
	for (const key of HUMAN_LINE_PROJECTION) out[key] = normalize(line[key]);
	return out;
}

function linesProjectionDiffers(a: ReviewDataObject[], b: ReviewDataObject[]): boolean {
	if (a.length !== b.length) return true;
	for (let i = 0; i < a.length; i++) {
		if (JSON.stringify(lineProjection(a[i])) !== JSON.stringify(lineProjection(b[i]))) return true;
	}
	return false;
}

type PageMergeResult = { page: ReviewDataObject; carried: number; lostSkip: boolean; noBaseline: boolean };

function mergePageExact(freshPage: ReviewDataObject, baselinePage: ReviewDataObject | undefined, currentPage: ReviewDataObject | undefined, dropped: DroppedEdit[]): PageMergeResult {
	if (!currentPage) return { page: freshPage, carried: 0, lostSkip: false, noBaseline: false };
	const ref = pageRefLabel(freshPage, currentPage);
	let carried = 0;
	const freshFacts = asRecordOr(freshPage.facts, {});
	const currentFacts = asRecordOr(currentPage.facts, {});
	const baselineFacts = asRecordOr(baselinePage?.facts, {});
	const factKeys = new Set([...Object.keys(baselineFacts), ...Object.keys(currentFacts), ...Object.keys(freshFacts)]);
	const mergedFacts: ReviewDataObject = { ...freshFacts };
	for (const key of factKeys) {
		const r = threeWay(ref, `facts.${key}`, baselineFacts[key], currentFacts[key], freshFacts[key], dropped);
		mergedFacts[key] = r.value;
		if (r.carried) carried++;
	}

	const skipped = currentPage.skipped === true;
	if (skipped) carried++;

	let lines = asRecordArray(freshPage.lines);
	let noBaseline = false;
	if (baselinePage) {
		const merged = mergeLinesExact(ref, lines, asRecordArray(baselinePage.lines), asRecordArray(currentPage.lines), dropped);
		lines = merged.lines;
		carried += merged.carried;
	} else {
		// This page has no baseline counterpart even though the OVERALL merge
		// is running in exact mode (the sidecar exists but is missing this
		// page — e.g. build-review-data.ts crashed between writing
		// review-data.json and review-data.ai.json, leaving the sidecar one
		// build stale). Silently keeping the fresh lines here would drop a
		// human's line edits with zero record and outcome "clean" — the one
		// failure shape this module exists to prevent. Record it exactly like
		// the whole-group degraded case, per-page, and flag the group.
		const currentLines = asRecordArray(currentPage.lines);
		if (linesProjectionDiffers(currentLines, lines)) {
			dropped.push({ item: ref, field: "lines", human_value: currentPage.lines ?? [], ai_before: null, ai_after: freshPage.lines ?? [], reason: "no_baseline" });
			noBaseline = true;
		}
	}

	return { page: { ...freshPage, facts: mergedFacts, skipped, lines }, carried, lostSkip: false, noBaseline };
}

function mergePageDegraded(freshPage: ReviewDataObject, currentPage: ReviewDataObject | undefined, dropped: DroppedEdit[]): PageMergeResult {
	if (!currentPage) return { page: freshPage, carried: 0, lostSkip: false, noBaseline: false };
	const ref = pageRefLabel(freshPage, currentPage);
	let carried = 0;

	const freshFacts = asRecordOr(freshPage.facts, {});
	const currentFacts = asRecordOr(currentPage.facts, {});
	const factKeys = new Set([...Object.keys(currentFacts), ...Object.keys(freshFacts)]);
	for (const key of factKeys) {
		if (differs(currentFacts[key], freshFacts[key])) {
			dropped.push({ item: ref, field: `facts.${key}`, human_value: currentFacts[key], ai_before: null, ai_after: freshFacts[key] ?? null, reason: "no_baseline" });
		}
	}

	const skipped = currentPage.skipped === true;
	if (skipped) carried++;

	const freshLines = asRecordArray(freshPage.lines);
	const currentLines = asRecordArray(currentPage.lines);
	if (linesProjectionDiffers(currentLines, freshLines)) {
		dropped.push({ item: ref, field: "lines", human_value: currentPage.lines ?? [], ai_before: null, ai_after: freshPage.lines ?? [], reason: "no_baseline" });
	}

	return { page: { ...freshPage, facts: freshFacts, skipped, lines: freshLines }, carried, lostSkip: false, noBaseline: false };
}

function mergeDocument(
	groupId: string,
	fresh: ReviewDataObject,
	baselineData: ReviewDataObject | null,
	currentData: ReviewDataObject,
	degraded: boolean,
	dropped: DroppedEdit[],
): { pages: ReviewDataObject[]; carried: number; lostSkips: number; noBaseline: boolean } {
	const freshPages = asRecordArray(fresh.pages);
	const currentPages = asRecordArray(currentData.pages);
	const baselinePages = baselineData ? asRecordArray(baselineData.pages) : [];

	const freshKeys = ordinalKeys(freshPages, pageKeyOf);
	const currentKeys = ordinalKeys(currentPages, pageKeyOf);
	const baselineKeys = baselineData ? ordinalKeys(baselinePages, pageKeyOf) : [];
	const currentByKey = new Map(currentKeys.map((k, i) => [k, currentPages[i]]));
	const baselineByKey = new Map(baselineKeys.map((k, i) => [k, baselinePages[i]]));

	let carried = 0;
	let lostSkips = 0;
	let noBaseline = false;
	const usedCurrentKeys = new Set<string>();

	const mergedPages = freshPages.map((freshPage, i) => {
		const key = freshKeys[i];
		const c = currentByKey.get(key);
		if (c) usedCurrentKeys.add(key);
		const result = degraded ? mergePageDegraded(freshPage, c, dropped) : mergePageExact(freshPage, baselineByKey.get(key), c, dropped);
		carried += result.carried;
		if (result.noBaseline) noBaseline = true;
		return result.page;
	});

	// Current pages with no fresh counterpart at all: their edits are gone.
	for (let i = 0; i < currentPages.length; i++) {
		const key = currentKeys[i];
		if (usedCurrentKeys.has(key)) continue;
		const c = currentPages[i];
		const ref = typeof c.ref === "string" ? c.ref : key;
		if (c.skipped === true) {
			dropped.push({ item: ref, field: "skipped", human_value: true, ai_before: degraded ? null : false, ai_after: null, reason: "item_not_matched" });
			lostSkips++;
		}
		if (degraded) continue; // exact-mode-only: full field diff needs a baseline to compare against
		const b = baselineByKey.get(key);
		if (!b) {
			// A page that vanished from BOTH fresh and baseline (the sidecar is
			// one build stale and never saw this page either) — there is no
			// AI-side value at all to compare against for this current page's
			// content, so record it as no_baseline rather than silently
			// skipping it the way an untouched `continue` would.
			const currentFacts = asRecordOr(c.facts, {});
			for (const fk of Object.keys(currentFacts)) {
				dropped.push({ item: ref, field: `facts.${fk}`, human_value: currentFacts[fk], ai_before: null, ai_after: null, reason: "no_baseline" });
			}
			const currentLines = asRecordArray(c.lines);
			if (currentLines.length > 0) {
				dropped.push({ item: ref, field: "lines", human_value: c.lines ?? [], ai_before: null, ai_after: null, reason: "no_baseline" });
			}
			noBaseline = true;
			continue;
		}
		const baselineFacts = asRecordOr(b.facts, {});
		const currentFacts = asRecordOr(c.facts, {});
		const factKeys = new Set([...Object.keys(baselineFacts), ...Object.keys(currentFacts)]);
		for (const fk of factKeys) {
			if (differs(currentFacts[fk], baselineFacts[fk])) {
				dropped.push({ item: ref, field: `facts.${fk}`, human_value: currentFacts[fk], ai_before: baselineFacts[fk], ai_after: null, reason: "item_not_matched" });
			}
		}
		const baselineLines = asRecordArray(b.lines);
		const currentLines = asRecordArray(c.lines);
		const currentByIndex = new Map(currentLines.map((l) => [String(l.line_index), l]));
		for (const bl of baselineLines) {
			const cl = currentByIndex.get(String(bl.line_index));
			if (!cl) continue;
			const item = lineItemLabel(ref, cl.line_index);
			for (const lk of LINE_FIELDS) {
				if (differs(cl[lk], bl[lk])) dropped.push({ item, field: lk, human_value: cl[lk], ai_before: bl[lk], ai_after: null, reason: "item_not_matched" });
			}
			const bAcc = accountComposite(bl);
			const cAcc = accountComposite(cl);
			if (cAcc !== bAcc) dropped.push({ item, field: "account_code", human_value: cAcc, ai_before: bAcc, ai_after: null, reason: "item_not_matched" });
		}
	}

	return { pages: mergedPages, carried, lostSkips, noBaseline };
}

// ---------------------------------------------------------------------------
// Statement mode.

function rowItemLabel(groupId: string, rowIndex: unknown): string {
	return `${groupId}#R${String(rowIndex)}`;
}

type RowMergeResult = { row: ReviewDataObject; carried: number; lostSkip: boolean };

function mergeRowExact(groupId: string, f: ReviewDataObject, b: ReviewDataObject, c: ReviewDataObject, dropped: DroppedEdit[]): RowMergeResult {
	const item = rowItemLabel(groupId, c.row_index);
	let carried = 0;
	const rDesc = threeWay(item, "description", b.description, c.description, f.description, dropped);
	if (rDesc.carried) carried++;
	const rAmount = threeWay(item, "amount", b.amount, c.amount, f.amount, dropped);
	if (rAmount.carried) carried++;
	const rAccount = threeWay(item, "account_code", accountComposite(b), accountComposite(c), accountComposite(f), dropped);
	let account_code = f.account_code;
	let sub_code = f.sub_code;
	let account_name_th = f.account_name_th;
	if (rAccount.carried) {
		account_code = c.account_code;
		sub_code = c.sub_code;
		account_name_th = c.account_name_th;
		carried++;
	}
	const skipped = c.skipped === true;
	if (skipped) carried++;
	return {
		row: { ...f, description: rDesc.value, amount: rAmount.value, account_code, sub_code, account_name_th, skipped },
		carried,
		lostSkip: false,
	};
}

function mergeRowDegraded(groupId: string, f: ReviewDataObject, c: ReviewDataObject, dropped: DroppedEdit[]): RowMergeResult {
	const item = rowItemLabel(groupId, c.row_index);
	if (differs(c.description, f.description)) dropped.push({ item, field: "description", human_value: c.description, ai_before: null, ai_after: f.description ?? null, reason: "no_baseline" });
	if (differs(c.amount, f.amount)) dropped.push({ item, field: "amount", human_value: c.amount, ai_before: null, ai_after: f.amount ?? null, reason: "no_baseline" });
	const cAcc = accountComposite(c);
	const fAcc = accountComposite(f);
	if (cAcc !== fAcc) dropped.push({ item, field: "account_code", human_value: cAcc, ai_before: null, ai_after: fAcc, reason: "no_baseline" });
	const skipped = c.skipped === true;
	return { row: { ...f, skipped }, carried: skipped ? 1 : 0, lostSkip: false };
}

function mergeRows(
	groupId: string,
	freshRows: ReviewDataObject[],
	baselineRows: ReviewDataObject[] | null,
	currentRows: ReviewDataObject[],
	degraded: boolean,
	dropped: DroppedEdit[],
): { rows: ReviewDataObject[]; carried: number; lostSkips: number } {
	let carried = 0;
	let lostSkips = 0;

	if (degraded) {
		const currentKeysAll = ordinalKeys(currentRows, rowIdentityFingerprintOf);
		const currentByIdentity = new Map(currentKeysAll.map((k, i) => [k, currentRows[i]]));
		const freshIdentityKeys = ordinalKeys(freshRows, rowIdentityFingerprintOf);
		const usedCurrentKeys = new Set<string>();
		const rows = freshRows.map((f, i) => {
			const key = freshIdentityKeys[i];
			const c = currentByIdentity.get(key);
			if (!c) return f;
			usedCurrentKeys.add(key);
			const result = mergeRowDegraded(groupId, f, c, dropped);
			carried += result.carried;
			return result.row;
		});
		for (let i = 0; i < currentRows.length; i++) {
			if (usedCurrentKeys.has(currentKeysAll[i])) continue;
			const c = currentRows[i];
			if (c.skipped === true) {
				dropped.push({ item: rowItemLabel(groupId, c.row_index), field: "skipped", human_value: true, ai_before: null, ai_after: null, reason: "item_not_matched" });
				lostSkips++;
			}
		}
		return { rows, carried, lostSkips };
	}

	const baseline = baselineRows ?? [];
	const baselineFpKeys = ordinalKeys(baseline, rowFingerprintOf);
	const baselineByFp = new Map(baselineFpKeys.map((k, i) => [k, baseline[i]]));
	const currentByIndex = new Map(currentRows.map((r) => [String(r.row_index), r]));
	const freshFpKeys = ordinalKeys(freshRows, rowFingerprintOf);
	const usedBaselineFp = new Set<string>();

	const rows = freshRows.map((f, i) => {
		const fpKey = freshFpKeys[i];
		const b = baselineByFp.get(fpKey);
		if (!b) return f;
		usedBaselineFp.add(fpKey);
		const c = currentByIndex.get(String(b.row_index));
		if (!c) return f;
		const result = mergeRowExact(groupId, f, b, c, dropped);
		carried += result.carried;
		return result.row;
	});

	for (let i = 0; i < baseline.length; i++) {
		const fpKey = baselineFpKeys[i];
		if (usedBaselineFp.has(fpKey)) continue;
		const b = baseline[i];
		const c = currentByIndex.get(String(b.row_index));
		if (!c) continue;
		const item = rowItemLabel(groupId, c.row_index);
		if (c.skipped === true) {
			dropped.push({ item, field: "skipped", human_value: true, ai_before: false, ai_after: null, reason: "item_not_matched" });
			lostSkips++;
		}
		if (differs(c.description, b.description)) dropped.push({ item, field: "description", human_value: c.description, ai_before: b.description, ai_after: null, reason: "item_not_matched" });
		if (differs(c.amount, b.amount)) dropped.push({ item, field: "amount", human_value: c.amount, ai_before: b.amount, ai_after: null, reason: "item_not_matched" });
		const bAcc = accountComposite(b);
		const cAcc = accountComposite(c);
		if (cAcc !== bAcc) dropped.push({ item, field: "account_code", human_value: cAcc, ai_before: bAcc, ai_after: null, reason: "item_not_matched" });
	}

	return { rows, carried, lostSkips };
}

function mergeBankAccountKey(
	groupId: string,
	fresh: ReviewDataObject,
	baselineStatement: ReviewDataObject | null,
	currentStatement: ReviewDataObject,
	degraded: boolean,
	dropped: DroppedEdit[],
	notes: string[],
): { statement: ReviewDataObject; carried: number } {
	const freshStatement = asRecordOr(fresh.statement, {});
	const fComposite = bankAccountComposite(freshStatement);
	const cComposite = bankAccountComposite(currentStatement);

	if (degraded) {
		if (cComposite !== "||" && cComposite !== fComposite) {
			notes.push(`degraded merge: kept confirmed statement.bank_account_key "${cComposite}" over differing AI proposal "${fComposite}" (no baseline to tell confirmation from proposal)`);
			return { statement: { ...freshStatement, bank_account_code: currentStatement.bank_account_code, bank_sub_code: currentStatement.bank_sub_code }, carried: 0 };
		}
		return { statement: freshStatement, carried: 0 };
	}

	const bComposite = bankAccountComposite(asRecordOr(baselineStatement, {}));
	const item = groupId;
	const r = threeWay(item, "statement.bank_account_key", bComposite, cComposite, fComposite, dropped);
	if (r.carried) {
		return { statement: { ...freshStatement, bank_account_code: currentStatement.bank_account_code, bank_sub_code: currentStatement.bank_sub_code }, carried: 1 };
	}
	return { statement: freshStatement, carried: 0 };
}

function mergeStatement(
	groupId: string,
	fresh: ReviewDataObject,
	baselineData: ReviewDataObject | null,
	currentData: ReviewDataObject,
	degraded: boolean,
	dropped: DroppedEdit[],
	notes: string[],
): { statement: ReviewDataObject; rows: ReviewDataObject[]; carried: number; lostSkips: number } {
	const currentStatement = asRecordOr(currentData.statement, {});
	const baselineStatement = baselineData ? asRecordOr(baselineData.statement, {}) : null;
	const bankResult = mergeBankAccountKey(groupId, fresh, baselineStatement, currentStatement, degraded, dropped, notes);

	const freshRows = asRecordArray(fresh.rows);
	const currentRows = asRecordArray(currentData.rows);
	const baselineRows = baselineData ? asRecordArray(baselineData.rows) : null;
	const rowResult = mergeRows(groupId, freshRows, baselineRows, currentRows, degraded, dropped);

	return {
		statement: bankResult.statement,
		rows: rowResult.rows,
		carried: bankResult.carried + rowResult.carried,
		lostSkips: rowResult.lostSkips,
	};
}

// ---------------------------------------------------------------------------
// Entry point.

export function mergeReviewData(input: MergeInput): MergeResult {
	const { groupId, fresh, baseline, current } = input;

	const freshSchema = isRecord(fresh) ? fresh.schema : undefined;
	let mode: Mode;
	if (freshSchema === "ksk_review_group_data.v1") mode = "document";
	else if (freshSchema === "ksk_review_statement_data.v1") mode = "statement";
	else if (current.kind === "absent") {
		// No prior file at all — nothing human is at risk, so this is not a
		// bail (which would flag a brand-new group for no reason). Just build
		// fresh with a note; the schema oddity is the fresh builder's problem,
		// not this module's, when there is no human work to protect.
		return {
			data: clone(isRecord(fresh) ? fresh : {}),
			report: { outcome: "fresh", carried: 0, lostSkips: 0, dropped: [], droppedTruncated: false, flags: [], notes: [`unrecognized fresh schema ${JSON.stringify(freshSchema)} (no current file, nothing at risk)`] },
		};
	} else return bail(isRecord(fresh) ? fresh : {}, [`unrecognized fresh schema ${JSON.stringify(freshSchema)}`]);

	if (current.kind === "absent") {
		return { data: clone(fresh), report: { outcome: "fresh", carried: 0, lostSkips: 0, dropped: [], droppedTruncated: false, flags: [], notes: [] } };
	}

	if (current.kind === "unreadable") {
		return bail(fresh, [`current review-data.json unreadable: ${current.detail}`]);
	}

	const currentShapeIssue = shapeError(current.data, mode, freshSchema, "current review-data.json");
	if (currentShapeIssue) {
		return bail(fresh, [currentShapeIssue]);
	}
	const currentData = current.data;

	const notes: string[] = [];
	if (typeof currentData.group_id === "string" && currentData.group_id !== groupId) {
		// Deliberately not a bail — the folder is the identity; group_id comes
		// from agent-written interpretation.json and can legitimately drift.
		notes.push(`current group_id "${currentData.group_id}" differs from manifest group id "${groupId}" (not treated as a bail — folder is the identity)`);
	}

	let baselineData: ReviewDataObject | null = null;
	let degraded = false;
	if (baseline.kind === "present") {
		const baselineShapeIssue = shapeError(baseline.data, mode, freshSchema, "review-data.ai.json (baseline)");
		if (baselineShapeIssue) {
			degraded = true;
			notes.push(`baseline unusable (${baselineShapeIssue}) — running degraded merge`);
		} else if (typeof baseline.data.group_id === "string" && typeof currentData.group_id === "string" && baseline.data.group_id !== currentData.group_id) {
			degraded = true;
			notes.push(`baseline group_id "${baseline.data.group_id}" differs from current group_id "${currentData.group_id}" — treating baseline as unusable, running degraded merge`);
		} else {
			baselineData = baseline.data;
		}
	} else if (baseline.kind === "unreadable") {
		degraded = true;
		notes.push(`baseline unreadable (${baseline.detail}) — running degraded merge`);
	} else {
		degraded = true; // no baseline exists and none can be derived
	}

	const dropped: DroppedEdit[] = [];
	let carried = 0;
	let lostSkips = 0;
	let data: ReviewDataObject;
	// Set when the OVERALL merge has a baseline (degraded === false) but one
	// or more individual pages did not (a sidecar one build stale relative to
	// review-data.json — see mergePageExact/mergeDocument). Treated the same
	// as the whole-group degraded case for flag/needs_attention purposes,
	// without downgrading the other pages' outcome to "degraded".
	let pageNoBaseline = false;

	if (mode === "document") {
		const result = mergeDocument(groupId, fresh, baselineData, currentData, degraded, dropped);
		carried += result.carried;
		lostSkips += result.lostSkips;
		pageNoBaseline = result.noBaseline;
		data = { ...clone(fresh), pages: result.pages };
	} else {
		const result = mergeStatement(groupId, fresh, baselineData, currentData, degraded, dropped, notes);
		carried += result.carried;
		lostSkips += result.lostSkips;
		data = { ...clone(fresh), statement: result.statement, rows: result.rows };
	}

	let droppedTruncated = false;
	let finalDropped = dropped;
	if (dropped.length > DROP_LIMIT) {
		const omitted = dropped.length - DROP_LIMIT;
		finalDropped = dropped.slice(0, DROP_LIMIT);
		droppedTruncated = true;
		notes.push(`dropped-edit record truncated at ${DROP_LIMIT}; ${omitted} additional dropped edit(s) omitted (see review-data.superseded.json for the untruncated truth)`);
	}

	// Count from the UNTRUNCATED list — finalDropped is only the truncated
	// slice written to the report/dropped-edits.json payload. Counting from
	// finalDropped would understate (or, in the pathological case where the
	// first DROP_LIMIT entries are all field:"skipped", entirely suppress)
	// the flag shown to the reviewer.
	const otherDropped = dropped.filter((d) => d.field !== "skipped").length;
	const flags: string[] = [];
	if (lostSkips > 0) flags.push(flagLostSkips(lostSkips));
	if (otherDropped > 0) flags.push(flagLostEdits(otherDropped));
	if (degraded) {
		flags.push(FLAG_NO_BASELINE);
		notes.push("no usable baseline (review-data.ai.json) for this rebuild — pre-rebuild file preserved as review-data.superseded.json");
	} else if (pageNoBaseline) {
		flags.push(FLAG_NO_BASELINE);
		notes.push("one or more pages had no baseline counterpart even though the group's sidecar exists (stale by one build) — those pages' line/fact edits could not be exactly reconciled");
	}

	if (flags.length > 0) {
		pushFlags(data, flags);
		forceNeedsAttention(data);
	}

	let outcome: MergeOutcome;
	if (degraded) outcome = "degraded";
	else if (carried > 0 || finalDropped.length > 0) outcome = "merged";
	else outcome = "clean";

	return {
		// Deep clone before returning: several code paths above hand back
		// pieces straight from `fresh` (an unmatched page, an untouched
		// statement{}) rather than a copy of it, so `data` would otherwise
		// alias sub-objects of the caller's `fresh` — the exact object the
		// pristine review-data.ai.json sidecar is written from in the same
		// build-review-data loop iteration. A future in-place edit of
		// `data.pages[i]`/`data.statement` by the caller would then silently
		// poison the next build's baseline. The docstring promises a deep
		// clone; make that true rather than "true so far, by accident".
		data: clone(data),
		report: { outcome, carried, lostSkips, dropped: finalDropped, droppedTruncated, flags, notes },
	};
}

// ---------------------------------------------------------------------------
// dropped-edits.json history — append-only, capped, pure.

export type DroppedEditsRebuild = {
	rebuilt_at: string;
	outcome: MergeOutcome;
	source_content_hash: string;
	carried: number;
	notes: string[];
	dropped: DroppedEdit[];
};

export type DroppedEditsFile = {
	schema: typeof DROPPED_EDITS_SCHEMA;
	group_id: string;
	rebuilds: DroppedEditsRebuild[];
};

export function appendDroppedEdits(existing: unknown, groupId: string, entry: DroppedEditsRebuild): DroppedEditsFile {
	const kept: DroppedEditsRebuild[] = isRecord(existing) && Array.isArray(existing.rebuilds) ? (existing.rebuilds as DroppedEditsRebuild[]) : [];
	const rebuilds = [...kept, entry].slice(-DROPPED_EDITS_HISTORY_LIMIT);
	return { schema: DROPPED_EDITS_SCHEMA, group_id: groupId, rebuilds };
}
