// WS9 BUG-338 / D-WS9-298 — STORAGE, AND THE COOK DAY.
//
// Pure, I/O-free, deterministic. Everything here is computed at ASSEMBLY and
// RENDER, on every read, and none of it is cached or sent to the model.
//
// ── WHY THE MODEL NO LONGER WRITES STORAGE TEXT ─────────────────────────────
//
// The census (P-R3) found 57 storage windows that expire before their own cook
// day across 7 of 13 plans, 15 of them raw flesh, max lag 5 days. The cause was
// structural: `loadPrepWeekInput` read no date field at all, so every "up to 2
// days" was a guess by a model that could not know when the meal was cooked.
//
// The fix is not a better prompt. A shelf life is a FACT about a food, the cook
// day is a FACT about the plan, and comparing two facts is arithmetic. The model
// writes the instruction; the code writes how long it keeps.
//
// ⚠️ THE OVERLAY MUST BE APPLIED ON THE CACHE-HIT PATH TOO. `PrepWeekStructure`
// holds the ASSEMBLED result, and these notes depend on the day. A hit that
// returns `structureJson` untouched serves yesterday's dates. Cache what the AI
// wrote; apply this on every read. See `applyStorageOverlay`.

import type { PrepWeekResult } from "./ai/schemas/prepWeek";

/** How long a food class keeps once prepped, in days. Room-temp classes noted. */
export interface StorageClass {
  key: string;
  /** Days in the fridge, unless `roomTemp`. */
  days: number;
  roomTemp?: boolean;
  /** The sentence the step shows. */
  note: string;
  /** Matched against the ingredient names the step covers. */
  match: RegExp;
}

