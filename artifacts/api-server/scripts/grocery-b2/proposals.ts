// [grocery] B2 — THE DATA. Everything the digest renders and the preview
// computes reads its figures from HERE, so Hans's rulings land in one place.
// B1's `scripts/grocery-b1/proposals.ts` has the same job and the same shape.
//
// Nothing in this file touches the database.

export type SubsumesClass = "QUALIFIER" | "KEEP" | "GENERIC";

export interface SubsumesRuling {
  klass: SubsumesClass;
  why: string;
  /**
   * true => this lane CHOSE for THIS EDGE and nothing above it decided; the
   * digest marks it `?`.
   *
   * An edge decided by a TOKEN FAMILY is NOT marked here, deliberately. The
   * choice is real but it is made once, for the family, and the digest gives
   * each family its own numbered `?` line at the top of section S. Marking all
   * 308 edges instead would put 247 question marks in front of Hans to rule on
   * 12 decisions.
   */
  uncertain: boolean;
  /** which layer decided: a quoted ruling, a token family, or the catch-all. */
  basis: "ruling" | "structural" | "keep-token" | "qualifier-token" | "catch-all";
}

/**
 * Hans's named rulings, verbatim in the prompt's section 2. A GENERIC key
 * applies to every specific under it; a "generic||specific" key wins over it.
 */
const NAMED: Record<string, SubsumesRuling> = {
  // KEEP — a different PRODUCT, not a narrower one (Hans)
  lettuce: { klass: "KEEP", why: "Hans: lettuce over iceberg / romaine / hearts is a different product", uncertain: false, basis: "ruling" },
  butter: { klass: "KEEP", why: "Hans: butter over unsalted is a different product", uncertain: false, basis: "ruling" },
  "brown sugar": { klass: "KEEP", why: "Hans: brown sugar over dark is a different product", uncertain: false, basis: "ruling" },
  "diced tomatoes": { klass: "KEEP", why: "Hans: diced tomatoes over fire-roasted is a different product", uncertain: false, basis: "ruling" },
  "chili powder": { klass: "KEEP", why: "Hans: chili powder over ancho is a different product", uncertain: false, basis: "ruling" },
  salsa: { klass: "KEEP", why: "Hans: salsa over verde is a different product", uncertain: false, basis: "ruling" },
  // GENERIC — fold, no qualifier
  "crusty bread": { klass: "GENERIC", why: "Hans: could be sourdough, but could be french so it stays generic", uncertain: false, basis: "ruling" },
  // the veto's own family — BUG-168 + NEVER_FOLD_PAIRS. The cluster contains
  // coarse kosher salt / kosher salt, so it is refused WHOLE.
  salt: { klass: "KEEP", why: "BUG-168 LOCKED + NEVER_FOLD_PAIRS: the cluster holds coarse kosher salt / kosher salt and is refused whole", uncertain: false, basis: "ruling" },
  // Digest #101, ruled on B1's digest
  "parsley||fresh flat-leaf parsley": { klass: "QUALIFIER", why: "digest #101 — 2 bunches parsley (at least one flat-leaf)", uncertain: false, basis: "ruling" },
  "fresh parsley||fresh flat-leaf parsley": { klass: "QUALIFIER", why: "digest #101, same pair under the fresh spelling", uncertain: false, basis: "ruling" },
  // Romaine hearts fold to romaine (Hans). The live table has no
  // `romaine lettuce` -> `romaine lettuce hearts` edge — see the report.
  "lettuce||romaine lettuce hearts": { klass: "KEEP", why: "Hans keeps lettuce separate; his hearts-are-just-romaine ruling is a ROMAINE-level fold and needs an edge that does not exist (finding N4)", uncertain: false, basis: "ruling" },
};

/**
 * MEDIUM-confidence subsumes edges promoted past the admission gate, each on a
 * quoted ruling. Exactly the shape — and exactly the justification — of
 * RULED_PROMOTIONS in ingredientRelations.ts, which already does this for
 * synonym edges. Reused rather than re-invented.
 *
 * Both of these are named by the working prompt as cases the dry run MUST show,
 * and both are `medium` + unreviewed in the table, so the gate that mirrors
 * admitSynonym excludes them. Without a promotion the prompt's own examples do
 * not fold.
 */
export const RULED_SUBSUMES_PROMOTIONS: readonly {
  generic: string;
  specific: string;
  why: string;
  uncertain: boolean;
}[] = [
  {
    generic: "parsley", specific: "fresh flat-leaf parsley",
    why: "digest #101, already ruled — 2 bunches parsley (at least one flat-leaf). The row is medium and unreviewed; the RULING is what promotes it.",
    uncertain: false,
  },
  {
    generic: "chicken thighs", specific: "boneless skinless chicken thighs",
    why: "the prompt requires this pair in the dry run and R7 names the same food as the Instacart failure of September 19. The row is medium and unreviewed, so it needs a promotion or it stays two lines.",
    uncertain: true,
  },
];

