// QA-COOK-1 — a Cook Mode session as the app shows it, built with the APP'S OWN
// pure functions (kiwi/lib/cooking), not a copy of them:
//
//   • order: app/cook-session.tsx — a feast cooks onTheDayMeal(meal); a multi-dish
//     meal with no meal-owned steps takes sequenceMealSteps(meal, sequence,
//     mergedSteps); anything else flattenMealSteps(meal);
//   • text: the screen renders each step's amountRefs through
//     buildAmountRefSegments at the meal's scale (mealScaleFactors over
//     resolveAmountMultiplier(effectiveServings, authoredServingsDefault));
//   • prepped: doneInPrepStepKeys over the plan's prep-week result and its
//     completions (the fold), and the server's preppedRefs (the chips).
//
// The kiwi files are imported by relative path; every import they make at
// runtime is relative too (the "@/…" ones are type-only and erased).
import * as cookSessionNs from "../../../kiwi/lib/cooking/cookSession";
import * as feastDayNs from "../../../kiwi/lib/cooking/feastDay";
import * as amountNs from "../../../kiwi/lib/cooking/amountSegments";
import * as quantityNs from "../../../kiwi/lib/format/quantity";
import { isServedCold } from "../../src/lib/cookingScheduler";

import type { CookView, SampleCategory, ShownStep } from "./types";

// The kiwi package is CommonJS to tsx, and ESM's static detection does not see
// all of its named exports: read each module through its namespace.
const cjs = <T>(ns: T): T => (ns as { default?: T }).default ?? ns;
const { doneInPrepStepKeys, flattenMealSteps, prepRecap, resolveAmountMultiplier, sequenceMealSteps } = cjs(cookSessionNs);
const { onTheDayMeal } = cjs(feastDayNs);
const { buildAmountRefSegments } = cjs(amountNs);
const { isFeastMeal, mealScaleFactors, ONE_BIRD } = cjs(quantityNs);

export interface SequenceReply {
  sequence: { dishId: string; originalStepIndex: number; sequenceIndex: number; startOffsetMinutes: number; reason?: string }[];
  totalEstimatedMinutes: number;
  mergedSteps?: { dishId: string; originalStepIndex: number }[];
}

export interface PrepEvidence {
  /** The prep-week envelope's `result` (phases → steps). */
  result: any;
  /** The completions' step keys (what the cook ticked). */
  checked: string[];
  completions: { stepKey: string; checkedAt: string }[];
}

/** cook-session.tsx:133 — the Sequencer runs only for a genuine multi-dish meal with no meal-owned steps. */
export function isMultiDish(meal: any): boolean {
  return (meal.steps?.length ?? 0) === 0 && (meal.dishes?.length ?? 0) > 1;
}

export function buildCookView(args: {
  meal: any;
  sequence: SequenceReply | null;
  prep: PrepEvidence | null;
  sourceMealId: string;
  category: SampleCategory;
  servings: number;
}): CookView {
  const { meal, sequence, prep } = args;
  const multi = isMultiDish(meal);
  const feast = isFeastMeal(meal.tags);
  const onDay = onTheDayMeal(meal);
  const steps = multi && sequence ? sequenceMealSteps(onDay, sequence.sequence as any, sequence.mergedSteps ?? []) : flattenMealSteps(onDay);

  const multiplier = resolveAmountMultiplier(meal.effectiveServings, meal.authoredServingsDefault);
  const scale = mealScaleFactors(meal.dishes, multiplier, feast, meal.birdWeightLb);
  const folded = prep ? doneInPrepStepKeys(steps, prep.result, meal.id, new Set(prep.checked)) : new Set<string>();
  const recap = prep ? prepRecap(prep.result, meal.id, prep.completions, new Date()).items : [];

  // parallelGroup is on the wire step but not on CookStep: read it back by key.
  const pg = new Map<string, string | null>();
  for (const d of meal.dishes ?? []) for (const s of d.steps ?? []) pg.set(`${d.dishId}#${s.stepIndex}`, s.parallelGroup ?? null);

  const shown: ShownStep[] = steps.map((s, i) => {
    const factor = s.dishId ? scale.byDish[s.dishId] ?? multiplier : scale.mealOwned;
    const birds = s.dishId ? scale.birds[s.dishId] ?? ONE_BIRD : scale.mealOwnedBirds;
    const text = buildAmountRefSegments(s.text, s.amountRefs ?? null, factor, birds).map((x) => x.text).join("");
    return {
      n: i + 1,
      key: s.key,
      ...(s.dishId !== undefined ? { dishId: s.dishId, stepIndex: s.stepIndex } : {}),
      ...(s.dishTitle ? { dishTitle: s.dishTitle } : {}),
      text,
      phaseType: s.phaseType,
      estimatedMinutes: s.estimatedMinutes,
      isTimingSensitive: !!s.isTimingSensitive,
      parallelGroup: s.dishId ? pg.get(`${s.dishId}#${s.stepIndex}`) ?? null : null,
      ...(s.cue ? { cue: s.cue } : {}),
      ...(s.startOffsetMinutes !== undefined ? { startOffsetMinutes: s.startOffsetMinutes } : {}),
      doneInPrep: folded.has(s.key),
      preppedLabels: (s.preppedRefs ?? []).map((r: { label: string }) => r.label),
    };
  });

  return {
    sourceMealId: args.sourceMealId,
    title: meal.displayTitle ?? meal.title,
    category: args.category,
    servings: args.servings,
    authoredServings: meal.authoredServingsDefault ?? meal.dishes?.[0]?.authoredServingsDefault ?? meal.servingsDefault ?? args.servings,
    prepped: !!prep,
    multiDish: multi,
    isFeast: feast,
    dishes: (meal.dishes ?? []).map((d: any) => ({ dishId: d.dishId, title: d.displayTitle ?? d.title, servedCold: isServedCold({ title: d.title }), ingredientNames: (d.ingredients ?? []).map((i: any) => String(i.name)) })),
    steps: shown,
    totalMinutes: multi && sequence ? sequence.totalEstimatedMinutes : shown.reduce((n, s) => n + (s.estimatedMinutes ?? 0), 0),
    recap,
  };
}

/** The screen, as text: what a persona is shown one step at a time, and what a report quotes. */
export function stepCard(v: CookView, s: ShownStep): string {
  const parts: string[] = [];
  parts.push(`Step ${s.n} of ${v.steps.length}${s.dishTitle ? ` · ${s.dishTitle}` : ""}${s.estimatedMinutes ? ` · ~${s.estimatedMinutes} min` : ""}`);
  if (s.doneInPrep) parts.push("(Done in prep — folded; you already did this in Prep the Week.)");
  if (s.cue) parts.push(`Tip: ${s.cue}`);
  parts.push(s.text);
  if (s.preppedLabels.length) parts.push(`You prepped this: ${s.preppedLabels.join(", ")}`);
  return parts.join("\n");
}
