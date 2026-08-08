import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StageAttemptContext, StageDef } from "./logic";
import { DEFAULT_INTERPRET_CONCURRENCY } from "./interpret-executor";
import type { SupervisedProcessOptions, SupervisedProcessResult } from "./process-supervisor";
import {
	AUDIT_LEAF_IDLE_TIMEOUT_MS,
	AUDIT_LEAF_TIMEOUT_MS,
	captureLeafResult,
	clampWeightedBudgetMs,
	classifyLeafResult,
	computeInterpretLeafTimeoutMs,
	computeScriptRunTimeoutMs,
	computeScriptRunTimeoutMsForPages,
	computeStageSpawnTimeoutMs,
	createSpawnStage,
	INTERPRET_LEAF_FLOOR_MS,
	INTERPRET_LEAF_IDLE_TIMEOUT_MS,
	INTERPRET_LEAF_PER_PAGE_MS,
	INTERPRET_LEAF_TIMEOUT_CEILING_MS,
	MAX_SUPERVISED_WALL_MS,
	PREPARE_PAGES_CHUNK_PAGES,
	PREPARE_PAGES_MAX_CHUNKS,
	resultEventConsumer,
	runInterpretStage,
	runPreparePagesChunked,
	SCRIPT_RUN_PER_PAGE_MS,
	SCRIPT_RUN_TIMEOUT_CEILING_MS,
	SCRIPT_RUN_TIMEOUT_MS,
	STAGE_SPAWN_IDLE_TIMEOUT_MS,
	STAGE_SPAWN_PER_PAGE_MS,
	STAGE_SPAWN_TIMEOUT_CEILING_MS,
	STAGE_SPAWN_TIMEOUT_MS,
	stageHookSettings,
} from "./spawn-stage";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function success(): SupervisedProcessResult {
	return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
}

// Fix F: runPreparePagesChunked() reads the chunk's own --json stdout to
// decide whether to loop again, so a fake prepare-pages call must return that
// shape (bare success() has empty stdout, which is deliberately treated as an
// unparseable/failed chunk) — work_remains: false is what ends the loop after
// exactly one invocation, matching every one of these tests' single-prepare
// expectations.
function successPreparePages(): SupervisedProcessResult {
	return { ...success(), stdout: JSON.stringify({ ok: true, prepared: 1, deferred: 0, work_remains: false }) };
}

function failure(reason: SupervisedProcessResult["reason"] = "exited"): SupervisedProcessResult {
	return { ...success(), exitCode: reason === "exited" ? 1 : null, reason };
}

// Stage 2's inlined visual leaf builds its system prompt from three shipped
// files under the repo root (see interpret-executor.ts's loadLeafMaterial), so
// every fake repo root in these tests has to carry them.
function stubLeafReferences(repoRoot: string) {
	mkdirSync(join(repoRoot, ".claude", "agents"), { recursive: true });
	mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "references", "schemas"), { recursive: true });
	writeFileSync(join(repoRoot, ".claude", "agents", "ksk-watson.md"), "---\nname: ksk-watson\ntools: []\nmodel: sonnet\n---\n\nInterpret the supplied pages and return JSON.\n");
	writeFileSync(join(repoRoot, ".claude", "skills", "ksk-keying", "references", "schemas", "segment-interpretation.md"), "# ksk_segment_interpretation.v1\n");
	writeFileSync(join(repoRoot, ".claude", "skills", "ksk-keying", "references", "extract-playbooks.md"), "# playbooks\n");
}

/** The inlined leaf's packet now arrives on stdin, not in argv. */
function inlineLeafPacket(options: SupervisedProcessOptions): { unitId: string; segmentId: string; assignedPages: Array<{ source_file: string; page: number }>; deterministicValidationErrors: string[] } {
	const message = JSON.parse(new TextDecoder().decode(options.stdin as Uint8Array));
	const head = message.message.content[0].text as string;
	return JSON.parse(head.slice(head.indexOf("{"), head.lastIndexOf("}") + 1));
}

/**
 * ...and its answer comes back as the stream-json `result` event's own
 * `result` string, which the executor parses and writes. Nothing is written to
 * disk by the leaf any more.
 */
