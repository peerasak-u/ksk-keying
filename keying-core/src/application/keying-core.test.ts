import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ErrorCode } from "../errors/codes";
import { CoreError } from "../errors/core-error";
import { isJobId } from "../jobs/job";
import { createInMemoryJobRepository } from "../jobs/job-repository";
import { createLogger, silentLogger } from "../observability/logger";
import { createFixture, type Fixture } from "../test-support/workspace-fixture";
import { createKeyingCore, type KeyingCore } from "./keying-core";
import { createInMemoryRunProjectionStore } from "./projection-store";
import { staticSchedulerView, unscheduledSchedulerView, type SchedulerView } from "./scheduler-view";

let fixture: Fixture;
let core: KeyingCore;

function build(scheduler: SchedulerView = unscheduledSchedulerView(1)): KeyingCore {
	return createKeyingCore({
		workspaceRoot: fixture.root,
		buddhistCenturyBase: 2500,
		jobs: createInMemoryJobRepository(),
		projections: createInMemoryRunProjectionStore(),
		scheduler,
		logger: silentLogger,
		now: () => "2026-08-07T12:00:00.000Z",
		streamId: "ksk-core-TEST0001",
		startedAt: "2026-08-07T08:00:01.004Z",
	});
}

beforeEach(async () => {
	fixture = createFixture();
	fixture.addMonth("216", "69-08");
	fixture.addMonth("216", "69-07");
	fixture.addMonth("ศรีชัย", "69-08");
	fixture.addClientFile("216", "CLIENT.md", '---\nclient_name: "บริษัท สองหนึ่งหก จำกัด"\n---\n');
	core = build();
	await core.boot();
});

afterEach(() => fixture.cleanup());

async function expectCoreError(promise: Promise<unknown>, code: ErrorCode): Promise<CoreError> {
	try {
		await promise;
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(CoreError);
		expect((thrown as CoreError).code).toBe(code);
		return thrown as CoreError;
	}
	throw new Error(`expected a CoreError with code ${code}`);
}

describe("§5.1 GET /v1/health/live", () => {
	test("answers with the process-instance id and the start time", () => {
		expect(core.live()).toEqual({
			status: "live",
			service: "keying-core",
			streamId: "ksk-core-TEST0001",
			startedAt: "2026-08-07T08:00:01.004Z",
		});
	});
});

