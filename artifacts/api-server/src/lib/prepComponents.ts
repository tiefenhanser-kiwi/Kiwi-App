// WS9 D-WS9-296 / D-WS9-299 — COMPONENTS AND NAMED BOWLS.
//
// Pure, I/O-free. Given one dish's steps and its ingredients, decide which
// ingredients belong to which MIXTURE, and what that mixture's bowl is called.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// `combinePrep` groups by `ingredientId`, so a marinade's eight parts became
// eight steps and eight containers, and nothing ever said they belonged
// together. Hans: "if you're making a marinade that has spices and oils, you
// have a step in the first one (dry ingredients) and you put the spices in Bowl
// A. then you go to the next step with oil and whatever else, and combine those
// liquids also into Bowl A." That is this module.
//
// Measured in B2 Part A over the 13-plan census: 383 of 676 prep-reaching dish
// ingredients (56.7%) get a component, and the vessel count falls 524 → 376.
//
// ── THE FOUR SIGNALS, in precedence order ───────────────────────────────────
//
//   0. THE INGREDIENT'S OWN NOTE (ruling 4) — "…for serving", "for the
//      marinade", "for garnish". Parsed FIRST, before any step is read, because
//      when the data says where something goes there is nothing to infer.
//      Charred Salsa Verde carries white onion twice, "¼ cup … for marinade" and
//      "½ cup … for serving"; B2 Part A put both in the marinade.
//   1. `RecipeInstructionStep.componentKey` — the Block 3.7 path tag
//      (D-WS9-066). 17.9% of dish steps carry one and the values are real
//      component names. Ruling 6: only a MIXTURE noun qualifies; "chicken",
//      "garlic" and "beef" name the food, not the mixture, and fall through.
//   2. A MIXTURE NOUN in the step's own prose.
//   3. The VERB GROUP — a combine/whisk/mix step with no name anywhere is
//      itself the component.
//   4. A NAME MATCH in a component step, for an ingredient whose amount sits on
//      a different step (the dice-then-combine shape). Ruling 2 guards it.

// H7 — a VALUE import from prepMoments, which itself imports only types from
// here, so there is no runtime cycle.
import { isHeatMoment } from "./prepMoments";

/** One step of a dish, as this module needs it. */
export interface ComponentStep {
  stepIndex: number;
  /** The prose the COOK reads — `stepTextTranslated`, never the raw column. */
  text: string;
  componentKey: string | null;
  /** ingredientIds this step's `amountRefs` resolved to. */
  ingredientIds: string[];
  /**
   * D-WS9-301 rule 1 — the authored phase tag, because a MOMENT ends when heat
   * starts. `cook` is the heat marker; everything else (`prep`, `assemble`,
   * `rest`, `hold`) continues the current moment. Measured against a
   * heat-in-prose regex over four plans it agrees on ~82% of steps, and it is
   * the tag the scheduler already trusts, so it is the primary signal.
   */
  phaseType: string;
}

/** One dish ingredient, as this module needs it. */
export interface ComponentIngredient {
  ingredientId: string;
  ingredientName: string;
  preparationNote: string | null;
  /** The engine's phase. `proteins` is never a mixture MEMBER (ruling 1). */
  phase: string | null;
}

export interface ResolvedComponent {
  /** Stable per-dish key: the step group that assembles it. */
  key: string;
  /** The label ("marinade", "glaze"); null for a numbered fallback. */
  noun: string | null;
  /** The finished bowl name, e.g. "Carne asada marinade bowl". */
  bowlName: string;
  /** ingredientIds that are MEMBERS of the mixture. */
  memberIds: string[];
  /**
   * ingredientIds that JOIN it on cook day rather than sitting in it — ruling 1.
   * A raw protein has a destination, not a seat.
   */
  cookDayIds: string[];
  /** Part J.1 — the cook steps that assemble it (ruling 5's identity), so a caller can ask whether any of them is heat. */
  stepIndexes: number[];
}

