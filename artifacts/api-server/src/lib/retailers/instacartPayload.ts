// Row 8 · Block 1 — compose the Instacart "Create Shopping List Page" body
// from Kiwi grocery rows. Pure: rows in, payload + skipped + unmapped out.
// The route owns ownership, the flag, config, the HTTP call and persistence.
//
// ARCHITECTURE RULING (chat-Claude, September 19, 2026, Hans un-objected):
// the pack-count arithmetic lives on the phone (packsToCoverNeed,
// artifacts/kiwi/lib/format/grocery.ts) and the server persists ONE unscaled
// pack per row. It is NOT ported here. The phone contributes the numbers it
// derives (pack count, pack unit); the server composes everything else from
// the row it owns and controls the Instacart contract. What the shopper reads
// on screen is what gets ordered.
//
// Order line precedence per item (R2):
//   1. client pack data (packCount × the row's per-pack size, in packUnit)
//   2. the row's purchaseQuantityOverride (the user's stated buy)
//   3. the row's stored pack: purchaseQuantity × purchaseUnit — scaled to the
//      need ONLY when both carry the same unit token (Part E1), else one pack
//   4. the need: quantity × unit, when the unit is in the ORDER table
//   5. `1 each`
// Then the unit mapping (R3), the measured need into line_item_measurements
// when the need unit maps (R4), the search name (R5), and display_text = the
// human pack line + name when a pack line exists (name elided when the pack
// already says it — humanLine below), else the raw displayName.

import { canonicalUnitToken } from "../ingredientConversions";
import { instacartSearchName } from "./instacartName";
import { splitRiderForRetailer } from "../groceryVarietyRider";
import {
  mapMeasurement,
  mapOrderUnit,
  normalizeUnitToken,
} from "./instacartUnits";

export interface InstacartLineItem {
  name: string;
  quantity: number;
  unit: string;
  display_text?: string;
  line_item_measurements?: Array<{ quantity: number; unit: string }>;
}

export interface InstacartShoppingListPayload {
  title: string;
  link_type: "shopping_list";
  expires_in: number;
  line_items: InstacartLineItem[];
}

/** The GroceryListItem columns the composer reads. */
export interface InstacartRowInput {
  id: string;
  displayName: string;
  userResolvedTo: string | null;
  quantity: number;
  unit: string;
  deletedAt: Date | null;
  purchaseQuantity: number | null;
  purchaseUnit: string | null;
  purchaseDisplay: string | null;
  purchaseUnitOverride: string | null;
  purchaseQuantityOverride: number | null;
  purchaseDisplayOverride: string | null;
  /**
   * [grocery] B4 (D-WS9-286) — the number of packs the SERVER computed for this
   * row's summed need. Optional so every existing fixture still compiles and a
   * pre-B4 row (null column) behaves exactly as it did.
   */
  packCount?: number | null;
}

/**
 * One selected item from the phone. `packCount` is the NUMBER OF PACKS the
 * phone's packsToCoverNeed derived (an integer ≥ 1, never the displayed
 * total) — the server multiplies it by the row's per-pack size
 * (purchaseQuantityOverride ?? purchaseQuantity) when `packUnit` names the
 * same unit as the row's pack, so "1 can (14.5 oz)" × 4 packs orders
 * `4 can`, and "1.5 lb pack" × 2 orders `3 pound`. A `packUnit` the row
 * does not know is taken at face value (per-pack size 1).
 */
export interface InstacartClientItem {
  groceryListItemId: string;
  packCount?: number;
  packUnit?: string;
  packSizeText?: string;
}

export interface ComposeOptions {
  title: string;
  /** Instacart: days, no default for shopping lists, max 365. Block ruling: 30. */
  expiresInDays?: number;
}

export type SkipReason = "deleted" | "not_found";

export interface ComposeResult {
  payload: InstacartShoppingListPayload;
  skipped: Array<{ groceryListItemId: string; reason: SkipReason }>;
  unmappedUnits: Array<{ groceryListItemId: string; unit: string }>;
}

export const INSTACART_EXPIRES_IN_DAYS = 30;
export const INSTACART_DEFAULT_TITLE = "Kiwi grocery list";

function formatCount(n: number): string {
  return String(parseFloat(n.toFixed(2)));
}

/** Same epsilon as the phone's PACK_EPSILON (grocery.ts:374). */
const PACK_EPSILON = 1e-9;

/**
 * Part E — rewrite a stored pack line's leading count to the scaled total:
 * "2 limes" → "6 limes", "1 can (7 oz)" → "2 cans (7 oz)". Only the leading
 * number and (when it was 1) the plural of the very next word move; the
 * parenthetical and everything after it are untouched. No leading number →
 * "<total> <unit>".
 */
