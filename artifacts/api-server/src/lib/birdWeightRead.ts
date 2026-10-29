// THX-4 (D-WS9-324) — GET /meals/:id?planItemId=: THE TURKEY'S WEIGHT ON THE MEAL READ.
//
// A meal read in its plan carries what the client needs to draw the stepper with no
// rules of its own — the bird's kind, the range, the weight chosen (or null) and the
// weight the line shows now — and, when a weight is chosen, the bird's steps said for
// it: the thaw step code-written for its days (makeAheadSchedule weighedThaw, the Hub's
// row's own arithmetic), and the main roast's minutes and its "about 2¾ hours"
// (birdWeight). SERVER-8 B (D-WS9-341): with none chosen, all of it at the recipe's weight. Read time only; the stored recipe keeps its authored words. Every
// amountRef moves with its text, as feastScaleFrames does.
//
// SERVER-7 A (D-WS9-337) — the thaw is the weight rule's with no weight chosen too, at
// the recipe's weight, and the bird row's note says its day.

import type { PrismaClient } from "@prisma/client";

import {
  birdRoastEdit,
  birdThawStepText,
  birdWeightWordEdits,
  defaultShownLb,
  editStep,
  mealBirdOf,
  roastStepEdits,
  type BirdKind,
} from "./birdWeight";
import { feastDowOf, weighedThaw } from "./makeAheadSchedule";
import { onTheDaySteps } from "./mealTiming";
import { FEAST_MEAL_TAG } from "./prepWeekAggregation";
import { hasUnmatchedAmount, type AmountRef } from "./stepAmountRefs";

/** The fields a bird meal's plan-context read adds (absent on every other read). */
export interface BirdReadFields {
  birdKind: BirdKind;
  /** The weight the cook chose, or null (the default bird). */
  birdWeightLb: number | null;
  birdWeightRange: { min: number; max: number; step: number; default: number };
  /** The weight the bird's line shows now: the chosen one, or the servings rule's (¼ lb). */
  birdShownLb: number;
}

interface ReadStep {
  stepIndex: number;
  text: string;
  estimatedMinutes: number;
  phaseType: string;
  amountRefs: AmountRef[] | null;
  unmatchedAmount: boolean;
}
interface ReadDish {
  dishId: string;
  title: string;
  servings: number;
  authoredServingsDefault: number;
  ingredients: { name: string; quantity: number; unit: string; preparationNote: string | null }[];
  steps: ReadStep[];
}

const THAW_STEP = /^\s*thaw \(\s*start\s+[a-z]+\s*\)\s*:/i;
const quarter = (lb: number) => Math.round(lb * 4) / 4;

/**
 * Adds the bird fields to a meal read in its plan, and says the bird's steps for a
 * chosen weight. `storedTexts` are the dish's step texts before any read-time wording
 * (the brine's "Make ahead (<Day> night):" is read from them). Returns the fields, or
 * null when the meal has no turkey the cook may weigh (nothing is touched).
 */
