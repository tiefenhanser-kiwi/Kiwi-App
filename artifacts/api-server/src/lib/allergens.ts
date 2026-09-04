// Allergen derivation — the single vocabulary, and the single place it is applied.
//
// WHY THIS MODULE EXISTS. Allergen stamping used to live in storeFill.ts and was
// called from exactly ONE site (the batch harness). Every other path into the
// shared pool — the live write-back, the seeds, and the in-place `isPublic` flip
// in scripts/promoteInstanceToTemplate.ts — published meals with `allergens: []`.
// Under the conservative retrieval rule in store/allergenFilter.ts ("if the user
// declared any allergy, also require a non-empty stamp"), an unstamped meal is
// EXCLUDED, so those meals were invisible to every allergic user. Measured
// 2026-09-04: 129 of 1,192 public dinners unstamped, and 100% of the
// `live_writeback` population — the only actively-growing source. Newest stamped
// public dinner was 2026-07-24; newest unstamped was 2026-09-01.
//
// So the derivation is split in two:
//   deriveAllergensFromNames(names)  — PURE. The vocabulary lives here alone.
//   stampAllergens(tx, mealId)       — reads the PERSISTED ingredient graph.
//
// The graph reader is what makes the other three paths fixable: a clone and an
// in-place publish have no AI payload to derive from, only rows. Verified before
// relying on it — re-running the OLD algorithm over DB ingredient names
// reproduced the stored stamp for 1063 of 1063 stamped meals (zero drift), so
// the graph is a faithful substitute for the payload.
//
// The precedent for a graph-reading post-write step is two lines from the gap it
// closes: wizardActivation.ts already calls recomputeAndPersistMealMacros(tx,
// meal.id) immediately before publishMealToStore.

import type { Prisma } from "@prisma/client";

import { logger } from "./logger";

type Tx = Prisma.TransactionClient;

/** The ingredient-name shape both callers reduce to. */
export interface AllergenDerivableMeal {
  dishes: ReadonlyArray<{ ingredients: ReadonlyArray<{ name: string }> }>;
}

// ── matching modes ───────────────────────────────────────────────────────────
//
// "word" — \bterm(?:s|es)?\b. The default.
//
//   The plural tolerance is NOT optional. Bare \bterm\b drops `peanuts`,
//   `sliced almonds`, `mussels`, `corn tortillas`, `breadcrumbs` and 6 more
//   real matches; (?:s|es)? recovers all of them.
//
//   Word matching is what kills the substring false positives:
//     "eggplant".includes("egg")                -> true   (3 names)
//     "parmigiano-reggiano".includes("egg")     -> true   (7 names, 29 meals)
//     "tamarind".includes("tamari")             -> true   (3 names)
//     "butternut squash".includes("butter")     -> true
//     "creamy peanut butter".includes("cream")  -> true
//   \b..\b rejects every one while keeping the legitimate matches.
//
// "raw" — plain substring. ONE token uses it, deliberately: see `fish`.
type MatchMode = "word" | "raw";

interface TokenSpec {
  mode: MatchMode;
  terms: readonly string[];
  /**
   * Names that carry a matching term but are NOT this allergen. Applied per
   * INGREDIENT NAME: a disqualified name contributes nothing to this token,
   * while other ingredients in the same meal still can.
   */
  disqualifiers?: readonly RegExp[];
}

