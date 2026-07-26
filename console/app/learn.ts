// "เรียนรู้" — the console half of the learning loop (wayfinder ticket #43,
// mechanism from #37). Three steps, in order:
//
//   1. propose — the deterministic script (.claude/skills/ksk-keying/scripts/
//      learn.ts) walks every month's changes.json for one CLIENT and counts
//      the account_code corrections into proposed coa_usage.json updates.
//   2. review — one bounded `claude -p` pass judges those proposals: is this
//      a real pattern or a one-off exception, and is there a signal here
//      bigger than a coa_usage bump (which becomes a learning-notes.md note)?
//      It is advisory and read-only: if it fails, times out, or answers with
//      prose instead of JSON, every proposal simply comes back "unreviewed"
//      and the human decides unaided. The pass never gates the loop.
//   3. apply — the human ticks what they want and the same script writes
//      coa_usage.json (+ learning-notes.md). Nothing is written before that
//      click; the agent's verdict only pre-checks/unchecks boxes.
//
// The pure seams (prompt building, verdict parsing, decorating, request-body
// shaping) are exported and unit-tested; the two spawns are the thin I/O.
import { dirname, resolve } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const SCRIPTS_DIR = resolve(HERE, "../../.claude/skills/ksk-keying/scripts");

// Per CLAUDE.md's model tiers: one bounded judgment step over data already
// laid out for it — a worker, not the reserved opus tier.
const REVIEW_MODEL = "sonnet";
// A judgment pass over a few dozen proposals; a human is watching a spinner.
const REVIEW_TIMEOUT_MS = 3 * 60 * 1000;

export type LearnProposal = {
	id: string;
	family: "expense_hints" | "income_hints" | "bank_hints";
	account_code: string;
	sub_code: string;
	label: string;
	in_coa: boolean;
	is_new_hint: boolean;
	correction_count: number;
	keywords: string[];
	tax_id_counts: { tax_id: string; count: number }[];
	from_accounts: { account_key: string; count: number }[];
	existing_tax_id_counts: { tax_id: string; count: number }[];
	examples: { month_id: string; group_id: string; line_id: string; description: string | null; from_key: string }[];
};

/** One learning-notes.md bullet, mirrored from the skill's learn.ts — see
 * that file's `parseLearningNotes`/`applyNoteHandling` for the format this
 * round-trips through. */
export type StoredNote = { id: string; date: string; title: string; detail: string; handled: boolean };

export type LearnReport = {
	schema: "ksk_learn_report.v1";
	client_dir: string;
	scanned_files: number;
	skipped_already_learned: number;
	correction_count: number;
	/** changes.json keys (client-root-relative) carrying not-yet-learned
	 * corrections — passed back verbatim on apply so the script re-reads
	 * exactly the files this report was built from. */
	sources: string[];
	proposals: LearnProposal[];
	/** learning-notes.md's bullets as-is (handled and unhandled both) — see
	 * the skill script's LearnReport for the same field. */
	learning_notes: StoredNote[];
};

export type LearningNote = { title: string; detail: string };
export type AgentVerdict = { proposal_id: string; verdict: "accept" | "reject"; reason: string };
export type AgentReview = { verdicts: AgentVerdict[]; notes: LearningNote[] };
export type DecoratedProposal = LearnProposal & { checked: boolean; verdict: "accept" | "reject" | "unreviewed"; reason: string };
export type LearnDecision = { accept: string[]; sources: string[]; notes: LearningNote[]; handled?: string[] };

// ---------------------------------------------------------------------------
// Pure core

export type ReportSummary = { hasWork: boolean; message: string };

/** The four honest "nothing happened" answers, kept distinct — a reviewer who
 * pressed the button deserves to know WHICH nothing this is. Notably: a client
 * that has never been exported has no changes.json anywhere, which is not a
 * failure, it's a missing prerequisite (#42 writes changes.json at export
 * time). */
export function summarizeReport(report: LearnReport): ReportSummary {
	if (report.proposals.length > 0) {
		return {
			hasWork: true,
			message: `พบข้อเสนอ ${report.proposals.length} รายการ จากการแก้ผังบัญชี ${report.correction_count} ครั้ง`,
		};
	}
	if (report.scanned_files === 0) {
		return { hasWork: false, message: "ยังไม่มีข้อมูลให้เรียนรู้ — ต้องกดส่งออก (export) อย่างน้อยหนึ่งเดือนก่อน จึงจะมีบันทึกการแก้ไขให้อ่าน" };
	}
	if (report.skipped_already_learned > 0) {
		return { hasWork: false, message: `เรียนรู้ครบแล้ว ไม่มีการแก้ไขใหม่ตั้งแต่รอบที่แล้ว (ตรวจ ${report.scanned_files} ไฟล์)` };
	}
	return { hasWork: false, message: `ไม่พบการแก้ผังบัญชีในรอบนี้ (ตรวจ ${report.scanned_files} ไฟล์) — การแก้ค่าอื่นๆ ไม่ได้ใช้สอน coa_usage.json` };
}

