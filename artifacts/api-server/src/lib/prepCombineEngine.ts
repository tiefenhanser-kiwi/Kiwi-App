// WS7-8a Block 1 — Deterministic prep-combine engine.
//
// Reworks Prep the Week from an all-AI combine into a BLENDED model: this
// module is the deterministic core. It groups a plan's ingredients by
// ingredientId, canonicalizes unit spellings, sums compatible quantities,
// retains the per-meal attribution breakdown, assigns each group to one of
// the 4 prep phases, and applies a tiered prep-worthy filter. AI is NOT
// involved here — narration of the computed result is a later block.
//
// PURE: no I/O, no prisma, no AI. Input is PrepCombineInput (built by the
// loader adapter in the wiring block) carrying per-ingredient `category` and
// EFFECTIVE (already servings-scaled) quantities — the engine never scales.
// See WS7-8a Phase 0 for why the existing PrepWeekInput is insufficient
// (drops category, ships un-scaled quantities).
//
// Design rulings (WS7-8a D1-D4):
//  - D1: engine owns its input contract (PrepCombineInput); loader maps to it.
//  - D2: quantities arrive effective/final; no scaling in the engine.
//  - D3: fixed denylist (salt/peppers/oils/water/ice/spray), no oil carve-out.
//  - D4: prepWorthy "uncertain" entries stay in their phase, flagged.
//
// Ingredient-based ONLY by design: RecipeInstructionStep carries no ingredient
// mapping (free text), so the season-and-cook-vs-combine step rule is applied
// by the AI narration layer in the next block, not here.

import { normalizeIngredientName } from "./groceryNormalization";
import { PrepWeekPhaseKey, type PrepWeekPhaseKeyT } from "./ai/schemas/prepWeek";

// ── phase tokens ─────────────────────────────────────────────────────────
// Reuse the schema enum so phase tokens stay identical across blocks. Order
// is fixed: seasonings_dry → sauces_marinades → produce → proteins (proteins
// ALWAYS last, food safety — PRD §13.4.1).
export type PrepPhaseKey = PrepWeekPhaseKeyT;
export const PREP_PHASE_ORDER: readonly PrepPhaseKey[] = PrepWeekPhaseKey.options;

// ── engine input contract ──────────────────────────────────────────────────

export interface PrepCombineIngredient {
  ingredientId: string;
  ingredientName: string;
  // Ingredient.category — Produce | Protein | Pantry | Dairy | Bakery |
  // Frozen | Canned (compared case-insensitively). Drives phase + filter.
  category: string;
  // EFFECTIVE quantity (servings-scaling already applied by the loader).
  quantity: number;
  unit: string;
  preparationNote?: string | null;
}

// WS7-8b #4 — MealDishLink.roleLabel (schema DishRole enum). A local string
// union so the engine stays PURE (no @prisma/client import); the loader's
// prisma `DishRole` value is structurally identical and assigns cleanly.
export type DishRoleT =
  | "main"
  | "side"
  | "sauce"
  | "topping"
  | "base"
  | "optional";

export interface PrepCombineDish {
  dishId: string;
  dishName: string;
  // WS7-8b #4 — dish's structural role, carried onto each contribution so the
  // narrator can judge KEEP (combines-into-a-mix: sauce/topping/base) vs.
  // DEMOTE (lone standalone measure) without relying on recipe prose.
  dishRole: DishRoleT;
  ingredients: PrepCombineIngredient[];
}

export interface PrepCombineMeal {
  mealId: string;
  mealName: string;
  dishes: PrepCombineDish[];
}

export interface PrepCombineInput {
  meals: PrepCombineMeal[];
}

// ── output contract ──────────────────────────────────────────────────────

export type PrepWorthy = "include" | "exclude" | "uncertain";
export type UnitFamily = "volume" | "weight" | "count" | "unknown";

export interface CanonicalUnit {
  token: string;
  family: UnitFamily;
}

// One meal/dish's contribution to a combined line. Quantity + unit are the
// ORIGINAL (effective) values; this is the per-meal attribution the
// prep→cook skip-loop needs (the B4 gap the all-AI path could not emit).
export interface PrepContribution {
  mealId: string;
  mealName: string;
  dishId: string;
  dishName: string;
  // WS7-8b #4 — dish role of the dish this contribution came from (assembly
  // reads it to narrate KEEP-vs-DEMOTE; grouping #5 keys on dishId, not this).
  dishRole: DishRoleT;
  quantity: number;
  unit: string;
  preparationNote?: string | null;
}

// A summed line within an ingredient group. Multiple lines exist ONLY when an
// ingredient is measured in incompatible unit families (e.g. count + volume) —
// honest non-merge beats a wrong sum (no density data, by design).
export interface PrepCombinedLine {
  unit: string; // canonical display token (coarsest in the bucket)
  unitFamily: UnitFamily;
  totalQuantity: number; // summed in the display token
  contributions: PrepContribution[];
}