/**
 * Tokens that, when they are what distinguishes the specific from the generic,
 * mean A DIFFERENT FOOD or A DIFFERENT PRESERVATION STATE. D-WS9-223's axis:
 * the distinction changes the dish.
 */
export const KEEP_TOKENS = [
  // preservation / state — a different purchase and a different prep
  "dried", "canned", "frozen", "fresh", "jarred", "refrigerated", "cooked",
  "pickled", "smoked", "roasted", "fire-roasted", "store-bought",
  // named varieties with their own culinary identity
  "verde", "roja", "ancho", "chipotle", "kashmiri", "madras", "panang",
  "hatch", "sichuan", "szechuan", "thai", "fresno", "serrano", "habanero",
  "cherry", "heirloom", "plum", "grape",
  // flavour / heat labels — a choice the shopper makes, not a grade
  "hot", "spicy", "mild", "sweet", "smoky", "honey", "buffalo", "chunky",
  "dark", "curly", "lacinato", "butter", "iceberg", "romaine", "little",
  // a named sausage is its own sausage, not a grade of "smoked sausage"
  "andouille", "kielbasa",
];

/**
 * Tokens that are a GRADE, TRIM, COLOUR, SIZE or LABEL on the same food. The
 * fold is right and the specific rides as a qualifier.
 */
export const QUALIFIER_TOKENS = [
  "red", "green", "yellow", "white", "purple", "orange",
  "large", "medium", "small", "baby", "jumbo", "extra-large",
  "sharp", "extra-sharp", "aged", "whole-milk", "low-moisture", "part-skim",
  "low-sodium", "unsalted", "salted", "reduced-sodium",
  "bone-in", "boneless", "skin-on", "skinless", "lean", "center-cut",
  "thick-cut", "thin-cut", "trimmed", "frenched", "shelled", "pitted",
  "peeled", "deveined", "ripe", "crisp", "long-grain", "short-grain",
  "italian", "japanese", "mexican", "french", "brioche", "potato",
  "granny", "honeycrisp", "braeburn", "navel", "russet", "yukon",
  "san", "albacore", "solid", "wide", "flat", "stone-ground",
  "80/20", "85/15", "85%",
];
// DELIBERATELY NOT HERE: "whole" (it would decide `croutons` over `whole grain
// croutons`, where the distinction is the GRAIN, not the word "whole") and
// "prosciutto" (its only edge is `prosciutto` over `prosciutto di parma`, whose
// distinction is "di parma"). Both now fall to the catch-all and carry a `?`.

/**
 * Tokens whose ONLY content is a dimension or a hedge — a spec the shopper
 * need not honour. Fold to the generic with NO qualifier.
 */
const GENERIC_TOKEN_RE =
  /^(about|approximately|\d+(?:[./]\d+)?|\d+(?:\.\d+)?[-–]?(?:inch|inches|mm|cm)|yai|fun|lan|quesillo|polenta|butt|boston)$/;

/** Words that carry no distinguishing content at all. */
const NOISE = new Set([
  "a", "an", "the", "of", "or", "and", "with", "in", "on", "to", "about",
  "such", "as", "count", "inch", "inches", "wide", "width", "thick", "half",
  "pinch", "piece", "pieces", "sen", "ho", "gai",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[()]/g, " ")
    .split(/[\s,]+/)
    .map((t) => t.replace(/[.]+$/, ""))
    .filter((t) => t.length > 0);
}

/**
 * Plural-insensitive, and it is load-bearing rather than tidy: without it
 * `bell peppers` over `red bell pepper` reads "pepper" as a word the specific
 * ADDS, and the rendered qualifier comes out "at least one red pepper" instead
 * of "at least one red". Deliberately the crudest possible rule — the tokens it
 * compares are catalog nouns, not general English — and it only ever widens
 * what counts as SHARED, so it can never invent a distinction.
 */
function stem(t: string): string {
  if (t.endsWith("es") && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) return t.slice(0, -1);
  return t;
}

/** The tokens the SPECIFIC adds over the GENERIC — what the distinction IS. */
export function distinguishingTokens(generic: string, specific: string): string[] {
  const g = new Set(tokens(generic).map(stem));
  return tokens(specific).filter((t) => !g.has(stem(t)) && !NOISE.has(t));
}

