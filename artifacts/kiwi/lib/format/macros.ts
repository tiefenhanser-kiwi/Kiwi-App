// WS7-6 (E) Block 2 §1 — shared macro/calorie display formatter.
//
// Kills the "51.60000000000001g" float artifact at RAW render sites by
// rounding to whole numbers. Null/undefined/NaN render as the caller's
// fallback (default "—" to match Plan Review's daily-averages convention).

export function formatMacro(
  value: number | null | undefined,
  fallback: string = "—",
): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return String(Math.round(value));
}

// WS7-6 C-fix Block 4 — shared per-serving macro line. Extracts the
// "320 cal · 30g P · 40g C · 20g F" pattern that PlanReviewMealRow built
// inline so dish rows (Recipes→Dishes / Mode-C picker / Meal→Add-Dish sheet)
// render the identical line. Each field rounds via formatMacro; missing values
// render as "0" (the site convention for these rows) so the line keeps a
// consistent shape. Real zeros (e.g. Garlic Green Beans at 0 cal) render as-is.
export function formatMacroLine(
  calories: number | null | undefined,
  protein: number | null | undefined,
  carbs: number | null | undefined,
  fat: number | null | undefined,
): string {
  return `${formatMacro(calories, "0")} cal · ${formatMacro(protein, "0")}g P · ${formatMacro(carbs, "0")}g C · ${formatMacro(fat, "0")}g F`;
}