// ── THE TABLE ───────────────────────────────────────────────────────────────
//
// Ordered: the FIRST match wins, so the specific classes come before the general
// ones. Every window is the conservative end of the usual range — a note that
// says 3 days for something that keeps 5 wastes a little food; the other
// direction makes someone ill.
export const STORAGE_TABLE: readonly StorageClass[] = [
  // ── the P1 class: raw flesh ───────────────────────────────────────────────
  {
    key: "raw-fish",
    days: 2,
    note: "Covered in the fridge — cook within 2 days.",
    match: /\b(salmon|cod|halibut|tilapia|tuna|snapper|trout|bass|shrimp|prawns?|scallops?|fish|fillets?)\b/i,
  },
  {
    key: "raw-meat",
    days: 2,
    note: "Covered in the fridge — cook within 2 days.",
    // `ham` was missing until BUG-340's own test asked for it: "deli ham" and
    // "smoked ham hock" fell to the 3-day default, which is the only direction
    // this table is not allowed to be wrong in. `\bham\b` cannot reach
    // "hamburger" — the boundary fails on the following letter — and the
    // dry-cured hams (prosciutto, capicola) are stripped before this runs.
    match: /\b(chicken|turkey|beef|pork|lamb|veal|steak|brisket|tenderloin|sausages?|bacon|ham|chorizo|ground (?:beef|turkey|pork|chicken|lamb)|breasts?|thighs?|drumsticks?|cutlets?|(?:pork|lamb|veal) chops?)\b/i,
  },
  // ── produce, by how fast it turns ─────────────────────────────────────────
  {
    key: "leafy-herbs",
    days: 3,
    note: "Airtight in the fridge, with a barely damp paper towel — up to 3 days.",
    match: /\b(cilantro|parsley|basil|mint|dill|tarragon|chives|scallions?|green onions?|arugula|spinach|lettuce|romaine|herbs?)\b/i,
  },
  {
    key: "citrus-juice",
    days: 3,
    note: "Small sealed jar in the fridge — up to 3 days.",
    match: /\b(lime juice|lemon juice|orange juice|grapefruit juice|citrus juice)\b/i,
  },
  {
    key: "citrus-wedges",
    days: 3,
    note: "Airtight in the fridge — up to 3 days.",
    match: /\b(wedges?|zest)\b/i,
  },
  {
    key: "cut-alliums",
    days: 4,
    note: "Airtight in the fridge — up to 4 days. It will scent the shelf; a sealed jar helps.",
    // Same trap as the chiles below, and the smoke run found it: "garlic
    // POWDER" is a dry spice and was getting the 4-day fridge note, scent-of-
    // the-shelf advice and all. Every allium here has a ground form.
    match: /\b(onions?|shallots?|garlic|leeks?|scallion)(?!\s+(?:powder|salt|granules))\b/i,
  },
  {
    key: "cut-peppers",
    days: 4,
    note: "Airtight in the fridge — up to 4 days.",
    // ⚠️ "chili" AND "pepper" ARE SPICES TOO. The first version matched `chilis?`
    // and sent "ground cumin, chili powder, spice blend" to the 4-day fridge
    // class instead of the room-temperature one — a fresh-chile pattern eating a
    // ground spice. The lookaheads exclude the ground forms; a fresh chile keeps
    // its short window.
    // …AND NOT ONE QUALIFIED AHEAD OF THE NOUN EITHER. The lookaheads caught
    // "pepper powder" and "chili flakes"; they did not catch CAYENNE pepper, BLACK
    // pepper or DRIED ANCHO chiles, so a bowl of paprika, cayenne and masa was told
    // to live in the fridge for four days. Third instance of this exact shape in the
    // pass — a fresh-produce pattern eating a cupboard spice.
    match: /\b(?<!\b(?:cayenne|black|white|ground|cracked|crushed|dried|smoked|chipotle|ancho|guajillo|chile|chili)\s)(?:peppers?(?!\s+(?:powder|flakes))|chil[ei]s?(?!\s+(?:powder|flakes)))\b|\b(?:jalapeños?|jalapenos?|serranos?|poblanos?|tomatillos?|tomatoes?|cucumbers?|celery|carrots?|radishes?|cabbage|broccoli|cauliflower|zucchini|squash|green beans?|asparagus|mushrooms?)\b/i,
  },
  // ── made things ───────────────────────────────────────────────────────────
  {
    key: "cooked-grains",
    days: 4,
    note: "Airtight in the fridge — up to 4 days.",
    match: /\b(rice|quinoa|couscous|farro|barley|orzo|pasta|noodles?|grains?)\b/i,
  },
  {
    key: "sauces-dressings",
    days: 5,
    note: "Sealed jar in the fridge — up to 5 days. Shake or stir before using.",
    match: /\b(sauce|dressing|vinaigrette|marinade|glaze|crema|aioli|remoulade|pesto|chimichurri|tzatziki|salsa|relish|chutney)\b/i,
  },
  {
    key: "spice-blend",
    days: 7,
    roomTemp: true,
    note: "Small airtight container at room temperature — it keeps for weeks.",
    match: /\b(spice blend|seasoning|rub|blend|spices?)\b/i,
  },
  // H6.1-C — THE DRY MIX. Flour, cornmeal, masa, sugar, leaveners, salt and dry
  // legumes and grains: a cupboard holds them for months, and the table had no
  // class for any of them, so a dumpling dough bowl was told to live in the fridge
  // for 3 days.
  {
    key: "dry-mix",
    days: 14,
    roomTemp: true,
    note: "Airtight at room temperature — it keeps for weeks.",
    match:
      /\b(flour|cornmeal|cornstarch|corn starch|masa(?:\s+harina)?|polenta|semolina|baking powder|baking soda|cream of tartar|yeast|sugar|brown sugar|powdered sugar|confectioners.? sugar|cocoa|salt|rice|lentils?|split peas|dried beans|oats|breadcrumbs|panko)\b/i,
  },
];

// ── BUG-340 — SHELF-STABLE PROTEINS ─────────────────────────────────────────
//
// Anchovy paste's `Ingredient.category` is Protein, so it landed in the
// Proteins phase and a jar that keeps for months was told to cook within 2
// days. The category is not the problem to solve: grocery aisles read it, and
// D-WS9-211 already ruled it is not a usable cross-check. The form is.
//
// 🔴 AN ADJECTIVE LIST WOULD HAVE REPEATED THE "CHILI POWDER" MISTAKE TWICE
// OVER. The obvious regex is /cured|smoked|dried/ — and BACON, HAM, SMOKED
// SAUSAGE and KIELBASA are all cured or smoked and all live in the fridge. A
// dev sweep of the 59 Protein-category names carrying one of those words found
// 53 of them refrigerated. So this is a list of SHELF-STABLE FORMS, not of
// preservation adjectives: a paste, a can, a jar, something dried, and the
// dry-cured salumi that hang at room temperature. Fresh sausage, bacon, ham and
// smoked poultry are deliberately absent and must stay absent.
//
// ⚠️ TWO REGEXES FROM ONE SOURCE, ON PURPOSE. A `/g` regex carries `lastIndex`
// between calls, so `.test()` on a shared global instance answers differently
// every other time it is asked. The exported one is NOT global and is the only
// one anything calls `.test()` on; the stripper below builds its own global
// copy and `.replace()` resets it.
// ── H6.1-C — THE CONTAINER'S FORM, FROM ITS MEMBERS ─────────────────────────
//
// The note text says what KIND of container this is, and the window says how long.
// They are different questions with different answers: a marinade holding rosemary
// keeps for 3 days BECAUSE of the rosemary, and is still a jar of oil rather than a
// tub of loose herbs that wants a damp paper towel over it.
//
// 🔴 READ FROM THE MEMBERS, never from the bowl or dish name — that leak is what
// classed a bowl of flour and cornmeal as cut chillies because the dish was called
// "Jalapeño Cheddar Cornbread".
type ContainerForm = "wet" | "dry" | "herbs" | "flesh" | "produce";

