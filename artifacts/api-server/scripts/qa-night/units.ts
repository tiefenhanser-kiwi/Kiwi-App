// QA-NIGHT-1 — quantities and units for the reconcilers.
//
// Deliberately SMALL and conservative: a reconciler compares two amounts only
// when both convert into the same family (volume, weight, count of one noun).
// Anything else is "not comparable" and counted as such — never guessed. A
// reconciler that guesses a conversion reports its own guess as a defect.

export type Family = "volume" | "weight" | "count";

/** Base unit per family: ml, g, and "each". */
const VOLUME: Record<string, number> = {
  tsp: 4.92892, teaspoon: 4.92892, teaspoons: 4.92892,
  tbsp: 14.7868, tablespoon: 14.7868, tablespoons: 14.7868, tbs: 14.7868, tbl: 14.7868,
  cup: 236.588, cups: 236.588,
  "fl oz": 29.5735, "fluid ounce": 29.5735, "fluid ounces": 29.5735, floz: 29.5735,
  pint: 473.176, pints: 473.176, pt: 473.176,
  quart: 946.353, quarts: 946.353, qt: 946.353,
  gallon: 3785.41, gallons: 3785.41, gal: 3785.41,
  ml: 1, milliliter: 1, milliliters: 1, l: 1000, liter: 1000, liters: 1000,
};
const WEIGHT: Record<string, number> = {
  g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
  lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
};
/** Count words that mean "one of the thing" — compared only to each other. */
const COUNT = new Set([
  "", "each", "ea", "whole", "piece", "pieces", "pc", "pcs", "item", "items",
  "clove", "cloves", "large", "medium", "small", "can", "cans", "bunch", "bunches",
  "head", "heads", "stalk", "stalks", "sprig", "sprigs", "slice", "slices",
  "package", "packages", "pkg", "jar", "jars", "bag", "bags", "box", "boxes",
  "ear", "ears", "fillet", "fillets", "breast", "breasts", "thigh", "thighs",
  "leaf", "leaves", "stick", "sticks", "loaf", "loaves", "bottle", "bottles",
]);

export function normUnit(u: string | null | undefined): string {
  return (u ?? "").trim().toLowerCase().replace(/\.$/, "").replace(/\s+/g, " ");
}

export function familyOf(unit: string): Family | null {
  const u = normUnit(unit);
  if (u in VOLUME) return "volume";
  if (u in WEIGHT) return "weight";
  if (COUNT.has(u)) return "count";
  return null;
}

/** The amount in its family's base unit, or null when the unit is unknown. */
export function toBase(qty: number, unit: string): { family: Family; value: number; countUnit?: string } | null {
  const u = normUnit(unit);
  if (u in VOLUME) return { family: "volume", value: qty * VOLUME[u] };
  if (u in WEIGHT) return { family: "weight", value: qty * WEIGHT[u] };
  if (COUNT.has(u)) {
    // Count units only compare within the same noun: 2 cans ≠ 2 cloves. The
    // size words (large/medium/small) and "each"/"" all mean one of the food.
    const generic = ["", "each", "ea", "whole", "piece", "pieces", "pc", "pcs", "item", "items", "large", "medium", "small", "clove", "cloves"];
    const countUnit = generic.includes(u) ? "each" : u.replace(/(es|s)$/, "");
    return { family: "count", value: qty, countUnit };
  }
  return null;
}

/** Two amounts in one unit, or null when they are not comparable. */
export function comparable(
  a: { qty: number; unit: string },
  b: { qty: number; unit: string },
): { a: number; b: number; unit: string } | null {
  const x = toBase(a.qty, a.unit);
  const y = toBase(b.qty, b.unit);
  if (!x || !y || x.family !== y.family) return null;
  if (x.family === "count" && x.countUnit !== y.countUnit) return null;
  const unit = x.family === "volume" ? "ml" : x.family === "weight" ? "g" : x.countUnit!;
  return { a: x.value, b: y.value, unit };
}

const GLYPHS: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };

