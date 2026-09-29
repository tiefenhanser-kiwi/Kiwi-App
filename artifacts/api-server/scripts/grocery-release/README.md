# The grocery data release runbook — PRODUCTION

**Audience: whoever walks Hans through the production deploy.** This file is
self-contained on purpose. You do not need to read the CC chat that produced it,
and you should not have to.

Everything here runs from `artifacts/api-server`, against the PRODUCTION
`DATABASE_URL`, **after** the store approvals and **after** `migrate deploy`.

---

## 0 — Before anything

```bash
# you are where you think you are
git -C "C:\Cooking App\Kiwi-App" log --oneline -1

# the database is the one you think it is. PRINT NOTHING ELSE.
node -e "const u=new URL(process.env.DATABASE_URL);console.log('host',u.hostname,'user',u.username)"
```

- The production host is **not** `ep-broad-haze*`. That string is the DEV branch,
  and every script under `scripts/grocery-b1/` and `scripts/grocery-b2/` **throws
  unless it sees it**. So each apply below is run with an explicit
  `DATABASE_URL` and the guard temporarily satisfied — see §1's note. Do not
  edit `.env`.
- Take a Neon branch/snapshot first. Both applies are idempotent, neither
  deletes, but a snapshot is the only thing that makes "undo" a sentence rather
  than a project.

> ⚠️ **`--shadow-database-url` RESETS the database it is pointed at.** It wiped
> the Neon dev branch on 2026-09-18. Never pass it here. Generate SQL with
> `migrate diff --from-url` and apply with `migrate deploy` only.

---

## 1 — The migration (B1's four columns)

**Name:** `20260928200000_grocery_b1_pack_yield`
**What it does:** four additive, nullable columns on `ingredients` —
`packYieldUnit`, `packYieldPerPack`, `packYieldSource`,
`packYieldReviewedByHuman` (default `false`). Nothing is dropped or renamed.

```bash
npx prisma migrate status    # expect: 1 migration not yet applied
npx prisma migrate deploy
npx prisma migrate status    # expect: Database schema is up to date
```

**B2 adds NO migration.** Everything in step 3 writes columns that already
exist plus `ingredient_relations` rows. If `migrate status` shows a second
pending grocery migration, stop — something is here that this runbook does not
describe.

### The DATABASE_URL note, once, for both applies

Each apply begins with

```ts
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
```

That guard exists so a dev-lane script cannot reach production by accident. For
the production run it has to be satisfied deliberately and visibly. Do it by
**passing the production URL explicitly and editing the guard in a throwaway
branch**, or by whatever the team's standard production-script mechanism is —
but do it in a way that shows up in a diff. Do not weaken the guard on `next`,
and do not edit `.env`.

---

## 2 — B1's apply — the pack yields

```bash
node --env-file=<prod-env> --import tsx scripts/grocery-b1/apply.ts --dry-run
node --env-file=<prod-env> --import tsx scripts/grocery-b1/apply.ts --apply
```

**69 reviewed rows**, every one `source: human` / `reviewedByHuman: true` /
`reviewedAt`:

| class | rows |
|---|---|
| Y pack yields | 42 |
| P1 basis admissions | 7 |
| P3 component edges | 6 (2 of them new) |
| P4 synonym edges | 1 |
| X salt row | 1 |
| X pack fixes | 5 |
| X category fixes | 4 |
| X BUG-328 re-times | 3 |

- **first run:** 69 written (created + updated), 0 unchanged.
- **re-run:** `0 created, 0 updated, 69 unchanged`.

**Then the witness.** A migrate command is not its own witness:

```bash
node --env-file=<prod-env> --import tsx scripts/grocery-b1/witness.ts
```

It reads the columns twice — through `information_schema` for the types and
defaults, and through the generated client for the values — because a stale
client would make the second read lie on its own.

---

## 3 — B2's apply — the names

```bash
node --env-file=<prod-env> --import tsx scripts/grocery-b2/apply.ts --dry-run
node --env-file=<prod-env> --import tsx scripts/grocery-b2/apply.ts --apply
```

