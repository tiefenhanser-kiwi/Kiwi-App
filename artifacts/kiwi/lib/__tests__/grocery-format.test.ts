// WS7-8b B2 commit 3 — grocery two-part line compose (render-side) tests.
// Pins the rendered line + the edit round-trip contract (need edit updates the
// parenthetical; pack + quantityAmount are undisturbed).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  composePackName,
  composeGroceryLine,
  formatNeedText,
  pluralizeNeedUnit,
  pluralizeIngredientName,
  singularizeIngredientName,
  normalizeUnitToken,
  renderedPack,
  purchaseEditorPatch,
  purchaseEditorSeed,
  GROCERY_UNIT_OPTIONS,
} from "../format/grocery";

describe("composePackName (pack + name, with count-produce elide)", () => {
  it("prepends the pack for non-'each' packs", () => {
    assert.equal(
      composePackName("parmesan", "wedge", "1 wedge (6 oz)"),
      "1 wedge (6 oz) parmesan",
    );
    assert.equal(composePackName("chicken breast", "lb", "1 lb"), "1 lb chicken breast");
  });

  it("elides an 'each' pack that already names the item", () => {
    assert.equal(composePackName("lemon", "each", "2 lemons"), "2 lemons");
    assert.equal(composePackName("tomato", "each", "3 tomatoes"), "3 tomatoes");
  });

  // BUG-125 retitled: this pins the NEED-LESS (3-arg) fallback only. With a
  // need in hand the row now renders an order quantity — see BUG-125 guard 2,
  // which asserts "3 yellow onions". The assertion itself is unchanged.
  it("with no need in hand, drops a generic 'each' pack on a qualifier mismatch", () => {
    assert.equal(composePackName("yellow onion", "each", "2 onions"), "yellow onion");
  });

  it("bare name when there is no pack", () => {
    assert.equal(composePackName("saffron", null, null), "saffron");
    assert.equal(composePackName("saffron", undefined, undefined), "saffron");
  });
});

describe("formatNeedText (glyph at render only)", () => {
  it("glyphs on-ladder amounts", () => {
    assert.equal(formatNeedText("4.875", "oz", "x"), "4⅞ oz");
    assert.equal(formatNeedText("0.5", "cup", "x"), "½ cup");
    assert.equal(formatNeedText("30", "clove", "x"), "30 cloves"); // count noun pluralized
  });
  it("passes an off-glyph / non-numeric amount through raw", () => {
    assert.equal(formatNeedText("3.97", "oz", "x"), "3.97 oz");
    assert.equal(formatNeedText("to taste", undefined, "x"), "to taste");
  });
  it("falls back when no structured amount/unit", () => {
    assert.equal(formatNeedText(undefined, undefined, "1 bunch"), "1 bunch");
  });
});

describe("pluralizeNeedUnit — count nouns only (Hans override)", () => {
  it("pluralizes count nouns when quantity != 1", () => {
    assert.equal(pluralizeNeedUnit("clove", 30), "cloves");
    assert.equal(pluralizeNeedUnit("head", 3), "heads");
    assert.equal(pluralizeNeedUnit("leaf", 4), "leaves");
    assert.equal(pluralizeNeedUnit("box", 2), "boxes");
  });
  it("keeps count nouns singular at quantity 1", () => {
    assert.equal(pluralizeNeedUnit("clove", 1), "clove");
    assert.equal(pluralizeNeedUnit("head", 1), "head");
  });
  it("NEVER touches measure units (4⅞ ozs would be worse than the bug)", () => {
    assert.equal(pluralizeNeedUnit("oz", 4.875), "oz");
    assert.equal(pluralizeNeedUnit("cup", 2), "cup");
    assert.equal(pluralizeNeedUnit("tbsp", 3), "tbsp");
    assert.equal(pluralizeNeedUnit("lb", 2), "lb");
    assert.equal(pluralizeNeedUnit("g", 200), "g");
  });
  it("passes unknown units + non-numeric quantities through unchanged", () => {
    assert.equal(pluralizeNeedUnit("blorp", 5), "blorp");
    assert.equal(pluralizeNeedUnit("each", 3), "each"); // not in the allow-list
    assert.equal(pluralizeNeedUnit("clove", null), "clove");
  });
  it("through formatNeedText: measure stays, count pluralizes", () => {
    assert.equal(formatNeedText("4.875", "oz", "x"), "4⅞ oz");
    assert.equal(formatNeedText("30", "clove", "x"), "30 cloves");
    assert.equal(formatNeedText("1", "clove", "x"), "1 clove");
  });
});

describe("composeGroceryLine — the two-part line the user reads", () => {
  it("parmesan: 1 wedge (6 oz) parmesan (4⅞ oz)", () => {
    assert.equal(
      composeGroceryLine("parmesan", "wedge", "1 wedge (6 oz)", formatNeedText("4.875", "oz", "")),
      "1 wedge (6 oz) parmesan (4⅞ oz)",
    );
  });
  it("garlic: 3 heads garlic (30 cloves) — pack pre-scaled server-side, need pluralized", () => {
    assert.equal(
      composeGroceryLine("garlic", "head", "3 heads", formatNeedText("30", "clove", "")),
      "3 heads garlic (30 cloves)",
    );
  });
  it("omits the parenthetical when there is no need", () => {
    assert.equal(composeGroceryLine("salt", "container", "1 container", ""), "1 container salt");
  });
});