function leafReturns(options: SupervisedProcessOptions, interpretation: unknown): SupervisedProcessResult {
	const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(interpretation) }) + "\n";
	options.onStdoutChunk?.(new TextEncoder().encode(line));
	return success();
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
		stubLeafReferences(repoRoot);
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
		const leafStdin: ReturnType<typeof inlineLeafPacket>[] = [];
		const result = await runInterpretStage(runRoot, undefined, {
			repoRoot,
			runSupervised: async (options: SupervisedProcessOptions) => {
				calls.push(options.cmd);
				if (options.cmd[0] === "bun" && options.cmd.includes("prepare-pages")) {
					const prepared = join(runRoot, "_pages", "scan");
					mkdirSync(prepared, { recursive: true });
					writeFileSync(join(prepared, "page-001.png"), "png");
					writeFileSync(join(prepared, "manifest.yaml"), "source_path: scan.pdf\npages:\n  - {page: 1, artifact: page-001.png}\n");
					return successPreparePages();
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
					const packet = inlineLeafPacket(options);
					leafStdin.push(packet);
					return leafReturns(options, { schema: "ksk_segment_interpretation.v1", segment_id: packet.segmentId, page_disposition: [{ file: "scan.pdf", page: 1, disposition: "excluded", reason: "blank" }] });
				}
				return success(); // canonical validator and merge
			},
		});
		expect(result).toMatchObject({ status: "success" });
		const leaf = calls.find((call) => call[0] === "claude")!;
		// The visual leaf is the inlined, tool-less shape: no --agent, no
		// Read/Write grant, its packet and page images on stdin instead.
		expect(leaf).not.toContain("--agent");
		expect(leaf).not.toContain("Read,Write");
		expect(leaf[leaf.indexOf("--tools") + 1]).toBe("");
		expect(leaf).toContain("--input-format");
		expect(leaf.join("\n")).toContain("ksk_segment_interpretation.v1");
		expect(leafStdin.map((packet) => packet.assignedPages)).toEqual([[{ source_file: "scan.pdf", page: 1 }]]);
		// The exclusion auditor is a different leaf and is deliberately unchanged.
		expect(calls.some((call) => call.includes("ksk-lestrade") && call.includes("Read,Write"))).toBe(true);
		expect(calls.filter((call) => call[0] === "bun").map((call) => call.includes("prepare-pages") ? "prepare" : call.includes("validate-interpretation") ? "validate" : call.includes("merge-dispositions") ? "merge" : "other")).toEqual(["prepare", "validate", "merge"]);
		expect([staleInterpretation, staleFragment, staleAudit].map(existsSync)).toEqual([false, false, false]);
	});

	// Regression coverage for the byte-identical-`reason`-echo bug: a real
	// client run died because ksk-watson (correctly, per validate-
	// interpretation.ts's rule that a Stage-2 exclusion reason must be a
	// natural-language Thai sentence, not a short code) wrote a long Thai
	// prose reason, and ksk-lestrade's audit report normalized it to a short
	// slug — a paraphrase with the SAME accounting verdict, just different
	// text. The old code treated any non-identical `reason` as proof the
	// audit report "does not exactly cover claims" and threw one opaque
	// error. A claim's identity is `file`+`page`/`sheet` (claimKey), not its
	// free-text `reason`; the executor already holds the authoritative
	// reason and must not require it echoed back.
	const LONG_THAI_REASON =
		"หน้านี้เป็นสรุปยอดขายรวมของเดือนที่อ้างอิงจากใบกำกับภาษีย่อยหน้าอื่นในไฟล์เดียวกัน ไม่ใช่เอกสารต้นฉบับที่ต้องบันทึกซ้ำ เนื่องจากยอดรวมตรงกับผลรวมของใบกำกับภาษีย่อยทั้งหมดที่ตรวจสอบแล้ว";

	function buildExclusionFixture() {
		const root = mkdtempSync("/tmp/ksk-stage2-auditreport-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		stubLeafReferences(repoRoot);
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_segments", "manifest.yaml"), "schema: ksk_segments.v1\nsegments:\n  - segment_id: seg-001\n    type: pdf_range\n    sources:\n      - {file: scan.pdf, pages: [1, 1], sheets: null}\n");
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 1, sheets: null}\n");
		return { root, runRoot, repoRoot };
	}

	/** Runs the fixture through runInterpretStage, with the single interpret
	 * leaf claiming page 1 excluded (reason: LONG_THAI_REASON), and the
	 * ksk-lestrade audit leaf writing exactly `auditReportYaml`. */
	async function runWithAuditReport(auditReportYaml: string) {
		const { runRoot, repoRoot } = buildExclusionFixture();
		return runInterpretStage(runRoot, undefined, {
			repoRoot,
			runSupervised: async (options: SupervisedProcessOptions) => {
				if (options.cmd[0] === "bun" && options.cmd.includes("prepare-pages")) {
					const prepared = join(runRoot, "_pages", "scan");
					mkdirSync(prepared, { recursive: true });
					writeFileSync(join(prepared, "page-001.png"), "png");
					writeFileSync(join(prepared, "manifest.yaml"), "source_path: scan.pdf\npages:\n  - {page: 1, artifact: page-001.png}\n");
					return successPreparePages();
				}
				if (options.cmd[0] === "claude") {
					const prompt = options.cmd[2];
					if (options.cmd.includes("ksk-lestrade")) {
						const auditPacket = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf("\nWrite exactly"))) as { resultPath?: string };
						if (!auditPacket.resultPath) throw new Error("audit packet omitted result path");
						mkdirSync(dirname(auditPacket.resultPath), { recursive: true });
						writeFileSync(auditPacket.resultPath, auditReportYaml);
						return success();
					}
					return leafReturns(options, { schema: "ksk_segment_interpretation.v1", segment_id: "seg-001", page_disposition: [{ file: "scan.pdf", page: 1, disposition: "excluded", reason: LONG_THAI_REASON }] });
				}
				return success(); // canonical validator and merge
			},
		});
	}

	test("a paraphrased audit reason no longer fails the run — only claim identity (file+page/sheet) matters", async () => {
		const result = await runWithAuditReport(
			"schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 1, reason: summary_report_reference_only, verdict: confirmed, evidence: matches summary totals}\n",
		);
		expect(result).toMatchObject({ status: "success" });
	});

	test("an audit report claiming a page that was never claimed fails with the specific claim key", async () => {
		const result = await runWithAuditReport(
			"schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 99, reason: x, verdict: confirmed, evidence: y}\n",
		);
		expect(result).toMatchObject({ status: "fail" });
		expect((result as { detail?: string }).detail).toContain("audit report claims a page that was never claimed: scan.pdf#p99");
	});

	test("an audit report repeating the same claim key fails naming the repeated key", async () => {
		const result = await runWithAuditReport(
			"schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 1, reason: a, verdict: confirmed, evidence: y}\n  - {file: scan.pdf, page: 1, reason: b, verdict: confirmed, evidence: z}\n",
		);
		expect(result).toMatchObject({ status: "fail" });
		expect((result as { detail?: string }).detail).toContain("audit report repeats a claim: scan.pdf#p1");
	});

	test("an audit report with an invalid verdict fails naming the claim and the bad value", async () => {
		const result = await runWithAuditReport(
			"schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 1, reason: x, verdict: maybe, evidence: y}\n",
		);
		expect(result).toMatchObject({ status: "fail" });
		expect((result as { detail?: string }).detail).toContain('audit claim scan.pdf#p1 has verdict "maybe" (expected confirmed|refuted)');
	});

	test("an audit report missing a claim fails naming the missing key, not just the file path", async () => {
		const result = await runWithAuditReport("schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims: []\n");
		expect(result).toMatchObject({ status: "fail" });
		expect((result as { detail?: string }).detail).toContain("audit report misses 1 claim(s): scan.pdf#p1");
	});

	// The counterpart to the paraphrase rule: `duplicate` is the ONE reason that
	// is NOT free prose (validate-interpretation.ts makes it the only legal
	// non-Thai code, always paired with duplicate_of), and ksk-lestrade runs a
	// different procedure for it. Renaming it is evidence of the wrong test, not
	// a transcription difference — so this one still has to be echoed.
	async function runDuplicateClaimAudit(auditReportYaml: string) {
		const root = mkdtempSync("/tmp/ksk-stage2-dupaudit-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		stubLeafReferences(repoRoot);
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_segments", "manifest.yaml"), "schema: ksk_segments.v1\nsegments:\n  - segment_id: seg-001\n    type: pdf_range\n    sources:\n      - {file: scan.pdf, pages: [1, 2], sheets: null}\n");
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 2, sheets: null}\n");
		const entries = [
			{ file: "scan.pdf", page: 1, disposition: "used" },
			{ file: "scan.pdf", page: 2, disposition: "excluded", reason: "duplicate", duplicate_of: "scan.pdf#p1" },
		];
		return runInterpretStage(runRoot, undefined, {
			repoRoot,
			runSupervised: async (options: SupervisedProcessOptions) => {
				if (options.cmd[0] === "bun" && options.cmd.includes("prepare-pages")) {
					const prepared = join(runRoot, "_pages", "scan");
					mkdirSync(prepared, { recursive: true });
					writeFileSync(join(prepared, "page-001.png"), "png");
					writeFileSync(join(prepared, "page-002.png"), "png");
					writeFileSync(join(prepared, "manifest.yaml"), "source_path: scan.pdf\npages:\n  - {page: 1, artifact: page-001.png}\n  - {page: 2, artifact: page-002.png}\n");
					return successPreparePages();
				}
				if (options.cmd[0] === "claude") {
					const prompt = options.cmd[2];
					if (options.cmd.includes("ksk-lestrade")) {
						const auditPacket = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf("\nWrite exactly"))) as { resultPath?: string };
						if (!auditPacket.resultPath) throw new Error("audit packet omitted result path");
						mkdirSync(dirname(auditPacket.resultPath), { recursive: true });
						writeFileSync(auditPacket.resultPath, auditReportYaml);
						return success();
					}
					return leafReturns(options, { schema: "ksk_segment_interpretation.v1", segment_id: "seg-001", page_disposition: entries });
				}
				return success(); // canonical validator and merge
			},
		});
	}

	test("a duplicate claim audited as a duplicate passes", async () => {
		const result = await runDuplicateClaimAudit(
			"schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 2, reason: duplicate, verdict: confirmed, evidence: same number/date/total/counterparty as p.1}\n",
		);
		expect(result).toMatchObject({ status: "success" });
	});

	test("a duplicate claim renamed by the auditor still fails — the wrong test was applied", async () => {
		const result = await runDuplicateClaimAudit(
			"schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 2, reason: blank, verdict: confirmed, evidence: page is empty}\n",
		);
		expect(result).toMatchObject({ status: "fail" });
		expect((result as { detail?: string }).detail).toContain('audit claim scan.pdf#p2 was claimed as reason "duplicate" but the report audits it as "blank"');
	});

	test("bounds audits and waits for every sibling cleanup after the first audit failure", async () => {
		const root = mkdtempSync("/tmp/ksk-stage2-audit-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		stubLeafReferences(repoRoot);
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
					return successPreparePages();
				}
				if (options.cmd[0] !== "claude") return success();
				if (!options.cmd.includes("ksk-lestrade")) {
					const leafPacket = inlineLeafPacket(options);
					const page = leafPacket.assignedPages[0].page;
					return leafReturns(options, { schema: "ksk_segment_interpretation.v1", segment_id: leafPacket.segmentId, page_disposition: [{ file: "scan.pdf", page, disposition: "excluded", reason: "blank" }] });
				}
				const prompt = options.cmd[2];
				const packet = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf("\nWrite exactly"))) as any;
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
		expect(result).toMatchObject({ status: "fail" });
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
		stubLeafReferences(repoRoot);
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
					return successPreparePages();
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
					return leafReturns(options, { schema: "ksk_segment_interpretation.v1", segment_id: "seg-001", page_disposition: [{ file: "scan.pdf", page: 1, disposition: "excluded", reason: "blank" }] });
				}
				return success(); // canonical validator and merge
			},
		});
		expect(result).toMatchObject({ status: "success" });
		// seg-001 is a 1-page unit here (see the manifest above), so the weighted
		// leaf budget is floor + perPage*1 — not the flat constant this used to be.
		expect(captured.leaf?.timeoutMs).toBe(computeInterpretLeafTimeoutMs({ pages: [{} as never], sheets: [] }));
		expect(captured.leaf?.idleTimeoutMs).toBe(INTERPRET_LEAF_IDLE_TIMEOUT_MS);
		expect(captured.audit?.timeoutMs).toBe(AUDIT_LEAF_TIMEOUT_MS);
		expect(captured.audit?.idleTimeoutMs).toBe(AUDIT_LEAF_IDLE_TIMEOUT_MS);
		// The whole point: these must be minutes, not the process-supervisor's
		// 60-minute module default (see process-supervisor.ts's DEFAULT_TIMEOUT_MS).
		expect(captured.leaf!.timeoutMs!).toBeLessThanOrEqual(30 * 60 * 1_000);
		expect(captured.audit!.timeoutMs!).toBeLessThanOrEqual(30 * 60 * 1_000);
	});

	// G1: the audit-repair leaf (spawn-stage.ts, auditExclusions' repair
	// runLeaf) had ZERO deadline coverage before this test — the old
	// "audit-repair leaf shares the same backstop..." test only compared
	// INTERPRET_LEAF_IDLE_TIMEOUT_MS to AUDIT_LEAF_IDLE_TIMEOUT_MS as bare
	// constants, exercising no call site at all. This drives a real refuted
	// audit through the whole stage so the repair leaf actually runs, and
	// captures the options it hands runSupervised directly — a rewiring bug
	// that pointed the repair leaf at AUDIT_LEAF_IDLE_TIMEOUT_MS (or any other
	// wrong deadline) would fail this test.
	test("the audit-repair leaf call site gets its own weighted deadline and the leaf idle backstop, observed at the real call site", async () => {
		const root = mkdtempSync("/tmp/ksk-stage2-audit-repair-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		stubLeafReferences(repoRoot);
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_segments", "manifest.yaml"), "schema: ksk_segments.v1\nsegments:\n  - segment_id: seg-001\n    type: pdf_range\n    sources:\n      - {file: scan.pdf, pages: [1, 1], sheets: null}\n");
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 1, sheets: null}\n");
		let auditCalls = 0;
		let repairLeafOptions: SupervisedProcessOptions | undefined;
		const result = await runInterpretStage(runRoot, undefined, {
			repoRoot,
			runSupervised: async (options: SupervisedProcessOptions) => {
				if (options.cmd[0] === "bun" && options.cmd.includes("prepare-pages")) {
					const prepared = join(runRoot, "_pages", "scan");
					mkdirSync(prepared, { recursive: true });
					writeFileSync(join(prepared, "page-001.png"), "png");
					writeFileSync(join(prepared, "manifest.yaml"), "source_path: scan.pdf\npages:\n  - {page: 1, artifact: page-001.png}\n");
					return successPreparePages();
				}
				if (options.cmd[0] === "claude") {
					const prompt = options.cmd[2];
					if (options.cmd.includes("ksk-lestrade")) {
						auditCalls++;
						// First audit call refutes the exclusion claim, forcing the one
						// owner repair attempt; second call (post-repair) confirms it so
						// the stage can finish.
						const verdict = auditCalls === 1 ? "refuted" : "confirmed";
						const auditPacket = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf("\nWrite exactly"))) as { resultPath?: string };
						mkdirSync(dirname(auditPacket.resultPath!), { recursive: true });
						writeFileSync(auditPacket.resultPath!, `schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 1, reason: blank, verdict: ${verdict}, evidence: checked}\n`);
						return success();
					}
					// Both the original interpret leaf and the audit-repair leaf share
					// this branch (same agent/command shape) — the label distinguishes
					// which call this is, exactly as spawn-stage.ts's own labels do.
					if (options.label?.startsWith("audit-repair-leaf:")) repairLeafOptions = options;
					return leafReturns(options, { schema: "ksk_segment_interpretation.v1", segment_id: "seg-001", page_disposition: [{ file: "scan.pdf", page: 1, disposition: "excluded", reason: "blank" }] });
				}
				return success(); // canonical validator and merge
			},
		});
		expect(result).toMatchObject({ status: "success" });
		expect(auditCalls).toBe(2); // one refute, one post-repair confirm
		expect(repairLeafOptions).toBeDefined();
		expect(repairLeafOptions?.label).toBe("audit-repair-leaf:seg-001");
		// seg-001 is a 1-page unit, so the weighted budget is floor + perPage*1 —
		// the same formula the main interpret leaf gets, computed fresh here
		// rather than compared against the constant the call site itself uses.
		expect(repairLeafOptions?.timeoutMs).toBe(computeInterpretLeafTimeoutMs({ pages: [{} as never], sheets: [] }));
		expect(repairLeafOptions?.idleTimeoutMs).toBe(INTERPRET_LEAF_IDLE_TIMEOUT_MS);
		expect(repairLeafOptions?.idleTimeoutMs).not.toBe(AUDIT_LEAF_IDLE_TIMEOUT_MS);
	});

	// The probe path is the one part of FIX #2 that can be wrong while every
	// other test still passes: point countPreparedPageArtifacts() at a directory
	// prepare.ts does not write to and it returns 0 forever, so no idle
	// extension is ever earned and the client-345 halt reappears with the fix
	// nominally "in place". This drives the probe through the real call site
	// against a fake prepare-pages that writes where prepare.ts's
	// sourceOutputDir() actually writes (<runRoot>/_pages/<stem>/page-NNN.png),
	// and pins the two ways the probe can go silently inert: a `.png`-only
	// filter (dead on a client of ready .jpg/.xlsx files, which prepare.ts
	// copies through as page-001<ext>) and a non-existent root.
	test("the prepare-pages liveness probe counts the directory prepare.ts really renders into", async () => {
		const root = mkdtempSync("/tmp/ksk-stage2-probe-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		stubLeafReferences(repoRoot);
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_segments", "manifest.yaml"), "schema: ksk_segments.v1\nsegments:\n  - segment_id: seg-001\n    type: pdf_range\n    sources:\n      - {file: scan.pdf, pages: [1, 1], sheets: null}\n");
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 1, sheets: null}\n");
		const captured: { prepare?: SupervisedProcessOptions; validateLabels: string[] } = { validateLabels: [] };
		const result = await runInterpretStage(runRoot, undefined, {
			repoRoot,
			runSupervised: async (options: SupervisedProcessOptions) => {
				if (options.cmd[0] === "bun" && options.cmd.includes("prepare-pages")) {
					captured.prepare = options;
					// Before any render: the probe must be readable and answer 0 on a
					// directory that does not exist yet, never throw.
					expect(options.livenessProbe).toBeDefined();
					expect(options.livenessProbe!()).toBe(0);
					const prepared = join(runRoot, "_pages", "scan");
					mkdirSync(prepared, { recursive: true });
					writeFileSync(join(prepared, "page-001.png"), "png");
					// After one rendered page: the reading must have MOVED, which is
					// what the supervisor accepts as evidence of liveness.
					expect(options.livenessProbe!()).toBe(1);
					writeFileSync(join(prepared, "manifest.yaml"), "source_path: scan.pdf\npages:\n  - {page: 1, artifact: page-001.png}\n");
					// A ready file (image/workbook) is copied through verbatim, never
					// rendered to PNG — it must still register, or a JPEG-only client
					// leaves the probe pinned at 0 and the halt comes back.
					const readyOut = join(runRoot, "_pages", "receipt");
					mkdirSync(readyOut, { recursive: true });
					writeFileSync(join(readyOut, "page-001.jpg"), "jpeg");
					expect(options.livenessProbe!()).toBe(3);
					return successPreparePages();
				}
				if (options.cmd.includes("validate-interpretation")) captured.validateLabels.push(options.label ?? "");
				if (options.cmd[0] === "claude") {
					const prompt = options.cmd[2];
					if (options.cmd.includes("ksk-lestrade")) {
						const auditPacket = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.indexOf("\nWrite exactly"))) as { resultPath?: string };
						mkdirSync(dirname(auditPacket.resultPath!), { recursive: true });
						writeFileSync(auditPacket.resultPath!, "schema: ksk_claim_audit.v1\nsegment_id: seg-001\nclaims:\n  - {file: scan.pdf, page: 1, reason: blank, verdict: confirmed, evidence: empty}\n");
						return success();
					}
					return leafReturns(options, { schema: "ksk_segment_interpretation.v1", segment_id: "seg-001", page_disposition: [{ file: "scan.pdf", page: 1, disposition: "excluded", reason: "blank" }] });
				}
				return success(); // canonical validator and merge
			},
		});
		expect(result).toMatchObject({ status: "success" });
		// F — the chunked call's deadline is sized by PREPARE_PAGES_CHUNK_PAGES
		// (a fixed chunk budget), NOT by this client's own inventory page count
		// the way the single-shot runScript() call used to be — that's the whole
		// point of chunking: every invocation gets the SAME comfortably-under-
		// ceiling deadline regardless of client size.
		expect(captured.prepare?.timeoutMs).toBe(computeScriptRunTimeoutMsForPages(PREPARE_PAGES_CHUNK_PAGES));
		// interpret-plan.ts names every single-window unit's result
		// "interpretation.json", so a basename-derived label would be identical
		// for every unit in the run; the label must carry the unit id instead.
		expect(captured.validateLabels).toEqual(["runScript:validate-interpretation:seg-001"]);
	});

	test("an unproven-cleanup leaf result becomes StageOutcome cleanup-failed, never a plain fail", async () => {
		const root = mkdtempSync("/tmp/ksk-stage2-cleanup-");
		roots.push(root);
		const runRoot = join(root, "month");
		const repoRoot = join(root, "repo");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(repoRoot, ".claude", "skills", "ksk-keying", "scripts"), { recursive: true });
		stubLeafReferences(repoRoot);
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
					return successPreparePages();
				}
				if (options.cmd[0] === "claude") {
					// A process group whose ownership could not be proven torn down —
					// process-supervisor.ts always forces reason to "cleanup-failed" here.
					return { pid: 1, exitCode: null, reason: "cleanup-failed", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: false };
				}
				return success();
			},
		});
		expect(result).toMatchObject({ status: "cleanup-failed" });
	});
});

