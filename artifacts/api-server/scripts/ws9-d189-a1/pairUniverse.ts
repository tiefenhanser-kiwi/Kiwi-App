// WS9 D-WS9-189 Block A1 — the pair universe and its family batching.
//
// THE UNIVERSE (D-WS9-196). Use the LARGER pair set, not the smaller one. A
// pair excluded from the universe is invisible forever; a pair included and
// labelled `distinct` writes one cheap row and costs nothing else. The proof is
// the `[whole]` signature, which covers both
//   canned diced tomatoes ~ canned whole peeled tomatoes   (distinct)
//   black peppercorns     ~ whole black peppercorns        (synonym)
// — one token difference, two different answers. No name rule separates them,
// which is the whole reason this program exists.
//
// Two predicates build it, unioned:
//   sameCore    both names reduce to the same non-empty core signature after
//               modifier tokens are stripped ("fresh mozzarella" ~ "mozzarella")
//   containment one name's token set is a strict subset of the other's
//               ("lime" ⊂ "lime juice")
//
// ⚠️ CONTAINMENT IS NOT OPTIONAL, and it is the half that catches components.
// Head-noun clustering systematically MISSES component relationships, because a
// derived product's head word IS the derivation: `garlic` vs garlic CLOVES,
// `Lime` vs lime JUICE / ZEST / WEDGES. Those pairs share no head noun and
// never land in the same core group. Containment is what finds them.

export interface CatalogRow {
  id: string;
  canonicalName: string;
  category: string;
}

export interface NormalizedRow extends CatalogRow {
  /** A1 — "A or B" substitution phrase, so never a valid SYNONYM endpoint. */
  isDisjunction: boolean;
  /** Singularized, stopword-stripped tokens, in order. */
  tokens: string[];
  tokenSet: Set<string>;
  /** Sorted unique non-modifier tokens, space-joined. "" when all-modifier. */
  core: string;
  head: string;
}

export interface Pair {
  a: NormalizedRow;
  b: NormalizedRow;
  /** How the pair entered the universe. */
  via: "same_core" | "containment";
  /**
   * The sorted symmetric token difference, "|"-joined. This is the key the
   * contradiction detector groups on: `lime ~ lime juice` and
   * `lemon ~ lemon juice` share the signature `juice`, so a divergent label
   * across them is structurally detectable without re-asking the model.
   */
  signature: string;
  /** True when the difference crosses a processing boundary (see below). */
  straddlesProcessing: boolean;
  familyKey: string;
}

// Grammatical filler and quantity noise. These carry no product identity, so
// leaving them in would split pairs that are otherwise identical.
const STOPWORDS = new Set([
  "or", "in", "and", "such", "as", "of", "about", "into", "on", "for", "with",
  "to", "a", "the", "at", "least", "plus", "more", "if", "you", "can", "find",
  "it", "preferably", "ideally", "like", "any", "other",
  "1", "2", "3", "4", "5", "6", "8", "10", "12",
  "inch", "cm", "lb", "oz", "pound", "ounce", "ounces", "pounds",
]);

// Physical-state / preparation modifiers. Stripping these is what makes
// "fresh mozzarella" and "shredded mozzarella cheese" reduce to one core.
const PREP_MODIFIERS = [
  "fresh", "freshly", "dried", "dry", "whole", "canned", "jarred", "bottled",
  "boxed", "frozen", "ground", "grated", "shredded", "sliced", "diced",
  "chopped", "minced", "crushed", "cubed", "julienned", "halved", "quartered",
  "torn", "peeled", "seeded", "cored", "stemmed", "trimmed", "pitted",
  "shelled", "deveined", "cooked", "uncooked", "raw", "roasted", "toasted",
  "smoked", "cured", "drained", "rinsed", "packed", "softened", "melted",
  "room", "temperature", "finely", "thinly", "coarsely", "roughly", "thick",
  "cut", "pressed", "rolled", "flaked", "pureed", "strained", "sifted",
  "beaten",
];

