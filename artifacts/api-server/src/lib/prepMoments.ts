// WS9 BUG-346 / D-WS9-301 rule 1 — THE MOMENT AN INGREDIENT ENTERS.
//
// Pure, I/O-free, deterministic.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// D-WS9-296 grouped a container per COMPONENT — one bowl per sub-recipe. Hans's
// re-cut (D-WS9-301 rule 1): "a container is the set of ingredients that enter
// the cooking process at the SAME MOMENT… the key piece there is making sure the
// containers are supposed to be combined or separated at cook time." Slow-cooker
// herbs, onion and chicken go in together, so one container is right. Taco onion
// is sautéed first and the spices go in after browning, so those are two.
//
// ── 🔴 WHAT `amountRefs` ACTUALLY ANSWERS, WHICH IS NOT THE QUESTION ─────────
//
// H0 measured this before any of it was built. `amountRefs` marks where an
// amount is STATED, which for the catalog is the mise-en-place step — not where
// the ingredient ENTERS. The taco dish, verbatim from the sample plan:
//
//   s0 prep   garlic                      ← amount stated here
//   s1 prep   [seasoning] chili powder · cumin · paprika · oregano · …
//   s4 cook   "Add the minced garlic and cook, stirring constantly, …"   ← no ref
//   s5 cook   "Add the 1½ pounds ground beef, breaking it up …"         ← no ref
//   s7 cook   [seasoning] tomato paste
//
// Both are stated on prep steps, so by `amountRefs` alone they are the same
// moment — yet they must be two containers. Coverage of the honest signal (an
// ingredient NAMED in a cook/assemble step's prose) is only 43%, so it cannot
// be the key. It is the override below: used where it exists, because where it
// exists it is the most reliable thing we have.
//
// So three signals, in this precedence:
//
//   1. COMPONENT — the authored sub-recipe tag. Wins outright where present: a
//      marinade built across steps 1, 2 and 3 is one container, which is the
//      case rule 1 names as its inverse ("the lemon-herb marinade… is ONE
//      container finished in ONE step").
//   2. PROSE IN A COOK STEP (Hans's override) — the exact step becomes the
//      moment, so "sauté the onion" (s4) and "add the cumin" (s7) separate even
//      though both are heat.
//   3. THE RUN PROXY — a run of consecutive non-`cook` steps is one moment; a
//      `cook` step closes it. This does the bulk of the merging: without it the
//      corpus lands at 13–40 containers per plan instead of 7–28.
//
// ⚠️ A DISH WITH NO `amountRefs` AT ALL HAS NO MOMENTS, AND INVENTS NONE. 23 of
// the 148 corpus dishes are in that state. `hasCoverage: false` says so, each
// ingredient stands alone, and rules 2 / 3 / 5 are the only grouping it gets.
// Reporting that is the point; a 0%-covered dish must not behave like a
// 100%-covered one just because the code has no way to tell.

import type { ComponentStep, ComponentIngredient } from "./prepComponents";

/** The heat marker. Everything else continues the current moment. */
const HEAT_PHASE = "cook";
/** Phases whose prose may carry Hans's override — where food meets the pan. */
const ENTRY_PHASES = new Set(["cook", "assemble"]);

// ── [prepcook] H7 — ONLY A COOKING MOMENT GROUPS ────────────────────────────
//
// Hans, October 2: "Don't combine seasonings, oil, liquid with protein or veggies
// until cook. Veggies + veggies is ok if they go in the pan together."
//
// H6.1 ruling 3 made "a cook or assemble step that names it" the moment, and an
// ASSEMBLE step is very often serve time: "toss the romaine with the dressing",
// "top the tacos with lettuce and tomato", "dress the tomato and cucumber". Those
// steps combine things at the table, and grouping on them is how the romaine
// reached the Caesar dressing jar and the taco lettuce reached the beef.
//
// So a step that names an ingredient is a GROUPING moment only when food goes into
// HEAT there: a `cook` step, or an assembly that a later `cook` step bakes (pizza
// toppings onto the dough, enchiladas into the dish). An assembly with no heat
// after it is serve time; its key is `v:` and, like `i:`, it groups nothing.
/** A `cook` step that opens with one of these is plating, not cooking. */
const SERVE_LEAD = /^\s*(?:to serve,?\s*)?(?:serve|garnish|plate)\b/i;

/**
 * H7 — a NON-cook step that puts food into the vessel that is about to be heated.
 * The tomatillo sauce's step 1 is tagged `prep` — "husk and halve the tomatillos,
 * halve the poblano… spread everything on the baking sheet" — and step 2 broils
 * it. The tray goes into the oven as one; the tag alone cannot see that. Only a
 * HEAT vessel counts: a mixing bowl is not one.
 */
