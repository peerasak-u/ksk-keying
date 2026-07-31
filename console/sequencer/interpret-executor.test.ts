import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLeafPrompt, DEFAULT_INTERPRET_CONCURRENCY, executeInterpretPlan, isUsageLimitText, rateLimitStatus, validateUnitArtifacts, type UnitValidator } from "./interpret-executor";
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


	// The production incident this guards: every `--output-format stream-json`
	// session emits a rate_limit_event near the top of its transcript, including
	// sessions that succeed. The old prose regex matched the event's NAME, so on a
	// perfectly healthy account the breaker tripped on the first leaf of every
	// wave and killed the whole stage. Mocked runners never carried a real
	// transcript, which is exactly why 490 passing tests did not catch it.
	const HEALTHY_TRANSCRIPT = [
		'{"type":"system","subtype":"init","session_id":"s1"}',
		'{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1785129000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false},"uuid":"u1"}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
		'{"type":"result","subtype":"success","is_error":false}',
	].join("\n");

	test("a healthy stream-json transcript is never mistaken for a usage limit", async () => {
		const started: string[] = [];
		const result = await executeInterpretPlan({
			plan: plan(unit("a"), unit("b")), repoRoot: "/repo", concurrency: 1, staggerMs: 0,
			validate: async () => ({ ok: true }),
			runLeaf: async (invocation) => { started.push(invocation.unit.id); return { exitCode: 0, stdout: HEALTHY_TRANSCRIPT }; },
		});
		expect(result.status).not.toBe("usage-limit");
		expect(result.units.some((u) => u.errors.some((e) => e.includes("usage-limit")))).toBe(false);
	});

	test("a genuinely limited transcript still opens the breaker, with the evidence recorded", async () => {
		const limited = HEALTHY_TRANSCRIPT.replace('"status":"allowed"', '"status":"rejected"');
		const result = await executeInterpretPlan({
			plan: plan(unit("a"), unit("b")), repoRoot: "/repo", concurrency: 1, staggerMs: 0,
			validate: async () => ({ ok: false, errors: ["missing"] }),
			runLeaf: async () => ({ exitCode: 1, stdout: limited }),
		});
		expect(result.status).toBe("usage-limit");
		expect(result.units[0].errors.join(" ")).toContain("status=rejected");
	});

	test("rateLimitStatus reads the structured event rather than the words around it", () => {
		expect(rateLimitStatus(HEALTHY_TRANSCRIPT)).toBeNull();
		expect(rateLimitStatus(HEALTHY_TRANSCRIPT.replace('"status":"allowed"', '"status":"exceeded"'))).toBe("exceeded");
		expect(rateLimitStatus("no events here")).toBeUndefined();
	});

	// Regression, from a real halt: client 216's seg-001 emitted
	// "allowed_warning" — permission granted, limit merely approaching — and an
	// equality test against "allowed" stopped the entire wave as if the account
	// were exhausted. Every granted variant must read as "not limited".
	test("an approaching-limit warning is still permission granted, not a limit", async () => {
		const warned = HEALTHY_TRANSCRIPT.replace('"status":"allowed"', '"status":"allowed_warning"');
		expect(rateLimitStatus(warned)).toBeNull();
		const result = await executeInterpretPlan({
			plan: plan(unit("a"), unit("b")), repoRoot: "/repo", concurrency: 1, staggerMs: 0,
			validate: async () => ({ ok: false, errors: ["missing"] }),
			runLeaf: async () => ({ exitCode: 1, stdout: warned }),
		});
		expect(result.status).not.toBe("usage-limit");
		expect(result.units.some((u) => u.errors.some((e) => e.includes("usage-limit")))).toBe(false);
	});

	test("the prose fallback does not match the machine-readable event names", () => {
		expect(isUsageLimitText('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}')).toBe(false);
		expect(isUsageLimitText('"rateLimitType":"five_hour"')).toBe(false);
		expect(isUsageLimitText("Claude usage limit reached — your limit will reset at 3pm")).toBe(true);
	});

	test("the default wave is small and ramps instead of bursting", async () => {
		expect(DEFAULT_INTERPRET_CONCURRENCY).toBeLessThanOrEqual(2);
		let peak = 0, active = 0;
		await executeInterpretPlan({
			plan: plan(unit("a"), unit("b"), unit("c"), unit("d")), repoRoot: "/repo", staggerMs: 0,
			validate: async () => ({ ok: true }),
			runLeaf: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; return { exitCode: 0, stdout: HEALTHY_TRANSCRIPT }; },
		});
		expect(peak).toBeLessThanOrEqual(DEFAULT_INTERPRET_CONCURRENCY);
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
		const temp = mkdtempSync(join(tmpdir(), "ksk-interpret-"));
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