// ── ruling 6 — THE MIXTURE NOUNS, in one place ──────────────────────────────
//
// A componentKey or a step noun qualifies only if it names a MIXTURE. Ordered
// longest-first so "spice blend" beats "blend" and "pico de gallo" beats "pico".
// An unknown noun falls through to the verb group rather than becoming a label.
const MIXTURE_NOUNS: ReadonlyArray<[RegExp, string]> = [
  [/\bspice (?:blend|mix|rub)\b/i, "spice blend"],
  [/\bseasoning (?:blend|mix|rub)\b/i, "spice blend"],
  [/\bpico de gallo\b/i, "pico de gallo"],
  [/\bcompound butter\b/i, "compound butter"],
  [/\bmarinade\b/i, "marinade"],
  [/\bvinaigrette\b/i, "vinaigrette"],
  [/\bchimichurri\b/i, "chimichurri"],
  [/\bremoulade\b/i, "remoulade"],
  [/\btzatziki\b/i, "tzatziki"],
  [/\bdressing\b/i, "dressing"],
  [/\bchutney\b/i, "chutney"],
  [/\bstuffing\b/i, "stuffing"],
  [/\bbreading\b/i, "breading"],
  [/\bguacamole\b/i, "guacamole"],
  [/\bseasoning\b/i, "seasoning"],
  [/\bfilling\b/i, "filling"],
  [/\brelish\b/i, "relish"],
  [/\bbatter\b/i, "batter"],
  [/\bglaze\b/i, "glaze"],
  [/\bgravy\b/i, "gravy"],
  [/\bsalsa\b/i, "salsa"],
  [/\bcrema\b/i, "crema"],
  [/\baioli\b/i, "aioli"],
  [/\bpesto\b/i, "pesto"],
  [/\bbrine\b/i, "brine"],
  [/\bdough\b/i, "dough"],
  [/\bslaw\b/i, "slaw"],
  [/\bpico\b/i, "pico de gallo"],
  [/\bblend\b/i, "spice blend"],
  [/\bsauce\b/i, "sauce"],
  [/\brub\b/i, "rub"],
];

/**
 * Ruling 5 — ONE MIXTURE, ONE NAME. When two labels attach to the same step
 * group, the more SPECIFIC wins. Lower rank is more specific; `sauce` is the
 * generic everything else beats.
 */
const NOUN_SPECIFICITY: Record<string, number> = {
  "pico de gallo": 0, guacamole: 0, tzatziki: 0, chimichurri: 0, remoulade: 0,
  aioli: 0, pesto: 0, crema: 0, salsa: 0, "compound butter": 0,
  vinaigrette: 1, dressing: 1, marinade: 1, glaze: 1, brine: 1, gravy: 1,
  slaw: 1, relish: 1, chutney: 1, dough: 1, batter: 1, breading: 1,
  "spice blend": 2, rub: 2, seasoning: 2, filling: 2, stuffing: 2,
  sauce: 3,
};
const specificity = (noun: string) => NOUN_SPECIFICITY[noun] ?? 2;

// ── [prepcook] H7 — A SERVE-TIME STEP COMBINES NOTHING AHEAD ─────────────────
//
// Hans, October 2: toss, dress, top, garnish, serve with, spoon over, fold in at
// the end — those happen at the table. The Caesar's "toss the romaine with the
// dressing" was a COMBINE step (`toss` is in the verb group below), so the romaine
// became a member of the dressing and was chopped into its jar on Sunday.
//
// A step is serve time when nothing after it goes into heat (`isHeatMoment`) and
// its verb is one of these. A cold MIXING verb (whisk, stir together, blend) on
// the same step keeps it a mixture: "whisk the oil, vinegar and mustard" is a
// dressing made ahead, and that is still prep.
// 🔴 NOT AFTER A HYPHEN. The first draft read the carne asada's "place the steak
// in a ZIP-TOP bag, pour the marinade over it" as serve time — `top` inside a
// compound noun — and the marinade lost its steak. The H6 lesson for the seventh
// time: a verb pattern will find a noun that contains it unless told not to.
const SERVE_VERB =
  /(?<![-\w])(toss(?:es|ed|ing)?|dress(?:es|ed)?\b|tops?\b|topped|garnish(?:es|ed)?|serve[sd]?|spoon(?:s|ed)?\s+(?:it\s+)?over|drizzl(?:e|es|ed)|sprinkl(?:e|es|ed)|scatter(?:s|ed)?|fold(?:s|ed)?\s+in)\b/i;
const SIT_MIX = /\b(whisk|stir\s+together|blend\s+together|puree|purée|mix\s+together|combine\s+in\s+a\s+(?:bowl|jar))\b/i;

export function isServeTimeStep(step: ComponentStep, ordered: readonly ComponentStep[]): boolean {
  if (isHeatMoment(step, ordered)) return false;
  return SERVE_VERB.test(step.text) && !SIT_MIX.test(step.text);
}

/** A step that COMBINES is one component by construction (signal 3, ruling 2). */
const COMBINE_VERB =
  /\b(whisk(?:\s+together)?|stir\s+together|combine|mix(?:\s+together)?|toss(?:\s+together)?|blend\s+together|mash(?:\s+together)?|fold(?:\s+together| in)?)\b/i;

// ── ruling 2 / ruling 4 — GARNISH AND SERVICE FORMS ─────────────────────────
//
// These never enter a mixture. They are the forms the wedged limes arrived in
// when B2 Part A put them in the hot-sauce jar: a name match on "lime" against
// the sauce step's text, for an ingredient whose own note said "cut into wedges,
// for serving". Matched against the ingredient's NAME and NOTE, never the step.
const SERVICE_FORM =
  /\b(wedges?|wedged|for serving|to serve|for garnish|to garnish|to finish|for finishing|sprinkle over|for topping|garnish)\b/i;