describe("§5.2 GET /v1/health/ready", () => {
	test("reports ready with the workspace census, the queue, and the century window", async () => {
		const body = await core.ready();
		expect(body.status).toBe("ready");
		expect(body.streamId).toBe("ksk-core-TEST0001");
		expect(body.checks.workspace).toMatchObject({ ok: true, root: fixture.root, clients: 2, months: 3 });
		expect(body.checks.orchestrator.ok).toBe(true);
		expect(body.checks.buddhistCentury).toEqual({ base: 2500, window: "2500-2599", expiresOn: "2057-01-01" });
		expect(body.queue).toEqual({ depth: 0, active: 0, concurrency: 1 });
	});

	test("§5.2's store check keeps the spec's `sqlite` key and is honest about there being none", async () => {
		const body = await core.ready();
		expect(body.checks.sqlite).toEqual({ ok: false, reason: "sqlite_not_implemented" });
		// §1.3: absent, not nulled — this route does not carry those facts yet.
		expect("schemaVersion" in body.checks.sqlite).toBe(false);
		expect("journalMode" in body.checks.sqlite).toBe(false);
		// And a failing sqlite check does NOT make the service un-ready in this
		// slice, or every route would be permanently 503 (README finding 8).
		expect(body.status).toBe("ready");
		expect(core.isReady()).toBe(true);
	});

	test("warnings[] is [], never absent, when there is nothing to report", async () => {
		expect((await core.ready()).warnings).toEqual([]);
	});

	test("names EVERY skipped non-matching month directory, verbatim", async () => {
		fixture.addMonth("216", "69-8");
		fixture.addMonth("ศรีชัย", "69-08 (แก้ไข)");
		fixture.addMonth("216", "69-08 "); // a trailing space must stay visible
		const body = await core.ready();
		expect(body.warnings.map((warning) => `${warning.clientKey}/${warning.name}`).sort()).toEqual(
			["216/69-8", "216/69-08 ", "ศรีชัย/69-08 (แก้ไข)"].sort(),
		);
		for (const warning of body.warnings) {
			expect(warning.code).toBe("month_folder_ignored");
			expect(warning.message).toBe("ชื่อโฟลเดอร์เดือนไม่ตรงรูปแบบ YY-MM จึงข้ามไป");
		}
	});

	test("warnings do NOT make the service un-ready — a stray folder is an operator problem", async () => {
		fixture.addMonth("216", "69-8");
		const body = await core.ready();
		expect(body.status).toBe("ready");
		expect(body.warnings.length).toBe(1);
		// And the skipped folder is invisible to everything downstream.
		expect(body.checks.workspace.months).toBe(3);
	});

	test("dot-directories produce no warning and are excluded from the walk entirely", async () => {
		fixture.addMonth("216", ".git");
		fixture.addMonth("216", ".claude");
		const body = await core.ready();
		expect(body.warnings).toEqual([]);
		expect(body.checks.workspace.months).toBe(3);
	});

	test("[C-15] a not-ready service throws 503 carrying the same checks object inside details", async () => {
		const unbooted = build();
		const error = await expectCoreError(unbooted.ready(), "not_ready");
		expect(error.status).toBe(503);
		expect(error.messageTh).toBe("ระบบยังเตรียมตัวไม่เสร็จ");
		const details = error.details as { checks: { orchestrator: { ok: boolean; reason: string } } };
		expect(details.checks.orchestrator).toMatchObject({ ok: false, reason: "reconcile_in_progress" });
		expect(unbooted.isReady()).toBe(false);
	});

	test("a workspace root that is not there is un-ready, and says which check failed", async () => {
		const missing = createKeyingCore({
			workspaceRoot: `${fixture.root}/nope`,
			buddhistCenturyBase: 2500,
			jobs: createInMemoryJobRepository(),
			projections: createInMemoryRunProjectionStore(),
			scheduler: unscheduledSchedulerView(1),
			logger: silentLogger,
			now: () => "2026-08-07T12:00:00.000Z",
			streamId: "ksk-core-TEST0005",
			startedAt: "2026-08-07T08:00:01.004Z",
		});
		await missing.boot();
		const error = await expectCoreError(missing.ready(), "not_ready");
		const details = error.details as { checks: { workspace: { ok: boolean; reason: string } } };
		expect(details.checks.workspace).toMatchObject({ ok: false, reason: "workspace_root_missing" });
	});

	test("boot refuses a century base that is not a multiple of 100, and stays un-ready", async () => {
		const bad = createKeyingCore({
			workspaceRoot: fixture.root,
			buddhistCenturyBase: 2543,
			jobs: createInMemoryJobRepository(),
			projections: createInMemoryRunProjectionStore(),
			scheduler: unscheduledSchedulerView(1),
			logger: silentLogger,
			now: () => "2026-08-07T12:00:00.000Z",
			streamId: "ksk-core-TEST0006",
			startedAt: "2026-08-07T08:00:01.004Z",
		});
		expect(bad.boot()).rejects.toThrow(/multiple of 100/);
		expect(bad.isReady()).toBe(false);
	});

	test("boot warns about a registered job whose month folder has since gone", async () => {
		const lines: string[] = [];
		const noisy = createKeyingCore({
			workspaceRoot: fixture.root,
			buddhistCenturyBase: 2500,
			jobs: createInMemoryJobRepository(),
			projections: createInMemoryRunProjectionStore(),
			scheduler: unscheduledSchedulerView(1),
			logger: createLogger({ sink: (line) => lines.push(line), level: "debug" }),
			now: () => "2026-08-07T12:00:00.000Z",
			streamId: "ksk-core-TEST0007",
			startedAt: "2026-08-07T08:00:01.004Z",
		});
		await noisy.boot();
		await noisy.registerJob({ clientKey: "216", monthId: "69-08" });
		rmSync(fixture.monthDir("216", "69-08"), { recursive: true, force: true });
		lines.length = 0;
		await noisy.boot();
		const missing = lines.map((line) => JSON.parse(line)).filter((line) => line.event === "core.boot.job_path_missing");
		expect(missing.length).toBe(1);
		expect(missing[0].workspaceRelPath).toBe("216/69-08");
	});

	test("boot logs the resolved Buddhist century window (plan §9.2 [r3])", async () => {
		const lines: string[] = [];
		const noisy = createKeyingCore({
			workspaceRoot: fixture.root,
			buddhistCenturyBase: 2500,
			jobs: createInMemoryJobRepository(),
			projections: createInMemoryRunProjectionStore(),
			scheduler: unscheduledSchedulerView(1),
			logger: createLogger({ sink: (line) => lines.push(line), level: "debug" }),
			now: () => "2026-08-07T12:00:00.000Z",
			streamId: "ksk-core-TEST0008",
			startedAt: "2026-08-07T08:00:01.004Z",
		});
		await noisy.boot();
		const boot = lines.map((line) => JSON.parse(line)).find((line) => line.event === "core.boot");
		expect(boot).toMatchObject({ buddhistCenturyWindow: "2500-2599", buddhistCenturyExpiresOn: "2057-01-01" });
	});

	test("the queue block reflects the scheduler, not a guess", async () => {
		const scheduled = build(staticSchedulerView({ concurrency: 2, queue: ["216/69-07"], active: ["216/69-08"] }));
		await scheduled.boot();
		expect((await scheduled.ready()).queue).toEqual({ depth: 1, active: 1, concurrency: 2 });
	});
});

