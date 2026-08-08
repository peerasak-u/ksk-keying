import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import {
	buildDispositionFragment,
	buildInlineLeafStdin,
	buildLeafPrompt,
	buildLeafSystemPrompt,
	claudeLeafInvocation,
	DEFAULT_INTERPRET_CONCURRENCY,
	executeInterpretPlan,
	InlineBudgetError,
	INTERPRET_MAX_INLINE_IMAGE_BYTES,
	INTERPRET_MAX_INLINE_TOTAL_BYTES,
	isUsageLimitText,
	leafDelivery,
	loadLeafMaterial,
	materializeUnitOutputs,
	parseInterpretationResponse,
	rateLimitStatus,
	validateUnitArtifacts,
	type LeafRunResult,
	type UnitValidator,
} from "./interpret-executor";
import type { InterpretPlan, InterpretUnit } from "./interpret-plan";

// The real repo: the inlined system prompt is assembled from ksk-watson.md,
// the segment-interpretation schema and the extract playbooks as they actually
// ship, so a rename or a deletion fails here rather than in production.
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

// Smallest valid PNG (1x1). Real bytes matter: the executor base64-encodes the
// prepared artifact itself, so a placeholder text file would not exercise it.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

let workspace = "";
beforeAll(() => {
	workspace = mkdtempSync("/tmp/ksk-interpret-exec-");
});
afterAll(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function pageArtifact(name: string, bytes: Buffer = TINY_PNG) {
	const path = join(workspace, "_pages", name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
	return path;
}

function unit(id: string, pageCount = 1): InterpretUnit {
	return {
		id,
		segmentId: "seg-001",
		runRoot: workspace,
		agent: "ksk-watson",
		pages: Array.from({ length: pageCount }, (_unused, index) => ({
			file: "scan.pdf",
			page: index + 1,
			sourcePath: join(workspace, "scan.pdf"),
			artifactPath: pageArtifact(`${id}/page-${String(index + 1).padStart(3, "0")}.png`),
		})),
		sheets: [],
		resultPath: join(workspace, "out", id, "interpretation.json"),
		fragmentPath: join(workspace, "out", "fragments", `${id}.yaml`),
	};
}

function sheetUnit(id: string): InterpretUnit {
	return {
		id,
		segmentId: "seg-900",
		runRoot: workspace,
		agent: "ksk-marple",
		pages: [],
		sheets: [{ file: "report.xlsx", sheet: "Sheet1", sourcePath: join(workspace, "report.xlsx"), artifactPath: join(workspace, "_pages/report/sheet-Sheet1.json") }],
		resultPath: join(workspace, "out", id, "interpretation.json"),
		fragmentPath: join(workspace, "out", "fragments", `${id}.yaml`),
	};
}

function plan(...units: InterpretUnit[]): InterpretPlan {
	return { runRoot: workspace, units, skipped: [] };
}

/** A canonical reply for `target`, as the inlined leaf would return it. */
function replyFor(target: InterpretUnit, overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		schema: "ksk_segment_interpretation.v1",
		segment_id: target.segmentId,
		documents: [{ source_file: "scan.pdf", source_page: 1, doc_kind: "normal_bill_or_invoice" }],
		relationship: { same_transaction: true, reason: "หน้าเดียวกัน" },
		accounting_facts: { direction: "expense", document_no: null },
		line_items: [],
		review_flags: [],
		questions_for_user: [],
		page_disposition: target.pages.map((page) => ({ file: page.file, page: page.page, disposition: "used" })),
		...overrides,
	});
}

function okLeaf(target: InterpretUnit) {
	return async (): Promise<LeafRunResult> => ({ exitCode: 0, resultText: replyFor(target) });
}

/** Parses the one stream-json line the inlined leaf receives on stdin. */
function stdinMessage(stdin: Uint8Array | undefined) {
	expect(stdin).toBeDefined();
	const text = new TextDecoder().decode(stdin!);
	expect(text.endsWith("\n")).toBe(true);
	expect(text.trimEnd().includes("\n")).toBe(false);
	return JSON.parse(text) as { type: string; message: { role: string; content: Array<Record<string, any>> } };
}

