// Deterministic cross-segment duplicate detector ("agents judge, scripts
// copy"). Stage-2 children (ksk-watson/ksk-marple) only ever see their own
// ≤15-page dispatch window, so the same physical document scanned into two
// DIFFERENT segments is invisible to both — neither ever writes a
// page_disposition: excluded for it, and no reason it ever surfaces for
// human review. prelink.ts already notices "same document_no in two
// different segments" (it demotes the whole cluster to residue for
// ksk-sherlock's booking-cluster judgment), but that judgment never becomes a
// page exclusion. This script closes that specific gap: it flags candidate
// cross-segment duplicates for ksk-lestrade to audit the same way it audits
// any other `duplicate` claim.
//
// Exit codes: 0 candidates written (possibly zero), 2 usage/malformed input.

import { relative } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { documentRecordsOf, type DocRecord, type InterpFile } from "./groups-lib";
import { loadInterpretations, resolveClientDir } from "./groups-io";
import { pagesDir } from "./paths";

export const CROSS_SEGMENT_DUPLICATE_CANDIDATES_SCHEMA = "ksk_cross_segment_duplicate_candidates.v1";

export type CandidateMember = {
	segment: string;
	interpretation: string;
	source_file: string | null;
	source_page: number | null;
	source_sheet: string | null;
	date: string | null;
	amount: number | null;
	tax_id: string | null;
};

export type Candidate = {
	document_no: string;
	matched_on: string[];
	members: CandidateMember[];
};

function sourceRefOf(record: DocRecord): { file: string | null; page: number | null; sheet: string | null } {
	const entry = record.sourceEntry;
	if (entry) {
		return {
			file: typeof entry.source_file === "string" ? entry.source_file : null,
			page: typeof entry.source_page === "number" ? entry.source_page : null,
			sheet: typeof entry.source_sheet === "string" ? entry.source_sheet : null,
		};
	}
	// whole-file fallback (Shape A, single-document file): sourceEntry is
	// null but the sole documents[] entry still carries source_file/page.
	const sole = record.file.json.documents?.[0];
	return {
		file: typeof sole?.source_file === "string" ? sole.source_file : null,
		page: typeof sole?.source_page === "number" ? sole.source_page : null,
		sheet: typeof (sole as Record<string, unknown> | undefined)?.source_sheet === "string"
			? ((sole as Record<string, unknown>).source_sheet as string)
			: null,
	};
}

function memberOf(record: DocRecord): CandidateMember {
	const ref = sourceRefOf(record);
	const amounts = [record.facts.gross_total, record.facts.net_paid].filter(
		(n): n is number => typeof n === "number",
	);
	const taxIds = [record.facts.seller_tax_id, record.facts.buyer_tax_id].filter(
		(t): t is string => typeof t === "string" && t.length > 0,
	);
	return {
		segment: record.file.segmentId,
		interpretation: record.file.path,
		source_file: ref.file,
		source_page: ref.page,
		source_sheet: ref.sheet,
		date: typeof record.facts.document_date === "string" ? record.facts.document_date : null,
		amount: amounts[0] ?? null,
		tax_id: taxIds[0] ?? null,
	};
}

// Corroborating signals beyond the shared document_no itself — a bare
// number collision is not evidence of sameness (handwritten receipt books
// commonly reuse small numbers across unrelated documents; prelink.ts hit
// this exact false positive, client _345 "46"). Require at least one more
// fact to agree between the two records before treating them as the same
// physical document scanned twice.
function corroboratingSignals(a: DocRecord, b: DocRecord): string[] {
	const signals: string[] = [];
	if (
		typeof a.facts.document_date === "string" &&
		a.facts.document_date === b.facts.document_date
	)
		signals.push("document_date");
	const amountsA = [a.facts.gross_total, a.facts.net_paid].filter((n): n is number => typeof n === "number");
	const amountsB = [b.facts.gross_total, b.facts.net_paid].filter((n): n is number => typeof n === "number");
	if (amountsA.some((n) => amountsB.includes(n))) signals.push("amount");
	const taxIdsA = [a.facts.seller_tax_id, a.facts.buyer_tax_id].filter(
		(t): t is string => typeof t === "string" && t.length > 0,
	);
	const taxIdsB = [b.facts.seller_tax_id, b.facts.buyer_tax_id].filter(
		(t): t is string => typeof t === "string" && t.length > 0,
	);
	if (taxIdsA.some((t) => taxIdsB.includes(t))) signals.push("tax_id");
	return signals;
}

