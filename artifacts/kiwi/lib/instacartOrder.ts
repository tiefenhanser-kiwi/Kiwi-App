// Row 8 Block 2 — what the grocery detail screen SENDS to
// POST /grocery-lists/:id/instacart-link, and what it SAYS when that fails.
//
// Lives in lib/ (not in app/grocery-list/[id].tsx) because app/** is outside
// the test glob (D-WS9-164): the selection rule, the pack numbers and the copy
// map are the three things this block must pin, and an inline version would be
// permanently unguardable.
//
// Precedent for the copy map: lib/authErrorCopy.ts (BUG-296) — key on an
// ApiError's status/body, hand the screen a string in Kiwi's voice, never a
// raw server string or a status code.

import { ApiError } from "@/lib/api/errors";
import { renderedPack } from "@/lib/format/grocery";
import type { GroceryListItem } from "@/lib/types";

// ── R1 — the selection ───────────────────────────────────────────────────
//
// Ruled: send the UNCHECKED rows; a universal staple only when it is opted in
// ("buying this week", §12.7); never a soft-deleted row. On the measured
// 60-row list this is exactly 54 — the six left out are universal staples
// with stapleOptedIn false.
//
// Soft-deleted rows never reach `list.items`: the server's list GET filters
// `deletedAt: null` (routes/groceryLists.ts) and the screen's remove drops the
// row from local state (the undo banner holds it aside, outside the list). So
// "never a soft-deleted row" is a property of the input, and this filter is
// checked-state and staple opt-in only.

export function selectInstacartRows(items: GroceryListItem[]): GroceryListItem[] {
  return items.filter(
    (it) => !it.isCompleted && (!it.isUniversalStaple || it.stapleOptedIn === true),
  );
}

// ── The wire items ───────────────────────────────────────────────────────

/** One item of the POST body (lib/ai/schemas/grocery.ts InstacartLinkInputSchema). */
export interface InstacartLinkItem {
  groceryListItemId: string;
  /** NUMBER OF PACKS, never the displayed total. Absent = let the server decide. */
  packCount?: number;
  packUnit?: string;
  packSizeText?: string;
}

// The server's schema bounds, mirrored: a value outside them fails the WHOLE
// request with 400 invalid_body, so an out-of-range field is dropped (the
// server falls back to its own precedence for that row) rather than sent.
const MAX_PACK_COUNT = 99;
const MAX_PACK_UNIT_LEN = 32;
const MAX_PACK_SIZE_LEN = 64;

/**
 * Per-row pack data from the SAME compose the row renders (renderedPack →
 * packsToCoverNeed). `packCount` is omitted whenever the phone has no derived
 * pack — a staple, a quantity override, no stored pack, an unrelatable unit —
 * never defaulted to 1; the server's own fallback is better informed.
 *
 * `packUnit` is the row's pack unit as the SERVER sees it
 * (purchaseUnitOverride ?? purchaseUnit): the server multiplies packCount by
 * the per-pack size only when the unit it is handed names the row's own pack
 * unit, so this must be the same token or the count would be taken at face
 * value and under-order.
 */
export function instacartItemForRow(item: GroceryListItem): InstacartLinkItem {
  const wire: InstacartLinkItem = { groceryListItemId: item.id };
  const pack = renderedPack(
    item.purchaseDisplay,
    item.quantityAmount,
    item.quantityUnit,
    item.purchaseUnit,
    item.isUniversalStaple,
    { quantity: item.purchaseQuantityOverride, display: item.purchaseDisplayOverride },
  );
  if (!pack || pack.packCount > MAX_PACK_COUNT) return wire;
  wire.packCount = pack.packCount;
  const unit = (item.purchaseUnitOverride ?? item.purchaseUnit ?? "").trim();
  if (unit.length > 0 && unit.length <= MAX_PACK_UNIT_LEN) wire.packUnit = unit;
  if (pack.packSizeText && pack.packSizeText.length <= MAX_PACK_SIZE_LEN) {
    wire.packSizeText = pack.packSizeText;
  }
  return wire;
}

/** The whole body's `items`: R1 selection, then per-row pack data. */
export function instacartItemsForList(items: GroceryListItem[]): InstacartLinkItem[] {
  return selectInstacartRows(items).map(instacartItemForRow);
}

// ── The count line (Row 8 Block 3 Part D) ────────────────────────────────
//
// Hans, September 21: "Kiwi should be sending everything, and if it won't
// send everything it should tell the user it didn't" — and, shown a bare
// count, "are we able to list what isn't sent? that's better than the user
// thinking 'which 6?'". Ruled: say the count, and let the staples fragment
// expand into the actual rows with an Add.
//
// Computed from the SAME selection the button sends (selectInstacartRows),
// never re-derived: the number on screen is the number on the wire. The
// held-back set is R1's complement among the unchecked rows — universal
// staples not opted in — so a checked-off staple is neither sent nor "not
// included"; it is simply done.

