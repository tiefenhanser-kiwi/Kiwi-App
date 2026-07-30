import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useApp } from "@/contexts/AppContext";
import { useToast } from "@/contexts/ToastProvider";
import type { PlanListResponse } from "@/lib/api/plans";

// WS9 3d Part 3b-2/3a (D-WS9-001) — shared "compost with undo" for BOTH entry
// points (the Plans-tab ⋯ and the Plan Review action area). The optimistic
// removal lives in the React Query cache (not per-screen local state) so the
// plan disappears from the list the moment it is composted, from whichever
// screen — and stays gone across the Plan Review → plans-list navigation. The
// destructive DELETE is DEFERRED to the app-level toast's onDismiss (commit);
// Undo restores the cached row and never touches the server (there is no
// un-compost route). A second compost commits the first via the toast host.

export function useCompostWithUndo() {
  const queryClient = useQueryClient();
  const { compostPlan } = useApp();
  const { showToast } = useToast();

  const restore = useCallback(() => {
    // Undo / failure — re-read the server truth (the plan was never deleted).
    queryClient.invalidateQueries({ queryKey: ["plans"] });
  }, [queryClient]);

  return useCallback(
    (planId: string, planName: string) => {
      // Optimistically drop the row from every plans-list cache (and clear the
      // This-Week callout if it was the active plan).
      queryClient.setQueriesData<PlanListResponse>(
        { queryKey: ["plans"] },
        (old) =>
          old
            ? {
                ...old,
                plans: old.plans.filter((p) => p.id !== planId),
                activeThisWeek:
                  old.activeThisWeek?.id === planId ? null : old.activeThisWeek,
              }
            : old,
      );
      showToast({
        message: `“${planName}” composted.`,
        actionLabel: "Undo",
        onAction: restore,
        onDismiss: () => {
          void compostPlan(planId).catch(() => {
            restore();
            showToast({ message: "Couldn't compost that plan. Please try again." });
          });
        },
      });
    },
    [queryClient, compostPlan, showToast, restore],
  );
}
