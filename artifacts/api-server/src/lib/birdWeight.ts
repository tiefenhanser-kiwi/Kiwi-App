// THX-4 (D-WS9-324) — THE TURKEY'S WEIGHT, SET BY THE COOK.
//
// Hans's feasts are written for one bird ("14 pound whole turkey"), and the servings
// rule bought it by the head count (BUG-454's floor: 10 lb at 4 of 10). The cook knows
// the bird they have. A plan item may now carry that weight (MealPlanItem.birdWeightLb,
// ½-lb steps), and four things follow it, all at read time, nothing stored but the
// number:
//   1. the bird's dish — its row and every other row (prepQuantity dishRowMultipliers,
//      `birdLb`): grocery, Prep the feast, the meal screen's amounts;
//   2. the roast — the main roast step's minutes, Cook Mode's clock and the stamp
//      (`birdRoastMinutes`): the bird comes out at the same minute before serving, and
//      the day starts earlier or later;
//   3. the thaw — ⌈lb ÷ 4⌉ fridge days, counted back from the day the bird is first
//      handled (its brine), on the Hub's make-ahead row and in the thaw step;
//   4. the words — the thaw step and the main roast's "about 2¾ hours".
// With no weight chosen, every one of these is exactly what it was.
//
// v1 is whole turkeys only (chat-Claude's call 3): Classic's, Make-Ahead's, New Twist's
// spatchcock and the Buttermilk alternate's (by count). Small's breast still follows
// the servings.

import type { Prisma } from "@prisma/client";

import { dishRowMultipliers, NAME_WEIGHT, weighedTurkeyOf } from "./prepQuantity";
import { isOvenStep, type SchedulerPhase } from "./cookingScheduler";

export type BirdKind = "whole" | "spatchcock";

/** Chat-Claude's call 4: whole bird 8–20 lb, spatchcock 8–16 lb, in ½-lb steps. */
export const BIRD_WEIGHT_STEP_LB = 0.5;
export const BIRD_WEIGHT_RANGE_LB: Readonly<Record<BirdKind, { min: number; max: number }>> = {
  whole: { min: 8, max: 20 },
  // A bird over 16 lb does not lie flat on a half-sheet pan (Phase 0 §4 iii).
  spatchcock: { min: 8, max: 16 },
};

/**
 * A meal whose turkey the cook may weigh: a feast (prepWeekAggregation FEAST_MEAL_TAG —
 * spelled here, as the loader imports this module), or a Thanksgiving turkey alternate
 * on its own.
 */
export const BIRD_MEAL_TAGS: readonly string[] = ["thanksgiving-feast", "course-turkey"];

export interface BirdRow { quantity: number; unit: string; name: string; note?: string | null }

export interface MealBird {
  dishId: string;
  /** The turkey's row in its dish, the recipe's weight (lb) and how it is written. */
  row: number;
  recipeLb: number;
  byCount: boolean;
  kind: BirdKind;
  range: { min: number; max: number; step: number; default: number };
}

const SPATCHCOCK = /\bspatchcock/i;
const roundToStep = (lb: number) => Math.round(lb / BIRD_WEIGHT_STEP_LB) * BIRD_WEIGHT_STEP_LB;

/** The meal's turkey, if the cook may weigh it: the first dish (by position) with a weighable turkey. */
export function mealBirdOf(meal: {
  tags: readonly string[];
  dishes: readonly { dishId: string; title: string; rows: readonly BirdRow[] }[];
}): MealBird | null {
  if (!meal.tags.some((t) => BIRD_MEAL_TAGS.includes(t))) return null;
  for (const d of meal.dishes) {
    const t = weighedTurkeyOf(d.rows);
    if (!t) continue;
    const r = d.rows[t.row];
    const kind: BirdKind = SPATCHCOCK.test(d.title) || SPATCHCOCK.test(r.name) || SPATCHCOCK.test(r.note ?? "") ? "spatchcock" : "whole";
    const { min, max } = BIRD_WEIGHT_RANGE_LB[kind];
    return {
      dishId: d.dishId,
      ...t,
      kind,
      range: { min, max, step: BIRD_WEIGHT_STEP_LB, default: Math.min(max, Math.max(min, roundToStep(t.recipeLb))) },
    };
  }
  return null;
}

