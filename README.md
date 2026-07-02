# ksk-keying

The KSK client-document keying workflow — segment a client folder, interpret its
documents, link transactions, map to the chart of accounts, and produce
human-reviewable proposals that export to PEAK. Built as a **Claude Code** skill
plus a team of bounded subagents.

## Layout

```
skills/ksk-keying/        # the orchestration skill (SKILL.md + references/)
  SKILL.md
  references/
    extract-playbooks.md      # classify-then-read rules per Thai doc type
    review-data-schema.md     # review-data.json contract (v1)
.claude/agents/           # the six leaf subagents (auto-loaded by Claude Code)
  ksk-magnum.md   # Stage 0  first-contact client profile + coa.csv
  ksk-columbo.md  # Stage 1  folder segmentation
  ksk-watson.md   # Stage 2  visual document reading
  ksk-marple.md   # Stage 2/4/5  spreadsheet interp, group skeleton/populate, review-data
  ksk-sherlock.md # Stage 3  cross-segment transaction linking
  ksk-poirot.md   # Stage 5  COA categorize
tools/ksk/                # deterministic (non-AI) commands the skill shells out to
  coa-to-csv.ts             # ผังบัญชี workbook -> coa.csv   (Stage 0)
  review-groups.ts          # review.html + PEAK xlsx export (Stage 5c)
  ...                       # legacy pipeline tools (gate/extract/categorize) kept for reference
```

## Requirements

- [Claude Code](https://claude.com/claude-code) — the skill and subagents run here.
  `.claude/agents/*.md` is the only path Claude Code auto-loads agents from.
- [Bun](https://bun.sh) — for the two deterministic tool commands.

## Setup

```bash
cd tools/ksk
bun install
cp .env.example .env   # only needed for the legacy AI pipeline, not for ksk-keying
```

## Run

Open this folder in Claude Code and invoke the skill:

```
/ksk-keying   (or: "run ksk-keying on <client folder>")
```

The parent session orchestrates; each stage runs in its bounded subagent. See
`skills/ksk-keying/SKILL.md` for the full stage contract, artifact layout, and
human-review gates.

The two deterministic steps run as:

```bash
bun run --cwd tools/ksk coa-to-csv    -- "<clientDir>"
bun run --cwd tools/ksk review-groups -- --force "<clientDir>"
```

## Notes

- **Claude Desktop / Claude.ai** has no subagent mechanism and can't run the bun
  tools in its sandbox — this repo targets Claude Code. A flattened single-context
  variant (agents folded into the skill as role guides) can be packaged
  separately if needed.
- **Client data never belongs in this repo.** `samples/` and `tools/ksk/.runs/`
  are gitignored; point the workflow at client folders that live elsewhere.
