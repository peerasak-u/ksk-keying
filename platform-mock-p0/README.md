# KSK platform mock — phase 0 + phase 1

A clickable, self-contained mock of the proposed KSK office platform (see issue #29),
built incrementally in one PR under captain review. **Phase 0** (login, sidebar nav frame,
personal project-card dashboard) is approved; **phase 1** (identity/roles, customers,
month board, run-start permissions) is the current addition — see the Phase 1 section
below. Supersedes PR #49, which the captain rejected as too cluttered/busy — phase 0 was a
from-scratch redesign under the design principles laid out there, and phase 1 keeps
building on the same mock rather than starting over.

**Round 1 revision** applied captain feedback on the first version of this mock: the
dashboard was re-modeled around projects instead of raw task rows, a collapsible sidebar
replaced the plain topbar as the nav frame, and the typeface changed to Google Sans
Flex/Noto Sans Thai. Details in the sections below.

**Round 2 revision**: replaced the circled-Unicode-digit phase/gate progress indicator
(`①✓ ②● ③○`) with a proper connected-timeline stepper — plain CSS shapes + one inline SVG
checkmark, dots joined by a track that fills up to the current step.

**Round 3 revision**: removed every emoji used anywhere in the mock (nav icon, sidebar
toggle, mobile hamburger, logout icon, empty-state celebration) and replaced them with
inlined Lucide SVG icons — same self-hosted, no-CDN approach as the round-1 font change.
See Icons below.

**Round 4 revision**: two section-label copy changes — "ติดขัด — รอการตัดสินใจ" →
"รอการตัดสินใจ", "วันนี้ต้องทำ" → "งานในมือ".

**Phase 1**: identity/roles, a Customers list + detail, a Month board, and a Project detail
screen with run-start permissions.

**Round 5 revision**: job types are now admin-editable rather than hardcoded, the free-text
"gate" per project became a real named-Gate checklist under the confirmed
**Job type → Phase → Gate** vocabulary, and Customer detail uses the actual designed field
list instead of the phase-1 3-field placeholder. Full writeup in the Round 5 section below.

**Round 6 revision** (this addition, from a design pass grounded in the captain's real
accounting checklist): the job-type editor gained a second nested level — each Phase now
has its own editable Gate checklist (name + required flag), not just a flat Phase-name
list — and the `monthly` job type's 4 generic placeholder phases were replaced with the
real 5-Phase/37-Gate structure from the office's actual accounting checklist. Full writeup
in the Round 6 section below.

## Open it

Open `index.html` directly from disk (double-click, or drag into a browser). No server, no
internet connection, no build step. Everything is in the one file: no CDN, no external
fonts (both typefaces are self-hosted as inlined base64 `data:` URIs — see Typography below).

**This is not real.** No backend, no database, no real auth, nothing persists (refresh =
reset), and every action button is a pure simulation — it shows a toast and does nothing
else. There is no pipeline call and no cost.

## What's here (and what isn't)

Phase 0 (approved):

- a login/session screen (three switchable demo users as of phase 1, so you can see the
  dashboard and permissions differ per person)
- the top-level navigation frame — a collapsible sidebar (toggle icon-only vs. labeled;
  on narrow viewports it becomes an off-canvas drawer instead) carrying product identity,
  nav destinations, and the current user + logout
- the personal dashboard shell ("งานของฉัน"): "what's left today" and "what's blocked",
  nothing else, modeled around **projects** (see below) instead of raw task rows

Phase 1 (this addition, captain-approved scope from `phase1-scope.md`):

- basic identity/roles (see Phase 1 → Identity below)
- a Customers list + detail view
- a Month board
- run-start permissions on the Project detail screen

Deliberately **not** built in phase 1, per the captain's explicit exclusion: the
financial-statement AI analyser feature — not built, not stubbed. Gate integration and any
further phases remain separate future work, to follow only after another round of captain
review on this slice.

## The dashboard's unit is a PROJECT, not a task row or a Key Ink status

Round 1 feedback: the first version organized the dashboard around Key Ink (the
auto-fill/document-reading feature) — wrong axis, since Key Ink is just one gate inside one
phase of one job, not the spine of the system. The row-of-cards shape stayed (captain
confirmed that part was right); what changed is what one row/card *is*.

A **project = one client + one job type.** The same client can run more than one project at
once — its recurring monthly bookkeeping work and, say, a separate Consult engagement — and
those are two separate cards, never merged just because the client is the same. The mock
demonstrates this directly: "บจก. ศรีชัยศึกษาภัณฑ์สกลนคร" appears twice, once as a blocked
monthly project and once as an active Consult project.

Each card shows real progress, not a Key-Ink-specific status: a phase stepper, which phase
the project is currently in, and which gate within that phase it's waiting on. Job types
carry their own phase lists (monthly work: รับเอกสาร → คีย์ข้อมูล → ตรวจทาน → ส่งมอบ; Consult:
นัดหมาย → ให้คำปรึกษา → สรุปผล; one-off Project work: วางแผน → ดำเนินการ → ส่งมอบ) —
Key Ink's auto-fill step is just one gate quietly inside the คีย์ข้อมูล phase, mentioned
only in passing, never the dashboard's organizing structure.

## Phase stepper (round 2 change)

The first version's stepper used circled-Unicode-digit glyphs (`①✓ ②● ③○`) — rejected as
dated/tacky. It's now a connected-timeline stepper: a row of small dot shapes joined by a
track, built from plain CSS (`border-radius: 999px` circles, a `<div>` track between them)
plus one inlined Lucide `check` SVG for the done marker — no emoji, no Unicode symbol
glyphs (`buildStepper()` in `index.html`). The track between two steps is filled once the
step behind it is done, so the line itself shows progress up to (not past) the current
step. Colour stays minimal here too: done and upcoming markers are neutral stone, and blue
(the mock's one "this needs your attention" accent) appears only on the current step —
nothing else in the stepper carries color.

## Typography (round 1 change)

Round 1 feedback: the previous system-font stack (`"Segoe UI", system-ui, sans-serif`) read
as too heavy/formal/stiff; the captain asked for Google Sans specifically, self-hosted (no
`fonts.googleapis.com` link — same no-CDN rule as everything else here).

**What's actually wired in, and why it's two font families, not one:** "Google Sans" itself
recently became free to redistribute — Google published it (and the variable "Google Sans
Flex") to Google Fonts under the SIL Open Font License, so it's legitimately embeddable/
distributable, including self-hosting the file, with no attribution required. Verified
directly against Google Fonts' own served CSS (`fonts.googleapis.com/css2?family=Google+Sans+Flex`)
before wiring it in, rather than assuming. That same CSS also shows Google Sans Flex ships
**Latin glyphs only** — no Thai unicode-range block exists in it at all — and this mock is
almost entirely Thai text. Shipping only Google Sans Flex would have changed nothing visible
for a Thai reader. The fix is the same pairing Google's own products use for non-Latin
scripts alongside Google Sans: "Noto Sans Thai" (also OFL, also on Google Fonts) as the Thai
companion. Both are declared as one CSS font stack —
`"Google Sans Flex", "Noto Sans Thai", system-ui, sans-serif` — so the browser's normal
per-character font-matching picks whichever face actually covers a given character; nothing
scripted, no per-element font switching.

Both were downloaded already subset to only the scripts this mock uses (Google Fonts serves
per-script `unicode-range` subsets), then re-encoded as base64 `data:` URIs directly in the
`<style>` block's `@font-face` rules — no external font file, no CDN request at runtime, same
constraint the mock already followed for everything else. Combined the two add ~60KB of
inlined base64 (36KB Latin variable weight + 9KB Thai variable weight) — small because each
is subset to exactly the codepoints in use, not the full font family.

## Icons (round 3 change)

Round 3 feedback: no emoji anywhere in the mock, at all — not just the round 2 progress
indicator. The sidebar collapse toggle and mobile hamburger (`☰`), the nav icon (`🗂`), the
logout icon (`⏻`), and the empty-state celebration (`🎉`) are now [Lucide](https://lucide.dev)
icons (`menu`, `clipboard-list`, `log-out`, `check-circle-2`) instead.

Same self-hosting rule as the round-1 font change: Lucide ships each icon as plain SVG
source (ISC-licensed, individually distributable), so the four actually used here are
inlined directly as `<svg>` markup in `index.html` — no `lucide.dev`/npm/CDN request at
runtime, and no bundling of icons this mock doesn't use. Every inlined icon uses
`stroke="currentColor"`, so it just follows its container's existing text color (sidebar
grey, active-link white, etc.) rather than needing its own color rule — one `.icon`/
`.icon-sm` CSS class handles sizing for all of them.

## Visual reference (carried over from round 0, unchanged)

This mock's look is otherwise carried over from the existing production KSK app
(`console/app/*.ts` in this repo — a server-rendered Bun app, no framework, no shared
stylesheet, each page inlines its own `<style>`). Conventions reused here:

- **Base colors**: body text `#292524` on a warm off-white `#f7f6f3` background — lifted
  directly from `console/app/dashboard.ts`'s own `body` rule (only the `font:` part of that
  rule changed, per the Typography section above).
- **Dark topbar → dark sidebar**: `#1c1917` background with `#fafaf9` text — same color the
  console dashboard's `header.topbar` uses, now the sidebar's background instead (round 1
  moved the nav frame from a topbar to a collapsible sidebar; the color carried over).
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

## Phase 1

All four screens read from one shared, in-memory data set (`ROLES`, `USERS`, `CUSTOMERS`,
`PROJECTS`, `MONTHS` in `index.html`) instead of each screen holding its own copy — the
same "one source of truth" fix phase 0's round 1 revision already applied to My work
(`PROJECTS` there was per-user; now it's one master list every screen filters). Still no
backend: this is an in-page JS array, reset on refresh like everything else in the mock.

### Identity

A small role catalog — `พนักงานฝึกงาน` (intern), `พนักงานตรวจทานเอกสาร` (staff),
`หัวหน้าทีมตรวจทาน` (lead), `ผู้ดูแลระบบ` (admin) — not a full auth system. The login
screen gained a third demo user (`ธนกร ฝึกงาน`, an intern) alongside the existing two staff
demo users, specifically so the run-start permissions screen (below) has an intern account
to actually log in as and see "(คุณ)" next to their own role. Round 5 added a fourth
(`กิตติ ดูแลระบบ`, admin), needed so someone could actually reach the round-5 "ประเภทงาน"
admin screen — until then no demo user held the admin role at all.

### Customers

A list page (`ลูกค้า` in the sidebar) and a detail page. The list shows each customer's
active project count, job-type pills, status pill (when not `active`), and a blocked-count
badge when relevant. The detail page is where phase 0's "one client can run more than one
project at once" model becomes literally visible: "บจก. ศรีชัยศึกษาภัณฑ์สกลนคร" shows both
its monthly project and its separate Consult project on the same page, never merged into
one card. (Field list upgraded in round 5 — see below.)

### Month board

A month switcher (‹ กรกฎาคม 2569 ›, three demo months) plus a flat list of every project
across every assignee scheduled that month — reusing the exact same project-card component
as My work and Customers, not a new card design. Blocked projects sort first; otherwise
it's a single list, not a multi-column kanban board — the captain's "lightweight, not Jira"
principle from phase 0 applies here too, explicitly repeated in the phase 1 brief.

### Run-start permissions

Reached from any project card → Project detail. A static permissions card lists all four
roles with a plain checkmark next to each — every role can start a run at the project's
current gate, **interns included**, which the card's caption states explicitly rather than
leaving it implied. Only admin gets an additional "+ แก้ไขสิทธิ์ได้" (can also edit who's
allowed) note; there is no permissions *editor* anywhere in this mock; the brief called that
optional and this stayed a read-only indicator, not a UI for changing it. Whichever role
matches the logged-in demo user is tagged "(คุณ)" so the connection between login identity
and this screen is concrete, not just described.

Project detail is reached from three different places (My work, Customers, Month board);
its back button returns to whichever one you came from (`returnTo` in `index.html`) rather
than hard-coding a single parent page.

## Round 5 — admin-editable job types, real Gate checklists, real Customer fields

Three changes from a domain-model research pass the captain reviewed and decided on
(`data/ksk-domain-model-scout/report.md` and `data/ksk-console-platform-design/report.md`
§5.2, both in the firstmate home — not in this repo).

### Job types are admin-editable, not hardcoded

`JOB_TYPES` in `index.html` used to be a fixed 3-entry object (`monthly`/`consult`/
`project`) baked into the JS. It's now a plain array an admin can add to or edit through a
new "ประเภทงาน" screen (sidebar item visible to the admin role only — added a fourth demo
login, `กิตติ ดูแลระบบ`, specifically to reach it). The form is deliberately small: a name,
and an ordered list of Phase names, add/remove freely. To prove this is genuinely
open-ended and not just a bigger hardcoded list, the screen has been used live in the mock
to add a fourth job type ("รายปี" / yearly, 3 phases) — it's not pre-seeded as demo data,
it's created through the same form a real admin would use.

Building the admin-only nav item surfaced a real bug: `.btn`/`.sidebar-link`'s own CSS
`display` rules (`inline-block`/`flex`) outrank the browser's default
`[hidden] { display: none }` — equal specificity, later author rule — so the "ประเภทงาน"
nav item and the job-type-form's cancel button were both rendering visible despite
`hidden = true`, until an explicit `.btn[hidden]`/`.sidebar-link[hidden]` override was
added for each. Same gotcha the production console app (`console/app/dashboard.ts`)
already documents and guards against for its own status chips.

### Terminology: Job type → Phase → Gate, and nothing else

Confirmed 3-level model, settled after "Grade" turned out to be a slip for "Phase": a
**Phase** is a stage of work (e.g. "คีย์ข้อมูล"); a **Gate** is a named checklist item
inside a Phase (e.g. "ยืนยันเอกสารซ้ำ 2 รายการ"). There is no other level, and no other
schema name for either of these anywhere in this mock's code or copy — internal design-doc
names for the same two levels (`GateDef`, `RequirementDef`) are mentioned in source
comments only as "don't use this," never as an actual identifier.

Every project's old single free-text `gate` sentence (e.g. `"พบเอกสารซ้ำ 2 รายการ — ระบบ
หยุดรอคนยืนยันก่อนไปต่อ"`) is now a real `gates: [{ name, done }]` checklist for its current
Phase (`gateListHtml()` in `index.html`) — 2-3 named Gates per project, each a plain check
(done) or hollow dot (pending), no glyphs/emoji. This is what makes "the Phase/Gate model is
the core of the task manager" (the captain's words) actually visible on every project card,
not just implied by a status string. A pending Gate only picks up the mock's amber
"needs attention" color when it's the specific Gate holding up a blocked project — the
checklist itself stays neutral everywhere else, same minimal-color rule as the rest of the
mock.

### Customer detail: the real field list

The phase-1 `CUSTOMERS` object (`name`/`taxId`/`contact`) was an explicit placeholder to
prove the one-customer-many-projects layout, not a considered field list. It's now the
`Customer`/`CustomerContact` split from the design doc: `code` (office's own short code),
`legalName`, `displayName` (what cards/lists actually show), `taxId` (nullable — one demo
customer is a บุคคลธรรมดา, not a registered entity, and the detail page renders that
explicitly as "ไม่มี (บุคคลธรรมดา)" rather than blank), `businessNature`, `status`
(`active`/`dormant`/`resigned` — one demo customer is `dormant` with zero projects, so the
"0 โปรเจกต์" and non-active-status cases both actually render somewhere), `lineGroupId`,
`note`, `onboardedAt`, plus a separate `contacts[]` array (name, role, phone, email, LINE
id, `isPrimary`) instead of one free-text contact string. `dropboxRoot` is deliberately
left out, per the brief — it's filesystem plumbing, not something a customer-detail screen
should surface.

## Round 6 — nested Phase→Gate job-type editor, real accounting checklist

From a design pass grounded in the captain's actual accounting checklist
(`data/ksk-gate-checklist-scout/report.md`, firstmate home, not in this repo).

### The job-type editor now edits Gates too, not just Phases

`JOB_TYPES[i].phases` changed shape from `[string, ...]` to
`[{ name, gates: [{ name, required }] }, ...]`. The "ประเภทงาน" screen's Phase list editor
gained a second, nested repeatable list: each Phase row now has its own
`[+ เพิ่ม Gate]`-repeatable Gate rows directly underneath it, one level indented — the exact
same input-row pattern (text input + "×" remove button) the Phase row already used, not a
new component (`.phase-input-row`/`.phase-input`/`.phase-input-remove` are shared as-is;
only `.gate-input-row`/`.gates-inputs`/`.add-gate-btn` are new, purely for indentation).
Each Gate row also carries a "บังคับ" (required) checkbox, defaulting to checked.
`submitJobTypeForm()` now scopes its Gate-input queries to each Phase block
(`block.querySelectorAll(...)`) rather than the whole document, and requires every Phase to
have at least one Gate the same way it already required at least one Phase.

Gate template fields stop at **name + required** — no ผู้ทำ/ผู้สอบทาน/status/date fields
here, per the brief: those are per-run tracking fields that belong on a future per-project
Gate *instance*, which this mock already has (`PROJECTS[i].gates: [{ name, done }]`, round
5) — a completely separate thing from this screen's job-type *template*. Editing a job
type's Gate template here never touches any project's own checklist.

### `monthly` reseeded from the real checklist

The generic 4-phase placeholder (`รับเอกสาร → คีย์ข้อมูล → ตรวจทาน → ส่งมอบ`) is replaced
with the office's actual 5-Phase/37-Gate accounting checklist, Gate wording taken verbatim
from the source workbook (quoted in full in the scout report): **รวบรวมเอกสาร** (7 gates),
**บันทึกบัญชี** (5), **ยื่นแบบภาษี** (9), **ปรับปรุงรายการ** (8), **ปิดบัญชี** (8). In
`ปรับปรุงรายการ`, three gates are flagged `required: true` as "4M" (never-skip-monthly)
items in the source sheet — bank reconciliation, depreciation, and clearing suspense
accounts — while the other five in that Phase are `required: false` ("4Y", year-end-only).
Every other Gate across all 5 Phases is `required: true`. `consult` and `project` keep
their phase-1 Phase names unchanged this round (only reshaped to the new nested format,
each Phase given one plausible placeholder Gate) — a `รายปี` (yearly) job type from the
same source sheet is a future round, not this one, per the brief.

Every existing `monthly` demo project's `phaseIndex` and per-project `gates` were remapped
to the new 5-Phase list so the stepper and checklist stay coherent (e.g. the project that
was blocked on a duplicate-document check now sits in `รวบรวมเอกสาร`; the two bank-
reconciliation-pending projects now sit in `ปรับปรุงรายการ`, matching gate 4.1 in the real
checklist exactly) — these are still round-5-style per-project *instances*, unrelated to
the job-type template change above.


## Design principle applied: personal task manager, not an overview dashboard

The dashboard shows only what's relevant to the logged-in person right now: their own
"today" queue and their own blocked items — never a cross-company or cross-employee
overview. Switch between the two demo users on the login screen to see this concretely:
one has blocked items and a full queue, the other has an empty blocked section (hidden
entirely, not shown-as-zero) and a single task. A company-wide/executive overview
dashboard is an explicit non-goal of this phase.
