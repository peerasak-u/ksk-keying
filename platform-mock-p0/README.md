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

**Round 6 revision** (from a design pass grounded in the captain's real
accounting checklist): the job-type editor gained a second nested level — each Phase now
has its own editable Gate checklist (name + required flag), not just a flat Phase-name
list — and the `monthly` job type's 4 generic placeholder phases were replaced with the
real 5-Phase/37-Gate structure from the office's actual accounting checklist. Full writeup
in the Round 6 section below.

**Round 7 revision** (this addition): the per-project screen became the place the work
actually gets done — every Phase of the job type as a collapsible checklist, one click to
tick a Gate, the office's own ผู้ทำ/ผู้สอบทาน/วันที่เสร็จ/สถานะ/หมายเหตุ recorded per Gate,
a visible required-Gates rule for advancing a Phase, and "ต้องการการตรวจสอบ" now genuinely
produced by a Gate sitting unsigned rather than being a static label. The remaining four
job types are seeded from their own sheets of the same workbook. Full writeup in the
Round 7 section below.

**Round 8 revision** (this addition): the "ประเภทงาน" admin screen became a two-column
layout — job-type list on the left, add/edit panel on the right — so neither adding a job
type nor editing one requires scrolling any more. Layout only; the nested Phase→Gate editor
itself is unchanged. Full writeup in the Round 8 section below.

**Round 9 revision**: the office-wide overview (`ภาพรวมสำนักงาน`) behind a role capability,
and a customer detail page that carries what a manager opens it for. Full writeup in the
Round 9 section below.

**Round 10 revision** (from `data/ksk-exec-view-scout/report.md`, which decoded the client's
own monitoring demo): the executive view rebuilt as five named sections with a period switch
and a team filter; Gate deadlines expressed as editable **rules** rather than dates; the flat
role list replaced by the office's **real three teams and their review ladder**; the office's
own six-step document-chase ladder modelled; and the whole mock seeded to the real **113
customers** so the lists are exercised at the volume they will meet. Full writeup in the
Round 10 section below.

**Round 18 revision**: the two round-17 surfaces that read as a flat part of the page —
รับลูกค้าใหม่ and adding/editing a person — are now modal dialogs over the screen you came
from, built as one shared component rather than two one-off implementations. Plus, on the
captain's call after reviewing it, the sidebar's unread-notification badge is red. Full
writeup in the Round 18 section below.

**Round 23 revision**: every dialog in the app was rendering unstyled at the bottom of the page
— round 22's CSS rewrite had deleted the round-18 dialog stylesheet. Restored, with the reproduction
and the falsification check recorded. Full writeup in the Round 23 section below.

**Round 22 revision**: the ten layout defects that density change caused, fixed at the cause —
the person card was a `<button>` that was also a flex container, and the card box was genuinely
too small for its content. Plus two round-19 action-bar regressions found by sweeping the rest of
the app. Full writeup in the Round 22 section below.

**Round 21 revision**: พนักงานและทีม packs two teams per row and three people per row, each
person's card says how much they are carrying and how much they have closed, and an admin can
now create a team. Full writeup in the Round 21 section below.

**Round 20 revision**: the standalone document-chase ladder panel is deleted from the project
screen — Phase + Gate is the single operational spine, and the ladder duplicated Phase 1's own
Gates. The one thing only it could say (asked-and-waiting vs the customer has nothing) is now
recorded on the Gate itself and everything else is derived. Deliberately reverses part of
round 10; full writeup in the Round 20 section below.

**Round 19 revision**: the workflow review flow's two steps kept their actions in different
places, and step 2's `บันทึกและถัดไป` was below the fold. Both now end in one shared sticky
action bar with the primary in the same slot. Full writeup in the Round 19 section below.

**Round 17 revision**: the three places a demo tour would still have had to say "imagine this
part" — taking on a new customer (and a continuous path from signing them to work appearing),
a พนักงานและทีม screen whose consequences are the real review-ladder ones, and a restrained
per-person notification surface built only on events the mock already had. Full writeup in the
Round 17 section below.

## Open it

Open `index.html` directly from disk (double-click, or drag into a browser). No server, no
internet connection, no build step. Everything is in the one file: no CDN, no external
fonts (both typefaces are self-hosted as inlined base64 `data:` URIs — see Typography below).

**This is not real.** No backend, no database, no real auth, nothing persists (refresh =
reset). As of round 7 the checklist buttons do change the mock's own in-memory state — tick
a Gate, sign it off, advance a Phase and every other screen reacts — but that state lives
only in the page and is gone on refresh. There is no pipeline call and no cost.

## What's here (and what isn't)

Phase 0 (approved):

- a login/session screen (five switchable demo users as of round 7, so you can see the
  dashboard and permissions differ per person — including an intern who can tick Gates but
  not sign them off, and a team lead who can)
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
the project is currently in, how many of that phase's required Gates are closed, and the
next few Gates still open. Job types carry their own Phase lists — as of round 7 those are
the office's own five sheets, e.g. กลุ่มรายเดือน: รวบรวมเอกสาร → บันทึกบัญชี → ยื่นแบบภาษี →
ปรับปรุงรายการ → ปิดบัญชี. Key Ink's auto-fill step is just one gate quietly inside one
phase, mentioned only in passing, never the dashboard's organizing structure.

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

*(Round 7 note: this card is still on the Project detail screen and still read-only, but it
now describes what each role can do to a **Gate** — tick it, and whether it may sign the
ผู้สอบทาน column — since that is the permission the screen actually exercises. Everything
below about it being a static indicator rather than an editor still holds.)*

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

*(Round 7 superseded the per-project half of what follows: a project no longer authors its
own `gates` list at all — the checklist is generated from its job type's template. The
Job type → Phase → Gate vocabulary above is unchanged.)*

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


## Round 7 — the working screen, and all five job types seeded

### The project screen is now where the work actually happens

The project detail view used to *show* progress; now you work it. Every Phase of the job
type is listed down the page as a collapsible panel. The Phase in progress is open by
default and is the only one with any colour or weight; the others are one quiet row each
(marker, name, `เกทบังคับ n/m`) and open read-only when clicked — so 37 Gates are all
reachable without ever dumping 37 rows on the screen at once.

Inside the open Phase, each Gate is one checklist row: a tick circle on the left, the
workbook's own `รหัส` + wording, and its state. **One click on the circle records the
common case** — สถานะ `เสร็จ`, ผู้ทำ defaulted to the signed-in user, วันที่เสร็จ defaulted
to today. Clicking the row itself expands an inline strip (never a modal) with the rest of
the office's own tracking columns: ผู้ทำ, ผู้สอบทาน, วันที่เสร็จ, สถานะ
(`ยังไม่เริ่ม`/`กำลังทำ`/`เสร็จ`), หมายเหตุ.

### "ต้องการการตรวจสอบ" is now produced, not declared

There is deliberately **no fourth สถานะ value**. "Waiting on a reviewer" is how the office's
own sheet already encodes it: สถานะ `เสร็จ` with the ผู้สอบทาน column still blank. That one
condition is the single source of the `ต้องการการตรวจสอบ` state everywhere in the app — the
red card on งานของฉัน, the `รอสอบทาน` section, the count on the Customers list, the sort
order on the month board. No project carries a `blocked` flag any more; `isAwaitingReview()`
derives it from the checklist. Sign the Gate off and the red disappears from every screen at
once.

