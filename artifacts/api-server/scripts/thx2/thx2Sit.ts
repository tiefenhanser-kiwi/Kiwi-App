// THX-3d round 3 (U) — THE PREHEAT AND THE BIRD'S PREP RIDE ITS SIT (content, patch.ts).
//
// Classic's turkey sat 79 minutes, not 60: the sit, THEN the preheat, the herb butter and
// the cavity, THEN the roast. The work between the sit and the roast happens while the
// bird sits, so the roast begins as the sit ends. Written as the scheduler's own
// intra-dish overlap (D-WS9-239's parallelGroup): the sit is the window (a hold, hands
// free), the steps after it up to the roast are its riders. Small's breast and New
// Twist's spatchcock sit 45 minutes the same way. Idempotent: a step already tagged is
// left alone.

import { feastRoastDish, isOvenStep, type SchedulerPhase } from "../../src/lib/cookingScheduler";
import { onTheDaySteps } from "../../src/lib/mealTiming";
import { thursdaySchedule, type OvenDish, type OvenStepRow } from "./thx2Oven";

/** The token the sit and its riders carry. */
export const SIT_GROUP = "sit";

const SIT = /\bsit at room temperature\b|\bfrom the fridge\b[^.;]*\bbefore roasting\b|\bbefore roasting\b/i;

/** The bird's sit and the steps that ride it: (dishId, stepIndex) → the group they need. */
export function sitRiderGroups(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): { dishId: string; stepIndex: number; group: string }[] {
  const { schedulerDishes } = thursdaySchedule(dishes, steps);
  const roast = feastRoastDish(schedulerDishes);
  if (!roast) return [];
  const own = steps.filter((s) => s.ownerId === roast.dishId).sort((a, b) => a.stepIndex - b.stepIndex);
  const day = onTheDaySteps(own.map((s) => ({ ...s, text: s.stepTextTranslated })));
  const sitAt = day.findIndex((s) => s.phaseType === "hold" && SIT.test(s.text));
  if (sitAt < 0) return [];
  const riders: typeof day = [];
  for (const s of day.slice(sitAt + 1)) {
    if (s.phaseType === "cook" && isOvenStep({ phaseType: s.phaseType as SchedulerPhase, text: s.text })) break;
    riders.push(s);
  }
  if (riders.length === 0) return [];
  // A preheat right before the sit (New Twist's) is already running as the bird sits:
  // it opens the group, the sit and the prep ride it.
  const lead = sitAt > 0 && day[sitAt - 1].phaseType === "preheat" ? [day[sitAt - 1]] : [];
  return [...lead, day[sitAt], ...riders].map((s) => ({ dishId: roast.dishId, stepIndex: s.stepIndex, group: SIT_GROUP }));
}
