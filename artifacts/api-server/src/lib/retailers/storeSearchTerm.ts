// SERVER-6 B (D-WS9-325) — THE WORDS A STORE'S SEARCH BOX GETS FOR ONE LINE.
//
// Built on the Instacart cleaner (instacartSearchName: the pack prefix, the
// parentheticals, the trailing prep clauses, userResolvedTo first), which already
// turns dev's 7,928 live rows into 734 clean terms. SHOP-0 Phase 0 §4 found the ~1.5 %
// it leaves that a store's own search box handles badly, and this adds exactly those:
//
//   1. an accent folded          "jalapeño" → "jalapeno" (a store's index may not fold it)
//   2. a leading "pinch of"      "pinch of Kashmiri red chili powder" → "Kashmiri red chili powder"
//   3. a comma clause            one adjective is put first ("guajillo chiles, dried" →
//                                "dried guajillo chiles"; "black pepper, freshly ground" →
//                                "ground black pepper"), a short proper name too
//                                ("tomatoes, San Marzano" → "San Marzano tomatoes");
//                                any other clause is dropped ("porterhouse steaks, about
//                                1.25 inches thick" → "porterhouse steaks")
//   4. the first of an "or" pair "chicken or vegetable broth" → "chicken broth",
//                                "lard or vegetable oil" → "lard", "avocado oil or olive
//                                oil" → "avocado oil" (the user can swap at the store)
//   5. prep states               "hard-boiled eggs" → "eggs", "ripe avocado" → "avocado",
//                                "day-old cooked long-grain white rice" → "long-grain white
//                                rice", "coarsely ground black pepper" → "black pepper"
//   6. the lean ratio kept       "ground beef (80/20)" → "80/20 ground beef" — stores sell
//                                by it, and the cleaner's parenthetical rule drops it
//
// Pure, one implementation, sent per row on GET /grocery-lists/:id so no client keeps
// a copy. If the rules would empty a term, the cleaner's term wins.

import { instacartSearchName } from "./instacartName";

const LEADING_MEASURE = /^(?:a\s+)?(?:pinch|dash|splash|sprinkle|handful)\s+of\s+/i;

/** An adjective a comma clause may carry that reads first in a search ("X, dried"). */
const INVERTIBLE = new Set([
  "dried", "ground", "fresh", "canned", "frozen", "smoked", "toasted", "roasted",
  "whole", "raw", "unsalted", "salted", "sweetened", "unsweetened", "boneless", "skinless",
]);
const ADVERB = /^[a-z]+ly$/i;

/** Words that say how the food is when it is cooked with, never how it is sold. */
const PREP_STATES = new Set([
  "ripe", "overripe", "day-old", "store-bought", "hard-boiled", "soft-boiled", "hard-cooked",
  "leftover", "cooked", "chilled", "softened", "melted", "thawed", "room-temperature",
]);
/** "-ly <participle>": "coarsely ground", "freshly squeezed", "finely grated". */
const MANNER = /\b[a-z]+ly\s+(?:ground|squeezed|grated|cracked|chopped|shredded)\b/gi;

/** A first alternative that is a product on its own ("lard or vegetable oil" → "lard"). */
const STANDALONE = new Set([
  "lard", "butter", "ghee", "shortening", "margarine", "mayo", "mayonnaise", "honey",
  "sugar", "water", "milk", "cream", "yogurt", "oil", "stock", "broth", "toothpicks",
]);
/** States an "or" pair's first word can name; the shared rest drops its own. */
const STATE_WORDS = new Set(["fresh", "frozen", "canned", "dried", "thawed"]);

function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "");
}

function commaClause(s: string): string {
  const idx = s.indexOf(",");
  if (idx < 0) return s;
  const head = s.slice(0, idx).trim();
  const clauses = s.slice(idx + 1).split(",").map((c) => c.trim()).filter(Boolean);
  if (head.length === 0) return s;
  if (clauses.length === 1) {
    const words = clauses[0].split(/\s+/);
    const adjective = words.length === 2 && ADVERB.test(words[0]) ? words[1] : words.length === 1 ? words[0] : null;
    if (adjective && INVERTIBLE.has(adjective.toLowerCase())) return `${adjective.toLowerCase()} ${head}`;
    if (words.length <= 3 && /^[A-Z]/.test(words[0]) && words.every((w) => /^[A-Za-z'-]+$/.test(w))) return `${clauses[0]} ${head}`;
  }
  return head;
}

function firstAlternative(s: string): string {
  const m = /\s+or\s+/i.exec(s);
  if (!m) return s;
  const left = s.slice(0, m.index).trim();
  const right = s.slice(m.index + m[0].length).trim().split(/\s+/);
  const leftWords = left.split(/\s+/);
  if (leftWords.length !== 1 || STANDALONE.has(left.toLowerCase()) || right.length < 2) return left;
  // "chicken or vegetable broth": the first word is the alternative to the right's
  // first word, and the rest is shared.
  let rest = right.slice(1);
  if (STATE_WORDS.has(left.toLowerCase())) rest = rest.filter((w) => !STATE_WORDS.has(w.toLowerCase()));
  return [left, ...rest].join(" ");
}

function dropPrepStates(s: string): string {
  return s
    .replace(MANNER, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !PREP_STATES.has(w.toLowerCase()))
    .join(" ");
}

/** "80/20", "93/7": two numbers that make 100, the way ground meat is labelled. */
function leanRatioOf(s: string): string | null {
  const m = /\b(\d{2,3})\s*\/\s*(\d{1,2})\b/.exec(s);
  return m && Number(m[1]) + Number(m[2]) === 100 ? `${m[1]}/${m[2]}` : null;
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s,.\-–—]+|[\s,.\-–—]+$/g, "").trim();
}

/** The search term for one grocery row at a store (Shop Your Store). */
export function storeSearchTerm(displayName: string, userResolvedTo?: string | null): string {
  const cleaned = instacartSearchName(displayName, userResolvedTo);
  const source = userResolvedTo && userResolvedTo.trim().length > 0 ? userResolvedTo : displayName;
  let t = foldAccents(cleaned)
    .replace(/\b1\/2\s*(?:&|and)\s*1\/2\b/i, "half and half")
    .replace(LEADING_MEASURE, "");
  t = commaClause(t);
  t = firstAlternative(t);
  t = tidy(dropPrepStates(t));
  const lean = leanRatioOf(source);
  if (lean && !t.includes(lean)) t = `${lean} ${t}`;
  return t.length > 0 ? t : cleaned;
}
