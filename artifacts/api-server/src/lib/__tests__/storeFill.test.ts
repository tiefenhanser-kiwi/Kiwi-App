// Plan-Gen Arc · Block 3 (D-WS9-041 / D-WS9-044) — store-fill harness core tests.
// Pure logic + a fake-tx materialize assertion (dish-owned steps) + a list-driven
// dry-run orchestration test with a fake runAICall (no network, no DB).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@prisma/client";
import type { WizardExpandEnrichedMealDetails } from "../ai/schemas/wizard";
import type { runAICall as productionRunAICall } from "../ai/runAICall";
import { materializeMeal } from "../mealMaterialize";
import {
  STORE_FILL_TARGET,
  buildMaterializePayload,
  dedupKey,
  deriveAllergens,
  isCarbIngredient,
  isProteinIngredient,
  isVegIngredient,
  mealComplete,
  mergeSteps,
  runStoreFill,
  generateInput,
  validateBug040Meal,
  type GenProfile,
} from "../storeFill";

// ── factories ────────────────────────────────────────────────────────────────

const PROFILE: GenProfile = { key: "test", servings: 4, difficulty: "easy" };

function macros() {
  return {
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
  };
}

/** A valid, complete two-dish dinner (main + base). Overrides let tests break it. */
function makeMeal(
  over: Partial<WizardExpandEnrichedMealDetails> = {},
): WizardExpandEnrichedMealDetails {
  return {
    title: "Seared Chicken with Rice",
    cuisineType: "American",
    estimatedTimeMinutes: 35,
    difficulty: "easy",
    servings: 4,
    dishes: [
      {
        title: "Seared Chicken",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "chicken breast", quantity: 1, unit: "pound" },
          { name: "olive oil", quantity: 2, unit: "tablespoon" },
        ],
        macros: macros(),
      },
      {
        title: "Steamed Rice",
        role: "base",
        positionIndex: 1,
        ingredients: [{ name: "white rice", quantity: 1, unit: "cup" }],
        macros: macros(),
      },
    ],
    ...over,
  };
}

function singleDish(
  title: string,
  ingredients: { name: string; quantity: number; unit: string }[],
): WizardExpandEnrichedMealDetails {
  return makeMeal({
    dishes: [{ title, role: "main", positionIndex: 0, ingredients, macros: macros() }],
  });
}

function finalizeFor(meal: WizardExpandEnrichedMealDetails) {
  return {
    dishSteps: meal.dishes.map((_d, di) => ({
      mealIndex: 0,
      dishIndex: di,
      steps: [
        { text: "Prep the components.", phaseType: "prep" as const, estimatedMinutes: 5, isTimingSensitive: false },
        { text: "Cook until done.", phaseType: "cook" as const, estimatedMinutes: 12, isTimingSensitive: true },
      ],
    })),
  };
}

// ── ingredient classification ────────────────────────────────────────────────

describe("ingredient classification", () => {
  it("isProteinIngredient matches proteins, not plain veg", () => {
    assert.equal(isProteinIngredient("boneless chicken thighs"), true);
    assert.equal(isProteinIngredient("extra-firm tofu"), true);
    assert.equal(isProteinIngredient("carrot"), false);
  });

  it("D-WS9-064: cheese and eggs count as a protein anchor; cheesecloth does not", () => {
    assert.equal(isProteinIngredient("sharp cheddar cheese"), true);
    assert.equal(isProteinIngredient("fresh mozzarella"), true);
    assert.equal(isProteinIngredient("whole-milk ricotta"), true);
    assert.equal(isProteinIngredient("large eggs"), true);
    assert.equal(isProteinIngredient("cheesecloth"), false); // tool, not food
    assert.equal(isProteinIngredient("elbow macaroni"), false); // carb, not protein
  });

  it("D-WS9-069: meaty mushroom mains and jackfruit count as a protein anchor; plain mushroom does not", () => {
    assert.equal(isProteinIngredient("portobello mushrooms"), true);
    assert.equal(isProteinIngredient("portabella caps"), true);
    assert.equal(isProteinIngredient("king oyster mushrooms"), true);
    assert.equal(isProteinIngredient("young green jackfruit"), true);
    assert.equal(isProteinIngredient("cremini mushrooms"), false); // sauce veg, not an anchor
    assert.equal(isProteinIngredient("button mushrooms"), false); // sauce veg, not an anchor
  });

  it("isCarbIngredient matches starches; excludes cornstarch/corned beef", () => {
    assert.equal(isCarbIngredient("white rice"), true);
    assert.equal(isCarbIngredient("russet potatoes"), true);
    assert.equal(isCarbIngredient("cornstarch"), false);
    assert.equal(isCarbIngredient("corned beef"), false);
    assert.equal(isCarbIngredient("olive oil"), false);
  });

  it("isVegIngredient matches vegetables; excludes aromatics/citrus/peppercorn", () => {
    assert.equal(isVegIngredient("broccoli florets"), true);
    assert.equal(isVegIngredient("bell pepper"), true);
    assert.equal(isVegIngredient("garlic"), false);
    assert.equal(isVegIngredient("yellow onion"), false);
    assert.equal(isVegIngredient("lemon"), false);
    assert.equal(isVegIngredient("black peppercorns"), false);
  });
});

// ── compositional completeness (D-WS9-044) ───────────────────────────────────

