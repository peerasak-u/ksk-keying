import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StageAttemptContext, StageDef } from "./logic";
import { DEFAULT_INTERPRET_CONCURRENCY } from "./interpret-executor";
import type { SupervisedProcessOptions, SupervisedProcessResult } from "./process-supervisor";
import {
	AUDIT_LEAF_IDLE_TIMEOUT_MS,
	AUDIT_LEAF_TIMEOUT_MS,
	createSpawnStage,
	INTERPRET_LEAF_IDLE_TIMEOUT_MS,
	INTERPRET_LEAF_TIMEOUT_MS,
	runInterpretStage,
	STAGE_SPAWN_IDLE_TIMEOUT_MS,
	STAGE_SPAWN_TIMEOUT_MS,
	stageHookSettings,
} from "./spawn-stage";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function success(): SupervisedProcessResult {
	return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
}

function failure(reason: SupervisedProcessResult["reason"] = "exited"): SupervisedProcessResult {
	return { ...success(), exitCode: reason === "exited" ? 1 : null, reason };
}

describe("runInterpretStage", () => {
	test("replaces the parent wave with prepared, supervised direct leaves and merge", async () => {
		const root = mkdtempSync("/tmp/ksk-stage2-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_segments", "manifest.yaml"), "schema: ksk_segments.v1\nsegments:\n  - segment_id: seg-001\n    type: pdf_range\n    sources:\n      - {file: scan.pdf, pages: [1, 1], sheets: null}\n");
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 1, sheets: null}\n");
		const staleInterpretation = join(runRoot, "ข้อมูลระบบ", "_segments", "seg-001", "interpretation-old.json");
		const staleFragment = join(runRoot, "ข้อมูลระบบ", "_pages", "fragments", "seg-001-old.yml");
		const staleAudit = join(runRoot, "ข้อมูลระบบ", "_pages", "claim-audit", "seg-001-old.yml");
		for (const path of [staleInterpretation, staleFragment, staleAudit]) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "stale");
		}
		const calls: string[][] = [];
		const result = await runInterpretStage(runRoot, undefined, {
			repoRoot,
			runSupervised: async (options: SupervisedProcessOptions) => {
				calls.push(options.cmd);
				if (options.cmd[0] === "bun" && options.cmd.includes("prepare-pages")) {
					const prepared = join(runRoot, "_pages", "scan");
					mkdirSync(prepared, { recursive: true });
					writeFileSync(join(prepared, "page-001.png"), "png");
					writeFileSync(join(prepared, "manifest.yaml"), "source_path: scan.pdf\npages:\n  - {page: 1, artifact: page-001.png}\n");
					return success();
				}
				if (options.cmd[0] === "claude") {
					const prompt = options.cmd[2];
					if (options.cmd.includes("ksk-lestrade")) {
						const auditPacket = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf("\nWrite exactly"))) as {
							resultPath?: string;
						};
						const auditPath = auditPacket.resultPath;
						if (!auditPath) throw new Error("audit packet omitted result path");
						mkdirSync(dirname(auditPath), { recursive: true });
						writeFileSync(auditPath, "schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 1, reason: blank, verdict: confirmed, evidence: empty}\n");
						return success();
					}
					const packet = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf("\nRead only"))) as {
						resultPath?: string;
						fragmentPath?: string;
					};
					const output = packet.resultPath;
					const fragment = packet.fragmentPath;
					if (!output || !fragment) throw new Error("leaf packet omitted output paths");
					mkdirSync(dirname(output), { recursive: true });
					mkdirSync(dirname(fragment), { recursive: true });
					writeFileSync(output, JSON.stringify({ schema: "ksk_segment_interpretation.v1", segment_id: "seg-001", page_disposition: [{ file: "scan.pdf", page: 1, disposition: "excluded", reason: "blank" }] }));
					writeFileSync(fragment, "schema: ksk_disposition_fragment.v1\nsegment_id: seg-001\nentries:\n  - {file: scan.pdf, page: 1, disposition: excluded, reason: blank}\n");
					return success();
				}
				return success(); // canonical validator and merge
			},
		});
		expect(result).toBe("success");
		const leaf = calls.find((call) => call[0] === "claude")!;
		expect(leaf).toContain("--agent");
		expect(leaf).toContain("ksk-watson");
		expect(leaf).toContain("--tools");
		expect(leaf).toContain("Read,Write");
		expect(leaf.join("\n")).toContain('"source_file": "scan.pdf"');
		expect(calls.some((call) => call.includes("ksk-lestrade") && call.includes("Read,Write"))).toBe(true);
		expect(calls.filter((call) => call[0] === "bun").map((call) => call.includes("prepare-pages") ? "prepare" : call.includes("validate-interpretation") ? "validate" : call.includes("merge-dispositions") ? "merge" : "other")).toEqual(["prepare", "validate", "merge"]);
		expect([staleInterpretation, staleFragment, staleAudit].map(existsSync)).toEqual([false, false, false]);
	});

	test("bounds audits and waits for every sibling cleanup after the first audit failure", async () => {
		const root = mkdtempSync("/tmp/ksk-stage2-audit-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		const segments = Array.from({ length: 5 }, (_, index) => [
			`  - segment_id: seg-00${index + 1}`,
			"    type: pdf_range",
			"    sources:",
			`      - {file: scan.pdf, pages: [${index + 1}, ${index + 1}], sheets: null}`,
		].join("\n")).join("\n");
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_segments", "manifest.yaml"), `schema: ksk_segments.v1\nsegments:\n${segments}\n`);
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 5, sheets: null}\n");
		let activeAudits = 0;
		let maxActiveAudits = 0;
		let auditStarts = 0;
		const result = await runInterpretStage(runRoot, undefined, {
			repoRoot,
			runSupervised: async (options) => {
				if (options.cmd.includes("prepare-pages")) {
					const prepared = join(runRoot, "_pages", "scan");
					mkdirSync(prepared, { recursive: true });
					for (let page = 1; page <= 5; page++) writeFileSync(join(prepared, `page-00${page}.png`), "png");
					writeFileSync(join(prepared, "manifest.yaml"), `source_path: scan.pdf\npages:\n${Array.from({ length: 5 }, (_, index) => `  - {page: ${index + 1}, artifact: page-00${index + 1}.png}`).join("\n")}\n`);
					return success();
				}
				if (options.cmd[0] !== "claude") return success();
				const prompt = options.cmd[2];
				const packet = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf(options.cmd.includes("ksk-lestrade") ? "\nWrite exactly" : "\nRead only"))) as any;
				if (!options.cmd.includes("ksk-lestrade")) {
					mkdirSync(dirname(packet.resultPath), { recursive: true });
					mkdirSync(dirname(packet.fragmentPath), { recursive: true });
					const page = packet.assignedPages[0].page;
					writeFileSync(packet.resultPath, JSON.stringify({ schema: "ksk_segment_interpretation.v1", segment_id: packet.segmentId, page_disposition: [{ file: "scan.pdf", page, disposition: "excluded", reason: "blank" }] }));
					writeFileSync(packet.fragmentPath, `schema: ksk_disposition_fragment.v1\nsegment_id: ${packet.segmentId}\nentries:\n  - {file: scan.pdf, page: ${page}, disposition: excluded, reason: blank}\n`);
					return success();
				}
				auditStarts++;
				activeAudits++;
				maxActiveAudits = Math.max(maxActiveAudits, activeAudits);
				try {
					if (packet.segmentId === "seg-001") {
						await new Promise((resolve) => setTimeout(resolve, 20));
						return failure();
					}
					return await new Promise<SupervisedProcessResult>((resolve) => {
						const finish = () => resolve(failure("aborted"));
						if (options.signal?.aborted) finish();
						else options.signal?.addEventListener("abort", finish, { once: true });
					});
				} finally {
					activeAudits--;
				}
			},
		});
		expect(result).toBe("fail");
		// Tied to the shared concurrency default rather than a literal: the point
		// is that audits are bounded by it and that none is left running, not the
		// particular number the default happens to be today.
		expect(auditStarts).toBe(DEFAULT_INTERPRET_CONCURRENCY);
		expect(maxActiveAudits).toBeLessThanOrEqual(DEFAULT_INTERPRET_CONCURRENCY);
		expect(activeAudits).toBe(0);
	});

	test("the interpret leaf and the exclusion-audit leaf each get their own sane fallback deadline, not the process-supervisor's 60-minute module default", async () => {
		const root = mkdtempSync("/tmp/ksk-stage2-deadlines-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_segments", "manifest.yaml"), "schema: ksk_segments.v1\nsegments:\n  - segment_id: seg-001\n    type: pdf_range\n    sources:\n      - {file: scan.pdf, pages: [1, 1], sheets: null}\n");
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 1, sheets: null}\n");
		const captured: { leaf?: SupervisedProcessOptions; audit?: SupervisedProcessOptions } = {};
		const result = await runInterpretStage(runRoot, undefined, {
			repoRoot,
			runSupervised: async (options: SupervisedProcessOptions) => {
				if (options.cmd[0] === "bun" && options.cmd.includes("prepare-pages")) {
					const prepared = join(runRoot, "_pages", "scan");
					mkdirSync(prepared, { recursive: true });
					writeFileSync(join(prepared, "page-001.png"), "png");
					writeFileSync(join(prepared, "manifest.yaml"), "source_path: scan.pdf\npages:\n  - {page: 1, artifact: page-001.png}\n");
					return success();
				}
				if (options.cmd[0] === "claude") {
					const prompt = options.cmd[2];
					if (options.cmd.includes("ksk-lestrade")) {
						captured.audit = options;
						const auditPacket = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf("\nWrite exactly"))) as { resultPath?: string };
						mkdirSync(dirname(auditPacket.resultPath!), { recursive: true });
						writeFileSync(auditPacket.resultPath!, "schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 1, reason: blank, verdict: confirmed, evidence: empty}\n");
						return success();
					}
					captured.leaf = options;
					const packet = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf("\nRead only"))) as { resultPath?: string; fragmentPath?: string };
					mkdirSync(dirname(packet.resultPath!), { recursive: true });
					mkdirSync(dirname(packet.fragmentPath!), { recursive: true });
					writeFileSync(packet.resultPath!, JSON.stringify({ schema: "ksk_segment_interpretation.v1", segment_id: "seg-001", page_disposition: [{ file: "scan.pdf", page: 1, disposition: "excluded", reason: "blank" }] }));
					writeFileSync(packet.fragmentPath!, "schema: ksk_disposition_fragment.v1\nsegment_id: seg-001\nentries:\n  - {file: scan.pdf, page: 1, disposition: excluded, reason: blank}\n");
					return success();
				}
				return success(); // canonical validator and merge
			},
		});
		expect(result).toBe("success");
		expect(captured.leaf?.timeoutMs).toBe(INTERPRET_LEAF_TIMEOUT_MS);
		expect(captured.leaf?.idleTimeoutMs).toBe(INTERPRET_LEAF_IDLE_TIMEOUT_MS);
		expect(captured.audit?.timeoutMs).toBe(AUDIT_LEAF_TIMEOUT_MS);
		expect(captured.audit?.idleTimeoutMs).toBe(AUDIT_LEAF_IDLE_TIMEOUT_MS);
		// The whole point: these must be minutes, not the process-supervisor's
		// 60-minute module default (see process-supervisor.ts's DEFAULT_TIMEOUT_MS).
		expect(captured.leaf!.timeoutMs!).toBeLessThanOrEqual(30 * 60 * 1_000);
		expect(captured.audit!.timeoutMs!).toBeLessThanOrEqual(30 * 60 * 1_000);
	});

	test("an unproven-cleanup leaf result becomes StageOutcome cleanup-failed, never a plain fail", async () => {
		const root = mkdtempSync("/tmp/ksk-stage2-cleanup-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_segments", "manifest.yaml"), "schema: ksk_segments.v1\nsegments:\n  - segment_id: seg-001\n    type: pdf_range\n    sources:\n      - {file: scan.pdf, pages: [1, 1], sheets: null}\n");
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 1, sheets: null}\n");
		const result = await runInterpretStage(runRoot, undefined, {
			repoRoot,
			runSupervised: async (options: SupervisedProcessOptions) => {
				if (options.cmd[0] === "bun" && options.cmd.includes("prepare-pages")) {
					const prepared = join(runRoot, "_pages", "scan");
					mkdirSync(prepared, { recursive: true });
					writeFileSync(join(prepared, "page-001.png"), "png");
					writeFileSync(join(prepared, "manifest.yaml"), "source_path: scan.pdf\npages:\n  - {page: 1, artifact: page-001.png}\n");
					return success();
				}
				if (options.cmd[0] === "claude") {
					// A process group whose ownership could not be proven torn down —
					// process-supervisor.ts always forces reason to "cleanup-failed" here.
					return { pid: 1, exitCode: null, reason: "cleanup-failed", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: false };
				}
				return success();
			},
		});
		expect(result).toBe("cleanup-failed");
	});
});

