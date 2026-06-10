// WS7-6 Block 2 — shared ingredient resolver.
//
// Why this exists: both materializeWizardDraft (wizardActivation.ts) and the
// new save-canonical materializeMeal (mealMaterialize.ts) need to take a list
// of free-text ingredient names (chicken thighs, harissa paste, crushed
// tomatoes…) and turn them into Ingredient row IDs without throwing on the
// first unseen name — mealCreate.ts's strict resolver intentionally throws
// on a miss (Q-P1-2) and is unsuitable here. This module owns the
// upsert-with-inferred-category + purchase-default lookup pattern that
// previously lived inline at wizardActivation.ts:382-411.
//
// Pass split convention: ingredient upserts run on the plain PrismaClient
// (NOT inside the meal-graph tx) so a later tx rollback doesn't lose them.
// Ingredient rows are write-once reference content; orphaning them is
// harmless and the next call reuses them. This matches the comment block
// at wizardActivation.ts:285-298.

import type { PrismaClient } from "@prisma/client";

import { lookupPurchaseDefault } from "./ingredientPurchaseDefaults";

// ── inferCategory ───────────────────────────────────────────────────────
// Deterministic keyword map, no AI, no I/O — safe to call hot.
// Output is one of: "Produce" | "Protein" | "Dairy" | "Pantry" | "Bakery" |
// "Frozen" | "Canned" | "Snacks" | "Household". Unknowns fall back to
// "Pantry". CATEGORY_TO_SECTION in groceryList.ts maps every value here to
// a StoreSection (WS7-5d Block 1 expanded that map to match).
//
// Ordering note (preserved verbatim from wizardActivation.ts): Canned must
// come before Produce so multi-token "diced tomato" wins over the bare
// "tomato" Produce match (WS7-5d Block 2 fix). Same trick for "pickled" →
// Canned over "jalapeño" → Produce, and "broth"/"stock" → Canned over the
// bare "chicken" → Protein keyword (WS7-5d Blocks 4, 5).

type IngredientCategory =
  | "Produce"
  | "Protein"
  | "Dairy"
  | "Pantry"
  | "Bakery"
  | "Frozen"
  | "Canned"
  | "Snacks"
  | "Household";

export const INGREDIENT_CATEGORY_FALLBACK: IngredientCategory = "Pantry";

