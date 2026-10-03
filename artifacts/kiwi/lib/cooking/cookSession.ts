// WS7-8b Block 3 — pure engine for the single-meal Cook Mode (app/cook-session.tsx).
//
// All non-React logic lives here so it's unit-testable in node:test: flatten a
// loaded recipe into an ordered step list, the three-state prep gate, the
// prepped path (which cook steps Prep the Week already did, and the recap of
// what was prepped), and the best-effort inline-quantity highlighter.
//
// CRITICAL INVARIANT: prep state is read ONLY from plan/instance context
// (PlanDetailItem.isPrepped via usePlan, the plan's prep-week payload and its
// completions). The Meal/Dish recipe shapes are RENDER-ONLY — nothing here
// reads or writes a prep flag on a Meal/Dish. Nothing here writes at all.

import type { PrepCompletionRow, PrepWeekResult, SequencedStep } from "@/lib/api/cooking";
import type { DishDetail } from "@/lib/api/dishes";
import type { AmountRef, MealDetail, MealStep } from "@/lib/api/meals";

// WS7-8b Block 4 (Block 1) — four shared primitives were lifted out of this
// module into dedicated, screen-agnostic homes so the Week Prep screen can
// import them too. They are RE-EXPORTED here unchanged so every existing
// importer (and the Cook Mode tests) keeps resolving them from cookSession.
export { highlightQuantities, type TextSegment } from "./quantityHighlight";
export {
  formatClock,
  isTimerDone,
  timerRemainingMs,
  type ActiveTimer,
} from "./timer";
export { remainingMinutes, remainingMinutesToServe } from "./stepTiming";

/**
 * WS7-8b BUG-006 — the multiplier Cook Mode renders amountRefs through, so the
 * cook screen scales to the SAME quantities as Meal Detail. Numerator is the
 * plan-resolved effectiveServings (servingsOverride ?? servingsDefault);
 * denominator is the authored servingsDefault. NEVER effectiveServings on both
 * sides (that collapses to 1). The dishId launch path passes 1 directly
 * (standalone dish has no plan override — D-WS7-175).
 *
 * Guard: a 0/missing/non-finite authored denominator falls back to 1 rather
 * than dividing by zero / emitting NaN.
 */
export function resolveAmountMultiplier(
  effectiveServings: number,
  servingsDefault: number,
): number {
  if (!Number.isFinite(servingsDefault) || servingsDefault <= 0) return 1;
  if (!Number.isFinite(effectiveServings) || effectiveServings <= 0) return 1;
  return effectiveServings / servingsDefault;
}

/**
 * WS7-8b BUG-006 follow-up — params for launching Cook Mode for a meal. Plan
 * context (planId + planItemId) is included ONLY when BOTH are present, so Cook
 * Mode's useMeal(mealId, planItemId) resolves the per-instance servingsOverride
 * and scales correctly. A Library launch (no plan context) passes just
 * { mealId } → base amounts, which is correct there. Never fabricates a
 * planItemId. Mirrors the plan-card path (PlanReviewMealRow.tsx).
 */
export function buildCookSessionParams(args: {
  mealId: string;
  planId?: string;
  planItemId?: string;
}): Record<string, string> {
  const { mealId, planId, planItemId } = args;
  return planId && planItemId ? { mealId, planId, planItemId } : { mealId };
}

