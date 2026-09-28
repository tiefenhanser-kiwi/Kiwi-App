// [grocery] B2 — THE DATA. Everything the digest, the defaults list and the dry
// run read their figures from HERE, so Hans's rulings land in one place. B1's
// `scripts/grocery-b1/proposals.ts` has the same job and the same shape.
//
// Nothing in this file touches the database.
//
// ── THE MODEL, AFTER HANS'S SEPTEMBER 28 RULINGS (H1–H7) ────────────────────
//
// Part A classified every subsumes edge as QUALIFIER / KEEP / GENERIC and
// folded the QUALIFIER ones onto the generic with an "at least one X" rider.
// Hans ruled that wrong in three messages. The replacement:
//
//   H1  BUY WHAT THE RECIPE SAYS. A variety, colour, cut or state a recipe
//       names is bought as named, on its own line. Varieties NEVER merge with
//       each other.
//   H2  A plain name with a ruled everyday DEFAULT joins the default's line and
//       is named as the default. (`chicken thighs` -> `bone-in chicken thighs`.)
//   H3  A plain name with NO default stays generic and CARRIES the called-out
//       varieties — but ONLY when a recipe demanded the generic itself, and only
//       in WHOLE UNITS of the line's buy unit. "5 bell peppers, at least 2 red
//       and at least 2 yellow."
//   H4  A plain name is never upgraded to a specific. "1 tbsp parsley" buys
//       parsley. Hedge, size and prep words are not varieties — they are
//       stripped (the GENERIC class).
//   H5  Weight- and volume-sold generics never carry shares.
//   H6  After any fold, B1's arithmetic runs on the group total.
//   H7  The retailer hand-off keeps the shopper's constraint.
//
// So an edge now answers ONE question — what happens when BOTH names are on the
// list — and the three answers are:
//
//   H1       two lines, always. The specific is a different product.
//   H3       one line IF the generic was demanded and the generic is count-sold;
//            two lines otherwise. The specific is a real store product that the
//            generic can stand in for when the shopper is choosing anyway.
//   GENERIC  one line, always, no rider. The "specific" is a hedge, a size or a
//            prep note, not a product.

export type HClass = "H1" | "H3" | "GENERIC";

export interface EdgeRuling {
  hClass: HClass;
  why: string;
  /** true => this lane chose; false => a quoted Hans ruling decided it. */
  uncertain: boolean;
}

// ---------------------------------------------------------------------------
// 1 — HEDGES. Not products. Stripped, unconditionally (H4 last clause).
// ---------------------------------------------------------------------------

/** A token that is a hedge on its own. */
const HEDGE_TOKENS = new Set([
  "about", "approximately", "ripe", "roughly", "finely", "thinly", "chopped",
  "sliced", "diced", "minced", "grated", "crushed", "halved", "quartered",
  "width", "thick", "inch", "inches", "count", "spears",
  "yai", "fun", "lan", "quesillo", "polenta", "butt", "boston",
]);

/**
 * Hedges ONLY IN THE COMPANY OF A DIMENSION. "wide" in
 * "flat rice noodles (6–8mm wide)" is part of a measurement; "wide" in
 * "wide egg noodles" is the product. The discriminator is whether a dimension
 * token is standing next to it.
 */
const HEDGE_WITH_DIMENSION = new Set(["wide", "long", "thin"]);

/**
 * A token that is only a dimension: "8mm", "3–5mm", "1.25", "6-inch",
 * "16/20" (a shrimp count).
 *
 * ⚠️ A LEAN RATIO LOOKS EXACTLY LIKE A SHRIMP COUNT and is not one: "80/20" and
 * "85/15" are the PRODUCT (the go-ahead lists them under H1). They are caught
 * before this runs, because the H1 test now sees the raw tokens rather than the
 * hedge-stripped ones — see classifyEdge.
 */
