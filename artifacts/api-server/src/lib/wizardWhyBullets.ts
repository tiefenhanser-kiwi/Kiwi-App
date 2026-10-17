// FIX-2 (Part B) — "Why this works" may only name what the plan holds.
//
// MEASURED, October 17 (dev, TRIAGE-0's three wizard cards): every card carried
// a bullet about a meal it did not have — "braised ragu" on a plan with no ragu,
// "a hearty bake" with no bake, "with Chicken Parmesan as the one night worth a
// little more effort" on a card whose meals were Shrimp Scampi, Cacio e Pepe,
// Pork Milanese, Turkey Meatballs and Chicken Fajitas. The card's meal rows are
// the model's own `mealTitles` (composeCandidateMeals keeps the title), so this
// is the MODEL writing bullets that disagree with its own meals — not the
// server swapping meals afterwards. The output shape asked for whyBullets BEFORE
// mealTitles with no thinking, so the bullets were a guess about a plan not yet
// written, from a 40-meal shelf and "one meal per plan" rules that moved meals
// between cards. The cause fix reorders the output (mealTitles first, bullets
// last — streamPlanCandidates.ts, schemas/wizard.ts, the prompt bodies).
//
// THIS is the backstop, at the one place every candidate reaches the wire
// (toWireCandidate): a bullet that names a dish, a protein or a cuisine that no
// meal on the card supports is DROPPED. A wrong bullet is worse than none. When
// nothing survives, one plain bullet built from the final meals stands in (the
// expand / save schemas require at least one).
//
// What it does NOT judge: preference claims ("matching your mostly-easy pacing
// preference"), counts, or times. Only food words, against the card's own
// titles and descriptions. A food word right after a negation ("no mushrooms",
// "skipped salmon") is a statement about what is NOT there and is left alone.

interface Term {
  /** Matches the claim in a bullet. */
  claim: RegExp;
  /** Matches the evidence in the card's meal titles + descriptions. */
  support: RegExp;
}

const PASTA =
  /\b(?:pastas?|spaghetti|penne|rigatoni|linguine|fettuccine|angel hair|ziti|lasagna|macaroni|mac (?:and|&|n) cheese|tortellini|ravioli|gnocchi|orzo|bucatini|pappardelle|carbonara|cacio e pepe|alfredo|noodles?|lo mein|orecchiette|farfalle|stroganoff)\b/;
const FISH = /\b(?:fish|salmon|cod|halibut|tilapia|trout|tuna|mahi[- ]?mahi|snapper|sea bass|swordfish|catfish)\b/;
const SEAFOOD = /\b(?:seafood|shrimp|prawns?|scallops?|crab|lobster|mussels|clams|calamari|fish|salmon|cod|halibut|tilapia|trout|tuna|mahi[- ]?mahi|snapper|scampi)\b/;

function t(claim: RegExp, support: RegExp = claim): Term {
  return { claim, support };
}