// ⚠️ THIS IS A PHRASE LIST, NOT A WORD RULE. DO NOT "SIMPLIFY" IT.
//
// The obvious shape is a generic modifier rule — treat any name containing the
// word `corn` or `rice` as non-wheat. It is clean on today's catalog and wrong
// the day a `cornbread` or a `rice bread` is generated: both contain wheat, and
// a generic rule would silently un-stamp them. Word boundaries do not help here
// either — `tortilla` and `noodle` are genuine whole words; what disqualifies
// them is the MODIFIER in front. So each exemption is spelled out as a phrase
// and earns its place by naming a real product.
//
// Measured 2026-09-04: 26 catalog names match a wheat word plus a disqualifying
// modifier, and all 26 are genuinely wheat-free. Adding a phrase here removes a
// token from meals, which is the dangerous direction — a new entry needs the
// same evidence.
const NOT_WHEAT: readonly RegExp[] = [
  /\bcorn tortilla/, //          corn tortillas are masa, not wheat  (82 meals)
  /\brice noodle/, //            rice noodles                        (8 meals)
  /\brice vermicelli\b/, //      rice vermicelli
  /\bglass noodle/, //           mung-bean starch
  /\bbean[- ]thread\b/, //       bean thread (glass) noodles
  /\bsweet[- ]potato glass\b/, // dangmyeon
  /\bshirataki\b/, //            konjac
  /\bcassava flour\b/,
  /\balmond flour\b/,
  /\bcoconut flour\b/,
  /\bchickpea flour\b/,
  /\boat flour\b/, //            (naturally GF; cross-contact is a labelling
  //                              question, not a derivation one)
  /\btapioca flour\b/,
  /\bmasa harina\b/, //          \b matters: "garam masala" must not match
  /\bgluten[- ]free\b/,
  /\bspaghetti squash\b/, //     a squash. The single most important entry here:
  //                              without it, adding `spaghetti` for Gap A would
  //                              stamp a vegetable as wheat.
  /\bcauliflower gnocchi\b/,
  /\bzucchini noodle/,
  /\bspring roll\b/, //          rice paper, not a bread roll
];

