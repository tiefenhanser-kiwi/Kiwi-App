// WS7-8a Block 2 — code-owned prep-week response assembly.
//
// The deterministic bridge between the engine result and the locked
// PrepWeekResult wire shape. Two pure steps:
//
//  buildStepPlan(result)        → code-owned step skeletons (number, phase,
//                                 contributesToMealIds) + the narration input
//                                 the AI is asked to write prose for.
//  assemblePrepWeekResult(plan, → merges AI prose back onto the code-owned
//    narration)                   skeletons by stepId. Numeric + attribution
//                                 fields come from the plan; ONLY title /
//                                 instructions / storageNote / estimatedMinutes
//                                 come from the AI. The narration result has no
//                                 quantity / mealId field, so prose cannot move
//                                 the math.
//
// Step structure (B1 ruling): seasonings_dry collapses ALL its entries (which
// are exactly the detected spice-blend components) into ONE "mix the blend"
// step; every other phase emits one step per included/uncertain group.
// Excluded groups never reach here (they are dropped upstream).
//
// Known simplification (D-WS7-151): two distinct dish-blends in one plan merge
// into a single seasonings_dry blend step. Accepted for now.

import {
  PREP_PHASE_ORDER,
  canonicalizeUnit,
  type PrepPhaseKey,
  type PrepCombineResult,
  type PrepIngredientGroup,
} from "./prepCombineEngine";
import type {
  PrepMeasure,
  PrepNarrationComponent,
  PrepNarrationInput,
  PrepNarrationResult,
} from "./ai/schemas/prepNarration";
import type { PrepWeekResult, PrepWeekStep } from "./ai/schemas/prepWeek";

// Fixed, code-owned phase labels + skippable flags (PRD §13.4.1). Never AI.
const PHASE_META: Record<PrepPhaseKey, { title: string; skippable: boolean }> = {
  seasonings_dry: { title: "Seasonings & dry ingredients", skippable: true },
  sauces_marinades: { title: "Sauces, marinades & garnishes", skippable: true },
  produce: { title: "Produce", skippable: false },
  proteins: { title: "Proteins", skippable: false },
};

// PrepWeekResult.totalEstimatedMinutes is capped 1..240 by the locked schema.
// Clamp the summed estimate so a large plan can't fail validation on the total.
const TOTAL_MIN = 1;
const TOTAL_MAX = 240;

export class PrepNarrationIncompleteError extends Error {
  constructor(public readonly missingStepIds: string[]) {
    super(`narration missing ${missingStepIds.length} step(s)`);
    this.name = "PrepNarrationIncompleteError";
  }
}

export interface PlannedStep {
  stepId: string;
  // WS7-8a B3 (D-WS7-153) — STABLE per-step key for checkbox persistence,
  // distinct from the transient positional `stepId`. Derived from the engine's
  // ingredientId (1:1 with phase), so it survives a regenerate. Carried onto
  // the wire step in assemblePrepWeekResult.
  stepKey: string;
  phase: PrepPhaseKey;
  number: number;
  // The engine ingredientId this step's key is derived from. null for the
  // collapsed seasonings_dry blend step (it folds many ingredientIds into one
  // step, keyed by the `seasonings_dry#blend` sentinel instead).
  ingredientId: string | null;
  // CODE-OWNED attribution — the dedup union of the contributing meal ids.
  contributesToMealIds: string[];
  isBlend: boolean;
  components: PrepNarrationComponent[];
  // WS7-8a B2b — raw step text of the dish(es) this step's ingredients are
  // cooked in, for the AI's combine-vs-season judgment.
  relevantSteps: string[];
}

