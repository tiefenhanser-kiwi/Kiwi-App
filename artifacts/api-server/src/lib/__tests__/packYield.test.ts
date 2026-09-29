// [grocery] B1 Part D — THE PACK YIELD: one food, one buy line, in whole packs.
//
// R2 (D-WS9-280, Hans, September 28): convert every need to purchase units
// through a yield, sum, round UP to whole packs — never under-buy — with one
// narrow forgiveness for something that wilts.
//
// The five cases §2 rule 3 names are fixtures here rather than corpus rows
// because three of them do not occur in the corpus: no live list carries a
// cabbage HEAD beside a cabbage CUP need.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConsolidatedItem } from "../groceryList";
import { mergeConvertibleGroups } from "../groceryMerge";
import { roundNeedQuantity } from "../needQuantity";
import {
  buildRelationIndex,
  poolComponentNeeds,
  EMPTY_RELATION_INDEX,
  type RelationRow,
} from "../ingredientRelations";
import {
  PACK_FORGIVENESS_FRACTION,
  canonicalUnitToken,
  forgivesPartPack,
  packsForNeed,
  rowConversion,
  scalePurchaseForSubUnit,
  toSubUnitChild,
  withPackYield,
} from "../ingredientConversions";

// ── fixtures ────────────────────────────────────────────────────────────────

function row(over: Partial<ConsolidatedItem> & Pick<ConsolidatedItem, "canonicalName" | "quantity" | "unit">): ConsolidatedItem {
  return {
    ingredientId: `ing-${over.canonicalName}`,
    displayName: over.canonicalName,
    sectionKey: "produce",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    sources: [],
    purchaseUnit: null,
    purchaseQuantity: null,
    purchaseDisplay: null,
    conversionRef: null,
    packYieldUnit: null,
    packYieldPerPack: null,
    packFloor: null,
    preparationNote: null,
    sourceDishTitle: null,
    ...over,
  } as ConsolidatedItem;
}

/** A bunch-sold herb with Hans's 2-cup-per-bunch yield. */
const cilantro = (quantity: number, unit: string) =>
  row({
    canonicalName: "fresh cilantro", displayName: "fresh cilantro",
    quantity, unit,
    purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch",
    packYieldUnit: "cup", packYieldPerPack: 2,
    // cilantro's own density, so an oz need can still reach cups
    conversionRef: { source: "curated", gramsPerCup: 16 },
  });

/** A head-sold vegetable. Keeps for weeks, so it NEVER gets the forgiveness. */
const cabbage = (quantity: number, unit: string) =>
  row({
    canonicalName: "green cabbage", displayName: "green cabbage",
    quantity, unit,
    purchaseUnit: "head", purchaseQuantity: 1, purchaseDisplay: "1 head",
    packYieldUnit: "cup", packYieldPerPack: 8,
  });

const iceberg = (quantity: number, unit: string) =>
  row({
    canonicalName: "iceberg lettuce", displayName: "iceberg lettuce",
    quantity, unit,
    purchaseUnit: "head", purchaseQuantity: 1, purchaseDisplay: "1 head",
    packYieldUnit: "cup", packYieldPerPack: 4,
  });

const garlic = (quantity: number, unit: string, name = "garlic") =>
  row({
    canonicalName: name, displayName: name === "garlic" ? "Garlic" : name,
    quantity, unit,
    purchaseUnit: "head", purchaseQuantity: 1, purchaseDisplay: "1 head",
    packYieldUnit: "clove", packYieldPerPack: 10,
  });

/** What the shopper is told to buy, for a row that stands alone. */
function packLine(item: ConsolidatedItem): string | null {
  const conv = rowConversion(item);
  const scaled = scalePurchaseForSubUnit(conv, item.quantity, item.unit, {
    packFloor: item.packFloor,
    storedDisplay: item.purchaseDisplay,
  });
  return scaled?.purchaseDisplay ?? null;
}

