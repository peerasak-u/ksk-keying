// Grade a STAGE eval run (Tier 2). Deterministic only — reads each session's
// ข้อมูลระบบ tree + re-runs the production gates, then compares the sessions to
// each other (with no mid-stage answer key, the runs are each other's reference).
//
//   bun run stage-grade.ts -- interpret --run <run-id>
//
// Writes grade-s<N>.json per session + summary.json, and prints the scoreboard
// line. Never edits a session's output; a malformed/missing artifact is a
// finding, reported as a failing metric.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	DATA_ROOT,
	RUNS_ROOT,
	amountEq,
	loadJson,
	loadYaml,
	matchDocs,
	normText,
	normalizeInterp,
	parseArgs,
	writeJson,
} from "./lib";

const SCRIPTS = "../.claude/skills/ksk-keying/scripts";
const NON_BOOKABLE = new Set(["context_reference", "derived_report"]);

const { positional, flags } = parseArgs(process.argv.slice(2));
const stage = positional[0] ?? "interpret";
const runId = String(flags.run ?? "");
if (stage !== "interpret") {
	console.error(`stage-grade currently supports "interpret" only (got "${stage}")`);
	process.exit(1);
}
if (!runId) {
	console.error("--run <run-id> is required");
	process.exit(1);
}

const runDir = join(RUNS_ROOT, `stage-${stage}`, runId);
const run = loadJson<{ sessions: number; fixture: string }>(join(runDir, "run.json"));