export interface PrepIngredientGroup {
  ingredientId: string;
  ingredientName: string;
  category: string;
  // null for buy-and-use categories with no prep phase (Dairy/Bakery/
  // Frozen/Canned/unknown) — always co-occurs with prepWorthy "exclude".
  phase: PrepPhaseKey | null;
  prepWorthy: PrepWorthy;
  // Tier-3: part of a 3+ distinct dry-seasoning blend on at least one dish.
  isBlendComponent: boolean;
  lines: PrepCombinedLine[];
}

export interface PrepPhase {
  phase: PrepPhaseKey;
  entries: PrepIngredientGroup[]; // include + uncertain (exclude is filtered out)
}

export interface PrepCombineResult {
  phases: PrepPhase[]; // exactly 4, fixed order, entries may be empty
  // Groups filtered out as noise / buy-and-use, kept (flagged) so the
  // narration block has full data and can audit the filter.
  excluded: PrepIngredientGroup[];
  // Left for the narration block to fill; this block emits data only.
  totalEstimatedMinutes: number;
}

// ── unit canonicalizer ─────────────────────────────────────────────────────

// Spelling-variant → canonical token + family. Built from the real seed unit
// spread (see WS7-8a Phase 0). Extend as new seed units appear.
const UNIT_CANON: Record<string, CanonicalUnit> = {
  // volume (tsp/tbsp/cup are inter-convertible — see VOLUME_RATIO)
  tsp: { token: "tsp", family: "volume" },
  teaspoon: { token: "tsp", family: "volume" },
  teaspoons: { token: "tsp", family: "volume" },
  tbsp: { token: "tbsp", family: "volume" },
  tablespoon: { token: "tbsp", family: "volume" },
  tablespoons: { token: "tbsp", family: "volume" },
  cup: { token: "cup", family: "volume" },
  cups: { token: "cup", family: "volume" },
  // volume but NOT in the ratio table → buckets alone (no tsp/tbsp/cup ratio)
  ml: { token: "ml", family: "volume" },
  milliliter: { token: "ml", family: "volume" },
  milliliters: { token: "ml", family: "volume" },
  // weight (oz/lb are inter-convertible — see WEIGHT_RATIO)
  oz: { token: "oz", family: "weight" },
  ounce: { token: "oz", family: "weight" },
  ounces: { token: "oz", family: "weight" },
  lb: { token: "lb", family: "weight" },
  lbs: { token: "lb", family: "weight" },
  pound: { token: "lb", family: "weight" },
  pounds: { token: "lb", family: "weight" },
  // weight but NOT in the ratio table → buckets alone (no g↔oz ratio)
  g: { token: "g", family: "weight" },
  gram: { token: "g", family: "weight" },
  grams: { token: "g", family: "weight" },
  // count / discrete — each token is its own bucket (never inter-converts)
  each: { token: "each", family: "count" },
  unit: { token: "each", family: "count" },
  large: { token: "each", family: "count" },
  clove: { token: "clove", family: "count" },
  cloves: { token: "clove", family: "count" },
  slice: { token: "slice", family: "count" },
  slices: { token: "slice", family: "count" },
  stalk: { token: "stalk", family: "count" },
  stalks: { token: "stalk", family: "count" },
  head: { token: "head", family: "count" },
  heads: { token: "head", family: "count" },
  bunch: { token: "bunch", family: "count" },
  bunches: { token: "bunch", family: "count" },
  pint: { token: "pint", family: "count" },
  pints: { token: "pint", family: "count" },
  can: { token: "can", family: "count" },
  cans: { token: "can", family: "count" },
  jar: { token: "jar", family: "count" },
  jars: { token: "jar", family: "count" },
  loaf: { token: "loaf", family: "count" },
  loaves: { token: "loaf", family: "count" },
  inch: { token: "inch", family: "count" },
  inches: { token: "inch", family: "count" },
};

// Same-family volume conversion, expressed in the base unit (tsp).
const VOLUME_RATIO: Record<string, number> = { tsp: 1, tbsp: 3, cup: 48 };
// Same-family weight conversion, expressed in the base unit (oz).
const WEIGHT_RATIO: Record<string, number> = { oz: 1, lb: 16 };

function ratioTableFor(token: string): Record<string, number> | null {
  if (token in VOLUME_RATIO) return VOLUME_RATIO;
  if (token in WEIGHT_RATIO) return WEIGHT_RATIO;
  return null;
}