export function computeCrossSegmentDuplicateCandidates(interps: InterpFile[]): Candidate[] {
	const byDocNo = new Map<string, DocRecord[]>();
	for (const file of interps) {
		for (const record of documentRecordsOf(file)) {
			const no = record.facts.document_no;
			if (typeof no !== "string" || !no) continue;
			byDocNo.set(no, [...(byDocNo.get(no) ?? []), record]);
		}
	}

	const candidates: Candidate[] = [];
	for (const [documentNo, records] of byDocNo) {
		const distinctSegments = new Set(records.map((r) => r.file.segmentId));
		if (distinctSegments.size < 2) continue; // same segment only — not our concern

		// Only keep records that corroborate with at least one OTHER record
		// from a different segment on some second signal — a document_no
		// collision with no other agreement is too weak to flag.
		const matchedOn = new Set<string>();
		const corroborated = new Set<number>();
		for (let i = 0; i < records.length; i++) {
			for (let j = i + 1; j < records.length; j++) {
				if (records[i].file.segmentId === records[j].file.segmentId) continue;
				const signals = corroboratingSignals(records[i], records[j]);
				if (signals.length === 0) continue;
				corroborated.add(i);
				corroborated.add(j);
				for (const s of signals) matchedOn.add(s);
			}
		}
		if (corroborated.size < 2) continue;

		candidates.push({
			document_no: documentNo,
			matched_on: ["same_document_no", ...matchedOn],
			members: [...corroborated].map((i) => memberOf(records[i])),
		});
	}
	return candidates;
}

function usage(): never {
	console.error(`Usage: bun run cross-segment-duplicates -- <client-dir>

Flags candidate cross-segment duplicate pages — the same document_no seen in
two DIFFERENT segments' Stage-2 interpretations, corroborated by a second
signal (date, amount, or tax id) — for ksk-lestrade to audit the same way it
audits any other duplicate claim. Writes
ข้อมูลระบบ/_pages/cross-segment-duplicate-candidates.yaml (possibly empty).

Run after prelink and before dispatching ksk-sherlock, so a confirmed
duplicate is excluded before Stage 4 builds doc groups from it.

Exit codes: 0 candidates written, 2 usage/malformed input.
`);
	process.exit(2);
}

function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length !== 1 || argv[0].startsWith("--")) usage();
	const clientDir = resolveClientDir(argv[0]);

	const interps = loadInterpretations(clientDir);
	if (interps.size === 0) {
		console.error("no interpretation files under ข้อมูลระบบ/_segments — run Stage 2 first");
		process.exit(2);
	}

	const candidates = computeCrossSegmentDuplicateCandidates([...interps.values()].flat());

	const outDir = pagesDir(clientDir);
	mkdirSync(outDir, { recursive: true });
	const outPath = `${outDir}/cross-segment-duplicate-candidates.yaml`;
	writeFileSync(
		outPath,
		yamlStringify({
			schema: CROSS_SEGMENT_DUPLICATE_CANDIDATES_SCHEMA,
			note: "machine-flagged candidates only — ksk-lestrade audits each one before any disposition changes; this file is never read as ground truth",
			candidates,
		}),
	);
	console.log(
		`wrote ${relative(clientDir, outPath)}: ${candidates.length} candidate(s) for ksk-lestrade`,
	);
}

if (import.meta.main) main();
