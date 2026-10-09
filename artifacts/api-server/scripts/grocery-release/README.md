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
  and every data script in this runbook **throws unless it sees it** — or unless
  `KIWI_PRODUCTION_HOST` names the host exactly. So each apply below is run with
  an explicit `DATABASE_URL` and that override — see §1's note. Do not edit
  `.env`.
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
npx prisma migrate status    # expect: SEVEN migrations not yet applied (below)
npx prisma migrate deploy
npx prisma migrate status    # expect: Database schema is up to date
```

> 🔴 **Corrected 2026-10-04 (Resubmission B1).** Against the production image of
> September 23, `migrate status` lists **seven** pending migrations, not one —
> every migration added to `next` since then, applied together by the one
> `migrate deploy`, in this order:
>
> 1. `20260925170000_row13_b1_guest_sessions`
> 2. `20260926221500_row13_b1b_signup_source_nudge`
> 3. `20260927120000_row9_oauth_user_identities`
> 4. `20260927210000_row9_stripe_s1_billing_mirror`
> 5. `20260928200000_grocery_b1_pack_yield` (this section's)
> 6. `20260929180000_grocery_b4_pack_count` (B4.1's)
> 7. `20261004120000_resub_b1_billing_sources` — **hand-edited RENAMEs**
>    (`stripeUpdatedAt` → `sourceUpdatedAt`, `stripe_events` →
>    `billing_events`); it drops `subscriptions.earlyPayBonusApplied`.
>
> Any other name in the list, or a different count: stop. All seven are applied
> on dev.

**B2 adds NO migration.** Everything in step 3 writes columns that already
exist plus `ingredient_relations` rows. If `migrate status` shows a second
pending grocery migration, stop — something is here that this runbook does not
describe.

### The DATABASE_URL note, once, for both applies

Every script this runbook runs opens with `assertScriptDatabase(…)`
(`src/lib/scripts/requireDatabaseHost.ts`, R3-0). It passes a host containing
`ep-broad-haze` (dev, as before) and **throws on everything else** — so a
dev-lane script cannot reach production by accident.

> 🔴 **The production run is one environment variable, typed by hand:**
> `KIWI_PRODUCTION_HOST` set to the production hostname — the EXACT string §0
> printed, full and case-sensitive; a prefix, a URL or a typo throws. A match
> prints `PRODUCTION host … (KIWI_PRODUCTION_HOST matched)` to stderr: if you do
> not see that line, you are not on production. Set it in the shell for the run,
> never in `.env`, and unset it afterwards. Do not edit a guard.

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
| D defaults | `reviewedByHuman` / `reviewedAt` / `rationale` / `source` on **2** `subsumes` rows (`chicken thighs ⊇ boneless skinless chicken thighs`, `chicken breast ⊇ boneless skinless chicken breasts`) | 2 updated | 0 · 2 unchanged |
| D-rev reversal | clears `reviewedByHuman` and replaces the rationale on **1** row — `chicken thighs ⊇ bone-in skin-on chicken thighs`, which was the default for two hours on September 28 before Hans reversed it. **On a fresh production database this is 0 updated / 1 unchanged**: nothing ever stamped it there, and the class carries the reversal already. | 0 updated · 1 unchanged | 0 · 1 unchanged |
| Y BUG-330 | `cherry tomatoes` pack yield — 10 ounce per pint | 1 updated · 1 skipped | 0 · 1 unchanged · 1 skipped |
| R N6 relabel | `romaine lettuce → romaine lettuce hearts`, `component` → `synonym`, yield cleared | 1 updated | 0 · 1 unchanged |
| P fennel edge | `fennel bulb → fennel fronds`, component, 3 tbsp, coHarvestable | 1 created | 0 · 1 unchanged |
| **TOTAL** | | **1 created · 159 updated · 1,626 unchanged · 1 skipped** | **0 created · 0 updated · 1,786 unchanged · 1 skipped** |

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
2. a plan whose recipe says plain "chicken thighs" reads **boneless skinless
   chicken thighs** — and a recipe that names **bone-in** still gets its own line,
   without the words "skin-on";
3. no line repeats its own name (`1 rotisserie chicken rotisserie chicken, …`);
4. a plan needing 12 oz of cherry tomatoes says **2 pints**, not 1.

---

# B3 — RECURRING ITEMS + RIDERS (D-WS9-284, September 29 2026)

B3 adds **no migration**. Everything below writes columns and rows that already
exist. Ruling 1 chose "option (c), no migration": a recurring text is resolved at
every generation and nothing is persisted per user.

## B3.1 — The data apply

```bash
node --env-file=.env --import tsx scripts/grocery-b3/apply.ts --dry-run
node --env-file=.env --import tsx scripts/grocery-b3/apply.ts --apply
node --env-file=.env --import tsx scripts/grocery-b3/apply.ts --apply   # idempotence: all unchanged
```

Ten rows, three classes. Expected on a clean production catalog:

| class | rows | what |
|---|---|---|
| P1 sandwich-bread pack | 1 update | `sandwich bread` → `1 loaf (20 oz, 22 slices)` |
| P2 pack yields | 5 updates | `romaine lettuce hearts` → 6 cup per 2-pack; the four broth rows → **1.75** cup per can. All reviewed. |
| P3 broth edge promotions | 4 updates | four `subsumes` edges → `reviewedByHuman: true`; **no label and no confidence moves** |

**The same `DATABASE_URL` note as B1/B2 applies** — the script throws unless the
host contains `ep-broad-haze`, so a production run needs the guard satisfied
explicitly. Do not edit `.env`.

`apply.ts` REFUSES a P3 row whose label is not `subsumes`. A promotion must never
change a label; if production's edge says something else, stop and compare.

> ⚠️ **1.75, not 1.8125.** "14.5 oz" on a broth can is NET WEIGHT, not fluid
> ounces; the labels say "about 1¾ cups". Dividing 14.5 by 8 treats a weight
> ounce as a fluid ounce, over-states the pack by 4.3% and therefore UNDER-buys
> at the boundary (a 7¼-cup need orders 4 cans at 1.8125 and 5 at 1.75). B1's
> rule stands: the lower honest figure buys more.
>
> ⚠️ **The four broth pack yields are the reason the promotion is safe to ship.**
> Without them the fold lands and its "at least 1 low-sodium" rider does not,
> because the share is stated in cups and nothing relates a cup to a can — which
> would REMOVE the word "low-sodium" from a list that used to carry it on its own
> line. They also fix a pre-existing under-buy: a plan needing 8 cups of broth
> ordered one 14.5 oz can. Deploy P2 and P3 together or neither.

### What is expected to differ on production

- **`SKIP … no catalog row` / `no edge`** — production is missing a row or a
  judged pair dev has. Reported by name; nothing else is affected.
- **`==` on a row** — production already carries the value. Fine.

## B3.2 — What ships with the build, not with a script

- **The recurring purchase defaults** (`paper towels`, `toilet paper`,
  `pet treats`, `coffee`, and `milk`'s gallon) are keys in
  `INGREDIENT_CONVERSIONS`, `src/lib/ingredientConversions.ts`. Code, not data —
  that is what ruling 1's option (c) means. Nothing to run.
- **The Household rule's five new phrases** (`pet`, `dog food`, `dog treats`,
  `cat food`, `cat litter`) are keywords in `inferCategory`,
  `src/lib/ingredientResolve.ts`. `inferCategory` runs at ingredient CREATE time
  only, so existing rows keep their category; swept over all 1,780 dev catalog
  names, **0 rows change**.
- **The recurring grade map** (`egg` / `eggs` → `large eggs`) is a code constant
  in `src/lib/groceryList.ts`, applied to recurring text only. D-WS9-228: this
  is an alias-precedence change, not a fold — the two catalog rows stay
  separate and the `distinct` edge stands.
- **Rule 3** (`pathKey` on the wire, and the widened `selectDefaultPathSteps`)
  and **BUG-320** are code. Nothing to run.

## B3.3 — After

Generate one grocery list on production for a user who has recurring items.

1. `milk` reads **1 gallon whole milk**, and where the plan also cooks with milk
   the line says so beside it — never one line for each;
2. a plan needing lemons shows **one** lemon line with the split, not two;
3. `paper towels` reads the same pack it read last week;
4. nothing on the list is the word `milk`, `bread`, `eggs` or `limes` — those are
   what the user typed, not what the catalog calls the food.

---

# B4 — PACK YIELDS + THE `packCount` WIRE FIELD (D-WS9-286, September 29 2026)

B4 adds **one migration** (`grocery_b4_pack_count`, a nullable Int column) and
**88 catalog updates**. Deploy the migration BEFORE the build that emits the
field, as usual.

## B4.1 — The migration

```bash
npx prisma migrate status    # expect: nothing pending if §1's deploy already ran
                             # (it applies all seven, this one included)
