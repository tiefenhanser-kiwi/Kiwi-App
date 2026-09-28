# [grocery] B2 — NAMES · Parts A and A2 (September 28, 2026)

Read-only. Everything here measures or previews; nothing writes. Run from
`artifacts/api-server`.

```bash
# 1. the probes — the questions the columns could not answer
node --env-file=.env --import tsx scripts/grocery-b2/probe.ts    # the subsumes table, by confidence and source
node --env-file=.env --import tsx scripts/grocery-b2/probe2.ts   # how much of it is LIVE, and under which generics
node --env-file=.env --import tsx scripts/grocery-b2/probe3.ts   # casing across every table that stores a name
node --env-file=.env --import tsx scripts/grocery-b2/probe4.ts   # multi-parent children + the buy-name population
node --import tsx            scripts/grocery-b2/probe5.ts        # R1's population on the corpus; the residue shapes
node --env-file=.env --import tsx scripts/grocery-b2/probe6.ts   # why each part still buys its own line; fennel
node --env-file=.env --import tsx scripts/grocery-b2/probe7.ts   # the named cases' edges, label + confidence
node --env-file=.env --import tsx scripts/grocery-b2/probe8.ts   # the clusters at HEAD
node --env-file=.env --import tsx scripts/grocery-b2/probe9.ts   # which chicken canonicals actually exist
node --env-file=.env --import tsx scripts/grocery-b2/probe10.ts  # is a DEFAULT derivable from existing columns?

# 2. the record of the ruled classification, and the list Hans still owes
node --env-file=.env --import tsx scripts/grocery-b2/digest.ts    # -> out/digest.txt
node --env-file=.env --import tsx scripts/grocery-b2/defaults.ts  # -> out/defaults.txt   <- Part A2(b)

# 3. the dry run, through the WHOLE pipeline, with the three gates
node --env-file=.env --import tsx scripts/grocery-b2/preview2.ts  # -> out/preview2.txt
```

`proposals.ts` is the data — the H1–H7 classification, the defaults, the casing
exception list, the name cleanings, the part edge, the relabel and the
never-order candidates — and is the ONLY file the digest, the defaults list and
the dry run read their figures from, so Hans's rulings land in one place. B1's
`scripts/grocery-b1/proposals.ts` has the same job.

`shadow.ts` is a throwaway copy of what Part C will make the real functions do.
Part C changes the real code and this file stops mattering. What it does NOT
re-implement is most of it: the cluster veto, the fold, the merge, the ladder,
the rounding, the pack resolution and the Instacart search term are all shipped
functions, called unchanged.

## What replaced what, and why

**Part A's model is gone.** It classified every subsumes edge as QUALIFIER / KEEP
/ GENERIC and folded the QUALIFIER ones onto the generic with an "at least one X"
rider. Hans replaced that wholesale on September 28 with H1–H7: buy what the
recipe says; a plain name joins a ruled default or stays generic; a generic line
carries called-out varieties only when a recipe demanded the generic, and only in
whole counts. `proposals.ts` and `shadow.ts` were rewritten; `digest.ts` now
prints the H class each edge carries.

**`preview.ts` was deleted, and its output with it.** It ran consolidate + merge
and stopped — but pack resolution (`resolvePurchaseFields` ->
`scalePurchaseForSubUnit`) lives INSIDE `generateFinalGroceryList`, so it could
not show a pack change at all: its BEFORE printed `1 head Garlic (25 cloves)`
where B1's Part E printed `3 heads Garlic (25 cloves)`. A dry run that cannot
show a quantity regression is not a dry run, and an unreproducible file of known-
wrong numbers is worse than no file. `preview2.ts` runs the census harness's own
stages and its BEFORE now matches B1's Part E exactly.

## What the dry runs changed about their own design

Each is commented at the place it bit.

From Part A:
1. The containment rule cannot be one symmetric "either contains the other"
   predicate — that turned `3 Bell peppers` into `3 `. It is two rules with
   opposite repairs.
2. It must not run where the client already elided — that turned `1 Yellow onion`
   into `1`.
3. The casing rule is a CATALOG fix, so it cannot touch a row with no
   `ingredientId`. Applying it per row moved 64 recurring synthetics.
4. R7 cannot move `canonicalName`: it is `@unique` (18 oil spellings cannot share
   one) and it is the group key.

From Part A2:
5. H1 must be tested BEFORE the hedges are stripped. A lean ratio is spelled
   exactly like a shrimp count — `80/20` and `16/20` — so stripping first turned
   `ground beef` over `ground beef (80/20 chuck)` into a GENERIC fold.
6. A colour is H3, not H1. H1's "every onion and pepper color" is about SIBLINGS;
   reading it as "always H1" made Hans's own `5 bell peppers, at least 2 red`
   example impossible.
7. A default must name a canonical that EXISTS. `bone-in chicken thighs` — the
   name Hans ruled and the line prints — has no catalog row; the rows are
   `bone-in skin-on chicken thighs` and `bone-in, skin-on chicken thighs`.
8. The defaults list cannot be filtered by the admission gate. The gate is what a
   default has to get past: filtering first proposed ZERO defaults, including the
   one Hans had already ruled.
9. A share is a COUNT THE LINE STATES, not a pack count. Using packs printed
   `at least 1 green` for a demand of two green peppers, because the catalog
   sells them two to a pack.
10. The pinned name and the "moved" test must both be measured against the index
    production builds TODAY, not against the row's own name — otherwise every
    pre-existing synonym fold (`fresh cilantro` -> `cilantro`) is counted and
    renamed as though this block had done it (155 rows).

## Fences

Same as the census: an `ep-broad-haze` host check at the top of every script that
opens a connection. Nothing here writes — `preview2.ts` runs the real pipeline
through the census's intercepting Prisma proxy, so the 52 `Ingredient` writes the
gap-fill attempts are recorded and applied to nothing. `proposals.ts` and
`shadow.ts` never touch Prisma at all.

⚠️ `scripts/grocery-census/README.md` said the `.env` role was `cookbook_ro`.
That stopped being true when B1 Part B needed to write; the role is
`neondb_owner` now and the host check plus the write proxy are what hold the
fence. Corrected there (go-ahead N10).
