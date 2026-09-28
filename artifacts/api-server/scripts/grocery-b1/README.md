# [grocery] B1 — QUANTITIES · Part A (September 28, 2026)

Read-only. Everything here measures or previews; nothing writes. Run from
`artifacts/api-server`.

```bash
# 1. the catalog survey — the R2 population, the parts population, the category
#    vocabulary, the component-edge inventory with each edge's admit/decline
node --env-file=.env --import tsx scripts/grocery-b1/survey.ts

# 2. the probes — the four questions the columns could not answer
node --env-file=.env --import tsx scripts/grocery-b1/probe.ts   # index folds + pool behaviour
node --env-file=.env --import tsx scripts/grocery-b1/probe2.ts  # why the garlic group refuses
node --env-file=.env --import tsx scripts/grocery-b1/probe3.ts  # BUG-328's honest step sums
node --env-file=.env --import tsx scripts/grocery-b1/probe4.ts  # the unit-token trace

# 3. the digest Hans rules on, by number
node --env-file=.env --import tsx scripts/grocery-b1/digest.ts   # -> out/digest.txt

# 4. the dry run against the 20-list golden corpus
node --env-file=.env --import tsx scripts/grocery-b1/preview.ts  # -> out/preview.txt
```

`proposals.ts` is the data — Y yields, P part edges, X fixes — and is the ONLY
file the digest and the preview read their figures from, so Hans's rulings land
in one place.

`preview.ts` runs the corpus twice: BEFORE through the real production functions
at HEAD, AFTER through a SHADOW of the same pipeline carrying the proposed
changes. Both render through the CLIENT's `composePackName`, the way
`scripts/grocery-census/census.ts` does, so a line here is comparable to the
corpus's own. The shadow is throwaway: Part C changes the real functions.

`out/survey.json` is gitignored (156 KB of machine detail); the three `.txt`
files are the deliverables and are committed.

---

## Parts B–E (September 28, 2026)

```bash
# B — the migration witness (a migrate command is not its own witness)
node --env-file=.env --import tsx scripts/grocery-b1/witness.ts

# B — the reviewed round trip. proposals.ts IS the sheet; digest.ts renders it.
node --env-file=.env --import tsx scripts/grocery-b1/apply.ts --dry-run
node --env-file=.env --import tsx scripts/grocery-b1/apply.ts --apply

# C — the wiring smoke: the REAL production functions over the corpus, no AI
node --env-file=.env --import tsx scripts/grocery-b1/smoke.ts     # -> out/smoke.txt

# D — the deliberate breaks (hash, break, prove red, restore, prove the hash)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/grocery-b1/breaks.ps1

# E — the corpus, re-run at HEAD and diffed
node --env-file=.env --import tsx scripts/grocery-census/census.ts --plans <the 20> --mode live --tag b1 --budget 6
node --env-file=.env --import tsx scripts/grocery-census/check.ts  --tag b1
node --env-file=.env --import tsx scripts/grocery-census/yields.ts --tag b1
node --import tsx scripts/grocery-b1/after.ts                      # -> out/after.txt
```

`probe6/7/8.ts` answer the three questions Part E's diff raised and are kept
because each one is the evidence for a line in the report: which parent claims
`fresh flat-leaf parsley leaves` (6), whether plan `247cd7bb` carries a recipe
override (7), and what f5556c19's lime demand actually is (8).

⚠️ `scripts/grocery-census/yields.ts` reads `pack_yields_REVIEWED.csv`, not the
new `Ingredient.packYield*` columns, so its "NOT COVERED" list is now stale by
construction — it reports `iceberg lettuce` as uncovered while printing the
correct `1 head iceberg lettuce (2 cup)` line beside it. The CSV stopped being
the authority when Part B landed.
