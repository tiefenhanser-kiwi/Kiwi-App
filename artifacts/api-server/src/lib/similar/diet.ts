// SAFE-1 (Part B) — the user's stored diet as a swap-pool filter.
//
// THE GAP (FIX-2's disclosure). Swap for Similar filters the pool by the user's
// allergens but had no meatless signal, so a vegetarian user swapping a
// vegetarian pasta could be offered Carbonara. The catalog has no diet column:
// Meal.tags carry cuisine and difficulty only, and Ingredient.category puts
// chicken, tofu and eggs together under "Protein" (measured on dev October 17).
// What every meal does have is its ingredient rows, so the signal is their
// CANONICAL NAMES (and the names of the dish's store-bought swap products —
// Dish.substitutions — which the bought path puts in the cart).
//
// It is a word list, so it can be wrong both ways; the SAFE-1 report measures
// it against the whole dev catalog. It leans strict: an ambiguous line
// ("chicken or vegetable broth", "dashi") counts as animal, because a wrong
// "vegetarian" puts meat in front of a vegetarian, and a wrong "meat" only
// costs them one option.
//
// The diets read: Vegetarian (no meat, poultry, fish or seafood), Pescatarian
// (no meat or poultry), Vegan (vegetarian, and no dairy, eggs or honey). The
// other eating styles (Keto, Low-carb, …) are not exclusions and are ignored.
// Rennet cheeses (Parmesan) are NOT treated as non-vegetarian here: the catalog
// writes plain "parmesan" for the vegetarian-labelled kind too, and the THX
// vegetarian rule that does exclude them is a generation rule, not a reading.

export type DietRestriction = "vegetarian" | "pescatarian" | "vegan";

/** The restricting eating styles in a stored `eatingStyles` list (any case). */
export function dietRestrictionsOf(eatingStyles: readonly string[] | null | undefined): DietRestriction[] {
  const out = new Set<DietRestriction>();
  for (const s of eatingStyles ?? []) {
    const v = s.trim().toLowerCase();
    if (v === "vegetarian" || v === "pescatarian" || v === "vegan") out.add(v);
  }
  return [...out];
}

/** Lines that name an animal word but are not one (checked first). */
const NOT_ANIMAL =
  /\b(vegetarian|vegan|plant[- ]based|meatless|meat[- ]free|veggie|impossible|beyond meat|tofu|seitan|tempeh|jackfruit|chicken[- ]style|beefsteak|oyster mushrooms?|oyster crackers?|duck sauce|goat cheese|goat's milk cheese|hot dog (buns?|rolls?)|frank's|celery ribs?|(cauliflower|cabbage|mushroom|portobello|celeriac|eggplant) steaks?|(crab|crawfish|shrimp|seafood) boil(?: seasoning)?|fish-free|eggplant|coconut meat)\b/i;

/** Meat and poultry (land animals), including their stocks, fats and gelatin. */
const MEAT =
  /\b(chicken|beef|pork|bacon|hams?|prosciutto|pancetta|guanciale|chorizo|salami|pepperoni|mortadella|soppressata|speck|kielbasa|bratwursts?|andouille|linguiça|chouriço|sausages?|hot dogs?|frankfurters?|turkey|duck|goose|quail|lamb|mutton|veal|goat|venison|bison|rabbit|steaks?|brisket|chuck|sirloin|ribeye|rib-eye|tenderloins?|short ribs?|spare ribs?|ribs|oxtail|tripe|livers?|giblets|meatballs?|meatloaf|lard|suet|tallow|gelatin|schmaltz|drippings|pastrami|jerky|char siu|carnitas|birria|porchetta|cutlets?|meat)\b/i;

/** Fish and seafood, and the sauces made from them. */
const FISH =
  /\b(fish|salmon|tuna|cod|halibut|tilapia|trout|snapper|haddock|mahi[- ]?mahi|mahi|swordfish|catfish|sardines?|anchov(?:y|ies)|mackerel|branzino|sea bass|pollock|flounder|grouper|shrimp|prawns?|crab|crabmeat|lobsters?|scallops?|clams?|mussels?|oysters?|squid|calamari|octopus|crawfish|crayfish|langoustines?|roe|caviar|bonito|dashi|worcestershire|nuoc cham|surimi|seafood|clam juice)\b/i;

