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
    assert.equal(
      composePackName("chicken thighs", "lb", "1.5 lb pack", "3.5", "pound"),
      "4.5 lb pack chicken thighs",
    );
  });

  it("guard A2 — BOUNDARY: need == purchaseQuantity is exactly ONE pack", () => {
    // Float noise makes ceil(1.0/1.0) unsafe without an epsilon.
    assert.equal(composePackName("ground beef", "lb", "1 lb", "1", "pound"), "1 lb ground beef");
    assert.equal(
      composePackName("chicken thighs", "lb", "1.5 lb pack", "1.5", "pound"),
      "1.5 lb pack chicken thighs",
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
    assert.equal(
      composePackName("guanciale", "lb", "0.5 lb pack", "8", "ounce"),
      "0.5 lb pack guanciale",
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
    assert.equal(
      composePackName("Cotija cheese", "lb", "1 lb block", "5.125", "ounce"),
      "1 lb block Cotija cheese",
    );
    assert.equal(
      composePackName("Mexican fresh chorizo", "lb", "0.75 lb pack", "12", "ounce"),
      "0.75 lb pack Mexican fresh chorizo",
    );
    assert.equal(
      composePackName("gruyère cheese", "lb", "0.5 lb block", "4", "ounce"),
      "0.5 lb block gruyère cheese",
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

  it("guard W7 — SCOPE: a weight need against a CONTAINER pack is still out of scope", () => {
    // "1 package (12 oz)" against a 2 lb need is a real under-order, and it is
    // deliberately NOT fixed here: the pack unit is `package`, not a weight, so
    // relating them means trusting a size parsed out of authored display prose
    // across a unit boundary. Widening to it would move rows outside the 35
    // this block scoped. Pinned so the next person sees the choice was made.
    assert.equal(
      composePackName("bacon", "package", "1 package (12 oz)", "2", "pound"),
      "1 package (12 oz) bacon",
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
