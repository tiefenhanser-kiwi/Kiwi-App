// Row 8 · Block 1 — the Instacart `name` field is a SEARCH TERM, not a label.
// Their matcher runs it against the catalog, so everything Kiwi's rows carry
// for a human reader — a baked pack prefix ("1 bottle (15 oz) lemon juice",
// 207 live rows), a spec parenthetical ("ground beef (80/20 chuck)", 166), a
// trailing prep clause ("white onion, roughly chopped", 105) — is noise that
// narrows or breaks the match. This strips exactly those three shapes and
// nothing else. Words that HELP search (canned / fresh / frozen / dried) stay;
// case is left alone (a brand word is a brand word). "or" alternatives
// ("chicken or vegetable broth", 10 rows) are NOT rewritten — R5 does not
// rule on them and either reading finds broth.
//
// Pure. The human line the shopper reads goes in `display_text` and is
// composed elsewhere (instacartPayload.ts); this governs `name` only.

/** Words that open a trailing prep clause (", roughly chopped"). */
const PREP_WORDS = new Set([
  "chopped",
  "diced",
  "sliced",
  "minced",
  "peeled",
  "deveined",
  "roughly",
  "finely",
  "thinly",
  "cut",
  "halved",
  "quartered",
  "trimmed",
  "grated",
  "shredded",
  "crushed",
  "softened",
  "melted",
  "divided",
  "plus",
  "for",
  "to",
  "optional",
  "at",
]);

/** Pack / measure nouns that can follow a leading number ("1 lb ", "2 cloves "). */
const UNIT_WORDS = new Set([
  "bottle",
  "can",
  "jar",
  "bag",
  "box",
  "package",
  "packet",
  "pack",
  "container",
  "carton",
  "loaf",
  "block",
  "tube",
  "wedge",
  "piece",
  "lb",
  "lbs",
  "pound",
  "oz",
  "ounce",
  "g",
  "gram",
  "kg",
  "ml",
  "cup",
  "tbsp",
  "tbs",
  "tablespoon",
  "tsp",
  "teaspoon",
  "pint",
  "quart",
  "bunch",
  "head",
  "clove",
  "sprig",
  "slice",
  "pinch",
  "stalk",
  "dozen",
  "large",
  "medium",
  "small",
  "each",
  "ear",
]);

// A leading count: "1", "1.5", "1/2", "~2".
const LEADING_NUMBER = String.raw`~?\d+(?:[./]\d+)?`;
// Form A — "<number> <word> (<size>) " : any word, because the parenthetical is
// what marks it as a pack ("1 bottle (15 oz) ", "2 cans (14.5 oz each) ").
const PACK_PREFIX_WITH_SIZE = new RegExp(
  String.raw`^${LEADING_NUMBER}\s+[A-Za-z]+\s*\([^)]*\)\s+`,
);
// Form B — "<number> <unit-word> " : the word must be a known unit noun, so
// "2 chicken breasts" keeps its count.
const PACK_PREFIX_BARE = new RegExp(
  String.raw`^${LEADING_NUMBER}\s+([A-Za-z]+)\s+`,
);

function singular(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith("es") && UNIT_WORDS.has(w.slice(0, -2))) return w.slice(0, -2);
  if (w.endsWith("s") && UNIT_WORDS.has(w.slice(0, -1))) return w.slice(0, -1);
  return w;
}

function stripPackPrefix(s: string): string {
  const withSize = PACK_PREFIX_WITH_SIZE.exec(s);
  if (withSize) {
    const rest = s.slice(withSize[0].length);
    return rest.trim().length > 0 ? rest : s;
  }
  const bare = PACK_PREFIX_BARE.exec(s);
  if (bare && UNIT_WORDS.has(singular(bare[1]))) {
    const rest = s.slice(bare[0].length);
    return rest.trim().length > 0 ? rest : s;
  }
  return s;
}

function stripParentheticals(s: string): string {
  return s.replace(/\s*\([^)]*\)/g, " ");
}

/**
 * Drop trailing comma-clauses whose first word is a prep word, repeatedly:
 * "parsley, chopped, for garnish" → "parsley, chopped" → "parsley".
 * A clause that opens with any other word ("tomatoes, San Marzano") stays.
 */
function stripPrepClauses(s: string): string {
  let cur = s;
  for (;;) {
    const idx = cur.lastIndexOf(",");
    if (idx < 0) return cur;
    const clause = cur.slice(idx + 1).trim();
    const first = clause.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (first.length === 0 || !PREP_WORDS.has(first)) return cur;
    cur = cur.slice(0, idx);
  }
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^[\s,.\-–—]+/, "")
    .replace(/[\s,.\-–—]+$/, "")
    .trim();
}

/**
 * The search term for one row. `userResolvedTo` wins when set (the user said
 * "milk" means "whole milk"); the cleaning then runs on whichever source was
 * chosen. If cleaning would empty the name, the UNTOUCHED source wins — a
 * noisy search beats an empty one.
 */
export function instacartSearchName(
  displayName: string,
  userResolvedTo?: string | null,
): string {
  const source =
    userResolvedTo && userResolvedTo.trim().length > 0
      ? userResolvedTo.trim()
      : displayName.trim();
  if (source.length === 0) return displayName;
  const cleaned = tidy(stripPrepClauses(stripParentheticals(stripPackPrefix(source))));
  return cleaned.length > 0 ? cleaned : source;
}
