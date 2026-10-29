// QA-NIGHT-1 — the shapes every reconciler shares.
//
// A reconciler is a PURE function from captured evidence to { checked, findings }.
// The journeys capture; the reconcilers judge. So every reconciler can be fed a
// hand-made fixture (reconcile.test.ts) and broken on purpose (§27.4).

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  rule: RuleId;
  /**
   * Stable across households and nights: rule, kind, and a normalised subject
   * (an ingredient, a step kind) — never an id. Two households hitting the same
   * defect group under one signature.
   */
  signature: string;
  severity: Severity;
  household: string;
  meal?: string;
  step?: string;
  detail: string;
  numbers?: Record<string, number | string | null>;
  /** Filled by known.ts when a known.json entry matches. */
  known?: string;
  /** QA-NIGHT-2 D: the entry it matches is marked fixed — the bug is back (always high). */
  regressed?: boolean;
}

export interface RuleResult {
  rule: RuleId;
  /** How many things the rule looked at. 0 means "nothing to check", never a pass. */
  checked: number;
  findings: Finding[];
}

export const RULE_TITLES: Record<RuleId, string> = {
  R1: "grocery covers the recipes",
  R2: "nothing extra on the grocery list",
  R3: "grocery follows edits",
  R4: "prep stays inside the recipes",
  R5: "the subset is the subset",
  R6: "labels add up",
  R7: "prep → cook",
  R8: "Cook Mode is complete",
  R9: "the feast's dates",
  R10: "lifecycle facts",
  R11: "health",
};

/** One HTTP call, as the night run's client saw it. */
export interface CallRecord {
  household: string;
  step: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  /** Statuses this step expected (a 4xx a journey provokes on purpose). */
  expected: number[];
  /** First 300 chars of a non-2xx body. */
  error?: string;
}

// ── evidence shapes (the subset of the wire the reconcilers read) ───────────

export interface RecipeIngredient {
  name: string;
  quantity: number;
  unit: string;
  isOptional: boolean;
}

export interface RecipeStep {
  stepIndex: number;
  text: string;
  estimatedMinutes: number;
  phaseType: string;
  preppedRefs?: { containerId: string; label: string }[];
  /** D-WS9-239 intra-dish overlap token: steps that share one may run in either order. */
  parallelGroup?: string | null;
}

export interface RecipeDish {
  dishId: string;
  title: string;
  /** authoredServingsDefault: the servings the amounts are written for. */
  servings: number;
  /** The dish's servingsDefault: what it cooks for when the item has no override. */
  defaultServings: number;
  /** The dish holds the whole bird: its amounts follow the bird weight, so R1 checks presence only. */
  isBirdDish?: boolean;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
}

/** One plan meal as the reconcilers see it. */
export interface PlanMeal {
  planItemId: string;
  mealId: string;
  title: string;
  /** Every name the meal goes by (title, displayTitle, an override title): grocery `mealNames` use one. */
  aliases: string[];
  servingsOverride: number | null;
  birdWeightLb: number | null;
  /** The feast meal (Thanksgiving) — its Cook Mode is worded from the feast build. */
  isFeast: boolean;
  dishes: RecipeDish[];
}

/** The server's multiplier (groceryList.ts): (override ?? the dish's default) ÷ the authored servings. */
export function dishFactor(meal: PlanMeal, dish: RecipeDish): number {
  const target = meal.servingsOverride ?? dish.defaultServings;
  return dish.servings > 0 ? target / dish.servings : 1;
}

export interface GroceryRow {
  id: string;
  displayName: string;
  canonicalName: string | null;
  quantity: number;
  unit: string;
  mealNames: string[];
  isChecked: boolean;
  isUniversalStaple: boolean;
  isUserPantryStaple: boolean;
  isRecurringItem: boolean;
  isUserAdded: boolean;
  isOptional: boolean;
}

export interface PrepStep {
  stepKey: string;
  phase: string;
  title: string;
  instructions: string;
  contributesToMealIds: string[];
  containerId?: string | null;
  containerNames?: string[];
  labelCount?: number | null;
  skipSuggested?: boolean;
  holdsNoContainer?: boolean;
  coversCookSteps?: { mealId: string; dishId: string; stepIndex: number }[];
}

/** A prep session as served: the week, a subset, one meal, or the feast. */
export interface PrepSession {
  kind: "week" | "subset" | "one-meal" | "feast";
  /** The meals asked for (subset / one-meal); empty for the week. */
  mealIds: string[];
  steps: PrepStep[];
  containerCount?: number | null;
}
