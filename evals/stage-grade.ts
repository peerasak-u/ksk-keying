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
	RUNS_ROOT,
	amountEq,
	loadJson,
	loadYaml,
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
	gross: number | null;
	docNo: string;
	docDate: string;
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
				docs.set(key, {
					key,
					gross: typeof f.gross_total === "number" ? f.gross_total : null,
					docNo: normText(f.document_no ?? f.document_number ?? ""),
					docDate: String(f.document_date ?? ""),
					liCount: doc.line_items.length,
					liSum: liSum(doc.line_items as any[]),
				});
			});
		}
	}
	return docs;
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
const accounted = grades.map((g) => (g.unaccounted === 0 && g.ledgerPass ? "PASS" : `${g.unaccounted}?`));
const valueAgreement = keysInAll.length
	? `${agreeing.length}/${keysInAll.length} (${((agreeing.length / keysInAll.length) * 100).toFixed(1)}%)`
	: "n/a";

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
