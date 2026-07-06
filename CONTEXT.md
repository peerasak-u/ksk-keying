# KSK Keying

Turns a raw client document folder (invoices, receipts, bank statements, spreadsheets) into human-reviewable accounting proposals exported as PEAK import data, via a parent-orchestrated subagent pipeline.

## Language

**Page**:
The atomic unit of accountability — one physical page of a source PDF, one image file, or one sheet of a spreadsheet file.
_Avoid_: document (that's a higher-level concept), image

**Inventory**:
The deterministic, tool-produced census of every source file and its true Page count — the fixed denominator the Page Ledger validates against. Never agent-reported. Includes every client file except the closed, code-owned skip-list (pipeline artifacts and OS junk); files consumed as machine context (e.g. the COA workbook) are not skipped but Excluded by declaration (`context_file`).
_Avoid_: page manifest, file list

**Page Ledger**:
The client-level view asserting a terminal state for every Page — always *derived* by deterministic code from on-disk evidence (Inventory, segment manifest, review data, exclusion declarations), never maintained by hand or by agents.
_Avoid_: coverage report, validation file

**Terminal State**:
The end-of-pipeline status a Page must reach: either **Reviewed** or **Excluded**. A Page in neither state is **Unaccounted**.

**Reviewed**:
A Page explicitly claimed in some Doc Group's review data — every page of a multi-page document listed (not just the first), every workbook sheet named individually — and therefore visible on a review page. Membership in a reviewed Segment or reviewed file proves nothing.

**Excluded**:
A Page deliberately left out of review, always with a declared reason (blank, duplicate, cover sheet, not bookable) and a declarer (an agent task or the human).
_Avoid_: skipped, ignored

**Page Disposition**:
The mandatory per-page section of an interpretation agent's report: every Page in its assigned range is stated as used or excluded-with-reason — silence is not permitted.
_Avoid_: page status, coverage note

**Exclusion Declaration**:
The parent-recorded, on-disk entry (file, page, reason, declared_by) that makes an Excluded state readable by the Page Ledger. Agent-declared exclusions are proposals; the human review gate sees them all.

**Unaccounted**:
A Page with no Terminal State — a pipeline defect that must block completion, never a silent condition.
_Avoid_: missing, lost

**Ledger Gate**:
A blocking checkpoint where the parent derives the Page Ledger and refuses to proceed while any Page is Unaccounted (or, at segmentation, in zero or more than one Segment). Resolved only by new evidence or a new Exclusion Declaration — never by editing the ledger.
_Avoid_: validation step, coverage check

**Segment**:
A proposed boundary over source files/page ranges (one document or transaction bundle), produced by folder inspection before any content interpretation.

**Doc Group**:
One bookable unit (one tax invoice + its evidence) placed in the category/VAT tree, carrying interpretation, categorization, and review data.

## Relationships

- Every **Page** belongs to exactly one **Segment** (segmentation coverage is total).
- A **Segment** yields one or more interpretations; their pages flow into **Doc Groups**.
- Every **Page** must end **Reviewed** (referenced by a **Doc Group**'s review data) or **Excluded** with a reason.
- The **Page Ledger** is the single place where **Unaccounted** pages become visible.
- Interpretation agents report a **Page Disposition**; the parent turns excluded entries into **Exclusion Declarations**; only the declarations (not the verbal reports) count as evidence.

## Example dialogue

> **Dev:** "Columbo segmented the 75-page scan into 44 invoices — are we done?"
> **Domain expert:** "Only if the union of segment ranges covers all 75 **Pages**. And segmentation alone isn't a **Terminal State** — each **Page** still has to surface as **Reviewed** in a **Doc Group** or be **Excluded** with a reason, or the **Page Ledger** reports it **Unaccounted** and the run can't complete."

## Flagged ambiguities

- "all pages recognized" was used to mean both segmentation coverage and end-to-end review coverage — resolved: the invariant is end-to-end (**Terminal State** for every **Page**), not merely segmentation coverage.
