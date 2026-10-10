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

export interface CreateOnce {
  /** True once the create flow has fully succeeded; Save is then inert. */
  readonly done: boolean;
  /** The created meal's id, if the create step has already succeeded. */
  readonly mealId: string | null;
  /** Create the meal, or return the id from an earlier successful create. */
  meal(create: () => Promise<{ id: string }>): Promise<string>;
  /** Mark the whole flow (create + any plan / playlist step) as succeeded. */
  finish(): void;
}

export function createOnce(): CreateOnce {
  let mealId: string | null = null;
  let done = false;
  return {
    get done() {
      return done;
    },
    get mealId() {
      return mealId;
    },
    async meal(create) {
      if (mealId === null) mealId = (await create()).id;
      return mealId;
    },
    finish() {
      done = true;
    },
  };
}