export interface StepPlan {
  steps: PlannedStep[];
  narrationInput: PrepNarrationInput;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// ── WS7-8b FIX 2 — kitchen-fraction formatter (code owns the math) ───────────
// Turns a raw engine decimal + unit into a finished display string the narrator
// echoes verbatim, so "prose can't move the math" still holds. Per-family
// policy (Hans-ratified):
//   - tsp/tbsp/cup/oz/lb → round UP to the nearest 1/8, rendered as a mixed
//     number with a vulgar-fraction glyph ("¾ cup", "1 ½ tbsp").
//   - ml/g              → round to a whole number (no fractions, no decimals).
//   - counts + unknown  → whole where clean, else the number as-is (e.g. eggs).
// Unit token comes from the engine's own canonicalizer so spelling variants
// ("teaspoons" → "tsp") collapse; magnitude is never converted here (each
// contribution keeps its own unit), only the spelling is normalized.

const EIGHTH_UNITS: ReadonlySet<string> = new Set(["tsp", "tbsp", "cup", "oz", "lb"]);
const WHOLE_UNITS: ReadonlySet<string> = new Set(["ml", "g"]);

// rem (1..7) eighths → vulgar-fraction glyph. 4/8 reduces to ½, etc.
const EIGHTH_GLYPH: Record<number, string> = {
  1: "⅛", // ⅛
  2: "¼", // ¼
  3: "⅜", // ⅜
  4: "½", // ½
  5: "⅝", // ⅝
  6: "¾", // ¾
  7: "⅞", // ⅞
};

// Round UP to the nearest 1/8 and render as a mixed number ("¾", "1 ½", "2").
function toEighths(q: number): string {
  const eighths = Math.ceil(q * 8 - 1e-9); // fp guard so 0.5 → 4, not 5
  const whole = Math.floor(eighths / 8);
  const rem = eighths % 8;
  if (rem === 0) return String(whole);
  const glyph = EIGHTH_GLYPH[rem];
  return whole > 0 ? `${whole} ${glyph}` : glyph;
}

// Render a count/unknown quantity: integer where clean, else the raw number
// (trimmed of fp noise) — no forced fractions.
function toCount(q: number): string {
  const rounded = Math.round(q);
  if (Math.abs(q - rounded) < 1e-9) return String(rounded);
  return String(Number(q.toFixed(2)));
}

export function formatMeasure(quantity: number, rawUnit: string): string {
  const { token } = canonicalizeUnit(rawUnit);
  if (EIGHTH_UNITS.has(token)) return `${toEighths(quantity)} ${token}`;
  if (WHOLE_UNITS.has(token)) return `${Math.max(1, Math.round(quantity))} ${token}`;
  return `${toCount(quantity)} ${token}`;
}

// One narration component per summed line of a group. Retains the code-owned
// summed total + meal names for reference, but the narrator writes from
// `measures[]` — the PER-DISH breakdown (WS7-8b FIX 1), each amount already
// fraction-formatted (FIX 2). Per-dish so nothing has to be re-portioned.
function componentsOf(entry: PrepIngredientGroup): PrepNarrationComponent[] {
  return entry.lines.map((line) => {
    const prep = line.contributions.find(
      (c) => (c.preparationNote ?? "").trim() !== "",
    )?.preparationNote;
    const forMeals = dedupe(line.contributions.map((c) => c.mealName));
    const measures: PrepMeasure[] = line.contributions.map((c) => ({
      amount: formatMeasure(c.quantity, c.unit),
      forDish: c.dishName,
      ...((c.preparationNote ?? "").trim()
        ? { preparationNote: (c.preparationNote ?? "").trim() }
        : {}),
    }));
    return {
      ingredientName: entry.ingredientName,
      totalQuantity: line.totalQuantity,
      unit: line.unit,
      ...(prep ? { preparationNote: prep } : {}),
      forMeals,
      measures,
    };
  });
}

function mealIdsOf(entry: PrepIngredientGroup): string[] {
  return entry.lines.flatMap((l) => l.contributions.map((c) => c.mealId));
}

function dishIdsOf(entry: PrepIngredientGroup): string[] {
  return entry.lines.flatMap((l) => l.contributions.map((c) => c.dishId));
}

export function buildStepPlan(
  result: PrepCombineResult,
  planName: string,
  // WS7-8a B2b — raw step text per dishId (dish-owned + meal-owned folded in,
  // built by the route from the loader output). A step's relevantSteps is the
  // deduped union over the dishes its ingredients are cooked in. Defaults to
  // an empty map so callers/tests that don't need the skip rule still work.
  stepTextByDishId: Map<string, string[]> = new Map(),
): StepPlan {
  const steps: PlannedStep[] = [];

  const relevantStepsFor = (group: PrepIngredientGroup[]): string[] =>
    dedupe(
      [...new Set(group.flatMap(dishIdsOf))].flatMap(
        (dishId) => stepTextByDishId.get(dishId) ?? [],
      ),
    );

  for (const phase of result.phases) {
    const key = phase.phase;
    const entries = phase.entries; // include + uncertain only (excluded dropped)
    if (entries.length === 0) continue;

    let number = 0;
    const pushStep = (isBlend: boolean, group: PrepIngredientGroup[]): void => {
      number += 1;
      // Stable key derivation (D-WS7-153). The blend step collapses many
      // ingredientIds → sentinel key; a normal step is exactly one group, so
      // group[0].ingredientId is its stable identity.
      const ingredientId = isBlend ? null : group[0].ingredientId;
      const stepKey = isBlend ? `${key}#blend` : `${key}#${ingredientId}`;
      steps.push({
        stepId: `${key}#${number}`,
        stepKey,
        phase: key,
        number,
        ingredientId,
        contributesToMealIds: dedupe(group.flatMap(mealIdsOf)),
        isBlend,
        components: group.flatMap(componentsOf),
        relevantSteps: relevantStepsFor(group),
      });
    };

    if (key === "seasonings_dry") {
      // B1: collapse all blend components into ONE blend step.
      pushStep(true, entries);
    } else {
      for (const entry of entries) pushStep(false, [entry]);
    }
  }

  const narrationInput: PrepNarrationInput = {
    planName,
    steps: steps.map((s) => ({
      stepId: s.stepId,
      phase: s.phase,
      isBlend: s.isBlend,
      components: s.components,
      relevantSteps: s.relevantSteps,
    })),
  };

  return { steps, narrationInput };
}

export function assemblePrepWeekResult(
  plan: StepPlan,
  narration: PrepNarrationResult,
): PrepWeekResult {
  const proseById = new Map(narration.steps.map((s) => [s.stepId, s]));

  // Fail closed: every planned step must be narrated. We never ship a step
  // with code-owned numbers but no prose.
  const missing = plan.steps
    .filter((s) => !proseById.has(s.stepId))
    .map((s) => s.stepId);
  if (missing.length > 0) throw new PrepNarrationIncompleteError(missing);

  const stepsByPhase = new Map<PrepPhaseKey, PrepWeekStep[]>();
  for (const p of PREP_PHASE_ORDER) stepsByPhase.set(p, []);

  let total = 0;
  for (const planned of plan.steps) {
    const prose = proseById.get(planned.stepId)!;
    total += prose.estimatedMinutes;
    stepsByPhase.get(planned.phase)!.push({
      number: planned.number, // CODE
      stepKey: planned.stepKey, // CODE — stable persistence identity
      title: prose.title, // AI
      instructions: prose.instructions, // AI
      estimatedMinutes: prose.estimatedMinutes, // AI (time judgment)
      contributesToMealIds: planned.contributesToMealIds, // CODE — never from prose
      ...(prose.storageNote ? { storageNote: prose.storageNote } : {}),
      // WS7-8a B2b — AI demotion annotation. Only emit when true so the wire
      // shape stays minimal; false/undefined → field absent (= keep as prep).
      ...(prose.skipSuggested ? { skipSuggested: true } : {}),
    });
  }

  const phases = PREP_PHASE_ORDER.map((p) => ({
    phase: p,
    title: PHASE_META[p].title,
    skippable: PHASE_META[p].skippable,
    steps: stepsByPhase.get(p)!,
  }));

  return {
    totalEstimatedMinutes: Math.min(TOTAL_MAX, Math.max(TOTAL_MIN, total)),
    phases,
  };
}
