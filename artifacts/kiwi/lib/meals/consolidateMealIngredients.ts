// WS9 D-WS9-058 (BUG-331) — THE MEAL'S COMPLETE INGREDIENT LIST, DEDUPLICATED.
//
// Ruled July 20 2026 and never built. Hans's report is what surfaced it: "there's
// text 'ingredients' which is hard to see just above the 'adjust for servings'
// function. it is supposed to expand, but no-ops when I click now." It never
// expanded — git history says the label has been an inert `<Text>` since
// WS5-5F and nothing near it was ever pressable, and no "Ingredients" disclosure
// exists on any other screen. He is remembering the ruling, not a regression.
//
// The ruling: a modal with the meal's complete consolidated list, deduplicated
// across dishes, display-only (never written to the server), reachable from a
// "View Ingredients" button on the meal card in Plan Details and in the meals
// list views. The two questions it left open are ruled here: the same
// ingredient across dishes SUMS, and the list reflects the DISPLAYED (scaled)
// servings.
//
// ── ⛔ THE ONE THING THIS MUST NOT DO ──────────────────────────────────────
//
// SUM ONLY WHAT IS COMPARABLE. A dish wanting `2 cup` of something and another
// wanting `1 head` of it do not add up, and the client has no density and no
// per-ingredient factor to make them — the server is never asked to send one
// (see lib/format/grocery.ts's BUG-147 note: relating ml to grams needs a
// DENSITY, which is per-ingredient and lives server-side). So two units that
// cannot be related produce TWO LINES under one name, and the reader decides.
// Guessing here would be the same failure the grocery line refuses at the pack:
// decline and print.
//
// The grouping key is the normalised name plus `canonicalUnitToken`'s client
// twin, `normalizeUnitToken` — the same token `composePackName` compares with,
// so "cup"/"cups" and "clove"/"cloves" key together and nothing else is folded.
// An unknown unit keys alone, which is the safe answer for a unit we hold no
// factor for.
//
// Pure and in lib/ because app/** is outside the test glob (D-WS9-164). The
// sheet that renders it is components/MealIngredientsSheetView.tsx.

import { formatIngredientLine, ingredientAmountNote } from "../format/ingredientLine";
import { normalizeUnitToken } from "../format/grocery";
import {
  displayedQuantity,
  isFeastMeal,
  lineMultiplier,
  mealScaleFactors,
  roundsPerShare,
} from "../format/quantity";
import type { MealDetail } from "../api/meals";

/** One consolidated line: a name, an amount, and where it came from. */
export interface ConsolidatedIngredient {
  /** The name as authored, from the first dish that contributed it. */
  name: string;
  /** Summed across every contributing dish, already scaled. */
  quantity: number;
  /** The unit as authored (not the canonical token) — that is what reads. */
  unit: string;
  /** Titles of the dishes that contributed, in meal order, deduplicated. */
  dishTitles: string[];
  /** The rendered line, through the SAME formatter the meal screen uses. */
  line: string;
  /** WEB-4 — the egg note ("recipe calls for ¾ at 2 servings"), or null. */
  note: string | null;
}

/**
 * Normalise a name for grouping only. Case and surrounding whitespace go; a
 * trailing prep clause goes too, because "lemon, juiced" and "lemon" are one
 * shopping thought — the SURVIVING name keeps whichever form arrived first, so
 * nothing is lost from the display.
 */
function groupKeyName(name: string): string {
  const comma = name.indexOf(",");
  return (comma === -1 ? name : name.slice(0, comma)).trim().toLowerCase();
}

/**
 * The meal's ingredients, summed across dishes and scaled to the displayed
 * servings.
 *
 * `multiplier` is the meal screen's own `servingsMultiplier`
 * (displayServings / authoredServingsDefault) — passed in rather than derived
 * so the sheet and the inline list cannot disagree about the denominator, which
 * is the WS7-8 BUG-003 anchor and not `meal.servings`.
 *
 * Ordering is first-appearance in meal order: dishes in `positionIndex` order,
 * ingredients in authored order within each. Not alphabetical — the reader is
 * about to shop or cook, and the recipe's own order is the one they have seen.
 */
