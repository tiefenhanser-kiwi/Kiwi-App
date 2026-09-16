// WS9 Redesign Arc Block 2c Part A — the bulk intake's REVIEW hand-off.
//
// When a bulk run finishes, the builder lands on the Playlist tab and the tab
// shows the review sheet over itself: what was saved, a "Review ›" per row
// that opens that meal's editor, and "Reviewed ✓" once that editor saves.
// The list crosses three screens (builder → tab → editor → tab), so it lives
// in this tiny module store rather than in route params: the tab stays
// mounted under the editor and simply re-reads it, and the editor marks a
// row reviewed without knowing anything about the sheet.
//
// Nothing here is required of the user — the meals are already saved. Done
// clears the store.

import { useSyncExternalStore } from "react";

export interface ImportReviewItem {
  mealId: string;
  title: string;
  reviewed: boolean;
}

export interface ImportReviewState {
  items: ImportReviewItem[];
  /** The meal whose editor is open — the sheet hides while it is. */
  reviewingId: string | null;
}

const EMPTY: ImportReviewState = { items: [], reviewingId: null };
let state: ImportReviewState = EMPTY;
const listeners = new Set<() => void>();

function emit(next: ImportReviewState) {
  state = next;
  for (const l of listeners) l();
}

/** The bulk run finished — stage what it saved for the tab's sheet. */
export function stageImportReview(saved: { mealId: string; title: string }[]): void {
  emit({
    items: saved.map((s) => ({ mealId: s.mealId, title: s.title, reviewed: false })),
    reviewingId: null,
  });
}

/** "Review ›" — the editor is opening for this meal; the sheet hides. */
export function beginImportReview(mealId: string): void {
  emit({ ...state, reviewingId: mealId });
}

/** The editor saved — flip the row; the sheet shows again. */
export function markImportReviewed(mealId: string): void {
  emit({
    items: state.items.map((i) => (i.mealId === mealId ? { ...i, reviewed: true } : i)),
    reviewingId: null,
  });
}

/** The tab regained focus without a save (the user backed out) — show the sheet. */
export function endImportReview(): void {
  if (state.reviewingId !== null) emit({ ...state, reviewingId: null });
}

/** Done — nothing is required; the meals are already saved. */
export function clearImportReview(): void {
  if (state !== EMPTY) emit(EMPTY);
}

export function getImportReview(): ImportReviewState {
  return state;
}

export function useImportReview(): ImportReviewState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getImportReview,
    getImportReview,
  );
}
