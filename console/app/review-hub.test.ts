import { describe, expect, test } from "bun:test";
import { renderReviewHub } from "./review-hub";
import { buildHubStats, type HubStatsInput } from "./review-hub-stats";
import type { Claim } from "./review-claims";
import type { DocumentBucket, ReviewPage } from "./review-data";

function page(over: Partial<ReviewPage> = {}): ReviewPage {
	return {
		ref: "r",
		short_ref: "r",
		source_src: "a.pdf",
		source_page: 1,
		source_sheet: null,
		image_src: null,
		extract_path: "",
		categorize_path: "",
		facts: { total: 1234.5 },
		lines: [{ line_index: 0 } as never],
		initial_status: "needs_attention",
		skipped: false,
		group_id: "g1",
		...over,
	} as ReviewPage;
}

function html(over: Partial<HubStatsInput> = {}, companyName: string | null = "บริษัท ทดสอบ จำกัด"): string {
	const stats = buildHubStats({
		clientId: "216",
		monthId: "เดือนเมษายน",
		claims: [],
		hadAnyExcluded: false,
		bucketPages: new Map<DocumentBucket, ReviewPage[]>([["expense/vat" as DocumentBucket, [page()]]]),
		statements: [],
		...over,
	});
	return renderReviewHub({ clientId: "216", monthId: "เดือนเมษายน", companyName, stats });
}

const claim = (over: Partial<Claim> = {}): Claim =>
	({ unitKey: "a.pdf#1", file: "a.pdf", page: 1, sheet: null, reasonLabel: "ซ้ำกับเอกสารอื่น", conflictGroup: null, referenceReportCheckMissing: false, ...over }) as Claim;

describe("renderReviewHub — the gate", () => {
	test("pending claims: every other card is locked and links nowhere", () => {
		const out = html({ claims: [claim(), claim({ page: 2 })], hadAnyExcluded: true });
		expect(out).toContain("ต้องเคลียร์ก่อนเริ่มหมวดอื่น");
		expect(out).toContain("ล็อกอยู่");
		// 5 document buckets + bank statement, none of them enterable
		expect(out.match(/class="card hub-card locked/g)?.length).toBe(6);
		expect(out).not.toContain('href="/clients/216/%E0%B9%80%E0%B8%94%E0%B8%B7%E0%B8%AD%E0%B8%99%E0%B9%80%E0%B8%A1%E0%B8%A9%E0%B8%B2%E0%B8%A2%E0%B8%99/review/expense/vat"');
		// the gate itself must stay reachable — it is the way out of the lock
		expect(out).toContain("/excluded-review\"");
	});

	test("cleared gate unlocks the cards and links them for real", () => {
		const out = html({ hadAnyExcluded: true });
		expect(out).toContain("ผ่านด่านแล้ว");
		expect(out).toContain("ยืนยันครบทุกรายการแล้ว");
		expect(out).not.toContain("hub-card locked");
		expect(out).toContain('href="/clients/216/%E0%B9%80%E0%B8%94%E0%B8%B7%E0%B8%AD%E0%B8%99%E0%B9%80%E0%B8%A1%E0%B8%A9%E0%B8%B2%E0%B8%A2%E0%B8%99/review/expense/vat"');
	});

	test("a month that never had exclusions says so instead of claiming credit for a review", () => {
		expect(html({ hadAnyExcluded: false })).toContain("เดือนนี้ไม่มีหน้าที่ถูกข้าม");
	});

	test("risk flags reach the gate chips", () => {
		const out = html({
			hadAnyExcluded: true,
			claims: [claim({ conflictGroup: "grp-1" }), claim({ page: 2, referenceReportCheckMissing: true })],
		});
		expect(out).toContain("ขัดแย้งกับกลุ่มที่คีย์แล้ว 1");
		expect(out).toContain("reference-report-check ยังไม่รัน 1");
	});
});

describe("renderReviewHub — the cards", () => {
	test("a bucket card carries counts, money and a progress denominator", () => {
		const out = html({
			bucketPages: new Map<DocumentBucket, ReviewPage[]>([
				["expense/vat" as DocumentBucket, [page({ initial_status: "reviewed" }), page({ group_id: "g2", source_src: "b.pdf" })]],
			]),
		});
		expect(out).toContain("2 เอกสาร · 2 ไฟล์ · 2 บรรทัด");
		expect(out).toContain("2,469.00 บาท");
		expect(out).toContain("1/2");
		expect(out).toContain("ต้องดู 1");
	});

	test("an empty bucket collapses to a thin row instead of a full card", () => {
		const out = html();
		expect(out.match(/hub-card is-empty/g)?.length).toBe(5); // 4 empty buckets + bank statement
		expect(out).toContain("ไม่มีเอกสาร");
	});

	test("skipped pages stay out of the money and the denominator", () => {
		const out = html({
			bucketPages: new Map<DocumentBucket, ReviewPage[]>([
				["expense/vat" as DocumentBucket, [page({ facts: { total: 100 }, initial_status: "reviewed" }), page({ facts: { total: 900 }, skipped: true })]],
			]),
		});
		expect(out).toContain("100.00 บาท");
		expect(out).toContain("1/1");
		expect(out).toContain("ข้าม 1");
	});
});

describe("renderReviewHub — page chrome", () => {
	test("breadcrumb places the hub one level under the dashboard", () => {
		const out = html();
		expect(out).toContain('<a href="/">Dashboard</a>');
		expect(out).toContain('<span class="crumb-here">ตรวจทานเอกสาร</span>');
	});

	test("company name and month are escaped, and a missing name falls back to the id", () => {
		expect(html({}, "<img src=x>")).toContain("&lt;img src=x&gt;");
		expect(html({}, null)).toContain("216 — เดือนเมษายน");
	});

	test("the lock message cannot break out of the inline script", () => {
		const out = html({ claims: [claim()], hadAnyExcluded: true });
		expect(out).not.toContain("</script>ยังตรวจ");
		expect(out).toContain('t.textContent = "');
	});
});
