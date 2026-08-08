// Plan §7.2's repository as a PORT, plus the in-memory adapter this slice runs
// on. Plan §14.1 names `core/jobs/repositories.ts` as "ports, not SQLite
// implementation" for exactly this reason.
//
// SQLite persistence is a later slice. What this file owes that slice is the
// seam and the one invariant the schema will enforce: plan §8.2's unique
// `workspace_rel_path`. The in-memory adapter enforces it here so §5.4's and
// §5.13's idempotency-by-uniqueness is real behaviour now and not a promise —
// and so the SQLite adapter has a behavioural contract to satisfy rather than
// a blank page.
import type { Job } from "./job";

export type JobPatch = {
	title?: string | null;
	externalRef?: Record<string, unknown> | null;
	requestedBy?: string | null;
	archived?: boolean;
	updatedAt: string;
};

export type JobRepository = {
	findById(jobId: string): Job | null;
	findByWorkspaceRelPath(workspaceRelPath: string): Job | null;
	/** Every job, in `(clientKey, monthId)` order — [C-16]'s sort, applied once
	 * at the source so no caller re-sorts. */
	list(): Job[];
	/** Throws if `workspaceRelPath` is already taken: that collision is the
	 * uniqueness constraint, and a caller that hits it has a bug, because
	 * `findByWorkspaceRelPath` is how registration checks first. */
	insert(job: Job): Job;
	update(jobId: string, patch: JobPatch): Job;
};

export function createInMemoryJobRepository(seed: Job[] = [], compare = (a: string, b: string) => a.localeCompare(b, "th")): JobRepository {
	const byId = new Map<string, Job>();
	const byPath = new Map<string, string>();

	function put(job: Job): void {
		byId.set(job.jobId, job);
		byPath.set(job.workspaceRelPath, job.jobId);
	}

	for (const job of seed) put(job);

	return {
		findById: (jobId) => byId.get(jobId) ?? null,
		findByWorkspaceRelPath(workspaceRelPath) {
			const jobId = byPath.get(workspaceRelPath);
			return jobId === undefined ? null : (byId.get(jobId) ?? null);
		},
		list() {
			return [...byId.values()].sort((a, b) => compare(a.clientKey, b.clientKey) || compare(a.monthId, b.monthId));
		},
		insert(job) {
			if (byPath.has(job.workspaceRelPath)) {
				throw new Error(`workspace_rel_path already registered: ${job.workspaceRelPath}`);
			}
			put(job);
			return job;
		},
		update(jobId, patch) {
			const existing = byId.get(jobId);
			if (!existing) throw new Error(`no such job: ${jobId}`);
			const next: Job = {
				...existing,
				...(patch.title === undefined ? {} : { title: patch.title }),
				...(patch.externalRef === undefined ? {} : { externalRef: patch.externalRef }),
				...(patch.requestedBy === undefined ? {} : { requestedBy: patch.requestedBy }),
				...(patch.archived === undefined ? {} : { archived: patch.archived }),
				updatedAt: patch.updatedAt,
			};
			put(next);
			return next;
		},
	};
}