Permissions extend the existing role catalog rather than adding a second one: `canReview`
is `false` for พนักงานฝึกงาน and `true` for the rest, and **a Gate's ผู้ทำ and ผู้สอบทาน can
never be the same person** (the sheet's own worked example is น้องเมย์ / พี่หนึ่ง). An intern
sees the ผู้สอบทาน field disabled with the reason stated; a reviewer who did the work
themselves gets the same treatment. A new `วิภา หัวหน้าทีม` demo user exists so the reviewer
half of the loop is reachable. งานของฉัน also now surfaces projects a reviewer is *eligible
to sign*, not only ones assigned to them — otherwise a reviewer could never find the Gate
waiting on them.

### The Phase-advance rule is visible

A Phase advances when all its **required** Gates are closed (done *and* signed); non-required
ones can be skipped. The bottom of the open Phase always says which case you are in: either
"เกทบังคับครบทั้ง n ข้อแล้ว" with a live `ผ่านเฟสนี้ ไป "<next>"` button, or the exact list of
required Gates still outstanding, by `รหัส`, each with why (`ยังไม่เริ่ม` / `กำลังทำ` /
`รอผู้สอบทานเซ็น`) and the button disabled. Advancing moves `phaseIndex`, which flows
straight back out to the dashboard cards, the stepper, the customer screen and the month
board — they all read the same derived state.

Rather than decorating 30-odd rows with a "บังคับ" badge, the minority is marked: skippable
Gates carry a muted `ไม่บังคับ` pill, a one-line legend states the rule, and the outstanding
list names the required ones concretely.

### A project's checklist comes from its job type, not from the project

The hand-authored `PROJECTS[i].gates` is gone. `ensureWork()` builds a per-run record for
every (project, phase, gate) from the job-type template, so two projects of the same job
type can no longer show different checklists, and an admin editing a template is visible in
every project using it (the work record re-aligns to the template on each render). Each
project's `seed` is only the demo *starting position* — how far along the current Phase is,
which Gates are mid-flight or awaiting a signature, and their seeded หมายเหตุ.

### All five job types seeded from the workbook

The two generic `consult` / `project` placeholders are replaced with real content, and two
job types added. One sheet of `Checklist_5Gates_งานบัญชี-1.xlsx` per job type, 5 Phases each,
wording copied verbatim (`รหัส` / `ขั้นตอนย่อย` / `ความถี่` / `หมายเหตุ` → `code` / `name` /
`freq` / `note`):

| job type | source sheet | Gates |
|---|---|---|
| `กลุ่มรายเดือน` | `Master 5 Gates`, `กลุ่มรายเดือน (ความถี่)` column | 37 |
| `กลุ่มรายปี` | `กลุ่มรายปี` | 37 |
| `ที่ปรึกษารายเดือน` | `ที่ปรึกษารายเดือน` | 20 |
| `งานโปรเจค` | `งานโปรเจค` | 22 |
| `งานทะเบียน` | `งานทะเบียน` | 19 |

`required: false` is only ever set where the sheet itself says the item does not always
apply — monthly's five "4Y"/ปิดปี rows in `ปรับปรุงรายการ`, yearly's two "(ถ้าจด VAT)" rows,
and rows whose own Thai wording is conditional (`ที่ปรึกษารายเดือน` 4.2 "(ถ้ามีในขอบเขตงาน)",
`งานทะเบียน` 2.3 "(ถ้าต้องมีมติที่ประชุม)").

Two things about the source deserve calling out. First, the last three sheets have **no
`ความถี่` column at all** — they are not the monthly/yearly cadence shape, so their Gates
carry no frequency and nothing was invented to fill the gap. Second, `ความถี่` repeats the
same value down almost every row of the two that do have it, so the UI prints it only where
a Gate deviates from its job type's baseline (`ปิดปี (4Y)`, `รายไตรมาส`, `ทุกเดือน (ถ้าจด
VAT)`, `ปีละครั้ง` …) — the exceptions are the information, the repetition is noise.

The job-type admin editor still edits name + Phase + Gate + `บังคับ` only; `code`, `freq` and
`note` ride through the form on `data-` attributes so editing a Phase never silently discards
the workbook's own `รหัส`/`ความถี่`/`หมายเหตุ`.


## Round 8 — ประเภทงาน as two columns, so add/edit needs no scrolling

Layout only. The nested Phase→Gate editing behaviour, its validation, and the `data-`
attributes that carry the workbook's `รหัส`/`ความถี่`/`หมายเหตุ` through the form are all
untouched.

The job-type list and the add/edit form used to be stacked, so reaching either meant
scrolling past the list — and after clicking แก้ไข on a 37-Gate job type, scrolling a long
way. They are now side by side: list on the left, editor on the right, both starting at the
same y. Clicking a row loads it into the panel **in place**, at `scrollY: 0`, and
`startEditJobType()` no longer calls `scrollIntoView` because there is nothing to scroll to.
"เพิ่มประเภทงานใหม่" is the panel's default/empty state and has its own entry under the
list, so adding is reachable without scrolling too.

Three things worth noting about how it is built:

- **The left column is the sticky one, not the right.** The captain suggested sticking the
  right panel so it stays in view as the list scrolls, but the geometry is the other way
  round: the list of 4-5 types is short, while the editor for a 5-Phase/37-Gate job type is
  several viewports tall — and `position: sticky` does not pin an element taller than the
  viewport. Sticking the short left column is what actually delivers the goal: the type list
  stays reachable while scrolling a long editor, and the panel is in view the instant any row
  is clicked either way.
- **List rows collapsed to a summary line.** A row is now the name plus `5 เฟส · 37 เกท`
  rather than a chip per Phase, so all five types fit the column without scrolling. The full
  Phase→Gate breakdown is one click away in the panel beside it.
- **`renderJobTypesList()` split out of `renderJobTypesPage()`**, so selecting a job type can
  re-highlight the list without wiping the editor that was just populated.

No new colour: a selected row and the "เพิ่มประเภทงานใหม่" button reuse the blue that already
means "this is the one currently active" everywhere else (the current stepper step, the
current Phase panel) plus the existing `.pill-current` chip. Rows are still `.customer-row`,
the editor is still the same `.permissions-card`. `main.wide` gives this one admin screen
1080px instead of the app's 820px reading width — the router toggles it; nothing else uses
it. Below 900px the two columns stack.

Also fixed in passing on this screen: `.icon` is `display: block`, so the "+ เพิ่ม Phase" and
"+ เพิ่ม Gate" buttons were wrapping their label onto a second line under the icon. Both now
carry a `.btn-with-icon` (`inline-flex`) class.


## Round 9 — the office-wide overview, and a customer page that carries information

### "ภาพรวมสำนักงาน" — a manager's screen, not a dashboard

This was deliberately deferred at the start of the redesign so the per-person work surface
could be got right first. It is built as the answers to five concrete questions, in that
order, and nothing else:

1. **What is behind, and how far behind?** There is no deadline field on a project and none
   was invented. A งวด is worked in the month *after* it closes — the whole of Phase 1 is
   collecting documents that only exist once the month has ended — so one month of lag is
   normal and only lag beyond that is late. "How far behind" is therefore stated in the unit
   the office actually thinks in: months of งวด (`monthsBehind()`), not invented days-past-due.
2. **What is stuck on a reviewer, and on whom?** Answered by a new `reviewer` field per
   project — see the decision note below.
3. **What is stuck on the customer?** Answered by a new `actor` field on the Gate template —
   see below.
4. **How is it closing out?** One thin meter bar: ปิดแล้ว / ยังไม่ปิด / ล่าช้า. This is the
   single chart on the screen, and every band of it is a button.
5. **Who is carrying how much?** A per-person list with a bar relative to the busiest person,
   so the longest bar *is* the overloaded one and the red part of it is their late work.

**Every figure is a button and nothing on the page is a dead statistic.** The five figures
and the three meter bands all select the same thing: the concrete list of project cards
behind that number, rendered directly underneath as the same `.task-card` used everywhere
else, each card annotated with one line saying why *this* list has it. The screen opens on
ล่าช้า rather than on a total, because that is the manager's first question. Clicking a
person in the workload list swaps the list to their open work; clicking them again returns.

No new components: the figures are `.btn-ghost` with the same inset-ring "selected"
treatment the ประเภทงาน list already uses, the people rows are `.customer-row`, the lists
are project cards. The only new shape is the meter, built from the palette's existing three
colours (dark stone = closed, light stone = open, red = late).

**Who sees it:** `ROLES` gains a third capability, `canSeeOffice`, added exactly the way
`canReview` was in round 7 — the same catalog, not a second role system. Only `lead` and
`admin` have it. The nav link is hidden for everyone else *and* the router refuses the page
(`PAGE_GUARD`), so a stale link cannot land someone on a screen their role does not have;
`job-types` is now guarded by the same mechanism instead of only by a hidden nav item.

### Two new fields, both because the existing material already needs them

- **`Gate.actor`** — marks the Gates the office cannot close on its own because the ball is
  in the customer's court. Taken from the sheet's own wording, never guessed: only rows that
  literally say รับเอกสาร / รับข้อมูล / ทวงข้อมูล / ลูกค้าอนุมัติ / ลูกค้ายืนยัน / ลูกค้าเซ็น
  carry it. This is what lets "รอเอกสารลูกค้า" be counted without inventing a fourth สถานะ.
  It is carried through the ประเภทงาน editor on a `data-actor` attribute alongside the
  existing `code`/`freq`/`note`, so editing a Phase name never silently drops it. The
  working screen shows it as a `รอฝั่งลูกค้า` chip on the row, so a Gate can never read as
  customer-blocked in one place and not another.
- **`Project.reviewer`** — the project's *default* ผู้สอบทาน. It is not a permission and it
  locks nothing: any role with `canReview` may still sign any Gate they did not do
  themselves, unchanged. It exists because "รอสอบทาน" is only actionable for a manager if it
  says on **whom**, and because the checklist itself keeps naming a reviewer for those Gates
  ("ส่งแบบทั้งหมดให้หัวหน้าทีมตรวจสอบ", "หัวหน้าทีม/CFO สอบทานร่างงานก่อนส่ง").

Two finished projects were also seeded. Without one, "ปิดแล้ว" is permanently zero and the
customer page has no history to show. "Finished" is still purely derived (last Phase, every
required Gate closed *and* signed) — there is no `closed` flag anywhere; the seed just
closes the last Phase's Gates.

### The customer page now carries what a manager opens it for

Order follows what the captain confirmed: **active projects first**, then what the office is
still waiting on *from this customer* (one row per outstanding `actor: ลูกค้า` Gate across
their live projects, each clicking straight through to that exact Gate — `openProjectDetail()`
now takes an optional phase/gate and opens that row expanded), then the closed งวด history
across months, then contacts, and last the reference fields as a plain key/value card —
those are looked up, not read, so they belong at the bottom rather than crowding the header.

Two customer fields were added, both because the checklist depends on them and neither is
derivable from anything already here: **`vatRegistered`** (the yearly job type's Gates 3.3
and 3.4 are literally conditioned on "(ถ้าจด VAT)" — whether a customer is registered
decides whether two Gates apply to them at all) and **`fiscalYearEnd`** (Phase 5 ปิดบัญชี and
the ภ.ง.ด.50 / DBD Gates hang off the customer's own year end, which is not always 31
ธันวาคม). Nothing else: no invented CRM fields, no revenue, no rating. Job types served are
derived from the customer's own projects rather than stored twice.

The customers list now reads "N โปรเจกต์ที่ยังไม่ปิด" instead of a raw total, dedupes the
job-type pills, and picks up a `รอเอกสาร N` pill from the same `actor` derivation.

## Round 10 — the executive view rebuilt, real teams, and gate deadlines

Round 10 is driven by `data/ksk-exec-view-scout/report.md` (firstmate home, not in this
repo), which decoded the client's own "KSK AI Monitoring v8.0" demo. Its §6 is the screen
built here; its §5.4 lists what round 9 already had right (all kept) and what it missed.

### The executive screen is now five named sections, in one order

`ภาพรวมสำนักงาน` opens on **ล่าช้า** as before, but the round-9 "one figure row, one list"
shape is replaced by the five questions the report ranks as worth keeping, each a section
whose own count is the button that opens its list in place:

1. **ล่าช้า** — งานที่เลยรอบทำงานปกติ. Unchanged derivation: no deadline field on a project,
   lateness measured in months of งวด.
2. **รอจากฝั่งลูกค้า**, split into **ขอแล้วลูกค้าไม่มีเอกสาร** (first, in red) and
   **ขอแล้ว รอลูกค้าส่ง**. The report calls this split the single highest-value gap in
   round 9, and it is: "we asked and they have nothing" is a decision (call the client, or
   close the งวด on what exists), "we asked and are waiting" is just a chase.
3. **รอสอบทาน — ค้างที่ใคร**, grouped by person **and** by which rung of the review ladder
   the Gate is stuck on (see teams, below).
4. **ใกล้ถึงกำหนดยื่น** — filings due across the whole office within 7 / 14 / 30 days, from
   the Gate templates' own due rules (see below). This is the one question in the client's
   whole document with a legal consequence behind it, and neither their demo nor round 9
   could answer it.
5. **งานกระจายตามผู้รับผิดชอบ** — open work per person, grouped by team, late portion in
   red. Distribution, never a ranking: no rate, no score, no ordering by performance.

Above them: **one period switch defaulting to now**, one team filter, and **exactly one
visual** — the closed / อยู่ในรอบปกติ / ล่าช้า meter, every band a button that opens its own
list. The period switch's default is not "this calendar month" but *every งวด still open*,
because that is the question a manager actually asks; the individual งวด are there for the
rarer "how did กรกฎาคม go".

Two reads moved off this screen, per the report:

- **Where work is bunched by phase** is now a strip on the **month board** — it is a planning
  question ("where do I move people next week"), not a today question. One row per Phase per
  job type, counting open projects, late portion in red; job types with fewer than 5 live
  projects that month are counted on one line instead of getting their own 5-row strip.
- **The 12-period completeness strip** is on the **customer page** — "is this customer
  chronically behind" is asked while looking at that customer, not office-wide. One cell per
  งวด of the year: closed / open / late / no งวด, each cell opening that งวด.

Project cards on the executive screen are **compact**: the miniature gate checklist is
dropped there, because that screen answers "which jobs need a decision" and the checklist
belongs to the project working screen, one click away on every row.

**Not built, and deliberately so** (all named in the report's §3 "drop" list): the AI
findings / AI Score / confidence-percentage layer, per-staff performance rankings, revenue
totals, activity timelines, a separate yearly dashboard, and a single progress percentage per
project. That is roughly 60% of the surface area of the client's own document; dropping it is
the point of the exercise, not an omission.

### Gate deadlines as rules, not dates (captain decision)

Every Gate in a job-type template may carry a `due` **rule**, in one of exactly two forms:

- `{ dayOfMonth: 7, monthOffset: 1 }` — "วันที่ 7 ของเดือนถัดจากงวด"
- `{ offsetDays: 10 }` — "ภายใน 10 วันนับจากวันเปิดงวด"

The concrete date is **derived per project from its own งวด** (`gateDueDate()`), never
stored: a งวด is opened on the first day of the month after it closes, which is the same
anchor the lateness rule already uses. The rule is printed next to every date it produces —
on the Gate row and in the executive list — so nobody has to trust a calendar date they
cannot check. Both forms are editable in the ประเภทงาน editor, on a second line of the same
gate row, beside the Gate's name and บังคับ flag.

The `dayOfMonth` rules seeded here are not invented: they are the sheet's own หมายเหตุ text
("กำหนดยื่นวันที่ 7 (e-Filing วันที่ 15)", "กำหนดยื่นวันที่ 15") finally made
machine-readable. The `offsetDays` rules are office practice for the document chase, stated
as a rule precisely so they can be argued with and edited.

### Real teams replace the flat role list (captain decision)

The office is three teams, each with a หัวหน้า and (except the consult/project team) a
รองหัวหน้า, พนักงาน and นศ.ฝึกงาน, plus **ไหม (COO + CPA)** as final reviewer. Teams and
people are the client's own, taken from their demo file.

The old flat `ROLES` catalog is **gone rather than kept alongside** this — a person's
position in a team is now the only thing that decides what they may do, so there is one
model, not two. The three capabilities earlier rounds established (`canReview`,
`canSeeOffice`, `canEditPermissions`) survive unchanged; they just hang off the position.

- **The review ladder** is ผู้ทำ → รองหัวหน้าทีม → หัวหน้าทีม → COO, with the COO rung
  conditional exactly as the office's own chart says ("เฉพาะประเด็นสำคัญ"). A Gate template
  may name the rung it must reach (`review: "lead" | "coo"`), set only where the sheet's own
  wording names the reviewer or where the work is a CPA matter (งบการเงิน, ภ.ง.ด.50).
- **`Project.reviewer` is gone.** Who a Gate lands on is derived every time from the
  assignee's team and the Gate's rung (`reviewerFor()`), climbing past anyone who did the
  work themselves — so it can never disagree with the real ladder or go stale when work
  moves. Team 3 has no deputy, so its work lands on its หัวหน้า directly.
- **Consequences carried through:** the executive view groups and filters by team; work
  waiting on a reviewer shows the rung; งานของฉัน shows a reviewer only the Gates that land
  on *their* rung of *their* team, not every unsigned Gate in the office; and the Gate row
  itself says "รอ ตันหยง (รองหัวหน้าทีม)" rather than just "รอผู้สอบทาน".
- **พนักงาน can no longer sign ผู้สอบทาน.** That is not tightening for its own sake — the
  office's own ladder does not include them. There is also no separate "ผู้ดูแลระบบ" person
  any more: the COO+CPA owns the ประเภทงาน templates, because that is the office's process,
  not an IT function.
- The demo logins are now the office's real people, one per rung (นัท / หยกหลิน / ตันหยง /
  ปุ๊ก / เมย์ / ไหม) instead of a parallel cast of invented users. A team lead lands on their
  own team's filter; the COO lands on the whole office.

### The document-chase ladder

> **Reversed in round 20 — see that section.** The captain's call after seeing this panel
> sitting next to Phase 1 on the project screen: it is a second place to work, and its first
> two rungs are Phase 1's own Gates written again. `Project.docState` is gone. What only it
> could say — asked-and-waiting vs asked-and-nothing-exists — survives, recorded on the Gate.
> The rest of this section describes what round 10 built.

The office's Airtable already tracks a six-step state per client-month, and the client's own
demo loads it and then renders it nowhere. It is modelled here as `Project.docState`, one
value per project-งวด, set on the working screen where the chase actually happens:

`1.แจ้งลูกค้าส่งเอกสาร → 2.ได้รับเอกสารแล้ว → 3.ขอแล้วลูกค้าไม่มีเอกสาร → 4.ไม่มีขอเอกสาร →
5.ลูกค้ารับทราบแล้ว → 6.ยืนยันจำนวนเอกสารกับลูกค้า`

It is the office's own field, not a new status: the per-Gate สถานะ columns are untouched, and
the customer page's per-Gate "รอจากฝั่งลูกค้า" list (from `Gate.actor`) is unchanged. What the
ladder adds is the one distinction `actor` cannot make — asked-and-waiting vs
asked-and-nothing-exists.

### Scale — 113 customers

The real office carries 113, and a screen comfortable with six can be useless with a hundred.
The six hand-written customers are joined by 107 generated ones (synthetic Khon Kaen company
names — never the client's real customer names), with the office's own job-type mix, spread
across the three teams: **113 customers, ~210 projects, 22 late, 71 closed, 132 filings due
within 14 days**. Nothing is random — every value is a function of the customer's index, so
the mock renders the same numbers on every refresh and the totals can actually be discussed.

Long lists are handled the cheap way rather than with a pagination framework: every list
shows a sensible first slice and a **"ดูทั้งหมด N"** button (one shared expansion register
across all screens), and the customers page gains a search box over name / รหัส /
ผู้รับผิดชอบ. Nothing is ever silently truncated — the full count is always on the button.

## Round 11 — automation workflows attach to a Phase, and never sign for a person

The office is separately building an automated keying pipeline (the KSK Keying app), and its
work overlaps **Phase 2 บันทึกบัญชี**. This round models how the two systems meet, on the
one rule the platform design already settled
(`data/ksk-console-platform-design/report.md` §4.2):

> the entire keying pipeline is one piece of evidence for one requirement inside one Phase
> Gate: Phase 2, บันทึกบัญชี

and the same document's open decision #4 — **no auto-pass.** Automation may report its own
result; it may never sign a checklist item that carries a human reviewer.

### A workflow is a configurable thing, attached to a Phase

`WORKFLOWS` is a **catalogue** — one entry, `ksk-keying` (รอบคีย์เอกสาร), because that is the
only automation the office actually has (see Round 12 below). It carries a name, a one-line
description of what it does, its own ordered steps, and its own **actor name**. An admin
*picks* from it on the ประเภทงาน screen; nothing is typed as free text, so a Phase can only
ever point at a workflow that exists.

- Attachment is **template-level**, alongside the Phase's Gates: `phase.workflows` is a
  **list**, so more than one workflow per Phase is a first-class case even though the seed
  attaches one thing in one place — `monthly` Phase 2 → `ksk-keying`.
- Each attachment also carries `evidence` — the Gate รหัส this workflow's result genuinely
  speaks for. Edited in the ประเภทงาน editor as toggle chips over that Phase's own Gates
  (reusing the `.doc-step` chip, which round 20 kept when it deleted the ladder itself), not as
  a free-text field.
- Kept in `PHASE_WORKFLOWS` beside `GATE_RULES` and merged onto the Phase objects at load —
  the same pattern round 10 used, so the verbatim workbook block above stays verbatim.

### On a project: a Run button, with the scope locked

A Phase with a workflow attached shows it on the working screen with **เริ่มรัน**. The run is
always scoped to that project's customer and งวด — and both are already decided by the
project, so they are shown as **locked context**, never asked for. Pressing it walks the run
through queued → running (one named step at a time) → เสร็จ / ไม่สำเร็จ over a few seconds,
entirely in the page.

A failed outcome is reachable and not arbitrary: a run stops at the second stage when the
project's own **document-chase ladder** says the งวด's documents are not in
(anything other than 2/5/6). Change the ladder on the same screen and run again.
*(Round 20: same behaviour, different source — `wfDocsReady()` now reads the Phase 1 Gates.
Tick them, or reverse a `ลูกค้าไม่มีเอกสารให้`, and run again.)* Two runs are
seeded so both terminal states are on screen without waiting — a finished one on
`ex3-monthly-may`, a failed one on `ex2-monthly-jun` (`3.ขอแล้วลูกค้าไม่มีเอกสาร`).

The automation appears **as its own named actor** — "ระบบคีย์เอกสาร KSK (อัตโนมัติ)" — wherever
a person's name would otherwise sit. It is never an option in the ผู้ทำ / ผู้สอบทาน dropdowns;
those are people, and stay people.

### The workflow is a second track, and it never blocks the checklist

This was the captain's explicit instruction, and it is why the workflow is drawn as a
**dashed, quieter card above the checklist** rather than as another `.phase-panel`:

- Dashed = "not part of the signed chain". The block stays in stone neutrals even while
  running — a run in progress must not turn the working screen into a status dashboard — and
  the only colour it may take is the red already used for "a person is needed", on a failed
  run. The Run button is `.btn-ghost`, deliberately *not* the blue that belongs to
  ผ่านเฟสนี้.
- The gates never wait for it. The card says so in as many words
  ("เช็กลิสต์ด้านล่างทำมือได้ตลอด ไม่ต้องรอรอบนี้"), `phaseCanAdvance()` is untouched, and a
  run stays live on a Phase whose Gates are **read-only** — ticks locked, run button running.
  That contrast is the clearest statement of two tracks there is.
- Where the result *is* evidence for a Gate, the link is shown both ways: the Gate row
  carries a neutral chip (มีเวิร์กโฟลว์รองรับ / มีผลจากระบบอัตโนมัติ), and the expanded row
  names the workflow, the run, and — every time — that the tick and the signature are still
  the person's to give.
- Only a finished or failed run redraws the screen. A mid-flight run repaints its own card
  only, so a หมายเหตุ somebody is halfway through typing survives the run.

### Deliberate divergence from the office's spreadsheet

`Checklist_5Gates_งานบัญชี-1.xlsx` was written before the automation existed, so its Phase 2
rows read as manual keying ("บันทึกรายการขาย / รายได้"). With the keying pipeline attached to
that Phase, that is no longer what the office does, so **the wording was changed to say what
is actually true**: Gates 2.1–2.4 of `monthly` now read
"ตรวจ… ที่ระบบคีย์มา — แก้จุดที่ไม่ถูกก่อนยืนยัน". 2.5 (ตรวจงบทดลองเบื้องต้น) was already
verification and is untouched, and every other Gate — including `yearly`'s Phase 2, which has
no workflow attached — stays verbatim from the sheet. This is the one place in the mock where
the office's own text was rewritten rather than copied, and it is rewritten in exactly the one
Phase that has automation behind it: a claim about the office's process that the office should
confirm or overrule.

## Round 12 — seed only the automation that actually exists

Round 11 seeded two extra plausible workflows (a VAT reconciliation and a document-completeness
check) to make the catalogue visibly plural. The captain's correction: when this mock is walked
through with the client, a viewer cannot tell an illustration from a thing that exists, and the
office has exactly **one** automation today — the KSK Keying pipeline.

So the seed now tells the truth, and only the seed changed:

- `WORKFLOWS` holds `ksk-keying` alone, attached to `monthly` Phase 2 บันทึกบัญชี and nowhere
  else. `yearly` Phase 2 and `monthly` 3.3 went back to the workbook's verbatim wording, since
  nothing automated stands behind them any more.
- **The capability is untouched.** `WORKFLOWS` is still a catalogue an admin picks from,
  `phase.workflows` is still a list, and the ประเภทงาน editor still attaches to any Phase of any
  job type and still takes more than one per Phase.
- Because almost every Phase now has none, the editor's no-workflow state had to get quieter:
  there is no empty box and no placeholder — just one small ghost button
  ("แนบเวิร์กโฟลว์อัตโนมัติ") that unfolds the picker when somebody wants it, and folds it back
  after attaching. The heading only appears once there is something for it to head. On the
  working screen a Phase without a workflow renders nothing at all, exactly as before.

## Round 13 — a finished run is something you go in and read, then re-run

Round 11 stopped at "เสร็จแล้ว". The captain's point: the demo has to flow — run it, watch it
finish, click in, read what it actually produced, re-run if needed, and come back out to the
checklist with the result sitting there as evidence. So a finished run now leads somewhere.

### It reuses the pipeline's own review surfaces, not a new design

The keying pipeline in this repo already writes its review UI, and this round copies its shape
rather than inventing one. Look at
`.claude/skills/ksk-keying/scripts/review-index-template.ts` (the hub) and `review-template.ts`
(the per-bucket page) — what is reused, deliberately:

- **The same buckets, with the office's own Thai names** — ค่าใช้จ่าย มีภาษี / ไม่มีภาษี /
  คละภาษี, รายได้ มีภาษี / ไม่มีภาษี, รายการเดินบัญชี — straight from `paths.ts`'s
  `CATEGORY_TH` / `VAT_TH`, path shown as `ตรวจทาน/ค่าใช้จ่าย/มีภาษี` exactly as the deliverable
  tree lays it out.
- **The hub's coverage figures**: หน้า/รายการทั้งหมดในคลัง · จัดกลุ่มแล้ว · ถูกตัดออก — รอตัดสินใจ,
  and the same per-bucket counts (กลุ่มเอกสาร / หน้าเอกสาร).
- **The group's own รายการ**, with the review page's columns — ผังบัญชี (รหัส + ชื่อบัญชี),
  รายละเอียด, ยอด — plus the เหตุผลการจัดหมวด and ความมั่นใจ the categorize agent wrote for
  choosing that account, and the group-level `review_flags` above them.
- **The same statuses**, ตรวจแล้ว / ต้องตรวจสอบ, with the same meaning: `needs_attention` is
  what the pipeline sets when a line is low-confidence or a flag is unresolved.
- **The excluded list, framed the pipeline's way** — "ข้อเสนอเท่านั้น ยังไม่ใช่ข้อสรุป ควรเข้าไป
  เช็คว่าตัดถูกจริงไหม", grouped by reason.

*(Round 13 built this as a summary page and left the preview out entirely. Round 14 replaced
that screen with the real layout — see below.)*

### Ran, reviewed, re-ran

`WF_RUNS[key]` is now a **run history**, not one run. A re-run appends; nothing is overwritten,
because a run somebody has already read is a record. This shows up in three places: the track
card carries a one-line history, the review screen has a ประวัติการรัน card where any finished
run can be re-opened, and each run generates its **own** result set (seeded from the project id
*and* the run number), so re-running visibly produces new numbers rather than the same ones
twice. Re-run is reachable from the run itself and from the review screen; both are scoped to
the project's customer and งวด, still locked, still never asked for.

### No dead ends, and still no auto-pass

- Finished run → **เปิดผลการรันเพื่อตรวจ** (the one blue button the track ever shows, and only
  while there is a finished result to open).
- A Gate's expanded row names the run behind it and offers the same way in.
- The review screen ends on a card that names the Gates this result is evidence for and puts a
  button back to them — plus the standing sentence, in the place a person is most likely to
  forget it: ระบบรายงานผลของตัวเองได้ แต่เซ็นเกทแทนคนไม่ได้.
- A re-run fired *from* the review screen lands the reviewer on the new run's result; a failed
  one leaves the previous result intact and says so.
- Opening a run that has gone (or never finished) says that, rather than rendering an empty page.

## Round 14 — the review screen is the real one: document on the left, form on the right

Round 13's screen was a summary: coverage figures, bucket cards, expandable groups. The captain's
correction is exact — **reviewing is not reading statistics.** It is looking at the document while
you correct the fields that were read off it. So that screen is gone and this one is the same
layout as the pipeline's own `ตรวจทาน.html`
(`.claude/skills/ksk-keying/scripts/review-template.ts`).

### What was taken from the real page

The class names are kept identical to that file's, so the two can be read side by side:

- **`.pane` = evidence | `.pane-gutter` | form.** A sticky `.evidence` column on the left holding
  the document and, under it, `.file-selector` → `.groups` → one `.group` card per item in the
  run (title, ยอด, status, bucket) — the same horizontal strip the real page uses to move between
  items one at a time. The active card scrolls itself into view.
- **The form's own field order**, verbatim from `PRIMARY_LEFT_FIELDS` / `PRIMARY_RIGHT_FIELDS` /
  `SUMMARY_FIELDS` / `EXTRA_FIELDS`: วันที่ · ผู้ขาย · ผู้ซื้อ · การจัดการ VAT on the left,
  เลขที่เอกสาร · เลขประจำตัวผู้เสียภาษีผู้ขาย/ผู้ซื้อ on the right, then **รายการ** as
  `.line-card` rows of ผังบัญชี / รายละเอียด / ยอด with the categorize agent's own
  เหตุผลการจัดหมวด and ความมั่นใจ under each, then ยอดก่อนภาษี / ยอดรวม, a **ฟิลด์อื่นๆ**
  disclosure, and **บัญชี / ตัวควบคุมผู้ตรวจ** with สถานะ (ตรวจแล้ว / ต้องตรวจสอบ) and
  บันทึกผู้ตรวจ.
- **`ไม่ใช้ข้อมูลกลุ่มนี้` and `บันทึกและถัดไป`** as the form actions, advancing through the run.
  *(Round 19 moved both out of the form and into the flow's shared sticky action bar — same two
  actions, same wording, no longer below the fold. See the Round 19 section.)*
- **The statement variant** for the `bank_statement` bucket, because the real page has one too: a
  chronological `.stm-table` (# · วันที่ · รายการ/คู่โอน · เงินเข้า · เงินออก · ผังบัญชี) with the
  account's own read-only header fields, not an invoice form.
- **The excluded pages** *(reworked again in round 15 — see below)*.
- **`.group-flags`** above the fields, and the ตรวจแล้ว / ต้องตรวจสอบ statuses, unchanged in
  meaning.

Editing works: change an amount and the ยอดก่อนภาษี / VAT / ยอดรวม recompute; change an account
and the line's name follows; add or delete lines; set the status; write a reviewer's note.
Everything is in-memory and belongs **to the run**, which is why a re-run produces a fresh result
set rather than inheriting corrections.

### What is different, and why

- **The document is a stand-in, and the pane says so at the top.** The real page renders the
  client's own PDF/image/xlsx out of the month folder; there is no such file in a mock. Rather
  than an empty box, the left pane draws the document it stands for — an invoice with header,
  เลขที่เอกสาร, line table and totals, or a bank statement with a running balance — with zoom,
  page anchor and the source filename, so the pane *behaves* like the thing it replaces. The
  banner keeps it honest.
- **The palette is the platform's stone, not the real page's slate/blue.** A screen inside this
  shell has to be the same product as the screen around it; the semantic roles are unchanged
  (needs_attention amber, active blue ring, everything else neutral).
- **No XLSX export button.** Building the PEAK file belongs to the pipeline's own page, which owns
  the export mapping and the file-system dialog. Nothing here writes a file.
- **The run summary became a header**, as the captain asked: counts, the run's identity and actor,
  ประวัติการรัน, รันใหม่, and the "กลับไปติ๊กเกท" link in one strip, plus filter chips (per bucket,
  ต้องตรวจสอบเท่านั้น, เสนอตัดออก) over the item strip. The screen below it is for reviewing items.

Everything round 13 established still works: getting in from the finished run, the run history,
re-running from here (which lands you on the new run's result), and the way back to the Phase
checklist. And still no auto-pass — the reviewer's สถานะ and บันทึก live on the run, and the
form says so where it is easiest to forget: เกทในเฟสยังต้องมีคนติ๊กและผู้สอบทานเซ็นตามเดิม.

## Round 15 — the excluded pages come first, and they block the rest of the review

Round 14 folded the excluded pages in as just another filter on the item strip. That lost the
step the real app puts **first**, and the reason it is first: an agent-declared exclusion is a
*proposal*, and a page wrongly dropped is a page that never gets keyed and that nobody ever goes
looking for. This round restores it.

### What the pipeline actually does (and this now follows)

From `references/ledger-gates.md` and `SKILL.md` §the parent's final report:

> Agent-declared exclusions (a child's Page Disposition marking something excluded) are proposals
> only; the human review gate sees them all before any Exclusion Declaration is treated as final.

and a blocked gate is resolved **only** by new evidence or by a new Exclusion Declaration recorded
with `declared_by: human` — never by editing ledger output. So there are exactly two decisions a
person can make about a proposed exclusion, and the mock offers exactly those two:

- **ยืนยันตัดออก** — the human re-records it, and it becomes a real Exclusion Declaration.
- **เอากลับเข้ากระบวนการ** — the page is wanted back, which is *new evidence*, so it returns on the
  **next run**. The screen says that rather than pretending the page reappears in this one.

### The screen is the pipeline's own ที่ถูกตัดออก page

Rebuilt from `review-index-template.ts`'s `EXCLUDED_HTML`, keeping its class names —
`.evidence-head` / `.nav-btn` / `.list-card` / `.list-head` / `.list-lead` / `.item-group-label` /
`.item` / `.item-icon` / `.item-main` / `.item-toggle` / `.preview-split` / `.preview-half`:

- Evidence on the left with the page's file name and **why it was cut**, and ‹ › buttons (plus the
  arrow keys, as that page binds them) to walk the list one at a time. *(Round 19 moved the ‹ ›
  into the flow's shared action bar and gave step 2 the same pair.)*
- The list on the right, **grouped by reason** with a chip per reason, its own
  "N รายการที่ระบบเสนอตัดออก" heading and the `N รอตัดสินใจ` badge.
- **A duplicate claim is shown beside the page it duplicates** — the split preview, because
  `reason: "duplicate"` must carry `duplicate_of` precisely so a reviewer who has never opened the
  source knows *which* page to compare against (`references/schemas/segment-interpretation.md`;
  `validate-interpretation` rejects a duplicate claim without it). The mock's exclusion reasons are
  now the pipeline's own keys (`duplicate` / `blank_page` / `not_accounting_document` /
  `unreadable_scan`) with Thai labels, and each item carries a `"<file>#p<N>"` Page-Ledger unit id.

### The blocking, and exactly where it stops

The review flow is two steps — **1. ตรวจรายการที่ถูกตัดออก → 2. ตรวจเอกสารที่จัดกลุ่มแล้ว** — and
step 2 is genuinely shut while anything is undecided: the step button is disabled and carries a
lock, and `setRunStep("documents")` refuses with the remaining count. Deciding an item advances to
the next undecided one, so clearing twenty pages is one action each rather than a hunt. A re-run
resets the flow to step 1, because a new run means new proposals.

**This blocking lives inside the workflow's own review flow and goes no further.** The Phase's Gate
checklist is untouched: `phaseCanAdvance()` never consults a run, the workflow track stays a
parallel track, and a Gate can be ticked and signed with twenty exclusions still undecided —
verified. Those are two different things and the boundary is deliberate.

## Round 16 — where work comes from: packages → recurring periods → a real project

Every deadline rule in this mock was expressed against a งวด or against "the day the งวด was
opened", and until this round **nothing ever opened one**. Data was all pre-seeded and no
project could be created, so the first question a viewer asks — "how does next month's work
come into existence?" — had no screen behind it. This round is that missing beginning, and
it is one story in three parts: **what the customer bought decides what recurs, recurring is
what opens periods, and opening a period is what starts the checklist clock.**

### 1. A customer's packages — the source of truth for the rest

`CUSTOMERS[id].packages` is the services this customer has actually bought from the office.
One entry carries the **job type** it maps to (one of the five already seeded), how often it
recurs (`monthly` / `yearly` / `oneoff`), when it started, whether it has ended, the fee, and
any occurrences somebody deliberately skipped. It sits on the customer page directly under
the live work — above รอจากฝั่งลูกค้า, well above the reference fields — because it is not a
CRM detail you look up, it is the answer to "what work does this customer generate for us".
Adding, editing, pausing, ending and un-ending a package all work, and each of them visibly
changes what the schedule will open next.

The six hand-written demo customers are a deliberately varied mix, so the recurring behaviour
differs per customer instead of looking uniform:

| customer | packages | what it demonstrates |
|---|---|---|
| ศรีชัยศึกษาภัณฑ์ | รายเดือน + รายปี + ที่ปรึกษา | the full monthly package |
| ตัวอย่าง สอง | รายเดือน (ไม่จด VAT) + ที่ปรึกษาที่**สิ้นสุดแล้ว** | monthly-only, and an ended package |
| ตัวอย่าง สาม | รายเดือน + รายปี + งานทะเบียน**ครั้งเดียว** ที่ยังไม่ได้เปิด | a one-off waiting to be opened |
| ตัวอย่าง สี่ | รายเดือน + งานโปรเจคครั้งเดียว + งานทะเบียนครั้งเดียว | one-off work alongside recurring |
| ตัวอย่าง ห้า | รายเดือน**สิ้นสุด** → ที่ปรึกษาอย่างเดียวตั้งแต่งวดสิงหาคม | a customer who switched packages |
| ตัวอย่าง หก | รายเดือนที่สิ้นสุดแล้ว | dormant: it recurs nothing, and that is *why* |

All 107 generated customers get a package too, mapped to the job type they are already served
on — so the schedule below is exercised at the office's real volume, not on six rows. Two
exceptions are seeded rather than left to be discovered by pressing buttons: one occurrence is
**skipped** with a reason, and one recurrence is **paused**.

The customers list and the customer page's "ประเภทงานที่ให้บริการ" now read from active
packages instead of from whichever projects happen to exist — a customer whose package ended
stops showing that pill even while the last งวด is still being finished. Both fall back to
projects for a customer with no packages, so nothing goes blank.

### 2. Auto-recurring — packages open periods by themselves

`scheduleSnapshot()` **derives** the periods that ought to exist and do not, from the active
packages, every time the month board renders. Nothing on that screen is hand-listed. It is
simulated and says so: there is no scheduler and no timer, and what the mock offers instead is
the same action a scheduler firing on the date would have taken.

- **Where**: a `รอบที่ถึงกำหนดเปิด` section at the top of the month board, above the month
  switcher, and deliberately *not* governed by it (the caption says so). What is about to come
  into existence is not a question about one month's work.
- **When a งวด opens**: the first day of the month after it closes — the same anchor
  `projectOpenedAt()` and the lateness rule have used since round 10, because a month's
  documents can only exist once the month has ended. A **one-off is not a งวด**: it starts when
  the office agreed to do it, and it reads as a single piece of work — one `งานครั้งเดียว` chip,
  one เปิดตอนนี้ button, and no ข้ามรอบ/พัก options, because there is no cycle to skip.
- **Opening is the default**: every row's first action is `เปิดตอนนี้`, and overdue rows carry a
  bulk `เปิดทุกรอบที่เลยกำหนด (N)`.
- **A skip is visibly a skip**: `ข้ามรอบนี้` opens an inline reason field, refuses to record
  without one, and the skipped occurrence then appears in its own `ข้ามรอบนี้ไว้` list with the
  reason, who skipped it and when — plus `ยกเลิกการข้าม`. A งวด that never happened is a
  decision on the screen, never a silent absence.
- **พักการเกิดซ้ำ** stops a package producing anything until it is resumed from its card on the
  customer page; the count of paused recurrences is stated on the board so it cannot hide.
- **The window** is ±30 days around today: anything further back is not "due to open", it is a
  งวด nobody is working, which is what the overview's ล่าช้า section is for. On load that gives
  **3 เลยกำหนด · 67 กำลังจะถึงกำหนด · 1 ข้ามไว้ · 1 พักไว้** — real numbers, derived, the same on
  every refresh.

Yearly packages recur off the **customer's own fiscal year end** (`fiscalYearEnd`, added in
round 9 for exactly this kind of reason), not off a fixed December. None of the demo
customers' yearly งวด falls inside the ±30-day window, so they show their next scheduled
opening on the package card (`ปีบัญชีสิ้นสุดธันวาคม 2569 — กำหนดเปิด 1/1/2570`) rather than in
the board's list. That is the honest outcome of the rule, not an omission.

### 3. Opening by hand — the same action, triggered by a person

`เปิดงวดด้วยตนเอง` on the same section: pick customer, job type and งวด. There is exactly one
creation path — **`openPeriod()`** — and both the schedule and the form call it, so a manual
open cannot behave differently from a recurring one. It also states the case the office will
actually hit: if the customer holds no package for that job type, the form says the period will
be opened as งานนอกแพ็กเกจ rather than silently inventing a recurrence. Backdating is just
picking an earlier งวด; re-opening a งวด that already exists is refused with a toast naming it.

### What opening actually produces

This is the payoff, and it is why every deadline rule in the mock existed in the first place:

- a project with `phaseIndex: 0`, **every Phase and Gate instantiated from the job type's own
  template** by the same `ensureWork()` every other project uses,
- nothing ticked, no ผู้ทำ/ผู้สอบทาน, no document-chase state recorded,
- and **gate deadlines computed off the real opening date** by the existing rule engine. Open
  งวดกรกฎาคม today and gate 1.1's `{ offsetDays: 3 }` rule reads `กำหนด 8/8/2569 (ภายใน 3 วัน
  นับจากวันเปิดงวด)` — three days from 5/8/2569, not from the derived first-of-month.

`projectOpenedAt()` now returns the project's **recorded** `openedOn` when it has one, falling
back to the derived date for the pre-seeded demo projects that were never opened through the
schedule. The `dayOfMonth` rules deliberately do *not* move with it: a filing deadline is fixed
by the งวด, not by when the office got round to opening it. The working screen states the
opening date and how it was opened, because a date nobody can see is a date nobody can check.

### Follow-through: the rest of the app tells the truth about a new period

Checked on a freshly opened period, and fixed where it only made sense for the half-finished
demo seed:

*(Round 20 replaced `docState` with derivations off the Gates; the three-way split described
here is unchanged, only its source is. See the Round 20 section.)*

- **A new one:** `docState` is `null`, and `docStateLabel()` already read that as
  `ยังไม่ได้บันทึก`. But the office overview's รอจากฝั่งลูกค้า section split projects into
  "asked and waiting" vs "asked and nothing exists" only — an unrecorded project matched
  neither and vanished from the one screen it most needs to appear on. It now has a third
  sub-list, **ยังไม่ได้บันทึกสถานะเอกสาร**, which is genuinely a different thing: nobody has
  asked yet.
- Verified unchanged and sensible without edits: งานของฉัน picks the new project up under
  งานในมือ (0/7 required gates, first three pending Gates listed); the month board shows it in
  its own งวด; the customer page counts it as active work and its cell turns "open" on the
  12-period strip; `projectFinished` / `projectLate` / `isAwaitingReview` are all false, so it
  is not miscounted as late or blocked anywhere; and a keying run fired on it fails at the
  document stage, because `wfDocsReady()` correctly reads an unrecorded ladder as "documents
  are not in".

### Decisions worth flagging

- **`endedAt` means the last งวด the package covers**, not the day somebody pressed the button.
  `สิ้นสุดแพ็กเกจ` defaults it to the most recent งวด actually opened under that package, so
  ending one never orphans work in progress and never leaves one more งวด quietly due. It is
  also undoable (`กลับมาใช้งาน`), because "we ended it by mistake" happens in an office.
- **The bulk open button is ghost, not blue.** It opens several projects at once, and the
  loudest button on a screen should not be the one with the widest blast radius; blue on that
  screen belongs to the single explicit `เปิดงวดนี้` submit.
- **`periodLabelFor()` is unchanged** for the seeded convention, and yearly occurrences get
  their own label (`ปีบัญชีสิ้นสุด<เดือน>`) through `occurrenceLabel()`, since a yearly งวด is
  keyed by a fiscal year end and not by the monthly "งวดเดือน…" shape. A registry job now reads
  `งานทะเบียน — เริ่ม <เดือน>` instead of falling through to "งวดเดือน…", which it never was.
- **Not built, per the brief**: adding customers from scratch, staff/team management, and
  notifications. *(All three are round 17 — see below.)*

## Round 17 — the three places the tour used to say "imagine this part"

This round exists for one reason: the whole product is about to be walked through on a
demo-tour video, and three things were still missing that would each have forced the tour to
stop and describe something rather than click it. Nothing here is a new idea — it is the
three remaining ends of threads earlier rounds already laid down.

### 1. Taking on a new customer, and a continuous path from there to work

`รับลูกค้าใหม่` on the ลูกค้า screen. The form asks **only what an office genuinely has at the
moment somebody signs**: รหัสลูกค้า (prefilled with the office's own next running number),
ชื่อที่ใช้เรียก, ชื่อจดทะเบียน, ลักษณะธุรกิจ, and one contact with a phone. Six fields, and two
of those are the same name twice.

Everything else in the customer schema — เลขผู้เสียภาษี, จด VAT, รอบปีบัญชี, LINE กลุ่ม,
สถานะ, หมายเหตุ — is deliberately *not* asked for, because the office usually does not have it
on day one. The consequence is that **the ข้อมูลลูกค้า card became editable**, which it had
said it was not since round 9 ("มอค — แก้ไขไม่ได้ในรอบนี้"): "the rest can be filled in later
on the customer screen" is only true if that screen can actually take it. Two of those fields
are not cosmetic and the form says so — จด VAT decides whether two Gates of the yearly
checklist apply at all, and รอบปีบัญชีสิ้นสุด decides which month a yearly package's งวด falls
in.

The path from there is made continuous rather than described:

- Saving lands on the new customer's page **with the package form already open** — attaching
  what they bought is the next thing that has to happen, not one more button away.
- The package form's default start งวด is now **the month before now**, not the calendar
  month. A customer signing today starts with the งวด the office is currently working; a งวด
  is worked in the month after it closes, so defaulting to สิงหาคม would quietly skip their
  first period.
- Because that first occurrence is therefore already due, the package card itself grows a
  `เปิด<งวด>` button. It calls **the same `openPeriod()`** the month board's schedule and the
  manual form call — round 16's "there is exactly one creation path" is unchanged; this is a
  third door onto it, on the screen where a person has just decided the package exists.
- A customer taken on during the session sorts to the top of the 113-row list with a
  `รับเข้ามาใหม่` chip, so coming back to ลูกค้า does not lose them below the fold.

Walked end to end: รับลูกค้าใหม่ → แพ็กเกจ → `เปิดงวดเดือนกรกฎาคม 2569` → a phase-0 project
with all 37 Gates instantiated from the template, landing on whoever carries the least open
work, who is told about it.

### 2. พนักงานและทีม — and the consequences are the real ones

A screen for whoever already holds the admin capability (`canEditPermissions` — the COO+CPA),
behind `PAGE_GUARD` exactly as ประเภทงาน and ภาพรวมสำนักงาน are, not a fourth permission model.

One card per team, its own review ladder printed at the top, people grouped under their rung.
Adding a person, changing their rung and moving them between teams all work — and none of it
is cosmetic, because nothing in this mock ever stored who reviews whom:

- **`reviewerFor()` derives the reviewer from the assignee's team every time**, so moving
  somebody moves the queue their Gates land in. Verified on the real seed: moving ตันหยง from
  ทีมบัญชี 1 to ทีมบัญชี 2 changes her งานของฉัน queue from `นัท / ริบบิ้น / หยกหลิน / ปุ๊ก`
  work to `เอิร์น / นัทตี้ / แพรว / บิ๋ม / เมย์` work, and ทีมบัญชี 1's unsigned Gates climb
  to ปุ๊ก because that team no longer has a รองหัวหน้า.
- **Capabilities hang off the rung**, so changing it changes what the person can do — and
  since a capability is no longer decided once at sign-in, `applyUserCapabilities()` was split
  out of `login()` and the nav updates immediately rather than at their next login.
- **ภาพรวมสำนักงาน follows for free**, because it groups by `membersOf()`.
- **The COO is derived from the roster** (`cooName()`) instead of the `COO_NAME` constant, so
  the top rung of all three ladders is genuinely editable too.

**Where a change would move work, the screen says so before it is saved.** The
`ถ้าบันทึก:` panel is not a second, hand-written description of the rule: it runs the *real*
`reviewerIn()` over a shadow copy of the structure (`structureSnapshot()` →
`applyPlacementTo()`) and diffs the office's whole unsigned-Gate queue, so it can never
disagree with what actually happens. It states the displaced rung-holder, how many Gates move
off this person and onto them, how many projects follow them into the new team, and every
capability they gain or lose — including "คุณกำลังปลดสิทธิ์ผู้ดูแลของตัวเอง" when the COO is
about to hand the seat over.

Three rules the screen enforces rather than reports:

- **A single-holder rung displaces its holder** down to พนักงานบัญชี on the same team — one
  uniform rule for หัวหน้าทีม, รองหัวหน้าทีม and COO, stated before you save.
- **Somebody holding open work cannot be removed.** The refusal names the count, and the
  `โอนงานที่ยังไม่ปิดทั้งหมดไปให้` control sits on the same panel, so it is one action from
  being resolved. Historical ผู้ทำ/ผู้สอบทาน signatures keep the name after removal — that is
  a record of who did what, not a live reference.
- **The COO cannot be removed at all** while they are the only one: the office must always
  have a final reviewer. Promote somebody else first.

Unsigned Gates left behind by a removal are not stranded — the ladder already climbs past
anybody who is not there — and the toast says where they went.

A name is a person's identity here (projects reference an assignee by name), so it is set
once when they join and is not editable afterwards.

### 3. Notifications — the hand-off made visible, and nothing more

A nav destination with a quiet count, not a bell over a panel. A row is the `.contact-row` the
customer page already uses.

*(Round 17 made both the unread badge and the unread dot stone, on the argument that red in
this app means "somebody is blocked" and has to keep meaning only that. The captain overruled
that for the badge in round 18 — see below. The unread dot on the rows themselves is still
stone.)*

**Per person, which is the whole point.** A notification is addressed to one name and the
screen only shows the signed-in user's own; switching demo users gives genuinely different
lists, without which the hand-off cannot be demonstrated at all. On load the six demo accounts
sit at `นัท 2 · หยกหลิน 9 · ตันหยง 8 · ปุ๊ก 2 · เมย์ 1 · ไหม 4`.

**No new domain events.** Every kind is something the mock already did:

| kind | emitted from | goes to |
|---|---|---|
| `review` | a Gate reaching สถานะ เสร็จ with ผู้สอบทาน still blank | the rung it lands on |
| `sentback` | a finished Gate re-opened by somebody who did not do it | the ผู้ทำ |
| `period` | `openPeriod()` — the one creation path | the assignee |
| `run` | a keying run reaching เสร็จ / ไม่สำเร็จ | the assignee, and whoever fired it |
| `doc` | the six-step document-chase ladder moving | the assignee |

The seeded state is derived, not written: one per Gate already sitting unsigned in the seed,
one per project whose chase already reached `3.ขอแล้วลูกค้าไม่มีเอกสาร` (the one rung of that
ladder that is a decision rather than a chase), and one per seeded run — 38 in total.

Clicking a row marks it read and **goes to the thing it is about**: a review notification
opens that project on that exact Gate, expanded (`openProjectDetail(id, pi, gi)`, which round 9
already built); a run notification opens that run's review screen; the rest open the project.
Nothing is a dead end.

### The login screen now reaches everybody

The six curated accounts stay the headline — they are one per rung and each says what it is
there to show — but every person in the office is now reachable under a
`พนักงานคนอื่นในสำนักงาน (N คน)` disclosure, and somebody added on the พนักงานและทีม screen
appears there without the disclosure having to be opened. This stopped being optional this
round: work can be handed to anybody, a newly opened งวด lands on whoever is carrying the
least, and "add a person" with no way to log in as them is a change with no other side to see.

### The walk, checked

New customer → package → งวด opens → assignee notified → they record the documents and tick
Gates → the Gates land on their รองหัวหน้าทีม → who is notified, clicks through to the exact
Gate and signs it → the keying run fires on that Phase, finishes, notifies both the assignee
and whoever started it → its result opens in the review screen and comes back to the checklist
→ ภาพรวมสำนักงาน shows the project under the right team. Every step clickable, no console
errors on any screen for any of the six demo users, and no screen that only makes sense for
pre-seeded data.

## Round 18 — creating something sits on its own layer

Two of round 17's surfaces were `.inline-form` blocks that unfolded into the page they lived
on: `รับลูกค้าใหม่` pushed 113 customer rows down to make room, and add/edit-a-person pushed
the team cards apart. Both read as the page rearranging itself rather than as an act on top
of the screen you were looking at — and in the person case that was actively costly, because
the whole point of the `ถ้าบันทึก:` panel is to be read *against* the structure it is about
to change, which was the thing being shoved off screen.

Both are now dialogs. **Only those two.** The ประเภทงาน editor's side-by-side add/edit panel
is round 8's deliberate answer to exactly this problem for a 37-Gate form and is untouched,
as are the customer page's package / ข้อมูลลูกค้า editors and the month board's manual-open
form — an inline form that does not displace much is not a bug.

### One component, two callers

`openModal(spec)` / `closeModal()` / `renderModal()` near `showToast()`, plus one
`#modal-root` div outside every page. A caller hands over a spec, not markup:

