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
