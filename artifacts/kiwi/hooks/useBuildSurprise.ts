import { useMutation } from "@tanstack/react-query";

import { buildSurprise, type BuildFromTextResult } from "@/lib/api/tellKiwi";
import type { ExclusionRequest } from "@/lib/wizard/sessionExclusion";

// WS9 3c §7.6 — Surprise-me generation. No prefs input (the server reads stored
// prefs); the mutate variable is the session re-roll exclusion (BUG-053, Part
// B) — plan + meal titles shown so far this session, so a re-roll returns
// something new. The result shares BuildFromTextResult's shape so wizard-results
// renders it via the Tell Kiwi branch.
export function useBuildSurprise() {
  return useMutation<BuildFromTextResult, Error, ExclusionRequest>({
    mutationFn: (exclude) => buildSurprise(exclude),
  });
}
