// FIX-2 (BUG-058 / D-WS9-102 ruling 3) — the dish FORM of a meal, read from its
// words. The cheap, no-AI pre-filter in front of `meals.find_similar`.
//
// WHY WORDS. Swap for Similar is meant to find meals that are cooked and eaten
// the same way (Hans: chicken parm ~ piccata, spaghetti and meatballs, chicken
// fingers, baked cutlets — "not a whole chicken and not a bbq anything"; chicken
// and dumplings ~ chicken soup, pot pie, a baked chicken dinner, a beef stew or
// chili). The catalog has no column for that: Meal.tags carries the cuisine and
// the difficulty and nothing else (measured on dev, October 17: 99 distinct tags
// over 1,325 dinners, none of them a form or a method). The title and the dish
// titles DO name the form ("Crispy Baked Chicken Parmesan", "Slow-Cooker Chicken
// and Dumplings", "Breaded Chicken Cutlets with Vodka Sauce"), so that is where
// this reads it. No taxonomy column: the AI ranks what this keeps.
//
// MAIN vs SIDE. "Baked Lemon-Herb Salmon with White Bean and Tomato Ragout" is a
// fish plate, not a stew. The form comes from the MAIN text (the title before
// "with", plus the main-role dishes); the side dishes count for less.
//
// A form belongs to one or more FAMILIES — the eating experience it shares with
// other forms (a pot pie and a stew are both cozy and spoonable). A candidate
// scores on shared forms first and shared families second; cuisine is a tie-break.

export type DishForm =
  | "cutlet"
  | "red_sauce"
  | "pasta"
  | "meatballs"
  | "noodles"
  | "soup"
  | "stew"
  | "pie_casserole"
  | "braise"
  | "roast_plate"
  | "fillet_plate"
  | "tacos"
  | "handheld"
  | "pizza"
  | "bowl"
  | "stir_fry"
  | "curry"
  | "rice_dish"
  | "grill_bbq"
  | "salad"
  | "sheet_pan"
  | "skillet"
  | "breakfast";

type Family = "crispy_italian" | "cozy" | "handheld" | "wok" | "grill" | "plate" | "fresh";

