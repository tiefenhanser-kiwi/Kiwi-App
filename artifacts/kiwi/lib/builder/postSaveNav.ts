// WS7-6 G2 scope (i) — shared post-save navigation contract for the Meal
// Builder CREATE path. All six Add-Meal-originated saves (manual Mode B,
// combine Mode C, Mode A draft, and the text/image/URL imports) funnel through
// one save handler; this pure helper decides where a successful save lands so
// the destination is single-sourced and unit-testable without rendering the
// screen.
//
// Contract (PRD §10.6 — Meal Detail is where a tap from any list lands):
//   - Plan-context save (addToPlanId present): the meal was being added to a
//     specific plan, so return to that plan ("plan-back"). The planId rides
//     along so the caller can `dismissTo` the plan directly — WS7-6 G3 Scope D:
//     import + Ask-Kiwi flows stack an extra input screen between the plan and
//     the builder, so a one-step `router.back()` stranded the user on that
//     input screen instead of the plan. dismissTo(plan) lands on the plan
//     regardless of intermediate stack depth.
//   - Add-Meal-originated save (no plan context): land on the NEW meal's Meal
//     Detail page.

export type PostSaveNav =
  | { kind: "plan-back"; planId: string }
  | { kind: "meal-detail"; mealId: string };

export function resolvePostSaveNav(args: {
  newMealId: string;
  addToPlanId?: string;
}): PostSaveNav {
  return args.addToPlanId
    ? { kind: "plan-back", planId: args.addToPlanId }
    : { kind: "meal-detail", mealId: args.newMealId };
}
