// WS7-8b Block 3 — pure engine for the single-meal Cook Mode (app/cook-session.tsx).
//
// All non-React logic lives here so it's unit-testable in node:test: flatten a
// loaded recipe into an ordered step list, the three-state prep gate, the
// prep-phase filter, the mise-en-place recap source, and the best-effort
// inline-quantity highlighter.
//
// CRITICAL INVARIANT: prep state is read ONLY from plan/instance context
// (PlanDetailItem.isPrepped via usePlan). The Meal/Dish recipe shapes are
// RENDER-ONLY — nothing here reads or writes a prep flag on a Meal/Dish, and
// the recap reads prep-step TEXT for display only. No write-back this block
// (per-meal prep write-back is D-WS7-157, Block 4).

import type { SequencedStep } from "@/lib/api/cooking";
import type { DishDetail } from "@/lib/api/dishes";
import type { AmountRef, MealDetail, MealStep } from "@/lib/api/meals";

export const PREP_PHASE = "prep";

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
  isPrep: boolean;
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
}

function toCookStep(s: MealStep, key: string, dishTitle?: string): CookStep {
  return {
    key,
    text: s.text,
    phaseType: s.phaseType,
    estimatedMinutes: s.estimatedMinutes,
    isPrep: s.phaseType === PREP_PHASE,
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
      out.push(toCookStep(s, `${dish.dishId}#${i}`, multiDish ? dish.title : undefined));
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
  const byKey = new Map<string, { step: MealStep; dishTitle: string }>();
  const naiveOrder: string[] = [];
  for (const dish of meal.dishes) {
    for (const s of dish.steps) {
      const k = `${dish.dishId}#${s.stepIndex}`;
      if (!byKey.has(k)) {
        byKey.set(k, { step: s, dishTitle: dish.title });
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
    out.push({ ...toCookStep(hit.step, k, hit.dishTitle), cue: entry.reason });
  }

  // Defensive append: any step the sequence omitted (or that failed to map) is
  // appended in naive order so the flow NEVER loses a step (§27).
  for (const k of naiveOrder) {
    if (used.has(k)) continue;
    const hit = byKey.get(k);
    if (hit) out.push(toCookStep(hit.step, k, hit.dishTitle));
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

/**
 * The linear session steps. On the prepped path we drop phaseType==='prep'
 * steps and renumber; the prepped ingredients are surfaced instead via the
 * mise-en-place recap. Cook/rest/preheat/assemble/hold always stay.
 */
export function applyPrepFilter(steps: CookStep[], skipPrep: boolean): CookStep[] {
  return skipPrep ? steps.filter((s) => !s.isPrep) : steps;
}

/**
 * Mise-en-place recap source: this meal's OWN prep-phase step texts (no
 * contributesToMealIds — that field is absent from mobile and is Block 4
 * territory). Render-only; writes nothing.
 */
export function misePlaceItems(steps: CookStep[]): string[] {
  return steps.filter((s) => s.isPrep).map((s) => s.text);
}

/** Sum of estimated minutes for the steps from `fromIndex` to the end. */
export function remainingMinutes(steps: CookStep[], fromIndex: number): number {
  return steps
    .slice(Math.max(0, fromIndex))
    .reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
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

// ── Per-step timer chips (WS7-8b B3 Build Block 2A) ─────────────────────────
// Wall-clock model: a started timer stores `endsAt` (epoch ms). A single ticking
// "now" drives every chip's remaining time, so concurrency (many timers at once)
// and continuation across navigation / brief app-background come for free — the
// remaining is always `endsAt - now`, independent of which step is the anchor.
// Live state + the interval live in the View; these helpers are the pure math.

export interface ActiveTimer {
  /** Epoch ms at which the countdown reaches zero. */
  endsAt: number;
  /** The full duration it was started with (for progress/restart). */
  durationMs: number;
}

/** Remaining milliseconds, clamped at 0. */
export function timerRemainingMs(timer: ActiveTimer, nowMs: number): number {
  return Math.max(0, timer.endsAt - nowMs);
}

/** True once the wall clock has reached/passed the timer's end. */
export function isTimerDone(timer: ActiveTimer, nowMs: number): boolean {
  return nowMs >= timer.endsAt;
}

/**
 * Format remaining ms as "M:SS" (minutes uncapped). Rounds UP to the next whole
 * second so a freshly-started 5-minute timer reads "5:00", not "4:59".
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ── Inline-quantity highlighter (best-effort, guaranteed-reconstruct) ────────

export interface TextSegment {
  text: string;
  isQuantity: boolean;
}

// Allowlisted units only, so we never bold an arbitrary trailing word. Time
// units included so cook-step durations ("4 minutes") highlight too.
const UNIT_WORDS = [
  "cups?", "tbsps?", "tablespoons?", "tsps?", "teaspoons?",
  "cloves?", "ozs?", "ounces?", "lbs?", "pounds?",
  "grams?", "g", "kgs?", "kilograms?",
  "mls?", "milliliters?", "millilitres?", "ls?", "liters?", "litres?",
  "pinch(?:es)?", "cans?", "sticks?", "slices?", "pieces?", "sprigs?",
  "minutes?", "mins?", "hours?", "hrs?", "seconds?", "secs?",
];

// A number form: integer, decimal (1.5 / 1,5), simple fraction (1/2), range
// (2-3 / 2–3), or a unicode vulgar fraction — optionally followed by an
// allowlisted unit. The `g` flag drives String.matchAll (which does not mutate
// lastIndex, so the shared regex is safe across calls).
const NUMBER = String.raw`\d+(?:[.,]\d+)?(?:\s*[\/\-–]\s*\d+(?:[.,]\d+)?)?|[½¼¾⅓⅔⅛⅜⅝⅞]`;
const QUANTITY_RE = new RegExp(
  `(?:${NUMBER})(?:\\s*(?:${UNIT_WORDS.join("|")}))?`,
  "gi",
);

/**
 * Split step text into plain + quantity segments for render-time bolding.
 *
 * GUARANTEE: `highlightQuantities(t).map(s => s.text).join("") === t` for every
 * input — segments are sliced contiguously on match indices, so no character is
 * ever dropped, reordered, or mangled. No match → a single plain segment. Never
 * throws. Full step text is always reconstructable (8a recovery path).
 */
export function highlightQuantities(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(QUANTITY_RE)) {
    const start = m.index ?? 0;
    const matched = m[0];
    if (!matched) continue; // defensive: never emit a zero-length match
    if (start > last) out.push({ text: text.slice(last, start), isQuantity: false });
    out.push({ text: matched, isQuantity: true });
    last = start + matched.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), isQuantity: false });
  return out.length > 0 ? out : [{ text, isQuantity: false }];
}