describe("§5.4 POST /v1/jobs — the operator's door", () => {
	test("registers a job bound to a validated client/month and starts nothing", async () => {
		const { job, created } = await core.registerJob({ clientKey: "216", monthId: "69-08" });
		expect(created).toBe(true);
		expect(isJobId(job.jobId)).toBe(true);
		expect(job.workspaceRelPath).toBe("216/69-08");
		expect(job.title).toBe("216 — 69-08");
		expect(job.companyName).toBe("บริษัท สองหนึ่งหก จำกัด");
		expect(job.archived).toBe(false);
		expect(job.externalRef).toBeNull();
		// "Registration starts nothing — the job's run is hasRunRecord: false."
		expect(job.run.hasRunRecord).toBe(false);
		expect(job.run.status).toBe("idle");
		expect(job.run.version).toBe(0);
	});

	test("registering an existing job is not an error: created:false, same jobId", async () => {
		const first = await core.registerJob({ clientKey: "216", monthId: "69-08" });
		const second = await core.registerJob({ clientKey: "216", monthId: "69-08" });
		expect(second.created).toBe(false);
		expect(second.job.jobId).toBe(first.job.jobId);
	});

	test("updates title and externalRef when they were supplied and differ", async () => {
		const first = await core.registerJob({ clientKey: "216", monthId: "69-08", title: "first" });
		const second = await core.registerJob({
			clientKey: "216",
			monthId: "69-08",
			title: "second",
			externalRef: { projectId: "216-monthly-69-08", phaseIndex: 1, workflowKey: "ksk-keying" },
		});
		expect(second.job.jobId).toBe(first.job.jobId);
		expect(second.job.title).toBe("second");
		expect(second.job.externalRef).toEqual({ projectId: "216-monthly-69-08", phaseIndex: 1, workflowKey: "ksk-keying" });
	});

	test("externalRef is stored verbatim and never interpreted", async () => {
		const weird = { projectId: "x", anything: { nested: [1, 2, 3] }, unknownField: "kept" };
		const { job } = await core.registerJob({ clientKey: "216", monthId: "69-08", externalRef: weird });
		expect(job.externalRef).toEqual(weird);
	});

	test("rejects a malformed monthId with 400, and an absent month with 404", async () => {
		await expectCoreError(core.registerJob({ clientKey: "216", monthId: "69-8" }), "invalid_month_id");
		const notFound = await expectCoreError(core.registerJob({ clientKey: "216", monthId: "69-09" }), "month_folder_not_found");
		expect(notFound.details).toEqual({ expectedMonthId: "69-09" });
	});

	test("rejects an unknown client with 404 and a traversing client key with 400", async () => {
		await expectCoreError(core.registerJob({ clientKey: "ไม่มี", monthId: "69-08" }), "client_not_found");
		await expectCoreError(core.registerJob({ clientKey: "../etc", monthId: "69-08" }), "invalid_client_key");
	});

	test("[C-17] does not accept a monthKey here — that is §5.13's door", async () => {
		await expectCoreError(core.registerJob({ clientKey: "216", monthId: "2569-08" }), "invalid_month_id");
	});

	test("rejects a title that is not a string", async () => {
		await expectCoreError(core.registerJob({ clientKey: "216", monthId: "69-08", title: 7 }), "validation_failed");
	});

	test("rejects an externalRef that is not an object", async () => {
		await expectCoreError(
			core.registerJob({ clientKey: "216", monthId: "69-08", externalRef: "srichai" }),
			"validation_failed",
		);
	});
});

