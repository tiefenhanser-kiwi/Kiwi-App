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

import { convertWithinDimension, pluralizeCountUnit } from "./ingredientConversions";
import { judgePrepWorthiness, bowlNameFor, useNounFor } from "./prepComponents";
import { isLoneKey } from "./prepMoments";
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
  // WS7-8a B2b / D-WS9-049 A1.2 — NAMES of the dish(es) this step's ingredients
  // are cooked in and that have step text. The prose itself lives once in the
  // narration input's `dishSteps` map; each step just references the dishes.
  // Empty when no step text was available for any of this step's dishes.
  relevantDishes: string[];
  // WS7-8b #5 — set ONLY on a grouped sauces_marinades dish-step whose dish
  // ALSO has dry spices that survived into the seasonings_dry blend step. The
  // value is that dish's name; the narrator emits the mandatory linkage wording
  // ("combine … with the <name> spices from your seasoning blend") only when
  // present. Absent when the sauce's dry spices were dropped upstream as noise
  // (<3-per-dish blend), so the wording never points at spices that aren't there.
  /**
   * WS9 D-WS9-296 — the vessel this step fills, e.g. "Carne asada marinade bowl".
   * Present on a COMPONENT step; absent on a plain per-ingredient portion. The
   * narrator must use it verbatim, and every destination row shows it.
   */
  bowlName?: string;
  /**
   * D-WS9-296 ruling 1 — the sentence for a raw protein that JOINS a bowl on cook
   * day rather than sitting in it. Written by the ENGINE, never the model: it
   * states a fact about the schedule, and prose must not be able to move it.
   */
  cookDaySentence?: string;
  /**
   * D-WS9-299 — the engine's own demotion. A step that does not save weeknight
   * time is render-omitted, whatever the model thinks. Carries the arm that
   * refused it so the corpus report can be read.
   */
  demoted?: { reason: string };
  /**
   * D-WS9-298 — max over this step's destination meals of (cook date − prep day),
   * in days. Undefined when no destination carries a date.
   *
   * ⚠️ CODE-ONLY. This never reaches the narration input: the storage note and the
   * demotion it drives are deterministic, and a day-dependent PROMPT input makes
   * every day reassignment a cache miss for prose that would not have changed.
   */
  daysUntilCook?: number;
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
//     number with a vulgar-fraction glyph ("¾ cup", "1½ tbsp" — unspaced since
//     D-WS9-297 ruling 7).
//   - ml/g              → round to a whole number (no fractions, no decimals).
//   - counts + unknown  → whole where clean, else the nearest glyph ("½ onion");
//     the bare "each" placeholder unit is dropped (ruling 7).
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

// ── WS9 BUG-338 / D-WS9-297 ruling 7 — ONE APP, ONE MIXED NUMBER ────────────
//
// 🔴 THE SPACED FORM IS RETIRED. The comment below used to defend "1 ½ lb" as
// "how a recipe is written". Measured on the 13-plan census: 55 spaced mixed
// numbers, against `artifacts/kiwi/lib/format/quantity.ts` which writes `1½`
// everywhere else in the app (`${whole}${glyph}`, no separator). Hans ruled
// glyphs everywhere in the grocery pass; two renderers disagreeing about the
// same number is the defect, and the grocery/mobile spelling is the one that
// wins because everything else already reads that way.
//
// The ruling asks to route through `formatQuantity` if it is reachable. IT IS
// NOT: that module lives in `artifacts/kiwi`, and nothing in `api-server/src`
// imports across that boundary (the server's build tree is bundled separately —
// see scripts/bundleExternals.mjs). So it is the same TABLE, deliberately
// spelled to match, and this comment is the link between the two copies. If one
// changes, change both.
function mixedNumber(whole: number, glyph: string | null): string {
  if (glyph === null) return String(whole);
  return whole > 0 ? `${whole}${glyph}` : glyph;
}

// Round UP to the nearest 1/8 and render as a mixed number ("¾", "1½", "2").
function toEighths(q: number): string {
  const eighths = Math.ceil(q * 8 - 1e-9); // fp guard so 0.5 → 4, not 5
  const whole = Math.floor(eighths / 8);
  const rem = eighths % 8;
  return mixedNumber(whole, rem === 0 ? null : EIGHTH_GLYPH[rem]);
}

// ── ruling 7, second half — A COUNT IS A GLYPH TOO ─────────────────────────
//
// `toCount` used to return the raw decimal for anything non-integer, which is
// where `0.25 bunch` and `0.5 each` came from (24 of them on the census). A
// count is not exempt from the app's own number rules: Hans's §8 asks for
// `¼ bunch` and `½ onion`.
//
// NEAREST-GLYPH, NOT ROUND-UP. `toEighths` deliberately rounds up because
// under-measuring a teaspoon spoils a dish; half an onion is an exact quantity
// and rounding it up to ⅝ would be a lie about the data. So this mirrors
// `formatQuantity`'s matchGlyph: a fractional part within ε of a known glyph
// prints that glyph, and anything else falls back to the decimal rather than
// inventing a fraction. ε and the glyph set are the mobile module's.
const COUNT_GLYPHS: ReadonlyArray<{ value: number; glyph: string }> = [
  { value: 1 / 8, glyph: "⅛" },
  { value: 1 / 4, glyph: "¼" },
  { value: 1 / 3, glyph: "⅓" },
  { value: 3 / 8, glyph: "⅜" },
  { value: 1 / 2, glyph: "½" },
  { value: 5 / 8, glyph: "⅝" },
  { value: 2 / 3, glyph: "⅔" },
  { value: 3 / 4, glyph: "¾" },
  { value: 7 / 8, glyph: "⅞" },
];
// Half the smallest gap between adjacent glyphs (⅓→⅜ and ⅝→⅔ are both 0.0417),
// so matches stay disjoint. Same constant as lib/format/quantity.ts.
const GLYPH_EPSILON = 0.02;