// Map a raw unit string to its canonical token + family. Empty / null / unknown
// strings degrade gracefully: "" / null → each; an unrecognized token is
// returned as-is with family "unknown" (it buckets alone — never force-merged).
export function canonicalizeUnit(raw: string | null | undefined): CanonicalUnit {
  const norm = normalizeIngredientName(raw ?? "");
  if (norm === "") return { token: "each", family: "count" };
  const hit = UNIT_CANON[norm];
  if (hit) return hit;
  return { token: norm, family: "unknown" };
}

// Bucket key deciding which contributions sum together. tsp/tbsp/cup share one
// volume bucket; oz/lb share one weight bucket; everything else (count, unknown,
// and ratio-less volume/weight like ml/g) buckets by its own token.
function mergeBucketKey(c: CanonicalUnit): string {
  if (c.token in VOLUME_RATIO) return "fam:volume";
  if (c.token in WEIGHT_RATIO) return "fam:weight";
  return `tok:${c.token}`;
}

// ── denylist + name heuristics ─────────────────────────────────────────────

// D3 Tier-1 denylist — cook-time staples that are never worth pre-prepping.
// Matched via normalizeIngredientName. No oils-in-blend carve-out (D3 ruling).
const DENYLIST: ReadonlySet<string> = new Set([
  "salt",
  "kosher salt",
  "sea salt",
  "black pepper",
  "pepper",
  "olive oil",
  "vegetable oil",
  "cooking oil",
  "canola oil",
  "water",
  "ice",
  "cooking spray",
  "nonstick spray",
]);

// Name hints that route a Pantry ingredient to sauces_marinades rather than
// seasonings_dry. Substring match on the normalized name.
const SAUCE_NAME_HINTS: readonly string[] = [
  "sauce",
  "paste",
  "oil",
  "dressing",
  "marinade",
  "vinegar",
  "broth",
  "stock",
  "syrup",
  "juice",
  "wine",
];

function isDenied(name: string): boolean {
  return DENYLIST.has(normalizeIngredientName(name));
}

function categoryKey(category: string): string {
  return category.trim().toLowerCase();
}

// ── phase assignment ───────────────────────────────────────────────────────

// Produce/Protein map cleanly on every row. Pantry splits by a name heuristic
// (liquid/sauce hint → sauces_marinades, else seasonings_dry). Buy-and-use
// categories (Dairy/Bakery/Frozen/Canned/unknown) have no prep phase → null.
export function assignPhase(category: string, name: string): PrepPhaseKey | null {
  switch (categoryKey(category)) {
    case "produce":
      return "produce";
    case "protein":
      return "proteins";
    case "pantry": {
      const nn = normalizeIngredientName(name);
      return SAUCE_NAME_HINTS.some((h) => nn.includes(h))
        ? "sauces_marinades"
        : "seasonings_dry";
    }
    default:
      return null;
  }
}

// ── core combine + attribute ───────────────────────────────────────────────

interface GroupAccumulator {
  ingredientId: string;
  ingredientName: string;
  category: string;
  contributions: PrepContribution[];
}

