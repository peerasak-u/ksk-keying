// Human-facing layer on top of grade-vs-answer-key.ts: turns the deterministic
// per-document grade into one self-contained Thai-language HTML report per
// client-month, grouped by root-cause bucket instead of by document, so a
// reviewer sees the *pattern* of what went wrong, not a wall of rows.
//
// This is a post-run comparison tool (same rule as grade-vs-answer-key.ts —
// see its header and CLAUDE.md "never peek at answer-keys/ mid-run"): only
// run it against a client-month that already finished Stage 5 and passed its
// Ledger Gates. It never edits the run or the answer key — every mismatch is
// a finding for human review, never an automatic fix (see
// memory/dont-override-verified-answer-key.md).
//
// It also folds in reference-report-check.ts's output when present, because
// a real run (client 339, see project history) once had a whole source file
// (~101 invoices) silently mis-classified as a "summary report" and excluded
// at segmentation — a failure mode grade-vs-answer-key.ts alone can only see
// as a generic recall gap, not diagnose. reference-report-check.ts already
// exists to catch exactly this; this script just surfaces its findings
// alongside the document-level grade instead of leaving them in a separate
// yaml file nobody opens.
//
//   bun run answer-key-report.ts -- --client <dir> --key <dir> [--label <name>] [--out <dir>]
//   bun run answer-key-report.ts -- --batch <yaml-file> [--out <dir>]
//
//   --client  one finished run's client-month folder (comma-separate several
//             attempts of the same client-month, same convention as
//             grade-vs-answer-key.ts).
//   --key     the client-month's answer-key folder ("File PEAK import" or its
//             parent) — see samples/answer-keys/<client>/<month>/.
//   --label   display name for the report header (default: basename of --client).
//   --batch   a yaml file listing several {client, key, label} entries — one
//             HTML per entry plus an index.html linking them.
//   --out     output directory (default: samples/evals/_runs/answer-key-report/<timestamp>/).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import {
	type DocGrade,
	type RunVsKeyGrade,
	gradeRun,
	loadKeyDocs,
	loadRunDocs,
} from "./grade-vs-answer-key";
import { amountEq, nowIso, parseArgs, writeJson } from "./lib";

// ---------------------------------------------------------------------------
// reference-report-check.yaml (produced by the ksk-keying skill's own script,
// .claude/skills/ksk-keying/scripts/reference-report-check.ts) — read-only,
// optional. Its schema: { schema, files_checked, results: FileResult[] }.

type RefReportResult = {
	file: string;
	status: "checked" | "skipped";
	skip_reason?: string;
	report_total?: number;
	matched_total?: number;
	unmatched_total?: number;
	unmatched_row_count?: number;
	total_row_count?: number;
	amount_confidence?: "high" | "low";
};

function loadReferenceReportGaps(clientDir: string): RefReportResult[] {
	// mirrors pagesDir(clientDir) from the ksk-keying skill's paths.ts, kept
	// as a literal path here so evals/ has no import dependency on the skill
	// scripts directory (they live in separate packages).
	const p = join(clientDir, "ข้อมูลระบบ", "_pages", "reference-report-check.yaml");
	if (!existsSync(p)) return [];
	const doc = yamlParse(readFileSync(p, "utf8")) as { results?: RefReportResult[] } | null;
	return (doc?.results ?? []).filter(
		(r) =>
			(r.status === "checked" && (r.unmatched_total ?? 0) > 0.01) ||
			// a "skipped" file (typically a PDF, not auto-totalable) is exactly
			// the shape of the client-339 failure — a whole source excluded as a
			// "summary report" with nobody re-checking it — so it's a finding
			// too, not silently dropped just because the auto-check couldn't run.
			r.status === "skipped",
	);
}

// ---------------------------------------------------------------------------
// Root-cause classification — deterministic rules over grade-vs-answer-key's
// own DocGrade fields. Every bucket is a FINDING for human review, never a
// reason to edit the run or the answer key.