// Dishes and forms. Named dishes first — "chicken parmesan" must be checked as
// the dish, not as "chicken" (which a card with any chicken would support).
const DISH_TERMS: Term[] = [
  t(/\bchicken parm(?:esan|igiana)?\b/),
  t(/\beggplant parm(?:esan|igiana)?\b/),
  t(/\b(?:ragu|ragù|bolognese)\b/, /\b(?:ragu|ragù|bolognese|meat sauce)\b/),
  t(/\bpiccata\b/),
  t(/\bscampi\b/),
  t(/\bmeatballs?\b/),
  t(/\bmeatloaf\b/),
  t(/\blasagna\b/),
  t(/\bcarbonara\b/),
  t(/\brisotto\b/),
  t(/\bpot pies?\b/),
  t(/\b(?:enchiladas?)\b/),
  t(/\b(?:fajitas?)\b/),
  t(/\b(?:burritos?|burrito bowls?)\b/),
  t(/\b(?:quesadillas?)\b/),
  t(/\btacos?\b/),
  t(/\b(?:pizzas?|flatbreads?)\b/),
  t(/\bburgers?\b/),
  t(/\b(?:sandwich(?:es)?|subs|sliders|wraps?|melts?)\b/),
  t(/\bcurr(?:y|ies)\b/, /\b(?:curr(?:y|ies)|tikka|masala|korma|vindaloo|dal|dahl|butter chicken|rogan josh)\b/),
  t(/\bstir[- ]?fr(?:y|ies|ied)\b/, /\b(?:stir[- ]?fr(?:y|ies|ied)|fried rice|lo mein|chow mein|kung pao|general tso'?s?|orange chicken|sesame chicken|mongolian|teriyaki|cashew|beef (?:and|&) broccoli|broccoli beef|pad thai|pad see ew|drunken noodles|bulgogi|wok|stir[- ]fried)\b/),
  t(/\bfried rice\b/),
  t(/\bsoups?\b/, /\b(?:soups?|chowder|bisque|pho|ramen|gumbo|minestrone|pozole)\b/),
  t(/\bstews?\b/, /\b(?:stews?|goulash|dumplings)\b/),
  t(/\bchili\b(?![- ]?(?:lime|crisp|oil|flakes|sauce|glaze|garlic))/, /\bchili\b(?![- ]?(?:lime|crisp|oil|flakes|sauce|glaze|garlic))/),
  t(/\bcasseroles?\b/, /\b(?:casseroles?|bake|baked ziti|lasagna|enchilada casserole|gratin|hotdish)\b/),
  t(/\b(?:a|the|one|cheesy|hearty) bake\b/, /\b(?:bakes?|baked|casseroles?|lasagna|gratin)\b/),
  t(/\bbrais(?:e|es|ed|ing)\b/, /\b(?:brais(?:e|es|ed|ing)|pot roast|short ribs|slow[- ]cook(?:er|ed)|osso buco|birria|carnitas|ropa vieja|(?:slow[- ])?simmer(?:ed|s|ing)?|sunday gravy|stews?|ragu|ragù|bolognese)\b/),
  t(/\bpot roast\b/),
  t(/\broast(?:ed)? chicken\b/, /\broast(?:ed)? chicken\b/),
  t(/\bsheet[- ]pan\b/),
  t(/\bslow[- ]cook(?:er|ed)\b/, /\b(?:slow[- ]cook(?:er|ed)|crock ?pot|(?:slow[- ])?simmer(?:ed|s|ing)?|brais(?:e|es|ed|ing)|sunday gravy|pot roast)\b/),
  t(/\b(?:bbq|barbecue|barbecued)\b/),
  t(/\bgrill(?:ed|ing)?\b/, /\b(?:grill(?:ed|ing)?|bbq|barbecue|charred|kebabs?|skewers|souvlaki)\b/),
  t(/\bsalads?\b/, /\b(?:salads?|slaw)\b/),
  t(/\bbowls?\b/),
  t(/\bpasta(?:s)?\b/, PASTA),
  t(/\bnoodles?\b/, PASTA),
  t(/\bdumplings?\b/),
];

const PROTEIN_TERMS: Term[] = [
  t(/\bchicken\b/),
  t(/\bturkey\b/),
  t(/\bbeef\b/, /\b(?:beef|steak|brisket|sirloin|ribeye|flank|short ribs|pot roast|bulgogi|birria|ground beef|hamburger|burger|meatloaf|bolognese|pastrami|corned)\b/),
  t(/\bsteaks?\b/, /\b(?:steaks?|sirloin|ribeye|flank|filet|porterhouse|skirt)\b/),
  t(/\bpork\b/, /\b(?:pork|bacon|ham|sausage|carnitas|al pastor|chorizo|pancetta|prosciutto|bratwurst|ribs)\b/),
  t(/\bsausage\b/, /\b(?:sausages?|chorizo|bratwurst|andouille|kielbasa)\b/),
  t(/\blamb\b/),
  t(/\bshrimp\b/, /\b(?:shrimp|prawns?|scampi)\b/),
  t(/\bsalmon\b/),
  t(/\bfish\b/, FISH),
  t(/\bseafood\b/, SEAFOOD),
  t(/\btofu\b/),
  t(/\b(?:chickpeas?|garbanzo)\b/),
  t(/\blentils?\b/, /\b(?:lentils?|dal|dahl)\b/),
];

// A cuisine is supported by its own word in a title or description, or by a
// dish that belongs to it. Generous on purpose: a cuisine is the claim most
// likely to be true without its word appearing ("tacos" are Mexican).
const MEXICAN =
  /\b(?:mexican|tex[- ]mex|tacos?|enchiladas?|fajitas?|burritos?|quesadillas?|tostadas?|nachos|taquitos|carnitas|al pastor|birria|chipotle|salsa|tortillas?|pozole|mole|elote|cotija|chimichangas?|sopes|flautas|carne asada|street corn)\b/;
const ITALIAN =
  /\b(?:italian|pasta|spaghetti|penne|rigatoni|linguine|fettuccine|angel hair|ziti|lasagna|tortellini|ravioli|gnocchi|risotto|carbonara|cacio e pepe|alfredo|marinara|bolognese|ragu|parm(?:esan|igiana)?|piccata|milanese|marsala|francese|scampi|bruschetta|pesto|polenta|calzones?|pizza|meatballs|osso buco|saltimbocca|caprese|minestrone|orzo|bucatini|pappardelle)\b/;
const CHINESE =
  /\b(?:chinese|stir[- ]?fr(?:y|ied)|fried rice|lo mein|chow mein|kung pao|general tso'?s?|orange chicken|sesame chicken|mongolian|cashew|szechuan|sichuan|sweet (?:and|&) sour|egg rolls?|potstickers|dumplings|dan dan|mapo|char siu|hoisin|bok choy)\b/;
const JAPANESE = /\b(?:japanese|teriyaki|katsu|ramen|udon|soba|miso|sushi|donburi|yakitori|tonkatsu|furikake)\b/;
const THAI = /\b(?:thai|pad thai|pad see ew|green curry|red curry|massaman|larb|basil chicken|pad kra pao|satay)\b/;
const KOREAN = /\b(?:korean|bulgogi|bibimbap|gochujang|kimchi|japchae|galbi)\b/;
const INDIAN = /\b(?:indian|tikka|masala|korma|vindaloo|dal|dahl|saag|paneer|biryani|naan|butter chicken|tandoori|rogan josh|chana)\b/;
const VIETNAMESE = /\b(?:vietnamese|pho|banh mi|lemongrass)\b/;
const MEDITERRANEAN =
  /\b(?:mediterranean|greek|middle eastern|gyros?|souvlaki|tzatziki|feta|hummus|falafel|shawarma|kebabs?|tahini|pita|za'?atar|harissa|tagine|couscous|orzo|olives?)\b/;

const CUISINE_TERMS: Term[] = [
  t(/\b(?:mexican|tex[- ]mex)\b/, MEXICAN),
  t(/\bitalian(?:[- ]american)?\b/, ITALIAN),
  t(/\bchinese(?:[- ]american)?\b/, CHINESE),
  t(/\bjapanese\b/, JAPANESE),
  t(/\bthai\b/, THAI),
  t(/\bkorean\b/, KOREAN),
  t(/\bindian\b/, INDIAN),
  t(/\bvietnamese\b/, VIETNAMESE),
  t(/\basian\b/, new RegExp(`(?:\\basian\\b|${[CHINESE, JAPANESE, THAI, KOREAN, INDIAN, VIETNAMESE].map((r) => r.source).join("|")})`)),
  t(/\b(?:mediterranean|greek|middle eastern)\b/, MEDITERRANEAN),
  t(/\b(?:cajun|creole)\b/, /\b(?:cajun|creole|jambalaya|gumbo|etouffee|étouffée|andouille|blackened|po'? ?boys?)\b/),
  t(/\bfrench\b/, /\b(?:french|coq au vin|bourguignon|au poivre|provençal|provencal|nicoise|niçoise|croque|gratin|ratatouille|en papillote|papillote)\b/),
];

const ALL_TERMS: Term[] = [...DISH_TERMS, ...PROTEIN_TERMS, ...CUISINE_TERMS];

// A food word this close after one of these is a statement about absence.
const NEGATION = /\b(?:no|not|without|skipped|skip|instead of|avoid(?:ed|ing)?|never|zero|nothing|kept out|left out|swapped out|subbed out|free of|hold the)\b[^.;:—–]{0,24}$/;

function norm(s: string): string {
  return s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ");
}

export interface MealForGrounding {
  title: string;
  description?: string | null;
}

export interface BulletCheck {
  bullet: string;
  /** The claims in it no meal on the card supports (empty = grounded). */
  unsupported: string[];
}

/** Every food claim in `bullet` that the card's meals do not support. */
export function unsupportedClaims(bullet: string, meals: readonly MealForGrounding[]): string[] {
  const text = norm(bullet);
  const evidence = meals.map((m) => norm(`${m.title} ${m.description ?? ""}`)).join(" | ");
  const out: string[] = [];
  // Named dishes claim their words: once "chicken parmesan" is judged, its
  // "chicken" is not judged again on its own.
  let masked = text;
  for (const term of ALL_TERMS) {
    const re = new RegExp(term.claim.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const before = masked.slice(0, m.index);
      if (!NEGATION.test(before) && !term.support.test(evidence)) out.push(m[0]);
      masked = masked.slice(0, m.index) + " ".repeat(m[0].length) + masked.slice(m.index + m[0].length);
      re.lastIndex = m.index + m[0].length;
    }
  }
  return out;
}

/** The plain stand-in when no bullet survives: true of the final meals, nothing more. */
export function fallbackBullet(meals: readonly MealForGrounding[]): string {
  const heads = meals.map((m) => m.title.split(/\s+(?:with|over|and a|alongside)\s+/i)[0].trim());
  const n = heads.length;
  const words = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven"];
  const count = words[n] ?? String(n);
  if (n <= 1) return `${heads[0] ?? "A dinner"}, picked for this week`;
  return `${count} different dinners: ${heads.slice(0, -1).join(", ")} and ${heads[n - 1]}`;
}

export interface GroundedBullets {
  whyBullets: string[];
  dropped: BulletCheck[];
  usedFallback: boolean;
}

/**
 * Keep the bullets whose food claims the card's meals support. Never returns an
 * empty list: when all are dropped, the fallback bullet stands in.
 */
export function groundWhyBullets(bullets: readonly string[], meals: readonly MealForGrounding[]): GroundedBullets {
  const kept: string[] = [];
  const dropped: BulletCheck[] = [];
  for (const b of bullets) {
    const unsupported = unsupportedClaims(b, meals);
    if (unsupported.length === 0) kept.push(b);
    else dropped.push({ bullet: b, unsupported });
  }
  if (kept.length > 0) return { whyBullets: kept, dropped, usedFallback: false };
  return { whyBullets: [fallbackBullet(meals)], dropped, usedFallback: true };
}
