// Row 13 "Test Kitchen" · Block 2b (BUG-315) — ONE ingredient line, for every
// screen that renders one.
//
// 🔴 WHY THIS FILE EXISTS. The guest recipe screen showed "1½ large shrimp",
// "4 unsalted butter", "12 angel hair pasta" — every unit gone — while the
// member meal screen showed "1½ pound large shrimp" off the same payload. The
// guest screen HAD called the right helper: lib/format/quantity.ts's
// formatQuantity. What it had not noticed is that formatQuantity is
// AMOUNT-ONLY — it takes `unit` solely to pick the whole-unit ceiling rule
// ("whole", "clove") and never emits it. The unit word was appended by the
// CALLER, inline in JSX, at each of the three call sites:
//
//   app/meal/[id].tsx     {formatQuantity(q * mult, unit)} {unit} {name}
//   app/dish/[id].tsx     {formatQuantity(q, unit)} {unit} {name}
//   app/test-kitchen/recipe.tsx   [formatQuantity(q, unit), name, ...].join(" ")
//
// So there was no shared line formatter to reuse (§27.2's answer: the reusable
// piece did not exist), and the fourth caller to compose the line by hand would
// have been free to drop the unit again. This is the extracted pure part, which
// the ruling asks for explicitly, and app/meal/[id].tsx now calls it too — that
// is what makes "the SAME formatter the member screen uses" true rather than
// aspirational.
//
// Pure and in lib/ because app/** is outside the test glob (D-WS9-164).

import { formatQuantity } from "./quantity";

/** The fields of a meal-detail ingredient this formatter reads. Structurally
 *  satisfied by MealDetailIngredientSchema's output (lib/api/meals.ts) and by
 *  the dish-detail ingredient shape, so neither needs importing here. */
export interface IngredientLineParts {
  name: string;
  quantity: number;
  /** Nullable/optional defensively: the wire schema types it `z.string()`, but
   *  an empty string is real (a bare count), and a caller holding a looser
   *  shape must not have to coerce before asking. */
  unit?: string | null;
  preparationNote?: string | null;
  isOptional?: boolean;
}

export interface IngredientLineOptions {
  /** Scales the quantity before rounding — the member screen's servings
   *  stepper. Defaults to 1; the guest screen is read-only and passes none. */
  multiplier?: number;
  /**
   * Append "(preparationNote)" and "— optional" when present.
   *
   * OFF by default, and that default is load-bearing: the member meal screen
   * renders neither today, and turning them on for it would be a copy change
   * this lane was not asked to make (Block 2b ruling 4). The guest recipe
   * screen already rendered both before this fix and keeps them — it is the
   * full read-only recipe, with no servings stepper and no edit path, so the
   * prep note is the only place "patted dry" can appear at all.
   */
  includeNotes?: boolean;
}

// ── BUG-317 — THE COUNT UNITS, SUPPRESSED (ruled by Hans, 2026-09-27) ──────
//
// "1 each large shrimp" is not English. A COUNT unit is a placeholder for the
// absence of a unit — the catalog writes it because the column is a `String` and
// something had to go in it — so emitting it puts a word on screen that no recipe
// has ever contained. Suppressed, the same lines read "1 large shrimp",
// "6 garlic cloves", "2 lemons (1 juiced…)".
//
// 🔴 REAL UNITS STAY WORDS, and the line between the two is what this set is for.
// `head`, `clove`, `bunch`, `can`, `slice` are units a recipe genuinely says out
// loud — "1 head garlic" is correct and "1 garlic" is not — so they are absent
// here, as are `whole` ("1 whole chicken") and `large` ("1 large egg"), both of
// which carry meaning that dropping them would destroy.
//
// WHAT IS ACTUALLY IN THE CATALOG (measured, not assumed): the 49 distinct `unit`
// values across the two catalog snapshots in
// api-server/scripts/output/ws9-30min/preimage_km30*.json are — each, "",
// teaspoon(s), tablespoon(s), cup(s), ounce(s), oz, pound(s), lb, clove, slice(s),
// head, stalk, sprig, leaf, strip, loaf, packet, package, bag, box, bottle,
// can(s), jar, bunch, pint, inch, "cup dry", "can (15.5 oz)", and a set of
// fraction-prefixed forms ("½ cups", "¼ teaspoons", "¾ lb", "½"). Of those, ONLY
// `each` and the empty string are count-ish: `piece`, `pieces`, `count`, `ct` and
// `unit` appear NOWHERE in the catalog today.
//
// They are in the set anyway, and that is a decision rather than an oversight.
// The prompt names them; the server's own count-unit table
// (api-server/src/lib/ingredientConversions.ts's COUNT_UNITS) holds exactly
// each/whole/""/piece/pieces/count/ct; and the recipe IMPORT path writes `unit`
// from arbitrary web pages, so a line reading "3 pieces chicken thigh" is one
// import away rather than impossible. Suppressing a spelling that never arrives
// costs nothing; missing one that does costs a bad line on the recipe screen.
//
// `whole` is the one member of the server's COUNT_UNITS deliberately NOT here:
// see above, and the test that pins "1 whole shallot" still passing.
const SUPPRESSED_COUNT_UNITS: ReadonlySet<string> = new Set([
  "each",
  "piece",
  "pieces",
  "count",
  "ct",
  "unit",
  "units",
]);

/** Whether a unit token is a placeholder rather than a word a recipe says. */
export function isSuppressedCountUnit(unit: string | null | undefined): boolean {
  return SUPPRESSED_COUNT_UNITS.has((unit ?? "").trim().toLowerCase());
}

/**
 * "1½ pound large shrimp" — amount, unit, name, in the member screen's order
 * and with the member screen's fraction glyphs (formatQuantity: eighths ∪
 * thirds, ε-exact, plain decimal otherwise).
 *
 * The unit token is dropped when it is absent or blank rather than emitted as
 * an empty word; that is the one behaviour difference from the old inline JSX,
 * which produced a double space there.
 *
 * BUG-317 — a COUNT unit is dropped too: "1 large shrimp", not "1 each large
 * shrimp". See SUPPRESSED_COUNT_UNITS above for which tokens count and which
 * real units (head, clove, bunch, can, slice, whole) deliberately do not.
 *
 * ⚠️ THE SUPPRESSED TOKEN IS STILL PASSED TO formatQuantity. It reads `unit` to
 * pick the whole-unit ceiling rule, so dropping it from the amount call as well
 * would change 3.2 lemons from "4" to "3.2" — a rounding change wearing a
 * display change's clothes.
 */
export function formatIngredientLine(
  ing: IngredientLineParts,
  opts: IngredientLineOptions = {},
): string {
  const { multiplier = 1, includeNotes = false } = opts;
  const unit = ing.unit?.trim() ?? "";
  const parts: string[] = [formatQuantity(ing.quantity * multiplier, unit)];
  if (unit && !isSuppressedCountUnit(unit)) parts.push(unit);
  parts.push(ing.name);
  if (includeNotes) {
    const note = ing.preparationNote?.trim();
    if (note) parts.push(`(${note})`);
    if (ing.isOptional) parts.push("— optional");
  }
  return parts.join(" ");
}