describe("§5.13 POST /v1/jobs/resolve — the platform's only door", () => {
	test("maps monthKey to monthId, registers by default, and echoes both", async () => {
		const result = await core.resolveJob({ clientKey: "216", monthKey: "2569-08" });
		expect(result.created).toBe(true);
		expect(result.monthId).toBe("69-08");
		expect(result.monthKey).toBe("2569-08");
		expect(result.workspaceRelPath).toBe("216/69-08");
		// [C-03]: runRef is the same opaque token as jobId.
		expect(result.runRef).toBe(result.jobId);
		expect(result.run?.hasRunRecord).toBe(false);
	});

	test("a second resolve returns the same job with created:false", async () => {
		const first = await core.resolveJob({ clientKey: "216", monthKey: "2569-08" });
		const second = await core.resolveJob({ clientKey: "216", monthKey: "2569-08" });
		expect(second.created).toBe(false);
		expect(second.jobId).toBe(first.jobId);
	});

	test("[C-20] register:false is a pure lookup that creates nothing", async () => {
		const result = await core.resolveJob({ clientKey: "216", monthKey: "2569-08", register: false });
		expect(result).toMatchObject({
			jobId: null,
			runRef: null,
			created: false,
			run: null,
			workspaceRelPath: "216/69-08",
			monthId: "69-08",
		});
		expect((await core.listJobs({})).total).toBe(0);
	});

	test("register:false still resolves an existing job", async () => {
		const created = await core.resolveJob({ clientKey: "216", monthKey: "2569-08" });
		const looked = await core.resolveJob({ clientKey: "216", monthKey: "2569-08", register: false });
		expect(looked.jobId).toBe(created.jobId);
		expect(looked.created).toBe(false);
	});

	test("the four failures §5.13 enumerates", async () => {
		// 1. monthKey fails its regex.
		const bad = await expectCoreError(core.resolveJob({ clientKey: "216", monthKey: "69-08" }), "invalid_month_key");
		expect(bad.details).toEqual({
			fields: [{ path: "monthKey", problem: "pattern", expected: "^[0-9]{4}-(0[1-9]|1[0-2])$" }],
		});
		// 3. clientKey does not resolve to a directory.
		await expectCoreError(core.resolveJob({ clientKey: "ไม่มี", monthKey: "2569-08" }), "client_not_found");
		// 4. the directory is not on disk, and Core never fuzzy-matches a near miss.
		fixture.addMonth("216", "69-6");
		const missing = await expectCoreError(core.resolveJob({ clientKey: "216", monthKey: "2569-06" }), "month_folder_not_found");
		expect(missing.details).toEqual({ expectedMonthId: "69-06" });
	});

	test("rejects a non-boolean register", async () => {
		await expectCoreError(
			core.resolveJob({ clientKey: "216", monthKey: "2569-08", register: "yes" }),
			"validation_failed",
		);
	});
});

