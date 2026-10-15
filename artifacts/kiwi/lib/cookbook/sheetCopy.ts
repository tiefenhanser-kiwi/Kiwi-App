// BOOK-1C1 (D-WS9-312) — the filter sheet's fixed copy.

/** Shown as disabled chips under "Eating styles", labelled "coming in December". */
export const EATING_STYLES_SOON = ["Vegetarian", "Vegan", "Pescatarian"] as const;

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
