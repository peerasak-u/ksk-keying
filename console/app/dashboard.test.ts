import { describe, expect, test } from "bun:test";
import { renderDashboard, type DashboardClient, type DashboardMonth, type DisplayStatus } from "./dashboard";

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

	test("the 8s poll defers while a menu is open instead of yanking it away", () => {
		const busy = html("stage-running");
		expect(busy).toContain("setInterval");
		expect(busy).toContain('if (document.querySelector(".menu-wrap.is-open")) return;');
		// no active/queued month -> no poll at all
		expect(html("done")).not.toContain("setInterval");
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

	test("the poll defers while the dialog is open, so a half-reviewed list is never reloaded away", () => {
		const busy = html("stage-running");
		expect(busy).toContain('if (!document.getElementById("learn-modal").hidden) return;');
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
		// File-wide rather than a window around noteRow: the only innerHTML in
		// this page is the button spinner's save/restore of its own static
		// label. Any fourth occurrence is new, and note text comes from client
		// documents — so the assertion is on the total, which cannot rot as
		// noteRow grows.
		expect(out.match(/\.innerHTML/g) ?? []).toHaveLength(3);
		expect(out).toMatch(/var originalText = btn\.innerHTML;/);
	});

	test("has .learn-note- CSS that stays visually subordinate to proposals", () => {
		const out = html("done");
		expect(out).toMatch(/\.learn-note-/);
	});
});
