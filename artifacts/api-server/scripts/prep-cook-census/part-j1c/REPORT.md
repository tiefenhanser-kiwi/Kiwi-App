# Prep & Cook Part J.1c — Hans's device pass (BUG-355) and long container names (BUG-354)

Run 2026-10-05 on `next`, server only. Prompt `prep.narrate_steps` **v21**, unchanged (no prompt body changed, no reseed). Prep engine version **4 → 6**. Spend **$0.331** of $1.00, all of it regeneration (cap $0.40):
- **v5:** A10 $0.0600, e55a9305 $0.0605, f49f5209 $0.0463.
- **v6:** A10 $0.0550, e55a9305 $0.0606, f49f5209 $0.0484.

All six were on claude-sonnet-5-5, 0 retries. No migrations; `artifacts/kiwi/**` untouched.

Reproduce (from `artifacts/api-server`; all free unless marked):
```
node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/hans-newest.ts                       # read-only
node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/device.ts <planId> 2026-10-04 --holds --raw  # replay a day, read-only
git archive HEAD src | tar -x -C scripts/prep-cook-census/part-j1c/out/_head                             # the v4 engine, read-only
node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/census.ts --engine head --date 2026-10-04
node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/census.ts --engine work --date 2026-10-04
node scripts/prep-cook-census/part-j1c/table.cjs                                                        # → census.md
node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/proteins.ts                         # → out/proteins.txt
node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/lids.ts                             # contents-named lids left
node scripts/prep-cook-census/part-j1c/breaks.cjs                                                       # → out/breaks.txt
node --env-file=.env --import tsx scripts/prep-cook-census/part-j0/regen.ts --out scripts/prep-cook-census/part-j1c/out --plan <id> --allow-hans   # paid
```

## Which plan was the device pass

Hans's newest plan by `createdAt` is **f49f5209**: Stroganoff, Taco Bell–style tacos, pork chops and BBQ meatballs, created Oct 4 at 23:29. The lines he quoted come from **e55a9305**, though:
- Tex-Mex beef "same tub";
- Slow-Cooker Chicken celery and carrots;
- pound + trim + cube = 22 min;
- the Lemon-Herb cook-day line.

`device.ts` replays e55a9305 as of Oct 4 at exactly the header he saw: **25 containers · about 110 min**. Both plans were regenerated and both are reported.

## The items

1. **"same tub" has no referent.** Every portion into one container is now one line that opens on the container: "Into one shared finely diced yellow onion tub: 1 for the Texas-Style Beef Chili · 1 for the Tex-Mex Seasoned Ground Beef". Across the 27 plans, "same tub" steps went **43 → 0**. A lid that names its dish ("Taco Toppings plate") no longer repeats "for the Taco Toppings".
2. **One destination is one sentence.** Example: "Slice 3 celery stalks into ½-inch pieces for the Slow-Cooker Chicken vegetables container." One-portion steps printed twice went **170 → 1**. That one (f49f5209's lemon) is the item 5 guard declining to fold.
   - The fold runs only in `finishPrepWeek`, on every read. The cached blob keeps the narrator's opening over the code's lines; folding in assembly as well printed the lid twice, and a test now catches that.
3. **Contents names are for shared tubs only.** One dish's lone item takes its dish's class container:
   - a citrus juice or zest (by name or by note: "lemon, juiced") → the dish's sauce jar, else "`<dish>` citrus jar" ("juice jar" for other juices);
   - a garnish → the toppings plate. "Garnish" means the dish is garnished **with** it ("Sprinkle with the parsley", "Scatter the cilantro over"). It does not mean the dish is sprinkled ("Sprinkle the asparagus with salt"). v5 got that wrong and put e55a9305's asparagus on a plate; v6 fixed it before the final regeneration.
   - the dish's one other lone cut, with no vegetables container → "`<dish> vegetables`" (or "`<dish> aromatics`" for garlic, ginger, shallot or a herb);
   - several lone cuts, or one beside a vegetables container it must not join → **one "`<dish>` prep plate", a separate pile each**. A lone cut is lone either because it goes in at another moment (H7.1: the later garlic never joins the onion) or because the recipe never says when. A pile keeps it apart either way. The mango salsa and the chicken salad had printed three lids each.

   Single-dish contents lids went **173 → 10**:
   - 8 are H6.1's two vegetable containers of one dish ("the lid says which", Hans's own ruling), left as they are;
   - 1 is a citrus wedge (rule 7, cook day);
   - 1 is H7.1's "`<dish>` — herbs/aromatics" pair.

   A step closing lids that keep differently now names each lid, the step's own included. Lids that keep alike share one sentence, so every lid stays named under the 200 cap.
