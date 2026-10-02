// WS7-8a Block 2 — loader → engine adapter.
//
// Maps the enriched prep-week loader output (PrepLoadedPlan) into the pure
// engine's input (PrepCombineInput). Two responsibilities the engine cannot do
// itself (both require data the engine input deliberately omits):
//
//  1. SERVINGS-SCALING — the loader ships RAW dish-ingredient quantities. We
//     scale per-dish, mirroring groceryList.ts exactly: the base is
//     dish.servingsDefault and the override is the plan-item's servingsOverride
//     (carried at meal level), so multiplier = (override ?? base) / base. No
//     override → multiplier 1. The engine then sums effective quantities.
//
//  2. "6 oz" COMPOUND-UNIT SPLIT — the one real seed unit that doesn't
//     canonicalize. `salmon fillets` is stored as quantity=2, unit="6 oz"
//     (2 fillets of 6 oz = 12 oz). We split the leading number out of the unit
//     and fold it into the quantity (2 × 6 = 12 oz) so it joins the weight
//     family instead of bucketing alone as an unknown unit.
//
// category comes straight off the Ingredient row (the loader now carries it);
// inferCategory is a defensive pocket fallback only, for the theoretical
// empty-category row.

import { inferCategory } from "./ingredientResolve";
import { assignPhase } from "./prepCombineEngine";
import { resolveDishComponents } from "./prepComponents";
import { resolveMoments } from "./prepMoments";
import type { PrepCombineInput } from "./prepCombineEngine";
import type { PrepLoadedPlan } from "./prepWeekAggregation";

// Leading "<number> <unit>" compound, e.g. "6 oz", "1.5 lb". The number is a
// per-unit pack size folded into the quantity; the remainder is the real unit.
const COMPOUND_UNIT_RE = /^\s*(\d+(?:\.\d+)?)\s+(\S.*?)\s*$/;

export function splitCompoundUnit(
  quantity: number,
  unit: string,
): { quantity: number; unit: string } {
  const m = unit.match(COMPOUND_UNIT_RE);
  if (!m) return { quantity, unit };
  const factor = Number.parseFloat(m[1]);
  if (!Number.isFinite(factor) || factor <= 0) return { quantity, unit };
  return { quantity: quantity * factor, unit: m[2] };
}

// ── H5.3 — THE SERVICE PORTION IS NOT PREP ──────────────────────────────────
//
// Hans, October 2: "Rounds / wedges / slices 'for topping' or 'for serving' are
// cook-day work, not prep." Cut citrus is also rule 6's first drop class, so it
// is doubly not prep — and a round sliced on Sunday is limp by Thursday.
//
// 🔴 IT IS REMOVED HERE, AT THE SOURCE, and therefore from the step, the
// container count and the minutes together. Demoting it later leaves the work
// costed and the vessel counted for something the cook is told not to do.
//
// 🔴 THIS IS THE PREP LANE ONLY. The limes stay in the recipe, the grocery list
// and Cook Mode, which read their own paths — the cook still cuts wedges on the
// night, which is the whole point.
const SERVICE_PURPOSE =
  /\bfor (?:topping|toppings|serving|garnish|the table)\b|\bto (?:serve|garnish)\b/i;
/** The cut forms that are service work when they are for service. */
const SERVICE_CUT =
  /\b(rounds?|wedges?|wedged|slices?|sliced|halves|halved|quartered)\b/i;
/** A leading count on a clause: "1 zested and juiced". */
const LEADING_COUNT = /^\s*(\d+(?:\.\d+)?|½|¼|¾|⅓|⅔)\s+(.*)$/;
const GLYPH: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };

/**
 * Split one ingredient row into the part that is PREP and the part that is
 * service. Returns null when the whole row is service and nothing is left to do
 * ahead.
 *
 * Only ever reduces: a note it does not recognise returns the row untouched.
 */
/**
 * Split one ingredient row into the part that is PREP and the part that is
 * cook-day service work. Returns null when nothing is left to do ahead.
 *
 * 🔴 ONLY CUT FORMS LEAVE. A chopped herb for garnish keeps everything —
 * including the words "for garnish" in its note, which is how rule 7's drop
 * class recognises it (lowValueClass). Stripping them would blind the drop pass.
 *
 * Only ever reduces: a shape it does not recognise returns the row untouched.
 */