// Quality / size / provenance descriptors.
const DESCRIPTOR_MODIFIERS = [
  "large", "small", "medium", "extra", "virgin", "light", "heavy", "low",
  "reduced", "no", "free", "sodium", "unsalted", "salted", "sweet",
  "sweetened", "unsweetened", "hot", "mild", "plain", "organic", "store",
  "bought", "homemade", "best", "quality", "good", "fine", "coarse", "flaky",
  "baby", "young", "old", "mature", "skinless", "boneless", "bone", "skin",
  "lean", "fatty", "wide", "narrow", "long", "short", "regular", "full", "fat",
  "nonfat", "part", "shelf", "stable", "prepared", "ready", "instant", "quick",
  "slow", "crusty", "soft", "firm", "ripe", "overripe", "neutral", "high",
  "heat", "all", "purpose", "pure", "natural", "real", "authentic",
  "traditional", "classic", "style", "flavored", "optional", "divided",
  "separated", "garnish", "serving", "topping", "needed",
];

// Colour words. Included as modifiers DELIBERATELY, and the reason is
// D-WS9-196: `red onion` vs `yellow onion` is genuinely two products, but the
// cost of pairing them and labelling `distinct` is one row, whereas the cost of
// never pairing them is that nothing can ever record that they differ.
const COLOR_MODIFIERS = [
  "red", "green", "white", "yellow", "black", "brown", "golden", "purple",
  "orange", "pink", "dark", "blonde",
];

const MODIFIERS = new Set([
  ...PREP_MODIFIERS,
  ...DESCRIPTOR_MODIFIERS,
  ...COLOR_MODIFIERS,
]);

// The subset of modifiers that change the PHYSICAL PRODUCT you take off the
// shelf, rather than merely describing one. A pair whose difference includes
// one of these "straddles a processing boundary" — the class where synonym vs
// distinct is genuinely hard and where the D-WS9-197 rubric defect bites.
// `fresh`/`dried` basil is two products; `large`/`small` onion is one.
const PROCESSING_MODIFIERS = new Set([
  "dried", "dry", "canned", "jarred", "bottled", "frozen", "ground", "grated",
  "shredded", "crushed", "pureed", "cooked", "uncooked", "raw", "roasted",
  "toasted", "smoked", "cured", "whole", "powder", "paste", "flake", "flakes",
  "juice", "zest", "sauce", "puree", "concentrate", "extract", "syrup",
  "instant", "fresh",
]);

// ── §2a: normalise out what should never have been judged ──────────────────
//
// 🔴 FIX THE INPUT, NOT THE RUBRIC. 326 of the 543 pairs in the four measured
// families (60%) involved a name that is not a distinct product at all. No
// rubric change competes with simply not asking.
//
// A TRANSFORM-PREP SUFFIX collapses to its base. `yellow onion, diced` IS
// `yellow onion` — per the A2 discriminator nothing is discarded, so it is the
// same purchase, and judging it as a separate entity invents a question.
//
// ⚠️ COMMA SUFFIX ONLY, AND THAT IS THE WHOLE DISCRIMINATOR. `shredded
// mozzarella cheese` (adjective PREFIX) is a different bag off a different
// shelf; `iceberg lettuce, shredded` (comma SUFFIX) is a knife instruction the
// recipe wrote down. Prefix qualifiers still go to the judge.
//
// ⚠️ DISCARD-PREP IS NOT COLLAPSED. `leeks, white and light green parts only`
// is a genuine COMPONENT carrying a yield — you buy a whole leek and bin half.
// The vocabulary below deliberately excludes `peeled`, `seeded`, `stemmed`,
// `trimmed`, `deveined` and `parts`, so anything carrying them stays a question
// for the judge. Where the call is ambiguous the rule declines to collapse:
// a false flag costs one line of a review sheet, a false collapse is a wrong
// catalog forever.
const TRANSFORM_SUFFIX_WORDS = new Set([
  // knife work — discards nothing
  "chopped", "sliced", "diced", "minced", "grated", "shredded", "halved",
  "quartered", "cubed", "cut", "torn", "crushed", "mashed", "smashed",
  // adverbs and shapes those take
  "roughly", "finely", "coarsely", "thinly", "thickly", "lengthwise",
  "crosswise", "into", "pieces", "rounds", "cubes", "wedges", "strips",
  "matchsticks", "half", "halves",
  // handling that changes nothing about the purchase
  "packed", "drained", "rinsed", "softened", "melted", "room", "temperature",
  "at", "divided", "separated",
  // usage notes — not a product difference at all
  "for", "serving", "serve", "to", "garnish", "garnishing", "topping",
  // connectors
  "and", "or",
]);