/** Anything poured. One of these and the container is a jar, whatever else is in it. */
const WET_MEMBER =
  /\b(oil|vinegar|juice|sauce|broth|stock|wine|cream|yogurt|yoghurt|mayonnaise|mayo|mustard|honey|syrup|molasses|buttermilk|milk|water|paste|pur[ée]e|zest)\b/i;
/** Loose fresh herbs, which are the only thing the damp-towel advice is for. */
const HERB_MEMBER =
  /\b(?:fresh\s+)?(parsley|cilantro|coriander leaves|basil|mint|dill|chives|tarragon|oregano leaves|rosemary|thyme|sage)\b/i;
/** Cupboard dry goods — the dry-mix class's own vocabulary. */
const DRY_MEMBER =
  /\b(flour|cornmeal|cornstarch|corn starch|masa(?:\s+harina)?|polenta|semolina|baking powder|baking soda|cream of tartar|yeast|sugar|cocoa|salt|pepper\b(?!\s*s)|peppercorns?|cayenne|paprika|cumin|coriander|turmeric|cinnamon|nutmeg|clove powder|chili powder|chile powder|curry powder|garlic powder|onion powder|dried \w+|ground \w+|breadcrumbs|panko|oats|rice|lentils?)\b/i;

function containerForm(names: readonly string[], fleshIdentity: string): ContainerForm {
  if (RAW_FLESH_HINT.test(fleshIdentity)) return "flesh";
  if (names.some((n) => WET_MEMBER.test(n))) return "wet";
  if (names.length > 0 && names.every((n) => DRY_MEMBER.test(n))) return "dry";
  if (names.some((n) => HERB_MEMBER.test(n))) return "herbs";
  return "produce";
}

/** The sentence each form writes. `N` is replaced by the strictest window. */
const FORM_NOTE: Readonly<Record<ContainerForm, string>> = {
  wet: "Covered in the fridge — up to N days.",
  dry: "Airtight at room temperature — it keeps for weeks.",
  herbs: "Airtight in the fridge, with a barely damp paper towel — up to N days.",
  flesh: "Covered in the fridge — cook within N days.",
  produce: "Airtight in the fridge — up to N days.",
};

const SHELF_STABLE_SRC =
  "\\b(?:anchovy paste|shrimp paste|fish paste|(?:canned|tinned|jarred)\\s+\\w+" +
  "|dried (?:shrimp|anchovies|anchovy|fish|beef)" +
  "|salami|genoa salami|soppressata|capicola|coppa|bresaola|pepperoni" +
  "|prosciutto(?: di parma)?|cured chorizo|spanish cured chorizo|dry-cured \\w+|jerky)\\b";

export const SHELF_STABLE_PROTEIN = new RegExp(SHELF_STABLE_SRC, "i");
const SHELF_STABLE_ALL = new RegExp(SHELF_STABLE_SRC, "gi");

/** Remove every shelf-stable form from a contents string. */
export function stripShelfStable(text: string): string {
  return text.replace(SHELF_STABLE_ALL, " ");
}

/** BUG-340 — what a shelf-stable protein's step says instead of the 2-day line. */
export const SHELF_STABLE_STORAGE: StorageClass = {
  key: "shelf-stable",
  days: 30,
  roomTemp: true,
  note: "Shelf-stable — it keeps in its own jar or packet, so portion it whenever suits you.",
  match: /(?:)/,
};

/** The fallback when nothing matches: the shortest produce window. */
export const DEFAULT_STORAGE: StorageClass = {
  key: "default",
  days: 3,
  note: "Airtight in the fridge — up to 3 days.",
  match: /(?:)/,
};