describe("createSpawnStage", () => {
	const STAGE: StageDef = { id: "profile", label: "Stage 0 — profile", gate: { kind: "shape", stage: "profile" }, spawnsProcess: true };
	const CONTEXT: StageAttemptContext = { retryCount: 0, previousCheckOutput: null };

	function resultEvent(isError: boolean): Uint8Array {
		return new TextEncoder().encode(`${JSON.stringify({ type: "result", is_error: isError })}\n`);
	}

	test("falls back to the sane per-stage deadline, not the process-supervisor's 60-minute module default, when no env override is set", async () => {
		delete process.env.KSK_STAGE_TIMEOUT_MS;
		delete process.env.KSK_STAGE_IDLE_TIMEOUT_MS;
		let captured: SupervisedProcessOptions | undefined;
		const runStage = createSpawnStage({
			repoRoot: "/repo",
			runSupervised: async (options) => {
				captured = options;
				options.onStdoutChunk?.(resultEvent(false));
				return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
			},
		});
		const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
		expect(outcome).toBe("success");
		expect(captured?.timeoutMs).toBe(STAGE_SPAWN_TIMEOUT_MS);
		expect(captured?.idleTimeoutMs).toBe(STAGE_SPAWN_IDLE_TIMEOUT_MS);
		expect(captured!.timeoutMs!).toBeLessThanOrEqual(30 * 60 * 1_000);
	});

	test("KSK_STAGE_TIMEOUT_MS still overrides the per-stage fallback (same shared knob runScript() uses)", async () => {
		process.env.KSK_STAGE_TIMEOUT_MS = "123456";
		process.env.KSK_STAGE_IDLE_TIMEOUT_MS = "7890";
		try {
			let captured: SupervisedProcessOptions | undefined;
			const runStage = createSpawnStage({
				repoRoot: "/repo",
				runSupervised: async (options) => {
					captured = options;
					options.onStdoutChunk?.(resultEvent(false));
					return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
				},
			});
			await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
			expect(captured?.timeoutMs).toBe(123456);
			expect(captured?.idleTimeoutMs).toBe(7890);
		} finally {
			delete process.env.KSK_STAGE_TIMEOUT_MS;
			delete process.env.KSK_STAGE_IDLE_TIMEOUT_MS;
		}
	});

	test("a cleanup that cannot be proven complete becomes StageOutcome cleanup-failed, never a plain fail an operator might retry past", async () => {
		const runStage = createSpawnStage({
			repoRoot: "/repo",
			runSupervised: async () => ({ pid: 1, exitCode: null, reason: "cleanup-failed", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: false }),
		});
		const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
		expect(outcome).toBe("cleanup-failed");
	});

	test("a plain process failure (proven-clean cleanup) still just fails — cleanup-failed is reserved for the unproven case", async () => {
		const runStage = createSpawnStage({
			repoRoot: "/repo",
			runSupervised: async () => ({ pid: 1, exitCode: 1, reason: "exited", stdout: "", stderr: "boom", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true }),
		});
		const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
		expect(outcome).toBe("fail");
	});
});

