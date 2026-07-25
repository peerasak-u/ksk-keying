import { describe, expect, test } from "bun:test";
import { breadcrumbHtml, reviewHubUrl } from "./nav";

describe("reviewHubUrl", () => {
	test("percent-encodes Thai month folders", () => {
		expect(reviewHubUrl("216", "เดือนพฤษภาคม")).toBe(
			"/clients/216/%E0%B9%80%E0%B8%94%E0%B8%B7%E0%B8%AD%E0%B8%99%E0%B8%9E%E0%B8%A4%E0%B8%A9%E0%B8%A0%E0%B8%B2%E0%B8%84%E0%B8%A1/review",
		);
	});

	test("encodes separators that would otherwise change the route", () => {
		expect(reviewHubUrl("a/b", "m?x")).toBe("/clients/a%2Fb/m%3Fx/review");
	});
});

describe("breadcrumbHtml", () => {
	test("links both ancestor levels and leaves the current page as text", () => {
		const html = breadcrumbHtml("216", "m", "รายจ่าย — มี VAT");
		expect(html).toContain('<a href="/">Dashboard</a>');
		expect(html).toContain('<a href="/clients/216/m/review">ตรวจทานเอกสาร</a>');
		expect(html).toContain('<span class="crumb-here">รายจ่าย — มี VAT</span>');
		// The leaf must not be a link — it is the page you are already on.
		expect(html).not.toContain('<a href="/clients/216/m/review">รายจ่าย');
	});

	test("escapes the current-page label", () => {
		expect(breadcrumbHtml("216", "m", '<img src=x onerror="alert(1)">')).toContain("&lt;img src=x");
	});
});
