import { describe, expect, test } from "bun:test";
import { STAGES } from "../sequencer/logic";
import {
	buildClientsPayload,
	elapsedText,
	renderClientHeader,
	renderDashboard,
	renderMonthRow,
	renderNoMatchRow,
	renderRunCard,
	renderRunCards,
	applyEtaEstimates,
	type DashboardClient,
	type DashboardMonth,
	type DisplayStatus,
} from "./dashboard";
import { diffDashboardMembership } from "./dashboard-reconcile";

/** Extract a top-level `function <name>(...) { ... }` block's exact literal
 * source out of the rendered page HTML by brace-counting from the `function`
 * keyword to its matching close brace — same pattern as
 * bank-statement-review.test.ts's own helper, used here (MINOR 4) to run the
 * real emitted computeElapsedText rather than a hand-copy of it. */
function extractFunctionSource(html: string, name: string): string {
	const marker = `function ${name}(`;
	const start = html.indexOf(marker);
	if (start === -1) throw new Error(`function ${name} not found in emitted page`);
	const braceStart = html.indexOf("{", start);
	let depth = 0;
	let i = braceStart;
	for (; i < html.length; i++) {
		if (html[i] === "{") depth++;
		else if (html[i] === "}") {
			depth--;
			if (depth === 0) break;
		}
	}
	return html.slice(start, i + 1);
}

function month(over: Partial<DashboardMonth> = {}): DashboardMonth {
	return {
		monthId: "เดือนพฤษภาคม",
		relPath: "216/เดือนพฤษภาคม",
		displayStatus: "done",
		stageLabel: null,
		reasonText: null,
		finishedAt: "2026-05-31T10:00:00.000Z",
		durationMin: 12,
		units: { total: 52, reviewed: 50, excluded: 2 },
		stageIndex: 0,
		startedAt: null,
		stageStartedAt: null,
		log: [],
		progress: null,
		...over,
	};
}

function html(status: DisplayStatus, over: Partial<DashboardMonth> = {}): string {
	const clients: DashboardClient[] = [
		{ clientId: "216", companyName: "บริษัท ทดสอบ จำกัด", months: [month({ displayStatus: status, ...over })] },
	];
	return renderDashboard(clients);
}

/** The menu markup for the single month rendered by html(). */
function menu(out: string): string {
	const m = out.match(/<span class="menu" role="menu">([\s\S]*?)<\/span>\n?\s*<\/span>/);
	return m ? m[1] : "";
}

describe("renderMonthRow — the one renderer shared by the initial page and the SSE push", () => {
	test("carries the row's identity and status as data attributes", () => {
		const m = month({ displayStatus: "blocked" });
		const out = renderMonthRow("216", m);
		expect(out).toContain('data-relpath="216/เดือนพฤษภาคม"');
		expect(out).toContain('data-code="216"');
		expect(out).toContain('data-status="blocked"');
		expect(out.trim().startsWith("<tr")).toBe(true);
		expect(out.trim().endsWith("</tr>")).toBe(true);
	});

	test("renderDashboard's row for a month is byte-identical to calling renderMonthRow directly", () => {
		const m = month({ displayStatus: "done" });
		const clients: DashboardClient[] = [{ clientId: "216", companyName: "บริษัท ทดสอบ จำกัด", months: [m] }];
		const page = renderDashboard(clients);
		expect(page).toContain(renderMonthRow("216", m));
	});
});

describe("dashboard — per-month ⋯ menu", () => {
	test("a finished month offers the review surfaces, the cheap rebuild and the full repair", () => {
		const out = html("done");
		expect(out).toContain('class="btn btn-menu"');
		const items = menu(out);
		expect(items).toContain("ตรวจทานเอกสาร");
		expect(items).toContain("รายการที่ตัดออก");
		expect(items).toContain("สร้างข้อมูลรีวิวใหม่");
		expect(items).toContain("รันซ่อมใหม่ทั้งเดือน");
	});

	test("a month that has never run has no menu at all — nothing to rebuild or repair", () => {
		const out = html("idle");
		expect(out).toContain("▶ เริ่มงาน");
		expect(out).not.toContain('class="btn btn-menu"');
	});

	test.each<DisplayStatus>(["queued", "stage-running", "gate-running"])(
		"a busy month (%s) offers no menu — every entry would race the running pipeline",
		(status) => {
			const out = html(status);
			expect(out).not.toContain('class="btn btn-menu"');
			expect(out).toContain("/stop");
			expect(out).toMatch(/ยกเลิกคิว|หยุดงาน/);
		},
	);

	test("a retryable month keeps its primary retry button AND offers retry in the menu", () => {
		const out = html("blocked");
		expect(out).toContain("🔁 ลองใหม่");
		expect(menu(out)).toContain("ลองขั้นที่ค้างใหม่");
	});

	test("a month stopped for a human can still be rebuilt without a full re-run", () => {
		const items = menu(html("stopped-for-human"));
		expect(items).toContain("สร้างข้อมูลรีวิวใหม่");
		expect(items).toContain("รันซ่อมใหม่ทั้งเดือน");
	});

	test("fatal cleanup exposes repair only after an operator restart", () => {
		const out = html("fatal-cleanup");
		expect(out).toContain("เริ่มใหม่หลัง restart");
		expect(out).toContain("repairRun");
		expect(out).toContain("/repair");
		expect(out).not.toContain('class="btn btn-menu"');
		expect(out).not.toContain('class="btn btn-attn" disabled');
	});

	test("the expensive action is marked as such and the cheap one says it skips the AI", () => {
		const items = menu(html("done"));
		expect(items).toContain("menu-item-danger");
		expect(items).toContain("ไม่เรียก AI ใหม่");
		expect(items).toContain("ใช้เวลาและค่าใช้จ่ายเต็ม");
	});
});