/** Merge a group the way consolidatePlanIngredients does, then read the pack. */
function buyLine(group: ConsolidatedItem[], index = EMPTY_RELATION_INDEX): string | null {
  const merged = mergeConvertibleGroups(group, index);
  assert.equal(merged.length, 1, `expected ONE row, got ${merged.length}: ${merged.map((m) => `${m.quantity} ${m.unit}`).join(" + ")}`);
  merged[0].quantity = roundNeedQuantity(merged[0].quantity, merged[0].unit);
  return packLine(merged[0]);
}

// ── §2 rule 3 — the five named cases ────────────────────────────────────────

describe("[grocery] B1 — R2's five named cases", () => {
  it("1 bunch + 2 tbsp cilantro -> 1 bunch (the forgiveness, at 1/16 of a pack)", () => {
    // 1 bunch = 2 cup, + 2 tbsp = 0.125 cup -> 2.125 cup = 1.0625 packs.
    assert.equal(buyLine([cilantro(1, "bunch"), cilantro(2, "tablespoon")]), "1 bunch");
  });

  it("1 head cabbage + 2 cups -> 2 heads (2 cups is a quarter head — a real portion)", () => {
    // 8 + 2 = 10 cup = 1.25 packs, over by 0.25 > 1/8 — AND cabbage is
    // head-sold, so the forgiveness could not apply even at 1/16.
    assert.equal(buyLine([cabbage(1, "head"), cabbage(2, "cup")]), "2 heads");
  });

  it("2 cups shredded iceberg -> 1 head, not 4", () => {
    // The symptom was a PACK that said four heads were one pack, fixed in the
    // catalog; the yield is what turns 2 cup into half a head.
    assert.equal(packLine(iceberg(2, "cup")), "1 head");
  });

  it("1/4 cup + 1/4 bunch cilantro -> 1 bunch, ONE row (the two-rows-of-one-food bug)", () => {
    // 0.25 cup + (0.25 bunch = 0.5 cup) = 0.75 cup = 0.375 packs.
    const merged = mergeConvertibleGroups([cilantro(0.25, "cup"), cilantro(0.25, "bunch")], EMPTY_RELATION_INDEX);
    assert.equal(merged.length, 1, "two rows for one food is the bug");
    assert.equal(merged[0].quantity, 0.75);
    assert.equal(merged[0].unit, "cup");
    assert.equal(packLine(merged[0]), "1 bunch");
  });

  it("1 bunch + 1/2 cup cilantro -> 2 bunches (past the forgiveness)", () => {
    // 2 + 0.5 = 2.5 cup = 1.25 packs, over by 0.25 > 1/8.
    assert.equal(buyLine([cilantro(1, "bunch"), cilantro(0.5, "cup")]), "2 bunches");
  });

  it("garlic: 1 head + 3 cloves -> 2 heads (D-WS9-220, verbatim)", () => {
    // Hans: "if they need a head of garlic and 3 cloves, they should buy 2 heads."
    assert.equal(buyLine([garlic(1, "head"), garlic(3, "clove")]), "2 heads");
  });
});

// ── the rounding rule itself ────────────────────────────────────────────────