function toCount(q: number): string {
  const rounded = Math.round(q);
  if (Math.abs(q - rounded) < 1e-9) return String(rounded);
  const whole = Math.floor(q);
  const frac = q - whole;
  let best: { glyph: string; dist: number } | null = null;
  for (const { value, glyph } of COUNT_GLYPHS) {
    const dist = Math.abs(frac - value);
    if (dist <= GLYPH_EPSILON && (best === null || dist < best.dist)) best = { glyph, dist };
  }
  if (best === null) return String(Number(q.toFixed(2)));
  return mixedNumber(whole, best.glyph);
}

// ── ruling 7, third part — "each" IS NOT A WORD A COOK SAYS ────────────────
//
// `canonicalizeUnit` returns `each` for a bare count, and printing it produced
// "Dice 3 each roma tomatoes" — 135 of these on the census, the single largest
// P-R5 class. The unit token is dropped for the GENERIC count placeholders only,
// so the narrator writes "3 roma tomatoes" from the amount plus the ingredient
// name it already has.
//
// ⚠️ SPECIFIC count units keep their token and their F5.2 pluralisation:
// "3 cloves", "2 stalks", "¼ bunch" all carry information the ingredient name
// does not. `whole` is also kept — "1 whole chicken" means something. Only the
// placeholder goes.
const PLACEHOLDER_COUNT_UNITS: ReadonlySet<string> = new Set(["each", "ea", ""]);

// ── [grocery] F (F5.2) — A COUNT UNIT INFLECTS ─────────────────────────────
//
// Hans's device pass, item 18: the Prep the Week text read "Finely dice 3 stalk
// celery and transfer to a container". Nothing was wrong with the number or the
// noun — `canonicalizeUnit` returns the CANONICAL token, and the canonical
// token is the singular, so every count above one printed singular. The
// narrator echoes `formatMeasure`'s string verbatim ("prose can't move the
// math"), which is exactly why the grammar has to be right here and cannot be
// left to the model.
//
// ⚠️ ONLY THE COUNT BRANCH. The two branches above it are measure units and
// they stay invariant on purpose: "1 ½ cup" and "2 lb" are how a recipe is
// written, and "2 lbs" / "2 cups" would be a regression dressed as a fix. That
// is the same split COUNT_NOUN_PLURALS keeps on the client.
//
// `pluralizeCountUnit` is the INVERSE of the count-unit alias map
// ingredientConversions already owns — derived, not a second table.
export function formatMeasure(quantity: number, rawUnit: string): string {
  const { token } = canonicalizeUnit(rawUnit);
  if (EIGHTH_UNITS.has(token)) return `${toEighths(quantity)} ${token}`;
  if (WHOLE_UNITS.has(token)) return `${Math.max(1, Math.round(quantity))} ${token}`;
  const shown = toCount(quantity);
  // D-WS9-297 ruling 7 — the bare number for a placeholder count; the narrator
  // supplies the noun. `Number(shown)` is NaN for a glyph-only string like "¼",
  // so the quantity itself drives the pluralisation, not the rendered text.
  if (PLACEHOLDER_COUNT_UNITS.has(token)) return shown;
  return `${shown} ${pluralizeCountUnit(token, quantity)}`;
}

