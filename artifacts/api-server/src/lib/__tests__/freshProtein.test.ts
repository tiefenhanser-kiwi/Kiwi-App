// D-WS9-292 — fresh meat, poultry and seafood are bought BY WEIGHT.
//
// The four things this pins, because each one is a Part D break:
//   1. the rule itself — a weight need buys that weight, ceiled to the ¼ lb;
//   2. the exception list — bacon keeps its pack;
//   3. the direction of the rounding — UP, never down (R2);
//   4. exception 3's amendment — a COUNT need of a sourced cut converts, and an
//      UNSOURCED cut does not and must not.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUY_WEIGHT_STEP_LB,
  PIECE_WEIGHT_LB,
  classifyFreshProtein,
  freshProteinPurchase,
  roundBuyWeightLb,
  weightUnitToLb,
} from "../freshProtein";

const MEAT = { sectionKey: "meat_seafood" as const };

function verdict(
  name: string,
  quantity: number,
  unit: string,
  gramsPerEach?: number | null,
) {
  return classifyFreshProtein({
    ...MEAT,
    canonicalName: name,
    displayName: name,
    quantity,
    unit,
    gramsPerEach,
  });
}

describe("D-WS9-292 — the rule", () => {
  it("🔴 a weight need buys that weight, not the stored pack", () => {
    // Hans's own three rows. Before this rule they read "4 lb pack", "3 lb
    // pack" and "2 lb pack" against these needs.
    const breasts = verdict("boneless skinless chicken breasts", 2.5, "pound");
    assert.equal(breasts.kind, "by_weight");
    assert.equal(breasts.kind === "by_weight" && breasts.buyLb, 2.5);

    const thighs = verdict("boneless skinless chicken thighs", 1.75, "pound");
    assert.equal(thighs.kind === "by_weight" && thighs.buyLb, 1.75);

    const chuck = verdict("beef chuck", 2, "pound");
    assert.equal(chuck.kind === "by_weight" && chuck.buyLb, 2);
  });

  it("🔴 the round is UP to the next ¼ lb, never down (R2)", () => {
    assert.equal(BUY_WEIGHT_STEP_LB, 0.25);
    assert.equal(roundBuyWeightLb(2.01), 2.25);
    assert.equal(roundBuyWeightLb(2.26), 2.5);
    assert.equal(roundBuyWeightLb(1.75), 1.75); // already on the ladder
    assert.equal(roundBuyWeightLb(0.1), 0.25); // never zero
    // The epsilon is load-bearing: 3 × 0.25 is 0.7500000000000001 in binary and
    // a naive ceil would push an exact three-quarters to a full pound.
    assert.equal(roundBuyWeightLb(0.25 * 3), 0.75);
  });

  it("every weight spelling reaches the rule", () => {
    assert.equal(weightUnitToLb("pound"), 1);
    assert.equal(weightUnitToLb("lbs"), 1);
    assert.equal(weightUnitToLb("ounces"), 1 / 16);
    assert.equal(weightUnitToLb("cup"), null);
    // 24 oz is 1.5 lb and needs no rounding.
    const cod = verdict("cod fillets", 24, "ounce");
    assert.equal(cod.kind === "by_weight" && cod.buyLb, 1.5);
  });

  it("the gate is the SECTION, not the name — a broth is not meat", () => {
    // 25 corpus rows have a protein word and sit in `canned`. A name-keyed gate
    // would have bought chicken broth by the pound.
    const broth = classifyFreshProtein({
      sectionKey: "canned",
      canonicalName: "low-sodium chicken broth",
      displayName: "low-sodium chicken broth",
      quantity: 6,
      unit: "cup",
    });
    assert.equal(broth.kind, "not_fresh_protein");
  });

  it("a need that is neither a weight nor a count is left alone", () => {
    // "1 rotisserie chicken (3 cup)" — cups of shredded meat.
    const cups = verdict("shredded chicken", 3, "cup");
    assert.equal(cups.kind, "not_fresh_protein");
  });
});

