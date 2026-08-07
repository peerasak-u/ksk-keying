// Reading the workflow module's authoritative run state.
//
// Plan §8.1: "Stage/status/retry/gate truth | In-process orchestrator plus
// existing sequencer state persisted at rest points in `run-state.yaml`". This
// module reads that file — the SAME file, the SAME schema, the SAME path as
// `console/app/run-store.ts:42-64` — and never writes it. Plan §14.3's line for
// run-store.ts is "Preserve exact file schema/path and atomic writes"; the
// cheapest way to preserve them is to have no second writer at all, and in this
// slice Core has none.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { CoreError } from "../errors/core-error";
import { parseRawHumanStopEntries, type RawHumanStopEntry } from "../workflow/human-stop";
import { RUN_STATUSES, type RunStatus } from "../workflow/state-machine";

/** logic.ts:136-143 — the persisted sequencer state. */
export type PersistedState = {
	stageIndex: number;
	status: RunStatus;
	retryCount: number;
	humanStopEntries: RawHumanStopEntry[];
	/** logic.ts:160-162 keeps exactly the last 8 lines. */
	log: string[];
};

/** run-store.ts:25-38 — the record around it. */
export type RunRecord = {
	state: PersistedState;
	startedAt: string;
	updatedAt: string;
	finishedAt: string | null;
	/** Optional/backward-compatible: a run-state.yaml written before per-stage
	 * timing existed has no `stage_started_at` key at all, and absence maps to
	 * null rather than throwing (run-store.ts:30-37). */
	stageStartedAt: string | null;
};

export function runStatePath(monthDir: string): string {
	return join(monthDir, "ข้อมูลระบบ", "_pages", "run-state.yaml");
}

function isRunStatus(value: unknown): value is RunStatus {
	return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

function malformed(): CoreError {
	// §2.2's 422 row: "The request is well-formed but names a resource whose
	// *body* is unusable … An artifact on disk is malformed". Reporting "this
	// month never ran" for a corrupted state file would hide a real run behind a
	// silence, which is the failure mode §3.7 exists to prevent.
	return new CoreError("artifact_malformed", { details: { reason: "run_state_unparseable" } });
}

/** Read one client-month's run record, or `null` when the file is absent — a
 * client-month with no run-state.yaml simply has no record, and callers treat
 * that as "not started yet", not an error (run-store.ts:86-89). */
export async function readRunRecord(monthDir: string): Promise<RunRecord | null> {
	const path = runStatePath(monthDir);
	if (!existsSync(path)) return null;

	const text = await readFile(path, "utf8");
	// An EMPTY file is the only content that honestly means "absent": yamlParse
	// returns null for it, and run-store.ts:86-89 treats a run-state.yaml it
	// cannot load as a month that never ran. A file with bytes in it that parse
	// to a scalar — a truncated or garbage write that still lexes — is a
	// corrupted record and goes through malformed(), because reporting "this
	// month never ran" for it is exactly the silence §3.7 exists to prevent.
	if (text.trim() === "") return null;

	let doc: unknown;
	try {
		doc = yamlParse(text);
	} catch {
		throw malformed();
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw malformed();

	const record = doc as Record<string, unknown>;
	const state = record.state;
	if (!state || typeof state !== "object") throw malformed();
	const raw = state as Record<string, unknown>;

	if (!isRunStatus(raw.status)) throw malformed();
	if (typeof raw.stageIndex !== "number" || !Number.isInteger(raw.stageIndex) || raw.stageIndex < 0) throw malformed();

	return {
		state: {
			stageIndex: raw.stageIndex,
			status: raw.status,
			retryCount: typeof raw.retryCount === "number" ? raw.retryCount : 0,
			humanStopEntries: parseRawHumanStopEntries(raw.humanStopEntries),
			log: Array.isArray(raw.log) ? raw.log.filter((line): line is string => typeof line === "string") : [],
		},
		startedAt: typeof record.started_at === "string" ? record.started_at : "",
		updatedAt: typeof record.updated_at === "string" ? record.updated_at : "",
		finishedAt: typeof record.finished_at === "string" ? record.finished_at : null,
		stageStartedAt: typeof record.stage_started_at === "string" ? record.stage_started_at : null,
	};
}
