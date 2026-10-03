# Prep & Cook Part J.0 — the prepped path, the 502, and Sonnet 5.5

Run 2026-10-03 on `next`, prompt `prep.narrate_steps` **v20**, model rows `prep.narrate_steps` and
`wizard.set_preferences.generate` on **claude-sonnet-5-5** (thinking off by code). Same 25-plan corpus as
Part I, test account only. Spend **$2.62** (narration $1.41, adherence $1.21).

Reproduce (from `artifacts/api-server`):

```
node --env-file=.env --import tsx scripts/prep-cook-census/part-j0/ticks.ts      # free: A1–A4, B caps, through the routes
node --env-file=.env --import tsx scripts/prep-cook-census/part-j0/covers.ts     # free: A4 on the census's 14 meals
node --env-file=.env --import tsx scripts/prep-cook-census/part-j0/regen.ts --only A10   # paid: route regeneration
node --env-file=.env --import tsx scripts/_scratch/sonnet55/p8-adherence.ts 10   # paid: D3
```

## 1. The prepped path (A1–A3)

| | before (Part I) | after |
|---|---|---|
| census prepped-path meals prepped after ticking every rendered step | 2 / 14 | **14 / 14** |
| census subset meals prepped after ticking every rendered subset step | 0 / 34 | **34 / 34** (50 / 50 over all 25 plans) |
| corpus plans where derived key set ≠ rendered key set | not counted (22 blockers on the 14 meals: 19 off the wire, 3 held proteins) | **0 / 25** |
| subset steps keyed outside the full plan | 8 / 186 | 0 |
| subset container names ≠ full plan | 64 / 178 | 0 |
| subset per-dish quantity ≠ full plan | 1 / 395 | 0 |

- One builder, `src/lib/prepWeekBuild.ts` `buildPrepWeekPlan`, feeds the route AND `loadPrepStepSet`.
- `isTickable` = not engine-demoted, not the wash / a cook-day line, not held by the overlay
  (`prepStorage.overlayHoldsForCookDay`, which the overlay itself now calls).
- The cached blob is no longer read for demotions (`demotedStepKeysFromStructure` kept one part for rollback).
- `GET /plans/:id` now runs the two step-text queries it used to skip (D-WS9-049 A2.1): the price of agreeing.
- Subset: the loader validates `mealIds` but loads the whole plan; `buildStepPlan(…, { scopeMealIds })` scopes
  after the drop pass, renumbers per phase, recomputes minutes and lags.

## 2. The 502 (B)

| | before | after |
|---|---|---|
| full-plan 502s | 8 / 25 | **0 / 25** (25 regenerated, 0 retries) |
| narration cost, the 8 failing plans | $1.584 (4.6, two billed attempts each) | **$0.492** (5.5) |
| narration cost, all regenerated | $3.279 (n=23 with a Part I call) | $1.412 (n=25), mean $0.057 |
| longest `instructions` | 1,059 (rejected) | 795 |
| portion lines without a destination · label twice in a step · "+N more" | 6 · 2 · 18 | 0 · 0 · 0 |
| narrator openings truncated / naming a dish or container | — | 0 / 156 · 0 / 156 |

Portion lines are rendered by `prepWeekAssembly.renderPortionLines`; the narrator writes the opening sentence only
(`portionsByApp` on the narration input, `measures: []`). Compaction ladder when a step will not fit:
drop "for <dish>" where the lid's head is the dish → unique short dish names → "the <Dish> tub" for a content
tub unique on the plan → plain amounts → (never reached) trim. Measured with a 160-char opening on all 25 plans:
7 steps use the short-tub stage, 0 trim.

## 3. Cook Mode (A4) and the stripped fields (C)

- `coversCookSteps: [{ mealId, dishId, stepIndex }]` on each prep-week step. On the census's 14 prepped meals:
  69 `prep`-tagged cook steps (the 69 the client filter drops today); **23** are done-in-prep, **46** stay in the
  cook flow (4 of those carry no amountRefs).
- `heldForCookDay` / phase `note`: the SERVER already sends both (A01, 7 meals: 5 held lines on v20). The strip
  is `artifacts/kiwi/lib/api/cooking.ts:273` — client lane.

## 4. D3 adherence (10 runs per model per set, identical inputs)

| rule | family4picky 4.6 | family4picky 5.5 | gf30 4.6 | gf30 5.5 |
|---|---|---|---|---|
| runs ok | 10/10 | 10/10 | 10/10 | 10/10 |
| candidate count = 3 | 10/10 | 10/10 | 10/10 | 10/10 |
| playlist exact (per candidate; target min(N, marked rows) = 2 / 1) | 12/30 | **8/30** | 26/30 | **10/30** |
| — by candidate position 1 / 2 / 3 | 5 · 3 · 4 | 8 · **0 · 0** | 9 · 8 · 9 | 8 · 1 · 1 |
| no non-playlist store slot over the cap (45 / 30) | 30/30 | 30/30 | 30/30 | 30/30 |
| store slots / live slots of 150 | 133 / 17 | 93 / 57 | 32 / 118 | 10 / 140 |

Full table and rows: `scripts/_scratch/sonnet55/p8-out.md`.
