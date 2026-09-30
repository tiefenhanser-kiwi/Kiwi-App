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
  quart: "quarts",
  gallon: "gallons",
};

// ── WS9 BUG-329 — PLURAL ONLY ABOVE ONE ────────────────────────────────────
//
// The guard was `quantity === 1`, so everything BELOW one pluralized too:
// `¼ bunches`, `½ heads`. Ruled: plural when the quantity is GREATER than one.
//
// MEASURED BLAST RADIUS, and why this had to land before BUG-321 rather than
// beside it. On the grocery corpus (b3 after-state, 1,021 rows across 20 plans)
// this changes NOTHING: `roundNeedQuantity` ceils count nouns server-side, so no
// live grocery row reaches here with a sub-one count. On DISH INGREDIENTS —
// where BUG-321 is about to wire this engine in for the first time — it is
// live: the catalog snapshot carries `0.5 head` rows (Shredded Cabbage). Wiring
// formatIngredientLine to the engine without this fix first would have shipped
// "½ heads green cabbage" as the fix for "½ head cabbage".
//
// The ≤ also covers 0 and negatives, which is the same answer for the same
// reason: neither is more than one of anything.
export function pluralizeNeedUnit(
  unit: string,
  quantity: number | null,
): string {
  if (quantity === null || quantity <= 1) return unit; // singular / unknown count
  const plural = COUNT_NOUN_PLURALS[unit.trim().toLowerCase()];
  return plural ?? unit; // measure/unknown units untouched
}

// ── WS9 BUG-321 — THE MEASURE UNITS, OWED BACK FROM THE WEB ────────────────
//
// ⚠️ PORTED VERBATIM from kiwi-site/scripts/cookbook/render.mjs, where the
// Cookbook generator added it and left a comment naming this debt. Its own
// words: the app's table above is COUNT nouns and deliberately omits measure
// units, because the grocery line it was written for renders a parenthetical
// need ("4⅞ oz") where "4⅞ ozs" would be worse than the bug it fixed. A RECIPE
// LINE is a different sentence — it renders the unit as a WORD a cook reads
// ("2 cups milk") — and "2 cup milk" is simply wrong English.
//
// It stays a SECOND table rather than being folded into COUNT_NOUN_PLURALS, so
// that the ported half stays byte-comparable with the web's and the grocery
// parenthetical keeps its narrower vocabulary. pluralizeNeedUnit reads one
// table; pluralizeUnitWord reads both.
//
// MEASURED, NOT GUESSED (the web's count, `dish_ingredients.unit`, 42 distinct
// values, 2026-09-27): teaspoon 13,360 · tablespoon 9,156 · cup 6,347 ·
// ounce 2,552 · pound 1,918 · inch 26 · quart 16 · "fluid ounce" 11 · pint 8 ·
// gram 2 · pinch 2 · second 3.
//
// ⚠️ THE ABBREVIATIONS ARE DELIBERATELY ABSENT — tbsp 110, tsp 98, lb 64, oz 32
// are all live in the catalog and all stay invariant: an abbreviation is
// already invariant in recipe English ("2 tbsp", never "2 tbsps"), and
// pluralizing one is the exact mistake COUNT_NOUN_PLURALS' comment warns
// against. `large` (4 rows) is absent for the same reason BUG-317 keeps it as a
// word: "2 large eggs" pluralizes the NAME, not the unit. Literal pack
// spellings ("15-ounce can") pass through untouched — they are already phrases.
const MEASURE_UNIT_PLURALS: Record<string, string> = {
  teaspoon: "teaspoons",
  tablespoon: "tablespoons",
  cup: "cups",
  ounce: "ounces",
  "fluid ounce": "fluid ounces",
  pound: "pounds",
  gram: "grams",
  kilogram: "kilograms",
  liter: "liters",
  litre: "litres",
  milliliter: "milliliters",
  millilitre: "millilitres",
  inch: "inches",
  pinch: "pinches",
  dash: "dashes",
  handful: "handfuls",
  second: "seconds",
  minute: "minutes",
};

/**
 * THE RECIPE LINE'S unit pluralizer: the count-noun table first, then the
 * measure units. Same contract as {@link pluralizeNeedUnit} — quantity ≤ 1 or
 * unknown is a no-op, an unknown unit passes through unchanged — and the same
 * body, ported verbatim from the web's `pluralizeUnitWord`.
 *
 * ⚠️ NOT a drop-in for pluralizeNeedUnit at the GROCERY call sites. The need
 * parenthetical and the pack label must keep rendering "4⅞ oz" and "3 lb pack";
 * this one is for a line where the unit is read as a word.
 */