describe("§5.3 GET /v1/jobs", () => {
	beforeEach(async () => {
		await core.registerJob({ clientKey: "216", monthId: "69-08" });
		await core.registerJob({ clientKey: "216", monthId: "69-07" });
		await core.registerJob({ clientKey: "ศรีชัย", monthId: "69-08" });
	});

	test("[C-16] sorts by (clientKey, monthId) ascending with Thai collation", async () => {
		const { jobs, total, nextCursor } = await core.listJobs({});
		expect(jobs.map((job) => job.workspaceRelPath)).toEqual(["216/69-07", "216/69-08", "ศรีชัย/69-08"]);
		expect(total).toBe(3);
		expect(nextCursor).toBeNull();
	});

	test("filters by clientKey, repeatably", async () => {
		expect((await core.listJobs({ clientKey: ["216"] })).jobs.length).toBe(2);
		expect((await core.listJobs({ clientKey: ["216", "ศรีชัย"] })).jobs.length).toBe(3);
		expect((await core.listJobs({ clientKey: ["nope"] })).jobs.length).toBe(0);
	});

	test("filters by hasRunRecord", async () => {
		fixture.writeRunState("216", "69-08", { status: "blocked", stageIndex: 2 });
		expect((await core.listJobs({ hasRunRecord: true })).jobs.map((job) => job.monthId)).toEqual(["69-08"]);
		expect((await core.listJobs({ hasRunRecord: false })).jobs.length).toBe(2);
	});

	test("filters by status, including the scheduler values queued and active", async () => {
		fixture.writeRunState("216", "69-08", { status: "blocked", stageIndex: 2 });
		expect((await core.listJobs({ status: ["blocked"] })).jobs.length).toBe(1);
		expect((await core.listJobs({ status: ["done"] })).jobs.length).toBe(0);
		expect((await core.listJobs({ status: ["idle", "blocked"] })).jobs.length).toBe(3);

		const scheduled = createKeyingCore({
			workspaceRoot: fixture.root,
			buddhistCenturyBase: 2500,
			jobs: createInMemoryJobRepository(),
			projections: createInMemoryRunProjectionStore(),
			scheduler: staticSchedulerView({ queue: ["216/69-08"] }),
			logger: silentLogger,
			now: () => "2026-08-07T12:00:00.000Z",
			streamId: "ksk-core-TEST0002",
			startedAt: "2026-08-07T08:00:01.004Z",
		});
		await scheduled.boot();
		await scheduled.registerJob({ clientKey: "216", monthId: "69-08" });
		expect((await scheduled.listJobs({ status: ["queued"] })).jobs.length).toBe(1);
		expect((await scheduled.listJobs({ status: ["active"] })).jobs.length).toBe(0);
	});

	test("pages by cursor and reports the full total on every page", async () => {
		const first = await core.listJobs({ limit: 2 });
		expect(first.jobs.map((job) => job.workspaceRelPath)).toEqual(["216/69-07", "216/69-08"]);
		expect(first.total).toBe(3);
		expect(first.nextCursor).not.toBeNull();

		const second = await core.listJobs({ limit: 2, cursor: first.nextCursor! });
		expect(second.jobs.map((job) => job.workspaceRelPath)).toEqual(["ศรีชัย/69-08"]);
		expect(second.total).toBe(3);
		expect(second.nextCursor).toBeNull();
	});

	test("rejects a limit outside 1..500 and an unreadable cursor", async () => {
		await expectCoreError(core.listJobs({ limit: 0 }), "validation_failed");
		await expectCoreError(core.listJobs({ limit: 501 }), "validation_failed");
		await expectCoreError(core.listJobs({ cursor: "not-a-cursor" }), "validation_failed");
		// Decodable base64 that carries the wrong shape is refused too, rather
		// than silently paging from nowhere.
		await expectCoreError(
			core.listJobs({ cursor: Buffer.from(JSON.stringify({ clientKey: "216" }), "utf8").toString("base64url") }),
			"validation_failed",
		);
	});

	describe("one unreadable run-state.yaml does not blank the list", () => {
		beforeEach(() => {
			fixture.writeRunState("216", "69-07", { status: "done", stageIndex: 6 });
			fixture.writeRunState("ศรีชัย", "69-08", { status: "blocked", stageIndex: 2 });
			fixture.writeRawRunState("216", "69-08", "state: [this is not: a mapping\n");
		});

		test("§5.3 still answers 200 with EVERY job, and marks only the corrupt row", async () => {
			const { jobs, total } = await core.listJobs({});
			expect(jobs.map((job) => job.workspaceRelPath)).toEqual(["216/69-07", "216/69-08", "ศรีชัย/69-08"]);
			expect(total).toBe(3);

			const corrupt = jobs.find((job) => job.workspaceRelPath === "216/69-08")!;
			// Distinguishable from "this month never ran": the marker is additive and
			// the documented fields are all still there.
			expect(corrupt.artifactProblem).toEqual({ code: "artifact_malformed", reason: "run_state_unparseable" });
			expect(corrupt.jobId).toBeTruthy();
			expect(corrupt.companyName).toBe("บริษัท สองหนึ่งหก จำกัด");
			expect(corrupt.run.jobId).toBe(corrupt.jobId);

			// And a healthy row is untouched — no marker, real projection.
			const healthy = jobs.find((job) => job.workspaceRelPath === "216/69-07")!;
			expect(healthy.artifactProblem).toBeUndefined();
			expect(healthy.run.status).toBe("done");
		});

		test("the corrupt row survives the run-shaped filters rather than vanishing into them", async () => {
			for (const query of [{ hasRunRecord: false }, { hasRunRecord: true }, { status: ["done"] }]) {
				const { jobs } = await core.listJobs(query);
				expect(jobs.some((job) => job.workspaceRelPath === "216/69-08")).toBe(true);
			}
		});

		test("§5.5 keeps the hard 422 for that same job — a single-subject read has nothing else to return", async () => {
			const { jobs } = await core.listJobs({});
			const corrupt = jobs.find((job) => job.workspaceRelPath === "216/69-08")!;
			const error = await expectCoreError(core.getJob(corrupt.jobId), "artifact_malformed");
			expect(error.status).toBe(422);
		});

		test("§5.13 resolve still hands back a jobId, so the repair path stays reachable", async () => {
			// A 422 here would be a dead end: resolve is the platform's only way to
			// turn office identity into keying identity, so it could never obtain the
			// jobId it needs to repair the artifact that caused the failure.
			const resolved = await core.resolveJob({ clientKey: "216", monthKey: "2569-08" });
			expect(resolved.jobId).toBeTruthy();
			expect(resolved.runRef).toBe(resolved.jobId);
			expect(resolved.workspaceRelPath).toBe("216/69-08");
			expect(resolved.monthId).toBe("69-08");
			expect(resolved.artifactProblem).toEqual({ code: "artifact_malformed", reason: "run_state_unparseable" });
			// And the jobId it hands back is the one GET /v1/jobs/{jobId} 422s on.
			await expectCoreError(core.getJob(resolved.jobId!), "artifact_malformed");
		});

		test("§1.6 a degraded projection never regresses the version already issued", async () => {
			// 216/69-07 is healthy in this block, so read it until the store holds a
			// non-zero version, then corrupt it and re-read through the degrade.
			fixture.writeRunState("216", "69-07", { status: "idle", stageIndex: 1 });
			const observed = (await core.listJobs({})).jobs.find((job) => job.workspaceRelPath === "216/69-07")!;
			expect(observed.run.version).toBeGreaterThan(0);

			fixture.writeRawRunState("216", "69-07", "state: [this is not: a mapping\n");
			const degraded = (await core.listJobs({})).jobs.find((job) => job.workspaceRelPath === "216/69-07")!;
			expect(degraded.artifactProblem).toBeDefined();
			expect(degraded.run.version).toBeGreaterThanOrEqual(observed.run.version);

			// The same holds through the other two multi-subject doors.
			const resolved = await core.resolveJob({ clientKey: "216", monthKey: "2569-07" });
			expect(resolved.run!.version).toBeGreaterThanOrEqual(observed.run.version);
			const { job } = await core.registerJob({ clientKey: "216", monthId: "69-07" });
			expect(job.run.version).toBeGreaterThanOrEqual(observed.run.version);
		});

		test("a job never observed at all still reports version 0 — §1.7's documented case", async () => {
			const corrupt = (await core.listJobs({})).jobs.find((job) => job.workspaceRelPath === "216/69-08")!;
			expect(corrupt.artifactProblem).toBeDefined();
			expect(corrupt.run.version).toBe(0);
		});

		test("§5.4 register echoes the same degraded job rather than refusing the registration", async () => {
			const { job } = await core.registerJob({ clientKey: "216", monthId: "69-08" });
			expect(job.jobId).toBeTruthy();
			expect(job.artifactProblem).toEqual({ code: "artifact_malformed", reason: "run_state_unparseable" });
			expect(job.run.hasRunRecord).toBe(false);
		});
	});
});