// ── ruling 7 — A MIXTURE WHOSE BASE IS A COOK-DAY ITEM ──────────────────────
//
// The guacamole is the case: cilantro, jalapeño, lime juice and onion all keep
// happily for days, and the avocado does not — cut it on Sunday and it is brown
// by Tuesday. B2 Part A gave it five separate containers because the avocado was
// demoted and took the bowl's reason for existing with it.
//
// So the base is excluded from the mixture exactly as a raw protein is, the
// other four share one vessel, and the bowl says what it is: a MIX-INS bowl,
// waiting for the thing that joins it on cook day.
//
// The same class the narration prompt's demote rule 4 names — a food that
// browns or degrades once cut. Kept short and literal; a guess here costs a
// user a brown guacamole.
const COOK_DAY_BASE = /\b(avocado|avocados|banana|bananas|apple|apples|potato|potatoes)\b/i;

// ── H5.1 — SERVED SEPARATELY IS NOT A MIXTURE ───────────────────────────────
//
// Hans, October 2: toppings and garnishes go on the finished dish; they are never
// combined. So a component whose NAME says it is served rather than assembled is
// not a container at all, and each member is handled on its own — the knife work
// joins its ingredient's produce step, the lime wedges are rule 7's first drop
// class, and a condiment is not prep at all (D-WS9-299).
//
// 🔴 TESTED AGAINST THE NAME, NOT THE STEP PROSE. A mixture's own prose may
// mention serving it ("whisk the vinaigrette… dress the salad to serve"), and a
// vinaigrette is a real jar. What is never a jar is a thing CALLED the toppings.
const SERVED_SEPARATELY =
  /\b(toppings?|garnishes|fixin'?s|fixings|condiments?|accompaniments?|for serving|to serve|serve[- ]?alongside)\b/i;

/**
 * H5.1 — is this thing SET OUT rather than assembled?
 *
 * Exported because two layers have to agree: the component resolver, which must
 * not build a bowl for it, and the assembly's moment grouping, which must not
 * rebuild one from the same run and have rule 8 name it off the dish. The first
 * fix did only the former, and "Taco Toppings sauce jar" came straight back as
 * "Taco Toppings prep container".
 *
 * 🔴 A SPECIFIC MIXTURE STILL WINS. Pico de gallo and guacamole are real bowls
 * however they reach the table, so the class only bites when the name offers no
 * mixture of its own.
 */
/**
 * H6.1 ruling 3 — IS THIS COMPONENT'S OWN WORK COOKING?
 *
 * The chili's `chile-base`: "Toast the 3 ancho chiles… in a dry skillet… cover with
 * boiling water, and soak for 15 minutes", then "Drain… transfer to a blender…
 * blend until completely smooth". None of that is Sunday work, and the engine was
 * putting three kinds of whole dried chile into a prep container for it.
 *
 * Matched on the component's OWN step text, because that is the only place the
 * answer is written. A mixture assembled cold (whisk, stir, toss, combine) is prep
 * however it is used later; one that is heated, soaked or blended is not.
 *
 * ⚠️ `blend` IS NOT HERE AS A NOUN. "Spice blend" is a container; "blend until
 * smooth" is a machine. The verb forms are matched and the noun is not.
 */
const COOKING_WORK =
  /\b(toast(?:s|ed|ing)?|soak(?:s|ed|ing)?|simmer(?:s|ed|ing)?|fry|fries|fried|frying|bakes?\b|baked\b|baking\b(?!\s+(?:powder|soda|sheet|dish|pan|tray|paper))|boil(?:s|ed|ing)?|roast(?:s|ed|ing)?|saut[ée](?:s|ed|ing)?|sear(?:s|ed|ing)?|blend until|blend to|in a blender|br(?:own|owns|owned|owning))\b/i;

export function isCookingWork(stepTexts: readonly string[]): boolean {
  // 🔴 EVERY STEP, NOT SOME. The first draft used `some` and dissolved the
  // dumpling dough bowl and the cornbread dry mix, because a component's steps
  // normally include BOTH the cold assembly and the cooking: "whisk the flour and
  // leaveners" then "drop the dumplings onto the simmering stew". A mixture with a
  // cold step has prep work in it. The chili's chile-base has none — toast, soak,
  // blend — and that is what this is for.
  return stepTexts.length > 0 && stepTexts.every((t) => COOKING_WORK.test(t));
}

export function isServedSeparately(name: string): boolean {
  return SERVED_SEPARATELY.test(name) && nounIn(name) === null;
}

/** Ruling 4 — an explicit destination in the note wins over every signal. */
const NOTE_SAYS_MARINADE = /\bfor (?:the )?marinade\b/i;

const norm = (s: string) => s.toLowerCase().trim();

/** The mixture noun a piece of text names, or null. */
function nounIn(text: string): string | null {
  for (const [re, word] of MIXTURE_NOUNS) if (re.test(text)) return word;
  return null;
}

// ── ruling 8 — THE BOWL NAME ────────────────────────────────────────────────

const JAR_NOUNS = new Set(["glaze", "dressing", "vinaigrette", "sauce", "crema", "aioli", "remoulade"]);
/** Never end a trimmed dish name on one of these. */
const DANGLING = new Set(["and", "with", "of", "in", "the", "a", "an", "or", "for", "&"]);
const NAME_MAX = 32;

/**
 * Ruling 8 — trim a dish title to something a bowl label can carry: cut at the
 * "with …" clause, drop parentheticals, cap at 32 characters, and never end on a
 * dangling conjunction. B2 Part A's 4-word cut produced "Pickled Red Onion and".
 */
export function shortDishName(title: string): string {
  let t = (title ?? "").split(/\s+with\s+/i)[0].replace(/\([^)]*\)/g, "").trim();
  if (t.length > NAME_MAX) {
    const words = t.split(/\s+/);
    t = "";
    for (const w of words) {
      if (t.length > 0 && `${t} ${w}`.length > NAME_MAX) break;
      t = t.length === 0 ? w : `${t} ${w}`;
    }
  }
  // Never end on a conjunction, however the trim got there.
  let words = t.split(/\s+/);
  while (words.length > 1 && DANGLING.has(norm(words[words.length - 1]))) words.pop();
  return words.join(" ");
}