/**
 * Strip one trailing transform-prep suffix, or return null when the suffix is
 * not purely transform. Numbers, fractions and measurement words are permitted
 * inside a suffix ("cut into 3/4-inch cubes") because they only ever describe
 * the shape of the knife work.
 */
export function stripTransformSuffix(canonicalName: string): string | null {
  const comma = canonicalName.lastIndexOf(",");
  if (comma <= 0) return null;
  const suffix = canonicalName.slice(comma + 1).trim().toLowerCase();
  if (suffix.length === 0) return null;
  const words = suffix
    .replace(/[0-9]+([./⁄][0-9]+)?/g, " ")
    .replace(/[½¼¾⅓⅔⅛]/g, " ")
    .replace(/\b(inch|inches|cm|mm)\b/g, " ")
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return null;
  if (!words.every((w) => TRANSFORM_SUFFIX_WORDS.has(w))) return null;
  return canonicalName.slice(0, comma).trim();
}

// §3 — REDUNDANT PROVENANCE QUALIFIERS.
//
// Hans's reasoning: purchase is the PREMISE of a grocery list, so "store-bought"
// carries zero information. "store-bought naan" and "naan" name the same thing
// to buy, and the qualifier only exists because a recipe wanted to tell a cook
// they need not make it themselves.
//
// Stripped at normalisation exactly as prep-transform is. Two outcomes, and they
// are reported separately because they are different facts:
//   DEDUP    — the stripped name already exists as its own catalog row, so the
//              qualified row collapses into it and disappears.
//   SHORTEN  — no such row exists, so the entity survives under its shortened
//              name and simply stops carrying a meaningless qualifier.
const PROVENANCE_QUALIFIERS = [
  "store-bought",
  "store bought",
  "shop-bought",
  "shop bought",
  "storebought",
  "purchased",
];

/** Remove a provenance qualifier, or return null when there is none. */
export function stripProvenance(canonicalName: string): string | null {
  let out = canonicalName;
  let hit = false;
  for (const q of PROVENANCE_QUALIFIERS) {
    const rx = new RegExp(`(^|\\s)${q.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(\\s|$)`, "gi");
    if (rx.test(out)) {
      hit = true;
      out = out.replace(rx, "$1$2");
    }
  }
  if (!hit) return null;
  const cleaned = out.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 && cleaned !== canonicalName ? cleaned : null;
}

export type ModifierClass = "prep" | "descriptor" | "color" | "other";

/**
 * Which kind of modifier a token is. Used by the contradiction detector's
 * same-base check: two pairs off the same base whose differences are the same
 * KIND of modifier are analogous, and so must carry the same label.
 * `onion ~ white onion` and `onion ~ yellow onion` are both colour differences
 * off `onion`; one SYNONYM and one DISTINCT is incoherent regardless of which
 * is right.
 */
export function modifierClassOf(token: string): ModifierClass {
  if (COLOR_MODIFIERS.includes(token)) return "color";
  if (PREP_MODIFIERS.includes(token)) return "prep";
  if (DESCRIPTOR_MODIFIERS.includes(token)) return "descriptor";
  return "other";
}

