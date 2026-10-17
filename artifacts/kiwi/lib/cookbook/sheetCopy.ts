// BOOK-1C1 (D-WS9-312) — the filter sheet's fixed copy.

/**
 * BOOK-1C2 — the filter sheet's one disabled line. It was three disabled chips
 * (Vegetarian · Vegan · Pescatarian) over "coming in December"; naming styles
 * the app cannot filter by yet promised a list, so the line names none.
 */
export const EATING_STYLES_SOON_LINE = "Eating styles: coming in December";

/**
 * The locked allergy line. The allergen filter is always on (server-side, from
 * the stored preferences), so this is a statement, not a control.
 */
export function allergyLine(allergies: readonly string[] | null): string {
  if (allergies === null) return "Your allergies are always on. Change them in Profile.";
  const list = allergies.map((a) => a.trim()).filter((a) => a.length > 0);
  if (list.length === 0) return "Your allergies: none set. Add them in Profile.";
  return `Your allergies: always on: ${list.join(", ")}. Change them in Profile.`;
}
