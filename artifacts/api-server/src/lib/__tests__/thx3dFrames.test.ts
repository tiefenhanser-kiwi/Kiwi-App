// THX-3d round 2 (O) — a count that becomes one rewrites its frame; portions follow the
// servings; a ref the plan shows as 1 says its noun in the singular. The real sentences.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scaleFrames, singularOf, type DishScale } from "../feastScaleFrames";
import type { WordingStep } from "../feastCookWording";

const scale = (over: Partial<DishScale> = {}): DishScale => ({ servings: 4, authoredServings: 10, ones: new Set(), counts: new Map(), rows: new Map(), ...over });
const step = (text: string, refs: [string, string, number, string][] = []): WordingStep => ({
  stepIndex: 0, text,
  amountRefs: refs.map(([span, id, quantity, unit]) => {
    const at = text.indexOf(span);
    return { ingredientId: id, quantity, unit, charStart: at, charEnd: at + span.length };
  }),
});
const ones = (...n: string[]) => new Set(n);

describe("THX-3d O — a count that becomes one", () => {
  it("Classic's pie at 4: one crust, one dish, the filling poured into it", () => {
    const s = scale({ ones: ones("crust", "shell", "pie dish", "dish") });
    assert.equal(scaleFrames(step("Make ahead (Wednesday): Fit one refrigerated pie crust into each of two 9-inch pie dishes; crimp the edges."), s).text,
      "Make ahead (Wednesday): Fit one refrigerated pie crust into a 9-inch pie dish; crimp the edges.");
    assert.equal(scaleFrames(step("Make ahead (Wednesday): Divide the filling evenly between the two prepared pie shells (each shell will be nearly full); place on a rimmed sheet pan."), s).text,
      "Make ahead (Wednesday): Pour the filling into the prepared pie shell (the shell will be nearly full); place on a rimmed sheet pan.");
  });
  it("Vegetarian's Wellington at 4: the one sheet, the mound, the Wellington, sliced into 4", () => {
    const s = scale({ ones: ones("sheet", "mound", "wellington"), counts: new Map([["wellington", { authored: 2, shown: 1 }]]) });
    const w = scaleFrames(step("Divide the duxelles between the 2 sheets, mounding it in the centre; top each mound with 2 portobello caps.", [["2 sheets", "pp", 2, "sheets"]]), s);
    assert.equal(w.text, "Spoon the duxelles onto the sheet, mounding it in the centre; top the mound with 2 portobello caps.");
    assert.deepEqual(w.amountRefs, [], "the frame's count went with its words");
    assert.equal(scaleFrames(step("Rest the Wellingtons on the pan for 10 minutes, then slice each into 5 portions."), s).text, "Rest the Wellington on the pan for 10 minutes, then slice it into 4 portions.");
  });
  it("New Twist's cornbread at 4: an 8×8 pan with its egg and milk", () => {
    const s = scale({ ones: ones("box", "pan") });
    assert.equal(scaleFrames(step("Bake 2 boxes (8.5 oz each) cornbread mix in two separate 8×8 pans, each with 1 egg and ⅓ cup whole milk, per package directions."), s).text,
      "Bake 2 boxes (8.5 oz) cornbread mix in an 8×8 pan with 1 egg and ⅓ cup whole milk, per package directions.");
  });
  it("nothing changes while the count is still two or more", () => {
    const t = "Divide the filling evenly between the two prepared pie shells.";
    assert.equal(scaleFrames(step(t), scale({ servings: 10, authoredServings: 10 })).text, t);
  });
});

describe("THX-3d O — portions follow the servings", () => {
  it("New Twist's bars at 4: \"slice into 4 portions\"", () => {
    assert.equal(scaleFrames(step("On Thursday: Lift the bars out, slice into 10 portions, and serve."), scale()).text, "On Thursday: Lift the bars out, slice into 4 portions, and serve.");
  });
});

describe("THX-3d O — a ref the plan shows as 1 says its noun singular", () => {
  const rows = new Map([["o", { mult: 0.4, name: "orange", unit: "each" }], ["b", { mult: 0.4, name: "bay leaves", unit: "each" }], ["e", { mult: 0.4, name: "large eggs", unit: "each" }]]);
  it("\"2 oranges\", \"2 bay leaves\", \"2 beaten eggs\" at ×0.4", () => {
    const text = "Zest and juice 2 oranges; add 2 bay leaves and 2 beaten eggs.";
    const at = [...text.matchAll(/2/g)].map((m) => m.index!);
    const s: WordingStep = { stepIndex: 0, text, amountRefs: ["o", "b", "e"].map((id, i) => ({ ingredientId: id, quantity: 2, unit: "", charStart: at[i], charEnd: at[i] + 1 })) };
    const w = scaleFrames(s, scale({ rows }));
    assert.equal(w.text, "Zest and juice 2 orange; add 2 bay leaf and 2 beaten egg.");
    assert.deepEqual(w.amountRefs!.map((r) => w.text.slice(r.charStart, r.charEnd)), ["2", "2", "2"]);
    assert.equal(singularOf("leaves"), "leaf");
    assert.equal(singularOf("potatoes"), "potato");
    assert.equal(singularOf("jalapeños"), "jalapeño");
  });
  it("a count the plan keeps above 1 keeps its plural", () => {
    const w = scaleFrames(step("Zest and juice 4 oranges.", [["4", "o", 4, ""]]), scale({ rows }));
    assert.equal(w.text, "Zest and juice 4 oranges.");
  });
});
