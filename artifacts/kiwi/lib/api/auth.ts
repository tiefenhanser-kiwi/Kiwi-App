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

import { fetchMe } from "@/lib/auth";
import type { User } from "@/lib/types";

export function useAuthMe(token: string | null) {
  return useQuery<User | null>({
    queryKey: ["auth", "me"],
    queryFn: fetchMe,
    enabled: !!token,
    staleTime: Infinity,
    retry: false,
  });
}
