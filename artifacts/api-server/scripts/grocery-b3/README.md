# [grocery] B3 — RECURRING ITEMS + RIDERS · Part A (September 29, 2026)

Read-only. Everything here measures or previews; nothing writes. Run from
`artifacts/api-server`.

```bash
# 1. the digest — every distinct recurring text on dev, and what the resolver picks
node --env-file=.env --import tsx scripts/grocery-b3/vocab.ts     # -> out/vocab.txt

# 2. what the resolution would MEET, per census plan
node --env-file=.env --import tsx scripts/grocery-b3/overlap.ts   # -> out/overlap.txt

# 3. Rule 3's population, and the only-bought components by id
node --env-file=.env --import tsx scripts/grocery-b3/paths.ts     # -> out/paths.txt

# 4. the dry run, through the WHOLE pipeline, with the four gates
node --env-file=.env --import tsx scripts/grocery-b3/preview.ts   # -> out/preview.txt
```

`shadow.ts` is a throwaway copy of what Part C will make
`consolidatePlanIngredients` do. Part C changes the real code and this file stops
mattering. What it does NOT re-implement is most of it: the resolver
(`lookupIngredientByName` + the `IngredientAlias` synonym index), the pack
resolution, the ladder, the rounding, the merge, the rider and the client render
are all shipped functions, called unchanged.

## The fences

| fence | how |
|---|---|
| dev branch only | every script throws unless `DATABASE_URL`'s host contains `ep-broad-haze`. |
| nothing persisted | `preview.ts` calls the pipeline's three stages and returns before the route's `prisma.$transaction`. |
| catalog untouched | every write method on the `ingredient` delegate is proxied to a recorder that applies nothing; `$transaction(array)` is `Promise.all`'d. |
| no user's ledger touched | AI calls run with `userId` undefined — a system-triggered CLI row. |

## What the dry run changed about its own design

1. **The BEFORE has to run the WHOLE pipeline, not be read off the corpus.** The
   `b2__` files are the right after-state, but the recurring rows' packs are
   gap-filled by Haiku live and two of the nine texts are not stable across runs
   (`paper towels` 49×`(6-pack)` / 7×`(6 rolls)`, `pet treats` 54×`box` / 2×`bag`
   over 288 observations). A BEFORE read off disk would attribute one of those
   flips to this block. Both passes run in one process with a Haiku cache keyed on
   the request, exactly as B2's `preview2.ts` does and for the same reason.

2. **The shadow must post-process the POST-merge rows, not pre-merge ones.**
   `consolidatePlanIngredients` appends recurring synthetics *before*
   `poolComponentNeeds` and `mergeConvertibleGroups`. A shadow cannot re-enter the
   function, so it works on what comes out — which is correct here only because
   the 40 resolved-but-not-demanded items are, by construction, foods the plan
   demands none of, so there is nothing for them to merge with, and the 14 that do
   meet a plan row join an existing row rather than adding one.

3. **Gate 1 is blind unless the conversion data is put back on the row first.**
   `GenerateListOutputItem` carries no `conversionRef` and no pack yield —
   `generateFinalGroceryList` builds it from the pack fields alone — so B2's
   `preview2.ts` gate1 casts read `undefined` on every row and its Cases B and D
   could never fire. Replayed over the `b2__` corpus that predicate calls 803 of
   1,041 rows unverifiable, not the 241 `preview2.txt` reports. `attachConv` here
   re-attaches the data from the consolidated row the output came from; the same
   strengthened gate scores the B2 after-state at 731 unverifiable / 0 fails and
   B3's after-state at 665 / 0.

4. **"Comparable" is not "convertible".** A gallon and two cups convert perfectly
   and Hans put that exact pair in R3's *incomparable* branch — "the app never
   decides that a gallon covers two cups". So the branch test is that both sides
   are the same COUNT unit; anything measured takes the default-purchase branch.
   Reading it as "same dimension" would have summed `1 bottle` into `1 cup`, which
   is the consumption modelling the ruling forbids.

---

## Parts B and E

```bash
# Part B — the reviewed catalog writes (dry-run, then apply, then apply again)
node --env-file=.env --import tsx scripts/grocery-b3/readers.ts        # -> out/readers.txt  (blast radius)
node --env-file=.env --import tsx scripts/grocery-b3/apply.ts --dry-run
node --env-file=.env --import tsx scripts/grocery-b3/apply.ts --apply

# Part D — the ten deliberate breaks
node scripts/grocery-b3/breaks.mjs

# Part E — the corpus at HEAD, then the diff and the gates
node --env-file=.env --import tsx scripts/grocery-census/census.ts \
  --plans f5556c19,56b03a57,c404a3cf,247cd7bb,14879176,b8e7f134,31c7a885,96a94410,425da049,ed238692,2b6e51a1,6e952e32,a8b0bbd5,316d0846,11653a33,353ce059,14397131,163875ec,d47d18aa,8a462408 \
  --mode live --tag b3 --budget 6
node --env-file=.env --import tsx scripts/grocery-b3/after.ts         # -> out/after.txt
node --env-file=.env --import tsx scripts/grocery-b3/paths-after.ts   # -> out/paths-after.txt
```

`paths-after.ts` exists because the grocery corpus cannot show Rule 3: only two
dev plans reach a component with a bought path and no scratch one, and neither is
among the 20. It runs the scheduler on those two with each predicate in turn, and
composes `GET /meals/:id` for all 10 bought-only components.

## What Part E changed about its own design

5. **Gate 4 cannot be a name comparison.** The first detector asked whether an
   AFTER row's name shared a four-character prefix with the BEFORE row's, and
   reported 33 failures that are the block working: `milk` → `whole milk`,
   `eggs` → `large eggs`, `bread` → `sandwich bread` share no prefix, which is
   the entire point of resolving. It now walks the user's own recurring TEXTS
   through the resolver and asks where each one landed.

6. **Gate 2's rider must stop at the need.** `at least[^,)]*` ran past the
   opening bracket of the client's need suffix, so
   `"4 can (14.5 oz) chicken broth, at least 1 low-sodium (6 cup)"` was read as
   the rider `"at least 1 low-sodium (6 cup"` and reported as a measure. The
   rider is a count; the measure is the sentence's, not the rider's.

7. **Ruling 8's premise did not hold, and the first Part E run is the evidence.**
   "Cans are counts, so this is allowed" — but the SHARE is 1.5 cup and 5.5 cup,
   `buyUnitsForNeed` has to state it in the buy unit, and nothing related `cup`
   to `can`. The fold landed and the rider did not, which would have REMOVED the
   word "low-sodium" from a list that used to carry it on its own line. The four
   broth pack yields in `proposals.ts` are the amendment that makes the ruled
   outcome exist; deleting those four entries reverts it.

8. **The yield figure was 1.8125 and that was wrong (B3 · F).** "14.5 oz" on a
   broth can is NET WEIGHT, not fluid ounces, and dividing it by 8 treats a
   weight ounce as a fluid ounce. 14.5 oz x 28.35 = 411 g, which for a broth is
   ~411 mL = 1.74 cups; the cans say "about 1¾ cups". A yield that over-states
   the pack UNDER-buys, so this is 1.75. The two figures disagree only at 7¼, 9
   and 10¾ cups, and no corpus need lands there — the 20 lists are byte-identical
   either way, which is exactly why a boundary error like this survives a
   corpus diff and has to be caught by reading the label.