// Run a bundled workflow script against a client dir; capture exit + stdout.
function script(cmd: string, clientAbs: string): { code: number; out: string } {
	try {
		const out = execFileSync("bun", ["run", "--cwd", SCRIPTS, cmd, "--", clientAbs], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (e: any) {
		return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

interface DocKey {
	key: string; // segId:source_page
	seg: string;
	gross: number | null; // gross_total, VAT-inclusive
	docNo: string; // normalized (for matching)
	docNoRaw: string;
	docDate: string;
	vatAmount: number | null; // watson emits a VAT *amount* (บาท), not a rate
	liCount: number;
	liSum: number | null;
}

function segDir(client: string, segId: string): string {
	return join(client, "ข้อมูลระบบ", "_segments", segId);
}

function interpFiles(client: string, segId: string): string[] {
	const d = segDir(client, segId);
	if (!existsSync(d)) return [];
	return readdirSync(d)
		.filter((f) => /^interpretation.*\.json$/.test(f))
		.map((f) => join(d, f));
}

function liSum(items: any[]): number | null {
	const nums = items
		.map((it) => (typeof it?.amount === "number" ? it.amount : Number(it?.amount)))
		.filter((n) => Number.isFinite(n));
	return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

// Collect one session's docs keyed by segment + source page — the unit the
// sessions are compared on.
function collectDocs(client: string, bookable: string[]): Map<string, DocKey> {
	const docs = new Map<string, DocKey>();
	for (const segId of bookable) {
		for (const file of interpFiles(client, segId)) {
			let interp: any;
			try {
				interp = loadJson(file);
			} catch {
				continue;
			}
			const norm = normalizeInterp(interp);
			norm.docs.forEach((doc, i) => {
				const page = doc.source_page ?? i;
				const key = `${segId}:${page}`;
				const f: any = doc.facts ?? {};
				const rawNo = String(f.document_no ?? f.document_number ?? "").trim();
				docs.set(key, {
					key,
					seg: segId,
					gross: typeof f.gross_total === "number" ? f.gross_total : null,
					docNo: normText(rawNo),
					docNoRaw: rawNo,
					docDate: String(f.document_date ?? "").trim(),
					vatAmount: typeof f.vat === "number" ? f.vat : null,
					liCount: doc.line_items.length,
					liSum: liSum(doc.line_items as any[]),
				});
			});
		}
	}
	return docs;
}

// ---- tier-B: grade a session against the fixture's ground-truth set --------
// The expected set is a SIBLING of the fixture dir (`<fixture>.expected.json`,
// never inside the cloned client), distilled from the PEAK-export answer key.
// interpret asserts document facts only — doc_no, date, gross (VAT-incl), and a
// vat rate; account_ref is poirot's job and is not checked here.

interface ExpectedDoc {
	docNo: string; // normalized (matching key)
	docNoRaw: string;
	docDate: string;
	gross: number | null;
	vatRate: number | null;
}

function loadExpected(fixture: string): ExpectedDoc[] | null {
	const p = join(DATA_ROOT, "fixtures", stage, `${fixture}.expected.json`);
	if (!existsSync(p)) return null;
	const j = loadJson<any>(p);
	return (j.documents ?? []).map((d: any) => ({
		docNo: normText(d.doc_no),
		docNoRaw: String(d.doc_no ?? ""),
		docDate: String(d.date ?? "").trim(),
		gross: typeof d.gross === "number" ? d.gross : null,
		vatRate: typeof d.vat_rate === "number" ? d.vat_rate : null,
	}));
}

// watson reports a VAT *amount*; recover the implied rate so it can be compared
// to the answer key's vat_rate. A zero-VAT doc yields rate 0 (a real signal:
// did the reader see the doc as VAT or non-VAT), otherwise null when unrecoverable.
function derivedVatRate(d: DocKey): number | null {
	if (d.gross == null || d.vatAmount == null) return null;
	if (d.vatAmount === 0) return 0;
	const base = d.gross - d.vatAmount;
	return base > 0 ? d.vatAmount / base : null;
}

interface TierB {
	expectedDocs: number;
	matched: number;
	recall: string; // matched / expected
	grossMatch: number; // of matched, gross agrees (VAT-incl)
	dateMatch: number;
	vatMatch: number; // derived rate ≈ expected rate
	valueMatch: string; // of matched, gross AND date agree
	invented: number; // session docs matching no expected doc
	missed: string[]; // expected doc_no not found
	inventedKeys: string[];
}

function gradeVsExpected(docs: Map<string, DocKey>, expected: ExpectedDoc[]): TierB {
	const sessionDocs = [...docs.values()];
	const { matched: pairs, missed, invented } = matchDocs(sessionDocs, expected);
	let grossMatch = 0;
	let dateMatch = 0;
	let vatMatch = 0;
	let valueMatch = 0;
	for (const { expected: exp, actual: hit } of pairs) {
		const g = amountEq(hit.gross, exp.gross);
		const dt = hit.docDate === exp.docDate;
		const vr = exp.vatRate == null ? true : amountEq(derivedVatRate(hit), exp.vatRate, 0.005);
		if (g) grossMatch++;
		if (dt) dateMatch++;
		if (vr) vatMatch++;
		if (g && dt) valueMatch++;
	}
	return {
		expectedDocs: expected.length,
		matched: pairs.length,
		recall: `${pairs.length}/${expected.length}`,
		grossMatch,
		dateMatch,
		vatMatch,
		valueMatch: `${valueMatch}/${pairs.length}`,
		invented: invented.length,
		missed: missed.map((exp) => exp.docNoRaw || "(blank)"),
		inventedKeys: invented.map((s) => s.key),
	};
}

interface SessionGrade {
	session: number;
	coverage: string;
	coverageOk: boolean;
	shapeOk: boolean;
	shapeDetail: string;
	ledgerPass: boolean;
	unaccounted: number;
	excludedClaims: number;
	auditedClaims: number;
	claimsOk: boolean;
	pass: boolean;
	docs: Map<string, DocKey>;
}

function gradeSession(s: number): SessionGrade {
	const client = join(runDir, `s${s}`, "client");
	const manifest = loadYaml<any>(join(client, "ข้อมูลระบบ/_segments/manifest.yaml"));
	const bookable: string[] = (manifest.segments ?? [])
		.filter((seg: any) => !NON_BOOKABLE.has(seg.source_class ?? ""))
		.map((seg: any) => seg.segment_id);

	const covered = bookable.filter((id) => interpFiles(client, id).length > 0);
	const coverageOk = covered.length === bookable.length && bookable.length > 0;

	const shape = script("validate-interpretation", client);
	const shapeOk = shape.code === 0;
	const shapeDetail = shapeOk ? "ok" : (shape.out.match(/✗/g)?.length ?? "?") + " invalid";

	// merge fragments into dispositions, then gate on page accountability.
	script("merge-dispositions", client);
	// ledger needs the --gate flag, so it can't go through the single-arg helper.
	const ledgerFull = (() => {
		try {
			const out = execFileSync(
				"bun",
				["run", "--cwd", SCRIPTS, "ledger", "--", "--gate", "interpret", client],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
			return { code: 0, out };
		} catch (e: any) {
			return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
		}
	})();
	const ledgerPass = /RESULT:\s*PASS/.test(ledgerFull.out);
	const unaccounted = Number(ledgerFull.out.match(/unaccounted:\s*(\d+)/)?.[1] ?? -1);

	// exclusion claims vs lestrade verdicts
	const fragDir = join(client, "ข้อมูลระบบ/_pages/fragments");
	let excludedClaims = 0;
	if (existsSync(fragDir)) {
		for (const f of readdirSync(fragDir).filter((f) => f.endsWith(".yaml"))) {
			const frag = loadYaml<any>(join(fragDir, f));
			excludedClaims += (frag?.entries ?? frag?.dispositions ?? []).filter(
				(e: any) => (e.disposition ?? e.status) === "excluded",
			).length;
		}
	}
	const auditDir = join(client, "ข้อมูลระบบ/_pages/claim-audit");
	let auditedClaims = 0;
	if (existsSync(auditDir)) {
		for (const f of readdirSync(auditDir).filter((f) => f.endsWith(".yaml"))) {
			const rep = loadYaml<any>(join(auditDir, f));
			auditedClaims += (rep?.verdicts ?? rep?.claims ?? []).length;
		}
	}
	const claimsOk = excludedClaims === 0 || auditedClaims >= excludedClaims;

	const pass = coverageOk && shapeOk && ledgerPass && unaccounted === 0 && claimsOk;

	return {
		session: s,
		coverage: `${covered.length}/${bookable.length}`,
		coverageOk,
		shapeOk,
		shapeDetail,
		ledgerPass,
		unaccounted,
		excludedClaims,
		auditedClaims,
		claimsOk,
		pass,
		docs: collectDocs(client, bookable),
	};
}

const grades: SessionGrade[] = [];
for (let s = 1; s <= run.sessions; s++) grades.push(gradeSession(s));

// ---- comparator: sessions vs each other ------------------------------------
const allKeys = new Set<string>();
grades.forEach((g) => g.docs.forEach((_, k) => allKeys.add(k)));
const keysInAll = [...allKeys].filter((k) => grades.every((g) => g.docs.has(k)));
const droppedKeys = [...allKeys].filter((k) => !grades.every((g) => g.docs.has(k)));

function agrees(k: string): boolean {
	const ds = grades.map((g) => g.docs.get(k)!);
	const a = ds[0];
	return ds.every(
		(d) =>
			amountEq(d.gross, a.gross) &&
			d.docNo === a.docNo &&
			d.docDate === a.docDate &&
			d.liCount === a.liCount &&
			amountEq(d.liSum, a.liSum),
	);
}
const agreeing = keysInAll.filter(agrees);

const reliability = grades.filter((g) => g.pass).length;
const valueAgreement = keysInAll.length
	? `${agreeing.length}/${keysInAll.length} (${((agreeing.length / keysInAll.length) * 100).toFixed(1)}%)`
	: "n/a";

// ---- tier-B: each session vs ground truth (when an expected set exists) -----
const expected = loadExpected(run.fixture);
const tierB = expected ? grades.map((g) => gradeVsExpected(g.docs, expected)) : null;
const groundTruth = tierB
	? {
			expected_docs: expected!.length,
			// worst-case recall/invented across sessions is the headline the
			// scoreboard should trust — one good session can't mask a bad one.
			min_recall: tierB.reduce((m, t) => Math.min(m, t.matched), Number.POSITIVE_INFINITY),
			max_invented: tierB.reduce((m, t) => Math.max(m, t.invented), 0),
			per_session: tierB.map((t, i) => ({
				session: i + 1,
				recall: t.recall,
				value_match: t.valueMatch,
				gross_match: `${t.grossMatch}/${t.matched}`,
				date_match: `${t.dateMatch}/${t.matched}`,
				vat_match: `${t.vatMatch}/${t.matched}`,
				invented: t.invented,
				missed: t.missed,
				invented_keys: t.inventedKeys,
			})),
		}
	: null;

const summary = {
	schema: "ksk_stage_eval_summary.v1",
	stage,
	run_id: runId,
	fixture: run.fixture,
	sessions: run.sessions,
	reliability: `${reliability}/${run.sessions}`,
	value_agreement: valueAgreement,
	docs_compared: keysInAll.length,
	docs_dropped: droppedKeys.length,
	dropped_keys: droppedKeys,
	ground_truth: groundTruth,
	per_session: grades.map((g) => ({
		session: g.session,
		pass: g.pass,
		coverage: g.coverage,
		shape: g.shapeOk ? "ok" : g.shapeDetail,
		ledger: g.ledgerPass ? "PASS" : "BLOCK",
		unaccounted: g.unaccounted,
		claims: `${g.auditedClaims}/${g.excludedClaims}`,
	})),
};
writeJson(join(runDir, "summary.json"), summary);
grades.forEach((g) => {
	const { docs, ...rest } = g;
	writeJson(join(runDir, `grade-s${g.session}.json`), rest);
});

console.log(`\nstage-interpret · ${run.fixture} · ${run.sessions} sessions · run ${runId}`);
console.log(
	`  reliability ${summary.reliability} · value-agreement ${valueAgreement} · ` +
		`docs compared ${keysInAll.length} · dropped ${droppedKeys.length}`,
);
grades.forEach((g) =>
	console.log(
		`  s${g.session}: ${g.pass ? "PASS" : "FAIL"} · coverage ${g.coverage} · ` +
			`shape ${g.shapeOk ? "ok" : g.shapeDetail} · ledger ${g.ledgerPass ? "PASS" : "BLOCK"} · ` +
			`unaccounted ${g.unaccounted} · claims ${g.auditedClaims}/${g.excludedClaims}`,
	),
);
if (droppedKeys.length) console.log(`  ⚠ dropped (not in all sessions): ${droppedKeys.join(", ")}`);

if (groundTruth) {
	console.log(
		`\n  ground truth (${groundTruth.expected_docs} expected docs) · ` +
			`min-recall ${groundTruth.min_recall}/${groundTruth.expected_docs} · max-invented ${groundTruth.max_invented}`,
	);
	groundTruth.per_session.forEach((t) => {
		console.log(
			`  s${t.session}: recall ${t.recall} · value ${t.value_match} · ` +
				`gross ${t.gross_match} · date ${t.date_match} · vat ${t.vat_match} · invented ${t.invented}`,
		);
		if (t.missed.length) console.log(`       missed: ${t.missed.join(", ")}`);
	});
} else {
	console.log("\n  ground truth: no expected set (skipped tier-B)");
}
