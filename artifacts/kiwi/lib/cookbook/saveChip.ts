// BOOK-1C2 — the Save chip (it replaced the heart). Hans: "the hearts look like
// 'likes' - can we update that to a dynamic chip that says 'save' and then goes
// to 'saved' (light sage, then dark sage on saved). basically the same
// behavior, different icon".
//
// Same state, same write: the chip renders `isSaved` (the card) or the
// lineage-aware favorites list (meal detail), and a tap calls
// AppContext.setSaved — exactly what the heart did. Only the face changed, so
// this module is the face: what the chip says, to the eye and to a screen
// reader, in each state. components/SaveChip.tsx draws it.

/** The tap target, both axes: the 44 pt floor, whatever the pill's own size. */
export const SAVE_CHIP_MIN_HIT = 44;

export interface SaveChipView {
  /** The visible word. */
  label: "Save" | "Saved";
  /** Contains the visible word (WCAG 2.5.3, label in name). */
  accessibilityLabel: string;
  /** What a tap will do from here. */
  accessibilityHint: string;
  /** Feather glyph: a bookmark to save, a check once saved. */
  icon: "bookmark" | "check";
  /** Light sage before, dark sage once saved. */
  tone: "light" | "dark";
}

export function saveChipView(saved: boolean): SaveChipView {
  return saved
    ? {
        label: "Saved",
        accessibilityLabel: "Saved to My Meals",
        accessibilityHint: "Removes it from My Meals",
        icon: "check",
        tone: "dark",
      }
    : {
        label: "Save",
        accessibilityLabel: "Save to My Meals",
        accessibilityHint: "Adds it to My Meals",
        icon: "bookmark",
        tone: "light",
      };
}

/** The toast a tap shows (on tap, before the write lands — BOOK-1C2 item 5). */
export function saveToastMessage(nextSaved: boolean): string {
  return nextSaved ? "Saved to My Meals" : "Removed from My Meals";
}