/** `summarizeReport`'s message is written for "no proposals" alone — it must
 * not tell the human to go away when there ARE unhandled notes waiting, or
 * #47's whole point (a place to ever clear them) is undone. Appends a note
 * count onto the existing message rather than replacing it, so the four
 * distinct "nothing happened" reasons stay distinct; only the trailing note
 * clause changes. */
export function summarizeWithNotes(summary: ReportSummary, storedNotes: StoredNote[]): ReportSummary {
	const unhandled = storedNotes.filter((n) => !n.handled).length;
	if (unhandled === 0) return summary;
	return { ...summary, message: `${summary.message} · มีข้อสังเกตที่ยังไม่จัดการ ${unhandled} ข้อ` };
}

function proposalBrief(p: LearnProposal): string {
	const from = p.from_accounts.map((f) => `${f.account_key}×${f.count}`).join(", ") || "(ไม่มี)";
	const taxIds = p.tax_id_counts.map((t) => `${t.tax_id}×${t.count}`).join(", ") || "(ไม่มี)";
	const history = p.existing_tax_id_counts.map((t) => `${t.tax_id}×${t.count}`).join(", ") || "(ยังไม่มี hint นี้)";
	const examples = p.examples.map((e) => `${e.month_id}/${e.group_id} ${e.line_id}: ${e.description ?? "(ไม่มีคำอธิบาย)"}`).join(" | ");
	return [
		`- id: ${p.id}`,
		`  family: ${p.family}  account: ${p.account_code}${p.sub_code ? `-${p.sub_code}` : ""} ${p.label}${p.in_coa ? "" : "  ⚠ ไม่มีรหัสนี้ใน coa.csv"}`,
		`  corrections: ${p.correction_count}  (แก้มาจาก: ${from})`,
		`  tax_ids ในรอบนี้: ${taxIds}`,
		`  ประวัติเดิมของ hint นี้: ${history}`,
		`  ตัวอย่าง: ${examples || "(ไม่มี)"}`,
	].join("\n");
}

/** The judge's whole brief. Read-only by construction: it is handed the
 * evidence inline and pointed at the client's own context files, and told in
 * both languages not to write anything. */
export function buildReviewPrompt(report: LearnReport, clientDir: string): string {
	return `คุณกำลังตรวจข้อเสนอปรับ coa_usage.json ของลูกค้ารายหนึ่ง ก่อนที่คนจะกดยืนยัน

ที่มา: สคริปต์เดินอ่านไฟล์ changes.json ทุกกลุ่ม ทุกเดือนของลูกค้ารายนี้ แล้วนับเฉพาะครั้งที่ "คนแก้รหัสบัญชีที่ AI เลือกไว้" (field: account_code) ออกมาเป็นข้อเสนอด้านล่าง แต่ละข้อเสนอ = ขอเพิ่ม/เพิ่มน้ำหนักให้ hint หนึ่งตัวใน coa_usage.json

หน้าที่ของคุณ — ตัดสินทีละข้อเสนอ:
1. accept ถ้ามันดูเป็น "รูปแบบจริง" (pattern) ที่ควรสอนระบบ — เช่น แก้ซ้ำหลายครั้ง/หลายเดือน, ตรงกับ tax_id เดิม, หรือสอดคล้องกับ CLIENT.md
2. reject ถ้ามันดูเป็น "ข้ออกเว้นครั้งเดียว" (one-off exception) — เอกสารใบเดียว, ขัดกับประวัติเดิมที่ใช้มาสม่ำเสมอหลายสิบครั้ง, หรือรหัสบัญชีไม่มีอยู่จริงใน coa.csv
3. ถ้าเห็นรูปแบบที่ "ใหญ่กว่าการปรับ coa_usage.json" — เช่น ควรไปแก้ coa_conventions ใน CLIENT.md, ผังบัญชีขาดบัญชีที่ควรมี, หรือ AI เข้าใจธุรกิจของลูกค้าผิดอย่างเป็นระบบ — ให้เขียนเป็น notes (คนจะไปอ่านและตัดสินใจเอง ระบบจะไม่แก้ CLIENT.md ให้อัตโนมัติ)

ไฟล์บริบทที่เปิดอ่านได้ (อ่านอย่างเดียว):
- ${clientDir}/CLIENT.md
- ${clientDir}/coa.csv
- ${clientDir}/coa_usage.json

ห้ามแก้ไข/เขียน/ลบไฟล์ใดๆ ทั้งสิ้น (do not write or edit any file) — งานนี้คือการให้ความเห็นเท่านั้น คนเป็นคนกดยืนยันเอง

ข้อเสนอ (${report.proposals.length} รายการ จากการแก้ ${report.correction_count} ครั้ง):
${report.proposals.map(proposalBrief).join("\n")}

ตอบกลับเป็น JSON ก้อนเดียวเท่านั้น (ห้ามมีอย่างอื่นนอกจากบล็อก JSON):
{
  "verdicts": [ { "proposal_id": "<id ตามด้านบน>", "verdict": "accept" | "reject", "reason": "<เหตุผลสั้นๆ ภาษาไทย>" } ],
  "notes": [ { "title": "<หัวข้อสั้น>", "detail": "<สิ่งที่คนควรไปทำต่อ>" } ]
}
ต้องมี verdict ครบทุก proposal_id และถ้าไม่มีข้อสังเกตใหญ่ ให้ notes เป็น []`;
}

