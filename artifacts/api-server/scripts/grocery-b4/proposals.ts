// [grocery] B4 · Part B — THE REVIEWED SHEET. Data only; `apply.ts` writes it.
//
// 95 pack yields, every one derived from the pack's OWN LABEL — the size or the
// count the `purchaseDisplay` already states — and nothing from a model.
// D-WS9-286. Each lands with `reviewedByHuman: true`, the overwrite guard.
//
// ── THE FOUR RULES THE FIGURES FOLLOW, AND THE THREE TIMES THEY WERE WRONG ──
//
// 1. A NATIVELY VOLUMETRIC size (ml, quart, fl oz) is a volume. No reading.
// 2. A COUNT on the label ("12 ct", "~6-8 scallions") is a count, and its unit
//    is `each` — THE UNIT THE RECIPES STATE, not the label noun. Naming the
//    child unit "scallion" makes `toSubUnitChild` ask
//    convertWithinDimension("each","scallion"), which is null, so the ladder
//    silently does nothing and the yield changes no arithmetic at all. Garlic is
//    the exception that proves it: its recipes really do say clove.
// 3. A RANGE takes its LOWER bound. The lower honest figure buys more.
// 4. A WEIGHT size needs a density. `oz ÷ 8` is what over-stated a broth can by
//    4.3% (B3·F), and there is no substitute for `gramsPerCup`. 72 spice and
//    dried-herb canonicals have no density and are therefore NOT here: they are
//    `?`, by ruling 3, and a 1.7 oz jar against a teaspoon need cannot under-buy
//    in any real plan.
//
// ⚠️ AND "oz" ON A LABEL IS AMBIGUOUS. A bottle of olive oil says "(17 oz)"
// meaning FLUID ounces; a tub of sour cream says "(16 oz)" meaning NET WEIGHT.
// The string does not say which. So both readings are taken where both are
// admissible and the LOWER wins — but the fluid reading is admissible ONLY from
// a bottle, carton or jug, because those are filled by volume and a bag, block,
// wedge, tub, jar, can or box is not.
//
// That last clause was learned by getting it wrong twice, in both directions:
//   • taking the weight reading alone made olive oil 2.231 cups a bottle when
//     17 fl oz is 2.125 — an UNDER-buy, the same shape as broth;
//   • taking the lower of both unconditionally made a 5 oz bag of shredded
//     iceberg 0.625 cups and ordered FOUR bags for two cups of leaves, and a
//     6 oz parmesan wedge 0.75 cups and ordered two. Category errors, not
//     conservative estimates.
//
// `sliced scallions` is absent on purpose: it already carries a human-reviewed
// yield and the overwrite guard skips it.

export interface YieldLoad {
  canonical: string;
  unit: string;
  perPack: number;
  source: string;
}

