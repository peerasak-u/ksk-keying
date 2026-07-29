// Bun.serve entrypoint for the new review app (wayfinder ticket #38: plain
// Bun.serve, no framework — ticket #30). This is a SEPARATE process/app from
// console/server.ts (the old /ksk-keying interactive console, untouched) —
// they can run side by side, per the Phase 1 roadmap's naming note.
//
// Route surface is intentionally the foundation only: client/month listing,
// starting/retrying a run, and live status over SSE. The actual review UI
// (dashboard, excluded/skip review, category/group review) is tickets
// #39/#40/#41, layered on top of these same routes and the orchestrator.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { renderBankStatementReviewPage } from "./bank-statement-review";
import { computeAndWriteChangesForGroup } from "./changelog";
import { loadCoaRows } from "./coa";
import { applyEtaEstimates, buildClientsPayload, renderDashboard, renderMonthRow, renderRunCards, toDashboardMonth, toDisplayStatus, type DashboardClient, type DashboardMonth } from "./dashboard";
import { MonthSizeCache } from "./month-size";
import { snapshotThenScan } from "./seq-utils";
import { createProgressTicker, readStageProgress } from "./stage-progress";
import { bringBackClaim, confirmClaim } from "./dispositions-writer";
import { bucketLabel, renderDocumentReviewPage } from "./document-review";
import { renderExcludedReview, type ExcludedReviewGuard } from "./excluded-review";
import { decorateProposals, parseDecisionBody, runAgentReview, runLearnApply, runLearnPropose, summarizeReport, summarizeWithNotes } from "./learn";
import { runRebuildReviewData } from "./rebuild-review-data";
import { renderReviewHub } from "./review-hub";
import { loadHubStats } from "./review-hub-stats";
import { config } from "./config";
import { orchestrator } from "./orchestrator";
import { buildExpenseOrRevenueRows, buildStatementJournalRows, buildXlsxWorkbook, peakTemplateForBucket, STATEMENT_JOURNAL_TEMPLATE } from "./peak-export";
import {
	buildClaims,
	hasAnyExcludedEntries,
	hasReferenceReportCheckFile,
	readDispositions,
	readReviewedUnitsByGroup,
} from "./review-claims";
import { isDocumentBucket, loadBucketPages, loadBucketStatements, type DocumentBucket } from "./review-data";
import { saveRowEdit, savePageEdit, saveStatementMetaEdit, type PageEdit, type PageLinePatch, type RowEdit } from "./review-edit";
import { listClientMonths, readCompanyName, readDefaultBuyer, readLedgerCounts, resolveUnderRoot } from "./workspace";
import { buildXlsxPreviewMap } from "./xlsx-preview";

/** "expense"+"vat" -> "expense/vat", validated against the 5 real document
 * buckets — a regex can match "income/mixed" (not a real bucket) since it
 * only constrains the two segments independently, so this is the actual
 * whitelist check. */
function resolveDocumentBucket(category: string, vat: string): DocumentBucket | null {
	const key = `${category}/${vat}`;
	return isDocumentBucket(key) ? key : null;
}

/** Shapes an arbitrary parsed JSON body into a PageEdit, dropping anything
 * that isn't the right type rather than trusting it straight through to
 * applyPageEdit — same defensive posture as claims/confirm's `typeof
 * body?.unitKey === "string"` guard just above. `facts` must be a plain
 * object (not an array/string, which would otherwise spread into nonsense
 * keys); `lines` must be an array of objects each carrying a numeric
 * `line_index` (anything else is dropped, not just the whole array). */
function parsePageEditBody(body: unknown): PageEdit {
	const b = (body ?? {}) as Record<string, unknown>;
	const facts = b.facts && typeof b.facts === "object" && !Array.isArray(b.facts) ? (b.facts as Record<string, string | number | null>) : undefined;
	const lines = Array.isArray(b.lines)
		? (b.lines.filter((l): l is PageLinePatch => !!l && typeof l === "object" && typeof (l as Record<string, unknown>).line_index === "number") as PageLinePatch[])
		: undefined;
	const skipped = typeof b.skipped === "boolean" ? b.skipped : undefined;
	return { facts, lines, skipped };
}

function parseRowEditBody(body: unknown): RowEdit {
	const b = (body ?? {}) as Record<string, unknown>;
	return {
		description: typeof b.description === "string" || b.description === null ? (b.description as string | null) : undefined,
		amount: typeof b.amount === "number" && Number.isFinite(b.amount) ? b.amount : undefined,
		account_key: typeof b.account_key === "string" ? b.account_key : undefined,
		skipped: typeof b.skipped === "boolean" ? b.skipped : undefined,
	};
}

const PUBLIC_DIR = join(import.meta.dir, "public");

function json(body: unknown, init: number | ResponseInit = 200): Response {
	const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
	return new Response(JSON.stringify(body), {
		...responseInit,
		headers: { "content-type": "application/json; charset=utf-8", ...(responseInit.headers ?? {}) },
	});
}