export function prepPortion(
  ingredientName: string,
  quantity: number,
  unit: string,
  preparationNote: string | null,
): { quantity: number; preparationNote: string | null } | null {
  const note = (preparationNote ?? "").trim();
  const unchanged = { quantity, preparationNote };
  if (note === "") return unchanged;

  const clauses = note.split(/\s*,\s*/).map((c) => c.trim()).filter((c) => c !== "");
  // A purpose stated anywhere in the note governs the whole of it: "cut into
  // wedges, for serving" is one instruction split by a comma.
  const purposeSomewhere = clauses.some((c) => SERVICE_PURPOSE.test(c));
  if (!purposeSomewhere) return unchanged;

  // The cut may be named by the ingredient instead of the note: "lemon wedges".
  const nameIsCut = SERVICE_CUT.test(ingredientName);
  const isServiceClause = (c: string) =>
    SERVICE_CUT.test(c) || (SERVICE_PURPOSE.test(c) && nameIsCut);
  const serviceClauses = clauses.filter(isServiceClause);
  if (serviceClauses.length === 0) {
    // A purpose with no cut — "chopped, for garnish". Rule 7's business, not
    // this function's, and its note must survive for the drop pass to see it.
    return unchanged;
  }

  const keptClauses = clauses.filter(
    (c) => !isServiceClause(c) && !SERVICE_PURPOSE.test(c),
  );
  // Nothing but the cut and its purpose: the whole row is cook-day work.
  if (keptClauses.length === 0) return null;

  // A split row on a COUNT unit, where every clause states its own count. Less
  // regular than that and the quantity stands — a wrong number is worse than an
  // undivided one.
  const counted = (c: string): number | null => {
    const m = LEADING_COUNT.exec(c);
    if (!m) return null;
    const n = GLYPH[m[1]] ?? Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const keptNote = keptClauses.join(", ");
  const keptCounts = keptClauses.map(counted);
  const isCount = /^(each|whole|clove|cloves|head|heads|stalk|stalks|sprig|sprigs)$/i.test(
    unit.trim(),
  );
  if (!isCount || keptCounts.some((n) => n === null)) {
    return { quantity, preparationNote: keptNote };
  }
  const prepTotal = (keptCounts as number[]).reduce((x, y) => x + y, 0);
  // Never invent more than the row had.
  return { quantity: Math.min(quantity, prepTotal), preparationNote: keptNote };
}
export function buildPrepCombineInput(loaded: PrepLoadedPlan): PrepCombineInput {
  return {
    meals: loaded.meals.map((meal) => ({
      mealId: meal.mealId,
      mealName: meal.mealName,
      dishes: meal.dishes.map((dish) => {
        // ── WS9 D-WS9-296 — resolve this dish's mixtures ────────────────────
        //
        // Done HERE and not in the engine because it needs the dish's STEPS,
        // which the engine's input deliberately omits — the same reason the
        // servings scaling and the compound-unit split live in this adapter.
        //
        // `assignPhase` is called for the protein test (ruling 1) rather than a
        // second copy of the category rules; the engine exports it for exactly
        // this kind of pre-pass.
        const resolved = resolveDishComponents(
          dish.dishName,
          meal.mealName,
          // `?? []` on purpose: the field is new, and the loader always sets it,
          // but several hand-built fixtures are `as never`-cast and predate it.
          // A missing field must degrade to "no components", never throw.
          dish.componentSteps ?? [],
          dish.ingredients.map((i) => ({
            ingredientId: i.ingredientId,
            ingredientName: i.ingredientName,
            preparationNote: i.preparationNote,
            phase: assignPhase(i.category, i.ingredientName),
          })),
        );
        // ── D-WS9-301 rule 1 — the MOMENT each ingredient enters ───────────
        //
        // Same reason this lives in the adapter as the components above: it
        // needs the dish's STEPS, which the engine's input omits. One call per
        // dish; the result is an opaque per-ingredient key the assembly layer
        // buckets on.
        const moments = resolveMoments(
          dish.componentSteps ?? [],
          dish.ingredients.map((i) => ({
            ingredientId: i.ingredientId,
            ingredientName: i.ingredientName,
            preparationNote: i.preparationNote,
            phase: assignPhase(i.category, i.ingredientName),
          })),
        );
        // ── D-WS9-301 rule 1's INVERSE CASE — a component absorbs its run ───
        //
        // "The lemon-herb marinade… all its parts enter together (into the
        // marinade), so it is ONE container finished in ONE step — zest and
        // juice the lemon inside that step, never deferred to the produce
        // phase." The sample plan did the opposite and said so out loud: "Note:
        // the lemon zest and juice for this marinade are handled in the lemon
        // prep step — add them to this bowl once prepped."
        //
        // The marinade's own steps carry the component tag; the lemon's amount
        // is stated on a step that carries none. So the component supplies the
        // NAME and the run supplies MEMBERSHIP: whatever is measured in the same
        // run as a resolved component belongs in it.
        //
        // ⚠️ Proteins are excluded — ruling 1 again: raw flesh has a destination,
        // not a seat, and joins on cook day.
        // 🔴 AND RULE 2 IS WHAT STOPS IT SWALLOWING THE TACO ONION. "Dry blend:
        // 3+ dry items for one dish → one shelf-stable container… DRY ONLY.
        // Garlic, onion and fresh herbs never join a dry blend."
        //
        // Both of Hans's examples are "an unclaimed ingredient shares a run with
        // a component", and they must go opposite ways: the lemon DOES belong in
        // the marinade, the diced onion does NOT belong in the taco seasoning.
        // What tells them apart is the component itself — a marinade is wet and
        // things get added to it, a spice blend is dry and must stay shelf
        // stable. So an all-dry component absorbs nothing fresh.
        const phaseOfIngredient = new Map(
          dish.ingredients.map((i) => [i.ingredientId, assignPhase(i.category, i.ingredientName)]),
        );
        const componentKeyByRun = new Map<number, string>();
        for (const comp of resolved.components) {
          const allDry = comp.memberIds.every(
            (id) => phaseOfIngredient.get(id) === "seasonings_dry",
          );
          if (allDry) continue;
          for (const memberId of comp.memberIds) {
            const run = moments.runByIngredientId.get(memberId);
            if (run === undefined) continue;
            if (!componentKeyByRun.has(run)) componentKeyByRun.set(run, comp.key);
          }
        }
        const momentKeyFor = (ing: { ingredientId: string; category: string; ingredientName: string }): string | null => {
          const own = resolved.byIngredient.get(ing.ingredientId);
          if (own) return `c:${own.key}`;
          if (assignPhase(ing.category, ing.ingredientName) === "proteins") {
            return moments.keyByIngredientId.get(ing.ingredientId) ?? null;
          }
          const run = moments.runByIngredientId.get(ing.ingredientId);
          const shared = run === undefined ? undefined : componentKeyByRun.get(run);
          if (shared) return `c:${shared}`;
          return moments.keyByIngredientId.get(ing.ingredientId) ?? null;
        };
        // Ruling 1 — a raw protein named by a mixture's steps joins it on cook
        // day. One protein can only join one bowl; first by component order.
        const cookDayIntoByIngredientId = new Map<string, string>();
        for (const c of resolved.components) {
          for (const id of c.cookDayIds) {
            if (!cookDayIntoByIngredientId.has(id)) cookDayIntoByIngredientId.set(id, c.bowlName);
          }
        }
        // WS7-8 BUG-003 — DENOMINATOR is the immutable authored anchor
        // (authoredBaseServings ?? baseServings); the NUMERATOR keeps its
        // no-override fallback of the live baseServings (= servingsDefault).
        // Anchor == baseServings until a future canonical promote, so today the
        // multiplier is unchanged.
        const authoredBase = dish.authoredBaseServings ?? dish.baseServings;
        const base = authoredBase > 0 ? authoredBase : 1;
        const effective = meal.servingsOverride ?? dish.baseServings;
        const multiplier = effective / base;
        return {
          dishId: dish.dishId,
          dishName: dish.dishName,
          dishRole: dish.dishRole,
          ingredients: dish.ingredients.flatMap((ing) => {
            const split = splitCompoundUnit(ing.quantity, ing.unit);
            // H5.3 — drop the service portion before anything downstream can
            // cost it, name it or count a vessel for it.
            const prep = prepPortion(
              ing.ingredientName,
              split.quantity,
              split.unit,
              ing.preparationNote,
            );
            if (prep === null) return [];
            const category =
              ing.category && ing.category.trim() !== ""
                ? ing.category
                : inferCategory(ing.ingredientName);
            const comp = resolved.byIngredient.get(ing.ingredientId) ?? null;
            const cookDayInto = cookDayIntoByIngredientId.get(ing.ingredientId) ?? null;
            return [{
              ingredientId: ing.ingredientId,
              ingredientName: ing.ingredientName,
              category,
              quantity: prep.quantity * multiplier,
              unit: split.unit,
              preparationNote: prep.preparationNote,
              component: comp
                ? { key: comp.key, noun: comp.noun, bowlName: comp.bowlName }
                : null,
              cookDayInto,
              momentKey: momentKeyFor({
                ingredientId: ing.ingredientId,
                category,
                ingredientName: ing.ingredientName,
              }),
              // D-WS9-297 ruling 8 — passed straight through. The compound-unit
              // split above touches the DEMAND's unit; the yield is a property
              // of the ingredient and is unaffected by it.
              sourceYield: ing.sourceYield,
            }];
          }),
        };
      }),
    })),
  };
}
