// Stage-2 output contract — canonical interpretation.json validator.
//
// The _216 run produced interpretation files in five different shapes for
// multi-document segments (per-document nesting, flat fields on documents[]
// entries, top-level transactions[] blocks, document_groups[] arrays,
// duplicate per-page entries repeating one document_no). groups-lib's reader
// was generalized to tolerate all of them, but tolerance is a safety net, not
// a contract: this script enforces the ONE canonical shape
// (`ksk_segment_interpretation.v1`, defined with examples in
// .claude/agents/ksk-watson.md) so a non-canonical file is caught at
// write-time — the child that wrote it gets re-dispatched — instead of
// surfacing as a mid-run script failure three stages later.
//
// Three canonical shapes, discriminated mechanically:
//   statement    — isStatementShaped (statement-row transactions[] or all
//                  bank_statement/generic doc_kinds)
//   transaction  — ONE booking: a single document, or several documents that
//                  are one transaction (relationship.same_transaction: true).
//                  Facts + line items live at the TOP level only.
//   bundle       — several INDEPENDENT documents in one dispatch window
//                  (relationship.same_transaction: false). Every documents[]
//                  entry nests its own complete accounting_facts (+
//                  line_items); nothing document-specific at the top level.
//
// Usage: bun run validate-interpretation -- <interpretation.json | client-dir> [...]
//   A client dir validates every ข้อมูลระบบ/_segments/*/interpretation*.json.
//
// Exit codes: 0 all canonical, 1 violations found (listed per file),
//             2 usage / path not found.

import { join, relative, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isStatementShaped, type Interpretation } from "./groups-lib";
import { segmentsDir } from "./paths";

export const SEGMENT_INTERPRETATION_SCHEMA = "ksk_segment_interpretation.v1";

