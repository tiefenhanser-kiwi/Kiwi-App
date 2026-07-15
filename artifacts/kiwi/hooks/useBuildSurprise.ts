import { useMutation } from "@tanstack/react-query";

import { buildSurprise, type BuildFromTextResult } from "@/lib/api/tellKiwi";

// WS9 3c §7.6 — Surprise-me generation. No input: the server reads stored
// prefs and generates crowd-pleaser candidates within hard constraints. The
// result shares BuildFromTextResult's shape so wizard-results renders it via
// the Tell Kiwi branch.
export function useBuildSurprise() {
  return useMutation<BuildFromTextResult, Error, void>({
    mutationFn: () => buildSurprise(),
  });
}