describe("mealComplete", () => {
  it("passes a multi-dish meal with a main + protein", () => {
    assert.deepEqual(mealComplete(makeMeal()), { ok: true });
  });

  it("fails when there is no main dish (the Greek-salad failure)", () => {
    const salad = makeMeal({
      dishes: [
        {
          title: "Big Green Salad",
          role: "side",
          positionIndex: 0,
          ingredients: [{ name: "romaine lettuce", quantity: 1, unit: "head" }],
          macros: { ...macros(), proteinGPerServing: 3 },
        },
      ],
    });
    assert.equal(mealComplete(salad).reason, "no_main_dish");
  });

  it("REJECTS a lone protein single dish (no carb, no vegetable)", () => {
    const loneSalmon = singleDish("Grilled Salmon", [
      { name: "salmon fillet", quantity: 1, unit: "pound" },
      { name: "lemon", quantity: 1, unit: "each" },
      { name: "fresh dill", quantity: 1, unit: "tablespoon" },
    ]);
    assert.equal(mealComplete(loneSalmon).reason, "incomplete_single_dish");
  });

  it("REJECTS a bare protein with only aromatics", () => {
    const bareChicken = singleDish("Grilled Chicken Breast", [
      { name: "chicken breast", quantity: 1, unit: "pound" },
      { name: "garlic", quantity: 2, unit: "clove" },
      { name: "yellow onion", quantity: 1, unit: "each" },
      { name: "olive oil", quantity: 2, unit: "tablespoon" },
    ]);
    assert.equal(mealComplete(bareChicken).reason, "incomplete_single_dish");
  });

  it("PASSES a single-dish stir-fry (protein + vegetable)", () => {
    const stirFry = singleDish("Chicken and Broccoli Stir-Fry", [
      { name: "chicken thigh", quantity: 1, unit: "pound" },
      { name: "broccoli florets", quantity: 2, unit: "cup" },
      { name: "soy sauce", quantity: 3, unit: "tablespoon" },
    ]);
    assert.deepEqual(mealComplete(stirFry), { ok: true });
  });

  it("PASSES a single-dish one-pot pasta (protein + carb)", () => {
    const onePot = singleDish("One-Pot Chicken Pasta", [
      { name: "chicken breast", quantity: 1, unit: "pound" },
      { name: "penne pasta", quantity: 12, unit: "ounce" },
      { name: "marinara sauce", quantity: 2, unit: "cup" },
    ]);
    assert.deepEqual(mealComplete(onePot), { ok: true });
  });

  it("PASSES a single-dish chicken soup (protein + carb + veg)", () => {
    const soup = singleDish("Chicken Noodle Soup", [
      { name: "chicken breast", quantity: 1, unit: "pound" },
      { name: "egg noodles", quantity: 8, unit: "ounce" },
      { name: "carrot", quantity: 2, unit: "each" },
      { name: "celery", quantity: 2, unit: "stalk" },
    ]);
    assert.deepEqual(mealComplete(soup), { ok: true });
  });
});

// ── allergens ────────────────────────────────────────────────────────────────

describe("deriveAllergens", () => {
  it("stamps dairy + fish + wheat, sorted+unique", () => {
    const meal = singleDish("Baked Salmon Alfredo", [
      { name: "salmon fillet", quantity: 1, unit: "pound" },
      { name: "heavy cream", quantity: 1, unit: "cup" },
      { name: "fettuccine pasta", quantity: 8, unit: "ounce" },
      { name: "parmesan cheese", quantity: 0.5, unit: "cup" },
    ]);
    assert.deepEqual(deriveAllergens(meal), ["dairy", "fish", "wheat"]);
  });

  it("returns [] when no allergen keywords appear", () => {
    const meal = singleDish("Grilled Chicken and Peppers", [
      { name: "chicken breast", quantity: 1, unit: "pound" },
      { name: "bell pepper", quantity: 2, unit: "each" },
    ]);
    assert.deepEqual(deriveAllergens(meal), []);
  });
});

// ── BUG-040 gate ─────────────────────────────────────────────────────────────

describe("validateBug040Meal", () => {
  it("passes non-empty units", () => {
    assert.deepEqual(validateBug040Meal(makeMeal()), { ok: true });
  });

  it("rejects an empty unit (never coerced)", () => {
    const bad = singleDish("Chicken", [{ name: "chicken", quantity: 3, unit: "" }]);
    const r = validateBug040Meal(bad);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /ingredients\.0\.unit/);
  });
});

// ── merge steps ──────────────────────────────────────────────────────────────

describe("mergeSteps", () => {
  it("merges one entry per dish", () => {
    const meal = makeMeal();
    const r = mergeSteps(meal, finalizeFor(meal));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.stepsPerDish.length, 2);
  });

  it("fails on a missing dish", () => {
    const meal = makeMeal();
    const r = mergeSteps(meal, { dishSteps: [finalizeFor(meal).dishSteps[0]] });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /missing_dish_steps:1/);
  });
});

// ── swappable components (Block 3.7, D-WS9-066) ───────────────────────────────

/** A single-dish coleslaw with a bagged-mix substitution. */
function slawMeal(): WizardExpandEnrichedMealDetails {
  return makeMeal({
    dishes: [
      {
        title: "Coleslaw",
        role: "side",
        positionIndex: 0,
        ingredients: [
          { name: "green cabbage", quantity: 1, unit: "head" },
          { name: "mayonnaise", quantity: 0.5, unit: "cup" },
        ],
        macros: macros(),
        substitutions: [
          { product: "bagged coleslaw mix", quantity: 14, unit: "oz", replaces: ["green cabbage"] },
        ],
      },
    ],
  });
}

