import { describe, expect, test } from "bun:test";
import { formatBaht, formatNumber, formatStatementDate, normalizeAmount, normalizeDateForPeak, normalizePeakYear } from "./peak-format";

describe("normalizePeakYear", () => {
	test("B.E. year (> 2400) converts to C.E.", () => {
		expect(normalizePeakYear(2569)).toBe("2026");
	});

	test("C.E. year passes through unchanged, zero-padded", () => {
		expect(normalizePeakYear(999)).toBe("0999");
		expect(normalizePeakYear(2026)).toBe("2026");
	});

	test("non-finite input falls back to the raw string", () => {
		expect(normalizePeakYear("abc")).toBe("abc");
	});
});

describe("normalizeDateForPeak", () => {
	test("Thai spelled-out date (full month name)", () => {
		expect(normalizeDateForPeak("7 พฤษภาคม 2569")).toBe("20260507");
	});

	test("Thai spelled-out date (abbreviated with periods)", () => {
		expect(normalizeDateForPeak("7 พ.ค. 2569")).toBe("20260507");
	});

	test("Thai spelled-out date (abbreviated without periods)", () => {
		expect(normalizeDateForPeak("7 พค 2569")).toBe("20260507");
	});

	test("ISO YYYY-MM-DD", () => {
		expect(normalizeDateForPeak("2026-05-07")).toBe("20260507");
	});

	test("ISO with slash separators", () => {
		expect(normalizeDateForPeak("2026/5/7")).toBe("20260507");
	});

	test("DMY DD-MM-YYYY (Buddhist year)", () => {
		expect(normalizeDateForPeak("07-05-2569")).toBe("20260507");
	});

	test("bare 8-digit string", () => {
		expect(normalizeDateForPeak("25690507")).toBe("20260507");
	});

	test("empty/blank input returns an empty string", () => {
		expect(normalizeDateForPeak("")).toBe("");
		expect(normalizeDateForPeak(null)).toBe("");
		expect(normalizeDateForPeak(undefined)).toBe("");
	});

	test("unparseable text passes through unchanged rather than throwing", () => {
		expect(normalizeDateForPeak("ไม่ทราบวันที่")).toBe("ไม่ทราบวันที่");
	});
});

describe("normalizeAmount", () => {
	test("strips thousand separators", () => {
		expect(normalizeAmount("1,234.50")).toBe(1234.5);
	});

	test("falls back to 0 for unparseable input", () => {
		expect(normalizeAmount("abc")).toBe(0);
		expect(normalizeAmount(null)).toBe(0);
		expect(normalizeAmount(undefined)).toBe(0);
	});
});

describe("formatBaht", () => {
	test("formats with 2 decimals and a บาท suffix", () => {
		expect(formatBaht(1234.5)).toBe("1,234.50 บาท");
	});

	test("blank input renders as an empty string, not 0.00 บาท", () => {
		expect(formatBaht(null)).toBe("");
		expect(formatBaht(undefined)).toBe("");
		expect(formatBaht("")).toBe("");
	});

	test("an explicit zero renders as 0.00 บาท, not blank", () => {
		expect(formatBaht(0)).toBe("0.00 บาท");
		expect(formatBaht("0")).toBe("0.00 บาท");
	});
});

describe("formatNumber", () => {
	test("same as formatBaht but without the currency suffix", () => {
		expect(formatNumber(1234.5)).toBe("1,234.50");
	});

	test("blank input renders as an empty string", () => {
		expect(formatNumber(null)).toBe("");
	});
});

describe("formatStatementDate", () => {
	test("reorders an ISO date to DD/MM/YYYY for display", () => {
		expect(formatStatementDate("2026-05-07")).toBe("07/05/2026");
	});

	test("tolerates a trailing time component", () => {
		expect(formatStatementDate("2026-05-07T14:16:00")).toBe("07/05/2026");
	});

	test("passes through unparseable text unchanged", () => {
		expect(formatStatementDate("not a date")).toBe("not a date");
	});

	test("null/undefined render as an empty string", () => {
		expect(formatStatementDate(null)).toBe("");
		expect(formatStatementDate(undefined)).toBe("");
	});
});