**Runs after step 2, and the order is load-bearing:** B2's `Y` class writes the
pack-yield columns step 1 creates, and reads `purchaseUnit` values step 2 may
have fixed.

| class | what it writes | first run | re-run |
|---|---|---|---|
| N buy names | `Ingredient.displayName` — the 16 neutral-oil spellings → `vegetable oil`, the 13 `skin-on` rows → the cut without it, the tortilla/mozzarella/rice/ground-beef shapes, the three parts | 39 updated · 3 unchanged | 0 · 42 unchanged |
| C casing | `Ingredient.displayName` — the leading character lowercased where the leading token is not a proper noun | 116 updated · 1,622 unchanged | 0 · 1,738 unchanged |
| D defaults | `reviewedByHuman` / `reviewedAt` / `rationale` / `source` on **2** `subsumes` rows (`chicken thighs ⊇ bone-in skin-on chicken thighs`, `chicken breast ⊇ boneless skinless chicken breasts`) | 2 updated | 0 · 2 unchanged |
| Y BUG-330 | `cherry tomatoes` pack yield — 10 ounce per pint | 1 updated · 1 skipped | 0 · 1 unchanged · 1 skipped |
| R N6 relabel | `romaine lettuce → romaine lettuce hearts`, `component` → `synonym`, yield cleared | 1 updated | 0 · 1 unchanged |
| P fennel edge | `fennel bulb → fennel fronds`, component, 3 tbsp, coHarvestable | 1 created | 0 · 1 unchanged |
| **TOTAL** | | **1 created · 159 updated · 1,625 unchanged · 1 skipped** | **0 created · 0 updated · 1,785 unchanged · 1 skipped** |

**The 1 skipped is expected, on both runs.** `grape tomatoes` has no catalog row;
the figure is recorded in `scripts/grocery-b2/proposals.ts` so nobody re-derives
it, and the apply refuses to mint a row it has no ruling for.

### If the first-run numbers do not match

The counts above were measured on the DEV branch. A production catalog that has
drifted will differ, and the two safe readings are:

- **fewer updates than listed** — production already has some of these names.
  Fine; the class totals (updates + unchanged) should still add to the same row
  count (1,780 ingredients at the time of writing).
- **a `SKIP … no catalog row`** — production is missing an ingredient dev has.
  The skip is reported by name. That row simply does not get its rename; nothing
  else is affected.

Anything else — a different TOTAL row count, an unexpected `created` — means the
catalogs have diverged in a way this runbook did not anticipate. Stop and
compare before `--apply`.

---

## 4 — What is NOT in this runbook, and where it lives

- **The code.** B1's and B2's Part C changes ship with the server build, not with
  a script. Nothing here needs running for them.
- **`NEVER_ORDER_CANONICALS`** (the eight cooking by-products B2 added) is a code
  constant in `src/lib/groceryStaples.ts`. It ships with the build.
- **The `RULED_SUBSUMES_DEFAULTS` constant** in `src/lib/ingredientRelations.ts`
  is what promotes the two default edges past the confidence gate. Step 3 makes
  the DATA carry the same decision, so the table is readable on its own — but the
  code constant is what the runtime reads. Both ship; neither alone is enough.
- **User data is never touched.** D-WS9-230: `GroceryListItem` rows keep their
  names, including the 1,359 with a leading capital. The fix is forward-only, on
  the shared catalog a new user would inherit.

---

## 5 — After

```bash
# the relation table's shape, as a sanity read
node -e "…"   # or just: npx prisma studio, and look at ingredient_relations
```

Generate one grocery list on production for a real plan and read it. The four
things to look for:

1. no line says `neutral oil`;
2. a chicken-thigh plan says `bone-in chicken thighs`, and a boneless-skinless
   recipe still gets its own line;
3. no line repeats its own name (`1 rotisserie chicken rotisserie chicken, …`);
4. a plan needing 12 oz of cherry tomatoes says **2 pints**, not 1.
