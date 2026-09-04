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

  egg: { mode: "word", terms: ["egg"] },

  peanut: { mode: "word", terms: ["peanut"] },

  tree_nut: {
    mode: "word",
    terms: [
      "almond", "walnut", "pecan", "cashew", "pistachio", "hazelnut", "macadamia",
      "pine nut", "brazil nut", "chestnut", "marzipan", "praline",
    ],
    // A water chestnut is a sedge tuber, not a nut. None in the catalog today;
    // the guard is here so adding one later cannot silently mis-stamp.
    disqualifiers: [/\bwater chestnut/],
  },

  soy: {
    mode: "word",
    terms: ["soy", "soybean", "soy sauce", "tofu", "tempeh", "edamame", "miso", "tamari", "natto", "hoisin"],
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
    terms: ["barley", "rye", "farro", "spelt", "bulgur", "malt", "seitan", "einkorn", "kamut", "freekeh", "triticale"],
    disqualifiers: NOT_WHEAT,
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
      "worcestershire",
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

  sesame: { mode: "word", terms: ["sesame", "tahini"] },
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
export async function deriveAllergensForMeal(tx: Tx, mealId: string): Promise<string[] | null> {
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
  return deriveAllergensFromNames(names);
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
export async function stampAllergens(tx: Tx, mealId: string): Promise<string[] | null> {
  const derived = await deriveAllergensForMeal(tx, mealId);
  if (derived === null) return null;
  const current = await tx.meal.findUnique({ where: { id: mealId }, select: { allergens: true } });
  const before = [...(current?.allergens ?? [])].sort();
  if (before.length === derived.length && before.every((t, i) => t === derived[i])) return derived;
  await tx.meal.update({ where: { id: mealId }, data: { allergens: derived } });
  return derived;
}