export const YIELD_LOADS: YieldLoad[] = [
  { canonical: "angel hair pasta",                         unit: "ounce",   perPack: 16,        source: "pack label \"1 box (16 oz)\"" },
  { canonical: "apple cider vinegar",                      unit: "cup",     perPack: 1.898,     source: "pack label \"1 bottle (16 oz)\" (lower of 1.898 net weight ÷ gramsPerCup 239 / 2.000 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "au jus gravy mix",                         unit: "ounce",   perPack: 1,         source: "pack label \"1 package (1 oz)\"" },
  { canonical: "baby arugula",                             unit: "ounce",   perPack: 5,         source: "pack label \"1 container (5 oz)\"" },
  { canonical: "bacon",                                    unit: "ounce",   perPack: 12,        source: "pack label \"1 package (12 oz)\"" },
  { canonical: "balsamic vinegar",                         unit: "cup",     perPack: 0.945,     source: "pack label \"1 bottle (8.5 oz)\" (lower of 0.945 net weight ÷ gramsPerCup 255 / 1.063 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "blue cheese crumbles",                     unit: "ounce",   perPack: 4,         source: "pack label \"1 container (4 oz)\"" },
  { canonical: "brown sugar",                              unit: "cup",     perPack: 4.124,     source: "pack label \"1 bag (2 lb)\" (net weight ÷ gramsPerCup 220)" },
  { canonical: "butter",                                   unit: "cup",     perPack: 1.998,     source: "pack label \"1 package (1 lb, 4 sticks)\" (net weight ÷ gramsPerCup 227)" },
  { canonical: "canned crushed san marzano tomatoes",      unit: "ounce",   perPack: 28,        source: "pack label \"1 can (28 oz)\"" },
  { canonical: "canned diced fire-roasted tomatoes",       unit: "ounce",   perPack: 28,        source: "pack label \"1 can (28 oz)\"" },
  { canonical: "canned diced tomatoes",                    unit: "ounce",   perPack: 14.5,      source: "pack label \"1 can (14.5 oz)\"" },
  { canonical: "canned kidney beans",                      unit: "ounce",   perPack: 15,        source: "pack label \"1 can (15 oz)\"" },
  { canonical: "canned tomato sauce",                      unit: "ounce",   perPack: 15,        source: "pack label \"1 can (15 oz)\"" },
  { canonical: "canned whole san marzano tomatoes",        unit: "ounce",   perPack: 28,        source: "pack label \"1 can (28 oz)\"" },
  { canonical: "cheddar",                                  unit: "cup",     perPack: 2.007,     source: "pack label \"1 block (8 oz)\" (net weight ÷ gramsPerCup 113)" },
  { canonical: "corn tortillas",                           unit: "each",    perPack: 12,        source: "pack label \"1 package (12 count)\"" },
  { canonical: "corn tortillas (6-inch)",                  unit: "each",    perPack: 12,        source: "pack label \"1 package (12 count)\"" },
  { canonical: "cornstarch",                               unit: "cup",     perPack: 3.544,     source: "pack label \"1 box (16 oz)\" (net weight ÷ gramsPerCup 128)" },
  { canonical: "crunchy taco shells",                      unit: "each",    perPack: 12,        source: "pack label \"1 box (12 count)\"" },
  { canonical: "crushed canned tomatoes",                  unit: "ounce",   perPack: 14.5,      source: "pack label \"1 can (14.5 oz)\"" },
  { canonical: "crushed san marzano tomatoes",             unit: "ounce",   perPack: 14.5,      source: "pack label \"1 can (14.5 oz)\"" },
  { canonical: "crushed tomatoes",                         unit: "ounce",   perPack: 14.5,      source: "pack label \"1 can (14.5 oz)\"" },
  { canonical: "dark red kidney beans",                    unit: "ounce",   perPack: 15,        source: "pack label \"1 can (15 oz)\"" },
  { canonical: "dark soy sauce",                           unit: "cup",     perPack: 1.112,     source: "pack label \"1 bottle (10 oz)\" (lower of 1.112 net weight ÷ gramsPerCup 255 / 1.250 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "dijon mustard",                            unit: "cup",     perPack: 0.911,     source: "pack label \"1 jar (8 oz)\" (net weight ÷ gramsPerCup 249)" },
  { canonical: "dill pickle",                              unit: "ounce",   perPack: 32,        source: "pack label \"1 jar (32 oz)\"" },
  { canonical: "dried pappardelle pasta",                  unit: "ounce",   perPack: 12,        source: "pack label \"1 box (12-13 oz)\"" },
  { canonical: "dried spaghetti",                          unit: "ounce",   perPack: 16,        source: "pack label \"1 box (1 lb)\"" },
  { canonical: "dry red wine",                             unit: "cup",     perPack: 3.17,      source: "pack label \"1 bottle (750 ml)\" (stated as a volume)" },
  { canonical: "dry sherry",                               unit: "cup",     perPack: 3.17,      source: "pack label \"1 bottle (750 ml)\" (stated as a volume)" },
  { canonical: "dry white wine",                           unit: "cup",     perPack: 3.17,      source: "pack label \"1 bottle (750 ml)\" (stated as a volume)" },
  { canonical: "egg",                                      unit: "each",    perPack: 12,        source: "a dozen is twelve" },
  { canonical: "elbow macaroni",                           unit: "ounce",   perPack: 16,        source: "pack label \"1 box (1 lb)\"" },
  { canonical: "extra-virgin olive oil",                   unit: "cup",     perPack: 3.188,     source: "pack label \"1 bottle (25.5 oz)\" (lower of 3.347 net weight ÷ gramsPerCup 216 / 3.188 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "farro",                                    unit: "cup",     perPack: 2.268,     source: "pack label \"1 bag (16 oz)\" (net weight ÷ gramsPerCup 200)" },
  { canonical: "feta",                                     unit: "ounce",   perPack: 8,         source: "pack label \"1 block (8 oz)\"" },
  { canonical: "feta cheese",                              unit: "ounce",   perPack: 8,         source: "pack label \"1 container (8 oz)\"" },
  { canonical: "fish sauce",                               unit: "cup",     perPack: 0.84,      source: "pack label \"1 bottle (8 oz)\" (lower of 0.840 net weight ÷ gramsPerCup 270 / 1.000 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "flour tortillas",                          unit: "each",    perPack: 10,        source: "pack label \"1 package (10 ct)\"" },
  { canonical: "fresh baby spinach",                       unit: "ounce",   perPack: 5,         source: "pack label \"1 container (5 oz)\"" },
  { canonical: "fresh cheese tortellini",                  unit: "ounce",   perPack: 20,        source: "pack label \"1 package (20 oz)\"" },
  { canonical: "fresh mozzarella cheese",                  unit: "ounce",   perPack: 8,         source: "pack label \"1 container (8 oz)\"" },
  { canonical: "granulated sugar",                         unit: "cup",     perPack: 9.072,     source: "pack label \"1 bag (4 lb)\" (net weight ÷ gramsPerCup 200)" },
  { canonical: "grated parmesan cheese",                   unit: "cup",     perPack: 2.268,     source: "pack label \"1 container (8 oz)\" (net weight ÷ gramsPerCup 100)" },
  { canonical: "heavy cream",                              unit: "cup",     perPack: 3.78,      source: "pack label \"1 container (16 oz)\" (net weight ÷ gramsPerCup 120)" },
  { canonical: "hoagie rolls",                             unit: "each",    perPack: 4,         source: "pack label \"1 package (4 count)\"" },
  { canonical: "honey",                                    unit: "cup",     perPack: 1.001,     source: "pack label \"1 jar (12 oz)\" (net weight ÷ gramsPerCup 340)" },
  { canonical: "instant couscous",                         unit: "ounce",   perPack: 10,        source: "pack label \"1 box (10 oz)\"" },
  { canonical: "jasmine rice",                             unit: "cup",     perPack: 4.904,     source: "pack label \"1 bag (2 lb)\" (net weight ÷ gramsPerCup 185)" },
  { canonical: "kettle-cooked potato chips",               unit: "ounce",   perPack: 5,         source: "pack label \"1 bag (5-6 oz)\"" },
  { canonical: "large eggs",                               unit: "each",    perPack: 12,        source: "a dozen is twelve" },
  { canonical: "large flour tortillas",                    unit: "each",    perPack: 8,         source: "pack label \"1 package (8 count)\"" },
  { canonical: "large flour tortillas (10-inch)",          unit: "each",    perPack: 8,         source: "pack label \"1 package (8 count)\"" },
  { canonical: "marinara sauce",                           unit: "cup",     perPack: 5.154,     source: "pack label \"1 jar (24 oz)\" (net weight ÷ gramsPerCup 132)" },
  { canonical: "mayonnaise",                               unit: "cup",     perPack: 1.933,     source: "pack label \"1 jar (15 oz)\" (net weight ÷ gramsPerCup 220)" },
  { canonical: "neutral oil",                              unit: "cup",     perPack: 6.375,     source: "pack label \"1 bottle (51 oz)\" (lower of 6.632 net weight ÷ gramsPerCup 218 / 6.375 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "olive oil",                                unit: "cup",     perPack: 2.125,     source: "pack label \"1 bottle (17 oz)\" (lower of 2.231 net weight ÷ gramsPerCup 216 / 2.125 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "orecchiette pasta",                        unit: "ounce",   perPack: 16,        source: "pack label \"1 box (16 oz)\"" },
  { canonical: "orzo pasta",                               unit: "cup",     perPack: 7.087,     source: "pack label \"1 box (16 oz)\" (net weight ÷ gramsPerCup 64)" },
  { canonical: "panko breadcrumbs",                        unit: "cup",     perPack: 4.536,     source: "pack label \"1 box (8 oz)\" (net weight ÷ gramsPerCup 50)" },
  { canonical: "parmesan",                                 unit: "cup",     perPack: 1.701,     source: "pack label \"1 wedge (6 oz)\" (net weight ÷ gramsPerCup 100)" },
  { canonical: "parmesan cheese",                          unit: "cup",     perPack: 2.268,     source: "pack label \"1 block (8 oz)\" (net weight ÷ gramsPerCup 100)" },
  { canonical: "peanuts",                                  unit: "cup",     perPack: 1.553,     source: "pack label \"1 bag (8 oz)\" (net weight ÷ gramsPerCup 146)" },
  { canonical: "plain breadcrumbs",                        unit: "cup",     perPack: 3.937,     source: "pack label \"1 container (15 oz)\" (net weight ÷ gramsPerCup 108)" },
  { canonical: "potato gnocchi",                           unit: "ounce",   perPack: 16,        source: "pack label \"1 package (16 oz)\"" },
  { canonical: "pre-washed kale",                          unit: "ounce",   perPack: 5,         source: "pack label \"1 bag (5 oz)\"" },
  { canonical: "ranch seasoning mix",                      unit: "ounce",   perPack: 1,         source: "pack label \"1 package (1 oz)\"" },
  { canonical: "red kidney beans",                         unit: "ounce",   perPack: 15,        source: "pack label \"2 cans (15 oz each)\"" },
  { canonical: "red wine vinegar",                         unit: "cup",     perPack: 1.898,     source: "pack label \"1 bottle (16 oz)\" (lower of 1.898 net weight ÷ gramsPerCup 239 / 2.000 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "restaurant-style tortilla chips",          unit: "ounce",   perPack: 13,        source: "pack label \"1 bag (13 oz)\"" },
  { canonical: "rice noodles",                             unit: "ounce",   perPack: 8,         source: "pack label \"1 package (8 oz)\"" },
  { canonical: "rigatoni",                                 unit: "ounce",   perPack: 16,        source: "pack label \"1 box (16 oz)\"" },
  { canonical: "san marzano whole peeled tomatoes",        unit: "ounce",   perPack: 28,        source: "pack label \"1 can (28 oz)\"" },
  { canonical: "scallions",                                unit: "each",    perPack: 6,         source: "pack label \"1 bunch (~6-8 scallions)\"" },
  { canonical: "sesame oil",                               unit: "cup",     perPack: 0.813,     source: "pack label \"1 bottle (6.5 oz)\" (lower of 0.845 net weight ÷ gramsPerCup 218 / 0.813 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "sharp cheddar cheese",                     unit: "ounce",   perPack: 8,         source: "pack label \"1 block (8 oz)\"" },
  { canonical: "shaved parmesan cheese",                   unit: "ounce",   perPack: 5,         source: "pack label \"1 package (5 oz)\"" },
  { canonical: "shredded iceberg lettuce",                 unit: "cup",     perPack: 2.487,     source: "pack label \"1 bag (5 oz)\" (net weight ÷ gramsPerCup 57)" },
  { canonical: "shredded mexican cheese blend",            unit: "cup",     perPack: 2.025,     source: "pack label \"1 bag (8 oz)\" (net weight ÷ gramsPerCup 112)" },
  { canonical: "shredded mozzarella cheese",               unit: "cup",     perPack: 2.637,     source: "pack label \"1 bag (8 oz)\" (net weight ÷ gramsPerCup 86)" },
  { canonical: "shredded sharp cheddar cheese",            unit: "cup",     perPack: 2.007,     source: "pack label \"1 package (8 oz)\" (net weight ÷ gramsPerCup 113)" },
  { canonical: "sliced almonds",                           unit: "cup",     perPack: 2.465,     source: "pack label \"1 bag (8 oz)\" (net weight ÷ gramsPerCup 92)" },
  { canonical: "small flour tortillas",                    unit: "each",    perPack: 8,         source: "pack label \"1 package (8 count)\"" },
  { canonical: "sour cream",                               unit: "cup",     perPack: 1.972,     source: "pack label \"1 container (16 oz)\" (net weight ÷ gramsPerCup 230)" },
  { canonical: "spaghetti",                                unit: "ounce",   perPack: 16,        source: "pack label \"1 box (1 lb)\"" },
  { canonical: "sugar",                                    unit: "cup",     perPack: 9.072,     source: "pack label \"1 bag (4 lb)\" (net weight ÷ gramsPerCup 200)" },
  { canonical: "taco shells",                              unit: "each",    perPack: 12,        source: "pack label \"1 box (12 ct)\"" },
  { canonical: "tahini",                                   unit: "cup",     perPack: 1.89,      source: "pack label \"1 jar (16 oz)\" (net weight ÷ gramsPerCup 240)" },
  { canonical: "tomato paste",                             unit: "cup",     perPack: 0.644,     source: "pack label \"1 can (6 oz)\" (net weight ÷ gramsPerCup 264)" },
  { canonical: "vegetable oil",                            unit: "cup",     perPack: 6.375,     source: "pack label \"1 bottle (51 oz)\" (lower of 6.632 net weight ÷ gramsPerCup 218 / 6.375 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "whole-milk ricotta cheese",                unit: "cup",     perPack: 1.715,     source: "pack label \"1 container (15 oz)\" (net weight ÷ gramsPerCup 248)" },
  { canonical: "wide egg noodles",                         unit: "ounce",   perPack: 12,        source: "pack label \"1 box (12 oz)\"" },
  { canonical: "worcestershire sauce",                     unit: "cup",     perPack: 1.031,     source: "pack label \"1 bottle (10 oz)\" (lower of 1.031 net weight ÷ gramsPerCup 275 / 1.250 the same number read as FLUID oz (a bottle is filled by volume))" },
  { canonical: "yellow mustard",                           unit: "cup",     perPack: 1.594,     source: "pack label \"1 bottle (14 oz)\" (lower of 1.594 net weight ÷ gramsPerCup 249 / 1.750 the same number read as FLUID oz (a bottle is filled by volume))" },
];
