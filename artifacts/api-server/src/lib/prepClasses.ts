// [prepcook] H7 — WHAT A CONTAINER MAY HOLD, AND WHAT IS PREP AT ALL.
//
// Pure, I/O-free, deterministic.
//
// ── THE RULING (Hans, October 2) ────────────────────────────────────────────
//
// "Don't combine seasonings, oil, liquid with protein or veggies until cook.
//  Veggies + veggies is ok if they go in the pan together."
//
// A prep container holds ONE class, never two:
//
//   A  seasonings + liquids — dry spices and dried herbs, salt, sugar, flour and
//      leaveners, condiments, oils, vinegars, wines, broths, sauces, citrus juice.
//      With each other, only at the same cooking moment.
//   B  vegetables — produce that is cut. With other vegetables only when they go
//      into the pan, pot or tray together.
//   C  protein — whole protein after its knife work. Stored alone, always.
//
// AROMATICS (garlic, ginger, shallot, fresh herbs, fresh chiles, citrus zest) join
// whichever class they ENTER with: sautéed with the onion → B; whisked into the
// lemon marinade → A. Never both in one container.
//
// ── WHERE THE CLASS COMES FROM ──────────────────────────────────────────────
//
// The engine's PHASE first, because the phase is already catalog-backed: category
// plus, since H7 2e, the purchase pack. A Pantry row is A whatever it is called. Only
// PRODUCE needs a further split, and there the name is the ingredient's own subject
// — "garlic" is garlic — which is the one place a name pattern is safe. The
// exclusions are written down anyway (powder, salt, ground, dried), because every
// defect in H6 was a pattern meeting a name it was not written for.

import type { PrepPhaseKey } from "./prepCombineEngine";
import { proseNames } from "./prepMoments";

export type PrepClass = "A" | "B" | "C" | "aromatic";

/**
 * Fresh aromatics, matched on a PRODUCE row's own name. A dried or ground form is
 * a Pantry row and never reaches this test.
 *
 * Whole citrus is here too: a lemon on a prep list is there to be zested or juiced,
 * and its juice and zest go wherever the lemon's portion goes.
 */