describe("D-WS9-292 — the exceptions", () => {
  it("🔴 exception 1 — a fixed-package meat keeps its pack", () => {
    for (const name of [
      "thick-cut bacon",
      "turkey bacon",
      "Italian pork sausage",
      "breakfast sausage links",
      "all-beef hot dogs",
      "sliced pepperoni",
      "Genoa salami",
      "prosciutto di Parma",
      "pancetta",
      "guanciale",
      "canned tuna in water",
      "anchovy fillets",
      "smoked salmon",
      "lox",
    ]) {
      const v = verdict(name, 1, "pound");
      assert.equal(v.kind, "fixed_package", `${name} must keep its pack`);
    }
  });

  it("exception 2 — a whole item is bought whole, whatever the need says", () => {
    for (const name of ["whole chicken", "rotisserie chicken", "Cornish game hen", "rack of lamb", "spiral ham"]) {
      const v = verdict(name, 3, "pound");
      assert.equal(v.kind, "whole_item", `${name} must stay whole`);
    }
  });

  it("exception 2 beats exception 1 — a whole ham is not deli meat", () => {
    // "whole ham" contains no exception-1 keyword today, but the ORDER is what
    // guarantees that adding "ham" to the fixed-package list later cannot
    // silently reclassify the bird-shaped rows. Break (2) removes the list.
    const v = verdict("spiral ham", 8, "pound");
    assert.equal(v.kind, "whole_item");
  });

  it("the ruled list carries classes the corpus has no row for", () => {
    // Ruled September 30: the exception list is the RULED list, not the corpus.
    // These four have zero rows on the 20-plan census and are carried anyway.
    for (const name of ["bratwurst", "kielbasa", "mortadella", "sardines"]) {
      assert.equal(verdict(name, 1, "pound").kind, "fixed_package", name);
    }
  });
});

describe("D-WS9-292 — exception 3, the amendment", () => {
  it("🔴 a COUNT need of a SOURCED cut converts to weight", () => {
    // Hans: "a chicken breast is probably 1/2 lb on average, so 4 breasts = 2 lbs".
    const v = verdict("boneless skinless chicken breasts", 4, "each");
    assert.equal(v.kind, "by_weight");
    assert.equal(v.kind === "by_weight" && v.via, "count");
    assert.equal(v.kind === "by_weight" && v.buyLb, 2);

    // Pork chops at half a pound, from four agreeing catalog pack displays.
    const chops = verdict("bone-in pork chops", 4, "each");
    assert.equal(chops.kind === "by_weight" && chops.buyLb, 2);
  });

  it("the converted weight is ALSO ceiled to the ¼ lb", () => {
    // 3 salmon fillets × 0.375 lb = 1.125 → 1.25.
    const v = verdict("salmon fillets", 3, "each");
    assert.equal(v.kind === "by_weight" && v.buyLb, 1.25);
    assert.equal(v.kind === "by_weight" && v.needLb, 1.125);
  });

  it("🔴 an UNSOURCED cut stays a count and keeps its pack", () => {
    // ⚠️ THIS TEST USED TO NAME bone-in chicken thighs, which was the class's
    // own example until D-WS9-295 sourced it. The PROPERTY it pins is what
    // matters and is unchanged: a cut with no defensible piece weight declines
    // rather than guessing, because inventing one invents the datum the whole
    // rule rests on. Re-pointed at a cut that is still unsourced.
    const v = verdict("chicken drumsticks", 4, "each");
    assert.equal(v.kind, "count_unsourced");
    assert.equal(v.kind === "count_unsourced" && v.cut, "chicken drumstick");
  });

  it("the catalog's own gramsPerEach BEATS the curated table", () => {
    // 340 g is 0.75 lb; the table would have said 0.5. A catalog that learns
    // the number must not be overruled by a default.
    const v = verdict("boneless skinless chicken breasts", 2, "each", 340);
    assert.equal(v.kind === "by_weight" && v.buyLb, 1.5);
  });

  it("every piece weight names its source", () => {
    for (const row of PIECE_WEIGHT_LB) {
      assert.ok(row.source.trim().length > 20, `${row.match} needs a real source`);
      assert.ok(row.lb > 0 && row.lb < 3, `${row.match} piece weight is implausible`);
    }
  });
});

