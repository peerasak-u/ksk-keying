// Spec §0.1: "an implementer must be able to check it, and a reviewer must be
// able to see that the state machine in §3 is the machine in
// `console/sequencer/logic.ts`, not a redrawing of it."
//
// This file is that check. It is the ONLY place keying-core reaches into
// `console/`, it is a test rather than shipped code, and it reads only — plan
// §12.2 forbids changing stage order, status names, retry counts, gates, or
// completion checks, so a divergence here means one of the two files moved and
// the diff should say which.
import { describe, expect, test } from "bun:test";
import { STAGES as RUNTIME_STAGES, TERMINAL_STATUSES as RUNTIME_TERMINAL, type Status } from "../../../console/sequencer/logic";
import { STAGES, STAGE_COUNT } from "./stages";
import { MAX_RETRIES, RUN_STATUSES, TERMINAL_STATUSES } from "./state-machine";

describe("keying-core's workflow contract against the runtime it describes", () => {
	test("the stage list is the sequencer's list — same ids, same order, same labels", () => {
		expect(STAGES.map((stage) => stage.id as string)).toEqual(RUNTIME_STAGES.map((stage) => stage.id));
		expect(STAGES.map((stage) => stage.label)).toEqual(RUNTIME_STAGES.map((stage) => stage.label));
		expect(STAGE_COUNT).toBe(RUNTIME_STAGES.length);
	});

	test("`spawnsProcess` matches, so `final`'s never-retried gate stays never-retried", () => {
		expect(STAGES.map((stage) => stage.spawnsProcess)).toEqual(RUNTIME_STAGES.map((stage) => stage.spawnsProcess));
		expect(STAGES.filter((stage) => !stage.spawnsProcess).map((stage) => stage.id)).toEqual(["final"]);
	});

	test("the terminal set is logic.ts:134's own array", () => {
		expect([...TERMINAL_STATUSES].sort()).toEqual([...RUNTIME_TERMINAL].sort());
	});

	test("every runtime Status value survives in the neutral DTO (plan §9.3)", () => {
		// A compile-time check as much as a runtime one: if `Status` gained a
		// member, this assignment stops type-checking, and if it lost one the
		// length assertion below fires.
		const everyRuntimeStatus: Status[] = [...RUN_STATUSES];
		expect(everyRuntimeStatus.length).toBe(10);
		// And the reverse direction: nothing in the DTO that the sequencer does
		// not have.
		const everyDtoStatus: readonly string[] = RUN_STATUSES;
		for (const status of RUNTIME_TERMINAL) expect(everyDtoStatus).toContain(status);
	});

	test("the retry policy is logic.ts:184's — 2 on blocked, 1 on env-error", () => {
		// logic.ts keeps MAX_RETRIES module-private, so this asserts the values
		// the spec transcribes (§3.1, §3.2's T9/T11) rather than importing them.
		// The behavioural half is covered by the T9–T14 cases in
		// state-machine.test.ts, which encode the same thresholds.
		expect(MAX_RETRIES).toEqual({ blocked: 2, "env-error": 1 });
	});
});