describe("mergeSteps — swappable components (D-WS9-066)", () => {
  it("carries valid step tags + registry through and prunes unreferenced components", () => {
    const meal = slawMeal();
    const finalize = {
      dishSteps: [
        {
          mealIndex: 0,
          dishIndex: 0,
          components: [
            { key: "slaw", label: "Coleslaw base", order: 0 },
            { key: "ghost", label: "Unused", order: 1 },
          ],
          steps: [
            { text: "Finely shred the cabbage.", phaseType: "prep" as const, estimatedMinutes: 10, isTimingSensitive: false, componentKey: "slaw", pathKey: "scratch" as const },
            { text: "Tip the bag into a bowl.", phaseType: "prep" as const, estimatedMinutes: 1, isTimingSensitive: false, componentKey: "slaw", pathKey: "bought" as const },
            { text: "Toss with the mayonnaise.", phaseType: "assemble" as const, estimatedMinutes: 3, isTimingSensitive: false },
          ],
        },
      ],
    };
    const r = mergeSteps(meal, finalize, "coleslaw");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // "ghost" pruned (no surviving step references it); "slaw" kept.
    assert.deepEqual(r.registryPerDish[0].map((c) => c.key), ["slaw"]);
    assert.equal(r.stepsPerDish[0][0].pathKey, "scratch");
    assert.equal(r.stepsPerDish[0][1].pathKey, "bought");
    assert.equal(r.stepsPerDish[0][2].componentKey, undefined); // base
    assert.equal(r.tagFindings.length, 0);
  });

  it("strips an unknown-component tag (drop-and-keep) and reports it", () => {
    const meal = makeMeal({ dishes: [{ title: "X", role: "main", positionIndex: 0, ingredients: [{ name: "chicken breast", quantity: 1, unit: "pound" }], macros: macros() }] });
    const finalize = {
      dishSteps: [
        {
          mealIndex: 0,
          dishIndex: 0,
          components: [{ key: "sauce", label: "Sauce", order: 0 }],
          steps: [
            { text: "Do a thing.", phaseType: "cook" as const, estimatedMinutes: 5, isTimingSensitive: false, componentKey: "wrongkey", pathKey: "scratch" as const },
          ],
        },
      ],
    };
    const r = mergeSteps(meal, finalize, "x");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.stepsPerDish[0][0].componentKey, undefined); // stripped → base
    assert.equal(r.stepsPerDish[0][0].pathKey, undefined);
    assert.equal(r.tagFindings.length, 1);
    assert.equal(r.tagFindings[0].reason, "unknown_component");
    assert.equal(r.registryPerDish[0].length, 0); // no referenced key survives
  });

  it("strips an incomplete tag (componentKey without pathKey) and reports it", () => {
    const meal = makeMeal({ dishes: [{ title: "X", role: "main", positionIndex: 0, ingredients: [{ name: "chicken breast", quantity: 1, unit: "pound" }], macros: macros() }] });
    const finalize = {
      dishSteps: [
        {
          mealIndex: 0,
          dishIndex: 0,
          components: [{ key: "sauce", label: "Sauce", order: 0 }],
          steps: [{ text: "Do a thing.", phaseType: "cook" as const, estimatedMinutes: 5, isTimingSensitive: false, componentKey: "sauce" }],
        },
      ],
    };
    const r = mergeSteps(meal, finalize, "x");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.stepsPerDish[0][0].componentKey, undefined);
    assert.equal(r.tagFindings.length, 1);
    assert.equal(r.tagFindings[0].reason, "incomplete_tag");
  });

  it("flags a dish that carries substitutions but no bought path (quality signal, not a strip)", () => {
    const meal = slawMeal();
    const finalize = {
      dishSteps: [
        {
          mealIndex: 0,
          dishIndex: 0,
          steps: [{ text: "Shred the cabbage and toss with mayo.", phaseType: "prep" as const, estimatedMinutes: 12, isTimingSensitive: false }],
        },
      ],
    };
    const r = mergeSteps(meal, finalize, "coleslaw");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.tagFindings.length, 1);
    assert.equal(r.tagFindings[0].reason, "substitutions_without_paths");
    // the meal is KEPT — steps untouched, no registry.
    assert.equal(r.stepsPerDish[0].length, 1);
    assert.equal(r.registryPerDish[0].length, 0);
  });

  it("buildMaterializePayload carries component tags + registry into the payload", () => {
    const meal = slawMeal();
    const finalize = {
      dishSteps: [
        {
          mealIndex: 0,
          dishIndex: 0,
          components: [{ key: "slaw", label: "Coleslaw base", order: 0 }],
          steps: [
            { text: "Finely shred the cabbage.", phaseType: "prep" as const, estimatedMinutes: 10, isTimingSensitive: false, componentKey: "slaw", pathKey: "scratch" as const },
            { text: "Tip the bag into a bowl.", phaseType: "prep" as const, estimatedMinutes: 1, isTimingSensitive: false, componentKey: "slaw", pathKey: "bought" as const },
            { text: "Toss with the mayonnaise.", phaseType: "assemble" as const, estimatedMinutes: 3, isTimingSensitive: false },
          ],
        },
      ],
    };
    const merged = mergeSteps(meal, finalize, "coleslaw");
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    const payload = buildMaterializePayload(meal, merged.stepsPerDish, [], "coleslaw", merged.registryPerDish);
    const d0 = payload.dishes[0];
    assert.equal(d0.kind, "new");
    if (d0.kind !== "new") return;
    assert.deepEqual(d0.componentRegistry, [{ key: "slaw", label: "Coleslaw base", order: 0 }]);
    const bought = d0.steps.find((s) => s.pathKey === "bought");
    assert.ok(bought, "bought-path step present in payload");
    assert.equal(bought!.componentKey, "slaw");
    const base = d0.steps.find((s) => s.text.startsWith("Toss"));
    assert.equal(base!.componentKey, undefined); // base step untagged
  });
});

// ── dedup key ────────────────────────────────────────────────────────────────

describe("dedupKey", () => {
  it("normalizes case, whitespace, trailing punctuation", () => {
    assert.equal(dedupKey("  Big  Greek Salad!  "), "big greek salad");
  });
});

// ── payload assembly ─────────────────────────────────────────────────────────