/** The meal's turkey from its live rows (one read), or null. */
export async function mealBirdFor(
  prisma: Pick<Prisma.TransactionClient, "meal">,
  mealId: string,
): Promise<MealBird | null> {
  const meal = await prisma.meal.findUnique({
    where: { id: mealId },
    select: {
      tags: true,
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        select: {
          dishId: true,
          dish: { select: { title: true, dishIngredients: { orderBy: { positionIndex: "asc" }, select: { quantity: true, unit: true, preparationNote: true, ingredient: { select: { displayName: true } } } } } },
        },
      },
    },
  });
  if (!meal) return null;
  return mealBirdOf({
    tags: meal.tags ?? [],
    dishes: meal.dishLinks.map((l) => ({
      dishId: l.dishId,
      title: l.dish.title,
      rows: l.dish.dishIngredients.map((di) => ({ quantity: di.quantity, unit: di.unit, name: di.ingredient.displayName, note: di.preparationNote })),
    })),
  });
}

/** Why a weight is refused for this bird (the 400's words), or null when it is fine. */
export function birdWeightProblem(lb: number, bird: Pick<MealBird, "range"> | null): string | null {
  if (!bird) return "this meal has no turkey to weigh";
  const { min, max, step } = bird.range;
  if (!Number.isFinite(lb) || lb < min || lb > max || Math.abs(lb / step - Math.round(lb / step)) > 1e-9) {
    return `birdWeightLb must be ${min}–${max} lb in ½-lb steps`;
  }
  return null;
}

/** The weight the meal shows for its turkey at these servings with nothing chosen (the servings rule). */
export function defaultShownLb(bird: MealBird, rows: readonly BirdRow[], servingsMultiplier: number, feast: boolean): number {
  // The bird row's multiplier × the recipe's weight: pounds by weight, birds × each bird's pounds by count.
  return bird.recipeLb * dishRowMultipliers(rows, servingsMultiplier, { feast })[bird.row];
}

// ── 2. THE ROAST ──────────────────────────────────────────────────────────────
//
// Chat-Claude's call 2: roast minutes = the chosen weight × the recipe's own minutes
// per pound, never under USDA's low end for its method. FSIS's unstuffed whole turkey
// at 325°F: 8–12 lb 2¾–3 h · 12–14 lb 3–3¾ h · 14–18 lb 3¾–4¼ h · 18–20 lb 4¼–4½ h ·
// 20–24 lb 4½–5 h. A weight on a bracket's edge takes the lighter bracket (a 14-lb
// bird is "12–14 lb"), so Make-Ahead's 171 minutes at 14 lb rise to 180. FSIS has no
// spatchcock table: a spatchcock bird keeps its own rate (New Twist's 7.4 min/lb).
const USDA_WHOLE_LOW: ReadonlyArray<readonly [number, number]> = [[12, 165], [14, 180], [18, 225], [20, 255], [24, 270]];

/** FSIS's low end for an unstuffed whole turkey of this weight, in minutes. */
export function usdaWholeLowMinutes(lb: number): number {
  for (const [upTo, min] of USDA_WHOLE_LOW) if (lb <= upTo + 1e-9) return min;
  return USDA_WHOLE_LOW[USDA_WHOLE_LOW.length - 1][1];
}

/** The bird's oven cook minutes at the chosen weight. */
export function birdRoastMinutes(kind: BirdKind, authoredCookMinutes: number, recipeLb: number, chosenLb: number): number {
  const own = Math.round((chosenLb * authoredCookMinutes) / recipeLb);
  return kind === "whole" ? Math.max(own, usdaWholeLowMinutes(chosenLb)) : own;
}

export interface RoastStep { stepIndex: number; estimatedMinutes: number; phaseType: string; text?: string | null }

/**
 * The main roast's new minutes: the bird dish's on-the-day oven `cook` steps are its
 * roast; the longest of them (the main roast) takes the whole change, and the finish
 * after the raise, the rest and the carve keep theirs. Null when the dish has no oven
 * cook step (nothing to move).
 */
export function birdRoastEdit(
  daySteps: readonly RoastStep[],
  bird: Pick<MealBird, "kind" | "recipeLb">,
  chosenLb: number,
): { stepIndex: number; minutes: number; authoredMinutes: number; cookMinutes: number } | null {
  const cooks = daySteps.filter((s) => s.phaseType === "cook" && isOvenStep({ phaseType: s.phaseType as SchedulerPhase, text: s.text ?? "" }));
  if (cooks.length === 0) return null;
  const authored = cooks.reduce((n, s) => n + Math.max(1, s.estimatedMinutes), 0);
  const main = cooks.reduce((a, b) => (b.estimatedMinutes > a.estimatedMinutes ? b : a));
  const target = birdRoastMinutes(bird.kind, authored, bird.recipeLb, chosenLb);
  const minutes = Math.max(1, Math.max(1, main.estimatedMinutes) + target - authored);
  return { stepIndex: main.stepIndex, minutes, authoredMinutes: main.estimatedMinutes, cookMinutes: authored - Math.max(1, main.estimatedMinutes) + minutes };
}