describe("executeInterpretPlan", () => {
	test("resumes validated units without starting Claude", async () => {
		let calls = 0;
		const validate: UnitValidator = async () => ({ ok: true });
		const result = await executeInterpretPlan({ plan: plan(unit("a")), repoRoot: REPO_ROOT, validate, runLeaf: async () => { calls++; return { exitCode: 0 }; } });
		expect(result.status).toBe("passed");
		expect(result.units[0].status).toBe("skipped-valid");
		expect(calls).toBe(0);
	});

	test("retries only the invalid unit and passes validator feedback to the direct leaf", async () => {
		let checks = 0;
		const target = unit("retry-feedback");
		let stdin: Uint8Array | undefined;
		let args: string[] = [];
		const result = await executeInterpretPlan({
			plan: plan(target), repoRoot: REPO_ROOT, maxAttempts: 2,
			validate: async () => (++checks >= 2 ? { ok: true } : { ok: false, errors: ["page_disposition missing"] }),
			runLeaf: async (invocation) => { stdin = invocation.stdin; args = invocation.args; return { exitCode: 0, resultText: replyFor(target) }; },
		});
		expect(result.units[0]).toMatchObject({ status: "passed", attempts: 1 });
		expect(JSON.stringify(stdinMessage(stdin))).toContain("page_disposition missing");
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe("");
	});

	test("forced audit repair re-runs an otherwise valid unit with explicit feedback", async () => {
		const target = unit("forced");
		let stdin: Uint8Array | undefined;
		const result = await executeInterpretPlan({
			plan: plan(target),
			repoRoot: REPO_ROOT,
			forceUnitIds: new Set(["forced"]),
			validate: async () => ({ ok: true }),
			runLeaf: async (invocation) => { stdin = invocation.stdin; return { exitCode: 0, resultText: replyFor(target) }; },
		});
		expect(result.units[0]).toMatchObject({ status: "passed", attempts: 1 });
		expect(JSON.stringify(stdinMessage(stdin))).toContain("exclusion audit refuted this unit");
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
			plan: plan(unit("a"), unit("b")), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0,
			validate: async () => ({ ok: true }),
			runLeaf: async (invocation) => { started.push(invocation.unit.id); return { exitCode: 0, stdout: HEALTHY_TRANSCRIPT }; },
		});
		expect(result.status).not.toBe("usage-limit");
		expect(result.units.some((u) => u.errors.some((e) => e.includes("usage-limit")))).toBe(false);
	});

	test("a genuinely limited transcript still opens the breaker, with the evidence recorded", async () => {
		const limited = HEALTHY_TRANSCRIPT.replace('"status":"allowed"', '"status":"rejected"');
		const result = await executeInterpretPlan({
			plan: plan(unit("a"), unit("b")), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0,
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
			plan: plan(unit("a"), unit("b")), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0,
			validate: async () => ({ ok: false, errors: ["missing"] }),
			runLeaf: async () => ({ exitCode: 1, stdout: warned }),
		});
		expect(result.status).not.toBe("usage-limit");
		expect(result.units.some((u) => u.errors.some((e) => e.includes("usage-limit")))).toBe(false);
	});

	// The inlined leaf's answer is client prose: transcribed document text, Thai
	// review flags, exclusion reasons. None of it is evidence about the ACCOUNT,
	// and a leaf that exited 0 proves the account was not refused. Reading it as
	// a limit signal would cancel every remaining unit of the month.
	test("usage-limit wording inside a successful leaf's own answer never breaks the wave", async () => {
		const target = unit("limit-wording");
		const reply = replyFor(target, {
			review_flags: ["ใบแจ้งหนี้ระบุว่า quota exceeded สำหรับแพ็กเกจนี้"],
			questions_for_user: ["Claude usage limit reached — your limit will reset at 3pm"],
		});
		const result = await executeInterpretPlan({
			plan: plan(target, unit("limit-wording-after")), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0,
			validate: async (subject, signal) => (subject.id === "limit-wording-after" ? { ok: true } : validateUnitArtifacts(subject, signal)),
			runLeaf: async () => ({ exitCode: 0, stdout: `${HEALTHY_TRANSCRIPT}\n${reply}`, resultText: reply }),
		});
		expect(result.status).toBe("passed");
		expect(result.units[0]).toMatchObject({ unitId: "limit-wording", status: "passed" });
		expect(result.units[1].status).toBe("skipped-valid");
	});

	// Defence in depth for the same class: even a runner that mis-classifies a
	// run it also reported as successful cannot cancel the month off it.
	test("a runner reporting failureKind=usage_limit on an exit-0 run does not open the breaker", async () => {
		const target = unit("limit-mislabelled");
		const result = await executeInterpretPlan({
			plan: plan(target), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0,
			validate: async (subject, signal) => validateUnitArtifacts(subject, signal),
			runLeaf: async () => ({ exitCode: 0, failureKind: "usage_limit", resultText: replyFor(target) }),
		});
		expect(result.status).toBe("passed");
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
			plan: plan(unit("a"), unit("b"), unit("c"), unit("d")), repoRoot: REPO_ROOT, staggerMs: 0,
			validate: async () => ({ ok: true }),
			runLeaf: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; return { exitCode: 0, stdout: HEALTHY_TRANSCRIPT }; },
		});
		expect(peak).toBeLessThanOrEqual(DEFAULT_INTERPRET_CONCURRENCY);
	});

	test("opens a usage-limit circuit breaker and aborts active leaf adapters", async () => {
		const started: string[] = [];
		const result = await executeInterpretPlan({ plan: plan(unit("a"), unit("b"), unit("c")), repoRoot: REPO_ROOT, concurrency: 1, validate: async () => ({ ok: false, errors: ["missing"] }), runLeaf: async (invocation) => { started.push(invocation.unit.id); return { exitCode: 1, failureKind: "usage_limit" }; } });
		expect(result.status).toBe("usage-limit");
		expect(started).toEqual(["a"]);
		expect(result.units.slice(1).map((entry) => entry.status)).toEqual(["cancelled", "cancelled"]);
		expect(isUsageLimitText("You've hit your limit · resets 8pm")).toBe(true);
	});

	test("relays an orchestrator stop signal to active leaves and stops new work", async () => {
		const controller = new AbortController();
		const started: string[] = [];
		const result = await executeInterpretPlan({ plan: plan(unit("a"), unit("b")), repoRoot: REPO_ROOT, signal: controller.signal, concurrency: 1, validate: async () => ({ ok: false, errors: ["missing"] }), runLeaf: async (invocation) => {
			started.push(invocation.unit.id);
			controller.abort("operator stop");
			return { exitCode: 1, failureKind: invocation.signal.aborted ? "cancelled" : "process_error" };
		} });
		expect(started).toEqual(["a"]);
		expect(result.units.map((entry) => entry.status)).toEqual(["cancelled", "cancelled"]);
	});

	test("the spreadsheet leaf's path packet names only exact input/reference/output paths and bans discovery", () => {
		const prompt = buildLeafPrompt(sheetUnit("s"), "/repo", ["missing disposition"]);
		expect(prompt).toContain('"source_file": "report.xlsx"');
		expect(prompt).toContain('"repoRoot": "/repo"');
		expect(prompt).toContain('"deterministicValidationErrors": [');
		expect(prompt).toContain('"missing disposition"');
		expect(prompt).toContain("/repo/.claude/skills/ksk-keying/references/extract-playbooks.md");
		expect(prompt).toContain("Do not run validation, find, grep, shell discovery");
		expect(prompt).not.toContain("Previous deterministic validation failed");
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

describe("the inlined visual leaf", () => {
	test("runs with no tools at all and never names --agent", () => {
		const invocation = claudeLeafInvocation(unit("no-tools"), REPO_ROOT, new AbortController().signal);
		expect(invocation.args).not.toContain("--agent");
		expect(invocation.args).not.toContain("Read,Write");
		const tools = invocation.args[invocation.args.indexOf("--tools") + 1];
		expect(tools).toBe("");
		expect(invocation.args).toContain("--strict-mcp-config");
		expect(invocation.args.slice(invocation.args.indexOf("--input-format"), invocation.args.indexOf("--input-format") + 2)).toEqual(["--input-format", "stream-json"]);
		// No settings source at all — measured at 3,050 wasted cache-creation
		// tokens per page when the console repo's CLAUDE.md was loaded.
		expect(invocation.args[invocation.args.indexOf("--setting-sources") + 1]).toBe("");
		expect(invocation.args).not.toContain("--safe-mode");
	});

	// Model selection is not the executor's to make: it stays wherever
	// ksk-watson.md pins it, which is what --agent used to carry.
	test("takes its model from ksk-watson.md's frontmatter", () => {
		const material = loadLeafMaterial(REPO_ROOT);
		const pinned = /^model:\s*(\S+)/m.exec(readFileSync(join(REPO_ROOT, ".claude/agents/ksk-watson.md"), "utf8"))?.[1];
		expect(material.model).toBe(pinned!);
		const invocation = claudeLeafInvocation(unit("model"), REPO_ROOT, new AbortController().signal);
		expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe(pinned!);
	});

	test("inlines the schema, the playbook, the client profile and watson's accounting rules into the system prompt", () => {
		const clientMd = join(workspace, "CLIENT.md");
		writeFileSync(clientMd, "# ลูกค้าทดสอบ\n\nเลขประจำตัวผู้เสียภาษี 0105564068776\n");
		const system = buildLeafSystemPrompt(loadLeafMaterial(REPO_ROOT, clientMd));
		expect(system).toContain("ksk_segment_interpretation.v1");
		// verbatim from the shipped reference files and the agent brief
		expect(system).toContain("Counterparties are structured: tax IDs go in");
		expect(system).toContain(readFileSync(join(REPO_ROOT, ".claude/skills/ksk-keying/references/extract-playbooks.md"), "utf8").trim());
		expect(system).toContain("0105564068776");
		// The system prompt must be per-MONTH, not per-unit, or the prefix cache
		// is rewritten on every page instead of read: it must be byte-identical
		// for two different units of the same client.
		expect(buildLeafSystemPrompt(loadLeafMaterial(REPO_ROOT, clientMd))).toBe(system);
		expect(system).not.toContain("materialize");
	});

	test("carries every assigned page as a base64 image block, in page order, in one message", () => {
		const seven = unit("seven", 7);
		const message = stdinMessage(buildInlineLeafStdin(seven));
		expect(message.type).toBe("user");
		expect(message.message.role).toBe("user");
		const images = message.message.content.filter((block) => block.type === "image");
		expect(images).toHaveLength(7);
		for (const image of images) {
			expect(image.source).toMatchObject({ type: "base64", media_type: "image/png" });
			expect(image.source.data).toBe(TINY_PNG.toString("base64"));
		}
		const labels = message.message.content.filter((block) => block.type === "text" && /^Page \d+ of 7/.test(block.text)).map((block) => block.text);
		expect(labels).toHaveLength(7);
		expect(labels[0]).toContain("source_file: scan.pdf, page: 1");
		expect(labels[6]).toContain("source_file: scan.pdf, page: 7");
	});

	test("a unit over the inlined-byte budget fails deterministically instead of dropping pages", () => {
		const big = unit("over-budget", 4);
		let thrown: unknown;
		try {
			buildInlineLeafStdin(big, [], { maxTotalBytes: TINY_PNG.length * 3 });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(InlineBudgetError);
		expect(String(thrown)).toContain("exceed the");
		expect(String(thrown)).toContain("split this segment into smaller sub_ranges");
		expect(String(thrown)).toContain("never dropped or truncated");
	});

	test("a single page over the per-image budget fails deterministically", () => {
		const wide = unit("wide-page");
		expect(() => buildInlineLeafStdin(wide, [], { maxImageBytes: 4 })).toThrow(InlineBudgetError);
		expect(() => buildInlineLeafStdin(wide, [], { maxImageBytes: 4 })).toThrow(/per-image limit/);
	});

	// The caps are derived from the Messages API's own 32 MB request / 5 MB
	// per-image ceilings — see INTERPRET_MAX_INLINE_TOTAL_BYTES's comment. A
	// change to either number should be a deliberate one.
	test("the default caps leave headroom under the API's request and image ceilings", () => {
		expect(INTERPRET_MAX_INLINE_TOTAL_BYTES).toBe(24 * 1024 * 1024);
		expect(INTERPRET_MAX_INLINE_IMAGE_BYTES).toBe(4 * 1024 * 1024);
		expect(INTERPRET_MAX_INLINE_TOTAL_BYTES).toBeLessThan(32 * 1000 * 1000);
		expect(INTERPRET_MAX_INLINE_IMAGE_BYTES).toBeLessThan(5 * 1000 * 1000);
	});

	test("a prepared artifact that is not an inlinable image fails with a named remedy", () => {
		const odd = unit("odd");
		odd.pages[0].artifactPath = pageArtifact("odd/page-001.tiff", TINY_PNG);
		expect(() => buildInlineLeafStdin(odd)).toThrow(/cannot be inlined as an image/);
	});

	test("an un-inlinable unit is one failed unit with an actionable message, and costs no model call", async () => {
		const big = unit("huge", 2);
		// A page whose base64 form is over the real per-image cap.
		writeFileSync(big.pages[0].artifactPath, Buffer.concat([TINY_PNG, Buffer.alloc(INTERPRET_MAX_INLINE_IMAGE_BYTES)]));
		let started = 0;
		const result = await executeInterpretPlan({
			plan: plan(big, unit("fine")), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0, maxAttempts: 2,
			validate: async (target) => (target.id === "fine" ? { ok: true } : { ok: false, errors: ["not written yet"] }),
			runLeaf: async () => { started++; return { exitCode: 0 }; },
		});
		expect(started).toBe(0);
		expect(result.units[0]).toMatchObject({ unitId: "huge", status: "failed" });
		expect(result.units[0].errors.join(" ")).toContain("per-image limit");
		// The wave is not aborted: the rest of the month still runs.
		expect(result.units[1].status).toBe("skipped-valid");
	});

	// A prepared artifact that cannot be READ is an I/O condition, not a
	// property of the unit: the same page can read fine a moment later on a
	// synced volume. So it consumes an attempt and goes round the ordinary
	// retry loop, unlike a byte-budget failure, which is identical every time
	// and is recorded immediately with the remaining attempts unspent.
	test("an unreadable prepared artifact is retried, then fails as one unit without aborting the wave", async () => {
		const target = unit("io-flake");
		target.pages[0].artifactPath = join(workspace, "_pages", "io-flake", "not-on-disk.png");
		let started = 0;
		const result = await executeInterpretPlan({
			plan: plan(target, unit("neighbour")), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0, maxAttempts: 2, evidenceRetryDelayMs: 0,
			validate: async (subject) => (subject.id === "neighbour" ? { ok: true } : { ok: false, errors: ["not written yet"] }),
			runLeaf: async () => { started++; return { exitCode: 0 }; },
		});
		expect(started).toBe(0);
		expect(result.units[0]).toMatchObject({ unitId: "io-flake", status: "failed", attempts: 2 });
		expect(result.units[0].errors.join(" ")).toContain("prepared page artifact unreadable");
		expect(result.units[1].status).toBe("skipped-valid");
	});

	// CLIENT.md sits on the same synced volume as the page artifacts, so an
	// unreadable-when-present profile is the same transient class — one unit's
	// attempts, never the month's. And never a silent no-profile substitution:
	// the buyer identity is evidence, so the unit fails rather than reporting
	// success on a reading made without it.
	test("an unreadable CLIENT.md fails its unit without aborting the wave, and is never substituted away", async () => {
		const target = unit("no-profile");
		let started = 0;
		const result = await executeInterpretPlan({
			plan: plan(target, unit("neighbour")), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0, maxAttempts: 2, evidenceRetryDelayMs: 0,
			clientMdPath: join(workspace, "absent-CLIENT.md"),
			validate: async (subject) => (subject.id === "neighbour" ? { ok: true } : { ok: false, errors: ["not written yet"] }),
			runLeaf: async () => { started++; return { exitCode: 0 }; },
		});
		expect(started).toBe(0);
		expect(result.units[0]).toMatchObject({ unitId: "no-profile", status: "failed", attempts: 2 });
		expect(result.units[0].errors.join(" ")).toContain("client profile unreadable");
		expect(result.units[1].status).toBe("skipped-valid");
	});

	// A run with no CLIENT.md at all is a legitimate no-profile run — only an
	// unreadable-when-present profile is an error.
	test("a run with no client profile at all still dispatches", () => {
		expect(loadLeafMaterial(REPO_ROOT, null).clientProfile).toBeNull();
	});

	test("the read-failure retry waits before re-reading, and the wait is interruptible", async () => {
		const target = unit("io-flake-delay");
		target.pages[0].artifactPath = join(workspace, "_pages", "io-flake-delay", "not-on-disk.png");
		const started = Date.now();
		const result = await executeInterpretPlan({
			plan: plan(target), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0, maxAttempts: 2, evidenceRetryDelayMs: 40,
			validate: async () => ({ ok: false, errors: ["not written yet"] }),
			runLeaf: async () => ({ exitCode: 0 }),
		});
		expect(result.units[0].status).toBe("failed");
		expect(Date.now() - started).toBeGreaterThanOrEqual(35);

		const stop = new AbortController();
		const cancelled = unit("io-flake-cancel");
		cancelled.pages[0].artifactPath = join(workspace, "_pages", "io-flake-cancel", "not-on-disk.png");
		const at = Date.now();
		const aborted = await executeInterpretPlan({
			plan: plan(cancelled), repoRoot: REPO_ROOT, concurrency: 1, staggerMs: 0, maxAttempts: 2, evidenceRetryDelayMs: 60_000,
			signal: stop.signal,
			validate: async () => { setTimeout(() => stop.abort("stop"), 20); return { ok: false, errors: ["not written yet"] }; },
			runLeaf: async () => ({ exitCode: 0 }),
		});
		expect(aborted.units[0].status).toBe("cancelled");
		expect(Date.now() - at).toBeLessThan(5_000);
	});

});

describe("executor-side parse, write and fragment derivation", () => {
	test("writes interpretation.json and derives the disposition fragment from page_disposition", async () => {
		const target = unit("materialize", 3);
		const result = await executeInterpretPlan({
			plan: plan(target), repoRoot: REPO_ROOT, validate: validateUnitArtifacts, runLeaf: okLeaf(target),
		});
		expect(result.units[0]).toMatchObject({ status: "passed", attempts: 1 });
		const written = JSON.parse(readFileSync(target.resultPath, "utf8"));
		expect(written.schema).toBe("ksk_segment_interpretation.v1");
		expect(written.page_disposition).toHaveLength(3);
		const fragment = yamlParse(readFileSync(target.fragmentPath, "utf8"));
		// Exactly the shape merge-dispositions.ts parses.
		expect(fragment.schema).toBe("ksk_disposition_fragment.v1");
		expect(fragment.segment_id).toBe("seg-001");
		expect(fragment.entries).toEqual([
			{ file: "scan.pdf", page: 1, disposition: "used" },
			{ file: "scan.pdf", page: 2, disposition: "used" },
			{ file: "scan.pdf", page: 3, disposition: "used" },
		]);
	});

	test("an exclusion keeps its reason and duplicate_of in the derived fragment", () => {
		const target = unit("excl", 2);
		const fragment = buildDispositionFragment(target, {
			page_disposition: [
				{ file: "scan.pdf", page: 1, disposition: "used" },
				{ file: "scan.pdf", page: 2, disposition: "excluded", reason: "duplicate", duplicate_of: "scan.pdf#p1" },
			],
		});
		expect(fragment.ok).toBe(true);
		if (!fragment.ok) return;
		expect(yamlParse(fragment.yaml).entries[1]).toEqual({ file: "scan.pdf", page: 2, disposition: "excluded", reason: "duplicate", duplicate_of: "scan.pdf#p1" });
	});

	test("accepts a fenced reply and a reply with surrounding prose", () => {
		const object = { schema: "ksk_segment_interpretation.v1", segment_id: "seg-001" };
		for (const reply of ["```json\n" + JSON.stringify(object) + "\n```", "```\n" + JSON.stringify(object) + "\n```", "Here you go:\n" + JSON.stringify(object) + "\nDone."]) {
			const parsed = parseInterpretationResponse(reply);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.value.segment_id).toBe("seg-001");
		}
	});

	test("a non-object or empty reply is a deterministic validation error, not a throw", () => {
		expect(parseInterpretationResponse("[1,2]")).toMatchObject({ ok: false });
		expect(parseInterpretationResponse("")).toMatchObject({ ok: false });
		expect(parseInterpretationResponse(undefined)).toMatchObject({ ok: false });
		const broken = parseInterpretationResponse("{not json at all");
		expect(broken).toMatchObject({ ok: false });
		if (!broken.ok) expect(broken.errors[0]).toContain("not valid JSON");
	});

	test("a reply without page_disposition writes nothing and reports it", () => {
		const target = unit("no-disp");
		const outcome = materializeUnitOutputs(target, JSON.stringify({ schema: "ksk_segment_interpretation.v1", segment_id: "seg-001" }));
		expect(outcome).toMatchObject({ ok: false });
		if (!outcome.ok) expect(outcome.errors[0]).toContain("no page_disposition[]");
		expect(() => readFileSync(target.resultPath, "utf8")).toThrow();
	});

	// The pair is validated as a pair, so a half-written pair must not exist:
	// the interpretation is never left behind when the fragment cannot land.
	test("a fragment that cannot be written leaves no orphaned interpretation", () => {
		const target = unit("half-written");
		const blocker = join(workspace, "blocked-fragments");
		writeFileSync(blocker, "not a directory");
		target.fragmentPath = join(blocker, "half-written.yaml");
		const outcome = materializeUnitOutputs(target, replyFor(target));
		expect(outcome).toMatchObject({ ok: false });
		if (!outcome.ok) expect(outcome.errors[0]).toContain("could not write this unit's artifacts");
		expect(() => readFileSync(target.resultPath, "utf8")).toThrow();
		expect(() => readFileSync(`${target.resultPath}.tmp`, "utf8")).toThrow();
	});

	// The failure mode the whole shape has to survive: a malformed reply must
	// reach the SAME retry the executor already runs for a schema violation.
	test("a malformed JSON reply feeds the existing retry path and the retry can succeed", async () => {
		const target = unit("malformed-then-good");
		const replies = ["I could not read the page, sorry.", replyFor(target)];
		let attempt = 0;
		let secondStdin: Uint8Array | undefined;
		const result = await executeInterpretPlan({
			plan: plan(target), repoRoot: REPO_ROOT, maxAttempts: 2, validate: validateUnitArtifacts,
			runLeaf: async (invocation) => {
				if (attempt === 1) secondStdin = invocation.stdin;
				return { exitCode: 0, resultText: replies[attempt++] };
			},
		});
		expect(attempt).toBe(2);
		expect(result.units[0]).toMatchObject({ status: "passed", attempts: 2 });
		// The parse failure is fed back as ordinary deterministic feedback.
		expect(JSON.stringify(stdinMessage(secondStdin))).toContain("not valid JSON");
	});

	test("a malformed reply on every attempt fails the unit with the parse error, no separate channel", async () => {
		const target = unit("always-malformed");
		const result = await executeInterpretPlan({
			plan: plan(target), repoRoot: REPO_ROOT, maxAttempts: 2, validate: validateUnitArtifacts,
			runLeaf: async () => ({ exitCode: 0, resultText: "sorry, no" }),
		});
		expect(result.status).toBe("failed");
		expect(result.units[0]).toMatchObject({ status: "failed", attempts: 2 });
		expect(result.units[0].errors.join(" ")).toContain("not valid JSON");
	});

	test("a reply whose page_disposition contradicts the plan still fails the existing validator", async () => {
		const target = unit("wrong-pages", 2);
		const result = await executeInterpretPlan({
			plan: plan(target), repoRoot: REPO_ROOT, maxAttempts: 1, validate: validateUnitArtifacts,
			runLeaf: async () => ({ exitCode: 0, resultText: replyFor(target, { page_disposition: [{ file: "scan.pdf", page: 1, disposition: "used" }] }) }),
		});
		expect(result.units[0].status).toBe("failed");
		expect(result.units[0].errors.join(" ")).toContain("misses scan.pdf#p2");
	});
});

// §3.6: ksk-marple consumes JSON sheet artifacts, not page images, and was
// explicitly out of scope for the measurement. Its path must be byte-identical
// to what it was before inlining.
describe("the spreadsheet leaf is untouched", () => {
	test("a sheet unit still gets --agent ksk-marple with Read,Write and no stdin", () => {
		const target = sheetUnit("sheet-a");
		expect(leafDelivery(target)).toBe("tool");
		const invocation = claudeLeafInvocation(target, "/repo", new AbortController().signal, ["feedback"], null);
		expect(invocation.args).toEqual([
			"-p", buildLeafPrompt(target, "/repo", ["feedback"], null),
			"--agent", "ksk-marple", "--tools", "Read,Write", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
		]);
		expect(invocation.stdin).toBeUndefined();
		expect(invocation.args).not.toContain("--system-prompt");
		expect(invocation.args).not.toContain("--input-format");
	});

	test("the executor does not write a sheet unit's artifacts — the leaf still does", async () => {
		const target = sheetUnit("sheet-b");
		let sawResultText = false;
		const result = await executeInterpretPlan({
			plan: plan(target), repoRoot: "/repo", maxAttempts: 1,
			validate: async () => ({ ok: false, errors: ["leaf did not write"] }),
			runLeaf: async (invocation) => {
				sawResultText = invocation.stdin !== undefined;
				// A reply that WOULD parse: if the executor were materializing it,
				// the files below would exist.
				return { exitCode: 0, resultText: replyFor(target) };
			},
		});
		expect(sawResultText).toBe(false);
		expect(result.units[0].status).toBe("failed");
		expect(() => readFileSync(target.resultPath, "utf8")).toThrow();
		expect(() => readFileSync(target.fragmentPath, "utf8")).toThrow();
	});

	test("a sheet unit never has its material loaded, so it needs no repo reference files", () => {
		// loadLeafMaterial would throw on a nonexistent repo root; the tool path
		// must not reach it.
		expect(() => claudeLeafInvocation(sheetUnit("sheet-c"), "/nonexistent-repo-root", new AbortController().signal)).not.toThrow();
		expect(() => claudeLeafInvocation(unit("visual-c"), "/nonexistent-repo-root", new AbortController().signal)).toThrow();
	});
});