type Bucket =
	| "missing"
	| "sign_flip"
	| "date_mismatch"
	| "value_mismatch_other"
	| "account_same_family"
	| "account_diff_family"
	| "invented"
	| "reference_report_gap";

const BUCKET_LABEL_TH: Record<Bucket, string> = {
	missing: "เอกสารหายไป — ไม่พบในผลลัพธ์ที่ generate",
	sign_flip: "เครื่องหมาย +/- ผิด (ต้องสงสัยใบลดหนี้/เอกสารปรับปรุง)",
	date_mismatch: "วันที่เอกสารไม่ตรงกับ Answer Key",
	value_mismatch_other: "ยอดเงินไม่ตรงกับ Answer Key",
	account_same_family: "รหัสบัญชีผิด — สลับ sub-code ในหมวดเดียวกัน",
	account_diff_family: "รหัสบัญชีผิด — คนละหมวดบัญชี",
	invented: "รายการที่ generate เกินมา ไม่มีใน Answer Key",
	reference_report_gap: "ไฟล์รายงานสรุปที่ถูกตัดออก มียอดที่หาไม่เจอในที่อื่นของงาน",
};

const BUCKET_ACTION_TH: Record<Bucket, string> = {
	missing:
		"ตรวจว่าเอกสารนี้ถูกตัดตั้งแต่ segmentation หรือหลุดระหว่าง interpret/link/group — ถ้ามีไฟล์ต้นทางที่ถูก exclude เป็น reference_report ให้เช็คแถวใน bucket ด้านล่างประกอบ",
	sign_flip:
		"เปิดเอกสารต้นทางเทียบว่าเป็นใบลดหนี้/เอกสารปรับปรุงจริงหรือไม่ ถ้าใช่ให้แก้ prompt ของ watson ให้บันทึกเครื่องหมายถูกต้อง",
	date_mismatch: "เปิดเอกสารต้นทางยืนยันวันที่จริง อาจเป็นความกำกวมของ OCR ระหว่างวันที่ออกเอกสารกับวันที่อื่นบนหน้าเดียวกัน",
	value_mismatch_other: "เปิดเอกสารต้นทางเทียบยอดทีละบรรทัด อาจเป็นปัญหาการรวมยอดหรืออ่านตัวเลขผิด",
	account_same_family:
		"ทบทวนเกณฑ์การเลือก sub-code ของ poirot สำหรับหมวดนี้ มักเป็นสัญญาณว่าขาดหลักฐาน (coa_usage/tax_id) ที่ชัดเจนพอ",
	account_diff_family:
		"ตรวจ prompt/บริบทของ poirot ว่าทำไมถึงเลือกคนละหมวดบัญชี ผลกระทบสูงกว่ากรณี sub-code เพราะกระทบงบรวม",
	invented:
		"เช็คว่าเป็นรายการซ้ำ (ควรถูก link/merge กับของเดิม), เป็นรายการนอกขอบเขตของ Answer Key (เช่น PEAK_ImportJournal), หรือเป็น dataset gap ที่ Answer Key ไม่ครอบคลุมจริง",
	reference_report_gap:
		"เปิดไฟล์รายงานที่ถูก exclude แล้วไล่แถวที่ unmatched — ถ้ายอดไม่เจอที่ไหนเลยในงาน แปลว่าการ exclude ทั้งไฟล์อาจตัดเอกสารจริงทิ้งไปด้วย ควรพิจารณาส่งให้ ksk-lestrade ตรวจ claim การ exclude ของไฟล์นี้ซ้ำ",
};

interface Finding {
	bucket: Bucket;
	doc_no: string;
	detail: string;
	amount_impact: number | null;
}

function accountFamily(code: string): string {
	return code.slice(0, 3);
}

