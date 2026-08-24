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

// WS9 BUG-125 — the ORDER line must cover the need.
//
// A row is read as "{order quantity} {noun} ({need})". Before this block the
// order half printed the STORED pack verbatim and was blind to the need, so
// "roma tomatoes" read "4 roma tomatoes" against a need of 9 — the user was
// told to buy less than half of what the recipes call for.
//
// Three rules, ruled by Hans 2026-08-21/22 (BUG-125), keyed on the UNITS:
//
//   1. pack unit AND need unit are both the count unit "each" → the "pack" is
//      not a package at all. Hans: "roma tomatoes don't always and only get
//      sold in minimums of 4 packs. that's popular, but grocery stores have
//      them loose, too." If you buy by the each there is nothing to round to,
//      so the order quantity IS the need — 9, not the stored 4 and not the
//      3-packs-of-4 = 12 that "scale the pack to cover" would give.
//   2. the units differ → the pack is a real container ("1 head" for a need in
//      cloves, "5 lb bag" for a need in cups) and is used AS STORED. It has
//      already been scaled to cover the need SERVER-side, in
//      scalePurchaseForSubUnit → resolvePurchaseFields (30 cloves → "3 heads").
//      The client must NOT re-scale: conversionRef / subUnit{parent,perParent}
//      is never sent over the wire, so it has nothing to scale WITH.
//   3. no pack → the need is the order quantity. Exception: a name that already
//      leads with a number is a pre-b0cd677 legacy row carrying the pack baked
//      into displayName ("1 head Garlic"); the name already answers "how much
//      do I buy", so prepending a second quantity gives two answers in one line.
//
// Over-ordering against a bogus stored pack is the ACCEPTED trade (ruled).
// Under-ordering is the worse failure: you cannot cook with four tomatoes when
// the recipe wants nine. No cleverness is added to avoid over-ordering.
//
// Still true, and load-bearing: nothing here is persisted. The pack stays data
// (purchaseUnit / purchaseQuantity / purchaseDisplay), the need stays the raw
// editable quantityAmount, and the line is composed at RENDER — which is also
// why the "each" decision has to live here rather than server-side: the need is
// edited inline and PATCH /grocery-lists/:id/items/:itemId does not recompute
// the pack, so a server-baked order quantity would go stale on the first edit.

/** A displayName that already opens with a digit ("1 head Garlic"). */
const NAME_LEADS_WITH_NUMBER = /^\s*\d/;

/** The pack minus its leading count: "4 roma tomatoes" → "roma tomatoes". */
function packResidue(purchaseDisplay: string): string {
  return purchaseDisplay.replace(/^\s*\d+(?:\.\d+)?\s+/, "").trim();
}

/** Does the pack's residue name the item itself (so printing both would dup)? */
function residueNamesItem(residue: string, name: string): boolean {
  const r = residue.toLowerCase().trim();
  const n = name.toLowerCase().trim();
  return r === n || r === `${n}s` || r === `${n}es`;
}

// Ingredient-name head nouns that must never take an "s". Mass nouns and
// already-invariant plurals — "4 corns on the cob" would be worse than the bug.
// Sized to the live data this path actually touches (20 distinct names across
// 67 rows at the time of writing), NOT to general English.
const INVARIANT_NAME_NOUNS = new Set([
  "corn",
  "bread",
  "milk",
  "water",
  "rice",
  "juice",
  "zucchini",
  "broccoli",
  "spinach",
  "lettuce",
  "cilantro",
  "parsley",
  "asparagus",
  "celery",
]);

// -o nouns that take -es. Explicit and tiny on purpose: English is inconsistent
// here ("tomatoes" but "avocados"), so any rule gets one of the two wrong.
const O_TAKES_ES = new Set(["tomato", "potato"]);

/** Preserve a leading capital when a lookup returns a lowercase plural. */
function matchLeadingCase(original: string, replacement: string): string {
  if (!original || original[0] !== original[0].toUpperCase()) return replacement;
  return replacement.charAt(0).toUpperCase() + replacement.slice(1);
}

/** Pluralize ONE noun, or return it unchanged when we can't do it safely. */
function pluralizeNoun(word: string): string {
  const w = word.toLowerCase();
  if (!w) return word;
  if (INVARIANT_NAME_NOUNS.has(w)) return word;
  // Already plural ("cloves", "peppers", "tomatillos"). "ss"/"us"/"is" endings
  // are singular ("glass", "asparagus", "iris") and fall through.
  if (w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) return word;
  // Reuse the count-noun map first — it already knows the irregulars this
  // codebase cares about (ear→ears, loaf→loaves, leaf→leaves, bunch→bunches).
  const viaUnit = pluralizeNeedUnit(w, 2);
  if (viaUnit !== w) return matchLeadingCase(word, viaUnit);
  if (/(?:ss|x|z|ch|sh)$/.test(w)) return `${word}es`; // squash → squashes
  if (/[^aeiou]y$/.test(w)) return `${word.slice(0, -1)}ies`; // berry → berries
  if (O_TAKES_ES.has(w)) return `${word}es`;
  return `${word}s`;
}

/**
 * Pluralize an ingredient NAME for the order line ("ear of corn" → "ears of
 * corn"). Deliberately not a general English pluralizer: it pluralizes the head
 * noun only — the word before an " of " / " on " prepositional phrase, else the
 * last word of the head clause — and leaves the name untouched whenever
 * pluralizeNoun declines. quantity ≤ 1 (or unknown) is always a no-op.
 */
