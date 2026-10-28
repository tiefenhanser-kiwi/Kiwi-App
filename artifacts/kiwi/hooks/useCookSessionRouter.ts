// CLIENT-5 B (BUG-564) — /cook-session's router: back() falls back, with no
// history, to the screen that launched the session (lib/navigation.ts
// cookSessionExitHref). Memoised on the fallback so the route's effects that
// list `router` as a dependency see one router per launch.

import { useMemo } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";

import { cookSessionExitHref, withBackFallback, type CookSessionParams } from "@/lib/navigation";

export function useCookSessionRouter(): ReturnType<typeof useRouter> {
  const router = useRouter();
  const fallback = cookSessionExitHref(useLocalSearchParams<CookSessionParams & Record<string, string>>());
  const key = JSON.stringify(fallback);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the fallback's identity
  return useMemo(() => withBackFallback(router, fallback), [router, key]);
}