```js
openModal({ title, sub, render: function () { return { body, actions }; }, onClose })
```

`render()` is called again on every field change, which is what the person dialog needs: its
`ถ้าบันทึก:` panel runs the **real** `reviewerIn()` over a shadow structure (round 17's
`structureSnapshot()` → `applyPlacementTo()`), so it has to recompute when ทีม or ตำแหน่ง
changes. Only the dialog repaints — the screen behind it does not, because nothing has been
saved yet. `renderModal()` remembers which input had focus (and the caret position) and puts
the person back into it, so a re-render triggered by one field never ejects you from another.

Behaviour, all of it in the component rather than per caller:

- **The screen behind stays visible and stays put.** `body.modal-open { overflow: hidden }`,
  and `#modal-root` sits outside every page so re-rendering the screen underneath a dialog
  cannot wipe the dialog.
- **Escape, the × and ยกเลิก all close it**, and closing writes nothing — every caller does
  its mutation in its own submit handler before asking for the close. A backdrop click
  closes too, but only a click that both started and ended on the backdrop.
- **Focus starts on the first field** (not the × that happens to come first in the markup)
  and Tab wraps inside the dialog rather than walking into the page behind. While a dialog is
  open the keyboard belongs to it: the run-review screen's ‹ › arrow-key binding stays quiet.
