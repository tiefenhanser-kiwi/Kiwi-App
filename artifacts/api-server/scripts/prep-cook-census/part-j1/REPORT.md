# Prep & Cook Part J.1 — Hans's October 3 rulings and the census's smaller prep defects

Run 2026-10-03 on `next`. Prompts after this part: `prep.narrate_steps` **v21** (claude-sonnet-5-5),
`wizard.set_preferences.generate` **v18** (back on claude-sonnet-4-6), `wizard.directed.generate` **v15**.
Prep engine version **3** (new, folded into the cache fingerprint). Spend **$1.66** of $3.50
(adherence $0.65, narration $1.01). Test account plus Hans's `e55a9305`; no migrations; `artifacts/kiwi/**` untouched.

Reproduce (from `artifacts/api-server`):
```
node --env-file=.env --import tsx scripts/prep-cook-census/part-j1/census.ts <J.0 prepStorage.ts snapshot>   # free
OPENING=70 node --env-file=.env --import tsx scripts/prep-cook-census/part-j0/ticks.ts                      # free
node --env-file=.env --import tsx scripts/prep-cook-census/part-j1/get-latency.ts J.1 24                     # free, read-only
P8_MODELS=claude-sonnet-4-6 node --env-file=.env --import tsx scripts/_scratch/sonnet55/p8-adherence.ts 10   # paid
node --env-file=.env --import tsx scripts/prep-cook-census/part-j0/regen.ts --out scripts/prep-cook-census/part-j1/out --only A10   # paid
```

## 0. From the J.0 audit

**0a — rows changed on reseed (two reseeds this part):**

| key | model | body |
|---|---|---|
| `wizard.set_preferences.generate` | claude-sonnet-5-5 → **claude-sonnet-4-6** | v17 → v18 (0b) |
| `wizard.directed.generate` | claude-sonnet-4-6 (unchanged) | v14 → v15 (0b) |
| `prep.narrate_steps` | claude-sonnet-5-5 (unchanged) | v20 → v21 |

The surprise generator is retired (`RETIRED_KEYS`), so two bodies carry the playlist rule.

**0b — playlist rule re-worded (replaced, not layered), 10 runs on Sonnet 4.6, identical inputs:**

| rule | family4picky J.0 | family4picky J.1 | gf30 J.0 | gf30 J.1 |
|---|---|---|---|---|
| runs ok · candidate count = 3 | 10/10 · 10/10 | 10/10 · 10/10 | 10/10 · 10/10 | 10/10 · 10/10 |
| playlist exact per candidate (target min(N, marked) = 2 / 1) | 12/30 | **19/30** | 26/30 | **30/30** |
| — candidate 1 · 2 · 3 | 5 · 3 · 4 | 6 · 7 · 6 | 9 · 8 · 9 | 10 · 10 · 10 |
| over target · under target | 0 · 18 | 3 · 8 | 3 · 1 | 0 · 0 |
| non-playlist shelf slot over the cap | 0/30 | 0/30 | 0/30 | 0/30 |
| shelf / live slots of 150 | 133 / 17 | 141 / 9 | 32 / 118 | 30 / 120 |

The count is now kept in all three plans. The 3 "over" candidates on family4picky place all three marked playlist meals (N = 2).

**0c** — one cook-day list on the Proteins phase. It holds every portion held for its window (R1), every protein the engine leaves for cook day ("straight from the package: the Italian sausage"), and every produce item that browns once cut. Lines are deduped; each food is named once per meal; lines split at an item, never mid-word.

**0d** — storage notes are fitted by whole sentences. The order is: the full note, then compact forms, then as many whole sentences as fit. There is no `…` truncation. The schema cap stays at 200, because the client holds 200 too.

**0e — `GET /plans/:id` p50, in-process against Neon dev (ms):**

| plan | pre-J.0 | J.0 (n=12) | J.1 (n=12) | J.1 (n=24) |
|---|---|---|---|---|
| 873796cd (A01, 7 meals) | 1246 / 1066 / 1108 | 984 (−262) | 1374 (+308) | 1031 (−77) |
| 3f9d46e8 (A10) | 957 / 1004 / 985 | 949 (−8) | 1049 (+45) | 983 (−2) |
| b4aa6fee | 1014 / 1055 / 1024 | 1020 (+6) | 1050 (−5) | 1032 (+8) |

Each J.x column is paired with the pre-J.0 run beside it. The one value over 300 ms (+308, n=12) did not reproduce at n=24, and run-to-run swings on this plan reach ±260 ms. The endpoint is Neon round-trips, so no memo was added.

