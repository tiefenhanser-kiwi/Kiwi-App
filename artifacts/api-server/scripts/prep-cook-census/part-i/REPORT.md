# Prep & Cook Part I — census over a shaped corpus, all three surfaces

Read-only on product code. HEAD `8968658` (`next`), prompt `prep.narrate_steps` v19, run 2026-10-03.
25 plans · 110 meals · 507 full-plan prep steps (17 plans) · 421 subset steps · 1,699 cook steps.
Every surface was driven through the **shipped routers** (`createCookingRouter`, `createPlansRouter`)
in-process as the test account `kiwi-browser-test-0930a@example.com`, and rendered with the phone's
own modules (`buildPrepWeekModel`, `sequenceMealSteps` / `flattenMealSteps`, `applyPrepFilter`,
`misePlaceItems`). `e55a9305` was never read by the harness. Hans's rows were never written.

Reproduce (from `artifacts/api-server`):

```
node --env-file=.env --import tsx scripts/prep-cook-census/part-i/corpus.ts [--assemble]
node --env-file=.env --import tsx scripts/prep-cook-census/part-i/run.ts --budget 5.8   # paid
node --env-file=.env --import tsx scripts/prep-cook-census/part-i/run.ts --ticks-only   # free
node --import tsx scripts/prep-cook-census/check.ts --tag parti      # K-R1…6, P-R1…6
node --import tsx scripts/prep-cook-census/part-i/check.ts           # H-rules, subset, prepped path
node --env-file=.env --import tsx scripts/prep-cook-census/part-i/forks.ts               # BUG-342
```

## 0. What subset mode and the prepped path do today

- **Subset** = the same route with `{ mealIds }` (`routes/cooking.ts:194-205`). The loader drops unselected items
  (`prepWeekAggregation.ts:344`). Everything downstream is unchanged. The cache is bypassed for read (`:390-392`)
  and write. The orphan-prune is skipped too (`:564`). The envelope says `subset: true` (`:616`).
- **But the food-identity fold is rebuilt over the subset only** (`prepWeekAggregation.ts:692-710`; the smallest
  id wins). Foods present in only some meals can therefore get **different stepKeys** from the full plan's.
- **Completions** are plan-scoped rows (`PUT …/completions`, `cooking.ts:727`). They carry no allowlist, so a
  subset key is stored even when the full plan has no such key.
- **`isPrepped`** is computed on `GET /plans/:id` (`plans.ts:468`, `:544`) against `loadPrepStepSet`.
  - That function rebuilds the step plan **without step text and without lags** (`prepStepSet.ts:114-119`).
  - It removes demotions only from the cached blob. That blob is written **before** the date overlay
    (`cooking.ts:563`), so the overlay's protein demotions are never in it.
- **Cook Mode has no plan context on the server.** `POST /meals/:id/cooking-sequence` takes no planId
  (`cooking.ts:137-163`).
- **On the client** (`app/cook-session.tsx:143-155`):
  - `resolvePrepGate(isPrepped)` decides the path.
  - On "prepped", `applyPrepFilter` drops every cook step whose `phaseType === "prep"` (`cookSession.ts:256`).
  - `misePlaceItems` makes the "You already prepped this — get your:" recap from **those same cook steps' texts**
    (`cookSession.ts:265`; `CookSessionView.tsx:301`). Nothing reads the Prep-the-Week steps.
  - Cook-step quantity text survives only on the steps that are kept.
- **Single-dish meals** never call the sequencer (`cook-session.tsx:78`, BUG-344). They are flattened, and the
  footer falls back to Σ step minutes.
- **`componentSelections`** (per-plan bought/scratch) is read by nothing. It is only copied on plan duplicate
  (`plans.ts:1876`). `DishIngredient.pathKey` is null on all 46,429 rows, so the bought path exists only on steps.

## 1. The corpus