const DIMENSION_RE = /^~?\d+(?:[.,/–-]\d+)?\s*(?:mm|cm|inch|inches|")?$/;

// ---------------------------------------------------------------------------
// 2 — THE TOKEN FAMILIES, as Hans ruled them on the Part A digest.
// ---------------------------------------------------------------------------

/**
 * H1 — the token names a DIFFERENT PRODUCT. Two lines, always.
 * Straight from the go-ahead's "Families -> H1 (separate lines)" list.
 */
export const H1_TOKENS = new Set([
  // state
  "dried", "frozen", "fire-roasted", "pickled", "smoked",
  // heat / flavour — the shopper's own choice, never ours
  "hot", "spicy", "mild", "sweet", "honey", "smoky", "buffalo",
  // named chiles and spice blends
  "kashmiri", "thai", "fresno", "hatch", "sichuan", "szechuan", "madras",
  "ancho", "chipotle", "roja", "verde", "serrano", "habanero",
  // named sausages
  "andouille", "kielbasa",
  // tomato varieties
  "cherry", "heirloom", "plum", "roma", "beefsteak",
  // greens
  "lacinato", "curly", "iceberg", "romaine", "little", "butter",
  // cuts
  "bone-in", "boneless", "skinless", "skin-on",
  // lean ratios
  "80/20", "85/15", "85%", "lean",
  // apple cultivars
  "crisp", "granny", "honeycrisp", "braeburn",
  // seasoned breadcrumbs — the go-ahead names #114/#115 explicitly
  "italian-seasoned",
  // one more the go-ahead names in the S.1 list
  "bulk",
]);

/**
 * H3 — the token names a REAL STORE PRODUCT the generic can stand in for while
 * the shopper is choosing anyway. One line when the generic was demanded and is
 * count-sold; two lines otherwise.
 */
export const H3_TOKENS = new Set([
  "san", "marzano", "canned", "jarred", "refrigerated", "store-bought",
  "large", "medium", "small", "jumbo", "baby",
  "peeled", "deveined", "shelled", "pitted", "trimmed", "frenched",
  "whole-milk", "part-skim", "low-moisture", "low-sodium", "reduced-sodium",
  "flat", "long-grain", "short-grain", "stone-ground",
  "japanese", "mexican", "french", "italian", "albacore", "solid",
  "sharp", "extra-sharp", "aged", "thick-cut", "thin-cut", "center-cut",
  "navel", "brioche", "potato", "unsalted", "salted", "whole", "grain",
  "fine", "coarse", "wide", "restaurant-style", "poppy", "seed",
  "fresh", "yukon", "gold", "russet", "dill", "shell-on", "tails",
]);

/**
 * COLOURS ARE H3, AND H1'S "every onion and pepper color" IS ABOUT SIBLINGS.
 *
 * The first cut read that line as "a colour is always H1" and it made Hans's own
 * worked example impossible: on `247cd7bb` a plan demanding plain `bell peppers`
 * AND `green bell pepper` printed two lines, where Hans asked for
 * "5 bell peppers, at least 2 red and at least 2 yellow".
 *
 * The two rules are about different pairs:
 *   H1  SIBLING vs SIBLING — red onion never merges with white onion. Nothing
 *       has to enforce this: every subsumes edge runs GENERIC -> SPECIFIC, and
 *       there is not one sibling-to-sibling edge in the 308 (checked).
 *   H3  GENERIC vs SPECIFIC — `onion` over `red onion`. Hans's pepper sentence
 *       is exactly this pair, and it folds when the generic was demanded.
 *
 * So `f5556c19`'s three onions stay three lines because no recipe there asks for
 * a plain onion — not because a colour is H1.
 */
const COLOUR_TOKENS = new Set(["red", "yellow", "white", "green", "purple", "orange"]);

// ---------------------------------------------------------------------------
// 3 — PER-EDGE OVERRIDES. Every one is a line the go-ahead ruled by number.
// ---------------------------------------------------------------------------

const EDGE_OVERRIDES: Record<string, EdgeRuling> = {};
const put = (generic: string, specific: string, hClass: HClass, why: string, uncertain = false) => {
  EDGE_OVERRIDES[`${generic}||${specific}`] = { hClass, why, uncertain };
};

// -- the go-ahead's S.1 rulings, by digest number --------------------------
// #175 / #316 -> H1
put("dried rice noodles", "dried rice vermicelli noodles", "H1", "go-ahead S.1 #175 — vermicelli is a different noodle");
put("rice noodles", "rice vermicelli noodles", "H1", "go-ahead S.1 #316 — same");
put("rice noodles", "dried rice vermicelli noodles", "H1", "go-ahead S.1 #175/#316 — same");
// #183 -> GENERIC (a width)
put("rice noodles", "flat rice noodles (6–8 mm wide)", "GENERIC", "go-ahead S.1 #183 — a width, not a product");
put("rice noodles", "flat rice noodles (6–8mm wide)", "GENERIC", "go-ahead S.1 #183 — same, the other spelling");
// #279 -> H1 (B1's co-harvest edge handles the brine)
put("pickle brine", "dill pickle brine", "H1", "go-ahead S.1 #279 — B1's co-harvest edge handles brine");
// #298 -> H1 and never-order
put(
  "reserved birria braising liquid", "reserved braising liquid from chicken birria",
  "H1", "go-ahead S.1 #298 — H1, and BOTH endpoints are never-order (see NEVER_ORDER_CANDIDATES)",
);
// #356 -> H1
put("smoked kielbasa", "smoked pork kielbasa", "H1", "go-ahead S.1 #356");
// #74 / #203 -> H1
put("ground beef", "ground beef (80/20 chuck)", "H1", "go-ahead S.1 #74/#203 — a lean ratio is the product");
put("ground beef (80/20)", "ground beef (80/20 chuck)", "H1", "go-ahead S.1 #74/#203");
put("80/20 ground beef", "ground beef (80/20 chuck)", "H1", "go-ahead S.1 #74/#203");
// #211 / #216 / #218 / #266 -> H3 within a variety, H1 across mild / hot
put("italian pork sausage", "italian pork sausage links", "H3", "go-ahead S.1 #211/#218 — links vs bulk within one variety");
put("italian sausage", "italian pork sausage links", "H3", "go-ahead S.1 #211/#218 — same");
put("italian sausage", "bulk italian sausage", "H3", "go-ahead S.1 #216 — bulk vs links within one variety");
put("italian pork sausage links", "mild italian pork sausage links", "H1", "go-ahead S.1 #266 — H1 across mild/hot");
put("mild italian pork sausage", "mild italian pork sausage links", "H3", "go-ahead S.1 #211 — within the mild variety");
// #286 -> H3/H1. "di parma" is a grade of the same cured ham, not a hedge; the
// first cut listed `di` and `parma` as hedge words and folded it away silently.
put("prosciutto", "prosciutto di parma", "H3", "go-ahead S.1 #286 — a grade of the same product");

// -- the `fresh` family, all 11 edges, reported per the go-ahead ------------
// H3 where `fresh` is the produce aisle's default state …
put("corn kernels", "fresh corn kernels", "H3", "`fresh` is whole produce's default state");
put("green beans", "fresh green beans", "H3", "same");
put("okra", "fresh okra", "H3", "same");
put("asparagus", "fresh asparagus spears, thick-cut", "H3", "same; `spears` and `thick-cut` are a hedge and a grade");
put("fresh asparagus", "fresh asparagus spears, thick-cut", "H3", "same");
put("fresh asparagus spears", "fresh asparagus spears, thick-cut", "H3", "same");
// … and H1 where `fresh` names a DIFFERENT PRODUCT (the go-ahead's own carve-out)
put("rice noodles", "fresh wide rice noodles", "H1", "fresh rice noodles are refrigerated, not shelf-stable — a different product (go-ahead's `fresh mozzarella` carve-out)");
put("rice noodles", "fresh wide rice noodles (ho fun)", "H1", "same");
put("rice noodles", "fresh wide rice noodles (sen yai)", "H1", "same");
put("kale", "fresh lacinato kale", "H1", "`lacinato` is H1 regardless of `fresh`");
put("red chili", "fresh red thai chilies", "H1", "`thai` is H1 regardless of `fresh`");

// -- Hans's named product rulings, carried forward from Part A --------------
for (const s of ["butter lettuce", "butter lettuce leaves", "green leaf lettuce",
  "iceberg lettuce", "iceberg lettuce leaves", "little gem lettuce", "romaine lettuce",
  "romaine lettuce hearts", "romaine lettuce leaves", "shredded iceberg lettuce",
  "shredded romaine lettuce"]) {
  put("lettuce", s, "H1", "Hans: lettuce over iceberg / romaine / hearts is a different product");
}
for (const s of ["coarse kosher salt", "fine salt", "fine sea salt", "hawaiian sea salt", "kosher salt"]) {
  put("salt", s, "H1", "BUG-168 LOCKED + NEVER_FOLD_PAIRS — and H1 reaches the same answer independently");
}
for (const s of ["chunky salsa", "fresh salsa", "fresh tomato salsa", "jarred salsa",
  "jarred salsa (medium)", "jarred salsa roja", "jarred salsa verde", "mild salsa", "salsa verde"]) {
  put("salsa", s, "H1", "Hans: salsa over verde is a different product");
}
for (const s of ["ancho chili powder", "chipotle chili powder", "kashmiri chili powder",
  "kashmiri red chili powder", "pinch of kashmiri red chili powder"]) {
  put("chili powder", s, "H1", "Hans: chili powder over ancho is a different product");
}
put("canned diced tomatoes", "canned fire-roasted diced tomatoes", "H1", "Hans: diced tomatoes over fire-roasted is a different product");
for (const s of ["diced fire-roasted tomatoes", "fire-roasted diced tomatoes", "canned fire-roasted diced tomatoes"]) {
  put("diced tomatoes", s, "H1", "Hans: diced tomatoes over fire-roasted is a different product");
}
// crusty bread — Hans: "could be sourdough, but could be french so it stays generic"
for (const s of ["crusty italian bread", "crusty italian bread loaf", "crusty sourdough bread"]) {
  put("crusty bread", s, "GENERIC", "Hans: could be sourdough, but could be french so it stays generic");
}

// -- the two the go-ahead ruled on S.PROMO ----------------------------------
// #1 parsley over flat-leaf: H3 only, via the single-bunch case. No default.
put("parsley", "fresh flat-leaf parsley", "H3", "go-ahead S.PROMO #1 — H3 only; where the two share one bunch the line becomes `1 bunch flat-leaf parsley`");
put("fresh parsley", "fresh flat-leaf parsley", "H3", "go-ahead S.PROMO #1 — same pair, the `fresh` spelling");
// #2 chicken thighs over boneless skinless: NO.
put("chicken thighs", "boneless skinless chicken thighs", "H1", "go-ahead S.PROMO #2 — NO (H1). Hans: recipes should be calling for what they need");

// ---------------------------------------------------------------------------
// 4 — THE CLASSIFIER
// ---------------------------------------------------------------------------

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[()]/g, " ").split(/[\s,]+/)
    .map((t) => t.replace(/[.]+$/, "")).filter((t) => t.length > 0);
}

