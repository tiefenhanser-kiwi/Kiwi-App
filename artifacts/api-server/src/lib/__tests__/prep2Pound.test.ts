// PREP-2 item 4 — "Pound the 14 lb whole turkey … to even thickness". Hans: "we can't
// tell users to pound their turkey." A rate ("per pound") is not the verb, and a
// whole bird or a large roast is never pounded; cutlets and breasts still are.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isLargeCut, proteinVerbsFor } from "../prepComponents";
import { judgeProteinWork, proteinNeedsKnife } from "../prepClasses";
import type { LoadPrepWeekInputResult, PrepLoadedPlan } from "../prepWeekAggregation";
import { buildPrepWeekPlan } from "../prepWeekBuild";

// The Classic feast's roast step, verbatim (dev catalog): the only "pound" it has.
const CLASSIC_ROAST =
  "Place the turkey breast side up on a rack in a large roasting pan and roast at 325°F for 3 to 3½ hours (about 13–15 minutes per pound), until an instant-read thermometer in the thickest part of the thigh reads 165°F.";
const CLASSIC_PAT = "Pat the turkey dry with paper towels, remove the neck and giblets (reserve for gravy), and submerge the bird in the brine, breast side down.";

describe("PREP-2 item 4 — the protein verbs", () => {
  it("'per pound' is a rate: the Classic turkey gets no verb at all", () => {
    assert.deepEqual(proteinVerbsFor(null, CLASSIC_ROAST, "whole turkey"), []);
    // The rate guard holds by itself, whatever the protein.
    assert.deepEqual(proteinVerbsFor(null, "Roast the chicken thighs about 20 minutes per pound.", "bone-in chicken thighs"), []);
    assert.deepEqual(proteinVerbsFor(null, "Allow 1 hour each pound.", "beef brisket flat"), []);
  });

  it("a whole bird or a large roast is never pounded, even when the text says so; its other verbs stand", () => {
    assert.deepEqual(proteinVerbsFor(null, "Pound the pork shoulder flat.", "boneless pork shoulder"), []);
    assert.deepEqual(proteinVerbsFor("pounded", "", "whole chicken"), []);
    assert.deepEqual(proteinVerbsFor(null, "Trim and cube the pork shoulder into 2-inch pieces.", "boneless pork shoulder"), ["cube", "trim"]);
    // A spatchcock is a butterfly: it stays, from the recipe's own words.
    assert.deepEqual(proteinVerbsFor(null, "Butterfly the whole chicken and press firmly to flatten it.", "whole chicken"), ["butterfly"]);
  });

  it("cutlets and breasts are still pounded", () => {
    assert.deepEqual(proteinVerbsFor(null, "Pound the chicken breasts to an even ½-inch thickness.", "boneless skinless chicken breasts"), ["pound"]);
    assert.deepEqual(proteinVerbsFor(null, "Pound the turkey cutlets thin.", "turkey breast cutlets"), ["pound"]);
    assert.deepEqual(proteinVerbsFor(null, "Pound the chicken to an even ½ inch."), ["pound"]);
  });

  it("isLargeCut, on the dev catalog's own names", () => {
    for (const n of [
      "whole turkey", "whole chicken", "whole chicken halves (bone-in, skin-on)", "boneless pork shoulder",
      "bone-in pork shoulder (boston butt)", "beef chuck roast", "boneless beef chuck roast", "beef brisket flat",
      "bone-in lamb shoulder", "bone-in skin-on chicken breast", "bone-in, skin-on turkey breast half",
      "bone-in fully cooked ham (shank or butt half)", "beef top round roast", "beef tenderloin, center-cut", "boneless pork loin",
    ]) assert.equal(isLargeCut(n), true, n);
    for (const n of [
      "boneless skinless chicken breasts", "turkey breast cutlets", "ground turkey (93% lean)", "beef chuck, cut into 1½-inch cubes",
      "pork shoulder steaks", "bone-in pork chops", "boneless pork loin chops", "pork tenderloin", "chicken tenderloins",
      "beef tenderloin medallions", "deli ham", "bone-in ham steak", "sliced deli turkey", "bone-in skin-on chicken thighs",
    ]) assert.equal(isLargeCut(n), false, n);
  });
});

