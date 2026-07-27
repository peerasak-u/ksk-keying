// Real per-stage `claude -p` spawn: one bounded,
// fresh-context headless invocation of `/ksk-stage-<id>`, per the R&D
// decision that each ksk-stage-* skill becomes a standalone entry point —
// the actual fix for context bloat, since no single session accumulates all
// 6 stages anymore.
//
// StageOutcome ("success" | "fail") is decided from the stream-json
// protocol's OWN structured result event (`is_error`) plus the process exit
// code — never by regexing the assistant's prose, unlike
// console/engine.ts's existing GATE_RE/UNFINISHED_RE. Whether the STAGE
// itself actually finished is a separate question, answered afterward by
// completion-check.ts's real gate/shape check against on-disk evidence —
// this function only answers "did the process complete without erroring."
//
// Real finding from the first live run against samples/clients/216 (see the
// prototype's NOTES.md in git history, commit 6782210): a bare
// `/ksk-stage-profile <dir>` prompt stopped after the
// agent-dispatch/policy-gate portion of the skill and never reached its own
// "0.5 Inventory" deterministic-script step, identically across all 3
// attempts (a fresh context has no reason to behave differently on a retry
// unless told what the previous attempt missed). The headless directive and
// retry-context appendage below exist because of that — folded directly
// into the `-p` prompt text (not `--append-system-prompt`) so this works the
// same under a subscription plan as any normal interactive prompt would.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import type { StageAttemptContext, StageDef, StageOutcome, StageRunner } from "./logic";
import { executeInterpretPlan, isUsageLimitText, validateUnitArtifacts, type LeafInvocation, type UnitValidator } from "./interpret-executor";
import { createInterpretPlan, type Disposition, type Inventory, type InterpretPlan, type InterpretUnit, type SegmentsManifest } from "./interpret-plan";
import { runSupervisedProcess, type SupervisedProcessOptions, type SupervisedProcessResult } from "./process-supervisor";

const HERE = dirname(new URL(import.meta.url).pathname);
const PREPARE_SHEET_SCRIPT = resolve(HERE, "prepare-sheet.ts");
// `claude` walks UP from cwd looking for .claude/ — on a bare-host run two
// levels up from HERE lands on the repo root, which is correct. In the
// ksk-app Docker image only console/'s own contents get copied to /app, so
// the same guess lands on "/" and .claude is never found (silent no-op: the
// process "completes" having never actually run /ksk-stage-*). The real
// scripts are bind-mounted at $KSK_WORKSPACE_ROOT/.claude there — see
// docker-compose.yml's KSK_APP_SKILLS_HOST — so cwd must be
// $KSK_WORKSPACE_ROOT in that case, not "/".
const HOST_GUESS = resolve(HERE, "../..");
const REPO_ROOT =
	existsSync(resolve(HOST_GUESS, ".claude")) || !process.env.KSK_WORKSPACE_ROOT
		? HOST_GUESS
		: resolve(process.env.KSK_WORKSPACE_ROOT);

// Per CLAUDE.md's "Agent teams — model tiers": a stage's own top-level
// session here does mechanical rule-following (dispatch the skill's named
// subagents, resolve Decision Policy rules, run deterministic scripts) —
// sonnet-tier work, never the reserved opus tier. Pinned explicitly so every
// stage runs on a deliberate choice rather than whatever `claude`'s ambient
// default happens to resolve to on a given machine. (The subagents each
// stage dispatches — ksk-magnum/columbo, ksk-watson/sherlock/poirot/marple,
// ksk-lestrade — already pin their own model via their own frontmatter,
// independent of this.)
const STAGE_MODEL = "sonnet";

