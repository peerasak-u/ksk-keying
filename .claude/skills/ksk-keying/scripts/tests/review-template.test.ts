import { describe, expect, test } from "bun:test";
import {
	compareReviewPagesBySource,
	derivePeakDate,
	inferPndType,
	modalYear,
	renderReviewHtml,
	resolveRelativeSegments,
	snapWhtRate,
	yearFromPeakDate,
	type ReviewPage,
} from "../review-template";

describe("snapWhtRate", () => {
	test("snaps exact standard rates", () => {
		expect(snapWhtRate(30, 1000)).toBe(0.03);
		expect(snapWhtRate(15, 1000)).toBe(0.015);
		expect(snapWhtRate(50, 1000)).toBe(0.05);
		expect(snapWhtRate(100, 1000)).toBe(0.1);
		expect(snapWhtRate(10, 1000)).toBe(0.01);
		expect(snapWhtRate(20, 1000)).toBe(0.02);
	});

	test("snaps within ±0.002 tolerance", () => {
		// 32.1 / 1070 = 0.03 exactly; 31 / 1000 = 0.031 is inside tolerance
		expect(snapWhtRate(32.1, 1070)).toBe(0.03);
		expect(snapWhtRate(31, 1000)).toBe(0.03);
		expect(snapWhtRate(29, 1000)).toBe(0.03);
	});

	test("rejects non-standard ratios instead of rounding", () => {
		expect(snapWhtRate(40, 1000)).toBeNull(); // 4% is not a standard rate
		expect(snapWhtRate(35, 1000)).toBeNull(); // between 3% and 5%
		expect(snapWhtRate(200, 1000)).toBeNull();
	});

	test("returns null on missing or non-positive inputs", () => {
		expect(snapWhtRate(null, 1000)).toBeNull();
		expect(snapWhtRate(30, null)).toBeNull();
		expect(snapWhtRate(0, 1000)).toBeNull();
		expect(snapWhtRate(-30, 1000)).toBeNull();
		expect(snapWhtRate(30, 0)).toBeNull();
		expect(snapWhtRate(30, -1000)).toBeNull();
	});
});

describe("inferPndType", () => {
	test("juristic markers → 53", () => {
		expect(inferPndType("บริษัท ทดสอบ จำกัด")).toBe("53");
		expect(inferPndType("บจก. ทดสอบ")).toBe("53");
		expect(inferPndType("บมจ. ทดสอบ")).toBe("53");
		expect(inferPndType("หจก. ทดสอบ")).toBe("53");
		expect(inferPndType("ห้างหุ้นส่วนสามัญ ทดสอบ")).toBe("53");
		expect(inferPndType("ธนาคารทดสอบ จำกัด (มหาชน)")).toBe("53");
	});

	test("individual title prefixes → 3", () => {
		expect(inferPndType("นายสมชาย ใจดี")).toBe("3");
		expect(inferPndType("นางสมศรี ใจดี")).toBe("3");
		expect(inferPndType("นางสาวสมหญิง ใจดี")).toBe("3");
		expect(inferPndType("น.ส.สมหญิง ใจดี")).toBe("3");
	});

	test("title must be a prefix, not a substring", () => {
		expect(inferPndType("ร้านนายฮ้อย")).toBeNull();
	});

	test("no marker → null (never guessed)", () => {
		expect(inferPndType("ร้านทดสอบการค้า")).toBeNull();
		expect(inferPndType("Test Trading")).toBeNull();
		expect(inferPndType("")).toBeNull();
		expect(inferPndType(null)).toBeNull();
		expect(inferPndType(undefined)).toBeNull();
	});
});

describe("yearFromPeakDate", () => {
	test("reads the year of a normalized YYYYMMDD date", () => {
		expect(yearFromPeakDate("20250131")).toBe(2025);
		expect(yearFromPeakDate("19991231")).toBe(1999);
	});

	test("rejects non-normalized values", () => {
		expect(yearFromPeakDate("")).toBeNull();
		expect(yearFromPeakDate(null)).toBeNull();
		expect(yearFromPeakDate(undefined)).toBeNull();
		expect(yearFromPeakDate("2025-01-31")).toBeNull();
		expect(yearFromPeakDate("31/01/2025")).toBeNull();
		expect(yearFromPeakDate("2025013")).toBeNull();
	});
});

describe("modalYear", () => {
	test("picks the most frequent year", () => {
		expect(modalYear(["20250110", "20250211", "20241231"])).toBe(2025);
		expect(modalYear(["20240110", "20240211", "20250101"])).toBe(2024);
	});

	test("ties break to the later year", () => {
		expect(modalYear(["20240101", "20250101"])).toBe(2025);
		expect(modalYear(["20250101", "20240101"])).toBe(2025);
	});

	test("ignores unparseable dates", () => {
		expect(modalYear(["", null, undefined, "not a date", "20250110"])).toBe(2025);
	});

	test("returns null when no date parses", () => {
		expect(modalYear([])).toBeNull();
		expect(modalYear(["", null, "31/01/2568"])).toBeNull();
	});
});

