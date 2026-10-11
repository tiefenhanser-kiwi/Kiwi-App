// WEB-1 Part D (BUG-385) — one Save = one meal, one plan add.
//
// THE MECHANISM (measured October 9): Plan Review → Add Meal → "Ask Kiwi for a
// meal" → /meal-builder?addToPlanId=… → Save fires POST /me/meals, then POST
// /plans/:id/items, then confirms with an alert whose OK is the ONLY path back
// to the plan. On the web that alert was a no-op (react-native-web's Alert is a
// stub — Part A), so the user stayed on the builder with no sign the save had
// happened. The builder's save guard (savingRef) only covers the request in
// flight, so a second Save ran the whole CREATE branch again: a SECOND
// POST /me/meals (a new meal id) and a SECOND plan add. Two library meals, two
// plan rows. Nothing server-side duplicated — every request did exactly what
// it was asked.
//
// The latch lives for the builder screen's lifetime (a ref):
//   • the meal is created at most once — a retry after a failed plan step
//     reuses the id instead of creating a second meal;
//   • once the whole create flow has succeeded, `done` blocks any further
//     Save (and the screen disables the button).
//
// WEB-2 Part D (BUG-387) — the reuse dropped edits. Save → the meal is created
// → the plan add fails → the user edits the form → Save: the latch handed back
// the FIRST meal's id and the plan got that meal, as first saved; the edits
// went nowhere. Now the latch remembers the form it saved (`key`, the payload
// serialised) and, when a retry carries a different one, PATCHes the saved
// meal with it (`update`) before handing the id back. Still one meal.

export interface CreateOnceSync {
  /** The form this save carries, serialised. Equal keys → nothing to write. */
  key: string;
  /** Bring the already-created meal up to this form (the meal PATCH). */
  update: (mealId: string) => Promise<unknown>;
}

export interface CreateOnce {
  /** True once the create flow has fully succeeded; Save is then inert. */
  readonly done: boolean;
  /** The created meal's id, if the create step has already succeeded. */
  readonly mealId: string | null;
  /**
   * Create the meal, or return the id from an earlier successful create —
   * after PATCHing it when `sync.key` differs from the form it holds.
   */
  meal(create: () => Promise<{ id: string }>, sync?: CreateOnceSync): Promise<string>;
  /** Mark the whole flow (create + any plan / playlist step) as succeeded. */
  finish(): void;
}

export function createOnce(): CreateOnce {
  let mealId: string | null = null;
  // The form the saved meal holds. Moves only after a write lands, so a failed
  // PATCH is retried on the next Save.
  let savedKey: string | null = null;
  let done = false;
  return {
    get done() {
      return done;
    },
    get mealId() {
      return mealId;
    },
    async meal(create, sync) {
      if (mealId === null) {
        mealId = (await create()).id;
        savedKey = sync?.key ?? null;
      } else if (sync && sync.key !== savedKey) {
        await sync.update(mealId);
        savedKey = sync.key;
      }
      return mealId;
    },
    finish() {
      done = true;
    },
  };
}