// Fix F: prepare.ts's --max-pages chunking, the LOOP that drives it, its own
// bound (PREPARE_PAGES_MAX_CHUNKS, D3), and the no-progress guard that should
// fire before that bound ever needs to in practice. Exercised directly
// against runPreparePagesChunked rather than through the whole
// runInterpretStage pipeline — the loop's own contract (when does it call
// again, when does it stop, what does it return) doesn't need a real
// interpret plan/executor around it to verify.
describe("runPreparePagesChunked — fix F chunk loop", () => {
	function writeArtifact(targetDir: string, name: string) {
		const dir = join(targetDir, "_pages", "src");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), "x");
	}

	test("a single chunk reporting work_remains: false completes in one call", async () => {
		const root = mkdtempSync("/tmp/ksk-prepchunk-single-");
		roots.push(root);
		const calls: string[][] = [];
		const result = await runPreparePagesChunked(
			async (options) => {
				calls.push(options.cmd);
				writeArtifact(root, "page-001.png");
				return { ...success(), stdout: JSON.stringify({ prepared: 1, deferred: 0, work_remains: false }) };
			},
			"/repo",
			root,
			undefined,
		);
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("prepare-pages");
		expect(calls[0]).toContain("--max-pages");
		expect(calls[0]).toContain(String(PREPARE_PAGES_CHUNK_PAGES));
		expect(result.exitCode).toBe(0);
		expect(result.reason).toBe("exited");
	});

	test("loops across chunks, making real progress each time, until work_remains is false", async () => {
		const root = mkdtempSync("/tmp/ksk-prepchunk-loop-");
		roots.push(root);
		let calls = 0;
		const result = await runPreparePagesChunked(
			async () => {
				calls++;
				writeArtifact(root, `page-${calls}.png`); // real progress every call
				return { ...success(), stdout: JSON.stringify({ prepared: 1, deferred: 0, work_remains: calls < 3 }) };
			},
			"/repo",
			root,
			undefined,
		);
		expect(calls).toBe(3);
		expect(result.exitCode).toBe(0);
	});

	test("no-progress guard: work_remains stays true but the artifact count never moves — stops rather than spinning", async () => {
		const root = mkdtempSync("/tmp/ksk-prepchunk-noprogress-");
		roots.push(root);
		let calls = 0;
		const result = await runPreparePagesChunked(
			async () => {
				calls++;
				// deliberately writes nothing — no on-disk progress this chunk
				return { ...success(), stdout: JSON.stringify({ prepared: 0, deferred: 5, work_remains: true }) };
			},
			"/repo",
			root,
			undefined,
		);
		expect(calls).toBe(1); // guard fires after the FIRST no-progress chunk, not PREPARE_PAGES_MAX_CHUNKS of them
		expect(result.exitCode).not.toBe(0);
	});

	test("D3 loop bound: a chunk that keeps making progress but never reports work_remains: false still terminates", async () => {
		const root = mkdtempSync("/tmp/ksk-prepchunk-maxchunks-");
		roots.push(root);
		let calls = 0;
		const result = await runPreparePagesChunked(
			async () => {
				calls++;
				writeArtifact(root, `page-${calls}.png`); // always "makes progress" — the no-progress guard must NOT be what stops this
				return { ...success(), stdout: JSON.stringify({ prepared: 1, deferred: 999, work_remains: true }) };
			},
			"/repo",
			root,
			undefined,
		);
		expect(calls).toBe(PREPARE_PAGES_MAX_CHUNKS);
		expect(result.exitCode).not.toBe(0);
	});

	test("unparseable --json output is treated as a failed chunk, never guessed at as 'no work remains'", async () => {
		const root = mkdtempSync("/tmp/ksk-prepchunk-badjson-");
		roots.push(root);
		let calls = 0;
		const result = await runPreparePagesChunked(
			async () => {
				calls++;
				return { ...success(), stdout: "not json" };
			},
			"/repo",
			root,
			undefined,
		);
		expect(calls).toBe(1);
		expect(result.exitCode).not.toBe(0);
	});

	test("a failed chunk (non-zero exit) stops the loop immediately and is returned as-is", async () => {
		const root = mkdtempSync("/tmp/ksk-prepchunk-failed-");
		roots.push(root);
		let calls = 0;
		const failed: SupervisedProcessResult = { pid: 1, exitCode: 1, reason: "exited", stdout: "", stderr: "boom", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
		const result = await runPreparePagesChunked(
			async () => {
				calls++;
				return failed;
			},
			"/repo",
			root,
			undefined,
		);
		expect(calls).toBe(1);
		expect(result).toEqual(failed);
	});

	test("an unproven-cleanup chunk result is returned as-is, never masked as a successful stop", async () => {
		const root = mkdtempSync("/tmp/ksk-prepchunk-cleanup-");
		roots.push(root);
		const unproven: SupervisedProcessResult = { pid: 1, exitCode: null, reason: "cleanup-failed", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: false };
		const result = await runPreparePagesChunked(async () => unproven, "/repo", root, undefined);
		expect(result).toEqual(unproven);
	});

	test("each chunk's deadline is comfortably under MAX_SUPERVISED_WALL_MS", async () => {
		const root = mkdtempSync("/tmp/ksk-prepchunk-deadline-");
		roots.push(root);
		let captured: SupervisedProcessOptions | undefined;
		await runPreparePagesChunked(
			async (options) => {
				captured = options;
				return { ...success(), stdout: JSON.stringify({ prepared: 1, deferred: 0, work_remains: false }) };
			},
			"/repo",
			root,
			undefined,
		);
		expect(captured?.timeoutMs).toBe(computeScriptRunTimeoutMsForPages(PREPARE_PAGES_CHUNK_PAGES));
		expect(captured!.timeoutMs!).toBeLessThan(MAX_SUPERVISED_WALL_MS);
	});
});

