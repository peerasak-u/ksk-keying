// The keying job — plan §7.2's module, narrowed to what this slice needs.
//
// "It does not own stage transitions, retry eligibility, queue order,
// completion, accounting artifacts, or anything at all about Phases, Gates,
// people, or signatures."
import { randomBytes } from "node:crypto";
import type { ExternalRef } from "../workflow/run-contract";

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_BODY_LENGTH = 22;

/** §1.4: `job_` + 22 chars `[0-9A-Za-z]`. Opaque, stable, never reused. */
export const JOB_ID_PATTERN = `^job_[0-9A-Za-z]{${ID_BODY_LENGTH}}$`;
const JOB_ID_RE = new RegExp(JOB_ID_PATTERN);

export function isJobId(value: string): boolean {
	return JOB_ID_RE.test(value);
}

export function mintJobId(): string {
	// Rejection-free unbiased draw: 62 does not divide 256, so bytes at or above
	// the largest multiple of 62 are redrawn rather than folded, which would make
	// the first few characters of the alphabet fractionally likelier.
	const limit = Math.floor(256 / ID_ALPHABET.length) * ID_ALPHABET.length;
	let body = "";
	while (body.length < ID_BODY_LENGTH) {
		for (const byte of randomBytes(ID_BODY_LENGTH)) {
			if (byte >= limit) continue;
			body += ID_ALPHABET[byte % ID_ALPHABET.length];
			if (body.length === ID_BODY_LENGTH) break;
		}
	}
	return `job_${body}`;
}

export type Job = {
	jobId: string;
	/** Unique. Plan §8.2's `unique workspace_rel_path` constraint is what makes
	 * §5.4 and §5.13 idempotent without a receipt (§1.5 [C-05]). */
	workspaceRelPath: string;
	clientKey: string;
	monthId: string;
	title: string | null;
	archived: boolean;
	externalRef: ExternalRef | null;
	/** Audit only (§1.1). Core never resolves it, never validates it against
	 * anything, and never authorizes on it. */
	requestedBy: string | null;
	createdAt: string;
	updatedAt: string;
};

export function defaultTitle(clientKey: string, monthId: string): string {
	// §5.3's example: "216 — 69-08".
	return `${clientKey} — ${monthId}`;
}