/** Crude, deliberately: these are catalog nouns, not general English. */
function stem(t: string): string {
  if (t.endsWith("es") && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) return t.slice(0, -1);
  return t;
}

const NOISE = new Set(["a", "an", "the", "of", "or", "and", "with", "in", "on", "to", "as", "such", "pinch"]);

/** The tokens the SPECIFIC adds over the GENERIC — what the distinction IS. */
export function distinguishingTokens(generic: string, specific: string): string[] {
  const g = new Set(tokens(generic).map(stem));
  return tokens(specific).filter((t) => !g.has(stem(t)) && !NOISE.has(t));
}

export function classifyEdge(generic: string, specific: string): EdgeRuling {
  const o = EDGE_OVERRIDES[`${generic}||${specific}`];
  if (o) return o;

  const extra = distinguishingTokens(generic, specific);
  if (extra.length === 0) {
    return { hClass: "GENERIC", why: "the specific adds no word the generic lacks", uncertain: false };
  }

  // ⚠️ H1 IS TESTED ON THE RAW TOKENS, BEFORE THE HEDGES ARE STRIPPED, and that
  // ordering is load-bearing rather than tidy. A lean ratio is spelled exactly
  // like a shrimp count — "80/20" and "16/20" — so a hedge strip that runs first
  // deletes the ratio and turns `ground beef` over `ground beef (80/20 chuck)`
  // into a GENERIC fold, which is the opposite of what the go-ahead ruled.
  const h1 = extra.filter((t) => H1_TOKENS.has(t));
  if (h1.length > 0) {
    return { hClass: "H1", uncertain: false, why: `"${h1.join(", ")}" names a different product (H1)` };
  }

  const hasDimension = extra.some((t) => DIMENSION_RE.test(t));
  const real = extra.filter(
    (t) =>
      !HEDGE_TOKENS.has(t) &&
      !DIMENSION_RE.test(t) &&
      !(hasDimension && HEDGE_WITH_DIMENSION.has(t)),
  );
  if (real.length === 0) {
    return {
      hClass: "GENERIC", uncertain: false,
      why: `only hedges, sizes or prep (${extra.join(" ")}) — H4's last clause`,
    };
  }
  const h3 = real.filter((t) => H3_TOKENS.has(t) || COLOUR_TOKENS.has(t));
  if (h3.length > 0) {
    return { hClass: "H3", uncertain: false, why: `"${h3.join(", ")}" is a store product the generic can stand in for (H3)` };
  }
  return {
    hClass: "H1", uncertain: true,
    why: `no family covers (${real.join(" ")}) — H1 is the safe side, because it buys exactly what the recipe said`,
  };
}

