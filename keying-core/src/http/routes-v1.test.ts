// The routes against the spec's own schemas and status codes. Nothing here
// asserts "whatever the implementation does" — every expectation is a line of
// §5 or §2, cited in the test name.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createKeyingCore, type KeyingCore } from "../application/keying-core";
import { createInMemoryRunProjectionStore } from "../application/projection-store";
import { unscheduledSchedulerView } from "../application/scheduler-view";
import { ERROR_CODES } from "../errors/codes";
import { createInMemoryJobRepository } from "../jobs/job-repository";
import { silentLogger } from "../observability/logger";
import { createFixture, type Fixture } from "../test-support/workspace-fixture";
import { createRouter } from "./routes-v1";

const TOKEN = "s3rvice-token-for-tests";

let fixture: Fixture;
let core: KeyingCore;
let handle: (request: Request) => Promise<Response>;

function makeCore(): KeyingCore {
	return createKeyingCore({
		workspaceRoot: fixture.root,
		buddhistCenturyBase: 2500,
		jobs: createInMemoryJobRepository(),
		projections: createInMemoryRunProjectionStore(),
		scheduler: unscheduledSchedulerView(1),
		logger: silentLogger,
		now: () => "2026-08-07T12:00:00.000Z",
		streamId: "ksk-core-TEST0001",
		startedAt: "2026-08-07T08:00:01.004Z",
	});
}

type CallOptions = { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> };

async function call(path: string, options: CallOptions = {}): Promise<{ status: number; body: any; headers: Headers }> {
	const headers: Record<string, string> = { ...options.headers };
	const token = options.token === undefined ? TOKEN : options.token;
	if (token !== null) headers.authorization = `Bearer ${token}`;
	if (options.body !== undefined) headers["content-type"] = "application/json";
	const response = await handle(
		new Request(`http://keying-core${path}`, {
			method: options.method ?? "GET",
			headers,
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		}),
	);
	return { status: response.status, body: await response.json(), headers: response.headers };
}

beforeEach(async () => {
	fixture = createFixture();
	fixture.addMonth("216", "69-08");
	fixture.addMonth("216", "69-07");
	fixture.addClientFile("216", "CLIENT.md", '---\nclient_name: "บริษัท สองหนึ่งหก จำกัด"\n---\n');
	core = makeCore();
	await core.boot();
	handle = createRouter({ core, serviceToken: TOKEN, logger: silentLogger });
});

afterEach(() => fixture.cleanup());

describe("§1.1 transport and trust", () => {
	test("§5.1 needs no auth — it must answer while the rest of the service is still coming up", async () => {
		const unbooted = makeCore();
		const bare = createRouter({ core: unbooted, serviceToken: TOKEN, logger: silentLogger });
		const response = await bare(new Request("http://keying-core/v1/health/live"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "live",
			service: "keying-core",
			streamId: "ksk-core-TEST0001",
			startedAt: "2026-08-07T08:00:01.004Z",
		});
	});

	test("every other route is 401 without a token, and the body says nothing about which", async () => {
		for (const path of ["/v1/health/ready", "/v1/jobs"]) {
			const missing = await call(path, { token: null });
			expect(missing.status).toBe(401);
			expect(missing.body.error.code).toBe("unauthorized");
			expect(missing.body.error.details).toBeUndefined();

			const wrong = await call(path, { token: "not-the-token" });
			expect(wrong.status).toBe(401);
			// A wrong token and a missing one are indistinguishable in the response.
			expect(wrong.body.error.code).toBe(missing.body.error.code);
			expect(wrong.body.error.message).toBe(missing.body.error.message);
		}
	});

	test("a token of the wrong length is rejected without leaking that fact", async () => {
		const short = await call("/v1/jobs", { token: "x" });
		const long = await call("/v1/jobs", { token: `${TOKEN}extra` });
		expect(short.status).toBe(401);
		expect(long.status).toBe(401);
	});

	test("responses are application/json; charset=utf-8 and carry the request id", async () => {
		const response = await handle(new Request("http://keying-core/v1/health/live"));
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("x-request-id")).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{16}$/);
	});

	test("§2.1 every error body is nested under `error` with a code, message, status and requestId", async () => {
		const { status, body, headers } = await call("/v1/jobs/nope");
		expect(status).toBe(400);
		expect(Object.keys(body)).toEqual(["error"]);
		expect(body.error.status).toBe(400);
		expect(ERROR_CODES).toContain(body.error.code);
		expect(typeof body.error.message).toBe("string");
		expect(body.error.requestId).toBe(headers.get("x-request-id"));
	});
});

