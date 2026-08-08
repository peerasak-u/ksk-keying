// The composition root (plan §14.1's `adapters/http/main.ts`). It is the only
// file that reads the environment, constructs adapters, and starts a server;
// everything below it takes its dependencies as arguments.
import { randomBytes } from "node:crypto";
import { createKeyingCore } from "./application/keying-core";
import { createInMemoryRunProjectionStore } from "./application/projection-store";
import { unscheduledSchedulerView } from "./application/scheduler-view";
import { loadConfig } from "./config";
import { createRouter } from "./http/routes-v1";
import { createInMemoryJobRepository } from "./jobs/job-repository";
import { createLogger } from "./observability/logger";

/** Plan §10.1's process-instance id. A client that sees it change knows the
 * process restarted, which is what makes §5.12's re-snapshot-on-reconnect
 * ([C-19]) detectable rather than guessed at. */
function mintStreamId(): string {
	return `ksk-core-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function main(): Promise<void> {
	const logger = createLogger({ level: (process.env.KSK_CORE_LOG_LEVEL as "info") || "info" });

	let config;
	try {
		config = loadConfig(process.env, (event, fields) => logger.warn(event, fields));
	} catch (thrown) {
		logger.error("core.boot_failed", { reason: thrown instanceof Error ? thrown.message : "unknown" });
		process.exit(1);
	}

	const core = createKeyingCore({
		workspaceRoot: config.workspaceRoot,
		buddhistCenturyBase: config.buddhistCenturyBase,
		jobs: createInMemoryJobRepository(),
		projections: createInMemoryRunProjectionStore(),
		// THE SEAM: the orchestrator-backed view lands with the run commands
		// (start/retry/repair/stop). Until then this process schedules nothing,
		// and says so rather than reporting a queue it does not have.
		scheduler: unscheduledSchedulerView(config.concurrency),
		logger,
		now: () => new Date().toISOString(),
		streamId: mintStreamId(),
		startedAt: new Date().toISOString(),
	});

	await core.boot();

	const handle = createRouter({ core, serviceToken: config.serviceToken, logger });
	const server = Bun.serve({ port: config.port, hostname: config.host, fetch: handle });
	logger.info("core.listening", { host: config.host, port: server.port });
}

if (import.meta.main) await main();