describe("buildMaterializePayload", () => {
  it("builds kind:new dishes, maps steps, stamps allergens, tags=cuisine+difficulty", () => {
    const meal = makeMeal();
    const merged = mergeSteps(meal, finalizeFor(meal));
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    const payload = buildMaterializePayload(meal, merged.stepsPerDish, ["dairy"], "seared-chicken");

    assert.equal(payload.mealType, "dinner");
    assert.equal(payload.sourceType, undefined); // target carries batch_generated
    assert.deepEqual(payload.allergens, ["dairy"]);
    assert.equal(payload.dishFamilyKey, "seared-chicken");
    assert.deepEqual(payload.tags, ["american", "easy"]);
    const d0 = payload.dishes[0];
    assert.equal(d0.kind, "new");
    if (d0.kind !== "new") return;
    assert.equal(d0.role, "main");
    assert.equal(d0.steps.length, 2);
    assert.equal(d0.steps[0].phaseType, "prep");
  });

  // WS9 D-WS9-239 (1a) — the payload CARRIES parallelGroup when a finalize step
  // has one, and carries no key when it does not. Handed a step object
  // directly (past the schema): WizardStepSchema is the store.finalize_steps
  // TOOL schema and stays unwidened until 1b, so today every parsed step lacks
  // the field and this carrier is inert — this pins that it is wired for the
  // day 1b opens the schema.
  it("D-WS9-239: carries parallelGroup from a finalize step into the payload; omitted stays omitted", () => {
    const meal = makeMeal();
    const merged = mergeSteps(meal, finalizeFor(meal));
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    const withTag = merged.stepsPerDish.map((steps, di) =>
      di === 0
        ? steps.map((s, si) => (si === 0 ? ({ ...s, parallelGroup: "oven" } as typeof s) : s))
        : steps,
    );
    const payload = buildMaterializePayload(meal, withTag, ["dairy"], "seared-chicken");
    const d0 = payload.dishes[0];
    assert.equal(d0.kind, "new");
    if (d0.kind !== "new") return;
    assert.equal(d0.steps[0].parallelGroup, "oven");
    assert.ok(!("parallelGroup" in d0.steps[1]), "an untagged step carries no key (not null)");
  });
});

// ── materializeMeal via the store target persists DISH-OWNED steps ──────────

describe("materializeMeal via STORE_FILL_TARGET", () => {
  it("writes steps as ownerType:'dish' and mints a batch_generated pool meal", async () => {
    const meal = makeMeal();
    const merged = mergeSteps(meal, finalizeFor(meal));
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    const payload = buildMaterializePayload(meal, merged.stepsPerDish, ["dairy"], "seared-chicken");

    const map = new Map<string, string>();
    for (const d of payload.dishes) {
      if (d.kind !== "new") continue;
      for (const ing of d.ingredients) map.set(ing.name.toLowerCase().trim(), `ing-${map.size}`);
    }

    const createdSteps: Array<Record<string, unknown>> = [];
    const createdMeals: Array<Record<string, unknown>> = [];
    let dishSeq = 0;
    const fakeTx = {
      meal: {
        create: async ({ data }: { data: Record<string, unknown> }) => { createdMeals.push(data); return { id: "meal-1" }; },
        update: async () => ({}),
        // D-WS9-214 — materializeMeal now ends with stampAllergens, which reads
        // the persisted graph and then the stored stamp. Branch on `select`:
        // the two reads are distinguishable only by it.
        findUnique: async (args: { select?: Record<string, unknown> }) =>
          args.select && "dishLinks" in args.select
            ? { dishLinks: [] }
            : { allergens: [], allergenSources: null, allergensStampedAt: null },
      },
      dish: { create: async () => ({ id: `dish-${dishSeq++}` }) },
      mealDishLink: { create: async () => ({}), findMany: async () => [] },
      dishIngredient: { create: async () => ({}) },
      recipeInstructionStep: {
      findMany: async () => [], // D-WS9-235 stampMealTiming reads steps back
        create: async ({ data }: { data: Record<string, unknown> }) => { createdSteps.push(data); return {}; },
      },
    };

    const res = await materializeMeal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeTx as any,
      "",
      payload,
      map,
      STORE_FILL_TARGET,
    );
    assert.equal(res.mealId, "meal-1");
    assert.equal(createdSteps.length, 4);
    for (const s of createdSteps) assert.equal(s.ownerType, "dish");

    const m = createdMeals[0];
    assert.equal(m.userId, null);
    assert.equal(m.isPublic, true);
    assert.equal(m.sourceType, "batch_generated");
    assert.deepEqual(m.allergens, ["dairy"]);
    assert.equal(m.dishFamilyKey, "seared-chicken");
    assert.equal(m.mealType, "dinner");
  });

  it("D-WS9-066: persists dish.componentRegistry + per-step component tags", async () => {
    const meal = slawMeal();
    const finalize = {
      dishSteps: [
        {
          mealIndex: 0,
          dishIndex: 0,
          components: [{ key: "slaw", label: "Coleslaw base", order: 0 }],
          steps: [
            { text: "Finely shred the cabbage.", phaseType: "prep" as const, estimatedMinutes: 10, isTimingSensitive: false, componentKey: "slaw", pathKey: "scratch" as const },
            { text: "Tip the bag into a bowl.", phaseType: "prep" as const, estimatedMinutes: 1, isTimingSensitive: false, componentKey: "slaw", pathKey: "bought" as const },
            { text: "Toss with the mayonnaise.", phaseType: "assemble" as const, estimatedMinutes: 3, isTimingSensitive: false },
          ],
        },
      ],
    };
    const merged = mergeSteps(meal, finalize, "coleslaw");
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    const payload = buildMaterializePayload(meal, merged.stepsPerDish, [], "coleslaw", merged.registryPerDish);

    const map = new Map<string, string>();
    for (const d of payload.dishes) {
      if (d.kind !== "new") continue;
      for (const ing of d.ingredients) map.set(ing.name.toLowerCase().trim(), `ing-${map.size}`);
    }

    const createdSteps: Array<Record<string, unknown>> = [];
    const createdDishes: Array<Record<string, unknown>> = [];
    let dishSeq = 0;
    const fakeTx = {
      meal: {
        create: async () => ({ id: "meal-1" }),
        update: async () => ({}),
        // D-WS9-214 — see the sibling stub above.
        findUnique: async (args: { select?: Record<string, unknown> }) =>
          args.select && "dishLinks" in args.select
            ? { dishLinks: [] }
            : { allergens: [], allergenSources: null, allergensStampedAt: null },
      },
      dish: { create: async ({ data }: { data: Record<string, unknown> }) => { createdDishes.push(data); return { id: `dish-${dishSeq++}` }; } },
      mealDishLink: { create: async () => ({}), findMany: async () => [] },
      dishIngredient: { create: async () => ({}) },
      recipeInstructionStep: {
      findMany: async () => [], // D-WS9-235 stampMealTiming reads steps back
        create: async ({ data }: { data: Record<string, unknown> }) => { createdSteps.push(data); return {}; },
      },
    };

    await materializeMeal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeTx as any,
      "",
      payload,
      map,
      STORE_FILL_TARGET,
    );

    // registry persisted on the dish row
    assert.deepEqual(createdDishes[0].componentRegistry, [{ key: "slaw", label: "Coleslaw base", order: 0 }]);
    // per-step tags persisted; base step leaves both columns unset
    const scratch = createdSteps.find((s) => s.pathKey === "scratch");
    const bought = createdSteps.find((s) => s.pathKey === "bought");
    const base = createdSteps.find((s) => (s.stepTextRaw as string).startsWith("Toss"));
    assert.equal(scratch!.componentKey, "slaw");
    assert.equal(bought!.componentKey, "slaw");
    assert.equal(base!.componentKey, undefined);
    assert.equal(base!.pathKey, undefined);
  });
});