// Page/unit counts for every client-month, including ones that have never run
// (month-size.ts). Non-blocking by construction: .get() below returns whatever
// is already known and does the counting in the background, then calls back
// here so the finished number reaches the browser over the SSE channel that
// already exists — the same "the render path never waits on disk work" rule
// ticket #3's stage-progress ticker follows.
const monthSizes = new MonthSizeCache({ onUpdated: (relPath) => scheduleBroadcast(relPath) });

async function buildDashboardClients(): Promise<DashboardClient[]> {
	const clientMonths = await listClientMonths(config.workspaceRoot);
	const byClient = new Map<string, DashboardClient>();
	for (const cm of clientMonths) {
		let entry = byClient.get(cm.clientId);
		if (!entry) {
			entry = {
				clientId: cm.clientId,
				companyName: await readCompanyName(join(config.workspaceRoot, cm.clientId)),
				months: [],
			};
			byClient.set(cm.clientId, entry);
		}
		const run = orchestrator.getRun(cm.relPath) ?? null;
		const units = run?.state.status === "done" ? await readLedgerCounts(join(config.workspaceRoot, cm.relPath)) : null;
		// Ticket #3: a disk read for stage-progress ONLY for a run that's
		// actually active — an idle/done/blocked month gets none, matching the
		// same "no needless I/O against a client-month nobody is touching" rule
		// readLedgerCounts above already follows for "done".
		const progress = run?.active ? await readStageProgress(join(config.workspaceRoot, cm.relPath), run.state.stageIndex) : null;
		const size = monthSizes.get(cm.relPath, join(config.workspaceRoot, cm.relPath));
		entry.months.push(toDashboardMonth(cm.monthId, cm.relPath, run, units, progress, size));
	}
	// Second pass: every month's time estimate needs the finished-run history of
	// the WHOLE list, so it can't be decided per-month above.
	return applyEtaEstimates([...byClient.values()]);
}

// --- Dashboard-wide live-updates broadcaster (validator fix for ticket #2) --
// The original eventsResponse() had each connected browser tab subscribe
// independently and run its OWN buildDashboardClients() (a full
// listClientMonths + per-month loadRunRecord/readLedgerCounts workspace scan)
// on every single orchestrator notification, PLUS one such scan per already-
// running client-month on every new connect (N concurrent scans, unawaited).
// Against a live pipeline that is writing run-state.yaml/ledger files at the
// same time, that's a lot of needless disk pressure for N tabs to all learn
// the same thing.
//
// Below: ONE workspace scan per notification, shared by every connected tab
// (pendingRelPaths + a 50ms debounce coalesces a burst of near-simultaneous
// notifications into a single buildDashboardClients() call), and every scan
// is chained onto broadcastChain so two scans can never resolve out of order
// and paint an older card strip / row over a newer one — the run they exist
// to prevent (an async buildDashboardClients() from an earlier notification
// resolving after a later one's).
type DashboardEvent = { seq: number; relPath: string; html: string; cardsHtml: string };

let eventSeq = 0;
const eventSubscribers = new Set<(payload: DashboardEvent) => void>();
const pendingRelPaths = new Set<string>();
let debounceHandle: ReturnType<typeof setTimeout> | null = null;
let broadcastChain: Promise<void> = Promise.resolve();
let globalSubscriptionStarted = false;

function findDashboardMonth(clients: DashboardClient[], relPath: string): { clientId: string; month: DashboardMonth } | null {
	for (const client of clients) {
		const month = client.months.find((m) => m.relPath === relPath);
		if (month) return { clientId: client.clientId, month };
	}
	return null;
}

async function broadcastPending(): Promise<void> {
	const relPaths = [...pendingRelPaths];
	pendingRelPaths.clear();
	if (relPaths.length === 0 || eventSubscribers.size === 0) return;
	const clients = await buildDashboardClients();
	const cardsHtml = renderRunCards(clients);
	for (const relPath of relPaths) {
		const found = findDashboardMonth(clients, relPath);
		if (!found) continue; // month vanished from the workspace scan — nothing to push
		const html = renderMonthRow(found.clientId, found.month);
		const payload: DashboardEvent = { seq: ++eventSeq, relPath, html, cardsHtml };
		for (const send of eventSubscribers) send(payload);
	}
}

function scheduleBroadcast(relPath: string): void {
	pendingRelPaths.add(relPath);
	if (debounceHandle) return;
	debounceHandle = setTimeout(() => {
		debounceHandle = null;
		// Chained, never run concurrently with a still-in-flight broadcast —
		// this is what makes seq a reliable "is this stale" signal for the
		// browser: broadcasts complete and are sent in the same order they
		// were scheduled, never overlapping.
		broadcastChain = broadcastChain.then(broadcastPending).catch((err) => console.error("dashboard broadcast failed:", err));
	}, 50);
}

function ensureGlobalSubscription(): void {
	if (globalSubscriptionStarted) return;
	globalSubscriptionStarted = true;
	orchestrator.subscribeAll((summary) => scheduleBroadcast(summary.relPath));
}

