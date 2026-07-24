# Prototype: excluded/skip review page (wayfinder ticket #34)

**Question:** what should the excluded/skip review page — the first and most
important review surface — actually look like, so a human can clearly judge
whether each AI-proposed exclusion was correct?

**Three initial variants**, switchable via `?variant=A|B|C`:

- **A — vertical review list.** One card per claim, inline preview + actions.
- **B — single-item focus/triage mode.** One claim large and centered, a rail
  to jump between claims, keyboard shortcuts, auto-advance.
- **C — gallery grouped by reason.** Thumbnail grid grouped by reason category,
  click to open a detail modal.

**Verdict: a fourth shape, converged into onto Variant A's slot after real feedback:**

1. First pass (list of small inline cards) had a preview too small (96px) to
   actually judge a skip — a review page needs the preview to carry the
   judgment, not just label it.
2. Second pass: big 50/50 side-by-side cards, stacked in a scrollable list —
   still not enough; the preview needed to dominate, and the list needed to
   become pure navigation, not compete for space.
3. **Final shape: a full-height split screen.** Left is a real document-viewer
   pane, filling the screen height — one labeled pane for a plain exclusion,
   two labeled panes ("หน้าที่ตัดออก" / "หน้าที่ซ้ำอยู่ (เก็บไว้)") side by
   side when the reason is `duplicate`. Right is the scrollable claim list
   (metadata + actions only, no thumbnail) — click any row to load it into
   the viewer; deciding a row auto-advances to the next unreviewed item.
4. Final polish: light mode, matching the dashboard prototype's (#32) exact
   palette — warm stone neutrals (`#f7f6f3`/`#ece9e3`), the same red/green
   tint pairing as its STATUS_META for the "cut"/"kept" duplicate labels, blue
   `#1d4ed8` accent for the active selection.

Run: `bun run --cwd console proto:excluded-review` (serves on `0.0.0.0:4902`
by default, override with `PORT=`/`HOST=`).

**Status:** answer captured; dev server stopped (ad hoc, per this machine's
LAN-serving convention). Code left in place at
`console/_prototype_excluded_review/` — not yet promoted (no real app skeleton
exists to fold it into) or cleaned up (variant-b.ts/variant-c.ts/switcher.ts
are now superseded reference points, not live alternatives) until a future
"Build: excluded/skip review page" ticket does both.