/**
 * The scheduler's dishes with the bird's main roast at the chosen weight (Cook Mode's
 * sequence and the stamp read the same). Unchanged when the bird's dish is not there.
 */
export function withBirdRoast<D extends { dishId: string; steps: readonly RoastStep[] }>(
  dishes: readonly D[],
  bird: Pick<MealBird, "dishId" | "kind" | "recipeLb">,
  chosenLb: number,
): D[] {
  return dishes.map((d) => {
    if (d.dishId !== bird.dishId) return d;
    const edit = birdRoastEdit(d.steps, bird, chosenLb);
    if (!edit) return d;
    return { ...d, steps: d.steps.map((s) => (s.stepIndex === edit.stepIndex ? { ...s, estimatedMinutes: edit.minutes } : s)) };
  });
}

// ── 3. THE THAW ───────────────────────────────────────────────────────────────
//
// FSIS: "allow approximately 24 hours for every 4 to 5 pounds" in the fridge. ⌈lb ÷ 4⌉
// is the slower end, and the bird must be thawed by the day it is first handled — its
// brine (Wednesday night for Classic and New Twist, Tuesday night for Make-Ahead) — or
// the feast day when nothing handles it sooner.

/** Fridge days for a bird of this weight. */
export function thawFridgeDays(lb: number): number {
  return Math.ceil(lb / 4 - 1e-9);
}

/** Days before the feast the thaw starts: the handling day's lead plus the fridge days. */
export function thawLeadDays(lb: number, handlingLeadDays: number): number {
  return handlingLeadDays + thawFridgeDays(lb);
}

// ── 4. THE WORDS ──────────────────────────────────────────────────────────────

const GLYPH: Record<number, string> = { 0.25: "¼", 0.5: "½", 0.75: "¾" };

/** 16 → "16", 16.5 → "16½". */
export function poundsWords(lb: number): string {
  const whole = Math.floor(lb + 1e-9);
  const frac = Math.round((lb - whole) * 4) / 4;
  return `${whole}${GLYPH[frac] ?? ""}`;
}

/** 165 → "about 2¾ hours", 60 → "about 1 hour", 45 → "about 45 minutes" (¼ hours from an hour, 5 minutes under). */
export function aboutDuration(minutes: number): string {
  const five = Math.max(5, Math.round(minutes / 5) * 5);
  if (five < 60) return `about ${five} minutes`;
  const q = Math.round(minutes / 15) / 4;
  return `about ${poundsWords(q)} ${q === 1 ? "hour" : "hours"}`;
}

/** The code-written thaw step (feastAddedDish's phrase, with the bird's weight and days). */
export function birdThawStepText(args: { birdWord: string; lb: number; startDay: string; readyBy: string }): string {
  const days = thawFridgeDays(args.lb);
  return `Thaw (start ${args.startDay}): If the ${args.birdWord} is frozen, move it to the fridge on ${args.startDay} — a ${poundsWords(args.lb)}-lb bird takes about ${days} ${days === 1 ? "day" : "days"} to thaw fully, so it is ready by ${args.readyBy}.`;
}

/**
 * SERVER-6 BUG-537 — A TURKEY WRITTEN BY COUNT SAYS THE WEIGHT THE COOK CHOSE. Its
 * weight is in its name ("1 whole turkey (12–14 lb)", New Twist's) or its note (the
 * Buttermilk alternate's "12–14 lb, neck and giblets removed"); with a weight chosen,
 * that text says the chosen one ("16 lb"). A by-weight bird's quantity already says it.
 *
 * DISPLAY ONLY, and applied after the row multipliers: weighedTurkeyOf reads the
 * recipe's weight out of this same text, so the rows must still be scaled from the
 * original. `name` gains " (16 lb)" when neither its name nor its note carried a
 * weight to rewrite, so the line itself always says it.
 */
export function birdLineAtWeight(row: { name: string; note: string | null }, chosenLb: number): { name: string; note: string | null } {
  const said = `${poundsWords(chosenLb)} lb`;
  const rewrite = (s: string) => {
    const m = NAME_WEIGHT.exec(s);
    return m ? s.slice(0, m.index) + said + s.slice(m.index + m[0].length) : null;
  };
  const name = rewrite(row.name);
  const note = row.note ? rewrite(row.note) : null;
  return { name: name ?? `${row.name} (${said})`, note: note ?? row.note };
}