// ---------------------------------------------------------------------------
// 5 — THE DEFAULTS (H2)
// ---------------------------------------------------------------------------

export interface DefaultRuling {
  generic: string;
  /**
   * The CANONICAL NAME of the default, null = NONE (follow H3).
   *
   * ⚠️ It must be a canonical that EXISTS. `bone-in chicken thighs` — the name
   * Hans ruled and the name the line prints — has no catalog row: the rows are
   * `bone-in skin-on chicken thighs` and `bone-in, skin-on chicken thighs`
   * (one synonym cluster). The first cut named the printed name here, no fold
   * found a target, and `163875ec` printed "2 lb chicken thighs" unchanged.
   * The printed name comes from R7's cleaning of this canonical instead.
   */
  def: string | null;
  /** what the line will read, for the digest. Derived, not a second source. */
  reads: string;
  why: string;
  uncertain: boolean;
}

/**
 * ⚠️ NONE IS THE NORM. Hans: "if the recipe is specific, we honor it. but in
 * lieu of that, we go generic." A default is proposed ONLY where the plain name
 * is not itself something a shopper can pick up, so the generic would otherwise
 * be unbuyable or wrong.
 *
 * Explicitly NOT proposed: parsley -> flat-leaf (Hans: "1 tbsp parsley" =>
 * "parsley"), and every produce generic, which is buyable as itself.
 */