const AROMATIC_PRODUCE =
  /\b(garlic(?!\s+(?:powder|salt|granules))|ginger(?!\s+(?:powder|ground))|shallots?|lemongrass|cilantro|parsley|basil|mint|dill|thyme|rosemary|sage|chives|tarragon|oregano|jalape[nñ]os?|serranos?|fresnos?|habaneros?|(?:thai|bird'?s[- ]eye)\s+chil(?:i|e|ies|ies)|zest|lemons?|limes?|oranges?)\b/i;

/** A produce row that IS a liquid: squeezed juice is class A, like a vinegar. */
const JUICE = /\bjuice\b/i;

export function classOf(phase: PrepPhaseKey | null, ingredientName: string): PrepClass {
  if (phase === "proteins") return "C";
  if (phase === "seasonings_dry" || phase === "sauces_marinades") return "A";
  if (JUICE.test(ingredientName)) return "A";
  if (AROMATIC_PRODUCE.test(ingredientName)) return "aromatic";
  return "B";
}

/** An A member that is POURED rather than measured dry. */
export function isWetA(phase: PrepPhaseKey | null, ingredientName: string): boolean {
  if (phase === "sauces_marinades") return true;
  return phase === "produce" && JUICE.test(ingredientName);
}

// ── 2d — ONE STEP PER FOOD, CITRUS INCLUDED ────────────────────────────────────
//
// "lemon", "lemon juice" and "lemon zest" are three catalog rows joined by
// `component` edges (lemon → lemon juice : 3 tbsp), so the engine groups them as
// three foods and the plan zested a lemon in one step and juiced it in another. The
// edge is already on every derived group as `sourceYield.fromName`, so the food is
// the PARENT's name. "fresh lemon" and "lemon" are one fruit; the loader takes the
// alphabetically first parent, which is "fresh lemon", so the qualifier is dropped.
const FRESH = /^fresh\s+/i;

export function foodKeyOf(
  ingredientName: string,
  sourceYield: { fromName: string } | null | undefined,
): string {
  const base = sourceYield?.fromName ?? ingredientName;
  return base.trim().toLowerCase().replace(FRESH, "");
}

// ── 2c — THE CODE DECIDES WHAT IS PREP ─────────────────────────────────────────
//
// Hans's test: "If you can chop it and refrigerate it ahead, it's prep. If you can
// mix/blend it ahead and fridge or counter, it's prep."
//
// Prep is knife work and mixing without heat, when the result holds until its cook
// day. Not prep: heat; measuring one thing; a ready-to-use item; something that
// does not hold once cut.

/** Knife work, read from a PREPARATION NOTE — never from the ingredient name. */
const KNIFE_WORK =
  /\b(chop(?:ped)?|dic(?:e|ed)|minc(?:e|ed)|slic(?:e|ed)|trim(?:med)?|peel(?:ed)?|snap(?:ped)?|pound(?:ed)?|cub(?:e|ed)|zest(?:ed)?|juic(?:e|ed)|shred(?:ded)?|grat(?:e|ed)|crush(?:ed)?|halv(?:e|ed)|quarter(?:ed)?|julienne(?:d)?|spiraliz(?:e|ed)|husk(?:ed)?|seed(?:ed)?|stem(?:med)?|core[ds]?|pit(?:ted)?|tear|torn|strip(?:ped)?|cut|wedge[ds]?|florets?|ribbons?|matchsticks?|rings?|coins?|rounds?|pick(?:ed)?)\b/i;

/** The work a whole protein needs ahead (rule 12's verbs, plus pat dry). */
const PROTEIN_WORK =
  /\b(trim(?:med|ming)?|pound(?:ed|ing)?|cub(?:e|ed|ing)|butterfl(?:y|ied)|skin(?:ned)?|skin removed|cut|slic(?:e|ed)|portion(?:ed)?|pat(?:ted)?\b[^.;]{0,40}\bdry|halv(?:e|ed)|tenderiz(?:e|ed)|score[ds]?|deboned?)\b/i;

/** Heat in a note: the work is the stove's, not Sunday's. */
const HEAT_NOTE =
  /\b(toast(?:ed)?|roast(?:ed)?|brown(?:ed)?|cook(?:ed)?|saut[ée]+d?|grill(?:ed)?|char(?:red)?|fried|fry|boil(?:ed)?|simmer(?:ed)?|melt(?:ed)?|warm(?:ed)?|softened)\b/i;

/**
 * The cut is in the NAME: the thing is bought cut. "sliced black olives",
 * "shredded mozzarella", "pepperoni slices". Opening the package is not prep.
 */
const BOUGHT_CUT =
  /\b(sliced|shredded|diced|chopped|grated|crumbled|minced|slices|florets|spiralized|pre-?cut|matchstick)\b/i;

/** Foods that brown or go off once cut (the narrator's old category 4, now code's). */
const DOES_NOT_HOLD = /\b(avocados?|bananas?|apples?|potato(?:es)?|pears?)\b/i;

export type PortionVerdict =
  | { prep: true }
  | { prep: false; reason: "no-work" | "ready-to-use" | "heat" | "does-not-hold" };

/**
 * Is ONE produce portion prep work?
 *
 * `derived` is a juice or zest the catalog says comes from a whole fruit: getting it
 * IS the work (squeezing, zesting), so it needs no note to count.
 */
/**
 * Does a SENTENCE of the recipe that names this ingredient ask for this work?
 *
 * 🔴 SENTENCE-SCOPED AND NAME-ANCHORED. A whole-dish scan would let "trim the
 * chicken" make the green beans knife work; a sentence that does not name the
 * ingredient is no evidence about it. `proseNames` is the moment resolver's own
 * matcher, with its guard against "garlic" finding "garlic powder".
 */
export function proseAsksFor(texts: readonly string[], ingredientName: string, work: RegExp): boolean {
  for (const t of texts) {
    // 🔴 THE CLAUSE, not the sentence: "…in a large pot with the HALVED onion,
    // smashed garlic, parsley stems, 4 thyme sprigs" names the thyme in a sentence
    // whose knife word belongs to the onion. Split at commas, semicolons and "then".
    for (const clause of t.split(/[.;,!?]|\bthen\b/i)) {
      if (work.test(clause) && proseNames(clause, ingredientName)) return true;
    }
  }
  return false;
}

export function judgeProducePortion(
  ingredientName: string,
  note: string | null | undefined,
  derived: boolean,
  /** The dish's own step texts — the knife work is sometimes only written there. */
  prose: readonly string[] = [],
): PortionVerdict {
  const n = (note ?? "").trim();
  const knife = KNIFE_WORK.test(n) || (n === "" && proseAsksFor(prose, ingredientName, KNIFE_WORK));
  if (DOES_NOT_HOLD.test(ingredientName) && (knife || n === "")) {
    return { prep: false, reason: "does-not-hold" };
  }
  if (knife) return { prep: true };
  // Getting a juice or a zest IS the work. Other derived rows are not: "fresh thyme
  // sprigs" is a catalog component of fresh thyme, and dropping four whole sprigs
  // into a pot is nothing to do on Sunday.
  if (derived && /\b(juice|zest)\b/i.test(ingredientName)) return { prep: true };
  if (HEAT_NOTE.test(n)) return { prep: false, reason: "heat" };
  if (BOUGHT_CUT.test(ingredientName)) return { prep: false, reason: "ready-to-use" };
  return { prep: false, reason: "no-work" };
}

/**
 * Is a whole-protein step prep? Only when the recipe asks for knife work on it —
 * the verbs rule 12 already extracts, or one in its own note. "Brown the Italian
 * sausage" is cooking: there is nothing to do to the sausage before the pan.
 */
export function judgeProteinWork(
  knifeVerbs: readonly string[],
  notes: readonly string[],
  /** The dish's step texts and the protein's own name, for "Pat the pork chops dry". */
  prose: readonly string[] = [],
  ingredientName = "",
): boolean {
  if (knifeVerbs.length > 0) return true;
  if (notes.some((n) => PROTEIN_WORK.test(n))) return true;
  return ingredientName !== "" && proseAsksFor(prose, ingredientName, PROTEIN_WORK);
}

/** The noun a cut gives a lone container: "diced jalapeño", "trimmed green beans". */
const CUT_WORDS = [
  "finely diced", "finely chopped", "thinly sliced", "minced", "diced", "chopped", "sliced",
  "shredded", "grated", "julienned", "spiralized", "halved", "quartered", "cubed", "snapped",
  "trimmed", "peeled", "husked", "seeded", "stripped", "zested", "juiced", "torn", "crushed",
];

export function cutOf(notes: readonly string[]): string | null {
  const blob = notes.join(" ").toLowerCase();
  for (const cut of CUT_WORDS) if (blob.includes(cut)) return cut;
  return null;
}