- **Saving closes the dialog and the screen behind updates in place** — the new customer is
  in the list, the moved person is under their new rung.
- **The dialog's own body is the only thing that ever scrolls** (`max-height: min(86vh,660px)`),
  and the title and actions stay put. Neither form needed trimming to fit: the customer form
  is round 17's six fields unchanged, and the person dialog's tallest state (fields +
  capability line + a five-line impact panel + the transfer control) clears a 768px-tall
  laptop with room over.

### It looks like it was always there

The overlay is the mobile sidebar drawer's own `rgba(28,25,23,·)` at a lighter alpha, so the
screen behind stays legible; the surface is the same white / `#ece9e4` / `10px` /
`0 1px 3px`-family card as every other card in the app, at a slightly deeper shadow because
it is the one thing genuinely floating. The only motion is a 0.12s opacity fade. **No new
colour**: the primary action is still `.btn-run`'s blue, everything else stone, and the
fields are the existing `.inline-grid` / `.inline-field` / `.inline-note` classes — the same
form pieces that were already inside these two forms, just no longer wrapped in the dashed
`.inline-form` box, which was a "this unfolded out of the page" signal that a dialog does not
need. The toast moved from `z-index: 50` to `70` so a validation message fired from inside a
dialog is readable over it.

On a narrow viewport the dialog keeps its shape and drops to the app's own 12px edge margins,
rather than stretching full-bleed and turning a six-field form into a screen of white; the
actions go full-width the same way `.task-action`'s buttons already do below 560px.

