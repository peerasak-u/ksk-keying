# KSK platform mock — the React app

The clickable mock of the proposed KSK office platform, as a real application. This is the
same mock `../index.html` is, restructured so it can be edited page by page: same layout,
same copy, same interactions, same seed data.

`../index.html` stays in the repo, frozen, so the two can be compared side by side during
the transition. New design rounds go here.

## Running it

The repo standardises on [Bun](https://bun.sh).

```bash
cd platform-mock-p0/app
bun install       # once
bun run dev       # dev server with hot reload, prints its URL
bun run build     # type-check + production build into dist/
bun run preview   # serve the built dist/ locally
```

`dist/` is a plain static site — copy it anywhere that serves files. The build uses a
relative base and hash routing, so it works from any path with no server-side rewrites.

## It is still a mock

No backend, no API calls, no database, no authentication. Everything is in memory and
seeded at startup; **refreshing the page resets it**, exactly as the single-file version
did. The login screen accepts anything — the demo users are there to show how the screens
differ by position in the office, not to authenticate.

## Layout

```
src/
  main.tsx            seeds the stores, mounts the router
  App.tsx             the routes, the dialog layer and the toast
  types.ts            the domain model, written out (Job type → Phase → Gate, etc.)
  navigation.ts       every screen's URL, and the two navigations that carry state
  data/               the seed: job types + gate rules, customers, projects, the office,
                      the 107 generated customers, the run-result tables
  domain/             pure logic — work records, the Phase trail, the schedule, the
                      document situation, due rules, notifications, the run engine
  state/              the live mutable stores, the seeding, the React context, the UI
                      selections that survive navigation
  components/         shared primitives — app shell, sidebar, project card, stepper,
                      capped list, modal, toast, icons
  pages/              one module per screen, with its bigger parts in a subfolder
  styles/             the legacy stylesheet, split along its own section comments and
                      imported in the original order
public/fonts/         the two self-hosted variable fonts
```

### Notes on the port

- **The stores are mutable on purpose.** `src/state/stores.ts` holds the office as plain
  objects, exactly as the single-file mock's globals did, so every screen reads the same
  list and an edit on one screen is visible on every other one without anything being
  copied. Actions mutate, then call `bump()` from `src/state/AppContext.tsx` to repaint.
  That keeps this a restructuring rather than a rewrite of the data model.
- **Class names are global and unchanged.** The stylesheet was split, not rewritten — no
  CSS Modules, no Tailwind, no UI kit — so the markup can be compared against the legacy
  file rule for rule.
- **Fonts and icons are still self-hosted with no CDN.** The fonts moved out of base64 into
  real `.woff2` assets; the Lucide icons became components in `src/components/Icons.tsx`
  with the same paths.
- **Routing is real.** Each screen has its own URL instead of a hidden-div switcher. Role
  gating lives in the router (`src/components/AppShell.tsx`), not only on the nav links, so
  a direct URL cannot land somebody on a screen their position does not have.
