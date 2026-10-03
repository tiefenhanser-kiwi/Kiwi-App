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
// BUG-340 — the shelf-stable test lives with the storage table it protects, so
// the phase classifier and the storage note cannot drift apart.
import { SHELF_STABLE_PROTEIN } from "./prepStorage";
import { PrepWeekPhaseKey, type PrepWeekPhaseKeyT } from "./ai/schemas/prepWeek";
import { ingredientGroupKey } from "./ingredientRelations";

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
  // D-WS9-297 ruling 8 — the whole ingredient this one is a component of, and
  // its yield ("lime", 3, "tbsp"). Carried, never interpreted: the engine sums
  // quantities and the assembly layer turns this into a fruit count.
  sourceYield?: SourceYield | null;
  /** [prepcook] H7 2e — `Ingredient.purchaseUnit`; see WET_PACKS. */
  purchaseUnit?: string | null;
  /**
   * WS9 D-WS9-296 — the mixture this ingredient belongs to WITHIN ITS DISH, and
   * the bowl it is portioned into. Resolved by the adapter from the dish's steps
   * (see prepComponents.ts); null for an ingredient that belongs to no mixture,
   * which keeps today's per-ingredient step.
   */
  component?: IngredientComponent | null;
  /**
   * D-WS9-296 ruling 1 — the bowl this ingredient joins ON COOK DAY rather than
   * sitting in. Set for a raw protein a mixture's steps name: the marinade is
   * prepped on Sunday, the steak meets it on Friday.
   */
  cookDayInto?: string | null;
  /**
   * D-WS9-301 rule 1 — the MOMENT this ingredient enters the cooking process,
   * as an opaque dish-local key (see prepMoments.ts). Two ingredients of one
   * dish sharing this key are one container; different keys are separate
   * containers. Supersedes `component` as the grouping key: a component is one
   * of the three signals that produce it, and the strongest.
   */
  momentKey?: string | null;
  /** H6.2 — the cook step that names this portion, or null when none does. */
  entryStep?: number | null;
}

/** D-WS9-296 — a mixture's identity and its bowl, as the engine carries it. */
export interface IngredientComponent {
  /** Stable within the dish: the step group that assembles the mixture. */
  key: string;
  /** The label ("marinade"); null for a numbered or seasoning fallback. */
  noun: string | null;
  /** The finished, user-facing vessel name. */
  bowlName: string;
  /**
   * Part J.1 (R2) — any of the component's own steps is heat (a `cook` phase or a
   * heat verb). A heated component is never a raw mix, whatever its combine step
   * says ("toss the green beans with oil" before they roast).
   */
  heated?: boolean;
}