/** The classes D-WS9-298 treats as the P1 (raw flesh) class. */
const P1_KEYS = new Set(["raw-fish", "raw-meat"]);

export const isP1Class = (c: StorageClass) => P1_KEYS.has(c.key);

/**
 * First match wins.
 *
 * ⚠️ THE BOWL NAME IS A LABEL, NOT CONTENTS, AND THE P1 CLASSES MUST NOT SEE IT.
 * Two opposite mistakes, one after the other:
 *
 *   • without the bowl name, "Loaded Vegetarian Nachos seasoning" holding cumin,
 *     chili powder and garlic powder read as loose produce, because none of
 *     those three words says "blend";
 *   • WITH it, "Sheet-Pan Chicken Fajitas seasoning bowl" — a jar of dry spices
 *     — matched the raw-meat class on the word CHICKEN and was told to cook
 *     within 2 days.
 *
 * So the label decides what KIND of mixture it is, and the contents decide
 * whether raw flesh is in the container. The raw classes read `contents` alone.
 *
 * BUG-340 — and a shelf-stable form is SUBTRACTED from the contents before any
 * of that, rather than short-circuiting it. "Anchovy paste" alone then matches
 * nothing and comes back shelf-stable; "salmon fillets and anchovy paste" still
 * matches raw-fish on what is left, which is the whole reason this is a strip
 * and not an early return. Same shape as the label split above: remove what is
 * not flesh, then ask whether flesh remains.
 */
/**
 * Raw flesh, for the form test only — the WINDOW still comes from the P1 classes in
 * the table, which are the authority and are unchanged.
 */
const RAW_FLESH_HINT =
  /\b(chicken|turkey|beef|pork|lamb|veal|steak|chuck|brisket|salmon|cod|halibut|tilapia|tuna|snapper|trout|shrimp|prawns?|scallops?|fillets?|breasts?|thighs?|drumsticks?|cutlets?|chops?|ground\s+(?:beef|turkey|pork|chicken|lamb|veal|sausage|meat|bison|venison))\b/i;

export function storageClassFor(
  contents: string,
  bowlName = "",
  /**
   * BUG-346 (a) — THE IDENTITIES of the ingredients in the container, with no
   * preparation notes attached. The raw-flesh classes read ONLY this.
   *
   * 🔴 A FREE-TEXT NOTE IS NOT AN INGREDIENT. `"baking soda (for tenderizing
   * beef)"` matched the raw-meat class on the word BEEF, and a sauce jar holding
   * nothing but powders was told to cook within 2 days. So did `"cornstarch (for
   * velveting the chicken)"`. The note says what the powder is FOR — the dish it
   * serves, the protein it will act on — and the one thing it never says is what
   * is in the container.
   *
   * Defaults to `contents` so every existing caller keeps today's behaviour; the
   * overlay passes the real list.
   */
  ingredientNames?: readonly string[],
): StorageClass {
  // ── H6.1-C — THE MEMBERS DECIDE, AND ONLY THE MEMBERS ────────────────────
  //
  // 🔴 THE BOWL NAME USED TO BE PART OF THE MATCHED TEXT, and the dish name rode in
  // with it: "Jalapeño Cheddar Cornbread seasoning bowl" matched `cut-peppers` on
  // the word JALAPEÑO, so a bowl of flour and cornmeal was classed as cut chillies
  // and sent to the fridge for 4 days. The same leak let any container with
  // "seasoning" in its label claim the room-temperature spice class whatever was
  // inside it — right for the enchilada spices by luck, wrong in principle.
  //
  // A container's storage is a fact about its CONTENTS. `bowlName` is still taken
  // (callers pass it, and the signature is load-bearing elsewhere) and is
  // deliberately not consulted.
  void bowlName;
  const identity = ingredientNames ? ingredientNames.join(" ") : contents;
  const shelfStable = stripShelfStable(identity);
  const isShelfStable = shelfStable !== identity;
  const fleshIdentity = stripShelfStable(identity);

  // ── THE WINDOW IS THE STRICTEST MEMBER'S; THE NOTE IS THE CONTAINER'S FORM ──
  //
  // A marinade holding rosemary used to take the HERB note — "with a barely damp
  // paper towel" — which is advice for loose herbs in a tub and nonsense for a jar
  // of oil. So every class the contents match is collected: the shortest window
  // wins, and the note comes from the form the container actually has.
  // With no list, the contents string stands in as a single name. The flesh test
  // runs first either way, so "chicken breasts and flour" is still flesh; what this
  // recovers is the ordinary "a jar of three dry spices" case for callers that
  // predate the identity list.
  const names = ingredientNames ?? (contents.trim() === "" ? [] : [contents]);
  const matched = STORAGE_TABLE.filter((c) =>
    c.match.test(isP1Class(c) ? fleshIdentity : shelfStable),
  );
  const form = containerForm(names, fleshIdentity);
  // The WINDOW: the strictest member's, from the table. With nothing matched, the
  // shelf-stable default when every member is shelf stable, else the plain default.
  const base = matched.length > 0
    ? matched.reduce((a, b) => (b.days < a.days ? b : a))
    : isShelfStable
      ? SHELF_STABLE_STORAGE
      : DEFAULT_STORAGE;
  // A dry cupboard container keeps for weeks whatever the strictest row said; every
  // other form takes the strictest window and its own sentence.
  // 🔴 A CUPBOARD FORM CANNOT OVERRIDE A FRIDGE CLASS THE CONTENTS MATCHED.
  // "cooked rice" matches the dry vocabulary on the word RICE, and `cooked-grains`
  // says 4 days in the fridge — the strictest member is the authority on the
  // window, so a 14-day cupboard answer there would be the food-safety mistake this
  // whole table exists to avoid.
  const effForm: ContainerForm = form === "dry" && matched.length > 0 && !base.roomTemp ? "produce" : form;
  if (effForm === "dry") {
    // The strictest ROOM-TEMPERATURE class the contents matched keeps its own key and
    // sentence — an authored spice blend stays a spice blend, a flour mix is a dry
    // mix, and both say "room temperature, weeks". Only a dry form that matched
    // nothing at all needs the generic row.
    if (base.roomTemp) return base;
    const dryRow = STORAGE_TABLE.find((c) => c.key === "dry-mix")!;
    return { ...dryRow, note: FORM_NOTE.dry };
  }
  if (base.roomTemp) return base;
  return {
    ...base,
    note: FORM_NOTE[effForm].replace("N", String(base.days)),
  };
}