describe("[grocery] B1 — ceil to whole packs, and the one forgiveness", () => {
  it("never under-buys: any fraction over a whole pack costs a pack", () => {
    assert.equal(packsForNeed(1.2, false), 2);
    assert.equal(packsForNeed(2.0001, false), 3);
    assert.equal(packsForNeed(0.01, false), 1, "half a pack is still one pack");
  });

  it("a need landing exactly on a pack boundary does NOT round up (epsilon)", () => {
    assert.equal(packsForNeed(1, false), 1);
    assert.equal(packsForNeed(2, false), 2);
    assert.equal(packsForNeed(3 / 3, false), 1);
  });

  it("forgives an overage of exactly 1/8 and no more", () => {
    assert.equal(packsForNeed(1 + PACK_FORGIVENESS_FRACTION, true), 1);
    assert.equal(packsForNeed(1 + PACK_FORGIVENESS_FRACTION + 0.001, true), 2);
  });

  // 🔴 RULED September 28. The discriminator is the PACK UNIT, not the category.
  // "The forgiveness exists so nobody throws out ¾ of a bunch that wilts in
  //  days. Garlic, onions, cabbage and citrus keep for weeks, so they round
  //  straight up."
  it("only a BUNCH forgives", () => {
    assert.equal(forgivesPartPack("bunch"), true);
    assert.equal(forgivesPartPack("bunches"), true, "the plural folds");
    for (const u of ["head", "each", "jar", "can", "bulb", "loaf", "wedge", null, undefined]) {
      assert.equal(forgivesPartPack(u), false, `${u} must not forgive`);
    }
  });

  it("a HEAD-SOLD PRODUCE item never gets the forgiveness, however small the overage", () => {
    // The case that produced the ruling: garlic is Produce, keeps for weeks, and
    // 21 cloves against a 10-clove head is 2.1 packs. Under the category rule
    // this bought 2 heads for a 21-clove need — one clove short.
    assert.equal(packLine(garlic(21, "clove")), "3 heads");
    // …and at the same 1/16 overage a BUNCH does forgive, so the two differ on
    // the pack and on nothing else.
    assert.equal(packLine(cilantro(2.125, "cup")), "1 bunch");
    assert.equal(packLine(cabbage(8.125, "cup")), "2 heads");
  });

  it("a NON-PERISHABLE container never gets the forgiveness", () => {
    const jar = row({
      canonicalName: "pickled jalapeños", quantity: 1.5 * 1.0625, unit: "cup",
      sectionKey: "canned",
      purchaseUnit: "jar", purchaseQuantity: 1, purchaseDisplay: "1 jar (12 oz)",
      packYieldUnit: "cup", packYieldPerPack: 1.5,
    });
    assert.equal(packLine(jar), "2 jar (12 oz)");
  });
});

// ── the ladder's generalisation ─────────────────────────────────────────────

describe("[grocery] B1 — the ladder knows its child unit", () => {
  it("a yield in the pack columns BEATS conversionRef.subUnit (D-WS9-220, ruled)", () => {
    const conv = withPackYield(
      { source: "curated", subUnit: { parent: "head", perParent: 6 }, purchaseUnit: "head" },
      { packYieldUnit: "clove", packYieldPerPack: 10, purchaseUnit: "head" },
    );
    assert.deepEqual(conv?.subUnit, { parent: "head", perParent: 10, childUnit: "clove" });
  });

  it("garlic's two routes agree, so BUG-025-1's render is reached either way", () => {
    const viaColumns = packLine(garlic(30, "clove"));
    const viaRef = packLine(
      row({
        canonicalName: "garlic", quantity: 30, unit: "clove",
        purchaseUnit: "head", purchaseQuantity: 1, purchaseDisplay: "1 head",
        conversionRef: {
          source: "curated", purchaseUnit: "head", purchaseDisplay: "1 head",
          subUnit: { parent: "head", perParent: 10 },
        },
      }),
    );
    assert.equal(viaColumns, "3 heads");
    assert.equal(viaRef, "3 heads", "the pre-B1 shape must still render identically");
  });

  it("a row with NO yield resolves exactly as it did before B1", () => {
    const plain = row({
      canonicalName: "ground beef", quantity: 3, unit: "pound",
      sectionKey: "meat_seafood",
      purchaseUnit: "lb", purchaseQuantity: 1, purchaseDisplay: "1 lb",
    });
    assert.equal(packLine(plain), null, "no ladder, no scaling — the stored pack stands");
  });

  it("declines LOUDLY rather than guessing when nothing relates the units", () => {
    // A bunch yield in cups against a need in EACH, with no gramsPerEach.
    const conv = rowConversion(
      row({
        canonicalName: "fresh basil leaves", quantity: 6, unit: "each",
        purchaseUnit: "bunch", packYieldUnit: "cup", packYieldPerPack: 2,
      }),
    );
    assert.equal(toSubUnitChild(6, "each", conv), null);
    assert.equal(scalePurchaseForSubUnit(conv, 6, "each"), null);
  });

  it("crosses dimensions through the row's OWN density (the broccoli gap)", () => {
    // 1 oz of cilantro at 16 g/cup = 28.35 g = 1.77 cup -> still under a bunch.
    assert.equal(packLine(cilantro(1, "ounce")), "1 bunch");
    // 2 oz = 3.54 cup = 1.77 packs -> 2.
    assert.equal(packLine(cilantro(2, "ounce")), "2 bunches");
  });

  it("the merge REFUSES a group it cannot convert rather than summing on faith", () => {
    const merged = mergeConvertibleGroups(
      [
        row({ canonicalName: "fresh basil", quantity: 1, unit: "bunch", purchaseUnit: "bunch", packYieldUnit: "cup", packYieldPerPack: 2 }),
        row({ canonicalName: "fresh basil", quantity: 6, unit: "each", purchaseUnit: "bunch", packYieldUnit: "cup", packYieldPerPack: 2 }),
      ],
      EMPTY_RELATION_INDEX,
    );
    assert.equal(merged.length, 2, "an unconvertible group passes through unmerged");
  });
});

