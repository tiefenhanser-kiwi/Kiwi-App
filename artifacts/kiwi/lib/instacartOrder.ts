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
import { isHouseholdRow } from "@/lib/format/recurringLine";
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

// ── 🔴 WS9 D-WS9-284 — HOUSEHOLD ROWS DO NOT GO IN A FOOD ORDER ─────────────
//
// B3 gave a recurring item a real catalog identity, and three of them are not
// food: paper towels, toilet paper, pet treats. Measured on the B3 after-state:
// 33 such rows across the 20 census plans, every one `isUniversalStaple: false`
// and unchecked at generation — so every one of them was going into the
// Instacart payload, silently. R1's filter had a staple clause and nothing
// else, so there was no branch for them to fail.
//
// Ruled (2026-09-29): HELD BACK BY DEFAULT, and named. No new column and no
// per-row opt-in gesture in this block — the user adds paper towels in
// Instacart if they want them, and the count line tells them Kiwi left them
// out, which is the standing answer to Hans's "if it won't send everything it
// should tell the user it didn't". If a per-row opt-in is ever wanted it
// mirrors `stapleOptedIn`; not now.
//
// The held-back set is therefore two kinds, and `instacartCountSummary` names
// them in one fragment rather than two — the user does not need the taxonomy,
// they need the list.

export function selectInstacartRows(items: GroceryListItem[]): GroceryListItem[] {
  return items.filter(
    (it) =>
      !it.isCompleted &&
      (!it.isUniversalStaple || it.stapleOptedIn === true) &&
      !isHouseholdRow(it),
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
    // D-WS9-286 — the server's own count, when it computed one. Same call the
    // ROW renders with, so the number on screen and the number considered here
    // are one derivation.
    item.packCount,
  );
  if (!pack || pack.packCount > MAX_PACK_COUNT) return wire;
  // ── 🔴 D-WS9-286 — A SERVER COUNT IS NOT SENT, AND THE REASON IS ARITHMETIC ─
  //
  // `packCount` on THIS wire is not "how many packs": it is an input to the
  // server's rule 1, which computes `packCount × the row's per-pack size`
  // (instacartPayload.ts composeOrderSource), taking that size from
  // `purchaseQuantity`. That multiply is correct for a count the PHONE derived,
  // because the phone only derives one on a row whose `purchaseQuantity` really
  // is a per-pack size.
  //
  // It is wrong for a count the SERVER derived. On a scaled row
  // `resolvePurchaseFields` writes the pack COUNT into `purchaseQuantity` and
  // leaves the size inside the display string — so rule 1 multiplies a count by
  // a count. Measured on the 20-plan census corpus: 34 rows would newly send one,
  // and "5 can (14.5 oz) low-sodium chicken broth" against an 8-cup need would
  // order 5 × 5 = 25 cans. Garlic goes 3 heads → 9.
  //
  // ⚠️ THE B4 LANE ALREADY MEASURED THE OTHER HALF OF THIS AND REFUSED IT.
  // Ruling 6 asked rule 1 to use packCount directly; it cannot, because nothing
  // on the wire distinguishes the two shapes of `purchaseQuantity` — the
  // tempting `purchaseQuantity === packCount` test is true of 579 corpus rows of
  // which only 71 are scaled. So rule 1 kept its arithmetic, and the client must
  // not feed it a number of the other kind.
  //
  // Omitting is not a loss: `packCount` absent means "the phone has no derived
  // pack for this row", and the server's own precedence then reaches rule 3 —
  // which the B4 lane measured as already correct for BOTH shapes (a scaled
  // row's need and pack carry different unit tokens, so its `packs` collapses to
  // 1 and the total becomes the count the scaler wrote).
  //
  // The RENDER still uses the server's count. That is the whole point of the
  // field, and it is untouched: the shopper reads the right number, and the
  // order is composed from the row the server already owns.
  if (pack.fromServer) return wire;
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

/**
 * The unchecked rows R1 leaves home: universal staples not opted in (BUG-171's
 * rule at the button) and household rows (D-WS9-284).
 *
 * Computed as R1's COMPLEMENT among the unchecked rows rather than as its own
 * predicate list — one filter, one inverse, so a third held-back kind can never
 * be added to the send rule and forgotten here. A checked-off row is in
 * neither: it is not sent and it is not "not included", it is simply done.
 */
export function heldBackStaples(items: GroceryListItem[]): GroceryListItem[] {
  const sent = new Set(selectInstacartRows(items).map((it) => it.id));
  return items.filter((it) => !it.isCompleted && !sent.has(it.id));
}

/** The name the list already shows for a row. Name ONLY — a staple has no
 *  pack line (BUG-171), and this never composes one. */
export function stapleDisplayName(item: GroceryListItem): string {
  return item.userResolvedTo ?? item.name;
}

export interface InstacartCountSummary {
  /** Rows the tap would send — `selectInstacartRows(items).length`. */
  sendCount: number;
  /** The rows the tap leaves home, in list order. */
  heldBack: GroceryListItem[];
  /** "Sends 54 items" / "Sends 1 item". Plain text. */
  sendsText: string;
  /**
   * "6 pantry staples not included" · "3 household items not included" ·
   * "6 pantry staples and 3 household items not included"; null at 0.
   */
  staplesText: string | null;
  /** The whole line as read aloud: sendsText, then " · " + staplesText when present. */
  line: string;
}

/** "6 pantry staples" / "1 household item" — count + the right noun. */
function heldBackFragment(n: number, one: string, many: string): string | null {
  if (n <= 0) return null;
  return `${n} ${n === 1 ? one : many}`;
}

export function instacartCountSummary(items: GroceryListItem[]): InstacartCountSummary {
  const sendCount = selectInstacartRows(items).length;
  const heldBack = heldBackStaples(items);
  const sendsText = `Sends ${sendCount} ${sendCount === 1 ? "item" : "items"}`;
  // D-WS9-284 — the held-back set is two kinds now, and calling three rolls of
  // paper towels "pantry staples" would be a wrong word in a sentence whose
  // whole job is to be accurate about what Kiwi did not send. Named separately;
  // the copy is byte-identical to before on a list with no household rows.
  const householdCount = heldBack.filter(isHouseholdRow).length;
  const stapleCount = heldBack.length - householdCount;
  const fragments = [
    heldBackFragment(stapleCount, "pantry staple", "pantry staples"),
    heldBackFragment(householdCount, "household item", "household items"),
  ].filter((f): f is string => f !== null);
  const staplesText =
    fragments.length > 0 ? `${fragments.join(" and ")} not included` : null;
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
