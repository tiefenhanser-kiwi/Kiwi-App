// THX-3d round 2 (J) — THE WARM STEPS, WRITTEN (content, patch.ts, no AI).
//
// Every stovetop side gets "Cover and keep warm over the lowest heat." right after its
// last hot step on the day; every oven side (not the bird, not the main) "Turn the oven
// off and leave the sides inside, covered loosely with foil, to keep warm." right after
// its last oven step. Cook Mode shows only the ones the day's schedule needs
// (cookingScheduler feastWarmSteps): a side that ends near serving keeps its pan, and
// the oven is turned off once, by the side that comes out last. Idempotent.

import { feastRoastDish, isOvenStep, KEEP_WARM_STEP, KEEP_WARM_TEXT, OVEN_OFF_STEP, OVEN_OFF_TEXT, type SchedulerPhase } from "../../src/lib/cookingScheduler";
import { onTheDaySteps } from "../../src/lib/mealTiming";
import { thursdaySchedule, type OvenDish, type OvenStepRow } from "./thx2Oven";
import type { ThursdayEdits } from "./thx2Thursday";

export function warmStepEdits(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): ThursdayEdits {
  const out: ThursdayEdits = { updates: [], deletes: [], creates: [], renumber: [] };
  const bird = feastRoastDish(thursdaySchedule(dishes, steps).schedulerDishes);
  for (const d of dishes) {
    if (bird && d.dishId === bird.dishId) continue;
    if (/\bmain\b/i.test(d.roleLabel ?? "")) continue;
    const rows = steps.filter((s) => s.ownerId === d.dishId).sort((a, b) => a.stepIndex - b.stepIndex);
    if (rows.some((r) => KEEP_WARM_STEP.test(r.stepTextTranslated) || OVEN_OFF_STEP.test(r.stepTextTranslated))) continue;
    const day = onTheDaySteps(rows.map((r) => ({ ...r, text: r.stepTextTranslated })));
    const oven = day.filter((r) => r.phaseType !== "preheat" && isOvenStep({ phaseType: r.phaseType as SchedulerPhase, text: r.text })).pop();
    const hot = day.filter((r) => r.phaseType === "cook").pop();
    const after = oven ?? hot;
    if (!after) continue;
    for (const r of rows.filter((x) => x.stepIndex > after.stepIndex).sort((a, b) => b.stepIndex - a.stepIndex)) {
      out.renumber.push({ dishId: d.dishId, from: r.stepIndex, to: r.stepIndex + 1 });
    }
    out.creates.push({ dishId: d.dishId, stepIndex: after.stepIndex + 1, text: oven ? OVEN_OFF_TEXT : KEEP_WARM_TEXT, phaseType: "assemble", estimatedMinutes: 1 });
  }
  return out;
}