const ALLERGEN_VOCABULARY: Readonly<Record<string, TokenSpec>> = {
  dairy: {
    mode: "word",
    terms: [
      "milk", "buttermilk", "butter", "ghee", "cream", "creme fraiche", "crème fraîche",
      "half-and-half", "yogurt", "custard", "whey", "casein", "paneer", "queso", "crema",
      // cheeses. `cheese` alone misses every bare varietal name — measured: 7
      // meals carried cheddar/gouda/queso/cotija/crema with NO dairy stamp.
      "cheese", "cheddar", "gouda", "gruyere", "gruyère", "halloumi", "manchego",
      "mascarpone", "provolone", "asiago", "havarti", "brie", "burrata", "cotija",
      "mozzarella", "feta", "ricotta", "romano", "pecorino",
      // `parmesan` alone misses the Italian spelling — measured: 11 meals
      // carried parmigiano-reggiano or pecorino with NO dairy stamp, including
      // Carbonara and Cacio e Pepe.
      "parmesan", "parmigiano", "grana padano",
      // D-WS9-214 — brioche is enriched dough: butter AND egg. It is listed
      // here, under `egg`, AND under `wheat` (it was already a bakery term
      // there). One ingredient, three independent allergens — that is not a
      // duplication to tidy up, it is what the food is. Measured 2026-09-04:
      // 5 spellings across 11 meals carried no dairy stamp and 43 no egg stamp.
      "brioche",
    ],
    disqualifiers: [
      // `butter` is a whole word inside every nut and seed butter.
      /\b(peanut|almond|cashew|sunflower|seed|apple|cocoa|shea|nut)\s+butter\b/,
      // ⚠️ PLANT MILKS ARE THE DAIRY-SIDE OF THE SAME TRAP. `milk`, `cream`,
      // `butter` and `yogurt` are whole words in products containing no dairy
      // at all. Measured 2026-09-04: coconut milk alone wrongly stamped `dairy`
      // on 13 public dinners — and they are Thai/Indian curries, i.e. exactly
      // the meals a dairy-free user most wants. An over-stamp is the safe
      // DIRECTION, but the cost here is concentrated on the group the token is
      // supposed to serve.
      /\b(coconut|almond|oat|soy|rice|cashew|hemp|flax|pea|sunflower)\s+(milk|cream|butter|yogurt|cheese)\b/,
      /\bvegan\b/,
      /\bnon[- ]dairy\b/,
    ],
  },

  // ⚠️ D-WS9-214 — THE LARGEST SINGLE GAP THE AUDIT FOUND, AND THE ONE THAT
  // EXPLAINS THE WHOLE CLASS. `egg` used to be one term: the word "egg". That
  // catches "large eggs" and misses every PROCESSED product made of eggs, whose
  // name contains no allergen word at all. Measured 2026-09-04: 136 public
  // dinners listed `Mayonnaise` / `Japanese mayonnaise` and carried NO egg
  // stamp — more meals than every defect the previous two rounds fixed put
  // together. `Greek yogurt or mayo` is why the bare word `mayo` is here too.
  //
  // Mayonnaise is egg ONLY. It is not dairy — no ruling to re-litigate, it is
  // oil and yolk. See `brioche` above for the opposite case.
  egg: {
    mode: "word",
    terms: ["egg", "mayonnaise", "mayo", "brioche"],
    // Narrowly scoped ON PURPOSE. A bare /\bvegan\b/ (as `dairy` carries) would
    // be a REMOVAL-direction rule on the one token where a false negative is a
    // hospital visit, so it fires only on the processed terms added above —
    // never on the word "egg" itself.
    disqualifiers: [/\bvegan\s+(mayonnaise|mayo|brioche)\b/],
  },

  peanut: { mode: "word", terms: ["peanut"] },

  tree_nut: {
    mode: "word",
    terms: [
      "almond", "walnut", "pecan", "cashew", "pistachio", "hazelnut", "macadamia",
      "pine nut", "brazil nut", "chestnut", "marzipan", "praline",
      // D-WS9-214 — pesto genovese is pine nuts. Nut-free pestos exist and would
      // be over-stamped; over-stamping is the safe direction for a nut token.
      // ⚠️ Pesto ALSO contains parmesan, i.e. it belongs on `dairy` by exactly
      // the same argument. That was deliberately NOT added: it is outside the
      // ruled scope of this pass, so it is reported as an open residual rather
      // than slipped in. It needs the same evidence every other entry carries.
      "pesto",
    ],
    // A water chestnut is a sedge tuber, not a nut. None in the catalog today;
    // the guard is here so adding one later cannot silently mis-stamp.
    disqualifiers: [/\bwater chestnut/],
  },

  soy: {
    mode: "word",
    // D-WS9-214 — `teriyaki` joins `hoisin`: both are soy-sauce-based sauces
    // sold under a name that never says soy. `Teriyaki sauce` was deriving
    // NOTHING AT ALL before this — no soy and no wheat.
    terms: ["soy", "soybean", "soy sauce", "tofu", "tempeh", "edamame", "miso", "tamari", "natto", "hoisin", "teriyaki"],
    // `tamari` is a substring of `tamarind`, which is a fruit pod. Before word
    // matching this was the only thing `tamari` ever matched — no ingredient
    // named `tamari` exists in the catalog at all.
    disqualifiers: [/\btamarind/],
  },

  wheat: {
    mode: "word",
    terms: [
      "wheat", "flour", "semolina", "farina", "couscous",
      "bread", "breadcrumb", "panko", "cracker",
      // ⚠️ SOY SAUCE IS A WHEAT SOURCE — it is brewed from wheat as well as
      // soybeans, so it belongs to BOTH tokens and is listed in both. Dropping
      // it from here (which an earlier draft of this file did) silently removed
      // `wheat` from 119 meals — every stir-fry and braise in the catalog —
      // and the re-stamp dry-run is what caught it. Note `tamari` is deliberately
      // NOT here: it is the wheat-free soy sauce, and `soy sauce` does not match it.
      "soy sauce",
      // pasta: the generic word, then the SHAPES. `pasta` alone missed 28 meals
      // that name only a shape — Carbonara, Bolognese, Alfredo, Chili Mac.
      "pasta", "noodle", "spaghetti", "tagliatelle", "rigatoni", "penne", "linguine",
      "fettuccine", "farfalle", "orecchiette", "bucatini", "ziti", "rotini", "macaroni",
      "lasagna", "lasagne", "gnocchi", "tortellini", "ravioli", "vermicelli", "cavatappi",
      "pappardelle", "orzo", "ditalini", "fusilli", "capellini", "angel hair", "paccheri",
      "udon", "ramen", "yakisoba", "lo mein", "chow mein",
      "wonton wrapper", "gyoza wrapper", "dumpling wrapper",
      // bakery: the class Gap A's pasta framing missed entirely. These are bread
      // products the substring `bread` does not reach.
      "tortilla", "flatbread", "pita", "naan", "baguette", "ciabatta", "sourdough",
      "brioche", "focaccia", "challah", "boule", "bagel", "pretzel", "croissant",
      "crouton", "matzo", "phyllo", "filo", "puff pastry", "pie crust", "pastry",
      "bun", "hoagie", "dinner roll", "slider roll", "hot dog roll",
      // ── D-WS9-214: processed wheat products whose name contains no wheat word.
      //
      // `dough` rather than the three measured "…pizza dough" spellings. Checked
      // against the catalog before widening: all 28 ingredient names containing
      // "dough" are wheat (pizza / pie / phyllo / sourdough), so the bare word
      // costs nothing and it is the difference between fixing three strings and
      // fixing the class. `sourdough` keeps its own entry above — \bdough\b does
      // not match inside it. Measured: 11 meals, and TWO OF THEM WERE ON A LIVE
      // GLUTEN-FREE SHELF (`Margherita Pizza Night`, `Sausage, Pepper, and Onion
      // Pizza`) at the moment this was found.
      "dough",
      // ⚠️ PRECEDENT ENTRY — READ BEFORE ADDING ANYTHING LIKE IT. Every term
      // above this line is a wheat word IN the ingredient's name. These are not:
      // a condensed cream soup is wheat because it is flour-thickened, which you
      // have to KNOW, not read. That makes this the first product-knowledge
      // claim in the vocabulary and the boundary of what a word list should be
      // asked to do — the confidence is high (all mainstream condensed cream
      // soups are roux-based) but the mechanism is different, and the model
      // ceiling (Hans's option (c)) is what generalises it. Do not read this
      // entry as licence to encode further product knowledge here.
      // "condensed cream of X soup" contains "cream of X soup", so the base
      // phrase covers both spellings. Celery is not in the catalog today; it is
      // the third canonical variety and is here so this does not need a fourth
      // pass. Measured: 15 meals.
      "cream of mushroom soup", "cream of chicken soup", "cream of celery soup",
      // Bread products under a name that never says bread. All measured.
      "stuffing", //   country-style white bread / herb-seasoned stuffing mix
      "pierogi", //    frozen potato and cheese pierogis (wheat dumpling dough)
      "empanada", //   store-bought empanada discs
      // ── found by the D-WS9-214 RE-SCAN, after the additions above shipped.
      // Four more meals that a coeliac could reach, each verified against the
      // live filter before being added here:
      //   Thai Red Curry with Roti           <- frozen roti paratha
      //   Teriyaki Tofu Bowl                 <- Teriyaki sauce
      //   Mississippi Pot Roast …            <- au jus gravy mix
      //   Tofu Pad Thai with Spring Rolls    <- hoisin sauce
      // ⚠️ `teriyaki` and `hoisin` are NOT a new product-knowledge claim. Both
      // are built on soy sauce, and `soy sauce -> wheat` is already in this list
      // (see its note above — dropping it once removed wheat from 119 meals).
      // These two are that same claim reaching the sauces it is sold as.
      // `roti`/`paratha` are wheat flatbreads at exactly the confidence of
      // `naan`, three lines up. `gravy mix` is a packaged flour thickener and
      // rides the cream-of-soup precedent documented above — it is deliberately
      // the PHRASE and not the bare word `gravy`, which is often cornstarch.
      "roti", "paratha", "teriyaki", "hoisin", "gravy mix",
    ],
    disqualifiers: NOT_WHEAT,
  },

  // Gluten is a SUPERSET of wheat, so it gets its own token rather than widening
  // `wheat`. Only the non-wheat gluten grains live here; store/allergenFilter.ts
  // maps "Gluten-free" to BOTH tokens and "Wheat-free" to `wheat` alone. That is
  // the whole point: a barley dish must reach someone avoiding wheat and must
  // not reach a coeliac, and one shared token cannot express both.
  // No migration — Meal.allergens is String[], not an enum.
  gluten: {
    mode: "word",
    terms: [
      "barley", "rye", "farro", "spelt", "bulgur", "malt", "seitan", "einkorn", "kamut", "freekeh", "triticale",
      // D-WS9-214 — beer is brewed from barley, so it lands on `gluten` and not
      // on `wheat`: a coeliac must not be served it, someone merely avoiding
      // wheat may drink it. That asymmetry is the entire reason the two tokens
      // are separate (see the header note in store/allergenFilter.ts).
      // ⚠️ `ale` IS DELIBERATELY ABSENT, and the reason is NOT the one you would
      // guess. A first draft of this comment claimed \bale\b matches
      // `guanciale` / `Kale` / `lacinato kale` / `curly kale` — the four real
      // catalog names an `includes("ale")` audit turns up. IT DOES NOT: word
      // mode anchors both ends, and `k`/`i` before `ale` is a word character, so
      // none of those four match. The claim was checked by adding the term and
      // watching the test stay GREEN.
      //
      // It stays out because it buys nothing and costs a disqualifier: no
      // catalog ingredient is named bare `ale`, while `ginger ale` is a soda
      // with no barley in it and would need its own exemption the moment the
      // term existed. Add it only alongside that exemption.
      //
      // ⚠️ The kale names ARE a real trap for anyone who switches this token to
      // `mode: "raw"` — the fish token's carve-out shows that is a thing this
      // file does. The regression test pins exactly that.
      // Measured: 6 meals across lager/stout/beer.
      "beer", "lager", "stout",
    ],
    // Root beer and ginger beer are sodas with no barley in them. Neither is in
    // the catalog today; the guard is here so adding one later cannot silently
    // mis-stamp it, exactly as `water chestnut` guards `tree_nut`.
    disqualifiers: [...NOT_WHEAT, /\b(root|ginger)\s+beer\b/],
  },

  // ⚠️ THE ONE RAW-SUBSTRING TOKEN, AND IT MUST STAY THAT WAY.
  // \bfish\b matches 1 of the 5 catalog names containing "fish" — only
  // `fish sauce`. It drops `catfish fillets`, and would drop `swordfish` and
  // `monkfish` if either were generated. Boundary matching is correct for the
  // other eight tokens and wrong for this one.
  // The crawfish names are dropped ON PURPOSE, via the disqualifier — crawfish
  // is a crustacean and belongs to `shellfish` below. Those two changes are one
  // change: a crawfish dish in neither token would be allergen-free, which is
  // worse than the bug being fixed.
  fish: {
    mode: "raw",
    terms: [
      "fish", "salmon", "tuna", "cod", "tilapia", "trout", "halibut", "anchovy",
      // Mainstream Worcestershire is anchovy-based.
      //
      // ⚠️ D-WS9-214 — THIS IS NOT AN INCONSISTENCY, DO NOT "FIX" IT. The
      // 2026-09-04 audit also proposed `worcestershire -> soy` (159 meals) and
      // it was REJECTED while this entry stayed. The two claims are not the same
      // claim: anchovy is in essentially every mainstream formulation, so `fish`
      // is a near-certainty; soy is in SOME brands and not others (Lea & Perrins
      // US lists none), so `soy` would be a brand guess stamped on 159 meals.
      // Same ingredient, different confidence, different call. A per-brand
      // question is exactly what the model ceiling is for — not a word list.
      "worcestershire",
      // D-WS9-214 — dashi is brewed from katsuobushi (bonito). Kombu-only dashi
      // exists and would be over-stamped; over-stamping is the safe direction.
      "dashi",
    ],
    disqualifiers: [/craw ?fish|cray ?fish|shellfish|jellyfish|cuttlefish/],
  },

  shellfish: {
    mode: "word",
    terms: [
      "shrimp", "prawn", "crab", "lobster", "scallop", "clam", "mussel", "oyster",
      "crawfish", "crayfish", "squid", "calamari", "octopus", "langoustine", "cuttlefish",
    ],
    // `oyster` is a whole word in two things that contain no shellfish at all.
    // Both are in the catalog today and both are falsely stamped by the old
    // substring rule. `oyster sauce` is NOT exempt — it is made from oysters.
    disqualifiers: [/\boyster (cracker|mushroom)/],
  },

  // D-WS9-214 — hummus is tahini-based, and neither of its two catalog spellings
  // (`hummus`, `store-bought hummus`) contains the word sesame.
  sesame: { mode: "word", terms: ["sesame", "tahini", "hummus"] },
};