function extractJsonObject(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidates = [fenced?.[1], text].filter((c): c is string => typeof c === "string");
	for (const candidate of candidates) {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start === -1 || end <= start) continue;
		try {
			return JSON.parse(candidate.slice(start, end + 1));
		} catch {
			// fall through to the next candidate
		}
	}
	return null;
}

/** Tolerant parse of the judge's answer. null means "no usable verdict" —
 * which the caller treats as "unreviewed", never as "reject everything". */
export function parseAgentReview(text: string): AgentReview | null {
	const parsed = extractJsonObject(text) as { verdicts?: unknown; notes?: unknown } | null;
	if (!parsed || typeof parsed !== "object") return null;
	if (!Array.isArray(parsed.verdicts) && !Array.isArray(parsed.notes)) return null;

	const verdicts: AgentVerdict[] = (Array.isArray(parsed.verdicts) ? parsed.verdicts : [])
		.map((raw) => raw as { proposal_id?: unknown; verdict?: unknown; reason?: unknown })
		.filter((v) => typeof v?.proposal_id === "string" && v.proposal_id && (v.verdict === "accept" || v.verdict === "reject"))
		.map((v) => ({ proposal_id: v.proposal_id as string, verdict: v.verdict as "accept" | "reject", reason: typeof v.reason === "string" ? v.reason : "" }));

	const notes: LearningNote[] = (Array.isArray(parsed.notes) ? parsed.notes : [])
		.map((raw) => raw as { title?: unknown; detail?: unknown })
		.filter((n) => typeof n?.title === "string" && typeof n?.detail === "string")
		.map((n) => ({ title: n.title as string, detail: n.detail as string }));

	return { verdicts, notes };
}

/** Pairs each proposal with its verdict and decides the checkbox's default
 * state. Two deliberate asymmetries: an unreviewed proposal defaults to
 * UNCHECKED (silence is not consent — the human can still tick it), and a
 * code that isn't in coa.csv is never pre-checked even on an accept, since
 * poirot can only ever map to codes that exist there. */
export function decorateProposals(proposals: LearnProposal[], review: AgentReview | null): DecoratedProposal[] {
	const byId = new Map((review?.verdicts ?? []).map((v) => [v.proposal_id, v]));
	return proposals.map((p) => {
		const v = byId.get(p.id);
		const verdict = v?.verdict ?? "unreviewed";
		return { ...p, verdict, reason: v?.reason ?? "", checked: verdict === "accept" && p.in_coa };
	});
}

/** Shapes an arbitrary request body into a decision — same defensive posture
 * as server.ts's parsePageEditBody. The accept list is just ids; the script
 * re-derives the proposals themselves from `sources`, so nothing a caller
 * sends can invent a hint out of thin air. */
