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

/**
 * "1½ pound large shrimp" — amount, unit, name, in the member screen's order
 * and with the member screen's fraction glyphs (formatQuantity: eighths ∪
 * thirds, ε-exact, plain decimal otherwise).
 *
 * The unit token is dropped when it is absent or blank rather than emitted as
 * an empty word; that is the one behaviour difference from the old inline JSX,
 * which produced a double space there.
 *
 * A count-ish unit ("each") is emitted AS WRITTEN — "1 each large shrimp" —
 * because that is what the member screen shows today and suppressing it is a
 * display ruling nobody has made. See the test, which pins it deliberately.
 */
export function formatIngredientLine(
  ing: IngredientLineParts,
  opts: IngredientLineOptions = {},
): string {
  const { multiplier = 1, includeNotes = false } = opts;
  const unit = ing.unit?.trim() ?? "";
  const parts: string[] = [formatQuantity(ing.quantity * multiplier, unit)];
  if (unit) parts.push(unit);
  parts.push(ing.name);
  if (includeNotes) {
    const note = ing.preparationNote?.trim();
    if (note) parts.push(`(${note})`);
    if (ing.isOptional) parts.push("— optional");
  }
  return parts.join(" ");
}
