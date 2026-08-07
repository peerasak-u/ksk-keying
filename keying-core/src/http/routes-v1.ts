// The `/v1` HTTP adapter. Five routes in this slice — §5.1, §5.2, §5.3, §5.4,
// §5.5 and §5.13 (six paths across five sections' worth of surface, counting
// both jobs POSTs).
//
// The remaining routes of §5 — the four run commands, the two SSE streams, the
// review/exclusion routes, the document and export routes — are later slices
// and are deliberately absent rather than stubbed: a route that answers is a
// contract, and answering wrongly is worse than not answering.
//
// Every failure leaves here as a CoreError, so §2's body is the only failure
// shape this service produces.
import type { KeyingCore, ListJobsQuery } from "../application/keying-core";
import { CoreError, toCoreError } from "../errors/core-error";
import type { Logger } from "../observability/logger";
import { RUN_STATUSES } from "../workflow/state-machine";
import {
	assertAuthorized,
	jsonResponse,
	mintRequestId,
	readIdempotencyKey,
	readJsonBody,
} from "./request-context";

export type RouterDeps = {
	core: KeyingCore;
	serviceToken: string;
	logger: Logger;
	requestId?: () => string;
};

const STATUS_FILTER_VALUES: readonly string[] = [...RUN_STATUSES, "queued", "active"];

function boolParam(raw: string | null, path: string): boolean | undefined {
	if (raw === null) return undefined;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new CoreError("validation_failed", {
		details: { fields: [{ path, problem: "enum", expected: "true|false" }] },
	});
}

function parseListJobsQuery(url: URL): ListJobsQuery {
	const archivedRaw = url.searchParams.get("archived");
	if (archivedRaw !== null && !["true", "false", "any"].includes(archivedRaw)) {
		throw new CoreError("validation_failed", {
			details: { fields: [{ path: "archived", problem: "enum", expected: "true|false|any" }] },
		});
	}

	const status = url.searchParams.getAll("status");
	for (const value of status) {
		if (!STATUS_FILTER_VALUES.includes(value)) {
			throw new CoreError("validation_failed", {
				details: { fields: [{ path: "status", problem: "enum", expected: STATUS_FILTER_VALUES.join("|") }] },
			});
		}
	}

	const limitRaw = url.searchParams.get("limit");
	let limit: number | undefined;
	if (limitRaw !== null) {
		limit = Number(limitRaw);
		if (!Number.isInteger(limit)) {
			throw new CoreError("validation_failed", {
				details: { fields: [{ path: "limit", problem: "type", expected: "integer 1..500" }] },
			});
		}
	}

	const clientKey = url.searchParams.getAll("clientKey");
	const cursor = url.searchParams.get("cursor");
	const hasRunRecord = boolParam(url.searchParams.get("hasRunRecord"), "hasRunRecord");

	return {
		...(clientKey.length ? { clientKey } : {}),
		...(status.length ? { status } : {}),
		...(archivedRaw === null ? {} : { archived: archivedRaw as "true" | "false" | "any" }),
		...(hasRunRecord === undefined ? {} : { hasRunRecord }),
		...(limit === undefined ? {} : { limit }),
		...(cursor === null ? {} : { cursor }),
	};
}

/** An address `/v1` does not define. §2.3's list is closed and carries no
 * "unknown route" code, so this maps onto `validation_failed` — §2.2's first
 * row, "the request is not a valid request" — with the offending path named as
 * the failing field. See README → "Findings against the spec". */
function unknownRoute(method: string, pathname: string): CoreError {
	return new CoreError("validation_failed", {
		details: { fields: [{ path: "path", problem: "unknown_route", expected: `${method} ${pathname} is not a /v1 route` }] },
	});
}