const NUM = String.raw`(?:\d+(?:\.\d+)?[¼½¾]?|[¼½¾]|an?|one|two|three|four|five)`;
/** "about 2¾ hours", "for about 1 hour", "about 3 to 3½ hours" — never "about 25 more minutes" (the finish). */
const ROAST_DURATION = new RegExp(String.raw`\babout ${NUM}(?:\s*(?:to|–|-)\s*${NUM})?\s+(?:hours?|minutes?)\b`, "i");
/** "for a 12–14 lb bird", "for a 14-lb turkey". */
const FOR_A_WEIGHT = /\bfor an? \d+(?:\.\d+)?(?:\s*(?:–|-|to)\s*\d+(?:\.\d+)?)?\s*[-‑]?\s*(?:lbs?|pounds?)\s+(bird|turkey)\b/i;

export interface WordRef { charStart: number; charEnd: number }
type Edit = { start: number; end: number; text: string };

/** Apply edits to a step's text; a ref inside an edit goes, the rest move with the text. */
export function editStep<R extends WordRef>(text: string, refs: readonly R[] | null, edits: readonly Edit[]): { text: string; amountRefs: R[] | null } {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  const shift: { at: number; by: number }[] = [];
  for (const e of sorted) {
    if (e.start < cursor) continue;
    out += text.slice(cursor, e.start) + e.text;
    shift.push({ at: e.end, by: e.text.length - (e.end - e.start) });
    cursor = e.end;
  }
  out += text.slice(cursor);
  if (!refs) return { text: out, amountRefs: null };
  const moved: R[] = [];
  for (const r of refs) {
    if (sorted.some((e) => r.charStart < e.end && e.start < r.charEnd)) continue;
    const by = shift.filter((s) => s.at <= r.charStart).reduce((t, s) => t + s.by, 0);
    moved.push({ ...r, charStart: r.charStart + by, charEnd: r.charEnd + by });
  }
  return { text: out, amountRefs: moved };
}

/** "A frozen 14-lb turkey thaws 3–4 days" (the Buttermilk alternate's brine step). */
const FROZEN_THAWS = /\b(\d+(?:\.\d+)?)-lb (turkey|bird) thaws (?:about )?\d+(?:\s*(?:–|-|to)\s*\d+)? days?\b/i;
/** "Pat the 14-lb turkey dry" (Make-Ahead's dry brine). */
const N_LB_BIRD = /\b(\d+(?:\.\d+)?)-lb (turkey|bird)\b/gi;

/**
 * SERVER-8 B (D-WS9-341) — the bird's other weight words, said for this weight: "a
 * frozen 16-lb turkey thaws about 4 days" (⌈lb ÷ 4⌉, the thaw step's rule) and "the
 * 16-lb turkey". An edit that would write what is there already is left out, so its
 * amountRefs stay.
 */
export function birdWeightWordEdits(text: string, lb: number): Edit[] {
  const edits: Edit[] = [];
  const f = FROZEN_THAWS.exec(text);
  if (f) {
    const days = thawFridgeDays(lb);
    edits.push({ start: f.index, end: f.index + f[0].length, text: `${poundsWords(lb)}-lb ${f[2]} thaws about ${days} ${days === 1 ? "day" : "days"}` });
  }
  for (const m of text.matchAll(N_LB_BIRD)) {
    if (f && m.index! >= f.index && m.index! < f.index + f[0].length) continue;
    edits.push({ start: m.index!, end: m.index! + m[0].length, text: `${poundsWords(lb)}-lb ${m[2]}` });
  }
  return edits.filter((e) => text.slice(e.start, e.end) !== e.text);
}

/** The main roast step's duration said for its new minutes; a stated bird weight said as the chosen one. */
export function roastStepEdits(text: string, minutes: number, chosenLb: number): Edit[] {
  const edits: Edit[] = [];
  const d = ROAST_DURATION.exec(text);
  if (d) edits.push({ start: d.index, end: d.index + d[0].length, text: aboutDuration(minutes) });
  const w = FOR_A_WEIGHT.exec(text);
  if (w && !(d && w.index < d.index + d[0].length && d.index < w.index + w[0].length)) {
    edits.push({ start: w.index, end: w.index + w[0].length, text: `for a ${poundsWords(chosenLb)}-lb ${w[1]}` });
  }
  return edits;
}
