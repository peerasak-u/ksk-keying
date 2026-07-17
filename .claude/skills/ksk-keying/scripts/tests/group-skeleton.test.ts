// Regression for BUG-1/BUG-2 (group-skeleton positional ids): removing one
// transaction cluster from links.yaml must not shift any other group's
// folder path, and the removed transaction's old folder must not survive as
// an orphan. Drives the real CLI core (runGroupSkeleton) against a temp
// client dir across two runs, exactly like an analyst re-running the stage
// after editing links.yaml.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { runGroupSkeleton } from "../group-skeleton";
import { docGroupsDir, segmentsDir } from "../paths";

const tmps: string[] = [];
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function invoiceInterpretation(docNo: string) {
	return {
		documents: [
			{
				source_file: `${docNo}.pdf`,
				source_page: 1,
				doc_kind: "normal_bill_or_invoice",
				document_role: "supplier_invoice",
			},
		],
		accounting_facts: {
			direction: "expense",
			document_date: "2026-05-22",
			document_no: docNo,
			seller_name: "หจก.ตัวอย่าง",
			gross_total: 1070,
			vat: 70,
			net_paid: 1070,
		},
		line_items: [{ description: "ของ", amount: 1000, amount_includes_vat: false, vat_rate: 7 }],
		review_flags: [],
		questions_for_user: [],
		page_disposition: [{ file: `${docNo}.pdf`, page: 1, disposition: "used" }],
	};
}

// Four independent transactions, one segment/document each — mirrors the
// _345 restart run's shape closely enough to reproduce the renumbering bug:
// several unrelated transactions, then one removed from links.yaml.
function seedClient(): string {
	const dir = mkdtempSync(join(tmpdir(), "ksk-group-skeleton-"));
	tmps.push(dir);
	const segRoot = segmentsDir(dir);
	const docs = { "seg-001": "INV-001", "seg-002": "INV-002", "seg-003": "INV-003", "seg-004": "INV-004" };
	for (const [segId, docNo] of Object.entries(docs)) {
		const segDir = join(segRoot, segId);
		mkdirSync(segDir, { recursive: true });
		writeFileSync(join(segDir, "interpretation.json"), JSON.stringify(invoiceInterpretation(docNo)));
	}
	const dgDir = docGroupsDir(dir);
	mkdirSync(dgDir, { recursive: true });
	writeLinks(dir, ["seg-001", "seg-002", "seg-003", "seg-004"]);
	return dir;
}

function writeLinks(clientDir: string, segments: string[]) {
	const docs: Record<string, string> = {
		"seg-001": "INV-001",
		"seg-002": "INV-002",
		"seg-003": "INV-003",
		"seg-004": "INV-004",
	};
	// transaction_id is derived from the segment's own document, not array
	// position — group-skeleton only copies links.yaml's transaction_id
	// verbatim, so a positionally-numbered fixture id here would make THIS
	// TEST'S data churn on removal, muddying the very stability this test
	// verifies. Real links.yaml transaction ids come from ksk-sherlock, out of
	// scope for this fixture.
	const transactions = segments.map((seg) => ({
		transaction_id: `txn-${docs[seg]}`,
		segments: [seg],
		bookable_docs: [docs[seg]],
		members: [{ segment: seg, document_no: docs[seg], role: "primary_document" }],
	}));
	writeFileSync(join(docGroupsDir(clientDir), "links.yaml"), yamlDump({ transactions }));
}

// Minimal hand-rolled YAML dump — avoids pulling in the project's yaml
// stringify just for a flat fixture shape; readable and exactly matches what
// loadLinks/readYaml expects to parse back.
function yamlDump(doc: { transactions: Record<string, unknown>[] }): string {
	const lines = ["transactions:"];
	for (const t of doc.transactions) {
		lines.push(`  - transaction_id: ${t.transaction_id}`);
		lines.push(`    segments: [${(t.segments as string[]).join(", ")}]`);
		lines.push(`    bookable_docs: [${(t.bookable_docs as string[]).map((d) => `"${d}"`).join(", ")}]`);
		lines.push("    members:");
		for (const m of t.members as Record<string, string>[])
			lines.push(`      - {segment: ${m.segment}, document_no: "${m.document_no}", role: ${m.role}}`);
	}
	return lines.join("\n") + "\n";
}

function readManifestGroups(clientDir: string): { id: string; path: string; bookable_doc: string | null }[] {
	const doc = yamlParse(readFileSync(join(docGroupsDir(clientDir), "manifest.yaml"), "utf8")) as {
		groups: { id: string; path: string; bookable_doc: string | null }[];
	};
	return doc.groups;
}

function existingLeafDirs(root: string): string[] {
	const leaves: string[] = [];
	function walk(dir: string, rel: string) {
		const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
		if (entries.length === 0) {
			if (rel) leaves.push(rel);
			return;
		}
		for (const e of entries) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
	}
	if (existsSync(root)) walk(root, "");
	return leaves;
}

describe("group-skeleton idempotency across a links.yaml edit", () => {
	test("removing one transaction leaves unrelated groups' paths unchanged and deletes the removed one's stale folder", () => {
		const clientDir = seedClient();
		runGroupSkeleton(clientDir);

		const before = readManifestGroups(clientDir);
		const beforeById = new Map(before.map((g) => [g.bookable_doc, g]));
		const seg002GroupBefore = beforeById.get("INV-002")!;
		const seg003GroupBefore = beforeById.get("INV-003")!;
		const seg004GroupBefore = beforeById.get("INV-004")!;

		// simulate the group having been populated already (what makes an
		// orphaned folder dangerous — real work sitting in it, not an empty dir)
		const groupsRoot = docGroupsDir(clientDir);
		writeFileSync(
			join(groupsRoot, seg002GroupBefore.path, "interpretation.json"),
			JSON.stringify({ populated: true }),
		);

		// remove the seg-002 transaction (its "duplicate stub" analog) and its
		// segment entirely — the real _345 case removed a duplicate segment's
		// interpretation along with its link cluster
		rmSync(join(segmentsDir(clientDir), "seg-002"), { recursive: true, force: true });
		writeLinks(clientDir, ["seg-001", "seg-003", "seg-004"]);

		runGroupSkeleton(clientDir);

		const after = readManifestGroups(clientDir);
		const afterById = new Map(after.map((g) => [g.bookable_doc, g]));

		// unrelated groups keep the EXACT same id/path — the core regression
		expect(afterById.get("INV-003")).toEqual(seg003GroupBefore);
		expect(afterById.get("INV-004")).toEqual(seg004GroupBefore);

		// the removed transaction's group is gone from the manifest...
		expect(afterById.has("INV-002")).toBe(false);
		// ...and its populated folder was actually deleted, not left as an orphan
		expect(existsSync(join(groupsRoot, seg002GroupBefore.path))).toBe(false);

		// every directory on disk after the second run traces back to a group
		// the fresh manifest actually lists — no leftover stale folders
		const freshPaths = new Set(after.map((g) => g.path));
		for (const dir of existingLeafDirs(groupsRoot)) expect(freshPaths.has(dir)).toBe(true);
	});
});