// ── the pack display ────────────────────────────────────────────────────────

describe("[grocery] B1 — the pack display", () => {
  it("synthesises when the stored residue leads with the bare pack noun", () => {
    assert.equal(packLine(garlic(30, "clove")), "3 heads"); // "1 head"
    assert.equal(packLine(garlic(30, "clove", "garlic cloves")), "3 heads");
  });

  it("keeps the words, and the SIZE, when the pack says more than its noun", () => {
    const kale = row({
      canonicalName: "fresh lacinato kale", quantity: 25, unit: "ounce",
      purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch (~10 oz)",
      packYieldUnit: "ounce", packYieldPerPack: 10,
    });
    // 25 oz = 2.5 packs -> 3 (a bunch forgives only 1/8).
    assert.equal(packLine(kale), "3 bunch (~10 oz)");
  });

  it("rewrites only the leading count when the residue is authored prose", () => {
    const ginger = row({
      canonicalName: "fresh ginger", quantity: 20, unit: "tablespoon",
      purchaseUnit: "each", purchaseQuantity: 1, purchaseDisplay: "1 small knob (~2 oz)",
      packYieldUnit: "tbsp", packYieldPerPack: 9,
    });
    assert.equal(packLine(ginger), "3 small knob (~2 oz)");
  });
});

// ── the parts ───────────────────────────────────────────────────────────────

const rel = (over: Partial<RelationRow> & Pick<RelationRow, "fromCanonicalName" | "toCanonicalName">): RelationRow => ({
  label: "component",
  yieldQuantity: 1,
  yieldUnit: "each",
  coHarvestable: true,
  confidence: "high",
  reviewedByHuman: true,
  fromDefaultUnit: "each",
  ...over,
});