npx prisma migrate deploy
npx prisma migrate status    # expect: Database schema is up to date
```

`grocery_list_items.packCount INTEGER` — additive, nullable, nothing dropped or
renamed. Existing rows read NULL, which is exactly the documented "the server
could not compute one" value, so a list generated before this deploy renders on
the old client path with no migration of its data.

> ⚠️ **`--shadow-database-url` RESETS the database it is pointed at.** It wiped
> the Neon dev branch on 2026-09-18. This migration was hand-written for that
> reason. Never pass that flag here.

## B4.2 — The data apply

```bash
node --env-file=.env --import tsx scripts/grocery-b4/apply.ts --dry-run
node --env-file=.env --import tsx scripts/grocery-b4/apply.ts --apply
node --env-file=.env --import tsx scripts/grocery-b4/apply.ts --apply   # all unchanged
```

95 proposals, of which **88 update** and **7 are refused** on a clean dev
catalog. Expected totals: `updated 88 · unchanged 0 · guarded 0 · no row 0 ·
refused 7`.

| what | why |
|---|---|
| **updated 88** | a pack yield derived from the pack's own label, on a row that had none |
| **refused 7** | the catalog row carries no `purchaseUnit`, so a ladder has no parent and the yield could never fire. On dev these are rows whose pack only ever existed as an intercepted gap-fill answer; on production they may well have one, in which case they load instead of refusing. Either outcome is correct — read the names it prints. |
| **guarded N** | the row already carries a yield and is NOT overwritten. Expect 0 on a catalog that has had B1/B3 applied in order, and a non-zero count if production already learned a yield some other way. Never force it. |

### What the figures are, and what they are not

Every one comes from the size or count the row's own `purchaseDisplay` already
states. None is from a model. Four rules, and the third and fourth are the ones
that bite:

1. a natively volumetric size (ml, quart, fl oz) is a volume;
2. a count on the label is a count, in `each` — the unit the recipes state;
3. a range takes its **lower** bound;
4. a weight size needs a **density**; `oz ÷ 8` is what over-stated a broth can by
   4.3% in B3·F, and 72 spice canonicals have no density and are therefore not
   in this sheet at all.

And "oz" on a label is ambiguous: a bottle of oil means fluid ounces, a tub of
sour cream means net weight. Both readings are taken where both are admissible
and the lower wins — but the fluid reading is admissible **only from a bottle,
carton or jug**.

## B4.3 — What ships with the build

- **`packCount`** on every grocery-list item, emitted by `resolvePurchaseFields`
  — the same code that already scales the display, so nothing computes twice.
  The client trusts it when present and parses `purchaseDisplay` only when it is
  null.

  > ⚠️ **The Instacart order does NOT use it, and that is deliberate (N14).** An
  > order total is `packs x the per-pack SIZE`, and `purchaseQuantity` is that
  > size only on an unscaled row — when the server scales a pack it writes the
  > COUNT there instead and the size survives only inside the display string.
  > The only discriminator on the wire, `purchaseQuantity === packCount`, is a
  > coincidence: true of 579 corpus rows of which 71 are actually scaled.
  > Trusting it ordered 2 lb against a 3.75 lb need on three of them. The order
  > path keeps its own arithmetic, which is correct for both shapes.
- **The same-unit rule in Gate 1** (the census harness) and **N11's split fix**
  in `recurringFacetsFor`. Neither touches stored data.

## B4.4 — After

Generate one grocery list on production for a plan with a canned or boxed
ingredient in it.

1. a plan needing 8 cups of broth reads **5 cans**, not 1;
2. a plan needing 12 tortillas reads **2 packages** of a 10-count pack;
3. a staple still reads its need and **no pack** — that is D-WS9-221, not a bug;
4. nothing reads a fractional pack;
5. a count above one reads a PLURAL pack noun — "4 cans (14.5 oz)", not "4 can".
   B4 moved the scaling of those rows from the client to the server, and whoever
   writes the count owns its plural.

---

# IMG — MEAL IMAGES (BUG-332 / D-WS9-288, September 29 2026)

🔴 **NOTHING IN THIS SECTION RUNS TODAY.** Every step here changes production
data, and the App Store review freeze forbids that. Each one waits for Hans to
say so, individually. The code half of D-WS9-288 ships with the build and needs
none of this.

**What the code half already fixed, so you do not run a script for it:** a fork
no longer inherits `failed` (`inheritedImageStatus`), a full rematerialize
re-queues a `failed` meal (`rematerializeMeal`), and the house prompt no longer
shows packaging or a whole roast shrunk onto a plate (`buildHousePrompt`). From
the build forward, NEW rows are right. These steps are only about rows that
already exist.

## IMG (a) — re-queue the rows the September-18 backfill marked `failed`

**What they are.** The Block 1c migration
(`20260918161800_ws9_row5_b1c_image_queue`) wrote `imageStatus = 'failed'` onto
every user-authored meal that had no image — 282 rows by its own note, 290 on
the 2026-09-27 dev copy. **All 290 sit at `imageAttempts = 0`**: not one was
ever a real generation failure. `failed` is terminal (the drain claims only
`pending`), so they render the warm gradient permanently.

**Which rows is Hans's call.** Both scopes are written out; run ONE.

Cost, at the measured $0.0088 per image and the org limit of 5 images/minute:

| scope | rows | cost | drain time |
|---|---|---|---|
| all | ~290 | ~$2.55 | ~58 min |
| named accounts only | as selected | rows x $0.0088 | rows / 5 min |

```sql
-- FIRST, ALWAYS: what you are about to change. SELECT only.
SELECT count(*) FILTER (WHERE "imageAttempts" = 0) AS backfilled,
       count(*) FILTER (WHERE "imageAttempts" > 0) AS really_struck_out,
       count(*) AS total