export function createRouter(deps: RouterDeps): (request: Request) => Promise<Response> {
	const nextRequestId = deps.requestId ?? mintRequestId;

	async function dispatch(request: Request, url: URL, requestId: string): Promise<Response> {
		const segments = url.pathname.split("/").filter((segment) => segment !== "");
		const method = request.method.toUpperCase();

		// §5.1 — process liveness only. No auth required, no dependency touched:
		// it must answer while the store is migrating and the orchestrator is
		// still reconciling, which is what makes it a liveness probe rather than
		// a second readiness probe.
		if (method === "GET" && url.pathname === "/v1/health/live") {
			return jsonResponse(deps.core.live(), 200, requestId);
		}

		// Every other route is authenticated (§1.1) and may report `not_ready`
		// (§2.3).
		assertAuthorized(request, deps.serviceToken);

		// §5.2 answers readiness itself; every other route is refused until it is
		// ready (plan §8.4 step 6: "Only then report readiness and accept
		// interface traffic").
		if (method === "GET" && url.pathname === "/v1/health/ready") {
			return jsonResponse(await deps.core.ready(), 200, requestId);
		}
		if (!deps.core.isReady()) throw new CoreError("not_ready");

		if (segments[0] !== "v1") throw unknownRoute(method, url.pathname);

		// §5.3
		if (method === "GET" && url.pathname === "/v1/jobs") {
			return jsonResponse(await deps.core.listJobs(parseListJobsQuery(url)), 200, requestId);
		}

		// §5.4 — Idempotency-Key optional ([C-05]): this route is already
		// idempotent by the unique workspace_rel_path constraint.
		if (method === "POST" && url.pathname === "/v1/jobs") {
			readIdempotencyKey(request, "optional");
			const body = await readJsonBody(request);
			const result = await deps.core.registerJob({
				clientKey: body.clientKey,
				monthId: body.monthId,
				title: body.title,
				externalRef: body.externalRef,
				requestedBy: body.requestedBy,
			});
			return jsonResponse({ job: result.job, created: result.created }, result.created ? 201 : 200, requestId);
		}

		// §5.13 — matched before the `{jobId}` pattern; `resolve` is a fixed
		// segment, not an id.
		if (method === "POST" && url.pathname === "/v1/jobs/resolve") {
			readIdempotencyKey(request, "optional");
			const body = await readJsonBody(request);
			const result = await deps.core.resolveJob({
				clientKey: body.clientKey,
				monthKey: body.monthKey,
				externalRef: body.externalRef,
				register: body.register,
				requestedBy: body.requestedBy,
			});
			return jsonResponse(result, result.created ? 201 : 200, requestId);
		}

		// §5.5
		if (method === "GET" && segments.length === 3 && segments[1] === "jobs") {
			const includeQueue = url.searchParams.getAll("include").includes("queue");
			// The raw path segment, NOT percent-decoded: a job id is `[0-9A-Za-z]`
			// only (job.ts's isJobId), so nothing legitimate needs decoding, and
			// `decodeURIComponent` on a malformed escape such as `/v1/jobs/%zz`
			// throws a URIError that would escape the CoreError path and become a
			// `500`. §5.5 requires `400 validation_failed` for a value that is not a
			// well-formed job id, which is what getJob now sees and raises.
			const job = await deps.core.getJob(segments[2], { includeQueue });
			return jsonResponse({ job }, 200, requestId);
		}

		throw unknownRoute(method, url.pathname);
	}

	return async function handle(request: Request): Promise<Response> {
		const requestId = nextRequestId();
		const url = new URL(request.url);
		try {
			const response = await dispatch(request, url, requestId);
			deps.logger.info("http.request", {
				requestId,
				method: request.method,
				path: url.pathname,
				status: response.status,
			});
			return response;
		} catch (thrown) {
			const error = toCoreError(thrown);
			// Plan §18: the log carries the request id so an operator can join a
			// screenshot to a log line. §2.5 keeps the RESPONSE free of internals;
			// the unhandled cause is logged here and nowhere else.
			deps.logger[error.status >= 500 ? "error" : "warn"]("http.request_failed", {
				requestId,
				method: request.method,
				path: url.pathname,
				status: error.status,
				code: error.code,
				...(error.code === "internal_error" && thrown instanceof Error ? { cause: thrown.message } : {}),
			});
			return jsonResponse(error.toBody(requestId), error.status, requestId);
		}
	};
}