export function pluralizeUnitWord(
  unit: string,
  quantity: number | null | undefined,
): string {
  if (quantity === null || quantity === undefined) return unit;
  if (quantity <= 1) return unit; // "½ cup", never "½ cups"
  const key = unit.trim().toLowerCase();
  const plural = COUNT_NOUN_PLURALS[key] ?? MEASURE_UNIT_PLURALS[key];
  if (!plural) return unit;
  return matchLeadingCase(unit.trim(), plural);
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

// ── WS9 BUG-160 — THE SHOPPER LINE, AND WHY EXACT MATCHING WAS NOT ENOUGH ───
//
// The elide asks one question: do the pack's words already name the item, so
// that printing both would say it twice? It asked it with an EXACT comparison
// plus a simple plural, and the live data does not cooperate:
//
//     "1 bunch (~6-8 scallions) scallions (3 each)"
//     "1 lb (~4-5 tomatillos) tomatillos (¾ pound)"
//     "1 bunch (~6-8 radishes) radishes (6 each)"
//     "3 medium white onion white onion (2¼ cup)"
//     "1 rotisserie chicken rotisserie chicken, meat shredded (3 cup)"
//
// In each the residue and the name overlap without being equal. Eight rows on
// the B3 after-state read like that.
//
// ⚠️ THE TEST IS DIRECTIONAL, AND A SYMMETRIC ONE IS WRONG. Measured: nine
// further rows have the NAME containing the RESIDUE, and eliding four of them
// LOSES the distinguishing word —
//
//     residue "loaf"     name "italian bread loaf"  ->  "1 loaf"      ✗
//     residue "boule"    name "sourdough boule"     ->  "1 boule"     ✗
//     residue "baguette" name "Italian baguette"    ->  "1 baguette"  ✗
//     residue "peppers"  name "bell peppers"        ->  "3 peppers"   ✗
//
// So the rule is: elide when the RESIDUE contains the NAME — the residue is the
// fuller phrase and keeping it loses nothing. Never the other way.
//
// ⚠️ THE COMMA CLAUSE COMES OFF THE NAME FIRST, and that is what rescues the
// fifth row above. "rotisserie chicken, meat shredded" is a prep clause on a
// name the residue states exactly; stripped, the two are EQUAL and the pre-
// existing exact test handles it with no containment at all. The distinguishing
// modifiers in the four rows that must not elide all sit BEFORE the head noun,
// which is why they survive the strip and stay unmatched. The split is the same
// one pluralizeIngredientName and singularizeIngredientName already use, for
// the same reason — reused, not rewritten.
//
// ⚠️ THIS PREDICATE IS ALSO RULE 1's, via countedPackTitle, and widening it
// moves 15 rows that did NOT duplicate: "1 white onion" becomes "1 medium white
// onion", "1 beefsteak tomato" becomes "1 large beefsteak tomato". Ruled
// ACCEPTED (2026-09-29) — that is the pack you reach for on the shelf, and R7
// wants the line to be a search term a store understands. One predicate, not
// two. lib/__tests__/grocery-format.test.ts pins all 28 rows as literals.

// ── 🔴 WS9 BUG-160 — A RIDER IS NOT A PREP CLAUSE, AND ELIDING ONE LOSES IT ──
//
// H3's variety rider (api-server/src/lib/groceryVarietyRider.ts) rides in the
// NAME, because the name is the only channel to the shopper's line:
//
//     "bell peppers, at least 2 green"
//     "yellow onions, at least 1 large"
//
// It LOOKS like the prep clause on "rotisserie chicken, meat shredded" and it
// is the opposite thing: a prep note describes what you do after you buy, a
// rider is the part of WHAT TO BUY that the pack string cannot state. Stripping
// it before the containment test made both rows above elide — the residue
// "green bell peppers" contains the head "bell peppers" — and printed the pack
// residue INSTEAD of the name, dropping "at least 2 green" off a list that
// carried it. Caught by the corpus diff, not by reasoning.
//
// That is precisely the failure B3 Part E's ruling-8 note records in the other
// direction ("the fold landed and the rider did not, which would have REMOVED
// the word 'low-sodium' from a list that used to carry it"). So: a name
// carrying a rider NEVER elides. The residue cannot contain a rider — the rider
// is not in the pack string and never will be — so there is no case where
// eliding one is safe, and refusing outright is stronger than trying to
// preserve it.
//
// The grammar is machine-written and fixed (`composeVarietyRider`: "at least N
// <variety>", joined by " and "), and nothing else in the codebase writes a
// `, at least N x` clause onto an ingredient name. That is what makes detecting
// it by shape honest rather than a guess.
const NAME_RIDER = /,\s*at least \d+\s/i;

/**
 * A name minus its trailing PREP clause: "chicken, meat shredded" → "chicken".
 * Returns the name unchanged when the clause is a variety rider.
 */
function nameHead(name: string): string {
  if (NAME_RIDER.test(name)) return name.trim();
  const comma = name.indexOf(",");
  return (comma === -1 ? name : name.slice(0, comma)).trim();
}

/** Escape a string for use as a regex literal. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `haystack` contain `needle` as whole words, tolerating a plural marker
 * on the contained phrase? "bunch (~6-8 scallions)" contains "scallions";
 * "medium white onion" contains "white onion"; "onion powder" does NOT contain
 * "onion powder her" and "scallion" does not match "scallions oil".
 */
function containsPhrase(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  return new RegExp(`(^|[^a-z])${escapeForRegex(needle)}(e?s)?([^a-z]|$)`, "i").test(
    haystack,
  );
}

// ── 🔴 [grocery] F (F2) — A BUY LINE ALWAYS NAMES THE FOOD ──────────────────
//
// Hans's device pass read, in PANTRY:
//
//     2 lb (~3–4 tomatillos)          — For Beef Enchiladas Verdes …  (1¼ pound)
//
// There is no food name on that line. `residueNamesItem` elided it because the
// residue "lb (~3–4 tomatillos)" *contains* "tomatillo" — but the containment
// is inside a PARENTHETICAL, and a parenthetical is a size hint, not a name.
// BUG-160's rule ("elide when the residue is the fuller phrase, because keeping
// it loses nothing") is sound and this is the case it did not anticipate: here
// the residue is not a fuller phrase at all, it is a measurement with a note.
//
// RULED September 30: the elide may never fire on the strength of a
// parenthetical. The test now runs on the residue's HEAD.
//
// ⚠️ THE 8 ROWS THIS TOUCHES, MEASURED ON THE f0 CORPUS, and why only two of
// them actually move. The other six already printed their name (the elide never
// fired) or keep printing exactly what they printed:
//
//     "1 lb (~4-5 tomatillos)"   + tomatillos        elided  ->  names the food
//     "1 lb (~3–4 tomatillos)"   + tomatillo         elided  ->  names the food
//     "1 bunch (~6-8 radishes)"  + radishes          elided  ->  names the food
//     "1 bunch (~6-8 scallions)" + scallions         elided  ->  names the food
//     "1 bunch (~8-10 stalks)"   + celery stalks     already printed the name
//     "1 bunch (~6 scallions)"   + sliced scallions  already printed the name
//     "1 package (4 buns)"       + brioche burger buns   already printed
//
// ⚠️ SO WHY DOES THE LINE NOT NOW SAY IT TWICE? Because when the PARENTHETICAL
// is what named the item, the name has taken over that job and the hint is
// redundant — so it comes off the display. "1 bunch (~6-8 scallions)" becomes
// "1 bunch scallions", not "1 bunch (~6-8 scallions) scallions". A hint that
// names something ELSE ("(4 buns)" on brioche burger buns is its own head noun;
// "(14.5 oz)" is a size) is untouched, because it was never the thing naming
// the food.
//
// The tomatillo hint is ALSO removed from the catalog (Part B), because its
// number was wrong independent of all this — a medium tomatillo is ~2 oz, so
// ~8 to the pound rather than 3-4. These two fixes are independent and each
// one alone would have put the name back on that line.

/** A residue or display with every parenthetical removed: "lb (~3–4 x)" → "lb". */
function stripParentheticals(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Does the pack's residue name the item itself (so printing both would dup)?
 *
 * F2 — tested on the HEAD only. A parenthetical is a size hint and never a
 * name, however much of the food's own word it happens to contain.
 */
function residueNamesItem(residue: string, name: string): boolean {
  return headNamesItem(stripParentheticals(residue), name);
}

/** The BUG-160 test, on a string that has already had its parentheticals cut. */
function headNamesItem(head: string, name: string): boolean {
  const r = head.toLowerCase().trim();
  const n = nameHead(name).toLowerCase();
  if (n.length === 0) return false;
  if (r === n || r === `${n}s` || r === `${n}es`) return true;
  // BUG-160 — one direction only: the residue may be the fuller phrase.
  return containsPhrase(r, n);
}

/**
 * F2 — was the PARENTHETICAL the only thing naming the food? True when the
 * whole residue names it but its head does not, which is precisely the case
 * where the name is about to be printed and the hint becomes redundant.
 */
function parentheticalNamedItem(residue: string, name: string): boolean {
  if (residueNamesItem(residue, name)) return false; // the head did it
  return headNamesItem(residue, name);
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

// WS9 BUG-144 — the inverse of COUNT_NOUN_PLURALS ("cloves" → "clove",
// "loaves" → "loaf", "leaves" → "leaf"). Derived rather than authored so the
// two directions cannot drift: adding one irregular to the map above gives
// both. It is the same set of irregulars this codebase already cares about.
const COUNT_NOUN_SINGULARS: Record<string, string> = Object.fromEntries(
  Object.entries(COUNT_NOUN_PLURALS).map(([one, many]) => [many, one]),
);

// WS9 BUG-144 — words that PASS isPluralWord but are not the plural of
// anything. The (ss|x|z|ch|sh)es reversal cannot tell "glasses" → "glass" from
// "molasses" → nothing: both end in -sses, and no morphological rule separates
// them.
//
// Sized to the live data, same discipline as INVARIANT_NAME_NOUNS above and NOT
// to general English. Scanning all 1,725 distinct ingredient + grocery-row
// names, exactly THREE hit that reversal: "peaches" → "peach" and "radishes" →
// "radish" are both correct, and "molasses" is the only one that is not.
// "pomegranate molasses" is a real catalog row. Add here only what the data
// shows — a speculative list of English mass nouns would be unfalsifiable.
const NOT_A_PLURAL = new Set(["molasses"]);

/** Preserve a leading capital when a lookup returns a lowercase plural. */
function matchLeadingCase(original: string, replacement: string): string {
  if (!original || original[0] !== original[0].toUpperCase()) return replacement;
  return replacement.charAt(0).toUpperCase() + replacement.slice(1);
}

/**
 * Does this word already read as a plural? "cloves", "peppers", "tomatillos"
 * yes; "glass", "asparagus", "iris" no (those -ss/-us/-is endings are
 * singular). Used both to avoid double-pluralizing and, in Root D, to decide
 * whether a stored pack residue can be swapped for the singular name.
 */
function isPluralWord(word: string): boolean {
  const w = word.trim().toLowerCase();
  return w.endsWith("s") && !/(?:ss|us|is)$/.test(w);
}

/** The last whitespace-separated word, which is where the plural marker sits. */
function lastWord(phrase: string): string {
  const parts = phrase.trim().split(/\s+/);
  return parts[parts.length - 1] ?? "";
}

/** Pluralize ONE noun, or return it unchanged when we can't do it safely. */
function pluralizeNoun(word: string): string {
  const w = word.toLowerCase();
  if (!w) return word;
  // ── [grocery] F — A TOKEN THAT DOES NOT START WITH A LETTER IS NOT A NOUN ──
  //
  // Caught by the corpus diff the moment F5.3 started routing Rule 2's names
  // through here. Two live catalog names end their head clause in a
  // parenthetical, and every branch below happily appended an "s" to it:
  //
  //     "corn tortillas (6-inch)"          ->  "corn tortillas (6-inch)s"
  //     "flour tortillas (large, 10-inch)"  ->  "flour tortillas (larges, 10-inch)"
  //
  // (The second is the comma split landing inside the parens, so the "last
  // word" is the fragment "(large".) Neither name needed pluralising at all —
  // both are already plural — but the head-noun rule looks at the LAST word and
  // the last word was punctuation.
  //
  // Declining here rather than at the new call site, because the defect is not
  // F5.3's: every caller of pluralizeIngredientName has always been one such
  // catalog name away from it. There is no word in any language this rule
  // refuses that the old code pluralised correctly.
  if (!/^[a-z]/i.test(word.trim())) return word;
  if (INVARIANT_NAME_NOUNS.has(w)) return word;
  if (isPluralWord(w)) return word;
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

/**
 * Singularize ONE noun, or return it unchanged when we can't do it safely.
 *
 * ⚠️ NO `INVARIANT_NAME_NOUNS` CHECK HERE, AND THAT IS DELIBERATE — mutation
 * testing proved one dead. Every one of the 14 invariant nouns (corn, bread,
 * asparagus, celery…) already fails `isPluralWord`: none ends in a bare `s`,
 * and `asparagus` is caught by the `-us` clause. Deleting an invariant check
 * changed no test and no live row, so it was reassuring-looking dead code —
 * the same call, on the same grounds, that the Root D branch below records.
 * The plural direction is different: there the check IS live, because it is
 * what stops "corn" becoming "corns".
 *
 * ⚠️ IF YOU ADD A GENUINELY-PLURAL MASS NOUN to INVARIANT_NAME_NOUNS
 * ("greens", "breadcrumbs", "flakes" — all real ingredient names, all measured
 * in cups or teaspoons today so none reaches this branch), it will NOT be
 * protected by that set and will stem to "green" / "breadcrumb" / "flake".
 * Add it to NOT_A_PLURAL instead, which is the set this function does read.
 */
function singularizeNoun(word: string): string {
  const w = word.toLowerCase();
  if (!w) return word;
  if (NOT_A_PLURAL.has(w)) return word; // "molasses" is not molasses-plural
  if (!isPluralWord(w)) return word; // already singular / -ss / -us / -is
  const viaUnit = COUNT_NOUN_SINGULARS[w];
  if (viaUnit) return matchLeadingCase(word, viaUnit); // cloves → clove
  if (/[^aeiou]ies$/.test(w)) return matchLeadingCase(word, `${w.slice(0, -3)}y`); // berries → berry
  if (O_TAKES_ES.has(w.slice(0, -2))) return word.slice(0, -2); // tomatoes → tomato
  if (/(?:ss|x|z|ch|sh)es$/.test(w)) return word.slice(0, -2); // squashes → squash
  return word.slice(0, -1); // lemons → lemon
}

/**
 * WS9 BUG-144 — the mirror of {@link pluralizeIngredientName}, for a count of
 * exactly 1. Same shape by construction: head noun only (the word before an
 * " of " / " on " phrase, else the last word of the head clause), a trailing
 * prep clause rides along untouched, and the name is returned UNCHANGED
 * whenever singularizeNoun declines.
 *
 * WHY IT EXISTS: Root D fixed "1 lemons" on the branch where the pack residue
 * NAMES the item, by falling back to the ingredient name — which is authored
 * singular in 22 of 23 live rows. The OTHER branch has no such fallback: when
 * the residue does not name the item ("1 head of garlic" against "garlic
 * cloves") the name IS the plural, so there is nothing to fall back TO and
 * `1 garlic cloves` shipped. That row renders live on list 22117b24.
 */
export function singularizeIngredientName(name: string): string {
  const comma = name.indexOf(",");
  const head = comma === -1 ? name : name.slice(0, comma);
  const tail = comma === -1 ? "" : name.slice(comma);
  const phrase = /^(.*?)(\s+(?:of|on|in|with)\s+.*)$/i.exec(head);
  const stem = phrase ? phrase[1] : head;
  const rest = phrase ? phrase[2] : "";
  const words = stem.split(/\s+/);
  const last = words[words.length - 1];
  const singular = singularizeNoun(last);
  if (singular === last) return name; // invariant / already singular → untouched
  words[words.length - 1] = singular;
  return `${words.join(" ")}${rest}${tail}`;
}

/**
 * The ingredient name agreed with a whole COUNT, in both directions. The two
 * order-line branches that print "{q} {name}" both route through here so a
 * count of 1 cannot singularise on one and not the other — which is exactly
 * how BUG-144 hid: Root D guarded one branch and left its twin uncovered.
 */
function countedName(name: string, quantity: number): string {
  return quantity === 1
    ? singularizeIngredientName(name)
    : pluralizeIngredientName(name, quantity);
}

/**
 * [grocery] F (F5.1) — the same function, exported for the RECIPE line.
 *
 * `formatIngredientLine` (lib/format/ingredientLine.ts) pluralised the name and
 * never singularised it, so a catalog name that is plural by construction read
 * "1 garlic cloves" on the meal-detail Ingredients sheet — the M13 note that
 * file carries, found by Hans's device pass. It now calls this.
 *
 * Exported rather than re-implemented for exactly the reason `countedName`
 * exists at all: BUG-144 hid because one branch was guarded and its twin was
 * not. Two surfaces counting the same noun must not be able to disagree.
 */
export function countedIngredientName(name: string, quantity: number): string {
  return countedName(name, quantity);
}

/** The need as a number, from the raw editable amount. null when unknown. */
function resolveNeed(amount: string | number | null | undefined): number | null {
  if (typeof amount === "number") return Number.isFinite(amount) ? amount : null;
  if (typeof amount !== "string") return null;
  return parseQuantity(amount);
}

// ── WS9 Root A — a container pack must SCALE to cover the need ──────────────
//
// BUG-125 fixed the `each` branch. The container branch was left alone on the
// belief that the server already scaled it — and it does, in
// scalePurchaseForSubUnit, for ingredients carrying a `subUnit`. Measured
// against the live catalog that is **1 row out of 1,570** (garlic, head↔clove).
// Every other container pack printed verbatim whatever the need, so "1 lb
// ground beef" stood against a need of 1.75 lb. Under-ordering, ruled worst.
//
// Three scalable shapes, and nothing else:
//   1. the need unit and the pack unit are the same → pure arithmetic,
//      ceil(need / packQuantity). No conversion data needed at all.
//   2. both units are WEIGHT units (BUG-143) → grams relate them outright,
//      ceil(need·g / (qty · pack·g)). Ingredient-independent, so no data.
//   3. purchaseDisplay carries a parenthetical size in the need's own unit
//      ("1 can (14.5 oz)" against a need in oz) → ceil(need / (qty × size)).
// Anything else — a need in cups against a pack in bunches — needs a
// container→measure factor that does not exist anywhere in the data. Those
// rows are OUT OF SCOPE and must render exactly as they do today.
//
// This lives client-side beside the `each` fix for the same reason: the need is
// user-editable inline and PATCH /grocery-lists/:id/items/:itemId does not
// recompute the stored pack, so a server-computed order quantity goes stale on
// the first edit.

const PACK_EPSILON = 1e-9;

/** A bare decimal, as a pack display spells one. Shared by the size hint and
 *  its range form so the two cannot accept different numbers. */
const PACK_NUM = String.raw`\d+(?:\.\d+)?`;

// Unit spellings that mean the same thing. Only what the live data actually
// uses — the need side says "pound"/"ounce" where the pack side says "lb"/"oz",
// and without this the two never match and nothing scales.
const UNIT_ALIASES: Record<string, string> = {
  lbs: "lb", pound: "lb", pounds: "lb",
  ounce: "oz", ounces: "oz", "fl oz": "oz",
  cups: "cup",
  tablespoon: "tbsp", tablespoons: "tbsp", tbsps: "tbsp",
  teaspoon: "tsp", teaspoons: "tsp", tsps: "tsp",
  gram: "g", grams: "g", kilogram: "kg", kilograms: "kg",
  milliliter: "ml", milliliters: "ml", liter: "l", liters: "l",
  bunches: "bunch", cans: "can", jars: "jar", bags: "bag", boxes: "box",
  heads: "head", cloves: "clove", containers: "container", bottles: "bottle",
  packages: "package", packets: "packet", cartons: "carton", loaves: "loaf",
  blocks: "block", wedges: "wedge", pints: "pint", quarts: "quart",
  gallons: "gallon", sticks: "stick", ears: "ear", slices: "slice",
  // WS9 BUG-216 — "count" is how a PACK states a countable size; "each" is how
  // a NEED states one. Without this row the two never meet: packSizeHint reads
  // "1 package (12 count)" as {12, "count"}, rule 3 compares it against a need
  // unit of "each", they differ, packsToCoverNeed returns null and the stored
  // pack prints verbatim — corn tortillas, need 36 each, "1 package" on the
  // shelf-side of the line when the answer is 3.
  //
  // Same class as `fl oz: "oz"` above and not the plural-folding the rest of
  // this table does: two spellings the live data genuinely uses for one unit.
  count: "each",
  // WS9 BUG-332 (W2) — the ABBREVIATED spellings of the same thing. BUG-216
  // added `count` and the live data also writes `ct`: "1 package (10 ct)" and
  // "1 box (12 ct)" sat unrelatable beside "1 package (12 count)", which
  // resolved. Two of the census's under-orders are exactly this — 12 tortillas
  // against a 10-ct package printed one package.
  //
  // Measured on the B3 after-state: 6 distinct count-sized packs, 19 rows; 4 of
  // the packs already resolved through `count`, and adding these three rows
  // moves 3 rows and nothing else.
  ct: "each",
  cnt: "each",
  ea: "each",
};

export function normalizeUnitToken(unit: string | null | undefined): string {
  const s = (unit ?? "").trim().toLowerCase();
  return UNIT_ALIASES[s] ?? s;
}

/**
 * WS9 BUG-117 — the unit set the grocery-row editor offers as one-tap chips.
 *
 * Hans's report: "the unit control offered `each` rather than a real unit
 * set." The control was a bare free-text box, so `each` (the add-path default
 * in performAdd) was simply whatever happened to be sitting in it.
 *
 * 🔴 INVARIANT: every entry must ALREADY be canonical — normalizeUnitToken(u)
 * === u. Putting "lbs" or "pounds" in this list would write a non-canonical
 * spelling into quantityUnit, and composePackName's rules compare NORMALIZED
 * tokens: the row would then read differently from an identical one typed as
 * "lb". lib/__tests__/grocery-format.test.ts guards this.
 *
 * Free text stays available in the editor — these are the fast path, not a
 * whitelist. "each" leads because it is the count unit BUG-141 needs when a
 * catalog row arrives packed by weight.
 */
export const GROCERY_UNIT_OPTIONS: readonly string[] = [
  "each",
  "lb",
  "oz",
  "g",
  "kg",
  "cup",
  "tbsp",
  "tsp",
  "ml",
  "l",
  "bunch",
  "clove",
  "head",
  "can",
  "jar",
  "bottle",
  "bag",
  "box",
  "package",
  "container",
];

// WS9 BUG-143 — weight unit → grams.
//
// ⚠️ SOURCE OF TRUTH IS SERVER-SIDE: artifacts/api-server/src/lib/
// ingredientConversions.ts, `WEIGHT_UNIT_TO_GRAMS`. These two numbers are
// DUPLICATED here deliberately, matching the hand-synced-mirror precedent every
// cross-package contract in lib/api/* already carries (see lib/api/builder.ts,
// lib/api/cooking.ts): the mobile package does not import api-server, and a
// shared package for two constants is not worth its own build graph. If the
// server table changes, change this one.
//
// WHY IT IS NEEDED HERE AT ALL: the factor is not missing from the project — it
// was left behind. BUG-125 and Root A moved the order-line arithmetic
// client-side, and packsToCoverNeed arrived with no numeric table, so a need in
// `oz` against a pack in `lb` related to nothing and printed the pack verbatim.
//
// ⚠️ SCOPE: WEIGHT ONLY, and that is the whole point. A pound is 16 ounces for
// cheese and for beef alike, so weight↔weight is the ONE cross-unit conversion
// that needs no per-ingredient data. `tsp`→container, `tbsp`→bottle and
// `cup`→bunch each need a density this table cannot supply and are correctly
// left unrelatable. Nothing volumetric is served from here.
//
// Only the four CANONICAL tokens are listed: normalizeUnitToken runs first and
// has already folded ounce/ounces→oz, pound/pounds/lbs→lb, gram(s)→g,
// kilogram(s)→kg. The server's table spells all fifteen because it has no
// normalizer in front of it.
const WEIGHT_UNIT_TO_GRAMS: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

// WS9 BUG-147 — volume unit → millilitres. The exact counterpart of the weight
// table above and it carries the same argument: a quart is four cups for stock
// and for milk alike, so volume↔volume is the second (and last) cross-unit
// conversion that needs NO per-ingredient data.
//
// ⚠️ IT DOES NOT CROSS THE SYSTEMS. Relating ml to grams needs a DENSITY, which
// is per-ingredient and lives server-side. The server's own packMagnitude
// (groceryMerge.ts) can do volume→grams only because it is handed an
// IngredientConversion; the client is never sent one, so weight↔volume stays
// correctly unrelatable here rather than being guessed at.
//
// Canonical tokens only — normalizeUnitToken runs first and has already folded
// liters→l, cups→cup, tablespoon→tbsp, quarts→quart.
const VOLUME_UNIT_TO_ML: Record<string, number> = {
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  cup: 236.5882365,
  pint: 473.176473,
  quart: 946.352946,
  gallon: 3785.411784,
};

/**
 * How many `to` units make one `from` unit, when BOTH sit in the same measuring
 * system. Null when they do not — different systems, or a unit in neither table
 * (a "can" relates to an "oz" only through data the client does not hold).
 * Identical units return 1 without consulting either table, so a count unit
 * ("each", "clove") still relates to itself.
 */
function sameSystemRatio(from: string, to: string): number | null {
  if (from.length > 0 && from === to) return 1;
  for (const table of [WEIGHT_UNIT_TO_GRAMS, VOLUME_UNIT_TO_ML]) {
    const f = table[from];
    const t = table[to];
    if (f !== undefined && t !== undefined) return f / t;
  }
  return null;
}

/**
 * The pack's own count, read off the front of `purchaseDisplay` ("1.5 lb pack"
 * → 1.5). Read from the display rather than threading `purchaseQuantity`
 * through a sixth parameter: the Phase 0 audit found the display's leading
 * number and the `purchaseQuantity` column agree on **all 1,308 live rows that
 * carry both**, and they cannot disagree on any path that writes them together.
 */
function packLeadingQuantity(purchaseDisplay: string): number | null {
  const m = /^\s*([\d.]+)\s+/.exec(purchaseDisplay);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The measured unit the display LEADS with, when it has one: "1 lb block" →
 * "lb". Null when the leading noun is a container ("1 can (14.5 oz)" → "can"),
 * which is the common case and is served by the parenthetical instead.
 *
 * WS9 BUG-147. The precedent is the server's own packMagnitude
 * (groceryMerge.ts), which tries the leading token AND the parenthetical and
 * keeps whichever yields a real magnitude. Read as a reference only — that
 * function needs an IngredientConversion to do volume→grams and lives in the
 * other package, so nothing is imported across the boundary.
 *
 * Only a MEASURED unit is returned. The leading count of a container pack is
 * already handled by packLeadingQuantity, and returning "can" here would let
 * a container masquerade as a measurement.
 */
function packLeadingMeasuredUnit(purchaseDisplay: string): string | null {
  const m = /^\s*[\d.]+\s+([a-zA-Z]+)(?:\s+(?!each\b)([a-zA-Z]+))?/.exec(
    purchaseDisplay,
  );
  if (!m) return null;
  // Two-word form first ("16 fl oz"), then the single word. "1 lb block" must
  // fall back: its second word is the CONTAINER noun, not part of the unit, and
  // trying only the greedy form read "lb block" and matched nothing.
  const candidates = m[2] ? [`${m[1]} ${m[2]}`, m[1]] : [m[1]];
  for (const raw of candidates) {
    const unit = normalizeUnitToken(raw);
    if (
      WEIGHT_UNIT_TO_GRAMS[unit] !== undefined ||
      VOLUME_UNIT_TO_ML[unit] !== undefined
    ) {
      return unit;
    }
  }
  return null;
}

/**
 * "1 can (14.5 oz)" → 14.5 oz per pack. Null when there is no size in parens.
 *
 * WS9 BUG-147 — the unit may be TWO words. The single-word capture read
 * "1 container (16 fl oz)" as the unit "fl", which normalises to nothing and
 * left the row unrelatable, so it printed one container against any need. The
 * optional second word is guarded against "each", so "(14.5 oz each)" still
 * reads "oz" and lets the trailing (?:each)? consume the rest.
 */
/**
 * WS9 BUG-332 (W1) — A RANGED PACK SIZE READS AS ITS LOWER BOUND.
 *
 * "1 bag (5-6 oz)", "1 box (12-13 oz)", "1 container (4-5 oz)". The single
 * `[\d.]+` capture could not match across the dash, so the whole hint failed
 * and the pack printed verbatim however much the week wanted — 8 oz of kettle
 * chips against a 5-6 oz bag ordered one bag.
 *
 * ⚠️ THE LOW FIGURE, AND THAT IS R2. Hans: "I don't want users to not have
 * enough." A pack stated as a range might be either end, so the conservative
 * reading is the SMALLER pack — it needs more of them to cover the need.
 * Reading 5-6 oz as 6 would order one bag for an 8-oz need; reading it as 5
 * orders two. Over-ordering against a ranged pack is the accepted trade, the
 * same one BUG-125 accepted for a bogus stored pack.
 *
 * Measured on the B3 after-state: 10 distinct ranged packs over 22 rows. Eight
 * of them are already decided by another rule (a count need against a bunch, a
 * weight need against a weight pack), so this moves exactly 2 rows.
 */
const RANGE_LOW = new RegExp(`^\\s*(${PACK_NUM})\\s*(?:-|–|—|to)\\s*${PACK_NUM}\\s*$`);

function packSizeHint(purchaseDisplay: string): { amt: number; unit: string } | null {
  const m = new RegExp(
    `\\(\\s*~?\\s*(${PACK_NUM}(?:\\s*(?:-|–|—|to)\\s*${PACK_NUM})?)\\s*([a-zA-Z]+(?:\\s+(?!each\\b)[a-zA-Z]+)?)\\s*(?:each)?\\s*\\)`,
  ).exec(purchaseDisplay);
  if (!m) return null;
  const raw = m[1].trim();
  const range = RANGE_LOW.exec(raw);
  const amt = parseFloat(range ? range[1] : raw);
  return Number.isFinite(amt) && amt > 0 ? { amt, unit: m[2] } : null;
}

/**
 * How many packs cover the need. Null when nothing in the data can relate the
 * need's unit to the pack — the caller then leaves the pack exactly as stored.
 * Never returns 0: half a pound of beef still means buying one pack.
 */
function packsToCoverNeed(
  need: number,
  packQuantity: number,
  needUnit: string,
  packUnit: string,
  purchaseDisplay: string,
): number | null {
  if (!(need > 0) || !(packQuantity > 0)) return null;
  const nu = normalizeUnitToken(needUnit);
  const pu = normalizeUnitToken(packUnit);
  // 1. Same unit on both sides — pure arithmetic. The epsilon is load-bearing:
  //    without it a need of exactly one pack can ceil to two on float noise.
  if (nu.length > 0 && nu === pu) {
    return Math.max(1, Math.ceil(need / packQuantity - PACK_EPSILON));
  }
  // 2. WS9 BUG-143 — both sides are WEIGHT units in different spellings. Grams
  //    relate them outright, with no per-ingredient data: 8 oz of Cotija
  //    against a "1 lb block" is one block. Before this the pair fell through
  //    to rule 3 and the pack printed verbatim whatever the need — the same
  //    Root A failure, one unit-pair short of being caught.
  //    Placed ahead of the size hint on purpose: a direct weight relation is
  //    exact, while the hint is parsed out of authored display prose. (No live
  //    row is decided by that ordering today — every weight↔weight row's pack
  //    carries no parenthetical size — but the precedence should not depend on
  //    that staying true.)
  //    WS9 BUG-147 widens this from weight-only to "the same measuring
  //    system", so a pack unit that is itself volumetric ("1 quart") relates
  //    to a need in cups on the same argument.
  //    The pack unit may be a container noun while the DISPLAY states the
  //    real measurement up front ("1 lb block", purchaseUnit "block"). Fall
  //    back to that, so 20 oz of cotija against a 1 lb block is two blocks
  //    rather than the one it printed before.
  const measuredPackUnit =
    sameSystemRatio(nu, pu) !== null
      ? pu
      : (packLeadingMeasuredUnit(purchaseDisplay) ?? pu);
  const packRatio = sameSystemRatio(nu, measuredPackUnit);
  if (packRatio !== null) {
    return Math.max(
      1,
      Math.ceil((need * packRatio) / packQuantity - PACK_EPSILON),
    );
  }
  // 3. The display names a size the need can be measured against.
  //    WS9 BUG-147 — this required the hint unit to EQUAL the need unit, so
  //    "1 bottle (1 quart)" against a need in cups fell through to rule 4 and
  //    printed one bottle however much the week wanted. Same-SYSTEM is the
  //    right test, not same-spelling: a quart is four cups for every
  //    ingredient, exactly as a pound is sixteen ounces.
  const hint = packSizeHint(purchaseDisplay);
  const hintRatio = hint
    ? sameSystemRatio(nu, normalizeUnitToken(hint.unit))
    : null;
  if (hint && hintRatio !== null) {
    return Math.max(
      1,
      Math.ceil((need * hintRatio) / (packQuantity * hint.amt) - PACK_EPSILON),
    );
  }
  // 4. Needs a container→measure factor nothing supplies. Out of scope.
  //
  // ── 🔴 WS9 BUG-332 — DO NOT READ A PARENTHETICAL `oz` AS FLUID OUNCES ─────
  //
  // This is where 315 corpus rows land: a volumetric need ("½ cup") against a
  // pack whose parenthetical says plain "oz". The obvious-looking fix is to
  // treat that `oz` as FLUID oz when the need is volumetric, which relates them
  // and empties this branch. It was measured and REFUSED (ruled 2026-09-29).
  //
  // `oz` in a pack parenthetical is AMBIGUOUS and the string does not say which
  // it is. The overwhelming majority of those 315 rows are weight-labelled
  // SOLIDS — "1 container (2.6 oz) smoked paprika", "1 bag (8 oz) sliced
  // almonds", "1 block (8 oz) cheddar". Reading them as fluid ounces produces:
  //
  //     1 bag (5 oz) mixed salad greens, need 4 cup   ->  SEVEN bags
  //     1 bag (5 oz) shredded iceberg, need 2 cup     ->  four bags
  //     1 container (8.8 oz) cooked rice, need 4 cup  ->  four containers
  //     1 wedge (6 oz) Parmesan, need 1 cup           ->  two wedges
  //
  // And R2 does NOT rescue it. Misreading weight as volume errs in BOTH
  // directions: it understates the pack for anything fluffier than water (the
  // seven bags) and OVERSTATES it for anything denser — honey, molasses, syrup
  // — which under-orders, the failure Hans ruled worst. It over-orders on
  // today's corpus because of what happens to be on it, not because of a rule.
  //
  // The datum that settles fl-oz vs weight-oz is per-ingredient and the server
  // holds it (`Ingredient.packYield*`). The client is not sent it, and does not
  // need to be: the B4 lane sends the finished `packCount` instead, which is
  // consulted ABOVE this whole function (see renderedPack). A row that arrives
  // with a packCount never reaches this branch at all.
  //
  // lib/__tests__/grocery-format.test.ts pins this null.
  return null;
}

/** Pack counts keep the display's own decimal style — glyphs are the NEED's convention. */
function formatPackAmount(n: number): string {
  return String(parseFloat(n.toFixed(4)));
}

// ── [grocery] F (F5.3) — HOW MANY OF THE FOOD ONE PACK HOLDS, WHEN IT SAYS ──
//
// Only the BARE forms: a count word with no noun after it. See the call site in
// composePackName for why a noun-bearing hint ("(4 sticks)", "(6 rolls)") must
// never reach the pluraliser.
const DOZEN = 12;
const BARE_COUNT_PAREN = /\(\s*(\d+)\s*(?:count|ct|cnt)\s*\)/i;

/** "1 dozen" → 12 · "1 package (12 count)" → 12 · "1 lb pack (4 sticks)" → null. */
function packItemCount(purchaseDisplay: string): number | null {
  const bare = BARE_COUNT_PAREN.exec(purchaseDisplay);
  if (bare) {
    const n = parseInt(bare[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (/(^|[^a-z])dozens?([^a-z]|$)/i.test(purchaseDisplay)) {
    const lead = packLeadingQuantity(purchaseDisplay) ?? 1;
    return DOZEN * lead;
  }
  return null;
}

// ── [grocery] F (F5.4) — THE PACK'S OWN COUNT TAKES A GLYPH ────────────────
//
// Hans's device pass: "`0.5 lb pack ground pork` should read `½ lb`, using
// glyphs as everywhere else."
//
// The need parenthetical has used glyphs since WS7-8b (`formatNeedGlyph`) and
// the pack half never did, because `scalePackDisplay` — the one place that
// rewrites the number — returns the stored string UNTOUCHED at one pack, and a
// sub-one pack is always one pack. So "0.5 lb pack", "1.5 lb pack" and
// "2.5 lb bag" printed their raw decimals: 28 rows on the f0 corpus.
//
// ⚠️ APPLIED AT RENDER, LAST, AND NEVER PERSISTED. This runs on the string
// about to be shown, after every arithmetic step has read the display. That
// ordering is load-bearing: `packLeadingQuantity` parses "2.5 lb" with a regex
// that a glyph would defeat, so glyphing earlier would silently stop the pack
// scaling. The same discipline the need half has always kept — the stored
// `purchaseQuantity` is still 2.5.
//
// ⚠️ THE LEADING NUMBER ONLY. A parenthetical size is authored prose in the
// catalog's own voice ("(14.5 oz)", "(1 quart / 32 oz)", "(10.5 oz each)") and
// is left exactly as written; rewriting it would be editing the catalog's copy
// at render. `formatNeedGlyph` is reused rather than a second ladder.
function glyphPackDisplay(purchaseDisplay: string): string {
  return purchaseDisplay.replace(/^(\s*)(\d+(?:\.\d+)?)(\s)/, (all, lead, num, gap) => {
    const n = parseFloat(num);
    if (!Number.isFinite(n) || n <= 0) return all;
    // formatNeedGlyph is LOSSLESS by construction: off its ladder it returns
    // `String(qty)`, so "1.7 lb" comes back "1.7 lb". No branch is needed and
    // no number is ever rounded here — this only swaps a decimal for the glyph
    // that means the same thing.
    return `${lead}${formatNeedGlyph(n)}${gap}`;
  });
}

/**
 * Rewrite the display's leading count to the scaled TOTAL and pluralize the
 * pack noun: "1 lb" ×2 → "2 lb" · "1 bunch" ×3 → "3 bunches" ·
 * "1 can (14.5 oz)" ×4 → "4 cans (14.5 oz)". At one pack the stored string is
 * returned untouched, so the no-scaling case stays byte-identical.
 */
/**
 * Make a pack label's HEAD NOUN agree with a count: "container (5 oz)" at 3
 * is "containers (5 oz)"; "cans (15 oz)" at 1 is "can (15 oz)". Only the
 * first token moves — the parenthetical size and any qualifier after it are
 * returned untouched.
 *
 * WS9 BUG-240 follow-up. This lived inline in scalePackDisplay, which does the
 * number rewrite AND the plural in ONE operation. The override path needs the
 * second without the first: overriding the purchase quantity bypasses
 * BUG-147's arithmetic (a user-set pack is not derived) but must not bypass
 * grammar, or a quantity-only override renders "3 container (5 oz)".
 * EXTRACTED rather than duplicated, so the two call sites cannot disagree.
 *
 * Both directions come from the maps that already exist — pluralizeNeedUnit
 * forward, singularizeNoun back (itself derived from COUNT_NOUN_PLURALS,
 * BUG-144) — so no second pluraliser is introduced. Measure units pass
 * through both ways, which is why "1 lb block" and "3 lb block" are both
 * left alone.
 *
 * ⚠️ The singular branch is UNREACHABLE from scalePackDisplay: it returns
 * early at packs <= 1, so its total is always >= 2. The extraction is
 * therefore behaviour-preserving for the derived path — guard (c) pins it.
 */
function agreePackLabel(label: string, count: number): string {
  const m = /^(\s*)(\S+)([\s\S]*)$/.exec(label);
  if (!m) return label;
  const [, lead, noun, rest] = m;
  const agreed =
    count === 1 ? singularizeNoun(noun) : pluralizeNeedUnit(noun, count);
  return `${lead}${agreed}${rest}`;
}

function scalePackDisplay(
  purchaseDisplay: string,
  packs: number,
  packQuantity: number,
): string {
  if (packs <= 1) return purchaseDisplay;
  const m = /^(\s*)([\d.]+)(\s+)(\S+)([\s\S]*)$/.exec(purchaseDisplay);
  if (!m) return purchaseDisplay;
  const [, lead, , gap, noun, rest] = m;
  const total = packs * packQuantity;
  // The same count-noun map the need parenthetical uses, so the two halves of
  // the line cannot pluralize differently. Measure units pass through.
  return `${lead}${formatPackAmount(total)}${gap}${agreePackLabel(noun + rest, total)}`;
}

// Pack + name, composed into the order half of the two-part line. `needAmount`
// / `needUnit` are the RAW need (quantityAmount / quantityUnit) — the same
// values the parenthetical is built from, never a formatted string. Omitting
// them yields the pre-BUG-125 behaviour verbatim, so a caller that has no need
// in hand degrades to the old output rather than to a wrong number.
/**
 * WS9 BUG-240 — the USER-SET purchase. `quantity` is the leading number,
 * `display` is the pack string WITHOUT it ("containers (5 oz)", "big bunch").
 * Either may be set alone. Both absent = the row is derived, exactly as
 * before.
 */
export interface PurchaseOverride {
  quantity?: number | null;
  display?: string | null;
}

/**
 * The DERIVED pack string — the stored display, scaled by BUG-147's
 * arithmetic to cover the need. Extracted so the override branch and Rule 2
 * read the same number: a user who overrides only the LABEL must keep the
 * quantity that was on screen, which is the scaled one, not the stored one.
 */
function derivedPackDisplay(
  purchaseDisplay: string,
  need: number | null,
  nUnit: string,
  pUnit: string,
): string {
  const packQuantity = packLeadingQuantity(purchaseDisplay);
  const packs =
    need !== null && packQuantity !== null
      ? packsToCoverNeed(need, packQuantity, nUnit, pUnit, purchaseDisplay)
      : null;
  return packs !== null && packQuantity !== null
    ? scalePackDisplay(purchaseDisplay, packs, packQuantity)
    : purchaseDisplay;
}

/**
 * WS9 BUG-240 — what the purchase editor's two fields start out holding.
 *
 * Exported so the SEED and the RENDER cannot drift: both go through
 * derivedPackDisplay / packLeadingQuantity / packResidue, so the number the
 * user is handed is the number they were looking at, and the label is the
 * stored pack string minus its leading count using the SAME regex the
 * renderer strips with — not a second one written to match.
 *
 * The asymmetry is deliberate and guard (a) pins it: `quantity` comes from the
 * SCALED display (what is on screen), `label` from the STORED one (which has
 * not been pluralised).
 */
export function purchaseEditorSeed(
  purchaseUnit: string | null | undefined,
  purchaseDisplay: string | null | undefined,
  needAmount?: string | number | null,
  needUnit?: string | null,
  override?: PurchaseOverride,
): { quantity: string; label: string } {
  const need = resolveNeed(needAmount);
  const nUnit = (needUnit ?? "").trim().toLowerCase();
  const pUnit = (purchaseUnit ?? "").trim().toLowerCase();
  const shown = purchaseDisplay
    ? derivedPackDisplay(purchaseDisplay, need, nUnit, pUnit)
    : "";
  const ovrQty = override?.quantity;
  const ovrLabel = override?.display;
  const quantity =
    ovrQty !== undefined && ovrQty !== null
      ? ovrQty
      : (packLeadingQuantity(shown) ?? 1);
  const label =
    ovrLabel !== undefined && ovrLabel !== null && ovrLabel.trim().length > 0
      ? ovrLabel.trim()
      : packResidue(purchaseDisplay ?? "");
  return { quantity: formatPackAmount(quantity), label };
}

/** The purchase editor's three fields, as the strings the inputs hold. */
export interface PurchaseEditorFields {
  quantity: string;
  label: string;
  name: string;
}

/**
 * The body of the item PATCH a purchase edit produces. Wire keys, not column
 * names: the server maps `purchaseQuantity` / `purchaseDisplay` onto the
 * *Override columns (groceryLists.ts). A key that is ABSENT leaves the column
 * alone; `null` clears it; a value sets it.
 */
export interface PurchaseEditorPatch {
  purchaseQuantity?: number | null;
  purchaseDisplay?: string | null;
  displayName?: string;
}

/**
 * WS9 BUG-240 follow-up — what a purchase edit SENDS, decided field by field
 * against what the editor SEEDED.
 *
 * The first cut sent every field on every commit, so a label the user never
 * touched — the seeded residue, "medium white onion" — was persisted as
 * `purchaseDisplayOverride`. A stored label renders verbatim (guard g: no
 * elide, no plural), which is exactly right for a label the user typed and
 * exactly wrong for one they were merely shown: every one of the 12 override
 * rows live on Sept 10 carried its own seed as an override.
 *
 * So: a field UNCHANGED from its seed is not sent (the column keeps whatever
 * it holds — nothing, or an override the user set earlier and was shown
 * again). A field EMPTIED is sent as `null`, which clears the override. A
 * field CHANGED is sent as its value. Comparison is on the trimmed strings
 * the inputs hold, the same normalisation the seed applied.
 *
 * The quantity gets the same three-way treatment, for the same reason: an
 * unchanged number is the derived one, and pinning it as an override would
 * stop the row re-deriving when the need changes. A changed quantity that
 * does not parse to a positive number is sent as `null` — the pre-existing
 * rule (a nonsense number clears rather than persists).
 *
 * The name never sends `null`: the row renders `userResolvedTo ?? name`, and
 * an empty box means "leave it alone", not "blank the row" (BUG-117 (3)).
 */
export function purchaseEditorPatch(
  seed: PurchaseEditorFields,
  edited: PurchaseEditorFields,
): PurchaseEditorPatch {
  const patch: PurchaseEditorPatch = {};
  const qty = edited.quantity.trim();
  if (qty !== seed.quantity.trim()) {
    const parsed = qty.length > 0 ? parseQuantity(qty) : null;
    patch.purchaseQuantity = parsed !== null && parsed > 0 ? parsed : null;
  }
  const label = edited.label.trim();
  if (label !== seed.label.trim()) {
    patch.purchaseDisplay = label.length > 0 ? label : null;
  }
  const name = edited.name.trim();
  if (name.length > 0 && name !== seed.name.trim()) {
    patch.displayName = name;
  }
  return patch;
}

/**
 * The order line for a COUNTED row — the pack and the need are both counts
 * (or there is no pack at all), so the line is a number and a noun. This is
 * Rule 1's body, extracted so the quantity-only override can run it with
 * the user's count in place of the need's: a quantity edit changes the
 * number and the plural and NOTHING else, so the override title at a count
 * must equal the derived title at that count.
 *
 * WS9 BUG-240 follow-up. The override branch used to build its line from the
 * residue + name + elide, which is Rule 2's shape. Rule 1 does not print the
 * residue when it fails to name the item — it prints the NAME, counted —
 * and so "1 medium white onion" against "White onion" rendered "1 White
 * onion" derived but "2 medium white onion White onion" overridden.
 */
function countedPackTitle(residue: string, name: string, q: number): string {
  const count = formatPackAmount(q);
  if (residueNamesItem(residue, name)) {
    // WS9 Root D — at a count of exactly 1 the stored residue is still the
    // pack's own plural ("2 lemons" -> "lemons"), so swapping the count in
    // front of it reads "1 lemons". The ingredient NAME is authored singular
    // in 22 of the 23 live rows, so prefer it. No stemmer: a name that is
    // itself plural ("roma tomatoes") has no singular to fall back to and
    // stays plural - one live row, accepted rather than stemmed.
    // No `!isPluralWord(name)` guard here: mutation testing proved it dead.
    // This branch only runs when the residue already NAMES the item, so the
    // fallback IS the name — for a plural name ("roma tomatoes") both sides
    // return the same string, and the extra condition could never change an
    // output. Deleted rather than left as reassuring-looking dead code.
    if (q === 1 && isPluralWord(lastWord(residue))) {
      return `1 ${name}`;
    }
    // WS9 BUG-149 — the MIRROR of the line above, and it shipped for the same
    // reason Root D's own defect did: the guard was written for one count and
    // the opposite count was never tried. The comment above assumes the
    // stored residue is "authored and correctly pluralized", which holds for
    // "4 roma tomatoes" and fails flat for a pack authored SINGULAR: "1
    // apple" against a need of 2 printed "2 apple" (live, list 93a03e23).
    // PRE-EXISTING, not a BUG-144 regression — verified byte-identical on the
    // pre-BUG-144 commit; BUG-144 only ever touched the two branches that do
    // NOT reuse the residue.
    //
    // ⚠️ NO `q > 1` AND NO `!isPluralWord(residue)` GUARD, and both omissions
    // are mutation-proved rather than assumed. The first draft carried both;
    // deleting either left the suite fully green, because
    // pluralizeIngredientName ALREADY declines in exactly those two cases —
    // it no-ops at quantity <= 1, and pluralizeNoun no-ops on a word
    // isPluralWord already calls plural. Guarding here restated a condition
    // the callee enforces, which reads as protection while pinning nothing.
    // The one thing that IS load-bearing is routing the residue through the
    // pluraliser at all; Break K (reverting to a bare `residue`) is red.
    return `${count} ${pluralizeIngredientName(residue, q)}`;
  }
  // WS9 BUG-144 — the branch Root D did not cover. Here the residue does NOT
  // name the item (or there is no pack), so there is no authored-singular
  // fallback and the NAME itself carries the plural ("garlic cloves" against
  // "1 head of garlic"). countedName singularises it at exactly 1 and
  // pluralises above it.
  return `${count} ${countedName(name, q)}`;
}

export function composePackName(
  name: string,
  purchaseUnit: string | null | undefined,
  purchaseDisplay: string | null | undefined,
  needAmount?: string | number | null,
  needUnit?: string | null,
  isPantryStaple?: boolean,
  override?: PurchaseOverride,
): string {
  // ── WS9 BUG-171 — a pantry staple states the NEED, never a pack ──────────
  // Ruled (Hans, Aug 27 2026), Option A: "Kosher salt · Pantry Staple ·
  // (11 teaspoon)", with no "1 container (26 oz)". Rationale, which generalises
  // past this fix: users buy staples in bulk or a little at a time, so pack size
  // is THEIR purchasing decision. The list's job for a staple is to say what the
  // week needs; the need parenthetical (rendered as its own sibling at the call
  // site) carries that, so the order half collapses to the bare name.
  //
  // ⚠️ FIRST, above every pack rule: a staple takes no pack branch at all, so
  // no scaling, elide or plural decision below can reintroduce one.
  //
  // ⚠️ Applies to BOTH staple states, opted-in and not. Opting in means "I'll
  // check my pantry", not "now sell me a container" — and gating on the
  // opted-in flag alone would make the line change shape on tap.
  //
  // ⚠️ This does NOT close BUG-147. Stock, broth and milk are not staples: they
  // still render packs and still under-order a volume need against a container
  // pack. That class survives, it merely stops being visible on staples.
  //
  // The name is returned untouched. A legacy row whose NAME has a pack baked in
  // ("1 head Garlic") still shows it — that is a stored-data shape, the same one
  // NAME_LEADS_WITH_NUMBER concedes to in Rule 3, not a composition this makes.
  if (isPantryStaple) return name;

  const need = resolveNeed(needAmount);
  const nUnit = (needUnit ?? "").trim().toLowerCase();
  const pUnit = (purchaseUnit ?? "").trim().toLowerCase();
  // A unitless need is a bare count, same as "each".
  const needIsCount = nUnit === "each" || nUnit === "";

  // ── WS9 BUG-240 — a USER-SET purchase is NOT derived ─────────────────────
  // Hans, Sept 10: "users shouldn't need to or have a reason to edit the
  // needed quantities" — the need is read-only now and the PURCHASE is what
  // the user controls. So when either override is present this row stops
  // being a derivation: BUG-147's scaling is bypassed entirely, and the
  // user's own string is rendered verbatim.
  //
  // ⚠️ NO pluralisation. scalePackDisplay does the number rewrite AND the
  // count-noun plural in one step, and bypassing it bypasses both — so a
  // quantity-only override can read "3 container". That is the ruled
  // trade: Hans owns the string, and the app must not rewrite it under him.
  //
  // ⚠️ NO warning and NO colour when the purchase disagrees with the need.
  // Hans: "it's ok to have a disagreement in the UI between the need and
  // the purchase. a user can know they're buying a different ingredient."
  //
  // Staples are ABOVE this, so an overridden staple still renders name-only
  // (BUG-171) — a staple has no pack to override.
  const ovrQty = override?.quantity;
  const ovrLabel = override?.display;
  const hasOverride =
    (ovrQty !== undefined && ovrQty !== null) ||
    (ovrLabel !== undefined && ovrLabel !== null && ovrLabel.trim().length > 0);
  if (hasOverride) {
    // The two defaults come from DIFFERENT strings, and guard (a) is what
    // proved it. A LABEL-only override must keep the quantity that was on
    // SCREEN — the derived, scaled one — because the user changed the word and
    // not the count. But a QUANTITY-only override must take its label from the
    // STORED display, because the scaled one has already been pluralised:
    // reusing it rendered "1 containers (5 oz)".
    const shown = purchaseDisplay
      ? derivedPackDisplay(purchaseDisplay, need, nUnit, pUnit)
      : "";
    const qty = ovrQty ?? packLeadingQuantity(shown) ?? 1;
    const userLabel =
      ovrLabel !== undefined && ovrLabel !== null && ovrLabel.trim().length > 0
        ? // The user's own string is NEVER touched — not pluralised, not
          // stripped, not rescaled.
          ovrLabel.trim()
        : null;
    if (userLabel === null) {
      // ── Quantity-only: the DERIVED title at the user's count ─────────────
      // WS9 BUG-240 follow-up. Ruled Sept 10: a quantity edit changes the
      // number and the plural and nothing else — so the line takes the SAME
      // shape the derived path would give at that count, per rule. Building
      // it from residue + name + elide (Rule 2's shape) for every row was
      // the bug: a counted row whose residue does not name the item prints
      // the NAME, not the residue, and the old branch printed both —
      // "2 medium white onion White onion", "3 avocados ripe avocado".
      if (needIsCount && (pUnit === "each" || !purchaseDisplay)) {
        // Rule 1 / Rule 3-count shape: a count and a noun.
        return countedPackTitle(packResidue(purchaseDisplay ?? ""), name, qty);
      }
      if (!purchaseDisplay) {
        // Rule 3-measure shape: the need's unit rides along, pluralised by the
        // same helper — "2 cups flour" overridden to 3 is "3 cups flour",
        // not "3 flour".
        return `${formatPackAmount(qty)} ${pluralizeNeedUnit(nUnit, qty)} ${name}`;
      }
      // Rule 2 shape: a real container. The derived label agrees with the
      // override count — grammar only, none of the scaling path. Same stored
      // string gives "1 container (5 oz)" and "3 containers (5 oz)".
      const residue = packResidue(purchaseDisplay);
      const head = `${formatPackAmount(qty)} ${agreePackLabel(residue, qty)}`;
      return residueNamesItem(residue, name) ? head : `${head} ${name}`;
    }
    const head = `${formatPackAmount(qty)} ${userLabel}`;
    // The presentation elide survives: a label that already names the item
    // ("roma tomatoes") would otherwise print the name twice. This is not a
    // scaling step — it is the same dedupe the derived path does.
    return residueNamesItem(userLabel, name) ? head : `${head} ${name}`;
  }

  // ── Rule 3: no pack ──────────────────────────────────────────────────────
  if (!purchaseDisplay) {
    if (need === null) return name; // genuine unknown → bare name
    if (NAME_LEADS_WITH_NUMBER.test(name)) return name; // legacy baked-in pack
    if (needIsCount) {
      // Discrete items round UP: you cannot buy 2½ onions, and rounding down
      // under-orders. (roundNeedQuantity already ceils counts server-side;
      // this is the belt for the rows that predate it.)
      const q = Math.ceil(need - 1e-9);
      // BUG-144 — countedName, not pluralizeIngredientName: a name authored
      // plural ("Carrots") against a need of 1 read "1 Carrots" here too.
      // No residue to consider, so this is countedPackTitle's name branch.
      return countedPackTitle("", name, q);
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
  // F2 — the hint, not the head, was naming the food. The name is about to be
  // printed, so the hint has nothing left to do and would only say it twice.
  const hintWasTheName = parentheticalNamedItem(residue, name);

  // ── Rule 1: both units are the count unit → the pack is meaningless ──────
  // The body lives in countedPackTitle (BUG-240 follow-up) so the quantity-only
  // override can produce the same line at the user's count. Root D, BUG-149
  // and BUG-144 are all in there, with their notes.
  if (pUnit === "each" && needIsCount && need !== null) {
    return countedPackTitle(residue, name, Math.ceil(need - 1e-9));
  }

  // ── Rule 2: the units differ → a real container, used as stored ──────────
  // WS9 Root A — scale the container to cover the need. Returns the stored
  // display untouched whenever the need and the pack cannot be related.
  const derived = derivedPackDisplay(purchaseDisplay, need, nUnit, pUnit);
  // F2 — drop the hint that was doing the naming; F5.4 — glyph the count.
  const display = glyphPackDisplay(
    hintWasTheName ? stripParentheticals(derived) : derived,
  );

  // ── [grocery] F Part E (E4.2) — AN ELIDED COUNT PACK AGREES WITH ITS COUNT ──
  //
  // "3 medium white onion (2¼ cup)" is the RENDERED line, not the stored pack:
  // the pack is "3 medium white onion", the elide fires because the residue
  // names the item, and the residue is returned verbatim. A user sees it.
  //
  // Rule 1 already agrees a counted title with its count (countedPackTitle), but
  // Rule 1 needs the NEED to be a count too. This row's need is 2¼ CUP against a
  // pack of 3 each, so it lands here instead, where nothing was inflecting it.
  //
  // ⚠️ GATED ON THE PACK UNIT BEING A COUNT, and that gate is load-bearing.
  // D-WS9-292 now renders weights through this same branch — "2 lb beef chuck
  // roast", "3 lb boneless beef chuck roast", "2 lb boneless pork shoulder" all
  // elide, because the residue "lb beef chuck roast" contains the name. The
  // leading number there is a WEIGHT, not a count of roasts, and agreeing it
  // would print "2 lb beef chuck roasts". Measured on the corpus: 3 weight rows
  // would have been wrong and 1 count row was.
  if (packNamesItem) {
    const shownCount = packLeadingQuantity(display);
    if ((pUnit === "each" || pUnit === "") && shownCount !== null && shownCount > 1) {
      const head = packResidue(display);
      return `${formatPackAmount(shownCount)} ${pluralizeIngredientName(head, shownCount)}`;
    }
    return display;
  }
  // Pre-BUG-125 back-compat: with no need to decide with, an "each" pack whose
  // residue doesn't match the name is still dropped rather than guessed at.
  if (pUnit === "each" && need === null) return name;
  // ── [grocery] F (F5.3) — A PACK THAT STATES A BARE COUNT GOVERNS A PLURAL ──
  //
  // "1 dozen egg" (live, list 9c0a250e). The catalog's displayName for that row
  // is literally "egg", and Rule 2 prints "{display} {name}" verbatim — rightly,
  // because the count in front is a count of CONTAINERS, not of the food: one
  // package of butter is not four butters.
  //
  // A pack label that states a BARE COUNT is the exception, and the only one:
  // "dozen", "(12 count)", "(10 ct)" name no intermediate noun, so the number
  // they state IS a number of the food and the name must agree with it.
  //
  // ⚠️ A COUNT WITH A NOUN IS EXCLUDED, and this is the whole reason the rule
  // is written narrowly. "1 lb pack (4 sticks) unsalted butter" states four
  // STICKS; feeding 4 to the pluraliser yields "4 unsalted butters". So does
  // "(6 rolls)" on paper towels and "(~6 stalks)" on celery. Measured on the f0
  // corpus and the two device lists, the bare-count form moves exactly one row
  // — "1 dozen egg" → "1 dozen eggs" — and every noun-bearing hint is untouched.
  const items = packItemCount(purchaseDisplay);
  return `${display} ${items !== null ? pluralizeIngredientName(name, items) : name}`;
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
  isPantryStaple?: boolean,
): string {
  const packName = composePackName(
    name,
    purchaseUnit,
    purchaseDisplay,
    needAmount,
    needUnit,
    isPantryStaple,
  );
  const need = needText.trim();
  return need ? `${packName} (${need})` : packName;
}

// ── Row 8 Block 2 — the pack the row RENDERS, as numbers for an order line ──
//
// ARCHITECTURE RULING (chat-Claude, September 19, 2026, Hans un-objected): the
// pack-count arithmetic lives on the phone and is NOT ported to the server. The
// phone contributes the numbers it already renders; the server owns the
// Instacart contract. What the shopper reads on screen is what gets ordered.
//
// So this reads the SAME primitives composePackName renders with —
// packLeadingQuantity → packsToCoverNeed — and nothing else, and returns a
// NUMBER OF PACKS, never the displayed total. The server multiplies packCount
// by the row's stored per-pack size (instacartPayload.ts, rule 1): "1 can
// (14.5 oz)" shown as "3 cans (14.5 oz)" is packCount 3 × 1 can; "1.5 lb pack"
// shown as "3 lb pack" is packCount 2 × 1.5 lb. Sending the on-screen total
// would multiply twice.
//
// Null means "the phone has no derived pack for this row" and the caller OMITS
// packCount — the server's own precedence (override → stored pack → need →
// 1 each) is better informed than a guessed 1. The cases, each mirroring the
// branch composePackName takes for the same row:
//   • a pantry staple (BUG-171) renders no pack → null;
//   • a QUANTITY override (BUG-240) is the user's stated buy, shown verbatim
//     and NOT a derivation → null, and the server's rule 2 orders exactly that
//     number. ⚠️ It is not sent as packCount: the server's per-pack size for
//     an overridden row IS the override (`purchaseQuantityOverride ??
//     purchaseQuantity`), so packCount = override would order override²;
//     the server's own fixture sends override rows with no packCount;
//   • a LABEL-only override keeps the derived, scaled count on screen → the
//     derived packs, as for a plain row;
//   • no stored pack (Rule 3) → null; the server orders the need;
//   • the need and the pack cannot be related (packsToCoverNeed rule 4) → null.
//
// `packSizeText` is the display's parenthetical, parens included ("(14.5 oz)"),
// which is the shape the server's fixture carries and appends to its pack line.

export interface RenderedPack {
  /** Number of packs — an integer ≥ 1, NEVER the displayed total. */
  packCount: number;
  /** The parenthetical size off the stored display, parens included. */
  packSizeText?: string;
}

// ── 🔴 WS9 D-WS9-286 — THE SERVER'S PACK COUNT WINS, AND THE PARSER STOPS ───
//
// THE DEFECT THIS CLOSES (block C Part A, finding M1). `purchaseDisplay`'s
// leading number means two different things and nothing on the wire says which:
//
//     "1.5 lb pack"       -> 1.5 is the SIZE of one pack
//     "4 can (14.5 oz)"   -> 4 is the COUNT of packs the server already scaled to
//
// `packLeadingQuantity` documents itself as the first and `packsToCoverNeed`
// divides by it in both cases. `purchaseQuantity` carries the same ambiguity,
// so there was nowhere to look it up. Today the collision is invisible only
// because the client cannot relate any of the unit pairs the server scales on
// (head↔clove, can↔cup, pint↔ounce, lb-bag↔cup) — measured: every yield-bearing
// row with a container pack against a measured need returns null here. That is
// an accident of what the client can parse, not a guarantee, and widening the
// parser is what would have removed it.
//
// So the B4 lane sends the answer. `packCount` is the whole number of packs the
// SERVER computed for the summed need, through a pack yield, a sub-unit ladder
// or a same-unit comparison; `null` when it could not compute one.
//
// ⚠️ THE RULE IS ABSOLUTE: WHEN packCount IS PRESENT THE CLIENT USES IT AND
// NEVER PARSES THE DISPLAY. Parsing runs only when it is null. Consulting both
// and preferring one is the same collision wearing a tie-break, and a guard
// test asserts that a row with a packCount reaches no parse call.
//
// ⚠️ THE OVERRIDE AND STAPLE GATES STILL COME FIRST. A pantry staple renders no
// pack at all (BUG-171) and a quantity override is the user's stated buy, not a
// derivation (BUG-240) — neither is something the server's count can answer,
// and the server does not see the override when it computes.
//
// `packSizeText` still comes off the display either way: it is the
// parenthetical, not a number, and it is not what the ambiguity is about.

export interface RenderedPack {
  /** Number of packs — an integer ≥ 1, NEVER the displayed total. */
  packCount: number;
  /** The parenthetical size off the stored display, parens included. */
  packSizeText?: string;
  /** D-WS9-286 — true when this count came from the server, not from the
   *  display parser. Read by the tests and by the Instacart payload's note. */
  fromServer?: boolean;
}

export function renderedPack(
  purchaseDisplay: string | null | undefined,
  needAmount: string | number | null | undefined,
  needUnit: string | null | undefined,
  purchaseUnit: string | null | undefined,
  isPantryStaple?: boolean,
  override?: PurchaseOverride,
  serverPackCount?: number | null,
): RenderedPack | null {
  if (isPantryStaple) return null;
  const ovrQty = override?.quantity;
  if (ovrQty !== undefined && ovrQty !== null) return null;
  if (!purchaseDisplay) return null;
  const size = /\([^)]+\)/.exec(purchaseDisplay);
  const withSize = (packCount: number, fromServer: boolean): RenderedPack => ({
    packCount,
    ...(size ? { packSizeText: size[0] } : {}),
    ...(fromServer ? { fromServer: true } : {}),
  });
  // D-WS9-286 — the server's count, and no parse.
  if (
    serverPackCount !== undefined &&
    serverPackCount !== null &&
    Number.isFinite(serverPackCount) &&
    serverPackCount > 0
  ) {
    return withSize(Math.ceil(serverPackCount), true);
  }
  const need = resolveNeed(needAmount);
  const packQuantity = packLeadingQuantity(purchaseDisplay);
  if (need === null || packQuantity === null) return null;
  const nUnit = (needUnit ?? "").trim().toLowerCase();
  const pUnit = (purchaseUnit ?? "").trim().toLowerCase();
  const packs = packsToCoverNeed(need, packQuantity, nUnit, pUnit, purchaseDisplay);
  if (packs === null) return null;
  return withSize(packs, false);
}
