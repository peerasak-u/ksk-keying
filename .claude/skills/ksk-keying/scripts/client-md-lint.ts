// The single definition of "CLIENT.md is well-formed", shared by the two
// places that need it:
//
//   1. stage-shape-check.ts's profile gate — the trust boundary. Runs after a
//      stage's process is gone; can only report, never repair.
//   2. A PostToolUse hook wired into the `claude -p` stage spawn
//      (spawn-stage.ts). Runs while the agent that wrote the file is still
//      alive, so the agent fixes its own mistake in the next turn instead of
//      the run dying at the gate three minutes later.
//
// Why this file exists at all: on 2026-07-27 a real run of client 345 died at
// the Stage 0 gate because an agent editing an existing 452-line CLIENT.md
// dropped the frontmatter's closing `---`. Nothing between "agent writes a
// malformed file" and "whole stage BLOCKED" noticed. The gate was right to
// stop — a profile that will not parse must not flow into COA mapping — but a
// missing delimiter should never have cost a stage.
//
// Deliberately NOT a repair tool. Inferring where an unterminated frontmatter
// was *meant* to end is a guess, and a wrong guess silently produces a profile
// with missing or swallowed fields that then feeds every interpretation leaf.
// The hook hands the defect back to the agent, which knows what it intended;
// we never guess on its behalf.
//
// Structural checks only — a missing `tax_id` or a wrong VAT flag is the
// gate's business and a human's, not a linter's. Auto-healing semantics would
// hide real pipeline bugs, which is the one thing this repo will not trade.
//
// CLI (hook mode): reads the PostToolUse hook JSON on stdin, lints the file it
// names, and exits 2 with the offenses on stderr so Claude Code feeds them
// back to the agent as an error. Exit 0 otherwise — including for any path
// that is not a CLIENT.md, so an over-broad hook matcher is harmless.
//
// Exit codes: 0 clean (or not our file), 2 offenses found / unreadable input.

import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { parse as yamlParse } from "yaml";

export const CLIENT_PROFILE_SCHEMA = "ksk_client_profile.v1";

// Closing delimiter must be a line of its own — `^---$` rather than a bare
// prefix, so a body line that merely starts with "---" cannot be mistaken for
// the end of the frontmatter block.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Structural offenses in a CLIENT.md's text. Empty array = well-formed.
 * Messages are written to be actionable by the agent that just wrote the file
 * (what is wrong, and where to put the fix), not just diagnostic for a human.
 * They name the defect but never the file — each caller prefixes the path it
 * already knows, so the same sentence serves the gate and the hook.
 *
 * `requireSchema` is the one place the two callers deliberately diverge. A
 * hook exit 2 only nudges the agent and can never halt a run, so the hook can
 * afford to insist on the declared schema. The gate CAN halt a run, and
 * tightening it would invent a brand-new way for a previously-fine client
 * folder to block — the exact failure class this file exists to remove. The
 * gate therefore checks structure only, exactly as strictly as it always has.
 */
export function lintClientMd(text: string, { requireSchema = false }: { requireSchema?: boolean } = {}): string[] {
	const offenses: string[] = [];

	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
		offenses.push(
			"must open with a YAML frontmatter block: line 1 has to be exactly `---`. " +
				"Rewrite the file so the machine-readable profile block comes first (see ksk-magnum's Output section).",
		);
		return offenses;
	}

	const match = text.match(FRONTMATTER);
	if (!match) {
		// The overwhelmingly common failure: the block was opened and never
		// closed. Point at where the prose begins so the fix is unambiguous.
		const lines = text.split(/\r?\n/);
		const headingIndex = lines.findIndex((line, index) => index > 0 && /^#{1,6}\s/.test(line));
		const hint =
			headingIndex > 0
				? ` The markdown body appears to start at line ${headingIndex + 1} (\`${lines[headingIndex].slice(0, 60)}\`), so the closing \`---\` belongs on its own line just above it.`
				: "";
		offenses.push(
			`opens a YAML frontmatter block at line 1 but never closes it — there is no line containing exactly \`---\` after it.${hint} ` +
				"Add the closing delimiter; do not otherwise change the content you just wrote.",
		);
		return offenses;
	}

	let parsed: unknown;
	try {
		parsed = yamlParse(match[1]);
	} catch (error) {
		offenses.push(
			`frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}. ` +
				"Fix the YAML between the two `---` delimiters — check quoting on any value containing `:` or `#`.",
		);
		return offenses;
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		offenses.push("frontmatter parsed but is not a YAML mapping — it must be a block of `key: value` fields.");
		return offenses;
	}

	const schema = (parsed as { schema?: unknown }).schema;
	if (requireSchema && schema !== CLIENT_PROFILE_SCHEMA)
		offenses.push(
			`frontmatter must declare \`schema: ${CLIENT_PROFILE_SCHEMA}\`` +
				`${schema === undefined ? " — the field is missing" : `, found \`${String(schema)}\``}.`,
		);

	return offenses;
}

/** True for the profile file this linter governs, whatever directory it sits in. */
export function isClientProfilePath(filePath: string): boolean {
	return basename(filePath) === "CLIENT.md";
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function main() {
	const raw = await readStdin();
	let filePath: string;
	try {
		filePath = JSON.parse(raw)?.tool_input?.file_path ?? "";
	} catch {
		// A hook that cannot read its own event must not fail a stage over it.
		process.exit(0);
	}
	if (!filePath || !isClientProfilePath(filePath)) process.exit(0);

	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		// Deleted or moved between the write and the hook — nothing to judge.
		process.exit(0);
	}

	const offenses = lintClientMd(text, { requireSchema: true });
	if (offenses.length === 0) process.exit(0);

	console.error(`${filePath} is malformed and will fail the Stage 0 completion check. Fix it now:`);
	for (const offense of offenses) console.error(`  - ${offense}`);
	process.exit(2);
}

if (import.meta.main) void main();
