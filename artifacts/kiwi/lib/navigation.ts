// WEB-1 Part B (BUG-382) — a back button with nowhere to go.
//
// On the web a screen can be the FIRST entry in the history: a cold load from
// the marketing site, a shared link, a refresh. router.back() there has no
// screen to return to, so the back button did nothing. goBack falls back to a
// replace() onto a real screen instead — replace, not push, so the dead entry
// is not left behind it.
//
// The router is passed in (each screen already holds one from useRouter())
// rather than read from expo-router's global, which keeps this testable
// against the router stub.

import type { Href } from "expo-router";

export interface BackRouter {
  canGoBack: () => boolean;
  back: () => void;
  replace: (href: Href) => void;
}

export function goBack(router: BackRouter, fallback: Href = "/"): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
