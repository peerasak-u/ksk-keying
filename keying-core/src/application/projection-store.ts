// Plan §8.2's `run_projections`, as a port: "exactly one row per job, updated
// in place; monotonically increasing `version`".
//
// §1.6: `version` is ORDERING ONLY. "The platform compares it before writing a
// run reference so a late SSE event cannot regress it." It is never a request
// precondition — §3.4's command-legality matrix is that.
//
// THE SEAM: the SQLite adapter is a later slice. What this in-memory adapter
// pins now is the semantics that adapter has to reproduce: version 0 while
// there is no run record, 1 at the first observed projection, and +1 on every
// change to the projection's content — never on a read that observed nothing
// new, or a dashboard poll would inflate the counter past every event.

export type RunProjectionStore = {
	/** The version to report for this job's current projection. */
	versionFor(jobId: string, fingerprint: string): number;
	/** The last version issued, without observing anything. */
	peek(jobId: string): number;
};

export function createInMemoryRunProjectionStore(): RunProjectionStore {
	const rows = new Map<string, { fingerprint: string; version: number }>();

	return {
		versionFor(jobId, fingerprint) {
			const existing = rows.get(jobId);
			if (!existing) {
				rows.set(jobId, { fingerprint, version: 1 });
				return 1;
			}
			if (existing.fingerprint === fingerprint) return existing.version;
			const next = { fingerprint, version: existing.version + 1 };
			rows.set(jobId, next);
			return next.version;
		},
		peek: (jobId) => rows.get(jobId)?.version ?? 0,
	};
}
