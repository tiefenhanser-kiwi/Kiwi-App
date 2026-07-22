// Plan-Gen Arc · Block 3 (D-WS9-041 / D-WS9-044) — store-fill harness core.
//
// LIST-DRIVEN direct meal-generation for Kiwi's pre-generated meal store. The
// variety engine is the curated TARGET-DISH list (storeFillDishes.ts): each
// generate call takes ONE target dish name (the main/centerpiece) as its
// VOLATILE input, so convergence is structurally impossible — distinct targets
// yield distinct meals. Preference profiles no longer drive WHAT is made; they
// parameterize HOW (servings, difficulty) and rotate across the list.
//
// Per target dish, two Sonnet calls route the meal through the wizard's quality
// pipeline: (1) generate a complete dinner around the target, (2) finalize-steps
// for real per-step estimatedMinutes / phaseType / isTimingSensitive. Then derive
// allergens, run the compositional completeness gate (D-WS9-044) + BUG-040 gate,
// and persist via materializeMeal with a store-pool target (dish-owned steps).
//
// The CLI (scripts/ws9-block3-store-fill.ts) is thin: it wires real prisma +
// runAICall and prints. All logic lives here (typechecked + unit-tested).

import type { PrismaClient } from "@prisma/client";

import {
  WizardExpandDishIngredientSchema,
  WizardExpandEnrichedMealDetailsSchema,
  WizardFinalizeStepsResultSchema,
  type WizardExpandEnrichedMealDetails,
  type WizardFinalizeStepsResult,
  type WizardStep,
} from "./ai/schemas/wizard";
import { runAICall as productionRunAICall } from "./ai/runAICall";
import {
  collectMealMentions,
  materializeMeal,
  type MaterializeMealDish,
  type MaterializeMealPayload,
  type MaterializeTarget,
} from "./mealMaterialize";
import { resolveIngredients } from "./ingredientResolve";
import { TARGET_DISHES, type TargetDish } from "./storeFillDishes";
import {
  STABLE_FINALIZE_PREFIX,
  STABLE_GENERATE_PREFIX,
} from "./storeFillPrompts";

// ── the store-pool target (R1) ───────────────────────────────────────────────
export const STORE_FILL_TARGET: MaterializeTarget = {
  userId: null,
  isPublic: true,
  sourceType: "batch_generated",
};

// ── how-profiles (D-WS9-044) — parameterize HOW, not WHAT ────────────────────
// The dish drives variety; these only vary target difficulty and rotate across
// the list. Diet/cuisine are NOT here — the target dish carries its own nature.
// Servings unified to 4 for the catalog (Gate 3): a 4-serving dinner is the
// standard household portion the plan-composer clones off the shelf, and the
// model sizes ingredients + macros to the requested servings. The "-b" keys are
// the second easy/medium rotation slot (keys are log-only, never persisted).
export interface GenProfile {
  key: string;
  servings: number;
  difficulty: "easy" | "medium" | "fancy";
}

export const PILOT_GEN_PROFILES: GenProfile[] = [
  { key: "family-4-easy", servings: 4, difficulty: "easy" },
  { key: "family-4-medium", servings: 4, difficulty: "medium" },
  { key: "family-4-medium-b", servings: 4, difficulty: "medium" },
  { key: "family-4-easy-b", servings: 4, difficulty: "easy" },
];

// ── ingredient classification (protein / carb / vegetable) ───────────────────
export const PROTEIN_KEYWORDS: readonly string[] = [
  "chicken", "beef", "steak", "pork", "bacon", "ham", "sausage", "turkey", "lamb",
  "veal", "duck", "fish", "salmon", "tuna", "cod", "tilapia", "trout", "halibut",
  "shrimp", "prawn", "crab", "lobster", "scallop", "clam", "mussel", "anchovy",
  "tofu", "tempeh", "seitan", "edamame", "egg", "eggs", "paneer", "lentil",
  "lentils", "chickpea", "chickpeas", "black bean", "kidney bean", "pinto bean",
  "cannellini", "white bean", "navy bean", "bean", "beans", "greek yogurt",
];

