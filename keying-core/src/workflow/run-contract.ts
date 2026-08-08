// §1.7's `run` object — the one neutral DTO every route that describes a run
// returns.
//
// Plan §9.3 is the constraint it is built to: the raw sequencer status
// survives, `queued` and `active` stay separate booleans because they describe
// scheduler state rather than sequencer state, and the one additive derived
// category (`observedStatus`) never replaces the raw status.
import { stageRef, type StageRef } from "./stages";
import { enrichHumanStopEntries, joinStopConditions, type EnrichContext, type HumanStopEntry } from "./human-stop";
import { observedStatus, retriesRemaining, type MachineState, type ObservedStatus, type RunStatus } from "./state-machine";
import type { RunRecord } from "../workspace/run-record";
import type { RepairImpact } from "../workspace/workspace-repository";

/** Stored verbatim and never interpreted (plan §7.2, §10.1). Core echoes it
 * back; it does not know what a project is. */
export type ExternalRef = Record<string, unknown>;

/** §1.7's `counts` — the headline counts the platform caches (plan §2.4).
 * `null` until the `final` gate has written them. */
export type RunCounts = {
	totalUnits: number;
	reviewed: number;
	excluded: number;
	groupCount: number;
	attention: number;
};

export type RunProjection = {
	/** [C-03]: the same opaque token as `jobId`. */
	runRef: string;
	jobId: string;
	workspaceRelPath: string;
	clientKey: string;
	monthId: string;
	/** The PERSISTED sequencer status, verbatim (logic.ts:117-127). */
	status: RunStatus;
	observedStatus: ObservedStatus;
	queued: boolean;
	active: boolean;
	hasRunRecord: boolean;
	stage: StageRef;
	retryCount: number;
	retriesRemaining: number | null;
	humanStop: HumanStopEntry[];
	lastLogLine: string | null;
	failReason: string | null;
	counts: RunCounts | null;
	/** [C-38]. Present on the single-subject reads and on both `repair`
	 * responses; the KEY IS ABSENT — §1.3's missing-key rule, not `null` — from
	 * the list routes and from every SSE payload, because computing it costs one
	 * filesystem read per group. */
	repairImpact?: RepairImpact;
	startedAt: string | null;
	stageStartedAt: string | null;
	updatedAt: string | null;
	finishedAt: string | null;
	externalRef: ExternalRef | null;
	requestedBy: string | null;
	version: number;
};

/** The statuses for which §1.7 says `failReason` is populated: "`null` when the
 * run has not failed or stopped". `idle`, `done` and the two transient running
 * statuses are the complement. */
const FAILED_OR_STOPPED: readonly RunStatus[] = [
	"blocked",
	"env-error",
	"fatal-cleanup",
	"stopped",
	"stopped-for-human",
	"blocked-for-human",
];

export type RunProjectionInput = {
	jobId: string;
	workspaceRelPath: string;
	clientKey: string;
	monthId: string;
	record: RunRecord | null;
	queued: boolean;
	active: boolean;
	counts: RunCounts | null;
	repairImpact?: RepairImpact;
	externalRef: ExternalRef | null;
	requestedBy: string | null;
	version: number;
	enrich?: EnrichContext;
};

/** The machine state a run record implies. §1.7: with no run record the status
 * is `idle`, the stage is stage 0, and the timestamps are null — which is
 * already what the runtime reports (`dashboard.ts:80`). */
export function machineStateOf(input: Pick<RunProjectionInput, "record" | "queued" | "active">): MachineState {
	const record = input.record;
	return {
		status: record?.state.status ?? "idle",
		queued: input.queued,
		active: input.active,
		hasRunRecord: record !== null,
		stageIndex: record?.state.stageIndex ?? 0,
		retryCount: record?.state.retryCount ?? 0,
	};
}

export function buildRunProjection(input: RunProjectionInput): RunProjection {
	const record = input.record;
	const state = machineStateOf(input);
	const rawHumanStop = record?.state.humanStopEntries ?? [];

	// §1.7: `humanStop` is "Empty unless `status` is `stopped-for-human`". The
	// entries stay on disk after a repair (logic.ts:64 never clears the file),
	// so gating on the status is what stops a resolved stop from reappearing.
	const humanStop: HumanStopEntry[] =
		state.status === "stopped-for-human"
			? enrichHumanStopEntries(rawHumanStop, {
					jobId: input.jobId,
					workspaceRelPath: input.workspaceRelPath,
					...input.enrich,
				})
			: [];

	const log = record?.state.log ?? [];
	const lastLogLine = log.length > 0 ? log[log.length - 1] : null;

	// reasonText()'s derivation (`dashboard.ts:86-93`): the joined human-stop
	// conditions when there are any, else the last log line — narrowed by §1.7 to
	// the statuses where a reason exists at all.
	const failReason = FAILED_OR_STOPPED.includes(state.status)
		? rawHumanStop.length > 0
			? joinStopConditions(rawHumanStop)
			: lastLogLine
		: null;

	const projection: RunProjection = {
		runRef: input.jobId,
		jobId: input.jobId,
		workspaceRelPath: input.workspaceRelPath,
		clientKey: input.clientKey,
		monthId: input.monthId,
		status: state.status,
		observedStatus: observedStatus(state),
		queued: state.queued,
		active: state.active,
		hasRunRecord: state.hasRunRecord,
		stage: stageRef(state.stageIndex),
		retryCount: state.retryCount,
		retriesRemaining: retriesRemaining(state.status, state.retryCount),
		humanStop,
		lastLogLine,
		failReason,
		counts: state.hasRunRecord ? input.counts : null,
		startedAt: record?.startedAt || null,
		stageStartedAt: record?.stageStartedAt ?? null,
		updatedAt: record?.updatedAt || null,
		finishedAt: record?.finishedAt ?? null,
		externalRef: input.externalRef,
		requestedBy: input.requestedBy,
		// §1.7: `version` is 0 for a job with no run record.
		version: state.hasRunRecord ? input.version : 0,
	};

	if (input.repairImpact !== undefined) projection.repairImpact = input.repairImpact;
	return projection;
}

/** A stable fingerprint of everything a projection update would change, used to
 * decide whether `version` must increment (§1.6: "Monotonic per job, increments
 * on every projection update"). `version` itself is excluded, or every read
 * would look like a change. */
export function projectionFingerprint(projection: RunProjection): string {
	const { version, repairImpact, ...rest } = projection;
	void version;
	void repairImpact;
	return JSON.stringify(rest);
}

export type StageRefType = StageRef;
