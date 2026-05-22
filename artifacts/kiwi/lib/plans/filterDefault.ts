// WS7-3 Block C2 Commit 3 — pure default-filter resolution for the Plans
// tab. Extracted so it unit-tests under the bare node:test harness (no JSX
// runner — see C2 Phase 1 §10).

import type { PlanFilterKey } from "@/lib/api/plans";

/**
 * Plans tab default filter (PRD §9.2.2 / Phase 2 Ruling A — R1): a
 * persisted `lastPlansFilters` wins (first key — single-select per ruling
 * 4H-2, tracked as D-WS7-049); otherwise Featured for a user with no saved
 * plans, My Plans for a user with at least one.
 */
export function plansFilterDefault(
  savedFilters: readonly PlanFilterKey[],
  savedPlanCount: number,
): PlanFilterKey[] {
  if (savedFilters.length > 0) return [savedFilters[0]];
  return savedPlanCount > 0 ? ["my_plans"] : ["featured"];
}
