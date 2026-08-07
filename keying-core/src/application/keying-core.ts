// Plan §7.1's application interface: "All adapters call the same use cases. No
// adapter may import SQLite repositories, orchestrator internals, or filesystem
// writers directly."
//
// This slice implements the query side plus the two registration commands. The
// four run commands (start/retry/repair/stop), SSE, the review/exclusion
// routes, the export/document routes and the CLI are later slices; where one of
// them needs a seam it is a port on `KeyingCoreDeps` and not a stub here.
import { statSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../errors/core-error";
import { assertClientKey, resolveClientMonth } from "../identity/paths";
import {
	assertMonthId,
	assertMonthKey,
	buddhistCenturyWindow,
	monthKeyToMonthId,
	type BuddhistCenturyWindow,
} from "../identity/month";
import { defaultTitle, isJobId, mintJobId, type Job } from "../jobs/job";
import type { JobRepository } from "../jobs/job-repository";
import type { Logger } from "../observability/logger";
import {
	buildRunProjection,
	projectionFingerprint,
	type ExternalRef,
	type RunCounts,
	type RunProjection,
} from "../workflow/run-contract";
import { allowedCommands, type RunCommand, type RunStatus } from "../workflow/state-machine";
import { readRunRecord, type RunRecord } from "../workspace/run-record";
import {
	compareThai,
	measureRepairImpact,
	readCompanyName,
	readGroupTotals,
	readLedgerCounts,
	scanWorkspace,
	type MonthFolderWarning,
} from "../workspace/workspace-repository";
import type { RunProjectionStore } from "./projection-store";
import type { SchedulerView } from "./scheduler-view";

export type KeyingCoreDeps = {
	workspaceRoot: string;
	buddhistCenturyBase: number;
	jobs: JobRepository;
	projections: RunProjectionStore;
	scheduler: SchedulerView;
	logger: Logger;
	/** Injected so a test can pin timestamps. */
	now: () => string;
	/** The process-instance id that stamps every SSE envelope (plan §10.1). A
	 * client that sees it change knows the process restarted. */
	streamId: string;
	startedAt: string;
};

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export type LiveBody = { status: "live"; service: "keying-core"; streamId: string; startedAt: string };

export type ReadyChecks = {
	store: { ok: boolean; kind: string; reason?: string };
	workspace: { ok: boolean; root: string; clients: number; months: number; reason?: string };
	orchestrator: { ok: boolean; reconciledAt: string | null; pendingRequests: number; reason?: string };
	buddhistCentury: BuddhistCenturyWindow;
};

export type ReadyBody = {
	status: "ready";
	streamId: string;
	checks: ReadyChecks;
	queue: { depth: number; active: number; concurrency: number };
	warnings: MonthFolderWarning[];
};

export type JobSummary = {
	jobId: string;
	workspaceRelPath: string;
	clientKey: string;
	monthId: string;
	title: string | null;
	companyName: string | null;
	archived: boolean;
	externalRef: ExternalRef | null;
	createdAt: string;
	updatedAt: string;
	run: RunProjection;
};

export type JobDetail = Omit<JobSummary, "companyName"> & {
	queuePosition: number | null;
	allowedCommands: RunCommand[];
};

export type ListJobsQuery = {
	clientKey?: string[];
	status?: string[];
	archived?: "true" | "false" | "any";
	hasRunRecord?: boolean;
	limit?: number;
	cursor?: string;
};

export type ListJobsResult = { jobs: JobSummary[]; nextCursor: string | null; total: number };

export type RegisterJobInput = {
	clientKey: unknown;
	monthId: unknown;
	title?: unknown;
	externalRef?: unknown;
	requestedBy?: unknown;
};

export type ResolveJobInput = {
	clientKey: unknown;
	monthKey: unknown;
	externalRef?: unknown;
	register?: unknown;
	requestedBy?: unknown;
};

export type ResolveJobResult = {
	jobId: string | null;
	runRef: string | null;
	workspaceRelPath: string;
	clientKey: string;
	monthId: string;
	monthKey: string;
	created: boolean;
	run: RunProjection | null;
};

export type KeyingCore = {
	live(): LiveBody;
	boot(): Promise<void>;
	ready(): Promise<ReadyBody>;
	/** The cheap half of readiness, for the guard every non-liveness route runs
	 * (§2.3: `not_ready` is raised by "every route except §5.1"). `ready()`
	 * re-walks the workspace and is for an operator; this is for a request. */
	isReady(): boolean;
	listJobs(query: ListJobsQuery): Promise<ListJobsResult>;
	getJob(jobId: string, options?: { includeQueue?: boolean }): Promise<JobDetail>;
	registerJob(input: RegisterJobInput): Promise<{ job: JobSummary; created: boolean }>;
	resolveJob(input: ResolveJobInput): Promise<ResolveJobResult>;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Plan §7.2: `externalRef` is "the platform's hook … so Core can echo it back
 * on every event without understanding it". Validated as a JSON object and
 * nothing more — Core never interprets a field of it. */
function readExternalRef(value: unknown, path = "externalRef"): ExternalRef | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new CoreError("validation_failed", { details: { fields: [{ path, problem: "type", expected: "object" }] } });
	}
	return value as ExternalRef;
}

