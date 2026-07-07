// Stage 3 pre-link — deterministic transaction-link proposer ("agents judge,
// scripts copy"). Clusters Stage-2 interpretations on EXACT evidence only:
//
//   rule same_document_no          — one file's document_no appears as another
//                                    file's document_no or reference
//   rule amount_date_counterparty  — identical (amount, document_date,
//                                    counterparty tax id) triple
//
// and writes ข้อมูลระบบ/_doc_groups/links.draft.yaml (ksk_links_draft.v1):
// proposed clusters plus a residue list of segments no exact rule matched.
// ksk-sherlock reads the draft, adopts/overrides the proposals, judges only
// the residue, and remains the single owner of the final links.yaml — this
// script never writes links.yaml and its output is a proposal, not a
// decision. Anything ambiguous (duplicate document numbers, clusters with no
// bookable primary) is demoted to residue rather than guessed at.
//
// Exit codes: 0 draft written, 2 usage/malformed input.

import { join, relative } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { docGroupsDir } from "./paths";
import { isStatementShaped, type InterpFile } from "./groups-lib";
import { loadInterpretations, resolveClientDir } from "./groups-io";

export const LINKS_DRAFT_SCHEMA = "ksk_links_draft.v1";

// Thin per-file fingerprint — everything the exact rules can match on.
export type Fingerprint = {
	segmentId: string;
	path: string;
	documentNo: string | null;
	reference: string | null;
	date: string | null;
	amounts: number[]; // gross_total + net_paid, deduped
	taxIds: string[]; // seller + buyer tax ids present on the document
	statement: boolean;
	// false only when the interpretation explicitly marked every document
	// usable_for_booking: false (a receipt/slip that is evidence, not a
	// booking) — such a file's document_no is never proposed as bookable
	bookable: boolean;
};

export function fingerprintOf(file: InterpFile): Fingerprint {
	const facts = file.json.accounting_facts ?? {};
	const amounts = [...new Set([facts.gross_total, facts.net_paid].filter(
		(n): n is number => typeof n === "number" && n !== 0,
	))];
	const taxIds = [...new Set([facts.seller_tax_id, facts.buyer_tax_id].filter(
		(t): t is string => typeof t === "string" && t.length > 0,
	))];
	const documents = file.json.documents ?? [];
	const flagged = documents.filter((d) => typeof d.usable_for_booking === "boolean");
	const bookable = !(flagged.length > 0 && flagged.every((d) => d.usable_for_booking === false));
	return {
		segmentId: file.segmentId,
		path: file.path,
		documentNo: typeof facts.document_no === "string" && facts.document_no ? facts.document_no : null,
		reference: typeof facts.reference === "string" && facts.reference ? facts.reference : null,
		date: typeof facts.document_date === "string" && facts.document_date ? facts.document_date : null,
		amounts,
		taxIds,
		statement: isStatementShaped(file.json),
		bookable,
	};
}

type Pair = { a: number; b: number; rule: string; evidence: string };

function exactPairs(prints: Fingerprint[]): Pair[] {
	const pairs: Pair[] = [];
	for (let i = 0; i < prints.length; i++) {
		for (let j = i + 1; j < prints.length; j++) {
			const a = prints[i];
			const b = prints[j];
			if (a.statement || b.statement) continue;
			// rule 1: exact shared document/reference number
			const numbersA = [a.documentNo, a.reference].filter(Boolean) as string[];
			const numbersB = [b.documentNo, b.reference].filter(Boolean) as string[];
			const shared = numbersA.find((n) => numbersB.includes(n));
			if (shared) {
				pairs.push({
					a: i,
					b: j,
					rule: "same_document_no",
					evidence: `shared number ${shared} (${a.segmentId} ↔ ${b.segmentId})`,
				});
				continue;
			}
			// rule 2: identical amount + date + counterparty tax id
			if (!a.date || a.date !== b.date) continue;
			const amount = a.amounts.find((n) => b.amounts.includes(n));
			if (amount == null) continue;
			const taxId = a.taxIds.find((t) => b.taxIds.includes(t));
			if (!taxId) continue;
			pairs.push({
				a: i,
				b: j,
				rule: "amount_date_counterparty",
				evidence: `amount ${amount} + date ${a.date} + tax id ${taxId} (${a.segmentId} ↔ ${b.segmentId})`,
			});
		}
	}
	return pairs;
}

export type DraftCluster = {
	draft_id: string;
	segments: string[];
	members: { segment: string; interpretation: string; document_no: string | null; proposed_role: string }[];
	bookable_docs: string[];
	evidence: string;
	rules: string[];
	confidence: "high" | "medium";
};

export type DraftResidue = {
	segment: string;
	interpretation: string;
	document_no: string | null;
	date: string | null;
	amounts: number[];
	tax_ids: string[];
	reason: string;
};

export type DraftResult = {
	proposed: DraftCluster[];
	residue: DraftResidue[];
};