// ── list-driven orchestration (dry-run, fake AI + fake prisma) ──────────────

interface FakeMeta { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }

function okResult(data: unknown, meta: FakeMeta = {}) {
  return {
    success: true as const,
    data,
    metadata: {
      promptKey: "x", promptVersion: null, model: "claude-sonnet-4-6", mode: "tool" as const,
      latencyMs: 1, inputTokens: meta.input ?? 10, outputTokens: meta.output ?? 5,
      cacheReadInputTokens: meta.cacheRead ?? 0, cacheCreationInputTokens: meta.cacheCreation ?? 0,
      costEstimateUsd: 0, retryCount: 0,
    },
  };
}

function makeFakeRunAICall(genQueue: unknown[], finQueue: unknown[]): typeof productionRunAICall {
  const fn = async (promptKey: string) => {
    if (promptKey === "store.generate_meal") {
      const next = genQueue.shift();
      if (next === undefined) throw new Error("gen queue exhausted");
      return next;
    }
    if (promptKey === "store.finalize_steps") {
      const next = finQueue.shift();
      if (next === undefined) throw new Error("fin queue exhausted");
      return next;
    }
    throw new Error(`unexpected promptKey ${promptKey}`);
  };
  return fn as unknown as typeof productionRunAICall;
}

function fakePrisma(existingKeys: string[] = []): PrismaClient {
  return {
    meal: { findMany: async () => existingKeys.map((dishFamilyKey) => ({ dishFamilyKey })) },
  } as unknown as PrismaClient;
}

const DISH = (rank: number, dish: string, key = dish.toLowerCase().replace(/[^a-z0-9]+/g, "-")) =>
  ({ rank, dish, key, category: "Test", parentDish: dish, band: "top25" as const, siblingCount: 1 });

describe("runStoreFill — list-driven dry-run", () => {
  it("generates against the target dish, no DB writes, accumulates tokens", async () => {
    const meal = makeMeal();
    const runAICall = makeFakeRunAICall(
      [okResult(meal, { input: 100, cacheRead: 3000 })],
      [okResult(finalizeFor(meal), { input: 50, cacheRead: 3200 })],
    );
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 1, dishes: [DISH(1, "Baked Chicken Breast")], profiles: [PROFILE] },
    );

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].targetDish, "Baked Chicken Breast");
    assert.equal(result.records[0].written, false);
    assert.equal(result.tokens.aiCalls, 2);
    assert.equal(result.tokens.cacheRead, 6200);
  });

  it("takes the FIRST N dishes by rank", async () => {
    const meal = makeMeal();
    const runAICall = makeFakeRunAICall(
      [okResult(makeMeal({ title: "M1" }))],
      [okResult(finalizeFor(meal))],
    );
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 1, dishes: [DISH(2, "Second"), DISH(1, "First")], profiles: [PROFILE] },
    );
    assert.equal(result.records[0].targetDish, "First"); // rank 1 first
  });

  it("regenerates on an incomplete single-dish meal, logs the rejection", async () => {
    const loneSalmon = singleDish("Grilled Salmon", [
      { name: "salmon fillet", quantity: 1, unit: "pound" },
      { name: "lemon", quantity: 1, unit: "each" },
    ]);
    const good = makeMeal();
    const runAICall = makeFakeRunAICall(
      [okResult(loneSalmon), okResult(good)],
      [okResult(finalizeFor(good))],
    );
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 1, dishes: [DISH(1, "Grilled Salmon")], profiles: [PROFILE], retries: 2 },
    );

    assert.equal(result.records.length, 1);
    assert.equal(result.completenessRejections.length, 1);
    assert.equal(result.completenessRejections[0].reason, "incomplete_single_dish");
  });

  it("skips a BUG-040-invalid meal (empty unit), never coerces", async () => {
    const bad = singleDish("Bad Units", [
      { name: "chicken", quantity: 3, unit: "" },
      { name: "rice", quantity: 1, unit: "cup" },
    ]);
    const runAICall = makeFakeRunAICall([okResult(bad)], []);
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 1, dishes: [DISH(1, "X", "x")], profiles: [PROFILE] },
    );
    assert.equal(result.records.length, 0);
    assert.equal(result.skips[0].stage, "bug040");
  });

  it("dedups on the TARGET-DISH KEY, seeded from existing batch_generated (re-run safe, no generate)", async () => {
    // "x" already written → dedup BEFORE generating (gen queue empty proves it).
    const runAICall = makeFakeRunAICall([], []);
    const result = await runStoreFill(
      { prisma: fakePrisma(["x"]), runAICall },
      { apply: false, limit: 1, dishes: [DISH(1, "X", "x")], profiles: [PROFILE] },
    );
    assert.equal(result.records.length, 0);
    assert.equal(result.tokens.aiCalls, 0); // never generated
    assert.equal(result.skips[0].stage, "dedup");
    assert.equal(result.skips[0].reason, "already_written");
  });
});

