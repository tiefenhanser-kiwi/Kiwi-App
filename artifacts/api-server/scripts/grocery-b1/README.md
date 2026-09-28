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