describe("PREP-2 item 4 — is the turkey prep at all?", () => {
  it("the Classic turkey asks for no knife work: patted dry only, so it is not a prep step (BUG-359's rule)", () => {
    const prose = [CLASSIC_PAT, CLASSIC_ROAST];
    assert.equal(proteinNeedsKnife([], [""], prose, "whole turkey"), false);
    // Still "work" (pat dry), which is what the marinade-join exception reads.
    assert.equal(judgeProteinWork([], [""], prose, "whole turkey"), true);
  });

  it("a weight is never cut work either; a real pounding still is", () => {
    assert.equal(proteinNeedsKnife([], ["1 pound"], [], "chicken breasts"), false);
    assert.equal(proteinNeedsKnife([], ["pounded thin"], [], "chicken breasts"), true);
    assert.equal(proteinNeedsKnife([], ["pounded thin"], [], "whole chicken"), false);
    assert.equal(proteinNeedsKnife([], ["trimmed of excess fat"], [], "boneless pork shoulder"), true);
  });
});

// ── through the engine (the route's build, no narration) ──────────────────────

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000240`;
type Ing = { id: string; name: string; quantity: number; unit: string; note?: string };
type Dish = { id: string; name: string; ings: Ing[]; steps: { i: number; phase: string; text: string; ids: string[] }[] };

function load(dishes: Dish[]): LoadPrepWeekInputResult {
  const input: PrepLoadedPlan = {
    planId: uuid(999),
    planName: "PREP-2",
    meals: dishes.map((d, k) => ({
      mealId: uuid(900 + k),
      mealName: d.name,
      cuisine: null,
      servingsOverride: null,
      dishes: [{
        dishId: d.id,
        dishName: d.name,
        dishRole: "main" as const,
        baseServings: 10,
        authoredBaseServings: 10,
        ingredients: d.ings.map((x) => ({
          ingredientId: x.id, ingredientName: x.name, category: "Protein", quantity: x.quantity, unit: x.unit,
          preparationNote: x.note ?? null, sourceYield: null, purchaseUnit: null,
        })),
        stepTexts: d.steps.map((s) => s.text),
        componentSteps: d.steps.map((s) => ({ stepIndex: s.i, text: s.text, componentKey: null, ingredientIds: s.ids, phaseType: s.phase })),
      }],
    })),
  };
  return {
    input,
    planRevisionId: 1,
    cookDays: {
      prepDay: "2026-11-25",
      lagByMealId: new Map(input.meals.map((m) => [m.mealId, 1])),
      dayNameByMealId: new Map(input.meals.map((m) => [m.mealId, "Thursday"])),
    },
    identity: { foldedIdByIngredientId: new Map() },
  };
}

describe("PREP-2 item 4 — through the engine", () => {
  it("the Classic turkey is not a pounding (it leaves the prep as patted-dry-only); a pork shoulder whose text says 'pound' is not pounded; a cutlet still is", () => {
    const b = buildPrepWeekPlan(load([
      { id: uuid(1), name: "Herb-Roasted Whole Turkey", ings: [{ id: uuid(11), name: "whole turkey", quantity: 14, unit: "pound" }],
        steps: [{ i: 0, phase: "prep", text: CLASSIC_PAT, ids: [uuid(11)] }, { i: 1, phase: "cook", text: CLASSIC_ROAST, ids: [uuid(11)] }] },
      { id: uuid(2), name: "Carnitas", ings: [{ id: uuid(21), name: "boneless pork shoulder", quantity: 4, unit: "pound" }],
        steps: [{ i: 0, phase: "prep", text: "Pound the pork shoulder with a mallet, then season it.", ids: [uuid(21)] }, { i: 1, phase: "cook", text: "Braise 3 hours.", ids: [] }] },
      { id: uuid(3), name: "Chicken Piccata", ings: [{ id: uuid(31), name: "boneless skinless chicken breasts", quantity: 2, unit: "pound" }],
        steps: [{ i: 0, phase: "prep", text: "Pound the chicken breasts to an even ½-inch thickness.", ids: [uuid(31)] }, { i: 1, phase: "cook", text: "Sear 4 minutes a side.", ids: [] }] },
    ]));
    const proteins = b.stepPlan.steps.filter((s) => s.phase === "proteins");
    const of = (name: string) => proteins.find((s) => s.components.some((c) => c.ingredientName === name))!;
    assert.deepEqual(of("whole turkey").knifeVerbs ?? [], []);
    assert.ok(of("whole turkey").demoted, "the turkey is off the wire (patted dry only)");
    assert.deepEqual(of("boneless pork shoulder").knifeVerbs ?? [], []);
    assert.deepEqual(of("boneless skinless chicken breasts").knifeVerbs, ["pound"]);
    assert.ok(!of("boneless skinless chicken breasts").demoted);
    assert.ok(proteins.filter((s) => !s.demoted).every((s) => !s.knifeVerbs?.includes("pound") || s.components.every((c) => !isLargeCut(c.ingredientName))));
  });
});
