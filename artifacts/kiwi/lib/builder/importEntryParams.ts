// WS9 3f-3 (D-WS9-005) — the SEND side of the import-entry contract, mirroring
// resolvePostSaveNav (the RECEIVE side in postSaveNav.ts). The shared import
// chooser (components/ImportSourceCards.tsx) is rendered in three completion
// contexts; this pure helper maps the context to the exact route params that
// must ride along to the import screens / meal-builder so the builder's CREATE
// branch resolves the correct outcome:
//
//   library → no params        → resolvePostSaveNav → meal-detail
//   append  → { addToPlanId }   → resolvePostSaveNav → plan-back  (addMealToPlan)
//   replace → { planId, planItemId } → resolvePostSaveNav → plan-replace
//                                       (changeMealForPlanItem — REPLACE the slot)
//
// Keeping this symmetric with the resolver is what makes the shared chooser
// safe: the chooser UI is shared, but the completion behavior is parameterized
// by which of these param sets is threaded — NOT by a shared completion handler
// (a shared handler would recreate D-WS9-005 in every context at once).

export type ImportEntryContext =
  | { kind: "library" }
  | { kind: "append"; planId: string }
  | { kind: "replace"; planId: string; planItemId: string };

export function importEntryParams(
  ctx: ImportEntryContext,
): Record<string, string> {
  switch (ctx.kind) {
    case "append":
      return { addToPlanId: ctx.planId };
    case "replace":
      return { planId: ctx.planId, planItemId: ctx.planItemId };
    case "library":
      return {};
  }
}
