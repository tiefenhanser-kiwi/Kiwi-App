# The Prep & Cook census harness — Part A (September 30, 2026)

Read-only. Builds a **golden corpus**: real dev plans run through the real
Prep-the-Week and Cook-Mode pipelines at HEAD, stopped before persistence, and
rendered exactly as the phone composes them. `check.ts` measures K-R1…K-R6 and
P-R1…P-R6 against those files.

Run everything from `artifacts/api-server`.

## The one command

```bash
# 1. the corpus (13 plans — 12 from the grocery census + the browser-pass plan)
node --env-file=.env --import tsx scripts/prep-cook-census/census.ts \
  --plans b4aa6fee,31c7a885,96a94410,ed238692,2b6e51a1,a8b0bbd5,316d0846,163875ec,d47d18aa,f5556c19,b8e7f134,425da049,247cd7bb \
  --tag live --budget 4.5

# 2. the checker (K-R1..K-R6, P-R1..P-R6)
node --import tsx scripts/prep-cook-census/check.ts --tag live

# the corpus probe (plan sizes, day coverage) — no AI, no cost
node --env-file=.env --import tsx scripts/prep-cook-census/probe.ts --plans <prefixes>
```

Plan ids may be given as 8-char prefixes; the harness resolves them and refuses
an ambiguous one. Measured on the 13-plan corpus: 54 meals, 399 prep steps,
770 cook steps, 13 Sonnet calls, **$1.2047**.

## The fences, and why each one holds

| fence | how |
|---|---|
| dev branch only | `census.ts` throws unless `DATABASE_URL`'s host contains `ep-broad-haze`. |
| no prep-cache write | the harness calls the **pipeline** (`loadPrepWeekInput` → `buildPrepCombineInput` → `combinePrep` → `buildStepPlan` → `runAICall` → `assemblePrepWeekResult`), never the route. `routes/cooking.ts` owns the `prepWeekStructure` upsert, so nothing here can reach it. |
| no cache **read** either | same reason. Every plan is generated fresh, so the corpus measures HEAD's prompt rather than a stored blob some earlier version wrote. |
| belt and braces | every write op on **every** Prisma delegate is proxied to a recorder that **throws**; `$transaction(array)` is `Promise.all`'d. The single exception is `LLMCallLog`, which the pass explicitly allows. |
| budget | the spy sums the SDK's own token counts through the Sonnet rate table and aborts before the plan that would cross `--budget`. |

Cook Mode costs nothing: BUG-018 B2 removed the sequencer's Sonnet call, so
`runCookingSequence` is pure arithmetic over persisted steps.

## The render is the client's, not a copy

`census.ts` imports `buildPrepWeekModel` + `buildMealLabelLookup` from
`artifacts/kiwi/lib/cooking/prepWeekModel.ts` and `sequenceMealSteps` from
`artifacts/kiwi/lib/cooking/cookSession.ts`, and calls them with the same
arguments the screens pass. Nothing about either render is re-implemented here.
(Both modules' `@/…` imports are type-only, so they load under tsx unchanged.)

One deviation, recorded per meal rather than hidden: `POST
/meals/:id/cooking-sequence` reads `recipeInstructionStep` straight from Prisma
and never sees a plan item's `recipeOverrideJson`, while `GET /meals/:id` does.
The corpus therefore records `hasRecipeOverride` on every meal and the `.txt`
prints a warning line for those, exactly as the §27 defensive append in
`cookSession.ts` describes.

## The checker is deliberately independent

`check.ts` imports **nothing** from `cookingScheduler` or `prepWeekAssembly`.
It reads the saved JSON as data and re-derives offsets, attendance and prose
with its own predicates, so a bug in the code under test cannot hide from its
own detector.

Three detectors were narrowed after their first run over-reported, and each
narrowing is commented at the site:

- **P-R2** first tested only the `seasonings_dry ∩ sauces_marinades` pair and
  reported 0. `combinePrep` groups by `ingredientId` and `assignPhase` routes by
  `Ingredient.category`, so a marinade's orange juice lands in `produce` — where
  `blendSpiceDish` (a `sauces_marinades`-only field) can never link it. Widened
  to any number of piles in any phases: 108 dishes, 461 piles.
- **P-R4** first matched any "on cook day" and caught correct forward references
  ("…ready to stir in on cook day"). Narrowed to prohibitions: 36 → 5.
- **P-R3**'s P1 class first scanned the whole step blob and tagged "Slice the red
  bell peppers **for Sheet-Pan Chicken Fajitas**" as raw flesh; "chop" also
  matched "Chop the fresh cilantro". Now word-anchored against the step's own
  object (the title before " for "): 41 → 15.

## Output

`out/` (gitignored) holds, per run and per plan:

- `<tag>__<planId8>.json` — the machine record (cook steps with serve-anchored
  offsets, phase, attendance tags and cues; prep steps with storage notes and
  render flags; the three competing minute totals).
- `<tag>__<planId8>.txt` — the readable render, prep then cook, as the phone
  composes each.
- `<tag>__<planId8>__narration-input.json` — exactly what the narrator was
  handed. This is the audit trail for any prompt fix, and P-R1/P-R2's
  structural source.
- `<tag>__summary.json` — per-call tokens, latency and cost.
- `<tag>__check.txt` / `.json` — the rule table, counts and examples.