// ── A1: substitution phrases are not products ──────────────────────────────
//
// 🔴 AN "A or B" ROW IS NEVER A VALID SYNONYM ENDPOINT, and the A1 pilot proved
// why by measurement. The 23-member neutral-oil synonym class contained `lard`
// and `avocado oil` ONLY because these rows exist as catalog ingredients:
// `lard or neutral oil`, `lard or unsalted butter`, and ten
// `neutral oil (such as X or Y)` variants. Remove those bridge rows and the
// class collapses to 9 — which is entirely correct, and is exactly the
// fragmentation this program exists to fix. The 23 was a bridging artifact.
//
// ⚠️ `lard or unsalted butter` is the proof: it is not a purchasable thing at
// all. It is a recipe's substitution phrase that became a canonical name, and
// transitively it makes BUTTER a vegetable oil.
//
// These rows still take part in the universe — they can legitimately be
// DISTINCT or SUBSUMES against something — but a SYNONYM verdict on one is
// rejected downstream, because folding a disjunction into either of its
// branches asserts something the name does not say.
//
// NOT DELETED. 73 catalog rows match, carrying 277 dish references; the blast
// radius of removing them is unmeasured and the hygiene pass is a separate
// decision.
const DISJUNCTION_PATTERNS: readonly RegExp[] = [
  /\bor\b/i, // "chicken or vegetable broth", "fresh or frozen corn kernels"
  /\bsuch as\b/i, // "dry red wine (such as burgundy or pinot noir)"
  // A slash BETWEEN WORDS only. ⚠️ Not a bare /: `80/20 ground beef` and
  // `beef chuck, cut into 3/4-inch cubes` are ratios and fractions, not
  // disjunctions, and excluding them would be a false positive that silently
  // shrinks the universe.
  /[a-z]\s*\/\s*[a-z]/i,
];

/** True when a canonical name is a substitution phrase rather than a product. */
export function isDisjunctionName(canonicalName: string): boolean {
  return DISJUNCTION_PATTERNS.some((rx) => rx.test(canonicalName));
}

export function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map(singularize)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

/**
 * Crude singularizer. Deliberately crude: it only has to make "tomatoes" and
 * "tomato" collide, and a wrong stem costs at worst a missed pair, never a
 * wrong row. The irregulars below are the ones the catalog actually contains.
 */
