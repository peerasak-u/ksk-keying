// Write path for the excluded/skip review page (wayfinder ticket #44, part of
// the #40 spec on issue #40). applyDecision is the pure core, shaped exactly
// like merge-dispositions.ts's mergeDispositions (existing entries + a change
// -> next entries) — confirmClaim/bringBackClaim are its thin I/O wrappers,
// atomic-writing dispositions.yaml the same way run-store.ts writes
// run-state.yaml.
//
// "confirm" (ticket #44) and "bring_back" (ticket #46, part of the #40 spec)
// both live here; the repairRun trigger that must follow a bring_back lives
// in orchestrator.ts (Orchestrator.repairRun) and is wired in server.ts's
// claims/bring-back route right after bringBackClaim — see
// https://github.com/peerasak-u/ksk-keying/issues/46.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { type DispositionEntry, unitKey } from "./review-claims";

export type { DispositionEntry };

export type Decision = "confirm" | "bring_back";

export type ApplyDecisionResult = { ok: true; entries: DispositionEntry[] } | { ok: false; error: string };

/** Pure: given the FULL existing entry list and a target unit key, apply one
 * human decision. Confirm preserves the entry's reason/duplicate_of (the
 * human is agreeing with the agent's stated reason, not inventing a new
 * one) and seals it with declared_by: "human" — the existing
 * PROTECTED_DECLARERS mechanism (merge-dispositions.ts) then guarantees no
 * later agent run can silently re-flag it. Bring_back is the inverse: the
 * human says the exclusion was wrong, so the entry is replaced with a fresh
 * minimal { disposition: "used", declared_by: "human" } — reason,
 * duplicate_of, and note are all cleared by omission since none of them
 * describe a "used" unit. */
export function applyDecision(existing: DispositionEntry[], targetUnitKey: string, decision: Decision): ApplyDecisionResult {
	const index = existing.findIndex((e) => unitKey(e) === targetUnitKey);
	if (index === -1) return { ok: false, error: `ไม่พบรายการ "${targetUnitKey}" ใน dispositions.yaml` };
	const entry = existing[index];
	if (entry.disposition !== "excluded" || (entry.declared_by !== "agent" && entry.declared_by !== "agent_policy")) {
		return { ok: false, error: `รายการ "${targetUnitKey}" ไม่ใช่ข้อเสนอตัดออกที่รอตรวจสอบ (อาจถูกตรวจสอบไปแล้ว)` };
	}
	// Same invariant merge-dispositions.ts's parseEntries enforces at write
	// time (reason required when excluded) — re-checked here since this is a
	// second, independent writer of the same file.
	if (!entry.reason) {
		return { ok: false, error: `รายการ "${targetUnitKey}" ไม่มี reason ที่ระบุไว้ — dispositions.yaml อาจเสียหาย` };
	}

	if (decision === "confirm") {
		const next = [...existing];
		next[index] = { ...entry, declared_by: "human" };
		return { ok: true, entries: next };
	}

	if (decision === "bring_back") {
		const next = [...existing];
		next[index] = { file: entry.file, page: entry.page, sheet: entry.sheet, disposition: "used", declared_by: "human" };
		return { ok: true, entries: next };
	}

	const exhaustive: never = decision;
	return { ok: false, error: `unsupported decision: ${exhaustive}` };
}

const DISPOSITIONS_SCHEMA = "ksk_dispositions.v1";

function dispositionsPath(clientDir: string): string {
	return join(clientDir, "ข้อมูลระบบ", "_pages", "dispositions.yaml");
}

function writeDispositionsFile(path: string, schema: string | undefined, entries: DispositionEntry[]): void {
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmpPath, yamlStringify({ schema: schema ?? DISPOSITIONS_SCHEMA, entries }), "utf8");
	renameSync(tmpPath, path);
}

/** Thin I/O wrapper: read dispositions.yaml, apply one decision, write back
 * atomically (temp-file-then-rename, same as run-store.ts's saveRunRecord —
 * a concurrent reader never sees a half-written file). */
export async function confirmClaim(clientDir: string, targetUnitKey: string): Promise<ApplyDecisionResult> {
	const path = dispositionsPath(clientDir);
	if (!existsSync(path)) return { ok: false, error: "ยังไม่มี dispositions.yaml สำหรับลูกค้ารายนี้" };
	const doc = yamlParse(await readFile(path, "utf8")) as { schema?: string; entries?: DispositionEntry[] } | null;
	const entries = doc?.entries ?? [];
	const result = applyDecision(entries, targetUnitKey, "confirm");
	if (!result.ok) return result;

	writeDispositionsFile(path, doc?.schema, result.entries);
	return result;
}

export type BringBackClaimResult =
	| { ok: true; entries: DispositionEntry[]; revert: () => void }
	| { ok: false; error: string };

/** Thin I/O wrapper: read dispositions.yaml, apply one bring_back decision,
 * write back atomically (temp-file-then-rename, same as confirmClaim above).
 * On success, also returns revert(): the server route triggers
 * Orchestrator.repairRun immediately after a successful bring-back, and that
 * call can still fail its own active/queued check (a narrow race — the page
 * guard already checked once, but this function's own read/write is a real
 * await point another request can land in between). Without a way back, that
 * race would strand dispositions.yaml showing "used" with no run ever
 * requeued and no UI path to retry. revert() re-writes the exact pre-change
 * entries array atomically so the server can restore it on that failure. */
export async function bringBackClaim(clientDir: string, targetUnitKey: string): Promise<BringBackClaimResult> {
	const path = dispositionsPath(clientDir);
	if (!existsSync(path)) return { ok: false, error: "ยังไม่มี dispositions.yaml สำหรับลูกค้ารายนี้" };
	const doc = yamlParse(await readFile(path, "utf8")) as { schema?: string; entries?: DispositionEntry[] } | null;
	const entries = doc?.entries ?? [];
	const result = applyDecision(entries, targetUnitKey, "bring_back");
	if (!result.ok) return result;

	writeDispositionsFile(path, doc?.schema, result.entries);
	return {
		ok: true,
		entries: result.entries,
		revert: () => writeDispositionsFile(path, doc?.schema, entries),
	};
}
