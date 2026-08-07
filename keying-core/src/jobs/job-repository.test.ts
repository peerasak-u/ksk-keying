import { describe, expect, test } from "bun:test";
import { defaultTitle, isJobId, mintJobId, type Job } from "./job";
import { createInMemoryJobRepository } from "./job-repository";

function job(overrides: Partial<Job> = {}): Job {
	const clientKey = overrides.clientKey ?? "216";
	const monthId = overrides.monthId ?? "69-08";
	return {
		jobId: mintJobId(),
		workspaceRelPath: `${clientKey}/${monthId}`,
		clientKey,
		monthId,
		title: defaultTitle(clientKey, monthId),
		archived: false,
		externalRef: null,
		requestedBy: null,
		createdAt: "2026-08-01T02:11:40.000Z",
		updatedAt: "2026-08-01T02:11:40.000Z",
		...overrides,
	};
}

describe("§1.4 the job id", () => {
	test("is `job_` plus 22 chars of [0-9A-Za-z]", () => {
		for (let n = 0; n < 200; n += 1) {
			const id = mintJobId();
			expect(id).toMatch(/^job_[0-9A-Za-z]{22}$/);
			expect(isJobId(id)).toBe(true);
		}
	});

	test("is opaque and never repeats within a run of the minter", () => {
		const seen = new Set(Array.from({ length: 500 }, () => mintJobId()));
		expect(seen.size).toBe(500);
	});

	test("rejects anything that is not one", () => {
		for (const value of ["", "job_", "job_short", "216/69-08", `job_${"x".repeat(23)}`, `JOB_${"x".repeat(22)}`]) {
			expect(isJobId(value)).toBe(false);
		}
	});
});

describe("the job repository port (plan §8.2's constraints)", () => {
	test("enforces unique workspace_rel_path — the constraint §5.4's idempotency rests on", () => {
		const repo = createInMemoryJobRepository();
		repo.insert(job({ clientKey: "216", monthId: "69-08" }));
		expect(() => repo.insert(job({ clientKey: "216", monthId: "69-08" }))).toThrow(/already registered/);
		// A different month of the same client is a different job.
		expect(() => repo.insert(job({ clientKey: "216", monthId: "69-07" }))).not.toThrow();
	});

	test("finds by id and by workspace path, and returns null rather than undefined for a miss", () => {
		const repo = createInMemoryJobRepository();
		const inserted = repo.insert(job());
		expect(repo.findById(inserted.jobId)).toEqual(inserted);
		expect(repo.findByWorkspaceRelPath("216/69-08")).toEqual(inserted);
		expect(repo.findById("job_0000000000000000000000")).toBeNull();
		expect(repo.findByWorkspaceRelPath("nope/69-08")).toBeNull();
	});

	test("lists in (clientKey, monthId) order with Thai collation", () => {
		const repo = createInMemoryJobRepository();
		repo.insert(job({ clientKey: "ศรีชัย", monthId: "69-08" }));
		repo.insert(job({ clientKey: "216", monthId: "69-08" }));
		repo.insert(job({ clientKey: "216", monthId: "69-07" }));
		expect(repo.list().map((row) => row.workspaceRelPath)).toEqual(["216/69-07", "216/69-08", "ศรีชัย/69-08"]);
	});

	test("update patches only what was supplied and always stamps updatedAt", () => {
		const repo = createInMemoryJobRepository();
		const inserted = repo.insert(job({ title: "before" }));
		const updated = repo.update(inserted.jobId, { title: "after", updatedAt: "2026-08-07T12:00:00.000Z" });
		expect(updated.title).toBe("after");
		expect(updated.externalRef).toBeNull();
		expect(updated.updatedAt).toBe("2026-08-07T12:00:00.000Z");
		expect(repo.findByWorkspaceRelPath("216/69-08")?.title).toBe("after");
	});

	test("update of an unknown job is a programming error, not a silent no-op", () => {
		const repo = createInMemoryJobRepository();
		expect(() => repo.update("job_0000000000000000000000", { updatedAt: "now" })).toThrow(/no such job/);
	});

	test("a seeded repository is queryable immediately — the shape a SQLite adapter must reproduce", () => {
		const seeded = createInMemoryJobRepository([job({ clientKey: "216", monthId: "69-08" })]);
		expect(seeded.list().length).toBe(1);
	});
});
