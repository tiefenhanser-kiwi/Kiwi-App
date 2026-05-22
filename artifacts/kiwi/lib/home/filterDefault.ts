// WS7-3 Block C2 Commit 2 — pure default-filter resolution for the Home
// Plan Discovery card. Extracted so it unit-tests under the bare node:test
// harness (no JSX runner — see C2 Phase 1 §10).

import type { PlanFilterKey } from "@/lib/api/plans";

/**
 * Home Plan Discovery default filter (PRD §4.2.5 / Phase 2 Ruling A — R1):
 * Featured for every user. A non-empty persisted `lastPlanDiscoveryFilters`
 * wins; its first key is taken — the card is single-select (ruling 4H-2,
 * tracked for revisit as D-WS7-049).
 */
export function homeFilterDefault(
  savedFilters: readonly PlanFilterKey[],
): PlanFilterKey[] {
  if (savedFilters.length > 0) return [savedFilters[0]];
  return ["featured"];
}
