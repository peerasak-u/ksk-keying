// The office fills วันที่เสร็จ as d/m/พ.ศ. (the sheet's own worked example
// reads "5/8/2569"), so the mock's "today" matches the greeting's date.
export const TODAY = "5/8/2569";
// The พ.ศ. year every seeded งวด falls in — the office counts closed work by
// accounting year, not by a rolling window (round 21's per-person figures).
export const THIS_YEAR = "2569";
export const TODAY_DATE = new Date(2026, 7, 5);   // the same day, as a real date, for the due-date rules


// ---- dates (round 10). Thai พ.ศ. in and out; plain JS Date in the middle.
// A งวด is identified by its own month (monthKey "2569-07" = งวดกรกฎาคม) and
// is OPENED on the first day of the month after it closes, because that is
// when its documents can first exist. Every due date on the screen is
// derived from one of those two anchors — none is stored.
export function periodParts(monthKey: string) {
	var a = String(monthKey).split("-");
	return { y: parseInt(a[0], 10) - 543, m: parseInt(a[1], 10) - 1 };
}
export function fmtDate(d: Date) { return d.getDate() + "/" + (d.getMonth() + 1) + "/" + (d.getFullYear() + 543); }

export const THAI_MONTHS = [
	"มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
	"กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];
export const THAI_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
export function monthLabel(monthKey: string) {
	var a = String(monthKey).split("-");
	return THAI_MONTHS[parseInt(a[1], 10) - 1] + " " + a[0];
}
export function periodLabelFor(jobKey: string, monthKey: string) {
	if (jobKey === "consult") return "รอบเดือน" + monthLabel(monthKey);
	if (jobKey === "yearly") return "ปีบัญชี 2568 (เอกสาร" + monthLabel(monthKey) + ")";
	if (jobKey === "project") return "เริ่ม " + monthLabel(monthKey);
	// A registration job is one piece of work with a start, not a งวด.
	if (jobKey === "registry") return "งานทะเบียน — เริ่ม " + monthLabel(monthKey);
	return "งวดเดือน" + monthLabel(monthKey);
}

export function daysUntil(d: Date) { return Math.round((d.getTime() - TODAY_DATE.getTime()) / 86400000); }
export function daysBetween(a: Date, b: Date) { return Math.round((b.getTime() - a.getTime()) / 86400000); }
export function addDays(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