/** The canonical token vocabulary, sorted. */
export const ALLERGEN_TOKENS: readonly string[] = Object.keys(ALLERGEN_VOCABULARY).sort();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Built once — these regexes are evaluated per ingredient per meal across the
// whole catalog during a re-stamp.
const COMPILED: ReadonlyArray<{ token: string; test: (n: string) => boolean }> = Object.entries(
  ALLERGEN_VOCABULARY,
).map(([token, spec]) => {
  const matchers =
    spec.mode === "raw"
      ? spec.terms.map((t) => (n: string) => n.includes(t))
      : spec.terms.map((t) => {
          const re = new RegExp("\\b" + escapeRe(t) + "(?:s|es)?\\b");
          return (n: string) => re.test(n);
        });
  const dq = spec.disqualifiers ?? [];
  return {
    token,
    test: (n: string) => !dq.some((re) => re.test(n)) && matchers.some((m) => m(n)),
  };
});

/**
 * D-WS9-214 — a derivation and the evidence for it.
 *
 * `sources` maps each token in `tokens` to the ingredient names that produced
 * it, in their ORIGINAL casing (the human-readable displayName, not the
 * lowercased form matching runs against) — this is read by a person debugging a
 * shelf, so `Parmigiano-Reggiano` beats `parmigiano-reggiano`.
 *
 * Invariant worth relying on: `Object.keys(sources)` always equals `tokens`.
 * Every token has at least one cause, and a token with no cause cannot exist.
 */