describe("edit round-trip: need edit updates the parenthetical; pack + raw amount undisturbed", () => {
  it("editing quantityAmount changes only the need, not the pack, and never formats the raw value", () => {
    // Persisted item: pack is DATA, need is the raw editable quantityAmount.
    const pack = { name: "parmesan", purchaseUnit: "wedge", purchaseDisplay: "1 wedge (6 oz)" };
    let quantityAmount = "4.875"; // raw
    const quantityUnit = "oz";

    const packBefore = composePackName(pack.name, pack.purchaseUnit, pack.purchaseDisplay);
    const lineBefore = composeGroceryLine(
      pack.name,
      pack.purchaseUnit,
      pack.purchaseDisplay,
      formatNeedText(quantityAmount, quantityUnit, ""),
    );
    assert.equal(lineBefore, "1 wedge (6 oz) parmesan (4⅞ oz)");

    // User edits the need to "2" (raw string, as the inline editor writes it).
    quantityAmount = "2";
    const packAfter = composePackName(pack.name, pack.purchaseUnit, pack.purchaseDisplay);
    const lineAfter = composeGroceryLine(
      pack.name,
      pack.purchaseUnit,
      pack.purchaseDisplay,
      formatNeedText(quantityAmount, quantityUnit, ""),
    );

    // Only the parenthetical changed; the pack is byte-identical.
    assert.equal(lineAfter, "1 wedge (6 oz) parmesan (2 oz)");
    assert.equal(packAfter, packBefore);
    assert.equal(packAfter, "1 wedge (6 oz) parmesan");
    // The raw amount is NEVER overwritten with a formatted glyph string.
    assert.equal(quantityAmount, "2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WS9 BUG-125 — the order line must COVER THE NEED.
//
// Ruled behaviour (Hans, 2026-08-21/22), three rules:
//   1. pack unit AND need unit are both the count unit "each" → the pack is
//      meaningless (loose-sold produce), the order quantity IS the need.
//   2. the units differ → the pack is a real container; use it as stored. It is
//      already scaled to cover the need SERVER-side (scalePurchaseForSubUnit,
//      head↔clove) — the client must not re-scale, it has no conversion data.
//   3. no pack → the need is the order quantity, UNLESS the name already leads
//      with a number (pre-b0cd677 legacy rows carry the pack baked into
//      displayName; prepending a second quantity gives two answers in one line).
// Over-ordering against a bogus pack is the accepted trade; under-ordering is
// the worse failure.
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-125: composePackName order quantity covers the need", () => {
  it("guard 1 — same-unit count produce uses the NEED, not the pack, not a multiple", () => {
    // Stored pack is 4; need is 9. Scaling the pack would give 3 packs = 12.
    // Loose-sold produce has no package to round to: the answer is 9.
    assert.equal(
      composePackName("roma tomatoes", "each", "4 roma tomatoes", "9", "each"),
      "9 roma tomatoes",
    );
    // Explicitly NOT either wrong answer.
    assert.notEqual(
      composePackName("roma tomatoes", "each", "4 roma tomatoes", "9", "each"),
      "4 roma tomatoes",
    );
    assert.notEqual(
      composePackName("roma tomatoes", "each", "4 roma tomatoes", "9", "each"),
      "12 roma tomatoes",
    );
    // The elide still holds: the count swaps in front of the stored residue.
    assert.equal(composePackName("Lemon", "each", "2 lemons", "5", "each"), "5 lemons");
    // A need BELOW the pack still wins — the pack is not a minimum.
    assert.equal(composePackName("Tomato", "each", "3 tomatoes", "2", "each"), "2 tomatoes");
  });

  it("guard 2 — a qualifier mismatch renders an order line instead of being dropped", () => {
    // "4 ears" does not match "ear of corn", so today the pack is dropped
    // entirely and the user is told nothing about how much to buy.
    assert.equal(
      composePackName("ear of corn", "each", "4 ears", "8", "each"),
      "8 ears of corn",
    );
    // The onion case the old elide comment was written for: no "2 onions
    // yellow onion", but no bare name either.
    assert.equal(
      composePackName("yellow onion", "each", "2 onions", "3", "each"),
      "3 yellow onions",
    );
    assert.equal(
      composePackName("ripe avocado", "each", "3 avocados", "2", "each"),
      "2 ripe avocados",
    );
    // Already-plural names are not double-pluralized.
    assert.equal(
      composePackName("garlic cloves", "each", "13 cloves (1-2 bulbs)", "6", "each"),
      "6 garlic cloves",
    );
    // Mass / invariant head nouns are left alone rather than mangled.
    assert.equal(
      composePackName("corn on the cob", "each", "2 ears", "4", "each"),
      "4 corn on the cob",
    );
  });

  it("guard 3 — a differing-unit pack is used as stored (the server already scaled it)", () => {
    // 6 cloves fits in one head; the server wrote "1 head".
    assert.equal(composePackName("garlic", "head", "1 head", "6", "clove"), "1 head garlic");
    // 30 cloves does not; the server wrote "3 heads". The client passes it
    // through untouched — it has no subUnit/perParent data to re-derive it.
    assert.equal(composePackName("garlic", "head", "3 heads", "30", "clove"), "3 heads garlic");
    // A measured need against a container pack is likewise passed through.
    assert.equal(composePackName("flour", "bag", "5 lb bag", "1.5", "cup"), "5 lb bag flour");
    assert.equal(composePackName("cardamom", "bottle", "1 bottle", "2", "tbsp"), "1 bottle cardamom");
  });

  it("guard 3b — the residue elide is presentation, decoupled from the quantity decision", () => {
    // Differing unit (need in cups, pack sold by the each) AND the pack names
    // the item: must not read "1 seedless watermelon seedless watermelon".
    assert.equal(
      composePackName("seedless watermelon", "each", "1 seedless watermelon", "3", "cup"),
      "1 seedless watermelon",
    );
  });

  it("guard 4 — no pack falls back to the need as the order quantity", () => {
    assert.equal(composePackName("Carrots", null, null, "3", "each"), "3 Carrots");
    assert.equal(composePackName("Yellow onion", null, null, "4", "each"), "4 Yellow onions");
    // A measure unit carries its unit — a bare number would be meaningless.
    assert.equal(
      composePackName("lime juice", null, null, "5", "tablespoon"),
      "5 tablespoon lime juice",
    );
    assert.equal(composePackName("bread", undefined, undefined, "2", "loaf"), "2 loaves bread");
  });

  it("guard 5 — no pack AND a name that already leads with a number renders unchanged", () => {
    // Legacy pre-b0cd677 rows carry the pack baked into displayName. The name
    // already answers "how much do I buy"; prepending gives two answers.
    assert.equal(composePackName("1 head Garlic", null, null, "30", "clove"), "1 head Garlic");
    assert.equal(
      composePackName("2 cans (14.5 oz each) beef broth", null, null, "28", "ounce"),
      "2 cans (14.5 oz each) beef broth",
    );
    assert.equal(
      composePackName("1 bottle (17 oz) Olive oil", null, null, "3", "tablespoon"),
      "1 bottle (17 oz) Olive oil",
    );
  });

  it("guard 6 — the NEED parenthetical is byte-unchanged in every BUG-125 case", () => {
    // Explicit literals — not derived from the helpers under test.
    assert.equal(formatNeedText("9", "each", ""), "9 each");
    assert.equal(formatNeedText("8", "each", ""), "8 each");
    assert.equal(formatNeedText("6", "clove", ""), "6 cloves");
    assert.equal(formatNeedText("30", "clove", ""), "30 cloves");
    assert.equal(formatNeedText("1.5", "cup", ""), "1½ cup");
    assert.equal(formatNeedText("4.875", "oz", ""), "4⅞ oz");
    // And through the whole line: the order part moves, the parenthetical does not.
    assert.equal(
      composeGroceryLine("roma tomatoes", "each", "4 roma tomatoes", "9 each", "9", "each"),
      "9 roma tomatoes (9 each)",
    );
    assert.equal(
      composeGroceryLine("ear of corn", "each", "4 ears", "8 each", "8", "each"),
      "8 ears of corn (8 each)",
    );
    assert.equal(
      composeGroceryLine("garlic", "head", "3 heads", "30 cloves", "30", "clove"),
      "3 heads garlic (30 cloves)",
    );
  });

  it("guard 7 — the 'each' edit round-trip INVERTS: editing the need moves the order line", () => {
    // Container row (parmesan, wedge vs oz): the pack is a real package, so
    // editing the need must NOT move it. That is the WS7-8b B2 invariant.
    const containerBefore = composePackName("parmesan", "wedge", "1 wedge (6 oz)", "4.875", "oz");
    const containerAfter = composePackName("parmesan", "wedge", "1 wedge (6 oz)", "2", "oz");
    assert.equal(containerBefore, "1 wedge (6 oz) parmesan");
    assert.equal(containerAfter, "1 wedge (6 oz) parmesan");
    assert.equal(containerAfter, containerBefore);

    // 'each' row (roma tomatoes): the order quantity IS the need, so editing
    // the need MUST move it. Leaving the invariant looking universal would be
    // the tautology shape — this is the case that proves it is not.
    const eachBefore = composePackName("roma tomatoes", "each", "4 roma tomatoes", "9", "each");
    const eachAfter = composePackName("roma tomatoes", "each", "4 roma tomatoes", "12", "each");
    assert.equal(eachBefore, "9 roma tomatoes");
    assert.equal(eachAfter, "12 roma tomatoes");
    assert.notEqual(eachAfter, eachBefore);
  });

  it("guard 8 — omitting the need arguments preserves the pre-BUG-125 behaviour exactly", () => {
    // Back-compat for the 3-arg shape (composeGroceryLine's mirror tests and
    // any caller not yet threading the need).
    assert.equal(composePackName("parmesan", "wedge", "1 wedge (6 oz)"), "1 wedge (6 oz) parmesan");
    assert.equal(composePackName("lemon", "each", "2 lemons"), "2 lemons");
    assert.equal(composePackName("saffron", null, null), "saffron");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WS9 grocery quantity block — Roots D and A (BUG-125 device-pass follow-ups).
//
// D: at a count of exactly 1 the residue-swap branch emitted the pack's own
//    plural ("2 lemons" → residue "lemons" → "1 lemons"). Every one of the 25
//    guards `083d935` shipped used a count >= 2, which is why it went green.
// A: `scalePurchaseForSubUnit` covers ONE ingredient in a 1,570-row catalog
//    (garlic). Every other container pack printed verbatim regardless of need,
//    so "1 lb ground beef" stood against a need of 1.75 lb — under-ordering,
//    the failure mode ruled worst.
// ─────────────────────────────────────────────────────────────────────────────
describe("Root D: the order line singularises at a count of exactly 1", () => {
  it("guard D1 — a plural pack residue against a singular name renders singular", () => {
    assert.equal(composePackName("Lemon", "each", "2 lemons", "1", "each"), "1 Lemon");
    assert.equal(composePackName("jalapeño", "each", "4 jalapeños", "1", "each"), "1 jalapeño");
    assert.equal(composePackName("Lime", "each", "2 limes", "1", "each"), "1 Lime");
    assert.equal(
      composePackName("english cucumber", "each", "2 english cucumbers", "1", "each"),
      "1 english cucumber",
    );
    // And explicitly NOT the shipped defect.
    assert.notEqual(composePackName("Lemon", "each", "2 lemons", "1", "each"), "1 lemons");
  });

  it("guard D2 — a name that is ITSELF plural stays plural (accepted, no stemmer)", () => {
    // "roma tomatoes" has no singular to fall back to. One live row. Ruled:
    // leave it rather than build a stemmer for a single row.
    assert.equal(
      composePackName("roma tomatoes", "each", "7 roma tomatoes", "1", "each"),
      "1 roma tomatoes",
    );
  });

  it("guard D3 — counts >= 2 are untouched by the singularisation branch", () => {
    assert.equal(composePackName("Lemon", "each", "2 lemons", "5", "each"), "5 lemons");
    assert.equal(composePackName("Lemon", "each", "2 lemons", "2", "each"), "2 lemons");
  });
});

describe("Root A: a container pack scales to cover the need", () => {
  it("guard A1 — same-unit arithmetic scales the pack", () => {
    // The sliders case: 1¾ lb of beef against a 1 lb pack.
    assert.equal(
      composePackName("ground beef", "lb", "1 lb", "1.75", "pound"),
      "2 lb ground beef",
    );
    // The cilantro case: 3 bunches needed, sold by the bunch.
    assert.equal(
      composePackName("fresh cilantro", "bunch", "1 bunch", "3", "bunch"),
      "3 bunches fresh cilantro",
    );
    // A multi-unit pack: 3.5 lb needed, 1.5 lb per pack -> 3 packs = 4.5 lb.
    // [grocery] F (F5.4) — the TOTAL is glyphed at render now ("4½", not "4.5").
    // The arithmetic is unchanged and that is the point of keeping this guard:
    // glyphPackDisplay runs last, on the string about to be shown, long after
    // packLeadingQuantity has parsed the stored decimal.
    assert.equal(
      composePackName("chicken thighs", "lb", "1.5 lb pack", "3.5", "pound"),
      "4½ lb pack chicken thighs",
    );
  });

  it("guard A2 — BOUNDARY: need == purchaseQuantity is exactly ONE pack", () => {
    // Float noise makes ceil(1.0/1.0) unsafe without an epsilon.
    assert.equal(composePackName("ground beef", "lb", "1 lb", "1", "pound"), "1 lb ground beef");
    // F5.4 — one pack, so scalePackDisplay returns the STORED string and the
    // glyph is the only thing that moved.
    assert.equal(
      composePackName("chicken thighs", "lb", "1.5 lb pack", "1.5", "pound"),
      "1½ lb pack chicken thighs",
    );
    assert.equal(
      composePackName("fresh cilantro", "bunch", "1 bunch", "1", "bunch"),
      "1 bunch fresh cilantro",
    );
    // Just over the boundary is two.
    assert.equal(
      composePackName("ground beef", "lb", "1 lb", "1.125", "pound"),
      "2 lb ground beef",
    );
    // Under the boundary is still one — never round DOWN to zero packs.
    assert.equal(composePackName("ground beef", "lb", "1 lb", "0.5", "pound"), "1 lb ground beef");
  });

  it("guard A3 — the display's size hint scales when its unit matches the need", () => {
    assert.equal(
      composePackName("crushed tomatoes", "can", "1 can (14.5 oz)", "56", "ounce"),
      "4 cans (14.5 oz) crushed tomatoes",
    );
    assert.equal(
      composePackName("Baby spinach", "container", "1 container (5 oz)", "10", "ounce"),
      "2 containers (5 oz) Baby spinach",
    );
  });

  it("guard A4 — a size hint whose unit does NOT match the need falls through untouched", () => {
    // oz hint vs a cup need: no cross-dimension conversion here (out of scope,
    // and the data to do it safely does not exist). Must NOT mis-scale.
    //
    // The need is 30 CUPS deliberately. An earlier version of this guard used
    // 3 cups, and mutation testing showed it could not fail: dropping the unit
    // check made the code compute ceil(3 / 14.5) = 1 pack, which renders
    // identically to not scaling at all. 30 cups mis-scales to "3 cans" if the
    // unit check is removed, so the guard now discriminates.
    assert.equal(
      composePackName("crushed tomatoes", "can", "1 can (14.5 oz)", "30", "cup"),
      "1 can (14.5 oz) crushed tomatoes",
    );
    assert.equal(
      composePackName("crushed tomatoes", "can", "1 can (14.5 oz)", "3", "cup"),
      "1 can (14.5 oz) crushed tomatoes",
    );
    // No hint at all, differing units: unchanged.
    assert.equal(
      composePackName("cardamom", "bottle", "1 bottle", "2", "tbsp"),
      "1 bottle cardamom",
    );
  });

  it("guard A5 — the server-scaled subUnit (garlic) path is NOT touched", () => {
    // clove-vs-head is scaled SERVER-side by scalePurchaseForSubUnit; the client
    // has no conversionRef and must pass both through byte-identically.
    assert.equal(composePackName("garlic", "head", "1 head", "6", "clove"), "1 head garlic");
    assert.equal(composePackName("garlic", "head", "3 heads", "30", "clove"), "3 heads garlic");
  });

  it("guard A6 — the residue elide still wins over scaling", () => {
    assert.equal(
      composePackName("seedless watermelon", "each", "1 seedless watermelon", "3", "cup"),
      "1 seedless watermelon",
    );
  });
});

describe("Roots A+B compose: the order line rounds up, the need stays fine-grained", () => {
  it("guard AB1 — 1¼ bunches needed, sold by the bunch → order 2, need 1¼", () => {
    // This is the pair that proves the two roots compose. The ORDER line ceils;
    // the NEED parenthetical does not.
    assert.equal(
      composePackName("fresh cilantro", "bunch", "1 bunch", "1.25", "bunch"),
      "2 bunches fresh cilantro",
    );
    assert.equal(formatNeedText("1.25", "bunch", ""), "1¼ bunches");
    assert.equal(
      composeGroceryLine("fresh cilantro", "bunch", "1 bunch", "1¼ bunches", "1.25", "bunch"),
      "2 bunches fresh cilantro (1¼ bunches)",
    );
  });

  it("guard AB2 — half a lemon: order 1, need ½ (the change Hans could not see)", () => {
    assert.equal(composePackName("Lemon", "each", "2 lemons", "0.5", "each"), "1 Lemon");
    assert.equal(formatNeedText("0.5", "each", ""), "½ each");
    assert.equal(
      composeGroceryLine("Lemon", "each", "2 lemons", "½ each", "0.5", "each"),
      "1 Lemon (½ each)",
    );
    // ...and after the second half is added, the need moves and the order does not.
    assert.equal(
      composeGroceryLine("Lemon", "each", "2 lemons", "1 each", "1", "each"),
      "1 Lemon (1 each)",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WS9 BUG-143 — the oz↔lb gap in packsToCoverNeed.
//
// Root A gave the container branch two ways to relate a need to a pack: an
// exact unit-token match, or a parenthetical size in the need's own unit.
// A need in `oz` against a pack in `lb` matched NEITHER, so 35 live rows fell
// through to "print the pack verbatim, whatever the need" — the same
// under-order Root A existed to kill, one unit-pair short.
//
// ⚠️ THE NUMBERS ARE ASSERTED AS LITERAL PACK COUNTS, never by importing
// WEIGHT_UNIT_TO_GRAMS. Deriving the expectation from the same constant the
// code uses would move both sides together and pin nothing — the tautology
// shape `cc90e95` avoided by asserting the literal 100. A boundary at exactly
// 16 oz per lb is what actually pins the ratio.
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-143: weight↔weight packs scale; nothing else starts scaling", () => {
  it("guard W1 — a need in oz above the pack scales it (was: printed verbatim)", () => {
    // 24 oz against a 1 lb block is two blocks. Before BUG-143 this returned
    // "1 lb block Cotija cheese" — half the cheese the recipes call for.
    assert.equal(
      composePackName("Cotija cheese", "lb", "1 lb block", "24", "ounce"),
      "2 lb block Cotija cheese",
    );
    assert.equal(
      composePackName("thick-cut bacon", "lb", "1 lb pack", "40", "ounce"),
      "3 lb pack thick-cut bacon",
    );
  });

  it("guard W2 — BOUNDARY: exactly 16 oz is ONE pound, not two", () => {
    // This is the assertion that pins the ratio. If either gram constant drifts
    // by any amount, 16 oz stops being exactly one pack and this goes red.
    assert.equal(
      composePackName("Cotija cheese", "lb", "1 lb block", "16", "ounce"),
      "1 lb block Cotija cheese",
    );
    // ...and one ounce more is two. 15 oz is still one.
    assert.equal(
      composePackName("Cotija cheese", "lb", "1 lb block", "17", "ounce"),
      "2 lb block Cotija cheese",
    );
    assert.equal(
      composePackName("Cotija cheese", "lb", "1 lb block", "15", "ounce"),
      "1 lb block Cotija cheese",
    );
  });

  it("guard W3 — BOUNDARY: a half-pound pack, where the epsilon earns its keep", () => {
    // 8 oz against "0.5 lb pack" is EXACTLY one pack. Without the epsilon this
    // is the case that ceils to 2 on float noise.
    // F5.4 — Hans's own example: "0.5 lb pack" reads "½ lb pack".
    assert.equal(
      composePackName("guanciale", "lb", "0.5 lb pack", "8", "ounce"),
      "½ lb pack guanciale",
    );
    // 9 oz needs two half-pound packs — which is one pound of total product,
    // the same total-not-count convention guard A3 already pins.
    assert.equal(
      composePackName("guanciale", "lb", "0.5 lb pack", "9", "ounce"),
      "1 lb pack guanciale",
    );
  });

  it("guard W4 — the reverse direction and grams both relate", () => {
    // A need in lb against a pack in oz. 2 lb = 32 oz = four 8-oz packages.
    assert.equal(
      composePackName("feta", "oz", "8 oz package", "2", "pound"),
      "32 oz package feta",
    );
    // Grams: 500 g is more than one 453.59 g pound, so two.
    assert.equal(
      composePackName("ground beef", "lb", "1 lb", "500", "gram"),
      "2 lb ground beef",
    );
  });

  it("guard W5 — every live weight row today needs ONE pack and is untouched", () => {
    // Measured against the DB at build time: all 35 weight↔weight rows need at
    // most one pack, so BUG-143 changes ZERO current rows. It is a forward fix
    // (D-WS9-186) and writes nothing. These are the real live shapes.
    //
    // [grocery] F (F5.4) — the two sub-one packs now render their glyph. Still
    // ONE pack each: the PACK COUNT is what this guard is about and none of it
    // moved, which is exactly what a render-only change should look like.
    assert.equal(
      composePackName("Cotija cheese", "lb", "1 lb block", "5.125", "ounce"),
      "1 lb block Cotija cheese",
    );
    assert.equal(
      composePackName("Mexican fresh chorizo", "lb", "0.75 lb pack", "12", "ounce"),
      "¾ lb pack Mexican fresh chorizo",
    );
    assert.equal(
      composePackName("gruyère cheese", "lb", "0.5 lb block", "4", "ounce"),
      "½ lb block gruyère cheese",
    );
  });

  it("guard W6 — SCOPE: volume and container pairs still do NOT scale", () => {
    // The 258 tsp→container, 156 tbsp→bottle and 68 cup→bunch rows need a
    // per-ingredient density that no table here supplies. An absurd need is
    // used deliberately: if the weight rule ever leaked into these, a need this
    // large could not possibly still print one pack.
    assert.equal(
      composePackName("olive oil", "bottle", "1 bottle", "400", "tablespoon"),
      "1 bottle olive oil",
    );
    assert.equal(
      composePackName("kosher salt", "container", "1 container", "900", "teaspoon"),
      "1 container kosher salt",
    );
    assert.equal(
      composePackName("fresh basil", "bunch", "1 bunch", "300", "cup"),
      "1 bunch fresh basil",
    );
  });

  it("guard W7 — WS9 BUG-147 CLOSED THIS: a weight need against a container pack now scales", () => {
    // ⚠️ THIS GUARD USED TO ASSERT "1 package (12 oz) bacon" AND IT WAS RIGHT
    // TO. It pinned a DEFERRAL, not a behaviour: its own note called the row
    // "a real under-order... deliberately NOT fixed here", pinned "so the next
    // person sees the choice was made". BUG-147 is that next person. Deciding
    // the deferred question is what changes the assertion; the guard did its
    // job by making the change deliberate instead of silent.
    //
    // 2 lb = 32 oz against a 12 oz package → 3 packages.
    assert.equal(
      composePackName("bacon", "package", "1 package (12 oz)", "2", "pound"),
      "3 packages (12 oz) bacon",
    );
  });

  it("guard W8 — the pre-existing hint rule still works and is not shadowed", () => {
    // The parenthetical-size rule must survive the new weight rule sitting in
    // front of it. `can` is not a weight unit, so the hint is the only way in.
    assert.equal(
      composePackName("crushed tomatoes", "can", "1 can (14.5 oz)", "56", "ounce"),
      "4 cans (14.5 oz) crushed tomatoes",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WS9 BUG-144 — the count-of-1 plural on the branch Root D did not cover.
//
// Root D fixed "1 lemons" on the branch where the pack residue NAMES the item,
// by falling back to the ingredient name. The sibling branch — residue does not
// name the item — has no fallback, because there the NAME is the plural:
// "garlic cloves" against a pack of "1 head of garlic" rendered
// "1 garlic cloves". It renders live on list 22117b24.
//
// ⚠️ EVERY GUARD BELOW HAS A CASE AT EXACTLY 1, ON EACH BRANCH. That is the
// whole lesson of BUG-130: all 25 guards `083d935` shipped used counts >= 2,
// which is precisely how "1 lemons" went green.
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-144: the order line agrees with a count of 1 on BOTH branches", () => {
  it("guard S1 — the live defect: residue does not name the item, name is plural", () => {
    // The exact row on list 22117b24.
    assert.equal(
      composePackName("garlic cloves", "each", "1 head of garlic", "1", "each"),
      "1 garlic clove",
    );
    // And explicitly NOT the shipped defect.
    assert.notEqual(
      composePackName("garlic cloves", "each", "1 head of garlic", "1", "each"),
      "1 garlic cloves",
    );
  });

  it("guard S2 — the SAME branch at counts >= 2 stays plural", () => {
    assert.equal(
      composePackName("garlic cloves", "each", "1 head of garlic", "2", "each"),
      "2 garlic cloves",
    );
    assert.equal(
      composePackName("garlic cloves", "each", "1 head of garlic", "20", "each"),
      "20 garlic cloves",
    );
  });

  it("guard S3 — the no-pack branch had the same defect, at 1 and above", () => {
    // Nine of the ten live rows this block corrects are here, not on the branch
    // the bug was reported from: "1 bananas", "1 pet treats", "1 Nespresso pods".
    assert.equal(composePackName("Carrots", null, null, "1", "each"), "1 Carrot");
    assert.equal(composePackName("bananas", null, null, "1", "each"), "1 banana");
    assert.equal(composePackName("pet treats", null, null, "1", "each"), "1 pet treat");
    // ...and counts >= 2 are untouched, matching the pre-existing guard.
    assert.equal(composePackName("Carrots", null, null, "3", "each"), "3 Carrots");
    assert.equal(composePackName("Yellow onion", null, null, "4", "each"), "4 Yellow onions");
  });

  it("guard S4 — irregulars come from the SAME map as the plural direction", () => {
    // COUNT_NOUN_SINGULARS is derived by inverting COUNT_NOUN_PLURALS, so the
    // two directions cannot drift. These are the irregulars a hand-authored
    // second list would be free to get wrong.
    assert.equal(singularizeIngredientName("Bay leaves"), "Bay leaf");
    assert.equal(singularizeIngredientName("ears of corn"), "ear of corn");
    assert.equal(singularizeIngredientName("lime wedges"), "lime wedge");
    assert.equal(singularizeIngredientName("brioche buns"), "brioche bun");
    // -ies and -oes, the two rules English disagrees with itself about.
    assert.equal(singularizeIngredientName("mixed berries"), "mixed berry");
    assert.equal(singularizeIngredientName("Cherry tomatoes"), "Cherry tomato");
    assert.equal(singularizeIngredientName("fingerling potatoes"), "fingerling potato");
  });

  it("guard S5 — words that only LOOK plural are not stemmed", () => {
    // ⚠️ THIS GUARD WAS REWRITTEN. It first asserted that INVARIANT_NAME_NOUNS
    // protected these, and deleting that check from singularizeNoun left the
    // suite GREEN — the check was unreachable, because every invariant noun
    // already fails isPluralWord. The assertion was describing a guard that
    // was not doing the work. What actually holds this line is the
    // -ss / -us / -is clause in isPluralWord, so that is what is pinned now.
    assert.equal(singularizeIngredientName("asparagus"), "asparagus"); // -us
    assert.equal(singularizeIngredientName("couscous"), "couscous"); // -us
    assert.equal(singularizeIngredientName("watercress"), "watercress"); // -ss
    assert.equal(singularizeIngredientName("molasses"), "molasses"); // -es on -ss
    assert.equal(singularizeIngredientName("Swiss chard"), "Swiss chard"); // -ss mid-name
    assert.equal(singularizeIngredientName("corn on the cob"), "corn on the cob"); // no -s
    assert.equal(singularizeIngredientName("Yellow onion"), "Yellow onion"); // already singular
    // Through the composer, at exactly 1, on the uncovered branch.
    assert.equal(
      composePackName("corn on the cob", "each", "2 ears", "1", "each"),
      "1 corn on the cob",
    );
  });

  it("guard S6 — a trailing prep clause rides along untouched", () => {
    assert.equal(
      singularizeIngredientName("garlic cloves, peeled"),
      "garlic clove, peeled",
    );
    assert.equal(
      composePackName("garlic cloves, peeled", "each", "1 head of garlic", "1", "each"),
      "1 garlic clove, peeled",
    );
  });

  it("guard S7 — Root D's ruled branch is UNCHANGED (guard D2 still stands)", () => {
    // A stemmer now exists, which was the stated reason D2 accepted
    // "1 roma tomatoes". This pins that the residue-swap branch was NOT
    // rerouted through it — changing a ruled outcome is not this block's call.
    assert.equal(
      composePackName("roma tomatoes", "each", "7 roma tomatoes", "1", "each"),
      "1 roma tomatoes",
    );
    assert.equal(composePackName("Lemon", "each", "2 lemons", "1", "each"), "1 Lemon");
  });

  it("guard S8 — singularise is the INVERSE of pluralise, not a lookalike", () => {
    // A property, not a table: this is what proves the derived map is really
    // the inverse rather than a second hand-authored list that happens to agree
    // on the cases someone thought to write down. Measured over the live
    // catalog at build time, 583 of 584 changed names round-trip.
    for (const singular of [
      "Carrot", "banana", "green onion", "Kalamata olive", "brioche bun",
      "Bay leaf", "fingerling potato", "Cherry tomato", "garlic clove",
      "lime wedge", "chicken thigh", "ear of corn",
    ]) {
      const plural = pluralizeIngredientName(singular, 2);
      assert.notEqual(plural, singular, `${singular} should pluralize`);
      assert.equal(singularizeIngredientName(plural), singular);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WS9 BUG-149 — the plural direction on the residue-reuse branch.
//
// Root D fixed a count of 1 against a PLURAL residue ("2 lemons" -> "1 lemons").
// Its mirror was never tried: a count of 2+ against a SINGULAR residue.
// "1 apple" against a need of 2 printed "2 apple" (live, list 93a03e23).
//
// PROVENANCE (verified, not assumed): PRE-EXISTING. Running the pre-BUG-144
// module (commit 2e12b41~1) on the same inputs returns "2 apple" byte-identically,
// so this is not a BUG-144 regression — BUG-144 only touched the two branches
// that do NOT reuse the stored residue.
//
// ⚠️ EVERY GUARD BELOW HAS A CASE AT EXACTLY 1 *AND* EXACTLY 2. BUG-144's own
// history is the argument: all 25 of Root D's guards used counts >= 2, which is
// how "1 lemons" shipped green — and then the mirror shipped through the fix
// for want of the opposite case. One count is never enough on this branch.
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-149: a SINGULAR pack residue pluralises above a count of 1", () => {
  it("guard P1 — the live defect: '1 apple' at 2 is '2 apples', at 1 is '1 apple'", () => {
    assert.equal(composePackName("apple", "each", "1 apple", "2", "each"), "2 apples");
    assert.equal(composePackName("apple", "each", "1 apple", "1", "each"), "1 apple");
    assert.equal(composePackName("apple", "each", "1 apple", "3", "each"), "3 apples");
    // And explicitly NOT the shipped defect.
    assert.notEqual(composePackName("apple", "each", "1 apple", "2", "each"), "2 apple");
  });

  it("guard P2 — the other live singular-residue rows, at 1 and at 2", () => {
    assert.equal(composePackName("shallot", "each", "1 shallot", "1", "each"), "1 shallot");
    assert.equal(composePackName("shallot", "each", "1 shallot", "2", "each"), "2 shallots");
    assert.equal(
      composePackName("yellow bell pepper", "each", "1 yellow bell pepper", "1", "each"),
      "1 yellow bell pepper",
    );
    assert.equal(
      composePackName("yellow bell pepper", "each", "1 yellow bell pepper", "2", "each"),
      "2 yellow bell peppers",
    );
    assert.equal(composePackName("lime", "each", "1 lime", "1", "each"), "1 lime");
    assert.equal(composePackName("lime", "each", "1 lime", "2", "each"), "2 limes");
  });

  it("guard P3 — a PLURAL residue is untouched in BOTH directions (Root D intact)", () => {
    // The branch must not double-pluralise what is already plural, and Root D's
    // count-of-1 fallback must still fire.
    assert.equal(composePackName("Lemon", "each", "2 lemons", "1", "each"), "1 Lemon");
    assert.equal(composePackName("Lemon", "each", "2 lemons", "2", "each"), "2 lemons");
    assert.equal(composePackName("Lemon", "each", "2 lemons", "5", "each"), "5 lemons");
    assert.equal(composePackName("roma tomatoes", "each", "4 roma tomatoes", "1", "each"), "1 roma tomatoes");
    assert.equal(composePackName("roma tomatoes", "each", "4 roma tomatoes", "2", "each"), "2 roma tomatoes");
  });

  it("guard P4 — irregular and invariant residues, at 1 and at 2", () => {
    // The residue is pluralised by the SAME helper the name uses, so the
    // irregulars and the mass nouns behave identically on both halves.
    // ⚠️ The name must MATCH the residue or this branch never runs — the first
    // draft of this guard used name "bay leaf" against residue "leaf", which
    // fails residueNamesItem and silently tested the OTHER branch instead.
    assert.equal(composePackName("leaf", "each", "1 leaf", "1", "each"), "1 leaf");
    assert.equal(composePackName("leaf", "each", "1 leaf", "2", "each"), "2 leaves");
    assert.equal(composePackName("squash", "each", "1 squash", "1", "each"), "1 squash");
    assert.equal(composePackName("squash", "each", "1 squash", "2", "each"), "2 squashes");
    // "corn" is invariant — it must NOT gain an "s" at 2.
    assert.equal(composePackName("corn", "each", "1 corn", "1", "each"), "1 corn");
    assert.equal(composePackName("corn", "each", "1 corn", "2", "each"), "2 corn");
  });

  it("guard P5 — a fractional need still ceils, then agrees", () => {
    // roundNeedQuantity leaves counts fractional now (Root B), so the ORDER
    // line is where the ceil happens — and the ceiled count drives the plural.
    assert.equal(composePackName("apple", "each", "1 apple", "0.5", "each"), "1 apple");
    assert.equal(composePackName("apple", "each", "1 apple", "1.25", "each"), "2 apples");
  });

  it("guard P6 — the other branches are untouched by this change", () => {
    // Residue does NOT name the item -> countedName path (BUG-144), and the
    // no-pack path. Both at 1 and at 2, so a regression on either shows here.
    assert.equal(composePackName("garlic cloves", "each", "1 head of garlic", "1", "each"), "1 garlic clove");
    assert.equal(composePackName("garlic cloves", "each", "1 head of garlic", "2", "each"), "2 garlic cloves");
    assert.equal(composePackName("Carrots", null, null, "1", "each"), "1 Carrot");
    assert.equal(composePackName("Carrots", null, null, "2", "each"), "2 Carrots");
  });
});

// ── WS9 BUG-171 — a pantry staple shows the NEED, not a pack ─────────────────
// Ruled (Hans, Aug 27 2026) Option A. Pack size for a staple is the user's
// purchasing decision — bulk or a little at a time — so the list states the
// week's need and stops selling a container.
describe("BUG-171: a pantry staple collapses the order half to the bare name", () => {
  it("the ruling's own example: kosher salt shows no container", () => {
    // The pack the catalog holds for salt, and the need for a real week.
    // Expected value written out as the line the USER reads, not derived from
    // the arguments — "Kosher salt" is what the row must say, full stop.
    assert.equal(
      composePackName("Kosher salt", "container", "1 container (26 oz)", "11", "teaspoon", true),
      "Kosher salt",
    );
    // …and the whole two-part line, need parenthetical included.
    assert.equal(
      composeGroceryLine(
        "Kosher salt",
        "container",
        "1 container (26 oz)",
        "11 teaspoon",
        "11",
        "teaspoon",
        true,
      ),
      "Kosher salt (11 teaspoon)",
    );
  });

  it("the SAME row without the flag still composes the pack", () => {
    // The control. If this ever equals the staple output, the flag is inert and
    // the test above proves nothing.
    const asStaple = composePackName("Kosher salt", "container", "1 container (26 oz)", "11", "teaspoon", true);
    const asNormal = composePackName("Kosher salt", "container", "1 container (26 oz)", "11", "teaspoon", false);
    assert.equal(asNormal, "1 container (26 oz) Kosher salt");
    assert.notEqual(asStaple, asNormal, "the staple flag must change the output");
  });

  it("applies to BOTH staple states — the flag is not the opted-in flag", () => {
    // The screen passes item.isUniversalStaple, which is true opted-in and not,
    // so the line does not change shape on tap. Nothing in the lib can tell the
    // two apart, and that is the point: one branch, one output.
    for (const need of ["11", "1", "900"]) {
      assert.equal(
        composePackName("Kosher salt", "container", "1 container (26 oz)", need, "teaspoon", true),
        "Kosher salt",
      );
    }
  });

  it("takes no pack branch at all — every rule below it is skipped", () => {
    // Rule 1 (count pack + count need, the elide/plural path) …
    assert.equal(composePackName("Lemon", "each", "2 lemons", "5", "each", true), "Lemon");
    assert.equal(composePackName("roma tomatoes", "each", "4 roma tomatoes", "9", "each", true), "roma tomatoes");
    // Rule 2 (real container, scaled to cover the need) …
    assert.equal(composePackName("olive oil", "bottle", "1 bottle", "400", "tablespoon", true), "olive oil");
    // Rule 3 (no pack at all) — no count is prepended either.
    assert.equal(composePackName("Carrots", null, null, "3", "each", true), "Carrots");
    assert.equal(composePackName("black pepper", null, null, null, null, true), "black pepper");
  });

  it("a non-staple is byte-identical to the pre-BUG-171 output", () => {
    // Omitting the flag must degrade to the old behaviour exactly, so the ~110
    // assertions above this block are still testing what they were written for.
    // Spot-checked across all three rules, undefined and false both.
    const cases: Array<[string, string]> = [
      [composePackName("parmesan", "wedge", "1 wedge (6 oz)"), "1 wedge (6 oz) parmesan"],
      [composePackName("Lemon", "each", "2 lemons", "5", "each"), "5 lemons"],
      [composePackName("garlic", "head", "3 heads", "30", "clove"), "3 heads garlic"],
      [composePackName("saffron", null, null), "saffron"],
      [composePackName("Lemon", "each", "2 lemons", "5", "each", false), "5 lemons"],
      [composePackName("Lemon", "each", "2 lemons", "5", "each", undefined), "5 lemons"],
    ];
    for (const [actual, expected] of cases) assert.equal(actual, expected);
  });

  it("does NOT close BUG-147 — a non-staple container still under-orders", () => {
    // Stock, broth and milk are not staples. They keep rendering packs, and the
    // volume-need-against-container class survives; it merely stops being
    // visible on staples. Pinned so a future reader does not assume otherwise.
    //
    // ⚠️ THIS PINS A DEFECT, DELIBERATELY. A 6-cup need is 48 oz and does not
    // fit one 32 oz container, but the cup->oz relation is not available to
    // packsToCoverNeed for this pair, so the pack does not scale and the line
    // under-orders. That IS BUG-147. If this assertion ever goes red because
    // the output became "2 containers (32 oz) chicken stock", BUG-147 was
    // fixed elsewhere — update this expectation, do not restore the old one.
    assert.equal(
      composePackName("chicken stock", "container", "1 container (32 oz)", "6", "cup", false),
      "1 container (32 oz) chicken stock",
    );
  });
});

// ── WS9 BUG-216 — a pack sized in "count" is sized in "each" ────────────
//
// packSizeHint reads "1 package (12 count)" as {12, "count"}; the need says
// "each". Without the alias the two never match, packsToCoverNeed falls to its
// out-of-scope branch and returns null, and the stored pack prints verbatim:
// corn tortillas, need 36 each, "1 package" on the shelf when the answer is 3.
describe("BUG-216 — `count` is an alias for `each`", () => {
  it("36 each against a 12-count package orders 3 packages", () => {
    assert.equal(
      composePackName("corn tortillas", "package", "1 package (12 count)", "36", "each"),
      "3 packages (12 count) corn tortillas",
    );
  });

  it("one package still covers a need of 12 or less (no spurious scaling)", () => {
    assert.equal(
      composePackName("corn tortillas", "package", "1 package (12 count)", "12", "each"),
      "1 package (12 count) corn tortillas",
    );
  });

  it("the alias reads through normalizeUnitToken on the NEED side too", () => {
    // A need authored as "count" against an each-sized pack is the same
    // question asked from the other end.
    assert.equal(
      composePackName("corn tortillas", "package", "1 package (12 each)", "36", "count"),
      "3 packages (12 each) corn tortillas",
    );
  });
});

// WS9 BUG-117 — the editor's unit chips.
describe("GROCERY_UNIT_OPTIONS (grocery-row editor unit set)", () => {
  it("offers only ALREADY-CANONICAL unit tokens", () => {
    // A non-canonical entry ("lbs", "pounds", "count") would write a spelling
    // that composePackName's normalized comparisons read as a different unit
    // from the same thing typed as "lb"/"each" — two buckets for one unit,
    // which is the BUG-141 defect-2 failure wearing a different hat.
    for (const unit of GROCERY_UNIT_OPTIONS) {
      assert.equal(
        normalizeUnitToken(unit),
        unit,
        `"${unit}" is not canonical — normalizeUnitToken maps it to "${normalizeUnitToken(unit)}"`,
      );
    }
  });

  it("carries no duplicates", () => {
    assert.equal(
      new Set(GROCERY_UNIT_OPTIONS).size,
      GROCERY_UNIT_OPTIONS.length,
    );
  });

  it("includes the count unit a weight-packed catalog row needs (BUG-141)", () => {
    // Hans added "1 lb roma tomatoes" wanting one tomato, while the same list
    // already carried roma tomatoes in "each". The editor must be able to say
    // "each" or the two adds stay in different buckets.
    assert.ok(GROCERY_UNIT_OPTIONS.includes("each"));
  });
});

// WS9 BUG-117 follow-up — what the chip HIGHLIGHT depends on.
//
// The editor decides which chip is lit with `normalizeUnitToken(editUnit) === u`.
// That only works if the spellings the live data actually carries fold onto a
// label that is really in the strip. On device, before this, only "Each" ever
// lit up — "each" is the one unit whose stored spelling equals its chip label
// character-for-character, which is what proved the comparison was at fault
// rather than the data.
describe("unit-chip highlight folding (BUG-117 follow-up)", () => {
  it("folds the spellings live rows carry onto a chip that exists", () => {
    const typed = [
      "ounce",
      "ounces",
      "OZ",
      " oz ",
      "pounds",
      "lbs",
      "teaspoons",
      "tablespoon",
      "grams",
      "cups",
      "count",
      "cloves",
      "containers",
    ];
    for (const raw of typed) {
      const folded = normalizeUnitToken(raw);
      assert.ok(
        GROCERY_UNIT_OPTIONS.includes(folded),
        `"${raw}" folded to "${folded}", which is not a chip in the strip`,
      );
    }
  });

  it("folds 'ounce' to the 'oz' chip specifically (the reported row)", () => {
    assert.equal(normalizeUnitToken("ounce"), "oz");
  });

  it("still lights 'each' — the one that already worked must not regress", () => {
    assert.equal(normalizeUnitToken("each"), "each");
    // "count" is the pack-side spelling of the same unit (BUG-216).
    assert.equal(normalizeUnitToken("count"), "each");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WS9 BUG-147 — a need must relate to a pack whenever the DATA can relate them,
// not only when the two happen to be spelled identically.
//
// ⚠️ WHAT THE TICKET SAID AND WHAT THE CODE DID DISAGREED. The brief's two
// headline rows — crushed tomatoes 28 oz against "1 can (14.5 oz)", spinach
// 10 oz against "1 container (5 oz)" — ALREADY scaled correctly here (guard W8
// pinned that path). The server passes the stored pack through unscaled, so a
// measurement taken server-side sees an under-order that the client had already
// fixed at render. What was genuinely broken were three narrower things:
//
//   1. SAME SYSTEM, DIFFERENT SPELLING. A need in `lb` against a hint in `oz`
//      required an exact token match and fell through. (Old guard W7.)
//   2. A TWO-WORD UNIT. "(16 fl oz)" parsed as the unit "fl" and related to
//      nothing, so the row printed one container against any need.
//   3. VOLUME, ENTIRELY. There was a weight table and no volume table, so
//      quart/cup/litre packs never related to anything.
//
// The scope line is unchanged and load-bearing: weight↔weight and volume↔volume
// need no per-ingredient data, weight↔volume needs a DENSITY, and the client is
// never sent one. Guard V6 pins that it still refuses.
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-147: same-system needs relate to the pack; cross-system still refuses", () => {
  it("guard V1 — same system, different spelling: lb need vs an oz hint", () => {
    // The old W7 row, from the other side: 2.5 lb against a 12 oz package.
    assert.equal(
      composePackName("bacon", "package", "1 package (12 oz)", "2.5", "pound"),
      "4 packages (12 oz) bacon",
    );
  });

  it("guard V2 — a TWO-WORD unit parses: '(16 fl oz)' is oz, not 'fl'", () => {
    assert.equal(
      composePackName("heavy cream", "container", "1 container (16 fl oz)", "24", "oz"),
      "2 containers (16 fl oz) heavy cream",
    );
    // ⚠️ and the trailing "each" form must not be swallowed as the second word.
    assert.equal(
      composePackName("broth", "can", "1 can (14.5 oz each)", "28", "oz"),
      "2 cans (14.5 oz each) broth",
    );
  });

  it("guard V3 — volume↔volume through the hint: cups against a quart bottle", () => {
    // 6 cups = 1419 ml against 946 ml → 2. A quart is four cups for stock and
    // for milk alike, so this needs no per-ingredient data.
    assert.equal(
      composePackName("milk", "bottle", "1 bottle (1 quart)", "6", "cup"),
      "2 bottles (1 quart) milk",
    );
    // BOUNDARY, and it is the one that matters: under one pack stays one pack.
    assert.equal(
      composePackName("milk", "bottle", "1 bottle (1 quart)", "3", "cup"),
      "1 bottle (1 quart) milk",
    );
  });

  it("guard V4 — the PACK UNIT itself is volumetric", () => {
    assert.equal(
      composePackName("buttermilk", "quart", "1 quart", "5", "cup"),
      "2 quarts buttermilk",
    );
  });

  it("guard V5 — the measurement leads the display: '1 lb block'", () => {
    // purchaseUnit is "block"; the weight is in the display's LEADING token,
    // which is the precedence the server's packMagnitude already reasons about.
    assert.equal(
      composePackName("cotija", "block", "1 lb block", "20", "oz"),
      "2 lb block cotija",
    );
    // Below one pack it must not scale.
    assert.equal(
      composePackName("cotija", "block", "1 lb block", "8", "oz"),
      "1 lb block cotija",
    );
  });

  it("guard V6 — SCOPE: weight against VOLUME still refuses (needs a density)", () => {
    // 8 oz is a weight, 500 ml is a volume. Relating them needs a per-ingredient
    // density the client is never sent. An absurd need proves it is refusing
    // rather than coincidentally landing on one pack.
    assert.equal(
      composePackName("olive oil", "bottle", "1 bottle (500 ml)", "8", "oz"),
      "1 bottle (500 ml) olive oil",
    );
    assert.equal(
      composePackName("olive oil", "bottle", "1 bottle (500 ml)", "400", "oz"),
      "1 bottle (500 ml) olive oil",
    );
  });

  it("guard V7 — SCOPE: a pack that states NO size still cannot be related", () => {
    // "1 can" with no parenthetical and no measured leading token. Nothing in
    // the row says how much a can holds, and nothing here invents it.
    assert.equal(
      composePackName("crushed tomatoes", "can", "1 can", "28", "oz"),
      "1 can crushed tomatoes",
    );
  });

  it("guard V8 — the count path is untouched: 'count' still folds to 'each'", () => {
    // The DISPLAY is echoed verbatim — only its leading number is rewritten.
    // It is the UNIT that folds (count → each), which is how a pack stating
    // "12 count" meets a need stated in "each" (BUG-216).
    assert.equal(
      composePackName("corn tortillas", "package", "1 package (12 count)", "36", "each"),
      "3 packages (12 count) corn tortillas",
    );
    // And the same row with the pack authored as "each" keeps that spelling.
    assert.equal(
      composePackName("corn tortillas", "package", "1 package (12 each)", "36", "count"),
      "3 packages (12 each) corn tortillas",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WS9 BUG-240 — the USER-SET purchase overrides the derived pack.
//
// Hans, Sept 10: "users shouldn't need to or have a reason to edit the needed
// quantities or units… just the purchase name and quantity. and it's ok to
// have a disagreement in the UI between the need and the purchase."
//
// So an overridden row is NOT a derivation: BUG-147's scaling is bypassed and
// the user's string renders verbatim. The need parenthetical is untouched —
// it is rendered by the caller as its own sibling and stays read-only.
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-240: purchase override bypasses derivation", () => {
  it("guard (a) — a quantity override beats BUG-147's scaling", () => {
    // The DERIVED answer for a 10 oz need against a 5 oz container is 2.
    assert.equal(
      composePackName("fresh baby spinach", "container", "1 container (5 oz)", "10", "oz"),
      "2 containers (5 oz) fresh baby spinach",
    );
    // The user says one. The app does not argue, and does not re-derive.
    assert.equal(
      composePackName(
        "fresh baby spinach", "container", "1 container (5 oz)", "10", "oz",
        false, { quantity: 1 },
      ),
      "1 container (5 oz) fresh baby spinach",
    );
  });

  it("guard (b) — a label override renders VERBATIM: no plural, no scaling", () => {
    assert.equal(
      composePackName(
        "green onions", "bunch", "1 bunch", "4", "bunch",
        false, { display: "big bunch" },
      ),
      "4 big bunch green onions",
    );
    // Explicitly NOT pluralised to "big bunches" and NOT rescaled.
    assert.notEqual(
      composePackName(
        "green onions", "bunch", "1 bunch", "4", "bunch",
        false, { display: "big bunch" },
      ),
      "4 big bunches green onions",
    );
    // A LABEL-only override keeps the quantity that was ON SCREEN (the scaled
    // one), not the stored "1" — the user changed the word, not the count.
    assert.equal(
      composePackName(
        "crushed tomatoes", "can", "1 can (14.5 oz)", "28", "oz",
        false, { display: "tins" },
      ),
      "2 tins crushed tomatoes",
    );
  });

  it("guard (c) — NO override: byte-identical to the derived path today", () => {
    // The fifteen BUG-147 shapes, as literal expected strings so a change to
    // the derived path is caught here rather than passing by self-comparison.
    const shapes: [string, string, string, string, string, string][] = [
      ["black beans", "can", "1 can (15 oz)", "15", "oz", "1 can (15 oz) black beans"],
      ["black beans", "can", "2 cans (15 oz)", "15", "oz", "2 cans (15 oz) black beans"],
      ["crushed tomatoes", "can", "1 can (14.5 oz)", "28", "oz", "2 cans (14.5 oz) crushed tomatoes"],
      ["fresh baby spinach", "container", "1 container (5 oz)", "10", "oz", "2 containers (5 oz) fresh baby spinach"],
      ["chicken stock", "carton", "1 carton (32 oz)", "48", "oz", "2 cartons (32 oz) chicken stock"],
      ["milk", "bottle", "1 bottle (1 quart)", "3", "cup", "1 bottle (1 quart) milk"],
      ["milk", "bottle", "1 bottle (1 quart)", "6", "cup", "2 bottles (1 quart) milk"],
      ["cotija", "block", "1 lb block", "20", "oz", "2 lb block cotija"],
      ["cotija", "block", "1 lb block", "8", "oz", "1 lb block cotija"],
      ["crushed tomatoes", "can", "1 can", "28", "oz", "1 can crushed tomatoes"],
      ["heavy cream", "container", "1 container (16 fl oz)", "24", "oz", "2 containers (16 fl oz) heavy cream"],
      ["bacon", "package", "1 package (12 oz)", "2", "pound", "3 packages (12 oz) bacon"],
      ["buttermilk", "quart", "1 quart", "5", "cup", "2 quarts buttermilk"],
      ["olive oil", "bottle", "1 bottle (500 ml)", "8", "oz", "1 bottle (500 ml) olive oil"],
      ["corn tortillas", "package", "1 package (12 count)", "36", "each", "3 packages (12 count) corn tortillas"],
    ];
    for (const [n, pu, pd, amt, nu, expected] of shapes) {
      assert.equal(composePackName(n, pu, pd, amt, nu), expected, `${pd} / ${amt} ${nu}`);
      // An EMPTY override object must also change nothing — the branch is
      // gated on a real value, not on the argument being present.
      assert.equal(
        composePackName(n, pu, pd, amt, nu, false, {}),
        expected,
        `${pd} / ${amt} ${nu} (empty override)`,
      );
      assert.equal(
        composePackName(n, pu, pd, amt, nu, false, { quantity: null, display: null }),
        expected,
        `${pd} / ${amt} ${nu} (cleared override)`,
      );
    }
  });

  it("guard (d) — a pantry staple ignores both overrides: name only (BUG-171)", () => {
    assert.equal(
      composePackName(
        "Kosher salt", "container", "1 container (26 oz)", "11", "teaspoon",
        true, { quantity: 4, display: "giant box" },
      ),
      "Kosher salt",
    );
  });
});

// WS9 BUG-240 follow-up — a quantity-only override still has to READ right.
//
// The first cut bypassed "every BUG-147 scaling step", and scalePackDisplay
// does the number rewrite and the plural in ONE operation — so bypassing it
// bypassed grammar too and rendered "3 container (5 oz)". Ruled Sept 10:
// grammar is not scaling. The derived label agrees with the override count;
// the USER'S label is never touched.
describe("BUG-240: a quantity-only override keeps the label's plural", () => {
  it("guard (e) — the derived label agrees with the override count", () => {
    // Stored singular, overridden UP.
    assert.equal(
      composePackName(
        "fresh baby spinach", "container", "1 container (5 oz)", "10", "oz",
        false, { quantity: 3 },
      ),
      "3 containers (5 oz) fresh baby spinach",
    );
    // Stored PLURAL, overridden DOWN to one — the inverse direction, which the
    // derived path can never reach (scalePackDisplay returns early at packs<=1).
    assert.equal(
      composePackName(
        "fresh baby spinach", "container", "2 containers (5 oz)", "10", "oz",
        false, { quantity: 1 },
      ),
      "1 container (5 oz) fresh baby spinach",
    );
  });

  it("guard (f) — only the HEAD noun moves; the parenthetical is untouched", () => {
    assert.equal(
      composePackName(
        "crushed tomatoes", "can", "1 can (14.5 oz)", "28", "oz",
        false, { quantity: 4 },
      ),
      "4 cans (14.5 oz) crushed tomatoes",
    );
    // A MEASURE unit head passes through in both directions — "3 lbs block"
    // would be worse than the bug (the same rule pluralizeNeedUnit enforces).
    assert.equal(
      composePackName("cotija", "block", "1 lb block", "20", "oz", false, { quantity: 3 }),
      "3 lb block cotija",
    );
    assert.equal(
      composePackName("cotija", "block", "1 lb block", "20", "oz", false, { quantity: 1 }),
      "1 lb block cotija",
    );
  });

  it("guard (g) — a USER label is never pluralised, at any count", () => {
    assert.equal(
      composePackName(
        "green onions", "bunch", "1 bunch", "4", "bunch",
        false, { quantity: 3, display: "big bunch" },
      ),
      "3 big bunch green onions",
    );
    assert.notEqual(
      composePackName(
        "green onions", "bunch", "1 bunch", "4", "bunch",
        false, { quantity: 3, display: "big bunch" },
      ),
      "3 big bunches green onions",
    );
  });
});

// WS9 BUG-240 follow-up — a quantity-only edit changes the COUNT and the
// PLURAL and nothing else.
//
// Hans, Sept 10, on device: "I changed 1 White Onion (1/2 each) to 2 in the
// quantity, and it changed the row to 2 medium white onion white onion …
// avocados … went from 2 avocados to 3 avocados ripe avocado."
//
// Two causes, both fixed, and both pinned:
//   1. The composer's override branch built EVERY row as residue + name +
//      elide (Rule 2's shape). A counted row whose residue does not name the
//      item takes Rule 1, which prints the NAME and never the residue — so
//      the derived and the overridden title disagreed on shape, not just on
//      number. Ruled: the override title at a count EQUALS the derived title
//      at that count.
//   2. The editor sent every field on every commit, so the seeded label was
//      persisted as purchaseDisplayOverride and rendered verbatim (guard g).
//      purchaseEditorPatch sends only what differs from the seed.
//
// Fixtures are the live rows from Hans's lists (probe, Sept 10): name /
// purchaseUnit / purchaseDisplay / need / needUnit as stored.
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-240: a quantity-only override equals the derived title at that count", () => {
  // [name, purchaseUnit, purchaseDisplay, needUnit, liveNeed, [title at 1, at 2, at 3]]
  //
  // ⚠️ THE `White onion` LITERALS MOVED IN [grocery] C (BUG-160), AND THE GUARD
  // DID NOT. Widening residueNamesItem to word-boundary containment made
  // "medium white onion" name the item, so this row left Rule 1's NAME branch
  // for its RESIDUE branch: "1 White onion" is now "1 medium white onion".
  // Ruled accepted 2026-09-29 — that is the pack you reach for on the shelf.
  //
  // What this guard actually asserts is untouched and is the reason the row
  // stays here: the OVERRIDE title at a count equals the DERIVED title at that
  // count. Both sides moved together, which is the property. The two device
  // strings below are still gone — "2 medium white onions" is not
  // "2 medium white onion White onion".
  const ROWS: [string, string, string, string, number, [string, string, string]][] = [
    // Rule 1, residue NAMES the item by containment (BUG-160) → the residue, counted.
    ["White onion", "each", "1 medium white onion", "each", 0.5, ["1 medium white onion", "2 medium white onions", "3 medium white onions"]],
    // Rule 1, residue does NOT name the item → the NAME, counted.
    ["ripe avocado", "each", "3 avocados", "each", 2, ["1 ripe avocado", "2 ripe avocados", "3 ripe avocados"]],
    // Rule 1, residue names the item → Root D at 1, the residue pluralised above.
    ["Lemon", "each", "2 lemons", "each", 1.5, ["1 Lemon", "2 lemons", "3 lemons"]],
    // Rule 2, a real container → the pack label agrees with the count.
    ["bananas", "bunch", "1 bunch", "bunch", 1, ["1 bunch bananas", "2 bunches bananas", "3 bunches bananas"]],
    ["Fresh thyme", "bunch", "1 bunch", "tablespoon", 1, ["1 bunch Fresh thyme", "2 bunches Fresh thyme", "3 bunches Fresh thyme"]],
  ];

  it("guard (h) — the DERIVED title at counts 1–3 (the literal expectations)", () => {
    // Rule 1 rows reach a count through the need itself.
    for (const [n, pu, pd, nu, , want] of ROWS.filter(([, pu]) => pu === "each")) {
      for (const q of [1, 2, 3]) {
        assert.equal(composePackName(n, pu, pd, q, nu), want[q - 1], `${n} derived at ${q}`);
      }
    }
    // Rule 2 rows reach a count through the need only where the units relate
    // (bananas: bunch/bunch). Thyme's need is a tablespoon against a bunch and
    // stays at one pack whatever the need — its "derived at 2" is the scaled
    // shape scalePackDisplay would give, which bananas demonstrates.
    assert.equal(composePackName("bananas", "bunch", "1 bunch", 1, "bunch"), "1 bunch bananas");
    assert.equal(composePackName("bananas", "bunch", "1 bunch", 2, "bunch"), "2 bunches bananas");
    assert.equal(composePackName("bananas", "bunch", "1 bunch", 3, "bunch"), "3 bunches bananas");
    assert.equal(composePackName("Fresh thyme", "bunch", "1 bunch", 1, "tablespoon"), "1 bunch Fresh thyme");
    assert.equal(composePackName("Fresh thyme", "bunch", "1 bunch", 3, "tablespoon"), "1 bunch Fresh thyme");
  });

  it("guard (i) — a quantity-only override at 1–3 is that same literal, on every row", () => {
    for (const [n, pu, pd, nu, liveNeed, want] of ROWS) {
      // The need is what the live row carries (½ onion, 2 avocados, 1½ lemons,
      // 1 bunch, 1 tablespoon) — the override count is what moves.
      for (const q of [1, 2, 3]) {
        assert.equal(
          composePackName(n, pu, pd, liveNeed, nu, false, { quantity: q }),
          want[q - 1],
          `${n} quantity-only override at ${q}`,
        );
      }
    }
    // The two literal strings from the device, gone.
    assert.notEqual(
      composePackName("White onion", "each", "1 medium white onion", 0.5, "each", false, { quantity: 2 }),
      "2 medium white onion White onion",
    );
    assert.notEqual(
      composePackName("ripe avocado", "each", "3 avocados", 2, "each", false, { quantity: 3 }),
      "3 avocados ripe avocado",
    );
  });

  it("guard (j) — no pack: a count and a measure keep their derived shape", () => {
    // Rule 3, count: the NAME counted, same as derived.
    assert.equal(composePackName("Carrots", "each", null, 2, "each"), "2 Carrots");
    assert.equal(composePackName("Carrots", "each", null, 2, "each", false, { quantity: 1 }), "1 Carrot");
    assert.equal(composePackName("Carrots", "each", null, 2, "each", false, { quantity: 3 }), "3 Carrots");
    // Rule 3, measure: the need's unit rides along, pluralised — not "3 flour".
    assert.equal(composePackName("flour", null, null, 2, "cup"), "2 cup flour");
    assert.equal(composePackName("flour", null, null, 2, "cup", false, { quantity: 3 }), "3 cup flour");
    assert.equal(composePackName("bread", null, null, 1, "loaf"), "1 loaf bread");
    assert.equal(composePackName("bread", null, null, 1, "loaf", false, { quantity: 2 }), "2 loaves bread");
  });

  it("guard (k) — a USER label still renders verbatim on these rows (guard g holds)", () => {
    assert.equal(
      composePackName("White onion", "each", "1 medium white onion", 0.5, "each", false, { quantity: 2, display: "large onions" }),
      "2 large onions White onion",
    );
    assert.equal(
      composePackName("Lemon", "each", "2 lemons", 1.5, "each", false, { quantity: 1, display: "lemons" }),
      "1 lemons",
    );
  });
});

describe("BUG-240: purchaseEditorPatch sends only what differs from the seed", () => {
  // The onion row's seed, as purchaseEditorSeed hands it to the editor.
  const seedOf = () => {
    const s = purchaseEditorSeed("each", "1 medium white onion", 0.5, "each", {
      quantity: null,
      display: null,
    });
    return { quantity: s.quantity, label: s.label, name: "White onion" };
  };

  it("guard (l) — the onion seed is what the device showed", () => {
    assert.deepEqual(seedOf(), { quantity: "1", label: "medium white onion", name: "White onion" });
  });

  it("guard (m) — a quantity-only edit sends the quantity and NOTHING else", () => {
    const seed = seedOf();
    const patch = purchaseEditorPatch(seed, { ...seed, quantity: "2" });
    assert.deepEqual(patch, { purchaseQuantity: 2 });
    // The literal defect: the untouched label must NOT be on the wire.
    assert.equal("purchaseDisplay" in patch, false);
    assert.equal("displayName" in patch, false);
  });

  it("guard (n) — unchanged → key absent; emptied → null; changed → the value", () => {
    const seed = seedOf();
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed }), {});
    // Whitespace is not a change.
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, label: "  medium white onion " }), {});
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, label: "" }), { purchaseDisplay: null });
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, label: "large onions" }), { purchaseDisplay: "large onions" });
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, quantity: "" }), { purchaseQuantity: null });
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, quantity: "1 1/2" }), { purchaseQuantity: 1.5 });
    // A changed quantity that is not a positive number clears, as before.
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, quantity: "abc" }), { purchaseQuantity: null });
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, quantity: "0" }), { purchaseQuantity: null });
  });

  it("guard (o) — the name: changed → displayName; emptied → absent, never null", () => {
    const seed = seedOf();
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, name: "Sweet onion" }), { displayName: "Sweet onion" });
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, name: "" }), {});
    assert.deepEqual(purchaseEditorPatch(seed, { ...seed, name: "   " }), {});
    // All three at once.
    assert.deepEqual(
      purchaseEditorPatch(seed, { quantity: "3", label: "", name: "Sweet onion" }),
      { purchaseQuantity: 3, purchaseDisplay: null, displayName: "Sweet onion" },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// [grocery] Block C — THE PACK COUNT (BUG-332 / D-WS9-286) AND THE SHOPPER LINE
// (BUG-160). Every literal below is a row measured on the B3 after-state corpus
// (artifacts/api-server/scripts/grocery-census/out/b3__*__r1.json, 20 plans,
// 1,021 rows), not an invented example.
// ═════════════════════════════════════════════════════════════════════════════

describe("BUG-332 W1 — a ranged pack size reads as its LOWER bound (R2)", () => {
  it("the two census under-orders are gone", () => {
    // "1 bag (5-6 oz) kettle-cooked potato chips", need 8 ounce. Read as 6 it
    // is one bag and the shopper is 2 oz short; read as 5 it is two.
    assert.equal(
      composePackName("kettle-cooked potato chips", "bag", "1 bag (5-6 oz)", 8, "ounce"),
      "2 bags (5-6 oz) kettle-cooked potato chips",
    );
    // "1 package (10 ct) flour tortillas", need 12 each — W2 supplies the unit
    // fold, W1 is not involved; pinned together because they are the two rows
    // the census called hidden under-orders.
    assert.equal(
      composePackName("flour tortillas", "package", "1 package (10 ct)", 12, "each"),
      "2 packages (10 ct) flour tortillas",
    );
  });

  it("a range that IS covered by one pack stays at one", () => {
    // "1 box (12-13 oz) dried pappardelle pasta", need 12 ounce → exactly one.
    assert.equal(
      composePackName("dried pappardelle pasta", "box", "1 box (12-13 oz)", 12, "ounce"),
      "1 box (12-13 oz) dried pappardelle pasta",
    );
  });

  it("every dash spelling the corpus uses, plus `to`", () => {
    for (const dash of ["-", "–", "—", " to "]) {
      assert.equal(
        composePackName("chips", "bag", `1 bag (5${dash}6 oz)`, 8, "ounce"),
        `2 bags (5${dash}6 oz) chips`,
        dash,
      );
    }
  });

  it("an unranged size is untouched — the regex did not get greedier", () => {
    assert.equal(
      composePackName("chicken stock", "can", "1 can (14.5 oz)", 14.5, "ounce"),
      "1 can (14.5 oz) chicken stock",
    );
    assert.equal(
      composePackName("chicken stock", "can", "1 can (14.5 oz)", 20, "ounce"),
      "2 cans (14.5 oz) chicken stock",
    );
  });
});

describe("BUG-332 W2 — `ct` is how a pack spells a count", () => {
  it("ct / cnt / ea all normalize to each, beside BUG-216 `count`", () => {
    for (const tok of ["ct", "cnt", "ea", "count"]) {
      assert.equal(normalizeUnitToken(tok), "each", tok);
    }
  });

  it("the two census rows resolve", () => {
    assert.equal(
      composePackName("taco shells", "box", "1 box (12 ct)", 12, "each"),
      "1 box (12 ct) taco shells",
    );
    assert.equal(
      composePackName("flour tortillas", "package", "1 package (10 ct)", 8, "each"),
      "1 package (10 ct) flour tortillas",
    );
  });
});

describe("🔴 BUG-332 W3 — a WEIGHT parenthetical against a VOLUME need stays unrelatable", () => {
  // REFUSED, ruled 2026-09-29, and this is the pin. `oz` in a pack
  // parenthetical is ambiguous and the string does not say which it is. Reading
  // it as FLUID oz relates 305 corpus rows and gets nine of them badly wrong —
  // "1 bag (5 oz) mixed salad greens" against a 4-cup need becomes SEVEN BAGS.
  // It errs both ways (dense foods under-order), so R2 round-up does not rescue
  // it. The server pack count is the answer instead; see the block below.
  const WEIGHT_PACK_VOLUME_NEED: [string, string, string, number, string][] = [
    ["mixed salad greens", "bag", "1 bag (5 oz)", 4, "cup"],
    ["shredded iceberg lettuce", "bag", "1 bag (5 oz)", 2, "cup"],
    ["long-grain white rice", "container", "1 container (8.8 oz)", 4, "cup"],
    ["Parmesan", "wedge", "1 wedge (6 oz)", 1, "cup"],
    ["shredded mozzarella cheese", "bag", "1 bag (8 oz)", 2, "cup"],
    ["sour cream", "container", "1 container (16 oz)", 1.25, "cup"],
    ["smoked paprika", "container", "1 container (2.6 oz)", 1.5, "teaspoon"],
  ];

  it("the pack prints VERBATIM — one pack, whatever the volume need", () => {
    for (const [name, pu, pd, need, nu] of WEIGHT_PACK_VOLUME_NEED) {
      assert.equal(
        composePackName(name, pu, pd, need, nu),
        `${pd} ${name}`,
        `${name} @ ${need} ${nu}`,
      );
    }
  });

  it("and renderedPack declines, so Instacart falls to the server own precedence", () => {
    for (const [, pu, pd, need, nu] of WEIGHT_PACK_VOLUME_NEED) {
      assert.equal(renderedPack(pd, need, nu, pu), null, `${pd} @ ${need} ${nu}`);
    }
  });

  it("volume↔volume still relates — the refusal is about `oz`, not about volume", () => {
    // BUG-147 row, untouched: a quart bottle against a need in cups.
    assert.equal(
      composePackName("buttermilk", "bottle", "1 bottle (1 quart)", 6, "cup"),
      "2 bottles (1 quart) buttermilk",
    );
  });

  it("weight↔weight still relates — BUG-143 row, untouched", () => {
    assert.equal(
      composePackName("Cotija", "block", "1 lb block", 20, "oz"),
      "2 lb block Cotija",
    );
  });
});

describe("🔴 D-WS9-286 — the SERVER pack count wins, and the parser does not run", () => {
  // THE GUARD. `purchaseDisplay` leading number means the SIZE of one pack on
  // "1.5 lb pack" and the COUNT of packs on "4 can (14.5 oz)" — the server
  // writes the second through scalePurchaseForSubUnit. The client cannot tell
  // them apart, so when the server sends its own count the client must use it
  // and never parse.

  it("a server count is used verbatim, even where the parser would disagree", () => {
    const parsed = renderedPack("1 lb pack", 2, "lb", "lb");
    assert.deepEqual(parsed, { packCount: 2 });
    const served = renderedPack("1 lb pack", 2, "lb", "lb", false, undefined, 5);
    assert.deepEqual(served, { packCount: 5, fromServer: true });
  });

  it("🔴 THE PARSE DOES NOT RUN: a display the parser CANNOT read still yields the server count", () => {
    // No leading number at all → packLeadingQuantity is null → the parsing path
    // returns null before it ever reaches packsToCoverNeed. A server count must
    // survive that, which it can only do by being consulted FIRST.
    assert.equal(renderedPack("a family pack", 3, "cup", "bag"), null);
    assert.deepEqual(renderedPack("a family pack", 3, "cup", "bag", false, undefined, 2), {
      packCount: 2,
      fromServer: true,
    });
    // Same for the W3 class the parser refuses outright.
    assert.equal(renderedPack("1 bag (5 oz)", 4, "cup", "bag"), null);
    assert.deepEqual(renderedPack("1 bag (5 oz)", 4, "cup", "bag", false, undefined, 1), {
      packCount: 1,
      packSizeText: "(5 oz)",
      fromServer: true,
    });
  });

  it("null / absent / zero fall back to the parser — all three mean you decide", () => {
    for (const v of [null, undefined, 0]) {
      assert.deepEqual(
        renderedPack("1 lb pack", 2, "lb", "lb", false, undefined, v),
        { packCount: 2 },
        String(v),
      );
    }
  });

  it("the staple and override gates still come FIRST — the server never saw them", () => {
    // BUG-171: a pantry staple renders no pack at all.
    assert.equal(
      renderedPack("1 container (26 oz)", 11, "tsp", "container", true, undefined, 3),
      null,
    );
    // BUG-240: a quantity override is the user stated buy, not a derivation.
    assert.equal(renderedPack("1 lb pack", 2, "lb", "lb", false, { quantity: 4 }, 3), null);
  });

  it("packSizeText still comes off the display either way", () => {
    assert.deepEqual(renderedPack("4 can (14.5 oz)", 6, "cup", "can", false, undefined, 4), {
      packCount: 4,
      packSizeText: "(14.5 oz)",
      fromServer: true,
    });
  });
});

describe("BUG-160 — the shopper line: the residue may CONTAIN the name", () => {
  // (A) THE DUPLICATING ROWS on the B3 after-state, as literals.
  //
  // ── 🔴 [grocery] F (F2) — FIVE OF THESE SEVEN NOW PRINT THE NAME ───────────
  //
  // Hans's device pass read "2 lb (~3–4 tomatillos)" with no food name on the
  // line at all. BUG-160's rule is right and this is the case it did not
  // anticipate: the containment that fired the elide was inside a
  // PARENTHETICAL, and a parenthetical is a size hint, not a name. The elide
  // now tests the residue's HEAD, and when the hint was the thing naming the
  // food it comes off the display — so the line gains a name and does not say
  // it twice.
  //
  // The last two rows are UNCHANGED and that is the control: "3 medium white
  // onion" and "1 rotisserie chicken" elide on their HEAD, exactly as BUG-160
  // intended, and nothing about them was a parenthetical.
  it("(A) the residue's HEAD is the fuller phrase → elide; a parenthetical never elides", () => {
    const A: [string, string, string, number, string, string][] = [
      ["scallions", "bunch", "1 bunch (~6-8 scallions)", 3, "each", "1 bunch scallions"],
      ["scallions", "bunch", "1 bunch (~6-8 scallions)", 2, "each", "1 bunch scallions"],
      ["radishes", "bunch", "1 bunch (~6-8 radishes)", 6, "each", "1 bunch radishes"],
      ["tomatillo", "lb", "2 lb (~3–4 tomatillos)", 1.25, "pound", "2 lb tomatillo"],
      ["tomatillos", "lb", "1 lb (~4-5 tomatillos)", 0.75, "pound", "1 lb tomatillos"],
      // ── the control: these two elide on the HEAD ─────────────────────────
      // [grocery] F Part E (E4.2) — the onion's residue is now AGREED with the
      // count. The elide is unchanged and is still the thing being tested; what
      // moved is the plural, which nothing was applying. See the E4.2 block
      // below for why the weight rows beside it must NOT move.
      ["white onion", "each", "3 medium white onion", 2.25, "cup", "3 medium white onions"],
      // The census third shape: the residue equals the name HEAD once the prep
      // clause comes off, so the pre-existing exact test handles it.
      ["rotisserie chicken, meat shredded", "each", "1 rotisserie chicken", 3, "cup", "1 rotisserie chicken"],
    ];
    for (const [name, pu, pd, need, nu, want] of A) {
      assert.equal(composePackName(name, pu, pd, need, nu), want, `${name} @ ${need} ${nu}`);
    }
  });

  it("🔴 F2 — a buy line ALWAYS names the food", () => {
    // The property, stated as a property rather than as seven literals: for
    // every row above, some word of the ingredient name survives onto the line.
    const rows: [string, string, string, number, string][] = [
      ["scallions", "bunch", "1 bunch (~6-8 scallions)", 3, "each"],
      ["radishes", "bunch", "1 bunch (~6-8 radishes)", 6, "each"],
      ["tomatillo", "lb", "2 lb (~3–4 tomatillos)", 1.25, "pound"],
      ["celery stalks", "bunch", "1 bunch (~8-10 stalks)", 3, "each"],
      ["brioche burger buns", "package", "1 package (4 buns)", 4, "each"],
      ["sliced scallions", "bunch", "1 bunch (~6 scallions)", 2, "each"],
    ];
    for (const [name, pu, pd, need, nu] of rows) {
      const line = composePackName(name, pu, pd, need, nu).toLowerCase();
      const head = name.toLowerCase().split(" ").pop()!.replace(/e?s$/, "");
      assert.ok(line.includes(head), `"${name}" → "${line}" names no food`);
    }
  });

  it("F2 — a hint that names something ELSE is left exactly as authored", () => {
    // "(4 buns)" is the pack's own head noun and "(14.5 oz)" is a size. Neither
    // was ever the thing naming the food, so neither is touched — the narrow
    // scope is what keeps this from editing the catalog's copy at render.
    assert.equal(
      composePackName("unsalted butter", "lb", "1 lb pack (4 sticks)", "7", "tablespoon"),
      "1 lb pack (4 sticks) unsalted butter",
    );
    assert.equal(
      composePackName("chipotle peppers in adobo sauce", "can", "1 can (7 oz)", "3", "each"),
      "1 can (7 oz) chipotle peppers in adobo sauce",
    );
    assert.equal(
      composePackName("celery", "bunch", "1 bunch (~6 stalks)", "3", "each"),
      "1 bunch (~6 stalks) celery",
    );
  });

  // (B) THE ROWS WHERE THE NAME CONTAINS THE RESIDUE. A symmetric rule would
  // elide these and LOSE the distinguishing word. One direction only.
  it("(B) the name is the fuller phrase → do NOT elide, the modifier survives", () => {
    // The four live rows, as the corpus renders them. All four take Rule 1's
    // NAME branch, which is what keeps the modifier — a symmetric containment
    // rule would have flipped them to the residue and printed "1 loaf",
    // "1 boule", "1 baguette", "3 peppers".
    const B: [string, string, string, number, string, string][] = [
      ["italian bread loaf", "each", "1 loaf", 1, "each", "1 italian bread loaf"],
      ["sourdough boule", "each", "1 boule", 1, "each", "1 sourdough boule"],
      ["Italian baguette", "each", "1 baguette", 1, "each", "1 Italian baguette"],
      ["bell peppers", "each", "3 peppers", 3, "each", "3 bell peppers"],
    ];
    for (const [name, pu, pd, need, nu, want] of B) {
      assert.equal(composePackName(name, pu, pd, need, nu), want, name);
      assert.ok(
        want.toLowerCase().includes(name.split(" ")[0].toLowerCase()),
        `${name}: the distinguishing word must survive`,
      );
    }
  });

  it("(B2) and on RULE 2, where the elide is the only thing deciding, it declines", () => {
    // Rule 1 prints the name whatever residueNamesItem says, so the rows above
    // pass for a second reason as well as the right one. This is the shape
    // where the predicate ALONE decides: a container pack, a measured need. The
    // name contains the residue, so the residue must NOT swallow it.
    assert.equal(
      composePackName("italian bread loaf", "loaf", "1 loaf", 2, "cup"),
      "1 loaf italian bread loaf",
    );
    // And the mirror: the residue contains the name → elide, one printing only.
    // E4.2 — one printing, now agreed with the count.
    assert.equal(
      composePackName("white onion", "each", "3 medium white onion", 2.25, "cup"),
      "3 medium white onions",
    );
  });

  // (C) THE RULE-1 ROWS the widening moves. Ruled ACCEPTED — that is the pack
  // you reach for on the shelf, and R7 wants a line a store search understands.
  // Two of Part A fifteen are absorbed by Root D and do not move; pinned too.
  it("(C) Rule 1 now prints the residue where it names the item — ruled accepted", () => {
    const C: [string, string, string, number, string, string][] = [
      ["white onion", "each", "1 medium white onion", 0.5, "each", "1 medium white onion"],
      ["white onion", "each", "1 medium white onion", 0.25, "each", "1 medium white onion"],
      ["white onion", "each", "3 medium white onion", 2.25, "each", "3 medium white onions"],
      ["red onion", "each", "1 medium red onion", 0.25, "each", "1 medium red onion"],
      ["red onion", "each", "2 medium red onion", 1.25, "each", "2 medium red onions"],
      ["red onion", "each", "3 medium red onion", 3, "each", "3 medium red onions"],
      ["orange", "each", "1 medium orange", 5, "each", "5 medium oranges"],
      ["rotisserie chicken", "each", "1 whole rotisserie chicken (~2 lb)", 1, "each", "1 whole rotisserie chicken (~2 lb)"],
    ];
    for (const [name, pu, pd, need, nu, want] of C) {
      assert.equal(composePackName(name, pu, pd, need, nu), want, `${name} @ ${need}`);
    }
    // Root D absorbs these two: the residue last word is already plural, so at
    // a count of 1 the NAME is preferred and the line does not move.
    assert.equal(
      composePackName("beefsteak tomato", "each", "2 large beefsteak tomatoes", 0.5, "each"),
      "1 beefsteak tomato",
    );
    assert.equal(
      composePackName("beefsteak tomato", "each", "2 large beefsteak tomatoes", 1, "each"),
      "1 beefsteak tomato",
    );
  });

  // (D) 🔴 THE RIDER. Caught by the corpus diff, not by reasoning.
  it("🔴 (D) a variety rider is NEVER elided — H3 words must not be dropped", () => {
    // The residue "green bell peppers" CONTAINS the name head "bell peppers",
    // so stripping the comma clause first made this elide and printed the
    // residue INSTEAD of the name — dropping "at least 2 green" off a list that
    // carried it. That is the loss B3 Part E ruling 8 forbids.
    assert.equal(
      composePackName("bell peppers, at least 2 green", "each", "2 green bell peppers", 6, "each"),
      "6 bell peppers, at least 2 green",
    );
    assert.equal(
      composePackName("yellow onions, at least 1 large", "each", "2 large yellow onion", 1.5, "each"),
      "2 yellow onions, at least 1 large",
    );
    // The broth row from B3 Part E ruling 8, same shape on a container pack.
    assert.equal(
      composePackName("chicken broth, at least 1 low-sodium", "can", "4 can (14.5 oz)", 6, "cup"),
      "4 can (14.5 oz) chicken broth, at least 1 low-sodium",
    );
  });

  it("containment is WORD-BOUNDED — a shared prefix is not a match", () => {
    // "onion" must not name "onion powder", and "scallion" must not name
    // "scallion oil".
    assert.equal(
      composePackName("onion powder", "container", "1 container (2.6 oz)", 0.5, "teaspoon"),
      "1 container (2.6 oz) onion powder",
    );
    assert.equal(
      composePackName("scallion oil", "bottle", "1 bottle (8 oz)", 2, "tablespoon"),
      "1 bottle (8 oz) scallion oil",
    );
  });
});

// ── [grocery] F (F5.3) — a pack that states a BARE COUNT governs a plural ───
describe("F5.3 — '1 dozen egg' is not English", () => {
  it("🔴 the literal from the device pass (list 9c0a250e)", () => {
    // The catalog's displayName for that row is literally "egg". Rule 2 prints
    // "{display} {name}" verbatim, rightly — the count in front of a container
    // pack counts CONTAINERS. "dozen" is the exception: it names no
    // intermediate noun, so the number it states is a number of the food.
    assert.equal(composePackName("egg", "dozen", "1 dozen", "2", "each"), "1 dozen eggs");
  });

  it("an already-plural name is byte-identical (the other live egg row)", () => {
    assert.equal(
      composePackName("large eggs", "dozen", "1 dozen", "1", "each"),
      "1 dozen large eggs",
    );
  });

  it("'(12 count)' and '(10 ct)' are bare counts too", () => {
    assert.equal(
      composePackName("corn tortilla", "package", "1 package (12 count)", "12", "each"),
      "1 package (12 count) corn tortillas",
    );
    assert.equal(
      composePackName("flour tortilla", "package", "2 packages (10 ct)", "12", "each"),
      "2 packages (10 ct) flour tortillas",
    );
  });

  it("🔴 a count WITH A NOUN is excluded — this is the whole reason it is narrow", () => {
    // "(4 sticks)" counts sticks, not butters. Feeding 4 to the pluraliser
    // gives "4 unsalted butters"; the same trap waits in "(6 rolls)" on paper
    // towels and "(~6 stalks)" on celery.
    assert.equal(
      composePackName("unsalted butter", "lb", "1 lb pack (4 sticks)", "7", "tablespoon"),
      "1 lb pack (4 sticks) unsalted butter",
    );
    assert.equal(
      composePackName("Paper towel", "pack", "1 pack (6 rolls)", "1", "pack"),
      "1 pack (6 rolls) Paper towel",
    );
    assert.equal(
      composePackName("celery", "bunch", "1 bunch (~6 stalks)", "3", "each"),
      "1 bunch (~6 stalks) celery",
    );
  });

  it("a measured size is never a count", () => {
    assert.equal(
      composePackName("sour cream", "container", "1 container (16 oz)", "1.5", "cup"),
      "1 container (16 oz) sour cream",
    );
  });
});

// ── [grocery] F (F5.4) — the pack's own count takes a glyph ─────────────────
describe("F5.4 — the buy line uses glyphs, like every other number on it", () => {
  it("🔴 the literal from the device pass", () => {
    // Hans: "`0.5 lb pack ground pork` should read `½ lb`, using glyphs as
    // everywhere else." (This row also disappears under D-WS9-292 — the class
    // is what is pinned, and it is live on cheese, potatoes and provolone.)
    assert.equal(
      composePackName("ground pork", "lb", "0.5 lb pack", "0.5", "pound"),
      "½ lb pack ground pork",
    );
    assert.equal(
      composePackName("shredded cheddar cheese", "lb", "2.5 lb bag", "0.5", "cup"),
      "2½ lb bag shredded cheddar cheese",
    );
  });

  it("🔴 the glyph is render-only — the ARITHMETIC still reads the stored decimal", () => {
    // This is the ordering that matters. glyphPackDisplay runs LAST, on the
    // string about to be shown; packLeadingQuantity parses "1.5 lb pack" with a
    // regex a glyph would defeat. Glyphing earlier silently stops the scaling.
    // 3.5 lb against a 1.5 lb pack is still three packs = 4.5 lb.
    assert.equal(
      composePackName("chicken thighs", "lb", "1.5 lb pack", "3.5", "pound"),
      "4½ lb pack chicken thighs",
    );
    // …and renderedPack, which the Instacart order reads, is untouched.
    assert.deepEqual(
      renderedPack("1.5 lb pack", "3.5", "pound", "lb"),
      { packCount: 3 },
    );
  });

  it("a whole number is unchanged, and an off-ladder decimal is left alone", () => {
    assert.equal(
      composePackName("ground beef", "lb", "1 lb", "1", "pound"),
      "1 lb ground beef",
    );
    // formatNeedGlyph returns String(qty) off its ⅛ ladder, so this is lossless
    // rather than rounded: 1.7 is not a kitchen fraction and stays a decimal.
    assert.equal(
      composePackName("beef brisket", "lb", "1.7 lb pack", "1.7", "pound"),
      "1.7 lb pack beef brisket",
    );
  });

  it("only the LEADING number — a parenthetical size is authored prose", () => {
    // Rewriting "(14.5 oz)" or "(1 quart / 32 oz)" would be editing the
    // catalog's own copy at render time.
    assert.equal(
      composePackName("beef broth", "can", "1 can (14.5 oz)", "0.75", "cup"),
      "1 can (14.5 oz) beef broth",
    );
    assert.equal(
      composePackName("whole milk", "bottle", "1 bottle (1 quart / 32 oz)", "1.125", "cup"),
      "1 bottle (1 quart / 32 oz) whole milk",
    );
  });
});

// ── [grocery] F — a token that does not start with a letter is not a noun ────
describe("F — pluralizeIngredientName declines on punctuation", () => {
  it("🔴 the two live catalog names the corpus diff caught", () => {
    // Both are already plural and needed no change at all; the head-noun rule
    // looks at the LAST word of the head clause and the last word was a
    // parenthetical. F5.3 exposed it by routing Rule 2's names through here.
    assert.equal(
      composePackName("corn tortillas (6-inch)", "package", "1 package (12 count)", "12", "each"),
      "1 package (12 count) corn tortillas (6-inch)",
    );
    assert.equal(
      composePackName(
        "flour tortillas (large, 10-inch)",
        "package",
        "1 package (8 count)",
        "4",
        "each",
      ),
      "1 package (8 count) flour tortillas (large, 10-inch)",
    );
  });

  it("the helper itself declines, at every quantity", () => {
    assert.equal(pluralizeIngredientName("corn tortillas (6-inch)", 12), "corn tortillas (6-inch)");
    assert.equal(pluralizeIngredientName("rice (long-grain)", 3), "rice (long-grain)");
    // …and a real head noun still moves, so the guard is not a blanket refusal.
    assert.equal(pluralizeIngredientName("roma tomato", 3), "roma tomatoes");
  });
});

// ── [grocery] F Part E (E4.2) — an elided COUNT pack agrees with its count ──
describe("E4.2 — '3 medium white onion' is the rendered line, not the stored pack", () => {
  it("🔴 the literal from the device pass", () => {
    // The pack is "3 medium white onion" and the elide returns it verbatim, so
    // this is what a user reads. Rule 1 would have agreed it, but Rule 1 needs a
    // COUNT need and this row's need is 2¼ cup.
    assert.equal(
      composePackName("white onion", "each", "3 medium white onion", 2.25, "cup"),
      "3 medium white onions",
    );
  });

  it("🔴 a WEIGHT pack must NOT be agreed — D-WS9-292 renders through here", () => {
    // These three elide too: the residue "lb beef chuck roast" contains the
    // name. The leading number is a WEIGHT, not a count of roasts, and agreeing
    // it prints "2 lb beef chuck roasts". Measured on the corpus: 3 weight rows
    // would have been wrong against the 1 count row that was.
    assert.equal(
      composePackName("beef chuck roast", "lb", "2 lb beef chuck roast", 2, "pound"),
      "2 lb beef chuck roast",
    );
    assert.equal(
      composePackName("boneless beef chuck roast", "lb", "3 lb boneless beef chuck roast", 3, "pound"),
      "3 lb boneless beef chuck roast",
    );
    assert.equal(
      composePackName("boneless pork shoulder", "lb", "2 lb boneless pork shoulder", 2, "pound"),
      "2 lb boneless pork shoulder",
    );
  });

  it("exactly one is left singular, and an already-plural residue is untouched", () => {
    assert.equal(
      composePackName("white onion", "each", "1 medium white onion", 0.75, "cup"),
      "1 medium white onion",
    );
    assert.equal(
      composePackName("roma tomatoes", "each", "4 roma tomatoes", 2, "cup"),
      "4 roma tomatoes",
    );
  });
});
