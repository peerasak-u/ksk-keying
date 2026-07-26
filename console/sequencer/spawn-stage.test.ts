import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SupervisedProcessOptions, SupervisedProcessResult } from "./process-supervisor";
import { runInterpretStage } from "./spawn-stage";

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
		expect(auditStarts).toBe(4);
		expect(maxActiveAudits).toBeLessThanOrEqual(4);
		expect(activeAudits).toBe(0);
	});
});