describe("§2.3 not_ready guards every route except §5.1", () => {
	test("an unbooted service answers live, reports 503 on ready, and refuses the rest", async () => {
		const unbooted = makeCore();
		const bare = createRouter({ core: unbooted, serviceToken: TOKEN, logger: silentLogger });
		const auth = { authorization: `Bearer ${TOKEN}` };

		expect((await bare(new Request("http://keying-core/v1/health/live"))).status).toBe(200);

		const ready = await bare(new Request("http://keying-core/v1/health/ready", { headers: auth }));
		expect(ready.status).toBe(503);
		const readyBody = (await ready.json()) as any;
		expect(readyBody.error.code).toBe("not_ready");
		// [C-15]: the same checks object as the 200, inside details.
		expect(readyBody.error.details.checks.orchestrator.ok).toBe(false);

		const jobs = await bare(new Request("http://keying-core/v1/jobs", { headers: auth }));
		expect(jobs.status).toBe(503);
		expect(((await jobs.json()) as any).error.code).toBe("not_ready");
	});
});

describe("§5.2 GET /v1/health/ready", () => {
	test("200 with checks, queue and warnings", async () => {
		const { status, body } = await call("/v1/health/ready");
		expect(status).toBe(200);
		expect(body.status).toBe("ready");
		expect(body.warnings).toEqual([]);
		expect(body.queue).toEqual({ depth: 0, active: 0, concurrency: 1 });
		expect(body.checks.buddhistCentury).toEqual({ base: 2500, window: "2500-2599", expiresOn: "2057-01-01" });
	});

	test("a non-matching month folder appears in warnings and does not change the status", async () => {
		fixture.addMonth("216", "69-8");
		const { status, body } = await call("/v1/health/ready");
		expect(status).toBe(200);
		expect(body.status).toBe("ready");
		expect(body.warnings).toEqual([
			{
				code: "month_folder_ignored",
				clientKey: "216",
				name: "69-8",
				message: "ชื่อโฟลเดอร์เดือนไม่ตรงรูปแบบ YY-MM จึงข้ามไป",
			},
		]);
	});
});

describe("§5.4 POST /v1/jobs", () => {
	test("201 on create, 200 when it already existed", async () => {
		const created = await call("/v1/jobs", { method: "POST", body: { clientKey: "216", monthId: "69-08" } });
		expect(created.status).toBe(201);
		expect(created.body.created).toBe(true);
		expect(created.body.job.workspaceRelPath).toBe("216/69-08");

		const again = await call("/v1/jobs", { method: "POST", body: { clientKey: "216", monthId: "69-08" } });
		expect(again.status).toBe(200);
		expect(again.body.created).toBe(false);
		expect(again.body.job.jobId).toBe(created.body.job.jobId);
	});

	test("the status codes §5.4 lists, and no others", async () => {
		expect((await call("/v1/jobs", { method: "POST", body: { monthId: "69-08" } })).body.error.code).toBe(
			"invalid_client_key",
		);
		expect((await call("/v1/jobs", { method: "POST", body: { clientKey: "216", monthId: "69-8" } })).body.error.code).toBe(
			"invalid_month_id",
		);
		const unknownClient = await call("/v1/jobs", { method: "POST", body: { clientKey: "ไม่มี", monthId: "69-08" } });
		expect(unknownClient.status).toBe(404);
		expect(unknownClient.body.error.code).toBe("client_not_found");

		const unknownMonth = await call("/v1/jobs", { method: "POST", body: { clientKey: "216", monthId: "69-09" } });
		expect(unknownMonth.status).toBe(404);
		expect(unknownMonth.body.error.code).toBe("month_folder_not_found");
		expect(unknownMonth.body.error.details).toEqual({ expectedMonthId: "69-09" });
	});

	test("a body that is not a JSON object is 400 validation_failed", async () => {
		const response = await handle(
			new Request("http://keying-core/v1/jobs", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: "[]",
			}),
		);
		expect(response.status).toBe(400);
		expect(((await response.json()) as any).error.code).toBe("validation_failed");
	});

	test("[C-05] Idempotency-Key is optional here, but a malformed one is still refused", async () => {
		const withKey = await call("/v1/jobs", {
			method: "POST",
			body: { clientKey: "216", monthId: "69-08" },
			headers: { "idempotency-key": "216-monthly-69-08:1:ksk-keying:3" },
		});
		expect(withKey.status).toBe(201);

		const badKey = await call("/v1/jobs", {
			method: "POST",
			body: { clientKey: "216", monthId: "69-07" },
			headers: { "idempotency-key": "too-short" },
		});
		expect(badKey.status).toBe(400);
		expect(badKey.body.error.code).toBe("idempotency_key_invalid");
	});
});