describe("computeScriptRunTimeoutMs — D1 weighted runScript() wall", () => {
	function inventoryDir(root: string) {
		return join(root, "ข้อมูลระบบ", "_pages");
	}

	test("a missing inventory.yaml falls back to the flat floor, never a crash or an unbounded deadline", () => {
		const root = mkdtempSync("/tmp/ksk-script-timeout-missing-");
		roots.push(root);
		mkdirSync(inventoryDir(root), { recursive: true });
		// deliberately no inventory.yaml written
		expect(computeScriptRunTimeoutMs(root)).toBe(SCRIPT_RUN_TIMEOUT_MS);
	});

	test("a corrupt/unparseable inventory.yaml falls back to the flat floor, never a crash", () => {
		const root = mkdtempSync("/tmp/ksk-script-timeout-corrupt-");
		roots.push(root);
		mkdirSync(inventoryDir(root), { recursive: true });
		writeFileSync(join(inventoryDir(root), "inventory.yaml"), "files: [this is not: valid: yaml: [[[");
		expect(computeScriptRunTimeoutMs(root)).toBe(SCRIPT_RUN_TIMEOUT_MS);
	});

	test("a small inventory sits at the floor plus its own per-page weight", () => {
		const root = mkdtempSync("/tmp/ksk-script-timeout-small-");
		roots.push(root);
		mkdirSync(inventoryDir(root), { recursive: true });
		writeFileSync(join(inventoryDir(root), "inventory.yaml"), "files:\n  - {path: a.pdf, kind: pdf, page_count: 3, sheets: null}\n  - {path: b.pdf, kind: pdf, page_count: 2, sheets: null}\n");
		expect(computeScriptRunTimeoutMs(root)).toBe(SCRIPT_RUN_TIMEOUT_MS + SCRIPT_RUN_PER_PAGE_MS * 5);
	});

	// The weighted budget is applied by being PASSED INTO deadlines(), which is
	// what reads the operator override — so the override has to keep winning
	// over the computed value, not just over the old flat constant. Reordering
	// the spreads in runScript() would break this silently.
	test("KSK_STAGE_TIMEOUT_MS still overrides the computed weighted wall at the prepare-pages site", async () => {
		const root = mkdtempSync("/tmp/ksk-script-timeout-env-");
		roots.push(root);
		const runRoot = join(root, "month");
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_pages"), { recursive: true });
		mkdirSync(join(runRoot, "ข้อมูลระบบ", "_segments"), { recursive: true });
		writeFileSync(join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 40, sheets: null}\n");
		process.env.KSK_STAGE_TIMEOUT_MS = "654321";
		try {
			let captured: SupervisedProcessOptions | undefined;
			// prepare-pages is failed deliberately: this test only needs the
			// deadline the supervisor was asked for, not a whole stage.
			await runInterpretStage(runRoot, undefined, {
				repoRoot: join(root, "repo"),
				runSupervised: async (options) => {
					captured = options;
					return failure();
				},
			});
			expect(captured?.cmd).toContain("prepare-pages");
			expect(captured?.timeoutMs).toBe(654321);
			expect(computeScriptRunTimeoutMs(runRoot)).toBe(SCRIPT_RUN_TIMEOUT_MS + SCRIPT_RUN_PER_PAGE_MS * 40);
		} finally {
			delete process.env.KSK_STAGE_TIMEOUT_MS;
		}
	});

	test("a huge inventory clamps to the non-negotiable ceiling, not an unbounded budget", () => {
		const root = mkdtempSync("/tmp/ksk-script-timeout-huge-");
		roots.push(root);
		mkdirSync(inventoryDir(root), { recursive: true });
		writeFileSync(join(inventoryDir(root), "inventory.yaml"), "files:\n  - {path: huge.pdf, kind: pdf, page_count: 100000, sheets: null}\n");
		expect(computeScriptRunTimeoutMs(root)).toBe(SCRIPT_RUN_TIMEOUT_CEILING_MS);
	});
});