const PLACES_IN_HEAT_VESSEL =
  /\b(?:on(?:to)?|in(?:to)?)\s+(?:a|the)\s+(?:large\s+|prepared\s+|rimmed\s+|foil-lined\s+|lined\s+)*(?:baking\s+sheet|sheet\s+pan|roasting\s+pan|broiler\s+pan|baking\s+dish|casserole|slow\s+cooker|dutch\s+oven|stockpot|pot|skillet|wok|air\s+fryer)\b/i;

/**
 * Is this step a moment where things go INTO HEAT together? Exported so the
 * component resolver asks the same question of the same steps.
 */
export function isHeatMoment(step: ComponentStep, ordered: readonly ComponentStep[]): boolean {
  if (step.phaseType === HEAT_PHASE) return !SERVE_LEAD.test(step.text);
  return ordered.some((s) => s.stepIndex > step.stepIndex && s.phaseType === HEAT_PHASE);
}

/**
 * Words that are never the identity of an ingredient, so they must not be
 * required when matching its name in prose.
 */
const NAME_NOISE = new Set([
  "fresh", "dried", "ground", "whole", "large", "small", "medium", "boneless",
  "skinless", "low-sodium", "lowsodium", "extra-virgin", "extra", "virgin",
  "unsalted", "kosher", "freshly", "finely", "thinly", "cold", "ripe", "baby",
  "sharp", "shredded", "grated", "sliced", "diced", "minced", "crushed", "cut",
  "lean", "thick-cut", "flat-leaf", "leaf", "plus", "more", "for", "of", "and",
  "or", "the", "a", "an", "to", "in", "into", "about", "optional", "divided",
  "stemmed", "seeded", "peeled", "halved", "chopped", "torn", "packed",
  // 🔴 VARIETAL MODIFIERS, which recipe prose routinely drops. The catalog says
  // "yellow onion" and step 4 says "add the diced onion" — requiring every word
  // made the match fail on the colour and the override never fired for the one
  // case the ruling is named after. The single-word guard below is what stops
  // "onion" then matching "onion powder".
  "yellow", "white", "red", "green", "purple", "sweet", "russet",
  // 🔴 H7 — THE PART OF THE PLANT, which recipe prose drops just as it drops the
  // colour. The catalog says "celery stalks" and "garlic cloves"; the slow cooker's
  // step says "scatter the onion, celery, carrots, and garlic". Requiring "stalks"
  // and "cloves" kept both out of the cook step that names them, and the slow
  // cooker's vegetables fell apart into single tubs. The single-word guard still
  // stops "garlic" matching "garlic powder".
  "stalk", "stalks", "clove", "cloves", "sprig", "sprigs", "leaves", "florets",
  "hearts", "spears",
  // …and the generic noun after a variety: "halve and seed the poblano" names the
  // poblano pepper. A name that is ONLY "pepper" keeps nothing and matches nothing.
  "pepper", "peppers",
]);

/**
 * H7 — the stem a word is searched by, so "carrots" finds "the grated carrot" and
 * "tomatoes" finds "tomato". Only a plain plural is stripped, and only from a word
 * long enough that the stem is still that word.
 */
function stemOf(w: string): string {
  if (w.length > 5 && w.endsWith("oes")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/**
 * 🔴 A HEAD WORD IS NOT A SUFFIX-FREE MATCH. "onion" is in "onion powder" and
 * "garlic" is in "garlic powder" — the same trap that sent a jar of dry spices
 * to the 4-day fridge class in B3 · d. A single-word ingredient must not match
 * prose where that word is followed by a modifier that names a DIFFERENT
 * ingredient.
 */
const DIFFERENT_INGREDIENT_AFTER = /^\s*(?:powder|salt|granules|flakes|seed|seeds|paste|sauce|oil|extract|juice|zest|stock|broth)\b/i;

/** The identifying words of a catalog ingredient name. */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NAME_NOISE.has(w));
}

/** Does `prose` name this ingredient, and not a different one that contains it? */
export function proseNames(prose: string, name: string): boolean {
  const words = nameWords(name);
  if (words.length === 0) return false;
  const lower = prose.toLowerCase();
  for (const w of words) {
    const stem = stemOf(w);
    const at = lower.indexOf(stem);
    if (at < 0) return false;
    // Only the LAST identifying word can be followed by a modifier that turns it
    // into something else ("onion powder"); an earlier one is fine ("chili
    // powder" legitimately contains "chili" when the ingredient IS chili powder,
    // which is why the whole word list has to match, not just one).
    // H7 — read past the plural ending the stem dropped, so "onions powder" is
    // never the question and "garlic, powder" is.
    const tail = lower.slice(at + stem.length).replace(/^(?:e?s)\b/, "");
    if (words.length === 1 && DIFFERENT_INGREDIENT_AFTER.test(tail)) {
      return false;
    }
  }
  return true;
}