4 live plans on the test account and 21 assembled there from public catalog meals, all starting Sun 2026-10-04
(the 4 existing ones start Sep 29/30, so the route's real clock anchors their prep day at today, Oct 3).
Every shape appears ≥ 2×. Full table: `out/corpus.md`.

| plan | code | meals (day, dishes) | shapes |
|---|---|---|---|
| 1e41fc0c | E | Carne Asada Tacos (Sun,3) · Enchiladas Verdes (Thu,2) · Stroganoff Skillet (Sat,1) · Caesar + Garlic Bread (Mon,2) · White Chicken Chili Mac (Fri,1) | late days, cold, marinade, single, bought |
| b4aa6fee | E | Sheet-Pan Fajitas (Mon,2) · Lemon-Herb Chicken (Sun,3) · Carne Asada Tacos (Fri,5) · Teriyaki Salmon (Thu,3) · Enchiladas Verdes (Sat,2) | seafood, marinade, toss, multi-3+ |
| b5263268 | E | Chipotle Beef Tacos (Thu,4) · Tex-Mex Tacos (Sat,4) · Slow-Cooker Chicken & Dumplings (Sun,1) · Enchiladas (Wed,3) · Meatloaf (Fri,3) | slow cooker, single, cold |
| 1cf373bc | E | Sheet-Pan Fajitas (Sun,3) · Lemon-Herb Chicken (Sat,3) · Texas Chili (Wed,1) · Italian Meatloaf (Fri,3) · Tex-Mex Tacos (Thu,3) | single, cold, two cuts |
| 873796cd | A01 | **7 meals Sun–Sat**: Carne Asada · Texas Chili · Baja Fish Tacos (slaw mix) · Dry-Rubbed Roast Chicken · Teriyaki Salmon (Thu) · Sizzling Fajitas (Fri) · Carne Asada Tostadas, 5 dishes (Sat) | 7 meals, days 5–7, seafood, marinades, bought, toss |
| c97aefe1 | A02 | **7 meals**: Slow-Cooker Dumplings · Blackened Shrimp Tacos · Cajun Sausage + Skillet Cornbread · Butter Chicken + Raita · Mahi-Mahi (Thu) · Herb Chicken Skewers (Fri) · Chipotle Chicken Bowl (Sat) | 7 meals, slow cooker, cornbread, seafood late |
| 53abd5b6 | A03 | **2 meals**: BBQ Chicken Pizza (Sun,1) · Buffalo Chicken Salad (Thu,1) | 2 meals, single, dough, cold |
| 7f206a48 | A04 | **2 meals**: Baja Shrimp Tacos + slaw (Mon,3) · Al Pastor Tacos + slaw (Sat,4) | 2 meals, seafood, marinade, slaw |
| 04a25763 | A05 | Smoked Brisket (Wed) · Braised Lamb Shanks (Thu) · Chicken Gyros + tzatziki (Fri) · Blackened Salmon (Sat) | smoker, braise, late proteins, seafood |
| da372b54 | A06 | Slow-Cooker Pot Roast · Pulled Pork Sliders + slaw · SW Chicken Salad · Shrimp Red Curry + cucumber salad · Beef Stew (1) | slow cooker, slaw, salad, seafood, single |
| fb328120 | A07 | Soy-Ginger Pork Chops (bottled marinade) · Sheet-Pan Fajitas (**guac: bought**) · Smash Burgers (**slaw-base: bought**) · Salsa Verde Carne Asada (bottled marinade) · King Ranch (rotisserie) | bought paths, per-plan selection |
| 27a03273 | A08 | Chicken Tenders + slaw · Tortilla Soup (rotisserie) · Cobb (rotisserie) · BBQ Chicken Sandwiches + slaw | rotisserie, bagged slaw |
| f0c56d0c | A09 | Shoyu Tuna Poke · Honey Garlic Chicken · Orange Chicken · General Tso's Tofu | ginger, scallion, raw fish |
| 3f9d46e8 | A10 | Supreme Pizza (1) · Fried Chicken + Biscuits + Collards · Chicken & Gravy over Biscuits · Falafel + Hummus + Tabbouleh + Flatbread | doughs, single, 4-dish |
| 33ddbb13 | A11 | Wedding Soup · Shrimp & Crab Jambalaya · Dum Biryani · Sheet-Pan Shrimp Boil · Taco Casserole — all single-dish | single-dish week, seafood, marinade |
| b12a194c | A12 | Salisbury Steak + green beans · Spatchcock Chicken · Herb-Roasted Thighs · Garlic-Herb Drumsticks | toss-no-heat, roasted veg |
| bd8aa8c2 | A13 | Carne Asada + pico · Carnitas + corn salsa + jalapeño slaw · Carnitas Bowl · Blackened Fish Tacos + mango salsa | cold dishes, marinade, seafood |
| 11623bcd | A14 | Tikka Masala + naan · Chana Masala + raita · Butter Chicken + roti · Korma | marinades, raita, two cuts |
| 2539d94d | A15 | Chipotle Pulled Pork Tacos · Carolina Pulled Pork + slaw · Slow-Roasted Pulled Pork | long passive, slaws |
| b0c8ffbd | A16 | Shrimp Fajita Bowl (5) · Seared Tuna + sesame slaw · Blackened Catfish + braised greens · Salmon Teriyaki | seafood ×4, ginger |
| 2730c4b1 | A17 | Beef Kofta + flatbread · Dolmades + tzatziki · Harissa Shawarma · Chicken Gyros | Mediterranean, marinades |
| 8a0de6e6 | A18 | Slow-Cooker Pot Roast · Biscuits & Gravy · Turkey Meat Sauce · Chicken Parm · Spaghetti Squash | slow cooker, biscuits, bought sauce |
| d26e6ae6 | A19 | BBQ Chicken Halves · Shrimp Skewers · Spatchcock Grilled · Grilled Shrimp Tacos | grill, seafood, toss |
| 2faff60f | A20 | Cajun Shrimp Pasta · Flank Steak Fajitas · Poblano Chicken Fajitas · Tetrazzini — all single-dish | single, marinade, seafood |
| 297794a0 | A21 | Braised Beef Bowl · Salsa Verde Braised Chicken · Braised Chicken Tacos · two Flautas meals | braise, cold, toss |

Plans per shape: days 5–7 25 · long passive 24 · aromatics 23 · two cuts 23 · multi-3+ 22 · cold 19 ·
marinade 12 · toss-no-heat 12 · seafood 11 · single-dish 10 · bought path 8 (+A07 by selection) · 7 meals 2 · 2 meals 2.

## 2. Tables

Counts are hits / candidates. Each detector was read against its own hits. The narrowings made are listed
at the end of each table, and recorded as comments in `check.ts`.

### Prep the Week (17 plans rendered; 8 failed — first row)

| rule | count | example 1 | example 2 |
|---|---|---|---|
| **Route 502 `validation_failed`** | **8 / 25 plans** (9 of 65 calls) | `b5263268` produce 3 "Mince all garlic": `steps.5.instructions: String must contain at most 800 character(s)` — 1,059 chars on attempt 1, 872 on attempt 2 | Fails: `1cf373bc`, `A02`, `A07`, `A09`, `A12`, `A13`, `A21` — every one is 4–7 meals with a shared-food step listing ≥ 4 labelled tubs. All 8 subsets (2 meals) succeeded |
| `heldForCookDay` stripped by the client | **15 / 15** plans with a held line | `04a25763` server sends 5 lines, e.g. "Add the boneless skinless chicken thighs the night before you cook them (Friday)." | `kiwi/lib/api/cooking.ts:273` `PrepWeekPhaseSchema` has no `heldForCookDay` (and no `note`) → Zod strips both, so the phone shows neither |
| `heldForCookDay` empty with a late protein | 1 / 15 | `3f9d46e8` A10 Fried Chicken thighs, 4 days out, engine-demoted (`heat-or-no-knife-work`) → never reaches the held list | — |
| Storage window ends before the cook day (legacy P-R3) | **111 / 202** dated notes, 17/17 plans | `04a25763` "Prep all garlic cloves": "up to 4 days", cooked Fri (5 days) | `7f206a48` Al Pastor marinade bowl (orange juice + garlic): "Covered in the fridge — up to 3 days", cooked Sat (6 days) |
| P-R1 header outside 10–15 | 13 / 17 | `873796cd` A01 (7 meals): 30 containers · 150 min | `04a25763` A05 (4 meals): 22 containers · 85 min |
| P-R1 single-member containers | 135 / 308 containers | `04a25763` "Slow-Cooked Pinto Beans — chopped yellow onion" | `11623bcd` "Chana Masala — juiced lemon" |
| Class mix in one container | 1 / 292 | `2539d94d` "Vinegar Coleslaw — large carrot and celery seed" — catalog files carrot as non-Produce and celery seed as Produce | — |
| Two cooking moments in one container | 3 / 135 | `2faff60f` "Classic Chicken Tetrazzini sauce jar" holds spaghetti (step 4, boil), flour (step 7), nutmeg (step 8), panko (step 10) | `33ddbb13` Biryani sauce bowl: whole spices (step 5) with ground spices (step 6) |
| Raw-mix grouping on a dish that has heat | 5 / 34 (by the rule's letter) | `2730c4b1` "Marinated Chicken Gyro Filling — parsley, garlic, red onion and roma tomatoes" | `da372b54` "Southwest Chicken Salad — cherry tomatoes, red onion" — all 5 are raw toppings inside a dish that cooks something else; **rule vs intent, for Hans** |
| Cut veg (cabbage) in a "greens" container | 4 / 43 | `2539d94d` "Creamy Vinegar Cabbage Slaw — greens" = green + red cabbage | `b0c8ffbd` "Sesame-Ginger Slaw — greens" = green + red cabbage |
| One citrus → one step | 0 / 23 | — | — |
| One food → one produce step | 0 / 218 | — | — |
| '+N more' / truncated label | 18 / 329 | `11623bcd` "Minced garlic cloves — Chicken Tikka Masala, Garlic Naan, Chana Masala +2 more" | `2730c4b1` "Herb and Rice Stuffed Grape Leaves (Dolmades) — yellow onion, fresh flat-leaf parsley, garlic, fresh mint leaves, fresh…" |
| Portion without a named container | 6 / 329 | `11623bcd` "2 onions for Chana Masala — into the same tub" | `33ddbb13` "…Wedding Soup — into the same tub" |
| Duplicate portion line in one step | 2 / 329 | `11623bcd` `1 tbsp — into a tub labelled "Fresh lemon juice — Cucumber Raita, Cumin-Spiced Roasted Cauliflower"` printed twice | `2730c4b1` "Fresh lemon juice — Tzatziki, Tzatziki Sauce" twice |
| Container closed ≠ once / not on its last step | 0 / 292 | — | — |
| Storage: one note, two windows | 3 / 346 | `11623bcd` "Coconut Chicken Korma — aromatics: Airtight in the fridge — up to 4 days. Airtight in the fridge — up to 3 days." | `1e41fc0c` carne asada bowl: "up to 3 days. Airtight in the fridge — up to 4 days." |
| Heat action inside a prep step | 1 / 329 | `33ddbb13` produce 8 "Fry the birista": "Thinly slice 1 cup worth of yellow onion and deep-fry until golden" | — |
| Dry blend < 3 · wet < 3 · single-item measure · jarred item in dry phase | 0 · 0 · 0 · 0 | — | — |
| Protein held although one of its meals is ≤ 2 days out | 6 / 42 | `11623bcd` chicken thighs: Tikka Masala lag 0, Butter Chicken 5, Korma 6 → whole step held | `33ddbb13` shrimp: Jambalaya lag 1, Shrimp Boil 4 → held |
| Protein rendered > 2 days out | 0 / 16 | — | — |
| Protein title does not name its dish | 4 / 16 | `8a0de6e6` "Trim the beef chuck roast" (for Red Wine and Herb Slow-Cooker Chuck Roast) | `b0c8ffbd` "Pat dry the shrimp" (for Chili-Lime Sautéed Shrimp) |
| Marinade close points at a protein step not on screen | 2 / 7 | `1e41fc0c` close: "The skirt steak go in at the proteins step and marinate until cook day." — that step is render-omitted (`heat-or-no-knife-work`) | `b4aa6fee` same sentence, same demotion |
| Marinade timing contradicts the recipe or the day | 6 / 7 | `04a25763` gyro chicken: recipe "refrigerate up to 4 hours", prep says "Add the … thighs the night before" | `11623bcd` Tikka marinade, cook day 6 out, no night-before line |
| BUG-346a protein line on a non-protein · BUG-346e herb without unit · decimals | 0 · 0 · 0 | — | — |
| Minutes: header vs Σ engine (rendered) | 17 / 17 disagree by > 5 | `04a25763` header 85 · Σ rendered 77 · phone 77 · server 111 | `53abd5b6` header 20 · Σ 14 · phone 14 · server 25 |
| Minutes: onion vs 2.5 min | 6 / 18 | `1e41fc0c` "Dice all white onion": 1 onion → 5 min | `2730c4b1` "Prep all yellow onion": 1 onion → 1 min |
| Minutes: garlic vs ⅓ min/clove | 0 / 15 | — | — |
| Bought path: per-plan selection ignored | 2 / 2 selections | `fb328120` Fajitas `guac: bought`: prep still portions roma tomatoes, white onion, jalapeño, lime juice, cilantro "for Fajita Toppings: Guacamole"; Cook Mode shows the scratch guac steps | Smash Burgers `slaw-base: bought`: prep still shreds green cabbage, carrots, iceberg "for Crisp Iceberg and Dill Slaw" |
| Cache served a stale blob · wire ≠ engine stepKeys | 0 / 1 · 0 / 17 | `b4aa6fee` had a v19 row, but its composition had moved (MISS). No hit was observed; the fingerprint has no engine version (`prepWeekFingerprint.ts:5`), so a stale hit is possible but not measured | — |

Detector narrowings, each from reading the hits:
- **Heat action:** "Roast" inside "Dry-Rubbed Roast Chicken" made 25 hits, now 1.
- **Raw-mix:** onions entering at heat by prose with no amountRef made 25 hits, now 7. Of the 7, pizza vegetables
  and roasted vegetables are the toss-no-heat shape that the engine got right, so 5 remain.
- **Class mix:** "garlic cloves" is filed Pantry. 7 hits, now 1.
- **Herb unit:** "2 scallions" is a natural count. 2 hits, now 0.
- **Citrus:** kaffir lime leaves. 1 hit, now 0.
- **Legacy P-R6** (7 hits) is noise: it matches "lime" in dish names like "Cilantro-Lime". The component-based
  check reads 0.

### Prep Selected Meals (25 subsets, all 200)

| rule | count | example 1 | example 2 |
|---|---|---|---|
| **Subset ticks never make the selected meals prepped** | **17 / 17** plans with a full plan (0 of 34 meals) | `04a25763` ticked 12 rendered subset keys; 6 of 13 required keys uncovered — `seasonings_dry#dish#3e552f0c…`, `seasonings_dry#dish#a632615c…` (keys no screen shows) | `53abd5b6` uncovered: `seasonings_dry#dish#23ba3769…` and the render-omitted `proteins#dafcbde7…` |
| Subset step not in the full plan (different stepKey) | 8 / 186 | `11623bcd` "Juice the lemon for Chicken Tikka Masala" → `produce#acc8ebfc…`, a key the full plan does not have (fold representative moved) | `3f9d46e8` "Mince all garlic" → `produce#e6753984…` |
| Container names differ from the full plan | 64 / 178 | `11623bcd` subset "Chicken Tikka Masala — finely diced yellow onion" vs full "Finely diced yellow onion — Chicken Tikka Masala, Chana Masala, …" | `04a25763` full also routes the onion to "Red Wine Braised Lamb Shanks vegetables" — the same step keyed to a different tub set |
| Subset quantity ≠ full for the same dish | 1 / 395 | `33ddbb13` garlic for Wedding Soup: subset 2 cloves, full 3 cloves | — |
| Subset drops the unit the full plan prints | 5 / 395 | `04a25763` garlic for Pickled Jalapeños: subset "2", full "2 cloves" | `11623bcd` garlic for Tikka Masala: "5" vs "5 cloves" |
| Unselected meal attributed in the subset | 0 / 178 | — | — |

### Cook Mode (110 meals; prepped path on 14 multi-dish meals)

| rule | count | example 1 | example 2 |
|---|---|---|---|
| K-R1 rest > 2 min after heat | 2 / 77 | `2730c4b1` Spiced Beef Kofta: rest at T-10, 3 min after its cook step | `bd8aa8c2` Cilantro-Lime Rice: steam-rest 4 min after heat |
| K-R2 pan hold > 5 min | 21 / 463 (12 plans) | `11623bcd` Butter Chicken: 12 min between blending (ends T-26) and "Stir in ½ cup heavy cream" (T-14) | `1cf373bc` Sheet-Pan Fajitas: 14 min between wrapping tortillas (T-18) and "Transfer the roasted chicken" (T-4) |
| K-R3 cue truth | 0 / 433 | — | — |
| K-R4 repeated action | 4 / 8,005 pairs | `27a03273` "Preheat the oven to 425°F" in Oven Fries #1 **and** Chicken Tenders #4 | `8a0de6e6` "Heat 2 tablespoons olive oil…" in two dishes |
| K-R5 idle passive windows ≥ 10 min | 35 / 269 | see causes below | |
| K-R6 footer ≠ card, sequenced | 0 / 91 | — | — |
| **K-R6 footer ≠ card, single-dish (BUG-344)** | **9 / 19** | `2faff60f` Cajun Shrimp Pasta: footer 53 min, card 33 (scheduler 33) | `33ddbb13` Shrimp Boil: footer 68, card 49 |
| BUG-344 single-dish never sequenced | 19 / 19 | `1cf373bc` Texas Chili: flattened 11 steps, no offsets; the scheduler had a 141-min plan | `1e41fc0c` Stroganoff Skillet: flattened, scheduler 46 min |
| D-WS7-152 single-dish shows a dish/meal label | 0 / 19 | — | — |
| **Prepped: ticking every rendered prep step leaves `isPrepped` false** | **12 / 14** | `11623bcd` Chana Masala: 10 rendered keys ticked, blocker `seasonings_dry#dish#138a0c89…` (on no screen); after ticking all 11 wire keys → still false | `04a25763` Lamb Shanks: blocker "Lamb shanks — cook day" (render-omitted); true only after ticking it |
| — blockers by kind (22) | 19 not on the wire · 3 render-omitted proteins | 12 `seasonings_dry#dish#…`, 4 `sauces_marinades#dish#…`, 2 `sauces_marinades#…`, 1 `seasonings_dry#…` | After ticking every wire step: 11 / 14 still false |
| Prepped: recap is not built from the prep steps | 14 / 14 | `3f9d46e8` Chicken & Gravy recap: "Use two forks to pull the rested chicken thighs into bite-sized shreds." · "Pour in ¾ cup cold buttermilk and stir … until a shaggy, sticky dough forms" — neither is Prep-the-Week work | `11623bcd` recap = 5 cook-side prep texts; the plan's 10 prep steps for the meal are not read |
| Prepped: cook steps dropped by the filter | 69 across 14 meals | The cooked-chicken shred and the biscuit dough above are dropped from the cook flow and appear only in the recap | `04a25763` "Drain and rinse the three 15 oz cans of cannellini beans…" — dropped, never in prep |
| Prepped: kept steps that redo prep / lost quantity | 1 / 14 · 2 / 14 | `b4aa6fee` kept: "Slice the chicken … scatter with ¼ cup chopped fresh parsley" | `11623bcd` kept: "Fold in the diced cucumber, mint, and cilantro…" — no quantity left in the flow |
| D-WS9-297 cold dish pulled into a passive window (**for Hans**) | 36 / 71 | `11623bcd` Cucumber Raita made T-20..T-10 inside Chana Masala's cook T-20..T-10 | `1cf373bc` Guacamole made T-37..T-22 inside the fajitas' preheat T-41..T-29 — 22 min before serve |
| BUG-342 forks' stale minute stamps | 0 / 697 derivable user-owned meals (743 owned, 437 with a source) | the 2026-10-01 population restamp (791 rows) covered user rows | — |

**K-R5's 35 idle windows, by cause:**
- **13: a cold dish was startable but sat elsewhere.** `2539d94d` pulled pork's 15-min preheat sits idle while
  the vinegar coleslaw shred waits.
- **10: a cook window with another dish's prep startable.** `04a25763` lamb shanks' 150-min braise is 146 min
  idle with the gremolata chop waiting.
- **9: the preheat window.** `1cf373bc` Roasted Garlic Mash's preheat is 12 min idle.
- **3: a rest window with knife work waiting.** `3f9d46e8` falafel's 30-min rest is idle while the hummus
  could start.

## 3. Four plans, full narrated text

These live in this directory, as the phone renders them:
- `out/873796cd.txt`: A01, 7 meals, Sun–Sat (30 containers, 150 min).
- `out/7f206a48.txt`: A04, 2 meals.
- `out/b0c8ffbd.txt`: A16, seafood.
- `out/3f9d46e8.txt`: A10, doughs. This file also has the **subset render** (Supreme Pizza + Falafel Plate)
  and the **three Cook Mode sequences**:
  - multi-dish, unprepped: Fried Chicken + Biscuits + Collards;
  - single-dish: Supreme Pizza, flattened, footer 60 vs card 40;
  - multi-dish, prepped: Chicken & Gravy over Biscuits — `isPrepped=false` after every tick; the recap is shown
    when the path is forced.

The A10 section is reproduced in Appendix A. The other three are in Appendix B.

## 4. Where each fix belongs (no fixes made)

| rule | file · function |
|---|---|
| 502 on > 800-char instructions | `src/lib/prepWeekAssembly.ts` `containerLabel` (`:305`, labels up to 120 chars repeated per portion line) + the shared-food portion lines; cap at `src/lib/ai/schemas/prepNarration.ts:179` |
| held list / phase note stripped | `artifacts/kiwi/lib/api/cooking.ts:273` `PrepWeekPhaseSchema` (+ `PrepWeekView` to render it) |
| held list misses engine-demoted proteins | `src/lib/prepStorage.ts` `applyStorageOverlay` (the `skipSuggested` early return before `held.push`) |
| storage window < cook day | `src/lib/prepStorage.ts` `applyStorageOverlay` / `closingNote` (`:523`) — produce and mixtures get no lag-aware demotion; only proteins do |
| header > 15 / single-member containers | `src/lib/prepWeekAssembly.ts` `buildStepPlan` destination resolver (rule 11) + the drop pass (`:1904`) |
| class mix (carrot / celery seed) | catalog data; `src/lib/prepCategoryOverride.ts` |
| two moments in one jar | `src/lib/prepComponents.ts` `resolveDishComponents` (`:372`) / `src/lib/prepMoments.ts` `resolveMoments` |
| raw-mix on a heated dish | `src/lib/prepWeekAssembly.ts` `buildStepPlan` `COLD_COMBINE` / `HEAT_TEXT` (`:1685-1687`) — needs a ruling first |
| cabbage in "— greens" | `src/lib/prepWeekAssembly.ts` `buildStepPlan` `LEAFY` (`:1690`) label noun |
| "+N more" / truncated labels | `src/lib/prepWeekAssembly.ts` `containerLabel` |
| "into the same tub" | `prisma/seeds/aiPrompts.ts` `prep.narrate_steps` (prose, not code) |
| duplicate portion line | `src/lib/prepWeekAssembly.ts` `buildStepPlan` — two measures to one destination not merged |
| two windows in one note | `src/lib/prepStorage.ts` `closingNote` |
| birista deep-fry as prep | `src/lib/prepClasses.ts` `judgeProducePortion` `HEAT_NOTE` (`:100`) |
| protein held with a meal ≤ 2 days out | `src/lib/prepStorage.ts` `judgeProteinStep` (`:380`), fed the max lag; the step is not split per meal in `buildStepPlan` |
| protein title without dish | `prisma/seeds/aiPrompts.ts` + `prepWeekAssembly.ts` rule-12 title (`knifeVerbs`) |
| marinade close → hidden protein step | `src/lib/prepStorage.ts` `closingNote` + `prepWeekAssembly.ts` demotion `heat-or-no-knife-work` (`:1313`) on a marinating protein |
| marinade timing vs recipe | `src/lib/prepStorage.ts` `applyStorageOverlay` (`SOON_DAYS`, `:473`) — reads no hours cap from the recipe |
| minutes, three numbers | `src/lib/prepWeekAssembly.ts` `summarizePrepWeek` (`:1941`) vs `assemblePrepWeekResult` `totalEstimatedMinutes` (`:2046`, counts omitted steps) vs `kiwi/lib/cooking/prepWeekModel.ts` |
| onion rate | `src/lib/prepStepMinutes.ts` `timeRow` (`:262`) / `cutRateFor` (`:97`) |
| per-plan bought selection ignored | `src/lib/prepWeekAggregation.ts` `loadPrepWeekInput` (`selectDefaultPathSteps`, `:560`) and `cookingScheduler.ts` `selectDefaultPathSteps` (`:323`) — neither reads `MealPlanItem.componentSelections` |
| subset / prepped `isPrepped` never true | `src/lib/prepStepSet.ts` `loadPrepStepSet` (`:110-119`, no step text → legacy `#dish#` keys; no overlay demotions) + `src/routes/cooking.ts:563` (blob written pre-overlay) |
| subset stepKeys / labels differ | `src/lib/prepWeekAggregation.ts` `loadPrepWeekInput` identity fold (`:692-710`, scoped to the subset) + `containerLabel` |
| subset unit dropped / garlic 2 vs 3 | same fold → `src/lib/prepCombineEngine.ts` `combinePrep` grouping |
| K-R1 | `src/lib/cookingScheduler.ts` `LAG_AFTER_HEAT_REST` (`:286`) |
| K-R2 / K-R5 | `src/lib/cookingScheduler.ts` `scheduleCookingSequence` finish alignment + window fill |
| K-R4 | `src/lib/cookingScheduler.ts` — a shared oven preheat is not deduped across dishes |
| K-R6 single-dish / BUG-344 | `artifacts/kiwi/app/cook-session.tsx:78` `isMultiDish` gate |
| cold-dish forwarding (ruling) | `src/lib/cookingScheduler.ts` `isServedCold` (`:450`) / `COLD_FORWARD_MIN_WINDOW` (`:291`) |
| recap source, dropped mid-cook steps, lost quantities | `artifacts/kiwi/lib/cooking/cookSession.ts` `misePlaceItems` (`:265`) / `applyPrepFilter` (`:256`) |

## 5. Classifier debt

Listed: 34 regex constants and 2 name word lists classify food by name, dish title or bowl name. They sit in
**9 files**, not the 7 H6.2 counted; the extra two are `prepMoments.ts` (1) and `cookingScheduler.ts` (2).
35 are live and 1 is dead (`WET_FORM`, `prepWeekAssembly.ts:254`, only `void`-ed).
A further 28 constants classify by prep note or step text; no Ingredient column can replace those.

**Where they go:**
- **`Ingredient.subcategory`** exists but is written on 0 of 1,773 rows. It would absorb most of them:
  - citrus, fresh herb, leafy green, dried chile, seafood, ground meat, allium;
  - `CITRUS`, `HERBS`, `HERB_MEMBER`, `FRESH_HERB`, `LEAFY`, `DRIED_CHILE`, `SEAFOOD`, `GROUND_MEAT`, `GARLIC`.
- **Four new attributes** cover the rest:
  - `form` (liquid / dry / precut / cut): `JUICE`, `WET_MEMBER`, `DRY_MEMBER`, `DRY_MIX_MEMBER`, `SERVICE_CUT`,
    `BOUGHT_CUT`, `SAUCE_NAME_HINTS`;
  - `perishability` (holds-cut, shelf-stable, shelf days): `DOES_NOT_HOLD` ≈ `COOK_DAY_BASE`,
    `SHELF_STABLE_PROTEIN` / `_ALL`, the 11-row `STORAGE_TABLE`, `RAW_FLESH_HINT`;
  - `role` (aromatic / staple / acid): `AROMATIC_PRODUCE`, `DENYLIST`, `ACIDIC`;
  - `knifeProfile`: `CUT_RATES`, `CUT_VEG`, `BATCH`, `MEAT`.
- **Two Dish-level attributes**:
  - `servedCold`: `COLD_DISH_TITLE` / `_EXCEPTION`;
  - `role = accompaniment`: `SERVED_SEPARATELY`.
- **Already done the right way:** `WET_PACKS` (`prepCombineEngine.ts:371`) reads `purchaseUnit`.

**Duplicated lists**, each of which would become one read:
- `DOES_NOT_HOLD` ≈ `COOK_DAY_BASE`
- `SEAFOOD` ≈ `STORAGE_TABLE` raw-fish ⊂ `RAW_FLESH_HINT` ≈ `MEAT`
- `FRESH_HERB` ≈ `HERBS` ≈ `HERB_MEMBER` ⊂ `AROMATIC_PRODUCE`

This run found the cost of the name approach in two places:
- carrot and celery seed with their categories swapped in the catalog;
- "garlic cloves" filed under Pantry.

## 6. Spend and fences

- **Spend: $4.85** (A03 smoke $0.08 · corpus run $4.61 · one validation probe $0.16). 67 Sonnet calls (65 in the corpus runs,
  2 in the probe); 9 corpus calls failed `validation_failed` after a billed retry.
- **Writes, all on the test account:**
  - 21 assembled `MealPlanInstance` rows;
  - `prepWeekStructure` upserts (the route's own cache write, test plans only);
  - `PrepStepCompletion` rows, each deleted again — **0 left on the account**, verified.
- **Write fence:** every other Prisma write was proxied to throw; none fired.
- **Never touched:** `e55a9305` and its cache; Hans's rows.
- **Detail files:**
  - `out/check.txt` — the full Part I checker table;
  - `../out/parti__check.txt` — the legacy K/P table;
  - `out/summary.json` — per-call tokens.

# Appendix A — A10 (3f9d46e8): full plan, subset, three Cook Mode sequences, prepped path

```
PLAN 3f9d46e8-b078-4bd4-b479-9f93cb8c76cd  [A10]  Part I · A10 · doughs and breads: pizza, biscuits, flatbread
  range 2026-10-04 .. 2026-10-10   meals 4   prep day 2026-10-04   shapes: days-5-7, long-passive, single-dish, bought-path, multi-3plus, aromatics

══════════ PREP THE WEEK — full plan, as Screen 3 renders it ══════════
  HEADER: 16 containers · about 85 min   (server total 103 · phone 75) · cacheHit=false · prompt v19

  ── seasonings_dry ──
     1. Measure the Classic Supreme Pizza dough bowl spices   (2 min)
        Into the Classic Supreme Pizza dough bowl:
        1 tsp dried oregano
        ½ tsp dried basil
        ½ tsp sugar
        » storage: Airtight in the fridge — up to 3 days.
        » for: Classic Supreme Pizza (Sunday)
     2. Measure the Flaky Drop Biscuits dough bowl dry mix   (2 min)
        Into the Flaky Drop Biscuits dough bowl:
        2 cup all-purpose flour
        1 tbsp baking powder
        ¼ tsp baking soda
        1 tsp sugar
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday)
     3. Measure the Flaky Buttermilk Drop Biscuits dough bowl dry mix   (2 min)
        Into the Flaky Buttermilk Drop Biscuits dough bowl:
        2 cup all-purpose flour
        1 tbsp baking powder
        1 tsp sugar
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Creamy Country Chicken and Gravy over Biscuits (Thursday)
     4. Measure the Buttermilk Fried Chicken dry mix   (4 min)
        Into the Buttermilk Fried Chicken dry mix:
        2 cup all-purpose flour
        ¼ cup cornstarch
        1½ tsp garlic powder
        1 tsp onion powder
        1½ tsp smoked paprika
        ½ tsp cayenne pepper
        ½ tsp dried thyme
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday)
     5. Measure the Herb Falafel dry mix   (3 min)
        Into the Herb Falafel dry mix:
        3 tbsp all-purpose flour
        1 tsp baking powder
        1½ tsp ground cumin
        1 tsp ground coriander
        ¼ tsp cayenne pepper
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
     6. Measure the Creamy Hummus sauce bowl dry start   (2 min)
        Into the Creamy Hummus sauce bowl:
        ¼ tsp ground cumin
        4 tbsp ice water (added gradually for texture)
        Set aside for the produce step.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
  ×  7. Pepperoni and crushed red pepper flakes — cook day   (1 min)  [RENDER-OMITTED]
        These go in at different moments, or there are too few to be worth a container — measure them on cook day.
        » for: Classic Supreme Pizza (Sunday)
  ×  8. Crushed red pepper flakes — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday)
  ×  9. All-purpose flour, garlic powder and onion powder — cook day   (2 min)  [RENDER-OMITTED]
        These go in at different moments, or there are too few to be worth a container — measure them on cook day.
        » for: Creamy Country Chicken and Gravy over Biscuits (Thursday)
  × 10. Smoked paprika — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)

  ── produce ──
     1. Wash and dry all the produce   (3 min)
        Wash and dry everything you are about to cut. One pass now keeps the board dry and the knife work clean.
        » for: Classic Supreme Pizza (Sunday), Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday), Creamy Country Chicken and Gravy over Biscuits (Thursday), Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
     2. Mince all garlic   (4 min)
        Mince all the garlic:
        2 cloves for the Classic Supreme Pizza
        3 cloves for the Slow-Braised Collard Greens with Bacon
        3 cloves for the Creamy Country Chicken and Gravy
        — combine all three portions into a tub labelled "Minced garlic — Classic Supreme Pizza, Slow-Braised Collard Greens with Bacon, Creamy Country Chicken and Gravy"
        2 cloves for the Creamy Hummus — into the Creamy Hummus sauce bowl
        » storage: Airtight in the fridge — up to 4 days.
        » for: Classic Supreme Pizza (Sunday), Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday), Creamy Country Chicken and Gravy over Biscuits (Thursday), Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
     3. Slice the green bell pepper for Classic Supreme Pizza   (3 min)
        Thinly slice 1 green bell pepper — into the Classic Supreme Pizza vegetables container.
        » for: Classic Supreme Pizza (Sunday)
     4. Slice the red onion for Classic Supreme Pizza   (3 min)
        Thinly slice ½ red onion — into the Classic Supreme Pizza vegetables container.
        » for: Classic Supreme Pizza (Sunday)
     5. Slice the cremini mushrooms for Classic Supreme Pizza   (3 min)
        Thinly slice 4 oz cremini mushrooms — into the Classic Supreme Pizza vegetables container.
        » storage: Classic Supreme Pizza vegetables: Airtight in the fridge — up to 4 days.
        » for: Classic Supreme Pizza (Sunday)
     6. Prep all yellow onion   (8 min)
        Work through the yellow onion three ways:
        Thinly slice 1 — into a tub labelled "Slow-Braised Collard Greens with Bacon — thinly sliced yellow onion"
        Finely dice 1 — into a tub labelled "Creamy Country Chicken and Gravy — finely diced yellow onion"
        Roughly chop 1 — into a tub labelled "Herb Falafel — yellow onion, fresh flat-leaf parsley and fresh cilantro"
        » storage: Both containers: Airtight in the fridge — up to 4 days.
        » for: Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday), Creamy Country Chicken and Gravy over Biscuits (Thursday), Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
  ×  7. Fresh thyme — cook day   (1 min)  [RENDER-OMITTED]
        Nothing to cut — it goes in as it comes.
        » for: Creamy Country Chicken and Gravy over Biscuits (Thursday)
     8. Trim the green beans for Simple Steamed Green Beans with Butter   (2 min)
        Trim the stem ends from 12 oz fresh green beans — into a tub labelled "Simple Steamed Green Beans with Butter — trimmed fresh green beans".
        » storage: Airtight in the fridge — up to 4 days.
        » for: Creamy Country Chicken and Gravy over Biscuits (Thursday)
     9. Prep all lemon   (4 min)
        Juice the lemons:
        3 tbsp fresh lemon juice for the Creamy Hummus — into the Creamy Hummus sauce bowl
        3 tbsp fresh lemon juice for the Tabbouleh — into a tub labelled "Tabbouleh — fresh lemon juice"
        Cut 4 lemon wedges for the Simple Steamed Green Beans with Butter — into a tub labelled "Simple Steamed Green Beans with Butter — lemon wedges"
        » storage: Airtight in the fridge — up to 3 days. Covered in the fridge — up to 3 days.
        » for: Creamy Country Chicken and Gravy over Biscuits (Thursday), Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    10. Chop all fresh flat-leaf parsley   (12 min)
        Roughly chop 1 cup fresh flat-leaf parsley (loosely packed) for the Herb Falafel — into a tub labelled "Herb Falafel — yellow onion, fresh flat-leaf parsley and fresh cilantro"
        Finely chop 2 cup fresh flat-leaf parsley (loosely packed) for the Tabbouleh — into a tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions"
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    11. Chop the fresh cilantro for Herb Falafel   (2 min)
        Roughly chop ½ cup fresh cilantro (loosely packed) — into a tub labelled "Herb Falafel — yellow onion, fresh flat-leaf parsley and fresh cilantro".
        » storage: Herb Falafel: Airtight in the fridge, with a barely damp paper towel — up to 3 days. Keep the Herb Falafel dry mix separate; combine on cook day (Saturday).
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    12. Chop the fresh mint leaves for Tabbouleh   (1 min)
        Finely chop ¼ cup fresh mint leaves — into a tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions".
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    13. Dice the roma tomatoes for Tabbouleh   (8 min)
        Seed and finely dice 3 roma tomatoes — into a tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions".
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    14. Dice the english cucumber for Tabbouleh   (3 min)
        Finely dice ½ english cucumber — into a tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions".
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    15. Slice the green onions for Tabbouleh   (1 min)
        Thinly slice 4 green onions — into a tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions".
        » storage: Tabbouleh: Airtight in the fridge, with a barely damp paper towel — up to 3 days. Keep the fresh lemon juice separate; combine on cook day (Saturday).
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)

  ── sauces_marinades ──
     1. Finish the Creamy Hummus sauce bowl   (2 min)
        Creamy Hummus sauce bowl (ground cumin, ice water, garlic and the fresh lemon juice from produce step 9 already in it): add
        ½ cup tahini
        Stir to combine.
        » storage: Covered in the fridge — up to 3 days.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
  ×  2. Black olives — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Classic Supreme Pizza (Sunday)
  ×  3. Hot sauce and honey — cook day   (1 min)  [RENDER-OMITTED]
        These go in at different moments, or there are too few to be worth a container — measure them on cook day.
        » for: Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday)
  ×  4. Apple cider vinegar — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday)
  ×  5. Worcestershire sauce — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Creamy Country Chicken and Gravy over Biscuits (Thursday)
  ×  6. Boiling water — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)

  ── proteins ──
     » Fish, poultry and meat keep about two days once handled, so this phase only preps what you'll cook soon.
  ×  1. Italian sausage — cook day   (1 min)  [RENDER-OMITTED]
        Nothing to do to it before the pan — it goes in straight from the package on cook day.
        » for: Classic Supreme Pizza (Sunday)
  ×  2. Bone-in chicken pieces (thighs and drumsticks) — cook day   (11 min)  [RENDER-OMITTED]
        Nothing to do to it before the pan — it goes in straight from the package on cook day.
        » for: Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday)
     3. Cut the bacon for Slow-Braised Collard Greens with Bacon   (1 min)
        Cut 4 oz thick-cut bacon into lardons (½-inch pieces).
        » storage: Covered in the fridge — cook within 2 days.
        » for: Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens (Tuesday)
  ×  4. Boneless skinless chicken thighs — cook day   (5 min)  [RENDER-OMITTED]
        Nothing to do to it before the pan — it goes in straight from the package on cook day.
        » for: Creamy Country Chicken and Gravy over Biscuits (Thursday)

══════════ PREP SELECTED MEALS — Classic Supreme Pizza + Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread ══════════
  HEADER: 8 containers · about 65 min   (server total 61 · phone 56) · cacheHit=false · prompt v19

  ── seasonings_dry ──
     1. Measure the Classic Supreme Pizza dough bowl spices   (2 min)
        Into the Classic Supreme Pizza dough bowl:
        1 tsp dried oregano
        ½ tsp dried basil
        ½ tsp sugar
        » storage: Airtight in the fridge — up to 3 days.
        » for: Classic Supreme Pizza (Sunday)
     2. Measure the Herb Falafel dry mix   (3 min)
        Into the Herb Falafel dry mix:
        1½ tsp ground cumin
        1 tsp ground coriander
        ¼ tsp cayenne pepper
        1 tsp baking powder
        3 tbsp all-purpose flour
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
     3. Measure the Creamy Hummus sauce bowl base   (2 min)
        Into the Creamy Hummus sauce bowl:
        ¼ tsp ground cumin
        4 tbsp ice water
        Set aside for the produce step.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
  ×  4. Pepperoni and crushed red pepper flakes — cook day   (1 min)  [RENDER-OMITTED]
        These go in at different moments, or there are too few to be worth a container — measure them on cook day.
        » for: Classic Supreme Pizza (Sunday)
  ×  5. Smoked paprika — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)

  ── produce ──
     1. Wash and dry all the produce   (3 min)
        Wash and dry everything you are about to cut. One pass now keeps the board dry and the knife work clean.
        » for: Classic Supreme Pizza (Sunday), Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
     2. Mince all garlic   (2 min)
        Mince the garlic:
        2 cloves for the Classic Supreme Pizza — into a tub labelled "Classic Supreme Pizza — minced garlic"
        2 cloves for the Creamy Hummus — into the Creamy Hummus sauce bowl
        » storage: Airtight in the fridge — up to 4 days.
        » for: Classic Supreme Pizza (Sunday), Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
     3. Slice the green bell pepper for Classic Supreme Pizza   (3 min)
        Thinly slice 1 green bell pepper — into a tub labelled "Classic Supreme Pizza vegetables".
        » for: Classic Supreme Pizza (Sunday)
     4. Slice the red onion for Classic Supreme Pizza   (3 min)
        Thinly slice ½ red onion — into the tub labelled "Classic Supreme Pizza vegetables".
        » for: Classic Supreme Pizza (Sunday)
     5. Slice the cremini mushrooms for Classic Supreme Pizza   (3 min)
        Thinly slice 4 oz cremini mushrooms — into the tub labelled "Classic Supreme Pizza vegetables".
        » storage: Classic Supreme Pizza vegetables: Airtight in the fridge — up to 4 days.
        » for: Classic Supreme Pizza (Sunday)
     6. Chop the yellow onion for Herb Falafel   (3 min)
        Roughly chop 1 yellow onion — into a tub labelled "Herb Falafel — yellow onion, fresh flat-leaf parsley and fresh cilantro".
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
     7. Chop all flat-leaf parsley   (12 min)
        Roughly chop 1 cup flat-leaf parsley (loosely packed) for the Herb Falafel — into the tub labelled "Herb Falafel — yellow onion, fresh flat-leaf parsley and fresh cilantro"
        Finely chop 2 cup flat-leaf parsley (loosely packed) for the Tabbouleh — into a tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions"
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
     8. Chop the cilantro for Herb Falafel   (2 min)
        Roughly chop ½ cup fresh cilantro (loosely packed) — into the tub labelled "Herb Falafel — yellow onion, fresh flat-leaf parsley and fresh cilantro".
        » storage: Herb Falafel: Airtight in the fridge, with a barely damp paper towel — up to 3 days. Keep the Herb Falafel dry mix separate; combine on cook day (Saturday).
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
     9. Juice all lemons   (3 min)
        Juice the lemons:
        3 tbsp fresh lemon juice for the Creamy Hummus — into the Creamy Hummus sauce bowl
        3 tbsp fresh lemon juice for the Tabbouleh — into a tub labelled "Tabbouleh — fresh lemon juice"
        » storage: Covered in the fridge — up to 3 days.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    10. Chop the mint leaves for Tabbouleh   (1 min)
        Finely chop ¼ cup fresh mint leaves — into the tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions".
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    11. Dice the roma tomatoes for Tabbouleh   (8 min)
        Finely dice 3 roma tomatoes, seeds removed — into the tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions".
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    12. Dice the cucumber for Tabbouleh   (3 min)
        Finely dice ½ English cucumber — into the tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions".
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
    13. Slice the green onions for Tabbouleh   (1 min)
        Thinly slice 4 green onions — into the tub labelled "Tabbouleh — fresh flat-leaf parsley, fresh mint leaves, roma tomatoes, english cucumber and green onions".
        » storage: Tabbouleh: Airtight in the fridge, with a barely damp paper towel — up to 3 days. Keep the fresh lemon juice separate; combine on cook day (Saturday).
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)

  ── sauces_marinades ──
     1. Finish the Creamy Hummus sauce bowl   (2 min)
        Creamy Hummus sauce bowl (ground cumin, ice water, garlic and the fresh lemon juice from produce step 9 already in it): add
        ½ cup tahini
        Stir to combine.
        » storage: Covered in the fridge — up to 3 days.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)
  ×  2. Black olives — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Classic Supreme Pizza (Sunday)
  ×  3. Boiling water — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread (Saturday)

  ── proteins ──
     » Fish, poultry and meat keep about two days once handled, so this phase only preps what you'll cook soon.
  ×  1. Italian sausage — cook day   (1 min)  [RENDER-OMITTED]
        Nothing to do to it before the pan — it goes in straight from the package on cook day.
        » for: Classic Supreme Pizza (Sunday)

  subset ticks: 17 keys, 2 not in the full plan; required for these meals 16, uncovered 6; isPrepped {"Classic Supreme Pizza":false,"Falafel Plate with Hummus, Tab":false}

══════════ COOK MODE (cook-session.tsx: sequenced if multi-dish, flattened if single) ══════════

  ▸ Classic Supreme Pizza   [Sunday]  FLATTENED (single-dish)
    footer 60 min | scheduler 40 | card 40 | fresh derive 40 | dishes 1
      1. [ T-40] ( 20m preheat) 
         Place a rack in the lowest position of the oven and preheat to 500°F (or as high as your oven will go); if you have a baking stone or steel, put it on the rack now.
      2. [ T-40] (  7m cook) 
         Crumble the 6 oz Italian sausage (casings removed) into a skillet over medium-high heat and cook, breaking it up, until browned through, about 6 minutes; transfer to a paper-towel-lined plate and set aside.
      3. [ T-33] (  4m prep) 
         While the oven preheats, combine ¾ cup canned crushed tomatoes, 2 minced garlic cloves, 1 teaspoon dried oregano, ½ teaspoon dried basil, ½ teaspoon kosher salt, and ½ teaspoon sugar in a small bowl and stir well to make the sauce.
      4. [    —] (  5m prep) 
         On a lightly floured surface, stretch the 16 oz room-temperature pizza dough into a 14-inch round (or press it into a rimmed baking sheet); transfer to a parchment-lined baking sheet or hot stone.
      5. [ T-29] (  2m assemble) 
         Brush the dough edge with 2 tablespoons olive oil, then spread the sauce evenly over the dough, leaving a ¾-inch border.
      6. [ T-24] (  4m assemble) 
         Scatter half the 8 oz shredded mozzarella over the sauce, then evenly distribute the browned sausage, 2 oz sliced pepperoni, 1 thinly sliced green bell pepper, ½ thinly sliced red onion, 4 oz thinly sliced cremini mushrooms, and 2 oz sliced black olives.
      7. [ T-22] (  2m assemble) 
         Top with the remaining mozzarella, 2 tablespoons grated Parmesan, and ¼ teaspoon crushed red pepper flakes if using.
      8. [ T-18] ( 13m cook) 
         Bake on the lowest rack for 12–15 minutes until the crust is deep golden and the cheese is bubbling and spotted brown.
      9. [ T-16] (  3m rest) 
         Let the pizza rest 3 minutes before slicing into 8 pieces and serving.

  ▸ Buttermilk Fried Chicken with Honey, Biscuits, and Collard Greens   [Tuesday]  SEQUENCED
    footer 94 min | scheduler 94 | card 94 | fresh derive 94 | dishes 3
      1. [ T-94] (  8m prep) Slow-Braised Collard Greens with Bacon
         Remove the stems from 1½ pounds collard greens and roughly chop the leaves; thinly slice the yellow onion and mince 3 garlic cloves.
      2. [ T-86] (  3m prep) Slow-Braised Collard Greens with Bacon
         Cut 4 ounces thick-cut bacon into lardons (½-inch pieces).
      3. [ T-83] (  7m cook) Slow-Braised Collard Greens with Bacon
         Cook the bacon lardons in a large, heavy pot over medium heat, stirring occasionally, for 6–7 minutes until the fat has rendered and the bacon is lightly crisp.
      4. [ T-81] ( 30m rest) Buttermilk Fried Chicken with Honey
         ⟶ With the Slow-Braised Collard Greens with Bacon cooking, start on the Buttermilk Fried Chicken with Honey.
         Combine 2 cups buttermilk and 1 tablespoon hot sauce in a large bowl, add the 3½ pounds chicken pieces, turn to coat, cover, and refrigerate for at least 30 minutes (or up to 8 hours).
      5. [ T-81] (  4m prep) Buttermilk Fried Chicken with Honey
         Whisk together 2 cups all-purpose flour, ¼ cup cornstarch, 1½ teaspoons garlic powder, 1 teaspoon onion powder, 1½ teaspoons smoked paprika, ½ teaspoon cayenne, ½ teaspoon dried thyme, 2 teaspoons kosher salt, and 1 teaspoon black pepper in a shallow dish.
      6. [ T-77] (  8m preheat) Buttermilk Fried Chicken with Honey
         Pour 4 cups vegetable oil into a large, deep skillet or Dutch oven and heat over medium-high until it reaches 350°F on an instant-read thermometer.
      7. [ T-76] (  5m cook) Slow-Braised Collard Greens with Bacon
         ⟶ With the Buttermilk Fried Chicken with Honey chilling, start on the Slow-Braised Collard Greens with Bacon.
         Add the sliced onion to the pot and cook in the bacon fat over medium heat, stirring frequently, for 5 minutes until softened and translucent.
      8. [ T-71] (  1m cook) Slow-Braised Collard Greens with Bacon
         Stir in the minced garlic and ¼ teaspoon crushed red pepper flakes and cook for 1 minute until fragrant.
      9. [ T-70] (  4m cook) Slow-Braised Collard Greens with Bacon
         Add the chopped collard greens in large handfuls, stirring each addition until slightly wilted before adding the next.
     10. [ T-66] (  3m cook) Slow-Braised Collard Greens with Bacon
         Pour in 1½ cups chicken broth and 1 tablespoon apple cider vinegar, season with ½ teaspoon kosher salt and ¼ teaspoon black pepper, stir to combine, and bring to a simmer.
     11. [ T-63] ( 38m cook) Slow-Braised Collard Greens with Bacon
         Reduce heat to low, cover the pot, and braise the collards for 35–40 minutes, stirring once or twice, until very tender and deeply flavored.
     12. [ T-51] (  5m prep) Buttermilk Fried Chicken with Honey
         ⟶ With the Slow-Braised Collard Greens with Bacon cooking, start on the Buttermilk Fried Chicken with Honey.
         Lift each chicken piece from the buttermilk, letting the excess drip off, then dredge thoroughly in the seasoned flour mixture, pressing firmly so the coating adheres; place on a wire rack.
     13. [ T-46] ( 10m preheat) Flaky Drop Biscuits
         ⟶ With the Slow-Braised Collard Greens with Bacon cooking, start on the Flaky Drop Biscuits.
         Preheat the oven to 450°F and line a baking sheet with parchment paper.
     14. [ T-46] (  3m prep) Flaky Drop Biscuits
         Whisk together 2 cups all-purpose flour, 1 tablespoon baking powder, ¼ teaspoon baking soda, ¾ teaspoon kosher salt, and 1 teaspoon sugar in a large bowl.
     15. [ T-43] (  4m prep) Flaky Drop Biscuits
         Add the 6 tablespoons cold cubed butter to the flour mixture and work it in with your fingertips until the mixture resembles coarse crumbs with some pea-sized butter pieces remaining.
     16. [ T-39] (  2m prep) Flaky Drop Biscuits
         Pour in ¾ cup cold buttermilk and stir with a fork just until a shaggy, sticky dough forms — do not overwork.
     17. [ T-36] (  3m assemble) Flaky Drop Biscuits
         Using a large spoon or ¼-cup scoop, drop the dough in 8 mounds onto the prepared baking sheet, spacing them about 2 inches apart.
     18. [ T-33] ( 13m cook) Flaky Drop Biscuits
         Bake at 450°F for 12–14 minutes until the tops are golden brown and a toothpick inserted in the center comes out clean.
     19. [ T-25] (  2m assemble) Slow-Braised Collard Greens with Bacon
         ⟶ With the Flaky Drop Biscuits cooking, start on the Slow-Braised Collard Greens with Bacon.
         Taste and adjust seasoning, then transfer to a serving bowl with some of the pot likker spooned over the top.
     20. [ T-23] ( 16m cook) Buttermilk Fried Chicken with Honey
         ⟶ With the Flaky Drop Biscuits cooking, start on the Buttermilk Fried Chicken with Honey.
         Working in two batches, lower the chicken into the hot oil and fry, turning once halfway through, for 14–16 minutes total until deep golden brown and the internal temperature reaches 165°F; maintain oil temperature between 325°F and 350°F throughout.
     21. [  T-7] (  5m rest) Buttermilk Fried Chicken with Honey
         Transfer the fried chicken to a clean wire rack set over a baking sheet and rest for 5 minutes so the crust sets and the juices redistribute.
     22. [  T-7] (  1m assemble) Flaky Drop Biscuits
         ⟶ With the Buttermilk Fried Chicken with Honey resting, start on the Flaky Drop Biscuits.
         Remove the biscuits from the oven and serve warm.
     23. [  T-2] (  2m assemble) Buttermilk Fried Chicken with Honey
         Arrange the chicken on a platter and drizzle 3 tablespoons honey evenly over the top just before serving.

  ▸ Creamy Country Chicken and Gravy over Biscuits   [Thursday]  SEQUENCED
    footer 64 min | scheduler 64 | card 64 | fresh derive 64 | dishes 3
      1. [ T-64] (  4m prep) Creamy Country Chicken and Gravy
         Pat 1½ pounds boneless skinless chicken thighs dry, then season all over with 1 teaspoon kosher salt, ¾ teaspoon black pepper, ½ teaspoon garlic powder, and ½ teaspoon onion powder.
      2. [ T-60] ( 11m cook) Creamy Country Chicken and Gravy
         Heat 1 tablespoon neutral oil in a large skillet or Dutch oven over medium-high heat until shimmering, then sear the chicken thighs 5 minutes per side until golden and cooked through, then transfer to a plate.
      3. [ T-49] (  5m prep) Creamy Country Chicken and Gravy
         While the chicken rests, finely dice the yellow onion and mince 3 garlic cloves.
      4. [ T-44] (  3m prep) Creamy Country Chicken and Gravy
         Use two forks to pull the rested chicken thighs into bite-sized shreds.
      5. [ T-41] ( 10m preheat) Flaky Buttermilk Drop Biscuits
         Preheat the oven to 450°F and line a baking sheet with parchment paper.
      6. [ T-41] (  3m prep) Flaky Buttermilk Drop Biscuits
         Whisk together 2 cups all-purpose flour, 1 tablespoon baking powder, ¾ teaspoon kosher salt, and 1 teaspoon granulated sugar in a large bowl.
      7. [ T-38] (  5m prep) Creamy Country Chicken and Gravy
         ⟶ With the Flaky Buttermilk Drop Biscuits heating up, start on the Creamy Country Chicken and Gravy.
         Finely dice the yellow onion and mince 3 garlic cloves.
      8. [ T-33] (  4m prep) Flaky Buttermilk Drop Biscuits
         Add 6 tablespoons cold cubed unsalted butter to the flour mixture and work it in with your fingertips until the mixture resembles coarse, pea-sized crumbs.
      9. [ T-29] (  5m cook) Creamy Country Chicken and Gravy
         Melt 3 tablespoons unsalted butter in the skillet over medium heat, add the diced onion, and cook, stirring frequently, for 4–5 minutes until softened and translucent.
     10. [ T-24] (  2m prep) Flaky Buttermilk Drop Biscuits
         Pour in ¾ cup cold buttermilk and stir with a fork just until a shaggy, sticky dough forms — do not overmix.
     11. [ T-22] (  2m assemble) Flaky Buttermilk Drop Biscuits
         Drop the dough in 8 equal mounds onto the prepared baking sheet, spacing them 2 inches apart.
     12. [ T-20] (  1m cook) Creamy Country Chicken and Gravy
         Add the minced garlic and cook, stirring constantly, for 1 minute until fragrant.
     13. [ T-20] ( 14m cook) Flaky Buttermilk Drop Biscuits
         Bake for 13–15 minutes until the biscuits are deep golden brown on top.
     14. [ T-19] (  2m cook) Creamy Country Chicken and Gravy
         ⟶ With the Flaky Buttermilk Drop Biscuits cooking, start on the Creamy Country Chicken and Gravy.
         Sprinkle 3 tablespoons all-purpose flour over the onions and stir continuously for 1–2 minutes to cook out the raw flour taste.
     15. [ T-17] (  3m cook) Creamy Country Chicken and Gravy
         Pour in 1½ cups low-sodium chicken broth in a slow stream, whisking constantly to prevent lumps, then whisk in 1 cup whole milk, ¼ cup heavy cream, and 1 teaspoon Worcestershire sauce.
     16. [ T-14] (  4m prep) Simple Steamed Green Beans with Butter
         ⟶ With the Flaky Buttermilk Drop Biscuits cooking, start on the Simple Steamed Green Beans with Butter.
         Trim the stem ends from 12 ounces of fresh green beans.
     17. [ T-10] (  8m cook) Creamy Country Chicken and Gravy
         ⟶ With the Flaky Buttermilk Drop Biscuits cooking, start on the Creamy Country Chicken and Gravy.
         Add 4 sprigs of fresh thyme and bring the gravy to a gentle simmer over medium heat, stirring occasionally, for 6–8 minutes until thickened enough to coat a spoon.
     18. [ T-10] (  6m cook) Simple Steamed Green Beans with Butter
         ⟶ With the Flaky Buttermilk Drop Biscuits cooking, start on the Simple Steamed Green Beans with Butter.
         Bring 1 inch of water to a boil in a large saucepan fitted with a steamer basket over medium-high heat, add the green beans, cover, and steam for 5–6 minutes until bright green and just tender-crisp.
     19. [  T-6] (  3m assemble) Flaky Buttermilk Drop Biscuits
         ⟶ With the Creamy Country Chicken and Gravy marinating, start on the Flaky Buttermilk Drop Biscuits.
         Transfer the biscuits to a wire rack and let them cool for 2 minutes, then split each one in half to serve.
     20. [  T-3] (  2m assemble) Simple Steamed Green Beans with Butter
         ⟶ With the Creamy Country Chicken and Gravy marinating, start on the Simple Steamed Green Beans with Butter.
         Transfer the green beans to a serving bowl, toss with 1 tablespoon unsalted butter, ¼ teaspoon kosher salt, and ⅛ teaspoon black pepper, and serve with lemon wedges on the side if desired.
     21. [  T-2] (  2m cook) Creamy Country Chicken and Gravy
         Remove and discard the thyme sprigs, fold in the shredded chicken, and simmer 2 minutes more to heat through; taste and adjust salt and pepper.

  ▸ Falafel Plate with Hummus, Tabbouleh, and Warm Flatbread   [Saturday]  SEQUENCED
    footer 100 min | scheduler 100 | card 100 | fresh derive 100 | dishes 4
      1. [T-100] (  3m prep) Herb Falafel
         Drain the soaked chickpeas well and pat them dry with a clean kitchen towel — excess moisture will make the falafel fall apart.
      2. [ T-97] (  5m prep) Herb Falafel
         Add the chickpeas, roughly chopped yellow onion, 1 cup parsley, ½ cup cilantro, 4 garlic cloves, 1½ teaspoons cumin, 1 teaspoon coriander, ¼ teaspoon cayenne, 1¼ teaspoons kosher salt, and 1 teaspoon baking powder to a food processor and pulse 25–30 times until the mixture is coarse and crumbly — not a paste.
      3. [ T-92] (  3m prep) Herb Falafel
         Sprinkle 3 tablespoons flour over the mixture and pulse 5 more times to combine, then transfer to a bowl, cover, and refrigerate for 30 minutes to firm up.
      4. [ T-89] ( 30m rest) Herb Falafel
         Chill the falafel mixture in the refrigerator for 30 minutes so it holds its shape when formed.
      5. [ T-59] (  6m prep) Herb Falafel
         Scoop the chilled mixture and firmly press into 16 golf ball-sized patties (about 1½ inches wide and ¾ inch thick), compacting each well so they don't crack during frying.
      6. [ T-53] ( 15m cook) Tabbouleh
         Place ½ cup fine bulgur wheat in a heatproof bowl and pour ¾ cup boiling water over it, stir once, cover with a plate, and let it steam for 15 minutes until tender.
      7. [ T-53] ( 10m prep) Tabbouleh
         While the bulgur steams, finely chop 2 cups parsley and ¼ cup fresh mint leaves, thinly slice 4 green onions, finely dice 3 seeded roma tomatoes, and finely dice ½ English cucumber.
      8. [ T-43] (  4m preheat) Herb Falafel
         ⟶ With the Tabbouleh cooking, start on the Herb Falafel.
         Pour 2 cups neutral oil into a large heavy skillet (cast iron works well) and heat over medium-high until the oil reaches 350°F — a small piece of mixture dropped in should sizzle immediately.
      9. [ T-43] (  3m prep) Creamy Hummus
         ⟶ With the Tabbouleh cooking, start on the Creamy Hummus.
         Drain the two 15-oz cans of chickpeas, reserving the liquid, and peel the 2 garlic cloves.
     10. [ T-39] ( 16m cook) Herb Falafel
         ⟶ With the Tabbouleh cooking, start on the Herb Falafel.
         Working in two batches, fry the falafel patties for 3–4 minutes per side, turning once, until deep golden-brown and crisp on both sides, then transfer to a paper-towel-lined plate.
     11. [ T-23] (  2m prep) Warm Flatbread
         Brush both sides of each pita with 1 tablespoon extra-virgin olive oil divided evenly across the 4 pieces.
     12. [ T-21] (  3m prep) Creamy Hummus
         Add the garlic cloves to a food processor and pulse until minced, then add the drained chickpeas, ½ cup tahini, 3 tablespoons lemon juice, ¾ teaspoon kosher salt, and ¼ teaspoon cumin and process for 1 minute.
     13. [ T-18] (  5m rest) Tabbouleh
         Fluff the cooked bulgur with a fork, spread it on a plate to cool for 5 minutes, then transfer to a large bowl.
     14. [ T-18] (  8m cook) Warm Flatbread
         ⟶ With the Tabbouleh cooking, start on the Warm Flatbread.
         Heat a dry skillet over medium-high and warm each pita for 1–2 minutes per side until lightly toasted and pliable, then wrap in a clean kitchen towel to keep warm until serving.
     15. [ T-10] (  4m prep) Creamy Hummus
         With the processor running, drizzle in 4 tablespoons ice water one tablespoon at a time, then continue processing for 2–3 minutes until the hummus is very smooth and creamy.
     16. [  T-6] (  2m assemble) Tabbouleh
         Add the parsley, mint, tomatoes, cucumber, and green onions to the bulgur, then drizzle with 3 tablespoons lemon juice and 3 tablespoons extra-virgin olive oil.
     17. [  T-4] (  2m assemble) Creamy Hummus
         Spread the hummus into a wide shallow bowl, use the back of a spoon to create a swirl, drizzle with 2 tablespoons extra-virgin olive oil, and dust with smoked paprika (optional).
     18. [  T-2] (  2m assemble) Tabbouleh
         Season with ¾ teaspoon kosher salt and ¼ teaspoon black pepper, toss well to combine, and taste and adjust lemon or salt as needed before serving.

══════════ COOK MODE — PREPPED PATH: Creamy Country Chicken and Gravy over Biscuits ══════════
  ticked 6 rendered prep steps → isPrepped=false; + every wire step for the meal (10) → isPrepped=false; blockers [{"stepKey":"seasonings_dry#dish#c9d2dd05-df21-40b4-b9ca-58b8c3861192","onWire":false,"rendered":false,"title":null,"skipSuggested":null},{"stepKey":"seasonings_dry#dish#6e55f8dd-d714-4d7b-862b-0667555644bf","onWire":false,"rendered":false,"title":null,"skipSuggested":null}]
  recap ("You already prepped this — get your:"):
    · Pat 1½ pounds boneless skinless chicken thighs dry, then season all over with 1 teaspoon kosher salt, ¾ teaspoon black pepper, ½ teaspoon garlic powder, and ½ teaspoon onion powder.
    · While the chicken rests, finely dice the yellow onion and mince 3 garlic cloves.
    · Use two forks to pull the rested chicken thighs into bite-sized shreds.
    · Whisk together 2 cups all-purpose flour, 1 tablespoon baking powder, ¾ teaspoon kosher salt, and 1 teaspoon granulated sugar in a large bowl.
    · Finely dice the yellow onion and mince 3 garlic cloves.
    · Add 6 tablespoons cold cubed unsalted butter to the flour mixture and work it in with your fingertips until the mixture resembles coarse, pea-sized crumbs.
    · Pour in ¾ cup cold buttermilk and stir with a fork just until a shaggy, sticky dough forms — do not overmix.
    · Trim the stem ends from 12 ounces of fresh green beans.
  footer 60 min; steps after the prep filter:
      1. [T-60] (cook) Creamy Country Chicken and Gravy
         Heat 1 tablespoon neutral oil in a large skillet or Dutch oven over medium-high heat until shimmering, then sear the chicken thighs 5 minutes per side until golden and cooked through, then transfer to a plate.
      2. [T-41] (preheat) Flaky Buttermilk Drop Biscuits
         Preheat the oven to 450°F and line a baking sheet with parchment paper.
      3. [T-29] (cook) Creamy Country Chicken and Gravy
         Melt 3 tablespoons unsalted butter in the skillet over medium heat, add the diced onion, and cook, stirring frequently, for 4–5 minutes until softened and translucent.
      4. [T-22] (assemble) Flaky Buttermilk Drop Biscuits
         Drop the dough in 8 equal mounds onto the prepared baking sheet, spacing them 2 inches apart.
      5. [T-20] (cook) Creamy Country Chicken and Gravy
         Add the minced garlic and cook, stirring constantly, for 1 minute until fragrant.
      6. [T-20] (cook) Flaky Buttermilk Drop Biscuits
         Bake for 13–15 minutes until the biscuits are deep golden brown on top.
      7. [T-19] (cook) Creamy Country Chicken and Gravy  ⟶ With the Flaky Buttermilk Drop Biscuits cooking, start on the Creamy Country Chicken and Gravy.
         Sprinkle 3 tablespoons all-purpose flour over the onions and stir continuously for 1–2 minutes to cook out the raw flour taste.
      8. [T-17] (cook) Creamy Country Chicken and Gravy
         Pour in 1½ cups low-sodium chicken broth in a slow stream, whisking constantly to prevent lumps, then whisk in 1 cup whole milk, ¼ cup heavy cream, and 1 teaspoon Worcestershire sauce.
      9. [T-10] (cook) Creamy Country Chicken and Gravy  ⟶ With the Flaky Buttermilk Drop Biscuits cooking, start on the Creamy Country Chicken and Gravy.
         Add 4 sprigs of fresh thyme and bring the gravy to a gentle simmer over medium heat, stirring occasionally, for 6–8 minutes until thickened enough to coat a spoon.
     10. [T-10] (cook) Simple Steamed Green Beans with Butter  ⟶ With the Flaky Buttermilk Drop Biscuits cooking, start on the Simple Steamed Green Beans with Butter.
         Bring 1 inch of water to a boil in a large saucepan fitted with a steamer basket over medium-high heat, add the green beans, cover, and steam for 5–6 minutes until bright green and just tender-crisp.
     11. [T-6] (assemble) Flaky Buttermilk Drop Biscuits  ⟶ With the Creamy Country Chicken and Gravy marinating, start on the Flaky Buttermilk Drop Biscuits.
         Transfer the biscuits to a wire rack and let them cool for 2 minutes, then split each one in half to serve.
     12. [T-3] (assemble) Simple Steamed Green Beans with Butter  ⟶ With the Creamy Country Chicken and Gravy marinating, start on the Simple Steamed Green Beans with Butter.
         Transfer the green beans to a serving bowl, toss with 1 tablespoon unsalted butter, ¼ teaspoon kosher salt, and ⅛ teaspoon black pepper, and serve with lemon wedges on the side if desired.
     13. [T-2] (cook) Creamy Country Chicken and Gravy
         Remove and discard the thyme sprigs, fold in the shredded chicken, and simmer 2 minutes more to heat through; taste and adjust salt and pepper.```

# Appendix B — full narrated Prep the Week for A01, A04, A16

## 873796cd
```
PLAN 873796cd-4e7e-4a4a-bdfe-28a802f295d7  [A01]  Part I · A01 · 7 meals, Sun–Sat: marinades, seafood, slaw
  range 2026-10-04 .. 2026-10-10   meals 7   prep day 2026-10-04   shapes: plan-7-meals, days-5-7, cold, long-passive, multi-3plus, marinate, aromatics, single-dish, seafood, bought-path, two-cuts, toss-no-heat

══════════ PREP THE WEEK — full plan, as Screen 3 renders it ══════════
  HEADER: 30 containers · about 150 min   (server total 195 · phone 132) · cacheHit=false · prompt v19
  HELD: Add the skirt steak the night before you cook them (Saturday).
  HELD: Add the skirt steak the night before you cook them (Saturday).
  HELD: Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday, 3 days out) — whole chicken that morning.
  HELD: Teriyaki Salmon Dinner (Thursday, 4 days out) — portion the salmon for Teriyaki Salmon that morning.
  HELD: Classic Sizzling Chicken Fajitas (Friday, 5 days out) — cut the chicken breasts into strips for Lime-Marinated Chicken Fajitas that morning.

  ── seasonings_dry ──
     1. Measure the Citrus-Marinated Carne Asada marinade spices   (3 min)
        Into the Citrus-Marinated Carne Asada marinade bowl:
        1 tsp ground cumin
        1 tsp chili powder
        ½ tsp smoked paprika
        ½ tsp dried oregano
        Set aside for the produce step.
        » for: Carne Asada Tacos (Sunday)
     2. Measure the Texas-Style Beef Chili spice blend   (2 min)
        Into the Texas-Style Beef Chili spice blend:
        2 tsp ground cumin
        1 tsp smoked paprika
        1 tsp dried oregano
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Texas-Style Beef Chili (Monday)
     3. Measure the Lime-Marinated Chicken Fajitas marinade bowl spices   (4 min)
        Into the Lime-Marinated Chicken Fajitas marinade bowl:
        1 tsp ground cumin
        1½ tsp chili powder
        ¾ tsp smoked paprika
        ½ tsp dried oregano
        ½ tsp garlic powder
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Classic Sizzling Chicken Fajitas (Friday)
     4. Measure the Smoky Carne Asada marinade spices   (3 min)
        Into the Smoky Carne Asada marinade bowl:
        1½ tsp ground cumin
        1 tsp smoked paprika
        ½ tsp dried oregano
        Set aside for the produce step.
        » for: Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
     5. Measure the Beer-Battered Cod Fish Tacos batter bowl   (4 min)
        Into the Beer-Battered Cod Fish Tacos batter bowl:
        1 cup all-purpose flour
        ¼ cup cornstarch
        1 tsp baking powder
        1 tsp smoked paprika
        ½ tsp garlic powder
        ¼ tsp cayenne pepper
        Then pour in 1 cup cold lager beer and whisk until a smooth, thick batter forms.
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Baja Fish Tacos with Quick Slaw and Lime Crema (Tuesday)
     6. Measure the Dry-Rubbed Roast Chicken dry mix   (3 min)
        Into the Dry-Rubbed Roast Chicken dry mix:
        1½ tsp smoked paprika
        1 tsp garlic powder
        ¾ tsp onion powder
        ½ tsp dried thyme
        ¼ tsp cayenne pepper
        1 tsp brown sugar
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday)
     7. Prep the Texas-Style Beef Chili dried chiles   (1 min)
        Into the Texas-Style Beef Chili — dried chiles, stemmed and seeded:
        3 dried ancho chiles, stemmed and seeded
        2 dried guajillo chiles, stemmed and seeded
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Texas-Style Beef Chili (Monday)
  ×  8. Ground cumin — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
  ×  9. Masa harina — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Texas-Style Beef Chili (Monday)

  ── produce ──
     1. Wash and dry all the produce   (3 min)
        Wash and dry everything you are about to cut. One pass now keeps the board dry and the knife work clean.
        » for: Carne Asada Tacos (Sunday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday), Baja Fish Tacos with Quick Slaw and Lime Crema (Tuesday), Classic Sizzling Chicken Fajitas (Friday), Texas-Style Beef Chili (Monday), Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday), Teriyaki Salmon Dinner (Thursday)
     2. Measure the orange juice   (2 min)
        Measure the orange juice and pour each portion into its container:
        ¼ cup for the Citrus-Marinated Carne Asada — into the Citrus-Marinated Carne Asada marinade bowl
        3 tbsp for the Smoky Carne Asada — into the Smoky Carne Asada marinade bowl
        » for: Carne Asada Tacos (Sunday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
  ×  3. Lime juice, lime and lime zest — cook day   (15 min)  [RENDER-OMITTED]
        Citrus wedges keep best cut on the day.
        » for: Carne Asada Tacos (Sunday), Baja Fish Tacos with Quick Slaw and Lime Crema (Tuesday), Classic Sizzling Chicken Fajitas (Friday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday), Texas-Style Beef Chili (Monday)
     4. Prep all garlic   (8 min)
        Mince, then thinly slice the garlic as noted, and portion into each container:
        4 cloves minced — into the Citrus-Marinated Carne Asada marinade bowl
        6 cloves minced + 3 cloves minced — into a tub labelled "Minced garlic — Texas-Style Beef Chili, Garlic Roasted Potatoes"
        3 cloves minced — into the Lime-Marinated Chicken Fajitas vegetables
        4 cloves minced — into the Smoky Carne Asada marinade bowl
        2 cloves minced — into the Teriyaki Salmon glaze jar
        2 cloves thinly sliced — into a tub labelled "Sautéed Garlic Green Beans — thinly sliced garlic"
        » storage: Citrus-Marinated Carne Asada marinade bowl: Covered in the fridge — up to 3 days. Airtight in the fridge — up to 4 days. Add the skirt steak the night before you cook them (Saturday).
        » for: Carne Asada Tacos (Sunday), Texas-Style Beef Chili (Monday), Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday), Teriyaki Salmon Dinner (Thursday), Classic Sizzling Chicken Fajitas (Friday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
     5. Dice all roma tomatoes   (15 min)
        Dice all roma tomatoes and portion into each container:
        3 diced — into a tub labelled "Fresh Pico de Gallo — roma tomatoes, white onion, fresh cilantro and jalapeño"
        3 finely diced — into a tub labelled "Fajita Toppings: Pico de Gallo, Guacamole, and Sour Cream — roma tomatoes, white onion, fresh cilantro and jalapeño"
        2 diced — into a tub labelled "Black Bean Salsa — roma tomatoes, white onion, fresh cilantro and jalapeño"
        » for: Carne Asada Tacos (Sunday), Classic Sizzling Chicken Fajitas (Friday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
     6. Dice all white onion   (8 min)
        Finely dice the white onion and portion:
        ½ — into a tub labelled "Fresh Pico de Gallo — roma tomatoes, white onion, fresh cilantro and jalapeño"
        ¼ — into a tub labelled "Finely diced white onion — Simple Guacamole, Texas-Style Beef Chili"
        ½ (for garnish) — into a tub labelled "Finely diced white onion — Simple Guacamole, Texas-Style Beef Chili"
        ½ — into a tub labelled "Black Bean Salsa — roma tomatoes, white onion, fresh cilantro and jalapeño"
        ¼ cup — into a tub labelled "Fajita Toppings: Pico de Gallo, Guacamole, and Sour Cream — roma tomatoes, white onion, fresh cilantro and jalapeño"
        » storage: Airtight in the fridge — up to 4 days.
        » for: Carne Asada Tacos (Sunday), Texas-Style Beef Chili (Monday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday), Classic Sizzling Chicken Fajitas (Friday)
     7. Chop all fresh cilantro   (8 min)
        Chop the cilantro as noted per dish and portion:
        ¼ cup chopped — into a tub labelled "Fresh Pico de Gallo — roma tomatoes, white onion, fresh cilantro and jalapeño"
        2 tbsp chopped + ¼ cup roughly chopped + ¼ cup roughly chopped + ¼ cup roughly chopped — into a tub labelled "Chopped fresh cilantro — Simple Guacamole, Texas-Style Beef Chili, Lime-Marinated Chicken Fajitas with Peppers and Onio…"
        ½ cup leaves picked — into a tub labelled "Beer-Battered Cod Fish Tacos — fresh cilantro"
        2 tbsp finely chopped — into a tub labelled "Fajita Toppings: Pico de Gallo, Guacamole, and Sour Cream — roma tomatoes, white onion, fresh cilantro and jalapeño"
        ¼ cup roughly chopped — into a tub labelled "Black Bean Salsa — roma tomatoes, white onion, fresh cilantro and jalapeño"
        » storage: Both containers: Airtight in the fridge, with a barely damp paper towel — up to 3 days.
        » for: Carne Asada Tacos (Sunday), Texas-Style Beef Chili (Monday), Baja Fish Tacos with Quick Slaw and Lime Crema (Tuesday), Classic Sizzling Chicken Fajitas (Friday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
     8. Prep all jalapeños   (15 min)
        Seed and mince, then thinly slice as noted, and portion:
        ½ seeded and minced — into a tub labelled "Fresh Pico de Gallo — roma tomatoes, white onion, fresh cilantro and jalapeño"
        1 seeded and minced — into a tub labelled "Fajita Toppings: Pico de Gallo, Guacamole, and Sour Cream — roma tomatoes, white onion, fresh cilantro and jalapeño"
        1 seeded and minced — into a tub labelled "Black Bean Salsa — roma tomatoes, white onion, fresh cilantro and jalapeño"
        4 thinly sliced — into a tub labelled "Quick Pickled Jalapeños — thinly sliced jalapeño"
        » storage: Fresh Pico de Gallo: Airtight in the fridge, with a barely damp paper towel — up to 3 days. Fajita Toppings: Pico de Gallo, Guacamole, and Sour Cream: Airtight in the fridge, with a barely damp paper…
        » for: Carne Asada Tacos (Sunday), Classic Sizzling Chicken Fajitas (Friday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
  ×  9. Ripe avocado — cook day   (1 min)  [RENDER-OMITTED]
        This browns once it is cut, so it is cut on cook day.
        » for: Carne Asada Tacos (Sunday), Classic Sizzling Chicken Fajitas (Friday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
    10. Prep all yellow onion   (5 min)
        Dice and slice the yellow onion as noted per dish:
        1 diced — into a tub labelled "Texas-Style Beef Chili — diced yellow onion"
        1 halved and sliced into ¼-inch half-moons — into the Lime-Marinated Chicken Fajitas vegetables
        » storage: Airtight in the fridge — up to 4 days.
        » for: Texas-Style Beef Chili (Monday), Classic Sizzling Chicken Fajitas (Friday)
    11. Prep all lemons   (2 min)
        Halve 1 lemon and juice ½ more:
        1 halved — into a tub labelled "Dry-Rubbed Roast Chicken with Crispy Skin — halved fresh lemon"
        1 tbsp juice — into a tub labelled "Sautéed Garlic Green Beans — fresh lemon juice"
        » storage: Airtight in the fridge — up to 3 days. Covered in the fridge — up to 3 days.
        » for: Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday)
  × 12. Fresh thyme sprigs — cook day   (1 min)  [RENDER-OMITTED]
        Nothing to cut — it goes in as it comes.
        » for: Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday)
  × 13. Baby Yukon gold potatoes — cook day   (3 min)  [RENDER-OMITTED]
        This browns once it is cut, so it is cut on cook day.
        » for: Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday)
    14. Chop the fresh rosemary for Garlic Roasted Potatoes   (1 min)
        Finely chop the fresh rosemary:
        1 tsp — into a tub labelled "Garlic Roasted Potatoes — finely chopped fresh rosemary"
        » storage: Airtight in the fridge, with a barely damp paper towel — up to 3 days.
        » for: Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday)
    15. Trim the green beans for Sautéed Garlic Green Beans   (2 min)
        Trim the ends from the green beans:
        1 lb — into a tub labelled "Sautéed Garlic Green Beans — trimmed fresh green beans"
        » storage: Airtight in the fridge — up to 4 days.
        » for: Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday)
    16. Grate the fresh ginger for Teriyaki Salmon   (1 min)
        Grate the fresh ginger:
        1 tsp — into the Teriyaki Salmon glaze jar
        » for: Teriyaki Salmon Dinner (Thursday)
    17. Slice the scallions for Teriyaki Salmon   (1 min)
        Thinly slice the scallions:
        2 — into a tub labelled "Teriyaki Salmon — thinly sliced scallions"
        » storage: Airtight in the fridge — up to 3 days.
        » for: Teriyaki Salmon Dinner (Thursday)
    18. Slice the cucumber for Sesame Cucumber Salad   (3 min)
        Thinly slice the English cucumber:
        1 — into a tub labelled "Sesame Cucumber Salad — thinly sliced english cucumber"
        » storage: Airtight in the fridge — up to 4 days.
        » for: Teriyaki Salmon Dinner (Thursday)
    19. Slice the red bell peppers for Lime-Marinated Chicken Fajitas   (5 min)
        Core, seed, and slice the red bell peppers into ¼-inch strips:
        2 — into the Lime-Marinated Chicken Fajitas vegetables
        » for: Classic Sizzling Chicken Fajitas (Friday)
    20. Slice the green bell pepper for Lime-Marinated Chicken Fajitas   (3 min)
        Core, seed, and slice the green bell pepper into ¼-inch strips:
        1 — into the Lime-Marinated Chicken Fajitas vegetables
        » storage: Lime-Marinated Chicken Fajitas vegetables: Airtight in the fridge — up to 4 days.
        » for: Classic Sizzling Chicken Fajitas (Friday)
  × 21. Avocado oil — cook day   (1 min)  [RENDER-OMITTED]
        This browns once it is cut, so it is cut on cook day.
        » for: Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
    22. Slice the radishes for Fresh Toppings   (1 min)
        Thinly slice the radishes:
        4 — into a tub labelled "Fresh Toppings — thinly sliced thinly sliced radish"
        » storage: Airtight in the fridge — up to 3 days.
        » for: Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)

  ── sauces_marinades ──
     1. Finish the Smoky Carne Asada marinade bowl   (6 min)
        Smoky Carne Asada marinade bowl (ground cumin, smoked paprika, dried oregano, the orange juice from produce step 2 and garlic already in it): add
        2 minced chipotle chiles in adobo
        Whisk to combine.
        » storage: Covered in the fridge — up to 3 days. Add the skirt steak the night before you cook them (Saturday).
        » for: Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
     2. Build the Quick Cabbage Slaw and Lime mix-ins bowl   (2 min)
        Into the Quick Cabbage Slaw and Lime mix-ins bowl:
        ¼ cup mayonnaise
        1 tbsp apple cider vinegar
        1 tsp honey
        1 tsp hot sauce (such as Cholula)
        Whisk to combine.
        » storage: Covered in the fridge — up to 5 days.
        » for: Baja Fish Tacos with Quick Slaw and Lime Crema (Tuesday)
     3. Finish the Teriyaki Salmon glaze jar   (4 min)
        Teriyaki Salmon glaze jar (garlic and fresh ginger already in it): add
        2 tbsp honey
        ¼ cup soy sauce
        3 tbsp mirin
        2 tbsp sake
        1 tsp sesame oil
        Whisk to combine.
        » storage: Covered in the fridge — up to 4 days.
        » for: Teriyaki Salmon Dinner (Thursday)
     4. Build the Sesame Cucumber Salad dressing jar   (3 min)
        Into the Sesame Cucumber Salad dressing jar:
        1 tsp honey
        1 tbsp soy sauce
        1 tbsp sesame oil
        2 tbsp rice vinegar
        Whisk to combine.
        » storage: Covered in the fridge — up to 4 days.
        » for: Teriyaki Salmon Dinner (Thursday)
  ×  5. Chipotle chile in adobo — cook day   (5 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Texas-Style Beef Chili (Monday)
  ×  6. White wine vinegar — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)

  ── proteins ──
     » Fish, poultry and meat keep about two days once handled, so this phase only preps what you'll cook soon.
  ×  1. Skirt steak — cook day   (9 min)  [RENDER-OMITTED]
        Nothing to do to it before the pan — it goes in straight from the package on cook day.
        » for: Carne Asada Tacos (Sunday), Smoky Carne Asada Tostadas with Black Bean Salsa and Pickled Jalapeños (Saturday)
     2. Cube the beef chuck for Texas-Style Beef Chili   (8 min)
        Cube 2 lb beef chuck into ¾-inch pieces, pat dry, and set in its storage container.
        » storage: Covered in the fridge — cook within 2 days.
        » for: Texas-Style Beef Chili (Monday)
     3. Cut the cod into strips for Beer-Battered Cod Fish Tacos   (6 min)
        Cut 1½ lb cod fillets into 1-inch strips and set in their storage container.
        » storage: Covered in the fridge — cook within 2 days.
        » for: Baja Fish Tacos with Quick Slaw and Lime Crema (Tuesday)
  ×  4. Whole chicken — cook day   (12 min)  [RENDER-OMITTED]
        Pat 4 lb whole chicken completely dry with paper towels, including inside the cavity — thorough drying is the key to crispy skin.
        » storage: This one is 3 days out — leave it for cook day.
        » for: Dry-Rubbed Roast Chicken with Crispy Skin, Roasted Potatoes, and Green Beans (Wednesday)
  ×  5. Salmon fillets — cook day   (6 min)  [RENDER-OMITTED]
        Portion 1½ lb skin-on salmon into 4 equal pieces and set in their storage container.
        » storage: This one is 4 days out — leave it for cook day.
        » for: Teriyaki Salmon Dinner (Thursday)
  ×  6. Boneless skinless chicken breasts — cook day   (7 min)  [RENDER-OMITTED]
        Cut 1¾ lb boneless skinless chicken breasts into ½-inch strips against the grain and set in their storage container.
        » storage: This one is 5 days out — leave it for cook day.
        » for: Classic Sizzling Chicken Fajitas (Friday)

```

## 7f206a48
```
PLAN 7f206a48-f9ca-46c3-b4ba-94c35a320da2  [A04]  Part I · A04 · 2 meals: shrimp tacos + al pastor (late)
  range 2026-10-04 .. 2026-10-10   meals 2   prep day 2026-10-04   shapes: plan-2-meals, days-5-7, seafood, cold, long-passive, multi-3plus, aromatics, two-cuts, toss-no-heat, marinate

══════════ PREP THE WEEK — full plan, as Screen 3 renders it ══════════
  HEADER: 13 containers · about 65 min   (server total 65 · phone 56) · cacheHit=false · prompt v19
  HELD: Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday, 6 days out) — cut the pork tenderloin into strips for Al Pastor Pork Strips that morning.

  ── seasonings_dry ──
     1. Measure the Baja Chili-Lime Shrimp Tacos spice blend   (2 min)
        Into the Baja Chili-Lime Shrimp Tacos spice blend:
        1½ tsp chili powder
        1 tsp ground cumin
        ½ tsp smoked paprika
        ½ tsp garlic powder
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday)
     2. Measure the Al Pastor Pork Strips marinade bowl spices   (3 min)
        Into the Al Pastor Pork Strips marinade bowl:
        1 tsp ground cumin
        1 tsp smoked paprika
        1½ tsp ancho chili powder
        Set aside for the produce step.
        » for: Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)

  ── produce ──
     1. Wash and dry all the produce   (3 min)
        Wash and dry everything you are about to cut. One pass now keeps the board dry and the knife work clean.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday), Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)
     2. Prep all limes   (11 min)
        Zest 1 lime, then juice it — zest and juice go into a tub labelled "Baja Chili-Lime Shrimp Tacos — zested lime".
        
        Juice enough limes for the remaining portions:
        1 tbsp — into the Chipotle Crema jar
        3 tbsp and 3 tbsp — into a tub labelled "Lime juice, fresh — Tangy Cabbage Slaw, Cilantro-Lime Slaw"
        
        For the 2 limes going to Warm Corn Tortillas with Cotija, those are cook-day — store them in a tub labelled "Warm Corn Tortillas with Cotija — lime".
        » storage: Airtight in the fridge — up to 3 days. Covered in the fridge — up to 3 days.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday), Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)
     3. Roughly chop all fresh cilantro   (4 min)
        Roughly chop all the cilantro, then portion it out:
        ¼ cup for Baja Chili-Lime Shrimp Tacos and ½ cup for Cilantro-Lime Slaw — into a tub labelled "Chopped fresh cilantro — Baja Chili-Lime Shrimp Tacos, Cilantro-Lime Slaw"
        ¼ cup for Tangy Cabbage Slaw — into the Tangy Cabbage Slaw sauce bowl
        » storage: Airtight in the fridge, with a barely damp paper towel — up to 3 days.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday), Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)
  ×  4. Avocado — cook day   (1 min)  [RENDER-OMITTED]
        This browns once it is cut, so it is cut on cook day.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday)
     5. Prep all garlic   (2 min)
        Finely grate 1 clove garlic — into the Chipotle Crema jar.
        Mince 3 cloves garlic — into the Al Pastor Pork Strips marinade bowl.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday), Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)
     6. Shred all green cabbage   (1 min)
        Finely shred 3 cups green cabbage for Tangy Cabbage Slaw and thinly shred 3 cups for Cilantro-Lime Slaw — all 6 cups go into a tub labelled "Shredded green cabbage — Tangy Cabbage Slaw, Cilantro-Lime Slaw".
        » storage: Airtight in the fridge — up to 4 days.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday), Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)
     7. Shred the red cabbage for Tangy Cabbage Slaw   (1 min)
        Finely shred 1 cup red cabbage — into a tub labelled "Tangy Cabbage Slaw — shredded red cabbage".
        » storage: Airtight in the fridge — up to 4 days.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday)
     8. Slice all jalapeño   (5 min)
        Seed and thinly slice 1 jalapeño — into the Tangy Cabbage Slaw sauce bowl.
        Thinly slice 1 jalapeño — into a tub labelled "Cilantro-Lime Slaw — thinly sliced jalapeño".
        » storage: Airtight in the fridge — up to 4 days.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday), Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)
     9. Juice the orange for Al Pastor Pork Strips   (2 min)
        Squeeze ¼ cup fresh orange juice — into the Al Pastor Pork Strips marinade bowl.
        » for: Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)
    10. Cut the fresh pineapple for Charred Pineapple   (1 min)
        Cut 1½ cup fresh pineapple into small chunks — into a tub labelled "Charred Pineapple — fresh pineapple".
        » storage: Airtight in the fridge — up to 3 days.
        » for: Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)

  ── sauces_marinades ──
     1. Finish the Al Pastor Pork Strips marinade bowl   (7 min)
        Al Pastor Pork Strips marinade bowl (ground cumin, smoked paprika, ancho chili powder, garlic and the fresh orange juice from produce step 9 already in it): add
        2 chipotle peppers in adobo sauce, minced
        2 tbsp adobo sauce
        1 tbsp white vinegar
        Whisk to combine.
        » storage: Covered in the fridge — up to 3 days.
        » for: Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)
     2. Finish the Tangy Cabbage Slaw sauce bowl   (2 min)
        Tangy Cabbage Slaw sauce bowl (fresh cilantro and jalapeño already in it): add
        1 tbsp apple cider vinegar
        Stir to combine.
        » storage: Covered in the fridge — up to 3 days.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday)
     3. Finish the Chipotle Crema jar   (7 min)
        Chipotle Crema jar (the lime juice, fresh from produce step 2 and garlic already in it): add
        ¼ cup mayonnaise
        2 chipotle peppers in adobo sauce, minced, plus 1 teaspoon adobo sauce
        Stir to combine.
        » storage: Covered in the fridge — up to 3 days.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday)
  ×  4. Honey — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday)
  ×  5. Honey — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)

  ── proteins ──
     » Fish, poultry and meat keep about two days once handled, so this phase only preps what you'll cook soon.
     1. Pat dry the shrimp for Baja Chili-Lime Shrimp Tacos   (5 min)
        Pat 1½ lb large shrimp dry with paper towels.
        » storage: Covered in the fridge — cook within 2 days.
        » for: Baja Shrimp Tacos with Chipotle Crema and Cabbage Slaw (Monday)
  ×  2. Pork tenderloin — cook day   (6 min)  [RENDER-OMITTED]
        Cut 1½ lb pork tenderloin into thin strips and pat dry with paper towels.
        » storage: This one is 6 days out — leave it for cook day.
        » for: Al Pastor Pork Tacos with Charred Pineapple, Cotija, and Cilantro-Lime Slaw (Saturday)

```

## b0c8ffbd
```
PLAN b0c8ffbd-b167-4265-8fb3-2782bc72092e  [A16]  Part I · A16 · seafood: shrimp bowl, seared tuna, catfish, salmon
  range 2026-10-04 .. 2026-10-10   meals 4   prep day 2026-10-04   shapes: days-5-7, seafood, cold, long-passive, multi-3plus, aromatics, two-cuts, marinate

══════════ PREP THE WEEK — full plan, as Screen 3 renders it ══════════
  HEADER: 21 containers · about 95 min   (server total 101 · phone 82) · cacheHit=false · prompt v19
  HELD: Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday, 6 days out) — portion the salmon fillets that morning.

  ── seasonings_dry ──
     1. Measure the Chili-Lime Sautéed Shrimp spice blend   (3 min)
        Into the Chili-Lime Sautéed Shrimp spice blend:
        1½ tsp chili powder
        1 tsp smoked paprika
        ¾ tsp ground cumin
        ½ tsp garlic powder
        ½ tsp onion powder
        ⅛ tsp cayenne pepper
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
     2. Measure the Blackened Catfish spice blend   (3 min)
        Into the Blackened Catfish spice blend:
        1½ tsp smoked paprika
        1 tsp garlic powder
        ¾ tsp onion powder
        ½ tsp cayenne pepper
        ½ tsp dried thyme
        ½ tsp dried oregano
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Blackened Catfish with Dirty Rice and Braised Greens (Thursday)
     3. Measure the Dirty Rice spice blend   (2 min)
        Into the Dirty Rice spice blend:
        ½ tsp smoked paprika
        ¼ tsp cayenne pepper
        ½ tsp dried thyme
        » storage: Airtight at room temperature — it keeps for weeks.
        » for: Blackened Catfish with Dirty Rice and Braised Greens (Thursday)
     4. Measure the Sesame-Crusted Seared Ahi Tuna marinade bowl   (2 min)
        Into the Sesame-Crusted Seared Ahi Tuna marinade bowl:
        4 tbsp sesame seeds (mix of white and black if available)
        
        Set aside for the produce step.
        » for: Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday)
     5. Measure the Teriyaki-Glazed Baked Salmon sauce bowl   (2 min)
        Into the Teriyaki-Glazed Baked Salmon sauce bowl:
        1 tbsp light brown sugar
        1 tsp cornstarch
        
        Set aside for the produce step.
        » for: Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)
  ×  6. Smoked paprika — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
  ×  7. Long-grain white rice — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
  ×  8. Long-grain white rice — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Blackened Catfish with Dirty Rice and Braised Greens (Thursday)
  ×  9. Sesame seeds — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday)
  × 10. Sesame seeds — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)
  × 11. Sesame seeds — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)
  × 12. Catfish fillets — cook day   (2 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Blackened Catfish with Dirty Rice and Braised Greens (Thursday)

  ── produce ──
     1. Wash and dry all the produce   (3 min)
        Wash and dry everything you are about to cut. One pass now keeps the board dry and the knife work clean.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday), Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday), Blackened Catfish with Dirty Rice and Braised Greens (Thursday), Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)
     2. Juice all limes   (9 min)
        Juice your limes and zest one before squeezing it. Portion as follows:
        
        Lime juice — into a tub labelled "Lime juice, fresh — Chili-Lime Sautéed Shrimp, Cilantro-Lime Rice, Sautéed Peppers and Onions +2 more":
        2 tbsp for the Chili-Lime Sautéed Shrimp
        2 tbsp for the Cilantro-Lime Rice
        1 tbsp for the Sautéed Peppers and Onions
        1½ tbsp for the Charred Corn Salsa
        2 tbsp for the Avocado Crema
        
        Lime zest — ½ tsp into a tub labelled "Cilantro-Lime Rice — lime zest"
        » storage: Both containers: Covered in the fridge — up to 3 days.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
     3. Chop all fresh cilantro   (4 min)
        Finely chop the cilantro, keeping portions separate by destination:
        ⅜ cup — into a tub labelled "Cilantro-Lime Rice — finely chopped fresh cilantro"
        3 tbsp, chopped — into a tub labelled "Charred Corn Salsa — fresh cilantro, cherry tomatoes, jalapeño and red onion"
        2 tbsp — into a tub labelled "Avocado Crema — fresh cilantro"
        ¼ cup, roughly chopped — into a tub labelled "Sesame-Ginger Slaw — fresh cilantro, fresh ginger and carrots"
        » storage: Both containers: Airtight in the fridge, with a barely damp paper towel — up to 3 days.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday), Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday)
     4. Slice all red bell peppers   (5 min)
        Seed and thinly slice 2 red bell peppers — into a tub labelled "Sautéed Peppers and Onions — thinly sliced red bell pepper".
        » storage: Airtight in the fridge — up to 4 days.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
     5. Slice the yellow bell pepper   (3 min)
        Seed and thinly slice 1 yellow bell pepper — into a tub labelled "Sautéed Peppers and Onions — thinly sliced yellow bell pepper".
        » storage: Airtight in the fridge — up to 4 days.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
     6. Prep all green bell pepper   (5 min)
        Seed and thinly slice 1 green bell pepper — into a tub labelled "Sautéed Peppers and Onions — thinly sliced green bell pepper".
        Finely dice 1 green bell pepper — into a tub labelled "Dirty Rice vegetables".
        » storage: Airtight in the fridge — up to 4 days.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday), Blackened Catfish with Dirty Rice and Braised Greens (Thursday)
     7. Prep all yellow onion   (8 min)
        Halve and thinly slice 1 yellow onion — into a tub labelled "Thinly sliced yellow onion — Sautéed Peppers and Onions, Braised Collard Greens".
        Finely dice 1 yellow onion — into a tub labelled "Dirty Rice vegetables".
        Thinly slice ½ yellow onion — into the same tub labelled "Thinly sliced yellow onion — Sautéed Peppers and Onions, Braised Collard Greens".
        » storage: Airtight in the fridge — up to 4 days.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday), Blackened Catfish with Dirty Rice and Braised Greens (Thursday)
     8. Quarter the cherry tomatoes   (1 min)
        Quarter ¾ cup cherry tomatoes — into a tub labelled "Charred Corn Salsa — fresh cilantro, cherry tomatoes, jalapeño and red onion".
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
     9. Dice the jalapeño   (3 min)
        Seed and finely dice 1 jalapeño — into a tub labelled "Charred Corn Salsa — fresh cilantro, cherry tomatoes, jalapeño and red onion".
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
    10. Dice the red onion   (3 min)
        Finely dice ¼ cup red onion — into a tub labelled "Charred Corn Salsa — fresh cilantro, cherry tomatoes, jalapeño and red onion".
        » storage: Charred Corn Salsa: Airtight in the fridge, with a barely damp paper towel — up to 3 days. Stir in the Chili-Lime Sautéed Shrimp, Cilantro-Lime Rice, Sautéed Peppers and Onions +2 more now — it is ea…
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
  × 11. Ripe avocado — cook day   (1 min)  [RENDER-OMITTED]
        This browns once it is cut, so it is cut on cook day.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
    12. Mince and slice all garlic   (4 min)
        Mince all garlic, then thinly slice the portion for the broccoli. Portion by destination:
        1 clove, minced — into a tub labelled "Avocado Crema — minced garlic cloves"
        2 cloves, minced — into the Sesame-Crusted Seared Ahi Tuna marinade bowl
        3 cloves, minced — into a tub labelled "Dirty Rice vegetables"
        2 cloves, minced — into the Teriyaki-Glazed Baked Salmon sauce bowl
        3 cloves, thinly sliced — into a tub labelled "Roasted Broccoli with Garlic and Sesame — garlic cloves and broccoli florets"
        » storage: Airtight in the fridge — up to 4 days.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday), Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday), Blackened Catfish with Dirty Rice and Braised Greens (Thursday), Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)
    13. Grate all fresh ginger   (1 min)
        Finely grate all the fresh ginger and portion by destination:
        1 tsp — into the Sesame-Crusted Seared Ahi Tuna marinade bowl
        1 tsp — into a tub labelled "Sesame-Ginger Slaw — fresh cilantro, fresh ginger and carrots"
        1 tsp — into the Teriyaki-Glazed Baked Salmon sauce bowl
        » for: Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday), Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)
    14. Shred the green cabbage   (1 min)
        Finely shred 4 cup green cabbage — into a tub labelled "Sesame-Ginger Slaw — greens".
        » for: Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday)
    15. Shred the red cabbage   (1 min)
        Finely shred 1 cup red cabbage — into a tub labelled "Sesame-Ginger Slaw — greens".
        » storage: Sesame-Ginger Slaw — greens: Airtight in the fridge — up to 4 days.
        » for: Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday)
    16. Julienne the carrots   (1 min)
        Peel and julienne or grate 2 carrots — into a tub labelled "Sesame-Ginger Slaw — fresh cilantro, fresh ginger and carrots".
        » storage: Sesame-Ginger Slaw — fresh cilantro, fresh ginger and carrots: Airtight in the fridge, with a barely damp paper towel — up to 3 days. Keep the Sesame-Ginger Slaw sauce bowl separate; combine on cook…
        » for: Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday)
    17. Dice the celery stalks   (1 min)
        Finely dice 2 celery stalks — into a tub labelled "Dirty Rice vegetables".
        » storage: Dirty Rice vegetables: Airtight in the fridge — up to 4 days.
        » for: Blackened Catfish with Dirty Rice and Braised Greens (Thursday)
    18. Cut the broccoli florets   (3 min)
        Cut 1½ lb broccoli into even florets — into a tub labelled "Roasted Broccoli with Garlic and Sesame — garlic cloves and broccoli florets".
        » storage: Roasted Broccoli with Garlic and Sesame: Airtight in the fridge — up to 4 days.
        » for: Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)

  ── sauces_marinades ──
     1. Finish the Sesame-Crusted Seared Ahi Tuna marinade bowl   (2 min)
        Sesame-Crusted Seared Ahi Tuna marinade bowl (sesame seeds, garlic cloves and fresh ginger already in it): add
        2 tbsp soy sauce
        1 tbsp toasted sesame oil
        Whisk to combine.
        » storage: Covered in the fridge — up to 4 days.
        » for: Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday)
     2. Finish the Teriyaki-Glazed Baked Salmon sauce bowl   (4 min)
        Teriyaki-Glazed Baked Salmon sauce bowl (light brown sugar, cornstarch, garlic cloves and fresh ginger already in it): add
        ¼ cup soy sauce
        2 tbsp honey
        3 tbsp mirin
        2 tbsp sake
        1 tsp sesame oil
        Stir to combine.
        » storage: Covered in the fridge — up to 4 days.
        » for: Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)
     3. Build the Sesame-Ginger Slaw sauce bowl   (3 min)
        Into the Sesame-Ginger Slaw sauce bowl:
        1 tbsp soy sauce
        1 tbsp toasted sesame oil
        3 tbsp rice vinegar
        1 tbsp honey
        Whisk to combine.
        » storage: Covered in the fridge — up to 4 days.
        » for: Seared Tuna Steak with Sesame-Ginger Slaw and Steamed Jasmine Rice (Wednesday)
  ×  4. Soy sauce — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)
  ×  5. Apple cider vinegar — cook day   (1 min)  [RENDER-OMITTED]
        One thing measured on its own goes straight into the pan on cook day — nothing to do ahead.
        » for: Blackened Catfish with Dirty Rice and Braised Greens (Thursday)

  ── proteins ──
     » Fish, poultry and meat keep about two days once handled, so this phase only preps what you'll cook soon.
     1. Pat dry the shrimp   (5 min)
        Remove the tails from 1½ lb large shrimp, then pat them thoroughly dry with paper towels.
        » storage: Covered in the fridge — cook within 2 days.
        » for: Shrimp Fajita Bowl with Cilantro-Lime Rice, Sautéed Peppers and Onions, Corn Salsa, and Avocado Crema (Monday)
  ×  2. Chicken livers — cook day   (1 min)  [RENDER-OMITTED]
        Nothing to do to it before the pan — it goes in straight from the package on cook day.
        » for: Blackened Catfish with Dirty Rice and Braised Greens (Thursday)
  ×  3. Andouille sausage — cook day   (1 min)  [RENDER-OMITTED]
        Nothing to do to it before the pan — it goes in straight from the package on cook day.
        » for: Blackened Catfish with Dirty Rice and Braised Greens (Thursday)
  ×  4. Smoked ham hock — cook day   (1 min)  [RENDER-OMITTED]
        Nothing to do to it before the pan — it goes in straight from the package on cook day.
        » for: Blackened Catfish with Dirty Rice and Braised Greens (Thursday)
  ×  5. Salmon fillets — cook day   (5 min)  [RENDER-OMITTED]
        Portion 24 oz salmon into four 6-oz fillets, then pat each one thoroughly dry with paper towels.
        » storage: This one is 6 days out — leave it for cook day.
        » for: Baked Salmon Teriyaki with Steamed Rice and Roasted Broccoli (Saturday)

```