// Distinct from console/engine.ts's HEADLESS_DIRECTIVE (which is about not
// abandoning IN-FLIGHT BACKGROUND WAVES within one long multi-stage
// session). This one is about a DIFFERENT failure mode specific to
// single-stage standalone invocation: a ksk-stage-* skill's instructions
// were written assuming an orchestrating parent keeps going across several
// actions in one session — a bare one-shot invocation can end its turn once
// the judgment/agent-dispatch part feels "done", never reaching that same
// skill's own later deterministic-script steps. Sent as part of the `-p`
// message itself, appended after the slash command (which must lead the
// message for Claude Code to recognize it as the skill invocation).
const HEADLESS_DIRECTIVE =
	"HEADLESS RUN (claude -p, ONE stage, no orchestrator): this process exits the moment " +
	"you end your turn, and nothing else will nudge it forward afterward — no parent " +
	"session, no follow-up turn, no human watching this attempt. You must complete EVERY " +
	"step the invoked skill instructs before ending your turn, including any deterministic " +
	"script it tells the parent to run — in this mode YOU are the parent, so do not stop " +
	"once the agent-dispatch/judgment portion feels complete if the skill lists further " +
	"steps after it (e.g. a census/inventory/build script). Never dispatch background or " +
	"async work you will not wait for — anything still in flight when your turn ends is " +
	"simply lost, not resumed. If you genuinely hit one of decision-policy.md's Stop rules, " +
	"follow its instruction to append an entry to ข้อมูลระบบ/_pages/human-stop.yaml before " +
	"ending your turn — that is a legitimate stopping point, detected from that file, never " +
	"from what you say.";

function buildPrompt(stage: StageDef, targetDir: string, context: StageAttemptContext): string {
	const command = `/ksk-stage-${stage.id} ${targetDir}`;
	const parts = [command, HEADLESS_DIRECTIVE];
	if (context.retryCount > 0) {
		parts.push(
			`This is retry ${context.retryCount} of this stage within the same run — a previous ` +
				`attempt ended without this stage's completion check passing. Previous completion-check ` +
				`output:\n${context.previousCheckOutput ?? "(none captured)"}\n\n` +
				`Read that output carefully and make sure whatever it reports missing or incomplete ` +
				`actually gets done this time before you end your turn.`,
		);
	}
	return parts.join("\n\n");
}