function readOptionalString(value: unknown, path: string): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") {
		throw new CoreError("validation_failed", { details: { fields: [{ path, problem: "type", expected: "string" }] } });
	}
	return value;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function encodeCursor(job: Job): string {
	return Buffer.from(JSON.stringify([job.clientKey, job.monthId]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
			throw new Error("shape");
		}
		return [parsed[0], parsed[1]];
	} catch {
		throw new CoreError("validation_failed", { details: { fields: [{ path: "cursor", problem: "opaque_value" }] } });
	}
}

export function createKeyingCore(deps: KeyingCoreDeps): KeyingCore {
	let reconciledAt: string | null = null;
	let bootError: string | null = null;

	function monthDir(workspaceRelPath: string): string {
		return join(deps.workspaceRoot, ...workspaceRelPath.split("/"));
	}

	/** §1.7's `counts`: the ledger's three plus the group/attention totals, and
	 * `null` until the `final` gate has written them. */
	async function readCounts(dir: string): Promise<RunCounts | null> {
		const ledger = await readLedgerCounts(dir);
		if (!ledger) return null;
		const totals = await readGroupTotals(dir);
		return { ...ledger, groupCount: totals.groupCount, attention: totals.attention };
	}

	async function projectRun(job: Job, options: { withRepairImpact?: boolean } = {}): Promise<RunProjection> {
		const dir = monthDir(job.workspaceRelPath);
		let record: RunRecord | null;
		try {
			record = await readRunRecord(dir);
		} catch (thrown) {
			if (thrown instanceof CoreError) {
				deps.logger.warn("run.projection.artifact_malformed", {
					jobId: job.jobId,
					workspaceRelPath: job.workspaceRelPath,
				});
			}
			throw thrown;
		}

		const counts = record ? await readCounts(dir) : null;
		const repairImpact = options.withRepairImpact ? await measureRepairImpact(dir) : undefined;

		const base = buildRunProjection({
			jobId: job.jobId,
			workspaceRelPath: job.workspaceRelPath,
			clientKey: job.clientKey,
			monthId: job.monthId,
			record,
			queued: deps.scheduler.isQueued(job.workspaceRelPath),
			active: deps.scheduler.isActive(job.workspaceRelPath),
			counts,
			repairImpact,
			externalRef: job.externalRef,
			requestedBy: job.requestedBy,
			// Filled below: the version depends on the projection's own content.
			version: 0,
			enrich: { logger: deps.logger },
		});

		if (!base.hasRunRecord) return base;
		return { ...base, version: deps.projections.versionFor(job.jobId, projectionFingerprint(base)) };
	}

	async function toSummary(job: Job): Promise<JobSummary> {
		const run = await projectRun(job);
		const companyName = await readCompanyName(join(deps.workspaceRoot, job.clientKey));
		return {
			jobId: job.jobId,
			workspaceRelPath: job.workspaceRelPath,
			clientKey: job.clientKey,
			monthId: job.monthId,
			title: job.title,
			companyName,
			archived: job.archived,
			externalRef: job.externalRef,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			run,
		};
	}

	function matchesStatusFilter(run: RunProjection, wanted: string[]): boolean {
		return wanted.some((value) => {
			if (value === "queued") return run.queued;
			if (value === "active") return run.active;
			return run.status === (value as RunStatus);
		});
	}

	return {
		live() {
			return { status: "live", service: "keying-core", streamId: deps.streamId, startedAt: deps.startedAt };
		},

		/** Plan §8.4's boot sequence, as far as this slice reaches: validate the
		 * mount, walk the workspace (which is also step 3's reconcile, since a
		 * registered job's identity IS its workspace path), and stamp the
		 * reconcile time. Steps 2 and 4 — booting the orchestrator and reapplying
		 * pending receipts — belong to the command slice; readiness reports what
		 * it actually knows rather than claiming them. */
		async boot() {
			bootError = null;
			try {
				const scan = scanWorkspace(deps.workspaceRoot, deps.logger);
				const window = buddhistCenturyWindow(deps.buddhistCenturyBase);
				// Plan §9.2 [r3]: log the resolved window at boot so the operator
				// can see which century the process believes it is in.
				deps.logger.info("core.boot", {
					streamId: deps.streamId,
					clients: scan.clients,
					months: scan.months,
					ignoredMonthFolders: scan.warnings.length,
					buddhistCenturyWindow: window.window,
					buddhistCenturyExpiresOn: window.expiresOn,
				});
				for (const job of deps.jobs.list()) {
					if (!scan.clientMonths.some((cm) => cm.workspaceRelPath === job.workspaceRelPath)) {
						deps.logger.warn("core.boot.job_path_missing", {
							jobId: job.jobId,
							workspaceRelPath: job.workspaceRelPath,
						});
					}
				}
				reconciledAt = deps.now();
			} catch (thrown) {
				reconciledAt = null;
				bootError = thrown instanceof Error ? "workspace_scan_failed" : "unknown";
				throw thrown;
			}
		},

		isReady() {
			return reconciledAt !== null;
		},

		async ready() {
			const window = buddhistCenturyWindow(deps.buddhistCenturyBase);
			// A live walk per probe, not a cached one: plan §9.2 step 3 says the
			// warnings are produced "at every discovery pass", and an operator
			// reading /ready after renaming a folder must see the new answer.
			// The mount is checked separately from the walk, because an unmounted
			// root and an empty one are the same empty scan and very different
			// operational facts (§5.2's own 503 example says
			// `workspace_root_missing`).
			const workspaceOk = isDirectory(deps.workspaceRoot);
			const scan = workspaceOk ? scanWorkspace(deps.workspaceRoot) : { clientMonths: [], warnings: [], clients: 0, months: 0 };

			const checks: ReadyChecks = {
				// THE SEAM: SQLite is a later slice, so the store check reports what
				// is actually running rather than a `journalMode` this process does
				// not have. §1.3's rule — a missing key means "this route does not
				// carry that fact" — is why `schemaVersion`/`journalMode` are absent
				// rather than faked.
				store: { ok: true, kind: "memory" },
				workspace: {
					ok: workspaceOk,
					// §5.2's own example puts the configured mount root here. It is
					// the operator's own path, not an arbitrary one — plan §9.2's
					// rule is about paths derived from caller input.
					root: deps.workspaceRoot,
					clients: scan.clients,
					months: scan.months,
					...(workspaceOk ? {} : { reason: "workspace_root_missing" }),
				},
				orchestrator: {
					ok: reconciledAt !== null,
					reconciledAt,
					pendingRequests: 0,
					...(reconciledAt === null ? { reason: bootError ?? "reconcile_in_progress" } : {}),
				},
				buddhistCentury: window,
			};

			if (!checks.workspace.ok || !checks.orchestrator.ok) {
				// [C-15]: the 503 carries the same `checks` object as the 200,
				// inside `details`.
				throw new CoreError("not_ready", { details: { checks: checks as unknown as Record<string, unknown> } });
			}

			return {
				status: "ready",
				streamId: deps.streamId,
				checks,
				queue: {
					depth: deps.scheduler.queueOrder().length,
					active: deps.scheduler.activeCount(),
					concurrency: deps.scheduler.concurrency,
				},
				// §5.2: `warnings[]` is `[]`, never absent, when there is nothing to
				// report — and a non-empty list does NOT make the service un-ready.
				warnings: scan.warnings,
			};
		},

		async listJobs(query) {
			const limit = query.limit ?? DEFAULT_LIMIT;
			if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
				throw new CoreError("validation_failed", {
					details: { fields: [{ path: "limit", problem: "range", expected: `1..${MAX_LIMIT}` }] },
				});
			}
			const archived = query.archived ?? "false";

			let candidates = deps.jobs.list();
			if (query.clientKey?.length) {
				const wanted = new Set(query.clientKey);
				candidates = candidates.filter((job) => wanted.has(job.clientKey));
			}
			if (archived !== "any") {
				const want = archived === "true";
				candidates = candidates.filter((job) => job.archived === want);
			}

			// The run-shaped filters need the projection, so they are applied after
			// the cheap metadata ones.
			const matched: JobSummary[] = [];
			for (const job of candidates) {
				const summary = await toSummary(job);
				if (query.hasRunRecord !== undefined && summary.run.hasRunRecord !== query.hasRunRecord) continue;
				if (query.status?.length && !matchesStatusFilter(summary.run, query.status)) continue;
				matched.push(summary);
			}

			// `total` counts every match, so a paged caller learns the size of the
			// set it is walking rather than the size of what is left.
			const total = matched.length;

			// [C-16]: the cursor is the last row's `(clientKey, monthId)`, and the
			// sort is that pair ascending with Thai collation — already the order
			// the repository returns.
			let remaining = matched;
			if (query.cursor) {
				const [clientKey, monthId] = decodeCursor(query.cursor);
				remaining = remaining.filter(
					(job) =>
						compareThai(job.clientKey, clientKey) > 0 ||
						(job.clientKey === clientKey && compareThai(job.monthId, monthId) > 0),
				);
			}

			const page = remaining.slice(0, limit);
			const last = page[page.length - 1];
			const nextCursor = remaining.length > limit && last ? encodeCursor(deps.jobs.findById(last.jobId)!) : null;
			return { jobs: page, nextCursor, total };
		},

		async getJob(jobId, options = {}) {
			// §5.5: "a value that is not a well-formed job id is
			// `400 validation_failed`, not `404`".
			if (!isJobId(jobId)) {
				throw new CoreError("validation_failed", { details: { fields: [{ path: "jobId", problem: "pattern" }] } });
			}
			const job = deps.jobs.findById(jobId);
			if (!job) throw new CoreError("job_not_found");

			// [C-38]: `repairImpact` is present on the single-subject reads.
			const run = await projectRun(job, { withRepairImpact: true });
			const queueIndex = deps.scheduler.queueOrder().indexOf(job.workspaceRelPath);

			return {
				jobId: job.jobId,
				workspaceRelPath: job.workspaceRelPath,
				clientKey: job.clientKey,
				monthId: job.monthId,
				title: job.title,
				archived: job.archived,
				externalRef: job.externalRef,
				createdAt: job.createdAt,
				updatedAt: job.updatedAt,
				run,
				queuePosition: options.includeQueue && queueIndex >= 0 ? queueIndex + 1 : null,
				// §5.5: the §3.4 row on every read, "so a client never has to guess
				// and never has to POST to find out".
				allowedCommands: allowedCommands(
					{
						status: run.status,
						queued: run.queued,
						active: run.active,
						hasRunRecord: run.hasRunRecord,
						stageIndex: run.stage.index,
						retryCount: run.retryCount,
					},
					{ fatalCleanupLatched: deps.scheduler.fatalCleanupLatched() },
				),
			};
		},

		/** §5.4 — the OPERATOR's door. It takes keying identity (`monthId`); the
		 * office platform uses §5.13 instead, because the platform speaks
		 * `monthKey` and must never construct a keying identity itself
		 * ([C-17], plan §9.2). */
		async registerJob(input) {
			const clientKey = assertClientKey(input.clientKey);
			const monthId = assertMonthId(input.monthId);
			const title = readOptionalString(input.title, "title");
			const externalRef = readExternalRef(input.externalRef);
			const requestedBy = readOptionalString(input.requestedBy, "requestedBy");

			// Core trusts no caller-supplied path: the identity is re-resolved
			// under the root, and an unknown client/month is a 404 here rather
			// than a row pointing at nothing.
			const location = resolveClientMonth(deps.workspaceRoot, clientKey, monthId);

			const existing = deps.jobs.findByWorkspaceRelPath(location.workspaceRelPath);
			if (existing) {
				// §5.4: registering a job that already exists is NOT an error — it
				// returns the existing job and updates title/externalRef if they
				// were supplied and differ. Idempotent by the unique
				// workspace_rel_path constraint (plan §8.2), which is why
				// Idempotency-Key is optional on this route ([C-05]).
				const titleChanged = title !== undefined && title !== existing.title;
				const refChanged = externalRef !== undefined && JSON.stringify(externalRef) !== JSON.stringify(existing.externalRef);
				const updated =
					titleChanged || refChanged
						? deps.jobs.update(existing.jobId, {
								...(titleChanged ? { title } : {}),
								...(refChanged ? { externalRef } : {}),
								updatedAt: deps.now(),
							})
						: existing;
				return { job: await toSummary(updated), created: false };
			}

			const now = deps.now();
			const job = deps.jobs.insert({
				jobId: mintJobId(),
				workspaceRelPath: location.workspaceRelPath,
				clientKey: location.clientKey,
				monthId: location.monthId,
				title: title ?? defaultTitle(location.clientKey, location.monthId),
				archived: false,
				externalRef: externalRef ?? null,
				requestedBy: requestedBy ?? null,
				createdAt: now,
				updatedAt: now,
			});
			deps.logger.info("job.created", {
				jobId: job.jobId,
				workspaceRelPath: job.workspaceRelPath,
				requestedBy: job.requestedBy,
			});
			// Registration starts nothing — the job's run is hasRunRecord: false.
			return { job: await toSummary(job), created: true };
		},

		/** §5.13 — the office platform's ONLY way to turn office identity into
		 * keying identity (plan §9.2). */
		async resolveJob(input) {
			const clientKey = assertClientKey(input.clientKey);
			const monthKey = assertMonthKey(input.monthKey);
			const externalRef = readExternalRef(input.externalRef);
			const requestedBy = readOptionalString(input.requestedBy, "requestedBy");
			if (input.register !== undefined && typeof input.register !== "boolean") {
				throw new CoreError("validation_failed", {
					details: { fields: [{ path: "register", problem: "type", expected: "boolean" }] },
				});
			}
			// [C-20]: `register` defaults to true, preserving the plan's
			// register-if-absent behaviour; `false` gives the read path a way to ask
			// without writing.
			const register = (input.register as boolean | undefined) ?? true;

			// Step 2 of §5.13's mapping. Core owns this function and the platform
			// never performs it.
			const monthId = monthKeyToMonthId(monthKey);
			const location = resolveClientMonth(deps.workspaceRoot, clientKey, monthId);

			const existing = deps.jobs.findByWorkspaceRelPath(location.workspaceRelPath);
			if (existing) {
				const refChanged = externalRef !== undefined && JSON.stringify(externalRef) !== JSON.stringify(existing.externalRef);
				const job = refChanged
					? deps.jobs.update(existing.jobId, { externalRef, updatedAt: deps.now() })
					: existing;
				return {
					jobId: job.jobId,
					runRef: job.jobId,
					workspaceRelPath: job.workspaceRelPath,
					clientKey: job.clientKey,
					monthId: job.monthId,
					monthKey,
					created: false,
					run: await projectRun(job),
				};
			}

			if (!register) {
				// §5.13 step 5: a pure lookup that never creates a job row.
				return {
					jobId: null,
					runRef: null,
					workspaceRelPath: location.workspaceRelPath,
					clientKey: location.clientKey,
					monthId: location.monthId,
					monthKey,
					created: false,
					run: null,
				};
			}

			const now = deps.now();
			const job = deps.jobs.insert({
				jobId: mintJobId(),
				workspaceRelPath: location.workspaceRelPath,
				clientKey: location.clientKey,
				monthId: location.monthId,
				title: defaultTitle(location.clientKey, location.monthId),
				archived: false,
				externalRef: externalRef ?? null,
				requestedBy: requestedBy ?? null,
				createdAt: now,
				updatedAt: now,
			});
			deps.logger.info("job.created", {
				jobId: job.jobId,
				workspaceRelPath: job.workspaceRelPath,
				requestedBy: job.requestedBy,
			});
			return {
				jobId: job.jobId,
				runRef: job.jobId,
				workspaceRelPath: job.workspaceRelPath,
				clientKey: job.clientKey,
				monthId: job.monthId,
				monthKey,
				created: true,
				run: await projectRun(job),
			};
		},
	};
}
