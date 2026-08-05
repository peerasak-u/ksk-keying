# KSK platform mock — phase 0

A clickable, self-contained mock of **phase 0 only** of the proposed KSK office platform
(see issue #29). Supersedes PR #49, which the captain rejected as too cluttered/busy — this
is a from-scratch redesign under the design principles below, scoped down to just phase 0.

## Open it

Open `index.html` directly from disk (double-click, or drag into a browser). No server, no
internet connection, no build step. Everything is in the one file: no CDN, no external
fonts.

**This is not real.** No backend, no database, no real auth, nothing persists (refresh =
reset), and every action button is a pure simulation — it shows a toast and does nothing
else. There is no pipeline call and no cost.

## What's here (and what isn't)

Phase 0 only, per the captain's direction:

- a login/session screen (with two switchable demo users, so you can see the dashboard
  actually differ per person)
- the top-level navigation frame (topbar with product identity + current user + logout)
- the personal dashboard shell: "what's left today" and "what's blocked", nothing else

Deliberately **not** built here: customers, the month board, run-start permissions, gate
integration, or any company-wide/executive overview dashboard. Those are separate future
phases and will follow as their own small PRs once this phase 0 shell is reviewed.

## Visual reference

This mock's look is carried over from the existing production KSK app
(`console/app/*.ts` in this repo — a server-rendered Bun app, no framework, no shared
stylesheet, each page inlines its own `<style>`). Conventions reused here:

- **Typography & base colors**: `"Segoe UI", system-ui, sans-serif`, 14px/1.5, body text
  `#292524` on a warm off-white `#f7f6f3` background — lifted directly from
  `console/app/dashboard.ts`'s own `body` rule.
- **Dark topbar**: `#1c1917` background with `#fafaf9` text, sticky — same as the
  console dashboard's `header.topbar`.
- **Stone/warm-gray neutral palette** for borders, secondary text, and card chrome
  (`#57534e`, `#78716c`, `#a8a29e`, `#d6d3cd`, `#ece9e4`, `#f0eee9`, `#f1efec`) — the same
  swatches `STATUS_META`, `.btn-ghost`, `.run-card`, etc. use in the console app.
- **Card style**: white background, `1px solid #ece9e4` border, `border-radius: 10px`,
  `box-shadow: 0 1px 3px rgba(0,0,0,0.08)` — taken from `.run-card` in the console dashboard.
- **Sparse accent color, by design** (captain's principle 3): exactly three accents,
  each meaning one specific thing everywhere it appears — blue `#1d4ed8` for the single
  primary action, red `#b91c1c`/`#fee2e2` for anything blocked/urgent, amber
  `#92400e`/`#fef3c7` for anything waiting. Pulled straight from the console app's
  `STATUS_META` table and `.btn-run`/`.btn-attn` button classes. Everything else in the
  UI stays neutral stone.
- **Pills, buttons, breadcrumb-style page label** — same rounded-pill badge shape
  (`border-radius: 999px`) and `.btn` sizing/weight as the console app's own.

No production app for the actual KSK *platform* (the thing issue #29 describes) exists yet
to reference directly — `console/` is the closest and most authoritative existing product
surface in this repo, and is what this mock's visual language is built to match.

## Design principle applied: personal task manager, not an overview dashboard

The dashboard shows only what's relevant to the logged-in person right now: their own
"today" queue and their own blocked items — never a cross-company or cross-employee
overview. Switch between the two demo users on the login screen to see this concretely:
one has blocked items and a full queue, the other has an empty blocked section (hidden
entirely, not shown-as-zero) and a single task. A company-wide/executive overview
dashboard is an explicit non-goal of this phase.
