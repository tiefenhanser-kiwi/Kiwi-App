// THX-3 (BUG-444) — the prep text's displayed amounts are FIX-7's (BUG-437).
// prepQuantity.ts is a COPY of artifacts/kiwi/lib/format/quantity.ts's rule (the
// server cannot import across the fence). This file pins the copy two ways:
// the literal tables, and — when the client file is on disk — the client's own
// table literals, so a change to one side without the other goes red here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  CUP_STEPS,
  SPOON_STEPS,
  WHOLE_BIRD,
  WHOLE_ITEM_NAME,
  WHOLE_UNITS,
  displayedPrepQuantity,
  mixedGlyph,
  wholeItemMultiplier,
} from "../prepQuantity";
import { formatMeasure } from "../prepWeekAssembly";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(here, "../../../../kiwi/lib/format/quantity.ts");

describe("THX-3 prepQuantity — the pinned table (FIX-7's, verbatim)", () => {
  it("spoons snap to ⅛ ¼ ½ ¾ and cups add the thirds", () => {
    assert.deepEqual(SPOON_STEPS, [0, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1]);
    assert.deepEqual(CUP_STEPS, [0, 1 / 8, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1]);
    assert.deepEqual(WHOLE_UNITS, ["whole", "clove", "sprig", "slice", "leaf", "strip"]);
  });

  it("matches the client's own literals (drift guard)", { skip: !existsSync(CLIENT) && "client file not on disk" }, () => {
    const src = readFileSync(CLIENT, "utf8");
    const lit = (name: string) => {
      const m = new RegExp(`const ${name}\\s*=\\s*(\\[[^\\]]*\\])`).exec(src);
      assert.ok(m, `${name} not found in the client file`);
      return m![1].replace(/\s+/g, "");
    };
    assert.equal(lit("SPOON_STEPS"), "[0,1/8,1/4,1/2,3/4,1]");
    assert.equal(lit("CUP_STEPS"), "[0,1/8,1/4,1/3,1/2,2/3,3/4,1]");
    assert.equal(lit("WHOLE_UNITS"), `["whole","clove","sprig","slice","leaf","strip"]`);
    const re = (name: string) => new RegExp(`const ${name} = new RegExp\\(\\s*String\\.raw\`([^\`]*)\``).exec(src)?.[1];
    assert.equal(re("WHOLE_ITEM_NAME"), WHOLE_ITEM_NAME.source);
    assert.equal(re("WHOLE_BIRD"), WHOLE_BIRD.source);
  });
});

describe("THX-3 prepQuantity — the displayed number", () => {
  const rows: Array<[number, string, string, number]> = [
    // spoons: nearest of ⅛ ¼ ½ ¾, ties up, floor ⅛, no thirds unless exact
    [0.375, "tsp", "", 0.5],
    [0.875, "tbsp", "", 1],
    [0.13, "tsp", "", 0.125],
    [0.01, "tsp", "", 0.125],
    [1 / 3, "tsp", "", 1 / 3],
    // cups: thirds allowed
    [0.6425, "cup", "", 2 / 3],
    [0.875, "cup", "", 1],
    [1.2, "cup", "", 1.25],
    // pounds: ¼ steps, ties up, floor ¼
    [1.625, "lb", "", 1.75],
    [1.3, "lb", "", 1.25],
    [0.1, "lb", "", 0.25],
    // whole counted items round UP — by unit and by name
    [4.8, "clove", "garlic", 5],
    // THX-3d (R5) — a sprig is a PIECE: the nearest whole now (rule 1 ceiled it to 4)
    [3.2, "sprigs", "fresh sage", 3],
    [0.8, "", "bay leaves", 1],
    [1.5, "", "corn tortillas", 2],
    // THX-3d round 2 (P) — produce by the piece to the nearest ½, never below ½
    // (chat-Claude's ruling, October 22: "⅜ onion" → ½, "1⅞" → 2)
    [0.8, "", "lemon", 1],
    [1.6, "", "yellow onion", 1.5],
    [0.375, "", "yellow onion", 0.5],
    // Hans's egg rule: nearest whole, halves up, never below 1
    [3.2, "", "large eggs", 3],
    [2.5, "", "large eggs", 3],
    [1.4, "", "egg yolks", 1],
    [0.4, "", "eggs", 1],
    [1.6, "", "egg whites", 2],
    // "egg noodles" is not an egg
    [0.4, "", "egg noodles", 0.375],
  ];
  for (const [q, unit, name, want] of rows) {
    it(`${q} ${unit || "(count)"} ${name} → ${want}`, () => {
      assert.ok(Math.abs(displayedPrepQuantity(q, unit, name) - want) < 1e-9, `got ${displayedPrepQuantity(q, unit, name)}`);
    });
  }

  // THX-3b: with no quantity the bird keeps FIX-7's no-scale-down (the floors need it; thx3bBird.test.ts).
  it("a whole bird by weight never scales DOWN without its quantity; up it scales; a breast is not a whole bird", () => {
    assert.equal(wholeItemMultiplier(0.8, "pound", "whole turkey"), 1);
    assert.equal(wholeItemMultiplier(1.2, "pound", "whole turkey"), 1.2);
    assert.equal(wholeItemMultiplier(0.8, "pound", "bone-in turkey breast"), 0.8);
    assert.equal(wholeItemMultiplier(0.8, "each", "whole turkey"), 0.8);
  });

  it("spells the app's mixed number", () => {
    assert.equal(mixedGlyph(1.5), "1½");
    assert.equal(mixedGlyph(2 / 3), "⅔");
    assert.equal(mixedGlyph(3), "3");
    assert.equal(mixedGlyph(1.625), "1⅝");
  });
});

describe("THX-3 formatMeasure — BUG-444's lines, before → after", () => {
  it("prints what the cook measures", () => {
    assert.equal(formatMeasure(4.8, "clove", "garlic"), "5 cloves");
    // THX-3d (R5) — a lemon is whole now ("¾" before)
    assert.equal(formatMeasure(0.8, "each", "lemon"), "1");
    assert.equal(formatMeasure(0.875, "tablespoon", "fresh thyme"), "1 tbsp");
    assert.equal(formatMeasure(1.625, "pound", "fresh green beans"), "1¾ lb");
    assert.equal(formatMeasure(3.2, "each", "large eggs"), "3");
    assert.equal(formatMeasure(3.2, "large", "eggs"), "3");
    assert.equal(formatMeasure(0.8, "each", "bay leaves"), "1");
    assert.equal(formatMeasure(1, "clove", "garlic"), "1 clove");
  });
});
