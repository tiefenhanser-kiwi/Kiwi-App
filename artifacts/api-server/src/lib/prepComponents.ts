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

    // Signal 1 — componentKey, but only when it names a MIXTURE (ruling 6).
    let noun: string | null = st.componentKey ? nounIn(st.componentKey.replace(/[-_]+/g, " ")) : null;
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
  const combineIdx = new Set(ordered.filter((s) => COMBINE_VERB.test(s.text)).map((s) => s.stepIndex));
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
      if (texts.some((t) => re.test(t))) { b.members.add(ing.ingredientId); break; }
    }
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
    const comp: ResolvedComponent = {
      key,
      noun: b.noun,
      bowlName: bowlNameFor(
        dishTitle, mealName, b.noun, ordinal, looksLikeSeasoning, b.lostBase,
        useNounFor([...b.members].map((id) => byId.get(id)?.phase ?? null)),
      ),
      memberIds: [...b.members],
      cookDayIds: [...b.cookDay],
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
