// SERVER-10 E (BUG-597) — A WEEKNIGHT MEAL'S UNIT-LESS AMOUNTS SAY THEIR NOUN FOR THE
// PLAN'S NUMBER, AT READ TIME.
//
// QA-COOK-1 read "1 limes", "1 eggs" and "1 porterhouse steaks" in Cook Mode: a dish
// authored for 4, served for 2. The server serves the authored step and its amountRefs
// ("Cut 2 limes into wedges", a ref on the "2" with no unit); the client puts the
// plan's number in the ref's place and cannot re-word the prose after it. A feast has
// said its nouns since THX-3d round 2 (O) (feastScaleFrames scaleFrames); this is the
// same rule (refNounEdits) for every other meal read in its plan, from the same
// multipliers the grocery list and Prep the Week scale by (dishRowMultipliers over
// (servingsOverride ?? servingsDefault) / the authored servings).
//
// Read time only (GET /meals/:id?planItemId=), nothing stored. A plan item with a
// recipe override is left as it is: its ingredient list is the override's, and its
// steps' refs still point at the recipe's rows.

import type { PrismaClient } from "@prisma/client";

import { agreeScaledNouns, type RefRows } from "./feastScaleFrames";
import type { WordingRef, WordingStep } from "./feastCookWording";
import { dishRowMultipliers } from "./prepQuantity";

export interface ScaledNounDish {
  dishId: string;
  /** Dish.servingsDefault and its authored anchor, as composeMealDetail serves them. */
  servings: number;
  authoredServingsDefault: number;
  steps: { stepIndex: number; text: string; amountRefs: WordingRef[] | null }[];
}

/** Each dish's rows by ingredient id, at the plan's servings. Pure. */
export function scaledNounRows(
  dish: Pick<ScaledNounDish, "servings" | "authoredServingsDefault">,
  ingredients: readonly { ingredientId: string; quantity: number; unit: string; name: string; note: string | null }[],
  servingsOverride: number | null,
): RefRows {
  const authored = dish.authoredServingsDefault > 0 ? dish.authoredServingsDefault : 1;
  const mult = dishRowMultipliers(ingredients, (servingsOverride ?? dish.servings) / authored);
  const rows = new Map<string, { mult: number; name: string; unit: string }>();
  ingredients.forEach((ing, i) => {
    if (!rows.has(ing.ingredientId)) rows.set(ing.ingredientId, { mult: mult[i], name: ing.name, unit: ing.unit });
  });
  return rows;
}

/** The steps whose words change, by dish and step index. One query. */
export async function scaledNounsFor(
  prisma: Pick<PrismaClient, "dishIngredient">,
  dishes: readonly ScaledNounDish[],
  servingsOverride: number | null,
): Promise<Map<string, Map<number, WordingStep>>> {
  const out = new Map<string, Map<number, WordingStep>>();
  const scaled = dishes.filter((d) => (servingsOverride ?? d.servings) !== d.authoredServingsDefault);
  if (scaled.length === 0) return out;
  const all = await prisma.dishIngredient.findMany({
    where: { dishId: { in: scaled.map((d) => d.dishId) } },
    orderBy: { positionIndex: "asc" },
    select: { dishId: true, ingredientId: true, quantity: true, unit: true, preparationNote: true, ingredient: { select: { displayName: true } } },
  });
  for (const d of scaled) {
    const rows = scaledNounRows(
      d,
      all.filter((x) => x.dishId === d.dishId).map((x) => ({ ingredientId: x.ingredientId, quantity: x.quantity, unit: x.unit, name: x.ingredient.displayName, note: x.preparationNote })),
      servingsOverride,
    );
    for (const st of d.steps) {
      const step: WordingStep = { stepIndex: st.stepIndex, text: st.text, amountRefs: st.amountRefs };
      const w = agreeScaledNouns(step, rows);
      if (w === step) continue;
      if (!out.has(d.dishId)) out.set(d.dishId, new Map());
      out.get(d.dishId)!.set(st.stepIndex, w);
    }
  }
  return out;
}
