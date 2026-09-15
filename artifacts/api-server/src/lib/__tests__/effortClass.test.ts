// WS9 D-WS9-242 — the effort-class derivation is a pure function over phase
// tags; these fixtures pin each class, the map, and the two data-driven
// refinements (rest alone is not cooking; a ≤2-minute stir-in is not cooking).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyEffort, EFFORT_CLASS_SOURCE, HEAT_MIN_MINUTES, PHASE_KIND } from "../effortClass";

const step = (phaseType: keyof typeof PHASE_KIND, estimatedMinutes: number, text: string) => ({ phaseType, estimatedMinutes, text });

describe("classifyEffort — the three classes from scratch-path phase tags", () => {
  it("assembly: every scratch step is prep-type (prep / assemble)", () => {
    const r = classifyEffort({ key: "dressing", label: "Dressing" }, [
      step("prep", 4, "Whisk ½ cup mayonnaise, 2 tablespoons cider vinegar, 1 tablespoon sugar, and ¼ teaspoon salt into a dressing."),
      step("assemble", 2, "Toss the slaw with the dressing just before serving."),
    ]);
    assert.equal(r.effortClass, "assembly");
    assert.equal(r.heatMinutes, 0);
    assert.deepEqual(r.cookPhases, []);
    assert.deepEqual(r.craftBy, []);
  });

  it("assembly: a spice blend measured in a bowl", () => {
    const r = classifyEffort({ key: "seasoning", label: "Spice blend" }, [
      step("prep", 3, "Mix 1 teaspoon ground cumin, ½ teaspoon dried oregano, and ½ teaspoon smoked paprika together in a small bowl."),
    ]);
    assert.equal(r.effortClass, "assembly");
  });

  it("assembly: a dressing that only CHILLS (rest) is not cooking — the ruling's own example, 11/11 on the catalog", () => {
    const r = classifyEffort({ key: "ranch", label: "Ranch dressing" }, [
      step("prep", 3, "Finely chop 1 tablespoon fresh dill and 1 tablespoon fresh chives."),
      step("prep", 3, "Whisk together ½ cup mayonnaise, ¼ cup sour cream and the herbs."),
      step("rest", 10, "Refrigerate 10 minutes to let the flavors meld."),
    ]);
    assert.equal(r.effortClass, "assembly");
    assert.deepEqual(r.cookPhases, ["rest"]);
  });

  it("assembly: a ≤2-minute stir-in tagged `cook` (the spice blend going into the pot) is not cooking — 79/79 on the catalog", () => {
    const r = classifyEffort({ key: "seasoning", label: "Taco seasoning" }, [
      step("prep", 2, "Measure out 2 teaspoons chili powder, 1½ teaspoons ground cumin, 1 teaspoon smoked paprika into a small bowl."),
      step("cook", 2, "Stir in the spice blend and 2 tablespoons tomato paste, coating the beef."),
    ]);
    assert.equal(r.effortClass, "assembly");
    assert.equal(r.heatMinutes, 2);
    assert.equal(HEAT_MIN_MINUTES, 3);
  });

  it("cooking: real heat on the scratch path (caramelized onions)", () => {
    const r = classifyEffort({ key: "onions", label: "Caramelized onions" }, [
      step("prep", 5, "Thinly slice 3 large yellow onions."),
      step("cook", 40, "Cook the onions in 2 tablespoons butter over medium-low for 40 minutes, stirring occasionally, until deep golden."),
    ]);
    assert.equal(r.effortClass, "cooking");
    assert.equal(r.heatMinutes, 40);
    assert.deepEqual(r.cookPhases, ["cook"]);
    assert.deepEqual(r.craftBy, []);
  });

  it("cooking: preheat and hold minutes count as heat; exactly HEAT_MIN_MINUTES is cooking", () => {
    const r = classifyEffort({ key: "croutons", label: "Croutons" }, [step("preheat", 2, "Preheat the oven."), step("hold", 1, "Keep warm.")]);
    assert.equal(r.effortClass, "cooking");
    assert.equal(r.heatMinutes, 3);
    assert.deepEqual(r.cookPhases, ["preheat", "hold"]);
  });

  it("cooking, not craft: shaping alone (form patties, roll meatballs) does not make a staple", () => {
    const r = classifyEffort({ key: "meatballs", label: "Meatballs" }, [
      step("prep", 8, "Mix the beef, breadcrumbs, egg and parmesan and roll into 16 meatballs."),
      step("cook", 8, "Brown the meatballs in a skillet 8 minutes, turning."),
    ]);
    assert.equal(r.effortClass, "cooking");
  });

  it("cooking, not craft: boiling dried noodles is cooking even though 'noodles' sounds like a staple", () => {
    const r = classifyEffort({ key: "noodles", label: "Lo mein noodles" }, [step("cook", 5, "Boil the 12 oz dried lo mein noodles 5 minutes; drain.")]);
    assert.equal(r.effortClass, "cooking");
  });

  it("craft by name: a strict staple name (dough) on a path with a rest (the rise) — even with no heat of its own", () => {
    const r = classifyEffort({ key: "dough", label: "Pizza dough" }, [
      step("prep", 8, "Stir the flour, yeast, salt and warm water into a shaggy dough."),
      step("rest", 60, "Cover and let the dough rise 1 hour until doubled."),
    ]);
    assert.equal(r.effortClass, "craft");
    assert.ok(r.craftBy.includes("name"));
  });

  it("craft by text: dough-craft work in the scratch text (knead / roll out / pasta sheets) when the name is not on the list", () => {
    const r = classifyEffort({ key: "base", label: "Base" }, [
      step("prep", 8, "Knead the flour and eggs 8 minutes into a smooth ball."),
      step("rest", 30, "Wrap and rest 30 minutes."),
      step("prep", 10, "Roll the dough through the pasta machine into thin sheets and cut into fettuccine."),
    ]);
    assert.equal(r.effortClass, "craft");
    assert.deepEqual(r.craftBy, ["text"]);
  });

  it("craft needs heat or a rest on the path: a no-bake crumb crust pressed in stays assembly", () => {
    const r = classifyEffort({ key: "crust", label: "Crumb crust" }, [
      step("prep", 4, "Stir the graham crumbs with the melted butter and press into the pan."),
    ]);
    assert.equal(r.effortClass, "assembly");
  });

  it("refuses an empty scratch path — an unresolvable component is a finding, not a class", () => {
    assert.throws(() => classifyEffort({ key: "x" }, []), /no scratch-path steps/);
  });

  it("the phase map is explicit: prep/assemble → prep; cook/preheat/hold → heat; rest → rest", () => {
    assert.deepEqual(PHASE_KIND, { prep: "prep", assemble: "prep", cook: "heat", preheat: "heat", hold: "heat", rest: "rest" });
    assert.equal(EFFORT_CLASS_SOURCE, "derived-v1");
  });
});
