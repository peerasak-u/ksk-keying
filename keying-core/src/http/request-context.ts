// Plan §7.4: "The CLI and HTTP adapter perform only parsing, authentication,
// validation-to-DTO mapping, status-code/exit-code mapping, and presentation."
// This file is the parsing/authentication half.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CoreError } from "../errors/core-error";

const REQUEST_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

export function mintRequestId(): string {
	let body = "";
	for (const byte of randomBytes(16)) body += REQUEST_ID_ALPHABET[byte % REQUEST_ID_ALPHABET.length];
	return `req_${body}`;
}

/** §1.1 [C-01]: the service token is presented as `Authorization: Bearer
 * <token>`. "A request with a missing or wrong token gets `401 unauthorized`
 * with NO body detail about which. Core has exactly one caller identity; there
 * is nothing to disambiguate." */
export function assertAuthorized(request: Request, serviceToken: string): void {
	const header = request.headers.get("authorization") ?? "";
	const prefix = "Bearer ";
	if (!header.startsWith(prefix)) throw new CoreError("unauthorized");
	const presented = Buffer.from(header.slice(prefix.length), "utf8");
	const expected = Buffer.from(serviceToken, "utf8");
	// Length is compared first because timingSafeEqual throws on a mismatch; the
	// length of a bearer token is not the secret.
	if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
		throw new CoreError("unauthorized");
	}
}

/** §1.5: `Idempotency-Key: <16..128 chars of [A-Za-z0-9_.:-]>`. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{16,128}$/;

export type IdempotencyRule = "required" | "optional";

/** Validates the header's presence and charset. Recording the receipt is a
 * later slice (plan §8.2's `workflow_requests`); rejecting a malformed key is
 * not, because §2.3 assigns both codes and a caller must learn its key is bad
 * before it starts relying on replay. */
export function readIdempotencyKey(request: Request, rule: IdempotencyRule): string | null {
	const value = request.headers.get("idempotency-key");
	if (value === null || value === "") {
		if (rule === "required") throw new CoreError("idempotency_key_required");
		return null;
	}
	if (!IDEMPOTENCY_KEY_RE.test(value)) throw new CoreError("idempotency_key_invalid");
	return value;
}

/** §1.2: request and response bodies are `application/json; charset=utf-8`, and
 * all text is UTF-8 and may be Thai. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	const raw = await request.text();
	if (raw.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CoreError("validation_failed", { details: { fields: [{ path: "body", problem: "not_json" }] } });
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new CoreError("validation_failed", { details: { fields: [{ path: "body", problem: "type", expected: "object" }] } });
	}
	return parsed as Record<string, unknown>;
}

export function jsonResponse(body: unknown, status: number, requestId: string, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// Not a specified field, but plan §18 requires the request id in the
			// log and §2.1 exists so an operator can join the two; a successful
			// response carries no body field to join on, so it carries a header.
			"x-request-id": requestId,
			...extraHeaders,
		},
	});
}
