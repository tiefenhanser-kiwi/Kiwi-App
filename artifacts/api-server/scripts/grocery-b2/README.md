# [grocery] B2 — NAMES · Part A (September 28, 2026)

Read-only. Everything here measures or previews; nothing writes. Run from
`artifacts/api-server`.

```bash
# 1. the probes — the six questions the columns could not answer
node --env-file=.env --import tsx scripts/grocery-b2/probe.ts   # the subsumes table, by confidence and source
node --env-file=.env --import tsx scripts/grocery-b2/probe2.ts  # how much of it is LIVE, and under which generics
node --env-file=.env --import tsx scripts/grocery-b2/probe3.ts  # casing across every table that stores a name
node --env-file=.env --import tsx scripts/grocery-b2/probe4.ts  # multi-parent children + the buy-name population
node --import tsx            scripts/grocery-b2/probe5.ts       # R1's population on the corpus; the residue shapes
node --env-file=.env --import tsx scripts/grocery-b2/probe6.ts  # why each part still buys its own line; fennel
node --env-file=.env --import tsx scripts/grocery-b2/probe7.ts  # the named cases' edges, label + confidence
node --env-file=.env --import tsx scripts/grocery-b2/probe8.ts  # the clusters at HEAD

# 2. the digest Hans rules on, by number
node --env-file=.env --import tsx scripts/grocery-b2/digest.ts   # -> out/digest.txt

# 3. the dry run against the 20-list golden corpus
node --env-file=.env --import tsx scripts/grocery-b2/preview.ts  # -> out/preview.txt
```

`proposals.ts` is the data — the S classification, the C exception list, the N
cleanings, the P edge and the gate promotions — and is the ONLY file the digest
and the preview read their figures from, so Hans's rulings land in one place.
B1's `scripts/grocery-b1/proposals.ts` has the same job.

`shadow.ts` is a throwaway copy of what Part C will make the real functions do.
Part C changes the real code and this file stops mattering. What it does NOT
re-implement is most of it: the cluster veto, the fold, the merge, the ladder,
the rounding and the Instacart search term are all the shipped functions, called
unchanged. The one genuinely new piece is the REPRESENTATIVE — `buildRelationIndex`
picks the shortest member name, and R5 says the line takes the generic; those
are not the same rule.

## What the dry run changed about its own design

Six times, and each is commented at the place it bit:

1. The containment rule cannot be one symmetric "either contains the other"
   predicate — that turned `3 Bell peppers` into `3 `. It is two rules with
   opposite repairs.
2. It must not run when the client already elided — that turned `1 Yellow onion`
   into `1`.
3. The casing rule is a CATALOG fix, so it cannot touch a row with no
   ingredientId. Applying it per-row moved 64 recurring synthetics.
4. R7 cannot move `canonicalName`: it is `@unique` (18 oil spellings cannot
   share one) and it is the group key (renaming the chicken thighs broke the R5
   fold the same prompt requires).
5. The qualifier's basis is the generic's PRE-augmentation cluster. Against the
   bare generic it reads "at least one fresh flat-leaf"; against the merged
   cluster it disappears.
6. A qualifier only exists where a fold happened — otherwise
   `1 yellow onion (at least one yellow)`.

## Fences

Same as the census: `census.ts`-style host check (`ep-broad-haze`) at the top of
every script that opens a connection. Nothing here writes; `proposals.ts` and
`shadow.ts` never touch Prisma at all.

⚠️ `scripts/grocery-census/README.md` still says the `.env` role is
`cookbook_ro`. That stopped being true when B1 Part B needed to write; the role
is `neondb_owner` now and the host check is what holds the fence.