// Substantial starches. Aromatics/spices that merely contain a keyword substring
// are excluded via CARB_STOP (e.g. cornstarch, corned beef).
const CARB_KEYWORDS: readonly string[] = [
  "rice", "pasta", "noodle", "spaghetti", "macaroni", "penne", "ziti", "orzo",
  "potato", "bread", "tortilla", "bun", "roll", "quinoa", "couscous", "farro",
  "barley", "polenta", "grits", "gnocchi", "dumpling", "biscuit", "cornbread",
  "naan", "pita", "bulgur", "hominy", "fries", "tater tot", "tots", "crust",
  "dough", "flatbread", "wrap", "roti", "udon", "ramen", "vermicelli", "yam",
  "corn",
];
const CARB_STOP: readonly string[] = [
  "cornstarch", "corn starch", "cornflour", "corn flour", "corned beef",
];

// Substantial vegetables. Deliberately EXCLUDES aromatics/citrus/spice (onion,
// garlic, shallot, scallion, ginger, cilantro, parsley, basil, lemon, lime,
// chili) so a bare protein seasoned only with aromatics is NOT counted as
// having a vegetable — biasing the single-dish gate against false passes.
const VEG_KEYWORDS: readonly string[] = [
  "broccoli", "carrot", "spinach", "kale", "lettuce", "romaine", "cabbage",
  "cauliflower", "zucchini", "squash", "mushroom", "tomato", "green bean",
  "peas", "snap pea", "snow pea", "celery", "cucumber", "asparagus", "eggplant",
  "bok choy", "brussels", "beet", "chard", "collard", "okra", "artichoke",
  "parsnip", "turnip", "arugula", "bell pepper", "peppers", "poblano", "pumpkin",
  "fennel", "leek",
];
const VEG_STOP: readonly string[] = ["peppercorn"];

function matchesAny(
  name: string,
  keywords: readonly string[],
  stop: readonly string[],
): boolean {
  const n = name.toLowerCase();
  if (stop.some((s) => n.includes(s))) return false;
  return keywords.some((k) => n.includes(k));
}

export function isProteinIngredient(name: string): boolean {
  return PROTEIN_KEYWORDS.some((k) => name.toLowerCase().includes(k));
}
export function isCarbIngredient(name: string): boolean {
  return matchesAny(name, CARB_KEYWORDS, CARB_STOP);
}
export function isVegIngredient(name: string): boolean {
  return matchesAny(name, VEG_KEYWORDS, VEG_STOP);
}

const PROTEIN_FLOOR_G = 15; // per-serving protein floor for the macro fallback

// ── compositional completeness gate (D-WS9-044) ──────────────────────────────
// A meal MAY be a single dish. The rule is COMPOSITIONAL, not a dish count:
//   - Multi-dish → needs a `main` + a protein (the existing check).
//   - Single-dish → the one dish must carry a PROTEIN and (a CARB or a VEGETABLE)
//     in its own ingredients. This rejects a lone fillet / bare breast / plain
//     steak while passing chicken soup, chili, casseroles, stir-fries, one-pot
//     pasta, and hearty dinner salads.
export interface CompletenessCheck {
  ok: boolean;
  reason?: string;
}

export function mealComplete(meal: WizardExpandEnrichedMealDetails): CompletenessCheck {
  const hasMain = meal.dishes.some((d) => d.role === "main");
  if (!hasMain) return { ok: false, reason: "no_main_dish" };

  const proteinAnywhere =
    meal.dishes.some((d) => d.ingredients.some((i) => isProteinIngredient(i.name))) ||
    meal.dishes.reduce((sum, d) => sum + (d.macros?.proteinGPerServing ?? 0), 0) >=
      PROTEIN_FLOOR_G;
  if (!proteinAnywhere) return { ok: false, reason: "no_protein_ingredient" };

  if (meal.dishes.length === 1) {
    const d = meal.dishes[0];
    const hasProteinIng = d.ingredients.some((i) => isProteinIngredient(i.name));
    const hasCarbOrVeg = d.ingredients.some(
      (i) => isCarbIngredient(i.name) || isVegIngredient(i.name),
    );
    if (!hasProteinIng || !hasCarbOrVeg) {
      return { ok: false, reason: "incomplete_single_dish" };
    }
  }
  return { ok: true };
}