// ── Part 2 runaway controls ─────────────────────────────────────────────────

describe("runStoreFill — runaway controls", () => {
  const bigRate = { inputPerMtokUsd: 3, outputPerMtokUsd: 15 };

  it("--max-calls halts the run cleanly", async () => {
    const meal = makeMeal();
    // Enough responses for several meals, but cap calls at 2 (one meal's worth).
    const gen = Array.from({ length: 5 }, () => okResult(meal));
    const fin = Array.from({ length: 5 }, () => okResult(finalizeFor(meal)));
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall: makeFakeRunAICall(gen, fin) },
      { apply: false, limit: 5, dishes: [DISH(1,"A","a"),DISH(2,"B","b"),DISH(3,"C","c"),DISH(4,"D","d"),DISH(5,"E","e")], profiles: [PROFILE], maxCalls: 2 },
    );
    assert.equal(result.stoppedBy, "max_calls");
    assert.equal(result.records.length, 1); // only the first meal completed
  });

  it("--max-cost halts the run cleanly", async () => {
    const meal = makeMeal();
    const gen = Array.from({ length: 5 }, () => okResult(meal, { input: 1_000_000 }));
    const fin = Array.from({ length: 5 }, () => okResult(finalizeFor(meal), { input: 1_000_000 }));
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall: makeFakeRunAICall(gen, fin) },
      { apply: false, limit: 5, dishes: [DISH(1,"A","a"),DISH(2,"B","b"),DISH(3,"C","c"),DISH(4,"D","d"),DISH(5,"E","e")], profiles: [PROFILE], maxCostUsd: 5, rate: bigRate },
    );
    assert.equal(result.stoppedBy, "max_cost");
    assert.ok(result.records.length < 5);
  });

  it("aborts after N consecutive meal failures", async () => {
    const lone = singleDish("Grilled Salmon", [
      { name: "salmon fillet", quantity: 1, unit: "pound" },
      { name: "lemon", quantity: 1, unit: "each" },
    ]);
    // Every generate returns an incomplete meal → each meal fails; retries:0.
    const gen = Array.from({ length: 6 }, () => okResult(lone));
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall: makeFakeRunAICall(gen, []) },
      { apply: false, limit: 6, dishes: [DISH(1,"A","a"),DISH(2,"B","b"),DISH(3,"C","c"),DISH(4,"D","d"),DISH(5,"E","e"),DISH(6,"F","f")], profiles: [PROFILE], retries: 0, maxConsecutiveFailures: 3 },
    );
    assert.equal(result.stoppedBy, "consecutive_failures");
    assert.equal(result.records.length, 0);
    assert.equal(result.attempted, 3); // stopped before the 4th
  });
});

// ── WS9 D-WS9-239 Phase 1b — mergeSteps derives parallelGroup from firstDependent ──
import { WizardFinalizeStepsResultSchema } from "../ai/schemas/wizard";
// The finalize step object carries `firstDependent` (WizardStepSchema); mergeSteps
// DERIVES the token after the component-tag drop-and-keep (so the path rule sees
// the final pathKey), sets it on the step, and buildMaterializePayload carries it
// to the write. A model-written token is stripped by the schema and never read.