describe("[grocery] B1 — a part never buys its own line", () => {
  const limeIndex = buildRelationIndex([
    rel({ fromCanonicalName: "lime", toCanonicalName: "lime juice", yieldQuantity: 2, yieldUnit: "tbsp", coHarvestable: true }),
    rel({ fromCanonicalName: "lime", toCanonicalName: "lime zest", yieldQuantity: 2, yieldUnit: "tsp", coHarvestable: true }),
    rel({ fromCanonicalName: "lime", toCanonicalName: "lime wedges", yieldQuantity: 8, yieldUnit: "each", coHarvestable: false }),
  ]);
  const lime = (n: number, u: string, name = "lime") =>
    row({ canonicalName: name, displayName: name, quantity: n, unit: u, purchaseUnit: "each", purchaseQuantity: 1, purchaseDisplay: "1 lime" });

  it("lime zest + lime juice share ONE lime (D-WS9-182: coHarvestable takes max)", () => {
    const res = poolComponentNeeds([lime(2, "tbsp", "lime juice"), lime(2, "tsp", "lime zest")], limeIndex);
    const limes = res.items.filter((i) => i.canonicalName === "lime");
    assert.equal(limes.length, 1);
    assert.equal(limes[0].quantity, 1, "max(1 for juice, 1 for zest) = 1");
    assert.equal(res.items.some((i) => i.canonicalName.includes("zest")), false, "the zest never gets its own line");
  });

  it("8 wedges plus a full lime's juice needs TWO — a wedge IS the fruit, so it ADDS", () => {
    const res = poolComponentNeeds([lime(8, "each", "lime wedges"), lime(2, "tbsp", "lime juice")], limeIndex);
    const limes = res.items.filter((i) => i.canonicalName === "lime");
    assert.equal(limes.length, 1);
    assert.equal(limes[0].quantity, 2, "max(juice) + sum(wedges)");
  });

  it("a part with NO parent edge stays its own row — it does not vanish", () => {
    const orphan = row({ canonicalName: "fennel fronds", quantity: 2, unit: "tablespoon", purchaseUnit: "bunch" });
    const res = poolComponentNeeds([orphan], limeIndex);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].canonicalName, "fennel fronds");
    assert.deepEqual(res.folds, []);
  });

  it("a coHarvestable part on an OFF-BASIS parent rides free: pack floor, need untouched", () => {
    // The f5556c19 case. `fresh cilantro` is on the list in CUPS against a basis
    // of BUNCHES; before B1 this declined and shipped three bunches.
    const idx = buildRelationIndex([
      rel({ fromCanonicalName: "fresh cilantro", toCanonicalName: "fresh cilantro stems", yieldQuantity: 0.75, yieldUnit: "cup", fromDefaultUnit: "bunch" }),
      rel({ fromCanonicalName: "fresh cilantro", toCanonicalName: "fresh cilantro leaves", yieldQuantity: 2, yieldUnit: "cup", fromDefaultUnit: "bunch" }),
    ]);
    const parent = cilantro(4 / 3, "cup");
    const res = poolComponentNeeds(
      [
        parent,
        row({ canonicalName: "fresh cilantro stems", quantity: 0.25, unit: "cup", purchaseUnit: "bunch" }),
        row({ canonicalName: "fresh cilantro leaves", quantity: 0.5, unit: "cup", purchaseUnit: "bunch" }),
      ],
      idx,
    );
    assert.equal(res.items.length, 1, "three rows become one");
    assert.equal(res.items[0].quantity, 4 / 3, "the NEED is untouched — the parts ride free");
    assert.equal(res.items[0].packFloor, 1);
    assert.equal(packLine(res.items[0]), "1 bunch", "one bunch, not three");
  });

  it("an EXCLUSIVE slot against an off-basis parent DECLINES, and says so", () => {
    const idx = buildRelationIndex([
      rel({ fromCanonicalName: "fresh thyme", toCanonicalName: "fresh thyme sprigs", yieldQuantity: 30, yieldUnit: "each", coHarvestable: false, fromDefaultUnit: "bunch" }),
    ]);
    const res = poolComponentNeeds(
      [
        row({ canonicalName: "fresh thyme", quantity: 3, unit: "sprig", purchaseUnit: "bunch", packYieldUnit: "tbsp", packYieldPerPack: 3 }),
        row({ canonicalName: "fresh thyme sprigs", quantity: 4, unit: "each", purchaseUnit: "bunch" }),
      ],
      idx,
    );
    assert.equal(res.items.length, 2, "the children stay as their own rows");
    assert.equal(res.declines.length, 1);
    assert.match(res.declines[0].reason, /EXCLUSIVE/);
  });
});

// ── the basis fallback, and its gate ────────────────────────────────────────