export const DEFAULTS: readonly DefaultRuling[] = [
  {
    generic: "chicken thighs", def: "bone-in skin-on chicken thighs",
    reads: "bone-in chicken thighs",
    why: "RULED. Hans: 'if a recipe calls for generic Chicken Thighs, I would assume it means bone-in.' A meat counter has no unqualified 'chicken thighs' bin — every pack states its cut. The canonical carries `skin-on`; the LINE drops it (go-ahead N #400-#402).",
    uncertain: false,
  },
  {
    generic: "chicken breast", def: "boneless skinless chicken breasts",
    reads: "boneless skinless chicken breasts",
    why: "PROPOSED by parity with the thigh ruling and the other way round: the default retail chicken breast IS the boneless skinless one. Same argument — the case is never sold unqualified.",
    uncertain: true,
  },
];

/**
 * Only RULED defaults move rows in the dry run. A proposal Hans has not yet
 * seen must not quietly rewrite 20 lists underneath the numbers he is reading.
 */
export const RULED_DEFAULTS = DEFAULTS.filter((d) => d.def && !d.uncertain);

// ---------------------------------------------------------------------------
// 6 — H5: WHICH GENERICS CAN CARRY SHARES AT ALL
// ---------------------------------------------------------------------------

/**
 * H3's rider is "at least N <variety>" in WHOLE UNITS of the line's buy unit.
 * A generic sold by weight or volume has no such unit, so it never carries one
 * (H5: no "3 lb ground beef, at least 1 lb 80/20").
 *
 * The test is the PACK's unit, which the catalog already stores. Nothing new.
 */