4. **Proteins are timed by the verb the step says** (the title's rule 12 verbs, the slowest wins), not by the catalog note. The table is below. Hans's anchor (pound 2½ lb breasts + trim 1¾ lb thighs + cube 2 lb chuck) came to **13 min shown, 12.25 raw**, against his "12 ish", from 22.
   - Found in the data: the verb detector read "3-pound pork shoulder" and "4-pound whole chicken" as **"Pound"**. Three corpus titles said "Pound the pork shoulder" or "Pound the whole chicken". A hyphenated weight is now a weight.
5. **The carrots.** The opening sentence, the code's portion line and the catalog step all say **3 carrots**:
   - catalog: "peel and slice 3 carrots into ½-inch coins" (3 each);
   - payload: "Peel 3 carrots and slice them into ½-inch coins." / "3 carrots for Slow-Cooker Chicken and Dumplings — into the Slow-Cooker Chicken vegetables container".

   "2 carrots" appears in no render of e55a9305 (J.1, J.1b, the Oct 4 replay) and on no carrot row of f49f5209. Not reproduced.

   The rule is enforced anyway, because item 2 makes the opening's number the only one on screen. A one-portion step folds only when its opening states exactly the code's number, no other quantity and not none; otherwise the code's line stays. A narrator writing "Peel 2 carrots" over 3 keeps "3 carrots" under it (tested).
6. **The cook-day list on e55a9305 is correct.** As of Oct 4:
   - **Lemon-Herb:** the potatoes don't hold once cut; the chicken joins its marinade 20 min before cooking.
   - **Slow-Cooker, Enchiladas, Chili:** lag 0, nothing held.
   - **Tacos:** lag 2. The tomatoes' 2-day window reaches Tuesday, so they're cut Sunday.

   Finding, not fixed: Friday and Saturday had already passed on Oct 4, so their lag clamps to 0 and the line reads "(Saturday, **today**)". H5 left that clamp on purpose, but the word is wrong for a day that has gone.

**BUG-354:** every container name is fitted in whole words, never cut mid-word. The dish part shortens: the full name, then `shortDishName`, then whole words. The use part ("toppings plate") is never cut.
- The budget is **104** characters, not 120. The narrator's own title "Measure the `<name>`" is also held to 120 by its schema, and `uniqueName` may append " 2".
- Engine titles now cut at whole words too.
- D-WS9-121's `displayTitle` is null on **4,917 of 4,917** dishes, so there is no stored short title to prefer. The longest catalog dish title today is 82 characters.
- Tested with a 119-character dish: the response validates.

## Protein time table, per lb (`MINUTES` in prepStepMinutes.ts)

| action | before | after | why |
|---|---|---|---|
| cube (stew pieces, trimming as you go) | 4 | 2.5 | 2 lb chuck ≈ 5 min, Hans's anchor |
| cut into strips | 4 (note "strips"), else 3 | 2.5 | same knife work as cubing |
| trim (fat off thighs or a roast) | 4 (note "trim"), else 3 | 2 | ~35 s a thigh, six to 1¾ lb |
| butterfly / spatchcock | 4 or 3 by note | 2 | a cut and a press per piece |
| pound (to an even thickness) | 4 or 3 by note | 1.5 | ~45 s a breast under plastic |
| skin | 4 or 3 by note | 1.5 | pulling the skin off |
| portion (divide a pack into shares) | 3 | 1.5 | no knife precision |

**Before:** the rate came from the **note**, so a pounding the title announced was charged at 3/lb because the note never said "pound".

**After:** the rate comes from the step's verbs, and the note is only the fallback.

Across 61 protein steps on 27 plans, protein minutes went **275 → 180** (`out/proteins.txt`, before → after per step).

**Is the anchor consistent with the other evidence?** No timed data exists in the repo besides this anchor and H6.1's onion figure, so the rates are judgment, set to meet the anchor. The cube rate (2.5/lb) is the one judgment call: at 2.0 the anchor would hit 12 exactly, but cubing 2 lb of chuck in 4 minutes is faster than a home cook. Two steps (A02, A14: 7¼ lb and 5¾ lb of thighs cut into pieces across several meals) still sit on the 15-minute cap. That is real volume, not misclassification.

Nothing else in the time table was changed. Hans's H6.1 "an onion in 2" against the 2.5 per-vegetable rate is a candidate he hasn't anchored.

## Headers

| plan | before (engine v4) | after (engine v6) |
|---|---|---|
| Hans e55a9305, Oct 4 replay | 25 containers · about 110 min (what Hans saw) | 25 · 100 |
| Hans f49f5209, Oct 4 replay | 15 · 55 | 13 · 50 |
| A10, census Oct 4 | 15 · 50 | 14 · 50 |
| served today, Oct 5 (regenerated) | — | A10 15 · 50 · e55a9305 25 · 100 · f49f5209 14 · 55 |

The served headers differ from the Oct 4 replays only because the day moved and the lags with it. Every census header, before → after on the same pinned day, is in `census.md`. Totals over 27 plans:
- containers **520 → 481**;
- header minutes **2,185 → 2,065**.

A20 went 70 → 75 minutes: its merged lids put it under rule 7's 15-container target, so its parsley garnish is no longer dropped. That is rule 7 as written.

## Tests: each fix broken once

`out/breaks.txt` has 14 breaks: 14 red, and 14 restores hash-identical to the original file.

| break | red line |
|---|---|
| shared tub named once | `+ '1 yellow onion for Texas-Style Beef Chili — into the shared finely diced yellow onion tub'` |
| one destination, one sentence | `+ 'Slice 3 celery stalks into ½-inch pieces.\n' +` |
| fold only on read | `+ '… for the Slow-Cooker Chicken vegetables container for the Slow-Cooker Chicken vegetables container.'` |
| fold keeps the code's number | `Peel 2 carrots and slice them into ½-inch coins for the Slow-Cooker Chicken vegetables container.` |
| single-dish lids by class | `+   'Roasted Asparagus with Lemon — lemon juice'` |
| never into an existing vegetables container | `the later garlic joined the onion` |
| several lone cuts → one prep plate | `+   'Chicken Salad — chopped romaine lettuce hearts'` |
| a citrus juiced by its note | `+   'Sautéed Broccolini with Garlic and Chili Flake vegetables'` |
| the thing garnished is not the garnish | `+   'Roasted Asparagus with Lemon toppings plate'` |
| two lids that keep differently are named | `Covered in the fridge — up to 6 days. Airtight in the fridge — up to 4 days.` |
| lids that keep alike share a sentence | `Creamy Beef and Mushroom Stroganoff toppings plate: Plate, wrapped, fridge, up to 3 days. Buttered Egg Noodles toppings plate: Plate, wrapped, fridge, up to 3 days.` |
| protein timed by its verb | `Expected values to be strictly equal` (trim charged at the portion rate) |
| hyphenated weight is not "pound" | `+ [` (`["pound"]` for "3-pound pork shoulder") |
| BUG-354 names fit the wire | `"String must contain at most 120 character(s)"` ×3 |

Two of my tests were vacuous on their first write, and both were fixed before the breaks ran:
- The moment test's fixture never formed a vegetables container. "Cook the onion…" is not a heat sentence to the adapter. It now states the moments.
- The multi-lid label test had an `if` that could skip.

Also fixed: `prepWeekAggregation.test.ts` had two **date bombs**. Their plan starts 2026-10-04 and they took "today" from the clock, so they went red on Oct 5 at HEAD as well. `now` is now pinned.

## Findings, not fixed

- **Taco lettuce and tomatoes in a "vegetables" container** (f49f5209 "Taco Bell–Style Seasoned Ground vegetables"): unchanged from v4. The moment grouping put them in a heated container.
- **`bowlNameFor`'s short name drops the noun:** "Taco Bell–Style Seasoned Ground spice blend". Unchanged from v4.
- **"(Saturday, today)" for a day already gone** (item 6).
- **The cached `containerNames` are not recomputed on read.** A name change needs an engine bump, which is why there was a v6.
- **Tofu "cube" is charged as a measure** (A09, 1 min for 28 oz).
