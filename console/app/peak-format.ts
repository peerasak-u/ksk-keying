// PEAK-export formatting primitives (wayfinder ticket #41's "carry over...
// Buddhist-year/Thai-date PEAK normalization" ask). Exact port of
// review-template.ts's normalizePeakYear/normalizeDateForPeak/THAI_MONTHS/
// formatBaht/formatNumber/normalizeAmount/formatStatementDate — verified
// against that file line-by-line, not reimplemented from a paraphrase.
//
// The actual PEAK XLSX row-builders (buildExpenseOrRevenueRows,
// buildStatementJournalRows, the rule-11 modalYear/derivePeakDate
// date-shifting used only at export time) are ticket #42's job ("Build:
// human-edit changelog + server-side export") — out of scope here. What #41
// needs these primitives FOR: a small "this is how PEAK will read this date"
// hint next to each document/statement date field, so a reviewer catches an
// unparseable date before export ever runs, plus formatBaht/formatNumber for
// the per-account running subtotal and the statement integrity-check banner.

export const THAI_MONTHS: Record<string, string> = {
	มกราคม: "01",
	"ม.ค.": "01",
	มค: "01",
	กุมภาพันธ์: "02",
	"ก.พ.": "02",
	กพ: "02",
	มีนาคม: "03",
	"มี.ค.": "03",
	มีค: "03",
	เมษายน: "04",
	"เม.ย.": "04",
	เมย: "04",
	พฤษภาคม: "05",
	"พ.ค.": "05",
	พค: "05",
	มิถุนายน: "06",
	"มิ.ย.": "06",
	มิย: "06",
	กรกฎาคม: "07",
	"ก.ค.": "07",
	กค: "07",
	สิงหาคม: "08",
	"ส.ค.": "08",
	สค: "08",
	กันยายน: "09",
	"ก.ย.": "09",
	กย: "09",
	ตุลาคม: "10",
	"ต.ค.": "10",
	ตค: "10",
	พฤศจิกายน: "11",
	"พ.ย.": "11",
	พย: "11",
	ธันวาคม: "12",
	"ธ.ค.": "12",
	ธค: "12",
};

/** B.E. -> C.E. when the year looks Buddhist (> 2400); left-pads to 4 digits. */
export function normalizePeakYear(year: string | number): string {
	const n = Number(year);
	if (!Number.isFinite(n)) return String(year || "");
	return String(n > 2400 ? n - 543 : n).padStart(4, "0");
}

/** Any of a Thai spelled-out date, ISO YYYY-MM-DD, DMY DD-MM-YYYY, or a bare
 * 8-digit string -> PEAK's YYYYMMDD (C.E., zero-padded). Falls back to the
 * original trimmed text when nothing parses — never throws, never blanks. */
export function normalizeDateForPeak(value: string | number | null | undefined): string {
	const text = String(value ?? "").trim();
	if (!text) return "";
	const thai = text.replace(/[ ]+/g, " ").split(" ");
	if (thai.length >= 3) {
		const day = thai[0].replace(/[^0-9]/g, "");
		const month = THAI_MONTHS[thai[1]];
		const year = thai[2].replace(/[^0-9]/g, "");
		if (day && month && year) return normalizePeakYear(year) + month + day.padStart(2, "0");
	}
	const ymd = text.match(/^([0-9]{4})[-/. ]([0-9]{1,2})[-/. ]([0-9]{1,2})$/);
	if (ymd) return normalizePeakYear(ymd[1]) + ymd[2].padStart(2, "0") + ymd[3].padStart(2, "0");
	const dmy = text.match(/^([0-9]{1,2})[-/. ]([0-9]{1,2})[-/. ]([0-9]{4})$/);
	if (dmy) return normalizePeakYear(dmy[3]) + dmy[2].padStart(2, "0") + dmy[1].padStart(2, "0");
	const digits = text.replace(/[^0-9]/g, "");
	if (digits.length === 8) return normalizePeakYear(digits.slice(0, 4)) + digits.slice(4);
	return text;
}

export function normalizeAmount(value: string | number | null | undefined): number {
	const n = Number(String(value ?? "").replace(/,/g, ""));
	return Number.isFinite(n) ? n : 0;
}

/** en-US thousand-separated, always 2 decimals, suffixed "บาท"; blank
 * (not "0.00 บาท") when the input is unset/unparseable and wasn't literally
 * 0/"0". */
export function formatBaht(value: string | number | null | undefined): string {
	const n = normalizeAmount(value);
	if (!n && value !== 0 && value !== "0") return "";
	return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;
}

/** Same as formatBaht but without the currency suffix (used for balances /
 * debit-credit totals). */
export function formatNumber(value: string | number | null | undefined): string {
	const n = normalizeAmount(value);
	if (!n && value !== 0 && value !== "0") return "";
	return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** ISO-ish "YYYY-MM-DD..." -> "DD/MM/YYYY" for on-screen display only — a
 * plain reorder of the ISO date, NOT Buddhist-converted (separate concern
 * from normalizeDateForPeak). */
export function formatStatementDate(value: string | null | undefined): string {
	const text = String(value ?? "");
	const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(text);
	if (!match) return text;
	return `${match[3]}/${match[2]}/${match[1]}`;
}
