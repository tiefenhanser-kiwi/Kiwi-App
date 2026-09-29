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
