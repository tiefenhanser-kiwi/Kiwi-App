// SERVER-12 A (BUG-626) — WHICH OF A DISH'S FOODS A COOK STEP'S WORDS NAME.
//
// A cook step links to the prep steps that did its work (prepWeekBuild
// assignCoversCookSteps). That link came only through the step's amountRefs, and a
// food the text names without an amount has none: "Finely dice the yellow onion and
// set aside" was linked to nothing, so ticking the onion folded nothing and showed no
// chip (INV-626). The step's words are now read too, with the app's own matching, so
// the server links exactly the foods Cook Mode's fold will ask about (CLIENT-6 B,
// cookSession doneInPrepStepKeys).
//
// 🔴 THIS IS A COPY OF THE CLIENT'S BLOCK, NOT AN IMPORT. Nothing in api-server/src
// imports across into artifacts/kiwi (the server's build tree is bundled separately;
// see prepQuantity.ts). The block below is artifacts/kiwi/lib/cooking/prepFoods.ts from
// PART through namedFoods, byte for byte, and prepFoods.test.ts reads the client file
// and fails on drift. If one changes, change both.

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