describe("[grocery] B1 — the component basis reads the PACK, for a reviewed edge only", () => {
  const mint = (reviewed: boolean) =>
    buildRelationIndex([
      rel({
        fromCanonicalName: "fresh mint", toCanonicalName: "fresh mint leaves",
        yieldQuantity: 2, yieldUnit: "cup",
        fromDefaultUnit: "sprig", fromPurchaseUnit: "bunch",
        reviewedByHuman: reviewed,
      }),
    ]);

  it("admits a reviewed edge whose defaultUnit names no whole but whose PACK does", () => {
    const idx = mint(true);
    assert.equal(idx.componentParents.length, 1);
    assert.equal(idx.componentParents[0].basisUnit, "bunch");
  });

  it("REFUSES the same edge unreviewed — the gate is reviewedByHuman", () => {
    const idx = mint(false);
    assert.equal(idx.componentParents.length, 0);
    assert.ok(idx.declined.some((d) => d.reason === "basis-unit-not-countable"));
  });

  // 🔴 The edge that ordered six cans of tuna for 11 tbsp of oil. Its arithmetic
  // is correct; olive oil is simply its own product. D-WS9-218 named it.
  it("refuses `canned tuna in olive oil -> olive oil` while it is unreviewed", () => {
    const idx = buildRelationIndex([
      rel({
        fromCanonicalName: "canned tuna in olive oil", toCanonicalName: "olive oil",
        yieldQuantity: 2, yieldUnit: "tbsp",
        fromDefaultUnit: "can", fromPurchaseUnit: "can",
        reviewedByHuman: false,
      }),
    ]);
    assert.equal(idx.componentParents.length, 0);
  });

  it("refuses a DOZEN as a basis even reviewed — twelve eggs is not one whole", () => {
    const idx = buildRelationIndex([
      rel({
        fromCanonicalName: "large eggs", toCanonicalName: "egg whites",
        yieldQuantity: 1, yieldUnit: "each",
        fromDefaultUnit: "dozen", fromPurchaseUnit: "dozen",
        reviewedByHuman: true,
      }),
    ]);
    assert.equal(idx.componentParents.length, 0, "D-WS9-218's 12x error stays refused");
  });
});

// ── the never-fold veto, unchanged ──────────────────────────────────────────

describe("[grocery] B1 — D-WS9-217 is still permanent", () => {
  it("refuses the direct edge AT THE PER-EDGE GATE, even reviewed and high", () => {
    const idx = buildRelationIndex([
      { label: "synonym", fromCanonicalName: "coarse kosher salt", toCanonicalName: "kosher salt", yieldQuantity: null, yieldUnit: null, coHarvestable: null, confidence: "high", reviewedByHuman: true, fromDefaultUnit: "teaspoon" },
    ]);
    assert.equal(idx.synonymFold("coarse kosher salt"), "coarse kosher salt");
    assert.equal(idx.synonymFold("kosher salt"), "kosher salt");
    assert.ok(idx.declined.some((d) => d.reason === "never-fold-ruling"));
    // ⚠️ THE LINE ABOVE IS NOT ENOUGH ON ITS OWN, and a deliberate break proved
    // it: the CLUSTER veto records the very same `reason`, so deleting the
    // per-edge gate left this test green. `admittedSynonymCount` is the only
    // thing that separates them — the index's own note says a cluster the veto
    // rejects afterwards STILL counts its edges here. Zero means the edge never
    // got past the per-edge gate at all.
    assert.equal(idx.admittedSynonymCount, 0, "the per-edge gate must refuse it before any cluster forms");
  });

  it("refuses a cluster that reaches the pair through a THIRD name", () => {
    const idx = buildRelationIndex([
      { label: "synonym", fromCanonicalName: "coarse kosher salt", toCanonicalName: "coarse salt", yieldQuantity: null, yieldUnit: null, coHarvestable: null, confidence: "high", reviewedByHuman: true, fromDefaultUnit: "teaspoon" },
      { label: "synonym", fromCanonicalName: "coarse salt", toCanonicalName: "kosher salt", yieldQuantity: null, yieldUnit: null, coHarvestable: null, confidence: "high", reviewedByHuman: true, fromDefaultUnit: "teaspoon" },
    ]);
    assert.equal(idx.synonymFold("coarse kosher salt"), "coarse kosher salt", "the whole cluster is vetoed");
    assert.ok(idx.declined.some((d) => d.detail?.includes("never-fold pair")));
  });
});

// ── the self-edge magnitude the index used to discard ───────────────────────