describe("§1.7 the run projection", () => {
	let jobId = "";

	beforeEach(async () => {
		const { job } = await core.registerJob({ clientKey: "216", monthId: "69-08" });
		jobId = job.jobId;
	});

	test("[C-11] a registered job that never ran reports a synthetic idle run, not a 404", async () => {
		const { run } = await core.getJob(jobId);
		expect(run).toMatchObject({
			status: "idle",
			observedStatus: "idle",
			hasRunRecord: false,
			queued: false,
			active: false,
			retryCount: 0,
			retriesRemaining: null,
			counts: null,
			startedAt: null,
			updatedAt: null,
			finishedAt: null,
			version: 0,
		});
		expect(run.stage).toEqual({ id: "profile", index: 0, label: "Stage 0 — profile", count: 7 });
		expect(run.humanStop).toEqual([]);
		expect(run.failReason).toBeNull();
	});

	test("reads status, stage, retry and timings straight out of run-state.yaml", async () => {
		fixture.writeRunState("216", "69-08", {
			status: "blocked",
			stageIndex: 2,
			retryCount: 1,
			log: ["interpret: running completion check", "interpret: completion check exit 1 — BLOCKED (retry 1/2 used)"],
		});
		const { run } = await core.getJob(jobId);
		expect(run).toMatchObject({
			status: "blocked",
			observedStatus: "blocked",
			hasRunRecord: true,
			retryCount: 1,
			retriesRemaining: 1,
			startedAt: "2026-08-07T09:14:02.117Z",
			stageStartedAt: "2026-08-07T09:41:55.902Z",
			updatedAt: "2026-08-07T10:02:44.310Z",
			finishedAt: null,
		});
		expect(run.stage).toEqual({ id: "interpret", index: 2, label: "Stage 2 — interpret", count: 7 });
		expect(run.lastLogLine).toBe("interpret: completion check exit 1 — BLOCKED (retry 1/2 used)");
		expect(run.failReason).toBe("interpret: completion check exit 1 — BLOCKED (retry 1/2 used)");
	});

	test("failReason is null while the run has not failed or stopped", async () => {
		fixture.writeRunState("216", "69-08", { status: "idle", stageIndex: 3, log: ["link: starting"] });
		const idle = await core.getJob(jobId);
		expect(idle.run.lastLogLine).toBe("link: starting");
		expect(idle.run.failReason).toBeNull();

		fixture.writeRunState("216", "69-08", { status: "done", stageIndex: 6, log: ["final: completion check PASS"] });
		expect((await core.getJob(jobId)).run.failReason).toBeNull();
	});

	test("humanStop is enriched, and only when the status is stopped-for-human", async () => {
		const entries = [
			{
				stage: "interpret",
				unit: "เอกสารรายจ่าย/true-6908.pdf#p7",
				condition: "unreadable_required_source",
				reason: "invoice.pdf page 6 is corrupted",
			},
		];
		fixture.writeRunState("216", "69-08", { status: "stopped-for-human", stageIndex: 2, humanStopEntries: entries });
		const stopped = await core.getJob(jobId);
		expect(stopped.run.humanStop.length).toBe(1);
		expect(stopped.run.humanStop[0]).toMatchObject({
			condition: "unreadable_required_source",
			conditionRaw: "unreadable_required_source",
			reason: "invoice.pdf page 6 is corrupted",
		});
		expect(stopped.run.humanStop[0].message).toContain("«เอกสารรายจ่าย/true-6908.pdf#p7»");
		expect(stopped.run.humanStop[0].remedy.length).toBeGreaterThan(0);
		// §1.7's failReason for a stop is the joined conditions — a log-shaped
		// string, deliberately different from the person-facing message.
		expect(stopped.run.failReason).toBe("unreadable_required_source: invoice.pdf page 6 is corrupted");
		expect(stopped.allowedCommands).toEqual(["repair"]);

		// The entries survive on disk after a repair (logic.ts:64 never clears the
		// file); gating on the status is what stops a resolved stop reappearing.
		fixture.writeRunState("216", "69-08", { status: "idle", stageIndex: 1, humanStopEntries: entries });
		expect((await core.getJob(jobId)).run.humanStop).toEqual([]);
	});

	test("counts stay null until the final gate has written them, then carry the group totals", async () => {
		fixture.writeRunState("216", "69-08", { status: "done", stageIndex: 6 });
		expect((await core.getJob(jobId)).run.counts).toBeNull();

		fixture.writeLedgerCounts("216", "69-08", { units: 41, reviewed: 33, excluded: 8 });
		fixture.addGroup("216", "69-08", "expense/vat", "g-004", {
			pages: [{ initial_status: "needs_attention" }, { initial_status: "reviewed" }],
		});
		fixture.addGroup("216", "69-08", "bank_statement", "kbank-1234", { pages: [{ initial_status: "needs_attention" }] });
		expect((await core.getJob(jobId)).run.counts).toEqual({
			totalUnits: 41,
			reviewed: 33,
			excluded: 8,
			groupCount: 2,
			attention: 2,
		});
	});

	test("[C-38] repairImpact is on the single-subject read and absent from the list route", async () => {
		fixture.writeRunState("216", "69-08", { status: "done", stageIndex: 6 });
		fixture.addGroup("216", "69-08", "expense/vat", "g-001");
		fixture.addGroup("216", "69-08", "expense/vat", "g-002", { humanEdited: true });

		const detail = await core.getJob(jobId);
		expect(detail.run.repairImpact).toMatchObject({ destroys: true, editedGroups: 1, groupCount: 2 });
		expect(detail.run.repairImpact?.lastHumanEditAt).not.toBeNull();

		const listed = (await core.listJobs({ clientKey: ["216"] })).jobs.find((job) => job.jobId === jobId)!;
		// §1.3's missing-key rule, not null.
		expect("repairImpact" in listed.run).toBe(false);
	});

	test("destroys is false exactly when no group has been edited", async () => {
		fixture.writeRunState("216", "69-08", { status: "done", stageIndex: 6 });
		fixture.addGroup("216", "69-08", "expense/vat", "g-001");
		const detail = await core.getJob(jobId);
		expect(detail.run.repairImpact).toEqual({
			destroys: false,
			editedGroups: 0,
			groupCount: 1,
			lastHumanEditAt: null,
		});
	});

	test("§1.6 version is monotonic per job: 0 with no record, then +1 only when the projection changes", async () => {
		expect((await core.getJob(jobId)).run.version).toBe(0);

		fixture.writeRunState("216", "69-08", { status: "idle", stageIndex: 1 });
		const first = (await core.getJob(jobId)).run.version;
		expect(first).toBe(1);
		// A read that observed nothing new must not inflate the counter.
		expect((await core.getJob(jobId)).run.version).toBe(1);

		fixture.writeRunState("216", "69-08", { status: "blocked", stageIndex: 2, retryCount: 1 });
		expect((await core.getJob(jobId)).run.version).toBe(2);
	});

	test("a well-formed but unknown jobId is 404; a malformed one is 400", async () => {
		await expectCoreError(core.getJob("job_0000000000000000000000"), "job_not_found");
		await expectCoreError(core.getJob("not-a-job-id"), "validation_failed");
	});

	test("§5.5 allowedCommands is on every read, and queuePosition needs include=queue", async () => {
		fixture.writeRunState("216", "69-08", { status: "blocked", stageIndex: 2 });
		const detail = await core.getJob(jobId);
		expect(detail.allowedCommands).toEqual(["retry", "repair"]);
		expect(detail.queuePosition).toBeNull();

		fixture.writeRunState("216", "69-08", { status: "idle", stageIndex: 1 });
		const scheduled = createKeyingCore({
			workspaceRoot: fixture.root,
			buddhistCenturyBase: 2500,
			jobs: createInMemoryJobRepository(),
			projections: createInMemoryRunProjectionStore(),
			scheduler: staticSchedulerView({ queue: ["ศรีชัย/69-08", "216/69-08"] }),
			logger: silentLogger,
			now: () => "2026-08-07T12:00:00.000Z",
			streamId: "ksk-core-TEST0003",
			startedAt: "2026-08-07T08:00:01.004Z",
		});
		await scheduled.boot();
		const { job } = await scheduled.registerJob({ clientKey: "216", monthId: "69-08" });
		const queued = await scheduled.getJob(job.jobId, { includeQueue: true });
		expect(queued.queuePosition).toBe(2);
		expect(queued.run.queued).toBe(true);
		expect(queued.run.observedStatus).toBe("queued");
		// §3.4's literal `queued` row: start (as a no-op) and stop.
		expect(queued.allowedCommands).toEqual(["start", "stop"]);
	});

	test("a blocked run that an earlier retry re-queued is governed by the `blocked` row", async () => {
		// §3.4's `queued` row and its `blocked` row both describe this state. It is
		// read as the `blocked` row, because §3.3 keys retry-legality on status
		// alone ("retry on anything but blocked/env-error"), §5.7's own table
		// answers this exact case with "202, alreadyQueued: true, nothing
		// enqueued", and the runtime agrees (orchestrator.ts:245-248 checks
		// isRetryable on the status, then de-duplicates at :186).
		fixture.writeRunState("216", "69-08", { status: "blocked", stageIndex: 2, retryCount: 1 });
		const scheduled = createKeyingCore({
			workspaceRoot: fixture.root,
			buddhistCenturyBase: 2500,
			jobs: createInMemoryJobRepository(),
			projections: createInMemoryRunProjectionStore(),
			scheduler: staticSchedulerView({ queue: ["216/69-08"] }),
			logger: silentLogger,
			now: () => "2026-08-07T12:00:00.000Z",
			streamId: "ksk-core-TEST0004",
			startedAt: "2026-08-07T08:00:01.004Z",
		});
		await scheduled.boot();
		const { job } = await scheduled.registerJob({ clientKey: "216", monthId: "69-08" });
		expect((await scheduled.getJob(job.jobId)).allowedCommands).toEqual(["start", "retry", "stop"]);
	});

	test("a corrupted run-state.yaml is 422 artifact_malformed, not a silent 'never ran'", async () => {
		fixture.writeRawRunState("216", "69-08", "state: [this is not: a mapping\n");
		const error = await expectCoreError(core.getJob(jobId), "artifact_malformed");
		expect(error.status).toBe(422);
	});

	test("a run-state.yaml carrying a status the contract does not have is 422, never passed through", async () => {
		fixture.writeRawRunState("216", "69-08", "state:\n  stageIndex: 2\n  status: teleported\n  retryCount: 0\n");
		await expectCoreError(core.getJob(jobId), "artifact_malformed");
	});

	test("a truncated run-state.yaml that still lexes as a scalar is 422, not a silent 'never ran'", async () => {
		fixture.writeRawRunState("216", "69-08", "schema: ksk_run_stat");
		await expectCoreError(core.getJob(jobId), "artifact_malformed");
		fixture.writeRawRunState("216", "69-08", "just some garbage text\n");
		await expectCoreError(core.getJob(jobId), "artifact_malformed");
	});

	test("an EMPTY run-state.yaml is the one content that honestly means 'never ran'", async () => {
		fixture.writeRawRunState("216", "69-08", "");
		expect((await core.getJob(jobId)).run.hasRunRecord).toBe(false);
	});
});
