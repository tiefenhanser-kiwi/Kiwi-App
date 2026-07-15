// BUG-023 (WS9 3c) — pure helpers for the persisted "dismissed resume-draft"
// set. Split out from wizard.tsx so the supersede rules are pinned by unit
// tests rather than a full screen-render harness — matches the
// decideWizardResumeUi / decidePlanDetailsCta pattern.
//
// The bug: the "pick up where you left off?" interstitial resurfaced drafts
// the user had already moved past, because dismissal ("Get new results") was
// session-local and reset on every wizard remount. The fix persists the
// dismissed draft ids per-device (Ruling 4 — AsyncStorage, not a server sweep;
// the literal server supersede rides with BUG-030). These helpers own the
// three set operations; the screen only wires storage + render.

import type { WizardDraftSummary } from "../api/wizard";

/**
 * The drafts that may still surface the interstitial: everything the user has
 * NOT dismissed. Server sort order is preserved (we only filter).
 */
export function visibleDrafts(
  drafts: WizardDraftSummary[],
  dismissedIds: string[],
): WizardDraftSummary[] {
  const dismissed = new Set(dismissedIds);
  return drafts.filter((d) => !dismissed.has(d.id));
}

/**
 * Add newly-dismissed ids to the persisted set, de-duplicated. Called when the
 * user taps "Get new results" — only the ids shown at that moment are
 * dismissed, so drafts created later can still resume.
 */
export function addDismissed(
  dismissedIds: string[],
  newlyDismissed: string[],
): string[] {
  return Array.from(new Set([...dismissedIds, ...newlyDismissed]));
}

/**
 * Drop dismissed ids the server no longer lists (swept past TTL, or activated).
 * Keeps the persisted set bounded and self-cleaning. Returns the SAME array
 * reference when nothing changed so callers can skip a needless write.
 */
export function pruneDismissed(
  dismissedIds: string[],
  existingDraftIds: string[],
): string[] {
  const existing = new Set(existingDraftIds);
  const pruned = dismissedIds.filter((id) => existing.has(id));
  return pruned.length === dismissedIds.length ? dismissedIds : pruned;
}
