# The QA harness — Part A (September 30, 2026)

Drives the real app in a real browser against the **dev** stack, photographs
every screen, and scores the result with the **census checkers' own code**.

Run everything from `artifacts/kiwi`.

## The one command

```bash
# all five corpus runs
pnpm run e2e

# one run, into a named folder
KIWI_E2E_RUNS=1 KIWI_E2E_RUN_ID=my-label pnpm run e2e
```

Output lands in `e2e/out/<run>/` (gitignored): one `results.json`, and per flow
a folder of `NN-<screen>.png` + `NN-<screen>.txt` (the PNG for Hans, the text
for the rules and for chat-Claude).

## What it needs running

| thing | who starts it |
|---|---|
| the dev api-server on `:3000` | **Hans.** The harness probes it, waits out a `tsx watch` restart, and **never starts or stops it.** |
| `:9000` serving `artifacts/kiwi/dist` + proxying `/api` | the harness starts `kiwi-local-tools/serve-proxy.cjs` **only if `:9000` is free**, and kills only its own child. Anything already listening is attached to and left alone. |
| `artifacts/kiwi/dist` | **you**, via `expo export --platform web` with `EXPO_PUBLIC_API_BASE_URL=http://localhost:9000/api`. Preflight reports the bundle's age and refuses a bundle baked for a different origin. |
| Chromium | `pnpm exec playwright install chromium` — the machine's cache, not the repo. |

Preflight fails the suite rather than producing a table of rule failures that
are really one missing server.

## The fences

- **DEV ONLY.** `assertDevDatabase()` refuses unless `artifacts/api-server/.env`'s
  `DATABASE_URL` host contains `ep-broad-haze`. The host is **tested, never
  printed** — a pasted connection string is the one way this folder could leak a
  credential.
- **The test account's email and password are read at runtime** from
  `C:\Cooking App\kiwi-local-tools\browser-test-account.local.txt` and are never
  copied into the repo. `redact()` sweeps both out of everything written to
  `out/`.
- **This folder is the whole footprint**, plus the `e2e` script and the
  `@playwright/test` devDependency in `artifacts/kiwi/package.json`, plus one
  line of `exclude` in `artifacts/kiwi/tsconfig.json` (whose `include` is
  `**/*.ts`, so it would otherwise typecheck this folder against the Expo app's
  config). **Metro is untouched**: `e2e/` is not reachable from
  `expo-router/entry`, so nothing here is bundled.

## Design

- **Runner** Playwright, headless Chromium, **375 × 812** at `deviceScaleFactor: 2`.
  `isMobile: false` — react-native-web listens for mouse events, and a
  touch-only context drops taps.
- **One worker, `retries: 0`.** Every flow mutates the same dev account (a new
  plan, a new list, the this-week winner), so parallel flows would race on one
  user's state. Retries are off because a flake a retry hides is the signal this
  harness exists to report.
- **Assertions are rule-based, never exact-text.** The AI parts vary run to run.
  A rule asks "is there a raw decimal anywhere in a quantity position", never
  "does this row say ½ cup".
- **A rule with no candidates reports `pass: null`**, not a green tick nothing
  earned. Both census checkers publish their own denominators for the same
  reason.

### Iteration model

- **Variety** — N plans built from different catalog meals through
  `POST /plans/from-meals`. Deterministic, **no AI, no cost**. `src/corpus.ts`
  freezes 5 × 5 meal ids: run 1 is the named flow (a two-dish meal and a
  lime+egg meal, so R3's three recurring forms appear against the account's own
  recurring list); runs 2–5 are a seeded stride over the id-sorted public
  catalog, one meal per cuisine, each guaranteeing a multi-dish meal and a
  recurring overlap.
- **Repetition** — each AI-backed surface generated K times. Grocery generation
  is per-plan and always spends. **Prep the Week caches** (`prepWeekStructure`),
  so a second call on the same plan is free and returns `cacheHit: true` —
  repetition on that surface therefore needs K *different plans*, not K calls.

## How the checkers are reused

Both `scripts/grocery-census/check.ts` and `scripts/prep-cook-census/check.ts`
export **nothing**: every detector lives inside a module-level `main()` that
reads `out/<tag>__*.json` off disk and writes a verdict file back. There is no
function to import.

So `src/censusBridge.ts` writes a census-shaped corpus file under its own
`qa-…` tag and **spawns those files unmodified**, then reads their verdicts.
Nothing about R1–R7 / K-R1–6 / P-R1–6 is re-expressed here, and a detector
narrowed tomorrow is inherited for free. The tag files are deleted afterwards so
a concurrent census pass never sees them.

### What the browser cannot see

