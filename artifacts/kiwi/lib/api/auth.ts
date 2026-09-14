// React Query hook for GET /auth/me — the first useQuery consumer in the
// mobile codebase. Establishes the convention documented in
// lib/api/README.md: ["<domain>", "<resource>", ...] query keys, with the
// auth tier pinned to `staleTime: Infinity` (token-bound, refetched only
// via explicit invalidation).
//
// The hook takes a token argument from AuthContext rather than calling
// readToken() itself: keeping the source-of-truth in React state means
// the query's `enabled` flag automatically re-evaluates when login /
// logout / cascade flip the token. The query key intentionally does NOT
// include the token — `queryClient.removeQueries({ queryKey: ["auth"] })`
// from logout / the 401 cascade flushes cached `me` data instead.

import { useQuery } from "@tanstack/react-query";

import { fetchMeWithDeadline } from "@/lib/auth";
import { BOOTSTRAP_DEADLINE_MS } from "@/lib/sessionBootstrap";
import type { User } from "@/lib/types";

export function useAuthMe(
  token: string | null,
  opts: { deadlineMs?: number } = {},
) {
  const deadlineMs = opts.deadlineMs ?? BOOTSTRAP_DEADLINE_MS;
  return useQuery<User | null>({
    queryKey: ["auth", "me"],
    // D-WS9-241 B (BUG-258) — every /auth/me run through this hook (the cold
    // start AND the failure screen's "Try again") is under the deadline.
    queryFn: () => fetchMeWithDeadline(deadlineMs),
    enabled: !!token,
    staleTime: Infinity,
    // Also what makes BOOTSTRAP_DEADLINE_MS true end-to-end — with react-
    // query's default policy (3 retries, exponential backoff) a 10s abort per
    // attempt surfaces in 40s+. Pinned here since WS7-1; do not remove.
    retry: false,
  });
}