export interface AllergenDerivation {
  tokens: string[];
  sources: Record<string, string[]>;
}

/**
 * PURE. Derive the canonical allergen tokens for a set of ingredient names,
 * AND record which name caused each token. Case-insensitive.
 *
 * Both halves are deduplicated and sorted, so the result is stable to persist
 * and two derivations of the same meal compare equal field-by-field.
 */
export function deriveAllergensWithSources(
  names: readonly string[],
): AllergenDerivation {
  const causes = new Map<string, Set<string>>();
  for (const raw of names) {
    const n = raw.toLowerCase();
    for (const { token, test } of COMPILED) {
      // ⚠️ NO `found.has(token)` SHORT-CIRCUIT HERE. The token-only version
      // below could stop testing a token once anything had matched it; this one
      // must not, or the FIRST cause would be the only one recorded and
      // "which ingredients make this meal wheat" would answer with one of three.
      if (!test(n)) continue;
      const set = causes.get(token);
      if (set) set.add(raw);
      else causes.set(token, new Set([raw]));
    }
  }
  const tokens = [...causes.keys()].sort();
  const sources: Record<string, string[]> = {};
  for (const t of tokens) sources[t] = [...causes.get(t)!].sort();
  return { tokens, sources };
}

/**
 * PURE. Derive the canonical allergen tokens for a set of ingredient names.
 * Case-insensitive. Deduplicated and sorted, so the result is comparable with
 * `===` on the joined form and stable to persist.
 */