/** One flattened, ordered step in a cook session. */
export interface CookStep {
  /** Stable identity for keys/scroll maps/timer state (source-scoped, not a server stepKey). */
  key: string;
  text: string;
  phaseType: string;
  estimatedMinutes: number;
  /**
   * K-R7 — the recipe identity of a DISH step: its dish and its persisted
   * `stepIndex` (the Sequencer's `originalStepIndex`, not the array position).
   * This is the key a prep step's `coversCookSteps` names. Absent on meal-owned
   * steps and on a dishId launch, which no prep step can cover.
   */
  dishId?: string;
  stepIndex?: number;
  /** §13.5.2 — the server's timing-sensitive flag; drives the "do this soon"
   *  treatment + an auto-suggested timer chip. */
  isTimingSensitive: boolean;
  /** Set only for multi-dish meals, to label which dish a step belongs to. */
  dishTitle?: string;
  /** WS7-8b BUG-003 Block 1 — sidecar step→ingredient refs. Ref-bearing steps
   *  render the structured amount instead of the highlightQuantities regex;
   *  null/absent on legacy + sequenced-path steps → regex fallback. */
  amountRefs?: AmountRef[] | null;
  /**
   * Sequencer parallel-cue (the server-composed `reason`, e.g. "While the
   * chicken rests, start the sauce"). Set only on the multi-dish sequenced
   * path. A suggestion, never blocking — it's a plain annotation on a real
   * step, so advancement is never gated on it (PRD §13.9).
   */
  cue?: string;
  /**
   * WS9 BUG-337 / D-WS9-297 ruling 5 — the server's serve-anchored offset
   * (0 = serve, negative = minutes before serve), set ONLY on the sequenced
   * path. This is what the footer's "~N min left" is computed from; it is the
   * scheduler's own wall-clock, so the screen can no longer disagree with the
   * card. Absent on the flatten paths and on §27's defensive append, where
   * `remainingMinutes` is still the only answer available.
   */
  startOffsetMinutes?: number | null;
}

function toCookStep(
  s: MealStep,
  key: string,
  dishTitle?: string,
  dishId?: string,
): CookStep {
  return {
    key,
    text: s.text,
    phaseType: s.phaseType,
    estimatedMinutes: s.estimatedMinutes,
    ...(dishId !== undefined ? { dishId, stepIndex: s.stepIndex } : {}),
    isTimingSensitive: s.isTimingSensitive,
    dishTitle,
    amountRefs: s.amountRefs ?? null,
  };
}

/**
 * Flatten a meal into ordered cook steps. Mirrors the meal-detail render rule
 * (meal/[id].tsx): meal-owned `steps` win when present; otherwise dish steps in
 * dish order, then stepIndex. Multi-dish ordering is naive (by dish, then
 * index) — the real Sequencer is Build Block 2. dishTitle is attached only for
 * a genuine multi-dish meal so single-dish meals stay label-free.
 */
export function flattenMealSteps(meal: MealDetail): CookStep[] {
  if (meal.steps.length > 0) {
    return meal.steps.map((s, i) => toCookStep(s, `meal#${i}`));
  }
  const multiDish = meal.dishes.length > 1;
  const out: CookStep[] = [];
  meal.dishes.forEach((dish) => {
    dish.steps.forEach((s, i) => {
      out.push(
        toCookStep(s, `${dish.dishId}#${i}`, multiDish ? dish.title : undefined, dish.dishId),
      );
    });
  });
  return out;
}

/** Flatten a single dish (dishId launch) — flat stepIndex order, no labels. */
export function flattenDishSteps(dish: DishDetail): CookStep[] {
  return dish.steps.map((s, i) => toCookStep(s, `dish#${i}`));
}

/**
 * WS7-8b Build Block 2B — apply a Cooking Sequencer result to a multi-dish meal.
 * Produces ONE unified, intermixed execution flow (steps from all dishes in the
 * sequencer's order) with each entry's server-composed `reason` attached as a
 * parallel cue (PRD §13.5.4 / §13.9). Multi-dish only; every step keeps its
 * dish label.
 *
 * The join is on (dishId, stepIndex) — the sequence references the source step
 * by its DB `originalStepIndex`, NOT its array position, so we key the lookup on
 * `MealStep.stepIndex`. Pure + read-only: nothing here mutates the meal or
 * writes a flag.
 *
 * DATA-INTEGRITY GUARANTEE (§27): no source step is ever dropped. Any sequence
 * entry that fails to map (unknown dishId/stepIndex, or a duplicate reference)
 * is skipped, and any source step the sequence omits is appended afterward in
 * naive (dish, then stepIndex) order. The output therefore always contains
 * exactly the meal's full step set, sequenced where possible.
 */