**0f** — a protein's title names its kept dish(es): "Pound the chicken breasts — Lemon-Herb Baked Chicken Breast". This is skipped on render-omitted steps.

## 1. Hans's rulings

### R1 — one Sunday session

The curated storage table was reviewed against USDA FoodKeeper (FSIS) refrigerator figures. FoodKeeper lists most produce whole, so a cut item takes at most the low end of its whole-item range. Windows were loosened up to the accepted figure and never past it, and tightened where J.0 was already past it.

| class | J.0 | J.1 | source |
|---|---|---|---|
| raw fish / raw meat | 2 | 2 | unchanged |
| cut tomato (new row) | 4 (via cut-peppers) | **2** | Hans's brief: cut tomato 2–3; FK whole cherry tomatoes 5. **Tighter** |
| soft herbs, scallions, leafy | 3 | 3 | FK parsley 2–3, greens 1–4. Now excludes *dried* herbs |
| broccoli, cauliflower, mushrooms (new row) | 4 | **3** | FK broccoli / cauliflower 3–5, mushrooms 3–7. **Tighter** |
| homemade slaw (new row) | 5 (sauces) | **3** | FK coleslaw, homemade 3–5 |
| zest / wedges | 3 | **4** | FK "Fruit, cut" 4 |
| cut alliums | 4 | 4 | Hans's brief: onion 4–5 |
| peppers, chiles, cucumber, cabbage, zucchini, beans | 4 | 4 | FK peppers 4–14, summer squash 4–5 |
| cooked grains | 4 | 4 | unchanged |
| sauces / dressings | 5 | 5 | FK salsa, homemade 5–7 |
| citrus juice | 3 | **6** | FK lemon juice, fresh squeezed 6 |
| hardy herbs: rosemary, thyme, sage (new row) | 3 (leafy/default) | **7** | FK herbs 7–10; Hans's brief "a week" |
| carrot, celery, radish (new row) | 4 | **7** | Hans's brief 1–2 weeks cut; FK whole carrots 14–21, celery 7–14, radishes 10–14 |
| spice blend / dry mix (room temp) | 7 / 14 | 7 / 14 | unchanged |

**Expired windows** — rendered, dated steps whose container window ends before the cook day:

| count | result |
|---|---|
| Part I census definition (v19 notes) | 111 / 202 |
| J.0 table, no holds (non-protein steps) | 188 / 398 |
| J.1 table, no holds | 176 / 394 |
| **J.1 as served, per kept portion, with holds** | **0 / 760** |

The table alone moves the count little; the holds clear it. How a portion is decided:

- A portion is prepped when its destination container's window reaches its meal's cook day. Otherwise it goes on the cook-day list, and the rest of that meal is still prepped.
- A protein serving a near meal and a far meal preps the near share and holds the far one.
- A narrated bowl step is all-or-nothing.
- Holds are computed on every read (`finishPrepWeek`), never cached.
- `isPrepped` waits only on the kept portions' meals.

### R2 — raw parts of a cooked dish

- **Raw mixes key on the component.** A raw mix is the component, whatever the dish around it does with heat: "Fish Tacos pico de gallo bowl" inside a dish that fries.
- **A heated component is never a raw mix.** Heat is judged on its own steps, or on heat that follows it: a later heat step naming a member, or the very next step being heat and naming nothing. Its vegetables go into "<dish> vegetables".
- **One toppings plate per dish.** "<dish> toppings plate", or "<dish> plate" when the dish IS the toppings. Leafy toppings sit on it; wedges stay off. Its storage line: "Separate piles on a small plate, under plastic wrap in the fridge — up to N days."
- **Names come from class and form:** spice blend · dry mix · sauce jar · marinade bowl · <dish> vegetables · <dish> toppings plate · <component> bowl · <dish> dried-chile bag. Dry pasta is a no-work item.
- **Containers 489 → 480 across the 25 plans** (per-plan table in `census.md`).

## 2. Smaller defects