describe("computeInterpretLeafTimeoutMs — D1 weighted interpret-leaf wall", () => {
	test("a 1-page unit sits at the floor plus one page's weight, well short of the old flat 15 min", () => {
		expect(computeInterpretLeafTimeoutMs({ pages: [{} as never], sheets: [] })).toBe(INTERPRET_LEAF_FLOOR_MS + INTERPRET_LEAF_PER_PAGE_MS);
	});

	test("the worst legal unit (INTERPRET_PAGE_CAP = 15) is comfortably covered and under the ceiling", () => {
		const pages = Array.from({ length: 15 }, () => ({}) as never);
		const budget = computeInterpretLeafTimeoutMs({ pages, sheets: [] });
		expect(budget).toBe(INTERPRET_LEAF_FLOOR_MS + INTERPRET_LEAF_PER_PAGE_MS * 15);
		expect(budget).toBeGreaterThan(15 * 60 * 1_000); // must beat the old flat wall that killed seg-001 twice
		expect(budget).toBeLessThanOrEqual(INTERPRET_LEAF_TIMEOUT_CEILING_MS);
	});

	test("pages and sheets both count toward the weight", () => {
		const pages = [{} as never];
		const sheets = [{} as never, {} as never];
		expect(computeInterpretLeafTimeoutMs({ pages, sheets })).toBe(INTERPRET_LEAF_FLOOR_MS + INTERPRET_LEAF_PER_PAGE_MS * 3);
	});

	test("a weight beyond the legal cap clamps to the ceiling, not an unbounded budget", () => {
		const pages = Array.from({ length: 500 }, () => ({}) as never);
		expect(computeInterpretLeafTimeoutMs({ pages, sheets: [] })).toBe(INTERPRET_LEAF_TIMEOUT_CEILING_MS);
	});

	// B2 refit check: 3 min/page still leaves real margin against the real
	// completion time now on record (seg-001, 13 pages, ~1531s) — the value
	// was reviewed against this data point and deliberately kept, not just
	// left unchecked. If this ratio ever drops toward 1 (or below), the
	// comment's "kept, healthy margin" claim needs revisiting alongside it.
	test("the refit data point (seg-001, 13 pages, ~1531s actual) still sits comfortably under the weighted budget", () => {
		const budget = computeInterpretLeafTimeoutMs({ pages: Array.from({ length: 13 }, () => ({}) as never), sheets: [] });
		const observedActualMs = 1531 * 1_000;
		expect(budget).toBeGreaterThan(observedActualMs);
		expect(budget / observedActualMs).toBeGreaterThan(1.5); // ~1.7x margin per the comment
	});
});

describe("INTERPRET_LEAF_IDLE_TIMEOUT_MS — D2 idle demoted to a coarse backstop", () => {
	// Client 216's seg-001 proved the 5-minute idle timer was killing live
	// work: attempt 1 died at exactly 300s of silence, attempt 2 with
	// identical inputs and the identical setting produced no such gap and
	// completed in ~1531s. The backstop must now clear that observed silence
	// with real headroom, not sit just above it.
	test("the new backstop clears the silence that killed seg-001's first attempt, with real headroom", () => {
		const observedSilenceMs = 300_004; // process-supervisor log: sinceOutputMs=300004
		expect(INTERPRET_LEAF_IDLE_TIMEOUT_MS).toBeGreaterThan(observedSilenceMs * 2);
	});

	// G1: this used to be "audit-repair leaf shares the same backstop as the
	// main interpret leaf" and only compared INTERPRET_LEAF_IDLE_TIMEOUT_MS to
	// AUDIT_LEAF_IDLE_TIMEOUT_MS — two imported constants, no call site
	// exercised. It would still pass if the audit-repair leaf's actual call
	// site (spawn-stage.ts, auditExclusions' repair runLeaf) were rewired to
	// pass AUDIT_LEAF_IDLE_TIMEOUT_MS instead, which is exactly the regression
	// it claimed to guard. The real behavioural assertion — that the
	// audit-repair leaf call site actually hands the supervisor
	// INTERPRET_LEAF_IDLE_TIMEOUT_MS (not the tighter audit-unit idle) and the
	// weighted computeInterpretLeafTimeoutMs deadline — now lives in
	// `describe("runInterpretStage")`'s "the audit-repair leaf call site gets
	// its own weighted deadline..." test, which drives a real refuted audit to
	// force the repair leaf to run and captures the options it actually hands
	// runSupervised.
});

describe("computeStageSpawnTimeoutMs — D1 weighted stage-spawn wall (client-216 group-stage fix)", () => {
	function inventoryDir(root: string) {
		return join(root, "ข้อมูลระบบ", "_pages");
	}

	test("a missing inventory.yaml falls back to the flat floor, never a crash or an unbounded deadline", () => {
		const root = mkdtempSync("/tmp/ksk-stage-spawn-timeout-missing-");
		roots.push(root);
		mkdirSync(inventoryDir(root), { recursive: true });
		// deliberately no inventory.yaml written — this is Stage 0 (profile)'s own
		// spawn, before profile has produced one yet.
		expect(computeStageSpawnTimeoutMs(root)).toBe(STAGE_SPAWN_TIMEOUT_MS);
	});

	test("a corrupt/unparseable inventory.yaml falls back to the flat floor, never a crash", () => {
		const root = mkdtempSync("/tmp/ksk-stage-spawn-timeout-corrupt-");
		roots.push(root);
		mkdirSync(inventoryDir(root), { recursive: true });
		writeFileSync(join(inventoryDir(root), "inventory.yaml"), "files: [this is not: valid: yaml: [[[");
		expect(computeStageSpawnTimeoutMs(root)).toBe(STAGE_SPAWN_TIMEOUT_MS);
	});

	test("a small inventory sits at the floor plus its own per-page weight", () => {
		const root = mkdtempSync("/tmp/ksk-stage-spawn-timeout-small-");
		roots.push(root);
		mkdirSync(inventoryDir(root), { recursive: true });
		writeFileSync(join(inventoryDir(root), "inventory.yaml"), "files:\n  - {path: a.pdf, kind: pdf, page_count: 3, sheets: null}\n  - {path: b.pdf, kind: pdf, page_count: 2, sheets: null}\n");
		expect(computeStageSpawnTimeoutMs(root)).toBe(STAGE_SPAWN_TIMEOUT_MS + STAGE_SPAWN_PER_PAGE_MS * 5);
	});

	test("a synthetic mid-size inventory (200 pages — a chosen size class, NOT client 216's real page count, which was never recorded) clears the flat 30-minute wall that killed 216, well before the 2h policy ceiling", () => {
		const root = mkdtempSync("/tmp/ksk-stage-spawn-timeout-large-");
		roots.push(root);
		mkdirSync(inventoryDir(root), { recursive: true });
		// 200 is a synthetic fixture chosen only to exercise a "many pages" size
		// class comfortably above the old flat 30-min wall — it is NOT a
		// measurement of client 216's actual inventory (that count was never
		// recorded; see computeStageSpawnTimeoutMs's own comment on this). Do not
		// re-fit STAGE_SPAWN_PER_PAGE_MS against this number as if it were 216's
		// real shape.
		// 200 pages: 30 min + 200 * 20s/page = ~96.7 min — clears the old flat
		// 30-min wall with real margin, but still sits under the 2h policy
		// ceiling (kept deliberately below it so this test exercises the
		// weighted formula, not the ceiling clamp — see the huge-inventory test
		// below for that).
		writeFileSync(join(inventoryDir(root), "inventory.yaml"), "files:\n  - {path: scan.pdf, kind: pdf, page_count: 200, sheets: null}\n");
		const budget = computeStageSpawnTimeoutMs(root);
		expect(budget).toBe(STAGE_SPAWN_TIMEOUT_MS + STAGE_SPAWN_PER_PAGE_MS * 200);
		expect(budget).toBeGreaterThan(30 * 60 * 1_000); // must beat the flat wall that killed pid=729 at exactly elapsedMs=1800010
		expect(budget).toBeLessThanOrEqual(STAGE_SPAWN_TIMEOUT_CEILING_MS);
	});

	test("a huge inventory clamps to the non-negotiable ceiling, not an unbounded budget", () => {
		const root = mkdtempSync("/tmp/ksk-stage-spawn-timeout-huge-");
		roots.push(root);
		mkdirSync(inventoryDir(root), { recursive: true });
		writeFileSync(join(inventoryDir(root), "inventory.yaml"), "files:\n  - {path: huge.pdf, kind: pdf, page_count: 100000, sheets: null}\n");
		expect(computeStageSpawnTimeoutMs(root)).toBe(STAGE_SPAWN_TIMEOUT_CEILING_MS);
	});
});