describe("§5.13 POST /v1/jobs/resolve", () => {
	test("201 on create, 200 on lookup, and the mapping both ways", async () => {
		const created = await call("/v1/jobs/resolve", { method: "POST", body: { clientKey: "216", monthKey: "2569-08" } });
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			workspaceRelPath: "216/69-08",
			clientKey: "216",
			monthId: "69-08",
			monthKey: "2569-08",
			created: true,
		});
		expect(created.body.runRef).toBe(created.body.jobId);

		const again = await call("/v1/jobs/resolve", { method: "POST", body: { clientKey: "216", monthKey: "2569-08" } });
		expect(again.status).toBe(200);
		expect(again.body.created).toBe(false);
	});

	test("[C-20] register:false is a 200 lookup with a null jobId and a null run", async () => {
		const { status, body } = await call("/v1/jobs/resolve", {
			method: "POST",
			body: { clientKey: "216", monthKey: "2569-07", register: false },
		});
		expect(status).toBe(200);
		expect(body).toMatchObject({ jobId: null, runRef: null, created: false, run: null, workspaceRelPath: "216/69-07" });
	});

	test("a truncated monthKey is 400 invalid_month_key with the expected pattern", async () => {
		const { status, body } = await call("/v1/jobs/resolve", { method: "POST", body: { clientKey: "216", monthKey: "69-08" } });
		expect(status).toBe(400);
		expect(body.error.code).toBe("invalid_month_key");
		expect(body.error.details.fields[0].expected).toBe("^[0-9]{4}-(0[1-9]|1[0-2])$");
	});

	test("resolve is routed before the {jobId} pattern", async () => {
		// GET /v1/jobs/resolve is not a route; POST is. The fixed segment must not
		// be swallowed by the id pattern in either direction.
		expect((await call("/v1/jobs/resolve")).body.error.code).toBe("validation_failed");
	});
});