function scalePackLine(
  purchaseDisplay: string | null,
  total: number,
  unit: string,
): string {
  const display = purchaseDisplay?.trim() ?? "";
  const m = /^(~?\d+(?:[./]\d+)?)(\s+)(\S+)([\s\S]*)$/.exec(display);
  if (!m) return `${formatCount(total)} ${unit}`;
  const wasOne = Number(m[1]) === 1;
  let noun = m[3]!;
  if (wasOne && total > 1) {
    noun = PACK_NOUN_PLURALS[noun.toLowerCase()] ?? noun;
  }
  return `${formatCount(total)}${m[2]}${noun}${m[4]}`;
}

// Only a KNOWN countable pack noun takes a plural; an adjective ("1 medium
// white onion"), a measure ("1 lb bag" — never "lbs"), or a name word stays.
const PACK_NOUN_PLURALS: Readonly<Record<string, string>> = {
  can: "cans",
  bunch: "bunches",
  head: "heads",
  package: "packages",
  packet: "packets",
  pack: "packs",
  bottle: "bottles",
  jar: "jars",
  bag: "bags",
  box: "boxes",
  block: "blocks",
  carton: "cartons",
  container: "containers",
  loaf: "loaves",
  tube: "tubes",
  wedge: "wedges",
  piece: "pieces",
  ear: "ears",
};

/**
 * The human line for display_text. The phone's two-part line elides the name
 * when the pack's words already name the item (residueNamesItem in
 * artifacts/kiwi/lib/format/grocery.ts: "2 limes" + "Lime", "4 roma tomatoes"
 * + "roma tomatoes"); the live +8 list printed "2 limes Lime" and "1 medium
 * white onion White onion" without it. Same PRESENTATION rule here — the
 * residue (pack line minus its leading count) equals the name, is its plural
 * or singular, or ends with it — and nothing of the pack arithmetic.
 */
// ── [grocery] B2 BUG-160 — CONTAINMENT, AND IT IS TWO RULES ─────────────────
//
// The test here was equality, its two plurals, and `residue.endsWith(" name")`.
// The census found three shapes it misses, and a dry run proved that ONE
// symmetric "either contains the other" predicate is the wrong fix — it turned
// "3 Bell peppers" into "3 ", because the pack "3 peppers" has a residue the NAME
// contains and dropping the name there throws away the word "bell".
//
// The DIRECTION decides the repair:
//
//   residue ⊇ name       "3 medium white onion" + "White onion"
//                        the pack line already says everything the name says
//                        -> DROP THE NAME            "3 medium white onion"
//
//   name OPENS with it   "1 rotisserie chicken" + "rotisserie chicken, meat
//                        shredded" — the name is the fuller statement and its
//                        head is the duplicate
//                        -> COUNT + NAME  "1 rotisserie chicken, meat shredded"
//
//   anything else        "3 peppers" + "bell peppers"; "1 head" + "Garlic"
//                        -> LEAVE IT ALONE
//
// Plural-aware through the same crude stem in both directions. Nothing here
// pluralises — BUG-321/329 are the client's lane.
//
// ⚠️ THE SHOPPER'S LIST LINE IS NOT FIXED HERE. It is composed by
// `artifacts/kiwi/lib/format/grocery.ts:149` (residueNamesItem), which is outside
// this block's fence and is ruled to block C. This is the Instacart half, and the
// two have to end up agreeing.
/**
 * The crudest plural stem that is still RIGHT, and it got one word wrong before.
 *
 * The first cut was `endsWith("es") -> drop two`, which turns "limes" into "lim"
 * while "lime" stays "lime" — so `6 limes` + `Lime` stopped eliding and the live
 * list printed "6 limes Lime" again, which is the exact defect BUG-160 named.
 *
 * English forms -es only after s / x / z / ch / sh, and after -o. Everything else
 * ending in -es is a word ending in -e taking a plain -s. Both sides of every
 * comparison run through this, so a word it stems oddly ("leaves" -> "leave")
 * still matches itself; what matters is that it never produces two different
 * stems for one word.
 */