/** "1½", "1 1/2", "3/4", "2.5", "½" → number; null when it is not a number. */
export function parseQty(s: string): number | null {
  const t = s.trim();
  let m = /^(\d+)\s*([¼½¾⅓⅔⅛⅜⅝⅞])$/.exec(t);
  if (m) return Number(m[1]) + GLYPHS[m[2]];
  if (t in GLYPHS) return GLYPHS[t];
  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = /^(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[1]) / Number(m[2]);
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return null;
}

/** Lower-cased, parentheticals and commas' tails dropped, plural trimmed: "Garlic cloves, minced" → "garlic clove". */
export function normName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // "jalapeño" → "jalapeno", not "jalape os"
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/,.*$/, "")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w.replace(/oes$/, "o")))
    .join(" ");
}

const DESCRIPTORS = new Set([
  "fresh", "freshly", "dried", "ground", "chopped", "minced", "diced", "sliced", "large", "small", "medium",
  "boneless", "skinless", "extra", "virgin", "kosher", "unsalted", "salted", "low", "sodium", "whole", "raw",
  "cooked", "frozen", "canned", "finely", "roughly", "grated", "shredded", "packed", "light", "dark", "plain",
  "lean", "fat", "free", "organic", "ripe", "peeled", "crushed", "toasted", "softened", "melted", "cold", "warm",
  "hot", "room", "temperature", "baby", "of", "and", "or", "for", "to", "the", "a", "an", "into", "cut", "inch",
]);

/** The words that identify a food, without size and prep words: "fresh flat-leaf parsley" → ["flat-leaf", "parsley"]. */
/**
 * The part of a plant a recipe names, where the list buys the plant: "thyme
 * leaves" → thyme, "garlic cloves" → garlic, "lemon juice" → lemon (the grocery
 * relation folds buy the whole food). Stripped only from the END, and only when
 * a food word remains.
 */
const FORMS = new Set(["leave", "leaf", "clove", "sprig", "stalk", "rib", "head", "bulb", "juice", "zest", "wedge", "floret", "stem", "kernel", "segment", "yolk", "white"]);

/** One name per food where the catalog uses two: the list buys "parmesan" for "Parmigiano-Reggiano". */
const SYNONYMS: Record<string, string> = { parmigiano: "parmesan", "parmigiano-reggiano": "parmesan", reggiano: "parmesan" };

export function foodWords(name: string): string[] {
  const w = normName(name).split(" ").filter((x) => x && !DESCRIPTORS.has(x)).map((x) => SYNONYMS[x] ?? x);
  for (let i = w.length - 1; i > 0; i--) if (w[i] === w[i - 1]) w.splice(i, 1); // "parmigiano reggiano" → "parmesan"
  while (w.length > 1 && FORMS.has(w[w.length - 1])) w.pop();
  return w;
}

/** One key per food: "Garlic cloves, minced" and "minced garlic" are both "garlic". */
export function foodKey(name: string): string {
  return foodWords(name).join(" ");
}

/** The food's head noun (its last identifying word): "chicken thigh" → "thigh". */
export function headNoun(name: string): string | null {
  const w = foodWords(name);
  return w.length ? w[w.length - 1] : null;
}

// "sugar", "flour", "milk" are foods on their own (the list's "sugar" is the recipe's "granulated sugar").
const GENERIC_HEADS = new Set(["sauce", "oil", "cheese", "pepper", "powder", "vinegar", "juice", "broth", "stock", "seasoning", "spice", "mix", "paste", "bean", "noodle", "wine"]);

/** True when two names plausibly name the same food (equal food words, or one's words contain the other's). */
export function sameFood(a: string, b: string): boolean {
  const x = foodWords(a);
  const y = foodWords(b);
  if (!x.length || !y.length) return false;
  const xs = x.join(" ");
  const ys = y.join(" ");
  if (xs === ys) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // "hot sauce" is not "soy sauce": a generic head alone ("sauce", after the
  // descriptor "hot" is dropped) names no food, so it must match exactly.
  if (short.length === 1 && GENERIC_HEADS.has(short[0])) return false;
  return short.every((w) => long.includes(w)) && short[short.length - 1] === long[long.length - 1];
}