/**
 * Ruling 8 — `{dish} {noun} {vessel}`, with the stutter removed when the dish
 * title already contains the noun ("Pico de Gallo pico de gallo bowl").
 * `mealName` is preferred when the dish IS the meal, which is the single-dish case.
 */
/**
 * D-WS9-301 rule 8 — the use noun for a container the recipe never named,
 * derived from what is in it. Never a number.
 *
 * Deliberately coarse. "Spice blend" and "sauce bowl" are what a cook would
 * call them; a produce-bearing container is the dish's own prep, and calling it
 * a "sauce bowl" because a tablespoon of oil is in it would be worse than
 * saying less.
 */
/**
 * D-WS9-301 H2.2 — nouns that promise a SHELF-STABLE DRY container. None of them
 * may name a container with fresh food in it.
 */
const DRY_NOUNS: ReadonlySet<string> = new Set([
  "seasoning", "seasonings", "spice blend", "spice mix", "spice mixture",
  "rub", "dry rub", "blend", "spices", "dredge", "breading",
]);

export function useNounFor(phases: (string | null)[]): string {
  const set = new Set(phases.filter((p): p is string => !!p));
  if (set.size === 0) return "prep container";
  if (set.size === 1 && set.has("seasonings_dry")) return "spice blend";
  if (!set.has("produce") && !set.has("proteins")) return "sauce bowl";
  return "prep container";
}