export function sequenceMealSteps(
  meal: MealDetail,
  sequence: SequencedStep[],
): CookStep[] {
  // Lookup + naive fallback order, both keyed by (dishId, stepIndex). Multi-dish
  // by contract, so a dish label is always attached.
  const byKey = new Map<string, { step: MealStep; dishTitle: string; dishId: string }>();
  const naiveOrder: string[] = [];
  for (const dish of meal.dishes) {
    for (const s of dish.steps) {
      const k = `${dish.dishId}#${s.stepIndex}`;
      if (!byKey.has(k)) {
        byKey.set(k, { step: s, dishTitle: dish.title, dishId: dish.dishId });
        naiveOrder.push(k);
      }
    }
  }

  const out: CookStep[] = [];
  const used = new Set<string>();
  // Walk the sequence in execution order. The server emits sequenceIndex sorted,
  // but a render must never trust upstream ordering — sort defensively.
  const ordered = [...sequence].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  for (const entry of ordered) {
    const k = `${entry.dishId}#${entry.originalStepIndex}`;
    const hit = byKey.get(k);
    if (!hit || used.has(k)) continue; // unmappable or duplicate → defer to append.
    used.add(k);
    out.push({
      ...toCookStep(hit.step, k, hit.dishTitle, hit.dishId),
      cue: entry.reason,
      startOffsetMinutes: entry.startOffsetMinutes,
    });
  }

  // ── §27 DEFENSIVE APPEND — WHAT IT IS ACTUALLY FOR, AS OF [grocery] B3 ────
  //
  // Any step the sequence omitted (or that failed to map) is appended in naive
  // order so the flow NEVER loses a step.
  //
  // ⚠️ THE REASON CHANGED AND THE CODE DID NOT. It used to carry a swappable
  // component's `bought` steps: the scheduler dropped them at its input while
  // the meal detail still returned them, so they arrived here and trailed. B3
  // (D-WS9-277 Rule 3) ended that — `selectDefaultPathSteps` is now per-
  // component, and BOTH sides run the same predicate over the same rows
  // (routes/meals.ts composeLoadedMealDetail, cookingScheduler
  // scheduleCookingSequence). Measured on the 10 dev components with a
  // bought-only path: every one returns exactly one path, and "components
  // carrying two paths" is 0. So that class is empty, and nothing here can
  // append a second path — it only ever re-emits steps `meal.dishes[].steps`
  // already holds, which is one path by construction.
  //
  // ⚠️ IT IS NOT DEAD, AND THE LIVE CASE IS THE RECIPE OVERRIDE. These are TWO
  // independent reads and one is not the other's input: `GET /meals/:id`
  // applies the per-instance recipe override (applyRecipeOverrideToDishes,
  // AFTER the path filter, rebuilding the dish list from the override's own
  // shape), while `POST /meals/:id/cooking-sequence` reads
  // `recipeInstructionStep` straight from Prisma and never sees the override.
  // A plan item with one therefore hands the two calls different step sets, and
  // this is what keeps the flow whole. It also still covers an unmappable
  // (dishId, stepIndex) and a duplicated sequence reference.
  //
  // Deleting it needs the override applied to BOTH endpoints first.
  for (const k of naiveOrder) {
    if (used.has(k)) continue;
    const hit = byKey.get(k);
    if (hit) out.push(toCookStep(hit.step, k, hit.dishTitle, hit.dishId));
  }
  return out;
}

// ── Prep gate ───────────────────────────────────────────────────────────────

export type PrepGateState = "prepped" | "not_prepped" | "unknown";

/**
 * The three-state gate (PRD §7.12). `hasPlanContext` means a plan item was
 * resolved (planId + planItemId present AND the item found via usePlan); only
 * then is `isPrepped` authoritative. No plan context → "unknown" → the screen
 * asks the user once. Read-only: this never writes a mark.
 */
export function resolvePrepGate(
  hasPlanContext: boolean,
  isPrepped: boolean,
): PrepGateState {
  if (!hasPlanContext) return "unknown";
  return isPrepped ? "prepped" : "not_prepped";
}