export async function applyBirdWeightToRead(
  prisma: Pick<PrismaClient, "dish">,
  meal: { tags: readonly string[] | null; dishes: ReadDish[] },
  item: { birdWeightLb: number | null; servingsOverride: number | null; assignedDayOfWeek: string | null },
  storedTexts: ReadonlyMap<string, readonly string[]>,
): Promise<BirdReadFields | null> {
  const tags = meal.tags ?? [];
  const rowsOf = (d: ReadDish) => d.ingredients.map((i) => ({ quantity: i.quantity, unit: i.unit, name: i.name, note: i.preparationNote }));
  const bird = mealBirdOf({ tags, dishes: meal.dishes.map((d) => ({ dishId: d.dishId, title: d.title, rows: rowsOf(d) })) });
  if (!bird) return null;
  const dish = meal.dishes.find((d) => d.dishId === bird.dishId)!;
  const feast = tags.includes(FEAST_MEAL_TAG);
  const chosen = item.birdWeightLb;
  const authored = dish.authoredServingsDefault > 0 ? dish.authoredServingsDefault : 1;
  const fields: BirdReadFields = {
    birdKind: bird.kind,
    birdWeightLb: chosen,
    birdWeightRange: bird.range,
    birdShownLb: chosen ?? quarter(defaultShownLb(bird, rowsOf(dish), (item.servingsOverride ?? dish.servings) / authored, feast)),
  };

  const say = (st: ReadStep, edits: Parameters<typeof editStep>[2]) => {
    if (edits.length === 0) return;
    const out = editStep(st.text, st.amountRefs, edits);
    st.text = out.text;
    st.amountRefs = out.amountRefs;
    st.unmatchedAmount = hasUnmatchedAmount(out.text, out.amountRefs);
  };

  // The main roast: its minutes (TimerChip reads estimatedMinutes) and its duration words.
  // 🔴 SERVER-8 B (D-WS9-341) — NO WEIGHT IS THE RECIPE'S WEIGHT. With none chosen the
  // roast is said at the recipe's own weight, FSIS's floor and all, so a plan with no
  // weight reads exactly as one set to the recipe's weight (Make-Ahead's main roast was
  // 131 minutes with none and 140 at its own 14 lb). And the bird's other weight words
  // follow the same weight ("Pat the 14-lb turkey dry", "A frozen 14-lb turkey thaws 3–4
  // days"), as the thaw step does.
  const lb = chosen ?? bird.recipeLb;
  const day = feast ? onTheDaySteps(dish.steps) : dish.steps;
  const roast = birdRoastEdit(day, bird, lb);
  if (roast) {
    const st = dish.steps.find((s) => s.stepIndex === roast.stepIndex)!;
    st.estimatedMinutes = roast.minutes;
    say(st, roastStepEdits(st.text, roast.minutes, lb));
  }
  for (const st of dish.steps) if (!THAW_STEP.test(st.text)) say(st, birdWeightWordEdits(st.text, lb));

  // 🔴 SERVER-7 A (BUG-559, D-WS9-337) — THE THAW, WEIGHT OR NO WEIGHT. The authored
  // "6 days, Friday" for a 14-lb bird left it thawed about 2½ days before the roast, and
  // USDA keeps a thawed bird 1–2 days. With no weight chosen the thaw is the weight
  // rule's at the recipe's own weight, so the authored weight and no weight say the same
  // thaw. The thaw step is code-written, and the bird row's note says that start day
  // ("move from freezer to fridge Saturday"). Thaw lines only: a null-weight read is
  // otherwise what it was.
  const thaw = dish.steps.find((s) => THAW_STEP.test(s.text));
  const noted = dish.ingredients.filter((r, i) => i === bird.row && r.preparationNote !== null && NOTE_THAW_DAY.test(r.preparationNote));
  if (thaw || noted.length > 0) {
    const row = await prisma.dish.findUnique({ where: { id: dish.dishId }, select: { tags: true } });
    const plan = weighedThaw({ tags: row?.tags ?? [], stepTexts: storedTexts.get(dish.dishId) ?? dish.steps.map((s) => s.text), feastDow: feastDowOf(item.assignedDayOfWeek), lb });
    if (thaw) say(thaw, [{ start: 0, end: thaw.text.length, text: birdThawStepText({ birdWord: "turkey", lb, startDay: plan.startDay, readyBy: plan.readyBy }) }]);
    for (const r of noted) r.preparationNote = r.preparationNote!.replace(NOTE_THAW_DAY, (_m, lead: string) => `${lead}${plan.startDay}`);
  }
  return fields;
}

// The thaw day a bird row's note names: Classic's "thawed (move from freezer to fridge
// Friday if frozen); …".
const NOTE_THAW_DAY = /(\bfreezer to (?:the )?fridge (?:on )?)(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i;
