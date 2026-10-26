// THX-4 (D-WS9-324) — the "Turkey: 14 lb" stepper's rules (lib/meals/birdWeight.ts):
// what the read must carry, the ½-lb grid inside the range, null → the default
// bird, and the label. The screen (app/meal/[id].tsx) only wires these.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  birdStepperOf,
  birdWeightDirty,
  birdWeightLabel,
  canStepBird,
  shownBirdLb,
  stepBirdWeight,
  type BirdStepper,
} from "../birdWeight";
import { MealDetailSchema, type MealDetail } from "../../api/meals";

const WHOLE = { min: 8, max: 20, step: 0.5, default: 14 };
const SPATCHCOCK = { min: 8, max: 16, step: 0.5, default: 14 };

describe("birdStepperOf — the read decides", () => {
  it("no bird fields (a library read, a meal with no weighable turkey, a server before THX-4): no stepper", () => {
    assert.equal(birdStepperOf({}), null);
    assert.equal(birdStepperOf({ birdKind: "whole", birdWeightLb: null, birdShownLb: 10 }), null);
  });

  it("null → the default bird; a number → the chosen weight", () => {
    assert.deepEqual(birdStepperOf({ birdKind: "whole", birdWeightLb: null, birdWeightRange: WHOLE, birdShownLb: 10 }), {
      kind: "whole",
      range: WHOLE,
      chosen: null,
      shown: 10,
    });
    assert.equal(birdStepperOf({ birdKind: "whole", birdWeightLb: 16.5, birdWeightRange: WHOLE, birdShownLb: 16.5 })!.chosen, 16.5);
  });

  it("the schema carries the four fields, and a read without them still parses", () => {
    const base = {
      id: "m", title: "Feast", cuisine: "", minutes: 300, servings: 10, authoredServingsDefault: 10,
      calories: 0, protein: 0, carbs: 0, fat: 0, tags: [], image: null, description: null,
      difficulty: "hard", mealType: "dinner", sourceType: "catalog", isPublic: false, userId: null,
      dishes: [], steps: [], notes: null, effectiveServings: 4,
    };
    const withBird = MealDetailSchema.parse({ ...base, birdKind: "spatchcock", birdWeightLb: null, birdWeightRange: SPATCHCOCK, birdShownLb: 10 });
    assert.deepEqual(birdStepperOf(withBird), { kind: "spatchcock", range: SPATCHCOCK, chosen: null, shown: 10 });
    assert.equal(birdStepperOf(MealDetailSchema.parse(base)), null);
  });
});

describe("stepBirdWeight / canStepBird — ½-lb steps within the range", () => {
  it("one ½ lb each way", () => {
    assert.equal(stepBirdWeight(14, 1, WHOLE), 14.5);
    assert.equal(stepBirdWeight(14, -1, WHOLE), 13.5);
    assert.equal(stepBirdWeight(16.5, -1, WHOLE), 16);
  });

  it("never past the ends: whole 8–20, spatchcock 8–16", () => {
    assert.equal(stepBirdWeight(20, 1, WHOLE), 20);
    assert.equal(stepBirdWeight(8, -1, WHOLE), 8);
    assert.equal(stepBirdWeight(16, 1, SPATCHCOCK), 16);
    assert.equal(canStepBird(20, 1, WHOLE), false);
    assert.equal(canStepBird(20, -1, WHOLE), true);
    assert.equal(canStepBird(8, -1, WHOLE), false);
    assert.equal(canStepBird(16, 1, SPATCHCOCK), false);
    assert.equal(canStepBird(16, 1, WHOLE), true);
  });

  it("a default off the grid (11¼ lb) steps onto it; one outside the range steps into it", () => {
    assert.equal(stepBirdWeight(11.25, 1, WHOLE), 11.5);
    assert.equal(stepBirdWeight(11.25, -1, WHOLE), 11);
    assert.equal(stepBirdWeight(28, -1, WHOLE), 20);
    assert.equal(canStepBird(28, 1, WHOLE), false);
    assert.equal(stepBirdWeight(7, 1, WHOLE), 8);
  });

  it("every value it reaches is on the server's grid (the PATCH's 400 never fires)", () => {
    for (let v = 8; v <= 20; v += 0.25) {
      for (const dir of [1, -1] as const) {
        const n = stepBirdWeight(v, dir, WHOLE);
        assert.ok(n >= 8 && n <= 20, `${v} ${dir}`);
        assert.equal(Math.abs(n / 0.5 - Math.round(n / 0.5)) < 1e-9, true, `${v} ${dir} → ${n}`);
      }
    }
  });
});

describe("shownBirdLb — birdWeightLb ?? birdShownLb, and the default the server was not asked for", () => {
  const TURKEY = {
    dishId: "turkey",
    title: "Turkey",
    ingredients: [{ name: "whole turkey", quantity: 14, unit: "pound", preparationNote: null }],
  };
  const meal = { tags: ["thanksgiving-feast"], effectiveServings: 4, dishes: [TURKEY] } as unknown as MealDetail;
  const stepper = (chosen: number | null, shown: number): BirdStepper => ({ kind: "whole", range: WHOLE, chosen, shown });

  it("a weight stepped to (saved or not) is shown", () => {
    assert.equal(shownBirdLb({ stepper: stepper(null, 10), displayLb: 15.5, meal, displayServings: 4, servingsMultiplier: 0.4 }), 15.5);
  });

  it("null at the saved servings: the server's birdShownLb", () => {
    assert.equal(shownBirdLb({ stepper: stepper(null, 10), displayLb: null, meal, displayServings: 4, servingsMultiplier: 0.4 }), 10);
  });

  it("Reset of a saved weight: the default bird's, not the saved one the read still says", () => {
    assert.equal(shownBirdLb({ stepper: stepper(16, 16), displayLb: null, meal, displayServings: 4, servingsMultiplier: 0.4 }), 10);
  });

  it("servings stepped and not saved: the default at those servings", () => {
    assert.equal(shownBirdLb({ stepper: stepper(null, 10), displayLb: null, meal, displayServings: 8, servingsMultiplier: 0.8 }), 11.25);
    assert.equal(shownBirdLb({ stepper: stepper(null, 10), displayLb: null, meal, displayServings: 20, servingsMultiplier: 2 }), 28);
  });
});

describe("birdWeightDirty / birdWeightLabel", () => {
  it("dirty when the stepped weight is not the saved one (null included)", () => {
    const s = (chosen: number | null): BirdStepper => ({ kind: "whole", range: WHOLE, chosen, shown: chosen ?? 10 });
    assert.equal(birdWeightDirty(null, s(null)), false);
    assert.equal(birdWeightDirty(14, s(null)), true);
    assert.equal(birdWeightDirty(null, s(14)), true);
    assert.equal(birdWeightDirty(14, s(14)), false);
    assert.equal(birdWeightDirty(14, null), false);
  });

  it("14 lb · 14½ lb · 11¼ lb", () => {
    assert.equal(birdWeightLabel(14), "14 lb");
    assert.equal(birdWeightLabel(14.5), "14½ lb");
    assert.equal(birdWeightLabel(11.25), "11¼ lb");
  });
});
