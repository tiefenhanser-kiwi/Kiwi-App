// THX-3 item A (BUG-426 / BUG-447) — liquids and equipment never land in a dry
// container; a feast measures its salt; each feast container says what joins it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assignPhase, isNeverMeasured, isSaltOrPepper } from "../prepCombineEngine";
import { resolvePrepCategory } from "../prepCategoryOverride";
import { buildFeastSession, buildPrepWeekPlan } from "../prepWeekBuild";
import type { LoadPrepWeekInputResult } from "../prepWeekAggregation";
import { CRANBERRY, PIE, TURKEY, thx3Feast, type FeastOpts } from "./fixtures/thx3Feast";

type Load = Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">;
const feast = (o: FeastOpts = {}) => thx3Feast(o) as Load;

const dryOf = (b: ReturnType<typeof buildPrepWeekPlan>, dishId: string) =>
  b.stepPlan.steps.filter((s) => !s.demoted && s.phase === "seasonings_dry" && s.components.some((c) => c.measures.some((m) => m.dishId === dishId)));
const names = (steps: ReturnType<typeof dryOf>) => steps.flatMap((s) => s.components.map((c) => c.ingredientName)).sort();

describe("THX-3 A — the name rules (every session)", () => {
  it("water in any form and equipment are never measured", () => {
    for (const n of ["cold water", "ice water", "warm water", "pasta cooking water", "large brining bag", "turkey-size brining bag", "parchment paper", "kitchen twine"]) {
      assert.equal(isNeverMeasured(n), true, n);
    }
    for (const n of ["rose water", "water chestnuts", "watercress", "canned tuna in water", "brown sugar", "bay leaves"]) {
      assert.equal(isNeverMeasured(n), false, n);
    }
  });

  it("extract and purée are wet; a Pantry row named fresh is produce (or bought and used)", () => {
    assert.equal(assignPhase("Pantry", "vanilla extract", null), "sauces_marinades");
    assert.equal(assignPhase("Pantry", "pumpkin purée", null), "sauces_marinades");
    assert.equal(assignPhase("Pantry", "pumpkin puree", null), "sauces_marinades");
    assert.equal(assignPhase("Pantry", "fresh cranberries", null), "produce");
    assert.equal(assignPhase("Pantry", "fresh lo mein noodles", null), null);
    assert.equal(assignPhase("Pantry", "ground cinnamon", "container"), "seasonings_dry");
  });

  it("a ground or dried spice filed as Produce is Pantry to the prep pipeline", () => {
    assert.equal(resolvePrepCategory("ground ginger", "Produce"), "Pantry");
    assert.equal(resolvePrepCategory("dried thyme", "Produce"), "Pantry");
    assert.equal(resolvePrepCategory("fresh ginger", "Produce"), "Produce");
  });

  it("salt and pepper are the seasonings a feast measures", () => {
    for (const n of ["kosher salt", "salt", "black pepper", "freshly ground black pepper", "white pepper"]) assert.equal(isSaltOrPepper(n), true, n);
    for (const n of ["black peppercorns", "red pepper flakes", "celery salt", "bell pepper"]) assert.equal(isSaltOrPepper(n), false, n);
  });
});

describe("THX-3 A — the feast session's dry containers", () => {
  const b = buildFeastSession(feast())!;

  it("the brine holds its salt and brown sugar — no water, no bag, no herb-butter pepper (Hans, Oct 19)", () => {
    const brine = dryOf(b, TURKEY).find((s) => s.components.some((c) => /brown sugar/.test(c.ingredientName)))!;
    const inBrine = brine.components.map((c) => c.ingredientName);
    assert.ok(inBrine.includes("kosher salt") && inBrine.includes("light brown sugar"), inBrine.join(", "));
    assert.ok(!inBrine.includes("black pepper"), inBrine.join(", "));
    const everything = b.stepPlan.steps.filter((s) => !s.demoted).flatMap((s) => s.components.map((c) => c.ingredientName));
    assert.ok(!everything.some((n) => /water|brining bag/.test(n)), everything.join(", "));
  });

  it("the herb butter's black pepper is a lone measure, demoted — never a container", () => {
    assert.deepEqual(dryOf(b, TURKEY).filter((s) => s.components.some((c) => c.ingredientName === "black pepper")), []);
    assert.ok(b.stepPlan.steps.some((s) => s.demoted && s.components.some((c) => c.ingredientName === "black pepper")));
  });

  it("the pie's dry step holds its spices, salt and sugar — never the vanilla or the purée", () => {
    assert.deepEqual(names(dryOf(b, PIE)), ["ground cinnamon", "ground cloves", "ground nutmeg", "kosher salt", "packed light brown sugar"]);
  });

  it("the cranberry mix holds no fresh cranberries and no water", () => {
    assert.deepEqual(names(dryOf(b, CRANBERRY)), ["cinnamon stick", "granulated sugar", "kosher salt"]);
  });

  it("each container closes with what joins it, built from its recipe step and day", () => {
    const lines = [...(b.closingLines ?? new Map<string, string>()).values()];
    const has = (l: string) => assert.ok(lines.includes(l), `${l}\n— not in —\n${lines.join("\n")}`);
    has("That's the Herb-Roasted Whole Turkey marinade bowl. On Wednesday night, dissolve it in the 1 gallon cold water.");
    // Not a make-ahead dish here, so the purée and vanilla are this container's own
    // wet members (its phase-3 step): the line names only what is still to come.
    has("That's the Pumpkin Pie sauce jar. On Wednesday, whisk it into the 4 large eggs and 1½ cup heavy cream.");
    // A food in another of the dish's containers joins as that container.
    has("That's the Cranberry-Orange Sauce dry mix. On Monday, combine it with the Cranberry-Orange Sauce vegetables and ½ cup water.");
  });

  it("the line rides the step that closes the container, and finishPrepWeek's wire keeps it", () => {
    for (const [key] of b.closingLines ?? new Map()) {
      const st = b.stepPlan.steps.find((s) => s.stepKey === key)!;
      assert.ok(st && !st.demoted && (st.closes ?? []).length > 0, key);
    }
  });
});

describe("THX-3 A — a weeknight keeps D3", () => {
  it("the same dishes outside a feast measure no salt, and carry no closing lines", () => {
    const b = buildPrepWeekPlan(feast({ feast: false }));
    const all = b.stepPlan.steps.filter((s) => !s.demoted).flatMap((s) => s.components.map((c) => c.ingredientName));
    assert.ok(!all.includes("kosher salt"), all.join(", "));
    assert.equal(b.closingLines, undefined);
  });
});