### What moved, and one small change of place

`เอาออกจากสำนักงาน` left the body and now sits in the dialog's actions row, pushed away from
บันทึก / ยกเลิก — it is not a variant of saving. It stays `.btn-ghost` rather than borrowing
red: the refusals above it already carry the weight, and red in this app means "somebody is
blocked". `โอนงานที่ยังไม่ปิดทั้งหมดไปให้` stays in the body under a `การออกจากสำนักงาน` label,
because it is the thing that unblocks the refusal; transferring keeps the dialog open (removing
them is usually the next thing) and repaints both it and the screen behind, since the project
counts on both people just changed. Removing a person closes the dialog *before* the repaint,
because a dialog about somebody who no longer exists would re-read a deleted `USERS` entry.

### Checked, end to end

Round 17's two walks still hold through the new dialogs:

- **New customer → package → งวด → work.** `รับลูกค้าใหม่` over the 113-row list → save →
  lands on the new customer with the package form already open → `บันทึกแพ็กเกจ` →
  `เปิดงวดเดือนกรกฎาคม 2569` on the package card → a `phaseIndex: 0` project with all **37
  Gates** instantiated from the template, landing on the person carrying the least open work.
- **Moving a person still moves the queue.** Editing ตันหยง from ทีมบัญชี 1 to ทีมบัญชี 2
  shows the live warning first — นัทตี้ displaced from รองหัวหน้าทีม, 7 Gates moving off her,
  6 moving onto her, 9 projects following her into the new team — and saving produces exactly
  that: ทีมบัญชี 1 has no deputy, so its unsigned Gates climb to ปุ๊ก. Escape at the same
  point changes nothing.