export function deriveAllergensFromNames(names: readonly string[]): string[] {
  const found = new Set<string>();
  for (const raw of names) {
    const n = raw.toLowerCase();
    for (const { token, test } of COMPILED) {
      if (!found.has(token) && test(n)) found.add(token);
    }
  }
  return [...found].sort();
}

/**
 * DIAGNOSTIC ONLY — never used to write a stamp.
 *
 * For each token, split the given names into the ones whose TERMS matched and
 * the ones a DISQUALIFIER then rejected. `deriveAllergensWithSources` reports
 * what a meal is; this reports why it isn't.
 *
 * The re-stamp gate is a removal list: a token disappearing from a meal is the
 * dangerous direction, and "removed `dairy`" is not reviewable while "removed
 * `dairy` — `coconut milk` matched `milk` and was disqualified as a plant milk"
 * is. Without this the reviewer is handed a token name and a meal title and has
 * to re-run the vocabulary in their head.
 */
export function explainAllergenMatches(
  names: readonly string[],
): Record<string, { matched: string[]; disqualified: string[] }> {
  const out: Record<string, { matched: string[]; disqualified: string[] }> = {};
  for (const [token, spec] of Object.entries(ALLERGEN_VOCABULARY)) {
    const hitsTerm =
      spec.mode === "raw"
        ? (n: string) => spec.terms.some((t) => n.includes(t))
        : (n: string) =>
            spec.terms.some((t) =>
              new RegExp("\\b" + escapeRe(t) + "(?:s|es)?\\b").test(n),
            );
    const matched: string[] = [];
    const disqualified: string[] = [];
    for (const raw of names) {
      const n = raw.toLowerCase();
      if (!hitsTerm(n)) continue;
      if ((spec.disqualifiers ?? []).some((re) => re.test(n))) disqualified.push(raw);
      else matched.push(raw);
    }
    if (matched.length || disqualified.length) out[token] = { matched, disqualified };
  }
  return out;
}