export function singularize(word: string): string {
  if (word.length < 4) return word;
  if (word === "chilies" || word === "chiles" || word === "chilis" || word === "chillies") {
    return "chili";
  }
  if (word === "leaves") return "leaf";
  if (/oes$/.test(word)) return word.slice(0, -2);
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(sses|shes|ches|xes)$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

export function normalizeRow(row: CatalogRow): NormalizedRow {
  const tokens = tokenize(row.canonicalName);
  const core = [...new Set(tokens.filter((t) => !MODIFIERS.has(t)))].sort().join(" ");
  return {
    ...row,
    isDisjunction: isDisjunctionName(row.canonicalName),
    tokens,
    tokenSet: new Set(tokens),
    core,
    head: tokens[tokens.length - 1] ?? "",
  };
}

function symmetricDifference(a: NormalizedRow, b: NormalizedRow): string[] {
  const diff = new Set<string>();
  for (const t of a.tokens) if (!b.tokenSet.has(t)) diff.add(t);
  for (const t of b.tokens) if (!a.tokenSet.has(t)) diff.add(t);
  return [...diff].sort();
}

function isStrictSubset(a: NormalizedRow, b: NormalizedRow): boolean {
  if (a.tokenSet.size === b.tokenSet.size) return false;
  const [small, large] =
    a.tokenSet.size < b.tokenSet.size ? [a.tokenSet, b.tokenSet] : [b.tokenSet, a.tokenSet];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

// ── Culinary families (D-WS9-197, half 1) ──────────────────────────────────
//
// ⚠️ THIS IS A BATCHING DEVICE, NOT A SEMANTIC ONE, and the distinction is what
// makes an authored list acceptable here. A wrong family assignment costs a
// suboptimal batch — nothing more. It can never produce a wrong row, because
// the judge still decides every pair on its merits and the contradiction
// detector still runs across families afterwards.
//
// WHY IT IS NEEDED AT ALL: the D-WS9-197 defect is `lime ~ lime juice` labelled
// component while `lemon ~ lemon juice` is labelled distinct, at high
// confidence, IN THE SAME CALL. Lime and lemon are different token clusters, so
// no clustering over names puts them together. Only a culinary notion of
// "citrus" does. These are the axes where analogous pairs must be judged side
// by side or the model has no way to notice it is contradicting itself.
//
// Every one of these is a family Hans has already ruled on, or one the pilot
// must cover because it is known-hard.
interface CulinaryFamily {
  key: string;
  /** A row joins the family if ANY of its tokens appears here. */
  tokens: string[];
}

const CULINARY_FAMILIES: readonly CulinaryFamily[] = [
  // The D-WS9-197 case itself. Juice / zest / wedges / leaves all live here.
  { key: "citrus", tokens: ["lime", "lemon", "orange", "grapefruit", "citron", "yuzu", "calamansi"] },
  // Hans: "iodized salt is NOT kosher is NOT flaky sea salt."
  { key: "salt", tokens: ["salt"] },
  // Hans: "peppercorns as an ingredient are different than black pepper (ground)."
  { key: "pepper_corn", tokens: ["peppercorn", "pepper"] },
  { key: "sugar", tokens: ["sugar", "sweetener", "jaggery", "molasse", "honey", "syrup"] },
  { key: "oil_fat", tokens: ["oil", "ghee", "shortening", "lard", "tallow"] },
  { key: "tomato", tokens: ["tomato", "passata", "marzano"] },
  { key: "chili", tokens: ["chili", "chile", "chilli", "cayenne", "chipotle", "ancho", "jalapeno", "serrano", "habanero", "poblano", "guajillo"] },
  { key: "allium", tokens: ["onion", "garlic", "shallot", "leek", "scallion", "chive"] },
  { key: "vinegar", tokens: ["vinegar"] },
  { key: "flour_starch", tokens: ["flour", "starch", "cornmeal", "semolina"] },
  { key: "cheese", tokens: ["cheese", "mozzarella", "parmesan", "cheddar", "ricotta", "feta", "gouda", "provolone", "pecorino", "queso"] },
  { key: "dairy_milk", tokens: ["milk", "cream", "yogurt", "buttermilk", "butter"] },
  { key: "bread", tokens: ["bread", "baguette", "loaf", "ciabatta", "boule", "sourdough", "roll", "bun", "tortilla", "pita", "naan"] },
  { key: "rice_grain", tokens: ["rice", "quinoa", "farro", "barley", "couscous", "bulgur", "oat"] },
  { key: "pasta_noodle", tokens: ["pasta", "noodle", "spaghetti", "penne", "linguine", "fettuccine", "macaroni", "lasagna", "ramen", "udon", "soba"] },
  { key: "beef", tokens: ["beef", "chuck", "brisket", "sirloin", "ribeye", "steak"] },
  { key: "pork", tokens: ["pork", "bacon", "pancetta", "prosciutto", "ham", "sausage", "chorizo"] },
  { key: "poultry", tokens: ["chicken", "turkey", "duck"] },
  { key: "seafood", tokens: ["shrimp", "salmon", "tuna", "cod", "halibut", "scallop", "crab", "anchovy", "clam", "mussel"] },
  { key: "bean_legume", tokens: ["bean", "lentil", "chickpea", "pea"] },
  { key: "herb", tokens: ["basil", "cilantro", "parsley", "mint", "oregano", "thyme", "rosemary", "sage", "dill", "tarragon"] },
  { key: "mushroom", tokens: ["mushroom", "shiitake", "cremini", "portobello", "porcini"] },
  { key: "stock_broth", tokens: ["broth", "stock", "bouillon"] },
  { key: "soy_sauce", tokens: ["soy", "tamari", "miso", "hoisin", "ponzu"] },
  { key: "pickle_brine", tokens: ["pickle", "pickled", "brine", "pepperoncini", "caper", "olive"] },
  { key: "nut_seed", tokens: ["almond", "walnut", "pecan", "cashew", "peanut", "pistachio", "sesame", "seed"] },
  { key: "greens", tokens: ["lettuce", "spinach", "kale", "arugula", "chard", "cabbage", "green"] },
  { key: "root_veg", tokens: ["potato", "carrot", "beet", "turnip", "parsnip", "radish", "ginger"] },
];

/**
 * Assign a family. Culinary families win; anything unmatched falls back to its
 * core signature (or head noun when the core is empty), which keeps the batch
 * small and coherent for the long tail.
 *
 * A PAIR takes the family of its two endpoints when they agree. When they
 * disagree — a genuinely cross-family pair — it takes the family of the SHORTER
 * name, on the reasoning that the shorter name is the base product and the pair
 * is a derivation of it.
 */
export function familyOf(row: NormalizedRow): string {
  for (const family of CULINARY_FAMILIES) {
    for (const token of row.tokens) {
      if (family.tokens.includes(token)) return family.key;
    }
  }
  return row.core || row.head || "unclassified";
}

export function pairFamily(a: NormalizedRow, b: NormalizedRow): string {
  const fa = familyOf(a);
  const fb = familyOf(b);
  if (fa === fb) return fa;
  return a.tokens.length <= b.tokens.length ? fa : fb;
}

/**
 * Build the full pair universe over a catalog.
 *
 * O(n^2) over ~1,570 rows is ~1.2M predicate evaluations — under a second, and
 * not worth an index. Straightforwardness beats cleverness here because the
 * count this produces is a number Hans makes a spend decision against.
 */
export interface CollapsedRow {
  /** The row that was normalised away. */
  from: NormalizedRow;
  /** The catalog row it collapses into. */
  intoId: string;
  intoName: string;
}

export interface RenamedRow {
  from: NormalizedRow;
  toName: string;
}

export interface UniverseExclusions {
  /** §2a — transform-prep rows folded into their base. */
  collapsed: CollapsedRow[];
  /** §2a — "A or B" substitution phrases, never a valid relation endpoint. */
  disjunctions: NormalizedRow[];
  /** §3 — provenance-qualified rows that DEDUP onto an existing catalog row. */
  provenanceDeduped: CollapsedRow[];
  /** §3 — provenance-qualified rows with no existing base; merely SHORTENED. */
  provenanceShortened: RenamedRow[];
}

export function buildPairUniverse(rows: CatalogRow[]): {
  normalized: NormalizedRow[];
  pairs: Pair[];
  exclusions: UniverseExclusions;
} {
  const all = rows.map(normalizeRow);
  const byName = new Map(all.map((r) => [r.canonicalName.toLowerCase(), r]));
  // Secondary match on the normalised token sequence, so a base that differs
  // only in pluralisation still counts: `beefsteak tomatoes, thinly sliced`
  // has no exact `beefsteak tomatoes` row, but `beefsteak tomato` is plainly
  // the same product. Exact match wins; this is the fallback.
  const byTokenKey = new Map<string, NormalizedRow>();
  for (const r of all) {
    const key = r.tokens.join(" ");
    if (key.length > 0 && !byTokenKey.has(key)) byTokenKey.set(key, r);
  }
  const lookupBase = (name: string): NormalizedRow | undefined =>
    byName.get(name.toLowerCase()) ?? byTokenKey.get(tokenize(name).join(" "));

  // §2a — fold transform-prep rows into their base, where the base exists as a
  // catalog row. A suffix with no base row to fold into stays in the universe:
  // there is nothing to collapse it to, so it is still a question.
  const collapsed: CollapsedRow[] = [];
  const collapsedIds = new Set<string>();
  for (const row of all) {
    let base = stripTransformSuffix(row.canonicalName);
    // Repeat, so "yellow onions, peeled, thinly sliced" reduces all the way.
    let target = base ? lookupBase(base) : undefined;
    while (base && !target) {
      const next = stripTransformSuffix(base);
      if (!next) break;
      base = next;
      target = lookupBase(base);
    }
    if (target && target.id !== row.id) {
      collapsed.push({ from: row, intoId: target.id, intoName: target.canonicalName });
      collapsedIds.add(row.id);
    }
  }

  // 🔴 §2a — a disjunction row is not a valid endpoint for ANY relation, not
  // just SYNONYM. `lard or unsalted butter` is not a purchasable thing; it is a
  // recipe's substitution phrase that became a canonical name, and it is the
  // sole cause of the lard/avocado-oil over-merge. Removed from the universe
  // outright rather than filtered at the auto-accept gate, so it can never
  // become an endpoint under any label.
  const disjunctions = all.filter((r) => r.isDisjunction);
  const disjunctionIds = new Set(disjunctions.map((r) => r.id));

  // §3 — strip provenance qualifiers. A row whose stripped name already exists
  // is a DEDUP and leaves the universe; one with no existing base is merely
  // SHORTENED and stays, under its cleaner name.
  const provenanceDeduped: CollapsedRow[] = [];
  const provenanceShortened: RenamedRow[] = [];
  const renamedTo = new Map<string, string>();
  for (const row of all) {
    if (collapsedIds.has(row.id) || disjunctionIds.has(row.id)) continue;
    const stripped = stripProvenance(row.canonicalName);
    if (!stripped) continue;
    const target = lookupBase(stripped);
    if (target && target.id !== row.id) {
      provenanceDeduped.push({ from: row, intoId: target.id, intoName: target.canonicalName });
      collapsedIds.add(row.id);
    } else {
      provenanceShortened.push({ from: row, toName: stripped });
      renamedTo.set(row.id, stripped);
    }
  }

  const normalized = all
    .filter((r) => !collapsedIds.has(r.id) && !disjunctionIds.has(r.id))
    .map((r) => {
      const newName = renamedTo.get(r.id);
      // Re-normalise under the shortened name so tokens/core/head all agree
      // with what a reviewer will see in the sheet.
      return newName ? normalizeRow({ ...r, canonicalName: newName }) : r;
    });
  const pairs: Pair[] = [];

  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i]!;
      const b = normalized[j]!;
      const sameCore = a.core.length > 0 && a.core === b.core;
      const containment = isStrictSubset(a, b);
      if (!sameCore && !containment) continue;

      const diff = symmetricDifference(a, b);
      pairs.push({
        a,
        b,
        via: sameCore ? "same_core" : "containment",
        signature: diff.join("|") || "(identical)",
        straddlesProcessing: diff.some((t) => PROCESSING_MODIFIERS.has(t)),
        familyKey: pairFamily(a, b),
      });
    }
  }

  return {
    normalized,
    pairs,
    exclusions: { collapsed, disjunctions, provenanceDeduped, provenanceShortened },
  };
}

