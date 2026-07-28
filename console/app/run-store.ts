// Persisted per-client-month run state (wayfinder ticket #31: "inside the
// client-month's own ข้อมูลระบบ folder, as YAML"). This is the one thing that
// survives a server restart — the in-memory queue (orchestrator.ts) does
// not. A restart re-derives its queue by re-scanning every record here (see
// orchestrator.ts's boot()).
//
// Why "idle" is the only status the orchestrator auto-resumes on boot:
// runStage/retryStage never return with status "stage-running"/"gate-running"
// — those only exist transiently inside one in-flight call (see logic.ts).
// So the state actually persisted on disk is always a rest point: "idle"
// means "about to run this stage" (either freshly advanced from the previous
// one, or the last thing on disk before a crash mid-attempt) — safe to
// re-invoke the same stage from scratch either way, since every ksk-stage-*
// skill is self-sufficient from on-disk artifacts. blocked/env-error/fatal-cleanup/stopped/
// stopped-for-human/blocked-for-human are exactly the statuses that already
// require an explicit human action (retry/reset) even in the interactive
// TUI — a restart must not paper over that by auto-retrying them.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { initialState, type State } from "../sequencer/logic";
import { listClientMonths, type ClientMonth } from "./workspace";

export type RunRecord = {
	state: State;
	startedAt: string;
	updatedAt: string;
	finishedAt: string | null;
	// Optional/backward-compatible (dashboard ticket #2's "per-stage elapsed"):
	// when the run began working the CURRENT stageIndex — stamped by
	// orchestrator.ts every time stageIndex changes (including the very first
	// stage). A run-state.yaml written before this field existed has no
	// `stage_started_at` key at all; loadRunRecord below maps that absence to
	// `null` rather than throwing, and the dashboard card just omits its
	// "ขั้นนี้ N นาที" clause when this is null.
	stageStartedAt: string | null;
};

const RUN_STATE_SCHEMA = "ksk_run_state.v1";

function runStatePath(targetDir: string): string {
	return join(targetDir, "ข้อมูลระบบ", "_pages", "run-state.yaml");
}

export function newRunRecord(): RunRecord {
	const now = new Date().toISOString();
	return { state: initialState(), startedAt: now, updatedAt: now, finishedAt: null, stageStartedAt: now };
}

export async function loadRunRecord(targetDir: string): Promise<RunRecord | null> {
	const path = runStatePath(targetDir);
	if (!existsSync(path)) return null;
	const raw = await readFile(path, "utf8");
	const doc = yamlParse(raw);
	if (!doc || typeof doc !== "object") return null;
	return {
		state: doc.state,
		startedAt: doc.started_at,
		updatedAt: doc.updated_at,
		finishedAt: doc.finished_at ?? null,
		stageStartedAt: doc.stage_started_at ?? null,
	};
}

/** Writes via a temp-file-then-rename so a concurrent reader (or a crash
 * mid-write) never sees a half-written file. */
export function saveRunRecord(targetDir: string, record: RunRecord): void {
	const path = runStatePath(targetDir);
	mkdirSync(join(targetDir, "ข้อมูลระบบ", "_pages"), { recursive: true });
	const doc = {
		schema: RUN_STATE_SCHEMA,
		started_at: record.startedAt,
		updated_at: record.updatedAt,
		finished_at: record.finishedAt,
		stage_started_at: record.stageStartedAt ?? null,
		state: record.state,
	};
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmpPath, yamlStringify(doc), "utf8");
	renameSync(tmpPath, path);
}

export type RunRecordWithLocation = RunRecord & ClientMonth;

/** Every client-month that has ever been run at least once, across the whole
 * workspace. A client-month with no run-state.yaml simply has no record —
 * callers (the dashboard) treat that as "not started yet", not an error. */
export async function listAllRunRecords(workspaceRoot: string): Promise<RunRecordWithLocation[]> {
	const clientMonths = await listClientMonths(workspaceRoot);
	const records: RunRecordWithLocation[] = [];
	for (const cm of clientMonths) {
		const record = await loadRunRecord(join(workspaceRoot, cm.relPath));
		if (record) records.push({ ...record, ...cm });
	}
	return records;
}