FROM "meals"
WHERE "imageStatus" = 'failed' AND "imageUrl" IS NULL AND "userId" IS NOT NULL;
```

```sql
-- SCOPE 1 — ALL of them.
-- `imageAttempts = 0` is deliberate: it re-queues ONLY the backfill rows and
-- leaves alone anything that genuinely used its three strikes.
UPDATE "meals"
SET "imageStatus" = 'pending'
WHERE "imageStatus" = 'failed'
  AND "imageUrl" IS NULL
  AND "userId" IS NOT NULL
  AND "imageAttempts" = 0;
```

```sql
-- SCOPE 2 — NAMED ACCOUNTS ONLY. Edit the email list; nothing else.
-- The App Store reviewer account is the one that showed the bug: it signed up,
-- built a plan from a template, and every meal in it forked a seed meal the
-- migration had marked `failed` — eight imageless meals, sixty seconds in.
UPDATE "meals" m
SET "imageStatus" = 'pending'
FROM "users" u
WHERE u."id" = m."userId"
  AND u."email" IN (
    'reviewer@kitchenwizard.ai',
    'hans.tiefenthaler+8@gmail.com'
  )
  AND m."imageStatus" = 'failed'
  AND m."imageUrl" IS NULL
  AND m."imageAttempts" = 0;
