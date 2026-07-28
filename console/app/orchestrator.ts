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
import { abortAllSupervisedProcesses } from "../sequencer/process-supervisor";
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
	/** Cancel an active/queued run and wait until its owned child group is gone. */
	stopRun(relPath: string): Promise<ActionResult>;
	/** Stop accepting work, abort active attempts, and wait for their cleanup. */
	shutdown(): Promise<void>;
	subscribe(relPath: string, fn: (summary: RunSummary) => void): () => void;
	/** Fires for every relPath's transition, not just one — the dashboard's
	 * live-updates SSE stream (wayfinder #49) subscribes globally instead of
	 * opening one connection per visible month. */
	subscribeAll(fn: (summary: RunSummary) => void): () => void;
};

export function createOrchestrator(deps: SequencerDeps = defaultSequencerDeps): Orchestrator {
	let workspaceRoot = "";
	let concurrency = 1;
	const registry = new Map<string, RunRecord>();
	const queue: string[] = [];
	const activeSlots = new Set<string>();
	const activeControllers = new Map<string, AbortController>();
	const activeDrives = new Map<string, Promise<void>>();
	const subscribers = new Map<string, Set<(summary: RunSummary) => void>>();
	const globalSubscribers = new Set<(summary: RunSummary) => void>();
	let shuttingDown = false;
	let fatalCleanupLatched = false;

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
		for (const fn of globalSubscribers) fn(summary);
	}

	function persistAndNotify(relPath: string, record: RunRecord) {
		saveRunRecord(join(workspaceRoot, relPath), record);
		registry.set(relPath, record);
		notify(relPath, record);
	}

	function hasFatalCleanup() {
		return fatalCleanupLatched;
	}

	function pump() {
		if (shuttingDown || hasFatalCleanup()) return;
		while (queue.length > 0 && activeSlots.size < concurrency) {
			const relPath = queue.shift()!;
			if (activeSlots.has(relPath)) continue;
			activeSlots.add(relPath);
			const controller = new AbortController();
			activeControllers.set(relPath, controller);
			notify(relPath, registry.get(relPath)!); // queued -> active is itself a visible transition
			const promise = drive(relPath, controller.signal)
				.catch((err) => console.error(`orchestrator: run ${relPath} crashed out of its drive loop:`, err))
				.finally(() => {
					activeSlots.delete(relPath);
					activeControllers.delete(relPath);
					activeDrives.delete(relPath);
					notify(relPath, registry.get(relPath)!);
					if (!shuttingDown) pump();
				});
			activeDrives.set(relPath, promise);
		}
	}

	async function drive(relPath: string, signal: AbortSignal): Promise<void> {
		const targetDir = join(workspaceRoot, relPath);
		for (;;) {
			const record = registry.get(relPath)!;
			if (TERMINAL_STATUSES.includes(record.state.status)) return;

			const nextState = isResumable(record.state.status)
				? await runStage(record.state, targetDir, deps, signal)
				: await retryStage(record.state, targetDir, deps, signal);

			const now = new Date().toISOString();
			const finished = TERMINAL_STATUSES.includes(nextState.status);
			// Stamped every time stageIndex actually moves (including the very
			// first attempt, when record.stageStartedAt is still unset) — this is
			// the ONLY place stageStartedAt changes, so the dashboard's "ขั้นนี้ N
			// นาที" clause always measures time in the CURRENT stage, never a
			// stale one left over from an earlier stageIndex.
			const stageChanged = record.stageStartedAt == null || nextState.stageIndex !== record.state.stageIndex;
			const nextRecord: RunRecord = {
				state: nextState,
				startedAt: record.startedAt,
				updatedAt: now,
				finishedAt: finished ? now : null,
				stageStartedAt: stageChanged ? now : record.stageStartedAt,
			};
			persistAndNotify(relPath, nextRecord);
			if (nextState.status === "fatal-cleanup") {
				fatalCleanupLatched = true;
				for (const [otherPath, controller] of activeControllers) {
					if (otherPath !== relPath) controller.abort("another run failed process cleanup");
				}
				await abortAllSupervisedProcesses();
				return;
			}

			// Only "idle" (advanced to the next stage) continues the loop
			// automatically; every other status is a pause point.
			if (nextState.status !== "idle") return;
		}
	}

	function enqueueForProcessing(relPath: string) {
		if (shuttingDown) return;
		if (activeSlots.has(relPath) || queue.includes(relPath)) return;
		queue.push(relPath);
		notify(relPath, registry.get(relPath)!);
		pump();
	}

	return {
		async boot(root: string, conc: number) {
			shuttingDown = false;
			// A fatal cleanup latch is intentionally process-local. Restarting
			// the app/container is the operator action that clears it; the
			// persisted run remains fatal until explicitly repaired.
			fatalCleanupLatched = false;
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
			if (hasFatalCleanup()) return { ok: false, code: 503, error: "ระบบหยุดเพื่อความปลอดภัยหลังเก็บ process ไม่สำเร็จ กรุณา restart app/container" };
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
			if (hasFatalCleanup()) return { ok: false, code: 503, error: "ระบบหยุดเพื่อความปลอดภัยหลังเก็บ process ไม่สำเร็จ กรุณา restart app/container" };
			const existing = registry.get(relPath);
			if (!existing) return { ok: false, code: 404, error: "ไม่พบงานนี้" };
			if (!isRetryable(existing.state.status)) {
				return { ok: false, code: 409, error: "งานนี้ไม่ได้อยู่ในสถานะที่ลองใหม่ได้" };
			}
			enqueueForProcessing(relPath);
			return { ok: true, run: toSummary(relPath, existing) };
		},

		async repairRun(relPath: string): Promise<ActionResult> {
			if (hasFatalCleanup()) return { ok: false, code: 503, error: "ระบบหยุดเพื่อความปลอดภัยหลังเก็บ process ไม่สำเร็จ กรุณา restart app/container" };
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
				stageStartedAt: now,
			};
			persistAndNotify(relPath, freshRecord);
			enqueueForProcessing(relPath);
			return { ok: true, run: toSummary(relPath, registry.get(relPath)!) };
		},

		async stopRun(relPath: string): Promise<ActionResult> {
			const existing = registry.get(relPath);
			if (!existing) return { ok: false, code: 404, error: "ไม่พบงานนี้" };
			let removed = false;
			for (let index = queue.indexOf(relPath); index !== -1; index = queue.indexOf(relPath)) {
				queue.splice(index, 1);
				removed = true;
			}
			const controller = activeControllers.get(relPath);
			if (!controller) {
				if (removed) {
					const now = new Date().toISOString();
					persistAndNotify(relPath, {
						...existing,
						state: { ...existing.state, status: "stopped", log: [...existing.state.log, "run: cancelled while queued"].slice(-8) },
						updatedAt: now,
						finishedAt: now,
					});
					return { ok: true, run: toSummary(relPath, registry.get(relPath)!) };
				}
				return { ok: false, code: 409, error: "งานนี้ไม่ได้กำลังทำงานอยู่" };
			}
			controller.abort();
			await activeDrives.get(relPath);
			return { ok: true, run: toSummary(relPath, registry.get(relPath)!) };
		},

		async shutdown() {
			if (shuttingDown) return;
			shuttingDown = true;
			const cancelled = queue.splice(0);
			for (const relPath of cancelled) {
				const record = registry.get(relPath);
				if (!record) continue;
				const now = new Date().toISOString();
				persistAndNotify(relPath, {
					...record,
					state: { ...record.state, status: "stopped", log: [...record.state.log, "run: cancelled during server shutdown"].slice(-8) },
					updatedAt: now,
					finishedAt: now,
				});
			}
			for (const controller of activeControllers.values()) controller.abort();
			// Safety net for a process started by a real dependency just before its
			// per-run signal was installed. Each supervisor still owns and reaps its
			// own group before this waits resolve.
			await abortAllSupervisedProcesses();
			await Promise.allSettled([...activeDrives.values()]);
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

		subscribeAll(fn: (summary: RunSummary) => void) {
			globalSubscribers.add(fn);
			return () => {
				globalSubscribers.delete(fn);
			};
		},
	};
}

/** The real singleton — bound to the real spawnStage/runCompletionCheck/
 * readHumanStop. server.ts calls boot() on this once at startup. */
export const orchestrator = createOrchestrator();