describe("D-WS9-292 — the pack it writes", () => {
  it("is a bare weight with no pack noun, and a packCount of 1", () => {
    const p = freshProteinPurchase(2.5);
    assert.deepEqual(p, {
      purchaseUnit: "lb",
      purchaseQuantity: 2.5,
      purchaseDisplay: "2.5 lb",
      // D-WS9-286: a COUNT of packs, never the size. One parcel of the stated
      // weight is one pack, so the order's count × size is the weight itself.
      packCount: 1,
    });
  });

  it("float noise from the ¼ multiply never reaches the display", () => {
    // 11 × 0.25 is 2.7500000000000004 in binary.
    const p = freshProteinPurchase(0.25 * 11);
    assert.equal(p.purchaseDisplay, "2.75 lb");
    assert.equal(p.purchaseQuantity, 2.75);
  });

  it("the display is what composePackName's Rule 2 needs", () => {
    // The residue of "2.5 lb" is "lb", which names no food, so Rule 2 prints
    // "{display} {name}" — "2.5 lb boneless skinless chicken breasts". The
    // glyph is applied at render by the client and never stored.
    const p = freshProteinPurchase(2.5);
    assert.ok(!/pack|bag|package|block|roast/.test(p.purchaseDisplay));
    assert.match(p.purchaseDisplay, /^[\d.]+ lb$/);
  });
});

// ── D-WS9-295 (E1) — the thigh, which Part B could not source ───────────────
describe("D-WS9-295 — bone-in and boneless chicken thighs", () => {
  it("🔴 the three corpus rows: 4 bone-in thighs is 1½ lb", () => {
    // Part B left these as counts because nothing in the repository stated a
    // thigh's piece weight. chat-Claude supplied it from the retail range.
    const v = verdict("bone-in chicken thighs", 4, "each");
    assert.equal(v.kind, "by_weight");
    assert.equal(v.kind === "by_weight" && v.pieceLb, 0.375);
    assert.equal(v.kind === "by_weight" && v.buyLb, 1.5);
  });

  it("🔴 BONELESS is the shorter weight, and the longest match decides", () => {
    // The bone is a third of the piece. "boneless skinless chicken thighs"
    // contains BOTH table keys, so longestMatch is what stops it being bought
    // at the bone-in weight — 4 boneless thighs is 1 lb, not 1½.
    const v = verdict("boneless skinless chicken thighs", 4, "each");
    assert.equal(v.kind === "by_weight" && v.pieceLb, 0.25);
    assert.equal(v.kind === "by_weight" && v.buyLb, 1);
    // …and the bone-in spelling still reaches the bone-in row.
    const bonein = verdict("bone-in skin-on chicken thighs", 4, "each");
    assert.equal(bonein.kind === "by_weight" && bonein.pieceLb, 0.375);
  });

  it("a WEIGHT need is unaffected by either piece weight", () => {
    const v = verdict("boneless skinless chicken thighs", 1.75, "pound");
    assert.equal(v.kind === "by_weight" && v.buyLb, 1.75);
    assert.equal(v.kind === "by_weight" && v.via, "weight");
  });

  it("the cuts still without a source stay counts", () => {
    for (const cut of ["chicken drumsticks", "chicken wings", "lamb shanks"]) {
      assert.equal(verdict(cut, 4, "each").kind, "count_unsourced", cut);
    }
  });
});
