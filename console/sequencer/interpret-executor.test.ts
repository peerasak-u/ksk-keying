import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLeafPrompt, executeInterpretPlan, isUsageLimitText, validateUnitArtifacts, type UnitValidator } from "./interpret-executor";
import type { InterpretPlan, InterpretUnit } from "./interpret-plan";

function unit(id: string): InterpretUnit {
	return { id, segmentId: "seg-001", runRoot: "/run", agent: "ksk-watson", pages: [{ file: "scan.pdf", page: 1, sourcePath: "/run/scan.pdf", artifactPath: "/run/_pages/scan/page-001.png" }], sheets: [], resultPath: `/run/ข้อมูลระบบ/_segments/seg-001/${id}.json`, fragmentPath: `/run/ข้อมูลระบบ/_pages/fragments/${id}.yaml` };
}
function plan(...units: InterpretUnit[]): InterpretPlan { return { runRoot: "/run", units, skipped: [] }; }

describe("executeInterpretPlan", () => {
	test("resumes validated units without starting Claude", async () => {
		let calls = 0;
		const validate: UnitValidator = async () => ({ ok: true });
		const result = await executeInterpretPlan({ plan: plan(unit("a")), repoRoot: "/repo", validate, runLeaf: async () => { calls++; return { exitCode: 0 }; } });
		expect(result.status).toBe("passed");
		expect(result.units[0].status).toBe("skipped-valid");
		expect(calls).toBe(0);
	});

	test("retries only the invalid unit and passes validator feedback to the direct leaf prompt", async () => {
		let checks = 0;
		let prompt = "";
		let args: string[] = [];
		const result = await executeInterpretPlan({ plan: plan(unit("a")), repoRoot: "/repo", maxAttempts: 2, validate: async () => (++checks >= 2 ? { ok: true } : { ok: false, errors: ["page_disposition missing"] }), runLeaf: async (invocation) => { prompt = invocation.args[1]; args = invocation.args; return { exitCode: 0 }; } });
		expect(result.units[0]).toMatchObject({ status: "passed", attempts: 1 });
		expect(prompt).toContain("page_disposition missing");
		expect(args.slice(2, 7)).toEqual(["--agent", "ksk-watson", "--tools", "Read,Write", "--output-format"]);
	});

	test("forced audit repair re-runs an otherwise valid unit with explicit feedback", async () => {
		let prompt = "";
		const result = await executeInterpretPlan({
			plan: plan(unit("a")),
			repoRoot: "/repo",
			forceUnitIds: new Set(["a"]),
			validate: async () => ({ ok: true }),
			runLeaf: async (invocation) => {
				prompt = invocation.args[1];
				return { exitCode: 0 };
			},
		});
		expect(result.units[0]).toMatchObject({ status: "passed", attempts: 1 });
		expect(prompt).toContain("exclusion audit refuted this unit");
	});

	test("opens a usage-limit circuit breaker and aborts active leaf adapters", async () => {
		const started: string[] = [];
		const result = await executeInterpretPlan({ plan: plan(unit("a"), unit("b"), unit("c")), repoRoot: "/repo", concurrency: 1, validate: async () => ({ ok: false, errors: ["missing"] }), runLeaf: async (invocation) => { started.push(invocation.unit.id); return { exitCode: 1, failureKind: "usage_limit" }; } });
		expect(result.status).toBe("usage-limit");
		expect(started).toEqual(["a"]);
		expect(result.units.slice(1).map((entry) => entry.status)).toEqual(["cancelled", "cancelled"]);
		expect(isUsageLimitText("You've hit your limit · resets 8pm")).toBe(true);
	});

	test("relays an orchestrator stop signal to active leaves and stops new work", async () => {
		const controller = new AbortController();
		const started: string[] = [];
		const result = await executeInterpretPlan({ plan: plan(unit("a"), unit("b")), repoRoot: "/repo", signal: controller.signal, concurrency: 1, validate: async () => ({ ok: false, errors: ["missing"] }), runLeaf: async (invocation) => {
			started.push(invocation.unit.id);
			controller.abort("operator stop");
			return { exitCode: 1, failureKind: invocation.signal.aborted ? "cancelled" : "process_error" };
		} });
		expect(started).toEqual(["a"]);
		expect(result.units.map((entry) => entry.status)).toEqual(["cancelled", "cancelled"]);
	});

	test("prompt names only exact input/reference/output paths and bans discovery", () => {
		const prompt = buildLeafPrompt(unit("a"), "/repo", ["missing disposition"]);
		expect(prompt).toContain('"source_file": "scan.pdf"');
		expect(prompt).toContain('"repoRoot": "/repo"');
		expect(prompt).toContain('"deterministicValidationErrors": [');
		expect(prompt).toContain('"missing disposition"');
		expect(prompt).toContain("/run/_pages/scan/page-001.png");
		expect(prompt).toContain("/repo/.claude/skills/ksk-keying/references/extract-playbooks.md");
		expect(prompt).toContain("Do not run validation, find, grep, shell discovery");
		expect(prompt).not.toContain("Previous deterministic validation failed");
		expect(prompt).not.toContain("/run/scan.pdf");
	});

	test("local resume validation requires exactly one disposition in both artifacts", async () => {
		const temp = mkdtempSync("/tmp/ksk-interpret-");
		try {
			const checked = { ...unit("a"), resultPath: join(temp, "result.json"), fragmentPath: join(temp, "fragment.yaml") };
			writeFileSync(checked.resultPath, JSON.stringify({ schema: "ksk_segment_interpretation.v1", segment_id: "seg-001", page_disposition: [{ file: "scan.pdf", page: 1, disposition: "used" }] }));
			writeFileSync(checked.fragmentPath, "schema: ksk_disposition_fragment.v1\nsegment_id: seg-001\nentries:\n  - {file: scan.pdf, page: 1, disposition: used}\n");
			expect(await validateUnitArtifacts(checked)).toEqual({ ok: true });
			writeFileSync(checked.fragmentPath, "schema: ksk_disposition_fragment.v1\nsegment_id: seg-001\nentries:\n  - {file: scan.pdf, page: 1, disposition: used}\n  - {file: scan.pdf, page: 1, disposition: used}\n");
			const invalid = await validateUnitArtifacts(checked);
			expect(invalid).toMatchObject({ ok: false });
			if (!invalid.ok) expect(invalid.errors).toContain("fragment claims scan.pdf#p1 2 times");
			writeFileSync(checked.fragmentPath, "schema: ksk_disposition_fragment.v1\nsegment_id: seg-001\nentries:\n  - {file: scan.pdf, page: 1, disposition: excluded, reason: blank}\n");
			const contradictory = await validateUnitArtifacts(checked);
			expect(contradictory).toMatchObject({ ok: false });
			if (!contradictory.ok) expect(contradictory.errors).toContain("interpretation and fragment disagree for scan.pdf#p1");
		} finally { rmSync(temp, { recursive: true, force: true }); }
	});
});
