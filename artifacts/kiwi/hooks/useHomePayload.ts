// React Query hook for GET /home — the Home tab's composite read.
// WS7-3 Block C1: API + hook foundation.
//
// Query key ["home", "payload"]; staleTime is the personal-mutable tier
// (60_000) — the global QueryClient default — so no per-query override.

import { useQuery } from "@tanstack/react-query";

import { getHomePayload, type HomePayload } from "@/lib/api/home";

// ── Sept 29 design review, item 14 — a client-side ceiling on GET /home ──────
//
// WHY THIS EXISTS. The apiClient layer imposes no timeout of its own and the
// global QueryClient sets `retry: false`, so a request that never settles leaves
// the query `pending` FOREVER. Home's lead slot is then held by the
// "Getting your week…" placeholder indefinitely — not an error state, not an
// empty state, just a screen that never resolves. An error state with a retry
// button cannot fix that on its own, because nothing ever reports an error.
//
// So a hang is CONVERTED INTO AN ERROR. That keeps item 14 to a single new state
// (error) instead of needing a separate "timed out" one, and the retry button
// then works for both causes.
//
// PATTERN: lifted from BUG-027 (app/grocery-list/[id].tsx's
// LOOKUP_CLIENT_TIMEOUT_MS + the AbortController wrap around
// lookupGroceryItemCandidates) — "convert an infinite spinner into a bounded
// abort". React Query aborts via the signal it hands the queryFn, and an abort
// surfaces as a rejection, so the query lands in `error` and nothing else has to
// know a timeout happened.
//
// ⚠️ THE VALUE IS 10s, NOT BUG-027's 4s, AND THIS IS A DELIBERATE DEVIATION.
// Hans's ruling said to reuse BUG-027's value; BUG-027's own comment is the
// reason not to. It reads: "4s is short enough to feel responsive for a
// typeahead (vs. the 90s used for a plan-activate)" — i.e. the repo's own
// precedent is that this number is justified PER SURFACE by the interaction, and
// 4s is justified by typeahead keystrokes. GET /home is a composite read on the
// critical path of a COLD START: a Cloud Run cold start plus mobile RTT lands in
// the 2–5s range on a perfectly healthy network, so a 4s ceiling would show
// "We couldn't reach Kiwi" to users whose connection is merely slow, and the
// retry would false-abort too. 10s is past any healthy cold start and still far
// short of a user concluding the app is broken. One line to overrule.
const HOME_CLIENT_TIMEOUT_MS = 10_000;

// WEB-1 Part F (BUG-383) — `staleTime` for a READER that is not Home. Plan
// Review passes Infinity: it fetches only when the payload is absent (a cold web
// entry or refresh on /plan/[id], where Home never ran) and never refetches a
// warm cache. Home itself passes nothing and keeps the default tier.
export function useHomePayload(opts?: { staleTime?: number }) {
  return useQuery<HomePayload>({
    queryKey: ["home", "payload"],
    ...(opts?.staleTime !== undefined ? { staleTime: opts.staleTime } : {}),
    queryFn: async ({ signal }) => {
      // Chained to React Query's OWN signal, so a component unmount or a key
      // change still aborts — the timeout adds a ceiling, it does not replace
      // the cancellation that was already there.
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort);
      const timeoutId = setTimeout(() => controller.abort(), HOME_CLIENT_TIMEOUT_MS);
      try {
        return await getHomePayload({ signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", onAbort);
      }
    },
  });
}