/**
 * Payload adapter — derive from an in-memory generated meal, before it is
 * persisted. Used by the store-fill harness, which has the AI payload in hand
 * and stamps at materialize time rather than re-reading its own write.
 */
export function deriveAllergens(meal: AllergenDerivableMeal): string[] {
  return deriveAllergensFromNames(meal.dishes.flatMap((d) => d.ingredients.map((i) => i.name)));
}

/**
 * Read a persisted meal's ingredient graph and return its allergen tokens.
 * Returns null when the meal does not exist.
 */
export async function deriveAllergensForMeal(
  tx: Tx,
  mealId: string,
): Promise<AllergenDerivation | null> {
  const meal = await tx.meal.findUnique({
    where: { id: mealId },
    select: {
      dishLinks: {
        select: {
          dish: {
            select: { dishIngredients: { select: { ingredient: { select: { displayName: true } } } } },
          },
        },
      },
    },
  });
  if (!meal) return null;
  // Tolerant of a partial graph rather than throwing on it. This runs inside the
  // plan-activation transaction (publishMealToStore), so an exception here would
  // roll back the user's entire plan save — losing a plan because a dish row had
  // no ingredient join would be a far worse failure than an under-stamped
  // write-back. Missing pieces contribute no names; a real DB error still throws.
  const links = meal.dishLinks ?? [];
  const names = links.flatMap((l) =>
    (l.dish?.dishIngredients ?? [])
      .map((di) => di.ingredient?.displayName)
      .filter((n): n is string => typeof n === "string"),
  );
  // ⚠️ ...but tolerance must not be SILENT. An under-stamped meal written with
  // no signal is precisely the class this module exists to eliminate — the
  // write-back published 55 of them over six weeks and nothing said a word.
  // Not a throw and not a swallow: a warning, so a partial graph surfaces the
  // first time rather than six weeks late.
  const emptyDishes = links.filter((l) => (l.dish?.dishIngredients ?? []).length === 0).length;
  if (links.length === 0 || emptyDishes > 0) {
    logger.warn(
      `[allergens] partial ingredient graph for meal ${mealId} — ` +
        `${links.length} dish link(s), ${emptyDishes} with zero ingredient rows, ` +
        `${names.length} name(s) usable. Stamp may be incomplete.`,
    );
  }
  return deriveAllergensWithSources(names);
}

