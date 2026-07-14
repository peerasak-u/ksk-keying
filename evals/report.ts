// Render a run's results and diff against the pinned baseline.
//
//   bun run report.ts -- watson --run <run-id | dir>            # print report
//   bun run report.ts -- watson --run <run-id> --set-baseline   # pin as baseline
//
// Exits 1 when a critical-field accuracy or the silent-error rate regresses
// vs baseline — usable as a gate before committing a prompt change.

import { copyFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { RUNS_ROOT, loadJson, parseArgs } from "./lib";

const { positional, flags } = parseArgs(process.argv.slice(2));
const agent = positional[0] ?? "watson";
const runArg = String(flags.run ?? "");
if (!runArg) {
	console.error("missing --run");
	process.exit(2);
}
const runDir = isAbsolute(runArg) ? runArg : join(RUNS_ROOT, agent, runArg);
const summaryPath = join(runDir, "summary.json");
if (!existsSync(summaryPath)) {
	console.error(`no summary.json in ${runDir} — run grade.ts first`);
	process.exit(1);
}
const s = loadJson<any>(summaryPath);

// --- lestrade: confusion-matrix report --------------------------------------
if (agent === "lestrade" || s.schema === "ksk_eval_summary.lestrade.v1") {
	const m = s.matrix;
	const fmtRate = (r: number | null) => (r == null ? "—" : `${(100 * r).toFixed(1)}%`);
	console.log(`# eval report — ${s.agent}  run ${s.run_id}  (dataset v${s.dataset_version})`);
	if (s.note) console.log(`note: ${s.note}`);
	console.log("");
	console.log(
		`cases: ${s.cases_passed}/${s.cases_graded} pass   ` +
			`claims: ${m.total}  (${m.positives} seeded-false / ${m.negatives} true-exclusion)`,
	);
	console.log("");
	console.log("confusion matrix  (positive = should REFUTE a bad exclusion)");
	console.log(`  TP catch        ${m.tp}`);
	console.log(`  FN miss         ${m.fn}   <- dangerous: a real bookable would be silently dropped`);
	console.log(`  FP false-alarm  ${m.fp}`);
	console.log(`  TN confirm      ${m.tn}`);
	if (m.unresolved)
		console.log(`  unresolved      ${m.unresolved}  (no verdict / unparseable — counted as no-alarm)`);
	console.log("");
	console.log(`  MISS-RATE (FN/pos)        ${fmtRate(m.miss_rate)}   <- the trust number to drive down`);
	console.log(`  catch-rate (TP/pos)       ${fmtRate(m.catch_rate)}`);
	console.log(`  false-alarm-rate (FP/neg) ${fmtRate(m.false_alarm_rate)}`);
	console.log(`  confirm-rate (TN/neg)     ${fmtRate(m.confirm_rate)}`);
	console.log(`  precision (TP/(TP+FP))    ${fmtRate(m.precision)}`);
	console.log(`  accuracy                  ${fmtRate(m.accuracy)}`);
	console.log("");
	if (s.misses.length) {
		console.log("MISSES (bad exclusions NOT caught):");
		for (const x of s.misses) console.log(`  ${x.case_id}  ${x.key}  (got ${x.got})`);
	}
	if (s.false_alarms.length) {
		console.log("FALSE ALARMS (good exclusions wrongly refuted):");
		for (const x of s.false_alarms) console.log(`  ${x.case_id}  ${x.key}  (got ${x.got})`);
	}
	if (s.unresolved.length) {
		console.log("UNRESOLVED (no verdict returned):");
		for (const x of s.unresolved) console.log(`  ${x.case_id}  ${x.key}`);
	}
	console.log("");
	for (const c of s.cases) {
		const mark = c.pass ? "PASS" : "FAIL";
		const prov = c.provisional ? "  (provisional)" : "";
		console.log(`  ${mark}  ${c.case_id}  [TP${c.tp} FN${c.fn} FP${c.fp} TN${c.tn}]${prov}`);
	}

	const baselinePath = join(RUNS_ROOT, agent, "baseline.json");
	if (flags["set-baseline"] === true) {
		copyFileSync(summaryPath, baselinePath);
		console.log(`\nbaseline set → ${baselinePath}`);
		process.exit(0);
	}
	if (!existsSync(baselinePath)) {
		console.log("\n(no baseline pinned — use --set-baseline to pin this run)");
		process.exit(0);
	}
	const b = loadJson<any>(baselinePath);
	console.log(`\n## vs baseline ${b.run_id} (dataset v${b.dataset_version})`);
	if (b.dataset_version !== s.dataset_version) {
		console.log("dataset version differs — numbers are not comparable; re-pin the baseline");
		process.exit(0);
	}
	let regressed = false;
	const curMiss = s.matrix.miss_rate ?? 0;
	const oldMiss = b.matrix.miss_rate ?? 0;
	if (curMiss > oldMiss + 1e-9) {
		regressed = true;
		console.log(`REGRESSION miss-rate: ${fmtRate(oldMiss)} → ${fmtRate(curMiss)}`);
	}
	const curFA = s.matrix.false_alarm_rate ?? 0;
	const oldFA = b.matrix.false_alarm_rate ?? 0;
	if (curFA > oldFA + 1e-9) {
		regressed = true;
		console.log(`REGRESSION false-alarm-rate: ${fmtRate(oldFA)} → ${fmtRate(curFA)}`);
	}
	if (!regressed) console.log("no regressions vs baseline");
	process.exit(regressed ? 1 : 0);
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);

console.log(`# eval report — ${s.agent}  run ${s.run_id}  (dataset v${s.dataset_version})`);
if (s.note) console.log(`note: ${s.note}`);
console.log("");
console.log(
	`cases: ${s.cases_passed}/${s.cases_graded} pass` +
		`   solid-only: ${s.solid.passed}/${s.solid.cases} pass` +
		`   SILENT ERRORS (solid): ${s.solid.silent_total}/${s.solid.fields_total}` +
		` (${s.solid.silent_error_rate == null ? "—" : (100 * s.solid.silent_error_rate).toFixed(2) + "%"})`,
);
console.log("");
console.log("field              correct  wrong_flagged  wrong_silent  missing  spurious");
for (const [field, c] of Object.entries<any>(s.fields)) {
	const total = c.correct + c.wrong_flagged + c.wrong_silent + c.missing_value + c.spurious_value;
	console.log(
		`${field.padEnd(18)} ${String(c.correct).padStart(3)}/${String(total).padEnd(4)}` +
			` ${String(c.wrong_flagged).padStart(8)} ${String(c.wrong_silent).padStart(13)}` +
			` ${String(c.missing_value).padStart(8)} ${String(c.spurious_value).padStart(9)}`,
	);
}
console.log("");
for (const c of s.cases) {
	const mark = c.pass ? "PASS" : "FAIL";
	const prov = c.provisional ? "  (provisional)" : "";
	const silent = c.silent_total > 0 ? `  silent:${c.silent_total}` : "";
	console.log(`  ${mark}  ${c.case_id}${silent}${prov}`);
}

// --- baseline ---------------------------------------------------------------

const baselinePath = join(RUNS_ROOT, agent, "baseline.json");

if (flags["set-baseline"] === true) {
	copyFileSync(summaryPath, baselinePath);
	console.log(`\nbaseline set → ${baselinePath}`);
	process.exit(0);
}

if (!existsSync(baselinePath)) {
	console.log("\n(no baseline pinned — use --set-baseline to pin this run)");
	process.exit(0);
}

const b = loadJson<any>(baselinePath);
console.log(`\n## vs baseline ${b.run_id} (dataset v${b.dataset_version})`);
if (b.dataset_version !== s.dataset_version) {
	console.log("dataset version differs — numbers are not comparable; re-pin the baseline");
	process.exit(0);
}

let regressed = false;
for (const field of Object.keys(s.fields)) {
	const cur = s.fields[field];
	const old = b.fields[field] ?? { correct: 0 };
	const curTotal = Object.values<number>(cur).reduce((a, v) => a + v, 0);
	const oldTotal = Object.values<number>(old).reduce((a, v) => a + v, 0);
	const curAcc = curTotal ? cur.correct / curTotal : 1;
	const oldAcc = oldTotal ? old.correct / oldTotal : 1;
	if (curAcc < oldAcc - 1e-9) {
		regressed = true;
		console.log(
			`REGRESSION ${field}: ${pct(old.correct, oldTotal)} → ${pct(cur.correct, curTotal)}`,
		);
	}
}
const curSilent = s.solid.silent_error_rate ?? 0;
const oldSilent = b.solid.silent_error_rate ?? 0;
if (curSilent > oldSilent + 1e-9) {
	regressed = true;
	console.log(
		`REGRESSION silent-error rate: ${(100 * oldSilent).toFixed(2)}% → ${(100 * curSilent).toFixed(2)}%`,
	);
}
if (!regressed) console.log("no regressions vs baseline");
process.exit(regressed ? 1 : 0);