describe("derivePeakDate", () => {
	test("prior-year date shifts to Jan 1 of the period year", () => {
		expect(derivePeakDate("20241215", 2025)).toEqual({ date: "20250101", shifted: true, suspicious: false });
		expect(derivePeakDate("20231215", 2025)).toEqual({ date: "20250101", shifted: true, suspicious: false });
	});

	test("same-year date passes through", () => {
		expect(derivePeakDate("20250615", 2025)).toEqual({ date: "20250615", shifted: false, suspicious: false });
	});

	test("future-year date is suspicious, never shifted", () => {
		expect(derivePeakDate("20260101", 2025)).toEqual({ date: "20260101", shifted: false, suspicious: true });
	});

	test("unparseable date or unknown period year passes through untouched", () => {
		expect(derivePeakDate("", 2025)).toEqual({ date: "", shifted: false, suspicious: false });
		expect(derivePeakDate("31/01/2025", 2025)).toEqual({ date: "31/01/2025", shifted: false, suspicious: false });
		expect(derivePeakDate("20241215", null)).toEqual({ date: "20241215", shifted: false, suspicious: false });
	});
});

describe("renderReviewHtml helper injection", () => {
	test("the page script carries the shared helper implementations", () => {
		const html = renderReviewHtml({} as never, "");
		for (const name of ["snapWhtRate", "inferPndType", "yearFromPeakDate", "modalYear", "derivePeakDate", "resolveRelativeSegments"]) {
			expect(html).toContain(`function ${name}(`);
		}
	});
});

function pageStub(overrides: Partial<ReviewPage>): ReviewPage {
	return {
		ref: "g/x",
		short_ref: "x",
		image_src: null,
		extract_path: "",
		categorize_path: "",
		facts: {},
		lines: [],
		initial_status: "reviewed",
		...overrides,
	};
}

describe("compareReviewPagesBySource", () => {
	test("orders by source file, then page number, then ref", () => {
		const pages = [
			pageStub({ ref: "g1/a", source_src: "../b.pdf", source_page: 2 }),
			pageStub({ ref: "g2/b", source_src: "../a.pdf", source_page: 10 }),
			pageStub({ ref: "g3/c", source_src: "../a.pdf", source_page: 2 }),
			pageStub({ ref: "g4/d", source_src: "../b.pdf", source_page: 1 }),
		];
		const order = pages.slice().sort(compareReviewPagesBySource).map((p) => p.ref);
		expect(order).toEqual(["g3/c", "g2/b", "g4/d", "g1/a"]);
	});

	test("pages are numeric, not lexicographic (2 before 10)", () => {
		const pages = [
			pageStub({ ref: "g1/a", source_src: "x.pdf", source_page: 10 }),
			pageStub({ ref: "g2/b", source_src: "x.pdf", source_page: 2 }),
		];
		const order = pages.slice().sort(compareReviewPagesBySource).map((p) => p.ref);
		expect(order).toEqual(["g2/b", "g1/a"]);
	});

	test("sourceless pages go last, ordered by ref; image_src substitutes for source_src", () => {
		const pages = [
			pageStub({ ref: "g1/z" }),
			pageStub({ ref: "g2/a", image_src: "pages/a.png" }),
			pageStub({ ref: "g3/m", source_src: "x.pdf", source_page: 1 }),
			pageStub({ ref: "g0/a" }),
		];
		const order = pages.slice().sort(compareReviewPagesBySource).map((p) => p.ref);
		expect(order).toEqual(["g2/a", "g3/m", "g0/a", "g1/z"]);
	});
});

describe("resolveRelativeSegments", () => {
	test("resolves ../ against the base segments", () => {
		expect(resolveRelativeSegments(["client", "ตรวจทาน", "ค่าใช้จ่าย", "มีภาษี"], "../../../04-69/เอกสารvat.pdf"))
			.toEqual(["client", "04-69", "เอกสารvat.pdf"]);
	});

	test("keeps plain relative paths and ignores ./ and empty segments", () => {
		expect(resolveRelativeSegments([], "a/./b//c.pdf")).toEqual(["a", "b", "c.pdf"]);
	});

	test("escaping above the root returns null", () => {
		expect(resolveRelativeSegments(["only"], "../../x.pdf")).toBeNull();
		expect(resolveRelativeSegments([], "../x.pdf")).toBeNull();
	});

	test("fully collapsing to nothing returns null", () => {
		expect(resolveRelativeSegments(["a"], "..")).toBeNull();
	});
});
