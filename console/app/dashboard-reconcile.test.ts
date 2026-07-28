// MAJOR 1 (validator finding) — see dashboard-reconcile.ts's own header
// comment for why this exists: swapRow() could only ever swap a row that
// already existed, so a client-month appearing or disappearing on disk
// between polls never showed up or never went away.
import { describe, expect, test } from "bun:test";
import { diffDashboardMembership, type ReconcilePayloadClient } from "./dashboard-reconcile";

function client(clientId: string, relPaths: string[]): ReconcilePayloadClient {
	return { clientId, months: relPaths.map((relPath) => ({ relPath })) };
}

describe("diffDashboardMembership", () => {
	test("a payload with a month the DOM has never seen is flagged for insertion", () => {
		const diff = diffDashboardMembership(
			["216/เดือนพฤษภาคม"],
			["216"],
			[client("216", ["216/เดือนพฤษภาคม", "216/เดือนมิถุนายน"])],
		);
		expect(diff.insertRelPaths).toEqual(["216/เดือนมิถุนายน"]);
		expect(diff.removeRelPaths).toEqual([]);
		expect(diff.insertClientCodes).toEqual([]);
		expect(diff.removeClientCodes).toEqual([]);
	});

	test("a payload missing a month the DOM has is flagged for removal", () => {
		const diff = diffDashboardMembership(
			["216/เดือนพฤษภาคม", "216/เดือนมิถุนายน"],
			["216"],
			[client("216", ["216/เดือนพฤษภาคม"])],
		);
		expect(diff.removeRelPaths).toEqual(["216/เดือนมิถุนายน"]);
		expect(diff.insertRelPaths).toEqual([]);
	});

	test("a wholly new client is flagged for header insertion, along with its month", () => {
		const diff = diffDashboardMembership([], [], [client("345", ["345/เดือนกรกฎาคม"])]);
		expect(diff.insertClientCodes).toEqual(["345"]);
		expect(diff.insertRelPaths).toEqual(["345/เดือนกรกฎาคม"]);
	});

	test("a client with no months left in the payload is flagged for full removal (header + any leftover rows)", () => {
		const diff = diffDashboardMembership(
			["216/เดือนพฤษภาคม"],
			["216"],
			[], // client 216 vanished entirely from the payload
		);
		expect(diff.removeClientCodes).toEqual(["216"]);
		expect(diff.removeRelPaths).toEqual(["216/เดือนพฤษภาคม"]);
	});

	test("an unchanged payload against a matching DOM produces an entirely empty diff", () => {
		const diff = diffDashboardMembership(
			["216/เดือนพฤษภาคม"],
			["216"],
			[client("216", ["216/เดือนพฤษภาคม"])],
		);
		expect(diff).toEqual({ insertRelPaths: [], removeRelPaths: [], insertClientCodes: [], removeClientCodes: [] });
	});

	test("insertion order follows the payload's own client/month order, deduplicated", () => {
		const diff = diffDashboardMembership(
			[],
			[],
			[client("216", ["216/a", "216/b"]), client("345", ["345/a"])],
		);
		expect(diff.insertClientCodes).toEqual(["216", "345"]);
		expect(diff.insertRelPaths).toEqual(["216/a", "216/b", "345/a"]);
	});

	test("a client that is both losing one month and gaining another reports both independently", () => {
		const diff = diffDashboardMembership(
			["216/เดือนพฤษภาคม"],
			["216"],
			[client("216", ["216/เดือนมิถุนายน"])],
		);
		expect(diff.insertRelPaths).toEqual(["216/เดือนมิถุนายน"]);
		expect(diff.removeRelPaths).toEqual(["216/เดือนพฤษภาคม"]);
		expect(diff.insertClientCodes).toEqual([]);
		expect(diff.removeClientCodes).toEqual([]);
	});
});
