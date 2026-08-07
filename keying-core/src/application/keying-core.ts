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
	/** §5.2 names this key `sqlite` in both the 200 body and the 503's
	 * `details.checks`, so the key is the spec's. `schemaVersion`/`journalMode`
	 * are absent, not nulled, per §1.3's rule that a missing key means "this
	 * route does not carry that fact". */
	sqlite: { ok: boolean; schemaVersion?: number; journalMode?: string; reason?: string };
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

/** The additive marker a §5.3/§5.4/§5.13 response carries when this job's own
 * artifacts could not be read. Absent — §1.3's missing-key rule — whenever they
 * could. See README finding 7; the choice number for it is to be assigned when
 * the spec is next revised, since the spec owns the `[C-nn]` sequence. */
export type JobArtifactProblem = { code: "artifact_malformed"; reason: string };

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
	artifactProblem?: JobArtifactProblem;
};

export type JobDetail = Omit<JobSummary, "companyName" | "artifactProblem"> & {
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
	artifactProblem?: JobArtifactProblem;
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

	/** The projection every MULTI-PURPOSE response embeds — the §5.3 rows, and
	 * the job §5.4 and §5.13 echo back. A job whose own artifacts are unreadable
	 * degrades here, in the one shared helper, rather than failing the whole
	 * response, for two reasons the spec gives itself:
	 *
	 * 1. None of these routes' status lists contains `422`: §5.3's is `200` and
	 *    `400 validation_failed`, §5.4's is `201`/`200`/`400`/`404`, §5.13's is
	 *    `200`/`201`/`400`/`404`/`409 idempotency_key_*` — and §2's error table
	 *    scopes `artifact_malformed` to §5.15/§5.16/§5.18/§5.21 only.
	 * 2. §3.6's rationale rejects exactly this shape: "Returning
	 *    `422 artifact_malformed` hides a run that has genuinely stopped behind
	 *    an error on the read route - the run becomes invisible exactly when a
	 *    person is needed". On the list that is one corrupt file hiding every
	 *    client; on §5.13 it is a DEAD END, because that route is the office
	 *    platform's ONLY way to turn office identity into keying identity, so a
	 *    422 denies it the `jobId` it needs to repair the very artifact that
	 *    caused the failure — even though the mapping itself
	 *    (`workspaceRelPath`, `jobId`, `monthId`) never reads the run record.
	 *
	 * The documented fields stay intact and `artifactProblem` is added beside
	 * them, so a degraded projection is never mistaken for `hasRunRecord: false`
	 * ("this month never ran"), the silence §3.7 exists to prevent, and no
	 * `status` outside §3.1's ten is invented. `GET /v1/jobs/{jobId}` keeps its
	 * hard `422` (README finding 5) by calling `projectRun` directly: there the
	 * run IS the subject and the read has nothing else to return.
	 *
	 * README finding 7 records this; its `[C-nn]` choice number is to be
	 * assigned when the spec is next revised (the spec owns that sequence). */
	async function projectRunOrDegrade(job: Job): Promise<{ run: RunProjection; artifactProblem?: JobArtifactProblem }> {
		try {
			return { run: await projectRun(job) };
		} catch (thrown) {
			if (!(thrown instanceof CoreError) || thrown.code !== "artifact_malformed") throw thrown;
			const reason = (thrown.details as { reason?: string } | undefined)?.reason ?? "artifact_unreadable";
			const degraded = buildRunProjection({
				jobId: job.jobId,
				workspaceRelPath: job.workspaceRelPath,
				clientKey: job.clientKey,
				monthId: job.monthId,
				record: null,
				queued: deps.scheduler.isQueued(job.workspaceRelPath),
				active: deps.scheduler.isActive(job.workspaceRelPath),
				counts: null,
				externalRef: job.externalRef,
				requestedBy: job.requestedBy,
				version: 0,
				enrich: { logger: deps.logger },
			});
			// `peek`, not `versionFor`: the LAST version actually issued, without
			// bumping the counter — a degraded read observed nothing new. It is
			// applied here rather than passed in because `run-contract.ts:159`
			// (`version: state.hasRunRecord ? input.version : 0`) overrides the
			// input whenever there is no record, which a degraded projection has by
			// construction. Two reasons it must not simply report 0:
			// 1. §1.6: "The platform compares it before writing a run reference so a
			//    late SSE event cannot regress it" — a row that regressed 5 → 0 is
			//    discarded by that compare, so the one row saying "this artifact is
			//    broken" never reaches the person who has to fix it.
			// 2. `RunProjectionStore` pins the semantics the SQLite adapter must
			//    reproduce, and that adapter is the next slice; a known contract
			//    break here would simply be inherited.
			// A job never observed at all still reports 0 — §1.7's documented
			// `hasRunRecord: false` case, not a regression.
			return {
				run: { ...degraded, version: deps.projections.peek(job.jobId) },
				artifactProblem: { code: "artifact_malformed", reason },
			};
		}
	}

	async function toSummary(job: Job): Promise<JobSummary> {
		const { run, artifactProblem } = await projectRunOrDegrade(job);
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
			...(artifactProblem === undefined ? {} : { artifactProblem }),
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
				// THE SEAM: SQLite is the next slice, not a deferred one — neither
				// document defers it. The key stays §5.2's `sqlite` because the
				// contract says so, and its CONTENT is honest about there being no
				// SQLite behind it: `ok: false` with a machine reason, and
				// `schemaVersion`/`journalMode` absent rather than faked (§1.3).
				// When the adapter lands it fills this in without reshaping the route.
				sqlite: { ok: false, reason: "sqlite_not_implemented" },
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

			// Readiness is the workspace and the orchestrator only for now. A failing
			// `checks.sqlite` deliberately does NOT flip the service to `not_ready`
			// in this slice, or every route would be permanently `503` and the slice
			// that does work could not run at all. When the SQLite adapter lands,
			// `checks.sqlite.ok` joins this condition, per plan §8.4 step 1.
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
				// A row whose run cannot be read survives every RUN-shaped filter: its
				// degraded projection is not evidence about the run, so filtering on it
				// would hide the row precisely where §3.6 says it must stay visible.
				if (summary.artifactProblem !== undefined) {
					matched.push(summary);
					continue;
				}
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
				const { run, artifactProblem } = await projectRunOrDegrade(job);
				return {
					jobId: job.jobId,
					runRef: job.jobId,
					workspaceRelPath: job.workspaceRelPath,
					clientKey: job.clientKey,
					monthId: job.monthId,
					monthKey,
					created: false,
					run,
					...(artifactProblem === undefined ? {} : { artifactProblem }),
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
			const { run, artifactProblem } = await projectRunOrDegrade(job);
			return {
				jobId: job.jobId,
				runRef: job.jobId,
				workspaceRelPath: job.workspaceRelPath,
				clientKey: job.clientKey,
				monthId: job.monthId,
				monthKey,
				created: true,
				run,
				...(artifactProblem === undefined ? {} : { artifactProblem }),
			};
		},
	};
}