// Union-find clustering over the exact-match pairs; ambiguous clusters are
// demoted to residue wholesale (sherlock judges them), never half-proposed.
export function buildDraft(prints: Fingerprint[]): DraftResult {
	const parent = prints.map((_, i) => i);
	const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
	const union = (a: number, b: number) => {
		parent[find(a)] = find(b);
	};
	const pairs = exactPairs(prints);
	for (const pair of pairs) union(pair.a, pair.b);

	const clusters = new Map<number, number[]>();
	prints.forEach((_, i) => {
		const root = find(i);
		clusters.set(root, [...(clusters.get(root) ?? []), i]);
	});

	const proposed: DraftCluster[] = [];
	const residue: DraftResidue[] = [];
	const toResidue = (index: number, reason: string) => {
		const p = prints[index];
		residue.push({
			segment: p.segmentId,
			interpretation: p.path,
			document_no: p.documentNo,
			date: p.date,
			amounts: p.amounts,
			tax_ids: p.taxIds,
			reason,
		});
	};

	let seq = 0;
	for (const members of [...clusters.values()].sort((a, b) => a[0] - b[0])) {
		const clusterPrints = members.map((i) => prints[i]);
		// statements are never auto-clustered; single statements become
		// standalone proposals so sherlock doesn't re-derive the obvious
		if (members.length === 1) {
			const p = clusterPrints[0];
			if (p.statement) {
				proposed.push({
					draft_id: `draft-${String(++seq).padStart(3, "0")}`,
					segments: [p.segmentId],
					members: [
						{ segment: p.segmentId, interpretation: p.path, document_no: null, proposed_role: "bank_statement" },
					],
					bookable_docs: [],
					evidence: "standalone bank statement",
					rules: ["standalone_statement"],
					confidence: "high",
				});
			} else if (p.documentNo && p.bookable) {
				proposed.push({
					draft_id: `draft-${String(++seq).padStart(3, "0")}`,
					segments: [p.segmentId],
					members: [
						{ segment: p.segmentId, interpretation: p.path, document_no: p.documentNo, proposed_role: "primary_invoice" },
					],
					bookable_docs: [p.documentNo],
					evidence: "no exact cross-segment match; standalone document",
					rules: ["standalone"],
					confidence: "high",
				});
			} else {
				toResidue(
					members[0],
					p.documentNo
						? "single evidence-only document (usable_for_booking: false) with no linked booking — needs judgment"
						: "single document with no document_no — needs judgment on where it belongs",
				);
			}
			continue;
		}
		// multi-member cluster: distinct BOOKABLE document numbers become
		// bookable docs (evidence-only files never do); the same number in two
		// files (duplicate copies) is ambiguous
		const byDocNo = new Map<string, number[]>();
		for (const i of members) {
			const docNo = prints[i].documentNo;
			if (docNo && prints[i].bookable) byDocNo.set(docNo, [...(byDocNo.get(docNo) ?? []), i]);
		}
		const duplicated = [...byDocNo.entries()].filter(([, idxs]) => idxs.length > 1);
		if (duplicated.length || byDocNo.size === 0) {
			const reason = duplicated.length
				? `document_no ${duplicated.map(([n]) => n).join(", ")} appears in several interpretations — duplicate copies vs distinct bookings needs judgment`
				: "linked segments but none carries a document_no — bookable unit unclear";
			for (const i of members) toResidue(i, reason);
			continue;
		}
		const clusterPairs = pairs.filter((p) => members.includes(p.a) && members.includes(p.b));
		const rules = [...new Set(clusterPairs.map((p) => p.rule))];
		proposed.push({
			draft_id: `draft-${String(++seq).padStart(3, "0")}`,
			segments: [...new Set(clusterPrints.map((p) => p.segmentId))],
			members: clusterPrints.map((p) => ({
				segment: p.segmentId,
				interpretation: p.path,
				document_no: p.documentNo,
				proposed_role: p.documentNo && p.bookable ? "primary_invoice" : "supporting_evidence",
			})),
			bookable_docs: [...byDocNo.keys()],
			evidence: clusterPairs.map((p) => p.evidence).join("; "),
			rules,
			confidence: rules.includes("same_document_no") ? "high" : "medium",
		});
	}
	return { proposed, residue };
}

function usage(): never {
	console.error(`Usage: bun run prelink -- <client-dir>

Proposes transaction clusters from exact matches across Stage-2
interpretations and writes ข้อมูลระบบ/_doc_groups/links.draft.yaml for
ksk-sherlock. The draft is a proposal — sherlock owns the final links.yaml.

Exit codes: 0 draft written, 2 usage/malformed input.
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
	const prints = [...interps.values()].flat().map(fingerprintOf);
	const draft = buildDraft(prints);

	const outDir = docGroupsDir(clientDir);
	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, "links.draft.yaml");
	writeFileSync(
		outPath,
		yamlStringify({
			schema: LINKS_DRAFT_SCHEMA,
			note: "machine-proposed exact matches only — ksk-sherlock adopts/overrides these and judges the residue; links.yaml stays sherlock's",
			proposed_transactions: draft.proposed,
			residue_segments: draft.residue,
		}),
	);
	const multi = draft.proposed.filter((c) => c.segments.length > 1).length;
	console.log(
		`wrote ${relative(clientDir, outPath)}: ${draft.proposed.length} proposed cluster(s) ` +
			`(${multi} multi-segment), ${draft.residue.length} residue segment(s) for ksk-sherlock`,
	);
}

if (import.meta.main) main();
