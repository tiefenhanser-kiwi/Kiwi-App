// WS9 BUG-096 (D-WS9-174) — THE CURATED MERGE PREDICATE.
//
// Side-effect-free on purpose: the merge script imports it to scope its writes,
// and the SEED-DURABILITY guard (ingredientMergeFold.test.ts) imports it to
// prove no seed file ever re-introduces a merged-away name. Neither should have
// to stand up a PrismaClient to read a list.
//
// THIS IS NOT A SINGULARISING NORMALIZER AND MUST NEVER BECOME ONE. A general
// write-path normalizer was measured and REFUTED in BUG-096 Phase 0: 468
// collateral renames against the real merges, molasses→molass, couscous→couscou,
// and 14 of 17 plural keys in INGREDIENT_CONVERSIONS with no singular twin. The
// 457 plural-only catalog rows are NOT in this list and must never be added to it.
//
// [survivor, loser]. Produced by the five-rung ladder ratified in Phase 0:
//   1 DishIngredient count → 2 total refs across all five id-carriers →
//   3 matched fdcId → 4 conversionRef → 5 purchase pack → 6 PLURAL wins.
// Decided at: di=72, allRefs=3, plural-fallback=6. Rungs 3–5 never fired.
// The plural survives in 59 of 81 groups ON MERIT, so the rung-6 fallback is
// the catalog's house style for count nouns, not a coin flip.
//
// COMPLETENESS IS BOUNDED TO SUFFIX-FOLD COLLISIONS. A 16-rule morphological
// sweep (-s, -es, -ies→y, -ves→f/fe, -oes→o, -i→us, -a→um/on, -ice→ouse,
// -eese→oose, -eet→oot, -eeth→ooth, -en, -ren, -im) over all 1,649 rows found
// exactly these 81 and nothing else. That is a statement about the RULE SET,
// not about the catalog: other duplicate shapes (a bare "garlic" beside
// "garlic cloves", "olive oil" beside "extra-virgin olive oil") are real and
// are deliberately OUT OF SCOPE here.
export const FOLD: Array<[survivor: string, loser: string]> = [
  ["all-beef hot dogs", "all-beef hot dog"],
  ["anchovy fillets", "anchovy fillet"],
  ["apple", "apples"],
  ["baby potato", "baby potatoes"],
  ["baby yellow potato", "baby yellow potatoes"],
  ["baby yukon gold potatoes", "baby yukon gold potato"],
  ["bay leaves", "bay leaf"],
  ["bell peppers", "bell pepper"],
  ["black cardamom pods", "black cardamom pod"],
  ["black peppercorns", "black peppercorn"],
  ["bone-in ribeye steaks", "bone-in ribeye steak"],
  ["boneless ribeye steaks", "boneless ribeye steak"],
  ["boneless skinless chicken breasts", "boneless skinless chicken breast"],
  ["bratwurst sausages", "bratwurst sausage"],
  ["brioche buns", "brioche bun"],
  ["brioche burger buns", "brioche burger bun"],
  ["brioche hamburger bun", "brioche hamburger buns"],
  ["brioche hot dog buns", "brioche hot dog bun"],
  ["broccoli florets", "broccoli floret"],
  ["capers", "caper"],
  ["carrots", "carrot"],
  ["celery stalks", "celery stalk"],
  ["cherry tomatoes", "cherry tomato"],
  ["chicken drumsticks", "chicken drumstick"],
  ["cod fillets", "cod fillet"],
  ["corn tortillas", "corn tortilla"],
  ["cremini mushrooms", "cremini mushroom"],
  ["dill pickle", "dill pickles"],
  ["dried ancho chiles", "dried ancho chile"],
  ["dried guajillo chiles", "dried guajillo chile"],
  ["dried red chilies", "dried red chili"],
  ["egg", "eggs"],
  ["egg yolks", "egg yolk"],
  ["english cucumber", "english cucumbers"],
  ["fennel seeds", "fennel seed"],
  ["flour tortillas", "flour tortilla"],
  ["fresh chives", "fresh chive"],
  ["fresh jalapeño", "fresh jalapeños"],
  ["fresh rosemary sprigs", "fresh rosemary sprig"],
  ["fresh tomatoes", "fresh tomato"],
  ["garlic cloves", "garlic clove"],
  ["granny smith apple", "granny smith apples"],
  ["green onions", "green onion"],
  ["hoagie rolls", "hoagie roll"],
  ["jalapeño", "jalapeños"],
  ["kalamata olives", "kalamata olive"],
  ["large carrot", "large carrots"],
  ["large eggs", "large egg"],
  ["large flour tortillas", "large flour tortilla"],
  ["lemon", "lemons"],
  ["lemongrass stalk", "lemongrass stalks"],
  ["lime", "limes"],
  ["medium carrots", "medium carrot"],
  ["navel oranges", "navel orange"],
  ["orange", "oranges"],
  ["persian cucumbers", "persian cucumber"],
  ["pickled jalapeños", "pickled jalapeño"],
  ["plum tomatoes", "plum tomato"],
  ["poblano pepper", "poblano peppers"],
  ["radishes", "radish"],
  ["ripe avocado", "ripe avocados"],
  ["ripe hass avocados", "ripe hass avocado"],
  ["roma tomatoes", "roma tomato"],
  ["romaine lettuce hearts", "romaine lettuce heart"],
  ["russet potatoes", "russet potato"],
  ["salmon fillets", "salmon fillet"],
  ["scallions", "scallion"],
  ["serrano chile", "serrano chiles"],
  ["shallot", "shallots"],
  ["shredded carrots", "shredded carrot"],
  ["skin-on salmon fillets", "skin-on salmon fillet"],
  ["small corn tortillas", "small corn tortilla"],
  ["small flour tortillas", "small flour tortilla"],
  ["strawberry", "strawberries"],
  ["sweet potatoes", "sweet potato"],
  ["tomato", "tomatoes"],
  ["top sirloin steaks", "top sirloin steak"],
  ["wide egg noodles", "wide egg noodle"],
  ["yellow onion", "yellow onions"],
  ["yellow potatoes", "yellow potato"],
  ["yukon gold potatoes", "yukon gold potato"],
];


/**
 * WS9 BUG-096 — THE IDEMPOTENCE DECISION, as a pure function.
 *
 * Given the canonical names that currently EXIST in the catalog, classify every
 * fold pair. This is what makes a second `--apply` a no-op: a group whose loser
 * row is already gone is `merged`, not work to redo.
 *
 * `refuse` is the state that must never be silently skipped — a loser present
 * with NO survivor means the catalog is in a shape this predicate does not
 * describe (someone deleted or renamed the survivor by hand). Merging into a
 * row that isn't there would rewrite every carrier to a dangling id.
 */
export interface FoldSelection {
  live: Array<[survivor: string, loser: string]>;
  merged: Array<[survivor: string, loser: string]>;
  absent: Array<[survivor: string, loser: string]>;
  refuse: Array<[survivor: string, loser: string]>;
}

export function selectLiveGroups(
  present: ReadonlySet<string>,
  fold: ReadonlyArray<readonly [string, string]> = FOLD,
): FoldSelection {
  const out: FoldSelection = { live: [], merged: [], absent: [], refuse: [] };
  for (const [survivor, loser] of fold) {
    const hasS = present.has(survivor);
    const hasL = present.has(loser);
    if (hasS && hasL) out.live.push([survivor, loser]);
    else if (hasS && !hasL) out.merged.push([survivor, loser]);
    else if (!hasS && !hasL) out.absent.push([survivor, loser]);
    else out.refuse.push([survivor, loser]);
  }
  return out;
}
