// [grocery] B2 Part C — THE SUBSUMES CLASSIFIER, in production.
//
// Hans's September 28 rulings, H1-H7. The question one `subsumes` edge answers
// is: WHAT HAPPENS WHEN BOTH NAMES ARE ON THE LIST.
//
//   H1       two lines, always. The specific is a different product.
//   H3       one line IF a recipe demanded the generic AND the generic is
//            count-sold; two lines otherwise. The specific is a real store
//            product the generic can stand in for while the shopper chooses.
//   GENERIC  one line, always, no rider. The "specific" is a hedge, a size or a
//            prep note, not a product.
//
// ⚠️ THIS FILE IS THE ONE TABLE. `scripts/grocery-b2/proposals.ts` — the reviewed
// sheet the digests render — imports from here rather than keeping a copy, so the
// classification Hans ruled on and the classification production applies cannot
// drift. The scripts own the DATA (which names, which defaults); this owns the
// RULES.
//
// Pure. Nothing here touches Prisma, and nothing imports anything but the
// normaliser.

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
// #2 chicken thighs over boneless skinless: NO as a CLASS, and then made the
// DEFAULT, which is a different question and a different mechanism.
//
// ⚠️ THIS LOOKS LIKE A CONTRADICTION AND IS NOT. The class says what happens when
// both names are demanded: two lines, because the cut is the product (H1). The
// DEFAULT says what the PLAIN name means when nobody said: the boneless skinless
// pack (H2). `admitSubsumes` tests RULED_DEFAULT_PAIRS first for exactly this
// reason, so the H2 join fires and the H1 class governs nothing it should not.
// Do not "reconcile" these by deleting one.
put("chicken thighs", "boneless skinless chicken thighs", "H1", "go-ahead S.PROMO #2 — NO as a class (H1); the same pair is the H2 DEFAULT, which is a different question");

// ---------------------------------------------------------------------------
// 4 — THE CLASSIFIER
// ---------------------------------------------------------------------------

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[()]/g, " ").split(/[\s,]+/)
    .map((t) => t.replace(/[.]+$/, "")).filter((t) => t.length > 0);
}

/** Crude, deliberately: these are catalog nouns, not general English. */
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
function stem(t: string): string {
  if (/(?:ss|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("oes")) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 2) return t.slice(0, -1);
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
    generic: "chicken thighs", def: "boneless skinless chicken thighs",
    reads: "boneless skinless chicken thighs",
    why: "RULED, and FLIPPED on September 28 after the build go-ahead. Hans: 'it sounds like boneless skinless thighs are more popular, especially for easy cooking. I think we need to update the map to \"chicken thighs\" => boneless skinless thighs, and \"bone in chicken thighs\" stays \"bone in chicken thighs\"'. A meat case has no unqualified bin, so the plain name has to mean SOMETHING; the everyday one is the boneless skinless pack.",
    uncertain: false,
  },
  {
    generic: "chicken breast", def: "boneless skinless chicken breasts",
    reads: "boneless skinless chicken breasts",
    // RULED Sept 28 (Parts B-E go-ahead, defaults #54: YES). Was `?` in A2.
    why: "RULED. Parity with the thigh ruling and the other way round: the default retail chicken breast IS the boneless skinless one. Same argument — the case is never sold unqualified.",
    uncertain: false,
  },
];

/**
 * Only RULED defaults move rows. A proposal Hans has not seen must not quietly
 * rewrite 20 lists underneath the numbers he is reading; both are ruled now, so
 * this is the whole list.
 */
export const RULED_DEFAULTS = DEFAULTS.filter((d) => d.def && !d.uncertain);

/**
 * ⚠️ `chicken thighs -> bone-in skin-on chicken thighs` IS NOT A DEFAULT, and the
 * absence is the ruling rather than an omission.
 *
 * It was the default for about two hours on September 28 and Hans reversed it:
 * boneless skinless is the everyday pack, and "a recipe wanting bone-in must say
 * so" — his examples were "oven roasted chicken thighs" and "grilled whole
 * thighs". So `bone-in chicken thighs` stays H1: its own line when a recipe names
 * it, displayed without "skin-on" (the N cleanings), searched as exactly that.
 *
 * Part B's first pass flipped `reviewedByHuman` on the bone-in row with a
 * rationale calling it the default. The amended apply reverses that, because a
 * stale rationale in the data is a decision nobody made.
 */
export const DEMOTED_DEFAULT_PAIRS: readonly { generic: string; specific: string; why: string }[] = [
  {
    generic: "chicken thighs",
    specific: "bone-in skin-on chicken thighs",
    why: "Hans, September 28, reversing his own earlier ruling: boneless skinless is the default thigh; a recipe wanting bone-in must say so.",
  },
];

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