function stemWord(w: string): string {
  if (/(?:ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("oes")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 2) return w.slice(0, -1);
  return w;
}
const stemAll = (x: string): string[] =>
  x.toLowerCase().split(/[\s,]+/).filter(Boolean).map(stemWord);

function containsSeq(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function humanLine(packLine: string, name: string): string {
  const n = name.trim();
  if (n.length === 0) return packLine;
  const residueText = packLine.replace(/^\s*~?\d+(?:[./]\d+)?\s+/, "").trim();
  const r = stemAll(residueText);
  const nm = stemAll(n);
  if (r.length === 0 || nm.length === 0) return `${packLine} ${name}`;
  if (containsSeq(r, nm)) return packLine;
  if (nm.length > r.length && containsSeq(nm.slice(0, r.length), r)) {
    const count = packLine.match(/^\s*~?\d+(?:[./]\d+)?/)?.[0]?.trim() ?? "";
    return count ? `${count} ${n}` : n;
  }
  return `${packLine} ${name}`;
}

/**
 * "cans" and "can" are the same pack unit; so are "lb" and "pound". Compare
 * through the order table when both sides map, by normalized token otherwise.
 */
function sameOrderUnit(a: string, b: string): boolean {
  const ma = mapOrderUnit(a, 1);
  const mb = mapOrderUnit(b, 1);
  if (ma.mapped && mb.mapped) return ma.unit === mb.unit;
  return normalizeUnitToken(a) === normalizeUnitToken(b);
}

interface OrderSource {
  rawUnit: string;
  total: number;
  /** The human pack line ("2 cans (14.5 oz each)"); null when the need or the fallback was used. */
  packLine: string | null;
  /** The unit to report when the order line could not be mapped (step 5). */
  unmappedNeedUnit: string | null;
}

function resolveOrderSource(
  row: InstacartRowInput,
  client: InstacartClientItem,
): OrderSource {
  const rowPackUnit = row.purchaseUnitOverride ?? row.purchaseUnit;
  const rowPackQty = row.purchaseQuantityOverride ?? row.purchaseQuantity;

  // 1. Client pack data — the phone's derived count, in the phone's unit.
  if (client.packCount != null && client.packCount > 0) {
    const unit = client.packUnit?.trim() || rowPackUnit || "each";
    const sameUnitAsRow = rowPackUnit != null && sameOrderUnit(unit, rowPackUnit);
    const perPack =
      sameUnitAsRow && rowPackQty != null && rowPackQty > 0 ? rowPackQty : 1;
    const total = client.packCount * perPack;
    const size = client.packSizeText?.trim();
    const packLine = `${formatCount(total)} ${unit}${size ? ` ${size}` : ""}`;
    return { rawUnit: unit, total, packLine, unmappedNeedUnit: null };
  }

  // 2. The user's stated buy.
  if (row.purchaseQuantityOverride != null && row.purchaseQuantityOverride > 0) {
    const unit = rowPackUnit ?? "each";
    const total = row.purchaseQuantityOverride;
    const packLine =
      row.purchaseDisplayOverride?.trim() || `${formatCount(total)} ${unit}`;
    return { rawUnit: unit, total, packLine, unmappedNeedUnit: null };
  }

  // 3. The stored pack. Part E (E1): when the need and the pack carry the SAME
  //    unit token, the server scales — packs = ceil(need / packQuantity) — so
  //    a caller with no pack data (row 3a's email later, the web surface) does
  //    not under-order: the live +8 list sent "2 limes" against a need of 5.
  //    This is the phone's packsToCoverNeed rule 1 VERBATIM
  //    (artifacts/kiwi/lib/format/grocery.ts:606-610, same-token branch, same
  //    1e-9 epsilon so a need of exactly one pack cannot ceil to two on float
  //    noise); the two are meant to agree. DIFFERENT tokens → one pack,
  //    unscaled, unchanged: cross-system conversion (2 pound against a
  //    "1 package (12 oz)") stays on the phone by ruling.
  if (row.purchaseQuantity != null && row.purchaseQuantity > 0 && rowPackUnit) {
    const needToken = canonicalUnitToken(row.unit);
    const packToken = canonicalUnitToken(rowPackUnit);
    // ── [grocery] B4 (D-WS9-286) — THE SERVER'S OWN COUNT, WHERE IT HAS ONE ──
    //
    // The same-token arithmetic below is the phone's rule 1, and it can only see
    // pairs that share a unit token. It therefore orders ONE pack for any row
    // whose need is in cups against a pack in cans — which is how a plan wanting
    // eight cups of broth ordered a single 14.5 oz can. `packCount` is the count
    // the server derived through the pack yield, so where it exists it wins.
    //
    // ⚠️ AND `purchaseQuantity` MEANS TWO DIFFERENT THINGS, which is why the
    // per-pack size is read off the invariant rather than assumed. When the
    // server SCALED the pack, resolvePurchaseFields wrote the same number into
    // both columns, so `purchaseQuantity === packCount` and the order is simply
    // `packCount` of the pack noun ("4 can"). When it did not scale,
    // `purchaseQuantity` is the per-pack SIZE and the order is the product
    // ("2 packs of 1.5 lb" = 3 lb). Multiplying in the first case would order
    // sixteen cans for four.
    const serverPacks =
      row.packCount != null && row.packCount > 0 ? row.packCount : null;
    const packs =
      serverPacks ??
      (needToken.length > 0 && needToken === packToken && row.quantity > 0
        ? Math.max(1, Math.ceil(row.quantity / row.purchaseQuantity - PACK_EPSILON))
        : 1);
    const perPack =
      serverPacks !== null && row.purchaseQuantity === serverPacks
        ? 1
        : row.purchaseQuantity;
    const total = packs * perPack;
    const packLine =
      packs === 1
        ? row.purchaseDisplay?.trim() || `${formatCount(total)} ${rowPackUnit}`
        : scalePackLine(row.purchaseDisplay, total, rowPackUnit);
    return { rawUnit: rowPackUnit, total, packLine, unmappedNeedUnit: null };
  }

  // 4. The need, when its unit is an order unit.
  const needUnit = normalizeUnitToken(row.unit);
  if (row.quantity > 0 && needUnit.length > 0) {
    const probe = mapOrderUnit(needUnit, row.quantity);
    if (probe.mapped) {
      return { rawUnit: needUnit, total: row.quantity, packLine: null, unmappedNeedUnit: null };
    }
  }

  // 5. One of whatever it is. A non-empty need unit that got here is the
  //    census signal (teaspoon / clove / sprig …) and is reported.
  return {
    rawUnit: "each",
    total: 1,
    packLine: null,
    unmappedNeedUnit: needUnit.length > 0 ? needUnit : null,
  };
}

export function composeInstacartPayload(
  rows: InstacartRowInput[],
  clientItems: InstacartClientItem[],
  opts: ComposeOptions,
): ComposeResult {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const skipped: ComposeResult["skipped"] = [];
  const unmappedUnits: ComposeResult["unmappedUnits"] = [];
  const line_items: InstacartLineItem[] = [];

  for (const client of clientItems) {
    const id = client.groceryListItemId;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = byId.get(id);
    if (!row) {
      skipped.push({ groceryListItemId: id, reason: "not_found" });
      continue;
    }
    if (row.deletedAt) {
      skipped.push({ groceryListItemId: id, reason: "deleted" });
      continue;
    }

    const source = resolveOrderSource(row, client);
    const order = mapOrderUnit(source.rawUnit, source.total);
    if (!order.mapped) {
      unmappedUnits.push({ groceryListItemId: id, unit: source.rawUnit });
    } else if (source.unmappedNeedUnit) {
      unmappedUnits.push({ groceryListItemId: id, unit: source.unmappedNeedUnit });
    }

    const name = instacartSearchName(row.displayName, row.userResolvedTo);
    const item: InstacartLineItem = {
      name,
      quantity: order.quantity,
      unit: order.unit,
      display_text: source.packLine ? humanLine(source.packLine, name) : row.displayName,
    };
    const measurement = mapMeasurement(row.unit, row.quantity);
    if (measurement) item.line_item_measurements = [measurement];

    // ── [grocery] B2 H7 — AN H3 LINE IS SENT AS SEPARATE ITEMS ───────────────
    //
    // Hans's shape is one DISPLAY line — "5 bell peppers, at least 2 red and at
    // least 2 yellow" — and that is what the shopper reads. But a retailer cart
    // holding one item called "bell peppers" has thrown the constraint away: the
    // picker has no way to know two of them must be red. So the order carries one
    // item per called-out variety at its guaranteed count, plus the remainder at
    // the generic name, and `display_text` stays the single line.
    //
    // ⚠️ THE SEARCH TERM NEEDED NO CHANGE AND THAT IS NOT LUCK. The rider is a
    // trailing comma-clause opening with "at", and "at" is in
    // instacartName.PREP_WORDS, so `instacartSearchName` already drops it —
    // "bell peppers, at least 2 green" searches as "bell peppers". Asserted by
    // test rather than relied on quietly.
    const split = splitRiderForRetailer(row.displayName, order.quantity);
    if (split.length > 1) {
      split.forEach((part, k) => {
        line_items.push({
          ...item,
          name: instacartSearchName(part.name, k === 0 ? row.userResolvedTo : null),
          quantity: part.quantity,
          // The human line rides on the FIRST item only. Repeating it would show
          // the shopper the same sentence three times in the retailer's cart.
          display_text: k === 0 ? item.display_text : part.name,
          // A measurement describes the whole need and cannot be divided between
          // the varieties, so the split items carry none.
          line_item_measurements: undefined,
        });
      });
      continue;
    }
    line_items.push(item);
  }

  const title = opts.title.trim().length > 0 ? opts.title.trim() : INSTACART_DEFAULT_TITLE;
  return {
    payload: {
      title,
      link_type: "shopping_list",
      expires_in: opts.expiresInDays ?? INSTACART_EXPIRES_IN_DAYS,
      line_items,
    },
    skipped,
    unmappedUnits,
  };
}