// ── the proteins phase ──────────────────────────────────────────────────────

/**
 * D-WS9-298 item 3 — shown on the Proteins phase ALWAYS, in the quiet
 * storage-note tier. No alert, no modal: it explains why the phase is short.
 */
/**
 * D-WS9-301 rule 13 — shown on the Proteins phase when the plan has NO cook
 * days at all. Everything is prepped with the 2-day note, and this says why the
 * app cannot do better and what the cook can do about it.
 */
export const NO_COOK_DAYS_NOTE =
  "Assign cook days in Plan Review and Kiwi will hold raw meat and fish for the right day.";

/** D-WS9-301 rule 13 — the heading above the held-for-cook-day lines. */
export const HELD_FOR_COOK_DAY_TITLE = "Held for cook day";

export const PROTEINS_PHASE_NOTE =
  "Fish, poultry and meat keep about two days once handled, so this phase only preps what you'll cook soon.";

/** D-WS9-298 item 2 — what happens to one raw-flesh step, given its lag. */
export type ProteinVerdict =
  | { kind: "keep"; note: string }
  | { kind: "demote"; note: string }
  | { kind: "unknown-day"; note: string };

/**
 * ⚠️ `daysUntilCook` IS THE WHOLE INPUT, and `undefined` is not zero. A plan with
 * no day assignment (4 of the 13 census plans) genuinely does not know, and
 * saying "cook within 2 days" to someone whose meal is on Saturday is the defect
 * this rule exists to remove. The unknown case gets its own sentence.
 */
export function judgeProteinStep(daysUntilCook: number | undefined): ProteinVerdict {
  if (daysUntilCook === undefined) {
    return {
      kind: "unknown-day",
      note:
        "Raw fish, poultry and meat keep about 2 days once handled — prep this the day before you cook, or leave it for cook day.",
    };
  }
  if (daysUntilCook <= 2) {
    return { kind: "keep", note: "Covered in the fridge — cook within 2 days." };
  }
  return {
    kind: "demote",
    note: `This one is ${daysUntilCook} days out — leave it for cook day.`,
  };
}

/**
 * D-WS9-298 item 2 / D-WS9-297 ruling 11 — a demoted step's title names the
 * THING, never the action it forbids. "Halve the baby yellow potatoes" over
 * "keep them whole until cook day" is two lines arguing with each other.
 *
 * Derived from the step's ingredient names rather than rewriting the model's
 * title, because the model's title is an imperative by construction.
 */