export interface MomentOverride {
  ingredientName: string;
  /** The cook step whose prose named it. */
  stepIndex: number;
  /** The run-proxy moment it would otherwise have had. */
  wasRunMoment: number | null;
  prose: string;
}

export interface MomentResolution {
  /** ingredientId → the container key WITHIN this dish. */
  keyByIngredientId: Map<string, string>;
  /**
   * ingredientId → the run its amount is stated in. Present only for
   * ingredients some step references. The caller uses it to let a RESOLVED
   * component absorb what shares its run — see the note above `runByIngredientId`
   * for why that join cannot live here.
   */
  runByIngredientId: Map<string, number>;
  /** False when no step of this dish carries a single amountRef. */
  hasCoverage: boolean;
  /** Hans's override — reported so its 43% can be audited, not assumed. */
  overrides: MomentOverride[];
}

/**
 * D-WS9-301 rule 1 — the per-dish container key for every ingredient.
 *
 * The key is opaque and dish-local; callers compare it, never parse it.
 */
export function resolveMoments(
  steps: ComponentStep[],
  ingredients: ComponentIngredient[],
): MomentResolution {
  const ordered = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);
  const hasCoverage = ordered.some((s) => s.ingredientIds.length > 0);

  // ── the run proxy ─────────────────────────────────────────────────────────
  // A `cook` step CLOSES the current run; the next non-cook step opens a new
  // one. The closing step's own amounts belong to the run it ends, which is the
  // slow-cooker case: the aromatics, the chicken and the liquids are one dump.
  const runOfStep = new Map<number, number>();
  let run = 0;
  let lastWasHeat = false;
  for (const s of ordered) {
    const heat = s.phaseType === HEAT_PHASE;
    if (!heat && lastWasHeat) run++;
    runOfStep.set(s.stepIndex, run);
    lastWasHeat = heat;
  }

  // ── signal 1: the component, and the first step that states each amount ───
  const firstRefStep = new Map<string, number>();
  const componentOf = new Map<string, string | null>();
  for (const s of ordered) {
    for (const id of s.ingredientIds) {
      if (firstRefStep.has(id)) continue;
      firstRefStep.set(id, s.stepIndex);
      componentOf.set(id, s.componentKey);
    }
  }

  // ── signal 2: Hans's override — the cook step whose prose names it ────────
  const nameById = new Map(ingredients.map((i) => [i.ingredientId, i.ingredientName]));
  const entryStep = new Map<string, number>();
  /** H7 — ingredients whose first naming step is serve time (no heat). */
  const serveStep = new Map<string, number>();
  const overrides: MomentOverride[] = [];
  for (const ing of ingredients) {
    // A component's members are one container by ruling; the override exists to
    // split ingredients the author never grouped, so it does not reach inside
    // one. Checked here rather than at the key so the report counts honestly.
    if (componentOf.get(ing.ingredientId)) continue;
    const named = ordered.find(
      (s) =>
        (ENTRY_PHASES.has(s.phaseType) ||
          (PLACES_IN_HEAT_VESSEL.test(s.text) && isHeatMoment(s, ordered))) &&
        proseNames(s.text, ing.ingredientName),
    );
    if (!named) continue;
    const wasRun = firstRefStep.has(ing.ingredientId)
      ? runOfStep.get(firstRefStep.get(ing.ingredientId)!) ?? null
      : null;
    // ── H6.1 ruling 3 — THE COOK STEP IS THE MOMENT, NOT A GAP-FILLER ───────
    //
    // H1 scoped this override to ingredients with no run at all, on the argument
    // that "a later cook step wins" would split the slow-cooker container: its
    // dried thyme and rosemary are named in "Pour in the broth and add the dried
    // thyme and rosemary" while its celery and carrots are measured at step 0, and
    // Hans ruled that container right.
    //
    // 🔴 THAT COUNTER-EXAMPLE NO LONGER BITES, and the guard above is why: the
    // slow cooker's herbs carry an authored componentKey, and an ingredient inside
    // a component never reaches this loop. What H1 could not separate — a tagged
    // mixture from an untagged neighbour — ruling 3 separates by authority: the
    // tag owns its own steps, the prose owns everything else, the run proxy owns
    // what is left.
    //
    // The measured cost of the narrowing was 412 of 545 overrides overruled by a
    // proxy, and both of H6.0's defects: the taco garlic minced into a
    // shelf-stable spice bowl ("Add the minced garlic", step 4, refused) and the
    // chili's masa pre-mixed with the cumin ("Whisk the masa harina with ¼ cup
    // cold water", step 8, refused).
    //
    // `ordered.find` takes the EARLIEST entry-phase step that names it, so the
    // moment is where the food first enters the dish — not where it is cut, which
    // is its phase's business, and not a later mention of the same thing.
    //
    // `wasRunMoment` is still reported, so an audit can see what the proxy would
    // have said and how often the two disagree.
    // H7 — and the step has to be a COOKING moment to be one at all. Serve time
    // is recorded separately so the key below can say "named, and groups nothing"
    // rather than falling back to the run proxy, which is what let the romaine
    // ride the dressing's run into its jar.
    if (!isHeatMoment(named, ordered)) {
      serveStep.set(ing.ingredientId, named.stepIndex);
      continue;
    }
    entryStep.set(ing.ingredientId, named.stepIndex);
    overrides.push({
      ingredientName: ing.ingredientName,
      stepIndex: named.stepIndex,
      wasRunMoment: wasRun,
      prose: named.text.slice(0, 90),
    });
  }

  // ── signal 1b: a component OCCUPIES its run, and absorbs what shares it ───
  //
  // 🔴 THE RULE'S OWN INVERSE CASE, WHICH THE COMPONENT TAG ALONE GETS WRONG.
  // Rule 1: "The lemon-herb marinade… all its parts enter together (into the
  // marinade), so it is ONE container finished in ONE step — zest and juice the
  // lemon inside that step, never deferred to the produce phase."
  //
  // The sample plan did exactly what the rule forbids. Its marinade steps (2, 3)
  // carry `componentKey = marinade`; the LEMON's amount is stated on step 1,
  // which carries no component tag at all. Keyed on the tag alone the lemon is a
  // separate container, and the shipped prose read: "Note: the lemon zest and
  // juice for this marinade are handled in the lemon prep step — add them to
  // this bowl once prepped." Two containers and a cross-reference, for one bowl.
  //
  // So the component supplies the NAME and the moment decides MEMBERSHIP: an
  // ingredient whose amount is stated in the same run as a component joins that
  // component. Where a run holds two components the first by step order wins —
  // arbitrary, but a stated tie-break beats an accidental one.
  //
  // ⚠️ PROTEINS NEVER JOIN (D-WS9-296 ruling 1). Raw flesh has a destination,
  // not a seat: the steak meets the marinade on cook day.
  // ⚠️ THE ABSORPTION ITSELF IS THE ADAPTER'S, NOT THIS MODULE'S. A step's raw
  // `componentKey` tag is not the same identity as a RESOLVED component
  // (prepComponents has four signals and a name-match look-ahead, so a member
  // can belong to a mixture whose tag never appears on its own step). Keying on
  // the raw tag here would split exactly the members the richer resolution had
  // just joined. This module therefore exposes the RUN each ingredient sits in
  // and leaves the join to the caller, which holds the resolved components.
  const runByIngredientId = new Map<string, number>();
  for (const [id, step] of firstRefStep) runByIngredientId.set(id, runOfStep.get(step)!);

  // ── the key ───────────────────────────────────────────────────────────────
  const keyByIngredientId = new Map<string, string>();
  for (const ing of ingredients) {
    const entry = entryStep.get(ing.ingredientId);
    if (entry !== undefined) {
      // The exact step, not its run: two cook steps are two moments, which is
      // the whole point of the override ("sauté the onion" then "add the cumin").
      keyByIngredientId.set(ing.ingredientId, `s:${entry}`);
      continue;
    }
    const served = serveStep.get(ing.ingredientId);
    if (served !== undefined) {
      keyByIngredientId.set(ing.ingredientId, `v:${served}`);
      continue;
    }
    const ref = firstRefStep.get(ing.ingredientId);
    if (ref !== undefined) {
      keyByIngredientId.set(ing.ingredientId, `r:${runOfStep.get(ref)}`);
      continue;
    }
    // No signal at all. It stands alone, and nothing is invented for it.
    keyByIngredientId.set(ing.ingredientId, `i:${ing.ingredientId}`);
  }

  return { keyByIngredientId, runByIngredientId, hasCoverage, overrides };
}

/**
 * True when a moment key groups nothing: "no signal, stands alone" (`i:`) or, H7,
 * "named only at serve time" (`v:`).
 */
export const isLoneKey = (key: string) => key.startsWith("i:") || key.startsWith("v:");
