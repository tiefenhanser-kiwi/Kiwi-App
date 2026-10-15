// THX-2G follow-up C — the deterministic checks on a GENERATED meal, run through
// runStoreFill's `postGenerate` hook: after the completeness gate, before the
// substitution sanitize and the finalize call, so the steps are written from
// what survives. Pure; every rule has a test (thx2Checks.test.ts).
//
// Two kinds of edit, both reported per meal:
//   swap_dropped — a substitution that is not a shortcut:
//     • the product names the same thing it replaces ("store-bought refrigerated
//       pie crust" for "refrigerated pie crust");
//     • a bought broth or stock for a bought broth or stock. Hans: store-bought
//       stock IS a shortcut for stock the recipe MAKES ("getting turkey stock
//       from the store would be a shortcut to making your own") — a replaced
//       neck-and-giblets list keeps its swap; only bought-for-bought goes.
//   unit_fixed — garlic counted "each" → "clove"; a teaspoon amount under ⅛ →
//     "1 pinch"; a spoon or cup amount whose fraction is no cook's fraction
//     (0.06, 0.33) snapped to the nearest one, so nothing prints as a decimal.

import type { WizardExpandEnrichedMealDetails } from "../../src/lib/ai/schemas/wizard";

export interface CheckNote {
  dish: string;
  kind: "swap_dropped" | "unit_fixed";
  detail: string;
}

// ── swaps ───────────────────────────────────────────────────────────────────

const NOISE = /\b(store[- ]bought|refrigerated|carton|cartons|low[- ]sodium|reduced[- ]sodium)\b/g;

const singular = (w: string) =>
  w.length > 3 && /(ches|shes|sses|xes|oes)$/.test(w) ? w.slice(0, -2)
  : w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y`
  : w.length > 2 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1)
  : w;

/** The name with packaging words, parentheticals, punctuation and plurals gone. */
export function swapKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(NOISE, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

const BROTH = /\b(broth|stock)s?\b/i;
const MADE = /\bhomemade\b/i;

/** Why a substitution is not a shortcut, or null when it is one. */
export function swapProblem(sub: { product: string; replaces: string[] }): string | null {
  const p = swapKey(sub.product);
  const same = sub.replaces.find((r) => swapKey(r) === p);
  if (same) return `"${sub.product}" replaces "${same}" — the same thing`;
  if (BROTH.test(sub.product) && sub.replaces.length > 0 && sub.replaces.every((r) => BROTH.test(r) && !MADE.test(r))) {
    return `"${sub.product}" replaces store-bought ${sub.replaces.map((r) => `"${r}"`).join(", ")} — bought for bought`;
  }
  return null;
}

// ── units ───────────────────────────────────────────────────────────────────

const COOK_FRACTIONS = [0, 1 / 8, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];
const SPOON_OR_CUP = /^(teaspoons?|tsp|tablespoons?|tbsp|cups?)$/i;
const TEASPOON = /^(teaspoons?|tsp)$/i;
const EACH = /^(each|whole|piece|pieces)$/i;
const GARLIC_NOT_CLOVES = /\b(head|heads|bulb|bulbs|powder|salt|granulated|paste|jar|jarred)\b/i;

/** The nearest cook's fraction (whole part kept). 0.06 → 0 (the pinch rule runs first). */
export function snapToCookFraction(q: number): number {
  const whole = Math.floor(q);
  const frac = q - whole;
  let best = COOK_FRACTIONS[0];
  for (const f of COOK_FRACTIONS) if (Math.abs(frac - f) < Math.abs(frac - best)) best = f;
  return whole + best;
}

/** True when q is already a whole number plus a cook's fraction. */
export function isCookFraction(q: number): boolean {
  return Math.abs(snapToCookFraction(q) - q) < 1e-6;
}

export function fixUnit(ing: { name: string; quantity: number; unit: string }): string | null {
  const before = `${ing.quantity} ${ing.unit} ${ing.name}`;
  if (/\bgarlic\b/i.test(ing.name) && EACH.test(ing.unit.trim()) && !GARLIC_NOT_CLOVES.test(ing.name)) {
    ing.unit = "clove";
    // "4 each garlic cloves" must not become "4 clove garlic cloves".
    ing.name = ing.name.replace(/\s*\bcloves?\b/i, "").replace(/\s{2,}/g, " ").trim() || "garlic";
    return `${before} → ${ing.quantity} clove ${ing.name}`;
  }
  if (TEASPOON.test(ing.unit.trim()) && ing.quantity < 1 / 8 - 1e-9) {
    ing.quantity = 1;
    ing.unit = "pinch";
    return `${before} → 1 pinch`;
  }
  if (SPOON_OR_CUP.test(ing.unit.trim()) && !isCookFraction(ing.quantity)) {
    const snapped = snapToCookFraction(ing.quantity);
    if (snapped > 0) {
      ing.quantity = snapped;
      return `${before} → ${Number(snapped.toFixed(4))} ${ing.unit}`;
    }
  }
  return null;
}

// ── the hook ────────────────────────────────────────────────────────────────

/** Apply every check to a generated meal IN PLACE; return what changed. */
export function applyChecks(meal: WizardExpandEnrichedMealDetails): CheckNote[] {
  const notes: CheckNote[] = [];
  for (const dish of meal.dishes) {
    if (dish.substitutions && dish.substitutions.length > 0) {
      const kept = dish.substitutions.filter((s) => {
        const why = swapProblem(s);
        if (why) notes.push({ dish: dish.title, kind: "swap_dropped", detail: why });
        return !why;
      });
      dish.substitutions = kept.length > 0 ? kept : undefined;
    }
    for (const ing of dish.ingredients) {
      const fixed = fixUnit(ing);
      if (fixed) notes.push({ dish: dish.title, kind: "unit_fixed", detail: fixed });
    }
  }
  return notes;
}
