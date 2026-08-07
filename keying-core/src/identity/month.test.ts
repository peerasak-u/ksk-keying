import { describe, expect, test } from "bun:test";
import { CoreError } from "../errors/core-error";
import {
	assertCenturyBase,
	assertMonthId,
	assertMonthKey,
	buddhistCenturyWindow,
	isMonthId,
	isMonthKey,
	monthIdToMonthKey,
	monthKeyToMonthId,
	MONTH_ID_PATTERN,
	MONTH_KEY_PATTERN,
} from "./month";

describe("monthId format (plan §9.2 [r3])", () => {
	test("accepts a zero-padded YY-MM on the short Buddhist year", () => {
		for (const value of ["69-08", "00-01", "99-12", "69-01", "69-10"]) {
			expect(isMonthId(value)).toBe(true);
		}
	});

	// The plan names these four rejections in as many words: "`69-8`,
	// `69-08 (แก้ไข)`, `2569-08`, and `69_08` all fail."
	test("rejects the four forms the plan names", () => {
		for (const value of ["69-8", "69-08 (แก้ไข)", "2569-08", "69_08"]) {
			expect(isMonthId(value)).toBe(false);
		}
	});

	test("rejects a trailing space, a leading space, a month of 00 or 13, and a descriptive tail", () => {
		for (const value of ["69-08 ", " 69-08", "69-00", "69-13", "69-08-copy", "69-08/", "", "69-8-08"]) {
			expect(isMonthId(value)).toBe(false);
		}
	});

	test("rejects full-width digits — the format is decimal ASCII digits only", () => {
		expect(isMonthId("６９-０８")).toBe(false);
	});

	test("assertMonthId throws 400 invalid_month_id with the expected pattern, never a 404", () => {
		try {
			assertMonthId("69-8");
			throw new Error("expected assertMonthId to throw");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(CoreError);
			const error = thrown as CoreError;
			expect(error.code).toBe("invalid_month_id");
			expect(error.status).toBe(400);
			expect(error.details).toEqual({ fields: [{ path: "monthId", problem: "pattern", expected: MONTH_ID_PATTERN }] });
		}
	});

	test("assertMonthId rejects a non-string", () => {
		expect(() => assertMonthId(6908)).toThrow(CoreError);
		expect(() => assertMonthId(null)).toThrow(CoreError);
	});
});

describe("monthKey format (spec §5.13)", () => {
	test("accepts a four-digit Buddhist year", () => {
		for (const value of ["2569-08", "2500-01", "2599-12"]) {
			expect(isMonthKey(value)).toBe(true);
		}
	});

	test("rejects a short year, a bad month, and a truncated key", () => {
		for (const value of ["69-08", "2569-8", "2569-00", "2569-13", "2569", "02569-08"]) {
			expect(isMonthKey(value)).toBe(false);
		}
	});

	test("assertMonthKey throws 400 invalid_month_key with the expected pattern", () => {
		try {
			assertMonthKey("2569-8");
			throw new Error("expected assertMonthKey to throw");
		} catch (thrown) {
			const error = thrown as CoreError;
			expect(error.code).toBe("invalid_month_key");
			expect(error.status).toBe(400);
			expect(error.details).toEqual({ fields: [{ path: "monthKey", problem: "pattern", expected: MONTH_KEY_PATTERN }] });
		}
	});
});

describe("the mapping, both directions (plan §9.2 [r3]'s table)", () => {
	test("monthKey → monthId drops the first two digits of the year", () => {
		expect(monthKeyToMonthId("2569-08")).toBe("69-08");
		expect(monthKeyToMonthId("2500-01")).toBe("00-01");
		expect(monthKeyToMonthId("2599-12")).toBe("99-12");
	});

	test("monthId → monthKey prefixes the configured century base", () => {
		expect(monthIdToMonthKey("69-08")).toBe("2569-08");
		expect(monthIdToMonthKey("00-01")).toBe("2500-01");
		expect(monthIdToMonthKey("99-12")).toBe("2599-12");
	});

	test("a non-default base moves the whole window", () => {
		expect(monthIdToMonthKey("00-01", 2600)).toBe("2600-01");
		expect(monthIdToMonthKey("57-03", 2600)).toBe("2657-03");
	});

	test("truncation then expansion round-trips inside the century window", () => {
		for (const monthKey of ["2500-01", "2545-06", "2569-08", "2599-12"]) {
			expect(monthIdToMonthKey(monthKeyToMonthId(monthKey))).toBe(monthKey);
		}
	});

	test("expansion is lossy across the century boundary — the same monthId, two Buddhist years", () => {
		// The ambiguity the plan states rather than hides: `00-01` is Buddhist
		// 2500 under the default base and Buddhist 2600 under the next one, and
		// the folder name cannot tell them apart.
		expect(monthIdToMonthKey("00-01", 2500)).toBe("2500-01");
		expect(monthIdToMonthKey("00-01", 2600)).toBe("2600-01");
	});

	test("both directions validate their input before mapping", () => {
		expect(() => monthKeyToMonthId("69-08")).toThrow(CoreError);
		expect(() => monthIdToMonthKey("2569-08")).toThrow(CoreError);
	});
});

describe("the century base and its dated guarantee", () => {
	test("refuses a base that is not a multiple of 100 (plan §9.2 [r3])", () => {
		for (const base of [2543, 2501, -100, 250.5]) {
			expect(() => assertCenturyBase(base)).toThrow();
		}
		expect(assertCenturyBase(2500)).toBe(2500);
		expect(assertCenturyBase(2600)).toBe(2600);
	});

	test("monthIdToMonthKey refuses a bad base rather than producing a wrong year", () => {
		expect(() => monthIdToMonthKey("69-08", 2543)).toThrow();
	});

	test("reports the window and the expiry the plan pins", () => {
		expect(buddhistCenturyWindow()).toEqual({ base: 2500, window: "2500-2599", expiresOn: "2057-01-01" });
	});

	test("the expiry moves with the base — it is configurable, not a compiled-in constant", () => {
		expect(buddhistCenturyWindow(2600)).toEqual({ base: 2600, window: "2600-2699", expiresOn: "2157-01-01" });
	});
});