function parseLine(line: string): any {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function resultEventConsumer(onResultEvent: (evt: any) => void): (chunk: Uint8Array) => void {
	const decoder = new TextDecoder();
	let buf = "";
	const maxPendingLineBytes = 256 * 1024;
	return (value: Uint8Array) => {
		buf += decoder.decode(value, { stream: true });
		// The supervisor retains only bounded output, but this incremental JSON
		// parser has its own buffer. A broken/malicious child that never emits a
		// newline must not bypass that memory bound.
		if (buf.length > maxPendingLineBytes && !buf.includes("\n")) {
			console.error("stage stream-json line exceeded parser limit; discarding it");
			buf = "";
			return;
		}
		let idx: number;
		while ((idx = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (!line.trim()) continue;
			const evt = parseLine(line);
			if (evt?.type === "result") onResultEvent(evt);
		}
	};
}

function envDuration(name: string): number | undefined {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

// Per-site deadline fallbacks used whenever KSK_STAGE_TIMEOUT_MS /
// KSK_STAGE_IDLE_TIMEOUT_MS are unset (same shared override knob as
// runScript() above — an operator can still raise every one of them at once
// in an emergency). Before this, all four leaf/stage spawns below fell
// straight through to process-supervisor.ts's bare module default (60 min
// wall / 5 min idle) — the exact gap the incident this file's header
// describes exploited. Sized for a 4-core Raspberry Pi with no swap
// headroom: a stuck leaf must die in minutes, and up to
// KSK_INTERPRET_CONCURRENCY (default 4) of these can run at once, so a
// generous default here is also a memory-pressure risk, not just a CPU one.
//
// Idle timeouts remain a secondary defense only — a chatty-but-stuck
// `--output-format stream-json` process resets its idle timer on every
// event, so the WALL clock (timeoutMs) is what actually bounds it; every
// value below is chosen to be a real bound on its own, not to rely on idle
// detection catching what wall-clock coverage already handles.
export const AUDIT_LEAF_TIMEOUT_MS = 8 * 60 * 1_000;
export const AUDIT_LEAF_IDLE_TIMEOUT_MS = 3 * 60 * 1_000;
// The main interpret leaf (watson/marple) and the audit-repair leaf invoke
// the identical per-unit worker command/args (see runLeaf in
// executeInterpretPlan) — same weight class, same fallback.
export const INTERPRET_LEAF_TIMEOUT_MS = 15 * 60 * 1_000;
export const INTERPRET_LEAF_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
// The top-level per-stage spawn (profile/segment/link/group/categorize): a
// whole `/ksk-stage-<id>` skill invocation, potentially dispatching its own
// subagent wave — heavier than a single leaf, so given the same order of
// magnitude as runScript()'s existing 30 min fallback above rather than the
// leaf-scale budget.
export const STAGE_SPAWN_TIMEOUT_MS = 30 * 60 * 1_000;
export const STAGE_SPAWN_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

type SupervisedRunner = (options: SupervisedProcessOptions) => Promise<SupervisedProcessResult>;

class CleanupFailure extends Error {}

export type SpawnStageDeps = {
	repoRoot: string;
	runSupervised: SupervisedRunner;
};

function scriptsDir(repoRoot: string) {
	return join(repoRoot, ".claude", "skills", "ksk-keying", "scripts");
}

function parseYamlFile<T>(path: string, required: boolean): T | null {
	if (!existsSync(path)) {
		if (required) throw new Error(`required Stage-2 input is missing: ${path}`);
		return null;
	}
	try {
		return yamlParse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		throw new Error(`failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function loadInterpretPlan(targetDir: string): InterpretPlan {
	const manifest = parseYamlFile<SegmentsManifest>(join(targetDir, "ข้อมูลระบบ", "_segments", "manifest.yaml"), true)!;
	const inventory = parseYamlFile<Inventory>(join(targetDir, "ข้อมูลระบบ", "_pages", "inventory.yaml"), true)!;
	const dispositions = parseYamlFile<{ entries?: Disposition[] }>(join(targetDir, "ข้อมูลระบบ", "_pages", "dispositions.yaml"), false) ?? {};
	return createInterpretPlan({ runRoot: targetDir, manifest, inventory, dispositions });
}

function processOutput(result: SupervisedProcessResult) {
	return `${result.stdout}${result.stderr}`.trim();
}

function successful(result: SupervisedProcessResult) {
	return result.reason === "exited" && result.exitCode === 0 && result.cleanupComplete;
}

function hasErrorResult(output: string) {
	for (const line of output.split(/\r?\n/)) {
		const event = parseLine(line);
		if (event?.type === "result" && event.is_error) return true;
	}
	return false;
}

async function runScript(runSupervised: SupervisedRunner, repoRoot: string, script: string, args: string[], signal?: AbortSignal) {
	return runSupervised({
		cmd: ["bun", "run", "--cwd", scriptsDir(repoRoot), script, "--", ...args],
		cwd: repoRoot,
		signal,
		timeoutMs: envDuration("KSK_STAGE_TIMEOUT_MS") ?? 30 * 60 * 1_000,
		idleTimeoutMs: envDuration("KSK_STAGE_IDLE_TIMEOUT_MS") ?? 5 * 60 * 1_000,
		maxOutputBytes: envDuration("KSK_PROCESS_MAX_OUTPUT_BYTES"),
	});
}

function preparedManifestPath(path: string) {
	return join(dirname(path), "manifest.yaml");
}

// A missing prepared input is a deterministic stage failure, never a reason
// to give a leaf a directory and hope it finds something nearby.
function assertPreparedEvidence(plan: InterpretPlan) {
	const manifests = new Map<string, { source_path?: unknown; pages?: Array<{ artifact?: unknown }> }>();
	for (const unit of plan.units) for (const ref of [...unit.pages, ...unit.sheets]) {
		if (!existsSync(ref.artifactPath)) throw new Error(`prepared evidence is missing: ${ref.artifactPath}`);
		const manifestPath = preparedManifestPath(ref.artifactPath);
		let manifest = manifests.get(manifestPath);
		if (!manifest) {
			manifest = parseYamlFile<{ source_path?: unknown; pages?: Array<{ artifact?: unknown }> }>(manifestPath, true)!;
			manifests.set(manifestPath, manifest);
		}
		if (typeof manifest.source_path !== "string" || !plan.units.some((unit) => [...unit.pages, ...unit.sheets].some((candidate) => candidate.file === manifest.source_path && preparedManifestPath(candidate.artifactPath) === manifestPath)))
			throw new Error(`prepared manifest does not identify an assigned source: ${manifestPath}`);
		if ("sheet" in ref) continue; // executor-derived sheet JSON is not a prepare.ts page artifact
		if (!Array.isArray(manifest.pages) || !manifest.pages.some((page) => page?.artifact === basename(ref.artifactPath)))
			throw new Error(`prepared manifest does not name artifact ${basename(ref.artifactPath)}: ${manifestPath}`);
	}
}

// Claude's Read tool cannot safely select one tab from XLS/XLSX. Each assigned
// sheet is converted by its own supervised, bounded subprocess so corrupt
// workbooks cannot block the app event loop or survive cancellation.
async function materializeSpreadsheetEvidence(plan: InterpretPlan, signal: AbortSignal | undefined, deps: SpawnStageDeps) {
	const seen = new Set<string>();
	for (const unit of plan.units) for (const ref of unit.sheets) {
		if (seen.has(ref.artifactPath)) continue;
		seen.add(ref.artifactPath);
		const result = await deps.runSupervised({
			cmd: ["bun", "run", PREPARE_SHEET_SCRIPT, "--", ref.sourcePath, ref.sheet, ref.artifactPath, ref.file],
			cwd: deps.repoRoot,
			signal,
			timeoutMs: envDuration("KSK_SHEET_PREPARE_TIMEOUT_MS") ?? 5 * 60 * 1_000,
			idleTimeoutMs: envDuration("KSK_SHEET_PREPARE_IDLE_TIMEOUT_MS") ?? 60 * 1_000,
			maxOutputBytes: envDuration("KSK_PROCESS_MAX_OUTPUT_BYTES"),
		});
		if (!successful(result))
			throw new Error(`spreadsheet preparation failed for ${ref.file}#s${ref.sheet}: ${processOutput(result) || result.reason}`);
	}
}

function removeUnexpectedGeneratedFiles(dir: string, expected: Set<string>, accepts: (name: string) => boolean) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !accepts(entry.name)) continue;
		const path = resolve(dir, entry.name);
		if (!expected.has(path)) rmSync(path, { force: true });
	}
}

/**
 * Unit boundaries may change between retries/runs. Downstream readers load
 * every generated interpretation and fragment file, so stale artifacts must not
 * survive a new deterministic plan and silently duplicate or override facts.
 */
function reconcileInterpretArtifacts(plan: InterpretPlan) {
	const expectedInterpretations = new Set(plan.units.map((unit) => resolve(unit.resultPath)));
	const expectedFragments = new Set(plan.units.map((unit) => resolve(unit.fragmentPath)));
	const segmentsRoot = join(plan.runRoot, "ข้อมูลระบบ", "_segments");
	if (existsSync(segmentsRoot)) {
		for (const entry of readdirSync(segmentsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			removeUnexpectedGeneratedFiles(
				join(segmentsRoot, entry.name),
				expectedInterpretations,
				(name) => name.startsWith("interpretation") && name.endsWith(".json"),
			);
		}
	}
	removeUnexpectedGeneratedFiles(
		join(plan.runRoot, "ข้อมูลระบบ", "_pages", "fragments"),
		expectedFragments,
		(name) => name.endsWith(".yaml") || name.endsWith(".yml"),
	);
	// Audits are re-run from current fragments every time; keeping an old
	// verdict would misrepresent a changed claim even when the unit id matches.
	removeUnexpectedGeneratedFiles(
		join(plan.runRoot, "ข้อมูลระบบ", "_pages", "claim-audit"),
		new Set(),
		(name) => name.endsWith(".yaml") || name.endsWith(".yml"),
	);
}

function clientProfilePath(targetDir: string) {
	const local = join(targetDir, "CLIENT.md");
	if (existsSync(local)) return local;
	const parent = join(dirname(targetDir), "CLIENT.md");
	return existsSync(parent) ? parent : null;
}

function canonicalUnitValidator(runSupervised: SupervisedRunner, repoRoot: string): UnitValidator {
	return async (unit, signal) => {
		const local = await validateUnitArtifacts(unit);
		if (!local.ok) return local;
		const result = await runScript(runSupervised, repoRoot, "validate-interpretation", [unit.resultPath], signal);
		if (successful(result)) return { ok: true };
		const output = processOutput(result);
		return { ok: false, errors: [output || `canonical validator ${result.reason} (exit ${result.exitCode ?? "none"})`] };
	};
}

type ExclusionClaim = { file: string; page: number | null; sheet: string | null; reason: string; duplicate_of?: string };
type AuditOutcome = { unit: InterpretUnit; claims: ExclusionClaim[]; refuted: boolean; feedback: string[] };

function claimKey(claim: ExclusionClaim) {
	return claim.page != null ? `${claim.file}#p${claim.page}` : `${claim.file}#s${claim.sheet}`;
}

function claimsForUnit(unit: InterpretUnit): ExclusionClaim[] {
	const fragment = parseYamlFile<{ entries?: unknown[] }>(unit.fragmentPath, true)!;
	if (!Array.isArray(fragment.entries)) throw new Error(`fragment entries missing for audit: ${unit.fragmentPath}`);
	return fragment.entries.flatMap((raw) => {
		if (!raw || typeof raw !== "object") return [];
		const entry = raw as Record<string, unknown>;
		if (entry.disposition !== "excluded") return [];
		if (typeof entry.file !== "string" || (typeof entry.page !== "number" && typeof entry.sheet !== "string") || typeof entry.reason !== "string" || !entry.reason)
			throw new Error(`malformed exclusion claim in ${unit.fragmentPath}`);
		return [{ file: entry.file, page: typeof entry.page === "number" ? entry.page : null, sheet: typeof entry.sheet === "string" ? entry.sheet : null, reason: entry.reason, duplicate_of: typeof entry.duplicate_of === "string" ? entry.duplicate_of : undefined }];
	});
}

function preparedRefMap(plan: InterpretPlan) {
	const refs = new Map<string, string>();
	for (const unit of plan.units) for (const ref of [...unit.pages, ...unit.sheets]) refs.set("page" in ref ? `${ref.file}#p${ref.page}` : `${ref.file}#s${ref.sheet}`, ref.artifactPath);
	return refs;
}

async function auditUnit(unit: InterpretUnit, plan: InterpretPlan, signal: AbortSignal | undefined, deps: SpawnStageDeps): Promise<AuditOutcome> {
	const claims = claimsForUnit(unit);
	if (!claims.length) return { unit, claims, refuted: false, feedback: [] };
	const refs = preparedRefMap(plan);
	const packet = claims.map((claim) => {
		const preparedEvidencePath = refs.get(claimKey(claim));
		if (!preparedEvidencePath) throw new Error(`audit claim has no prepared evidence: ${claimKey(claim)}`);
		const originalEvidencePath = claim.duplicate_of ? refs.get(claim.duplicate_of) : undefined;
		if (claim.duplicate_of && !originalEvidencePath) throw new Error(`audit duplicate claim has no prepared original: ${claim.duplicate_of}`);
		return { ...claim, preparedEvidencePath, originalEvidencePath };
	});
	const resultPath = join(unit.runRoot, "ข้อมูลระบบ", "_pages", "claim-audit", `${unit.id}.yaml`);
	mkdirSync(dirname(resultPath), { recursive: true });
	const auditPacket = {
		repoRoot: deps.repoRoot,
		runRoot: unit.runRoot,
		segmentId: unit.segmentId,
		owningInterpretationPath: unit.resultPath,
		claims: packet,
		resultPath,
	};
	const prompt = [
		"You are one direct, bounded Stage-2 exclusion auditor. Do not delegate or discover files.",
		"Audit exactly the claims in this literal JSON packet and only its prepared evidence paths:",
		JSON.stringify(auditPacket, null, 2),
		"Write exactly one ksk_claim_audit.v1 YAML result only to packet.resultPath.",
		"Do not run commands, validation, searches, merges, or change any interpretation/fragment/ledger.",
	].join("\n");
	const result = await deps.runSupervised({
		cmd: ["claude", "-p", prompt, "--agent", "ksk-lestrade", "--tools", "Read,Write", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"],
		cwd: deps.repoRoot, signal,
		timeoutMs: envDuration("KSK_STAGE_TIMEOUT_MS") ?? AUDIT_LEAF_TIMEOUT_MS,
		idleTimeoutMs: envDuration("KSK_STAGE_IDLE_TIMEOUT_MS") ?? AUDIT_LEAF_IDLE_TIMEOUT_MS,
		maxOutputBytes: envDuration("KSK_PROCESS_MAX_OUTPUT_BYTES"),
	});
	const auditOutput = processOutput(result);
	if (!successful(result) || hasErrorResult(auditOutput)) {
		if (isUsageLimitText(auditOutput)) throw new Error(`Claude usage limit reached during exclusion audit for ${unit.id}`);
		throw new Error(`exclusion audit leaf failed for ${unit.id}: ${auditOutput}`);
	}
	const report = parseYamlFile<{ schema?: unknown; segment_id?: unknown; claims?: unknown[] }>(resultPath, true)!;
	if (report.schema !== "ksk_claim_audit.v1" || report.segment_id !== unit.segmentId || !Array.isArray(report.claims)) throw new Error(`invalid exclusion audit report: ${resultPath}`);
	const expected = new Set(claims.map(claimKey));
	const seen = new Set<string>();
	let refuted = false;
	const feedback: string[] = [];
	for (const raw of report.claims) {
		if (!raw || typeof raw !== "object") throw new Error(`invalid audit claim in ${resultPath}`);
		const entry = raw as Record<string, unknown>;
		const claim: ExclusionClaim = { file: String(entry.file ?? ""), page: typeof entry.page === "number" ? entry.page : null, sheet: typeof entry.sheet === "string" ? entry.sheet : null, reason: String(entry.reason ?? "") };
		const key = claimKey(claim);
		if (!expected.has(key) || seen.has(key) || claim.reason !== claims.find((expectedClaim) => claimKey(expectedClaim) === key)?.reason || (entry.verdict !== "confirmed" && entry.verdict !== "refuted")) throw new Error(`audit report does not exactly cover claims: ${resultPath}`);
		seen.add(key);
		if (entry.verdict === "refuted") {
			refuted = true;
			feedback.push(`exclusion audit refuted ${key}: ${typeof entry.evidence === "string" && entry.evidence ? entry.evidence : "claim not supported by prepared evidence"}`);
		}
	}
	if (seen.size !== expected.size) throw new Error(`audit report misses a claim: ${resultPath}`);
	return { unit, claims, refuted, feedback };
}

async function runAuditBatch(
	units: InterpretUnit[],
	plan: InterpretPlan,
	externalSignal: AbortSignal | undefined,
	deps: SpawnStageDeps,
): Promise<AuditOutcome[]> {
	const controller = new AbortController();
	const relayAbort = () => controller.abort(externalSignal?.reason ?? "Stage 2 cancelled");
	if (externalSignal?.aborted) relayAbort();
	else externalSignal?.addEventListener("abort", relayAbort, { once: true });
	const results = new Array<AuditOutcome>(units.length);
	const concurrency = envDuration("KSK_INTERPRET_CONCURRENCY") ?? 4;
	let cursor = 0;
	let firstError: unknown = null;
	async function worker() {
		while (!controller.signal.aborted) {
			const index = cursor++;
			if (index >= units.length) return;
			try {
				results[index] = await auditUnit(units[index], plan, controller.signal, deps);
			} catch (error) {
				if (firstError == null) firstError = error;
				controller.abort(error);
			}
		}
	}
	try {
		await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, worker));
		if (firstError != null) throw firstError;
		if (controller.signal.aborted) throw new Error("Stage 2 exclusion audit cancelled");
		return results;
	} finally {
		externalSignal?.removeEventListener("abort", relayAbort);
	}
}

async function auditExclusions(plan: InterpretPlan, signal: AbortSignal | undefined, deps: SpawnStageDeps) {
	const first = await runAuditBatch(plan.units, plan, signal, deps);
	const refuted = first.filter((outcome) => outcome.refuted).map((outcome) => outcome.unit);
	if (!refuted.length) return true;
	const forceRetryErrors = new Map(
		first.filter((outcome) => outcome.refuted).map((outcome) => [outcome.unit.id, outcome.feedback]),
	);
	// The owner alone receives one repair attempt. forceUnitIds deliberately
	// bypasses resume so a valid-but-refuted fragment cannot evade the repair.
	const repaired = await executeInterpretPlan({
		plan: { ...plan, units: refuted }, repoRoot: deps.repoRoot, signal, clientMdPath: clientProfilePath(plan.runRoot), concurrency: 1, maxAttempts: 1,
		forceUnitIds: new Set(refuted.map((unit) => unit.id)), forceRetryErrors, validate: canonicalUnitValidator(deps.runSupervised, deps.repoRoot),
		runLeaf: async (invocation) => {
			const result = await deps.runSupervised({
				cmd: [invocation.command, ...invocation.args], cwd: invocation.cwd, signal: invocation.signal,
				timeoutMs: envDuration("KSK_STAGE_TIMEOUT_MS") ?? INTERPRET_LEAF_TIMEOUT_MS,
				idleTimeoutMs: envDuration("KSK_STAGE_IDLE_TIMEOUT_MS") ?? INTERPRET_LEAF_IDLE_TIMEOUT_MS,
				maxOutputBytes: envDuration("KSK_PROCESS_MAX_OUTPUT_BYTES"),
			});
			const output = processOutput(result);
			return { exitCode: successful(result) && !hasErrorResult(output) ? 0 : result.exitCode && result.exitCode !== 0 ? result.exitCode : 1, stdout: result.stdout, stderr: result.stderr, failureKind: isUsageLimitText(output) ? "usage_limit" : result.reason === "aborted" ? "cancelled" : "process_error" };
		},
	});
	if (repaired.status !== "passed") return false;
	const second = await runAuditBatch(refuted, plan, signal, deps);
	return !second.some((outcome) => outcome.refuted);
}

export async function runInterpretStage(targetDir: string, signal: AbortSignal | undefined, deps: SpawnStageDeps): Promise<StageOutcome> {
	const safeDeps: SpawnStageDeps = {
		...deps,
		runSupervised: async (options) => {
			const result = await deps.runSupervised(options);
			if (!result.cleanupComplete)
				throw new CleanupFailure(`supervisor could not clean process group ${result.pid ?? "unknown"}`);
			return result;
		},
	};
	try {
		// Prepare is deliberately before planning/execution: it creates every PDF
		// image and workbook copy named in the literal leaf packet at 300 DPI.
		const prepared = await runScript(safeDeps.runSupervised, safeDeps.repoRoot, "prepare-pages", ["--dpi", "300", targetDir], signal);
		if (!successful(prepared)) {
			console.error(`interpret: prepare-pages failed: ${processOutput(prepared)}`);
			return "fail";
		}
		const plan = loadInterpretPlan(targetDir);
		reconcileInterpretArtifacts(plan);
		await materializeSpreadsheetEvidence(plan, signal, safeDeps);
		for (const unit of plan.units) {
			mkdirSync(dirname(unit.resultPath), { recursive: true });
			mkdirSync(dirname(unit.fragmentPath), { recursive: true });
		}
		assertPreparedEvidence(plan);
		const executed = await executeInterpretPlan({
			plan,
			repoRoot: safeDeps.repoRoot,
			signal,
			clientMdPath: clientProfilePath(targetDir),
			concurrency: envDuration("KSK_INTERPRET_CONCURRENCY") ?? 4,
			maxAttempts: 2,
			validate: canonicalUnitValidator(safeDeps.runSupervised, safeDeps.repoRoot),
			runLeaf: async (invocation: LeafInvocation) => {
				const result = await safeDeps.runSupervised({
					cmd: [invocation.command, ...invocation.args], cwd: invocation.cwd, signal: invocation.signal,
					timeoutMs: envDuration("KSK_STAGE_TIMEOUT_MS") ?? INTERPRET_LEAF_TIMEOUT_MS,
					idleTimeoutMs: envDuration("KSK_STAGE_IDLE_TIMEOUT_MS") ?? INTERPRET_LEAF_IDLE_TIMEOUT_MS,
					maxOutputBytes: envDuration("KSK_PROCESS_MAX_OUTPUT_BYTES"),
				});
				const output = processOutput(result);
			return { exitCode: successful(result) && !hasErrorResult(output) ? 0 : result.exitCode && result.exitCode !== 0 ? result.exitCode : 1, stdout: result.stdout, stderr: result.stderr, failureKind: isUsageLimitText(output) ? "usage_limit" : result.reason === "aborted" ? "cancelled" : "process_error" };
			},
		});
		if (executed.status !== "passed") {
			console.error(`interpret: executor ${executed.status}: ${executed.units.filter((unit) => unit.status !== "passed" && unit.status !== "skipped-valid").map((unit) => `${unit.unitId}: ${unit.errors.join("; ")}`).join(" | ")}`);
			return "fail";
		}
		if (!(await auditExclusions(plan, signal, safeDeps))) {
			console.error("interpret: an exclusion claim remained refuted after its one owner retry");
			return "fail";
		}
		const merged = await runScript(safeDeps.runSupervised, safeDeps.repoRoot, "merge-dispositions", [targetDir], signal);
		if (!successful(merged)) {
			console.error(`interpret: merge-dispositions failed: ${processOutput(merged)}`);
			return "fail";
		}
		return "success";
	} catch (error) {
		console.error(`interpret: deterministic executor failed: ${error instanceof Error ? error.message : String(error)}`);
		return error instanceof CleanupFailure ? "cleanup-failed" : "fail";
	}
}

export function createSpawnStage(deps: SpawnStageDeps = { repoRoot: REPO_ROOT, runSupervised: runSupervisedProcess }): StageRunner {
	return async (stage, targetDir, context, signal) => {
	if (stage.id === "interpret") return runInterpretStage(targetDir, signal, deps);
	const prompt = buildPrompt(stage, targetDir, context);
	let sawSuccessResult = false;
	let sawErrorResult = false;
	const onResultEvent = (evt: any) => {
		if (evt.is_error) sawErrorResult = true;
		else sawSuccessResult = true;
	};
	const result = await deps.runSupervised({
		cmd: [
			"claude",
			"-p",
			prompt,
			"--model",
			STAGE_MODEL,
			"--output-format",
			"stream-json",
			"--verbose",
			// Real finding from diagnosing the first two live runs: under
			// --permission-mode acceptEdits, a plain `Bash(echo ...)` call is
			// auto-approved, but `bun run .../inventory.ts` was NOT — denied 3
			// times with "This command requires approval" (no TTY to approve it
			// in headless mode), and the model correctly gave up and reported
			// that rather than looping or fabricating success. There is no
			// human watching a bounded single-stage spawn to approve anything
			// anyway — the external completion check afterward is this
			// architecture's actual trust boundary, not the agent's own tool
			// permissions. console/.env.example already documents
			// KSK_PERMISSION_MODE=bypassPermissions as the real-unattended-run
			// setting for the exact same reason; this uses the same setting.
			"--permission-mode",
			"bypassPermissions",
		],
		cwd: deps.repoRoot,
		signal,
		// Real, sane fallbacks (not the supervisor's bare module default) — see
		// STAGE_SPAWN_TIMEOUT_MS above. Env overrides are intentionally explicit
		// for long, real client runs, never an unbounded escape hatch.
		timeoutMs: envDuration("KSK_STAGE_TIMEOUT_MS") ?? STAGE_SPAWN_TIMEOUT_MS,
		idleTimeoutMs: envDuration("KSK_STAGE_IDLE_TIMEOUT_MS") ?? STAGE_SPAWN_IDLE_TIMEOUT_MS,
		maxOutputBytes: envDuration("KSK_PROCESS_MAX_OUTPUT_BYTES"),
		onStdoutChunk: resultEventConsumer(onResultEvent),
		onStderrChunk: resultEventConsumer(onResultEvent),
	});

	// A clean process exit with no result event at all (e.g. killed mid-turn)
	// is not evidence of success — only an explicit non-error result event,
	// on top of a clean exit, counts.
	if (result.reason !== "exited") {
		console.error(`stage ${stage.id}: supervised process ${result.reason}${result.cleanupComplete ? "" : " (cleanup incomplete)"}`);
		return result.cleanupComplete ? "fail" : "cleanup-failed";
	}
	return result.exitCode === 0 && sawSuccessResult && !sawErrorResult ? "success" : "fail";
	};
}

export const spawnStage: StageRunner = createSpawnStage();