export function bowlNameFor(
  dishTitle: string,
  mealName: string | null,
  noun: string | null,
  ordinal: number,
  /** Ruling 8 — a nameless mixture of spices and oil is a "seasoning bowl". */
  looksLikeSeasoning: boolean,
  /** Ruling 7 — the mixture lost a cook-day base, so it is the MIX-INS. */
  lostBase = false,
  /**
   * D-WS9-301 rule 8 — "Containers, named by dish + use. Never 'bowl 1',
   * 'dish A'." This is the use noun for a mixture the author never named, and
   * it replaces the numbered last resort. The sample plan shipped
   * "Slow-Cooker Chicken bowl 1" and "Garlic Herb Roasted Potatoes bowl 1".
   */
  fallbackUse: string | null = null,
): string {
  const dish = shortDishName(
    mealName && norm(mealName) === norm(dishTitle) ? mealName : dishTitle,
  );
  if (lostBase) return `${dish} mix-ins bowl`;
  if (noun === null) {
    if (looksLikeSeasoning) return `${dish} seasoning bowl`;
    // Rule 8 — a use, never an ordinal. `ordinal` is kept in the signature
    // because a caller that genuinely has nothing to say still needs a unique
    // name, but no production path reaches it any more.
    if (fallbackUse) return `${dish} ${fallbackUse}`;
    return `${dish} bowl ${ordinal}`;
  }
  const vessel = JAR_NOUNS.has(noun) ? "jar" : "bowl";
  if (new RegExp(`\\b${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(dish)) {
    return `${dish} ${vessel}`;
  }
  if (noun === "spice blend" || noun === "seasoning") return `${dish} ${noun}`;
  return `${dish} ${noun} ${vessel}`;
}

// ── the derivation ──────────────────────────────────────────────────────────

interface Bucket {
  /** The step indexes that assemble this component — ruling 5's identity. */
  stepIndexes: number[];
  noun: string | null;
  members: Set<string>;
  cookDay: Set<string>;
  /** Ruling 7 — a base that joins on cook day, so the bowl becomes "mix-ins". */
  lostBase: boolean;
}

/**
 * Resolve one dish's components.
 *
 * Returns the components AND the per-ingredient assignment. An ingredient absent
 * from `byIngredient` has no component and keeps today's per-ingredient step.
 */
export function resolveDishComponents(
  dishTitle: string,
  mealName: string | null,
  steps: ComponentStep[],
  ingredients: ComponentIngredient[],
): { components: ResolvedComponent[]; byIngredient: Map<string, ResolvedComponent> } {
  // H5.1 — a dish that IS the toppings forms no component. Checked first,
  // before any signal runs, because the cheapest way to get this wrong is to
  // build the bucket and then try to unpick it.
  //
  // 🔴 A SPECIFIC MIXTURE STILL WINS. "Pico de Gallo" and "Guacamole" are real
  // bowls whoever eats them, and a dish may be named for both ("Pico de Gallo
  // Toppings"), so the negative class only bites when the name offers no mixture
  // of its own. Without this arm the salsa and the guacamole would lose their
  // bowls the moment a recipe called them toppings.
  if (isServedSeparately(dishTitle)) {
    return { components: [], byIngredient: new Map() };
  }
  const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const byId = new Map(ingredients.map((i) => [i.ingredientId, i]));
  /** step group key → bucket. Ruling 5: the GROUP is the identity, the noun a label. */
  const buckets = new Map<string, Bucket>();

  const isProtein = (id: string) => byId.get(id)?.phase === "proteins";
  const isCookDayBase = (id: string) => {
    const ing = byId.get(id);
    return ing ? COOK_DAY_BASE.test(ing.ingredientName) : false;
  };
  const isService = (id: string) => {
    const ing = byId.get(id);
    if (!ing) return false;
    const blob = `${ing.ingredientName} ${ing.preparationNote ?? ""}`;
    // Ruling 4: "for the marinade" is an assignment, not a service form, even
    // though both live in the same note.
    if (NOTE_SAYS_MARINADE.test(blob)) return false;
    return SERVICE_FORM.test(blob);
  };

  /** Attach a noun to a bucket, keeping the more specific one (ruling 5). */
  const label = (b: Bucket, noun: string | null) => {
    if (noun === null) return;
    if (b.noun === null || specificity(noun) < specificity(b.noun)) b.noun = noun;
  };

  for (const st of ordered) {
    if (st.ingredientIds.length === 0) continue;
    // H7 — serve time builds no mixture. The step's text is still read as a
    // look-ahead LABEL by the step before it (the whisk step learns it makes a
    // "dressing" from here), it just contributes no members.
    if (isServeTimeStep(st, ordered)) continue;

    // Signal 1 — componentKey, but only when it names a MIXTURE (ruling 6).
    // H5.1 — the same test on the component's OWN name, for a dish whose title
    // says nothing: a `componentKey` of "toppings" or "garnish" is the author
    // telling us these are set out, not mixed.
    const keyText = st.componentKey ? st.componentKey.replace(/[-_]+/g, " ") : "";
    if (keyText !== "" && isServedSeparately(keyText)) continue;
    let noun: string | null = nounIn(keyText);
    // Signal 2 — the step's own prose.
    noun ??= nounIn(st.text);

    const isCombine = COMBINE_VERB.test(st.text);
    // ── THE LOOK-AHEAD RUNS EVEN WHEN THE STEP DID NAME SOMETHING ────────────
    //
    // Ruling 5 is why. "Whisk the vinegar, oil and honey into a SAUCE" followed
    // by "pour the DRESSING over the cucumbers" is one mixture with two labels,
    // and the second step carries no amounts at all — so it is skipped by the
    // `ingredientIds.length === 0` guard above and its label would never arrive.
    // Collecting both here and letting `label()` keep the more specific is what
    // gives the Sesame Cucumber Salad ONE jar instead of a sauce jar and a
    // dressing jar.
    let aheadNoun: string | null = null;
    if (isCombine) {
      const i = ordered.indexOf(st);
      for (const a of ordered.slice(i + 1, i + 3)) {
        aheadNoun = nounIn(a.text);
        if (aheadNoun !== null) break;
      }
    }
    if (noun !== null && aheadNoun !== null && specificity(aheadNoun) < specificity(noun)) {
      noun = aheadNoun;
    }
    if (noun === null && isCombine) {
      // ── LOOK AHEAD ONE OR TWO STEPS ────────────────────────────────────────
      // "In a bowl, whisk together ¼ cup orange juice, 3 tbsp lime juice, 4
      // garlic cloves…" names nothing; the NEXT step says "pour the MARINADE
      // over it". The step that MAKES a mixture routinely does not name it.
      // Without this the carne asada marinade splits into a nameless bowl
      // holding the mixture and a "marinade" holding nothing.
      noun = aheadNoun;
    }
    if (noun === null && !isCombine) continue; // no signal at all

    // Ruling 5 — the step GROUP is the key. A combine step and the step that
    // names its product are one group, so both fold into the same bucket.
    const key = noun ?? `step#${st.stepIndex}`;
    const b = buckets.get(key) ?? { stepIndexes: [], noun: null, members: new Set(), cookDay: new Set(), lostBase: false };
    b.stepIndexes.push(st.stepIndex);
    label(b, noun);
    for (const id of st.ingredientIds) {
      // Ruling 1 — a raw protein has a destination, not a seat.
      if (isProtein(id)) b.cookDay.add(id);
      // Ruling 7 — nor does a base that browns once cut.
      else if (isCookDayBase(id)) { b.cookDay.add(id); b.lostBase = true; }
      // Ruling 2 — a garnish or service form never enters a mixture.
      else if (!isService(id)) b.members.add(id);
    }
    buckets.set(key, b);
  }

  // ── SIGNAL 4 — the name, when the amount is on another step ────────────────
  //
  // The Pico de Gallo: step 0 dices (4 amountRefs, no component), step 1
  // combines "the tomatoes, onion, jalapeño" with no amounts at all, so its four
  // parts were uncovered while the lime alone got the bowl.
  //
  // RULING 2's GUARD, all three arms: the candidate step must be a COMBINE step,
  // the ingredient must not already be placed, and a garnish or service form is
  // excluded. The last arm is what takes the wedged limes out of the hot-sauce jar.
  const placed = new Set<string>();
  for (const b of buckets.values()) {
    for (const id of b.members) placed.add(id);
    for (const id of b.cookDay) placed.add(id);
  }
  const combineIdx = new Set(
    ordered
      .filter((s) => COMBINE_VERB.test(s.text) && !isServeTimeStep(s, ordered))
      .map((s) => s.stepIndex),
  );
  for (const ing of ingredients) {
    if (placed.has(ing.ingredientId)) continue;
    if (isProtein(ing.ingredientId) || isService(ing.ingredientId)) continue;
    if (isCookDayBase(ing.ingredientId)) continue; // ruling 7
    // Non-ASCII letters must survive: stripping to [a-z] turned "jalapeño" into
    // "jalape" and left the pico's chilli in a container of its own.
    const head = (norm(ing.ingredientName).split(/\s+/).pop() ?? "").replace(/[^\p{L}-]/gu, "");
    if (head.length < 4) continue; // "oil", "egg" — too short to match safely
    const re = new RegExp(`\\b${head.replace(/(?:es|s)$/, "")}(?:e?s)?\\b`, "i");
    for (const [, b] of buckets) {
      if (!b.stepIndexes.some((i) => combineIdx.has(i))) continue;
      const texts = b.stepIndexes.map((i) => ordered.find((s) => s.stepIndex === i)?.text ?? "");
      // 🔴 STRIP THE NAMES OF WHAT IS ALREADY IN THIS BUCKET before looking for the
      // head word. "combine … ½ teaspoon GARLIC POWDER, ½ teaspoon ONION POWDER …"
      // otherwise matches "garlic" and "yellow onion", and the taco's fresh
      // aromatics were pulled into a shelf-stable spice blend by the names of two
      // powders already in it. An occurrence the bucket's own members explain is not
      // evidence about a third food.
      const memberNames = [...b.members, ...b.cookDay]
        .map((id) => byId.get(id)?.ingredientName ?? "")
        .filter((n) => n.trim() !== "")
        .sort((x, y) => y.length - x.length);
      const scrub = (t: string): string => {
        let out = norm(t);
        for (const n of memberNames) {
          const needle = norm(n);
          if (needle.length < 3) continue;
          out = out.split(needle).join(" ");
        }
        return out;
      };
      if (texts.some((t) => re.test(scrub(t)))) { b.members.add(ing.ingredientId); break; }
    }
  }

  // ── H6.1 ruling 3 — A COMPONENT WHOSE OWN STEPS COOK IS NOT A PREP CONTAINER
  //
  // Dissolved here, where the bucket knows which steps built it. Its members fall
  // back to their ordinary per-ingredient handling: the produce among them still
  // gets knife work in the produce phase, and the dry and wet members leave the
  // session entirely, which is the right answer for a chile you are going to toast.
  for (const [k, b] of [...buckets]) {
    const texts = b.stepIndexes.map((i) => ordered.find((s) => s.stepIndex === i)?.text ?? "");
    if (!isCookingWork(texts)) continue;
    buckets.delete(k);
  }

  // ── ruling 3 — A MIXTURE HAS AT LEAST TWO MEMBERS ──────────────────────────
  //
  // A one-member "component" is a plain portion of its dish, and the name is
  // dropped with it: the Sesame Cucumber Salad's lone cucumber is not a
  // "dressing jar". A bucket whose only content is a cook-day protein also goes
  // — there is no bowl to put anything in.
  const kept = [...buckets.entries()].filter(([, b]) => b.members.size >= 2);

  const out: ResolvedComponent[] = [];
  const byIngredient = new Map<string, ResolvedComponent>();
  let ordinal = 0;
  for (const [key, b] of kept) {
    ordinal += 1;
    // Ruling 8 — a nameless mixture of dry seasonings and oil is a "seasoning
    // bowl" rather than "bowl 1".
    const looksLikeSeasoning = [...b.members].every((id) => {
      const ph = byId.get(id)?.phase;
      return ph === "seasonings_dry" || ph === "sauces_marinades";
    });
    // ── D-WS9-301 H2.2 — A CONTAINER HOLDING FRESH FOOD IS NOT A "SEASONING" ──
    //
    // Rule 2: "Dry only. Garlic, onion and fresh herbs never join a dry blend."
    // Rule 8: the name carries the use. The corpus shipped "Tex-Mex Seasoned
    // Ground Beef seasoning" holding six dry spices AND three minced garlic
    // cloves AND a diced yellow onion — a name that tells the cook it is a dry
    // blend, on a container that will not keep like one.
    //
    // The MEMBERSHIP is not wrong: those things do go into the pan together, and
    // H1 already moved the container out of the skippable dry phase and gave it
    // a fridge window. Only the noun lies. So where anything fresh is inside, a
    // dry noun is dropped and `useNounFor` supplies an honest one.
    const memberPhases = [...b.members].map((id) => byId.get(id)?.phase ?? null);
    const hasFresh = memberPhases.some((p) => p === "produce" || p === "proteins");
    const noun = hasFresh && b.noun !== null && DRY_NOUNS.has(norm(b.noun)) ? null : b.noun;
    const comp: ResolvedComponent = {
      key,
      noun,
      bowlName: bowlNameFor(
        dishTitle, mealName, noun, ordinal, looksLikeSeasoning && !hasFresh, b.lostBase,
        useNounFor([...b.members].map((id) => byId.get(id)?.phase ?? null)),
      ),
      memberIds: [...b.members],
      cookDayIds: [...b.cookDay],
      stepIndexes: [...b.stepIndexes],
    };
    out.push(comp);
    for (const id of b.members) byIngredient.set(id, comp);
  }
  return { components: out, byIngredient };
}

// ── D-WS9-299 — IS THIS STEP WORTH DOING AHEAD? ─────────────────────────────
//
// Hans: "measuring 1 thing (condiment, cooking oil, single spice), or even 2
// simple things that don't need to sit and mix together, isn't part of prep.
// what adds time to a weeknight … is measuring 6 things with different
// quantities for a mix and double checking your work, and then cleaning up a
// tsp tbsp 1/2 tsp, 2/3 cup, 1/4 cup measures because you had a lot to mix."
//
// So a prep step earns its place ONLY when it is one of:
//   (a) a MIXTURE of three or more measured items,
//   (b) TWO items that must SIT together — a marinade, a brine, a pickle, a soak,
//   (c) KNIFE WORK or WASHING — chop, dice, mince, slice, trim, zest, juice, husk.
//
// Never prep: a single condiment, oil, vinegar or spice measured alone; two
// simple things that just get added at the stove; anything poured straight from
// its container.
//
// This WIDENS D-WS7-150's skip rule, which only demoted season-and-cook. A
// demoted step is render-omitted exactly as today, and its dish's cook-day step
// handles the item.

/** Components that MUST sit together, so two members is enough (arm b). */
const MUST_SIT = new Set(["marinade", "brine", "pickle", "soak"]);

/** H7 — does a mixture with this noun have to SIT, so two members are enough? */
export const mustSit = (noun: string): boolean => MUST_SIT.has(noun);

/** Arm (c) — the verbs that are knife work or washing. */
const KNIFE_OR_WASH =
  /\b(chop|chopped|dice|diced|mince|minced|slice|sliced|trim|trimmed|zest|zested|juice|juiced|husk|husked|peel|peeled|shred|shredded|grate|grated|crush|crushed|halve|halved|quarter|quartered|cube|cubed|julienne|wash|washed|rinse|rinsed|clean|cleaned|pit|pitted|seed|seeded|tear|torn|snap|snapped|cut)\b/i;

export interface PrepWorthinessInput {
  /** How many measured items the step asks the cook to portion. */
  measuredItems: number;
  /** The component's noun, when the step is a mixture. */
  componentNoun: string | null;
  /** Every preparation note the step carries, for the knife-work test. */
  preparationNotes: string[];
  /** The step's own title/ingredient names, for the knife-work test. */
  text: string;
  /**
   * The engine phase. `proteins` is EXEMPT: portioning 1½ lb of ground beef into
   * a container is not "measuring one thing", it is handling raw flesh, and
   * D-WS9-298 has its own rules for when that step may exist at all. Without
   * this the judge demoted every unmarinated protein as a single item.
   */
  phase?: string | null;
}

export interface PrepWorthiness {
  worthDoingAhead: boolean;
  /** Which arm admitted it, or why it was refused — for the report and the logs. */
  reason: "mixture" | "must-sit" | "knife-work" | "single-item" | "two-simple-items";
}

export function judgePrepWorthiness(input: PrepWorthinessInput): PrepWorthiness {
  // Proteins are exempt — see `phase` on the input.
  if (input.phase === "proteins") return { worthDoingAhead: true, reason: "knife-work" };
  const notes = input.preparationNotes.join(" ");
  // (c) first: knife work earns its place at ANY count. One onion still has to
  // be diced, and dicing it on Sunday is the whole point of the feature.
  if (KNIFE_OR_WASH.test(notes) || KNIFE_OR_WASH.test(input.text)) {
    return { worthDoingAhead: true, reason: "knife-work" };
  }
  // (a) a real mix.
  if (input.measuredItems >= 3) return { worthDoingAhead: true, reason: "mixture" };
  // (b) two that must sit together.
  if (input.measuredItems >= 2 && input.componentNoun !== null && MUST_SIT.has(input.componentNoun)) {
    return { worthDoingAhead: true, reason: "must-sit" };
  }
  return {
    worthDoingAhead: false,
    reason: input.measuredItems <= 1 ? "single-item" : "two-simple-items",
  };
}

// ── D-WS9-301 rule 12 — THE WHOLE-PROTEIN KNIFE VERBS ───────────────────────
//
// "Phase 4 is every whole-protein knife-work verb the recipe text names: cube,
// trim, pound, butterfly, skin, cut strips, portion."
//
// The step used to read as a bare ingredient line — "Boneless skinless chicken
// breasts" — because the narrator was given the ingredient and nothing else.
// Measured over the 14-plan corpus: 25 of 31 protein components have a verb
// somewhere in their dish's prose and 15 have one in their own note, and none
// of it reached the card.
//
// ⚠️ THE PROSE WINS OVER THE NOTE (Hans's ruling 4). The note is the shopping
// form — "sliced very thin", "patted dry" — and the prose is what the cook step
// expects to find ready. Where the Buttermilk chicken's note says "sliced very
// thin" and its prose says pound and portion, the cook needs to pound.
const PROTEIN_VERBS: ReadonlyArray<[RegExp, string]> = [
  [/\bbutterfl(?:y|ied|ying)\b/i, "butterfly"],
  // 🔴 H7 — NOT THE UNIT. "Place the 2 pounds bone-in chicken thighs in a pot" and
  // "1½ pounds shrimp" read as the verb, and the plan said "Pound the shrimp". A
  // quantity in front of it (digits, a glyph, a word number) makes it a weight.
  [/(?<![\d½¼¾⅓⅔⅛⅜⅝⅞]\s?|\b(?:a|one|two|three|four|half a)\s)\bpound(?:s|ed|ing)?\b/i, "pound"],
  [/\bcub(?:e|es|ed|ing)\b/i, "cube"],
  [/\b(?:cut|slice)[^.]{0,30}\bstrips?\b/i, "cut into strips"],
  [/\b(?:skinned|remove the skin|skin removed)\b/i, "skin"],
  [/\btrim(?:s|med|ming)?\b/i, "trim"],
  [/\bportion(?:s|ed|ing)?\b/i, "portion"],
];

/**
 * Rule 12 — the verbs a protein step should name, most specific first.
 *
 * Returns at most two: a card that says "pound, portion and trim the chicken"
 * is a paragraph, not a step title. Empty when the recipe names none, and then
 * the narrator writes the step as it does today.
 */
export function proteinVerbsFor(note: string | null | undefined, prose: string): string[] {
  const fromProse = PROTEIN_VERBS.filter(([re]) => re.test(prose)).map(([, v]) => v);
  if (fromProse.length > 0) return fromProse.slice(0, 2);
  const fromNote = PROTEIN_VERBS.filter(([re]) => re.test(note ?? "")).map(([, v]) => v);
  return fromNote.slice(0, 2);
}
