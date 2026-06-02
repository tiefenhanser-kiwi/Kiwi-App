// WS7-5b-server — wizard draft activation ("Save and use" materializer).
//
// Reads the hidden draft (isWizardDraft=true) written by WS7-5a expand and
// materializes it into real Meal / Dish / MealDishLink / DishIngredient /
// RecipeInstructionStep / MealPlanItem rows so the existing plan-view UX
// renders it as a real plan.
//
// Why not createMealWithDishes? mealCreate.ts:121-131 enforces strict
// canonicalName resolution and throws on any miss. Wizard-AI ingredient
// names mostly will not pre-exist (chicken thighs, harissa, etc.) so the
// strict resolver fires on nearly every activation. Activation needs an
// upsert path with deterministic category inference instead.
//
// Category inference is a deterministic keyword map (NO AI call, no latency).
// Approximate for uncommon names; D-WS7-065 acknowledges a future master-
// data reconciliation pass (analogous to WS6 6c-4 purchaseUnit writeback)
// would refine categories without touching this file.

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  WizardExpandedPlanSchema,
  type WizardExpandedPlan,
} from "./ai/schemas/wizard";
import { lookupPurchaseDefault } from "./ingredientPurchaseDefaults";

export class WizardDraftNotFoundError extends Error {
  constructor(public readonly draftId: string) {
    super(`Wizard draft not found: ${draftId}`);
    this.name = "WizardDraftNotFoundError";
  }
}

export class WizardDraftMalformedError extends Error {
  constructor(
    public readonly draftId: string,
    public readonly reason: string,
  ) {
    super(`Wizard draft malformed: ${draftId} (${reason})`);
    this.name = "WizardDraftMalformedError";
  }
}

// ── inferCategory ────────────────────────────────────────────────────────
// Maps an ingredient canonical name to the Ingredient.category vocabulary.
// Seeded vocab (devData.ts) covers "Produce" | "Protein" | "Dairy" |
// "Pantry" | "Bakery" | "Frozen"; WS7-5d Block 2 extends the wizard-side
// inference to also emit "Canned" | "Snacks" | "Household" so canned items
// (crushed tomatoes, enchilada sauce, coconut milk) and the section-map
// additions Block 1 made in CATEGORY_TO_SECTION route to the right
// StoreSection instead of falling through to Pantry/extras.
// D-WS7-065: this is still a first-pass deterministic map. Uncommon
// ingredients land in "Pantry" by default; a later AI-reconciliation pass
// can refine — out of scope for this block.
//
// Structure: a rules array (keyword → category). Easy to extend; a future
// reconciliation pass can re-categorize ingredients without touching the
// activation transaction.

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
  // WS7-5d Block 2: Canned must come before Produce so multi-token keywords
  // like "diced tomatoes" / "crushed tomatoes" win over the bare "tomato"
  // Produce match. Block 1 confirmed live mis-categorizations of these into
  // Pantry; with the expanded CATEGORY_TO_SECTION map they now route to the
  // 'canned' StoreSection on activation.
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
    ],
  },
  // WS7-5d Block 2: Snacks — conservative keyword set. Bare "chips" matches
  // word-boundary single-token, so "tortilla chips" / "potato chips" route
  // here without picking up adjacent terms like "chip cookies".
  {
    category: "Snacks",
    keywords: [
      "chip", "chips", "pretzel", "popcorn", "crackers",
      "granola bar", "trail mix", "potato chip", "tortilla chip",
    ],
  },
  // WS7-5d Block 2: Household — non-food groceries. Multi-token keywords
  // are substring matches so "paper towels" / "trash bags" still route.
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
  // "Pantry" — implicit fallback. Spices (paprika, cumin, oregano),
  // condiments (soy sauce, vinegar, ketchup, mustard), oils, vinegars,
  // grains (rice, quinoa, farro), pasta, flour, sugar, canned goods,
  // dried beans, seasonings — all land here without an explicit rule,
  // matching the seeded vocabulary.
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordMatches(name: string, keyword: string): boolean {
  if (keyword.includes(" ")) {
    // Multi-token keyword: simple substring is the closest match heuristic
    // ("ground beef" should match "1 lb ground beef, lean").
    return name.includes(keyword);
  }
  // Single-token keyword: word-boundary, with a permissive trailing 's' so
  // plurals match without bloating the keyword list.
  return new RegExp(`\\b${escapeRegExp(keyword)}s?\\b`, "i").test(name);
}