- No console errors on any screen for any of the six demo users, before or after opening
  either dialog.

### The unread badge is red (captain's call, after the round-18 review)

Round 17 made the sidebar's unread count stone and argued the case for it: red belongs to
"somebody is blocked", and an accounting office's working tool should not turn its own frame
into an alert panel. The captain's read on seeing it is that a count nobody notices is not
doing its job, and that decision stands over round 17's.

So `.nav-badge` is now `#b91c1c` — **the file's own red**, the single value already carrying
late / blocked / urgent everywhere else, not a new one — on the same `#fafaf9` text. Nothing
else about it changes: same small pill, same size, same weight, same place. It is a badge, not
an alert.

Two things deliberately did *not* follow it:

- **The unread dot on the notification rows stays stone.** The badge has to be seen from the
  frame while you are looking at another screen; a row you are already reading does not need
  colour to be found. Making both red would be the alert panel round 17 was right to avoid.
- **Collapsed to icons, the badge gains a 2px ring in the sidebar's own background**
  (`#1c1917`, or `#292524` over the active row) rather than being lightened. At 10px riding a
  nav icon, a dark red on dark stone needs separating from what is behind it — and the honest
  way to do that is to cut it out of its background, not to drift the palette's red toward
  something brighter that then means something slightly different from every other red here.

## Round 19 — one sticky action bar for the whole review flow

The button somebody presses eighty times in a row was in a different place on each of the two
review steps, and on one of them it was below the fold. Step 1 kept its
`ยืนยันตัดออก` / `เอากลับเข้ากระบวนการ` under the evidence column, so their y position moved
with the preview's own height — a duplicate claim renders a taller split view than a blank
page does. Step 2 put `บันทึกและถัดไป` at the foot of the right-hand form, which on a laptop
meant scrolling down past every field to reach it and back up to read the next document.
Clearing a 95-item run that way is ninety-five scrolls that do nothing.