export function classifySubsumes(generic: string, specific: string): SubsumesRuling {
  const exact = NAMED[`${generic}||${specific}`];
  if (exact) return exact;
  const byGeneric = NAMED[generic];
  if (byGeneric) return byGeneric;

  const extra = distinguishingTokens(generic, specific);
  // Nothing new at all, or only a dimension/hedge: fold, no qualifier.
  if (extra.length === 0) {
    return {
      klass: "GENERIC", basis: "structural", uncertain: false,
      why: "the specific adds no word the generic lacks",
    };
  }
  if (extra.every((t) => GENERIC_TOKEN_RE.test(t) || /^\d/.test(t))) {
    return {
      klass: "GENERIC", basis: "structural", uncertain: false,
      why: `only a dimension or hedge (${extra.join(" ")}) — nothing for the shopper to honour`,
    };
  }
  const keeps = extra.filter((t) => KEEP_TOKENS.includes(t));
  if (keeps.length > 0) {
    return {
      klass: "KEEP", basis: "keep-token", uncertain: false,
      why: `family "${keeps.join(", ")}" — a different food or state`,
    };
  }
  const quals = extra.filter((t) => QUALIFIER_TOKENS.includes(t));
  if (quals.length > 0) {
    return {
      klass: "QUALIFIER", basis: "qualifier-token", uncertain: false,
      why: `family "${quals.join(", ")}" — a grade, trim, colour or size on the same food`,
    };
  }
  return {
    klass: "KEEP", basis: "catch-all", uncertain: true,
    why: `no family covers (${extra.join(" ")}) — refusing to fold is the safe side, and this one needs a look`,
  };
}

/** The qualifier text a QUALIFIER fold renders: "at least one red". */
export function qualifierText(generic: string, specific: string): string {
  const extra = distinguishingTokens(generic, specific).filter((t) => !GENERIC_TOKEN_RE.test(t));
  return extra.length > 0 ? `at least one ${extra.join(" ")}` : "";
}

// ---------------------------------------------------------------------------
// C — CASING (BUG-323). The rule lowercases the FIRST CHARACTER ONLY, and only
// when the leading token is not a proper noun. Interior capitals are untouched,
// so "Plain Greek yogurt" becomes "plain Greek yogurt".
// ---------------------------------------------------------------------------

/** Leading tokens that KEEP their capital. `?` entries are flagged in the digest. */
export const PROPER_NOUN_LEADS: readonly string[] = [
  "American", "Asian", "Basmati", "Belgian", "Brussels", "Caesar", "Cajun",
  "Cheese", "Chinese", "Chinkiang", "Cotija", "Creole", "English", "Frank's",
  "French", "Fritos", "Granny", "Greek", "Guinness", "Hatch", "Hawaiian",
  "Honeycrisp", "Italian", "Italian-seasoned", "Italian-style", "Japanese",
  "Kalamata", "Kashmiri", "Madras", "Mexican", "Near", "New", "Oaxacan",
  "Old", "Panang", "Parmesan", "Parmigiano-Reggiano", "Pecorino", "Persian",
  "Pico", "Ritz", "San", "Shaoxing", "Sichuan", "Spanish", "St.", "Swiss",
  "Szechuan", "T-bone", "Thai", "Yukon",
];

/** The ones this lane CHOSE rather than read off a ruling. Digest marks them `?`. */
export const PROPER_NOUN_UNCERTAIN: readonly string[] = [
  "Basmati", "Brussels", "Cotija", "Kalamata", "Parmesan", "Ritz",
];

export function lowercaseLead(displayName: string): string {
  const lead = displayName.trim().split(/\s+/)[0] ?? "";
  if (PROPER_NOUN_LEADS.includes(lead)) return displayName;
  if (!/^[A-Z]/.test(displayName)) return displayName;
  return displayName.charAt(0).toLowerCase() + displayName.slice(1);
}

// ---------------------------------------------------------------------------
// N — BUY NAMES (R7). `line` is what the shopper reads, qualifier included;
// the Instacart search term is what instacartSearchName ALREADY derives from
// `line` (measured, not proposed — see the report).
// ---------------------------------------------------------------------------

export interface NameCleaning {
  current: string;
  line: string;
  why: string;
  uncertain: boolean;
}

const NEUTRAL_OIL_SPELLINGS = [
  "neutral oil", "neutral cooking oil", "neutral oil (for frying)",
  "neutral oil for frying", "neutral oil (such as avocado or canola oil)",
  "neutral oil (such as canola or grapeseed)", "neutral oil (such as canola)",
  "neutral oil (such as grapeseed or avocado)",
  "neutral oil (such as grapeseed or canola)", "neutral oil (such as vegetable oil)",
  "neutral oil (such as vegetable or avocado oil)",
  "neutral oil (such as vegetable or canola oil)",
  "neutral oil (such as vegetable or canola)",
  "neutral oil (such as vegetable or peanut oil)",
  "neutral oil (vegetable or canola)", "neutral vegetable oil",
];

