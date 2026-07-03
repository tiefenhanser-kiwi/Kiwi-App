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
  // The engine ingredientId this step's key is derived from. null for a
  // per-dish seasonings_dry blend step (it folds a dish's many spice
  // ingredientIds into one step, keyed `seasonings_dry#dish#${dishId}` — BUG-016
  // / D-WS7-187) and for a grouped sauces_marinades dish-step (`…#dish#${dishId}`).
  ingredientId: string | null;
  // CODE-OWNED attribution — the dedup union of the contributing meal ids.
  contributesToMealIds: string[];
  isBlend: boolean;
  components: PrepNarrationComponent[];
  // WS7-8a B2b — raw step text of the dish(es) this step's ingredients are
  // cooked in, for the AI's combine-vs-season judgment.
  relevantSteps: string[];
  // WS7-8b #5 — set ONLY on a grouped sauces_marinades dish-step whose dish
  // ALSO has dry spices that survived into the seasonings_dry blend step. The
  // value is that dish's name; the narrator emits the mandatory linkage wording
  // ("combine … with the <name> spices from your seasoning blend") only when
  // present. Absent when the sauce's dry spices were dropped upstream as noise
  // (<3-per-dish blend), so the wording never points at spices that aren't there.
  blendSpiceDish?: string;
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
      dishRole: c.dishRole,
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