// ── allergen derivation (stamp-only; no retrieval filter here) ────────────────
const ALLERGEN_TOKENS: Record<string, readonly string[]> = {
  dairy: ["milk", "butter", "cheese", "cream", "yogurt", "parmesan", "mozzarella", "feta", "ricotta", "ghee", "paneer"],
  egg: ["egg"],
  peanut: ["peanut"],
  tree_nut: ["almond", "walnut", "pecan", "cashew", "pistachio", "hazelnut", "macadamia", "pine nut"],
  soy: ["soy", "tofu", "tempeh", "edamame", "miso", "tamari"],
  wheat: ["wheat", "flour", "bread", "pasta", "noodle", "tortilla", "couscous", "cracker", "panko", "breadcrumb", "soy sauce"],
  fish: ["fish", "salmon", "tuna", "cod", "tilapia", "trout", "halibut", "anchovy"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "scallop", "clam", "mussel", "oyster"],
  sesame: ["sesame", "tahini"],
};

export function deriveAllergens(meal: WizardExpandEnrichedMealDetails): string[] {
  const found = new Set<string>();
  for (const dish of meal.dishes) {
    for (const ing of dish.ingredients) {
      const n = ing.name.toLowerCase();
      for (const [token, subs] of Object.entries(ALLERGEN_TOKENS)) {
        if (subs.some((s) => n.includes(s))) found.add(token);
      }
    }
  }
  return [...found].sort();
}

// ── BUG-040 gate — re-validate every ingredient before write ─────────────────
export interface Bug040Result {
  ok: boolean;
  reason?: string;
}

export function validateBug040Meal(meal: WizardExpandEnrichedMealDetails): Bug040Result {
  for (let di = 0; di < meal.dishes.length; di++) {
    const dish = meal.dishes[di];
    for (let ii = 0; ii < dish.ingredients.length; ii++) {
      const parsed = WizardExpandDishIngredientSchema.safeParse(dish.ingredients[ii]);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path.join(".") || "shape";
        return { ok: false, reason: `dishes.${di}.ingredients.${ii}.${field}` };
      }
    }
  }
  return { ok: true };
}

// ── merge finalize steps into the meal's dishes (single meal → mealIndex 0) ──
export type MergeResult =
  | { ok: true; stepsPerDish: WizardStep[][] }
  | { ok: false; reason: string };

export function mergeSteps(
  meal: WizardExpandEnrichedMealDetails,
  finalize: WizardFinalizeStepsResult,
): MergeResult {
  const byDish = new Map<number, WizardStep[]>();
  for (const entry of finalize.dishSteps) {
    if (entry.mealIndex !== 0) {
      return { ok: false, reason: `unexpected_meal_index:${entry.mealIndex}` };
    }
    if (byDish.has(entry.dishIndex)) {
      return { ok: false, reason: `duplicate_dish_index:${entry.dishIndex}` };
    }
    byDish.set(entry.dishIndex, entry.steps);
  }
  const stepsPerDish: WizardStep[][] = [];
  for (let di = 0; di < meal.dishes.length; di++) {
    const steps = byDish.get(di);
    if (!steps) return { ok: false, reason: `missing_dish_steps:${di}` };
    byDish.delete(di);
    stepsPerDish.push(steps);
  }
  if (byDish.size > 0) {
    const [extra] = byDish.keys();
    return { ok: false, reason: `extra_dish_steps:${extra}` };
  }
  return { ok: true, stepsPerDish };
}

// ── dedup key (BACKSTOP only — the distinct target dishes are the primary
// mechanism; a collision here is a signal, not the main defense) ─────────────
export function dedupKey(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:'"]+$/g, "");
}

// ── tags ─────────────────────────────────────────────────────────────────────
export function buildTags(
  meal: WizardExpandEnrichedMealDetails,
): string[] {
  const tags = new Set<string>();
  if (meal.cuisineType) tags.add(meal.cuisineType.toLowerCase());
  tags.add(meal.difficulty);
  return [...tags];
}

