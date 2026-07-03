# ksk-keying

KSK client-document keying for Claude Code — segment a client folder, interpret Thai
accounting documents, link transactions, map to the chart of accounts, and produce
human-reviewable proposals that export to PEAK.

## Quick start (for humans)

1. Put this folder anywhere on your machine.
2. Open **this folder** in [Claude Code](https://code.claude.com/docs/en/overview).
3. Tell Claude:

```
Read README.md, then install this repo and confirm when /ksk-keying is ready.
```

Claude will run the install steps below and report back. No manual setup needed.

## Install (for Claude Code)

When a user asks you to install this repo, do the following in order:

1. **Read this file** — understand what the repo provides and what "done" looks like.
2. **Check prerequisites**
   - [Claude Code](https://code.claude.com/docs/en/overview) with the `Agent` tool (this session).
   - [Bun](https://bun.sh) on the machine. If missing, tell the user to install Bun and stop.
3. **Run the install script** from the repo root:

```bash
bash scripts/install.sh
```

4. **Confirm the skill is registered** — these must exist:
   - `.claude/skills/ksk-keying/SKILL.md`
   - `.claude/agents/ksk-{magnum,columbo,watson,sherlock,marple,poirot}.md`
5. **Tell the user** they can run `/ksk-keying` (or "run ksk-keying on `<client folder>`").
   If the skill does not appear in `/` yet, restart Claude Code from this folder.

**Done when:** `bun install` succeeded in `tools/ksk/`, all six agents are present, and
`/ksk-keying` is available.

No API keys or `.env` file needed — Claude Code subagents do the AI work; the Bun
tools (`coa-to-csv`, `review-groups`) are deterministic.

## What you get

- **`/ksk-keying`** — parent orchestrator skill (stages, gates, artifact contract)
- **Six subagents** in `.claude/agents/` — magnum, columbo, watson, sherlock, marple, poirot
- **Review UI** — `review.html` per bucket with inline source preview + PEAK XLSX export

Client data stays **outside** this repo. Point the workflow at a client folder on disk.

## Run

```
/ksk-keying
```

or:

```
run ksk-keying on /path/to/_362 บจก.ตัวอย่าง
```

Human review gates stop at Stage 0 (client profile), ambiguous segmentation, and weak
transaction links.

When finished, open each bucket's review page in Chrome or Edge:

```
file:///path/to/client/_doc_groups/expense/vat/review.html
```

Review, then export `peak_import_<bucket>.xlsx` from the page.

### Artifacts created in the client folder

| Artifact | Purpose |
|----------|---------|
| `CLIENT.md` | Client profile — business nature, buyer identity, COA conventions |
| `coa.csv` | Chart of accounts (converted from `ผังบัญชี` workbook if needed) |
| `_segments/` | Folder segmentation proposal |
| `_doc_groups/` | Category/VAT tree, per-group interpretations and mappings |
| `review.html` + `peak_import_*.xlsx` | Human review + PEAK export per bucket |

Full contract: `.claude/skills/ksk-keying/SKILL.md`.

## Repo layout

```
.claude/
  skills/ksk-keying/      # /ksk-keying skill + references/
  agents/                 # six leaf subagents (auto-loaded)
tools/ksk/                # Bun tools (coa-to-csv, review-groups)
scripts/install.sh        # one-command setup
docs/ksk-team/            # visual team overview (optional)
```

## Notes

- **Work from this repo.** Subagents only auto-load when Claude Code's working directory
  is this project.
- **Never commit client data.** `samples/` and `tools/ksk/.runs/` are gitignored.
- **Claude Desktop / Claude.ai** cannot run this workflow — it needs Claude Code subagents.