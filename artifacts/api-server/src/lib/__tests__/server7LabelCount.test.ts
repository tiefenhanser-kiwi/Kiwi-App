// SERVER-7 D (BUG-534 follow-up) — the "Label N containers" step carries N as a number,
// `labelCount`, in Prep the Week and Prep the feast; the title keeps its words for the
// clients that read N out of it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PrepWeekResultSchema } from "../ai/schemas/prepWeek";
import { assemblePrepWeekResult, engineTitle } from "../prepWeekAssembly";
import { buildFeastSession, buildPrepWeekPlan, finishPrepWeek } from "../prepWeekBuild";
import { FEAST_LABEL_STEP_KEY } from "../prepFeastLabels";
import { WEEK_LABEL_STEP_KEY } from "../prepWeekLabels";
import type { LoadPrepWeekInputResult } from "../prepWeekAggregation";
import { load, uuid, wire, type Meal } from "./fixtures/prep3Week";
import { thx3Feast } from "./fixtures/thx3Feast";

type Load = Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">;

// prep3Labels.test.ts's Monday: a plate, a protein and a shared lemon-juice tub.
const monday: Meal = {
  id: uuid(1), name: "Grilled Chicken with Garlic Herb Rice", day: "Monday", lag: 1,
  dishes: [
    { id: uuid(11), name: "Garlic Herb Rice",
      ings: [{ id: uuid(101), name: "fresh flat-leaf parsley", category: "Produce", quantity: 1, unit: "tbsp", note: "finely chopped" }],
      steps: [{ i: 0, phase: "assemble", text: "Fluff the rice and stir in 1 tablespoon finely chopped parsley.", ids: [uuid(101)] }] },
    { id: uuid(12), name: "Roasted Asparagus with Lemon",
      ings: [
        { id: uuid(102), name: "asparagus", category: "Produce", quantity: 1, unit: "lb", note: "woody ends snapped off" },
        { id: uuid(103), name: "lemon", category: "Produce", quantity: 0.5, unit: "each", note: "juiced" },
      ],
      steps: [
        { i: 0, phase: "cook", text: "Roast the asparagus at 425°F for 12 minutes.", ids: [uuid(102)] },
        { i: 1, phase: "assemble", text: "Squeeze the juice of ½ lemon over the asparagus.", ids: [uuid(103)] },
      ] },
    { id: uuid(13), name: "Grilled Chicken Breasts",
      ings: [{ id: uuid(104), name: "boneless skinless chicken breasts", category: "Protein", quantity: 1, unit: "lb", note: "pounded to an even thickness" }],
      steps: [{ i: 0, phase: "cook", text: "Grill the chicken breasts for 12 minutes.", ids: [uuid(104)] }] },
  ],
};

describe("SERVER-7 D — Prep the Week's label step", () => {
  const r = wire(buildPrepWeekPlan(load([monday])));
  const first = r.phases.find((p) => p.steps.length > 0)!.steps[0];

  it("labelCount is the title's N and the number of labels the step lists", () => {
    assert.equal(first.stepKey, WEEK_LABEL_STEP_KEY);
    const n = Number(/^Label (\d+) containers$/.exec(first.title)![1]);
    assert.equal(first.labelCount, n);
    assert.equal(first.instructions.replace(/^Write these on tape, one per container: /, "").replace(/\.$/, "").split(" · ").length, n);
  });

  it("only the label step carries it, and the wire schema keeps it", () => {
    assert.deepEqual(r.phases.flatMap((p) => p.steps).filter((s) => s.labelCount !== undefined).map((s) => s.stepKey), [WEEK_LABEL_STEP_KEY]);
    const parsed = PrepWeekResultSchema.parse(r);
    assert.equal(parsed.phases.flatMap((p) => p.steps).find((s) => s.stepKey === WEEK_LABEL_STEP_KEY)!.labelCount, first.labelCount);
  });
});

describe("SERVER-7 D — Prep the feast's label step", () => {
  const b = buildFeastSession(thx3Feast() as Load)!;
  const narrate = () =>
    assemblePrepWeekResult(b.stepPlan, { steps: b.stepPlan.steps.filter((s) => !s.fixedProse).map((s) => ({ stepId: s.stepId, title: engineTitle(s) || "Prep", instructions: `${engineTitle(s) || "Prep"}.` })) });
  const labelStep = (r: ReturnType<typeof finishPrepWeek>) => r.phases.flatMap((p) => p.steps).find((s) => s.stepKey === FEAST_LABEL_STEP_KEY)!;

  it("the served (cached) step gets today's count when its title says it", () => {
    const n = b.stepPlan.feastLabels!.ordered.length;
    const step = labelStep(finishPrepWeek(narrate(), b));
    assert.equal(step.title, `Label ${n} containers`);
    assert.equal(step.labelCount, n);
  });

  it("a cached title that no longer says today's count gets no number (the client reads the title)", () => {
    const stale = narrate();
    const st = labelStep(stale);
    st.title = "Label 99 containers";
    assert.equal(labelStep(finishPrepWeek(stale, b)).labelCount, undefined);
  });
});