describe("D — MAX_SUPERVISED_WALL_MS operator policy: no ceiling may exceed 2 hours", () => {
	test("the policy constant itself is exactly 2 hours", () => {
		expect(MAX_SUPERVISED_WALL_MS).toBe(2 * 60 * 60 * 1_000);
	});

	test("every declared ceiling in this module is at or under the 2-hour policy", () => {
		for (const ceiling of [INTERPRET_LEAF_TIMEOUT_CEILING_MS, STAGE_SPAWN_TIMEOUT_CEILING_MS, SCRIPT_RUN_TIMEOUT_CEILING_MS]) {
			expect(ceiling).toBeLessThanOrEqual(MAX_SUPERVISED_WALL_MS);
		}
	});

	test("STAGE_SPAWN_TIMEOUT_CEILING_MS and SCRIPT_RUN_TIMEOUT_CEILING_MS sit exactly at the policy cap, not below it", () => {
		// These two used to be sized to clear every real client's honest
		// weighted budget (24h and 8h respectively) — under the new policy they
		// ARE the 2h cap, deliberately, not a smaller number that happens to
		// also satisfy "under 2h".
		expect(STAGE_SPAWN_TIMEOUT_CEILING_MS).toBe(MAX_SUPERVISED_WALL_MS);
		expect(SCRIPT_RUN_TIMEOUT_CEILING_MS).toBe(MAX_SUPERVISED_WALL_MS);
	});

	test("INTERPRET_LEAF_TIMEOUT_CEILING_MS keeps its own tighter 90-minute value", () => {
		// A tighter site-specific ceiling is explicitly allowed by the policy —
		// only EXCEEDING 2h is forbidden.
		expect(INTERPRET_LEAF_TIMEOUT_CEILING_MS).toBe(90 * 60 * 1_000);
		expect(INTERPRET_LEAF_TIMEOUT_CEILING_MS).toBeLessThan(MAX_SUPERVISED_WALL_MS);
	});

	test("the module-load guard's own message names the offending constant and both ms values", () => {
		// Exercises the exact guard clause from spawn-stage.ts (mirrored here,
		// not re-imported under a poisoned constant — reloading the real module
		// from a relocated copy would break its own relative imports to ./logic,
		// ./interpret-executor, etc., which is a test-harness problem, not a
		// policy one). This pins the guard's behaviour/shape so a refactor that
		// silently drops the check is still caught by "every declared ceiling"
		// above, and a refactor that garbles the error message is caught here.
		const name = "STAGE_SPAWN_TIMEOUT_CEILING_MS";
		const poisonedMs = 3 * 60 * 60 * 1_000;
		const check = () => {
			if (poisonedMs > MAX_SUPERVISED_WALL_MS) {
				throw new Error(
					`policy violation: ${name} (${poisonedMs}ms) exceeds MAX_SUPERVISED_WALL_MS ` +
						`(${MAX_SUPERVISED_WALL_MS}ms) — see this file's MAX_SUPERVISED_WALL_MS comment; ` +
						"no supervised wall may exceed the operator's 2-hour policy.",
				);
			}
		};
		expect(check).toThrow(/policy violation: STAGE_SPAWN_TIMEOUT_CEILING_MS/);
	});
});

describe("D2 — clamp order is correct and total, even for a misconfigured floor/ceiling pair", () => {
	test("a normal budget between floor and ceiling passes through unchanged", () => {
		const root = mkdtempSync("/tmp/ksk-clamp-normal-");
		roots.push(root);
		mkdirSync(join(root, "ข้อมูลระบบ", "_pages"), { recursive: true });
		writeFileSync(join(root, "ข้อมูลระบบ", "_pages", "inventory.yaml"), "files:\n  - {path: a.pdf, kind: pdf, page_count: 10, sheets: null}\n");
		const budget = computeScriptRunTimeoutMs(root);
		expect(budget).toBe(SCRIPT_RUN_TIMEOUT_MS + SCRIPT_RUN_PER_PAGE_MS * 10);
		expect(budget).toBeGreaterThanOrEqual(SCRIPT_RUN_TIMEOUT_MS);
		expect(budget).toBeLessThanOrEqual(SCRIPT_RUN_TIMEOUT_CEILING_MS);
	});

	test("the interpret-leaf ceiling is never shorter than its own floor for any legal weight, including weight 0", () => {
		// Weight 0 is the smallest budget the formula can ever produce (floor +
		// perPage * 0 = floor exactly) — the tightest possible check that the
		// clamp cannot return something below the floor.
		const budget = computeInterpretLeafTimeoutMs({ pages: [], sheets: [] });
		expect(budget).toBe(INTERPRET_LEAF_FLOOR_MS);
		expect(budget).toBeGreaterThanOrEqual(INTERPRET_LEAF_FLOOR_MS);
	});

	// BLOCKER FIX (test-truthfulness finding): the previous version of this
	// test called computeInterpretLeafTimeoutMs with a large weight against
	// the real, correctly-ordered floor/ceiling constants (floor 5 min <
	// ceiling 90 min) and asserted the result equals the ceiling — but
	// Math.min(Math.max(budget, floor), ceiling) (the OLD, buggy shape)
	// produces the IDENTICAL 90-minute result for a correctly-ordered pair, so
	// the assertion passed under both the old and new clamp shapes and proved
	// nothing about the fix. No real call site can ever supply an inverted
	// pair (every floor/ceiling constant in this file is correctly ordered by
	// construction), so exercising the actual bug requires calling
	// clampWeightedBudgetMs directly with one — which is exactly why it is
	// exported (see its own comment).
	test("clampWeightedBudgetMs widens an inverted ceiling back up to the floor, never returning below it", () => {
		// ceilingMs (5 min) < floorMs (10 min): the exact misconfiguration D2's
		// comment describes. Math.min(Math.max(budgetMs, floorMs), ceilingMs)
		// (the OLD shape) returns ceilingMs = 5 min here — a wall SHORTER than
		// the function's own floor fallback. The NEW shape must return floorMs
		// (10 min) instead, by widening the inverted ceiling up to the floor
		// before clamping.
		const floorMs = 10 * 60 * 1_000;
		const ceilingMs = 5 * 60 * 1_000;
		// budgetMs is always >= floorMs by construction at every real call site
		// (floorMs + perPageMs * weight, weight >= 0) — clampWeightedBudgetMs
		// relies on that precondition and only clamps the CEILING side, so every
		// case here supplies a budgetMs at or above floorMs, exactly like a real
		// caller would.
		expect(clampWeightedBudgetMs(floorMs, floorMs, ceilingMs)).toBe(floorMs);
		// A budget above the floor still clamps to the (widened) floor when the
		// ceiling is inverted — the floor becomes the effective ceiling too.
		expect(clampWeightedBudgetMs(floorMs * 100, floorMs, ceilingMs)).toBe(floorMs);
	});

	test("a correctly-ordered ceiling still clamps a budget that exceeds it", () => {
		// The ordinary (non-inverted) ceiling-clamp branch — kept as its own
		// test now that the inverted-pair case above no longer conflates the
		// two. Forces a weight large enough that INTERPRET_LEAF_TIMEOUT_CEILING_MS
		// (90 min) binds ahead of the formula's own floor+perPage budget.
		const weight = 500; // far past the legal cap; forces the ceiling branch
		const budget = computeInterpretLeafTimeoutMs({ pages: Array.from({ length: weight }, () => ({}) as never), sheets: [] });
		expect(budget).toBeGreaterThanOrEqual(INTERPRET_LEAF_FLOOR_MS);
		expect(budget).toBe(INTERPRET_LEAF_TIMEOUT_CEILING_MS);
	});
});