```

⚠️ **Re-queue the PARENTS too, or the children pay for it twice.** The seed
meals the reviewer plan forked (`dev-meal-*`) are themselves `failed`. With the
D-WS9-288 code shipped, a NEW fork of one starts `pending` and generates its own
image, so this is no longer a correctness problem — but a re-queued parent gets
ONE generation that every later fork inherits, instead of one generation per
fork. Scope 2 misses those parents if they belong to another account; check with
the SELECT above before choosing a scope.

**After:** the drain picks them up within a minute, five a minute. Watch it with
IMG (b). There is nothing to verify by hand beyond "the gradients became
photographs".

## IMG (b) — is the drain actually running?

The drain route **fails closed**: with either env var unset,
`POST /api/internal/images/drain` answers **404 to every caller**, including
Cloud Scheduler, and logs `image_drain_not_configured` once per process. A
scheduler job pointed at such a revision shows up as a failing job rather than a
silent no-op — but only if somebody looks.

**Cloud Run must carry both** (`src/routes/internal.ts`):

- `IMAGE_DRAIN_OIDC_EMAIL` — the scheduler job service-account email
  (comma-separated allowlist)
- `IMAGE_DRAIN_OIDC_AUDIENCE` — the `aud` the job was created with; by Cloud
  Scheduler default that is the drain URL itself

```sql
-- Query 4 of kiwi-local-tools/bug332/production-read.sql. SELECT only.
-- One row per hour for three days. A GAP is the finding: the scheduler did not
-- fire, or fired at a revision whose drain answers 404.
SELECT date_trunc('hour', l."createdAt") AS hour,
       l."success", l."failureReason",
       count(*) AS n,
       round(sum(l."costEstimateUsd")::numeric, 4) AS usd
FROM "llm_call_logs" l
WHERE l."promptKey" = 'images.generate'
  AND l."createdAt" > now() - interval '3 days'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2;
```

```sql
-- And the queue depth. `pending` older than a few minutes means stalled, not
-- busy. `generating` older than five minutes should already have been swept
-- back to `pending` by the next claim (IMAGE_STUCK_AFTER_MINUTES).
SELECT "imageStatus", count(*) AS n,
       min("createdAt") AS oldest_created, min("updatedAt") AS oldest_touched
