// WS7-8b B2 commit 3 — the grocery two-part line, composed at RENDER.
//
// The server persists the pack as DATA (purchaseUnit / purchaseQuantity /
// purchaseDisplay) and the ingredient name (displayName) separately; the need
// quantity stays the raw editable `quantityAmount`. This composes them into the
// single line the user reads together:
//
//   "{purchaseDisplay} {name} ({needGlyph} {unit})"
//   → "1 wedge (6 oz) parmesan (4⅞ oz)"
//   → "3 heads garlic (30 cloves)"
//
// Nothing formatted is ever persisted — the glyph is applied here, at render
// only (formatNeedGlyph), never written back to quantityAmount.

import { formatNeedGlyph } from "./quantity";
import { parseQuantity } from "../quantity";

/**
 * The NEED text rendered inside the two-part line's parenthetical, e.g.
 * "4⅞ oz". The amount is glyph-formatted at RENDER only (formatNeedGlyph) — the
 * raw `quantityAmount` is never mutated, so the inline editor keeps reading and
 * writing the raw value. A non-numeric / off-glyph amount passes through as its
 * raw string. Returns `fallback` (the legacy `quantity` display) when there is
 * no structured amount/unit.
 */
export function formatNeedText(
  quantityAmount: string | undefined,
  quantityUnit: string | undefined,
  fallback: string,
): string {
  const displayAmt =
    quantityAmount !== undefined
      ? (() => {
          const n = parseQuantity(quantityAmount);
          return n !== null ? formatNeedGlyph(n) : quantityAmount;
        })()
      : undefined;
  return displayAmt !== undefined || quantityUnit !== undefined
    ? [displayAmt, quantityUnit].filter(Boolean).join(" ")
    : fallback;
}

// Pack + name, with the "each"-dup elide ported verbatim from the former
// server formatPackDisplay (WS7-5d Fix B) so count produce doesn't read
// "2 lemons lemon" or "2 onions yellow onion":
//   - no purchaseDisplay → bare name (genuine unknown).
//   - purchaseUnit "each" AND purchaseDisplay's word-residue == name(+s/+es) →
//     the pack alone ("2 lemons", "3 tomatoes").
//   - purchaseUnit "each" + qualifier mismatch ("yellow onion" vs "2 onions") →
//     bare name (avoid "2 onions yellow onion", don't drop "yellow").
//   - otherwise → "{purchaseDisplay} {name}".
export function composePackName(
  name: string,
  purchaseUnit: string | null | undefined,
  purchaseDisplay: string | null | undefined,
): string {
  if (!purchaseDisplay) return name;

  if (purchaseUnit === "each") {
    const residue = purchaseDisplay
      .toLowerCase()
      .replace(/^\d+(?:\.\d+)?\s+/, "")
      .trim();
    const n = name.toLowerCase().trim();
    if (residue === n || residue === `${n}s` || residue === `${n}es`) {
      return purchaseDisplay;
    }
    return name;
  }

  return `${purchaseDisplay} ${name}`;
}

/**
 * The full two-part line. `needText` is the already-formatted need (glyph +
 * unit, e.g. "4⅞ oz") produced at render from the raw quantity — pass an empty
 * string to omit the parenthetical (e.g. a checked-off staple with no need).
 */
export function composeGroceryLine(
  name: string,
  purchaseUnit: string | null | undefined,
  purchaseDisplay: string | null | undefined,
  needText: string,
): string {
  const packName = composePackName(name, purchaseUnit, purchaseDisplay);
  const need = needText.trim();
  return need ? `${packName} (${need})` : packName;
}
