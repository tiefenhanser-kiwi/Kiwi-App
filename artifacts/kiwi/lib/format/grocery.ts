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

// WS7-8b B2 commit 3 (Hans override) — render-time pluralization of the NEED
// unit for COUNT NOUNS only ("30 clove" → "30 cloves"; the garlic headline).
// This is render-only formatting of an authored value — exactly what the ⅛
// glyphs already do (4⅞ is not the stored 4.875); the discipline is *don't
// persist formatted values*, not *never format*. Hard guardrails:
//   - Allow-list count nouns ONLY. Measure units (oz, cup, tbsp, lb, g, ml…)
//     are NEVER touched — "4⅞ ozs" would be worse than the bug.
//   - Unknown units pass through unchanged.
//   - quantity === 1 (or non-numeric) → singular / unchanged.
// Count nouns are discrete, so roundNeedQuantity ceils them to whole — a
// fractional count never reaches here.
const COUNT_NOUN_PLURALS: Record<string, string> = {
  clove: "cloves",
  head: "heads",
  slice: "slices",
  piece: "pieces",
  can: "cans",
  jar: "jars",
  bottle: "bottles",
  bunch: "bunches",
  bag: "bags",
  box: "boxes",
  package: "packages",
  packet: "packets",
  carton: "cartons",
  container: "containers",
  ear: "ears",
  stalk: "stalks",
  sprig: "sprigs",
  fillet: "fillets",
  breast: "breasts",
  thigh: "thighs",
  wedge: "wedges",
  block: "blocks",
  stick: "sticks",
  loaf: "loaves",
  bulb: "bulbs",
  sheet: "sheets",
  strip: "strips",
  cube: "cubes",
  leaf: "leaves",
  wrap: "wraps",
  roll: "rolls",
  pint: "pints",
};

export function pluralizeNeedUnit(
  unit: string,
  quantity: number | null,
): string {
  if (quantity === null || quantity === 1) return unit; // singular / unknown count
  const plural = COUNT_NOUN_PLURALS[unit.trim().toLowerCase()];
  return plural ?? unit; // measure/unknown units untouched
}

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
  const n = quantityAmount !== undefined ? parseQuantity(quantityAmount) : null;
  const displayAmt =
    quantityAmount !== undefined
      ? n !== null
        ? formatNeedGlyph(n)
        : quantityAmount
      : undefined;
  // Count-noun plural at render only; measure units + unknowns pass through.
  const unit =
    quantityUnit !== undefined ? pluralizeNeedUnit(quantityUnit, n) : undefined;
  return displayAmt !== undefined || unit !== undefined
    ? [displayAmt, unit].filter(Boolean).join(" ")
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
