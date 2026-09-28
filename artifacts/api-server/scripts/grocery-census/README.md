# The grocery census harness — Part A (September 28, 2026)

Read-only. Builds a **golden corpus**: real dev plans run through the real
generate pipeline at HEAD, stopped before persistence, and rendered exactly as
the phone composes them. Everything later in the grocery pass measures against
these files.

Run everything from `artifacts/api-server`.

## The one command

```bash
# 1. the corpus (20 plans, live pipeline)
node --env-file=.env --import tsx scripts/grocery-census/census.ts \
  --plans f5556c19,56b03a57,c404a3cf,247cd7bb,14879176,b8e7f134,31c7a885,96a94410,425da049,ed238692,2b6e51a1,6e952e32,a8b0bbd5,316d0846,11653a33,353ce059,14397131,163875ec,d47d18aa,8a462408 \
  --mode live --tag live --budget 6

# 2. reproducibility (5 plans × 3 runs)
node --env-file=.env --import tsx scripts/grocery-census/census.ts \
  --plans 56b03a57,c404a3cf,b8e7f134,96a94410,ed238692 \
  --runs 3 --mode live --tag repro --budget 3

# 3. the AI-REMOVED control (same 20 plans, Sonnet stubbed to an echo)
node --env-file=.env --import tsx scripts/grocery-census/census.ts \
  --plans <same 20> --mode det --tag det --budget 2

# 4. the checker (D1..D8) and the analyses
node --env-file=.env --import tsx scripts/grocery-census/check.ts   --tag live
node --env-file=.env --import tsx scripts/grocery-census/check.ts   --tag det
node --import tsx scripts/grocery-census/compare.ts --mode diff  --tag live
node --import tsx scripts/grocery-census/compare.ts --mode repro --tag repro
node --import tsx scripts/grocery-census/compare.ts --mode ab --a live --b det
node --import tsx scripts/grocery-census/yields.ts  --tag live
```

Plan ids may be given as 8-char prefixes; the harness resolves them and refuses
an ambiguous one.

## The fences, and why each one holds

| fence | how |
|---|---|
| dev branch only | `census.ts` throws unless `DATABASE_URL`'s host contains `ep-broad-haze`. |
| nothing persisted | the harness calls the pipeline's three stages and **returns before** the route's `prisma.$transaction` that creates `GroceryList` / `GroceryListItem`. |
| catalog untouched | every write method on the `ingredient` delegate is proxied to a recorder that applies nothing; `$transaction(array)` is `Promise.all`'d rather than handed to Prisma. Would-be writes are reported per list. |
| no user's ledger touched | AI calls run with `userId` undefined — a system-triggered CLI row. |
| belt and braces | the `.env` role is `cookbook_ro`, which holds `SELECT` and nothing else, so no write is physically possible. `LLMCallLog` inserts therefore fail soft and **cost is measured from the SDK's own token counts** through the same `estimateCostUsdFromRate` the server uses. |

## The render is the client's, not a copy

`census.ts` imports `composePackName`, `formatNeedText` and `renderedPack` from
`artifacts/kiwi/lib/format/grocery.ts` and calls them with the same arguments
`app/grocery-list/[id].tsx:1450,1490` passes, through the wire mapping in
`lib/api/grocery.ts:226`. Nothing about the line is re-implemented here.

## Output

`out/` (gitignored) holds, per run, a `.json` (machine) and a `.txt` (readable):
rendered lines, the pre-AI consolidated rows, the intercepted catalog writes,
and every AI call with its prompt/output hash and token counts. `_findings__*`,
`_ai_diff__*`, `_repro__*`, `_ab__*` and `_yields__*` are the analyses.
