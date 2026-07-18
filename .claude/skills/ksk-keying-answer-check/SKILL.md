---
name: ksk-keying-answer-check
description: Compare a finished ksk-keying run against its client's answer key (samples/answer-keys/<client>/) for one or more named clients, and produce a short Thai-language HTML report per client showing what the pipeline got wrong. Use when asked to "check <client> against the answer key", "grade this run vs answer key", "/ksk-keying-answer-check <client>", or to audit accuracy after a run finishes. Dev-repo tooling; needs the gitignored samples/answer-keys/ dataset on this machine.
---

# ksk-keying-answer-check — grade finished runs against their answer key

You compare already-finished ksk-keying runs against verified answer keys and
report findings for human review. You never edit the run's output and you
never edit the answer key — every disagreement is a finding, full stop (see
memory/dont-override-verified-answer-key.md and CLAUDE.md "never peek at
answer-keys/ mid-run").

All chat replies and report content are in Thai. This file, code comments,
and script CLI text stay in English — that split matches the rest of this
repo (schemas, code, agent instructions in English; every reviewer-facing
string in review.html/reports in Thai — see the 2026-07-18 commit
"require Thai wording for reviewer-facing reason/flag text").

## Precondition — do this before touching answer-keys/ at all

For each client the user names:

1. Confirm the run finished Stage 5 (categorize) and passed its Ledger Gate:
   ```bash
   bun run .claude/skills/ksk-keying/scripts/ledger.ts -- --gate final "<client-dir>"
   ```
   Exit 0 = pass. If it's not final/pass, tell the user in Thai and skip that
   client — this tool is a post-run comparison, never a mid-run one.
2. Confirm `samples/answer-keys/<client>/<month>/` exists. If it doesn't,
   report in Thai that there's no answer key for that client-month and skip
   it — a missing answer key is a dataset gap, not something to force.

## Procedure

1. **Reference-report gap check** (existing script — don't reimplement):
   ```bash
   bun run .claude/skills/ksk-keying/scripts/reference-report-check.ts -- "<client-dir>"
   ```
   This writes `<client-dir>/ข้อมูลระบบ/_pages/reference-report-check.yaml`.
   Run it for every client before the next step — it's the one mechanism that
   catches a whole source file being wrongly excluded as a "summary report"
   (see project history: client 339's `ภาษีซื้อ.xlsx`, ~101 invoices, silently
   mis-classified this way and missed by every other check).

2. **Grade + render the report:**
   ```bash
   cd evals
   bun run answer-key-report.ts -- --client "<client-dir>" --key "<answer-key-dir>" --label "<display name>" --out <out-dir>
   ```
   For several clients in one call, write a batch yaml (`entries: [{client,
   key, label}, ...]`) and pass `--batch <file>` instead — one command, one
   HTML per client plus an `index.html`. This wraps `grade-vs-answer-key.ts`
   (recall / value-match / account-match / invented, per document) and folds
   in step 1's reference-report gaps, grouped into root-cause buckets:
   missing, sign-flip, date-mismatch, value-mismatch, account-code mismatch
   (same-family vs different-family), invented, reference-report-gap.

3. **Follow up on suspicious exclusions.** If the report's
   `reference_report_gap` bucket or `missing` bucket is non-empty, that's a
   candidate for a real exclusion-claim audit — dispatch `ksk-lestrade` (Agent
   tool) against the specific excluded pages/segments named in the finding to
   verify the claim independently, the same way client 345's run was audited.
   Don't do this preemptively for every clean run; only when the deterministic
   checks already flagged something.

4. **Report to the user in Thai.** Summarize per client: recall/value-match/
   account-match percentages, the biggest 1-2 finding buckets by count or
   baht impact, and the path to the HTML report(s). Link the HTML file(s) so
   the user can open them. Do not paste the full finding tables into chat —
   the HTML is the detailed artifact; chat gets the headline.

## Hard rules

- Never run this against a client-month whose run hasn't passed its Ledger
  Gate — this is a finished-run comparison tool only.
- Never edit `samples/answer-keys/` — it is verified ground truth (see
  memory/dont-override-verified-answer-key.md). Every disagreement is
  reported for human review, never auto-corrected on either side.
- Never feed answer-key content back into a client's `ข้อมูลระบบ/` or any
  in-progress run.
- The HTML report is read-only output — no auto-fix buttons, no scripts that
  mutate the run from inside the report.
- A low score is not a bug to chase to 100% (memory/evals-characterize-not-gate.md)
  — this tool characterizes where the pipeline fails; deciding what's worth
  fixing is the human's call after reading the report.