export const COUNT_PACK_UNITS = new Set([
  "each", "head", "heads", "bunch", "bunches", "can", "cans", "jar", "jars",
  "package", "packages", "packet", "packets", "bottle", "bottles", "box",
  "boxes", "bag", "bags", "carton", "cartons", "container", "containers",
  "loaf", "loaves", "block", "blocks", "stick", "sticks", "clamshell", "tub",
  "bulb", "bulbs", "ear", "ears", "dozen", "pint", "quart",
]);

export function packUnitCarriesShares(purchaseUnit: string | null | undefined): boolean {
  if (!purchaseUnit) return false;
  return COUNT_PACK_UNITS.has(purchaseUnit.toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// 7 — C: CASING (BUG-323), unchanged except for the go-ahead's one correction.
// ---------------------------------------------------------------------------

/** Leading tokens that KEEP their capital. */
export const PROPER_NOUN_LEADS: readonly string[] = [
  "American", "Asian", "Belgian", "Brussels", "Caesar", "Cajun",
  "Cheese", "Chinese", "Chinkiang", "Cotija", "Creole", "English", "Frank's",
  "French", "Fritos", "Granny", "Greek", "Guinness", "Hatch", "Hawaiian",
  "Honeycrisp", "Italian", "Italian-seasoned", "Italian-style", "Japanese",
  "Kalamata", "Kashmiri", "Madras", "Mexican", "Near", "New", "Oaxacan",
  "Old", "Panang", "Parmesan", "Parmigiano-Reggiano", "Pecorino", "Persian",
  "Pico", "Ritz", "San", "Shaoxing", "Sichuan", "Spanish", "St.", "Swiss",
  "Szechuan", "T-bone", "Thai", "Yukon",
];
// ⚠️ "Basmati" was on this list in Part A and the go-ahead ruled it OFF
// (digest #419): basmati is a rice variety, lowercase. Removed, not commented
// out, so nothing re-adds it by accident.

export function lowercaseLead(displayName: string): string {
  const lead = displayName.trim().split(/\s+/)[0] ?? "";
  if (PROPER_NOUN_LEADS.includes(lead)) return displayName;
  if (!/^[A-Z]/.test(displayName)) return displayName;
  return displayName.charAt(0).toLowerCase() + displayName.slice(1);
}

// ---------------------------------------------------------------------------
// 8 — N: BUY NAMES (R7), with the go-ahead's chicken rulings applied.
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
    current, line: "vegetable oil",
    why: "Hans: neutral oil can be considered vegetable oil — a store sells vegetable oil and sells nothing called neutral oil",
    uncertain: false,
  })),
  { current: "neutral cooking spray", line: "cooking spray", why: "same ruling, the spray form", uncertain: false },
  { current: "lard or neutral oil", line: "lard or vegetable oil", why: "go-ahead N #399 YES — the or-alternative is not rewritten; only the neutral half is renamed", uncertain: false },

  // ── the chicken cuts, as the go-ahead ruled them (#400-#403) ─────────────
  //
  // ⚠️ "skin-on" IS DROPPED FROM THE LINE unless the recipe's own text carries
  // it. Not a simplification: under H1 the cut is the product, and the go-ahead
  // ruled the product here is `bone-in chicken thighs`.
  { current: "bone-in, skin-on chicken thighs", line: "bone-in chicken thighs", why: "go-ahead N #400 — skin-on dropped from the line", uncertain: false },
  { current: "bone-in skin-on chicken thighs", line: "bone-in chicken thighs", why: "go-ahead N #401 — same, the comma-less spelling", uncertain: false },
  { current: "bone-in, skin-on chicken drumsticks", line: "bone-in chicken drumsticks", why: "go-ahead N #402", uncertain: false },
  { current: "bone-in skin-on chicken drumsticks", line: "bone-in chicken drumsticks", why: "go-ahead N #402 — same, the comma-less spelling", uncertain: false },
  {
    current: "boneless skinless chicken thighs", line: "boneless skinless chicken thighs",
    why: "go-ahead N #403 — STAYS, and is searched as exactly that (H7)", uncertain: false,
  },

  { current: "corn tortillas (6-inch)", line: "corn tortillas (6-inch)", why: "already R7's shape; only the search term changes, and it already does", uncertain: false },
  { current: "large flour tortillas (10-inch)", line: "flour tortillas (large, 10-inch)", why: "R7's verbatim shape", uncertain: false },
  { current: "large flour tortillas (12-inch)", line: "flour tortillas (large, 12-inch)", why: "same", uncertain: false },
  { current: "flour tortillas (10-inch)", line: "flour tortillas (10-inch)", why: "already the shape", uncertain: false },
  { current: "mozzarella cheese, shredded", line: "shredded mozzarella cheese", why: "the comma inversion is not a search term", uncertain: false },
  { current: "day-old cooked long-grain white rice", line: "long-grain white rice (day-old, cooked)", why: "day-old and cooked are recipe states, not things a store stocks", uncertain: false },
  { current: "80/20 ground beef", line: "ground beef (80/20)", why: "go-ahead N #410 YES", uncertain: false },
  { current: "fresh basil leaves", line: "fresh basil (leaves)", why: "go-ahead N #411 YES", uncertain: false },
  { current: "fresh sage leaves", line: "fresh sage (leaves)", why: "go-ahead N #412 YES", uncertain: false },
  { current: "iceberg lettuce leaves", line: "iceberg lettuce (leaves)", why: "go-ahead N #413 YES", uncertain: false },
];