interface CategoryRule {
  category: IngredientCategory;
  keywords: string[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "Frozen",
    keywords: ["frozen", "ice cream", "gelato", "sorbet"],
  },
  {
    category: "Canned",
    keywords: [
      "canned",
      "diced tomato", "crushed tomato", "stewed tomato",
      "tomato sauce", "tomato paste", "tomato puree",
      "enchilada sauce", "marinara",
      "coconut milk", "coconut cream",
      "chickpea", "black bean", "kidney bean", "pinto bean",
      "white bean", "cannellini bean", "navy bean", "refried bean",
      "tuna",
      "pickled",
      "capers",
      "broth",
      "stock",
    ],
  },
  {
    category: "Snacks",
    keywords: [
      "chip", "chips", "pretzel", "popcorn", "crackers",
      "granola bar", "trail mix", "potato chip", "tortilla chip",
    ],
  },
  {
    category: "Household",
    keywords: [
      "paper towel", "toilet paper", "trash bag", "garbage bag",
      "dish soap", "laundry detergent", "sponge", "aluminum foil",
      "plastic wrap", "parchment paper", "zip-top bag",
    ],
  },
  {
    category: "Produce",
    keywords: [
      "onion", "garlic", "tomato", "lettuce", "spinach", "kale", "arugula",
      "carrot", "celery", "potato", "sweet potato", "bell pepper",
      "cucumber", "zucchini", "broccoli", "cauliflower", "mushroom", "avocado",
      "lemon", "lime", "orange", "apple", "banana", "berries",
      "strawberry", "blueberry", "raspberry", "blackberry", "mango",
      "pineapple", "grape", "pear", "peach", "plum",
      "cilantro", "parsley", "basil", "mint", "rosemary", "thyme", "sage",
      "dill", "tarragon", "oregano leaves",
      "scallion", "green onion", "shallot", "leek", "ginger", "chive",
      "cabbage", "asparagus", "eggplant", "squash", "corn", "peas",
      "green bean", "radish", "beet", "fennel", "bok choy", "watercress",
      "jalapeno", "jalapeño", "chili pepper", "chile pepper",
      "lettuce mix", "salad greens", "spring mix", "romaine", "kale",
    ],
  },
  {
    category: "Protein",
    keywords: [
      "chicken", "beef", "pork", "lamb", "turkey", "duck", "veal",
      "bacon", "sausage", "ham", "prosciutto", "salami", "pepperoni",
      "chorizo", "meatballs",
      "fish", "salmon", "tuna", "cod", "tilapia", "trout", "halibut",
      "shrimp", "prawn", "crab", "lobster", "scallop", "squid", "calamari",
      "anchovy", "sardine", "mackerel",
      "tofu", "tempeh", "seitan",
      "ground beef", "ground turkey", "ground pork", "ground chicken",
      "chicken breast", "chicken thigh", "chicken wing", "chicken leg",
      "steak", "ribeye", "sirloin", "filet", "pork chop", "ribs", "brisket",
    ],
  },
  {
    category: "Dairy",
    keywords: [
      "milk", "buttermilk", "butter", "cream", "heavy cream", "half and half",
      "yogurt", "yoghurt", "greek yogurt", "sour cream", "creme fraiche",
      "cheese", "cheddar", "parmesan", "mozzarella", "feta", "ricotta",
      "goat cheese", "cream cheese", "cottage cheese", "brie", "blue cheese",
      "swiss", "gouda", "provolone", "havarti", "manchego",
      "ghee", "egg", "eggs", "egg yolk", "egg white",
    ],
  },
  {
    category: "Bakery",
    keywords: [
      "bread", "tortilla", "bun", "roll", "naan", "pita", "bagel",
      "croissant", "biscuit", "muffin", "english muffin",
      "taco shell", "wrap", "baguette", "sourdough", "ciabatta",
      "focaccia", "brioche", "pretzel",
    ],
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordMatches(name: string, keyword: string): boolean {
  if (keyword.includes(" ")) {
    return name.includes(keyword);
  }
  return new RegExp(`\\b${escapeRegExp(keyword)}(?:es|s)?\\b`, "i").test(name);
}

export function inferCategory(name: string): string {
  const lower = name.toLowerCase().trim();
  if (!lower) return INGREDIENT_CATEGORY_FALLBACK;
  for (const rule of CATEGORY_RULES) {
    for (const k of rule.keywords) {
      if (keywordMatches(lower, k)) return rule.category;
    }
  }
  return INGREDIENT_CATEGORY_FALLBACK;
}

// ── resolveIngredients ──────────────────────────────────────────────────
// Take a list of free-text ingredient mentions, upsert each unique
// canonical name once on the plain PrismaClient, and return a
// canonical→ingredientId map the caller uses inside its meal-graph tx to
// write DishIngredient rows.
//
// Why plain PrismaClient and not the tx: see top-of-file note. Upserts
// commit independently; a later tx rollback leaves harmless orphan
// Ingredient rows that the next call reuses.

export interface IngredientMention {
  // The original-cased free-text name as the AI / user typed it. Used as
  // displayName on first create; on hit, the existing displayName is kept
  // (update: {}). Empty/whitespace-only names are silently skipped — Zod
  // schemas enforce .min(1) at the route boundary so this is defense in
  // depth.
  name: string;
  // The unit string is stored on the Ingredient row as defaultUnit on
  // first create. Wizard + builder + parsed-meal inputs all carry a unit.
  unit: string;
}

/**
 * Upsert one Ingredient row per unique canonical name and return the
 * canonical-name → ingredient-id map. Pass the plain PrismaClient (NOT a
 * TransactionClient) — see top-of-file note on why the upserts commit
 * outside the caller's tx.
 *
 * On create: stores `displayName` from the first-occurrence original-cased
 * name, `category` from `inferCategory`, `defaultUnit` from the mention's
 * `unit`, and `purchaseUnit / purchaseQuantity / purchaseDisplay` from
 * `lookupPurchaseDefault` when the canonical name is in the shared
 * defaults table (avoids the gap-fill storm on the first generate-
 * grocery-list call — see wizardActivation.ts:381-411 commentary).
 *
 * On hit: `update: {}` — never overwrites existing rows. Categories,
 * display names, and purchase fields are write-once reference content;
 * a later AI-reconciliation pass (D-WS7-065 / WS6 6c-4 analog) refines.
 */
export async function resolveIngredients(
  prisma: PrismaClient,
  mentions: Iterable<IngredientMention>,
): Promise<Map<string, string>> {
  type Discovered = {
    canonical: string;
    displayName: string;
    defaultUnit: string;
  };
  const discovered = new Map<string, Discovered>();
  for (const m of mentions) {
    const canonical = m.name.toLowerCase().trim();
    if (!canonical) continue;
    if (!discovered.has(canonical)) {
      discovered.set(canonical, {
        canonical,
        displayName: m.name.trim(),
        defaultUnit: m.unit,
      });
    }
  }

  const out = new Map<string, string>();
  for (const d of discovered.values()) {
    const purchase = lookupPurchaseDefault(d.canonical);
    const upserted = await prisma.ingredient.upsert({
      where: { canonicalName: d.canonical },
      update: {},
      create: {
        canonicalName: d.canonical,
        displayName: d.displayName,
        category: inferCategory(d.canonical),
        defaultUnit: d.defaultUnit,
        ...(purchase
          ? {
              purchaseUnit: purchase.purchaseUnit,
              purchaseQuantity: purchase.purchaseQuantity,
              purchaseDisplay: purchase.purchaseDisplay,
            }
          : {}),
      },
      select: { id: true },
    });
    out.set(d.canonical, upserted.id);
  }
  return out;
}
