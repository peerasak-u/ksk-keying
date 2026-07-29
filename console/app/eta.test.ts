import { describe, expect, test } from "bun:test";
import { estimateMinutes, formatMinutes, minutesPerUnit, MIN_SAMPLES } from "./eta";

describe("minutesPerUnit", () => {
	test("needs at least MIN_SAMPLES usable finished runs", () => {
		expect(minutesPerUnit([])).toBeNull();
		expect(minutesPerUnit([{ units: 100, minutes: 50 }])).toBeNull();
		expect(MIN_SAMPLES).toBe(2);
		expect(minutesPerUnit([
			{ units: 100, minutes: 50 },
			{ units: 100, minutes: 50 },
		])).toBe(0.5);
	});

	test("drops samples that carry no usable rate", () => {
		// A run with no ledger count, a zero duration, or a NaN can't say anything
		// about throughput — and must not count toward the MIN_SAMPLES bar either.
		expect(
			minutesPerUnit([
				{ units: 0, minutes: 30 },
				{ units: 100, minutes: 0 },
				{ units: Number.NaN, minutes: 10 },
				{ units: 100, minutes: 50 },
			]),
		).toBeNull();
	});

	test("uses the median so one stalled run can't skew the rate", () => {
		// 0.5, 0.5, 0.6, and one month that sat blocked overnight (12.0).
		const rate = minutesPerUnit([
			{ units: 100, minutes: 50 },
			{ units: 100, minutes: 50 },
			{ units: 100, minutes: 60 },
			{ units: 100, minutes: 1200 },
		]);
		expect(rate).toBeCloseTo(0.55, 10);
	});

	test("even sample count averages the two middle rates", () => {
		expect(minutesPerUnit([
			{ units: 10, minutes: 10 },
			{ units: 10, minutes: 20 },
		])).toBe(1.5);
	});
});

describe("estimateMinutes", () => {
	test("null in, null out — no estimate is better than a made-up one", () => {
		expect(estimateMinutes(null, 0.5)).toBeNull();
		expect(estimateMinutes(120, null)).toBeNull();
		expect(estimateMinutes(0, 0.5)).toBeNull();
	});

	test("rounds to a 5-minute step, never below 5", () => {
		expect(estimateMinutes(120, 0.5)).toBe(60);
		expect(estimateMinutes(101, 0.5)).toBe(50); // 50.5 -> 50
		expect(estimateMinutes(1, 0.5)).toBe(5); // 0.5 min still reads as "5 นาที"
	});
});

describe("formatMinutes", () => {
	test("minutes until it reads better as hours", () => {
		expect(formatMinutes(45)).toBe("45 นาที");
		expect(formatMinutes(60)).toBe("1 ชม.");
		expect(formatMinutes(80)).toBe("1 ชม. 20 นาที");
		expect(formatMinutes(180)).toBe("3 ชม.");
	});
});
