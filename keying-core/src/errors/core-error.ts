// The single failure path of this service (spec §2.1). Every route reports a
// failure by throwing a CoreError; the HTTP adapter is the only place that
// turns one into a response, so there is exactly one error body shape on the
// wire and no route can invent a second one.
//
// [C-10]: the body is nested under `error` rather than flat, because a success
// body may legitimately contain a field called `code` (a COA account code
// does) and a flat shape would make "is this an error?" a guess about which
// keys are present.
import { ERROR_MESSAGE_TH, ERROR_STATUS, type ErrorCode } from "./codes";

/** §2.4's four `details` shapes. `details` is optional, code-specific, and
 * documented per code — never free-form, which is why this is a union and not
 * `Record<string, unknown>`. */
export type ValidationFieldProblem = {
	path: string;
	problem: string;
	expected?: string;
};

export type ValidationDetails = { fields: ValidationFieldProblem[] };

/** Shape 2 — any command refused by state. `allowedCommands` is the row of
 * §3.4's matrix for the run's current state, so a platform can grey a button
 * without re-implementing the matrix. */
export type CommandRefusedDetails = {
	jobId: string;
	currentStatus: string;
	queued: boolean;
	active: boolean;
	allowedCommands: string[];
};

export type StaleVersionDetails = {
	currentEtag: string;
	groupId: string;
	bucket: string;
};

export type RepairImpactDetails = {
	jobId: string;
	repairImpact: {
		destroys: boolean;
		editedGroups: number;
		groupCount: number;
		lastHumanEditAt: string | null;
	};
};

/** `month_folder_not_found` carries `details.expectedMonthId` (plan §9.2 /
 * §5.13 step 4) — the fifth documented shape, small enough that §2.4 states it
 * inline in the code table rather than as its own block. */
export type MonthFolderDetails = { expectedMonthId: string };

/** §5.2 [C-15]: the readiness 503 carries the same `checks` object as the 200,
 * inside `details`, so an operator reading a failing probe learns which check
 * failed without going to the logs. */
export type NotReadyDetails = { checks: Record<string, unknown> };

/** §5.20: a `404` whose reason is "the directory exists but coa.csv does not". */
export type ReasonDetails = { reason: string };

export type ErrorDetails =
	| ValidationDetails
	| CommandRefusedDetails
	| StaleVersionDetails
	| RepairImpactDetails
	| MonthFolderDetails
	| NotReadyDetails
	| ReasonDetails;

export type ErrorBody = {
	error: {
		code: ErrorCode;
		message: string;
		status: number;
		requestId: string;
		details?: ErrorDetails;
	};
};

export class CoreError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	/** The Thai, human, operator-safe message that goes on the wire. `message`
	 * (Error's own) carries the same text so an uncaught throw still logs
	 * something meaningful. */
	readonly messageTh: string;
	readonly details?: ErrorDetails;

	constructor(code: ErrorCode, options: { message?: string; details?: ErrorDetails } = {}) {
		const messageTh = options.message ?? ERROR_MESSAGE_TH[code];
		super(messageTh);
		this.name = "CoreError";
		this.code = code;
		this.status = ERROR_STATUS[code];
		this.messageTh = messageTh;
		this.details = options.details;
	}

	toBody(requestId: string): ErrorBody {
		return {
			error: {
				code: this.code,
				message: this.messageTh,
				// §2.1: the status is repeated in the body so a client that only
				// logs the body can still tell a 409 from a 503.
				status: this.status,
				requestId,
				...(this.details === undefined ? {} : { details: this.details }),
			},
		};
	}
}

/** Turn anything thrown into a CoreError. A non-CoreError is an unhandled
 * failure: it becomes `internal_error`, whose message is the fixed Thai string
 * and never the underlying exception's (§2.5). */
export function toCoreError(thrown: unknown): CoreError {
	if (thrown instanceof CoreError) return thrown;
	return new CoreError("internal_error");
}

export function validationFailed(fields: ValidationFieldProblem[]): CoreError {
	return new CoreError("validation_failed", { details: { fields } });
}
