// React Query hook for GET /home — the Home tab's composite read.
// WS7-3 Block C1: API + hook foundation. The Home screen migrates in a later
// C-block; this hook ships ahead of its consumer.
//
// Query key ["home", "payload"]; staleTime is the personal-mutable tier
// (60_000) — the global QueryClient default — so no per-query override.

import { useQuery } from "@tanstack/react-query";

import { getHomePayload, type HomePayload } from "@/lib/api/home";

export function useHomePayload() {
  return useQuery<HomePayload>({
    queryKey: ["home", "payload"],
    queryFn: getHomePayload,
  });
}
