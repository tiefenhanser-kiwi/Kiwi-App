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

  it("drops a generic 'each' pack on a qualifier mismatch (no '2 onions yellow onion')", () => {
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