// WS7-8b #5 — per-dishId-filtered sibling of componentsOf (the committed FIX 1
// per-entry builder above). Used ONLY by the grouped sauces_marinades dish-step
// path: given one ingredient group and a target dishId, emit components built
// from just that dish's contributions, so a sauce dish-step shows only its own
// wet parts. Sits BESIDE componentsOf (does not replace the committed path).
// totalQuantity/unit stay reference-only (narrator writes from measures[]);
// here they are per-dish scoped — the sum of just this dish's contributions.
function componentsForDish(
  entry: PrepIngredientGroup,
  dishId: string,
): PrepNarrationComponent[] {
  const out: PrepNarrationComponent[] = [];
  for (const line of entry.lines) {
    const contribs = line.contributions.filter((c) => c.dishId === dishId);
    if (contribs.length === 0) continue;
    const prep = contribs.find(
      (c) => (c.preparationNote ?? "").trim() !== "",
    )?.preparationNote;
    const forMeals = dedupe(contribs.map((c) => c.mealName));
    const measures: PrepMeasure[] = contribs.map((c) => ({
      amount: formatMeasure(c.quantity, c.unit),
      forDish: c.dishName,
      dishRole: c.dishRole,
      ...((c.preparationNote ?? "").trim()
        ? { preparationNote: (c.preparationNote ?? "").trim() }
        : {}),
    }));
    out.push({
      ingredientName: entry.ingredientName,
      totalQuantity: contribs.reduce((s, c) => s + c.quantity, 0),
      unit: line.unit,
      ...(prep ? { preparationNote: prep } : {}),
      forMeals,
      measures,
    });
  }
  return out;
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

  // WS7-8b #5 — dishIds (→ dish name) whose dry spices actually SURVIVE into the
  // collapsed seasonings_dry blend step. phase.entries are already include +
  // uncertain only (a <3-per-dish blend is dropped as noise upstream, see
  // classifyPrepWorthy), so this is precisely the set of dishes with real blend
  // spices. A grouped sauce step for one of these dishes gets a blendSpiceDish
  // marker → the narrator emits the linkage wording. Absent otherwise → no
  // false pointer at spices that were dropped.
  const blendSpiceDishByDishId = new Map<string, string>();
  const seasoningsPhase = result.phases.find((p) => p.phase === "seasonings_dry");
  if (seasoningsPhase) {
    for (const entry of seasoningsPhase.entries) {
      for (const line of entry.lines) {
        for (const c of line.contributions) {
          if (!blendSpiceDishByDishId.has(c.dishId)) {
            blendSpiceDishByDishId.set(c.dishId, c.dishName);
          }
        }
      }
    }
  }

  for (const phase of result.phases) {
    const key = phase.phase;
    const entries = phase.entries; // include + uncertain only (excluded dropped)
    if (entries.length === 0) continue;

    let number = 0;
    const pushStep = (step: Omit<PlannedStep, "stepId" | "number" | "phase">): void => {
      number += 1;
      steps.push({
        stepId: `${key}#${number}`,
        phase: key,
        number,
        ...step,
      });
    };

    if (key === "seasonings_dry") {
      // BUG-016 (D-WS7-187) — split the collapsed blend PER DISH. The B1 ruling
      // (D-WS7-151) folded every dish's dry-seasoning components into ONE
      // `seasonings_dry#blend` step; on a big plan (~30 per-dish measures) that
      // step's single AI `instructions` field can't fit under the 800-char cap
      // → retry → 502. Keying one blend step per dish keeps each step small and
      // each checkbox meaningful. Mirrors the sauces_marinades group-by-dishId
      // pattern below: key `seasonings_dry#dish#${dishId}` (stable across
      // regenerate, honors D-WS7-153; recomputes identically in loadPrepStepSet).
      //
      // D-WS7-187 note: a single dish's dry blend — make-ahead spices AND an
      // at-cook dredge alike — stays in that ONE dish step (intra-dish integrity
      // = the genuine D-WS7-183 guard). Only the cross-dish collapse (D-WS7-151)
      // is reversed here.
      const dishOrder: string[] = [];
      const entriesByDish = new Map<string, PrepIngredientGroup[]>();
      for (const entry of entries) {
        for (const dishId of [...new Set(dishIdsOf(entry))]) {
          let list = entriesByDish.get(dishId);
          if (!list) {
            list = [];
            entriesByDish.set(dishId, list);
            dishOrder.push(dishId);
          }
          list.push(entry);
        }
      }
      for (const dishId of dishOrder) {
        const dishEntries = entriesByDish.get(dishId)!;
        const mealIds = dedupe(
          dishEntries.flatMap((e) =>
            e.lines.flatMap((l) =>
              l.contributions
                .filter((c) => c.dishId === dishId)
                .map((c) => c.mealId),
            ),
          ),
        );
        pushStep({
          stepKey: `${key}#dish#${dishId}`,
          ingredientId: null,
          contributesToMealIds: mealIds,
          isBlend: true,
          components: dishEntries.flatMap((e) => componentsForDish(e, dishId)),
          relevantSteps: dedupe(stepTextByDishId.get(dishId) ?? []),
        });
      }
    } else if (key === "sauces_marinades") {
      // WS7-8b #5 — group by dishId so a sauce's wet components (vinegar +
      // ketchup + mayo) land in ONE "make the sauce" step instead of stranding
      // per-ingredient. Entries are ingredient-level groups; an ingredient can
      // touch >1 dish, so we bucket each entry under every dishId its
      // contributions reach, then emit one step per dishId (stable first-seen
      // order). Key on `#dish#${dishId}` (stable across regenerate, honors
      // D-WS7-153; recomputes identically in loadPrepStepSet).
      const dishOrder: string[] = [];
      const entriesByDish = new Map<string, PrepIngredientGroup[]>();
      for (const entry of entries) {
        for (const dishId of [...new Set(dishIdsOf(entry))]) {
          let list = entriesByDish.get(dishId);
          if (!list) {
            list = [];
            entriesByDish.set(dishId, list);
            dishOrder.push(dishId);
          }
          list.push(entry);
        }
      }
      for (const dishId of dishOrder) {
        const dishEntries = entriesByDish.get(dishId)!;
        const mealIds = dedupe(
          dishEntries.flatMap((e) =>
            e.lines.flatMap((l) =>
              l.contributions
                .filter((c) => c.dishId === dishId)
                .map((c) => c.mealId),
            ),
          ),
        );
        const blendSpiceDish = blendSpiceDishByDishId.get(dishId);
        pushStep({
          stepKey: `${key}#dish#${dishId}`,
          ingredientId: null,
          contributesToMealIds: mealIds,
          isBlend: false,
          components: dishEntries.flatMap((e) => componentsForDish(e, dishId)),
          relevantSteps: dedupe(stepTextByDishId.get(dishId) ?? []),
          ...(blendSpiceDish ? { blendSpiceDish } : {}),
        });
      }
    } else {
      // One step per ingredient group (produce, proteins). group[0] === entry,
      // so entry.ingredientId is its stable identity (D-WS7-153).
      for (const entry of entries) {
        pushStep({
          stepKey: `${key}#${entry.ingredientId}`,
          ingredientId: entry.ingredientId,
          contributesToMealIds: dedupe(mealIdsOf(entry)),
          isBlend: false,
          components: componentsOf(entry),
          relevantSteps: relevantStepsFor([entry]),
        });
      }
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
      ...(s.blendSpiceDish ? { blendSpiceDish: s.blendSpiceDish } : {}),
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