// Ticket #3's hard requirement: stage-progress.ts does its own disk reads,
// but WHEN those reads happen is gated here, not there. orchestrator
// notifications alone (the broadcast above) only fire at stage/attempt
// boundaries — a fragment landing mid-interpret, or a group's
// interpretation.json/categorize.json appearing mid-populate/categorize,
// never fires one, so without this poll the numerator would freeze between
// boundaries for the entire stage. createProgressTicker starts/stops exactly
// one 5s interval as the live SSE subscriber count crosses 0 — a run at 3am
// with nobody on the dashboard costs zero extra reads, same as before #3.
const progressTicker = createProgressTicker(() => {
	for (const run of orchestrator.listRuns()) {
		if (run.active) scheduleBroadcast(run.relPath);
	}
});

/** Both confirm and (future) bring-back are only ever actionable once a run
 * has settled — reviewing a page that's about to change underneath you makes
 * no sense (ticket #40's spec). Derives from the same displayStatus
 * dashboard.ts already computes rather than re-deriving active/queued
 * directly, so there's exactly one definition of "is this run mid-flight". */
function reviewGuard(relPath: string): ExcludedReviewGuard {
	const status = toDisplayStatus(orchestrator.getRun(relPath) ?? null);
	if (status === "stage-running" || status === "gate-running") {
		return { disabled: true, message: "งานนี้กำลังทำงานอยู่ ไม่สามารถตรวจสอบได้ตอนนี้" };
	}
	if (status === "queued") return { disabled: true, message: "งานนี้กำลังรอคิวอยู่ ไม่สามารถตรวจสอบได้ตอนนี้" };
	return { disabled: false, message: null };
}

const FILE_CONTENT_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls": "application/vnd.ms-excel",
};

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
};

async function serveStatic(pathname: string): Promise<Response> {
	// PUBLIC_DIR already IS the public dir, so a "/public/..." request must not
	// re-add the segment (that path had no files under it until pdf.js was
	// vendored, so the double-"public" join never surfaced before).
	const rel = pathname.replace(/^\/(?:public\/)?/, "");
	const filePath = join(PUBLIC_DIR, rel);
	const resolved = resolve(filePath);
	if (!resolved.startsWith(resolve(PUBLIC_DIR) + sep) && resolved !== resolve(PUBLIC_DIR)) {
		return new Response("forbidden", { status: 403 });
	}
	if (!existsSync(resolved)) return new Response("not found", { status: 404 });
	const body = await readFile(resolved);
	const contentType = CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
	return new Response(body, { headers: { "content-type": contentType } });
}

function sseResponse(relPath: string): Response {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					// controller already closed; cleanup happens on cancel
				}
			};
			const current = orchestrator.getRun(relPath);
			if (current) send(current);
			unsubscribe = orchestrator.subscribe(relPath, send);
			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": ping\n\n"));
				} catch {
					// stream closed
				}
			}, 15000);
		},
		cancel() {
			unsubscribe?.();
			if (heartbeat) clearInterval(heartbeat);
		},
	});

	return new Response(stream, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
	});
}

/** The dashboard-wide live-updates stream (wayfinder #49, replacing the old
 * whole-page 8s reload): pushes dashboard.ts's own renderMonthRow() output —
 * not raw RunSummary JSON — so the browser never re-implements
 * detailCell/timeCell/STATUS_META to turn a status into a row. Every
 * subsequent push is produced by the single shared broadcaster above (one
 * workspace scan per orchestrator notification, shared by every connected
 * tab); this function's own job is just: register this connection to receive
 * those broadcasts, and give it ONE catch-up scan of its own on connect (not
 * one scan per already-running client-month, which the previous version did
 * concurrently for N runs on every new tab). */
function eventsResponse(): Response {
	ensureGlobalSubscription();
	const encoder = new TextEncoder();
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let send: ((payload: DashboardEvent) => void) | null = null;
	// A browser can disconnect while start() is still awaiting
	// buildDashboardClients() below. Per the streams spec, cancel() fires the
	// moment that happens — it does NOT wait for the pending start() promise —
	// so at that point `heartbeat` is still null and clearInterval() there is a
	// no-op. Without this flag, start() would resume afterwards, install a 15s
	// setInterval nobody will ever clear, and that timer would enqueue to a
	// dead controller for the rest of the server process's life (the throw is
	// swallowed by the try/catch above, so it fails silently). `cancelled` lets
	// start() bail out of both the catch-up sends and the heartbeat install
	// once cancel() has already run.
	let cancelled = false;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			send = (payload) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
				} catch {
					// controller already closed; cleanup happens on cancel
				}
			};
			eventSubscribers.add(send);
			progressTicker.onSubscriberCountChange(eventSubscribers.size);
			try {
				// Same fix as /api/clients (MAJOR 2 follow-up, validator finding):
				// snapshot eventSeq BEFORE the scan starts, via snapshotThenScan,
				// rather than incrementing the counter after buildDashboardClients()
				// resolves. eventSubscribers.add(send) above runs synchronously
				// before this await, so a broadcast minted while this connection's
				// own catch-up scan is in flight must be stamped with a seq that
				// is STRICTLY GREATER than this catch-up's — otherwise the client's
				// strict `seq < lastRowSeq` guard lets this stale catch-up win and
				// repaint a finished run back to a running pill/button. Snapshotting
				// first guarantees that ordering.
				const { seq, result: clients } = await snapshotThenScan(() => eventSeq, buildDashboardClients);
				if (cancelled) return; // disconnected mid-scan — don't catch up a dead connection
				const cardsHtml = renderRunCards(clients);
				for (const client of clients) {
					for (const month of client.months) {
						if (!orchestrator.getRun(month.relPath)) continue; // never run — nothing to catch this connection up on
						send(renderCatchup(client.clientId, month, cardsHtml, seq));
					}
				}
			} catch (err) {
				console.error("dashboard events initial catch-up failed:", err);
			}
			if (cancelled) return; // don't install a heartbeat nothing will ever clear
			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": ping\n\n"));
				} catch {
					// stream closed
				}
			}, 15000);
		},
		cancel() {
			cancelled = true;
			if (send) eventSubscribers.delete(send);
			progressTicker.onSubscriberCountChange(eventSubscribers.size);
			if (heartbeat) clearInterval(heartbeat);
		},
	});

	return new Response(stream, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
	});
}

