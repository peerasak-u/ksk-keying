import { describe, expect, test } from "bun:test";
import { ERROR_CODES, ERROR_MESSAGE_TH, ERROR_STATUS, isErrorCode, type ErrorCode } from "./codes";
import { CoreError, toCoreError, validationFailed } from "./core-error";

// The closed list of spec §2.3, transcribed from the document's own table so
// this test fails if a code is dropped, renamed, or given a different status.
// "Thirty codes. A client may switch exhaustively on this list."
const SPEC_TABLE: Array<[ErrorCode, number]> = [
	["validation_failed", 400],
	["invalid_month_key", 400],
	["invalid_month_id", 400],
	["invalid_client_key", 400],
	["invalid_path", 400],
	["invalid_unit", 400],
	["idempotency_key_required", 400],
	["idempotency_key_invalid", 400],
	["unsupported_field", 400],
	["unauthorized", 401],
	["job_not_found", 404],
	["client_not_found", 404],
	["month_folder_not_found", 404],
	["group_not_found", 404],
	["unit_not_found", 404],
	["run_not_startable", 409],
	["run_not_retryable", 409],
	["run_not_repairable", 409],
	["repair_not_acknowledged", 409],
	["run_not_running", 409],
	["run_busy", 409],
	["stale_version", 409],
	["idempotency_key_conflict", 409],
	["idempotency_key_in_flight", 409],
	["export_not_ready", 409],
	["decision_not_pending", 409],
	["artifact_malformed", 422],
	["not_ready", 503],
	["halted_fatal_cleanup", 503],
	["internal_error", 500],
];

describe("the closed code list (§2.3)", () => {
	test("carries exactly the thirty codes the spec names, and no more", () => {
		expect(ERROR_CODES.length).toBe(30);
		expect([...ERROR_CODES].sort()).toEqual(SPEC_TABLE.map(([code]) => code).sort());
	});

	test("maps every code to the status §2.2's rule assigns it", () => {
		for (const [code, status] of SPEC_TABLE) {
			expect(ERROR_STATUS[code]).toBe(status);
		}
	});

	test("carries a non-empty Thai message for every code (§1.2 [C-02])", () => {
		for (const code of ERROR_CODES) {
			const message = ERROR_MESSAGE_TH[code];
			expect(message.length).toBeGreaterThan(0);
			// Thai, not English-only: at least one character in the Thai block.
			expect(/[฀-๿]/.test(message)).toBe(true);
		}
	});

	test("keeps the two consequences §2.2 says people get wrong", () => {
		// 1. A month folder that fails the format is a 400; one that matches but
		//    is absent from disk is a 404. Different failures, different codes.
		expect(ERROR_STATUS.invalid_month_id).toBe(400);
		expect(ERROR_STATUS.month_folder_not_found).toBe(404);
		// 2. An illegal command is never a 400.
		for (const code of ["run_not_startable", "run_not_retryable", "run_not_repairable", "run_not_running"] as const) {
			expect(ERROR_STATUS[code]).toBe(409);
		}
	});

	test("isErrorCode accepts members and rejects anything else", () => {
		expect(isErrorCode("run_not_startable")).toBe(true);
		expect(isErrorCode("route_not_found")).toBe(false);
		expect(isErrorCode("")).toBe(false);
	});
});

describe("the error body (§2.1)", () => {
	test("nests under `error` and repeats the status inside the body ([C-10])", () => {
		const body = new CoreError("run_not_startable", {
			message: "ลูกค้ารายนี้มีการรันค้างอยู่แล้ว ใช้ปุ่มลองใหม่แทน",
			details: {
				jobId: "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
				currentStatus: "stage-running",
				queued: false,
				active: true,
				allowedCommands: ["stop"],
			},
		}).toBody("req_01J8ZC4K7Q");

		expect(body).toEqual({
			error: {
				code: "run_not_startable",
				message: "ลูกค้ารายนี้มีการรันค้างอยู่แล้ว ใช้ปุ่มลองใหม่แทน",
				status: 409,
				requestId: "req_01J8ZC4K7Q",
				details: {
					jobId: "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
					currentStatus: "stage-running",
					queued: false,
					active: true,
					allowedCommands: ["stop"],
				},
			},
		});
	});

	test("omits `details` entirely rather than sending null (§1.3's missing-key rule)", () => {
		const body = new CoreError("job_not_found").toBody("req_x");
		expect("details" in body.error).toBe(false);
		expect(body.error.message).toBe("ไม่พบงานนี้");
	});

	test("validationFailed carries §2.4's shape 1", () => {
		const body = validationFailed([{ path: "monthKey", problem: "pattern", expected: "^[0-9]{4}-(0[1-9]|1[0-2])$" }]).toBody("req_x");
		expect(body.error.code).toBe("validation_failed");
		expect(body.error.status).toBe(400);
		expect(body.error.details).toEqual({
			fields: [{ path: "monthKey", problem: "pattern", expected: "^[0-9]{4}-(0[1-9]|1[0-2])$" }],
		});
	});
});

describe("toCoreError (§2.5)", () => {
	test("passes a CoreError through untouched", () => {
		const original = new CoreError("run_busy");
		expect(toCoreError(original)).toBe(original);
	});

	test("never leaks an internal message through internal_error", () => {
		const converted = toCoreError(new Error("SQLITE_BUSY at /Users/peerasak/secret/db.sqlite"));
		expect(converted.code).toBe("internal_error");
		expect(converted.status).toBe(500);
		expect(converted.messageTh).toBe(ERROR_MESSAGE_TH.internal_error);
		expect(converted.messageTh).not.toContain("/Users");
		expect(converted.messageTh).not.toContain("SQLITE");
	});

	test("converts a non-Error throw too", () => {
		expect(toCoreError("boom").code).toBe("internal_error");
		expect(toCoreError(undefined).code).toBe("internal_error");
	});
});