- **Marinades** use the recipe's stated window: "Add the chicken thighs 2 hours before cooking (Tuesday)." A protein joins at prep only when the recipe says overnight (or 8 h+) **and** the cook day is within a day. The close names the proteins step only when it renders; otherwise it says "Add the … to this bowl now". One predicate (`joinsAtPrep`) feeds both the close and the protein's own note.
- **Cabbage is a cut vegetable.** `LEAFY` no longer holds it, so a slaw's cabbages and carrot share one bowl.
- **One citrus, one tub.** A dish's zest and juice of one fruit share "<dish> — lime zest and juice".
- **Labels spoken in words.** "into the shared minced-garlic tub", "into the diced-jalapeño tub for the Jalapeño Cheddar Cornbread". The raw `<Dish> — <contents>` label stays as the container's name on the wire.
- **BUG-346 (a) and (e)** are tested: storage is classed by ingredient identity, and herb counts keep their unit. The "dried basil → fridge" leak in the leafy row is fixed alongside.
- **`componentSelections`** is unbuilt: nothing reads `MealPlanItem.componentSelections` or `Dish.componentSelections`. The schema comments say "Nothing reads it yet", and the only code touching them copies them on duplicate/fork (`plans.ts:1876`, `mealFork.ts:327`). One skipped test (`prepWeekJ1.test.ts`) cites D-WS9-068 / D-WS7-215. Nothing changed.
- **Cache hazard closed.** `PREP_ENGINE_VERSION` is now in the composition fingerprint, so an engine change to names or grouping invalidates warm caches once instead of serving stale container names.

## 3. Regenerated (v21, claude-sonnet-5-5, 0 retries)

| plan | header J.0 (v20) → J.1 (v21) |
|---|---|
| A01 873796cd | 30 containers · 150 min → 30 · 130 |
| A04 7f206a48 | 13 · 65 → 11 · 50 |
| A16 b0c8ffbd | 21 · 95 → 21 · 85 |
| A10 3f9d46e8 | 16 · 85 → 15 · 50 |
| A10 subset (Supreme Pizza + Falafel Plate) | 8 · 65 (Part I, v19) → 6 · 25 |
| Hans e55a9305 | 23 · 110 (cached v19 blob) → 25 · 105 · 0 completion rows before and after |

Full texts: `out/regen_*.txt`.

---

# Part J.1b — the audit's follow-ups

Run 2026-10-03 on `next`. Prep engine version **4**: a protein's knife verbs changed for the same composition, so warm caches regenerate once. Spend **$0.11** of $1.50, all of it the two engine-v4 regenerations; the final re-renders were cache hits at $0. No migrations; `artifacts/kiwi/**` untouched.

1. **Plates hold per pile; bowls hold whole.** `computeHolds` gives a plate portion its own pile's window, and gives any other portion its container's window. On a plate, a held pile leaves and the rest go on Sunday. The plate's line names the piles that are on it: "Separate piles (iceberg lettuce and white onion) on a small plate…". A mixed bowl (pico) is held entire when any member expires. Both cases are tested.
2. **The cook-day list has one line per meal, and prep only.** Members are joined in one sentence, with the weekday once. These never appear: a lone measure, a held sauce jar's measures, a package protein, and a protein that joins its marinade (the marinade clause says it).
   - The line fits by naming things briefly: actions → foods → short food and protein names → the first foods plus "and N more" → the meal's own dish name before " with …". It is never cut mid-word.
   - Corpus cook-day lines: 178 → 73.
3. **"Cube and trim the chicken thighs"** came from the dumpling butter's "cubed" sentence. A protein's verbs now come only from prose sentences that name the protein. Hans's plan now reads "Trim the chicken thighs".
4. **`GET /plans/:planId/prep-week/structure`** returns the engine's step set:
   - Fields: stepKey, engine title, phase, containerNames, contributesToMealIds, coversCookSteps, skipSuggested, heldForCookDay.
   - It makes no AI call and writes no cache row. Auth and ownership-as-404 match the prep-week route.
   - Tested: zero LLMCallLog rows and no cache write or prune.
   - **Client lane:** Cook Mode can switch to this route. Its titles are engine-made ("Dice the yellow onion") and differ from the narrator's.
5. **Storage-line labels are said in words**, for example "The herb tub for the Herb Rice: airtight…". A partly held step's opening lists only the cuts the step still does (`dropHeldCuts`).

Found and fixed in Hans's re-render:
- The Lemon-Herb cook-day line was cut mid-word ("…to the mar"). The fit ladder above replaced the slice.
- The cilantro step printed "Plate, wrapped, fridge, up to 3 days." twice. Plates that keep alike now collapse to "Both containers: …" whatever their piles, and `fitNote` says identical compact sentences once.

Behaviour change to note: package proteins are off the cook-day list. They are no-work items.

| plan | header J.1 → J.1b |
|---|---|
| A10 3f9d46e8 | 15 containers · 50 min → 15 · 50 (Falafel line is now one line) |
| Hans e55a9305 | 25 · 105 → 25 · 105, v21 |

`out/regen.json` holds the last run only (Hans's). The J.1 runs are in git at 364021e.