describe("§5.3 GET /v1/jobs and §5.5 GET /v1/jobs/{jobId}", () => {
	let jobId = "";

	beforeEach(async () => {
		const created = await call("/v1/jobs", { method: "POST", body: { clientKey: "216", monthId: "69-08" } });
		jobId = created.body.job.jobId;
		await call("/v1/jobs", { method: "POST", body: { clientKey: "216", monthId: "69-07" } });
	});

	test("the list carries the job shape §5.3 documents", async () => {
		const { status, body } = await call("/v1/jobs");
		expect(status).toBe(200);
		expect(body.total).toBe(2);
		expect(body.nextCursor).toBeNull();
		const job = body.jobs.find((entry: any) => entry.jobId === jobId);
		expect(Object.keys(job).sort()).toEqual(
			[
				"archived",
				"clientKey",
				"companyName",
				"createdAt",
				"externalRef",
				"jobId",
				"monthId",
				"run",
				"title",
				"updatedAt",
				"workspaceRelPath",
			].sort(),
		);
		expect(job.companyName).toBe("บริษัท สองหนึ่งหก จำกัด");
	});

	test("query parameters are validated, not ignored", async () => {
		expect((await call("/v1/jobs?archived=maybe")).body.error.code).toBe("validation_failed");
		expect((await call("/v1/jobs?status=teleported")).body.error.code).toBe("validation_failed");
		expect((await call("/v1/jobs?limit=nine")).body.error.code).toBe("validation_failed");
		expect((await call("/v1/jobs?limit=501")).body.error.code).toBe("validation_failed");
		expect((await call("/v1/jobs?hasRunRecord=1")).body.error.code).toBe("validation_failed");
		expect((await call("/v1/jobs?status=queued&status=blocked")).status).toBe(200);
	});

	test("pages with a cursor", async () => {
		const first = await call("/v1/jobs?limit=1");
		expect(first.body.jobs.length).toBe(1);
		expect(first.body.total).toBe(2);
		const second = await call(`/v1/jobs?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
		expect(second.body.jobs[0].workspaceRelPath).not.toBe(first.body.jobs[0].workspaceRelPath);
	});

	test("the single-job read carries queuePosition and allowedCommands", async () => {
		const { status, body } = await call(`/v1/jobs/${jobId}`);
		expect(status).toBe(200);
		expect(Object.keys(body)).toEqual(["job"]);
		expect(body.job.queuePosition).toBeNull();
		expect(body.job.allowedCommands).toEqual(["start", "repair"]);
		expect(body.job.run.repairImpact).toBeDefined();
	});

	test("an unknown jobId is 404 job_not_found; a malformed one is 400", async () => {
		const unknown = await call("/v1/jobs/job_0000000000000000000000");
		expect(unknown.status).toBe(404);
		expect(unknown.body.error.code).toBe("job_not_found");
		expect(unknown.body.error.message).toBe("ไม่พบงานนี้");

		const malformed = await call("/v1/jobs/12345");
		expect(malformed.status).toBe(400);
		expect(malformed.body.error.code).toBe("validation_failed");
	});

	test("a malformed percent-escape in the jobId is 400, not a 500 from the decoder", async () => {
		// URL leaves `%zz` literal in pathname, and decodeURIComponent throws a
		// URIError on it — which would escape the CoreError path entirely. §5.5:
		// a value that is not a well-formed job id is 400 validation_failed.
		for (const path of ["/v1/jobs/%zz", "/v1/jobs/%E0%A4%A"]) {
			const { status, body } = await call(path);
			expect(status).toBe(400);
			expect(body.error.code).toBe("validation_failed");
			expect(body.error.details.fields[0].path).toBe("jobId");
		}
	});
});

describe("routes this slice does not serve", () => {
	test("an out-of-scope /v1 route is refused through the error model, not a bare 404 page", async () => {
		for (const [method, path] of [
			["POST", `/v1/jobs/job_0000000000000000000000/start`],
			["GET", "/v1/events"],
			["GET", "/v1/runs"],
			["PATCH", "/v1/runs/job_0000000000000000000000/groups/g-004"],
		] as const) {
			const { status, body } = await call(path, { method });
			expect(status).toBe(400);
			// §2.3's list is closed and has no "unknown route" code; see README →
			// "Findings against the spec".
			expect(body.error.code).toBe("validation_failed");
			expect(body.error.details.fields[0].problem).toBe("unknown_route");
		}
	});

	test("a path outside /v1 is refused the same way", async () => {
		expect((await call("/api/runs")).status).toBe(400);
		expect((await call("/")).status).toBe(400);
	});

	test("a wrong method on a real path does not fall through to another route", async () => {
		expect((await call("/v1/jobs", { method: "DELETE" })).status).toBe(400);
		expect((await call("/v1/health/live", { method: "POST" })).status).toBe(400);
	});
});

describe("§2.5 what an error never contains", () => {
	test("no host path, no token, no stack", async () => {
		const responses = [
			await call("/v1/jobs", { method: "POST", body: { clientKey: "../../etc", monthId: "69-08" } }),
			await call("/v1/jobs", { method: "POST", body: { clientKey: "ไม่มี", monthId: "69-08" } }),
			await call("/v1/jobs/nope", { token: null }),
		];
		for (const { body } of responses) {
			const serialised = JSON.stringify(body);
			expect(serialised).not.toContain(fixture.root);
			expect(serialised).not.toContain(TOKEN);
			expect(serialised).not.toContain("at Object.");
			expect(serialised).not.toContain("node:");
		}
	});

	test("an unexpected failure is internal_error with a fixed Thai message", async () => {
		const exploding = {
			...core,
			isReady: () => true,
			listJobs: async () => {
				throw new Error("SQLITE_BUSY at /Users/peerasak/secret/core.sqlite");
			},
		} as unknown as KeyingCore;
		const bare = createRouter({ core: exploding, serviceToken: TOKEN, logger: silentLogger });
		const response = await bare(
			new Request("http://keying-core/v1/jobs", { headers: { authorization: `Bearer ${TOKEN}` } }),
		);
		expect(response.status).toBe(500);
		const body = (await response.json()) as any;
		expect(body.error.code).toBe("internal_error");
		expect(body.error.message).toBe("เกิดข้อผิดพลาดภายในระบบ");
		expect(JSON.stringify(body)).not.toContain("SQLITE_BUSY");
		expect(JSON.stringify(body)).not.toContain("/Users");
	});
});