/**
 * Derive and PERSIST a meal's allergen stamp from its ingredient graph. Call
 * after any write that puts a meal into the shared pool.
 *
 * Idempotent, and skips the UPDATE when the stamp is already correct — so a
 * re-stamp pass over an already-stamped catalog issues no writes.
 *
 * Returns the tokens written (or the existing ones when unchanged), or null if
 * the meal is missing.
 */
export interface StampAllergensOptions {
  /**
   * Write even when nothing would change, refreshing `allergensStampedAt` to
   * now. The BATCH re-stamp passes this; the hot paths never do.
   *
   * ⚠️ THIS IS THE DIFFERENCE BETWEEN THE TWO READINGS OF `allergensStampedAt`
   * AND IT MATTERS. Without force, the timestamp means "when the stamp last
   * CHANGED": a meal correctly stamped under vocabulary v1 and re-verified
   * unchanged under v2 keeps its v1 date and looks stale forever, so the next
   * "re-stamp everything older than X" sweep can never converge. With force, a
   * completed re-stamp pass leaves every row dated to that pass, and the
   * timestamp means "when this row was last EVALUATED against the vocabulary" —
   * which is the reading the column exists for.
   */
  force?: boolean;
}

export async function stampAllergens(
  tx: Tx,
  mealId: string,
  opts: StampAllergensOptions = {},
): Promise<string[] | null> {
  const derived = await deriveAllergensForMeal(tx, mealId);
  if (derived === null) return null;

  const current = await tx.meal.findUnique({
    where: { id: mealId },
    select: { allergens: true, allergenSources: true, allergensStampedAt: true },
  });
  const before = [...(current?.allergens ?? [])].sort();
  const tokensUnchanged =
    before.length === derived.tokens.length &&
    before.every((t, i) => t === derived.tokens[i]);
  // Compared as canonical JSON. Both sides are built with sorted keys and sorted
  // values (deriveAllergensWithSources) and the stored side round-trips through
  // JSONB, which preserves neither insertion order nor whitespace — so a
  // structural compare, not a string compare of arbitrary serializations.
  const sourcesUnchanged =
    canonicalSources(current?.allergenSources) === canonicalSources(derived.sources);

  // The no-op skip. Its point is that a re-stamp over an already-correct catalog
  // issues no writes at all — the property the hot paths rely on, since
  // publishMealToStore calls this inside the user's plan-activation transaction.
  // `allergensStampedAt == null` deliberately defeats the skip: a row stamped
  // before D-WS9-214 has correct tokens but no metadata, and skipping it would
  // leave it permanently invisible under the new filter clause.
  if (
    !opts.force &&
    tokensUnchanged &&
    sourcesUnchanged &&
    current?.allergensStampedAt != null
  ) {
    return derived.tokens;
  }

  await tx.meal.update({
    where: { id: mealId },
    data: {
      allergens: derived.tokens,
      allergenSources: derived.sources,
      allergensStampedAt: new Date(),
    },
  });
  return derived.tokens;
}

/**
 * Stable serialization of a sources map for equality testing. Tolerant of the
 * `JsonValue` the column reads back as (null, a scalar, an array — anything a
 * hand-edit or an older writer could have left) rather than assuming shape.
 */
function canonicalSources(value: unknown): string {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return "null";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return JSON.stringify(
    keys.map((k) => {
      const v = obj[k];
      const names = Array.isArray(v) ? v.map(String).sort() : [];
      return [k, names];
    }),
  );
}
