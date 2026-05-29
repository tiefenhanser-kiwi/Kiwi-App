// WS7-5b-mobile Block B — wizard-entry resume-interstitial decision helper.
//
// When the user opens the wizard, we fetch GET /wizard/drafts and feed the
// result through this helper to decide what the interstitial should look
// like (or whether it should appear at all). Split out from the screen so
// the eligibility + sort rules can be pinned by unit tests rather than a
// full screen-render harness — matches Block A's decidePlanDetailsCta
// pattern.
//
// Sort note: the server already returns drafts createdAt-desc (wizard.ts:
// findMany { orderBy: { createdAt: "desc" } }), so this helper TRUSTS that
// order. The "most recent" is just `drafts[0]`; we do not re-sort here.
// Re-sorting on the client would defeat that contract and quietly mask a
// server-side change.

import type { WizardDraftSummary } from "../api/wizard";

/**
 * Discriminated decision shape the wizard entry screen renders.
 *
 * - `none`   → no drafts; render the wizard inputs immediately (the
 *              common case for most users).
 * - `single` → exactly one resumable draft; show resume-or-new choice.
 * - `multi`  → two or more drafts; show the most-recent prominently with
 *              a "see all" affordance listing the others. `others` is in
 *              the server's createdAt-desc order with the primary removed,
 *              so the see-all list is consistent with the visual primary.
 */
export type WizardResumeUiDecision =
  | { kind: "none" }
  | { kind: "single"; draft: WizardDraftSummary }
  | {
      kind: "multi";
      primary: WizardDraftSummary;
      others: WizardDraftSummary[];
    };

/**
 * Decide what the wizard-entry interstitial should render given the
 * drafts list from GET /wizard/drafts. Pure function — no fetch, no
 * navigation, no React.
 *
 * The caller is the wizard.tsx screen, which gates between this decision
 * and the inputs form. When kind is "none", the screen renders inputs
 * exactly as today; "single" and "multi" both show the interstitial
 * before the inputs and force a choice (resume one OR get new results).
 *
 * The server returns drafts already sorted createdAt desc; we treat
 * `drafts[0]` as the most-recent without re-sorting. See sort note above.
 */
export function decideWizardResumeUi(
  drafts: WizardDraftSummary[],
): WizardResumeUiDecision {
  if (drafts.length === 0) {
    return { kind: "none" };
  }
  if (drafts.length === 1) {
    return { kind: "single", draft: drafts[0] };
  }
  return {
    kind: "multi",
    primary: drafts[0],
    others: drafts.slice(1),
  };
}
