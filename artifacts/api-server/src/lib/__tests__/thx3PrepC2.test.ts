// THX-3 item C2 (D-WS9-316, refined by Hans October 19; server half ruled October 20):
// "Prep the feast" holds the make-ahead dishes' shelf-stable mixes only, is done
// before the first day one of them is used, and every container is made in exactly
// one session.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCoreWeek, buildFeastSession } from "../prepWeekBuild";
import { makeAheadDaysOf, type LoadPrepWeekInputResult } from "../prepWeekAggregation";
import { CRANBERRY, FEAST_MEAL, PIE, TURKEY, thx3Feast, type FeastOpts } from "./fixtures/thx3Feast";

type Load = Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">;
const feast = (o: FeastOpts = {}) => thx3Feast({ makeAhead: true, ...o }) as Load;
const live = (b: NonNullable<ReturnType<typeof buildFeastSession>>) => b.stepPlan.steps.filter((s) => !s.demoted);
const namesFor = (b: NonNullable<ReturnType<typeof buildFeastSession>>, dishId: string) =>
  live(b).flatMap((s) => s.components.filter((c) => c.measures.some((m) => m.dishId === dishId)).map((c) => c.ingredientName));

describe("THX-3 C2 — the loader reads a feast dish's make-ahead days off its tags", () => {
  it("ahead-<day> and brine-<day>, in tag order, nothing else", () => {
    assert.deepEqual(makeAheadDaysOf(["ahead-tue", "ahead-wed", "keeps-1d", "assemble"]), ["tue", "wed"]);
    assert.deepEqual(makeAheadDaysOf(["thaw-6d", "brine-wed"]), ["wed"]);
    assert.deepEqual(makeAheadDaysOf(["thanksgiving", "course-sides"]), []);
  });
});

describe("THX-3 C2 — a make-ahead dish brings only its shelf-stable mix", () => {
  const b = buildFeastSession(feast())!;

  it("nothing perishable from a make-ahead dish is in the session (cut herbs, citrus, cranberries, liquids)", () => {
    for (const d of [TURKEY, PIE, CRANBERRY]) {
      const here = namesFor(b, d);
      assert.ok(here.length > 0, d);
      assert.ok(!here.some((n) => /thyme|orange|cranberries|purée|vanilla|water|turkey/.test(n)), here.join(", "));
    }
    assert.ok(live(b).every((s) => s.phase === "seasonings_dry"), live(b).map((s) => s.stepKey).join(", "));
  });

  it("the pie's mix is a dry mix, and its closing line names the wet it joins — Hans's 'combine that with the wet, mix, and bake'", () => {
    const pie = live(b).find((s) => s.bowlName?.startsWith("Pumpkin Pie"))!;
    assert.equal(pie.bowlName, "Pumpkin Pie dry mix");
    assert.equal(
      b.closingLines?.get(pie.stepKey),
      "That's the Pumpkin Pie dry mix. On Wednesday, whisk it into the 30 oz pumpkin purée, 4 large eggs, 1½ cup heavy cream and 2 tsp vanilla extract.",
    );
  });

  it("at 8 servings the joining amounts scale and the eggs stay whole", () => {
    const b8 = buildFeastSession(feast({ servings: 8 }))!;
    const pie = live(b8).find((s) => s.bowlName === "Pumpkin Pie dry mix")!;
    assert.equal(
      b8.closingLines?.get(pie.stepKey),
      "That's the Pumpkin Pie dry mix. On Wednesday, whisk it into the 24 oz pumpkin purée, 3 large eggs, 1¼ cup heavy cream and 1½ tsp vanilla extract.",
    );
  });

  it("the cranberries join on Monday as an amount, not as a prepped container", () => {
    const line = [...(b.closingLines ?? new Map<string, string>()).values()].find((l) => l.startsWith("That's the Cranberry"));
    assert.equal(line, "That's the Cranberry-Orange Sauce dry mix. On Monday, combine it with the 24 oz fresh cranberries and ½ cup water.");
  });
});

describe("THX-3 C2 — the session loses its fixed Wednesday", () => {
  it("it is done before the first day a container is used: Monday's cranberry mix", () => {
    assert.equal(buildFeastSession(feast())!.sessionBefore, "Monday");
  });

  it("with no make-ahead day before the feast, it is done before the feast", () => {
    const b = buildFeastSession(thx3Feast({ makeAhead: false }) as Load)!;
    // Untagged, the fixture's step phrases still name Monday: the day comes from the recipe.
    assert.equal(b.sessionBefore, "Monday");
  });

  it("its lag is measured from the day before that first day (4 to Thursday), never more than the plan's own", () => {
    const b = buildFeastSession(feast())!;
    void b;
    const near = thx3Feast({ makeAhead: true }) as Load;
    (near.cookDays!.lagByMealId as Map<string, number>).set(FEAST_MEAL, 2);
    assert.ok(buildFeastSession(near), "a plan read Tuesday still builds");
  });
});

describe("THX-3 C2 — every container is made in exactly one session", () => {
  it("the week and the feast share no container and no step", () => {
    const load = feast();
    // A weeknight dinner beside the feast, using the same pantry foods.
    const weeknight = structuredClone(load.input.meals[0]) as (typeof load.input.meals)[number];
    weeknight.mealId = "f0000000-0000-4000-8000-0000000000aa";
    weeknight.mealName = "Weeknight Pie Night";
    delete (weeknight as { feast?: true }).feast;
    weeknight.dishes = weeknight.dishes.map((d) => ({ ...d, dishId: d.dishId.replace(/^fd/, "fe"), makeAheadDays: undefined }));
    const both: Load = {
      ...load,
      input: { ...load.input, meals: [load.input.meals[0], weeknight] },
      cookDays: {
        ...load.cookDays!,
        lagByMealId: new Map([...load.cookDays!.lagByMealId, [weeknight.mealId, 2]]),
        dayNameByMealId: new Map([...load.cookDays!.dayNameByMealId, [weeknight.mealId, "Tuesday"]]),
      },
    };
    const week = buildCoreWeek(both);
    const fs = buildFeastSession(both)!;
    const containers = (steps: typeof week.stepPlan.steps) =>
      new Set(steps.filter((s) => !s.demoted).flatMap((s) => [s.bowlName, ...s.components.flatMap((c) => c.measures.map((m) => m.destination))]).filter((x): x is string => !!x));
    const inWeek = containers(week.stepPlan.steps);
    const inFeast = containers(fs.stepPlan.steps);
    assert.deepEqual([...inFeast].filter((n) => inWeek.has(n)), []);
    // And each session's steps are its own meals'.
    assert.ok(live(fs).every((s) => s.contributesToMealIds.every((m) => m === FEAST_MEAL)));
    assert.ok(week.stepPlan.steps.filter((s) => !s.demoted).every((s) => !s.contributesToMealIds.includes(FEAST_MEAL)));
  });
});
