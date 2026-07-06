# Page completeness is proven by a derived, evidence-only Page Ledger — never by agent bookkeeping

The keying pipeline could silently lose pages at four hops (segmentation gap, under-read multi-document scan, dropped group, omitted review-data entry), and the review generator even drops unresolvable source paths without error. We decided that completeness is enforced by a **derived** Page Ledger: a deterministic script recomputes, from on-disk artifacts alone, a terminal state for every page of every source file — Reviewed (explicitly claimed in a group's review data via `source_pages`/`source_sheet`) or Excluded (a parent-recorded declaration with reason and declarer) — and any Unaccounted page hard-blocks the run at three Ledger Gates (after Segment, where gaps *and overlaps* fail; after Interpret; before completion).

We rejected the maintained-ledger alternative (agents update a status file as they work) because it makes every agent a bookkeeper and lets the ledger lie in both directions — a forgotten update fakes loss, an eager update fakes coverage. In the derived design agents cannot corrupt the ledger at all; they can only fail to produce evidence, which the ledger then truthfully reports. This is why agents carry a mandatory Page Disposition in their return contract instead of write access to any ledger file, why the denominator (the Inventory) comes from `pdfinfo`/sheet enumeration rather than any agent's count, and why a blocked gate can only be cleared by new evidence or a new Exclusion Declaration — never by editing ledger output.

## Consequences

- Review-data claims must be explicit at census granularity: every page of a multi-page document (`source_pages`), every workbook sheet (`source_sheet`). Membership in a reviewed segment or file proves nothing.
- The Inventory skips only a closed, code-owned list (pipeline artifacts, OS junk); every other file — including context files like the COA workbook — must reach a terminal state, so unknown or misnamed files surface at the first gate instead of vanishing.
- All exclusions, agent- or human-declared, are proposals surfaced at human review; `declared_by` is recorded.
