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
import { loadCoaRows } from "./coa";
import { renderDashboard, toDashboardMonth, toDisplayStatus, type DashboardClient } from "./dashboard";
import { bringBackClaim, confirmClaim } from "./dispositions-writer";
import { renderDocumentReviewPage } from "./document-review";
import { renderExcludedReview, type ExcludedReviewGuard } from "./excluded-review";
import { config } from "./config";
import { orchestrator } from "./orchestrator";
import {
	buildClaims,
	hasAnyExcludedEntries,
	hasReferenceReportCheckFile,
	readDispositions,
	readReviewedUnitsByGroup,
} from "./review-claims";
import { isDocumentBucket, loadBucketPages, loadBucketStatements, type DocumentBucket } from "./review-data";
import { saveRowEdit, savePageEdit, saveStatementMetaEdit, type PageEdit, type PageLinePatch, type RowEdit } from "./review-edit";
import { listClientMonths, readCompanyName, readLedgerCounts, resolveUnderRoot } from "./workspace";
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
	return { facts, lines };
}

function parseRowEditBody(body: unknown): RowEdit {
	const b = (body ?? {}) as Record<string, unknown>;
	return {
		description: typeof b.description === "string" || b.description === null ? (b.description as string | null) : undefined,
		amount: typeof b.amount === "number" && Number.isFinite(b.amount) ? b.amount : undefined,
		account_key: typeof b.account_key === "string" ? b.account_key : undefined,
	};
}

const REVIEW_BUCKET_LINKS: { category: string; vat: string; label: string }[] = [
	{ category: "expense", vat: "vat", label: "รายจ่าย — มี VAT" },
	{ category: "expense", vat: "non_vat", label: "รายจ่าย — ไม่มี VAT" },
	{ category: "expense", vat: "mixed", label: "รายจ่าย — ผสม VAT/ไม่มี VAT" },
	{ category: "income", vat: "vat", label: "รายรับ — มี VAT" },
	{ category: "income", vat: "non_vat", label: "รายรับ — ไม่มี VAT" },
];

/** Small hub linking every review surface for one client-month — the "done"
 * dashboard action lands here instead of jumping straight to one bucket,
 * since by that point every review surface (excluded/skip + all 6 category
 * buckets) is equally relevant. Deliberately not its own module: a handful
 * of links, not worth a whole file. */
function renderReviewHub(clientId: string, monthId: string, companyName: string | null): string {
	const displayName = companyName ?? clientId;
	const links = [
		{ href: `/clients/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/excluded-review`, label: "เอกสารที่ตัดออก (ตรวจสอบ/เอากลับ)" },
		...REVIEW_BUCKET_LINKS.map((b) => ({
			href: `/clients/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/review/${b.category}/${b.vat}`,
			label: b.label,
		})),
		{ href: `/clients/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/review/bank_statement`, label: "รายการเดินบัญชีธนาคาร" },
	];
	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ตรวจทานเอกสาร — ${Bun.escapeHTML(displayName)}</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f7f6f3; color: #292524; }
	header { background: #1c1917; color: #fafaf9; padding: 12px 20px; }
	header a.back { color: #a8a29e; font-size: 12px; text-decoration: none; }
	header h1 { font-size: 15px; margin: 0; }
	header .sub { font-size: 11.5px; color: #a8a29e; }
	main { max-width: 480px; margin: 24px auto; padding: 0 20px; display: flex; flex-direction: column; gap: 10px; }
	a.link-card {
		background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
		text-decoration: none; color: #292524; font-weight: 600; font-size: 13.5px;
	}
	a.link-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
</style>
</head>
<body>
	<header>
		<a class="back" href="/">← กลับไปที่ Dashboard</a>
		<h1>ตรวจทานเอกสาร</h1>
		<div class="sub">${Bun.escapeHTML(displayName)} — ${Bun.escapeHTML(monthId)}</div>
	</header>
	<main>
		${links.map((l) => `<a class="link-card" href="${l.href}">${Bun.escapeHTML(l.label)}</a>`).join("")}
	</main>
</body>
</html>`;
}

const PUBLIC_DIR = join(import.meta.dir, "public");

function json(body: unknown, init: number | ResponseInit = 200): Response {
	const responseInit: ResponseInit = typeof init === "number" ? { status: init } : init;
	return new Response(JSON.stringify(body), {
		...responseInit,
		headers: { "content-type": "application/json; charset=utf-8", ...(responseInit.headers ?? {}) },
	});
}

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
		entry.months.push(toDashboardMonth(cm.monthId, cm.relPath, run, units));
	}
	return [...byClient.values()];
}

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
	const rel = pathname.replace(/^\//, "");
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

			if (pathname === "/api/clients" && req.method === "GET") {
				return json({ clients: await buildDashboardClients() });
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

			const runMatch = pathname.match(/^\/api\/runs\/([^/]+)\/([^/]+)(\/(events|retry|claims\/confirm|claims\/bring-back))?$/);
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
				const companyName = await readCompanyName(join(config.workspaceRoot, clientId));
				return new Response(renderReviewHub(clientId, monthId, companyName), {
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