describe("mergeSteps / buildMaterializePayload — D-WS9-239 1b derived parallelGroup round-trip", () => {
  function finalizeWithWindow(meal: WizardExpandEnrichedMealDetails) {
    return {
      dishSteps: meal.dishes.map((_d, di) => ({
        mealIndex: 0,
        dishIndex: di,
        steps:
          di === 0
            ? [
                { text: "Preheat the oven to 425°F.", phaseType: "preheat" as const, estimatedMinutes: 12, isTimingSensitive: false, firstDependent: 3 },
                { text: "Cut the potatoes into chunks.", phaseType: "prep" as const, estimatedMinutes: 6, isTimingSensitive: false },
                { text: "Spread on a sheet pan.", phaseType: "prep" as const, estimatedMinutes: 2, isTimingSensitive: false },
                { text: "Roast 30 minutes.", phaseType: "cook" as const, estimatedMinutes: 30, isTimingSensitive: false, firstDependent: 4 },
                { text: "Transfer to a platter.", phaseType: "assemble" as const, estimatedMinutes: 2, isTimingSensitive: false },
              ]
            : [
                { text: "Rinse the rice.", phaseType: "prep" as const, estimatedMinutes: 2, isTimingSensitive: false },
                { text: "Simmer covered 18 minutes.", phaseType: "cook" as const, estimatedMinutes: 18, isTimingSensitive: false, firstDependent: 2 },
                { text: "Fluff and serve.", phaseType: "assemble" as const, estimatedMinutes: 1, isTimingSensitive: false },
              ],
      })),
    };
  }

  it("one window + riders round-trips to the payload's step tags; dependents and adjacent windows stay untagged", () => {
    const meal = makeMeal();
    // Through the SCHEMA first, as the harness does (runAICall validates the tool output).
    const finalize = WizardFinalizeStepsResultSchema.parse(finalizeWithWindow(meal));
    const merged = mergeSteps(meal, finalize, "roast-potatoes");
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    assert.deepEqual(merged.parallelGroupIssues, []);
    const payload = buildMaterializePayload(meal, merged.stepsPerDish, [], "roast-potatoes", merged.registryPerDish);
    const d0 = payload.dishes[0];
    const d1 = payload.dishes[1];
    assert.equal(d0.kind, "new");
    assert.equal(d1.kind, "new");
    if (d0.kind !== "new" || d1.kind !== "new") return;
    assert.deepEqual(
      d0.steps.map((s) => s.parallelGroup ?? null),
      ["w0", "w0", "w0", null, null],
      "preheat is the window; chop + spread ride it; the roast and the plating are dependents",
    );
    assert.ok(!("parallelGroup" in d0.steps[3]), "an untagged step carries no key (falls to the column null)");
    assert.deepEqual(d1.steps.map((s) => s.parallelGroup ?? null), [null, null, null], "a window whose dependent is the next step emits no token");
    for (const s of [...d0.steps, ...d1.steps]) assert.ok(!("firstDependent" in s), "firstDependent is consumed, never written");
  });

  it("a rejected declaration is reported on parallelGroupIssues (never fatal) and the step stays untagged", () => {
    const meal = makeMeal();
    const finalize = WizardFinalizeStepsResultSchema.parse({
      dishSteps: meal.dishes.map((_d, di) => ({
        mealIndex: 0,
        dishIndex: di,
        steps: [
          { text: "Sear.", phaseType: "cook" as const, estimatedMinutes: 6, isTimingSensitive: true, firstDependent: 2 },
          { text: "Chop.", phaseType: "prep" as const, estimatedMinutes: 2, isTimingSensitive: false },
          { text: "Plate.", phaseType: "assemble" as const, estimatedMinutes: 2, isTimingSensitive: false },
        ],
      })),
    });
    const merged = mergeSteps(meal, finalize, "x");
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    assert.equal(merged.parallelGroupIssues.length, 2, "one per dish");
    assert.equal(merged.parallelGroupIssues[0].cls, "attended_window");
    assert.equal(merged.parallelGroupIssues[0].dishIndex, 0);
    assert.equal(merged.parallelGroupIssues[1].dishIndex, 1);
    for (const steps of merged.stepsPerDish) for (const s of steps) assert.ok(!("parallelGroup" in s));
  });

  it("the path rule sees the FINAL pathKey: a bought-path rider is a hole in a scratch window (derivation runs after the tag drop-and-keep)", () => {
    const meal = makeMeal({
      dishes: [
        {
          title: "Coleslaw",
          role: "side",
          positionIndex: 0,
          ingredients: [{ name: "cabbage", quantity: 1, unit: "head" }],
          macros: macros(),
          substitutions: [{ product: "coleslaw mix", quantity: 1, unit: "bag", replaces: ["cabbage"] }],
        },
      ],
    });
    const finalize = WizardFinalizeStepsResultSchema.parse({
      dishSteps: [
        {
          mealIndex: 0,
          dishIndex: 0,
          components: [{ key: "slaw", label: "Slaw base", order: 0 }],
          steps: [
            { text: "Chill the dressing 20 minutes.", phaseType: "rest" as const, estimatedMinutes: 20, isTimingSensitive: false, firstDependent: 4, componentKey: "slaw", pathKey: "scratch" },
            { text: "Shred the cabbage.", phaseType: "prep" as const, estimatedMinutes: 8, isTimingSensitive: false, componentKey: "slaw", pathKey: "scratch" },
            { text: "Open the bag of slaw mix.", phaseType: "prep" as const, estimatedMinutes: 1, isTimingSensitive: false, componentKey: "slaw", pathKey: "bought" },
            { text: "Grate the carrot.", phaseType: "prep" as const, estimatedMinutes: 3, isTimingSensitive: false },
            { text: "Toss and serve.", phaseType: "assemble" as const, estimatedMinutes: 2, isTimingSensitive: false },
          ],
        },
      ],
    });
    const merged = mergeSteps(meal, finalize, "coleslaw");
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    const tags = merged.stepsPerDish[0].map((s) => (s as { parallelGroup?: string }).parallelGroup ?? null);
    // #2 (bought) cannot ride the scratch window → hole → contiguity closes the group at #2;
    // the window keeps #1 and, after the hole, #3 is a re-appearance → dropped.
    assert.deepEqual(tags, ["w0", "w0", null, null, null]);
    assert.ok(merged.parallelGroupIssues.some((i) => i.cls === "path_mismatch"));
  });
});

// ── D-WS9-240 item 6 — the dish split rides the volatile input, only when given ──
import { STABLE_GENERATE_PREFIX } from "../storeFillPrompts";

describe("generateInput — the 30-minute list's dish split (D-WS9-240 item 6)", () => {
  it("without a split the volatile input is byte-identical to Block 3.8's", () => {
    assert.equal(generateInput("Baked Chicken Breast", PROFILE), JSON.stringify({ targetDish: "Baked Chicken Breast", servings: 4, difficulty: "easy" }));
    assert.equal(generateInput("Baked Chicken Breast", PROFILE, []), generateInput("Baked Chicken Breast", PROFILE), "an empty split is no split");
  });

  it("with a split the input carries `dishes` in the order given", () => {
    const parsed = JSON.parse(generateInput("BLT with Kettle Chips and a Dill Pickle", PROFILE, ["BLT sandwich", "Kettle chips and pickle"])) as { dishes: string[] };
    assert.deepEqual(parsed.dishes, ["BLT sandwich", "Kettle chips and pickle"]);
  });

  it("the cached generate prefix tells the model what a `dishes` list means", () => {
    assert.ok(STABLE_GENERATE_PREFIX.includes("carries a `dishes` list"), "the prefix must explain the split or the model is guessing");
  });

  it("runStoreFill passes the target's split to the generate call", async () => {
    const meal = makeMeal();
    const seen: string[] = [];
    const inner = makeFakeRunAICall([okResult(meal)], [okResult(finalizeFor(meal))]);
    const runAICall = (async (key: string, vars: Record<string, string>, ...rest: unknown[]) => {
      if (key === "store.generate_meal") seen.push(vars.generateInput);
      return (inner as unknown as (...a: unknown[]) => Promise<unknown>)(key, vars, ...rest);
    }) as unknown as typeof productionRunAICall;
    await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 1, dishes: [{ ...DISH(1, "BLT with Kettle Chips and a Dill Pickle"), dishes: ["BLT sandwich", "Kettle chips and pickle"] }], profiles: [PROFILE] },
    );
    assert.equal(seen.length, 1);
    assert.deepEqual((JSON.parse(seen[0]) as { dishes: string[] }).dishes, ["BLT sandwich", "Kettle chips and pickle"]);
  });
});

