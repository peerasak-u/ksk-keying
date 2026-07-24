// Write path for the excluded/skip review page (wayfinder ticket #44, part of
// the #40 spec on issue #40). applyDecision is the pure core, shaped exactly
// like merge-dispositions.ts's mergeDispositions (existing entries + a change
// -> next entries) — confirmClaim is its thin I/O wrapper, atomic-writing
// dispositions.yaml the same way run-store.ts writes run-state.yaml.
//
// Only the "confirm" branch exists here; "bring_back" (and the repairRun
// trigger that must follow it) is ticket #46's scope — see
// https://github.com/peerasak-u/ksk-keying/issues/46.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { type DispositionEntry, unitKey } from "./review-claims";

export type { DispositionEntry };

export type Decision = "confirm";

export type ApplyDecisionResult = { ok: true; entries: DispositionEntry[] } | { ok: false; error: string };

/** Pure: given the FULL existing entry list and a target unit key, apply one
 * human decision. Confirm preserves the entry's reason/duplicate_of (the
 * human is agreeing with the agent's stated reason, not inventing a new
 * one) and seals it with declared_by: "human" — the existing
 * PROTECTED_DECLARERS mechanism (merge-dispositions.ts) then guarantees no
 * later agent run can silently re-flag it. */
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

	const exhaustive: never = decision;
	return { ok: false, error: `unsupported decision: ${exhaustive}` };
}

const DISPOSITIONS_SCHEMA = "ksk_dispositions.v1";

function dispositionsPath(clientDir: string): string {
	return join(clientDir, "ข้อมูลระบบ", "_pages", "dispositions.yaml");
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

	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmpPath, yamlStringify({ schema: doc?.schema ?? DISPOSITIONS_SCHEMA, entries: result.entries }), "utf8");
	renameSync(tmpPath, path);
	return result;
}