/**
 * Infer an Ingredient.category value from a canonical-name string. Output
 * is one of: "Produce" | "Protein" | "Dairy" | "Pantry" | "Bakery" |
 * "Frozen" | "Canned" | "Snacks" | "Household". Unknowns fall back to
 * "Pantry". CATEGORY_TO_SECTION in groceryList.ts maps every value here to
 * a StoreSection (WS7-5d Block 1 expanded that map to match).
 *
 * Deterministic, no AI, no I/O. Safe to call inside the activation
 * transaction without inflating latency.
 */
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

// ── materializeWizardDraft ──────────────────────────────────────────────

export interface MaterializeWizardDraftOptions {
  // Plain Prisma client — used for the non-transactional preamble (read of
  // the draft row, Zod parse, ingredient upserts). Pass 1 commits as it
  // goes; orphaned ingredient rows from a later-aborted plan-graph tx are
  // harmless (no plan references them; the next activation reuses them).
  prisma: PrismaClient;
  // Transactional client — used for Pass 2 (meal-graph writes that must
  // be all-or-nothing).
  tx: Prisma.TransactionClient;
  userId: string;
  draftId: string;
  // WS7-5c Block A — optional pre-merged payload. The three-stage wizard
  // splits "view details" from "finalize at save": activate/save callers
  // read the details-stage draft, run wizard.candidate.finalize_steps
  // BEFORE the tx, merge per-dish steps in, then hand the merged
  // WizardExpandedPlan to the materializer here. When `payload` is
  // provided we still read the draft row (for the ownership +
  // isWizardDraft invariant — keeping that check in one place), but we
  // SKIP the Zod parse of optimizationNotes (the draft is stepless and
  // would fail the with-steps WizardExpandedPlanSchema) and materialize
  // from `payload` instead.
  payload?: WizardExpandedPlan;
}

export interface MaterializeWizardDraftResult {
  expanded: WizardExpandedPlan;
  mealsCreated: number;
  dishesCreated: number;
  itemsCreated: number;
  ingredientsTouched: number;
  // WS7-5b-mobile FIX — PRD §2.4: every wizard plan persists as a
  // MealPlanTemplate (auto-saved, hidden) + a linked MealPlanInstance. The
  // route handler reads this and writes it into the Instance's
  // mealPlanTemplateId in the same transaction.
  mealPlanTemplateId: string;
}

/**
 * Read the hidden draft row, parse its stored WizardExpandedPlan JSON, and
 * materialize the meal graph (Meal + Dish + MealDishLink + DishIngredient +
 * RecipeInstructionStep + MealPlanItem) so the activated plan reads back
 * through the existing plan-view paths.
 *
 * Split across two clients to keep the atomic critical section small:
 * - Pass 1 (draft read, Zod parse, ingredient upserts) runs on the plain
 *   `prisma` client. Ingredient rows are write-once reference content;
 *   committing them independently is safe — a later rollback of Pass 2
 *   leaves them as harmless orphans that the next activation reuses.
 * - Pass 2 (meal-graph writes) runs on the caller's `tx`. The caller is
 *   responsible for the active-flip + activity emit + flipping
 *   isWizardDraft → false within the same transaction.
 *
 * @throws WizardDraftNotFoundError if the draft isn't owned by userId or
 *   isn't a wizard draft.
 * @throws WizardDraftMalformedError if optimizationNotes doesn't parse as
 *   a WizardExpandedPlan, or if a dish ingredient name fails to resolve in
 *   the upserted map (Pass 1 covers every non-empty name).
 */