export const NAME_CLEANINGS: readonly NameCleaning[] = [
  ...NEUTRAL_OIL_SPELLINGS.map((current) => ({
    current,
    line: "vegetable oil",
    why: "Hans: neutral oil can be considered vegetable oil — a store sells vegetable oil and sells nothing called neutral oil",
    uncertain: false,
  })),
  {
    current: "neutral cooking spray", line: "cooking spray",
    why: "same ruling, applied to the spray form", uncertain: false,
  },
  {
    current: "lard or neutral oil", line: "lard or vegetable oil",
    why: "the or-alternative is NOT rewritten (instacartName's stated rule); only the neutral half is renamed",
    uncertain: true,
  },
  // the cut/spec names the corpus prints
  {
    current: "bone-in, skin-on chicken thighs", line: "chicken thighs (bone-in, skin-on)",
    why: "R7 verbatim — this is the name that failed to match on Instacart, September 19", uncertain: false,
  },
  {
    current: "bone-in skin-on chicken thighs", line: "chicken thighs (bone-in, skin-on)",
    why: "the comma-less spelling of the same food", uncertain: false,
  },
  {
    current: "bone-in, skin-on chicken drumsticks", line: "chicken drumsticks (bone-in, skin-on)",
    why: "same shape", uncertain: false,
  },
  {
    current: "boneless skinless chicken thighs", line: "chicken thighs (boneless, skinless)",
    why: "same shape, the other trim", uncertain: false,
  },
  {
    current: "corn tortillas (6-inch)", line: "corn tortillas (6-inch)",
    why: "already R7's shape — the size is already a parenthetical, so only the search term changes and it already does",
    uncertain: false,
  },
  {
    current: "large flour tortillas (10-inch)", line: "flour tortillas (large, 10-inch)",
    why: "R7's verbatim shape — flour tortillas (8-inch)", uncertain: false,
  },
  {
    current: "large flour tortillas (12-inch)", line: "flour tortillas (large, 12-inch)",
    why: "same", uncertain: false,
  },
  {
    current: "flour tortillas (10-inch)", line: "flour tortillas (10-inch)",
    why: "already the shape", uncertain: false,
  },
  {
    current: "mozzarella cheese, shredded", line: "shredded mozzarella cheese",
    why: "the comma inversion is not a search term; the store sells shredded mozzarella cheese",
    uncertain: false,
  },
  {
    current: "day-old cooked long-grain white rice", line: "long-grain white rice (day-old, cooked)",
    why: "day-old and cooked are recipe states, not things a store stocks", uncertain: false,
  },
  {
    current: "80/20 ground beef", line: "ground beef (80/20)",
    why: "R7's shape — the lean ratio is the spec, the product is ground beef", uncertain: true,
  },
  // the parts still named as the buy
  {
    current: "fresh basil leaves", line: "fresh basil (leaves)",
    why: "the pool edge is admitted and correct; it declines only because the demand arrives in `each` against a yield in cups with no grams-per-leaf. The NAME is fixable now, the pool is not.",
    uncertain: true,
  },
  { current: "fresh sage leaves", line: "fresh sage (leaves)", why: "same", uncertain: true },
  {
    current: "iceberg lettuce leaves", line: "iceberg lettuce (leaves)",
    why: "a synonym edge already folds it to iceberg lettuce; the fold never fires because no plan carries both rows, so the name has to carry it",
    uncertain: true,
  },
];

/** Names the R7 sweep looked at and DECLINED to change, so nobody re-proposes them. */
export const NAME_REFUSALS: readonly { name: string; why: string }[] = [
  {
    name: "bay leaves",
    why: "NOT a part — a store sells a container of bay leaves and sells no bay. The census's part-word regex is over-broad here; casing is the only change (section C).",
  },
  { name: "fennel fronds", why: "gets a PARENT EDGE, not a rename — see section P." },
];

// ---------------------------------------------------------------------------
// P — the one part edge R7 asks for.
// ---------------------------------------------------------------------------

export const PART_EDGES: readonly {
  parent: string;
  child: string;
  yieldQuantity: number;
  yieldUnit: string;
  coHarvestable: boolean;
  why: string;
  uncertain: boolean;
}[] = [
  {
    parent: "fennel bulb",
    child: "fennel fronds",
    yieldQuantity: 3,
    yieldUnit: "tablespoon",
    coHarvestable: true,
    why: "Hans: tops are part of the bulb and come with it. The bulb row ALREADY EXISTS (canonicalName `fennel bulb`, purchaseUnit `each`, pack '1 fennel bulb') so no new catalog row is needed — the prompt's premise is wrong on that point. `each` is in COMPONENT_BASIS_UNITS, so the edge is admitted as authored.",
    uncertain: true,
  },
];
