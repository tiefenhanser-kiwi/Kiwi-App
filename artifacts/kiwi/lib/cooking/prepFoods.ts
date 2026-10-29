// CLIENT-6 B (BUG-584 / D-WS9-350 phase 1) — WHICH FOODS A COOK STEP WORKS ON, AND
// WHETHER THE TICKED PREP STEPS COVERING IT DID THEM.
//
// The "Done in prep" fold hides a whole cook step. QA-NIGHT-1: "Finely dice the
// yellow onion and mince the 2 garlic cloves" listed only the garlic step in its
// covering steps (coversCookSteps), so ticking garlic folded the step and the onion
// was never diced. A prep step's coversCookSteps says it did SOME of a step's work,
// not all of it.
//
// What the client has to tell "every food" (measured on the night run's payloads):
//   • preppedRefs — the server's chips. Containers, not foods, and absent on most
//     covered steps (none of the night run's folded steps carried one).
//   • amountRefs — a step's ingredient ids, but only where the text states an amount
//     ("the 4 garlic cloves"; "the yellow onion" has none), and the ids are the
//     dish's rows, which the prep step's key does not always use (the week folds
//     garlic spellings to one id).
//   • the prose — the dish's own ingredient names, found in the step's words, and
//     the covering prep steps' own words: the title ("Mince all garlic") and each
//     instruction line's work, cut before where it goes ("for the …", "into the …",
//     " — …"), because those clauses name destination dishes and containers
//     ("for the Creamy Beef and Mushroom Stroganoff"), not the food cut.
// So the rule reads the prose. It errs one way only: a name it cannot place keeps
// the step in full.

/** Words that name a part of a food, not the food: "garlic cloves" is garlic. */
const PART = new Set(["clove", "stalk", "rib", "sprig", "leaf", "floret", "head", "bunch", "piece", "flake", "wedge", "strip"]);

/**
 * Heads too common to stand alone: "black pepper" is not "bell pepper", a yellow
 * onion is not a green one. Covered only when the prep step says the word before
 * the head as well.
 */
const AMBIGUOUS = new Set([
  "pepper", "oil", "sauce", "cheese", "juice", "powder", "salt", "mix", "spice", "seasoning", "onion", "potato",
  "tomato", "bean", "squash", "chile", "chili", "pea", "vinegar", "stock", "broth", "sugar", "flour", "milk",
  "cream", "paste", "seed", "green", "lettuce", "cabbage", "rice", "sausage", "zest",
]);

function singular(w: string): string {
  if (w === "leaves") return "leaf";
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(ches|shes|oes|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Lower-case, unaccented, singular words. */
export function foodWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0)
    .map(singular);
}

export interface Food {
  /** The ingredient as the dish names it. */
  name: string;
  head: string;
  /** The word before the head, when the head is ambiguous ("yellow" onion). */
  before: string | null;
}

/** "fresh ginger" → ginger; "garlic cloves" → garlic; "ground beef (85% lean)" → beef. */
export function foodOf(name: string): Food | null {
  const words = foodWords(name.replace(/\([^)]*\)/g, " ").split(",")[0]);
  while (words.length > 1 && PART.has(words[words.length - 1])) words.pop();
  const head = words[words.length - 1];
  if (!head || head.length < 3) return null;
  return { name, head, before: AMBIGUOUS.has(head) ? (words[words.length - 2] ?? null) : null };
}

const has = (words: readonly string[], w: string) => words.includes(w);
const hasPair = (words: readonly string[], a: string, b: string) =>
  words.some((w, i) => w === a && words[i + 1] === b);

/**
 * The dish's foods a cook step's words name: by head, loose, so a step names more,
 * never less. One exception keeps it honest: "sesame oil" in the words is the
 * dish's sesame oil, not also its vegetable oil. An ambiguous head right after
 * ANOTHER ingredient's own word before it belongs to that ingredient; a bare
 * "the oil" still names every oil.
 */
export function namedFoods(text: string, ingredientNames: readonly string[]): Food[] {
  const words = foodWords(text);
  const foods = ingredientNames.map(foodOf).filter((f): f is Food => f !== null);
  const out: Food[] = [];
  for (const f of foods) {
    if (out.some((o) => o.head === f.head && o.before === f.before)) continue;
    const named = words.some((w, i) => {
      if (w !== f.head) return false;
      if (f.before === null || words[i - 1] === f.before) return true;
      return !foods.some((o) => o.head === f.head && o.before !== null && o.before !== f.before && words[i - 1] === o.before);
    });
    if (named) out.push(f);
  }
  return out;
}

/** A prep step's own work, without the clauses that say where it goes. */
export function prepWorkWords(step: { title: string; instructions?: string }): string[] {
  const lines = [step.title, ...(step.instructions ?? "").split(/\n|\s+\/\s+/)];
  return lines.flatMap((line) => {
    if (/^\s*into\b/i.test(line)) return [];
    const work = line.split(/\s+(?:for the|for your|into the|into a|into an|into|to the)\s+|\s+[—–-]\s+|:/i)[0];
    return foodWords(work);
  });
}

/** Whether these prep steps' own words say the food. */
export function prepCovers(words: readonly string[], food: Food): boolean {
  if (!has(words, food.head)) return false;
  return food.before === null || hasPair(words, food.before, food.head);
}
