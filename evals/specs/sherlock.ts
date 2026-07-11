// Grading spec + grader for ksk-sherlock (transaction linking).
//
// Expectation contract: expected.yaml is the verified links.yaml of a
// completed run. A cluster is correct when the output contains a transaction
// with exactly the same member set (segment + document_no); bookable_docs must
// match on top of that. Roles/evidence wording are not graded — membership is
// what downstream group-skeleton consumes.

import { loadYaml } from "../lib";

interface Cluster {
	key: string; // canonical member-set key
	members: string[];
	bookable: string[];
	multi: boolean;
}

function memberKey(m: any): string {
	return `${m?.segment ?? "?"}|${m?.document_no ?? "null"}`;
}

export function normalizeLinks(path: string): Cluster[] {
	const doc = loadYaml<any>(path);
	const txs: any[] = doc?.transactions ?? [];
	return txs.map((t) => {
		const members = (t?.members ?? []).map(memberKey).sort();
		return {
			key: members.join(" + "),
			members,
			bookable: [...(t?.bookable_docs ?? [])].map(String).sort(),
			multi: members.length > 1,
		};
	});
}

export interface SherlockGrade {
	clusters_expected: number;
	clusters_exact: number;
	bookable_correct: number;
	multi_expected: number;
	multi_exact: number;
	missing_clusters: string[]; // expected member-sets not reproduced
	spurious_clusters: string[]; // output member-sets not in expected
	bookable_mismatches: Array<{ cluster: string; expected: string[]; got: string[] }>;
}

export function gradeLinks(expectedPath: string, outputPath: string): SherlockGrade {
	const exp = normalizeLinks(expectedPath);
	const out = normalizeLinks(outputPath);
	// Multiset matching: several clusters can share one member-set key (e.g.
	// standalone documents with document_no null in the same segment), so each
	// output cluster may be consumed only once. Within a key bucket, prefer
	// the output whose bookable_docs also match.
	const buckets = new Map<string, Cluster[]>();
	for (const c of out) {
		const b = buckets.get(c.key) ?? [];
		b.push(c);
		buckets.set(c.key, b);
	}

	let exact = 0;
	let bookableCorrect = 0;
	let multiExact = 0;
	const missing: string[] = [];
	const bookableMismatches: SherlockGrade["bookable_mismatches"] = [];

	for (const e of exp) {
		const bucket = buckets.get(e.key);
		if (!bucket || bucket.length === 0) {
			missing.push(e.key);
			continue;
		}
		const wanted = JSON.stringify(e.bookable);
		let i = bucket.findIndex((o) => JSON.stringify(o.bookable) === wanted);
		if (i === -1) i = 0;
		const o = bucket.splice(i, 1)[0];
		exact++;
		if (e.multi) multiExact++;
		if (JSON.stringify(e.bookable) === JSON.stringify(o.bookable)) bookableCorrect++;
		else bookableMismatches.push({ cluster: e.key, expected: e.bookable, got: o.bookable });
	}

	const spurious = [...buckets.values()].flat().map((c) => c.key);

	return {
		clusters_expected: exp.length,
		clusters_exact: exact,
		bookable_correct: bookableCorrect,
		multi_expected: exp.filter((c) => c.multi).length,
		multi_exact: multiExact,
		missing_clusters: missing,
		spurious_clusters: spurious,
		bookable_mismatches: bookableMismatches,
	};
}
