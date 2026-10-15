// BOOK-1C1 (D-WS9-312) — the Cookbook's "Not finding what you want?" helper.
//
// It opens the EXISTING Ask Kiwi meal maker (app/ask-kiwi.tsx, Mode A) with the
// search text prefilled. Asking Kiwi is an AI call, so on a lapsed account the
// helper opens the subscribe sheet instead of a screen whose submit would only
// end in a 402.
//
// ⚠️ THE SERVER STAYS THE AUTHORITY (lib/billing/subscriptionView.ts: "this
// client must never gate anything on its own copy"). This is a shortcut past a
// screen that cannot work, not the gate: it asks sheetStateFor — the same
// status read the banner uses, blacked out while `enforced` is false — and a
// stale answer either way still ends at the server's 402, which opens the same
// sheet from lib/api/client.ts. With enforcement off it never fires.

import { sheetStateFor, type SubscriptionPayload } from "@/lib/billing/subscriptionView";

export type AskKiwiAction = { kind: "paywall" } | { kind: "open"; prompt: string | null };

export function askKiwiAction(sub: SubscriptionPayload | null, text: string): AskKiwiAction {
  if (sheetStateFor(sub) === "lapsed") return { kind: "paywall" };
  const prompt = text.trim();
  return { kind: "open", prompt: prompt.length > 0 ? prompt : null };
}