export function pluralizeIngredientName(
  name: string,
  quantity: number | null,
): string {
  if (quantity === null || quantity <= 1) return name;
  // A trailing prep clause rides along untouched ("tomatillos, husked and
  // halved" pluralizes "tomatillos", not "halved").
  const comma = name.indexOf(",");
  const head = comma === -1 ? name : name.slice(0, comma);
  const tail = comma === -1 ? "" : name.slice(comma);
  // "ear of corn" → stem "ear" + phrase " of corn"; "yellow onion" → stem
  // "yellow onion" + no phrase.
  const phrase = /^(.*?)(\s+(?:of|on|in|with)\s+.*)$/i.exec(head);
  const stem = phrase ? phrase[1] : head;
  const rest = phrase ? phrase[2] : "";
  const words = stem.split(/\s+/);
  const last = words[words.length - 1];
  const plural = pluralizeNoun(last);
  if (plural === last) return name; // invariant / already plural → untouched
  words[words.length - 1] = plural;
  return `${words.join(" ")}${rest}${tail}`;
}

/** The need as a number, from the raw editable amount. null when unknown. */
function resolveNeed(amount: string | number | null | undefined): number | null {
  if (typeof amount === "number") return Number.isFinite(amount) ? amount : null;
  if (typeof amount !== "string") return null;
  return parseQuantity(amount);
}

// Pack + name, composed into the order half of the two-part line. `needAmount`
// / `needUnit` are the RAW need (quantityAmount / quantityUnit) — the same
// values the parenthetical is built from, never a formatted string. Omitting
// them yields the pre-BUG-125 behaviour verbatim, so a caller that has no need
// in hand degrades to the old output rather than to a wrong number.
export function composePackName(
  name: string,
  purchaseUnit: string | null | undefined,
  purchaseDisplay: string | null | undefined,
  needAmount?: string | number | null,
  needUnit?: string | null,
): string {
  const need = resolveNeed(needAmount);
  const nUnit = (needUnit ?? "").trim().toLowerCase();
  const pUnit = (purchaseUnit ?? "").trim().toLowerCase();
  // A unitless need is a bare count, same as "each".
  const needIsCount = nUnit === "each" || nUnit === "";

  // ── Rule 3: no pack ──────────────────────────────────────────────────────
  if (!purchaseDisplay) {
    if (need === null) return name; // genuine unknown → bare name
    if (NAME_LEADS_WITH_NUMBER.test(name)) return name; // legacy baked-in pack
    if (needIsCount) {
      // Discrete items round UP: you cannot buy 2½ onions, and rounding down
      // under-orders. (roundNeedQuantity already ceils counts server-side;
      // this is the belt for the rows that predate it.)
      const q = Math.ceil(need - 1e-9);
      return `${q} ${pluralizeIngredientName(name, q)}`;
    }
    // A measured need carries its unit — a bare number would be meaningless.
    // The unit is pluralized by the SAME helper the parenthetical uses, so the
    // two halves cannot drift ("2 loaves bread (2 loaves)").
    return `${formatNeedGlyph(need)} ${pluralizeNeedUnit(nUnit, need)} ${name}`;
  }

  const residue = packResidue(purchaseDisplay);
  // The elide is a PRESENTATION step, decoupled from the quantity decision:
  // when the pack's words already name the item, printing both duplicates it
  // ("1 seedless watermelon seedless watermelon", "2 lemons lemon").
  const packNamesItem = residueNamesItem(residue, name);

  // ── Rule 1: both units are the count unit → the pack is meaningless ──────
  if (pUnit === "each" && needIsCount && need !== null) {
    const q = Math.ceil(need - 1e-9);
    // Reuse the stored residue when it already names the item — it is authored
    // and correctly pluralized ("roma tomatoes"), so no pluralizer is needed
    // for this majority case. Only a mismatch ("4 ears" vs "ear of corn")
    // falls through to pluralizing the name.
    return `${q} ${packNamesItem ? residue : pluralizeIngredientName(name, q)}`;
  }

  // ── Rule 2: the units differ → a real container, used as stored ──────────
  if (packNamesItem) return purchaseDisplay;
  // Pre-BUG-125 back-compat: with no need to decide with, an "each" pack whose
  // residue doesn't match the name is still dropped rather than guessed at.
  if (pUnit === "each" && need === null) return name;
  return `${purchaseDisplay} ${name}`;
}

/**
 * The full two-part line. `needText` is the already-formatted need (glyph +
 * unit, e.g. "4⅞ oz") produced at render from the raw quantity — pass an empty
 * string to omit the parenthetical (e.g. a checked-off staple with no need).
 * `needAmount` / `needUnit` are that same need in RAW form, forwarded to
 * composePackName so the order half can cover it (BUG-125).
 *
 * NOTE: this is a test-only mirror of the render — the grocery-list row renders
 * composePackName and the need parenthetical as SEPARATE sibling Pressables
 * (the need is its own edit affordance; nesting it re-opens the WS5-5Q
 * responder race). It is kept, and kept in sync, because it is the only place
 * the whole two-part line is asserted as one string.
 */
export function composeGroceryLine(
  name: string,
  purchaseUnit: string | null | undefined,
  purchaseDisplay: string | null | undefined,
  needText: string,
  needAmount?: string | number | null,
  needUnit?: string | null,
): string {
  const packName = composePackName(
    name,
    purchaseUnit,
    purchaseDisplay,
    needAmount,
    needUnit,
  );
  const need = needText.trim();
  return need ? `${packName} (${need})` : packName;
}
