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
  type PrepPhaseKey,
  type PrepCombineResult,
  type PrepIngredientGroup,
} from "./prepCombineEngine";
import type {
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
  phase: PrepPhaseKey;
  number: number;
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

// One narration component per summed line of a group. Carries the code-owned
// quantity + the first observed prep note + the contributing meal NAMES.
function componentsOf(entry: PrepIngredientGroup): PrepNarrationComponent[] {
  return entry.lines.map((line) => {
    const prep = line.contributions.find(
      (c) => (c.preparationNote ?? "").trim() !== "",
    )?.preparationNote;
    const forMeals = dedupe(line.contributions.map((c) => c.mealName));
    return {
      ingredientName: entry.ingredientName,
      totalQuantity: line.totalQuantity,
      unit: line.unit,
      ...(prep ? { preparationNote: prep } : {}),
      forMeals,
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
      steps.push({
        stepId: `${key}#${number}`,
        phase: key,
        number,
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