describe("dashboard — menu wiring", () => {
	test("each action posts to its own endpoint and only the destructive one confirms first", () => {
		const out = html("done");
		expect(out).toContain("/rebuild-review-data");
		expect(out).toContain('"/api/runs/" + encodeURIComponent(clientId) + "/" + encodeURIComponent(monthId) + "/repair"');
		// confirm() guards repairRun and nothing else
		expect(out.match(/if \(!confirm\(/g)?.length).toBe(1);
		expect(out).toMatch(/function repairRun\([\s\S]*?if \(!confirm\(/);
	});

	test("the rebuild reports its result before reloading rather than refreshing silently", () => {
		const out = html("done");
		expect(out).toMatch(/alert\(body\.message[\s\S]*?location\.reload\(\)/);
	});

	test("live updates replace the old whole-page reload — no setInterval ever calls location.reload", () => {
		// The 8s poll + its menu/learn-dialog guard used to live only when a
		// month was active/queued; live updates (SSE + the 30s JSON fallback)
		// are unconditional now, so this must hold for every status, not just
		// a busy one. Asserts the actual invariants — exactly the two
		// deliberate setIntervals (the 30s fallback, and ticket #2's 30s
		// run-card elapsed-time tick) — rather than a brace-matching regex:
		// /setInterval\([^)]*\{.../ can never match `setInterval(function () {`
		// (the `)` inside `function ()` breaks `[^)]*` before it reaches `{`),
		// so that regex would still pass with the old 8s reload poll pasted
		// back in verbatim.
		//
		// MINOR 7 (validator finding): counting `location.reload()` matches
		// across the WHOLE page used to include prose mentions inside comments
		// (e.g. "...NOT call location.reload()..."), not just real call sites —
		// fragile in both directions, since adding or removing a comment could
		// silently change the count without touching a single real call. Strip
		// `//` line comments before counting, and separately pin the two real
		// call sites by name (startRun/retryRun/stopRun/repairRun never call
		// it — only postAction's success path and rebuildReviewData's own
		// explicit reload do) plus a standing assertion that the old 8s poll's
		// literal interval never reappears.
		const stripLineComments = (src: string) =>
			src
				.split("\n")
				.map((line) => line.replace(/\/\/.*$/, ""))
				.join("\n");

		for (const status of ["done", "stage-running", "idle"] as DisplayStatus[]) {
			const out = html(status);
			expect(out.match(/setInterval\(/g) ?? []).toHaveLength(2);
			expect(out).toContain("setInterval(pollClientsFallback, 30000)");
			expect(out).toContain("setInterval(tickRunCards, 30000)");
			expect(out).not.toContain("}, 8000)");

			const withoutComments = stripLineComments(out);
			expect(withoutComments.match(/location\.reload\(\)/g) ?? []).toHaveLength(2);
			expect(withoutComments).toMatch(/async function postAction\([\s\S]*?location\.reload\(\);/);
			expect(withoutComments).toMatch(/async function rebuildReviewData\([\s\S]*?location\.reload\(\);/);
		}
	});

	test("a live push is deferred while the row's own menu is open, and flushed once it closes", () => {
		const out = html("done");
		expect(out).toContain("function swapRow(relPath, outerHtml, seq)");
		expect(out).toContain("pendingSwaps[relPath] = outerHtml");
		// flushPending() is what flushes a deferred swap back in — shared by
		// closeMenus() (closed via elsewhere/Escape/another row's menu) AND
		// toggleMenu() (closed via the row's own "⋯" button, which never
		// reaches closeMenus() for its own wrap and stops propagation, so
		// without this shared flush a swap deferred on that row would be
		// stranded — see the "closing a menu via its own" test below).
		expect(out).toMatch(/function flushPending\(row\)[\s\S]*?pendingSwaps\[relPath\][\s\S]*?applyRowSwap\(row, html\)/);
		expect(out).toMatch(/function closeMenus\([\s\S]*?flushPending\(/);
	});

	test("the 30s JSON fallback never reloads the page, and reconciles status via the DOM", () => {
		const out = html("done");
		expect(out).toContain("pollClientsFallback");
		expect(out).toContain('fetch("/api/clients")');
		expect(out).toContain("setInterval(pollClientsFallback, 30000)");
		expect(out).not.toMatch(/pollClientsFallback[\s\S]*?location\.reload\(\)/);
	});

	test("status-chip counts and the attention pill are recomputed from data-status, not tracked separately", () => {
		const out = html("done");
		expect(out).toContain("function recomputeStatusUI()");
		expect(out).toContain('document.querySelectorAll("tr.run-row")');
		expect(out).toContain('id="attn-pill"');
	});

	test("the panel escapes the table's overflow clip instead of being cut off by it", () => {
		const out = html("done");
		// The table clips (border-radius + overflow:hidden), so an absolutely
		// positioned panel would be cut at the table edge — this is the bug this
		// asserts against.
		expect(out).toContain("table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden;");
		expect(out).toMatch(/\.menu \{\s*display: none; position: fixed;/);
		expect(out).not.toMatch(/\.menu \{[^}]*position: absolute/);
	});

	test("a fixed panel is placed from the trigger rect, clamped, flipped and kept in sync", () => {
		const out = html("done");
		expect(out).toContain("function placeMenu(wrap)");
		expect(out).toContain("btn.getBoundingClientRect()");
		// clamped to the viewport on both axes
		expect(out).toContain("window.innerWidth - w - 8");
		expect(out).toContain('Math.max(8, left) + "px"');
		// flips above the trigger rather than running off the bottom
		expect(out).toContain("if (top + h > window.innerHeight - 8) top = r.top - h - 4;");
		// and follows its row when the page moves
		expect(out).toContain('window.addEventListener("scroll", repositionOpenMenu');
		expect(out).toContain('window.addEventListener("resize", repositionOpenMenu)');
	});

	test("month ids reach the menu through the JSON-escaping onclick helper", () => {
		const out = html("done", { monthId: 'เดือน"x' });
		expect(out).toContain("&quot;");
		expect(out).not.toContain('rebuildReviewData("216", "เดือน"x")');
	});
});

describe("dashboard — เรียนรู้ (ticket #43)", () => {
	test("the menu offers learning, and says out loud that it is client-wide, not this month", () => {
		const items = menu(html("done"));
		expect(items).toContain("เรียนรู้จากการแก้ไข");
		expect(items).toContain("ทุกเดือน");
		expect(items).toContain('openLearn(&quot;216&quot;)');
	});

	test("a month that never ran offers no menu, so no learning entry either", () => {
		expect(menu(html("idle"))).toBe("");
	});

	test("the review dialog is part of the page, closed, with its confirm button hidden until there is something to confirm", () => {
		const out = html("done");
		expect(out).toContain('id="learn-modal"');
		expect(out).toMatch(/id="learn-modal"[^>]*hidden/);
		expect(out).toMatch(/id="learn-confirm"[^>]*hidden/);
	});

	test("proposing and applying are two separate posts — nothing is written by opening the dialog", () => {
		const out = html("done");
		expect(out).toContain('"/api/learn/" + encodeURIComponent(clientId)');
		expect(out).toContain('"/api/learn/" + encodeURIComponent(learnState.clientId) + "/apply"');
		// the accept list is built from the checkboxes the human left ticked
		expect(out).toContain('document.querySelectorAll("#learn-body .learn-cb")');
	});

	test("proposal rows are built with textContent — client document text never reaches innerHTML", () => {
		const out = html("done");
		expect(out).toContain("function learnRow(p)");
		expect(out).not.toMatch(/learn-row[\s\S]{0,400}innerHTML/);
	});

	test("a failed agent pass is surfaced, not hidden behind pre-ticked boxes", () => {
		expect(html("done")).toContain("AI ตรวจให้ไม่สำเร็จรอบนี้");
	});
});

describe("dashboard — บันทึกที่ค้างอยู่ (ticket #47)", () => {
	test("stored notes render even with no fresh proposals — the whole point of the ticket", () => {
		const out = html("done");
		// Neither the fetch of proposals nor renderLearn's gate on hasWork
		// should prevent the notes section from being built.
		expect(out).toContain("function renderNotes(");
		expect(out).toContain("storedNotes");
		expect(out).toContain("data.storedNotes || []");
	});

	test("unhandled notes are listed unchecked, handled notes sit collapsed and pre-checked", () => {
		const out = html("done");
		expect(out).toContain("createElement(\"details\")");
		expect(out).toContain("learn-note-cb");
		expect(out).toContain("cb.checked = n.handled");
	});

	test("confirming sends handled ids alongside accept/sources/notes", () => {
		const out = html("done");
		expect(out).toMatch(/JSON\.stringify\(\{\s*accept: accept, sources: learnState\.sources, notes: notes, handled: handled\s*\}\)/);
		expect(out).toContain("learn-note-cb");
	});

	test("the confirm button's visibility uses hasAnythingToConfirm, not hasWork alone", () => {
		const out = html("done");
		expect(out).toContain("hasAnythingToConfirm(");
		expect(out).not.toMatch(/if \(proposals\.length === 0\) return;\s*\n\s*document\.getElementById\("learn-confirm"\)\.hidden = false;/);
	});

	test("note rows are built with textContent, never innerHTML", () => {
		const out = html("done");
		expect(out).toContain("function noteRow(");
		// File-wide rather than a window around noteRow: the only innerHTML
		// uses in this page are the button spinner's save/restore of its own
		// static label, applyRowSwap's one-time parse of the trusted,
		// server-rendered row markup pushed over SSE, and swapCards' equivalent
		// swap of the trusted, server-rendered active-run card strip (ticket
		// #2). Note text itself comes from client documents and is never
		// routed through innerHTML — so the assertion is on the total, which
		// cannot rot as noteRow grows.
		expect(out.match(/\.innerHTML/g) ?? []).toHaveLength(5);
		expect(out).toMatch(/var originalText = btn\.innerHTML;/);
	});

	test("has .learn-note- CSS that stays visually subordinate to proposals", () => {
		const out = html("done");
		expect(out).toMatch(/\.learn-note-/);
	});
});

describe("dashboard — live updates keep the whole page correct, not just the swapped row", () => {
	test("every status in STATUS_FILTER_ORDER gets a chip even at zero count, hidden rather than absent", () => {
		// Only "done" has any months in html("done") — every other status chip
		// must still exist in the markup (hidden), or a status that first
		// appears later (no more reload to rebuild the chip bar) would give the
		// operator no way to filter for it at all.
		const out = html("done");
		expect(out).toContain('data-status="idle"');
		expect(out).toMatch(/data-status="idle"[^>]* hidden>/);
		expect(out).toMatch(/data-status="done"[^>]*>(?!.* hidden)/);
	});

	test("a hidden chip actually disappears — .chip[hidden] overrides the base display:inline-flex", () => {
		const out = html("done");
		expect(out).toMatch(/\.chip\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
	});

	test("recomputeStatusUI hides an emptied chip, un-hides a newly nonzero one, and drops it from activeStatuses", () => {
		const out = html("done");
		expect(out).toContain("chip.hidden = n === 0;");
		expect(out).toMatch(/if \(n === 0 && activeStatuses\.has\(s\)\)/);
	});

	test("recomputeStatusUI also rebuilds each client's N/M เดือนเสร็จแล้ว progress from the DOM", () => {
		const out = html("done");
		expect(out).toContain('document.querySelectorAll(".client-progress")');
		expect(out).toContain('เดือนเสร็จแล้ว');
		// the span carries the client code so recompute can target it per client
		expect(out).toMatch(/<span class="client-progress" data-code="[^"]*">/);
	});

	test("closing a menu via its own ⋯ button flushes any swap deferred while it was open", () => {
		// toggleMenu never reaches closeMenus() for its own wrap (closeMenus
		// skips `except`) and stops propagation, so the document-level
		// closeMenus(null) never runs either — without an explicit flush here a
		// swap deferred while the menu was open would be stranded forever.
		const out = html("done");
		expect(out).toMatch(/function toggleMenu\(btn\) \{[\s\S]*?flushPending\(wrap\.closest\("tr\.run-row"\)\)/);
		expect(out).toContain("function flushPending(row)");
	});

	test("a direct row apply always invalidates a still-pending deferred update for the same row", () => {
		// Otherwise a later menu close on that row could replay stale HTML over
		// a row that a subsequent direct update had already corrected.
		const out = html("done");
		const flushBody = out.match(/function swapRow\(relPath, outerHtml, seq\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(flushBody).toContain("delete pendingSwaps[relPath];");
	});

	test("the 30s fallback poll swaps full row markup instead of only patching data-status", () => {
		// A poll that only wrote data-status would leave the pill, detail/time
		// cells and action button frozen while the attribute moved underneath
		// them. MAJOR 1 (validator finding) moved this from a bare swapRow loop
		// into reconcileDashboard, which now ALSO handles membership — but the
		// full-markup-swap behavior for a row that's staying must still hold.
		const out = html("done");
		const pollBody = out.match(/async function pollClientsFallback\(\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(pollBody).toContain("reconcileDashboard(data)");
		expect(pollBody).not.toContain("setAttribute(\"data-status\"");
		const reconcileBody = out.match(/function reconcileDashboard\(data\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(reconcileBody).toContain("applyRowSwapQuiet(row, m.html)");
	});

	test("the 30s fallback poll also refreshes the run-card strip unconditionally, not just changed rows", () => {
		// The card strip's ONLY other refresh path is the SSE push — in the
		// exact scenario the fallback exists for (a proxy blocking the SSE
		// connection), the card would otherwise render once at page load and
		// never update again: stale stage, stale log, a "■ หยุด" button offered
		// for a run that has since finished. swapCards must run every tick,
		// not conditionally on a row's status having changed.
		const out = html("done");
		const pollBody = out.match(/async function pollClientsFallback\(\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(pollBody).toContain("swapCards(data.cardsHtml, data.seq)");
	});

	test("the 30s fallback poll threads data.seq into both swapCards and the reconcile pass, not just an unconditional apply", () => {
		// Validator finding (ticket #3, round 2): buildDashboardClients() behind
		// GET /api/clients is not instant (full workspace scan + per-active-run
		// readStageProgress), so a terminal SSE notification can land while this
		// fetch is still in flight. Without threading server.ts's shared seq
		// counter through, the fallback's swaps skip the `typeof seq === "number"`
		// guard entirely and can repaint a pre-terminal row/card over the newer
		// SSE-delivered terminal state — and nothing ever corrects it, since a
		// finished run emits no further notifications.
		const out = html("done");
		const pollBody = out.match(/async function pollClientsFallback\(\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(pollBody).toContain("swapCards(data.cardsHtml, data.seq)");
		expect(pollBody).toContain("reconcileDashboard(data)");
		const reconcileBody = out.match(/function reconcileDashboard\(data\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(reconcileBody).toContain("typeof data.seq === \"number\"");
	});
});

describe("dashboard — fallback-poll membership reconciliation (MAJOR 1)", () => {
	test("a row missing from the DOM is inserted from the payload's own html, not built client-side", () => {
		const out = html("done");
		const body = out.match(/function reconcileDashboard\(data\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(body).toContain("var row = findRunRow(m.relPath);");
		expect(body).toMatch(/if \(!row\) \{[\s\S]*?row = htmlToElement\(m\.html\);/);
	});

	test("a row the payload no longer lists is removed from the DOM", () => {
		const out = html("done");
		const body = out.match(/function reconcileDashboard\(data\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(body).toMatch(/if \(!seenRelPaths\[row\.getAttribute\("data-relpath"\)\]\) row\.remove\(\);/);
	});

	test("a wholly new client's header and no-match-row are inserted from the payload, never built in the browser", () => {
		const out = html("done");
		const body = out.match(/function reconcileDashboard\(data\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(body).toContain("findClientHeader(client.clientId) || htmlToElement(client.headerHtml)");
		expect(body).toContain("findNoMatchRow(client.clientId) || htmlToElement(client.noMatchHtml)");
	});

	test("a client no longer in the payload has its header and no-match-row removed too", () => {
		const out = html("done");
		const body = out.match(/function reconcileDashboard\(data\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(body).toMatch(/tr\.client-header, tr\.no-match-row[\s\S]*?if \(!seenCodes\[row\.getAttribute\("data-code"\)\]\) row\.remove\(\);/);
	});

	test("recomputeStatusUI and applyFilters run exactly once per reconcile pass, not once per row", () => {
		const out = html("done");
		const body = out.match(/function reconcileDashboard\(data\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? "";
		expect(body.match(/recomputeStatusUI\(\)/g) ?? []).toHaveLength(1);
		expect(body.match(/applyFilters\(\)/g) ?? []).toHaveLength(1);
		// and they run at the very end of the function, after both the
		// insert/update loop and the two removal passes
		const recomputeIdx = body.indexOf("recomputeStatusUI()");
		const lastRemoveIdx = body.lastIndexOf(".remove()");
		expect(recomputeIdx).toBeGreaterThan(lastRemoveIdx);
	});

	// MAJOR 3 (validator finding, round 2): dashboard-reconcile.ts's
	// diffDashboardMembership() has no production importer — the browser's
	// inline reconcileDashboard (above) is a hand-maintained mirror of its
	// membership semantics, never the same code path. Unlike computeElapsedText
	// (MINOR 4), the tests around reconcileDashboard up to this point only
	// assert against its *source text* (regex/substring matches), which cannot
	// catch a logic error in ensurePosition's cursor walk or the ordering of
	// the two removal passes. This closes that gap by actually RUNNING the
	// real emitted reconcileDashboard (plus every helper it calls) against a
	// hand-rolled DOM stub — no DOM library is installed in this repo — and
	// asserting its insert/remove decisions match diffDashboardMembership
	// across the same table of cases.
	describe("reconcileDashboard (browser) and diffDashboardMembership (pure) agree on membership", () => {
		/** A minimal element sufficient to drive the real htmlToElement/
		 * ensurePosition/reconcileDashboard against: attribute storage, a
		 * parent-tracked sibling chain, and the handful of DOM methods those
		 * functions actually call (insertAdjacentElement, insertBefore, remove,
		 * replaceWith). querySelector is stubbed to null — none of this test's
		 * fixture rows use the row-menu markup isMenuOpenRow looks for, so every
		 * row is treated as not mid-menu, same as steady state. */
		class FakeElement {
			tag: string;
			attrs: Record<string, string> = {};
			children: FakeElement[] = [];
			parent: FakeElement | null = null;
			constructor(tag: string) {
				this.tag = tag;
			}
			getAttribute(name: string) {
				return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
			}
			querySelector(_sel: string): FakeElement | null {
				return null;
			}
			get firstElementChild(): FakeElement | null {
				return this.children[0] ?? null;
			}
			get nextElementSibling(): FakeElement | null {
				if (!this.parent) return null;
				const idx = this.parent.children.indexOf(this);
				return this.parent.children[idx + 1] ?? null;
			}
			set innerHTML(raw: string) {
				const parsed = parseOneElement(raw);
				this.children = parsed ? [parsed] : [];
				if (parsed) parsed.parent = this;
			}
			insertAdjacentElement(pos: string, el: FakeElement) {
				if (pos !== "afterend") throw new Error(`FakeElement stub doesn't support insertAdjacentElement(${pos})`);
				if (!this.parent) throw new Error("insertAdjacentElement called on a detached element");
				detach(el);
				const idx = this.parent.children.indexOf(this);
				this.parent.children.splice(idx + 1, 0, el);
				el.parent = this.parent;
			}
			insertBefore(el: FakeElement, ref: FakeElement | null) {
				detach(el);
				const idx = ref ? this.children.indexOf(ref) : this.children.length;
				this.children.splice(idx === -1 ? this.children.length : idx, 0, el);
				el.parent = this;
			}
			remove() {
				detach(this);
			}
			replaceWith(el: FakeElement) {
				if (!this.parent) throw new Error("replaceWith called on a detached element");
				const idx = this.parent.children.indexOf(this);
				this.parent.children.splice(idx, 1, el);
				el.parent = this.parent;
				this.parent = null;
			}
		}

		function detach(el: FakeElement) {
			if (!el.parent) return;
			const idx = el.parent.children.indexOf(el);
			if (idx !== -1) el.parent.children.splice(idx, 1);
			el.parent = null;
		}

		/** Parses ONE top-level `<tag attr="val" ...>` open tag out of a
		 * trusted, hand-built fixture string — this test only ever feeds it
		 * self-closing-shaped `<tr .../>`-style rows it built itself, so a
		 * regex is enough; it's standing in for the browser's real HTML
		 * parser, not re-implementing one. */
		function parseOneElement(raw: string): FakeElement | null {
			const m = raw.match(/^<(\w+)([^>]*)>/);
			if (!m) return null;
			const el = new FakeElement(m[1]);
			const attrRe = /([\w-]+)="([^"]*)"/g;
			let am: RegExpExecArray | null;
			while ((am = attrRe.exec(m[2]))) el.attrs[am[1]] = am[2];
			return el;
		}

		function matchesCompoundSelector(el: FakeElement, compound: string): boolean {
			const m = compound.trim().match(/^(\w+)((?:\.[\w-]+)*)$/);
			if (!m) return false;
			if (el.tag !== m[1]) return false;
			const classes = (m[2].match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1));
			const elClasses = (el.attrs.class ?? "").split(/\s+/);
			return classes.every((c) => elClasses.includes(c));
		}

		/** Builds the fake `document` reconcileDashboard's extracted source
		 * expects: querySelector("tbody"), querySelectorAll(selector) scoped to
		 * the tbody's direct children (every fixture row here is a direct
		 * child, same as the real table), and createElement for htmlToElement's
		 * own `document.createElement("tbody")` scratch-parse trick. */
		function makeFakeDocument() {
			const tbody = new FakeElement("tbody");
			return {
				tbody,
				document: {
					querySelector(sel: string) {
						return sel === "tbody" ? tbody : null;
					},
					querySelectorAll(sel: string) {
						const parts = sel.split(",").map((s) => s.trim());
						return tbody.children.filter((el) => parts.some((p) => matchesCompoundSelector(el, p)));
					},
					createElement(tag: string) {
						return new FakeElement(tag);
					},
				},
			};
		}

		/** Concatenates the real emitted source of reconcileDashboard and every
		 * helper it calls by name (ensurePosition, findRunRow, findClientHeader,
		 * findNoMatchRow, isMenuOpenRow, htmlToElement, applyRowSwapQuiet) —
		 * extracted, not hand-copied — and compiles them as one script sharing
		 * one scope, exactly like they share the page's single inline
		 * `<script>` block in production. */
		function extractReconcileScript(out: string): string {
			return [
				"ensurePosition",
				"findRunRow",
				"findClientHeader",
				"findNoMatchRow",
				"isMenuOpenRow",
				"htmlToElement",
				"applyRowSwapQuiet",
				"reconcileDashboard",
			]
				.map((name) => extractFunctionSource(out, name))
				.join("\n");
		}

		type FixtureClient = { clientId: string; relPaths: string[] };

		function rowHtml(relPath: string, code: string) {
			return `<tr class="run-row" data-relpath="${relPath}" data-code="${code}"></tr>`;
		}
		function headerHtml(code: string) {
			return `<tr class="client-header" data-code="${code}"></tr>`;
		}
		function noMatchHtml(code: string) {
			return `<tr class="no-match-row" data-code="${code}"></tr>`;
		}

		/** Seeds the fake tbody with header + row(s) + no-match-row for each
		 * fixture client, in order — the DOM state reconcileDashboard would see
		 * on a page that already rendered these clients once. */
		function seedExisting(tbody: FakeElement, clients: FixtureClient[]) {
			for (const c of clients) {
				tbody.children.push(Object.assign(new FakeElement("tr"), { attrs: { class: "client-header", "data-code": c.clientId }, parent: tbody }));
				for (const relPath of c.relPaths) {
					tbody.children.push(
						Object.assign(new FakeElement("tr"), { attrs: { class: "run-row", "data-relpath": relPath, "data-code": c.clientId }, parent: tbody }),
					);
				}
				tbody.children.push(Object.assign(new FakeElement("tr"), { attrs: { class: "no-match-row", "data-code": c.clientId }, parent: tbody }));
			}
		}

		function toPayload(clients: FixtureClient[]) {
			return {
				clients: clients.map((c) => ({
					clientId: c.clientId,
					headerHtml: headerHtml(c.clientId),
					noMatchHtml: noMatchHtml(c.clientId),
					months: c.relPaths.map((relPath) => ({ relPath, html: rowHtml(relPath, c.clientId) })),
				})),
			};
		}

		const cases: { name: string; existing: FixtureClient[]; payload: FixtureClient[] }[] = [
			{
				name: "steady state — nothing changes",
				existing: [{ clientId: "216", relPaths: ["216/a", "216/b"] }],
				payload: [{ clientId: "216", relPaths: ["216/a", "216/b"] }],
			},
			{
				name: "a month is added to an existing client",
				existing: [{ clientId: "216", relPaths: ["216/a"] }],
				payload: [{ clientId: "216", relPaths: ["216/a", "216/b"] }],
			},
			{
				name: "a month disappears from an existing client",
				existing: [{ clientId: "216", relPaths: ["216/a", "216/b"] }],
				payload: [{ clientId: "216", relPaths: ["216/a"] }],
			},
			{
				name: "a wholly new client appears",
				existing: [{ clientId: "216", relPaths: ["216/a"] }],
				payload: [
					{ clientId: "216", relPaths: ["216/a"] },
					{ clientId: "345", relPaths: ["345/a"] },
				],
			},
			{
				name: "a client disappears entirely",
				existing: [
					{ clientId: "216", relPaths: ["216/a"] },
					{ clientId: "345", relPaths: ["345/a"] },
				],
				payload: [{ clientId: "216", relPaths: ["216/a"] }],
			},
			{
				name: "simultaneous add, remove, and untouched rows across two clients",
				existing: [
					{ clientId: "216", relPaths: ["216/a", "216/b"] },
					{ clientId: "345", relPaths: ["345/a"] },
				],
				payload: [
					{ clientId: "216", relPaths: ["216/a", "216/c"] },
					{ clientId: "777", relPaths: ["777/a"] },
				],
			},
		];

		for (const { name, existing, payload } of cases) {
			test(name, () => {
				const out = html("done");
				const script = extractReconcileScript(out);
				const { tbody, document } = makeFakeDocument();
				seedExisting(tbody, existing);

				const run = new Function(
					"document",
					"recomputeStatusUI",
					"applyFilters",
					"pendingSwaps",
					"lastRowSeq",
					"data",
					`${script}\nreconcileDashboard(data);`,
				);
				run(document, () => {}, () => {}, {}, {}, toPayload(payload));

				const finalRelPaths = tbody.children.filter((el) => el.tag === "tr" && el.attrs.class === "run-row").map((el) => el.attrs["data-relpath"]);
				const finalClientCodes = new Set(
					tbody.children.filter((el) => el.attrs.class === "client-header").map((el) => el.attrs["data-code"]),
				);

				const existingRelPaths = existing.flatMap((c) => c.relPaths);
				const existingClientCodes = existing.map((c) => c.clientId);
				const diff = diffDashboardMembership(existingRelPaths, existingClientCodes, toPayload(payload).clients);

				// What survives in the real, DOM-driven reconcileDashboard must be
				// exactly what the pure diff says should survive: everything the
				// payload lists, nothing it doesn't.
				const payloadRelPaths = payload.flatMap((c) => c.relPaths);
				const payloadClientCodes = payload.map((c) => c.clientId);
				expect(finalRelPaths.sort()).toEqual([...payloadRelPaths].sort());
				expect([...finalClientCodes].sort()).toEqual([...new Set(payloadClientCodes)].sort());

				// And directly: every relPath/code the pure diff says to insert
				// actually shows up net-new, and everything it says to remove is
				// actually gone, in the real DOM-driven run.
				for (const relPath of diff.insertRelPaths) expect(finalRelPaths).toContain(relPath);
				for (const relPath of diff.removeRelPaths) expect(finalRelPaths).not.toContain(relPath);
				for (const code of diff.insertClientCodes) expect(finalClientCodes.has(code)).toBe(true);
				for (const code of diff.removeClientCodes) expect(finalClientCodes.has(code)).toBe(false);
			});
		}
	});

	test("renderClientHeader and renderNoMatchRow are exported and byte-identical to what renderDashboard itself emits", () => {
		const clients: DashboardClient[] = [
			{ clientId: "216", companyName: "บริษัท ทดสอบ จำกัด", months: [month()] },
		];
		const page = renderDashboard(clients);
		expect(page).toContain(renderClientHeader(clients[0]));
		expect(page).toContain(renderNoMatchRow("216"));
	});

	test("buildClientsPayload ships headerHtml/noMatchHtml/per-month html for every client", () => {
		const clients: DashboardClient[] = [
			{ clientId: "216", companyName: "บริษัท ทดสอบ จำกัด", months: [month()] },
		];
		const payload = buildClientsPayload(clients);
		expect(payload).toHaveLength(1);
		expect(payload[0].headerHtml).toBe(renderClientHeader(clients[0]));
		expect(payload[0].noMatchHtml).toBe(renderNoMatchRow("216"));
		expect(payload[0].months[0].html).toBe(renderMonthRow("216", clients[0].months[0]));
	});
});

describe("dashboard — the active-run card (ticket #2)", () => {
	test("renders all 8 log lines, newest first, not just the last one", () => {
		const log = Array.from({ length: 8 }, (_, i) => `interpret: step ${i}`);
		const out = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({ displayStatus: "stage-running", log }));
		expect(out).toContain("บันทึกการทำงาน (8)");
		for (const line of log) expect(out).toContain(line);
		// newest first: the last log entry appears before the first one in the markup
		const lastIdx = out.indexOf("interpret: step 7");
		const firstIdx = out.indexOf("interpret: step 0");
		expect(lastIdx).toBeGreaterThan(-1);
		expect(lastIdx).toBeLessThan(firstIdx);
	});

	test("the step strip marks exactly stageIndex as current, earlier ones done, later ones pending", () => {
		const stageIndex = 2;
		const out = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({ displayStatus: "stage-running", stageIndex }));
		const doneCount = (out.match(/step-done/g) ?? []).length;
		const currentCount = (out.match(/step-current/g) ?? []).length;
		const pendingCount = (out.match(/step-pending/g) ?? []).length;
		expect(doneCount).toBe(stageIndex);
		expect(currentCount).toBe(1);
		expect(pendingCount).toBe(STAGES.length - stageIndex - 1);
	});

	test("the step strip never hardcodes STAGES.length — it always emits exactly that many steps", () => {
		const out = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({ displayStatus: "stage-running", stageIndex: 0 }));
		expect((out.match(/class="step /g) ?? []).length).toBe(STAGES.length);
	});

	test("renderRunCards is empty when no month is active or queued", () => {
		const clients: DashboardClient[] = [
			{ clientId: "216", companyName: "บริษัท ทดสอบ จำกัด", months: [month({ displayStatus: "done" }), month({ displayStatus: "idle" })] },
		];
		expect(renderRunCards(clients)).toBe("");
	});

	test("renderDashboard mounts no card strip when nothing is active or queued", () => {
		const out = html("done");
		expect(out).toContain('id="run-cards-container"');
		expect(out).toContain('<div id="run-cards-container"></div>');
	});

	test("renderDashboard mounts a card when a month is active or queued", () => {
		const out = html("stage-running");
		expect(out).toContain('class="run-cards"');
		expect(out).toContain('class="run-card"');
	});

	test("a run-state.yaml with no stageStartedAt omits the ขั้นนี้ clause", () => {
		const withStage = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({
			displayStatus: "stage-running",
			startedAt: "2026-07-28T10:00:00.000Z",
			stageStartedAt: "2026-07-28T10:30:00.000Z",
		}));
		expect(withStage).toContain("ขั้นนี้");

		const withoutStage = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({
			displayStatus: "stage-running",
			startedAt: "2026-07-28T10:00:00.000Z",
			stageStartedAt: null,
		}));
		expect(withoutStage).toContain("ผ่านไป");
		expect(withoutStage).not.toContain("ขั้นนี้");
	});

	test("card content is HTML-escaped", () => {
		const out = renderRunCard("216", '<img src=x onerror=alert(1)>', month({
			displayStatus: "stage-running",
			log: ['<script>alert("xss")</script>'],
		}));
		expect(out).not.toContain("<img src=x");
		expect(out).not.toContain("<script>alert");
		expect(out).toContain("&lt;img src=x");
		expect(out).toContain("&lt;script&gt;");
	});

	test("the card's stop button reuses the existing stopRun() action", () => {
		const out = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({ displayStatus: "stage-running", monthId: "04-69" }));
		expect(out).toContain("■ หยุด");
		expect(out).toContain("stopRun");
		expect(out).toContain("216");
		expect(out).toContain("04-69");
	});

	test("re-render on an SSE update swaps the run-cards-container's innerHTML", () => {
		const out = html("stage-running");
		expect(out).toContain("function swapCards(cardsHtml, seq)");
		expect(out).toContain('document.getElementById("run-cards-container")');
		expect(out).toMatch(/msg\.cardsHtml/);
	});

	test("swapCards preserves an open บันทึกการทำงาน <details> across the innerHTML swap", () => {
		// The innerHTML swap itself is unavoidable (the whole card strip is
		// re-rendered server-side), but without capturing/restoring [open] by
		// data-relpath, any log panel the operator had expanded snaps shut on
		// the very next push — the ticket's own "free win" collapsing under the
		// operator every time the run advances.
		const out = html("stage-running");
		expect(out).toMatch(/function swapCards\(cardsHtml, seq\) \{[\s\S]*?querySelectorAll\("\.run-card-log\[open\]"\)/);
		expect(out).toMatch(/function swapCards\(cardsHtml, seq\) \{[\s\S]*?details\.open = true;/);
	});

	test("swapCards and swapRow ignore a message whose seq is lower than the last one applied", () => {
		// server.ts serialises every dashboard rebuild onto one chain and
		// stamps a strictly-increasing seq — this is the client-side half of
		// that defense: an out-of-order delivery must not paint a stale card
		// strip or row over a newer one.
		const out = html("stage-running");
		expect(out).toMatch(/function swapCards\(cardsHtml, seq\) \{\s*if \(typeof seq === "number"\) \{\s*if \(seq < lastCardsSeq\) return;/);
		expect(out).toMatch(/function swapRow\(relPath, outerHtml, seq\) \{\s*if \(typeof seq === "number"\) \{/);
	});

	test("the elapsed-time text is recomputed client-side every 30s from data-started-at/data-stage-started-at", () => {
		// The card only re-renders on an orchestrator notification (stage/
		// attempt boundaries, minutes to an hour apart) — without a client-side
		// tick, "ผ่านไป N นาที" would freeze for the entire duration of a long
		// stage like interpret.
		const out = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({
			displayStatus: "stage-running",
			startedAt: "2026-07-28T10:00:00.000Z",
			stageStartedAt: "2026-07-28T10:30:00.000Z",
		}));
		expect(out).toContain('data-started-at="2026-07-28T10:00:00.000Z"');
		expect(out).toContain('data-stage-started-at="2026-07-28T10:30:00.000Z"');
		expect(out).toContain('class="run-card-elapsed"');

		const page = html("stage-running");
		expect(page).toContain("function computeElapsedText(startedAt, stageStartedAt)");
		expect(page).toContain("function tickRunCards()");
	});

	// MINOR 4 (validator finding): elapsedText() (server) and
	// computeElapsedText() (inline browser script) are a hand-maintained pair
	// with the same arithmetic and the same Thai strings, and nothing pinned
	// them together — a drift in either one would only ever be caught by eye.
	// This runs the REAL emitted computeElapsedText (extracted, not
	// hand-copied) against elapsedText() across a table of inputs, with
	// Date.now() pinned so both sides compute against the identical instant.
	test("elapsedText (server) and computeElapsedText (browser) produce identical output across a table of inputs", () => {
		const originalNow = Date.now;
		try {
			const NOW = new Date("2026-07-28T12:00:00.000Z").getTime();
			Date.now = () => NOW;

			const out = html("stage-running");
			const src = extractFunctionSource(out, "computeElapsedText");
			const runComputeElapsedText = (startedAt: string | null, stageStartedAt: string | null): string =>
				new Function("startedAt", "stageStartedAt", `${src}\nreturn computeElapsedText(startedAt, stageStartedAt);`)(startedAt, stageStartedAt);

			for (const ms of [0, 1, 59, 60, 61, 3600]) {
				const startedAt = new Date(NOW - ms).toISOString();
				// stageStartedAt null: the "· ขั้นนี้ N นาที" clause must be omitted
				// identically on both sides.
				const mNoStage = month({ displayStatus: "stage-running", startedAt, stageStartedAt: null });
				expect(runComputeElapsedText(startedAt, null)).toBe(elapsedText(mNoStage));

				// stageStartedAt present, offset by a different amount, on both sides.
				const stageStartedAt = new Date(NOW - ms - 30_000).toISOString();
				const mWithStage = month({ displayStatus: "stage-running", startedAt, stageStartedAt });
				expect(runComputeElapsedText(startedAt, stageStartedAt)).toBe(elapsedText(mWithStage));
			}

			// startedAt null (never started): the server side renders "" — the
			// browser side never calls computeElapsedText for such a card at all
			// (tickRunCards only targets rendered .run-card-elapsed spans, and
			// elapsedText's own "" means no card-time span carries a value to
			// re-derive from), so there is nothing to call it with — this just
			// pins the server-side null behavior explicitly.
			expect(elapsedText(month({ displayStatus: "stage-running", startedAt: null }))).toBe("");
		} finally {
			Date.now = originalNow;
		}
	});
});

describe("dashboard — real progress numbers (ticket #3)", () => {
	test("renderRunCard shows a real fraction and a clamped bar when progress exists", () => {
		const out = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({
			displayStatus: "stage-running",
			progress: { done: 5, total: 20, unitLabel: "หน่วยตีความ" },
		}));
		expect(out).toContain("5/20 หน่วยตีความ");
		expect(out).toContain("width:25%");
		expect(out).not.toContain("กำลังทำงาน</div>");
	});

	test("renderRunCard clamps a done count past total instead of rendering a >100% bar", () => {
		const out = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({
			displayStatus: "stage-running",
			progress: { done: 44, total: 42, unitLabel: "หน้า" },
		}));
		expect(out).toContain("44/42 หน้า");
		expect(out).toContain("width:100%");
	});

	test("renderRunCard falls back to a plain กำลังทำงาน line — no invented bar — when progress is null", () => {
		const out = renderRunCard("216", "บริษัท ทดสอบ จำกัด", month({ displayStatus: "stage-running", progress: null }));
		expect(out).not.toContain('class="run-card-bar"');
		expect(out).toContain("กำลังทำงาน</div>");
		// the elapsed clause (already live before #3) still carries "ผ่านไป N นาที"
		expect(out).toContain('class="run-card-elapsed"');
	});

	test("the row's detail cell appends the real fraction only when progress exists", () => {
		const withProgress = renderMonthRow("216", month({
			displayStatus: "stage-running",
			stageLabel: "Stage 2 — interpret",
			progress: { done: 3, total: 9, unitLabel: "หน่วยตีความ" },
		}));
		expect(withProgress).toContain("กำลังอยู่ที่ขั้น Stage 2 — interpret (3/9 หน่วยตีความ)");

		const withoutProgress = renderMonthRow("216", month({
			displayStatus: "stage-running",
			stageLabel: "Stage 0 — profile",
			progress: null,
		}));
		expect(withoutProgress).toContain('">กำลังอยู่ที่ขั้น Stage 0 — profile</td>');
	});
});

describe("dashboard — the ปริมาณ column (page/unit count per month)", () => {
	test("an exact count (the pipeline's own census) shows a plain number", () => {
		const out = renderMonthRow("216", month({ size: { units: 142, files: 36, archives: 0, exact: true } }));
		expect(out).toContain('data-label="ปริมาณ"');
		expect(out).toContain("142 หน้า");
		expect(out).toContain("36 ไฟล์");
		expect(out).not.toContain("~142");
	});

	test("a pre-run estimate is marked with ~ and says so in its tooltip", () => {
		const out = renderMonthRow("216", month({ displayStatus: "idle", size: { units: 142, files: 36, archives: 0, exact: false } }));
		expect(out).toContain("~142 หน้า");
		expect(out).toContain("ประมาณการก่อนเริ่มงาน");
	});

	test("an estimate holding an un-extracted zip admits its contents aren't counted", () => {
		const out = renderMonthRow("216", month({ displayStatus: "idle", size: { units: 12, files: 12, archives: 1, exact: false } }));
		expect(out).toContain("+zip");
		expect(out).toContain("ยังไม่ได้แตกไฟล์ zip 1 ไฟล์");
	});

	test("a count that hasn't landed yet renders as pending — never as 0 หน้า", () => {
		const out = renderMonthRow("216", month({ displayStatus: "idle", size: null }));
		expect(out).toContain('class="size-pending"');
		expect(out).not.toContain("0 หน้า");
	});

	test("a genuinely empty month folder says so instead of showing a bare 0", () => {
		const out = renderMonthRow("216", month({ displayStatus: "idle", size: { units: 0, files: 0, archives: 0, exact: false } }));
		expect(out).toContain("ไม่มีเอกสาร");
	});

	test("every row keeps the same column count as the client header's colspan", () => {
		const clients: DashboardClient[] = [
			{ clientId: "216", companyName: "บริษัท ทดสอบ จำกัด", months: [month({ displayStatus: "idle" })] },
		];
		const page = renderDashboard(clients);
		const cells = (renderMonthRow("216", month({ displayStatus: "idle" })).match(/<td/g) || []).length;
		const colspan = Number(page.match(/colspan="(\d+)"/)![1]);
		expect(cells).toBe(colspan);
		expect(renderNoMatchRow("216")).toContain(`colspan="${colspan}"`);
	});
});

describe("dashboard — estimated run time (applyEtaEstimates)", () => {
	function client(months: DashboardMonth[]): DashboardClient {
		return { clientId: "216", companyName: "บริษัท ทดสอบ จำกัด", months };
	}

	test("no estimate at all until enough finished runs exist to measure a rate", () => {
		const idle = month({ displayStatus: "idle", size: { units: 100, files: 20, archives: 0, exact: false } });
		const done = month({ displayStatus: "done", durationMin: 50, units: { total: 100, reviewed: 100, excluded: 0 } });
		applyEtaEstimates([client([idle, done])]);
		expect(idle.etaMin).toBeNull();
		expect(renderMonthRow("216", idle)).toContain(">—<");
	});

	test("two finished runs give every unstarted month an estimate from measured throughput", () => {
		const idle = month({ displayStatus: "idle", size: { units: 200, files: 40, archives: 0, exact: false } });
		const done1 = month({ displayStatus: "done", durationMin: 50, units: { total: 100, reviewed: 100, excluded: 0 } });
		const done2 = month({ displayStatus: "done", durationMin: 50, units: { total: 100, reviewed: 100, excluded: 0 } });
		applyEtaEstimates([client([idle, done1, done2])]);
		expect(idle.etaMin).toBe(100); // 200 pages at 0.5 min/page
		expect(renderMonthRow("216", idle)).toContain("คาดว่า ~1 ชม. 40 นาที");
		// a finished month keeps its real duration, never an estimate over it
		expect(done1.etaMin).toBeNull();
		expect(renderMonthRow("216", done1)).toContain("ใช้เวลา 50 นาที");
	});

	test("a month whose size hasn't landed yet gets no estimate", () => {
		const idle = month({ displayStatus: "idle", size: null });
		const done1 = month({ displayStatus: "done", durationMin: 50, units: { total: 100, reviewed: 100, excluded: 0 } });
		const done2 = month({ displayStatus: "done", durationMin: 60, units: { total: 100, reviewed: 100, excluded: 0 } });
		applyEtaEstimates([client([idle, done1, done2])]);
		expect(idle.etaMin).toBeNull();
	});
});