/** "Cube the chuck" → "cube the chuck", for the middle of a sentence. */
function lowerFirst(t: string): string {
  return t.length === 0 ? t : `${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}

export function nounFormTitle(ingredientNames: string[]): string {
  const names = [...new Set(ingredientNames.map((n) => n.trim()).filter(Boolean))];
  if (names.length === 0) return "Cook day";
  const head = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  // Sentence case on the first letter only; catalog names are already lowercase
  // except for proper nouns, which must keep their capitals.
  return `${head.charAt(0).toUpperCase()}${head.slice(1)} — cook day`;
}

// ── THE OVERLAY ─────────────────────────────────────────────────────────────

/** What the overlay needs about one planned step, by stepKey. */
export interface StorageContext {
  /** Days from the prep session to the LATEST meal this step feeds. */
  daysUntilCook?: number;
  /** The phase the step sits in — proteins has its own rules. */
  phase: string;
  /** The ingredient names and prep notes the step covers — the CONTENTS. */
  text: string;
  /** The bowl's name, when the step has one. A LABEL, never contents. */
  bowlName?: string;
  /** Ingredient names, for the noun-form title of a demoted step. */
  ingredientNames: string[];
  /**
   * D-WS9-301 rule 13 — the weekday this step's latest meal is cooked on, for
   * the held list: "Texas-style chili (Saturday, 5 days out)". Absent when the
   * plan carries no day for it.
   */
  dayName?: string;
  /** The dish or meal the held line names. */
  mealName?: string;
  /**
   * H7 2b — the containers this step is the LAST to touch, each with its full
   * membership (prepWeekAssembly.storageClosesByStepKey). When present the note is
   * built from these, not from the step's own contents: the carrots step that
   * closes the slow cooker's vegetables writes that container's line.
   */
  closes?: readonly {
    name: string;
    ingredientNames: readonly string[];
    text: string;
    own: boolean;
    /** H7.1 2a — a cold mixture's dressing containers. */
    combineWith?: readonly string[];
    /** H7.1 2b — the proteins that belong with this marinade. */
    joins?: readonly MarinadeJoinFacts[];
  }[];
  /** H7.1 2b — on a protein step: the marinade it belongs with. */
  marinadeJoin?: MarinadeJoinFacts & { bowl: string };
}

/** H7.1 — the date-free facts; the sentence depends on the cook day. */
export interface MarinadeJoinFacts {
  protein?: string;
  marinates: boolean;
  seafood: boolean;
  acidic: boolean;
}

/**
 * H7.1 — "within 1 day of prep": the only window in which a dressing goes into its
 * vegetables, or a protein into its marinade, at the prep session itself.
 */
const SOON_DAYS = 1;

/** The part of a tub label that names the food: "Fresh Pico de Gallo — lime juice" → "lime juice". */
const foodOf = (label: string) => (label.includes(" — ") ? label.split(" — ").slice(1).join(" — ") : label);

/**
 * H7.1 — the date-dependent half of a close: a cold mixture's dressing, a marinade's
 * proteins. Computed on every read, like the storage line, because the cached prose
 * cannot know the cook day.
 */
function timingLines(
  c: NonNullable<StorageContext["closes"]>[number],
  ctx: Pick<StorageContext, "daysUntilCook" | "dayName">,
  held: string[],
): string[] {
  const out: string[] = [];
  const soon = ctx.daysUntilCook !== undefined && ctx.daysUntilCook <= SOON_DAYS;
  const when = ctx.dayName ? ` (${ctx.dayName})` : "";
  if (c.combineWith && c.combineWith.length > 0) {
    const what = c.combineWith.map(foodOf).join(" and ");
    out.push(soon ? `Stir in the ${what} now — it is eaten within a day.` : `Keep the ${what} separate; combine on cook day${when}.`);
  }
  for (const j of c.joins ?? []) {
    const who = j.protein ?? "protein";
    if (j.seafood && j.acidic) {
      // Seafood never sits in acid ahead: the acid starts to cook it.
      out.push(`Add the ${who} just before cooking${when} — acid starts to cook seafood.`);
    } else if (j.marinates && soon) {
      out.push(`The ${who} go in at the proteins step and marinate until cook day.`);
    } else {
      const line = `Add the ${who} the night before you cook them${when}.`;
      out.push(line);
      held.push(line);
    }
  }
  return out;
}

/** The wire caps `storageNote` at 200 characters (PrepWeekStepSchema). */
const NOTE_MAX = 200;

/**
 * H7 2b — the storage line for the containers one step closes.
 *
 * A container that is the step's own food reads as the plain note, exactly as before.
 * Anyone else's container is named, because the cook is closing a lid on something
 * other than what the step was about: "Slow-Cooker Chicken vegetables: Airtight in
 * the fridge — up to 4 days." The name is the part of a tub label before its dash —
 * the dinners after it are already on the lid.
 */
export function closingNote(
  closes: NonNullable<StorageContext["closes"]>,
  /** H7.1 — the cook day, for the dressing and marinade lines; absent = unknown. */
  ctx: Pick<StorageContext, "daysUntilCook" | "dayName"> = {},
  held: string[] = [],
): string {
  const timing = closes.flatMap((c) => timingLines(c, ctx, held));
  const finish = (s: string) => {
    const all = [s, ...timing].join(" ");
    return all.length <= NOTE_MAX ? all : `${all.slice(0, NOTE_MAX - 1).trimEnd()}…`;
  };
  // One sentence when every container this step closes keeps the same way: the
  // jalapeño step closing the tomatillo tray AND the cornbread's jalapeño tub read
  // "…up to 4 days. Airtight in the fridge — up to 4 days." twice over.
  const notes = closes.map((c) => storageClassFor(c.text, c.name, c.ingredientNames).note);
  if (closes.length > 1 && notes.every((n) => n === notes[0])) {
    return finish(`${closes.length === 2 ? "Both containers" : `All ${closes.length} containers`}: ${notes[0]}`);
  }
  const parts: string[] = [];
  for (const c of closes) {
    const note = storageClassFor(c.text, c.name, c.ingredientNames).note;
    // The full name, so two containers of one dish ("Classic Chicken Noodle Soup —
    // carrots and celery stalks" / "— yellow onion…") stay two. Only a long tub label
    // is cut at its dash, where the list of dinners begins.
    const label = c.name.length <= 70 ? c.name : c.name.split(" — ")[0];
    const line = c.own ? note : `${label}: ${note}`;
    if (!parts.includes(line)) parts.push(line);
  }
  return finish(parts.join(" "));
}

/**
 * D-WS9-298 — rewrite every storage note, demote the proteins that will not
 * keep, and add the Proteins phase line.
 *
 * 🔴 CALLED ON EVERY READ, INCLUDING A CACHE HIT. The cached blob is the
 * assembled result and these notes depend on the DAY, so a hit that returned
 * `structureJson` untouched would serve the dates the plan had when it was
 * generated. Cache what the AI wrote; compute this fresh.
 *
 * 🔴 THE MODEL'S OWN `storageNote` IS DISCARDED, not merged. It was a guess by
 * something that could not see a date (57 windows expired before their own
 * cook day across the census). Keeping it as a fallback would leave exactly
 * the wrong answers in place on exactly the steps the table does not cover.
 */
export function applyStorageOverlay(
  result: PrepWeekResult,
  contextByStepKey: ReadonlyMap<string, StorageContext>,
): PrepWeekResult {
  // D-WS9-301 rule 13 — collected as the proteins phase is rewritten below.
  const held: string[] = [];
  let anyDayKnown = false;
  for (const ctx of contextByStepKey.values()) {
    if (ctx.daysUntilCook !== undefined) anyDayKnown = true;
  }

  return {
    ...result,
    phases: result.phases.map((phase) => {
      // 🔴 THE STEPS ARE REWRITTEN BEFORE THE PHASE OBJECT IS BUILT, AND THAT
      // ORDER IS LOAD-BEARING. `held` is filled by the demote branch inside the
      // step map below. Reading `heldForCookDay` in the same object literal
      // that builds the steps reads an EMPTY array: object properties evaluate
      // in source order, so the spread ran before its own phase's steps had.
      // The test caught it; the types never could.
      const steps = phase.steps.map((step) => {
        // ── D-WS9-301 H2.3 — A STEP THAT IS NOT DONE HAS NOTHING TO STORE ────
        //
        // The corpus shipped: "Pre-measuring 1½ tbsp olive oil to drizzle over
        // asparagus saves nothing — just pour it straight from the bottle when
        // you roast. Skip this one and do it at the stove. » Airtight in the
        // fridge — up to 3 days." Two sentences arguing with each other, and the
        // second one is advice about a container that will never exist.
        //
        // Applies to a step that arrives ALREADY demoted — by the narrator or by
        // the engine. The protein demotion BELOW is different: it writes "This
        // one is 4 days out — leave it for cook day" into the same field, and
        // that sentence is the reason, not a storage instruction.
        // ── H6.1-C — NOT EVERY STEP HAS A STORAGE LINE ────────────────────
        //
        // The wash step holds nothing — it reads "Airtight in the fridge — up to 3
        // days" about a pile of rinsed vegetables it does not keep. And a container
        // worked again in a later phase is not finished, so its line belongs to the
        // step that closes it (`suppressStorage`).
        if (step.holdsNoContainer === true || step.suppressStorage === true) {
          const { storageNote: _none, ...rest } = step;
          return rest;
        }
        if (step.skipSuggested) {
          const { storageNote: _drop, ...rest } = step;
          return rest;
        }
        const ctx = contextByStepKey.get(step.stepKey);
        if (!ctx) {
          // No context means the step plan does not know this key — drop the
          // model's note rather than keep an unverifiable one.
          const { storageNote: _drop, ...rest } = step;
          return rest;
        }
        // BUG-340 — a shelf-stable form in the Proteins phase is not raw flesh,
        // whatever the phase says. The phase classifier below also keeps these
        // out of the phase; this is the second half of the same fix, and it is
        // the half the user is protected by: a category the catalog gets wrong
        // tomorrow must not be able to put "cook within 2 days" on a jar.
        const identityHere = ctx.ingredientNames.join(" ");
        const shelfStableHere = stripShelfStable(identityHere) !== identityHere;
        if (ctx.phase === "proteins" && !shelfStableHere) {
          const verdict = judgeProteinStep(ctx.daysUntilCook);
          if (verdict.kind === "demote") {
            // Rule 13 — "shown instead of silently dropped".
            const who = ctx.mealName ?? nounFormTitle(ctx.ingredientNames).replace(" — cook day", "");
            const when = ctx.dayName
              ? `${ctx.dayName}, ${ctx.daysUntilCook} days out`
              : `${ctx.daysUntilCook} days out`;
            // Rule 13 names the ACTION — "cube the chuck that morning" — so it
            // reads the step's own title, which rule 12 has already opened with
            // the verb the recipe uses. The noun form is the fallback for a step
            // whose recipe named none.
            const what = /^(pound|trim|cube|cut|skin|portion|butterfly|slice|halve|dice)/i.test(step.title)
              ? lowerFirst(step.title)
              : lowerFirst(nounFormTitle(ctx.ingredientNames).replace(" — cook day", ""));
            held.push(`${who} (${when}) — ${what} that morning.`);
            return {
              ...step,
              title: nounFormTitle(ctx.ingredientNames),
              storageNote: verdict.note,
              skipSuggested: true,
            };
          }
          // H7.1 2b — a protein that marinates and is cooked within a day goes into
          // its marinade now; everything else keeps the plain two-day line, and the
          // marinade's own close says when it joins.
          const j = ctx.marinadeJoin;
          if (
            j &&
            j.marinates &&
            !(j.seafood && j.acidic) &&
            ctx.daysUntilCook !== undefined &&
            ctx.daysUntilCook <= SOON_DAYS
          ) {
            return {
              ...step,
              storageNote: `Then into the ${j.bowl} to marinate — covered in the fridge, cook within 1 day.`.slice(0, NOTE_MAX),
            };
          }
          return { ...step, storageNote: verdict.note };
        }
        return {
          ...step,
          // H7 2b — the containers this step closes, when the plan says which. A step
          // with no list (an older caller, a step that touches nothing named) keeps
          // the note for its own contents.
          // BUG-346 (a) — the identities, so a note cannot name a protein.
          storageNote:
            ctx.closes && ctx.closes.length > 0
              ? closingNote(ctx.closes, ctx, held)
              : storageClassFor(ctx.text, ctx.bowlName, ctx.ingredientNames).note,
        };
      });

      return {
        ...phase,
        // D-WS9-298 item 3 + D-WS9-301 rule 13. With no cook days anywhere the
        // phase says so and tells the cook how to fix it; otherwise it carries
        // the standing two-day line.
        ...(phase.phase === "proteins"
          ? { note: anyDayKnown ? PROTEINS_PHASE_NOTE : `${PROTEINS_PHASE_NOTE} ${NO_COOK_DAYS_NOTE}` }
          : {}),
        ...(phase.phase === "proteins" && held.length > 0 ? { heldForCookDay: held } : {}),
        steps,
      };
    }),
  };
}