// One narration component per summed line of a group. The narrator writes from
// `measures[]` — the PER-DISH breakdown (WS7-8b FIX 1), each amount already
// fraction-formatted (FIX 2). Per-dish so nothing has to be re-portioned.
// D-WS9-049 A1.1 — the old reference-only `totalQuantity`/`unit`/`forMeals`
// (which the prompt already said to IGNORE) are no longer emitted; they only
// cost narration-input tokens. id-level attribution stays on the planned step.
// ── WS9 BUG-338 / D-WS9-297 ruling 8 — HOW MANY LIMES IS THAT ──────────────
//
// The census found every citrus in every plan counted twice: "Prep all limes"
// portions whole fruit, "Measure all lime juice: 3 tbsp + 2 tbsp + 2 tbsp" asks
// for juice, and nothing connects them. 14 of 14 plans; 5 of them never state a
// fruit count anywhere.
//
// `sourceYield` carries the `component` edge's magnitude (lime → lime juice :
// 3 tbsp), so the count is arithmetic the CODE can do — which is the whole point
// of the blended design. `convertWithinDimension` handles a demand stated in a
// different volume unit than the yield; a demand in an incompatible dimension
// (juice by weight) yields null and no hint is emitted.
//
// ROUNDED UP, always. You cannot buy 1.4 limes, and a cook told "2 limes" for
// 2.1 limes' worth of juice is short. The same direction `toEighths` rounds.
// 🔴 `pluralizeCountUnit` IS THE WRONG TOOL FOR THIS, and using it first is how
// this read "2 lime". That function inflects UNIT TOKENS from a closed table
// (clove → cloves, stalk → stalks); `fromName` is an ingredient NOUN and is not
// in it, so every count came back singular.
//
// `artifacts/kiwi/lib/format/grocery.ts` has the fuller `pluralizeNoun`, and the
// server cannot import it (same build boundary as `formatQuantity` — see
// `mixedNumber` above). This is the regular-plural subset, which is all the data
// needs: every ingredient carrying a `component` yield today is citrus, and
// lime/lemon/orange/grapefruit are all regular. An irregular noun would come back
// wrong, so if a yield is ever added for one, this is the function to widen.
function pluralizeSourceNoun(noun: string): string {
  const w = noun.trim();
  if (w.length === 0) return noun;
  if (/[^a-z]$/i.test(w)) return w; // ends in punctuation — not a noun to inflect
  if (/(?:s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

function sourceCountFor(
  sourceYield: PrepIngredientGroup["sourceYield"],
  quantity: number,
  unit: string,
): string | undefined {
  if (!sourceYield || !(sourceYield.quantity > 0)) return undefined;
  const { token: demandToken } = canonicalizeUnit(unit);
  const { token: yieldToken } = canonicalizeUnit(sourceYield.unit);
  let inYieldUnit: number | null;
  if (demandToken === yieldToken) {
    inYieldUnit = quantity;
  } else {
    inYieldUnit = convertWithinDimension(quantity, demandToken, yieldToken);
  }
  if (inYieldUnit === null || !Number.isFinite(inYieldUnit) || inYieldUnit <= 0) return undefined;
  const count = Math.ceil(inYieldUnit / sourceYield.quantity - 1e-9);
  if (!Number.isFinite(count) || count < 1) return undefined;
  return `${count} ${count === 1 ? sourceYield.fromName : pluralizeSourceNoun(sourceYield.fromName)}`;
}

/**
 * WS9 D-WS9-296 — `componentsOf`, minus the contributions a COMPONENT step has
 * already taken.
 *
 * 🔴 FILTERED PER (dish, ingredient), NOT PER INGREDIENT. The plan's garlic is
 * ONE ingredient group feeding four dishes; the carne asada's share goes into
 * its marinade bowl while the other three still need their own portions. An
 * entry-level skip would silently drop those three.
 */
function componentsOfUnclaimed(
  entry: PrepIngredientGroup,
  claimed: ReadonlySet<string>,
): PrepNarrationComponent[] {
  const out: PrepNarrationComponent[] = [];
  for (const line of entry.lines) {
    const kept = line.contributions.filter(
      (c) => !claimed.has(`${c.dishId}|${entry.ingredientId}`),
    );
    if (kept.length === 0) continue;
    const prep = kept.find((c) => (c.preparationNote ?? "").trim() !== "")?.preparationNote;
    const measures: PrepMeasure[] = kept.map((c) => {
      const fromSource = sourceCountFor(entry.sourceYield, c.quantity, c.unit);
      return {
        amount: formatMeasure(c.quantity, c.unit),
        forDish: c.dishName,
        dishRole: c.dishRole,
        ...(fromSource ? { fromSource } : {}),
        ...((c.preparationNote ?? "").trim()
          ? { preparationNote: (c.preparationNote ?? "").trim() }
          : {}),
      };
    });
    out.push({
      ingredientName: entry.ingredientName,
      ...(prep ? { preparationNote: prep } : {}),
      measures,
    });
  }
  return out;
}

function componentsOf(entry: PrepIngredientGroup): PrepNarrationComponent[] {
  return entry.lines.map((line) => {
    const prep = line.contributions.find(
      (c) => (c.preparationNote ?? "").trim() !== "",
    )?.preparationNote;
    const measures: PrepMeasure[] = line.contributions.map((c) => {
      const fromSource = sourceCountFor(entry.sourceYield, c.quantity, c.unit);
      return {
        amount: formatMeasure(c.quantity, c.unit),
        forDish: c.dishName,
        dishRole: c.dishRole,
        ...(fromSource ? { fromSource } : {}),
        ...((c.preparationNote ?? "").trim()
          ? { preparationNote: (c.preparationNote ?? "").trim() }
          : {}),
      };
    });
    return {
      ingredientName: entry.ingredientName,
      ...(prep ? { preparationNote: prep } : {}),
      measures,
    };
  });
}

// WS7-8b #5 — per-dishId-filtered sibling of componentsOf (the committed FIX 1
// per-entry builder above). Used ONLY by the grouped sauces_marinades dish-step
// path: given one ingredient group and a target dishId, emit components built
// from just that dish's contributions, so a sauce dish-step shows only its own
// wet parts. Sits BESIDE componentsOf (does not replace the committed path).
// D-WS9-049 A1.1 — like componentsOf, no longer emits the IGNORE-only
// totalQuantity/unit/forMeals; the narrator writes from measures[].
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
    const measures: PrepMeasure[] = contribs.map((c) => {
      const fromSource = sourceCountFor(entry.sourceYield, c.quantity, c.unit);
      return {
        amount: formatMeasure(c.quantity, c.unit),
        forDish: c.dishName,
        dishRole: c.dishRole,
        ...(fromSource ? { fromSource } : {}),
        ...((c.preparationNote ?? "").trim()
          ? { preparationNote: (c.preparationNote ?? "").trim() }
          : {}),
      };
    });
    out.push({
      ingredientName: entry.ingredientName,
      ...(prep ? { preparationNote: prep } : {}),
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
  // built by the route from the loader output). Re-keyed by dish name into the
  // narration input's shared `dishSteps` map (D-WS9-049 A1.2); each step then
  // references the dishes its ingredients are cooked in via `relevantDishes`.
  // Defaults to an empty map so callers/tests that don't need the skip rule
  // still work (→ empty relevantDishes, empty dishSteps).
  stepTextByDishId: Map<string, string[]> = new Map(),
  // D-WS9-297 ruling 13 — mealId → days from the prep session to that meal's cook
  // day. Built by the route from the loader's `prepDay` + each meal's
  // `assignedDate`. Defaults empty, so `loadPrepStepSet` (which only needs step
  // keys) and every existing test are untouched.
  cookLagByMealId: ReadonlyMap<string, number> = new Map(),
): StepPlan {
  const steps: PlannedStep[] = [];

  // D-WS9-049 A1.2 — dish name ⇄ step text, so a dish's prose is sent ONCE
  // (input-level `dishSteps` map) and each step just references dish names.
  //   dishNameById   — dishId → dishName (first-seen across all contributions).
  //   dishStepsByName — dishName → its deduped step text (union across any
  //                     same-named dishIds). Only dishes WITH text appear.
  const dishNameById = new Map<string, string>();
  for (const phase of result.phases) {
    for (const entry of phase.entries) {
      for (const line of entry.lines) {
        for (const c of line.contributions) {
          if (!dishNameById.has(c.dishId)) dishNameById.set(c.dishId, c.dishName);
        }
      }
    }
  }
  const dishStepsByName = new Map<string, string[]>();
  for (const [dishId, texts] of stepTextByDishId) {
    const name = dishNameById.get(dishId);
    if (!name) continue; // dishId not present in this plan's contributions
    const clean = dedupe(texts);
    if (clean.length === 0) continue;
    const existing = dishStepsByName.get(name);
    dishStepsByName.set(name, existing ? dedupe([...existing, ...clean]) : clean);
  }

  // The dishes whose step text applies to a step === the dishes its ingredients
  // are cooked in, restricted to those that actually have text (so an empty
  // result still means "no step text → never demote", as before). Names, not
  // prose — the prose is looked up in dishSteps by the narrator.
  const relevantDishesFor = (dishIds: string[]): string[] =>
    dedupe(
      [...new Set(dishIds)]
        .map((dishId) => dishNameById.get(dishId))
        .filter((name): name is string => !!name && dishStepsByName.has(name)),
    );

  // ── WS9 D-WS9-296 — `blendSpiceDish` IS RETIRED ─────────────────────────
  //
  // WS7-8b #5 built it, and B1's ruling 10 widened it: a per-dish sauce step
  // whose dish also had spices in the blend carried the dish's NAME, and the
  // narrator wrote "combine these with the <dish> spices from your seasoning
  // blend". It was always a pointer between two containers that should have
  // been one, and it could never reach the case that mattered — a marinade's
  // orange juice is `produce`, and the field was only ever set on
  // `sauces_marinades`. Measured in B2 Part A: 74 of 108 multi-pile dishes had
  // no join at all.
  //
  // Components replace it. There is no sentence pointing from one vessel to
  // another because there is one vessel, and it has a name.
  // ── WS9 BUG-338 / D-WS9-297 ruling 9 — A BLEND OF ONE IS NOT A BLEND ──────
  //
  // ⚠️ THE RULING'S LITERAL WORDING HAS NO TARGETS. It asks that "a lone
  // sub-tablespoon DRY measure folds into its dish's BLEND step". Measured on the
  // census, all 13 lone dry measures under a tablespoon ARE their dish's blend
  // step — a per-dish blend (BUG-016 / D-WS7-187) that came out with one
  // component, because the spice is a blend member on a DIFFERENT dish and so
  // survives the <3-per-dish noise filter on this one. There is nothing for them
  // to fold into, so the rule as written would change nothing.
  //
  // What the data supports instead: a one-component blend step folds into that
  // dish's SAUCE step, when the dish has one. "Measure the BBQ Chicken
  // Drumsticks spice blend: 1 tsp smoked paprika" and "Measure the BBQ sauce"
  // become one step and one container. Measured: 17 single-component blends, 12
  // of them foldable; the other 5 (a lone parmesan, a lone cumin) have no sauce
  // step and are left alone rather than dropped — dropping prep work is Hans's
  // call, not a floor rule's.
  //
  // No sub-tablespoon test: a blend of ONE is the defect at any size, and a
  // threshold here would just be a number nobody could justify.
  //
  // This also closes 12 P-R2 splits, which is the same defect seen from the
  // other side — the wet and dry halves of one sauce in two containers.
  const seasoningsEntries =
    result.phases.find((p) => p.phase === "seasonings_dry")?.entries ?? [];
  const saucesEntries =
    result.phases.find((p) => p.phase === "sauces_marinades")?.entries ?? [];
  const dishesWithSauce = new Set(saucesEntries.flatMap((e) => dishIdsOf(e)));
  /** dishId → the single blend entry to fold into that dish's sauce step. */
  const foldedBlendByDishId = new Map<string, PrepIngredientGroup>();
  {
    const blendEntriesByDish = new Map<string, PrepIngredientGroup[]>();
    for (const entry of seasoningsEntries) {
      for (const dishId of new Set(dishIdsOf(entry))) {
        const list = blendEntriesByDish.get(dishId) ?? [];
        list.push(entry);
        blendEntriesByDish.set(dishId, list);
      }
    }
    for (const [dishId, list] of blendEntriesByDish) {
      if (list.length === 1 && dishesWithSauce.has(dishId)) {
        foldedBlendByDishId.set(dishId, list[0]);
      }
    }
  }

  // ── WS9 D-WS9-296 — ONE STEP PER COMPONENT PER DISH ───────────────────────
  //
  // A mixture's members are scattered across phases by construction: the carne
  // asada marinade has four spices in seasonings_dry and its juices and garlic
  // in produce. Hans's Bowl A is one vessel, so it is one STEP — placed in the
  // EARLIEST phase it touches, holding every member, named for the bowl.
  //
  // Claimed contributions are removed from the per-phase steps below, so a
  // marinade's cumin no longer also appears in the dish's spice blend.
  // ── D-WS9-301 rule 1 — THE BUCKET KEY IS THE MOMENT, NOT THE COMPONENT ────
  //
  // "A container is the set of ingredients that enter the cooking process at the
  // SAME MOMENT — the same cook step." A component still wins where one exists:
  // it is the strongest moment signal AND it carries the author's own name for
  // the mixture. What changes is that an UNNAMED moment holding two or more
  // ingredients is now equally a container — which is where nearly all of the
  // reduction comes from. H0 measured it: keying on components alone leaves the
  // corpus at 13-40 containers per plan, the moment key brings it to 7-28.
  //
  // A "lone" key (prepMoments.isLoneKey) means the dish gave no signal at all —
  // 23 of 148 corpus dishes. Those never bucket; nothing is invented for them.
  interface ComponentBucket {
    dishId: string;
    dishName: string;
    mealName: string;
    /**
     * "" until the naming pass — an unnamed moment cannot be named until its
     * members are known, and the pass below fills every empty one
     * unconditionally. Not `null`, so nothing downstream has to narrow a type
     * for a state that does not survive this function.
     */
    bowlName: string;
    noun: string | null;
    phase: PrepPhaseKey;
    entries: Map<string, PrepIngredientGroup>;
    mealIds: Set<string>;
  }
  const componentBuckets = new Map<string, ComponentBucket>();
  /** `${dishId}|${ingredientId}` claimed by a container — skipped per-phase. */
  const claimed = new Set<string>();
  for (const phase of result.phases) {
    for (const entry of phase.entries) {
      for (const line of entry.lines) {
        for (const c of line.contributions) {
          // 🔴 THE KEY IS THE MOMENT, FULL STOP — never the component's own key.
          // The adapter has already folded the resolved component INTO the
          // moment key (`c:<resolved key>`), including for ingredients that
          // merely share its run. Keying on `c.component.key` here as well would
          // put the marinade's members in one bucket and the lemon that shares
          // their run in another, which is the exact defect rule 1's inverse
          // case names.
          // A component IS a moment, so a contribution carrying one but no
          // explicit `momentKey` still buckets. The adapter always sets both and
          // sets them consistently, so this fallback never fires in production —
          // it is what keeps an engine-level fixture (and any caller that builds
          // `PrepCombineInput` by hand) meaningful instead of silently emitting
          // no container at all.
          const mk = c.momentKey ?? (c.component ? `c:${c.component.key}` : null);
          if (!mk || isLoneKey(mk)) continue;
          // ── 🔴 RULE 5 BEATS RULE 1 FOR A SHARED INGREDIENT ────────────────
          //
          // Rule 1 groups within a DISH, and a moment bucket is by construction
          // one dish's container. Applied to an ingredient several dishes use,
          // that produces exactly what rule 5 forbids — "a chopped ingredient
          // used by several dishes goes in ONE container, labelled with its
          // dishes. Never one container per dish."
          //
          // Measured when this was the other way round: every container on the
          // sample plan came out single-dish, the cilantro feeding four dishes
          // split four ways, and the count went UP. Rule 5 is the one with a
          // number attached to it ("this alone is 18 containers → 5"), so it
          // wins, and the cook portions the shared container at the stove.
          //
          // ⚠️ AN AUTHORED MIXTURE IS THE EXCEPTION, and it is not a new one:
          // D-WS9-296 already put the carne asada's garlic in its marinade bowl
          // while the other three dishes' garlic shared a step, and Hans
          // ratified that. A `c:` key means a resolved component — the author
          // said these things belong together — so it still claims its share.
          const isAuthoredMixture = mk.startsWith("c:");
          if (!isAuthoredMixture && new Set(dishIdsOf(entry)).size > 1) continue;
          const k = `${c.dishId}|${mk}`;
          const b = componentBuckets.get(k) ?? {
            dishId: c.dishId,
            dishName: c.dishName,
            mealName: c.mealName,
            bowlName: c.component?.bowlName ?? "",
            noun: c.component?.noun ?? null,
            phase: phase.phase,
            entries: new Map<string, PrepIngredientGroup>(),
            mealIds: new Set<string>(),
          };
          // Earliest phase wins: PREP_PHASE_ORDER is the fixed order.
          if (PREP_PHASE_ORDER.indexOf(phase.phase) < PREP_PHASE_ORDER.indexOf(b.phase)) {
            b.phase = phase.phase;
          }
          // The author's own name for the mixture, from whichever member carries
          // one. An absorbed ingredient (the marinade's lemon) has no component
          // of its own, so the name can arrive on any member of the bucket.
          if (b.bowlName === "" && c.component) {
            b.bowlName = c.component.bowlName;
            b.noun = c.component.noun;
          }
          b.entries.set(entry.ingredientId, entry);
          b.mealIds.add(c.mealId);
          componentBuckets.set(k, b);
          claimed.add(`${c.dishId}|${entry.ingredientId}`);
        }
      }
    }
  }

  // A container holds at least two things. A moment with one ingredient in it is
  // a plain portion of that ingredient, and giving it a vessel name would be the
  // "~30 containers" defect wearing a different label. Dissolving UN-CLAIMS, so
  // the ingredient falls back to its ordinary per-phase step.
  for (const [k, b] of [...componentBuckets]) {
    if (b.entries.size >= 2) continue;
    for (const ingredientId of b.entries.keys()) claimed.delete(`${b.dishId}|${ingredientId}`);
    componentBuckets.delete(k);
  }

  // ── D-WS9-301 rule 2 — "DRY ONLY… fresh herbs never join a dry blend" ─────
  //
  // The buckets above place a mixture in the EARLIEST phase it touches
  // (D-WS9-296), and that put a container holding fresh onion under
  // "Seasonings & dry ingredients" on the sample plan. The container itself is
  // right — the slow-cooker's aromatics, dried herbs and liquids are one dump,
  // which is Hans's own approved example — but the cook reads a skippable dry
  // phase and the onion is neither dry nor skippable.
  //
  // So a bucket holding anything fresh moves to the earliest phase it touches
  // that is NOT seasonings_dry. Its storage class follows its contents already.
  for (const b of componentBuckets.values()) {
    if (b.phase !== "seasonings_dry") continue;
    const phases = [...b.entries.values()].map((e) => e.phase);
    if (!phases.some((p) => p === "produce" || p === "proteins")) continue;
    const firstFresh = PREP_PHASE_ORDER.find((p) => p !== "seasonings_dry" && phases.includes(p));
    if (firstFresh) b.phase = firstFresh;
  }

  // Rule 8 — name every container the author did not name, by dish and use.
  for (const b of componentBuckets.values()) {
    if (b.bowlName !== "") continue;
    b.bowlName = bowlNameFor(
      b.dishName,
      b.mealName,
      null,
      0,
      false,
      false,
      useNounFor([...b.entries.values()].map((e) => e.phase)),
    );
  }

  // ── D-WS9-296 ruling 1 — the raw protein's cook-day step ─────────────────
  //
  // "On cook day: 1½ lb skirt steak into the Carne asada marinade bowl (a
  // zip-top bag works)." The sentence is the ENGINE's, because it states a fact
  // about the schedule; the model may not move it.
  const cookDayByDishIngredient = new Map<string, string>();
  for (const phase of result.phases) {
    for (const entry of phase.entries) {
      for (const line of entry.lines) {
        for (const c of line.contributions) {
          if (c.cookDayInto) cookDayByDishIngredient.set(`${c.dishId}|${entry.ingredientId}`, c.cookDayInto);
        }
      }
    }
  }

  /** The mixture noun a planned step belongs to, for the must-sit arm. */
  const nounByBowl = new Map<string, string | null>();
  for (const b of componentBuckets.values()) nounByBowl.set(b.bowlName, b.noun);
  const componentNounOf = (st: PlannedStep): string | null =>
    st.bowlName ? nounByBowl.get(st.bowlName) ?? null : null;

  for (const phase of result.phases) {
    const key = phase.phase;
    const entries = phase.entries; // include + uncertain only (excluded dropped)
    if (entries.length === 0) continue;

    let number = 0;
    const pushStep = (step: Omit<PlannedStep, "stepId" | "number" | "phase">): void => {
      number += 1;
      // D-WS9-297 ruling 13 — the LATEST cook day this step has to survive to.
      // Max, not min: a portion feeding Tuesday and Saturday has to last until
      // Saturday, and the shorter answer is the one that spoils food.
      const lags = step.contributesToMealIds
        .map((id) => cookLagByMealId.get(id))
        .filter((n): n is number => n !== undefined);
      const planned: PlannedStep = {
        stepId: `${key}#${number}`,
        phase: key,
        number,
        ...step,
        ...(lags.length > 0 ? { daysUntilCook: Math.max(...lags) } : {}),
      };
      // ── D-WS9-299 — DOES THIS STEP SAVE WEEKNIGHT TIME? ──────────────────
      //
      // Hans: "measuring 1 thing (condiment, cooking oil, single spice), or
      // even 2 simple things that don't need to sit and mix together, isn't
      // part of prep." The judge is in prepComponents.ts; a refusal is a
      // render-omitted step, exactly as an AI demotion is, and its dish's
      // cook-day step handles the item.
      //
      // ⚠️ A COOK-DAY PROTEIN STEP IS NEVER JUDGED. It carries no measuring at
      // all — it tells the cook where the steak goes on Friday — so the
      // weeknight-time test does not apply to it.
      if (!planned.cookDaySentence) {
        const verdict = judgePrepWorthiness({
          measuredItems: planned.components.reduce((n, c) => n + c.measures.length, 0),
          componentNoun: componentNounOf(planned),
          preparationNotes: planned.components.flatMap((c) => [
            c.preparationNote ?? "",
            ...c.measures.map((m) => m.preparationNote ?? ""),
          ]),
          text: planned.components.map((c) => c.ingredientName).join(" "),
          phase: planned.phase,
        });
        if (!verdict.worthDoingAhead) planned.demoted = { reason: verdict.reason };
      }
      steps.push(planned);
    };

    // ── D-WS9-296 — this phase's COMPONENT steps, first ────────────────────
    //
    // One step per (dish, component), placed in the earliest phase the mixture
    // touches, holding every member across phases. Keyed
    // `component#${dishId}#${componentKey}` so a checkbox survives a
    // regenerate exactly as the per-dish blend and sauce keys do (D-WS7-153).
    for (const [bucketKey, b] of componentBuckets) {
      if (b.phase !== key) continue;
      // Ruling 3, applied again AFTER the engine's prep-worthy filter: a bucket
      // whose other members were dropped upstream arrives with one measure and
      // is a plain portion, not a mixture. Its claim is released so the
      // per-phase branches below pick the survivor up.
      const surviving = [...b.entries.values()]
        .flatMap((e) => componentsForDish(e, b.dishId))
        .reduce((n, c) => n + c.measures.length, 0);
      if (surviving < 2) {
        for (const e of b.entries.values()) claimed.delete(`${b.dishId}|${e.ingredientId}`);
        continue;
      }
      const dishId = b.dishId;
      pushStep({
        // 🔴 THE SCHEMA CAPS stepKey AT 80 CHARS, and the first keys blew it:
        // `component#${uuid}#${noun}` is 10 + 36 + 1 + n, and
        // `cookday#${uuid}#${uuid}` is 81 before the noun even exists. Every
        // plan 502'd on PrepWeekResultSchema, and no route test caught it because
        // the stub input has no componentSteps and so emits no component step at
        // all. Short prefixes, and the noun is capped: the key must still be
        // STABLE across a regenerate (D-WS7-153), and a deterministic truncation
        // is.
        stepKey: `cmp#${bucketKey.slice(0, 68)}`,
        ingredientId: null,
        contributesToMealIds: [...b.mealIds],
        // A mixture IS a blend in the narrator's sense — one pre-measure
        // action into one vessel — whatever phase it sits in.
        isBlend: true,
        components: [...b.entries.values()].flatMap((e) => componentsForDish(e, dishId)),
        relevantDishes: relevantDishesFor([dishId]),
        bowlName: b.bowlName,
      });
    }

    // ── D-WS9-296 ruling 1 — the raw proteins that JOIN a bowl on cook day ──
    if (key === "proteins") {
      for (const entry of entries) {
        for (const dishId of new Set(dishIdsOf(entry))) {
          const bowl = cookDayByDishIngredient.get(`${dishId}|${entry.ingredientId}`);
          if (!bowl) continue;
          const mine = componentsForDish(entry, dishId);
          const amount = mine[0]?.measures[0]?.amount ?? "";
          pushStep({
            stepKey: `cd#${dishId}#${entry.ingredientId}`,
            ingredientId: entry.ingredientId,
            contributesToMealIds: dedupe(
              entry.lines.flatMap((l) =>
                l.contributions.filter((c) => c.dishId === dishId).map((c) => c.mealId),
              ),
            ),
            isBlend: false,
            components: mine,
            relevantDishes: relevantDishesFor([dishId]),
            cookDaySentence: `On cook day: ${amount} ${entry.ingredientName} into the ${bowl} (a zip-top bag works).`,
          });
          claimed.add(`${dishId}|${entry.ingredientId}`);
        }
      }
    }

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
        // D-WS9-296 — a (dish, ingredient) a component step already took is not
        // measured twice. When nothing is left, the step is not emitted at all.
        const dishEntries = (entriesByDish.get(dishId) ?? []).filter(
          (e) => !claimed.has(`${dishId}|${e.ingredientId}`),
        );
        if (dishEntries.length === 0) continue;
        const mealIds = dedupe(
          dishEntries.flatMap((e) =>
            e.lines.flatMap((l) =>
              l.contributions
                .filter((c) => c.dishId === dishId)
                .map((c) => c.mealId),
            ),
          ),
        );
        // Ruling 9 — this dish's blend is a single component and its sauce step
        // will carry it instead. No step, no second container.
        if (foldedBlendByDishId.has(dishId)) continue;
        pushStep({
          stepKey: `${key}#dish#${dishId}`,
          ingredientId: null,
          contributesToMealIds: mealIds,
          isBlend: true,
          components: dishEntries.flatMap((e) => componentsForDish(e, dishId)),
          relevantDishes: relevantDishesFor([dishId]),
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
        // D-WS9-296 — a (dish, ingredient) a component step already took is not
        // measured twice. When nothing is left, the step is not emitted at all.
        const dishEntries = (entriesByDish.get(dishId) ?? []).filter(
          (e) => !claimed.has(`${dishId}|${e.ingredientId}`),
        );
        if (dishEntries.length === 0) continue;
        const mealIds = dedupe(
          dishEntries.flatMap((e) =>
            e.lines.flatMap((l) =>
              l.contributions
                .filter((c) => c.dishId === dishId)
                .map((c) => c.mealId),
            ),
          ),
        );
        // Ruling 9 — the folded one-component blend rides on this step.
        const folded = foldedBlendByDishId.get(dishId);
        pushStep({
          stepKey: `${key}#dish#${dishId}`,
          ingredientId: null,
          contributesToMealIds: mealIds,
          isBlend: false,
          components: [
            ...dishEntries.flatMap((e) => componentsForDish(e, dishId)),
            ...(folded ? componentsForDish(folded, dishId) : []),
          ],
          relevantDishes: relevantDishesFor([dishId]),
        });
      }
    } else {
      // One step per ingredient group (produce, proteins). group[0] === entry,
      // so entry.ingredientId is its stable identity (D-WS7-153).
      for (const entry of entries) {
        // D-WS9-296 — filtered per (dish, ingredient): the carne asada's garlic is
        // in its marinade bowl, the other three dishes' garlic still needs a step.
        const unclaimed = componentsOfUnclaimed(entry, claimed);
        if (unclaimed.length === 0) continue;
        const unclaimedDishIds = dishIdsOf(entry).filter(
          (d) => !claimed.has(`${d}|${entry.ingredientId}`),
        );
        pushStep({
          stepKey: `${key}#${entry.ingredientId}`,
          ingredientId: entry.ingredientId,
          contributesToMealIds: dedupe(
            entry.lines.flatMap((l) =>
              l.contributions
                .filter((c) => !claimed.has(`${c.dishId}|${entry.ingredientId}`))
                .map((c) => c.mealId),
            ),
          ),
          isBlend: false,
          components: unclaimed,
          relevantDishes: relevantDishesFor(unclaimedDishIds),
        });
      }
    }
  }

  // Emit dishSteps ONLY for dishes actually referenced by some step, in
  // first-referenced order, so the map carries no unused prose.
  const dishSteps: Record<string, string[]> = {};
  for (const s of steps) {
    for (const name of s.relevantDishes) {
      if (!(name in dishSteps)) {
        const texts = dishStepsByName.get(name);
        if (texts) dishSteps[name] = texts;
      }
    }
  }

  const narrationInput: PrepNarrationInput = {
    planName,
    dishSteps,
    steps: steps.map((s) => ({
      stepId: s.stepId,
      phase: s.phase,
      isBlend: s.isBlend,
      components: s.components,
      relevantDishes: s.relevantDishes,
      ...(s.bowlName ? { bowlName: s.bowlName } : {}),
      ...(s.cookDaySentence ? { cookDaySentence: s.cookDaySentence } : {}),
      // ⚠️ daysUntilCook IS DELIBERATELY NOT HERE. It stays on the step skeleton
      // (PlannedStep) where the deterministic layers read it; sending it to the
      // narrator bought nothing the model needed and made the prose day-dependent,
      // which in turn made every day reassignment a cache miss. D-WS9-298.
    })),
  };

  // ── D-WS9-301 rule 7 — THE DROP PASS, AND WHERE IT STOPS ──────────────────
  //
  // "Target 10–15 containers… Over target, drop the lowest-value steps first
  // (single-dish garnish portions, citrus wedges) rather than splitting
  // further. Exceeding 15 is allowed when every step clears the test."
  //
  // 🔴 SO THIS IS NOT A LOOP TO 15, AND MUST NOT BECOME ONE. Hans ruled it
  // explicitly: it drops only the two lowest classes and then stops, even if
  // the plan is still over. "A plan at 23 containers of real dry blends,
  // marinades and knife work is 23; the count is reported, not forced." A pass
  // that kept going would start deleting the knife work that is the entire
  // reason the screen exists.
  //
  // Measured over the 14 plans: six land inside 10–15 on the grouping alone,
  // and the rest are over by 1–13 — so what this pass must NOT do matters more
  // than what it does.
  dropLowValueSteps(steps);

  return { steps, narrationInput };
}

/** Rule 7's two droppable classes, lowest value first. Null = never dropped. */
export function lowValueClass(step: PlannedStep): "garnish" | "citrus-wedge" | null {
  if (step.cookDaySentence) return null; // not a container at all
  if (step.bowlName) return null; // a named mixture is never the cheap thing
  const notes = step.components
    .flatMap((c) => [c.preparationNote ?? "", ...c.measures.map((m) => m.preparationNote ?? "")])
    .join(" ")
    .toLowerCase();
  const names = step.components.map((c) => c.ingredientName).join(" ").toLowerCase();
  const dishes = new Set(step.components.flatMap((c) => c.measures.map((m) => m.forDish)));

  // Citrus cut into wedges: the one thing on the plan that takes 20 seconds on
  // the night and loses most by sitting (rule 6 names it as the first to go).
  if (/\b(lime|lemon|orange|grapefruit)\b/.test(names) && /\bwedge/.test(notes)) {
    return "citrus-wedge";
  }
  // A SINGLE-DISH garnish portion. Single-dish on purpose: a cilantro container
  // feeding four dishes is rule 5's best work, not a garnish portion.
  if (dishes.size === 1 && /\b(garnish|to finish|for serving|to serve|topping)\b/.test(notes)) {
    return "garnish";
  }
  return null;
}

/** Containers in a step plan: a kept step that holds food. */
export function countContainers(steps: readonly PlannedStep[]): number {
  return steps.filter((s) => !s.demoted && !s.cookDaySentence).length;
}

const CONTAINER_TARGET_MAX = 15;

function dropLowValueSteps(steps: PlannedStep[]): void {
  if (countContainers(steps) <= CONTAINER_TARGET_MAX) return;
  // Garnish portions before citrus wedges, and within a class the ones serving
  // the FEWEST dishes first — D-WS9-301 ruling 2's "dishes-served descending"
  // read from the other end: the container that earns its place by feeding four
  // dishes is the last of its kind to go.
  const order = { garnish: 0, "citrus-wedge": 1 } as const;
  const candidates = steps
    .map((s) => ({ s, cls: lowValueClass(s) }))
    .filter((x): x is { s: PlannedStep; cls: "garnish" | "citrus-wedge" } => x.cls !== null && !x.s.demoted)
    .sort((a, b) => {
      if (order[a.cls] !== order[b.cls]) return order[a.cls] - order[b.cls];
      const da = new Set(a.s.components.flatMap((c) => c.measures.map((m) => m.forDish))).size;
      const db = new Set(b.s.components.flatMap((c) => c.measures.map((m) => m.forDish))).size;
      return da - db;
    });
  for (const { s, cls } of candidates) {
    if (countContainers(steps) <= CONTAINER_TARGET_MAX) break;
    s.demoted = {
      reason:
        cls === "citrus-wedge"
          ? "rule 7 — over the container target; citrus wedges keep best cut on the day"
          : "rule 7 — over the container target; a single-dish garnish portion saves the least",
    };
  }
}

/**
 * D-WS9-301 ruling 4 — the header's two numbers: "N containers · about M min".
 *
 * Hans re-ruled D-WS9-213 for this: *"'12 containers, about 40 minutes' sounds
 * great. that's a time investment with a clear outcome that users can see value
 * in."* The September ruling that removed the summed total was made against a
 * two-hour output and is amended, not reversed — the per-phase "~N min left"
 * stays, and the header is hidden when there is nothing to prep.
 *
 * 🔴 ROUNDED UP, NEVER DOWN. His condition: *"I just want to be sure 40 minutes
 * is no more than 50 minutes or so in reality, otherwise, people won't trust
 * it."* A stated number a cook beats is a number they trust; one they miss is a
 * number they stop reading. So the sum goes UP to the next 5.
 *
 * 🔴 COMPUTED ON EVERY READ, over the steps that RENDER. A step the day overlay
 * demotes (a Friday salmon on a Sunday prep) is not a container today even
 * though it was one when the blob was cached — the same argument as
 * applyStorageOverlay, and the reason this is not baked into `structureJson`.
 */
export function summarizePrepWeek(result: PrepWeekResult): PrepWeekResult {
  let containers = 0;
  let minutes = 0;
  for (const phase of result.phases) {
    for (const step of phase.steps) {
      if (step.skipSuggested) continue;
      // The cook-day sentence still shows and still takes a moment on Friday, so
      // it counts toward the MINUTES — it just is not a container.
      minutes += step.estimatedMinutes;
      if (step.holdsNoContainer) continue;
      containers += 1;
    }
  }
  return {
    ...result,
    containerCount: containers,
    estimatedMinutes: minutes === 0 ? 0 : Math.ceil(minutes / 5) * 5,
  };
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
      // D-WS9-301 rule 7 — the engine's own demotion has to reach the wire, not
      // just the corpus. It used to be folded in by the census harness and by
      // the mobile model separately; the drop pass makes that a correctness
      // matter, because a dropped garnish portion the client still rendered
      // would be a container the header did not count.
      ...(planned.demoted ? { skipSuggested: true } : {}),
      // A cook-day sentence holds no food, so it is not a container.
      ...(planned.cookDaySentence ? { holdsNoContainer: true } : {}),
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