describe("[grocery] B1 — a dropped self-edge keeps its magnitude", () => {
  const idx = buildRelationIndex([
    rel({
      fromCanonicalName: "garlic head", toCanonicalName: "garlic",
      yieldQuantity: 10, yieldUnit: "clove", coHarvestable: false,
      fromDefaultUnit: "each",
    }),
  ]);

  it("the slot is dropped (a parent is not its own child) but selfYields keeps it", () => {
    assert.equal(idx.componentParents.length, 0);
    assert.deepEqual(idx.selfYields.get("garlic head"), { perOne: 10, unit: "clove" });
  });

  it("so `garlic head 1 each` counts as TEN cloves, not one — the under-buy", () => {
    const merged = mergeConvertibleGroups(
      [garlic(6, "each", "garlic cloves"), garlic(9, "clove"), garlic(1, "each", "garlic head")],
      idx,
    );
    assert.equal(merged.length, 1, "three garlic rows become one (BUG-200)");
    assert.equal(merged[0].quantity, 25, "6 + 9 + (1 head = 10) = 25, not 16");
    assert.equal(packLine(merged[0]), "3 heads");
  });
});

// ── the unit-token fold Hans ruled in ───────────────────────────────────────

describe("[grocery] B1 — head and heads bucket together", () => {
  it("canonicalUnitToken folds the pack-noun plurals", () => {
    assert.equal(canonicalUnitToken("heads"), canonicalUnitToken("head"));
    assert.equal(canonicalUnitToken("bunches"), canonicalUnitToken("bunch"));
  });

  it("two rows spelled `head` and `heads` reach ONE merge group and sum", () => {
    const merged = mergeConvertibleGroups([cabbage(1, "head"), cabbage(1, "heads")], EMPTY_RELATION_INDEX);
    assert.equal(merged.length, 1, "the plural must not bucket alone");
    assert.equal(merged[0].quantity, 2);
  });
});

// ── [grocery] B2 BUG-330 — the pint of cherry tomatoes that under-ordered ────
//
// `1 pint cherry tomatoes (12 ounce)` bought 298 g against a 340 g need. The
// pack is a VOLUME and the need is a WEIGHT, and nothing said how much of the
// need one pint gives, so resolvePurchaseFields left the count at 1. The
// per-ingredient pack yield is the home; 10 oz per dry pint is the figure.
//
// Asserted at every boundary rather than at the one number the bug reported,
// because an off-by-one in the ceil would still pass a single 12-oz case.
describe("BUG-330 — a pint of cherry tomatoes yields 10 ounces", () => {
  const CHERRY = {
    canonicalName: "cherry tomatoes",
    conversionRef: {
      source: "curated",
      gramsPerCup: 149,
      purchaseUnit: "pint",
      purchaseQuantity: 1,
      purchaseDisplay: "1 pint",
    },
    packYieldUnit: "ounce",
    packYieldPerPack: 10,
    purchaseUnit: "pint",
  };

  function packsFor(needOunces: number): number | null {
    const conv = rowConversion(CHERRY as never);
    const scaled = scalePurchaseForSubUnit(conv, needOunces, "ounce", {
      packFloor: null,
      storedDisplay: "1 pint",
    });
    return scaled?.purchaseQuantity ?? null;
  }

  it("the yield reaches the ladder at all", () => {
    const conv = rowConversion(CHERRY as never);
    assert.deepEqual(conv?.subUnit, { parent: "pint", perParent: 10, childUnit: "ounce" });
  });

  it("orders ONE pint up to and including 10 ounces", () => {
    assert.equal(packsFor(6), 1);
    assert.equal(packsFor(10), 1);
  });

  it("orders TWO the moment the need passes one pint — the reported case", () => {
    assert.equal(packsFor(11), 2);
    assert.equal(packsFor(12), 2, "the live a8b0bbd5 line");
    assert.equal(packsFor(20), 2);
  });

  it("keeps climbing, and never under-orders", () => {
    assert.equal(packsFor(21), 3);
    for (const need of [1, 5, 9.9, 10.1, 15, 19.9, 20.1, 25]) {
      const packs = packsFor(need)!;
      assert.ok(packs * 10 + 1e-9 >= need, `${packs} pints must cover ${need} oz`);
    }
  });

  it("renders the pack line with the plural", () => {
    const conv = rowConversion(CHERRY as never);
    const scaled = scalePurchaseForSubUnit(conv, 12, "ounce", {
      packFloor: null,
      storedDisplay: "1 pint",
    });
    assert.equal(scaled?.purchaseDisplay, "2 pints");
  });
});
