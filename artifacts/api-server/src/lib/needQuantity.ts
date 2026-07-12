// WS7-8b — shared NEED-quantity rounding (PRD §2.8 [LOCKED]).
//
// Extracted from groceryList.ts in B2 so both the deterministic consolidation
// sweep AND the AI-merge re-sweep (generateFinalGroceryList) round identically.
// A grocery line is two parts: a PURCHASE size (the buyable pack) and a NEED
// quantity (what the plan requires). This rounds the NEED only — it is
// decision-support ("do I have enough, or buy more?"), so it stays fine-grained
// (⅛ ladder) and is NEVER rounded toward a purchasable amount. B1 made this
// number honest; B2 must not re-round it toward a pack size.

const QTY_EPSILON = 1e-9;

// Volume/weight units that follow the sensible-fraction rule. Everything not
// listed (each, clove, slice, can, head, bunch, …, empty, unknown) is a
// discrete whole-unit count. Lowercase; matched case-insensitively.
export const MEASURED_UNITS = new Set<string>([
  "cup", "cups",
  "tbsp", "tablespoon", "tablespoons",
  "tsp", "teaspoon", "teaspoons",
  "oz", "ounce", "ounces", "fl oz", "fluid ounce", "fluid ounces",
  "lb", "lbs", "pound", "pounds",
  "g", "gram", "grams",
  "kg", "kilogram", "kilograms",
  "ml", "milliliter", "milliliters",
  "l", "liter", "liters",
  "pinch", "pinches",
  "quart", "quarts",
  "gallon", "gallons",
]);

// Sensible kitchen fractions, ascending, with the 0 and 1 ladder ends. Eighths
// give fine-grained "need" granularity; ⅓ and ⅔ stay so a value just below them
// rounds up to clean thirds (1.3 → ⅓). Round-UP only, never down.
const FRACTION_LADDER = [
  0, 1 / 8, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 5 / 8, 2 / 3, 3 / 4, 7 / 8, 1,
];

/**
 * Round a NEED quantity per PRD §2.8:
 *   - Discrete / unknown / empty units → round UP to a whole unit
 *     (3.75 cloves → 4; you can't buy 0.75 of a lemon).
 *   - Measured units (volume/weight) → round the fractional remainder UP to ⅛
 *     granularity, keeping clean ⅓/⅔. Never inflates a value already on-ladder.
 * Whole-number inputs pass through unchanged (epsilon-guarded).
 */
export function roundNeedQuantity(quantity: number, unit: string): number {
  if (!(quantity > 0)) return quantity;

  if (!MEASURED_UNITS.has(unit.trim().toLowerCase())) {
    return Math.ceil(quantity - QTY_EPSILON);
  }

  const whole = Math.floor(quantity + QTY_EPSILON);
  const frac = quantity - whole;
  if (frac <= QTY_EPSILON) return whole;
  for (const step of FRACTION_LADDER) {
    if (frac <= step + QTY_EPSILON) return whole + step;
  }
  return whole + 1; // unreachable (ladder ends at 1) — defensive.
}