function classifyDocs(docs: DocGrade[]): Finding[] {
	const findings: Finding[] = [];
	for (const d of docs) {
		if (!d.matched) {
			findings.push({
				bucket: "missing",
				doc_no: d.key_doc_no,
				detail: `คาดหวัง ${d.gross_expected ?? "?"} บาท วันที่ ${d.date_expected || "?"} บัญชี ${d.account_expected || "?"}`,
				amount_impact: d.gross_expected,
			});
			continue;
		}
		if (!d.value_match) {
			const isSignFlip =
				d.gross_actual != null &&
				d.gross_expected != null &&
				Math.abs(d.gross_expected) > 0.01 &&
				Math.abs(d.gross_actual + d.gross_expected) < 0.02;
			const dateOnly =
				!isSignFlip &&
				d.gross_actual != null &&
				d.gross_expected != null &&
				amountEq(d.gross_actual, d.gross_expected) &&
				d.date_actual !== d.date_expected;
			const bucket: Bucket = isSignFlip ? "sign_flip" : dateOnly ? "date_mismatch" : "value_mismatch_other";
			findings.push({
				bucket,
				doc_no: d.key_doc_no,
				detail: `Answer Key: ${d.gross_expected ?? "?"} บาท / ${d.date_expected || "?"} — ผลลัพธ์: ${d.gross_actual ?? "?"} บาท / ${d.date_actual || "?"}`,
				amount_impact:
					d.gross_actual != null && d.gross_expected != null ? d.gross_actual - d.gross_expected : null,
			});
		}
		if (!d.account_match) {
			const sameFamily =
				!!d.account_expected && !!d.account_actual && accountFamily(d.account_expected) === accountFamily(d.account_actual);
			findings.push({
				bucket: sameFamily ? "account_same_family" : "account_diff_family",
				doc_no: d.key_doc_no,
				detail: `Answer Key: ${d.account_expected || "?"} — ผลลัพธ์: ${d.account_actual || "(ไม่มี)"}`,
				amount_impact: d.gross_expected,
			});
		}
	}
	return findings;
}

function classifyInvented(grade: RunVsKeyGrade): Finding[] {
	return grade.invented_keys.map((k) => ({
		bucket: "invented" as const,
		doc_no: k,
		detail: "ไม่พบเอกสารที่ตรงกันฝั่ง Answer Key",
		amount_impact: null,
	}));
}

function classifyReferenceReportGaps(gaps: RefReportResult[]): Finding[] {
	return gaps.map((g) => ({
		bucket: "reference_report_gap" as const,
		doc_no: g.file,
		detail:
			g.status === "skipped"
				? `ไม่สามารถตรวจยอดอัตโนมัติได้ (${g.skip_reason ?? "ไฟล์ไม่ใช่สเปรดชีต"}) — ต้องเปิดไฟล์ตรวจด้วยตาว่ารายการในนี้ถูกบันทึกไว้ที่อื่นครบหรือไม่`
				: `ยอดรายงาน ${g.report_total ?? "?"} บาท · หาไม่เจอในที่อื่น ${g.unmatched_total ?? "?"} บาท (${g.unmatched_row_count ?? "?"}/${g.total_row_count ?? "?"} แถว, ความมั่นใจ: ${g.amount_confidence ?? "?"})`,
		amount_impact: g.status === "skipped" ? null : (g.unmatched_total ?? null),
	}));
}

// ---------------------------------------------------------------------------
// HTML rendering — one self-contained file per client-month. Short by design:
// findings are grouped and capped per bucket, not listed document-by-document.

const EXAMPLES_PER_BUCKET = 6;