/** The unchecked universal staples R1 leaves home (BUG-171's rule at the button). */
export function heldBackStaples(items: GroceryListItem[]): GroceryListItem[] {
  return items.filter(
    (it) => !it.isCompleted && it.isUniversalStaple && it.stapleOptedIn !== true,
  );
}

/** The name the list already shows for a row. Name ONLY — a staple has no
 *  pack line (BUG-171), and this never composes one. */
export function stapleDisplayName(item: GroceryListItem): string {
  return item.userResolvedTo ?? item.name;
}

export interface InstacartCountSummary {
  /** Rows the tap would send — `selectInstacartRows(items).length`. */
  sendCount: number;
  /** The staples the tap leaves home, in list order. */
  heldBack: GroceryListItem[];
  /** "Sends 54 items" / "Sends 1 item". Plain text. */
  sendsText: string;
  /** "6 pantry staples not included" / "1 pantry staple not included"; null at 0. */
  staplesText: string | null;
  /** The whole line as read aloud: sendsText, then " · " + staplesText when present. */
  line: string;
}

export function instacartCountSummary(items: GroceryListItem[]): InstacartCountSummary {
  const sendCount = selectInstacartRows(items).length;
  const heldBack = heldBackStaples(items);
  const sendsText = `Sends ${sendCount} ${sendCount === 1 ? "item" : "items"}`;
  const staplesText =
    heldBack.length > 0
      ? `${heldBack.length} pantry ${heldBack.length === 1 ? "staple" : "staples"} not included`
      : null;
  return {
    sendCount,
    heldBack,
    sendsText,
    staplesText,
    line: staplesText ? `${sendsText} · ${staplesText}` : sendsText,
  };
}

// ── Copy ─────────────────────────────────────────────────────────────────
//
// COPY COMPLIANCE (Instacart): never "free delivery", never "partner" /
// "partnership", never position Instacart as a store or a delivery service,
// no delivery-speed claims. The expectation line is set by the measured page
// (September 19 device pass): matching is asynchronous AND unstable across
// loads (11 → 48 → 34 items on one URL), and quantity is advisory.

/** Under the CTA, always. */
export const INSTACART_EXPECTATION_COPY =
  "Opens Instacart. Matching can take a moment — check the list before you order.";

/**
 * The line for a 403 retailer_disabled / 503 retailer_not_configured.
 *
 * Hans, September 22 — this used to be INSTACART_COMING_SOON_COPY, "Online
 * grocery ordering is coming soon.", and it did two jobs: the flag-off render
 * AND this error. The flag-off render is GONE (InstacartOrderPanel returns
 * null; nothing Instacart-shaped exists when the flag is off), so the only job
 * left is the error — which is now reachable ONLY as a race: the client gates
 * the CTA on a cached flag, and the row could flip off between the cache and
 * the tap. "Coming soon" is the wrong thing to tell someone who just tapped a
 * button that was there a second ago, and the first binary ships no
 * coming-soon copy at all.
 */
export const INSTACART_UNAVAILABLE_COPY =
  "Online grocery ordering isn't available right now.";

export const INSTACART_UNREACHABLE_COPY =
  "Couldn't reach Instacart just now. Try again in a moment.";
export const INSTACART_RATE_LIMIT_COPY = "Give it a few seconds and try again.";
export const INSTACART_NO_ITEMS_COPY = "Check off what you still need first.";
/** The device refused the URL (no browser) — Linking.openURL rejected. */
export const INSTACART_NO_BROWSER_COPY = "Couldn't open a browser on this device.";
/** The app's standing generic failure line (18 call sites). */
export const INSTACART_GENERIC_COPY = "Something went wrong. Please try again.";

/**
 * The line the screen renders for a failed link call, by status and body.
 *   403 retailer_disabled / 503 retailer_not_configured → not available
 *   502 retailer_error / 504 retailer_timeout → Instacart unreachable
 *   429 → rate limited
 *   400 no_items → nothing to send
 *   anything else (incl. a network failure, a 404) → generic
 */
export function instacartErrorCopy(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 403:
      case 503:
        return INSTACART_UNAVAILABLE_COPY;
      case 502:
      case 504:
        return INSTACART_UNREACHABLE_COPY;
      case 429:
        return INSTACART_RATE_LIMIT_COPY;
      case 400:
        return bodyErrorCode(err.body) === "no_items"
          ? INSTACART_NO_ITEMS_COPY
          : INSTACART_GENERIC_COPY;
      default:
        return INSTACART_GENERIC_COPY;
    }
  }
  return INSTACART_GENERIC_COPY;
}

function bodyErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const e = (body as { error?: unknown }).error;
  return typeof e === "string" ? e : undefined;
}
