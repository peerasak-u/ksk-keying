# CLAUDE.md

Instructions for Claude Code working in this repo.

## What this repo is

This is the **development repo for the `ksk-keying` skill itself** — not a place where a
real client's documents live. The deliverable is the skill (`.claude/skills/ksk-keying/`,
`.claude/agents/`, the bundled Bun scripts) that a customer installs into *their own*
working copy and points at *their own* client folders (see README.md → "Install",
"Client data stays outside this repo"). Every change here should be judged by whether it
makes the shipped skill more correct and robust for a customer's real run, not by whether
it happens to work on the sample client folders in this checkout.

## `samples/` — local test fixtures only

`samples/` is gitignored (never commit client data — real or sample). It exists purely to
exercise the pipeline end-to-end on this machine. Two subfolders, two different jobs:

- **`samples/ready-for-test/<client>/`** — a client folder in its *starting* state (raw
  source documents, maybe partway through the pipeline from a prior run). This is what you
  point `/ksk-keying` at, exactly like a real customer's folder.
- **`samples/old-result/<client>/`** — the **answer key**: PEAK export files that are
  already known-correct for that client, produced outside this pipeline (manually, or by
  an earlier workflow). It exists only to grade a finished run against, never to help
  produce one.

Not every client in `ready-for-test/` has a matching `old-result/` — only ones where a
verified reference export exists.

## Hard rule — never peek at `old-result/` mid-run

`old-result/` is an exam answer key. Any agent (parent or subagent) doing segmentation,
interpretation, linking, categorization, or populate work for a client **must not read,
`grep`, or otherwise inspect that client's `samples/old-result/` folder** before or during
the run. Looking at the answer key while producing the answer defeats the entire point of
using it as a check, and would hide real pipeline bugs behind a memorized result.

`old-result/` may only be touched **after** a run has gone through its normal Ledger Gates
and human review, and only for comparison/grading — diffing the pipeline's
`peak_import_*.xlsx` output against the reference files, never feeding the reference
content back into an in-progress run.

If you are ever asked to validate a run against `old-result/`, do the full run first,
completely blind to the answer key, then compare at the end.
