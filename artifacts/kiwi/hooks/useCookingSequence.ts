// React Query hook for POST /meals/:mealId/cooking-sequence — the multi-dish
// Cook Mode launch read (WS7-8b Build Block 2B).
//
// Query key follows the documented convention (lib/api/README.md):
// ["cooking", "sequence", mealId]. The result is deterministic over the meal's
// current step data, so staleTime is Infinity — a cook session never needs to
// refetch the ordering mid-flow.
//
// The caller passes `enabled` so the hook only fires for a genuine multi-dish
// meal (meal.steps.length === 0 && meal.dishes.length > 1, per PRD §7.13).
// Single-dish meals and dishId launches degrade to naive ordering and never
// touch this endpoint. The global QueryClient default `retry: false` keeps a
// failed launch from adding retry latency — the screen degrades to naive
// ordering on error (§13.5.5: the meal always cooks).

import { useQuery } from "@tanstack/react-query";

import { getCookingSequence, type CookingSequence } from "@/lib/api/cooking";

// THX-4 (D-WS9-324) — from a plan, the plan item rides the request (its turkey
// weight sets the roast) and the key, so one meal in two plans, or in a plan and
// the library, never shares an ordering. A weight Save marks
// ["cooking","sequence",mealId] stale (AppContext savePlanItemAmounts).
export function cookingSequenceQueryKey(mealId: string, planItemId?: string) {
  return planItemId ? ["cooking", "sequence", mealId, planItemId] : ["cooking", "sequence", mealId];
}

export function useCookingSequence(mealId: string, enabled: boolean, planItemId?: string) {
  return useQuery<CookingSequence>({
    queryKey: cookingSequenceQueryKey(mealId, planItemId),
    queryFn: () => getCookingSequence(mealId, planItemId),
    enabled: enabled && mealId.length > 0,
    staleTime: Infinity,
  });
}
