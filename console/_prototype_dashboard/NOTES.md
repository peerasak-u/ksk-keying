# Prototype: company/month picker + run dashboard (wayfinder ticket #32)

**Question:** what should the company/month picker and live run dashboard actually
look like — glanceable per-client history of run/not-run months, plus a live
queue/running/done view?

**Three variants**, switchable via `?variant=A|B|C` on the same route (`serve.ts`):

- **A — one unified table.** Every client × month is a row, grouped under a client
  header row. Spreadsheet mental model; a search box filters by name/code.
- **B — client cards + a persistent "active now" rail.** A grid of client cards
  (dots = month status, click to expand a per-client month timeline inline) plus an
  always-visible left sidebar showing what needs attention / is running / is queued,
  regardless of which client you're browsing.
- **C — Kanban board + quick-picker.** A top search bar for starting new work
  fast (type a client, see its not-yet-run months as clickable chips) plus a 4-lane
  board (queued / running / needs review / done) for "what's happening across
  everything right now."

Run: `bun run --cwd console proto:dashboard` (serves on `0.0.0.0:4901` by default,
override with `PORT=`/`HOST=`).

**Verdict: Variant A (unified table) won outright** — Peerasak liked it from the first
look and it survived three rounds of real feedback without needing a rethink:

1. Add search-by-name/code AND a status filter (clickable chips, OR-combined with the
   text search) so you can scope to "what's running right now" / "what needs me" etc.
2. Client-header rows must never disappear when a filter empties out a client's rows —
   the company name is load-bearing context; added a per-client "ไม่มีเดือนที่ตรงกับ
   ตัวกรองในบริษัทนี้" placeholder row instead of letting the header vanish.
3. Constrain content to a centered `max-width` (full-bleed color bars, centered
   content) for wide monitors, and reflow each row into a labeled stacked card
   (`data-label` + a `@media (max-width: 640px)` query) instead of a squeezed table
   on narrow/mobile widths.

**Status:** answer captured; this prototype's dev server has been stopped (ad hoc, per
this machine's LAN-serving convention — restart with
`bun run --cwd console proto:dashboard` if needed again). The code is intentionally
**left in place** rather than deleted/promoted yet — there's no real app skeleton to
promote the winning variant into until a future "Build: dashboard" ticket exists on
the wayfinder map. When that ticket lands: fold Variant A's markup/CSS/filter JS into
the real app (reading live sequencer/run state instead of `mock-data.ts`), then delete
`variant-b.ts`, `variant-c.ts`, `switcher.ts`, and this whole `_prototype_dashboard/`
directory.