// Build the summed lines for one ingredient group from its contributions.
// Contributions bucket by unit-merge-key; each bucket becomes one line.
function buildLines(contributions: PrepContribution[]): PrepCombinedLine[] {
  const buckets = new Map<string, PrepContribution[]>();
  const order: string[] = [];
  for (const c of contributions) {
    const key = mergeBucketKey(canonicalizeUnit(c.unit));
    const list = buckets.get(key);
    if (list) {
      list.push(c);
    } else {
      buckets.set(key, [c]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const members = buckets.get(key)!;
    const canon = members.map((m) => ({ c: m, u: canonicalizeUnit(m.unit) }));
    const family = canon[0].u.family;
    const ratio = ratioTableFor(canon[0].u.token);

    if (ratio) {
      // Convertible family: pick the coarsest token present, convert + sum.
      let displayToken = canon[0].u.token;
      for (const { u } of canon) {
        if (ratio[u.token] > ratio[displayToken]) displayToken = u.token;
      }
      const totalQuantity = canon.reduce(
        (sum, { c, u }) => sum + c.quantity * (ratio[u.token] / ratio[displayToken]),
        0,
      );
      return {
        unit: displayToken,
        unitFamily: family,
        totalQuantity,
        contributions: members,
      };
    }

    // count / unknown / ratio-less: single canonical token, plain sum.
    const totalQuantity = canon.reduce((sum, { c }) => sum + c.quantity, 0);
    return {
      unit: canon[0].u.token,
      unitFamily: family,
      totalQuantity,
      contributions: members,
    };
  });
}

// Tier-3 blend detection: per dish, the set of distinct ingredientIds that are
// Pantry, assigned to seasonings_dry, and NOT denylisted. 3+ such on one dish
// → all of them are blend components (worth pre-measuring together).
function detectBlendComponents(input: PrepCombineInput): Set<string> {
  const blendIds = new Set<string>();
  for (const meal of input.meals) {
    for (const dish of meal.dishes) {
      const drySeasonings = new Set<string>();
      for (const ing of dish.ingredients) {
        if (isDenied(ing.ingredientName)) continue;
        if (categoryKey(ing.category) !== "pantry") continue;
        if (assignPhase(ing.category, ing.ingredientName) === "seasonings_dry") {
          drySeasonings.add(ing.ingredientId);
        }
      }
      if (drySeasonings.size >= 3) {
        for (const id of drySeasonings) blendIds.add(id);
      }
    }
  }
  return blendIds;
}

// Tiered prep-worthy classification (D3/D4). Precedence: denylist → produce →
// protein → pantry(dry blend / sauces) → buy-and-use.
function classifyPrepWorthy(
  group: GroupAccumulator,
  phase: PrepPhaseKey | null,
  isBlendComponent: boolean,
): PrepWorthy {
  if (isDenied(group.ingredientName)) return "exclude"; // Tier 1
  switch (categoryKey(group.category)) {
    case "produce":
      // Tier 2: produce with a prep note (diced/minced/chopped/…) is prep work.
      return group.contributions.some(
        (c) => (c.preparationNote ?? "").trim() !== "",
      )
        ? "include"
        : "uncertain"; // Tier 4: whole produce, narration decides
    case "protein":
      return "uncertain"; // Tier 4: trimming/portioning judged by narration
    case "pantry":
      if (phase === "seasonings_dry") {
        // Tier 3: only a 3+ blend is worth pre-measuring; lone/under-3 = noise.
        return isBlendComponent ? "include" : "exclude";
      }
      return "uncertain"; // sauces_marinades — narration decides
    default:
      return "exclude"; // Dairy/Bakery/Frozen/Canned/unknown — buy-and-use
  }
}

// Walk the plan, group by ingredientId, canonicalize + sum units, retain
// per-meal attribution, assign phases, and apply the prep-worthy filter.
// Variant ingredient rows (red vs yellow onion = different ingredientId) stay
// separate groups by design — that is correct prep behavior, not a bug.
export function combinePrep(input: PrepCombineInput): PrepCombineResult {
  const groups = new Map<string, GroupAccumulator>();
  const order: string[] = [];

  for (const meal of input.meals) {
    for (const dish of meal.dishes) {
      for (const ing of dish.ingredients) {
        let g = groups.get(ing.ingredientId);
        if (!g) {
          g = {
            ingredientId: ing.ingredientId,
            ingredientName: ing.ingredientName,
            category: ing.category,
            contributions: [],
          };
          groups.set(ing.ingredientId, g);
          order.push(ing.ingredientId);
        }
        g.contributions.push({
          mealId: meal.mealId,
          mealName: meal.mealName,
          dishId: dish.dishId,
          dishName: dish.dishName,
          dishRole: dish.dishRole,
          quantity: ing.quantity,
          unit: ing.unit,
          ...(ing.preparationNote != null
            ? { preparationNote: ing.preparationNote }
            : {}),
        });
      }
    }
  }

  const blendIds = detectBlendComponents(input);

  // Seed the 4 fixed phases (empty entries retained — invariant shape).
  const phaseMap = new Map<PrepPhaseKey, PrepIngredientGroup[]>();
  for (const p of PREP_PHASE_ORDER) phaseMap.set(p, []);
  const excluded: PrepIngredientGroup[] = [];

  for (const id of order) {
    const g = groups.get(id)!;
    const phase = assignPhase(g.category, g.ingredientName);
    const isBlendComponent = blendIds.has(g.ingredientId);
    const prepWorthy = classifyPrepWorthy(g, phase, isBlendComponent);

    const entry: PrepIngredientGroup = {
      ingredientId: g.ingredientId,
      ingredientName: g.ingredientName,
      category: g.category,
      phase,
      prepWorthy,
      isBlendComponent,
      lines: buildLines(g.contributions),
    };

    // Excluded groups never populate a phase (keeps phases noise-free); they
    // are preserved in `excluded` for downstream audit. include/uncertain need
    // a real phase — buy-and-use categories (phase null) are always exclude, so
    // a null phase here would be a contradiction; route it to excluded too.
    if (prepWorthy === "exclude" || phase === null) {
      excluded.push(entry);
    } else {
      phaseMap.get(phase)!.push(entry);
    }
  }

  const phases: PrepPhase[] = PREP_PHASE_ORDER.map((p) => ({
    phase: p,
    entries: phaseMap.get(p)!,
  }));

  return {
    phases,
    excluded,
    totalEstimatedMinutes: 0, // narration block fills this
  };
}