export const NAME_REFUSALS: readonly { name: string; why: string }[] = [
  { name: "bay leaves", why: "go-ahead N9 — NOT a part. A store sells a container of bay leaves and sells no bay; the census part-word regex is over-broad. Casing is the only change." },
  { name: "fennel fronds", why: "gets a PARENT EDGE, not a rename — see PART_EDGES." },
];

export const PART_EDGES: readonly {
  parent: string; child: string; yieldQuantity: number; yieldUnit: string;
  coHarvestable: boolean; why: string; uncertain: boolean;
}[] = [
  {
    parent: "fennel bulb", child: "fennel fronds", yieldQuantity: 3, yieldUnit: "tablespoon",
    coHarvestable: true, uncertain: false,
    why: "go-ahead N #416 YES. Hans: tops are part of the bulb and come with it. The bulb row ALREADY EXISTS (purchaseUnit `each`, pack '1 fennel bulb'), so `each` is in COMPONENT_BASIS_UNITS and the edge is admitted as authored.",
  },
];

/** go-ahead N6 — the label is wrong, not the edge. */
export const RELABEL_TO_SYNONYM: readonly { from: string; to: string; why: string }[] = [
  {
    from: "romaine lettuce", to: "romaine lettuce hearts",
    why: "go-ahead N6 — Hans: 'Romaine lettuce hearts are just romaine in my opinion.' The row is labelled `component`, which asserts a yield relation that does not exist. Relabel to `synonym`, reviewedByHuman.",
  },
];

/**
 * go-ahead S.1 #298 — H1 AND never-order. Both endpoints are a by-product of
 * cooking, not a purchase. `isNeverOrdered` (groceryStaples.ts) is the existing
 * home; these are candidates for it, reported rather than written by this file.
 */
export const NEVER_ORDER_CANDIDATES: readonly string[] = [
  "reserved birria braising liquid",
  "reserved braising liquid from chicken birria",
  "pasta cooking water",
  "reserved pasta cooking water",
];
