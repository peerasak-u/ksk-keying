// The pipeline's stage list, as the neutral contract carries it.
//
// Plan §9.3: "Core's stage list is authoritative and is what crosses the wire.
// Every event carries `stageId` (`profile`…`final`) and `stageIndex`. … Neither
// side may hardcode '7'." That is why STAGE_COUNT is derived and why §1.7's
// `stage.count` is on the wire.
//
// This is the runtime's own list (`console/sequencer/logic.ts:53-61`), narrowed
// to what a client needs: the gate mechanics (`CompletionCheck`) stay inside
// the workflow module and never cross the boundary. `runtime-parity.test.ts`
// asserts the two lists stay identical, so this file cannot drift from the
// sequencer silently.

export type StageId = "profile" | "segment" | "interpret" | "link" | "group" | "categorize" | "final";

export type Stage = {
	id: StageId;
	/** The runtime's own label, verbatim — the office platform keeps its own
	 * display copy and maps `id` (plan §9.3). */
	label: string;
	index: number;
	/** false only for `final`: there is no stage process to spawn, so a failed
	 * `final` gate is never retried (logic.ts:45-48, 217-224). */
	spawnsProcess: boolean;
};

export const STAGES: readonly Stage[] = [
	{ id: "profile", label: "Stage 0 — profile", index: 0, spawnsProcess: true },
	{ id: "segment", label: "Stage 1 — segment", index: 1, spawnsProcess: true },
	{ id: "interpret", label: "Stage 2 — interpret", index: 2, spawnsProcess: true },
	{ id: "link", label: "Stage 3 — link", index: 3, spawnsProcess: true },
	{ id: "group", label: "Stage 4 — group", index: 4, spawnsProcess: true },
	{ id: "categorize", label: "Stage 5 — categorize", index: 5, spawnsProcess: true },
	{ id: "final", label: "Completion — final", index: 6, spawnsProcess: false },
] as const;

export const STAGE_COUNT = STAGES.length;

/** The stage a `repair` resets to: a full pipeline restart from Stage 1, NOT
 * from Stage 0 (§5.8; `orchestrator.ts:265`). */
export const REPAIR_STAGE_INDEX = STAGES.findIndex((stage) => stage.id === "segment");

export const LAST_STAGE_INDEX = STAGE_COUNT - 1;

/** The `stage` object of §1.7. Out-of-range indexes are clamped rather than
 * throwing: a run-state.yaml written by a future stage list must still be
 * readable, and reporting the last known stage beats failing the read. */
export function stageAt(index: number): Stage {
	if (index <= 0) return STAGES[0];
	if (index >= LAST_STAGE_INDEX) return STAGES[LAST_STAGE_INDEX];
	return STAGES[index];
}

export type StageRef = { id: StageId; index: number; label: string; count: number };

export function stageRef(index: number): StageRef {
	const stage = stageAt(index);
	return { id: stage.id, index: stage.index, label: stage.label, count: STAGE_COUNT };
}
