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

// Sensible kitchen fractions, ascending, with the 0 and 1 ladder ends. Eighths
// give fine-grained "need" granularity; ⅓ and ⅔ stay so a value just below them
// rounds up to clean thirds (1.3 → ⅓). Round-UP only, never down.
const FRACTION_LADDER = [
  0, 1 / 8, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 5 / 8, 2 / 3, 3 / 4, 7 / 8, 1,
];

/**
 * Round a NEED quantity per PRD §2.8: round the fractional remainder UP to ⅛
 * granularity, keeping clean ⅓/⅔. Never inflates a value already on-ladder;
 * whole numbers pass through unchanged (epsilon-guarded).
 *
 * WS9 Root B — this used to CEIL discrete/unknown units (each, clove, bunch…)
 * to a whole. That was a direct violation of the locked rule this file exists
 * to enforce: 1.25 bunch became 2 bunch, which is rounding the need TOWARD A
 * PURCHASABLE AMOUNT. It also made real changes invisible — half a lemon and
 * a whole lemon both displayed as 1, so adding the second half looked like
 * nothing had happened.
 *
 * The round-UP that shoppers need did not disappear: BUG-125 moved it to the
 * ORDER line, where composePackName ceils the pack count. The need half is
 * decision-support and stays fine-grained for EVERY unit, which is why the
 * measured/discrete split is gone rather than merely relaxed.
 *
 * The unit is retained in the signature — every caller passes it, and a future
 * per-unit granularity rule would want it — but it no longer selects a branch.
 */
export function roundNeedQuantity(quantity: number, _unit: string): number {
  if (!(quantity > 0)) return quantity;

  const whole = Math.floor(quantity + QTY_EPSILON);
  const frac = quantity - whole;
  if (frac <= QTY_EPSILON) return whole;
  for (const step of FRACTION_LADDER) {
    if (frac <= step + QTY_EPSILON) return whole + step;
  }
  return whole + 1; // unreachable (ladder ends at 1) — defensive.
}
