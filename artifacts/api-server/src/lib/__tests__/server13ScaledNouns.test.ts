// SERVER-13 F (BUG-634) — the scaled-noun rule: a range keeps its plural ("Place 1–2
// fish strip"), and no "mangoe", "chily" or "doughs". The vectors are shared with the
// client's port (shared/scaledNounVectors.mts); SERVER-10 E's own tests stay as they are.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { agreeScaledNouns, pluralOf, singularOf } from "../feastScaleFrames";
import { PLURAL, SINGULAR, STEP_VECTORS } from "./shared/scaledNounVectors.mjs";

describe("SERVER-13 F — the shared scaled-noun vectors, on the server's rule", () => {
  for (const [plural, one] of SINGULAR) {
    it(`singularOf("${plural}") is "${one}"`, () => assert.equal(singularOf(plural), one));
  }
  for (const [one, plural] of PLURAL) {
    it(`pluralOf("${one}") is "${plural}"`, () => assert.equal(pluralOf(one), plural));
  }
  for (const v of STEP_VECTORS) {
    it(v.name, () => {
      const charStart = v.text.indexOf(v.ref);
      assert.ok(charStart >= 0, `"${v.ref}" is in the text`);
      const step = { stepIndex: 0, text: v.text, amountRefs: [{ ingredientId: "f", quantity: v.authored, unit: "", charStart, charEnd: charStart + v.ref.length }] };
      const w = agreeScaledNouns(step, new Map([["f", { mult: v.shown / v.authored, name: v.food, unit: "each" }]]));
      assert.equal(w.text, v.want);
      const r = w.amountRefs![0];
      assert.equal(w.text.slice(r.charStart, r.charEnd), v.ref, "the ref still sits on its number");
    });
  }
});
