import { describe, expect, test } from "bun:test";
import { createInMemoryRunProjectionStore } from "./projection-store";

describe("§1.6 the run projection's version counter", () => {
	test("starts at 1 for the first observation of a job", () => {
		const store = createInMemoryRunProjectionStore();
		expect(store.versionFor("job_a", "fingerprint-1")).toBe(1);
	});

	test("does not move when nothing about the projection changed", () => {
		const store = createInMemoryRunProjectionStore();
		store.versionFor("job_a", "fingerprint-1");
		expect(store.versionFor("job_a", "fingerprint-1")).toBe(1);
		expect(store.versionFor("job_a", "fingerprint-1")).toBe(1);
	});

	test("is monotonic per job — it never regresses, even back to a previous content", () => {
		const store = createInMemoryRunProjectionStore();
		expect(store.versionFor("job_a", "one")).toBe(1);
		expect(store.versionFor("job_a", "two")).toBe(2);
		expect(store.versionFor("job_a", "one")).toBe(3);
	});

	test("counts per job, not globally", () => {
		const store = createInMemoryRunProjectionStore();
		store.versionFor("job_a", "one");
		store.versionFor("job_a", "two");
		expect(store.versionFor("job_b", "one")).toBe(1);
	});

	test("peek reports the last version issued, and 0 for a job never observed", () => {
		const store = createInMemoryRunProjectionStore();
		expect(store.peek("job_a")).toBe(0);
		store.versionFor("job_a", "one");
		expect(store.peek("job_a")).toBe(1);
	});
});