Both steps now end in **one shared bar**, `runActionBarHtml()`, pinned to the bottom of the
viewport. A caller supplies where it is, what ‹ › do, and its actions; the bar decides where
those sit. Verified rather than asserted: the primary button's bounding box is identical on
both steps — same right edge, same bottom.

### Sticky, not fixed — and always viewport-tall

`position: sticky; bottom: 0` as the last child of the pane, not `position: fixed`. Sticky
takes the content column's width for free, so there is no left offset to keep in step with the
sidebar's expanded / collapsed / off-canvas-drawer states, and it **cannot cover the last of
the content**: scrolled to the end it simply sits where it falls (checked — the form's bottom
edge clears the bar's top).

Sticky only pins while there is something left to scroll, though, and step 1 on a short run
does not fill the viewport — the bar would then sit wherever that step's content happened to
end, which is the exact inconsistency it exists to remove. So `main.run-flow` (a per-page class
toggled by the router, beside the existing `wide` / `widest` ones) makes the flow page at least
viewport-tall and the bar takes the slack with `margin-top: auto`. Short content: pushed to the
bottom. Long content: pinned there. Either way, the same place.

`.pane-excluded .evidence` came down from `100vh - 330px` to `100vh - 290px - var(--run-bar-h)`.
That 330px was itself a workaround for this problem — it existed to stop the decision buttons at
the bottom of that column falling below the fold. They are not in that column any more.

### What the bar carries

Thin, and in the same order on both steps: ‹ › · where you are · secondary · **primary**.

| | step 1 (ตัดออก) | step 2 (เอกสาร) |
|---|---|---|
| where | `รายการที่ 3 จาก 20 · เหลือ 18 รอตัดสินใจ` | `รายการที่ 1 จาก 95 · 18 ต้องตรวจสอบ` |
| secondary | `เอากลับเข้ากระบวนการ` | `ไม่ใช้ข้อมูลกลุ่มนี้` |
| **primary** | **`ยืนยันตัดออก`** | **`บันทึกและถัดไป`** |

Secondary stays `.btn-ghost` next to the one `.btn-run` — the bar is not a row of equally
weighted buttons. No new colour, no new component: `.nav-btn` for ‹ ›, the same `.btn` classes,
stone text.

Three things moved into it rather than being duplicated:

- **‹ › left the evidence head on step 1**, so walking the list and deciding a page are in one
  place instead of at opposite ends of the column — and **step 2 gained the matching ‹ ›**,
  which it never had. That is what makes the two steps navigate the same way.
- **`รายการที่ n / m` left the step-2 filter row.** The same figure in two places is two places
  to check.
- **`ไปตรวจเอกสารที่จัดกลุ่มแล้ว` left the `.gate-clear` block** and became the bar's primary
  the moment nothing is pending — because at that point that *is* the next thing to press. The
  per-item decision is still reversible there, just demoted to secondary. Two identical blue
  buttons on one screen would have been the worse answer.

**The arrow keys now work on both steps**, not just step 1 — same guard as before, so they
never fire while somebody is typing in a field (verified with a real event target, not just a
document-level dispatch). The point of the bar is continuous pressing; the keyboard had to
follow.

Below 700px the actions take their own full-width row under the orientation line — the same
answer `.task-action` already gives at that width — and the primary is still the rightmost
thing. Checked at 560×820 on both steps.

### Unchanged, and checked

The excluded pages still come first and still genuinely shut step 2: `setRunStep("documents")`
with 20 undecided still refuses with the count. Twenty presses of the primary in one fixed spot
clears the run, each one advancing to the next undecided item, and the slot then becomes the
step-forward button. And the workflow track still never blocks the Phase Gate checklist —
`phaseCanAdvance()` does not consult a run and was not touched. No console errors.

## Round 20 — Phase + Gate is the spine, so the document ladder stops being a second place to work

**This deliberately reverses part of Round 10**, and the reason is worth recording rather than
quietly dropping.

Round 10 modelled the office's own six-step Airtable "สถานะเอกสาร" field as `Project.docState`
and gave it its own editable panel on the project screen. That was faithful to the office's
existing tooling. It was also, once it sat on screen next to Phase 1, a **second place to
work**: `1.แจ้งลูกค้าส่งเอกสาร` and `2.ได้รับเอกสารแล้ว` are Phase 1's own Gates written a
second time, and the panel asked one person to record the same fact twice, in two shapes, with
nothing keeping the two honest with each other. The captain's judgement — Phase + Gate is meant
to be the single operational spine of the product, and anything that competes with it is a
source of confusion, not of extra information.

So the panel is deleted as a data-entry surface. **A person works the Phase 1 checklist and
nothing else.**

### What survived, and where it lives now

The one thing no checkbox expressed is the difference between **"we asked and are still
waiting"** and **"we asked and the customer has nothing to give"**. Those are opposite
decisions — chase, or stop chasing and decide — and the executive view's `รอจากฝั่งลูกค้า`
section was built around exactly that split (`data/ksk-exec-view-scout/report.md` §6, Round 10
above). It is still recordable and still drives that screen.

It is recorded **on the Gate**, because that is where somebody is standing when they find out.
A customer-facing Gate's expanded row gains one action next to the sign-off —
`ปิดเกทนี้: ลูกค้าไม่มีเอกสารให้` — which uses the Gate's existing shape exactly as the tick
does: สถานะ `เสร็จ`, ผู้ทำ defaulted to the signed-in user, วันที่เสร็จ today, and the
หมายเหตุ prefilled. It is fully reversible, and it **still needs a ผู้สอบทาน signature** —
"the customer has nothing" is a claim that deserves a second pair of eyes as much as any other.

One field carries it: `rec.noDocs`. It is deliberately **not a fourth สถานะ** — round 7's rule
stands. Both outcomes are `เสร็จ`, because the office did ask and did get an answer; what
`noDocs` records is *which* answer, which is the thing the next person needs. The row says so
without being opened (a `ลูกค้าไม่มีเอกสาร` chip, and the `รอฝั่งลูกค้า` chip drops off), and
the expanded row states the consequence in as many words: closed because there was nothing to
collect, not because everything came in.

### Everything else is now derived, not recorded

| | before (round 10) | now |
|---|---|---|
| ขอแล้วลูกค้าไม่มีเอกสาร | `docState === 3` | a customer Gate closed with `noDocs` |
| ขอแล้ว รอลูกค้าส่ง | `docState` 1 or 4 | a still-open customer Gate somebody has set to `กำลังทำ` |
| ยังไม่มีใครเริ่มติดตาม | `docState === null` | customer Gates outstanding, none touched |
| เอกสารเข้าครบแล้ว | `docState` 2 / 5 / 6 | every customer Gate the project has reached is closed |

Starting the chase is now something a person genuinely *did* — moving a Gate to `กำลังทำ` —
rather than a second thing to remember to record. Scope is `customerGateRecords()`, the same
"Gates in Phases the project has actually reached" rule `pendingCustomerGates()` has used since
round 9, so the two can never disagree about which Gates are in play.

`wfDocsReady()` follows the same way: a keying run's document stage passes when no customer
Gate is outstanding **and** the customer has not said there is nothing — because if there is
nothing, there is nothing to key. The two seeded runs are unchanged in outcome: `ex3-monthly-may`
still finishes, `ex2-monthly-jun` still fails at the document stage, now because its Gate 1.2 is
closed `noDocs` rather than because a field said `3`.

The `doc` notification kind survives too, on the one rung of the old ladder that was a decision
rather than a chase — it now fires from `toggleGateNoDocs()` and deep-links to that exact Gate
rather than to the project in general.

### The one line that stayed on the project screen

The captain left this to judgement, and one **derived, read-only** sentence earned its place:

> เอกสารจากลูกค้า: ลูกค้าแจ้งว่าไม่มีเอกสารของงวดนี้ (บันทึกไว้ที่เกท 1.2) — ต้องตัดสินใจ ไม่ใช่ทวงต่อ

Two reasons. Somebody arriving from the overview's `ขอแล้วลูกค้าไม่มีเอกสาร` list needs to see
**why** on arrival, and naming the Gate takes them to it. And a project three Phases along still
wants to be able to say the documents are in without the reader counting Gates. It is one line,
it is a consequence of the checklist below it, and its only colour is the red the app already
uses for "somebody has to act" — on the one case that is a decision rather than a chase.

### Seeds, and the dead code

`docState` is gone from all ~210 projects. The demo's starting document situation is now
`seed.docs` — `"asked"` / `"none"` / `"in"` — applied **once** to the customer-facing Gates by
`applyDocSeed()` when the work record is first built, exactly like the `seed.done` /
`seed.awaiting` / `seed.doing` positions round 7 established. It never overwrites what the phase
seed already recorded. `DOC_STATES`, `docState()`, `docStateLabel()`, `setDocState()`,
`renderDocStateCard()`'s panel and the `.doc-ladder` CSS are all deleted. `.doc-step` stays —
the workflow screens' filter and evidence chips have used it since round 11 and it never had
anything to do with the ladder.

### Checked end to end

- **A newly opened งวด**: no customer Gate touched → `ยังไม่มีใครเริ่มติดตาม`, and it appears in
  that sub-list of the overview (which is what round 16 added it for). A keying run on it still
  fails at the document stage.
- **Starting the chase**: setting Gate 1.2 to `กำลังทำ` moves it to `ขอแล้ว รอลูกค้าส่ง`.
- **A customer with nothing**: `ปิดเกทนี้: ลูกค้าไม่มีเอกสารให้` on 1.2 moves it to
  `ขอแล้วลูกค้าไม่มีเอกสาร`, leaves the Gate awaiting a signature, notifies the assignee, and
  keeps the keying run failing. Reversing it puts everything back.
- On load the office overview reads **9 ขอแล้วลูกค้าไม่มีเอกสาร · 38 ขอแล้ว รอลูกค้าส่ง ·
  0 ยังไม่มีใครเริ่มติดตาม** across 139 open projects — derived every time, same on every refresh.
- All seven screens render for all six demo users with no console errors; the workflow track
  still never blocks the Gate checklist (`phaseCanAdvance()` untouched).

## Round 21 — พนักงานและทีม at a glance, with load, and a way to start a team

Three changes, all on that one screen.

### 1. Two teams per row, three people per row

A team was a full-width card and a person a full-width `.customer-row`, so fourteen people
across three teams was a scroll rather than a look. It is now a `.team-grid` of two teams
across, and inside each team a `.people-grid` of three people across, grouped under the rung
headings that were already there — the ladder stays visible, because the ladder is the point of
the screen. Each team card still prints its own review ladder line at the top.

Tightening the person to fit meant deciding what actually earns space at that density. The card
now carries the name, the avatar and the load figures, and nothing else. What was dropped was
already said better elsewhere: "งานของเขาส่งขึ้นไปที่ X" is the team's own ladder line one row
up, and the capability list (`เซ็นผู้สอบทานได้` / `เห็นภาพรวมสำนักงาน` / …) is stated in the
edit dialog where it is about to be changed. The rung is the heading the card sits under.

*(Round 22 corrected the sizing here: the screen moved to `main.widest`, and the responsive
steps were re-ordered. See the Round 22 section.)*

### 2. Load per person — a workload reading, not a rating

Two or three plain figures on each card, and one summary line per team:

| figure | derived from |
|---|---|
| `N ถืออยู่` | projects assigned to them that are not finished |
| `N ปิดปีนี้` | projects assigned to them that are finished, in the พ.ศ. year of the งวด's own `monthKey` |
| `N รอเซ็น` | Gates currently landing on their rung — **only shown for people on the review ladder**, where it is the larger half of what they are carrying |

Everything is counted out of `PROJECTS` and the Gate records already in the file, and every
figure reconciles exactly with the office totals: the fourteen people's `ถืออยู่` sums to the
139 open projects, `ปิดปีนี้` to the 71 closed ones, and `รอเซ็น` to the 32 Gates in
`reviewQueueUnder()`. The unit is the office's own — a งวด — and "ปีนี้" is the accounting year
of the งวด, not a rolling window.

**No bars, no scores, no ranking, and no ordering by output.** The exec-view scout report's §3
"drop" list has per-staff performance rankings on it, the captain has ruled that out twice, and
that still stands: this answers "who is carrying too much", not "who is best". The only colour
is the amber already used for `รอเซ็น` elsewhere, on a review queue that is not empty; a zero
is greyed rather than hidden, because "carrying nothing" is information too. The screen's own
caption says it in as many words: ตัวเลขบนการ์ดคือปริมาณงาน ไม่ใช่คะแนน.

The team header carries the same two figures summed, so a team can be compared to a team
without adding up its people.

### 3. `ตั้งทีมใหม่`

Adding a person existed since round 17; adding a **team** did not, so the office's structure was
only editable inside a shape that had been seeded once. It is round 18's dialog, the same
component as adding a person: ชื่อทีม, หัวหน้าทีม, รองหัวหน้าทีม — the last two optional and
picked from people who already work here.

It is consequential the same way everything else on this screen is, and for the same reason:
**nothing about a review ladder is stored.** Creating a team seats its lead and deputy with the
very same `applyPlacementTo()` the person dialog uses, so a person moved in here cannot behave
differently from one moved any other way, and `reviewerIn()` derives the new team's ladder from
whoever ends up holding those rungs.

The `ถ้าบันทึก:` panel is the person dialog's, extended: it pushes the not-yet-existing team
into a `structureSnapshot()`, applies both placements to the copy, and diffs the office's whole
unsigned-Gate queue with the real `reviewerIn()`. So it can state — and be right about — that
taking somebody who currently leads another team leaves that team's rung vacant, how many Gates
change reviewer, and the two structural cases:

- **no lead and no deputy**: work on this team climbs straight to the COO until somebody holds a
  rung. A team with nobody in charge is allowed; it just says what that means.
- **lead but no deputy**: work goes straight to the หัวหน้าทีม — which is not a special case, it
  is exactly how ทีมที่ปรึกษา + โปรเจค has always worked, and the warning says so by name.

Permissions are untouched: the whole screen already sits behind `canEditPermissions` and
`PAGE_GUARD`, so this needed no fourth check.

### Checked

Creating `ทีมบัญชี 3` with แพรว as lead and บิ๋ม as deputy does exactly what the panel promised
— both move onto the new team, both gain `canReview`, and the 2 Gates it warned about move off
นัทตี้ onto them. The new team then immediately appears in the person dialog's ทีม dropdown, in
the office overview's team filter, and moving นัท into it moves 4 more Gates and shows the
existing "20 โปรเจกต์ยังเป็นของ นัท" warning unchanged. Removing somebody who still holds open
work is still refused by name. All seven screens render for all six demo users with no console
errors, at 1440px and at 560px.

## Round 22 — the dense people grid, fixed at the cause

Ten layout defects were reported on พนักงานและทีม at desktop width, all the same class: text
covered by an opaque sibling. They were symptoms of two causes introduced by round 21's density
change, and both are fixed rather than patched.

### Cause 1 — the person card was a `<button>` that was also `display: flex`

Every other clickable card in this file is a `div` with an `onclick`: `.customer-row`,
`.contact-row`, `.pkg-row`, the notification rows, the person rows before round 21. Round 21
made this one a `<button>`, which is the one shape here that had never been used — and a
`<button>` as a flex container is the classic cross-engine failure. Where it is not honoured,
the inner spans lay out as inline content, escape the button box and paint over whatever is
beside them, which is precisely the reported symptom and precisely why it did not reproduce in
every browser. It is a `div` now, like the rest of the file. **This is round 21 diverging from
the file's own answer for no reason, which principle 6 exists to prevent.**

### Cause 2 — the box was genuinely too small for what was put in it

Two teams across `main.wide`'s 1080px left **159px per person card**, holding an avatar, a name
and three figures. Measured with a realistic Thai full name, the name overflowed its own box by
37px (`scrollWidth` 143 into `clientWidth` 106) — the card could not shrink, because
`.person-card-top` was a flex row without `min-width: 0`, so the ellipsis could never engage.

The captain said trim rather than overlap if it genuinely does not fit, so, in order of how much
each bought:

- **The page moved to `main.widest`** (1360px), the width the run-review screen already uses and
  the router already toggled — ~211px per card instead of 159px. No new class.
- **The avatar came off the person card.** 29px of a ~200px box spent on a two-character
  abbreviation of the name printed next to it. It stays everywhere it earns its place (the
  sidebar, the workload list, contacts).
- **`ปิดแล้วปี 2569` → `ปิดปีนี้`**, and each figure gained a `title` with the full sense. The
  screen's caption already states what the figures are, once, at the top.
- **The team's figures moved out of `.permissions-head`** onto their own line. A team name of any
  length and a `white-space: nowrap` figure string in one flex row is the same collision in
  miniature.
- **The name wraps instead of clipping.** `overflow-wrap: anywhere`, no `nowrap` — at this
  density a two-line name is readable and a truncated one is not.
- `min-width: 0` where a flex or grid child has to be allowed to shrink, and `overflow: hidden`
  on the card so nothing can paint outside it even if something else is added later.

**Nothing the captain fixed as a constraint moved**: still two teams per row, still three people
per row, the workload numbers are all still there, and every team still prints its review ladder.
The responsive steps were re-ordered to match where the pressure actually is — people drop to two
across at 1180px *before* teams drop to one at 900px, because a 3-across person grid inside a
half-width team card is the tight case, not the page width.

### Checked the rest of the screen too, and found two more

The same sweep across every screen at 1675 / 1440 / 1180 / 1000 / 900 / 700 / 560px turned up two
genuine round-19 regressions that the action bar had introduced and that only step 2 had been
measured for:

- **`.evidence` ran 21px underneath the action bar** on the documents step — its
  `calc(100vh - 210px …)` predated the bar. Now `260px`, verified at 760 / 900 / 1100px tall,
  giving the same ~28px clearance the excluded step already had.
- **`.list-card` had no height rule at all**, so on the excluded step it ran past the bar while
  `.item-list` carried a magic `max-height`. The list column now takes the same height as the
  evidence column it sits beside — they are siblings in one grid row, and that is what keeps
  *both* clear instead of only the one that had been measured — and `.item-list` derives its
  scroll region from the card (`flex: 1 1 auto; min-height: 0`) instead of from a constant.
  Both also **release those heights when the pane stacks** below 1000px, which they had not been
  doing; that was the 900px failure.

Round 19's actual contract is re-verified at all seven widths: at full scroll the last of the
content clears the bar on both steps. Content passing *behind* the bar and the mobile topbar
while scrolling is what a sticky bar is, and is unchanged.

Everything round 21 delivered still works after the rewrite: creating a team, its ladder deriving
from whoever holds the rungs, moving a person into it, and the `ถ้าบันทึก:` warning. No console
errors on any screen for any of the six demo users.

## Round 23 — the dialogs were unstyled, because round 22 deleted their stylesheet

### Reproduction

Reported as "the edit-person dialog does not seem to work correctly", annotated on
`div#modal-card > div:first`. It reproduces on the first try: open พนักงานและทีม, press แก้ไข on
anybody.

### What starts it, what exposes it, what you see — three different things

- **What starts it**: nothing a user does. Round 22 rewrote the "People + teams" CSS block by
  replacing everything between its own heading comment and the `/* pure-simulation toast */`
  rule. The round-18 dialog stylesheet sat inside that range, so all 61 lines of it —
  `.modal-backdrop`, `.modal`, `.modal-head/-body/-actions`, `body.modal-open`, the fade
  keyframe and the narrow-viewport rules — were deleted at that commit. Only the class *names*
  in the JS survived. It was already broken when round 22 was pushed; no sequence of clicks
  causes it and none avoids it.
- **What exposes it**: opening **any** dialog. It is not the person dialog, not a particular
  person, not the second team, and not "only after a previous dialog was cancelled" — a single
  missing stylesheet cannot be conditional. The captain happened to hit it on edit-person.
- **What you see**: no overlay and no card. The dialog's contents — title, ×, fields, the
  ถ้าบันทึก: panel, the actions — render as full-width unstyled flow content **appended to the
  bottom of the page**, below the sidebar, with the page not locked and the screen you came from
  still fully interactive above it. The screenshot in the PR shows it.

### Known-good comparison, and the falsification check

The captain named the round-18 customer dialog as a working reference. That was the check that
could have proved the explanation wrong: **if `รับลูกค้าใหม่` had still rendered as a proper
overlay on the round-22 build, the cause could not be a missing shared stylesheet** and would
have to be something specific to the person dialog.

Checked against the pushed round-22 commit directly. All four dialogs report
`position: static`, no `z-index`, and an unlocked body — the customer one included. The
explanation survives; the "known-good" dialog was simply not re-opened after round 22.

### The fix

The 61 deleted lines restored verbatim in their place. Nothing in the dialog component's
behaviour was changed, because nothing about it was wrong — `openModal` / `closeModal` /
`renderModal`, the focus trap, Escape, the backdrop-click test and the per-caller `render()`
were all still correct and still passing every path while looking like this.

The section from the dialog to the end of the `<style>` block is now explicitly marked as
**app-level, not part of any screen's stylesheet**, with the reason recorded — this failure came
from editing one screen's CSS by a pair of surrounding landmarks rather than by its own bounds.

### Verified afterwards, on all four dialogs

At 1675 / 1440 / 900 / 560px, `รับลูกค้าใหม่`, `แก้ไข <คน>`, `เพิ่มพนักงานใหม่` and `ตั้งทีมใหม่`
each render as a fixed, centred, z-60 card that fits the viewport, with the body locked and focus
landing in the first field. And every path in turn:

- **Saving updates the screen behind** — the moved person, the new person, the new team card, and
  the new customer landing on their own page with the package form open.
- **Cancelling changes nothing** — changing ทีม and pressing ยกเลิก leaves `USERS` untouched; so
  does Escape, and so does a backdrop click.
- **Reopening shows current values, not stale ones** — reopen after a cancelled edit and the ทีม
  select reads the person's real team again.
- A name typed into เพิ่มพนักงานใหม่ still survives the re-render caused by changing another field.

No console errors on any screen for any of the six demo users.

## Design principle applied: a personal work surface first, an office view only for managers

The dashboard still shows only what's relevant to the logged-in person right now: their own
"today" queue and their own blocked items — never a cross-company or cross-employee
overview. Switch between the demo users on the login screen to see this concretely: one has
blocked items and a full queue, another has an empty blocked section (hidden entirely, not
shown-as-zero) and a single task.

Round 9 adds the office-wide view the captain deferred at the start of the redesign, but it
is a **separate screen behind a role capability**, not a widening of งานของฉัน — that screen
is unchanged. A manager gets the office view; everybody else's home page is still only their
own work.

Round 10 keeps this exactly as it was, and sharpens it: งานของฉัน is still only your own
work plus the Gates that land on **your** rung of **your** team's review ladder — teams made
that boundary tighter, not looser.
