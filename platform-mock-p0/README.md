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

`WORKFLOWS` is a **catalogue** — three entries today (`ksk-keying` รอบคีย์เอกสาร,
`vat-recon` กระทบยอดภาษีซื้อ–ภาษีขายกับ GL, `doc-check` ตรวจความครบถ้วนของเอกสาร), each with
a name, a one-line description of what it does, its own ordered steps, and its own **actor
name**. An admin *picks* from it on the ประเภทงาน screen; nothing is typed as free text, so a
Phase can only ever point at a workflow that exists.

- Attachment is **template-level**, alongside the Phase's Gates: `phase.workflows` is a
  **list**, so more than one workflow per Phase is a first-class case even though today's
  seed uses one per Phase. Seeded: `monthly` Phase 2 → `ksk-keying`, `monthly` Phase 3 →
  `vat-recon`, `yearly` Phase 2 → `ksk-keying`. `doc-check` is attached to nothing, so the
  catalogue is visibly a catalogue.
- Each attachment also carries `evidence` — the Gate รหัส this workflow's result genuinely
  speaks for. Edited in the ประเภทงาน editor as toggle chips over that Phase's own Gates
  (reusing the document ladder's `.doc-step` chip), not as a free-text field.
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
(anything other than 2/5/6). Change the ladder on the same screen and run again. Two runs are
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
is actually true**: Gates 2.1–2.4 of `monthly` and `yearly` now read
"ตรวจ… ที่ระบบคีย์มา — แก้จุดที่ไม่ถูกก่อนยืนยัน". 2.5 (ตรวจงบทดลองเบื้องต้น) was already
verification and is untouched. The same applies to `monthly` 3.3, where `vat-recon` is
attached. Everything else stays verbatim from the sheet. This is the one place in the mock
where the office's own text was rewritten rather than copied — it is a claim about the
office's process that the office should confirm or overrule.

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
