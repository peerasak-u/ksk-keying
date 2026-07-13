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
exercise the pipeline and the evals end-to-end on this machine. Everything under it is
**prepared fresh from the real Dropbox workspace** (`~/Dropbox/สารบัญงานบัญชี_For Ton`, the
`(พร้อมทดสอบ)_*` client folders) — treat those Dropbox folders as read-only source material,
never write pipeline output back into them.

Layout:

- **`samples/clients/<client>/`** — a client folder in its *starting* state (raw source
  documents only). This is what you point `/ksk-keying` at, exactly like a real customer's
  folder. When preparing one from Dropbox, **strip the answer key out of the copy** (see
  below) — the raw client must never contain PEAK-export files.
- **`samples/answer-keys/<client>/`** — the **answer key**: PEAK export files
  (`File PEAK import/…`) that are already known-correct for that client-month, produced
  outside this pipeline. Exists only to grade a finished run against, never to help produce
  one. (Formerly `samples/old-result/`.)
- **`samples/evals/`** — the eval datasets:
  - `fixtures/<stage>/<client>/` — per-stage frozen snapshots (a client folder holding only
    the artifacts of stages ≤ N-1); the **input** to a stage eval.
  - `watson/`, `sherlock/`, … — per-agent curated unit cases (each self-contained, with its
    own `client/` clone).
  - `_runs/` — run outputs + pinned baselines.

Not every client has a matching answer key — only ones where a verified reference export
exists. A raw client and its answer key come from the **same** Dropbox client-month, split
into the two folders at prepare time.

## Hard rule — never peek at `answer-keys/` mid-run

`answer-keys/` is an exam answer key. Any agent (parent or subagent) doing segmentation,
interpretation, linking, categorization, or populate work for a client **must not read,
`grep`, or otherwise inspect that client's `samples/answer-keys/` folder** (nor any
`File PEAK import/` folder still inside a Dropbox source) before or during the run. Looking
at the answer key while producing the answer defeats the entire point of using it as a
check, and would hide real pipeline bugs behind a memorized result.

`answer-keys/` may only be touched **after** a run has gone through its normal Ledger Gates
and human review, and only for comparison/grading — diffing the pipeline's PEAK-export
output against the reference files, never feeding the reference content back into an
in-progress run.

If you are ever asked to validate a run against the answer key, do the full run first,
completely blind to it, then compare at the end.