/**
 * Group pairs into judge batches.
 *
 * ⚠️ A SPLIT FAMILY LOSES THE GUARANTEE FAMILY BATCHING EXISTS TO PROVIDE — the
 * model can contradict itself across the split, exactly as it could across an
 * arbitrary batch boundary. Splits are therefore returned as distinct batches
 * with a `split` flag so the caller can log them rather than let the cap pass
 * silently. The contradiction detector is what covers the residual risk.
 */
export function batchByFamily(
  pairs: Pair[],
  maxPairsPerBatch: number,
): Array<{ familyKey: string; pairs: Pair[]; split: boolean; partIndex: number }> {
  const byFamily = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const bucket = byFamily.get(pair.familyKey);
    if (bucket) bucket.push(pair);
    else byFamily.set(pair.familyKey, [pair]);
  }

  const batches: Array<{ familyKey: string; pairs: Pair[]; split: boolean; partIndex: number }> = [];
  for (const [familyKey, familyPairs] of [...byFamily].sort((x, y) => x[0].localeCompare(y[0]))) {
    // Deterministic order so a re-run produces the same batches, which is what
    // makes a --dry-run comparable against the --apply that follows it.
    const ordered = [...familyPairs].sort((x, y) =>
      `${x.a.canonicalName} ${x.b.canonicalName}`.localeCompare(
        `${y.a.canonicalName} ${y.b.canonicalName}`,
      ),
    );
    const split = ordered.length > maxPairsPerBatch;
    for (let i = 0; i < ordered.length; i += maxPairsPerBatch) {
      batches.push({
        familyKey,
        pairs: ordered.slice(i, i + maxPairsPerBatch),
        split,
        partIndex: Math.floor(i / maxPairsPerBatch),
      });
    }
  }
  return batches;
}
