// MAJOR 2 (validator finding): the /api/clients seq guard used to stamp
// `seq = ++eventSeq` AFTER buildDashboardClients() resolved, which guaranteed
// a stale fallback response would outrank any SSE broadcast minted while
// that same scan was still in flight. These tests pin the fix — snapshot
// BEFORE the scan starts — directly against the extracted pure helper.
import { describe, expect, test } from "bun:test";
import { snapshotThenScan } from "./seq-utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("snapshotThenScan", () => {
	test("snapshots seq before the scan starts, unaffected by a bump that happens while the scan is in flight", async () => {
		let counter = 0;
		const readSeq = () => counter;
		const scan = async () => {
			// Simulates an SSE broadcast (broadcastPending) incrementing the
			// shared eventSeq counter WHILE this fallback's own scan is still
			// pending — the exact race the bug allowed the fallback to win.
			counter = 5;
			return "clients-payload";
		};

		const { seq, result } = await snapshotThenScan(readSeq, scan);

		expect(seq).toBe(0); // the value BEFORE the scan, not 5 and not 6
		expect(result).toBe("clients-payload");
	});

	test("an uncontended scan (no bump) still returns the counter's value at call time", async () => {
		let counter = 3;
		const readSeq = () => counter;
		const scan = async () => "ok";

		const { seq } = await snapshotThenScan(readSeq, scan);

		expect(seq).toBe(3);
	});

	test("the buggy pre-fix behavior (stamping after resolve) would have returned the bumped value — demonstrating the regression this guards against", async () => {
		let counter = 0;
		const readSeq = () => counter;
		const scan = async () => {
			counter = 5;
			return "clients-payload";
		};

		// The old, broken shape: `const result = await scan(); const seq = readSeq();`
		const result = await scan();
		const buggySeq = readSeq();
		expect(buggySeq).toBe(5); // this is what let the stale response win

		// The fixed helper, run against the identical race, returns the seq
		// from BEFORE the scan instead.
		counter = 0; // reset the race for a clean second run through the fix
		const { seq: fixedSeq } = await snapshotThenScan(readSeq, scan);
		expect(fixedSeq).toBe(0);
		expect(fixedSeq).toBeLessThan(buggySeq);
	});
});

// Wiring pin (validator finding, MAJOR 2 follow-up): the two tests above only
// prove snapshotThenScan() itself is correct in isolation. Nothing stopped
// server.ts from importing it and then never actually calling it at either
// seq-sensitive call site (or reverting to `const seq = ++eventSeq;` AFTER an
// await, right back to the original bug) while the rest of the suite stayed
// green — server.ts can't be imported directly from a test (it calls
// Bun.serve()/orchestrator.boot() at module load), so this asserts against
// its source text instead: both the /api/clients handler and the SSE
// catch-up in eventsResponse() must call snapshotThenScan(), and the
// increment-after-resolve shape (`++eventSeq`) must appear exactly once in
// the whole file — the one legitimate site, broadcastPending, which mints a
// brand new seq for a push notification rather than reading an existing one.
describe("server.ts wiring to snapshotThenScan", () => {
	const serverSource = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

	test("calls snapshotThenScan(() => eventSeq, buildDashboardClients) at least twice — /api/clients and the SSE catch-up", () => {
		const calls = serverSource.match(/snapshotThenScan\(\(\) => eventSeq, buildDashboardClients\)/g) ?? [];
		expect(calls.length).toBeGreaterThanOrEqual(2);
	});

	test("`++eventSeq` appears exactly once in server.ts — only broadcastPending, never a seq-snapshot call site", () => {
		const incrementSites = serverSource.match(/\+\+eventSeq/g) ?? [];
		expect(incrementSites.length).toBe(1);
	});
});