// ── D-WS9-242 lane — `shortcut_used` on the wire, only when given ─────────────
import { shortcutLine } from "../storeFill";
import { STABLE_FINALIZE_PREFIX } from "../storeFillPrompts";

describe("generateInput — the 30-minute list's store-bought shortcut (D-WS9-240 item 6 / D-WS9-242)", () => {
  it("without a shortcut the rendered input is BYTE-IDENTICAL to today's (with and without a split)", () => {
    assert.equal(generateInput("Baked Chicken Breast", PROFILE, undefined, undefined), generateInput("Baked Chicken Breast", PROFILE));
    assert.equal(generateInput("Baked Chicken Breast", PROFILE, undefined, ""), generateInput("Baked Chicken Breast", PROFILE), "an empty string is no shortcut");
    assert.equal(generateInput("Baked Chicken Breast", PROFILE, undefined, "   "), generateInput("Baked Chicken Breast", PROFILE), "whitespace is no shortcut");
    assert.equal(
      generateInput("BLT", PROFILE, ["BLT sandwich", "Kettle chips and pickle"], undefined),
      JSON.stringify({ targetDish: "BLT", servings: 4, difficulty: "easy", dishes: ["BLT sandwich", "Kettle chips and pickle"] }),
    );
  });

  it("with a shortcut the JSON is unchanged and the shortcut line follows it, verbatim", () => {
    const out = generateInput("Smash Burgers with Special Sauce and Bagged Slaw", PROFILE, ["Smash burgers", "Quick slaw"], "Bagged slaw mix; potato buns");
    const json = JSON.stringify({ targetDish: "Smash Burgers with Special Sauce and Bagged Slaw", servings: 4, difficulty: "easy", dishes: ["Smash burgers", "Quick slaw"] });
    assert.ok(out.startsWith(json + "\n\n"), "the JSON comes first, byte-identical, then a blank line");
    assert.equal(out.slice(json.length + 2), shortcutLine("Bagged slaw mix; potato buns"));
    assert.equal(
      shortcutLine("Bagged slaw mix; potato buns"),
      "Store-bought shortcut the cook uses for this dinner: Bagged slaw mix; potato buns. Build the DEFAULT path around this product; the from-scratch version of that component is the optional bought→scratch alternative, not the primary path.",
    );
  });

  it("runStoreFill passes the target's shortcut to the generate call, and nothing when the target has none", async () => {
    const meal = makeMeal();
    const seen: string[] = [];
    const inner = makeFakeRunAICall([okResult(meal), okResult(meal)], [okResult(finalizeFor(meal)), okResult(finalizeFor(meal))]);
    const runAICall = (async (key: string, vars: Record<string, string>, ...rest: unknown[]) => {
      if (key === "store.generate_meal") seen.push(vars.generateInput);
      return (inner as unknown as (...a: unknown[]) => Promise<unknown>)(key, vars, ...rest);
    }) as unknown as typeof productionRunAICall;
    await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 2, dishes: [{ ...DISH(1, "Smash Burgers"), shortcut: "Bagged slaw mix; potato buns" }, DISH(2, "Pot Roast")], profiles: [PROFILE] },
    );
    assert.equal(seen.length, 2);
    assert.ok(seen[0].includes("Store-bought shortcut the cook uses for this dinner: Bagged slaw mix; potato buns."));
    assert.equal(seen[1], JSON.stringify({ targetDish: "Pot Roast", servings: 4, difficulty: "easy" }), "no shortcut → byte-identical");
  });

  it("the cached generate prefix explains the shortcut line (the product is the default path, not a substitutions swap)", () => {
    assert.ok(STABLE_GENERATE_PREFIX.includes("names a store-bought shortcut the cook uses for this dinner"), "the prefix must explain the line");
    assert.ok(STABLE_GENERATE_PREFIX.includes("do not offer the product as a substitution for itself"));
  });
});

describe("store prefixes — D-WS9-242 vocabulary + D-WS9-239 default-path-only windows", () => {
  it("generate: the 'assembly, never COOKING' slogan is gone; the three effort classes are named; the TEST sentence is kept verbatim", () => {
    assert.ok(!STABLE_GENERATE_PREFIX.includes("never COOKING"), "the slogan is replaced, not layered");
    assert.ok(!STABLE_GENERATE_PREFIX.includes("NOT legitimate (cooking)"), "the contradicting example list is gone");
    assert.ok(STABLE_GENERATE_PREFIX.includes("an ASSEMBLY component"));
    assert.ok(STABLE_GENERATE_PREFIX.includes("a COOKING component"));
    assert.ok(STABLE_GENERATE_PREFIX.includes("a CRAFT component"));
    assert.ok(STABLE_GENERATE_PREFIX.includes("A bought path names a product that EXISTS and that REPLACES that component."));
    assert.ok(STABLE_GENERATE_PREFIX.includes("Pre-sliced onions do not replace caramelized onions"));
    assert.ok(STABLE_GENERATE_PREFIX.includes("NEVER the finished centerpiece"));
    assert.ok(
      STABLE_GENERATE_PREFIX.includes("TEST: would a good home cook plausibly buy this and still be making THIS dish — and would the substitute actually BE that component?"),
      "the quality bar stays a prompt rule, verbatim",
    );
  });

  it("finalize: windows are declared over the DEFAULT (scratch) path only — a bought-path step is never a window and never a rider", () => {
    assert.ok(STABLE_FINALIZE_PREFIX.includes("Windows are declared over the DEFAULT (scratch) path only"));
    assert.ok(STABLE_FINALIZE_PREFIX.includes("A bought-path step is never a window and never a rider for scratch work"));
    assert.ok(STABLE_FINALIZE_PREFIX.includes('a step tagged `"pathKey": "bought"` carries no `firstDependent`'));
  });
});
