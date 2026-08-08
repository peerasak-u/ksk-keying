// The month identity and its two mappings (plan §9.2 [r3], spec §1.4, §5.13).
//
// Plan §9.2: "Core owns both functions and they live in one module, so there is
// exactly one implementation of the truncation and exactly one of the
// expansion." This is that module. The office platform sends the four-digit
// `monthKey` and never truncates it itself.
import { CoreError } from "../errors/core-error";

/** `YY-MM` on the SHORT Buddhist year — `69-08` is Buddhist 2569, month 08.
 * Zero-padded both fields, hyphen separator, nothing else in the name: no
 * suffix, no trailing space, no descriptive tail. `69-8`, `69-08 (แก้ไข)`,
 * `2569-08` and `69_08` all fail. */
export const MONTH_ID_PATTERN = "^[0-9]{2}-(0[1-9]|1[0-2])$";
const MONTH_ID_RE = /^[0-9]{2}-(0[1-9]|1[0-2])$/;

/** `BBBB-MM` on the FULL Buddhist year — the office platform's own form
 * (mock `src/domain/dates.ts:15-18`). */
export const MONTH_KEY_PATTERN = "^[0-9]{4}-(0[1-9]|1[0-2])$";
const MONTH_KEY_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/** Plan §9.2 [r3]: the default Buddhist century base, overridable by
 * `KSK_BUDDHIST_CENTURY_BASE`. Core refuses to boot if it is not a multiple of
 * 100 — see assertCenturyBase. */
export const DEFAULT_BUDDHIST_CENTURY_BASE = 2500;

/** Buddhist era leads the Gregorian by 543 years. Used only to state when the
 * reverse mapping's dated guarantee expires. */
const BUDDHIST_GREGORIAN_OFFSET = 543;

export function isMonthId(value: string): boolean {
	return MONTH_ID_RE.test(value);
}

export function isMonthKey(value: string): boolean {
	return MONTH_KEY_RE.test(value);
}

/** Throws `400 invalid_month_id` (§2.3) rather than returning a boolean, so a
 * route cannot forget to map the failure. §2.2's consequence 1: a name that
 * fails the format is a 400, never a 404. */
export function assertMonthId(value: unknown, path = "monthId"): string {
	if (typeof value !== "string" || !isMonthId(value)) {
		throw new CoreError("invalid_month_id", {
			details: { fields: [{ path, problem: "pattern", expected: MONTH_ID_PATTERN }] },
		});
	}
	return value;
}

export function assertMonthKey(value: unknown, path = "monthKey"): string {
	if (typeof value !== "string" || !isMonthKey(value)) {
		throw new CoreError("invalid_month_key", {
			details: { fields: [{ path, problem: "pattern", expected: MONTH_KEY_PATTERN }] },
		});
	}
	return value;
}

/** platform → Core, the common case. Validate, then drop the first two digits
 * of the year. Total and lossless in this direction (plan §9.2's table). */
export function monthKeyToMonthId(monthKey: string): string {
	assertMonthKey(monthKey);
	return `${monthKey.slice(2, 4)}-${monthKey.slice(5, 7)}`;
}

/** Core → platform, when Core reports a folder it discovered. Prefix the year
 * with the configured century base.
 *
 * Expansion is NOT lossless: `YY = "00"` is Buddhist 2500 and Buddhist 2600
 * equally, and the folder name cannot tell them apart. Plan §9.2 [r3] resolves
 * that by defining the reverse mapping only over `[BASE, BASE + 99]` and
 * writing the expiry down (see buddhistCenturyWindow) rather than compiling a
 * constant into a path helper. */
export function monthIdToMonthKey(monthId: string, base: number = DEFAULT_BUDDHIST_CENTURY_BASE): string {
	assertMonthId(monthId);
	assertCenturyBase(base);
	const year = base + Number(monthId.slice(0, 2));
	return `${year}-${monthId.slice(3, 5)}`;
}

/** Plan §9.2 [r3]: "Core must refuse to start if `KSK_BUDDHIST_CENTURY_BASE` is
 * not a multiple of 100". Throwing here is what makes §5.2's guarantee true —
 * "this route never reports a bad one".
 *
 * The floor is 1000 rather than 0 because the base is the four-digit half of a
 * `monthKey`: with a base below 1000 the expansion would produce a year of
 * fewer than four digits, i.e. a value MONTH_KEY_PATTERN itself rejects. The
 * ceiling keeps `base + 99` inside four digits for the same reason. */
export function assertCenturyBase(base: number): number {
	if (!Number.isInteger(base) || base < 1000 || base > 9900 || base % 100 !== 0) {
		throw new Error(`KSK_BUDDHIST_CENTURY_BASE must be a multiple of 100 within 1000..9900; got ${base}`);
	}
	return base;
}

export type BuddhistCenturyWindow = {
	base: number;
	/** `"2500-2599"` — the Buddhist years the reverse mapping is defined over. */
	window: string;
	/** The dated guarantee's expiry, as a Gregorian ISO date. With the default
	 * base that is 2057-01-01 (Buddhist 2600). Plan §9.2 [r3]: this is written
	 * down and configurable, not permanent. */
	expiresOn: string;
};

/** The block §5.2 reports at `checks.buddhistCentury`, and the line plan §9.2
 * requires Core to log at boot "so the operator can see which century the
 * process believes it is in". */
export function buddhistCenturyWindow(base: number = DEFAULT_BUDDHIST_CENTURY_BASE): BuddhistCenturyWindow {
	assertCenturyBase(base);
	return {
		base,
		window: `${base}-${base + 99}`,
		expiresOn: `${base + 100 - BUDDHIST_GREGORIAN_OFFSET}-01-01`,
	};
}