const FORM_PATTERNS: Record<DishForm, RegExp> = {
  cutlet:
    /\b(?:(?:chicken|eggplant|veal|turkey|pork|shrimp) parm(?:esan|igiana)?|parm sub|piccata|cutlets?|schnitzel|milanese|katsu|francese|scal(?:l)?op(?:p)?ini|marsala|tenders|fingers|nuggets|popcorn chicken|breaded|panko|parmesan[- ]crusted|fried chicken|chicken[- ]fried(?! rice))\b/,
  red_sauce:
    /\b(?:marinara|(?:chicken|eggplant|veal|turkey) parm(?:esan|igiana)?|parm sub|vodka sauce|bolognese|ragu|arrabbiata|pomodoro|baked ziti|lasagna|meatballs?)\b/,
  pasta:
    /\b(?:spaghetti|pasta|penne|rigatoni|linguine|fettuccine|angel hair|ziti|lasagna|macaroni|mac (?:and|&|n) cheese|tortellini|ravioli|gnocchi|orzo|bucatini|pappardelle|farfalle|orecchiette|alfredo|carbonara|cacio e pepe|chop suey|stroganoff|egg noodles)\b/,
  meatballs: /\bmeatballs?\b/,
  noodles: /\b(?:lo mein|chow mein|ramen|udon|soba|pad (?:thai|see ew)|rice noodles|noodle bowls?|dan dan|yakisoba|japchae|pho)\b/,
  soup: /\b(?:soup|chowder|bisque|pho|ramen|gumbo|minestrone|pozole|posole|broth bowl)\b/,
  stew:
    /\b(?:stew|(?<!sweet[- ])(?<!thai )chili(?![- ]?(?:crisp|oil|lime|garlic|flakes|sauce|glaze|dipping|dogs?|cheese|fries|loaded|rubbed|spiced|powder|honey|mango|crunch|crusted|glazed))|goulash|chicken (?:and|&|n) (?:rolled |drop[- ])?dumplings|dumpling stew|cassoulet|tagine|etouffee|étouffée|ragout)\b/,
  pie_casserole:
    /\b(?:pot pies?|casserole|shepherd'?s pie|cottage pie|baked ziti|lasagna|gratin|strata|hotdish|tamale pie|stuffed peppers|moussaka|bake)\b/,
  braise:
    /\b(?:braised?|slow[- ]cooker|crock ?pot|pot roast|short ribs|osso buco|instant pot|pressure[- ]cooker|carnitas|birria|ropa vieja|beef bourguignon|coq au vin)\b/,
  roast_plate:
    /\b(?:roast(?:ed)? (?:chicken|turkey|pork|beef)|pot roast|whole chicken|spatchcock|roast beef|pork loin|pork tenderloin|tenderloin|meatloaf|chicken thighs?|drumsticks|pork chops?|baked chicken(?! parm)|lemon chicken|herb chicken|garlic chicken|smothered)\b/,
  fillet_plate:
    /\b(?:salmon|cod|halibut|tilapia|trout|mahi[- ]?mahi|sea bass|snapper|swordfish|tuna steaks?|fish fillets?|scallops|steak|sirloin|ribeye|filet mignon|flank)\b/,
  tacos: /\b(?:tacos?|burritos?|quesadillas?|fajitas?|tostadas?|enchiladas?|nachos|taquitos|chimichangas?|gorditas?|sopes|flautas)\b/,
  handheld:
    /\b(?:burgers?|sandwich(?:es)?|subs?|sliders|wraps?|melts?|hoagies?|po'? ?boys?|gyros?|pitas?|banh mi|cheesesteaks?|sloppy joes?|hot dogs?|chili dogs?|paninis?|grilled cheese|lettuce wraps|lobster rolls?|french dip)\b/,
  pizza: /\b(?:pizzas?|calzones?|flatbreads?|stromboli)\b/,
  bowl: /\b(?:bowls?|poke|bibimbap|buddha|grain bowl|donburi)\b/,
  stir_fry:
    /\b(?:stir[- ]?fr(?:y|ied)|fried rice|lo mein|chow mein|kung pao|general tso'?s?|orange chicken|sesame chicken|beef (?:and|&) broccoli|teriyaki|szechuan|sichuan|mongolian|cashew chicken|sweet (?:and|&) sour|pad kra pao|bulgogi|wok)\b/,
  curry: /\b(?:curry|tikka|masala|korma|vindaloo|dal|dahl|saag|biryani|butter chicken|rogan josh)\b/,
  rice_dish: /\b(?:risotto|paella|jambalaya|fried rice|pilaf|biryani|arroz con pollo|congee)\b/,
  grill_bbq:
    /\b(?:bbq|barbecue|barbecued|grilled|grill|kebabs?|kabobs?|skewers|ribs|brisket|pulled pork|pulled chicken|smoked|souvlaki|satay|jerk|carne asada|cookout)\b/,
  salad: /\b(?:salad|slaw)\b/,
  sheet_pan: /\b(?:sheet[- ]pan|traybake|tray bake|one[- ]pan|foil packets?)\b/,
  skillet: /\b(?:skillet|one[- ]pot|hash|sauté|saute)\b/,
  breakfast: /\b(?:frittata|omelet(?:te)?|quiche|pancakes|waffles|shakshuka|breakfast|eggs benedict|french toast)\b/,
};

const FORM_FAMILIES: Record<DishForm, readonly Family[]> = {
  cutlet: ["crispy_italian"],
  red_sauce: ["crispy_italian"],
  pasta: ["crispy_italian"],
  meatballs: ["crispy_italian"],
  noodles: ["wok"],
  soup: ["cozy"],
  stew: ["cozy"],
  pie_casserole: ["cozy"],
  braise: [],
  roast_plate: ["cozy", "plate"],
  fillet_plate: ["plate"],
  tacos: ["handheld"],
  handheld: ["handheld"],
  pizza: ["handheld"],
  bowl: ["fresh", "wok"],
  stir_fry: ["wok"],
  curry: ["wok", "cozy"],
  rice_dish: ["wok"],
  grill_bbq: ["grill"],
  salad: ["fresh"],
  sheet_pan: [],
  skillet: [],
  breakfast: [],
};

// Forms eaten nearly the same way, closer than a shared family: chicken and
// dumplings ~ chicken soup ~ pot pie (Hans's list), tacos ~ a burrito or wrap.
const NEAR_FORMS: Partial<Record<DishForm, readonly DishForm[]>> = {
  stew: ["soup", "pie_casserole"],
  soup: ["stew"],
  pie_casserole: ["stew"],
  tacos: ["handheld"],
  handheld: ["tacos", "pizza"],
  pizza: ["handheld"],
  pasta: ["noodles"],
  noodles: ["pasta", "stir_fry"],
  stir_fry: ["noodles", "rice_dish"],
  rice_dish: ["stir_fry"],
  curry: ["stew"],
};

// Forms that are only a method — they sharpen a match, they never make one alone,
// and they carry no family (slow-cooker tacos are tacos, not a cozy stew).
const METHOD_ONLY: ReadonlySet<DishForm> = new Set(["sheet_pan", "skillet", "braise"]);
// A sauce, not a dish: it counts, for less than the dish it sits on.
const SAUCE_ONLY: ReadonlySet<DishForm> = new Set(["red_sauce"]);
// The protein-plate forms are read off a protein word (salmon, steak, chicken
// thighs), so a dish-defining form beside one wins: steak fajitas are tacos, a
// cheesesteak is a sandwich, chicken thigh tacos are tacos.
const PLATE_FORMS: readonly DishForm[] = ["fillet_plate", "roast_plate"];
const DISH_DEFINING: readonly DishForm[] = [
  "tacos", "handheld", "pizza", "bowl", "pasta", "noodles", "soup", "stew", "pie_casserole", "curry", "salad",
];

export interface FormText {
  title: string;
  /** Titles of the meal's main-role dishes (MealDishLink.roleLabel === "main"). */
  mainDishTitles: string[];
  /** Every other dish title (sides, sauces, salads). */
  sideDishTitles: string[];
}

export interface DishFormProfile {
  main: ReadonlySet<DishForm>;
  side: ReadonlySet<DishForm>;
  families: ReadonlySet<Family>;
}

function lower(s: string): string {
  return s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
}

/** The title before its accompaniments: "Al Pastor Tacos with Charred Corn" → "al pastor tacos". */
export function titleHead(title: string): string {
  return lower(title).split(/\s+(?:with|over|on|alongside|served with|plus)\s+|,\s+|\s+[–—-]\s+/)[0] ?? "";
}

function formsIn(text: string): Set<DishForm> {
  const out = new Set<DishForm>();
  for (const [form, re] of Object.entries(FORM_PATTERNS) as [DishForm, RegExp][]) {
    if (re.test(text)) out.add(form);
  }
  return out;
}

export function dishFormProfile(t: FormText): DishFormProfile {
  const head = titleHead(t.title);
  const main = formsIn([head, ...t.mainDishTitles.map(lower)].join(" | "));
  if (DISH_DEFINING.some((f) => main.has(f))) for (const f of PLATE_FORMS) main.delete(f);
  const tail = lower(t.title).slice(head.length);
  const side = formsIn([tail, ...t.sideDishTitles.map(lower)].join(" | "));
  for (const f of main) side.delete(f);
  const families = new Set<Family>();
  for (const f of main) for (const fam of FORM_FAMILIES[f]) families.add(fam);
  return { main, side, families };
}

/**
 * How alike two meals are by form. Shared main forms dominate, shared families
 * come next, a side-dish overlap counts a little. A grill / BBQ candidate for a
 * non-grill source is pushed down (Hans: "not a bbq anything"), as is a roast
 * for a cutlet ("not a whole chicken"). Protein is deliberately NOT a term:
 * D-WS9-102 ruling 3 crosses the protein line, and the AI ranks the rest.
 */
export function formScore(source: DishFormProfile, cand: DishFormProfile): number {
  let score = 0;
  for (const f of source.main) {
    if (cand.main.has(f)) score += METHOD_ONLY.has(f) ? 1 : SAUCE_ONLY.has(f) ? 1.5 : 3;
    else if ((NEAR_FORMS[f] ?? []).some((n) => cand.main.has(n))) score += 1.5;
    else if (cand.side.has(f)) score += 0.5;
  }
  for (const fam of source.families) if (cand.families.has(fam)) score += 2;
  for (const f of source.side) if (cand.main.has(f) || cand.side.has(f)) score += 0.25;
  if (cand.main.has("grill_bbq") && !source.main.has("grill_bbq")) score -= 3;
  if (source.main.has("cutlet") && cand.main.has("roast_plate") && !cand.main.has("cutlet")) score -= 2;
  return score;
}

const HEAD_FILLER = new Set([
  "classic", "easy", "simple", "quick", "homemade", "best", "the", "ultimate", "weeknight",
  "crispy", "baked", "oven", "perfect", "favorite", "favourite", "authentic", "traditional",
  "old-fashioned", "old", "fashioned", "a", "of",
  // Methods, not dishes: "Slow-Cooker Chicken and Dumplings" is chicken and dumplings.
  "slow", "cooker", "crockpot", "crock", "instant", "sheet", "pan", "one", "air", "fryer",
]);

/** "dumplings" → "dumpling", "tacos" → "taco"; leaves "ss" words ("bass") alone. */
function singular(w: string): string {
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

const TOKEN_ALIASES: Record<string, string> = { parm: "parmesan", parmigiana: "parmesan", "&": "and" };

/** The title head's words, filler and joiners dropped ("Crispy Baked Chicken Parm" → {chicken, parmesan}). */
export function headTokens(title: string): ReadonlySet<string> {
  return new Set(
    titleHead(title)
      .replace(/[^a-z0-9'& ]+/g, " ")
      .split(" ")
      .map((w) => TOKEN_ALIASES[w] ?? w)
      .filter((w) => w.length > 0 && w !== "and" && w !== "n" && !HEAD_FILLER.has(w))
      .map(singular),
  );
}

/**
 * Same dish, different sides: "Al Pastor Tacos with Charred Street Corn" and
 * "Al Pastor Pork Tacos with Charred Pineapple…" are one dish to the person
 * swapping (TRIAGE-0: tacos got five of them). Jaccard over the title heads'
 * words, filler dropped, at ≥ 0.75.
 */
export function isSameDishTokens(ta: ReadonlySet<string>, tb: ReadonlySet<string>): boolean {
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.75;
}

export function isSameDish(a: string, b: string): boolean {
  return isSameDishTokens(headTokens(a), headTokens(b));
}

/**
 * A VERSION of a meal the user already has: every word of its dish name is in
 * the candidate's ("Chicken Parmesan" → "Spicy Arrabbiata Chicken Parmesan",
 * "Chicken Parmesan Pasta"). Asymmetric, and only for a two-word-or-longer name,
 * so "Pizza" does not swallow every pizza. Used against the source and the plan's
 * meals, never between candidates.
 */
export function isVersionOf(known: ReadonlySet<string>, cand: ReadonlySet<string>): boolean {
  if (known.size < 2) return false;
  for (const w of known) if (!cand.has(w)) return false;
  return true;
}