// ── payload assembly ─────────────────────────────────────────────────────────
export function buildMaterializePayload(
  meal: WizardExpandEnrichedMealDetails,
  stepsPerDish: WizardStep[][],
  allergens: string[],
  dishFamilyKey: string,
): MaterializeMealPayload {
  const dishes: MaterializeMealDish[] = meal.dishes.map((d, di) => ({
    kind: "new",
    title: d.title,
    role: d.role,
    positionIndex: d.positionIndex,
    ingredients: d.ingredients.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
      preparationNote: i.preparationNote ?? null,
      isOptional: i.isOptional ?? false,
    })),
    steps: stepsPerDish[di].map((s) => ({
      text: s.text,
      estimatedMinutes: s.estimatedMinutes,
      phaseType: s.phaseType,
      isTimingSensitive: s.isTimingSensitive,
    })),
    ...(d.macros
      ? {
          macros: {
            caloriesPerServing: d.macros.caloriesPerServing,
            proteinGPerServing: d.macros.proteinGPerServing,
            carbsGPerServing: d.macros.carbsGPerServing,
            fatGPerServing: d.macros.fatGPerServing,
          },
        }
      : {}),
  }));

  return {
    title: meal.title,
    // One-line headnote from the generate prompt → Meal.description. Nullable:
    // a meal generated before this field existed simply omits it.
    description: meal.description ?? null,
    cuisineType: meal.cuisineType,
    mealType: "dinner",
    servingsDefault: meal.servings,
    estimatedTimeMinutes: meal.estimatedTimeMinutes,
    difficulty: meal.difficulty,
    // sourceType intentionally left off — STORE_FILL_TARGET carries
    // "batch_generated" and the target overrides the payload's value.
    tags: buildTags(meal),
    allergens,
    dishFamilyKey,
    dishes,
  };
}

// ── volatile per-call inputs (go in the user body; NOT the cached prefix) ─────
export function generateInput(targetDish: string, profile: GenProfile): string {
  return JSON.stringify({
    targetDish,
    servings: profile.servings,
    difficulty: profile.difficulty,
  });
}

export function finalizeInput(meal: WizardExpandEnrichedMealDetails): string {
  return JSON.stringify({ meals: [meal] });
}

