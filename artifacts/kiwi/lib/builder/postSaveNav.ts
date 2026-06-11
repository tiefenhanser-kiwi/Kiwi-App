// WS7-6 G2 scope (i) — shared post-save navigation contract for the Meal
// Builder CREATE path. All six Add-Meal-originated saves (manual Mode B,
// combine Mode C, Mode A draft, and the text/image/URL imports) funnel through
// one save handler; this pure helper decides where a successful save lands so
// the destination is single-sourced and unit-testable without rendering the
// screen.
//
// Contract (PRD §10.6 — Meal Detail is where a tap from any list lands):
//   - Plan-context save (addToPlanId present): the meal was being added to a
//     specific plan, so keep the contextual return to that plan ("plan-back").
//   - Add-Meal-originated save (no plan context): land on the NEW meal's Meal
//     Detail page.

export type PostSaveNav =
  | { kind: "plan-back" }
  | { kind: "meal-detail"; mealId: string };

export function resolvePostSaveNav(args: {
  newMealId: string;
  addToPlanId?: string;
}): PostSaveNav {
  return args.addToPlanId
    ? { kind: "plan-back" }
    : { kind: "meal-detail", mealId: args.newMealId };
}
