// CLIENT-5 D (BUG-570) — "Send my list" (Hans, Oct 27).
//
// One partner has the list in Kiwi and texts or emails it to the other, who is
// driving past a store. So the text is plain and needs no account on the other
// end:
//
//   Kiwi grocery list · <plan name>
//
//   Produce
//   2 lemons (¼ cup)
//   …
//
//   Made with Kiwi · kitchenwizard.ai
//
// Aisles in the screen's order (GROCERY_SECTIONS), each with its UNCHECKED rows
// in the screen's order, each row worded as GroceryRow words it: the pack line
// (composePackName), then "(need)", or the recurring line's "— …" in its place.
// Left out: checked rows, and a default pantry staple (one not opted in), which
// the screen draws dimmed with a "+" as something you likely have — it is not
// in the screen's checked/total count either. An aisle with nothing left is
// left out; a list with nothing left says so.
//
// Copy standard: the list is "complete and sorted by aisle" (the retired
// single-list phrasing is not used; groceryShare.test.ts checks).

import { GROCERY_SECTIONS } from "@/lib/domain";
import { composePackName, formatNeedText } from "@/lib/format/grocery";
import { recurringDetail } from "@/lib/format/recurringLine";
import type { GroceryList, GroceryListItem } from "@/lib/types";

export const GROCERY_SHARE_FOOTER = "Made with Kiwi · kitchenwizard.ai";
export const GROCERY_SHARE_EMPTY = "Nothing left to buy: everything on this list is checked off.";

export function groceryShareTitle(planName: string): string {
  const name = planName.trim();
  return name ? `Kiwi grocery list · ${name}` : "Kiwi grocery list";
}

/** One row as the screen shows it (app/grocery-list/[id].tsx GroceryRow). */
export function groceryShareLine(item: GroceryListItem): string {
  const packName = composePackName(
    item.userResolvedTo ?? item.name,
    item.purchaseUnit,
    item.purchaseDisplay,
    item.quantityAmount,
    item.quantityUnit,
    item.isUniversalStaple,
    { quantity: item.purchaseQuantityOverride, display: item.purchaseDisplayOverride },
  );
  const need = formatNeedText(item.quantityAmount, item.quantityUnit, item.quantity);
  const recurring = recurringDetail(item.recurringFacets);
  if (recurring) return `${packName} — ${recurring.detail}`;
  return need ? `${packName} (${need})` : packName;
}

/** Still to buy: unchecked, and not a default (un-opted) pantry staple. */
export function groceryShareIncludes(item: GroceryListItem): boolean {
  if (item.isCompleted) return false;
  return !(item.isUniversalStaple && !(item.stapleOptedIn ?? false));
}

export function groceryShareText(list: Pick<GroceryList, "planName" | "items">): string {
  const blocks: string[] = [groceryShareTitle(list.planName)];
  for (const section of GROCERY_SECTIONS) {
    const lines = list.items
      .filter((i) => i.sectionKey === section.key && groceryShareIncludes(i))
      .map(groceryShareLine);
    if (lines.length > 0) blocks.push([section.label, ...lines].join("\n"));
  }
  if (blocks.length === 1) blocks.push(GROCERY_SHARE_EMPTY);
  blocks.push(GROCERY_SHARE_FOOTER);
  return blocks.join("\n\n");
}

/** A mailto URL's body is kept under this many ENCODED characters: mail clients
 *  and browsers drop or truncate long mailto links (around 2,000 is the safe
 *  floor across them). */
export const MAILTO_BODY_MAX = 1800;
export const MAILTO_CUT_LINE = "…the rest is on the list in Kiwi (Copy list sends all of it).";

/**
 * "Email it": mailto: with the text as the body, URL-encoded. A body too long for
 * a mailto link is cut at a whole line (never inside an item or an escape), ends
 * with MAILTO_CUT_LINE, and keeps the footer.
 */
export function groceryMailtoHref(text: string, subject: string): string {
  const enc = (s: string) => encodeURIComponent(s.replace(/\n/g, "\r\n"));
  const head = `mailto:?subject=${encodeURIComponent(subject)}&body=`;
  if (enc(text).length <= MAILTO_BODY_MAX) return head + enc(text);
  const lines = text.split("\n");
  const footer = lines[lines.length - 1];
  const kept: string[] = [];
  for (const line of lines.slice(0, -1)) {
    const next = [...kept, line, "", MAILTO_CUT_LINE, "", footer].join("\n");
    if (enc(next).length > MAILTO_BODY_MAX) break;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return head + enc([...kept, "", MAILTO_CUT_LINE, "", footer].join("\n"));
}

export type GroceryShareOutcome = "shared" | "dismissed" | "sheet";

export interface GroceryShareDeps {
  os: string;
  /** React Native's built-in Share.share. */
  nativeShare: (content: { message: string; title?: string }) => Promise<unknown>;
  /** The browser's navigator.share, when it has one. */
  webShare?: (data: { title?: string; text: string }) => Promise<void>;
}

/**
 * Native: Share.share({ message }), whatever the phone offers (Messages, email,
 * WhatsApp). Web: navigator.share when present; a dismissed share is just
 * dismissed, any other failure (no user gesture, a blocked share) falls back to
 * the sheet. No navigator.share: the sheet ("Copy list", "Email it").
 */
export async function sendGroceryList(
  text: string,
  title: string,
  deps: GroceryShareDeps,
): Promise<GroceryShareOutcome> {
  if (deps.os !== "web") {
    await deps.nativeShare({ message: text, title });
    return "shared";
  }
  if (!deps.webShare) return "sheet";
  try {
    await deps.webShare({ title, text });
    return "shared";
  } catch (e) {
    return (e as { name?: unknown } | null)?.name === "AbortError" ? "dismissed" : "sheet";
  }
}
