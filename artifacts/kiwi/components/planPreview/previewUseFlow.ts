// PREVIEW-1 B — the preview's "use" flow, ONE copy for both callers (Home's
// Featured rail, app/(tabs)/index.tsx, and the Plans tab, app/(tabs)/plans.tsx).
// It lives here rather than inline in the two screens because app/ is outside
// the test glob — inline, the rule below could not be pinned.
//
// THE RULE: once the create succeeds, the plan EXISTS and must never be
// created again. The flow is create → (activate) → open, and only the create
// may throw back to the sheet:
//   • create fails   → throw. The sheet keeps itself open with its inline
//                      error and retry (BUG-396); nothing was made, so a
//                      retry is safe.
//   • activate fails → do NOT throw. The sheet closes, the new plan opens,
//                      and a toast says this-week did not stick. The user
//                      lands on Plan Review, whose "This week" pill is the
//                      retry — against the SAME plan. Before this, the throw
//                      reached the sheet, which offered a retry that re-ran
//                      the create: a second copy of the plan per tap.

/** Plan Review's own failure copy for the same action (handleCookThisWeek,
 *  app/plan/[id].tsx). Copied, not imported: that screen exports nothing. */
export const ACTIVATE_FAILED_NOTICE = "Couldn't set this week's plan. Please try again.";

export interface UseFromPreviewDeps {
  /** AppContext.useTemplateAsPlan — creates the undated instance. */
  createFromTemplate: (templateId: string) => Promise<{ instanceId: string }>;
  /** AppContext.setPlanActiveThisWeek. */
  activateThisWeek: (instanceId: string) => Promise<unknown>;
  /** Open the new plan (router.push to /plan/[id]). */
  openPlan: (instanceId: string) => void;
  /** Show a toast. */
  notify: (message: string) => void;
}

export async function runUseFromPreview(
  deps: UseFromPreviewDeps,
  templateId: string,
  opts: { activate: boolean },
): Promise<void> {
  // A throw here propagates on purpose: nothing exists yet, the sheet retries.
  const { instanceId } = await deps.createFromTemplate(templateId);

  let activateFailed = false;
  if (opts.activate) {
    try {
      await deps.activateThisWeek(instanceId);
    } catch (err) {
      console.warn("[plan-preview] activate failed after create", { templateId, instanceId, err });
      activateFailed = true;
    }
  }

  deps.openPlan(instanceId);
  // After the push: the toast host wraps the whole navigator (app/_layout.tsx),
  // so the notice shows over Plan Review, where the retry lives.
  if (activateFailed) deps.notify(ACTIVATE_FAILED_NOTICE);
}