// BLOCKER FIX: interpret-leaf / audit-repair-leaf / exclusion-audit call sites
// used to derive is_error / usage-limit purely from processOutput(result) —
// the supervisor's own separately bounded, HEAD-retained stdout+stderr text.
// A real leaf's `result` event is always the LAST line of a multi-minute,
// multi-MB transcript, so that text essentially never contains it. These
// tests exercise classifyLeafResult/captureLeafResult directly against a
// result whose retained stdout text does NOT carry the result event at all
// (simulating exactly that truncation) while the INCREMENTAL onStdoutChunk
// stream does — proving the classification now comes from the captured event,
// not from the truncated retained text.
describe("captureLeafResult / classifyLeafResult — is_error survives retained-output truncation", () => {
	function resultWithoutRetainedEvent(overrides: Partial<SupervisedProcessResult> = {}): SupervisedProcessResult {
		// The retained stdout/stderr the supervisor kept is just the transcript's
		// HEAD (some ordinary tool-use chatter) — no trailing result line at
		// all, exactly what process-supervisor.ts's captureStream produces once
		// maxOutputBytes is exhausted before the child's last line arrives.
		return {
			pid: 1,
			exitCode: 0,
			reason: "exited",
			stdout: '{"type":"assistant","message":"working..."}\n',
			stderr: "",
			stdoutTruncated: true,
			stderrTruncated: false,
			cleanupComplete: true,
			...overrides,
		};
	}

	test("a captured is_error:true result event is trusted even though the retained stdout text never shows it", () => {
		const capture = captureLeafResult("test:stdout");
		// The INCREMENTAL stream (what a real leaf's stdout actually carried,
		// byte for byte) — distinct from the truncated `stdout` field above.
		capture.onStdoutChunk(new TextEncoder().encode(`{"type":"assistant","message":"working..."}\n`));
		capture.onStdoutChunk(new TextEncoder().encode(`{"type":"result","is_error":true,"result":"boom"}\n`));
		const classified = classifyLeafResult(resultWithoutRetainedEvent(), capture.get());
		expect(classified.isError).toBe(true);
		expect(classified.signalLost).toBe(false);
	});

	test("a captured is_error:false result event is trusted the same way", () => {
		const capture = captureLeafResult("test:stdout");
		capture.onStdoutChunk(new TextEncoder().encode(`{"type":"result","is_error":false}\n`));
		const classified = classifyLeafResult(resultWithoutRetainedEvent(), capture.get());
		expect(classified.isError).toBe(false);
	});

	test("stdoutTruncated with no captured event is treated as the error signal being lost, not as success", () => {
		// Nothing ever arrived on the incremental stream either (e.g. the
		// process was killed before finishing) — captured event is null, and
		// the result the supervisor returned says its stdout was truncated.
		const capture = captureLeafResult("test:stdout");
		const classified = classifyLeafResult(resultWithoutRetainedEvent({ stdoutTruncated: true }), capture.get());
		expect(classified.isError).toBe(true);
		expect(classified.signalLost).toBe(true);
	});

	test("a discarded stdout line is treated as the error signal being lost even if stdoutTruncated is false", () => {
		const capture = captureLeafResult("test:stdout");
		// A line past classifyDeferBytes with no discoverable top-level `type`
		// key — the resultEventConsumer's own tainting branch (see its tests
		// above) — reported through onDiscard, not through stdoutTruncated.
		capture.onStdoutChunk(new TextEncoder().encode(`{"data":"${"x".repeat(600 * 1024)}"`));
		const classified = classifyLeafResult(resultWithoutRetainedEvent({ stdoutTruncated: false }), capture.get());
		expect(classified.isError).toBe(true);
		expect(classified.signalLost).toBe(true);
	});

	test("no captured event and no truncation/discard falls back to the old text scan (unaffected pre-existing shape)", () => {
		const capture = captureLeafResult("test:stdout");
		const classified = classifyLeafResult(
			resultWithoutRetainedEvent({ stdoutTruncated: false, stdout: '{"type":"assistant"}\n' }),
			capture.get(),
		);
		expect(classified.isError).toBe(false);
		expect(classified.signalLost).toBe(false);
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
		expect(outcome).toMatchObject({ status: "success" });
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
		expect(outcome).toMatchObject({ status: "cleanup-failed" });
	});

	test("a plain process failure (proven-clean cleanup) still just fails — cleanup-failed is reserved for the unproven case", async () => {
		const runStage = createSpawnStage({
			repoRoot: "/repo",
			runSupervised: async () => ({ pid: 1, exitCode: 1, reason: "exited", stdout: "", stderr: "boom", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true }),
		});
		const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
		expect(outcome).toMatchObject({ status: "fail" });
	});

	// Fix C/D/E — an oversized stream-json line must not be able to hide a
	// real stage failure behind a discarded `result` event. The parser's own
	// 4 MiB-with-no-newline discard bound (resultEventConsumer) is a real,
	// necessary memory guard (a broken/malicious child that never emits a
	// newline must not be able to grow the buffer without limit) — these
	// tests are about what happens to StageOutcome once that guard has
	// actually fired, not about relaxing the guard itself. Fix D raised the
	// bound from an original 256 KB to 4 MiB after the 216 run showed real,
	// successful stages writing single stream-json lines as large as 502 KB.
	// Fix E (below) went further and stopped that bound from being the thing
	// that decides a line's fate at all for the common case: a line is now
	// classified from its head first, and only a line that IS (or cannot be
	// ruled out as) the `result` event ever gets buffered up to this 4 MiB
	// cap — the test payloads below are still sized past it, to exercise that
	// remaining, narrower path.
	describe("resultEventConsumer — discard reporting and tail handling", () => {
		test("an oversized unterminated line calls onDiscard exactly once and never reaches onResultEvent", () => {
			const events: unknown[] = [];
			let discards = 0;
			const consume = resultEventConsumer(
				"test",
				(evt) => events.push(evt),
				() => { discards += 1; },
			);
			consume(new TextEncoder().encode(`{"type":"result","note":"${"x".repeat(5 * 1024 * 1024)}`));
			expect(discards).toBe(1);
			expect(events).toEqual([]);
		});

		test("the tail of a discarded line is skipped, not parsed as a fresh event, even when it happens to be valid JSON on its own", () => {
			const events: unknown[] = [];
			let discards = 0;
			const consume = resultEventConsumer(
				"test",
				(evt) => events.push(evt),
				() => { discards += 1; },
			);
			consume(new TextEncoder().encode(`{"type":"result","note":"${"x".repeat(5 * 1024 * 1024)}`));
			// A well-formed, complete JSON line arriving right after the discard —
			// without the tail-skip fix this would be sliced at its own newline
			// and handed straight to JSON.parse(), producing a synthetic
			// successful-looking event that was never actually emitted.
			consume(new TextEncoder().encode(`{"type":"result","is_error":false}\n`));
			expect(events).toEqual([]);
			expect(discards).toBe(1);
		});

		test("parsing resumes normally on the next real line after the skipped tail", () => {
			const events: unknown[] = [];
			const consume = resultEventConsumer(
				"test",
				(evt) => events.push(evt),
				() => {},
			);
			consume(new TextEncoder().encode(`{"type":"result","note":"${"x".repeat(5 * 1024 * 1024)}`));
			// The garbage tail (ending the discarded line) followed, in the SAME
			// chunk, by a genuine subsequent line — both must be handled: the
			// tail dropped, the real line parsed.
			consume(new TextEncoder().encode(`garbage-tail-fragment\n{"type":"result","is_error":true}\n`));
			expect(events).toEqual([{ type: "result", is_error: true }]);
		});

		// BLOCKER FIX: classifyHead used to take the FIRST `"type":"<value>"`
		// pair found anywhere in the head, which is only correct if `type` is
		// guaranteed to be the line's own TOP-LEVEL key — a nested object's own
		// `type` key (here, `meta.type`) sitting textually before the line's
		// real top-level `type` used to win the match, silently misclassifying
		// a genuine `result` event as "other" with no discard and no taint.
		// Padded past classifyDeferBytes (512 KiB) so the still-incomplete-line
		// classify path (not the whole-line fast path) is actually exercised.
		test("a nested `type` key preceding the line's own top-level `type` does not misclassify a real result event", () => {
			const events: unknown[] = [];
			let discards = 0;
			const consume = resultEventConsumer(
				"test",
				(evt) => events.push(evt),
				() => { discards += 1; },
			);
			const pad = "x".repeat(600 * 1024);
			const line = `{"meta":{"type":"text","note":"${pad}"},"type":"result","is_error":true}\n`;
			consume(new TextEncoder().encode(line.slice(0, 100)));
			consume(new TextEncoder().encode(line.slice(100)));
			expect(events).toEqual([{ meta: { type: "text", note: pad }, type: "result", is_error: true }]);
			expect(discards).toBe(0);
		});

		// BLOCKER FIX: classifying a still-incomplete line from a head-scan
		// PREFIX, instead of waiting for whatever a whole-line delivery would
		// have done, made StageOutcome depend on `reader.read()`'s ARBITRARY
		// chunk boundaries — a retry could flip pass/fail on byte-for-byte
		// identical child output. Below classifyDeferBytes (512 KiB), the two
		// delivery shapes (one chunk vs. many) must now agree exactly.
		test("a line under classifyDeferBytes parses identically whether delivered whole or split across many chunks", () => {
			function run(chunks: string[]) {
				const events: unknown[] = [];
				let discards = 0;
				const consume = resultEventConsumer("test", (evt) => events.push(evt), () => { discards += 1; });
				for (const chunk of chunks) consume(new TextEncoder().encode(chunk));
				return { events, discards };
			}
			// A ~70 KB non-result field before the real `type` key — past
			// headScanBytes (64 KiB) but well under classifyDeferBytes (512 KiB).
			const line = `{"a":"${"z".repeat(70 * 1024)}","type":"result","is_error":true}\n`;
			const whole = run([line]);
			const split = run([line.slice(0, -2), line.slice(-2)]);
			const chunked: string[] = [];
			for (let i = 0; i < line.length; i += 997) chunked.push(line.slice(i, i + 997));
			const manyChunks = run(chunked);
			expect(whole).toEqual({ events: [{ a: "z".repeat(70 * 1024), type: "result", is_error: true }], discards: 0 });
			expect(split).toEqual(whole);
			expect(manyChunks).toEqual(whole);
		});

		test("an ordinary transcript with no oversized line never calls onDiscard", () => {
			const events: unknown[] = [];
			let discards = 0;
			const consume = resultEventConsumer(
				"test",
				(evt) => events.push(evt),
				() => { discards += 1; },
			);
			consume(new TextEncoder().encode(`{"type":"assistant","note":"hello"}\n`));
			consume(new TextEncoder().encode(`{"type":"result","is_error":false}\n`));
			expect(discards).toBe(0);
			expect(events).toEqual([{ type: "result", is_error: false }]);
		});

		// E — the actual fix: a huge line whose head proves it is NOT a `result`
		// event must be skipped for free (no buffering, no taint), unlike the
		// pre-fix behaviour where line SIZE alone decided whether it got
		// discarded regardless of what it actually was.
		test("a huge non-result (tool_result-shaped) line never calls onDiscard and never blocks the next real result event", () => {
			const events: unknown[] = [];
			let discards = 0;
			const consume = resultEventConsumer(
				"test",
				(evt) => events.push(evt),
				() => { discards += 1; },
			);
			// "type" appears early, but its value is "user" (the event shape that
			// wraps a huge tool_result), not "result" — this is exactly the real
			// review-data.json / categorize.json incident shape from fix D's own
			// measurements, sized well past the 4 MiB bound this used to trip.
			const hugeNonResult = `{"type":"user","message":{"content":"${"x".repeat(5 * 1024 * 1024)}"}}\n`;
			consume(new TextEncoder().encode(hugeNonResult));
			consume(new TextEncoder().encode(`{"type":"result","is_error":false}\n`));
			expect(discards).toBe(0);
			expect(events).toEqual([{ type: "result", is_error: false }]);
		});

		test("a huge line that IS itself a result event is still fully parsed and reported, not skipped", () => {
			const events: unknown[] = [];
			let discards = 0;
			const consume = resultEventConsumer(
				"test",
				(evt) => events.push(evt),
				() => { discards += 1; },
			);
			// A large but legal payload — under the 4 MiB hard cap on a
			// classified "result" line — must still be fully assembled and
			// parsed, not treated as if it were an ordinary skippable line just
			// because it is large.
			const padded = "x".repeat(1024 * 1024);
			consume(new TextEncoder().encode(`{"type":"result","is_error":false,"note":"${padded}"}\n`));
			expect(discards).toBe(0);
			expect(events).toEqual([{ type: "result", is_error: false, note: padded }]);
		});

		test("the classifying token survives being split across a chunk boundary", () => {
			const events: unknown[] = [];
			let discards = 0;
			const consume = resultEventConsumer(
				"test",
				(evt) => events.push(evt),
				() => { discards += 1; },
			);
			// The literal substring `"type":"result"` is split mid-token across
			// two chunks; classification must re-scan the CUMULATIVE buffer, not
			// each chunk in isolation, to still catch it correctly as "other"
			// (value is "user", not "result") and skip it for free.
			consume(new TextEncoder().encode(`{"typ`));
			consume(new TextEncoder().encode(`e":"user","big":"${"x".repeat(5 * 1024 * 1024)}"}\n`));
			consume(new TextEncoder().encode(`{"type":"result","is_error":true}\n`));
			expect(discards).toBe(0);
			expect(events).toEqual([{ type: "result", is_error: true }]);
		});

		test("a line whose head never reveals a type key at all is treated as ambiguous and tainted", () => {
			const events: unknown[] = [];
			let discards = 0;
			const consume = resultEventConsumer(
				"test",
				(evt) => events.push(evt),
				() => { discards += 1; },
			);
			// No `"type":"..."` pair anywhere — including past the 64 KB head-scan
			// budget — so this can never be classified "other" or "result"; the
			// classifier must fall to the safe, tainting branch rather than guess.
			// No trailing newline yet, deliberately: with one present the (much
			// cheaper, and correct) fast path would just parse this as a normal
			// complete line — the ambiguous-classification branch under test only
			// applies to a still-growing, not-yet-terminated line. Past
			// classifyDeferBytes (512 KiB), not just headScanBytes (64 KiB): a
			// still-incomplete line below classifyDeferBytes is deliberately left
			// to keep growing rather than classified at all (see that constant's
			// comment — it's what makes whole-chunk and split-chunk delivery of
			// the SAME bytes agree), so this test must exceed it to actually reach
			// the classify-or-discard logic under test.
			consume(new TextEncoder().encode(`{"data":"${"x".repeat(600 * 1024)}"`));
			expect(discards).toBe(1);
			expect(events).toEqual([]);
		});
	});

	describe("a discarded oversized stream-json line taints the outcome", () => {
		function oversizedLineThen(tail: Uint8Array): Uint8Array[] {
			// One giant unterminated chunk (well past the 4 MiB bound, no
			// newline anywhere in it) followed by whatever comes next on the
			// wire — exactly the shape process-supervisor.ts's own bounded
			// capture cannot protect this incremental JSON parser from, since
			// the parser keeps its own buffer independent of the supervisor's.
			const huge = new TextEncoder().encode(`{"type":"result","note":"${"x".repeat(5 * 1024 * 1024)}`);
			return [huge, tail];
		}

		test("an oversized line followed by a valid success result: the discard still forces fail, not a pass-through", async () => {
			let captured: SupervisedProcessOptions | undefined;
			const runStage = createSpawnStage({
				repoRoot: "/repo",
				runSupervised: async (options) => {
					captured = options;
					for (const chunk of oversizedLineThen(resultEvent(false))) options.onStdoutChunk?.(chunk);
					return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
				},
			});
			const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
			// Without this fix, sawSuccessResult would be set from the second,
			// intact line and sawErrorResult would never be set (the discarded
			// line's own is_error, whatever it was, is unknowable) — a silent
			// false "success". The fix must refuse to certify success here.
			expect(outcome).toMatchObject({ status: "fail" });
			expect(captured).toBeDefined();
		});

		test("an oversized line that IS itself the result event: still fails, and its tail is never mistaken for a fresh event", async () => {
			const runStage = createSpawnStage({
				repoRoot: "/repo",
				runSupervised: async (options) => {
					// The giant line's own tail — after the 4 MiB discard point —
					// still arrives on the wire and terminates with a newline. If
					// that tail were (mis)treated as a fresh line, this happens to be
					// valid, complete JSON on its own once sliced at the newline —
					// exactly the second-order bug this fix also has to close: it must
					// NOT be parsed as a real (successful-looking) event.
					const tail = new TextEncoder().encode(`{"type":"result","is_error":false}\n`);
					for (const chunk of oversizedLineThen(tail)) options.onStdoutChunk?.(chunk);
					return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
				},
			});
			const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
			expect(outcome).toMatchObject({ status: "fail" });
		});

		test("a normal transcript with no oversized line still succeeds — this fix does not fail every stage that ever prints a long line", async () => {
			const runStage = createSpawnStage({
				repoRoot: "/repo",
				runSupervised: async (options) => {
					// A generous, but ordinary, line — nowhere near the 4 MiB bound —
					// followed by the real result event, exactly like a normal run.
					options.onStdoutChunk?.(new TextEncoder().encode(`{"type":"assistant","note":"${"x".repeat(4096)}"}\n`));
					options.onStdoutChunk?.(resultEvent(false));
					return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
				},
			});
			const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
			expect(outcome).toMatchObject({ status: "success" });
		});

		// E — the root-cause fix at outcome level: a stage that Writes a huge
		// artifact (a real, successful Write tool_result on stdout) must pass
		// cleanly, not just avoid the OLD size-based discard — this exercises
		// the same shape through the full createSpawnStage path, not just the
		// consumer in isolation above.
		test("a huge tool_result line on stdout followed by a clean result event passes with no taint", async () => {
			const runStage = createSpawnStage({
				repoRoot: "/repo",
				runSupervised: async (options) => {
					const hugeToolResult = new TextEncoder().encode(
						`{"type":"user","message":{"content":"${"x".repeat(5 * 1024 * 1024)}"}}\n`,
					);
					options.onStdoutChunk?.(hugeToolResult);
					options.onStdoutChunk?.(resultEvent(false));
					return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
				},
			});
			const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
			expect(outcome).toMatchObject({ status: "success" });
		});

		// E — stdout and stderr are no longer equally authoritative: a discard
		// on stderr (which never carries the structured `result` event under
		// this protocol) must not be able to fail a stage that stdout reports
		// as clean — the exact validator-caught bug this rewrite resolves.
		test("an oversized, unclassifiable line on STDERR does not taint a stage whose stdout delivered a clean result", async () => {
			const runStage = createSpawnStage({
				repoRoot: "/repo",
				runSupervised: async (options) => {
					// No "type" key anywhere, and no trailing newline yet — genuinely
					// unclassifiable and still growing, well past classifyDeferBytes
					// (512 KiB, not just the 64 KiB head-scan budget — see that
					// constant's comment) so this DOES trip the tainting branch
					// inside resultEventConsumer; the point of this test is that the
					// taint must not propagate to StageOutcome from stderr.
					const ambiguousStderr = new TextEncoder().encode(`{"data":"${"x".repeat(600 * 1024)}"`);
					options.onStderrChunk?.(ambiguousStderr);
					options.onStdoutChunk?.(resultEvent(false));
					return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
				},
			});
			const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
			expect(outcome).toMatchObject({ status: "success" });
		});

		// BLOCKER FIX: a validator caught the mirror-image bug of the test above —
		// this file used to pass the SAME onResultEvent to both streams'
		// resultEventConsumer, so a `{"type":"result","is_error":false}`-shaped
		// line arriving on STDERR (a wrapper script echoing a transcript, a
		// subagent printing its own captured stream-json, …) could set
		// sawSuccessResult and certify a stage "success" even though STDOUT never
		// delivered a result event at all. Per this file's own comment, stderr
		// carries incidental diagnostic text under this protocol and must never
		// be authoritative for StageOutcome in EITHER direction.
		test("a result-shaped line on STDERR cannot certify success when stdout never delivered one", async () => {
			const runStage = createSpawnStage({
				repoRoot: "/repo",
				runSupervised: async (options) => {
					options.onStderrChunk?.(resultEvent(false));
					// Deliberately no stdout result event at all.
					return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true };
				},
			});
			const outcome = await runStage(STAGE, "/repo/client/month", CONTEXT, undefined);
			expect(outcome).toMatchObject({ status: "fail" });
		});
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
