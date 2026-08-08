// Axis B of §3.1, as a port.
//
// Plan §8.1: "Queue membership and active slots | In-process orchestrator |
// Exposed run summary". The orchestrator is the authority and this is the
// read-only window onto it that the query side needs — `orchestrator.ts:95-103`
// derives exactly these two booleans, and §5.10's `queue.order` is "the real
// queue, not a projection".
//
// THE SEAM: wiring this to `Orchestrator` belongs with the command routes
// (`start`/`retry`/`repair`/`stop`), which are a later slice. Until those land,
// this Core process runs no work of its own, so the honest implementation is
// `unscheduledSchedulerView` — nothing queued, nothing active, no latch. Every
// consumer already reads through the port, so that later slice replaces one
// object in the composition root and changes nothing else.

export type SchedulerView = {
	/** `KSK_APP_CONCURRENCY` (`console/app/config.ts:16-17`). §4.1: it bounds the
	 * number of relPaths whose drive loop is executing at one instant — not
	 * registered jobs, queued jobs, HTTP requests, review reads, or review
	 * writes. */
	concurrency: number;
	/** The FIFO array, head first, as `workspaceRelPath` values. A snapshot: two
	 * reads a second apart may differ. */
	queueOrder(): string[];
	activeCount(): number;
	isQueued(workspaceRelPath: string): boolean;
	isActive(workspaceRelPath: string): boolean;
	/** Process-local, cleared by a restart (`orchestrator.ts:196-198`). */
	fatalCleanupLatched(): boolean;
};

export function unscheduledSchedulerView(concurrency: number): SchedulerView {
	return {
		concurrency,
		queueOrder: () => [],
		activeCount: () => 0,
		isQueued: () => false,
		isActive: () => false,
		fatalCleanupLatched: () => false,
	};
}

/** A fake for tests, and the shape the orchestrator-backed adapter will take. */
export function staticSchedulerView(options: {
	concurrency?: number;
	queue?: string[];
	active?: string[];
	fatalCleanupLatched?: boolean;
}): SchedulerView {
	const queue = options.queue ?? [];
	const active = options.active ?? [];
	return {
		concurrency: options.concurrency ?? 1,
		queueOrder: () => [...queue],
		activeCount: () => active.length,
		isQueued: (relPath) => queue.includes(relPath),
		isActive: (relPath) => active.includes(relPath),
		fatalCleanupLatched: () => options.fatalCleanupLatched ?? false,
	};
}