// ── The prepped path (K-R7) ─────────────────────────────────────────────────
//
// 🔴 NO COOK STEP IS EVER REMOVED FROM THE FLOW. This replaced a filter that
// dropped every cook step tagged `prep` on the prepped path and built the recap
// from those same cook steps. Both were wrong: a `prep` tag says what KIND of
// work a step is, not that Prep the Week did it, so a step whose salt or oil was
// never prepped vanished with the part the cook still had to do. Now:
//   • a cook step is "done in prep" — collapsed, its text one tap away — only
//     when every prep step whose `coversCookSteps` names it is complete;
//   • the recap lists the plan's PREP steps for this meal, not cook steps.
// The footer's minutes are untouched by either: the Sequencer's serve-anchored
// offsets are plan-agnostic and still count a collapsed step's time, and a
// second clock that subtracted it is BUG-337's lesson (see stepTiming.ts).

function coverKey(dishId: string, stepIndex: number): string {
  return `${dishId}#${stepIndex}`;
}

/**
 * The CookStep keys Prep the Week has fully done for `mealId`: every prep step
 * listing the cook step in `coversCookSteps` has its stepKey in `checked` (the
 * completions the app already reads). Strict on purpose, like the server's
 * derivation: one unticked covering step and the cook step renders normally,
 * because it is the cook step that then tells the cook what still needs
 * cutting. A cook step no prep step covers never collapses.
 */
export function doneInPrepStepKeys(
  steps: readonly CookStep[],
  prep: PrepWeekResult | undefined,
  mealId: string,
  checked: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (!prep || mealId.length === 0) return out;
  const coveringStepKeys = new Map<string, string[]>();
  for (const phase of prep.phases) {
    for (const step of phase.steps) {
      for (const c of step.coversCookSteps ?? []) {
        if (c.mealId !== mealId) continue;
        const k = coverKey(c.dishId, c.stepIndex);
        const list = coveringStepKeys.get(k) ?? [];
        list.push(step.stepKey);
        coveringStepKeys.set(k, list);
      }
    }
  }
  for (const st of steps) {
    if (st.dishId === undefined || st.stepIndex === undefined) continue;
    const by = coveringStepKeys.get(coverKey(st.dishId, st.stepIndex));
    if (by && by.length > 0 && by.every((k) => checked.has(k))) out.add(st.key);
  }
  return out;
}

export interface PrepRecap {
  /** "Prepped on Sunday", or "Already prepped" when the day is unknown. */
  heading: string;
  /** One line per prep step (its title), in Prep the Week's order. */
  items: string[];
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The "you already prepped this" recap, from the plan's PREP steps for this
 * meal (those whose `contributesToMealIds` includes it). Two kinds are left
 * out because the cook never prepped them: a `skipSuggested` step (Prep the
 * Week does not render it — D-WS7-184) and a `holdsNoContainer` step (the
 * cook-day protein line or the wash; the server's isPrepped does not wait for
 * them either).
 *
 * The day is the latest `checkedAt` among those steps' completions, named only
 * when it is today or one of the six days before; older, or no completion at
 * all (a manual pin), and a weekday would point at the wrong week, so the
 * heading says "Already prepped".
 */
export function prepRecap(
  prep: PrepWeekResult | undefined,
  mealId: string,
  completions: readonly PrepCompletionRow[],
  now: Date,
): PrepRecap {
  const items: string[] = [];
  const stepKeys = new Set<string>();
  for (const phase of prep?.phases ?? []) {
    for (const step of phase.steps) {
      if (!step.contributesToMealIds.includes(mealId)) continue;
      if (step.skipSuggested === true || step.holdsNoContainer === true) continue;
      stepKeys.add(step.stepKey);
      if (!items.includes(step.title)) items.push(step.title);
    }
  }

  let latest: Date | null = null;
  for (const row of completions) {
    if (!stepKeys.has(row.stepKey)) continue;
    const at = new Date(row.checkedAt);
    if (Number.isNaN(at.getTime())) continue;
    if (latest === null || at > latest) latest = at;
  }
  // Calendar days, local time: 0 (today) … 6. Seven is the same weekday a week
  // ago, which the weekday alone cannot tell apart from this week.
  const days =
    latest === null
      ? null
      : Math.round((startOfLocalDay(now) - startOfLocalDay(latest)) / DAY_MS);
  const heading =
    latest !== null && days !== null && days >= 0 && days <= 6
      ? `Prepped on ${WEEKDAYS[latest.getDay()]}`
      : "Already prepped";
  return { heading, items };
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Cook Mode fetches the plan's prep-week payload only when a prep session has
 * evidently happened (at least one completion row). That payload is a cache hit
 * for a plan that was prepped — but for one that never was, the same POST is a
 * live narration call. Without a completion nothing can collapse anyway; the
 * payload is still used whenever it is already in the client cache.
 */
export function shouldLoadPrepForCook(
  hasPlan: boolean,
  completionCount: number,
): boolean {
  return hasPlan && completionCount > 0;
}

// ── Navigation over the live (not done-in-prep) steps ──────────────────────
// A done-in-prep step stays in the list — counted in "step N of M", painted on
// the progress bar — but the anchor never rests on it: the cook reads it by
// tapping it open, not by stepping onto it.

/** First step not done in prep (0 when every step is). */
export function firstLiveIndex(
  steps: readonly CookStep[],
  doneInPrep: ReadonlySet<string>,
): number {
  const i = steps.findIndex((s) => !doneInPrep.has(s.key));
  return i === -1 ? 0 : i;
}

/** Last step not done in prep (the last step when every step is). */
export function lastLiveIndex(
  steps: readonly CookStep[],
  doneInPrep: ReadonlySet<string>,
): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!doneInPrep.has(steps[i].key)) return i;
  }
  return Math.max(0, steps.length - 1);
}

