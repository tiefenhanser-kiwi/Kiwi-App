// WS9 Block 3c (D-WS9-032) — params that open the SHARED Plan Review screen as
// an unsaved wizard draft (Option A). The results card / Surprise-me expand a
// candidate, then push /plan/[id] with these params:
//   - id       — a placeholder path segment ("/plan/[id]" needs one). Plan
//                 Review branches to draft mode on `draftId`, so it never
//                 fetches this id (usePlan("") is disabled in draft mode).
//   - draftId  — the hidden draft's id; Save for Later / Use This Week act on it.
//   - expanded — the WizardExpandedPlan JSON the draft adapter renders.
//
// The card uses router.push (not replace) so the results screen stays in the
// stack and Back from Plan Review returns to the 3 candidates (point 5). Pinned
// as a pure helper so the contract (placeholder id + draftId + JSON payload) is
// testable without rendering the screen.

import type { WizardExpandResponse } from "../api/wizard";

/** Placeholder path segment for the draft-mode Plan Review route. */
export const DRAFT_PLAN_ROUTE_ID = "draft";

export function buildOpenDraftParams(expand: WizardExpandResponse): {
  id: string;
  draftId: string;
  expanded: string;
} {
  return {
    id: DRAFT_PLAN_ROUTE_ID,
    draftId: expand.draft.id,
    expanded: JSON.stringify(expand.expanded),
  };
}
