// FIX-4 (B) — what the Pick shelf takes from Tell Kiwi's text.
//
// THE GAP (Hans, October 17: "when I update the tell kiwi text it's not
// listening"). POST /wizard/shelf ran the parse and used ONE thing from it:
// a named meal, matched as a substring of a catalog TITLE. Everything else the
// text said was dropped, so "easy dinners for two", "something with whipped
// cream" and "NY strip steak, medium-rare" returned the same 15 cards (measured
// on dev: 15 of 15 shared, three texts in a row), and "NY Strip Steak" came
// back unmatched because no dinner is TITLED that — the strip-steak dinners
// name it in their ingredients.
//
// Two readings are added, both catalog-only (no invention on this path) and
// both under the shelf's hard filters (allergens, diet):
//   • a named meal the titles miss is matched on INGREDIENT names, the name
//     first and then with its leading qualifiers dropped ("ny strip steak" →
//     "strip steak"), never below two words;
//   • a food DESCRIPTOR ("whipped cream", "salmon", "sheet-pan") puts up to
//     DESCRIPTOR_PINS meals whose title or ingredients name it at the top.
//     Mood and constraint words ("easy", "healthy", "cozy") are skipped: they
//     are the wizard's preferences, not something a title or a pantry names.
// Whatever still matches nothing is returned for "Couldn't find: …", so the
// screen always answers the text it was given.

import type { Prisma } from "@prisma/client";

export const DESCRIPTOR_PINS = 3;

const NOT_A_FOOD = new Set([
  "easy", "quick", "fast", "simple", "simpler", "healthy", "healthier", "light", "lighter",
  "comfort", "comforting", "comfort food", "cozy", "hearty", "family", "family-friendly",
  "kid-friendly", "kids", "budget", "cheap", "affordable", "inexpensive", "fresh", "weeknight",
  "weeknights", "mild", "not spicy", "spicy", "low-carb", "low carb", "keto", "high-protein",
  "high protein", "protein", "vegetarian", "vegan", "pescatarian", "gluten-free", "dairy-free",
  "fancy", "impressive", "date night", "summer", "fall", "autumn", "winter", "spring", "seasonal",
  "make-ahead", "leftovers", "variety", "new", "different", "classic", "filling", "satisfying",
  "lean", "crowd-pleaser", "crowd-pleasing", "flavorful", "tasty", "delicious", "low-calorie",
  "low calorie", "balanced", "nutritious", "medium-rare", "medium rare", "rare", "well-done",
  "for two", "for one", "for four", "dinner", "dinners", "meals", "something",
]);

/** The descriptors worth matching against the catalog, lower-cased, deduped. */
export function foodDescriptors(descriptors: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of descriptors) {
    const d = raw.trim().toLowerCase();
    if (d.length < 3 || NOT_A_FOOD.has(d) || out.includes(d)) continue;
    out.push(d);
  }
  return out;
}

/**
 * The ingredient phrases a named meal is tried as, longest first: the name,
 * then with leading words dropped while two or more remain. "NY Strip Steak"
 * → ["ny strip steak", "strip steak"]; "Chicken Tikka" → ["chicken tikka"].
 */
export function ingredientPhrasesFor(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; words.length - i >= 2; i++) out.push(words.slice(i).join(" "));
  return out;
}

/** Meals with an ingredient whose canonical name contains `phrase`. */
export function ingredientNamedWhere(phrase: string): Prisma.MealWhereInput {
  return {
    dishLinks: {
      some: {
        dish: {
          dishIngredients: {
            some: { ingredient: { canonicalName: { contains: phrase, mode: "insensitive" } } },
          },
        },
      },
    },
  };
}

/** Meals whose title or ingredients name a descriptor. */
export function descriptorWhere(descriptor: string): Prisma.MealWhereInput {
  return {
    OR: [{ title: { contains: descriptor, mode: "insensitive" } }, ingredientNamedWhere(descriptor)],
  };
}