FROM "meals" WHERE "imageStatus" IN ('pending', 'generating') GROUP BY 1;
```

## IMG (c) — re-generate the whole-item catalog images

🔴 **THIS REPLACES SHARED CATALOG IMAGES IN THE PRODUCTION BUCKET.** Every id in
the list is `ready` with a live URL today, and the object key is
`meals/<mealId>.jpg` — a re-generation OVERWRITES it, for every user whose plan
contains that meal and for every published Cookbook page. It is not additive and
there is no undo beyond generating again. **It waits for Hans, separately from
(a) and (b).**

**Why.** Two live Cookbook pages showed a whole roast chicken scaled down onto a
dinner plate — "either a really big side or a really small bird" (Hans,
2026-09-29). The old prompt asked for "a single plated serving" and the model
sized the whole bird to the plate instead of carving it. D-WS9-288 ruling 1b
added the portion-and-scale sentence; these rows were generated before it.

**The list:** `scripts/grocery-release/bug332-whole-item-meals.json` — 35
confirmed of 51 pattern hits, swept read-only over 1,309 public meals, with the
16 rejections and the reason for each. 33 of the 35 are on the Cookbook.

**Order matters:**

1. The build carrying the D-WS9-288 `buildHousePrompt` must be live on
   production. Re-queuing before that re-generates with the OLD prompt and buys
   nothing.
2. Re-queue the 35:

   ```sql
   -- Paste the 35 ids from bug332-whole-item-meals.json.
   -- imageUrl is NULLED on purpose. The drain claims `pending` rows and
   -- markReady overwrites the URL either way, but leaving the old URL in place
   -- keeps the card showing the OLD photo until the new one lands; nulling it
   -- shows the gradient for that minute instead. Which is worse is Hans call;
   -- the statement is written for the honest version.
   UPDATE "meals"
   SET "imageStatus" = 'pending', "imageAttempts" = 0, "imageUrl" = NULL
   WHERE "id" IN ('316a0ecc-...', ...);
   ```

3. ~35 images at 5 a minute is about **7 minutes, ~$0.31**. Watch with (b).
4. **Then, and only then**, the Cookbook: `--regenerate` over the affected
   slugs, so the static pages pick up the new bucket URLs. A Cookbook build run
   before the drain finishes republishes the OLD images.
5. Look at three of the rebuilt pages. A whole bird should now be a leg and
   thigh or a few slices, at plate scale, beside its sides.

## IMG — what is NOT here

- **Changing the image model.** `gpt-image-1-mini` shuts down **December 1,
  2026** (announced June 2, 2026; the named replacements are
  `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare`). D-WS9-288 deliberately did
  not touch the model — a swap re-opens the house prompt calibration and the
  per-image cost. It is its own block and it is owed before that date.
- **A retry affordance for a genuinely `failed` meal.** Today the only way out
  of `failed` is a full rematerialize (D-WS9-288 ruling 3) or one of the SQL
  statements above. No UI exposes it.
- **Telling the client anything about `imageStatus`.** The phone receives
  `imageUrl` and nothing else, so `pending`, `generating`, `failed` and a
  ready-but-dead URL all render the same warm gradient. That is the ruled
  terminal state (D-WS9-246), not an oversight — but it is also why this
  arrived as a bug report rather than as a metric.

---

# ⛔ BLOCK F — AFTER APPROVAL

**Everything in this section waits for Hans's explicit go-ahead on production.**
Each step is dev-verified and none of it has run against production.

## F.1 — The data apply: F2, F3 and F4's catalog rows (AFTER APPROVAL)

```bash
node --env-file=.env --import tsx scripts/grocery-f/catalog-sweep.ts   # read-only
node --env-file=.env --import tsx scripts/grocery-f/catalog-fix.ts     # dry
node --env-file=.env --import tsx scripts/grocery-f/catalog-fix.ts --apply
node --env-file=.env --import tsx scripts/grocery-f/catalog-sweep.ts   # 0 outliers
```

27 field updates on a clean dev catalog — 2 for F2, 8 for F3, 17 for F4.

| what | why |
|---|---|
| **F2 · 2 rows** | `tomatillo` / `tomatillos` lose a `(~3–4 tomatillos)` count hint that was both factually wrong (a medium tomatillo is ~2 oz, so ~8 to the pound) and the only place the line named the food. It feeds no arithmetic: `packSizeHint` needs the hint's unit to relate to the need's through the weight or volume table, and "tomatillos" is in neither. |
| **F3 · 4 rows × 2 fields** | a single-container pack authored as two — `cream of chicken soup` at `2 cans (10.5 oz each)`, plus canned black beans, red kidney beans and Near East rice pilaf. The list was faithfully printing what the catalog told it. |
| **F4 · 17 rows** | `Ingredient.category` outliers, each with correctly-filed siblings: one vinegar in Produce (11 others in Pantry), five condensed soups split between Protein and Produce (none in Canned), eleven fresh chiles and tomatillos in Pantry (four in Produce). |

**⚠️ The sweep may find MORE on production than on dev,** and that is the point
of running it first. `catalog-fix.ts` writes a fixed, named list; anything the
sweep reports that the fix does not name is a new row and needs a ruling, not a
widened script.

**`pouch sticky rice` (`2 pouches`) is deliberately NOT fixed.** Microwave rice
pouches genuinely ship as 2-packs, so the stored value may be right. It is
reported by the sweep on every run until someone rules on it.

## F.2 — BUG-334: the amount refs that print their fraction twice (AFTER APPROVAL)

```bash
node --env-file=.env --import tsx scripts/grocery-f/bug334-repair.ts          # dry
node --env-file=.env --import tsx scripts/grocery-f/bug334-repair.ts --apply
node --env-file=.env --import tsx scripts/grocery-f/bug334-repair.ts          # public → 0
```

**Order matters, and this one is genuinely optional.**

1. **The build carrying the render guard must be live first.**
   `kiwi/lib/cooking/amountSegments.ts` refuses a ref whose unit opens with a
   number and renders the authored text instead, so every affected step reads
   correctly *with no data written at all*. That is what makes this apply
   cleanup rather than the fix.
2. Then the repair. Dev figures: **3,266 corrupt refs → 2,494 written** across
   2,312 steps and 1,521 **public** dishes.
3. **772 refs on 492 user-owned dish copies are NOT written** — D-WS9-230, fixes
   are forward-only for user data. The guard is what serves them, permanently.
   So a post-apply re-run reporting a non-zero corrupt count is CORRECT: the
   expected residue is exactly the user-owned copies.

**The script refuses to write on anything but a clean dry run.** Every repair is
checked against the authored span at `[charStart, charEnd)` before it is
accepted, and a ref whose repaired quantity does not reproduce the text a reader
sees is skipped and printed. Dev: 0 refused. If production refuses any, read the
names — do not pass a flag.

Two classes, opposite arithmetic, and a single-class repair gets one wrong:

- **glyph** (3,263 on dev) — `{q: 1.5, u: "½ cups"}`. The quantity is already
  right; only the unit repeats the fraction. Quantity untouched.
- **digit** (3 on dev, **all three on user-owned dishes**, so none is written) —
  `{q: 1, u: "1/2 tablespoons"}`. The fraction is *lost*, not duplicated, and the
  quantity must be raised to 1.5.

## F.3 — `retailer.instacart_enabled` (AFTER APPROVAL — and probably NOT)

Block F set this **true on DEV only**, so device-pass item 11 could be tested at
all. Production is a separate decision and is not part of this runbook: turning
it on exposes the Order Online surface to every user.

```bash
# DEV ONLY. The script's host check refuses anything but ep-broad-haze.
node --env-file=.env --import tsx scripts/grocery-f/instacart-dev.ts --enable
```

## F.4 — What ships with the build, not with a script

- **D-WS9-292** — fresh meat, poultry and seafood bought by weight
  (`src/lib/freshProtein.ts`, gated in `resolvePurchaseFields`). **Writes no
  catalog row**: the stored pack keeps its value and simply stops being consulted
  for this class, so the whole rule reverts by deleting one block.
- **F5.2** — `pluralizeCountUnit` in `ingredientConversions.ts`, read by
  `formatMeasure`, so the Prep the Week text stops saying "3 stalk celery".
- The client-side rules (F2's two render rules, F5.1/5.3/5.4/5.5, BUG-334's
  guard) ship in `artifacts/kiwi/lib/**`.

---

# ⛔ PREPCOOK — THE PREP & COOK PASS (BUG-337 / BUG-338, September 30 2026)

**Everything in this section waits for Hans's explicit go-ahead on production.**
Dev-verified; none of it has run against production. Run the three in the order
below — the re-stamp reads the step text the second one fixes, so a reversed
order leaves two meals stamped from the old rows.

The pass's code ships with the build (the scheduler, the client footer, the prep
engine and assembly). Only these three touch data.

## PREPCOOK (a) — the dish text the census found duplicated (AFTER APPROVAL)

```bash
node --env-file=.env --import tsx scripts/prep-cook-census/fix-k-r4.ts          # scan, writes nothing
node --env-file=.env --import tsx scripts/prep-cook-census/fix-k-r4.ts --apply
node --env-file=.env --import tsx scripts/prep-cook-census/fix-k-r4.ts          # → 0 remaining
```

One step, in the Carne Asada dish, whose whole body points at another dish's
work: *"While the steak rests, warm the corn tortillas (see Warm Corn Tortillas
dish)."* The Warm Corn Tortillas dish is in the same meal and the scheduler
already interleaves it, so the meal warmed 12 tortillas twice. 2 rows on dev, one
of them CATALOG (`userId` null); production may hold more or fewer, and the scan
prints each with its owner before anything is written.

> 🔴 **`RecipeInstructionStep` HAS TWO TEXT COLUMNS.** `stepTextRaw` and
> `stepTextTranslated`, and `toStepShape` (`src/routes/meals.ts`) renders the
> **translated** one — that is what the cook reads. The first dev run wrote only
> `stepTextRaw`, the screen did not change, and a scan of the raw column reported
> the fix as applied. They are identical on all 30,718 dev rows, which is exactly
> why the mistake was invisible. **This script now writes both, and anything else
> that edits step text must too.**

Every run leaves `out/k-r4-<stamp>.json`; `--revert <that file>` restores both
columns.

## PREPCOOK (b) — re-stamp the derived meal times (AFTER APPROVAL)

```bash
node --env-file=.env --import tsx scripts/prep-cook-census/restamp.ts --scan     # default; writes nothing
node --env-file=.env --import tsx scripts/prep-cook-census/restamp.ts --apply
```

`Meal.estimatedTimeMinutes` / `activeTimeMinutes` are stamped from
`cookingScheduler` at save time. B1 changed the scheduler — a latest bound on a
step following heat, served-cold dishes pulled into passive windows, and the
cook's hands modelled as a busy SET rather than a high-water mark — so every
stored stamp predates the code that produced it.

**Dev moved 23 of the 54 corpus meals** (delta min −21, median −3, max +5). A
bare invocation is `--scan` and cannot write. Omitting `--plans` scans the whole
catalog, which is what production wants; expect the count to be far larger than
23 and read the distribution it prints before applying.

> 🔴 **BUG-341 — RUN THIS WITHOUT `--plans`, AND THAT IS THE WHOLE POINT.** The
> B1 dev run was scoped to the census's 13 plans, so it repaired 23 meals and
> left the rest of the catalog stamped by the pre-B1 scheduler. The QA harness
> then read five plans off the rendered screen and found Cook Mode disagreeing
> with the card on **9 of 25 meals**; the unscoped scan found **791 of 2,042**
> (delta min −43, p25 −6, median −2, p75 −1, max +18). Applied on dev
> 2026-10-01 00:28Z → re-scan reports 0 stale. **Production is the same catalog
> and will hold the same class.** Nothing is wrong with the two readers:
> `deriveMealTiming` reproduced `runCookingSequence` on all 89 rows measured
> (public + forks), every time. The stamp was simply older than the scheduler.
>
> Forks are not a separate step. `POST /plans/from-meals` copies the stamp at
> fork time and never re-derives it, so a fork made before a scheduler change
> keeps the old number for ever (two such rows are still on dev, from August).
> The unscoped scan covers every non-archived meal, forks included — which is
> why it is 2,042 and not the catalog count.

Every run leaves `out/restamp-<stamp>.json`; `--revert <that file>` restores the
previous pair on every row it touched. `--scan` also writes
`out/stamp-sweep.json`, which `check.ts` scores as K-R6's population arm; a
missing sweep file prints a warning rather than a zero.

## PREPCOOK (c) — reseed `prep.narrate_steps` (AFTER APPROVAL)

The prompt body changed (D-WS9-297 rulings 11 and 12, plus D-WS9-296's bowl
names, and now **D-WS9-301 rule 5**). The seed is diff-driven: it compares the
active version's body to the seed body and only inserts a new version when they
differ, so re-running it is idempotent.

> 🔴 **D-WS9-301 — ONE SENTENCE WAS THE OPPOSITE OF RULE 5, AND IT WAS THE
> LARGEST SINGLE SOURCE OF THE "~30 CONTAINERS" REPORT.** The body used to say:
> *"When a step splits an ingredient (or a blend) across MULTIPLE dishes, tell
> the user up front to get out one small container per dish and portion each
> dish's amount into its own."* Rule 5 says the exact reverse — one container,
> labelled with the dishes it serves, and the cook portions at the stove. The
> sentence is inverted in the seed. (Dev reached v13 on 2026-10-01 — see the
> current state below.) Production is still on whatever version it was deployed with, so this reseed is
> required for the grouping re-cut to reach a user even though the rest of the
> re-cut is code.
>
> 🔴 **v12 → v13 (BUG-204) — THE MODEL NO LONGER RETURNS A DURATION.** It used to
> own `estimatedMinutes`, and over the 14-plan corpus its estimates ran about 3x
> long (mean 6.6 min a step; 3 min to halve one poblano). That was cosmetic until
> D-WS9-301 ruling 4 put the SUM in the header. `prepStepMinutes.ts` computes it
> now, the field is OPTIONAL on the narration schema so a v12 response still
> parses, and anything that arrives is ignored. **The values in `MINUTES` are
> starting values awaiting Hans's timed session** — see the H2 report for the
> per-action-class evidence and the recommended multiplier. Re-tuning is editing
> that one object; no reseed and no regeneration are needed for a re-tune, because
> the minutes are not in `structureJson`.
>
> 🔴 **v13 → v14 (D-WS9-301, the October 1 device pass).** The phases became the
> KIND OF WORK in the order a cook works a board (Dry · Produce · Sauces and
> marinades · Proteins — `produce` and `sauces_marinades` swapped, keys
> unchanged); every produce portion now names its destination container WITH its
> quantity; phase 1 and 3 steps carry no knife work; a protein step opens with
> the verb the recipe names; and the source parenthetical ("from 1 garlic head")
> is gone. (Dev reached v14 on 2026-10-02.) Without this reseed the
> engine groups correctly and the prose still reads the old way.
>
> 🔴 **THE CURRENT STATE — read from dev 2026-10-04, after Part J.1b.**
> `prep.narrate_steps` is **v21** on dev (2026-10-03), and its `defaultModel`
> is now **`claude-sonnet-5-5`** — the reseed changes the model on production
> too, not only the body. Since the September 23 image, dev also gained
> `wizard.set_preferences.generate` **v18** and `wizard.directed.generate`
> **v15** (both 2026-10-03). So on production this one reseed bumps **three**
> keys, ONE version each (production's own counters; the dev numbers above are
> not the production ones). On dev the seed is a no-op: a dry run against a
> recording client on 2026-10-04 reported 0 bumps, 0 model changes. Production
> runs `claude-sonnet-5-5` with thinking OFF by default (`requestShapeForModel`)
> — leave `AI_SONNET55_THINKING` unset there.

```bash
pnpm --filter @workspace/api-server prisma:seed:prompts
```

`prisma/seedPrompts.ts` (R3-0) runs `seedAIPrompts` then `seedSystemSettings`
and nothing else, behind the same guard as the data scripts — production needs
`KIWI_PRODUCTION_HOST` exactly as in §1's note. A `DATABASE_URL` set in the
shell wins over the script's `--env-file=.env`, so the shell's is the one used.

> 🔴 **NEVER run `prisma:seed` (the full `prisma/seed.ts`) on production.** It
> also upserts the seed recipes' ingredients, meals, dishes and steps, and
> `deleteMany`s their dish ingredients and steps first — rewriting catalog rows
> the applies above just fixed.

Expected on production (static diff of the seed file at the September 23 image
against `next`, through the real seeder): **3 bumps** —
`wizard.set_preferences.generate`, `wizard.directed.generate`,
`prep.narrate_steps` — and `prep.narrate_steps`'s model
`claude-sonnet-4-6 → claude-sonnet-5-5`; no key created or retired. The settings
seed **creates** any missing row (the two `claude-sonnet-5-5` rate rows are new
since the September 23 image; `retailer.instacart_enabled` is created `false`
only if production never got it) and never changes an existing row's `value` —
an operator switch stays whatever production has. A second run reports 0 bumps.

**A bump invalidates every cached `PrepWeekStructure`,** because the route folds
the active prompt version into the cache gate. That is correct and intended: a
cached row holds prose the previous version wrote. The cost is one regeneration
per plan on first open, and it is self-healing — no backfill.

## PREPCOOK — what is NOT here

- **The migration: none.** The whole pass is additive in code; no column was
  added, dropped or retyped.
- **The cook day is not part of the prep cache key** (D-WS9-298). A day
  reassignment is a cache HIT by construction, and a test pins it. If a
  production plan starts regenerating whenever Hans drags a meal to another day,
  a date has leaked back into `PrepLoadedPlan` — see `PrepCookDays`.
