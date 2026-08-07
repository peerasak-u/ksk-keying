import { describe, expect, test } from "bun:test";
import { createLogger, silentLogger } from "./logger";

function capture() {
	const lines: string[] = [];
	return { lines, sink: (line: string) => lines.push(line) };
}

describe("the structured logger (plan §18)", () => {
	test("writes one JSON line per event, with a timestamp, level and event name", () => {
		const { lines, sink } = capture();
		const logger = createLogger({ sink, now: () => "2026-08-07T12:00:00.000Z" });
		logger.info("core.boot", { clients: 113 });
		expect(JSON.parse(lines[0])).toEqual({
			ts: "2026-08-07T12:00:00.000Z",
			level: "info",
			event: "core.boot",
			clients: 113,
		});
	});

	test("filters below the configured level", () => {
		const { lines, sink } = capture();
		const logger = createLogger({ sink, level: "warn" });
		logger.debug("a");
		logger.info("b");
		logger.warn("c");
		logger.error("d");
		expect(lines.map((line) => JSON.parse(line).event)).toEqual(["c", "d"]);
	});

	test("a child logger stamps its base fields onto every line", () => {
		const { lines, sink } = capture();
		const logger = createLogger({ sink, level: "debug" }).child({ requestId: "req_X", jobId: "job_Y" });
		logger.debug("http.request", { status: 200 });
		const line = JSON.parse(lines[0]);
		expect(line).toMatchObject({ requestId: "req_X", jobId: "job_Y", status: 200 });
	});

	test("per-call fields win over the child's base fields", () => {
		const { lines, sink } = capture();
		const logger = createLogger({ sink }).child({ jobId: "job_Y" });
		logger.info("x", { jobId: "job_Z" });
		expect(JSON.parse(lines[0]).jobId).toBe("job_Z");
	});

	test("the silent logger writes nothing at any level", () => {
		expect(() => {
			silentLogger.debug("a");
			silentLogger.info("b");
			silentLogger.warn("c");
			silentLogger.error("d");
		}).not.toThrow();
	});
});