/** The next live step after `from`; `from` itself when there is none. */
export function nextLiveIndex(
  steps: readonly CookStep[],
  doneInPrep: ReadonlySet<string>,
  from: number,
): number {
  for (let i = from + 1; i < steps.length; i++) {
    if (!doneInPrep.has(steps[i].key)) return i;
  }
  return from;
}

/** The previous live step before `from`; `from` itself when there is none. */
export function prevLiveIndex(
  steps: readonly CookStep[],
  doneInPrep: ReadonlySet<string>,
  from: number,
): number {
  for (let i = from - 1; i >= 0; i--) {
    if (!doneInPrep.has(steps[i].key)) return i;
  }
  return from;
}

// ── Cook-screen render selector (WS7-8b B3 polish #1) ───────────────────────
// Pure decision for what the route (app/cook-session.tsx) renders, extracted so
// the gate-vs-load ordering is unit-testable without driving expo-router +
// react-query. The ORDER is the contract (PRD §7.12 gate seam):
//   1. recipeError  → terminal error screen.
//   2. planResolving → block on the CHEAP plan fetch FIRST. isPrepped is the
//      gate-state source; resolving it before showing the gate prevents the
//      State-3 ("did you prep?") flash on a launch that is actually State 1/2.
//   3. needsGatePrompt → show the State-3 gate NOW, even while the slow recipe/
//      sequence fetch is still in flight (load the step data behind the gate).
//   4. recipeLoading || sequenceLoading → only reached once the gate is answered
//      (or no prompt is needed); spinner while the step data finishes.
//   5. session → render the full cook flow.

export type CookRenderState =
  | "error"
  | "plan-loading"
  | "gate"
  | "recipe-loading"
  | "session";

export function resolveCookRender(input: {
  recipeError: boolean;
  planResolving: boolean;
  recipeLoading: boolean;
  sequenceLoading: boolean;
  needsGatePrompt: boolean;
}): CookRenderState {
  if (input.recipeError) return "error";
  if (input.planResolving) return "plan-loading";
  if (input.needsGatePrompt) return "gate";
  if (input.recipeLoading || input.sequenceLoading) return "recipe-loading";
  return "session";
}

// ── Per-step timer chips + inline-quantity highlighter ──────────────────────
// Both were lifted to dedicated modules (./timer, ./quantityHighlight) in
// WS7-8b Block 4 so the Week Prep screen can reuse them. Re-exported above for
// back-compat; see those files for the implementations.