// Top-level arrays the canonical shape knows. Anything else holding objects is
// an invented collection (document_groups[], sub_documents[], …) — the exact
// failure mode this validator exists to reject.
const KNOWN_TOP_ARRAYS = new Set([
	"documents",
	"line_items",
	"review_flags",
	"questions_for_user",
	"page_disposition",
	"transactions",
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
	v != null && typeof v === "object" && !Array.isArray(v);

function validatePageDisposition(json: Interpretation, errors: string[]) {
	const entries = json.page_disposition;
	if (!Array.isArray(entries) || entries.length === 0) {
		errors.push("page_disposition[] missing or empty — every page/sheet in the assigned range must appear");
		return;
	}
	entries.forEach((entry, i) => {
		if (!isObject(entry)) return errors.push(`page_disposition[${i}] is not an object`);
		if (typeof entry.file !== "string" || !entry.file)
			errors.push(`page_disposition[${i}] has no file`);
		if (entry.page == null && entry.sheet == null)
			errors.push(`page_disposition[${i}] has neither page nor sheet`);
		if (entry.disposition !== "used" && entry.disposition !== "excluded")
			errors.push(`page_disposition[${i}] disposition "${entry.disposition ?? "missing"}" (expected used|excluded)`);
		else if (entry.disposition === "excluded" && !entry.reason)
			errors.push(`page_disposition[${i}] is excluded without a reason`);
	});
}

function validateDocumentEntryBasics(doc: unknown, i: number, errors: string[]) {
	if (!isObject(doc)) return errors.push(`documents[${i}] is not an object`);
	if (typeof doc.doc_kind !== "string" || !doc.doc_kind)
		errors.push(`documents[${i}] has no doc_kind`);
	if (!doc.source_file && !doc.artifact)
		errors.push(`documents[${i}] has neither source_file nor artifact — downstream review cannot claim its pages`);
}

function validateFacts(
	facts: unknown,
	where: string,
	errors: string[],
) {
	if (!isObject(facts)) return errors.push(`${where} accounting_facts missing or not an object`);
	if (facts.direction !== "expense" && facts.direction !== "income")
		errors.push(`${where} accounting_facts.direction "${facts.direction ?? "missing"}" (expected expense|income)`);
	if (!("document_no" in facts))
		errors.push(`${where} accounting_facts has no document_no key (use null explicitly when the document carries no number)`);
}

// Full canonical check of one parsed interpretation file. Returns violation
// messages; empty array = canonical.
export function validateInterpretation(json: unknown): string[] {
	const errors: string[] = [];
	if (!isObject(json)) return ["not a JSON object"];
	const interp = json as Interpretation;

	if (interp.schema !== SEGMENT_INTERPRETATION_SCHEMA)
		errors.push(`schema marker missing or wrong (expected "${SEGMENT_INTERPRETATION_SCHEMA}", got ${JSON.stringify(interp.schema ?? null)})`);
	if (typeof interp.segment_id !== "string" || !interp.segment_id)
		errors.push("segment_id missing");
	validatePageDisposition(interp, errors);

	for (const [key, value] of Object.entries(interp)) {
		if (!Array.isArray(value) || KNOWN_TOP_ARRAYS.has(key)) continue;
		if (value.some((item) => isObject(item)))
			errors.push(`unexpected top-level array "${key}" — bundled documents belong in documents[] with nested accounting_facts, never in an invented collection`);
	}

	const documents = Array.isArray(interp.documents) ? interp.documents : [];
	const statement = isStatementShaped(interp);

	if (statement) {
		(interp.transactions ?? []).forEach((row, i) => {
			if (!isObject(row)) return errors.push(`transactions[${i}] is not an object`);
			if (typeof row.date_iso !== "string" || !row.date_iso)
				errors.push(`transactions[${i}] has no date_iso`);
			if (row.direction !== "in" && row.direction !== "out")
				errors.push(`transactions[${i}] direction "${row.direction ?? "missing"}" (expected in|out)`);
			if (typeof row.amount !== "number")
				errors.push(`transactions[${i}] amount is not a number`);
		});
		documents.forEach((doc, i) => validateDocumentEntryBasics(doc, i, errors));
		return errors;
	}

	if (Array.isArray(interp.transactions))
		errors.push("top-level transactions[] on a non-statement file — bundled documents belong in documents[] with nested accounting_facts");
	if (!Array.isArray(interp.documents) || documents.length === 0) {
		errors.push("documents[] missing or empty");
		return errors;
	}
	documents.forEach((doc, i) => validateDocumentEntryBasics(doc, i, errors));

	const relationship = isObject(interp.relationship) ? interp.relationship : null;
	const sameTransaction =
		documents.length === 1 ? true : relationship?.same_transaction;
	if (typeof sameTransaction !== "boolean") {
		errors.push("multi-document file needs relationship.same_transaction (boolean) — true = one booking, false = independent documents (bundle shape)");
		return errors;
	}

	if (sameTransaction) {
		// transaction shape: one booking — facts/lines at the top level only
		validateFacts(interp.accounting_facts, "top-level", errors);
		if (!Array.isArray(interp.line_items))
			errors.push("line_items[] missing at the top level (use [] when the document has no line detail)");
		documents.forEach((doc, i) => {
			if (!isObject(doc)) return;
			if ("accounting_facts" in doc)
				errors.push(`documents[${i}] nests accounting_facts in a one-transaction file — nested facts are for independent documents (relationship.same_transaction: false)`);
			if ("document_no" in doc)
				errors.push(`documents[${i}] carries document_no — the booking's number lives in top-level accounting_facts.document_no; a supporting document's number goes in accounting_facts.reference`);
			if ("line_items" in doc)
				errors.push(`documents[${i}] carries line_items — line items live at the top level in a one-transaction file`);
		});
	} else {
		// bundle shape: independent documents — everything nested per entry
		if (interp.accounting_facts != null)
			errors.push("top-level accounting_facts on a bundle file — each independent document nests its own accounting_facts");
		if (interp.line_items != null)
			errors.push("top-level line_items on a bundle file — each document's line items nest inside its documents[] entry");
		const seen = new Map<string, number>();
		documents.forEach((doc, i) => {
			if (!isObject(doc)) return;
			validateFacts(doc.accounting_facts, `documents[${i}]`, errors);
			if ("line_items" in doc && !Array.isArray(doc.line_items))
				errors.push(`documents[${i}] line_items is not an array`);
			const no = isObject(doc.accounting_facts) ? doc.accounting_facts.document_no : null;
			if (typeof no === "string" && no) {
				const first = seen.get(no);
				if (first != null)
					errors.push(`documents[${i}] repeats document_no "${no}" (also on documents[${first}]) — one entry per document; extra pages belong in page_disposition/source_pages, a duplicate copy is one entry with usable_for_booking: false`);
				else seen.set(no, i);
			}
		});
	}
	return errors;
}

// Non-fatal data-loss checks. Run `_356` lost the counterparty tax ids: most
// readers either omitted seller_tax_id/buyer_tax_id or appended the 13-digit
// id inside the name string, where prelink's exact matching and the PEAK
// export can't see it. Warnings don't fail validation (legacy files stay
// loadable) but the writing child is told to fix them before replying.
const EMBEDDED_TAX_ID = /\d{13}|เลขประจำตัวผู้เสียภาษี|tax\s*id/i;

function warnFacts(facts: unknown, where: string, warnings: string[]) {
	if (!isObject(facts)) return;
	for (const party of ["seller", "buyer"] as const) {
		const name = facts[`${party}_name`];
		const taxId = facts[`${party}_tax_id`];
		if (typeof name === "string" && EMBEDDED_TAX_ID.test(name) && !taxId)
			warnings.push(
				`${where} ${party}_name embeds a tax id ("${name.slice(0, 60)}…") — move the 13-digit id to ${party}_tax_id; the name field carries only the party's name`,
			);
	}
}

// VAT arithmetic self-consistency. 7% is the only positive Thai VAT rate, so
// any facts block with vat > 0 must satisfy vat ≈ 7% of (gross_total − vat),
// i.e. vat ≈ gross_total × 7/107. A mismatch beyond rounding means a digit of
// the base or the vat was misread — the file is internally inconsistent and
// the reading child must re-read the document. vat null/0 (non-VAT documents)
// and gross_total null are skipped. net_paid may sit BELOW gross_total (WHT
// withheld) but can never exceed it.
const AMOUNT_TOLERANCE = 0.02;
const VAT_RATE = 0.07;

function warnVatArithmetic(facts: unknown, where: string, warnings: string[]) {
	if (!isObject(facts)) return;
	const gross = facts.gross_total;
	const vat = facts.vat;
	const label =
		typeof facts.document_no === "string" && facts.document_no
			? `document_no "${facts.document_no}"`
			: where;
	if (typeof gross === "number" && typeof vat === "number" && vat > 0) {
		const base = gross - vat;
		const expected = base * VAT_RATE;
		if (Math.abs(vat - expected) > AMOUNT_TOLERANCE)
			warnings.push(
				`${where} vat_arithmetic_mismatch: ${label} has gross_total ${gross} and vat ${vat}, but 7% of the implied base ${base.toFixed(2)} is ${expected.toFixed(2)} — the numbers are internally inconsistent; re-read the document`,
			);
	}
	const netPaid = facts.net_paid;
	if (
		typeof gross === "number" &&
		typeof netPaid === "number" &&
		netPaid - gross > AMOUNT_TOLERANCE
	)
		warnings.push(
			`${where} vat_arithmetic_mismatch: ${label} has net_paid ${netPaid} exceeding gross_total ${gross} — paid can never exceed the document total; re-read the document`,
		);
}

// Warning messages for one parsed interpretation file; empty array = clean.
export function interpretationWarnings(json: unknown): string[] {
	const warnings: string[] = [];
	if (!isObject(json)) return warnings;
	const interp = json as Interpretation;
	if (isStatementShaped(interp)) return warnings;
	warnFacts(interp.accounting_facts, "top-level", warnings);
	warnVatArithmetic(interp.accounting_facts, "top-level", warnings);
	(Array.isArray(interp.documents) ? interp.documents : []).forEach((doc, i) => {
		if (!isObject(doc)) return;
		warnFacts(doc.accounting_facts, `documents[${i}]`, warnings);
		warnVatArithmetic(doc.accounting_facts, `documents[${i}]`, warnings);
	});
	return warnings;
}

// ---------------------------------------------------------------------------
// CLI

function usage(): never {
	console.error(`Usage: bun run validate-interpretation -- <interpretation.json | client-dir> [...]

Validates Stage-2 interpretation files against the canonical
${SEGMENT_INTERPRETATION_SCHEMA} shape (defined in .claude/agents/ksk-watson.md).
A client directory validates every ข้อมูลระบบ/_segments/*/interpretation*.json.
A non-canonical file means the child that wrote it should be re-dispatched —
groups-lib tolerates the known variants, but only as a safety net.

Exit codes: 0 all canonical, 1 violations found, 2 usage / path not found.
`);
	process.exit(2);
}

function collectTargets(input: string): string[] {
	const path = resolve(input);
	if (!existsSync(path)) {
		console.error(`not found: ${input}`);
		process.exit(2);
	}
	if (statSync(path).isFile()) return [path];
	const root = segmentsDir(path);
	if (!existsSync(root)) {
		console.error(`no ข้อมูลระบบ/_segments under ${input} — run Stage 2 first`);
		process.exit(2);
	}
	const files: string[] = [];
	for (const segmentId of readdirSync(root).sort()) {
		const dir = join(root, segmentId);
		if (!statSync(dir).isDirectory()) continue;
		for (const name of readdirSync(dir).sort())
			if (name.startsWith("interpretation") && name.endsWith(".json"))
				files.push(join(dir, name));
	}
	return files;
}

function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length === 0 || argv.some((a) => a.startsWith("--"))) usage();
	const targets = argv.flatMap(collectTargets);
	if (targets.length === 0) {
		console.error("no interpretation files found");
		process.exit(2);
	}
	let bad = 0;
	for (const target of targets) {
		const rel = relative(process.cwd(), target);
		const shown = rel.startsWith("..") ? target : rel;
		let errors: string[];
		let warnings: string[] = [];
		try {
			const json = JSON.parse(readFileSync(target, "utf8"));
			errors = validateInterpretation(json);
			warnings = interpretationWarnings(json);
		} catch (error) {
			errors = [`unreadable/invalid JSON: ${error instanceof Error ? error.message : String(error)}`];
		}
		if (errors.length === 0) {
			console.log(`✓ ${shown}`);
			for (const warning of warnings) console.log(`    ⚠ ${warning}`);
			continue;
		}
		bad++;
		console.log(`✗ ${shown}`);
		for (const error of errors) console.log(`    - ${error}`);
		for (const warning of warnings) console.log(`    ⚠ ${warning}`);
	}
	console.log(
		`${targets.length - bad}/${targets.length} canonical` +
			(bad ? ` — re-dispatch the Stage-2 child owning each ✗ file with the canonical ${SEGMENT_INTERPRETATION_SCHEMA} shape` : ""),
	);
	process.exit(bad ? 1 : 0);
}

if (import.meta.main) main();