export function parseDecisionBody(body: unknown): LearnDecision {
	const b = (body ?? {}) as Record<string, unknown>;
	const accept = Array.isArray(b.accept) ? b.accept.filter((x): x is string => typeof x === "string") : [];
	const sources = Array.isArray(b.sources) ? b.sources.filter((x): x is string => typeof x === "string") : [];
	const notes = Array.isArray(b.notes)
		? b.notes
				.map((raw) => raw as { title?: unknown; detail?: unknown })
				.filter((n) => typeof n?.title === "string" && typeof n?.detail === "string")
				.map((n) => ({ title: n.title as string, detail: n.detail as string }))
		: [];
	// Left UNDEFINED when the caller sent no `handled` field at all, and kept
	// as an empty array when they sent an empty one — the two mean different
	// things downstream: absent leaves note handling alone, `[]` un-handles
	// every note (the human unticked the last box to reopen it).
	const handled = Array.isArray(b.handled) ? b.handled.filter((x): x is string => typeof x === "string") : undefined;
	return { accept, sources, notes, handled };
}

/** Whether the confirm dialog has anything at all to act on this round —
 * fresh proposals to accept/reject, or pending notes to clear, or both. A
 * client with pending notes and no fresh corrections must still get a
 * confirm button, or those notes could never be marked handled (#47). */
export function hasAnythingToConfirm(hasWork: boolean, storedNotes: StoredNote[]): boolean {
	return hasWork || storedNotes.some((n) => !n.handled);
}

// ---------------------------------------------------------------------------
// Thin I/O

async function runScript(args: string[], stdinText?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", "--cwd", SCRIPTS_DIR, ...args], {
		stdin: stdinText === undefined ? "ignore" : new TextEncoder().encode(stdinText),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { exitCode, stdout, stderr };
}

export type ProposeResult = { ok: true; report: LearnReport } | { ok: false; error: string };

export async function runLearnPropose(clientDir: string): Promise<ProposeResult> {
	const result = await runScript(["learn", "--", "--propose", clientDir]);
	if (result.exitCode !== 0) return { ok: false, error: result.stderr.trim() || "อ่านบันทึกการแก้ไขไม่สำเร็จ" };
	try {
		return { ok: true, report: JSON.parse(result.stdout) as LearnReport };
	} catch {
		return { ok: false, error: "อ่านผลลัพธ์จากสคริปต์เรียนรู้ไม่ได้" };
	}
}

/** The advisory pass. Returns null on ANY failure (spawn error, non-zero
 * exit, timeout, unparseable answer) — the caller shows the proposals
 * unreviewed rather than blocking the human on a flaky judgment step. */
export async function runAgentReview(clientDir: string, report: LearnReport): Promise<AgentReview | null> {
	if (report.proposals.length === 0) return null;
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(
			[
				"claude",
				"-p",
				buildReviewPrompt(report, clientDir),
				"--model",
				REVIEW_MODEL,
				"--output-format",
				"text",
				// Read-only by grant, not just by instruction — this pass exists to
				// give an opinion, and the human's click is what writes anything.
				// Both flags are needed: under bypassPermissions (the same
				// unattended-run setting sequencer/spawn-stage.ts uses, since there
				// is no TTY to approve anything) --allowedTools is a no-prompt
				// allowlist, NOT a deny-list — only --disallowedTools actually
				// refuses the write tools.
				"--allowedTools",
				"Read,Glob,Grep",
				"--disallowedTools",
				"Write,Edit,NotebookEdit,Bash",
				"--permission-mode",
				"bypassPermissions",
			],
			{ cwd: SCRIPTS_DIR, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
	} catch {
		return null;
	}
	const timer = setTimeout(() => proc.kill(), REVIEW_TIMEOUT_MS);
	try {
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) return null;
		return parseAgentReview(stdout);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

export type ApplyResult = { ok: true; message: string } | { ok: false; error: string };

export async function runLearnApply(clientDir: string, decision: LearnDecision): Promise<ApplyResult> {
	const result = await runScript(["learn", "--", "--apply", clientDir], JSON.stringify(decision));
	if (result.exitCode !== 0) return { ok: false, error: result.stderr.trim() || "บันทึกการเรียนรู้ไม่สำเร็จ" };
	const accepted = decision.accept.length;
	const noteCount = decision.notes.length;
	const parts = [accepted > 0 ? `เรียนรู้แล้ว ${accepted} รายการ` : "ไม่ได้รับข้อเสนอใดไว้"];
	if (noteCount > 0) parts.push(`บันทึกข้อสังเกต ${noteCount} ข้อไว้ใน learning-notes.md`);
	// Marking notes handled is a real outcome, and often the ONLY thing a
	// notes-only confirm did — without this the human gets back "ไม่ได้รับ
	// ข้อเสนอใดไว้" and no sign that their ticks landed.
	if (decision.handled) parts.push(`ข้อสังเกตที่จัดการแล้ว ${decision.handled.length} ข้อ`);
	return { ok: true, message: parts.join(" · ") };
}