function esc(s: string): string {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmtBaht(n: number | null): string {
	if (n == null || Number.isNaN(n)) return "-";
	const sign = n < 0 ? "-" : "";
	return `${sign}${Math.abs(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderBucketSection(bucket: Bucket, findings: Finding[]): string {
	if (!findings.length) return "";
	const impact = findings.reduce((s, f) => s + Math.abs(f.amount_impact ?? 0), 0);
	const shown = findings.slice(0, EXAMPLES_PER_BUCKET);
	const rest = findings.length - shown.length;
	return `
  <section class="bucket">
    <h3><span class="count">${findings.length}</span> ${esc(BUCKET_LABEL_TH[bucket])}${impact > 0 ? ` <span class="impact">ผลกระทบรวม ~${fmtBaht(impact)} บาท</span>` : ""}</h3>
    <p class="action">${esc(BUCKET_ACTION_TH[bucket])}</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>เอกสาร/ไฟล์</th><th>รายละเอียด</th></tr></thead>
        <tbody>
          ${shown.map((f) => `<tr><td>${esc(f.doc_no)}</td><td>${esc(f.detail)}</td></tr>`).join("\n          ")}
        </tbody>
      </table>
    </div>
    ${rest > 0 ? `<p class="more">+ อีก ${rest} รายการรูปแบบเดียวกัน</p>` : ""}
  </section>`;
}

const BUCKET_ORDER: Bucket[] = [
	"reference_report_gap",
	"missing",
	"sign_flip",
	"account_diff_family",
	"account_same_family",
	"value_mismatch_other",
	"date_mismatch",
	"invented",
];

function renderReport(opts: {
	label: string;
	grade: RunVsKeyGrade;
	findings: Finding[];
	generatedAt: string;
}): string {
	const { label, grade, findings, generatedAt } = opts;
	const byBucket = new Map<Bucket, Finding[]>();
	for (const f of findings) byBucket.set(f.bucket, [...(byBucket.get(f.bucket) ?? []), f]);

	const recallPct = grade.key_docs ? Math.round((grade.matched / grade.key_docs) * 100) : 0;
	const [vmN] = grade.value_match.split("/").map(Number);
	const [amN] = grade.account_match.split("/").map(Number);
	const valuePct = grade.matched ? Math.round((vmN / grade.matched) * 100) : 0;
	const accountPct = grade.matched ? Math.round((amN / grade.matched) * 100) : 0;

	const sections = BUCKET_ORDER.map((b) => renderBucketSection(b, byBucket.get(b) ?? [])).join("\n");
	const totalFindings = findings.length;

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>ตรวจสอบผลลัพธ์เทียบ Answer Key — ${esc(label)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem;
    font-family: "Noto Sans Thai", "Sarabun", system-ui, -apple-system, sans-serif;
    background: #f6f5f2; color: #1f1b16; line-height: 1.6;
  }
  @media (prefers-color-scheme: dark) { body { background: #17140f; color: #efe9df; } }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  .meta { color: #78706420; font-size: .85rem; opacity: .75; margin-bottom: 1.5rem; }
  .warn {
    border: 1px solid #c8863040; background: #f4e3c840; border-radius: .5rem;
    padding: .75rem 1rem; font-size: .85rem; margin-bottom: 1.5rem;
  }
  @media (prefers-color-scheme: dark) { .warn { background: #4a380f40; border-color: #c8863060; } }
  .scorecards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .75rem; margin-bottom: 2rem; }
  .card {
    border-radius: .6rem; padding: 1rem; background: #fff; border: 1px solid #e5e0d5;
  }
  @media (prefers-color-scheme: dark) { .card { background: #211d16; border-color: #362f22; } }
  .card .num { font-size: 1.7rem; font-weight: 700; }
  .card .lbl { font-size: .78rem; opacity: .7; }
  .card.ok .num { color: #2f7d4f; }
  .card.warn2 .num { color: #b8862b; }
  .card.bad .num { color: #b8452f; }
  section.bucket { margin-bottom: 1.75rem; border-top: 1px solid #e5e0d5; padding-top: 1rem; }
  @media (prefers-color-scheme: dark) { section.bucket { border-color: #362f22; } }
  h3 { font-size: 1rem; margin: 0 0 .35rem; display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
  .count {
    display: inline-flex; min-width: 1.6rem; height: 1.6rem; align-items: center; justify-content: center;
    background: #b8452f; color: #fff; border-radius: 999px; font-size: .8rem; font-weight: 700; padding: 0 .4rem;
  }
  .impact { font-size: .78rem; opacity: .65; font-weight: 400; }
  .action { font-size: .85rem; opacity: .8; margin: 0 0 .6rem; }
  .table-wrap { overflow-x: auto; border: 1px solid #e5e0d5; border-radius: .4rem; }
  @media (prefers-color-scheme: dark) { .table-wrap { border-color: #362f22; } }
  table { border-collapse: collapse; width: 100%; font-size: .82rem; }
  th, td { text-align: left; padding: .45rem .65rem; white-space: nowrap; }
  td:last-child, th:last-child { white-space: normal; }
  thead tr { background: #efe9dc; }
  @media (prefers-color-scheme: dark) { thead tr { background: #2a251b; } }
  tbody tr:nth-child(even) { background: #faf8f3; }
  @media (prefers-color-scheme: dark) { tbody tr:nth-child(even) { background: #1d1a13; } }
  .more { font-size: .78rem; opacity: .6; margin: .4rem 0 0; }
  .clean { opacity: .7; font-size: .9rem; }
  footer { margin-top: 2.5rem; font-size: .75rem; opacity: .55; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ตรวจสอบผลลัพธ์เทียบ Answer Key — ${esc(label)}</h1>
  <p class="meta">สร้างเมื่อ ${esc(generatedAt)} · เอกสารใน Answer Key ทั้งหมด ${grade.key_docs} รายการ</p>
  <p class="warn">รายงานนี้เป็นข้อมูลสำหรับให้มนุษย์ตรวจทานเท่านั้น ทุกรายการคือ finding ที่ต้องตรวจสอบ — ห้ามใช้แก้ไข Answer Key หรือแก้ผลลัพธ์การรันโดยอัตโนมัติ</p>

  <div class="scorecards">
    <div class="card ${recallPct >= 95 ? "ok" : recallPct >= 85 ? "warn2" : "bad"}">
      <div class="num">${recallPct}%</div><div class="lbl">Recall (${grade.matched}/${grade.key_docs})</div>
    </div>
    <div class="card ${valuePct >= 95 ? "ok" : valuePct >= 85 ? "warn2" : "bad"}">
      <div class="num">${valuePct}%</div><div class="lbl">ยอด+วันที่ตรง (${grade.value_match})</div>
    </div>
    <div class="card ${accountPct >= 95 ? "ok" : accountPct >= 85 ? "warn2" : "bad"}">
      <div class="num">${accountPct}%</div><div class="lbl">รหัสบัญชีตรง (${grade.account_match})</div>
    </div>
    <div class="card ${totalFindings === 0 ? "ok" : totalFindings <= 5 ? "warn2" : "bad"}">
      <div class="num">${totalFindings}</div><div class="lbl">ข้อค้นพบทั้งหมด</div>
    </div>
  </div>

  ${totalFindings === 0 ? '<p class="clean">ไม่พบ finding ในรอบนี้ — ผลลัพธ์ตรงกับ Answer Key ทุกรายการที่เทียบได้</p>' : sections}

  <footer>ksk-keying-answer-check · schema ksk_answer_key_report.v1 · ห้าม override answer key จากผลลัพธ์นี้ ไม่ว่ากรณีใด</footer>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CLI

type Entry = { client: string; key: string; label?: string };

function usage(): never {
	console.error(`Usage: bun run answer-key-report.ts -- --client <dir> --key <dir> [--label <name>] [--out <dir>]
   or: bun run answer-key-report.ts -- --batch <yaml-file> [--out <dir>]

--batch yaml shape:
  entries:
    - { client: "samples/clients/_339 บจก เจ็ทเดอร์/05-69", key: "samples/answer-keys/_339 บจก เจ็ทเดอร์/05-69", label: "339 เจ็ทเดอร์ พ.ค." }
`);
	process.exit(2);
}

function slugify(s: string): string {
	return (
		s
			.normalize("NFKC")
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+|-+$/g, "") || "report"
	);
}

function runOne(entry: Entry, outDir: string, generatedAt: string): { label: string; file: string; grade: RunVsKeyGrade } {
	const clientDirs = entry.client.split(",").map((s) => s.trim());
	const label = entry.label || basename(clientDirs[0]);
	const keyDocs = loadKeyDocs(entry.key);
	// worst-case framing across attempts, matching grade-vs-answer-key.ts;
	// with a single client dir this is just that run's own grade.
	const grades = clientDirs.map((dir) => gradeRun(loadRunDocs(dir), keyDocs));
	const grade = grades.reduce((worst, g) => (g.matched < worst.matched ? g : worst));

	const findings = [
		...classifyDocs(grade.docs),
		...classifyInvented(grade),
		...classifyReferenceReportGaps(loadReferenceReportGaps(clientDirs[0])),
	];

	const html = renderReport({ label, grade, findings, generatedAt });
	const file = join(outDir, `${slugify(label)}.html`);
	writeFileSync(file, html);
	writeJson(join(outDir, `${slugify(label)}.json`), { schema: "ksk_answer_key_report.v1", label, grade, findings });
	return { label, file, grade };
}

function renderIndex(results: { label: string; file: string; grade: RunVsKeyGrade }[], generatedAt: string): string {
	const rows = results
		.map((r) => {
			const recallPct = r.grade.key_docs ? Math.round((r.grade.matched / r.grade.key_docs) * 100) : 0;
			return `<tr><td><a href="${esc(basename(r.file))}">${esc(r.label)}</a></td><td>${recallPct}%</td><td>${esc(r.grade.value_match)}</td><td>${esc(r.grade.account_match)}</td></tr>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>ตรวจสอบผลลัพธ์เทียบ Answer Key — สรุปรวม</title>
<style>
  body { font-family: "Noto Sans Thai","Sarabun",system-ui,sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; } th,td { text-align:left; padding:.5rem; border-bottom:1px solid #ddd; }
</style></head>
<body>
<h1>ตรวจสอบผลลัพธ์เทียบ Answer Key — สรุปรวม</h1>
<p>สร้างเมื่อ ${esc(generatedAt)}</p>
<table><thead><tr><th>ลูกค้า</th><th>Recall</th><th>ยอด+วันที่ตรง</th><th>รหัสบัญชีตรง</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}

function main() {
	const { flags } = parseArgs(process.argv.slice(2));
	const generatedAt = nowIso();

	let entries: Entry[];
	if (typeof flags.batch === "string") {
		const doc = yamlParse(readFileSync(resolve(flags.batch), "utf8")) as { entries?: Entry[] } | null;
		entries = doc?.entries ?? [];
		if (!entries.length) {
			console.error(`no entries in ${flags.batch}`);
			process.exit(2);
		}
	} else {
		const client = typeof flags.client === "string" ? flags.client : "";
		const key = typeof flags.key === "string" ? flags.key : "";
		if (!client || !key) usage();
		entries = [{ client, key, label: typeof flags.label === "string" ? flags.label : undefined }];
	}

	const outDir = typeof flags.out === "string" ? resolve(flags.out) : join("samples", "evals", "_runs", "answer-key-report", generatedAt.replace(/[:.]/g, "-"));
	mkdirSync(outDir, { recursive: true });

	const results = entries.map((e) => runOne(e, outDir, generatedAt));

	if (results.length > 1) {
		writeFileSync(join(outDir, "index.html"), renderIndex(results, generatedAt));
		console.log(`\nwrote ${results.length} reports + index.html to ${outDir}`);
	} else {
		console.log(`\nwrote report to ${results[0].file}`);
	}
	for (const r of results) {
		const recallPct = r.grade.key_docs ? Math.round((r.grade.matched / r.grade.key_docs) * 100) : 0;
		console.log(`  ${r.label}: recall ${recallPct}% · value-match ${r.grade.value_match} · account-match ${r.grade.account_match}`);
	}
}

if (import.meta.main) main();
