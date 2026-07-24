// In-process run orchestrator (wayfinder ticket #31): a configurable-
// concurrency queue (default 1 — a de facto global FIFO) driving
// sequencer/logic.ts's state machine for every client-month, persisting
// through run-store.ts after every transition and notifying SSE subscribers.
//
// Dependency-injected exactly like logic.ts itself (see SequencerDeps) so
// this can be unit-tested with fakes — orchestrator.test.ts never spawns a
// real `claude -p`. The real app (server.ts) uses `orchestrator`, the
// singleton bound to the real spawnStage/runCompletionCheck/readHumanStop.
//
// Concurrency-slot policy (a judgment call this ticket had to make — ticket
// #31 decided the concurrency limit and queue existence, not this specific
// rule): a run only occupies a slot while its drive loop is actively
// running a stage. The moment it pauses — blocked, env-error, stopped-for-
// human, or done — its slot is released immediately, so one stuck client-
// month can never block every other queued client-month behind it. An
// explicit retryRun() re-enters the queue and may have to wait for a free
// slot again, same as a brand-new run.
import { join } from "node:path";
import { readHumanStop, runCompletionCheck } from "../sequencer/completion-check";
import {
	initialState,
	retryStage,
	runStage,
	STAGES,
	TERMINAL_STATUSES,
	type SequencerDeps,
	type State,
} from "../sequencer/logic";
import { spawnStage } from "../sequencer/spawn-stage";
import { listAllRunRecords, loadRunRecord, newRunRecord, saveRunRecord, type RunRecord } from "./run-store";

export type RunSummary = RunRecord & {
	relPath: string;
	clientId: string;
	monthId: string;
	queued: boolean;
	active: boolean;
};

const defaultSequencerDeps: SequencerDeps = {
	runStageProcess: spawnStage,
	runGate: runCompletionCheck,
	checkHumanStop: readHumanStop,
};

function splitRelPath(relPath: string): { clientId: string; monthId: string } {
	const slash = relPath.indexOf("/");
	if (slash === -1) return { clientId: relPath, monthId: "" };
	return { clientId: relPath.slice(0, slash), monthId: relPath.slice(slash + 1) };
}

function isResumable(status: State["status"]): boolean {
	return status === "idle";
}

function isRetryable(status: State["status"]): boolean {
	return status === "blocked" || status === "env-error";
}

export type ActionResult = { ok: true; run: RunSummary } | { ok: false; code: number; error: string };

export type Orchestrator = {
	boot(workspaceRoot: string, concurrency: number): Promise<void>;
	listRuns(): RunSummary[];
	getRun(relPath: string): RunSummary | undefined;
	enqueueRun(relPath: string): Promise<ActionResult>;
	retryRun(relPath: string): Promise<ActionResult>;
	repairRun(relPath: string): Promise<ActionResult>;
	subscribe(relPath: string, fn: (summary: RunSummary) => void): () => void;
};

