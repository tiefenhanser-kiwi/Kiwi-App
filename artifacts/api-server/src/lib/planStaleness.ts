// WS9 3d Part 3b-1 (D-WS9-013) — the dietary-staleness DECISION, server-side.
// The invariant on this project is that the server owns all math, attribution,
// and structure and the client only renders; "is this plan dietarily stale?" is
// derived judgment (two-timestamp comparison), so it is computed here and shipped
// as a single boolean on the plan payload, NOT reconstructed on the client.
//
// Rules (D-WS9-013, backfill posture already ruled):
//   - stale iff the user's last allergy/dietary edit (dietaryUpdatedAt) is
//     non-null AND the plan's commit instant (committedAt) is non-null AND the
//     edit post-dates the commit;
//   - null committedAt ⇒ false (pre-migration rows: a silent miss beats a false
//     allergy warning);
//   - a wizard draft is never stale — the note is hidden on drafts, and the
//     server (not the client) makes that call.

export function computeDietaryStale(args: {
  isWizardDraft: boolean;
  committedAt: Date | null;
  dietaryUpdatedAt: Date | null;
}): boolean {
  const { isWizardDraft, committedAt, dietaryUpdatedAt } = args;
  if (isWizardDraft) return false;
  // Loose == null so a legitimately-absent (undefined) timestamp is treated the
  // same as an explicit null — never reach .getTime() on a missing value.
  if (committedAt == null || dietaryUpdatedAt == null) return false;
  return dietaryUpdatedAt.getTime() > committedAt.getTime();
}
