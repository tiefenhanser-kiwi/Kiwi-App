// BOOK-1C1 (D-WS9-312) — the filter sheet's fixed copy.

/**
 * BOOK-1C2 — the filter sheet's one disabled line. It was three disabled chips
 * (Vegetarian · Vegan · Pescatarian) over "coming in December"; naming styles
 * the app cannot filter by yet promised a list, so the line names none.
 */
export const EATING_STYLES_SOON_LINE = "Eating styles: coming in December";

/**
 * The allergy line. The allergen filter is always on (server-side, from the
 * stored preferences), so this is a statement, not a control.
 *
 * CLIENT-2 A2 (BUG-508) — `locked` is whether the sheet draws it as a lock
 * (icon + tan fill). With no allergies set nothing is hidden, and a lock read
 * as the reason a filter found few meals; so that line is plain text and says
 * nothing is hidden. Still unknown (null, prefs loading) keeps the lock.
 */
export function allergyLine(allergies: readonly string[] | null): { text: string; locked: boolean } {
  if (allergies === null) return { text: "Your allergies are always on. Change them in Profile.", locked: true };
  const list = allergies.map((a) => a.trim()).filter((a) => a.length > 0);
  if (list.length === 0) return { text: "Allergies: none set, so nothing is hidden. Add them in Profile.", locked: false };
  return { text: `Allergies always on: ${list.join(", ")}. Change them in Profile.`, locked: true };
}
