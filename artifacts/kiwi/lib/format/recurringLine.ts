// WS9 D-WS9-284 / D-WS9-188 — R3: WHAT A RECURRING ROW SAYS ABOUT ITSELF.
//
// A recurring item is a standing order the user typed once ("milk", "paper
// towels", "bananas"). B3 made it MEET the plan: the row the shopper sees can
// now carry both a standing quantity and a quantity this week's recipes asked
// for, and until this block the line said neither — it printed a summed number
// and left the user to wonder why they were buying five lemons.
//
// Hans ruled the two shapes (D-WS9-188):
//
//   SAME UNIT      one line, summed, with the split
//                  "5 lemons — 2 recurring + 3 for meals"
//   OTHERWISE      the recurring quantity is the order line, the need beside it
//                  "1 gallon whole milk — recurring; ½ cup for meals"
//
// ⛔ THE STANDING RULE, and it is why the second branch exists at all: THE APP
// NEVER DECIDES THAT A GALLON COVERS THE CUPS. A gallon and half a cup convert
// perfectly and Hans put that exact pair in the incomparable branch on purpose.
// The server owns that decision (`recurringComparable`: both sides the same
// COUNT unit, dozen↔each deliberately not converted) and this module only reads
// `comparable`. Do not re-derive it here, and do not "improve" it into a
// dimension test — that is the consumption modelling the ruling forbids.
//
// A THIRD SHAPE falls out of the data rather than the ruling: a recurring row
// the plan needs NONE of (`mealQuantity === null`). Five of the twenty census
// plans carry one — "1 gallon whole milk (1 gallon)", "1 dozen large eggs
// (1 dozen)". It gets "— recurring" and no "for meals" clause, because there is
// no meal quantity to name and inventing "+ 0 for meals" would be worse than
// saying nothing.
//
// Pure and in lib/ because app/** is outside the test glob (D-WS9-164).

import type { RecurringFacets } from "../types";
import { pluralizeNeedUnit } from "./grocery";
import { formatNeedGlyph } from "./quantity";

/** The suffix a recurring row appends to its line, or null when it has none. */
export interface RecurringLine {
  /** The clause after the em-dash, without the dash. */
  detail: string;
  /** Which R3 branch produced it — read by the tests, not by the render. */
  branch: "summed" | "default_purchase" | "recurring_only";
}

/**
 * One quantity + unit, in the grocery line's own conventions: glyph fractions
 * (½, not 0.5) and the count-noun plural. `pluralizeNeedUnit`, not
 * `pluralizeUnitWord` — this is the grocery sentence, where measure units stay
 * abbreviated and uninflected ("½ cup", "2 lb"), and it is the same helper
 * formatNeedText uses so the two halves of the row cannot drift.
 */
// ── [grocery] F (F5.5) — A COUNT DROPS "each" ──────────────────────────────
//
// Hans's device pass: "— recurring; 1 each for meals" should read "— recurring;
// 1 for meals". This is BUG-317's ruling ("'1 each large shrimp' is not
// English"; a count unit is a placeholder for the ABSENCE of a unit, written
// because the column is a `String` and something had to go in it) reaching the
// one sentence that had not heard it.
//
// ⚠️ THE SUMMED BRANCH ALREADY DID THIS, and that is what makes the defect a
// near-miss rather than an oversight: it calls `amount(q, null)` because the
// unit is shared and stated once. Only the default-purchase branch passes a
// real unit, and only there could "each" reach the page.
//
// The token set is BUG-317's, not a new one — the same reasoning and the same
// deliberate exclusions. `whole` is absent ("1 whole chicken"), and so are
// `head`, `clove`, `bunch`, `can` and `slice`: those are units a recipe says
// out loud, and "recurring; 3 cloves for meals" is correct English.
const COUNT_PLACEHOLDER_UNITS: ReadonlySet<string> = new Set([
  "each",
  "piece",
  "pieces",
  "count",
  "ct",
  "unit",
  "units",
]);

function amount(quantity: number, unit: string | null): string {
  const n = formatNeedGlyph(quantity);
  const u = unit?.trim();
  if (!u || COUNT_PLACEHOLDER_UNITS.has(u.toLowerCase())) return n;
  return `${n} ${pluralizeNeedUnit(u, quantity)}`;
}

/**
 * R3's clause for one row, or null when the row is not recurring / carries no
 * facets. The caller renders "{the row's normal line} — {detail}".
 *
 * ⚠️ THE ORDER HALF IS NOT THIS MODULE'S. On the summed branch the row already
 * prints the summed total (that IS `quantity`), and on the incomparable branch
 * it already prints the recurring pack — the server wrote `purchaseDisplay`
 * from the recurring resolution. So R3 is a SUFFIX, not a rewrite, and nothing
 * here recomputes a number the row is already showing. That is what keeps this
 * additive: a row whose facets are absent renders exactly as it does today.
 */
export function recurringDetail(
  facets: RecurringFacets | undefined,
): RecurringLine | null {
  if (!facets) return null;
  const { recurringQuantity, recurringUnit, mealQuantity, mealUnit, comparable } =
    facets;

  // No meal need — a standing order this week's cooking does not touch.
  if (mealQuantity === null || !(mealQuantity > 0)) {
    return { detail: "recurring", branch: "recurring_only" };
  }

  // Same unit → one line, summed, with the split.
  if (comparable && recurringQuantity !== null && recurringQuantity > 0) {
    return {
      detail: `${amount(recurringQuantity, null)} recurring + ${amount(
        mealQuantity,
        null,
      )} for meals`,
      branch: "summed",
    };
  }

  // Otherwise the recurring quantity is the order line and the need shows
  // beside it. The recurring half is NOT restated — the row's pack already is
  // it — so the clause names it and then states the need.
  return {
    detail: `recurring; ${amount(mealQuantity, mealUnit)} for meals`,
    branch: "default_purchase",
  };
}

/**
 * Convenience for a caller that has a whole line already composed. Kept beside
 * the branch logic so the em-dash lives in ONE place — the grocery row renders
 * the two halves as separate Text nodes and would otherwise spell it itself.
 */
export function withRecurringDetail(
  line: string,
  facets: RecurringFacets | undefined,
): string {
  const r = recurringDetail(facets);
  return r ? `${line} — ${r.detail}` : line;
}

/**
 * Is this row one of the non-food household items (paper towels, toilet paper,
 * pet treats)?
 *
 * 🔴 KEYED ON `sectionKey`, NOT on the facets, and that is deliberate. The
 * server classifies household as a CATEGORY (groceryList.ts ruling 5:
 * "household is a CATEGORY, never a lookup failure") and persists it as
 * `storeSection`, which the client has always received and normalizeListItem
 * has always copied. `recurringFacets.household` says the same thing but only
 * on a row the resolver still claims — a list generated before B3, or one whose
 * user has since deleted the recurring text, keeps the section and loses the
 * facet. The section is the durable signal.
 */
export function isHouseholdRow(item: { sectionKey: string }): boolean {
  return item.sectionKey === "household";
}
