import { describe, expect, test } from "bun:test";
import { createLogger } from "../observability/logger";
import {
	enrichHumanStopEntries,
	enrichHumanStopEntry,
	isStopCondition,
	joinStopConditions,
	parseRawHumanStopEntries,
	STOP_CONDITIONS,
	type RawHumanStopEntry,
} from "./human-stop";

function raw(overrides: Partial<RawHumanStopEntry> = {}): RawHumanStopEntry {
	return {
		stage: "interpret",
		unit: "เอกสารรายจ่าย/true-6908.pdf#p7",
		condition: "unreadable_required_source",
		reason: "invoice.pdf page 6 is corrupted — pdfinfo cannot read it; no other source for this transaction",
		...overrides,
	};
}

describe("§3.6 [C-36] the closed three-value enumeration", () => {
	test("carries exactly the three conditions decision-policy.md's Stop rules name", () => {
		expect([...STOP_CONDITIONS]).toEqual(["no_coa_source", "unreadable_required_source", "no_rule_ambiguity"]);
	});

	test("isStopCondition rejects anything outside the set", () => {
		expect(isStopCondition("no_coa_source")).toBe(true);
		expect(isStopCondition("some_future_blocker")).toBe(false);
	});

	test("each known condition gets a Thai message and remedy that name no stage, exit code, or pipeline file", () => {
		for (const condition of STOP_CONDITIONS) {
			const entry = enrichHumanStopEntry(raw({ condition, unit: null }));
			expect(entry.message.length).toBeGreaterThan(0);
			expect(entry.remedy.length).toBeGreaterThan(0);
			expect(/[฀-๿]/.test(entry.message)).toBe(true);
			expect(entry.message).not.toContain("exit");
			expect(entry.message).not.toContain("run-state.yaml");
		}
	});

	test("reproduces §3.6's own wire example byte-for-byte on the fields Core owns", () => {
		const entry = enrichHumanStopEntry(raw());
		expect(entry.stage).toBe("interpret");
		expect(entry.unit).toBe("เอกสารรายจ่าย/true-6908.pdf#p7");
		expect(entry.condition).toBe("unreadable_required_source");
		expect(entry.conditionRaw).toBe("unreadable_required_source");
		expect(entry.message).toBe("เปิดไฟล์ «เอกสารรายจ่าย/true-6908.pdf#p7» ไม่ได้ หรือไฟล์หายไป จึงตรวจเอกสารใบนี้ต่อไม่ได้");
		expect(entry.remedy.startsWith("หาไฟล์ตัวจริงมาวางทับที่เดิม")).toBe(true);
	});

	test("<unit> is substituted verbatim, Thai filenames included", () => {
		const entry = enrichHumanStopEntry(raw({ unit: "เอกสาร/ใบเสร็จ ๒๕๖๙.pdf#p1" }));
		expect(entry.message).toContain("«เอกสาร/ใบเสร็จ ๒๕๖๙.pdf#p1»");
		expect(entry.message).not.toContain("<unit>");
	});

	test("a client-wide condition has no unit, and the placeholder is not printed as a word", () => {
		const entry = enrichHumanStopEntry(raw({ condition: "no_coa_source", unit: null }));
		expect(entry.unit).toBeNull();
		expect(entry.message).toBe("ยังไม่มีผังบัญชีของลูกค้ารายนี้ ระบบจึงลงบัญชีให้ไม่ได้เลย");
		expect(entry.message).not.toContain("null");
		expect(entry.remedy).not.toContain("<unit>");
	});

	test("stage, unit and reason are the artifact's own bytes, untouched", () => {
		const source = raw({ stage: "  interpret  ", reason: "  two   spaces  " });
		const entry = enrichHumanStopEntry(source);
		expect(entry.stage).toBe(source.stage);
		expect(entry.reason).toBe(source.reason);
	});
});

describe("§3.6 [C-37] an unrecognised condition", () => {
	test("is surfaced as unrecognised: condition null, conditionRaw verbatim", () => {
		const entry = enrichHumanStopEntry(raw({ condition: "a_fourth_blocker" }));
		expect(entry.condition).toBeNull();
		expect(entry.conditionRaw).toBe("a_fourth_blocker");
	});

	test("is never rejected and never dropped — the entry still comes back", () => {
		const entries = enrichHumanStopEntries([raw({ condition: "a_fourth_blocker" }), raw()]);
		expect(entries.length).toBe(2);
		expect(entries[0].conditionRaw).toBe("a_fourth_blocker");
	});

	test("gets the fixed fallback pair, naming the raw value in both", () => {
		const entry = enrichHumanStopEntry(raw({ condition: "a_fourth_blocker" }));
		expect(entry.message).toBe("งานนี้หยุดรอคน ด้วยเหตุผลที่ระบบรุ่นนี้ยังไม่รู้จัก (a_fourth_blocker)");
		expect(entry.remedy).toContain("«a_fourth_blocker»");
		// The instruction ends with somebody being told the contract has drifted.
		expect(entry.remedy).toContain("แจ้งผู้ดูแลระบบ");
	});

	test("still carries the stage's own reason, which is the incident-specific part", () => {
		const entry = enrichHumanStopEntry(raw({ condition: "a_fourth_blocker", reason: "the stage's own sentence" }));
		expect(entry.reason).toBe("the stage's own sentence");
	});

	test("writes one warn line, event=run.human_stop.unknown_condition, carrying conditionRaw", () => {
		const lines: string[] = [];
		const logger = createLogger({ sink: (line) => lines.push(line), level: "debug" });
		enrichHumanStopEntry(raw({ condition: "a_fourth_blocker" }), {
			logger,
			jobId: "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
			workspaceRelPath: "216/69-08",
		});
		expect(lines.length).toBe(1);
		const line = JSON.parse(lines[0]);
		expect(line.level).toBe("warn");
		expect(line.event).toBe("run.human_stop.unknown_condition");
		expect(line.conditionRaw).toBe("a_fourth_blocker");
		expect(line.jobId).toBe("job_7Qd2xK9mLp0aRt4Vb8Nc1Z");
		expect(line.workspaceRelPath).toBe("216/69-08");
	});

	test("writes no such line for a recognised condition", () => {
		const lines: string[] = [];
		const logger = createLogger({ sink: (line) => lines.push(line), level: "debug" });
		enrichHumanStopEntry(raw(), { logger });
		expect(lines.length).toBe(0);
	});
});

describe("reading the entries off the artifact", () => {
	test("a missing or non-array value is an empty list, not a throw", () => {
		expect(parseRawHumanStopEntries(undefined)).toEqual([]);
		expect(parseRawHumanStopEntries(null)).toEqual([]);
		expect(parseRawHumanStopEntries("nope")).toEqual([]);
	});

	test("a malformed member is coerced rather than dropped — a hard blocker never becomes silence", () => {
		const parsed = parseRawHumanStopEntries([{ stage: "interpret" }, null, { condition: 7 }]);
		expect(parsed.length).toBe(3);
		expect(parsed[0]).toEqual({ stage: "interpret", unit: null, condition: "", reason: "" });
		expect(parsed[2].condition).toBe("");
	});

	test("joinStopConditions is reasonText()'s derivation — `condition: reason`, joined by ` | `", () => {
		expect(joinStopConditions([raw({ condition: "a", reason: "b" }), raw({ condition: "c", reason: "d" })])).toBe(
			"a: b | c: d",
		);
		expect(joinStopConditions([])).toBe("");
	});
});