function renderCatchup(clientId: string, month: DashboardMonth, cardsHtml: string, seq: number): DashboardEvent {
	return { seq, relPath: month.relPath, html: renderMonthRow(clientId, month), cardsHtml };
}

await orchestrator.boot(config.workspaceRoot, config.concurrency);

const server = Bun.serve({
	hostname: config.host,
	port: config.port,
	async fetch(req) {
		const url = new URL(req.url);
		const { pathname } = url;

		try {
			if (pathname === "/api/config" && req.method === "GET") {
				return json({ workspaceRoot: config.workspaceRoot, concurrency: config.concurrency, port: config.port });
			}

			// The 30s SSE-fallback poll (dashboard.ts's pollClientsFallback) has to
			// swap through the same renderMonthRow() markup the SSE push and the
			// initial page use — attaching `html` here, rather than leaving the
			// fallback to patch data-status alone, is what stops the row's pill,
			// detail/time text and action button from freezing at page-load state
			// while data-status moves underneath them during a sustained SSE outage.
			// `cardsHtml` (top-level, same renderRunCards() the SSE push carries)
			// is what lets that same fallback keep the active-run card strip live
			// too — without it, a proxy that blocks the SSE connection left the
			// card frozen at page-load state for the rest of the session.
			//
			// `seq` (validator finding, MAJOR 2): this handler shares the SAME
			// eventSeq counter the SSE push and catch-up use, snapshotted BEFORE
			// buildDashboardClients() (an async full workspace scan + per-active-run
			// readStageProgress) starts, via snapshotThenScan — NOT stamped at the
			// moment the scan resolves. Stamping on resolve would guarantee this
			// response outranks any SSE broadcast minted while the very same scan
			// was still in flight (the client guards are strict `seq < lastRowSeq`,
			// so that stale response could then NEVER be dropped): a terminal SSE
			// notification (run reaches done/blocked/stopped) landing mid-scan
			// would get overwritten right back to a pre-terminal row/card by this
			// fallback, forever (a finished run emits no further notifications to
			// correct it). Snapshotting first means an uncontended poll behaves
			// exactly as before (its seq still applies — the guard is strict `<`),
			// while a broadcast completing during the scan now correctly holds a
			// strictly higher seq and wins.
			if (pathname === "/api/clients" && req.method === "GET") {
				const { seq, result: clients } = await snapshotThenScan(() => eventSeq, buildDashboardClients);
				const cardsHtml = renderRunCards(clients);
				// MAJOR 1 (validator finding): every client also carries its own
				// pre-rendered headerHtml/noMatchHtml now (buildClientsPayload,
				// dashboard.ts), not just each month's html — the browser's fallback
				// reconciliation needs both to insert a wholly new client that
				// appeared on disk since the last poll, without ever building that
				// markup itself.
				return json({ clients: buildClientsPayload(clients), cardsHtml, seq });
			}

			if (pathname === "/api/events" && req.method === "GET") {
				return eventsResponse();
			}

			if (pathname === "/api/runs" && req.method === "GET") {
				return json({ runs: orchestrator.listRuns() });
			}

			if (pathname === "/api/runs" && req.method === "POST") {
				const body = await req.json().catch(() => ({}) as any);
				const rawPath: string = typeof body?.path === "string" ? body.path : "";
				const resolved = resolveUnderRoot(config.workspaceRoot, rawPath);
				if (!resolved || !existsSync(resolved) || !(await stat(resolved)).isDirectory()) {
					return json({ error: "ไม่พบโฟลเดอร์ที่เลือก" }, 400);
				}
				const relPath = rawPath.replace(/^\/+/, "");
				const result = await orchestrator.enqueueRun(relPath);
				if (!result.ok) return json({ error: result.error }, result.code);
				return json({ run: result.run }, 201);
			}

			const runMatch = pathname.match(
				/^\/api\/runs\/([^/]+)\/([^/]+)(\/(events|retry|repair|stop|rebuild-review-data|claims\/confirm|claims\/bring-back))?$/,
			);
			if (runMatch) {
				const relPath = `${decodeURIComponent(runMatch[1])}/${decodeURIComponent(runMatch[2])}`;
				const sub = runMatch[4];

				if (!sub && req.method === "GET") {
					const run = orchestrator.getRun(relPath);
					if (!run) return json({ error: "ยังไม่เคยรันงานนี้" }, 404);
					return json({ run });
				}

				if (sub === "events" && req.method === "GET") {
					return sseResponse(relPath);
				}

				if (sub === "retry" && req.method === "POST") {
					const result = await orchestrator.retryRun(relPath);
					if (!result.ok) return json({ error: result.error }, result.code);
					return json({ run: result.run });
				}

				if (sub === "stop" && req.method === "POST") {
					const result = await orchestrator.stopRun(relPath);
					if (!result.ok) return json({ error: result.error }, result.code);
					return json({ run: result.run });
				}

				// Full pipeline restart from Stage 1 — same call the excluded-review
				// bring-back already makes, now also reachable deliberately from the
				// dashboard menu instead of only as a side effect of bringing a page
				// back. repairRun does its own active/queued check.
				if (sub === "repair" && req.method === "POST") {
					const result = await orchestrator.repairRun(relPath);
					if (!result.ok) return json({ error: result.error }, result.code);
					return json({ run: result.run });
				}

				// Re-assemble review-data.json from artifacts already on disk. No
				// agent, no queue slot — but it writes into the same files a running
				// pipeline writes, so it is refused while one is in flight.
				if (sub === "rebuild-review-data" && req.method === "POST") {
					const run = orchestrator.getRun(relPath);
					if (run && (run.active || run.queued)) {
						return json({ error: "งานนี้กำลังทำงานอยู่หรืออยู่ในคิว รอให้เสร็จก่อนแล้วค่อยสร้างใหม่" }, 409);
					}
					const targetDir = resolveUnderRoot(config.workspaceRoot, relPath);
					if (!targetDir || !existsSync(targetDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);
					const result = await runRebuildReviewData(targetDir);
					if (!result.ok) return json({ error: result.error, output: result.output }, 409);
					return json({ message: result.summary.message, summary: result.summary, output: result.output });
				}

				if (sub === "claims/confirm" && req.method === "POST") {
					const guard = reviewGuard(relPath);
					if (guard.disabled) return json({ error: guard.message }, 409);
					const body = await req.json().catch(() => ({}) as any);
					const unitKey = typeof body?.unitKey === "string" ? body.unitKey : "";
					const targetDir = join(config.workspaceRoot, relPath);
					if (!existsSync(targetDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);
					const result = await confirmClaim(targetDir, unitKey);
					if (!result.ok) return json({ error: result.error }, 400);
					return json({ ok: true });
				}

				if (sub === "claims/bring-back" && req.method === "POST") {
					const guard = reviewGuard(relPath);
					if (guard.disabled) return json({ error: guard.message }, 409);
					const body = await req.json().catch(() => ({}) as any);
					const unitKey = typeof body?.unitKey === "string" ? body.unitKey : "";
					const targetDir = join(config.workspaceRoot, relPath);
					if (!existsSync(targetDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);
					const result = await bringBackClaim(targetDir, unitKey);
					if (!result.ok) return json({ error: result.error }, 400);
					// The guard already checked active/queued moments earlier, but
					// repairRun re-checks (a rare race) — undo the disposition write
					// rather than stranding it with no run ever requeued.
					const repairResult = await orchestrator.repairRun(relPath);
					if (!repairResult.ok) {
						result.revert();
						return json({ error: repairResult.error }, repairResult.code);
					}
					return json({ ok: true });
				}
			}

			// เรียนรู้ (ticket #43) — CLIENT-scoped, not month-scoped: it reads
			// every month's changes.json under one client. Two steps, because
			// nothing may be written before a human sees the proposals.
			const learnMatch = pathname.match(/^\/api\/learn\/([^/]+)(\/apply)?$/);
			if (learnMatch && req.method === "POST") {
				const clientId = decodeURIComponent(learnMatch[1]);
				const clientDir = resolveUnderRoot(config.workspaceRoot, clientId);
				if (!clientDir || !existsSync(clientDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);
				// coa_usage.json is an input every categorize stage reads, so it is
				// never rewritten under a run that is mid-flight.
				const busy = orchestrator.listRuns().some((r) => r.clientId === clientId && (r.active || r.queued));
				if (busy) return json({ error: "บริษัทนี้มีงานกำลังทำงานอยู่ รอให้เสร็จก่อนแล้วค่อยกดเรียนรู้" }, 409);

				if (learnMatch[2]) {
					const decision = parseDecisionBody(await req.json().catch(() => ({})));
					const applied = await runLearnApply(clientDir, decision);
					if (!applied.ok) return json({ error: applied.error }, 500);
					return json({ message: applied.message });
				}

				const proposed = await runLearnPropose(clientDir);
				if (!proposed.ok) return json({ error: proposed.error }, 500);
				const baseSummary = summarizeReport(proposed.report);
				// The agent-review pass is gated on hasWork alone — no proposals
				// means nothing for the agent to judge, and spending a `claude -p`
				// call just to look at stored notes would be wasted spend.
				const review = baseSummary.hasWork ? await runAgentReview(clientDir, proposed.report) : null;
				const summary = summarizeWithNotes(baseSummary, (proposed.report.learning_notes ?? []));
				return json({
					message: summary.message,
					hasWork: summary.hasWork,
					agentReviewed: review !== null,
					proposals: decorateProposals(proposed.report.proposals, review),
					notes: review?.notes ?? [],
					sources: proposed.report.sources,
					// Always present, independent of hasWork — a client can have
					// pending notes with no fresh corrections, and this is the only
					// way the confirm dialog can ever offer to clear them (#47).
					storedNotes: (proposed.report.learning_notes ?? []),
				});
			}

			const reviewPageMatch = pathname.match(/^\/clients\/([^/]+)\/([^/]+)\/excluded-review$/);
			if (reviewPageMatch && req.method === "GET") {
				const clientId = decodeURIComponent(reviewPageMatch[1]);
				const monthId = decodeURIComponent(reviewPageMatch[2]);
				const relPath = `${clientId}/${monthId}`;
				const targetDir = join(config.workspaceRoot, relPath);
				if (!existsSync(targetDir)) return new Response("not found", { status: 404 });

				const [companyName, dispositions, reviewedByGroup] = await Promise.all([
					readCompanyName(join(config.workspaceRoot, clientId)),
					readDispositions(targetDir),
					readReviewedUnitsByGroup(targetDir),
				]);
				const claims = buildClaims(dispositions, reviewedByGroup, hasReferenceReportCheckFile(targetDir));
				return new Response(
					renderExcludedReview({
						clientId,
						monthId,
						companyName,
						claims,
						guard: reviewGuard(relPath),
						hasAnyExcludedEntries: hasAnyExcludedEntries(dispositions),
						xlsxPreviews: buildXlsxPreviewMap(targetDir, claims),
					}),
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				);
			}

			const reviewHubMatch = pathname.match(/^\/clients\/([^/]+)\/([^/]+)\/review$/);
			if (reviewHubMatch && req.method === "GET") {
				const clientId = decodeURIComponent(reviewHubMatch[1]);
				const monthId = decodeURIComponent(reviewHubMatch[2]);
				const targetDir = join(config.workspaceRoot, clientId, monthId);
				if (!existsSync(targetDir)) return new Response("not found", { status: 404 });
				const [companyName, stats] = await Promise.all([
					readCompanyName(join(config.workspaceRoot, clientId)),
					loadHubStats(targetDir, clientId, monthId),
				]);
				return new Response(renderReviewHub({ clientId, monthId, companyName, stats }), {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			const docReviewMatch = pathname.match(/^\/clients\/([^/]+)\/([^/]+)\/review\/(expense|income)\/(vat|non_vat|mixed)$/);
			if (docReviewMatch && req.method === "GET") {
				const clientId = decodeURIComponent(docReviewMatch[1]);
				const monthId = decodeURIComponent(docReviewMatch[2]);
				const bucket = resolveDocumentBucket(docReviewMatch[3], docReviewMatch[4]);
				if (!bucket) return new Response("not found", { status: 404 });
				const relPath = `${clientId}/${monthId}`;
				const targetDir = join(config.workspaceRoot, relPath);
				if (!existsSync(targetDir)) return new Response("not found", { status: 404 });
				const [companyName, coaRows, bucketResult] = await Promise.all([
					readCompanyName(join(config.workspaceRoot, clientId)),
					loadCoaRows(targetDir),
					loadBucketPages(targetDir, bucket),
				]);
				if (bucketResult.errors.length) console.error(`document review bucket ${bucket} (${relPath}):`, bucketResult.errors);
				const html = await renderDocumentReviewPage(targetDir, {
					clientId,
					monthId,
					companyName,
					bucket,
					coaRows,
					guard: reviewGuard(relPath),
					pages: bucketResult.pages,
				});
				return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
			}

			const stmtReviewMatch = pathname.match(/^\/clients\/([^/]+)\/([^/]+)\/review\/bank_statement$/);
			if (stmtReviewMatch && req.method === "GET") {
				const clientId = decodeURIComponent(stmtReviewMatch[1]);
				const monthId = decodeURIComponent(stmtReviewMatch[2]);
				const relPath = `${clientId}/${monthId}`;
				const targetDir = join(config.workspaceRoot, relPath);
				if (!existsSync(targetDir)) return new Response("not found", { status: 404 });
				const [companyName, coaRows, bucketResult] = await Promise.all([
					readCompanyName(join(config.workspaceRoot, clientId)),
					loadCoaRows(targetDir),
					loadBucketStatements(targetDir),
				]);
				if (bucketResult.errors.length) console.error(`bank_statement review bucket (${relPath}):`, bucketResult.errors);
				const html = await renderBankStatementReviewPage(targetDir, {
					clientId,
					monthId,
					companyName,
					coaRows,
					guard: reviewGuard(relPath),
					statements: bucketResult.statements,
				});
				return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
			}

			const docEditMatch = pathname.match(
				/^\/api\/review\/([^/]+)\/([^/]+)\/(expense|income)\/(vat|non_vat|mixed)\/([^/]+)\/pages\/(\d+)$/,
			);
			if (docEditMatch && req.method === "POST") {
				const clientId = decodeURIComponent(docEditMatch[1]);
				const monthId = decodeURIComponent(docEditMatch[2]);
				const bucket = resolveDocumentBucket(docEditMatch[3], docEditMatch[4]);
				if (!bucket) return json({ error: "ไม่พบหมวดนี้" }, 404);
				const groupId = decodeURIComponent(docEditMatch[5]);
				const pageIndex = Number(docEditMatch[6]);
				const relPath = `${clientId}/${monthId}`;
				const guard = reviewGuard(relPath);
				if (guard.disabled) return json({ error: guard.message }, 409);
				const targetDir = join(config.workspaceRoot, relPath);
				if (!existsSync(targetDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);
				const body = await req.json().catch(() => ({}) as any);
				const coaRows = await loadCoaRows(targetDir);
				const result = await savePageEdit(targetDir, bucket, groupId, pageIndex, parsePageEditBody(body), coaRows);
				if (!result.ok) return json({ error: result.error }, 400);
				return json({ ok: true });
			}

			const stmtRowEditMatch = pathname.match(/^\/api\/review\/([^/]+)\/([^/]+)\/bank_statement\/([^/]+)\/rows\/(\d+)$/);
			if (stmtRowEditMatch && req.method === "POST") {
				const clientId = decodeURIComponent(stmtRowEditMatch[1]);
				const monthId = decodeURIComponent(stmtRowEditMatch[2]);
				const groupId = decodeURIComponent(stmtRowEditMatch[3]);
				const rowIndex = Number(stmtRowEditMatch[4]);
				const relPath = `${clientId}/${monthId}`;
				const guard = reviewGuard(relPath);
				if (guard.disabled) return json({ error: guard.message }, 409);
				const targetDir = join(config.workspaceRoot, relPath);
				if (!existsSync(targetDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);
				const body = await req.json().catch(() => ({}) as any);
				const coaRows = await loadCoaRows(targetDir);
				const result = await saveRowEdit(targetDir, groupId, rowIndex, parseRowEditBody(body), coaRows);
				if (!result.ok) return json({ error: result.error }, 400);
				return json({ ok: true });
			}

			const stmtMetaEditMatch = pathname.match(/^\/api\/review\/([^/]+)\/([^/]+)\/bank_statement\/([^/]+)\/statement$/);
			if (stmtMetaEditMatch && req.method === "POST") {
				const clientId = decodeURIComponent(stmtMetaEditMatch[1]);
				const monthId = decodeURIComponent(stmtMetaEditMatch[2]);
				const groupId = decodeURIComponent(stmtMetaEditMatch[3]);
				const relPath = `${clientId}/${monthId}`;
				const guard = reviewGuard(relPath);
				if (guard.disabled) return json({ error: guard.message }, 409);
				const targetDir = join(config.workspaceRoot, relPath);
				if (!existsSync(targetDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);
				const body = await req.json().catch(() => ({}) as any);
				const accountKey = typeof body?.account_key === "string" ? body.account_key : "";
				const coaRows = await loadCoaRows(targetDir);
				const result = await saveStatementMetaEdit(targetDir, groupId, { account_key: accountKey }, coaRows);
				if (!result.ok) return json({ error: result.error }, 400);
				return json({ ok: true });
			}

			const docExportMatch = pathname.match(/^\/api\/export\/([^/]+)\/([^/]+)\/(expense|income)\/(vat|non_vat|mixed)$/);
			if (docExportMatch && req.method === "POST") {
				const clientId = decodeURIComponent(docExportMatch[1]);
				const monthId = decodeURIComponent(docExportMatch[2]);
				const bucket = resolveDocumentBucket(docExportMatch[3], docExportMatch[4]);
				if (!bucket) return json({ error: "ไม่พบหมวดนี้" }, 404);
				const relPath = `${clientId}/${monthId}`;
				const guard = reviewGuard(relPath);
				if (guard.disabled) return json({ error: guard.message }, 409);
				const targetDir = join(config.workspaceRoot, relPath);
				if (!existsSync(targetDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);

				const [coaRows, defaultBuyer, bucketResult] = await Promise.all([
					loadCoaRows(targetDir),
					readDefaultBuyer(join(config.workspaceRoot, clientId)),
					loadBucketPages(targetDir, bucket),
				]);
				if (bucketResult.errors.length) console.error(`export ${bucket} (${relPath}):`, bucketResult.errors);

				const template = peakTemplateForBucket(bucket);
				const { rows, warnings, committedCount } = buildExpenseOrRevenueRows(bucketResult.pages, template.isRevenue, coaRows);
				if (!committedCount) return json({ error: "ไม่มีเอกสารที่ยังไม่ถูกข้ามสำหรับส่งออกในหมวดนี้" }, 400);

				// One changes.json per group represented in this bucket, computed
				// atomically with the export (ticket #36) — a group whose upstream
				// interpretation/categorize files are missing is soft-skipped (logged),
				// not a reason to fail the whole export.
				const groupIds = [...new Set(bucketResult.pages.map((p) => p.group_id).filter((g): g is string => !!g))];
				for (const groupId of groupIds) {
					const changes = await computeAndWriteChangesForGroup(targetDir, bucket, groupId, defaultBuyer);
					if (!changes) console.error(`changes.json skipped for group "${groupId}" in ${bucket} (${relPath}): missing/malformed interpretation.json or categorize.json`);
				}

				const buffer = buildXlsxWorkbook(template.headers, template.sheetName, rows);
				return json({ ok: true, filename: `นำเข้า PEAK - ${bucketLabel(bucket)}.xlsx`, warnings, dataBase64: buffer.toString("base64") });
			}

			const stmtExportMatch = pathname.match(/^\/api\/export\/([^/]+)\/([^/]+)\/bank_statement$/);
			if (stmtExportMatch && req.method === "POST") {
				const clientId = decodeURIComponent(stmtExportMatch[1]);
				const monthId = decodeURIComponent(stmtExportMatch[2]);
				const relPath = `${clientId}/${monthId}`;
				const guard = reviewGuard(relPath);
				if (guard.disabled) return json({ error: guard.message }, 409);
				const targetDir = join(config.workspaceRoot, relPath);
				if (!existsSync(targetDir)) return json({ error: "ไม่พบลูกค้ารายนี้" }, 404);

				const bucketResult = await loadBucketStatements(targetDir);
				if (bucketResult.errors.length) console.error(`export bank_statement (${relPath}):`, bucketResult.errors);

				const { rows, warnings, committedCount } = buildStatementJournalRows(bucketResult.statements);
				if (!committedCount) return json({ error: "ไม่มีรายการที่ยังไม่ถูกข้ามสำหรับส่งออก" }, 400);

				for (const entry of bucketResult.statements) {
					const changes = await computeAndWriteChangesForGroup(targetDir, "bank_statement", entry.group_dir, null);
					if (!changes) console.error(`changes.json skipped for group "${entry.group_dir}" in bank_statement (${relPath}): missing/malformed interpretation.json or categorize.json`);
				}

				const buffer = buildXlsxWorkbook(STATEMENT_JOURNAL_TEMPLATE.headers, STATEMENT_JOURNAL_TEMPLATE.sheetName, rows);
				return json({ ok: true, filename: "peak_import_bank_statement.xlsx", warnings, dataBase64: buffer.toString("base64") });
			}

			const fileMatch = pathname.match(/^\/files\/([^/]+)\/([^/]+)\/(.+)$/);
			if (fileMatch && req.method === "GET") {
				const clientId = decodeURIComponent(fileMatch[1]);
				const monthId = decodeURIComponent(fileMatch[2]);
				const targetDir = join(config.workspaceRoot, clientId, monthId);
				const resolved = resolveUnderRoot(targetDir, fileMatch[3]);
				if (!resolved || !existsSync(resolved) || !(await stat(resolved)).isFile()) {
					return new Response("not found", { status: 404 });
				}
				const contentType = FILE_CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
				return new Response(await readFile(resolved), { headers: { "content-type": contentType } });
			}

			if (pathname === "/" && req.method === "GET") {
				return new Response(renderDashboard(await buildDashboardClients()), {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			if (pathname.startsWith("/public/") || pathname.endsWith(".css") || pathname.endsWith(".js")) {
				return serveStatic(pathname);
			}

			return new Response("not found", { status: 404 });
		} catch (err) {
			console.error(err);
			return json({ error: "เกิดข้อผิดพลาดภายในระบบ" }, 500);
		}
	},
});

console.log(
	`KSK review app listening on http://${config.host}:${server.port} ` +
		`(concurrency=${config.concurrency}, workspaceRoot=${config.workspaceRoot})`,
);

let shuttingDown = false;
async function gracefulShutdown(signal: "SIGINT" | "SIGTERM") {
	if (shuttingDown) {
		// A second termination signal is the operator/Docker asking us not to
		// wait any longer. The first handler has already signalled every group.
		process.exit(1);
	}
	shuttingDown = true;
	console.log(`KSK review app received ${signal}; cancelling active process groups...`);
	try {
		// Stop new HTTP work first, then wait for the orchestrator's supervisors
		// to TERM/KILL every stage/gate process group before exiting the container.
		server.stop(true);
		await orchestrator.shutdown();
	} catch (error) {
		console.error("KSK review app shutdown failed:", error);
		process.exitCode = 1;
	} finally {
		process.exit(process.exitCode ?? 0);
	}
}

process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