export function createOrchestrator(deps: SequencerDeps = defaultSequencerDeps): Orchestrator {
	let workspaceRoot = "";
	let concurrency = 1;
	const registry = new Map<string, RunRecord>();
	const queue: string[] = [];
	const activeSlots = new Set<string>();
	const subscribers = new Map<string, Set<(summary: RunSummary) => void>>();

	function toSummary(relPath: string, record: RunRecord): RunSummary {
		return {
			...record,
			relPath,
			...splitRelPath(relPath),
			queued: queue.includes(relPath),
			active: activeSlots.has(relPath),
		};
	}

	function notify(relPath: string, record: RunRecord) {
		const summary = toSummary(relPath, record);
		for (const fn of subscribers.get(relPath) ?? []) fn(summary);
	}

	function persistAndNotify(relPath: string, record: RunRecord) {
		saveRunRecord(join(workspaceRoot, relPath), record);
		registry.set(relPath, record);
		notify(relPath, record);
	}

	function pump() {
		while (queue.length > 0 && activeSlots.size < concurrency) {
			const relPath = queue.shift()!;
			if (activeSlots.has(relPath)) continue;
			activeSlots.add(relPath);
			notify(relPath, registry.get(relPath)!); // queued -> active is itself a visible transition
			drive(relPath)
				.catch((err) => console.error(`orchestrator: run ${relPath} crashed out of its drive loop:`, err))
				.finally(() => {
					activeSlots.delete(relPath);
					notify(relPath, registry.get(relPath)!);
					pump();
				});
		}
	}

	async function drive(relPath: string): Promise<void> {
		const targetDir = join(workspaceRoot, relPath);
		for (;;) {
			const record = registry.get(relPath)!;
			if (TERMINAL_STATUSES.includes(record.state.status)) return;

			const nextState = isResumable(record.state.status)
				? await runStage(record.state, targetDir, deps)
				: await retryStage(record.state, targetDir, deps);

			const now = new Date().toISOString();
			const finished = TERMINAL_STATUSES.includes(nextState.status);
			const nextRecord: RunRecord = {
				state: nextState,
				startedAt: record.startedAt,
				updatedAt: now,
				finishedAt: finished ? now : null,
			};
			persistAndNotify(relPath, nextRecord);

			// Only "idle" (advanced to the next stage) continues the loop
			// automatically; every other status is a pause point.
			if (nextState.status !== "idle") return;
		}
	}

	function enqueueForProcessing(relPath: string) {
		if (activeSlots.has(relPath) || queue.includes(relPath)) return;
		queue.push(relPath);
		notify(relPath, registry.get(relPath)!);
		pump();
	}

	return {
		async boot(root: string, conc: number) {
			workspaceRoot = root;
			concurrency = conc;
			const all = await listAllRunRecords(root);
			for (const r of all) {
				const { clientId, monthId, relPath, ...record } = r;
				registry.set(relPath, record);
				if (isResumable(record.state.status)) queue.push(relPath);
			}
			pump();
		},

		listRuns() {
			return [...registry.entries()].map(([relPath, record]) => toSummary(relPath, record));
		},

		getRun(relPath: string) {
			const record = registry.get(relPath);
			return record ? toSummary(relPath, record) : undefined;
		},

		async enqueueRun(relPath: string): Promise<ActionResult> {
			const existing = registry.get(relPath) ?? (await loadRunRecord(join(workspaceRoot, relPath)));
			if (existing && !isResumable(existing.state.status)) {
				registry.set(relPath, existing);
				const error =
					existing.state.status === "done"
						? "งานนี้เสร็จสมบูรณ์แล้ว"
						: "ลูกค้ารายนี้มีการรันค้างอยู่แล้ว ใช้ปุ่มลองใหม่แทน";
				return { ok: false, code: 409, error };
			}
			if (!existing) {
				const fresh = newRunRecord();
				saveRunRecord(join(workspaceRoot, relPath), fresh);
				registry.set(relPath, fresh);
			} else {
				registry.set(relPath, existing);
			}
			enqueueForProcessing(relPath);
			return { ok: true, run: toSummary(relPath, registry.get(relPath)!) };
		},

		async retryRun(relPath: string): Promise<ActionResult> {
			const existing = registry.get(relPath);
			if (!existing) return { ok: false, code: 404, error: "ไม่พบงานนี้" };
			if (!isRetryable(existing.state.status)) {
				return { ok: false, code: 409, error: "งานนี้ไม่ได้อยู่ในสถานะที่ลองใหม่ได้" };
			}
			enqueueForProcessing(relPath);
			return { ok: true, run: toSummary(relPath, existing) };
		},

		async repairRun(relPath: string): Promise<ActionResult> {
			const existing = registry.get(relPath);
			if (!existing) return { ok: false, code: 404, error: "ไม่พบงานนี้" };
			if (activeSlots.has(relPath) || queue.includes(relPath)) {
				return {
					ok: false,
					code: 409,
					error: "งานนี้กำลังทำงานอยู่หรืออยู่ในคิว ไม่สามารถซ่อมได้ในขณะนี้",
				};
			}
			const now = new Date().toISOString();
			const freshRecord: RunRecord = {
				state: { ...initialState(), stageIndex: STAGES.findIndex((s) => s.id === "segment") },
				startedAt: now,
				updatedAt: now,
				finishedAt: null,
			};
			persistAndNotify(relPath, freshRecord);
			enqueueForProcessing(relPath);
			return { ok: true, run: toSummary(relPath, registry.get(relPath)!) };
		},

		subscribe(relPath: string, fn: (summary: RunSummary) => void) {
			let set = subscribers.get(relPath);
			if (!set) {
				set = new Set();
				subscribers.set(relPath, set);
			}
			set.add(fn);
			return () => {
				set!.delete(fn);
				if (set!.size === 0) subscribers.delete(relPath);
			};
		},
	};
}

/** The real singleton — bound to the real spawnStage/runCompletionCheck/
 * readHumanStop. server.ts calls boot() on this once at startup. */
export const orchestrator = createOrchestrator();