/** Dairy, eggs and honey (vegan only). */
const ANIMAL_PRODUCT =
  /\b(milk|butter|cheeses?|cream|yogh?urt|ghee|eggs?|egg yolks?|egg whites?|honey|mayonnaise|mayo|buttermilk|parmesan|parmigiano|pecorino|mozzarella|cheddar|ricotta|feta|paneer|halloumi|gruyère|gruyere|fontina|provolone|monterey jack|cotija|queso|mascarpone|burrata|brie|crème fraîche|creme fraiche|whey|custard|ice cream)\b/i;
const NOT_ANIMAL_PRODUCT =
  /\b(peanut butter|almond butter|nut butter|cashew butter|sunflower butter|cocoa butter|apple butter|butter beans?|butter lettuce|coconut (milk|cream)|(almond|oat|soy|rice|cashew) (milk|cream|yogh?urt)|cream of tartar|vegan|plant[- ]based|dairy[- ]free|egg[- ]free|eggless|nutritional yeast)\b/i;

export type AnimalKind = "meat" | "fish" | "animal_product";

/** What a single ingredient line is, for diet purposes (null = plant). */
export function animalKindOf(name: string): AnimalKind | null {
  const n = name.toLowerCase();
  if (!NOT_ANIMAL.test(n)) {
    // Seafood first: "lump crab meat" and "tuna steaks" are seafood, not meat.
    if (FISH.test(n)) return "fish";
    if (MEAT.test(n)) return "meat";
  } else if (/\b(chicken|beef|pork) (broth|stock|bouillon)\b/.test(n) && !/\b(vegetarian|vegan|plant[- ]based|chicken[- ]style)\b/.test(n)) {
    return "meat";
  }
  if (ANIMAL_PRODUCT.test(n) && !NOT_ANIMAL_PRODUCT.test(n)) return "animal_product";
  return null;
}

/** May a meal whose lines are `names` be served under every one of `restrictions`? */
export function fitsDiets(names: readonly string[], restrictions: readonly DietRestriction[]): boolean {
  if (restrictions.length === 0) return true;
  const kinds = new Set(names.map(animalKindOf).filter((k): k is AnimalKind => k !== null));
  for (const r of restrictions) {
    if (kinds.has("meat")) return false;
    if ((r === "vegetarian" || r === "vegan") && kinds.has("fish")) return false;
    if (r === "vegan" && kinds.has("animal_product")) return false;
  }
  return true;
}

/**
 * FIX-4 (A) — a generated meal before it has ingredients: its title and its
 * one-line description. Each is split at the joins a dinner title uses ("Tofu
 * and Shrimp Pad Thai", "Ribeye with Chimichurri") so one plant word cannot
 * excuse the animal word beside it (animalKindOf reads a NOT_ANIMAL word in a
 * line as "this line is not an animal"). Same leaning as the line reader: a
 * title that names an animal fails.
 */
export function generatedMealFitsDiets(
  title: string,
  description: string | null | undefined,
  restrictions: readonly DietRestriction[],
): boolean {
  if (restrictions.length === 0) return true;
  const parts = [title, description ?? ""]
    .flatMap((t) => t.split(/,|;|\/|\s+(?:and|with|&|\+|over|on|in|plus|or)\s+/i))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return fitsDiets(parts, restrictions);
}

/** The ingredient and swap-product names of a meal row (the select below). */
export function mealLineNames(row: {
  dishLinks: { dish: { substitutions: unknown; dishIngredients: { ingredient: { canonicalName: string } }[] } }[];
}): string[] {
  const out: string[] = [];
  for (const l of row.dishLinks) {
    for (const i of l.dish.dishIngredients) out.push(i.ingredient.canonicalName);
    const subs = l.dish.substitutions;
    if (Array.isArray(subs)) {
      for (const s of subs) {
        const p = (s as { product?: unknown })?.product;
        if (typeof p === "string") out.push(p);
      }
    }
  }
  return out;
}

export const MEAL_LINE_NAMES_SELECT = {
  id: true,
  dishLinks: {
    select: {
      dish: {
        select: {
          substitutions: true,
          dishIngredients: { select: { ingredient: { select: { canonicalName: true } } } },
        },
      },
    },
  },
} as const;
