// "How long will this month take?" — the second half of showing a month's size
// (month-size.ts). A page count on its own answers "how much work"; the
// operator's actual question is "how long will I be waiting", and the only
// honest answer available is this workspace's OWN measured throughput.
//
// Deliberately NOT a hardcoded minutes-per-page constant: run duration depends
// on the machine, the concurrency setting, and the document mix, all of which
// differ per install. So the estimate is derived from finished runs in the same
// workspace, and when there aren't enough of them there is simply NO estimate —
// a fabricated one is worse than a blank cell, since the whole point is to
// decide whether to start a run now or after lunch.
//
// Everything here is pure: the caller supplies the samples it already has
// (server.ts's buildDashboardClients already reads every done month's ledger
// counts and duration for the row it renders anyway).

/** One finished run: how many Pages it covered and how long it took. */
export type ThroughputSample = { units: number; minutes: number };

/** At least this many finished runs before any estimate is offered. Two is the
 * minimum that can disagree — one sample is an anecdote, and an operator shown
 * "≈ 40 นาที" derived from a single unusual month would trust it exactly as
 * much as one derived from twenty. */
export const MIN_SAMPLES = 2;

/** Median minutes-per-Page across the supplied finished runs, or null when
 * there aren't enough usable ones. Median, not mean: one month that sat blocked
 * overnight before someone hit retry would drag a mean far off, and that is a
 * completely normal thing to have in this history. */
export function minutesPerUnit(samples: ThroughputSample[]): number | null {
	const rates = samples
		.filter((s) => Number.isFinite(s.units) && Number.isFinite(s.minutes) && s.units > 0 && s.minutes > 0)
		.map((s) => s.minutes / s.units)
		.sort((a, b) => a - b);
	if (rates.length < MIN_SAMPLES) return null;
	const mid = Math.floor(rates.length / 2);
	return rates.length % 2 === 1 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}

/** Estimated minutes for a month of `units` Pages, rounded to a 5-minute step
 * (and never below 5) — the precision this can honestly claim. Null whenever
 * either input is missing, which is what makes "no estimate yet" render as a
 * blank rather than a zero. */
export function estimateMinutes(units: number | null, ratePerUnit: number | null): number | null {
	if (units == null || ratePerUnit == null) return null;
	if (!Number.isFinite(units) || units <= 0) return null;
	const raw = units * ratePerUnit;
	return Math.max(5, Math.round(raw / 5) * 5);
}

/** "45 นาที" / "1 ชม. 20 นาที" — hours only once it's worth reading as hours. */
export function formatMinutes(minutes: number): string {
	if (minutes < 60) return `${minutes} นาที`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours} ชม.` : `${hours} ชม. ${rest} นาที`;
}