/** D-WS9-297 ruling 8 — a `component` edge's magnitude, from ingredient_relations. */
export interface SourceYield {
  fromName: string;
  quantity: number;
  unit: string;
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
  /**
   * D-WS9-296 — the mixture this CONTRIBUTION joins. On the contribution rather
   * than the group because a component is per (dish, ingredient): the plan's
   * garlic is one ingredient group feeding four dishes, and each dish's share
   * goes to a different bowl.
   */
  component?: IngredientComponent | null;
  /**
   * D-WS9-296 ruling 1 — a raw protein has a DESTINATION, not a seat. When set,
   * this contribution is not a member of the bowl; it joins on cook day and the
   * engine writes that sentence.
   */
  cookDayInto?: string | null;
  /**
   * D-WS9-301 rule 1 — the moment key, per (dish, ingredient) for the same
   * reason `component` is: the plan's garlic is one group feeding four dishes
   * and each dish's share enters its own dish at its own moment.
   */
  momentKey?: string | null;
  /** H6.2 — the cook step that names this portion, or null when none does. */
  entryStep?: number | null;
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
  // D-WS9-297 ruling 8 — null for the vast majority; set for a derived
  // component (lime juice, lemon zest) so the narration layer can say how many
  // whole ones it takes.
  sourceYield: SourceYield | null;
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

// ── [prepcook] H7 2e — THE DRY PHASE HOLDS ONLY DRY THINGS ──────────────────
//
// `dijon mustard` sat in the dry phase on two plans — twice on `2251c7f5` — and
// mayonnaise beside it, because the Pantry split below is a NAME rule and neither
// name carries a sauce word. Extending the word list is the shape this whole pass
// keeps paying for (a pattern matching a name instead of its subject), so the
// catalog answers first: `Ingredient.purchaseUnit` is the pack the thing is bought
// in, and nothing poured or spooned comes in a spice container.
//
// Measured over the whole catalog on 2026-10-02: of the Pantry rows the name rule
// sends to the dry phase, every one bought by the jar, bottle, tube or can is a
// condiment, an olive, a liquid or a paste — dijon, whole-grain and creole
// mustard, mayonnaise, honey, molasses, tahini, salsa, ketchup, sriracha, olives,
// water. Not one dry spice is bought that way; they come in a container, a bag, a
// box or a packet.
//
// ⚠️ A NULL PACK KEEPS THE NAME RULE. 380 of those rows have no purchaseUnit yet,
// and "no catalog answer" must not be read as "dry". That gap is the next lane's
// regex → catalog migration, not this one.
const WET_PACKS: ReadonlySet<string> = new Set([
  "jar", "jars", "bottle", "bottles", "tube", "tubes", "can", "cans", "carton", "cartons",
]);

// Produce/Protein map cleanly on every row. Pantry splits by the catalog pack
// (above), then by a name heuristic (liquid/sauce hint → sauces_marinades, else
// seasonings_dry). Buy-and-use categories (Dairy/Bakery/Frozen/Canned/unknown)
// have no prep phase → null.
export function assignPhase(
  category: string,
  name: string,
  purchaseUnit?: string | null,
): PrepPhaseKey | null {
  const pantryPhase = (): PrepPhaseKey => {
    if (purchaseUnit && WET_PACKS.has(purchaseUnit.trim().toLowerCase())) return "sauces_marinades";
    const nn = normalizeIngredientName(name);
    return SAUCE_NAME_HINTS.some((h) => nn.includes(h))
      ? "sauces_marinades"
      : "seasonings_dry";
  };
  switch (categoryKey(category)) {
    case "produce":
      return "produce";
    case "protein":
      // BUG-340 — anchovy paste is categorised Protein, so it landed in the
      // Proteins phase and inherited D-WS9-298's raw-flesh line: a jar that
      // keeps for months told to cook within 2 days. `Ingredient.category` is
      // NOT the place to fix it — grocery aisles read that column and
      // D-WS9-211 ruled it is not a usable cross-check — so the form decides.
      // A shelf-stable protein is treated exactly like a pantry item, which is
      // what it is on the shelf; "paste" is already a sauce hint, so the
      // anchovy goes where the Caesar dressing it joins is built.
      return SHELF_STABLE_PROTEIN.test(normalizeIngredientName(name))
        ? pantryPhase()
        : "proteins";
    case "pantry":
      return pantryPhase();
    default:
      return null;
  }
}

// ── core combine + attribute ───────────────────────────────────────────────

interface GroupAccumulator {
  ingredientId: string;
  ingredientName: string;
  category: string;
  sourceYield: SourceYield | null;
  purchaseUnit: string | null;
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
        if (assignPhase(ing.category, ing.ingredientName, ing.purchaseUnit) === "seasonings_dry") {
          // H6.1 — the blend detector counts DISTINCT FOODS, for the same reason
          // the groups do: two rows for one spice are not two items of a 3+ blend.
          drySeasonings.add(ingredientGroupKey(ing.ingredientName));
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
/**
 * D-WS9-301 rule 4 — "Ground meat is never touched — no portioning, no forming,
 * nothing until the pan."
 *
 * Knife work on produce and on WHOLE proteins is prep: cubing a chuck roast or
 * cutting chicken into strips saves real weeknight time. Ground meat saves
 * none — it goes from the package into the skillet — and the census was
 * producing "Portion the ground beef for the Hamburger Steaks", "Keep the 1¼ lb
 * ground beef in its original packaging", and a dozen more steps whose whole
 * content was "do nothing to this".
 *
 * Matched on the NAME, because the category is `Protein` for ground and whole
 * alike and `Ingredient.category` is not a usable discriminator (D-WS9-211).
 */
const GROUND_MEAT = /\bground\s+(?:beef|turkey|pork|chicken|lamb|veal|sausage|meat|bison|venison)\b/i;

export const isGroundMeat = (name: string) => GROUND_MEAT.test(name);

function classifyPrepWorthy(
  group: GroupAccumulator,
  phase: PrepPhaseKey | null,
  isBlendComponent: boolean,
): PrepWorthy {
  if (isDenied(group.ingredientName)) return "exclude"; // Tier 1
  // Rule 4 — before the category switch, because it is a statement about the
  // FORM of the food and no category can express it.
  if (isGroundMeat(group.ingredientName)) return "exclude";
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
// ── H6.2 item 2 — A PORTION THAT NEEDS NO ACTION IS NOT PREP ────────────────
//
// "3 cloves, unpeeled — for the Roasted Tomatillo Sauce" asks the cook to put three
// whole cloves in a labelled tub on Sunday so that on Thursday they can take three
// whole cloves out of it. It is not work, it is not a step line, and it fills no
// container. The tomatillo sauce roasts them whole; they stay in the bag.
//
// ⚠️ ONLY AN EXPLICIT NO-WORK NOTE. A row with NO note at all is a different case —
// whole produce the narrator still judges (D-WS9-299 tier 4) — and must not be swept
// up here.
const NO_WORK_NOTE =
  /^(?:\s*(?:left\s+)?(?:whole|unpeeled|uncut|intact|as[- ]is|skin[- ]on|in its skin|unopened|in the bag)\b[\s,;.]*)+$/i;

export function isNoWorkPortion(preparationNote: string | null | undefined): boolean {
  const note = (preparationNote ?? "").trim();
  if (note === "") return false;
  return NO_WORK_NOTE.test(note);
}

export function combinePrep(
  input: PrepCombineInput,
  /**
   * H6.1 ruling 1 — ingredientId → the id its food groups under, from
   * loadPrepWeekInput's `identity`. It carries the folds only the catalog knows
   * (the plan's synonym edges); the name fold below is applied regardless, so a
   * caller without this still merges every garlic spelling.
   */
  foldedIdByIngredientId?: ReadonlyMap<string, string>,
): PrepCombineResult {
  const groups = new Map<string, GroupAccumulator>();
  const order: string[] = [];

  // ── H6.1 ruling 1 — ONE INGREDIENT IS ONE FOOD, NOT ONE ROW ──────────────
  //
  // The sample plan had "Mince all garlic" (10 cloves, 3 dishes) and "Mince all
  // garlic cloves" (17, five more) because the catalog carries `garlic` and
  // `garlic cloves` as two rows. The grocery list has always folded them —
  // `ingredientGroupKey` is the function it folds with — and the prep lane was
  // the only one still keying on the row.
  //
  // The representative is the SMALLEST id of the merged set, so the surviving
  // `produce#<id>` stepKey does not depend on which meal the user dragged first.
  // 🔴 ONE SOURCE OR THE OTHER, NEVER BOTH CONCATENATED. The loader's map is
  // already the union of the name fold and the plan's synonym edges, and it sends
  // every member of a group to that group's root — so with the map in hand the
  // name key is redundant, and including it alongside the id put the RAW id back
  // into the key and merged nothing at all.
  //
  // Without the map — a test, a fixture, any caller that has no database — the
  // pure name key is the whole answer, which still folds every garlic spelling.
  const keyOf = (ing: { ingredientId: string; ingredientName: string }) =>
    foldedIdByIngredientId
      ? (foldedIdByIngredientId.get(ing.ingredientId) ?? ing.ingredientId)
      : ingredientGroupKey(ing.ingredientName);
  const representative = new Map<string, string>();
  for (const meal of input.meals) {
    for (const dish of meal.dishes) {
      for (const ing of dish.ingredients) {
        const k = keyOf(ing);
        const cur = representative.get(k);
        if (cur === undefined || ing.ingredientId < cur) representative.set(k, ing.ingredientId);
      }
    }
  }

  for (const meal of input.meals) {
    for (const dish of meal.dishes) {
      for (const ing of dish.ingredients) {
        const groupId = representative.get(keyOf(ing)) ?? ing.ingredientId;
        let g = groups.get(groupId);
        if (!g) {
          g = {
            ingredientId: groupId,
            ingredientName: ing.ingredientName,
            category: ing.category,
            sourceYield: ing.sourceYield ?? null,
            purchaseUnit: ing.purchaseUnit ?? null,
            contributions: [],
          };
          groups.set(groupId, g);
          order.push(groupId);
        }
        // 🔴 H6.2 item 2 — A NO-WORK PORTION IS NOT A LINE. Dropped here, at the
        // contribution, because an ingredient's portions are not all alike: the garlic
        // is one merged group of eight, and exactly one of them is "3 cloves, unpeeled"
        // for a sauce that roasts them whole. Withholding only its container still left
        // it on the step, reading "3 cloves — leave unpeeled", which is a line asking
        // the cook to do nothing. Its quantity goes with it, so 24 cloves get minced.
        if (isNoWorkPortion(ing.preparationNote)) continue;
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
          ...(ing.component ? { component: ing.component } : {}),
          ...(ing.cookDayInto ? { cookDayInto: ing.cookDayInto } : {}),
          // D-WS9-301 rule 1 — carried, never interpreted here. The assembly
          // layer buckets on it; the engine only has to not lose it.
          ...(ing.momentKey ? { momentKey: ing.momentKey } : {}),
          // H6.2 follow-up — carried, never interpreted here, exactly as momentKey is.
          ...(ing.entryStep != null ? { entryStep: ing.entryStep } : {}),
        });
      }
    }
  }


  // ── H6.1 — ONE FOOD, ONE UNIT ─────────────────────────────────────────────
  //
  // Merging `garlic` with `garlic cloves` produced a group whose contributions
  // used two units — "cloves" from one catalog row and nothing at all from the
  // other — so the per-unit sum below kept them as two lines and the step costed
  // 10 cloves plus "1 clove" instead of 27.
  //
  // Within ONE group a bare count and a count-unit are the same thing, so the
  // unitless contributions adopt the sibling unit. Across groups they are not, and
  // this never looks outside one.
  const COUNTISH = /^(?:|each|whole)$/i;
  for (const g of groups.values()) {
    const named = g.contributions.find(
      (c) => typeof c.unit === "string" && c.unit.trim() !== "" && !COUNTISH.test(c.unit.trim()),
    );
    if (!named) continue;
    const unit = named.unit as string;
    // Only a COUNT unit may be adopted — never a weight or a volume, where a bare
    // number says nothing about how much food there is.
    if (!/^(?:cloves?|heads?|stalks?|sprigs?|ears?|slices?)$/i.test(unit.trim())) continue;
    for (const c of g.contributions) {
      if (typeof c.unit === "string" && !COUNTISH.test(c.unit.trim())) continue;
      c.unit = unit;
    }
  }

  const blendIds = detectBlendComponents(input);

  // Seed the 4 fixed phases (empty entries retained — invariant shape).
  const phaseMap = new Map<PrepPhaseKey, PrepIngredientGroup[]>();
  for (const p of PREP_PHASE_ORDER) phaseMap.set(p, []);
  const excluded: PrepIngredientGroup[] = [];

  for (const id of order) {
    const g = groups.get(id)!;
    const phase = assignPhase(g.category, g.ingredientName, g.purchaseUnit);
    // H6.1 — keyed on the FOOD, matching what detectBlendComponents collects. The
    // first draft changed the set to group keys and left this reading ids, which
    // emptied the dry phase on all 14 plans — the table caught it immediately.
    const isBlendComponent = blendIds.has(ingredientGroupKey(g.ingredientName));
    const prepWorthy = classifyPrepWorthy(g, phase, isBlendComponent);

    const entry: PrepIngredientGroup = {
      ingredientId: g.ingredientId,
      ingredientName: g.ingredientName,
      category: g.category,
      phase,
      prepWorthy,
      isBlendComponent,
      sourceYield: g.sourceYield,
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