export function consolidateMealIngredients(
  meal: Pick<MealDetail, "dishes"> & { tags?: readonly string[] },
  multiplier = 1,
  /** WEB-4 — the servings the multiplier scales to, for the egg note. */
  servings?: number,
  /** THX-4 — the turkey weight the cook chose (meal.birdWeightLb); null, the servings rule. */
  birdLb?: number | null,
): ConsolidatedIngredient[] {
  // WEB-4d — `raw` is the true sum behind a per-share-rounded quantity; `scaled`
  // whether any share was scaled at all; `prep` the first share's prep note.
  const byKey = new Map<
    string,
    ConsolidatedIngredient & { titles: Set<string>; raw: number; scaled: boolean; perShare: boolean; prep: string }
  >();
  const order: string[] = [];

  // WEB-4c (BUG-462) — a bird's parts are one per bird of the MEAL's bird.
  // WEB-4c — and in a feast only, a dish follows its bird written by count.
  const feast = isFeastMeal(meal.tags);
  // THX-4 — a chosen turkey weight is mealScaleFactors' rule, one rule for both screens.
  const scale = mealScaleFactors(meal.dishes, multiplier, feast, birdLb);
  for (const dish of meal.dishes) {
    // WEB-4b (BUG-454) — a whole-bird dish scales by its bird's factor.
    const factor = scale.byDish[dish.dishId];
    const birds = scale.birds[dish.dishId];
    for (const ing of dish.ingredients) {
      const unit = (ing.unit ?? "").trim();
      // ⛔ The unit token is the second half of the key. Two units that
      // normalise differently NEVER merge, so cup + head is two lines.
      const key = `${groupKeyName(ing.name)}|${normalizeUnitToken(unit)}`;
      // FIX-7 rule 4 — a whole bird by weight is not scaled down; the line
      // below gets multiplier 1, so the bird rule has to be applied here.
      const lineFactor = lineMultiplier(factor, unit, ing.name, ing.quantity, birds);
      const scaled = ing.quantity * lineFactor;
      const isScaled = Math.abs(lineFactor - 1) > 1e-9;
      const prep = ing.preparationNote ?? "";
      // WEB-4d (R5) — produce, packages and pieces round SHARE BY SHARE, then
      // sum, each by its own cut word and its own scaling (an unscaled share is
      // as written).
      const perShare = roundsPerShare(unit, ing.name);
      const shown = perShare ? displayedQuantity(scaled, unit, ing.name, { scaled: isScaled, note: prep }) : scaled;
      const hit = byKey.get(key);
      if (hit) {
        hit.quantity += shown;
        hit.raw += scaled;
        hit.scaled ||= isScaled;
        hit.titles.add(dish.title);
      } else {
        byKey.set(key, {
          name: ing.name,
          quantity: shown,
          raw: scaled,
          scaled: isScaled,
          perShare,
          prep,
          unit,
          dishTitles: [],
          line: "",
          note: null,
          titles: new Set([dish.title]),
        });
        order.push(key);
      }
    }
  }

  return order.map((key) => {
    const row = byKey.get(key)!;
    const dishTitles = [...row.titles];
    return {
      name: row.name,
      quantity: row.quantity,
      unit: row.unit,
      dishTitles,
      // The multiplier is ALREADY applied above — pass 1 here, or the scaling
      // lands twice. The formatter is shared so the sheet's lines and the meal
      // screen's lines pluralise and glyph identically (BUG-321).
      // WEB-4d — shares already rounded are not rounded again as a sum.
      line: formatIngredientLine(
        { name: row.name, quantity: row.quantity, unit: row.unit, preparationNote: row.prep },
        {
          multiplier: 1,
          scaled: row.perShare ? false : row.scaled,
          packageScaled: row.perShare && row.scaled ? row.raw : undefined,
        },
      ),
      note: ingredientAmountNote(
        { name: row.name, quantity: row.quantity, unit: row.unit },
        { multiplier: 1, servings },
      ),
    };
  });
}

/**
 * How many lines the sheet will show — used by the entry-point buttons so a
 * meal with no ingredients does not offer a button that opens an empty sheet.
 */
export function consolidatedIngredientCount(
  meal: Pick<MealDetail, "dishes">,
): number {
  return consolidateMealIngredients(meal).length;
}
