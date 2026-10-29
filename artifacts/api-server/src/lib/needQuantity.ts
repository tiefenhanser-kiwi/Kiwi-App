// WS7-8b — shared NEED-quantity rounding (PRD §2.8 [LOCKED]).
//
// Extracted from groceryList.ts in B2 so both the deterministic consolidation
// sweep AND the AI-merge re-sweep (generateFinalGroceryList) round identically.
// A grocery line is two parts: a PURCHASE size (the buyable pack) and a NEED
// quantity (what the plan requires). This rounds the NEED only — it is
// decision-support ("do I have enough, or buy more?"), so it stays fine-grained
// (⅛ ladder) and is NEVER rounded toward a purchasable amount. B1 made this
// number honest; B2 must not re-round it toward a pack size.

import { PACK_FORGIVENESS_UNIT, canonicalUnitToken, packsForNeed } from "./ingredientConversions";

const QTY_EPSILON = 1e-9;

// ── 🔴 D-WS9-360 (RULED, 2026-10-29) — A COUNTED ROW NEVER SHOWS A FRACTION ───
//
// "A list row for anything sold by the count or the bunch never shows a
// fraction. 0.5 cucumber → 1 cucumber, 0.125 bunch cilantro → 1 bunch. Prep and
// Cook Mode amounts stay recipe-exact." This overrules Root B below FOR THESE
// UNITS ONLY: the night run of Oct 29 found 27 of 135 counted rows fractional
// after generation ("0.5 each english cucumber", "13.625 clove garlic", "2.875
// sprig fresh rosemary"). A measured need (cups, ounces, pounds) keeps the ⅛
// ladder.
//
// A counted need rounds UP to whole items. A bunch keeps the pack forgiveness
// (packsForNeed, PACK_FORGIVENESS_FRACTION): 1⅛ bunches of an herb is one bunch,
// exactly what the order line buys, so the need never says more than the pack.
// The unit is read as the bucket carries it; "" is a bare count ("2 limes").
const COUNTED_UNIT =
  /^(?:|each|ea|whole|pieces?|pcs?|count|ct|items?|large|medium|small|cloves?|heads?|bunch(?:es)?|stalks?|ribs?|sprigs?|lea(?:f|ves)|sticks?|ears?|bulbs?|slices?|cans?|jars?|packages?|packets?|pkgs?|bags?|box(?:es)?|bottles?|loa(?:f|ves)|fillets?|breasts?|thighs?|links?|sheets?|strips?|wedges?|pouch(?:es)?|containers?|cartons?|tubs?|blocks?)$/;

/** D-WS9-360 — is this a unit something is sold by the count or the bunch in? */
export function isCountedNeedUnit(unit: string): boolean {
  return COUNTED_UNIT.test(unit.trim().toLowerCase().replace(/\.$/, ""));
}

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
 * D-WS9-360 (ruled 2026-10-29) is that per-unit rule: a unit sold by the count
 * or the bunch (isCountedNeedUnit) is whole again; every other unit keeps this
 * ladder.
 */
export function roundNeedQuantity(quantity: number, unit: string): number {
  if (!(quantity > 0)) return quantity;
  // D-WS9-360 — see the note at the top. Whole items; a bunch with its forgiveness.
  if (isCountedNeedUnit(unit)) {
    return packsForNeed(quantity, canonicalUnitToken(unit) === PACK_FORGIVENESS_UNIT);
  }

  const whole = Math.floor(quantity + QTY_EPSILON);
  const frac = quantity - whole;
  if (frac <= QTY_EPSILON) return whole;
  for (const step of FRACTION_LADDER) {
    if (frac <= step + QTY_EPSILON) return whole + step;
  }
  return whole + 1; // unreachable (ladder ends at 1) — defensive.
}