describe("stageHookSettings", () => {
	type HookEntry = { type: string; if: string; command: string; args: string[]; timeout: number };
	function hooksFor(stageId: string, repoRoot = "/repo"): HookEntry[] {
		const parsed = JSON.parse(stageHookSettings(stageId, repoRoot));
		expect(parsed.hooks.PostToolUse).toHaveLength(1);
		expect(parsed.hooks.PostToolUse[0].matcher).toBe("Write|Edit");
		return parsed.hooks.PostToolUse[0].hooks;
	}

	test("emits one CLIENT.md validator per write-shaped tool, since `if` holds a single rule", () => {
		expect(hooksFor("profile").map((h) => h.if)).toEqual(["Write(**/CLIENT.md)", "Edit(**/CLIENT.md)"]);
	});

	test("every stage carries the CLIENT.md check — the file has more writers than Stage 0", () => {
		// Stage 0's parent patches CLIENT.md and Stage 1 appends to its
		// Decisions log; scoping to "the stage we think writes it" would repeat
		// the assumption that produced the 345 outage.
		for (const stageId of ["profile", "segment", "link", "group", "categorize", "final"])
			expect(hooksFor(stageId).some((h) => h.if.includes("CLIENT.md"))).toBe(true);
	});

	test("uses exec form so client paths with spaces or Thai characters need no quoting", () => {
		for (const hook of hooksFor("profile")) {
			expect(hook.command).toBe("bun");
			expect(hook.args).toEqual(["/repo/.claude/skills/ksk-keying/scripts/client-md-lint.ts"]);
			expect(hook.type).toBe("command");
		}
	});

	test("resolves the validator under the given repo root, not a build-time constant", () => {
		expect(hooksFor("profile", "/workspace")[0].args[0]).toBe(
			"/workspace/.claude/skills/ksk-keying/scripts/client-md-lint.ts",
		);
	});

	test("bounds the hook so a wedged validator cannot hold a stage open", () => {
		for (const hook of hooksFor("profile")) expect(hook.timeout).toBe(30);
	});

	test("createSpawnStage passes the settings to claude -p", async () => {
		let captured: SupervisedProcessOptions | undefined;
		const runStage = createSpawnStage({
			repoRoot: "/repo",
			runSupervised: async (options) => {
				captured = options;
				options.onStdoutChunk?.(new TextEncoder().encode(`${JSON.stringify({ type: "result", is_error: false })}\n`));
				return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
			},
		});
		await runStage(
			{ id: "profile", label: "Stage 0 — profile", gate: { kind: "shape", stage: "profile" }, spawnsProcess: true },
			"/repo/client/month",
			{ retryCount: 0, previousCheckOutput: null },
			undefined,
		);
		const flagIndex = captured!.cmd.indexOf("--settings");
		expect(flagIndex).toBeGreaterThan(-1);
		expect(captured!.cmd[flagIndex + 1]).toBe(stageHookSettings("profile", "/repo"));
	});
});