export async function materializeWizardDraft(
  opts: MaterializeWizardDraftOptions,
): Promise<MaterializeWizardDraftResult> {
  const { prisma, tx, userId, draftId, payload } = opts;

  // ── Pass 1 (non-transactional): read draft, parse, upsert ingredients ─

  // WS7-5c Block A: when `payload` is provided, the caller already read +
  // parsed the details-stage draft and ran wizard.candidate.finalize_steps
  // to produce the merged with-steps shape. We still read the row for the
  // ownership + isWizardDraft invariant (cheap; keeps that check in one
  // place). When `payload` is null we ALSO need optimizationNotes to parse
  // ourselves — so always select it; the wasted bytes when `payload` is
  // set are negligible (a single row read of a small JSON blob).
  const draft = await prisma.mealPlanInstance.findUnique({
    where: { id: draftId },
    select: {
      userId: true,
      isWizardDraft: true,
      optimizationNotes: true,
    },
  });
  if (!draft || draft.userId !== userId || !draft.isWizardDraft) {
    throw new WizardDraftNotFoundError(draftId);
  }

  let expanded: WizardExpandedPlan;
  if (payload) {
    // Validate the merged payload defensively — the materializer's invariant
    // is that the shape it sees parses against WizardExpandedPlanSchema
    // (steps required). The caller already ran a parse to assemble payload,
    // but the validation here is the durable post-merge gate matching the
    // §27 round-trip contract.
    const parsed = WizardExpandedPlanSchema.safeParse(payload);
    if (!parsed.success) {
      const reason =
        parsed.error.issues
          .slice(0, 3)
          .map((i) => i.path.join(".") || "root")
          .join(",") || "shape_mismatch";
      throw new WizardDraftMalformedError(draftId, reason);
    }
    expanded = parsed.data;
  } else {
    const parsed = WizardExpandedPlanSchema.safeParse(draft.optimizationNotes);
    if (!parsed.success) {
      const reason =
        parsed.error.issues
          .slice(0, 3)
          .map((i) => i.path.join(".") || "root")
          .join(",") || "shape_mismatch";
      throw new WizardDraftMalformedError(draftId, reason);
    }
    expanded = parsed.data;
  }

  // Collect unique ingredients, upsert each once.
  // Preserve the first-occurrence original-cased name as displayName for
  // newly created rows; the AI-emitted unit becomes defaultUnit. Existing
  // rows keep their displayName/defaultUnit untouched (update: {}).
  type Discovered = {
    canonical: string;
    displayName: string;
    defaultUnit: string;
  };
  const discovered = new Map<string, Discovered>();
  for (const m of expanded.meals) {
    for (const d of m.dishes) {
      for (const ing of d.ingredients) {
        const canonical = ing.name.toLowerCase().trim();
        if (!canonical) continue;
        if (!discovered.has(canonical)) {
          discovered.set(canonical, {
            canonical,
            displayName: ing.name.trim(),
            defaultUnit: ing.unit,
          });
        }
      }
    }
  }

  const ingredientIdByCanonical = new Map<string, string>();
  for (const d of discovered.values()) {
    // WS7-5d Block 2: populate purchaseUnit/Quantity/Display on create when
    // the canonical name is in the shared defaults table. Without this,
    // every freshly-wizarded ingredient row has null purchase fields →
    // guaranteed miss on the cache gate in
    // groceryListAI.fillPurchaseSizesWithWriteBack → serial Haiku gap-fill
    // storm on the first generate-grocery-list call. Genuine unknowns
    // (ingredients NOT in the table) intentionally remain null so the
    // gap-fill path still handles them on demand.
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
    ingredientIdByCanonical.set(d.canonical, upserted.id);
  }

  // ── Pass 2 (transactional): materialize the meal graph. ─────────────
  let mealsCreated = 0;
  let dishesCreated = 0;
  let itemsCreated = 0;

  for (let mi = 0; mi < expanded.meals.length; mi++) {
    const m = expanded.meals[mi];

    const meal = await tx.meal.create({
      data: {
        userId,
        title: m.title,
        sourceType: "wizard",
        cuisineType: m.cuisineType,
        mealType: "dinner",
        difficulty: m.difficulty,
        estimatedTimeMinutes: m.estimatedTimeMinutes,
        servingsDefault: m.servings,
        isPublic: false,
        isArchived: false,
      },
      select: { id: true },
    });
    mealsCreated++;

    for (let di = 0; di < m.dishes.length; di++) {
      const d = m.dishes[di];

      // Per-dish macros: if the wizard expand pass produced numbers and the
      // estimate didn't fail, write them into the *PerServing cache so the
      // activated plan's macros tile renders immediately. Failed/null
      // macros leave the cache at the schema default (0), and the existing
      // planNeedsMacroEstimation predicate (planMacros.ts:142-184) will
      // surface a stale flag for a follow-up recalc.
      const macros =
        d.macros && !d.macros.failed
          ? {
              caloriesPerServing: d.macros.caloriesPerServing,
              proteinGPerServing: d.macros.proteinGPerServing,
              carbsGPerServing: d.macros.carbsGPerServing,
              fatGPerServing: d.macros.fatGPerServing,
            }
          : {};

      const dish = await tx.dish.create({
        data: {
          userId,
          title: d.title,
          sourceType: "wizard",
          estimatedTimeMinutes: m.estimatedTimeMinutes,
          difficulty: m.difficulty,
          servingsDefault: m.servings,
          isArchived: false,
          ...macros,
        },
        select: { id: true },
      });
      dishesCreated++;

      await tx.mealDishLink.create({
        data: {
          mealId: meal.id,
          dishId: dish.id,
          positionIndex: d.positionIndex,
          roleLabel: d.role,
        },
      });

      for (let ii = 0; ii < d.ingredients.length; ii++) {
        const ing = d.ingredients[ii];
        const canonical = ing.name.toLowerCase().trim();
        const ingredientId = ingredientIdByCanonical.get(canonical);
        if (!ingredientId) {
          // Pass 1 upserted every non-empty name. Hitting this branch means
          // an empty-or-whitespace ingredient name made it past the Zod
          // schema's .min(1) — surface as a malformed-draft error rather
          // than 500ing on a Prisma FK violation.
          throw new WizardDraftMalformedError(
            draftId,
            `ingredient_missing:${ing.name}`,
          );
        }
        await tx.dishIngredient.create({
          data: {
            dishId: dish.id,
            ingredientId,
            quantity: ing.quantity,
            unit: ing.unit,
            preparationNote: ing.preparationNote ?? null,
            isOptional: ing.isOptional ?? false,
            positionIndex: ii,
          },
        });
      }

      for (let si = 0; si < d.steps.length; si++) {
        const text = d.steps[si];
        await tx.recipeInstructionStep.create({
          data: {
            ownerType: "dish",
            ownerId: dish.id,
            stepIndex: si,
            stepTextRaw: text,
            stepTextTranslated: text,
          },
        });
      }
    }

    await tx.mealPlanItem.create({
      data: {
        mealPlanInstanceId: draftId,
        mealId: meal.id,
        positionIndex: mi,
        isBreakfast: false,
        isLunch: false,
        isDinner: true,
      },
    });
    itemsCreated++;
  }

  // WS7-5b-mobile FIX — PRD §2.4. Wizard plans must persist as a
  // MealPlanTemplate (auto-saved, hidden) + a linked MealPlanInstance.
  // Pre-fix: the draft → activate/save path left mealPlanTemplateId null
  // and stuffed the WizardExpandedPlan JSON into optimizationNotes; that
  // broke Plan Review's mobile PlanSchema parse (couldn't-load-this-plan)
  // and rendered blank My Plans cards. Description carries whyBullets
  // (PRD §5.6 candidate copy) as bullet copy so the card subtext renders.
  // imageUrl stays null — WS7-10 owns stock-image integration. Dedup-by-
  // meal-set (PRD §2.4 line 258) is deferred to D-WS7-071; this path
  // creates a fresh Template per wizard plan and accepts dupes for now.
  const description = expanded.whyBullets.map((b) => `• ${b}`).join("\n");
  const template = await tx.mealPlanTemplate.create({
    data: {
      userId,
      title: expanded.title,
      description,
      tags: expanded.tags,
      sourceType: "wizard",
      defaultDaysCount: expanded.meals.length,
      imageUrl: null,
      isPublic: false,
      isArchived: false,
    },
    select: { id: true },
  });

  return {
    expanded,
    mealsCreated,
    dishesCreated,
    itemsCreated,
    ingredientsTouched: discovered.size,
    mealPlanTemplateId: template.id,
  };
}