| gap | consequence |
|---|---|
| `canonicalName` is on no wire and the persisted row has no such column | resolved by one read-only `SELECT` on `ingredientId`. Measured: 219/233 rows had `displayName === canonicalName`, 6 more matched normalised, **8 genuinely differed** (`vegetable oil` for `neutral oil`) — which is exactly D1's generic/specific class, so it is resolved rather than approximated. |
| the pre-AI `consolidated` bucket list | synthesised to the right empty/non-empty `sources` truth from `recurringFacets.mealQuantity` + `mealNames` — the only property D7's `.some(sources.length > 0)` reads. **The checker TypeErrors without the field**, so this is not optional. |
| the **narration input** | `P-R2` scores 0-of-0 and `P-R1` keeps only its rendered-text arm. `POST /plans/:id/prep-week` returns the assembled result, never what the narrator was handed. Not faked: no file is written and the checker's own `try/catch` nulls it. |
| `MealPlanItem.recipeOverrideJson` | `hasRecipeOverride` is always `false`; the census's warning for meals where `GET /meals/:id` and the sequencer read different steps cannot be reproduced here. |
| the corpus is **post**-persistence | the census stops **pre**-persistence. `notes` and the `*Override` columns are the only fields that can differ — and D7's R3 arm reads `notes`. |

## The browser's own rules

Three things exist only after React has run, and no server-side census can reach
them. They are the reason this harness is not just a second census.

- **B-R1 — every row the wire returned is on the screen.** The census scores 88
  composed lines whether the list renders 88, 87, or a spinner.
- **B-R2 — R3's three ruled sentences (D-WS9-188).**
  `app/grocery-list/[id].tsx:1527` *replaces* the need parenthetical with
  `recurringDetail(item.recurringFacets)`, and `renderRow()` in the grocery
  census never calls `recurringDetail` at all. So the census's `line` for a
  recurring row **is not what the shopper reads**, and the three forms have no
  server-side detector anywhere. B-R2 also counts which branches appeared, so a
  run that never produced one reports missing *coverage* rather than a pass.
- **B-R3 — the glyph ladder, plus no bare `each` in an R3 sentence.**

> ### ⚠️ B-R3 was narrowed after its first run, and the narrowing is the point
>
> The first version scanned every line for `\d+ each` and reported **21 of 161**
> on run 1 — all of them the need parenthetical: `(4 each)`, `(12 each)`. Every
> one was a false positive, and the authority says so twice: **BUG-160**'s entry
> quotes Hans ruling the shape acceptable outright (*"or `(1 each)`"*), and
> `lib/__tests__/grocery-format.test.ts:84` asserts
> `pluralizeNeedUnit("each", 3) === "each"` with the comment *"not in the
> allow-list"*.
>
> BUG-317's ruling and `[grocery] F5.5`'s fix landed on the **ingredient lines**
> and on the **recurring sentence** (`— recurring; 1 each for meals` →
> `1 for meals`). The rule is real; its scope is that sentence. `BARE_EACH` now
> runs on those sentences only.
>
> The census README records three of its own detectors narrowed the same way,
> for the same reason: **a detector that reports a ruled shape as a defect buries
> the real ones.**

## Residue

A flow **writes to the dev database**: one `MealPlanInstance` (created ACTIVE,
so it takes over `activeThisWeek`), one `GroceryList`, forked `Meal` rows (one
per distinct public catalog source, D-WS7-139 fork-on-acquire), and a
`prepWeekStructure` when prep-week succeeds. Nothing is cleaned up — the plans
are the evidence for the run and hard-delete has a known divergence from
PRD §8.4.2. Expect the account's plan list to grow by one per flow.

## Frictions worth an app-side fix

Recorded here because they are findings, not test debt.

1. **`components/Button.tsx` wraps a bare `Pressable` with no
   `accessibilityRole`**, so react-native-web renders `<div tabindex="0">` with
   no role. `getByRole("button", { name: "Sign in" })` finds nothing — and the
   one element on the sign-in screen that *does* carry `role="button"` is the
   password-visibility toggle, **with an empty accessible name**. So a role query
   does not merely miss the submit control, it can select the wrong one. The
   harness falls back to `div[tabindex="0"]` filtered on exact text. One
   `accessibilityRole="button"` would retire that selector and improve screen-reader
   behaviour at the same time.
2. **Almost no `testID`s.** Across the three screens this pass drives, the whole
   inventory is `grocery-stale-notice` and `step-<i>`. Everything else is reached
   by visible text — which is in tension with "never assert exact text", so
   selectors here only ever match chrome.
3. **No idle signal.** RNW + React Query settle with no global flag and
   `networkidle` is unreliable behind the proxy, so `settle()` polls the rendered
   text until it stops changing. Slower, but it does not lie.
4. **The dev api-server is a watcher.** `tsx watch` closes `:3000` for 2–15s on
   every save under `artifacts/api-server/src`. The harness waits out a restart
   in preflight and retries **reads** on a transport 502; **writes never repeat a
   request**, they ask the server what happened (see `generateGroceryList` and
   `prepWeek`) so a retry cannot double-spend.