// ── cost accounting ──────────────────────────────────────────────────────────
export interface TokenTotals {
  aiCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ModelRateUsd {
  inputPerMtokUsd: number;
  outputPerMtokUsd: number;
}

export function emptyTokenTotals(): TokenTotals {
  return { aiCalls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/** Cache-aware cost: uncached input at 1x, cache writes 1.25x, cache reads 0.1x. */
export function computeCacheAwareCostUsd(t: TokenTotals, rate: ModelRateUsd): number {
  const inPerTok = rate.inputPerMtokUsd / 1_000_000;
  const outPerTok = rate.outputPerMtokUsd / 1_000_000;
  return (
    t.input * inPerTok +
    t.cacheCreation * inPerTok * 1.25 +
    t.cacheRead * inPerTok * 0.1 +
    t.output * outPerTok
  );
}

/** cache_read / (all input-side tokens). 0 when no input-side tokens seen. */
export function cacheHitRate(t: TokenTotals): number {
  const inputSide = t.input + t.cacheRead + t.cacheCreation;
  return inputSide === 0 ? 0 : t.cacheRead / inputSide;
}

// ── orchestrator ─────────────────────────────────────────────────────────────
export interface StoreFillDeps {
  prisma: PrismaClient;
  runAICall?: typeof productionRunAICall;
}

export interface StoreFillOptions {
  apply: boolean;
  /** first N dishes by rank (the head, which users hit most). */
  limit: number;
  /** completeness regeneration cap per dish (default 2 retries → 3 attempts). */
  retries?: number;
  /** override the dish list (tests); defaults to the frozen TARGET_DISHES. */
  dishes?: TargetDish[];
  /** override the how-profiles (tests). */
  profiles?: GenProfile[];
  // ── Part 2 runaway controls (independent) ─────────────────────────────────
  /** hard cache-aware USD ceiling; checked before each AI call. Default 75. */
  maxCostUsd?: number;
  /** hard AI-call ceiling, independent of cost. Default limit * 5. */
  maxCalls?: number;
  /** abort after this many consecutive meal failures. Default 3. */
  maxConsecutiveFailures?: number;
  /** model rate for cost accounting; default claude-sonnet-4-6 fallback. */
  rate?: ModelRateUsd;
  /** progress sink (the CLI wires console.log); default no-op. */
  log?: (msg: string) => void;
  /** wall-clock start (ms); injected for determinism in tests. */
  nowMs?: () => number;
}

export interface MealDishRecord {
  title: string;
  role: string;
  ingredientCount: number;
  stepCount: number;
}

export interface MealRecord {
  targetDish: string;
  profileKey: string;
  title: string;
  cuisineType: string;
  difficulty: string;
  servings: number;
  dishes: MealDishRecord[];
  allergens: string[];
  written: boolean;
  mealId?: string;
}

export interface SkipRecord {
  targetDish: string;
  profileKey: string;
  stage: string;
  reason: string;
  title?: string;
}

export interface CompletenessRejection {
  targetDish: string;
  profileKey: string;
  attempt: number;
  reason: string;
  title?: string;
}

export interface StoreFillResult {
  apply: boolean;
  attempted: number;
  records: MealRecord[];
  skips: SkipRecord[];
  completenessRejections: CompletenessRejection[];
  tokens: TokenTotals;
  costUsd: number;
  /** set when a runaway control halted the run early. */
  stoppedBy: "max_cost" | "max_calls" | "consecutive_failures" | null;
}

function accumulate(t: TokenTotals, meta: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): void {
  t.aiCalls++;
  t.input += meta.inputTokens ?? 0;
  t.output += meta.outputTokens ?? 0;
  t.cacheRead += meta.cacheReadInputTokens ?? 0;
  t.cacheCreation += meta.cacheCreationInputTokens ?? 0;
}

export async function runStoreFill(
  deps: StoreFillDeps,
  opts: StoreFillOptions,
): Promise<StoreFillResult> {
  const runAICall = deps.runAICall ?? productionRunAICall;
  const { prisma } = deps;
  const profiles = opts.profiles ?? PILOT_GEN_PROFILES;
  const retries = opts.retries ?? 2;
  const rate = opts.rate ?? { inputPerMtokUsd: 3, outputPerMtokUsd: 15 };
  const maxCostUsd = opts.maxCostUsd ?? 75;
  const maxCalls = opts.maxCalls ?? opts.limit * 5;
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
  const log = opts.log ?? (() => {});
  const nowMs = opts.nowMs ?? (() => Date.now());
  const startMs = nowMs();

  // First N dishes by rank — the head of the list, which users hit most.
  const dishes = (opts.dishes ?? TARGET_DISHES)
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, opts.limit);

  const tokens = emptyTokenTotals();
  const records: MealRecord[] = [];
  const skips: SkipRecord[] = [];
  const completenessRejections: CompletenessRejection[] = [];

  // D-WS9-045 dedup on the TARGET-DISH KEY (not the generated title). Seed from
  // existing batch_generated meals → re-run safe: a re-run skips every dish
  // already written and only generates what's missing.
  const seenKeys = new Set<string>();
  const existing = await prisma.meal.findMany({
    where: { sourceType: "batch_generated" },
    select: { dishFamilyKey: true },
  });
  for (const m of existing) if (m.dishFamilyKey) seenKeys.add(m.dishFamilyKey);

  let attempted = 0;
  let consecutiveFailures = 0;
  let stoppedBy: StoreFillResult["stoppedBy"] = null;

  const overCalls = () => tokens.aiCalls >= maxCalls;
  const overCost = () => computeCacheAwareCostUsd(tokens, rate) >= maxCostUsd;

  for (let i = 0; i < dishes.length; i++) {
    // Runaway controls, checked BEFORE doing any work this iteration.
    if (overCost()) { stoppedBy = "max_cost"; break; }
    if (overCalls()) { stoppedBy = "max_calls"; break; }
    if (consecutiveFailures >= maxConsecutiveFailures) { stoppedBy = "consecutive_failures"; break; }

    const target = dishes[i];
    const profile = profiles[i % profiles.length];
    attempted++;

    const progress = () => {
      const cost = computeCacheAwareCostUsd(tokens, rate);
      const elapsed = ((nowMs() - startMs) / 1000).toFixed(0);
      log(`[${i + 1}/${dishes.length}] done=${records.length} remaining=${dishes.length - i - 1} | $${cost.toFixed(3)} | ${elapsed}s`);
    };

    // 0. Dedup FIRST — skip an already-written target without generating (cheap,
    //    re-run safe). A dedup skip is NOT a failure (resets the streak).
    if (seenKeys.has(target.key)) {
      skips.push({ targetDish: target.dish, profileKey: profile.key, stage: "dedup", reason: "already_written" });
      consecutiveFailures = 0;
      progress();
      continue;
    }

    // 1. Generate around the target dish + compositional-completeness retry.
    let meal: WizardExpandEnrichedMealDetails | null = null;
    let failed = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (overCalls()) { stoppedBy = "max_calls"; break; }
      const gen = await runAICall(
        "store.generate_meal",
        { generateInput: generateInput(target.dish, profile) },
        WizardExpandEnrichedMealDetailsSchema,
        { prisma, mode: "tool", cachedSystemPrefix: STABLE_GENERATE_PREFIX },
      );
      accumulate(tokens, gen.metadata);
      if (!gen.success) {
        skips.push({ targetDish: target.dish, profileKey: profile.key, stage: "generate", reason: gen.reason });
        failed = true;
        break;
      }
      const mc = mealComplete(gen.data);
      if (mc.ok) { meal = gen.data; break; }
      completenessRejections.push({ targetDish: target.dish, profileKey: profile.key, attempt, reason: mc.reason ?? "incomplete", title: gen.data.title });
    }
    if (stoppedBy) break;
    if (!failed && !meal) {
      skips.push({ targetDish: target.dish, profileKey: profile.key, stage: "completeness", reason: "exhausted_retries" });
      failed = true;
    }
    if (failed || !meal) { consecutiveFailures++; progress(); continue; }

    // 2. BUG-040 gate — log + SKIP on failure, never coerce.
    const bug040 = validateBug040Meal(meal);
    if (!bug040.ok) {
      skips.push({ targetDish: target.dish, profileKey: profile.key, stage: "bug040", reason: bug040.reason ?? "invalid", title: meal.title });
      consecutiveFailures++; progress(); continue;
    }

    // 3. Finalize steps (the load-bearing quality stage) + merge.
    if (overCalls()) { stoppedBy = "max_calls"; break; }
    const fin = await runAICall(
      "store.finalize_steps",
      { finalizeInput: finalizeInput(meal) },
      WizardFinalizeStepsResultSchema,
      { prisma, mode: "tool", cachedSystemPrefix: STABLE_FINALIZE_PREFIX },
    );
    accumulate(tokens, fin.metadata);
    if (!fin.success) {
      skips.push({ targetDish: target.dish, profileKey: profile.key, stage: "finalize", reason: fin.reason, title: meal.title });
      consecutiveFailures++; progress(); continue;
    }
    const merged = mergeSteps(meal, fin.data);
    if (!merged.ok) {
      skips.push({ targetDish: target.dish, profileKey: profile.key, stage: "merge", reason: merged.reason, title: meal.title });
      consecutiveFailures++; progress(); continue;
    }

    // 4. Allergens + payload (stamped with the target-dish key).
    const allergens = deriveAllergens(meal);
    const payload = buildMaterializePayload(meal, merged.stepsPerDish, allergens, target.key);

    // 5. Persist (two-pass, one $transaction PER MEAL so an interrupted run
    //    keeps completed work and resumes safely). Reserve the key first.
    seenKeys.add(target.key);
    let mealId: string | undefined;
    let written = false;
    if (opts.apply) {
      const mentions = collectMealMentions(payload);
      const ingredientIdByCanonical = await resolveIngredients(prisma, mentions);
      const res = await prisma.$transaction((tx) =>
        materializeMeal(tx, "", payload, ingredientIdByCanonical, STORE_FILL_TARGET),
      );
      mealId = res.mealId;
      written = true;
    }

    consecutiveFailures = 0;
    records.push({
      targetDish: target.dish,
      profileKey: profile.key,
      title: meal.title,
      cuisineType: meal.cuisineType,
      difficulty: meal.difficulty,
      servings: meal.servings,
      dishes: meal.dishes.map((d, di) => ({
        title: d.title,
        role: d.role,
        ingredientCount: d.ingredients.length,
        stepCount: merged.stepsPerDish[di].length,
      })),
      allergens,
      written,
      mealId,
    });
    progress();
  }

  const costUsd = computeCacheAwareCostUsd(tokens, rate);
  if (stoppedBy) log(`STOPPED by ${stoppedBy} — ${records.length} written, $${costUsd.toFixed(4)} spent`);
  return { apply: opts.apply, attempted, records, skips, completenessRejections, tokens, costUsd, stoppedBy };
}
