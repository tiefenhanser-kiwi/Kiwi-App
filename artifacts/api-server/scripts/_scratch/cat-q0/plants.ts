// CAT-Q0 Pass 3 — the seeded defects. Each plant takes a deep copy of a stored
// catalog meal, IN MEMORY ONLY, and writes one known defect into it. A plant
// declares the meals it can go into (`fits`), what it did (`describe`, set by
// `apply`), and how to recognise a review that caught it (`caught`: the issue
// must be on the planted dish and match the plant's own words).
//
// Ten plants spanning all seven CAT-Q0 §1 classes.

import type { CatDish, CatMeal } from "./catalogDb";
import type { ReviewIssue } from "./rubric";

export interface Planted { dish: string; described: string; token?: RegExp }

export interface Plant {
  id: string;
  cls: number;
  fits: (m: CatMeal) => boolean;
  /** Mutates `m` (a clone). Returns the planted dish's title and a one-line description. */
  apply: (m: CatMeal) => Planted;
  /** Does this issue name the plant? */
  caught: (i: ReviewIssue, planted: Planted) => boolean;
}

export const clone = (m: CatMeal): CatMeal => structuredClone(m);

const RAW_POULTRY = (d: CatDish) => d.ingredients.find((i) => /\bchicken\b/i.test(i.name) && !/\b(broth|stock|bouillon|cooked|rotisserie|sausage|ground)\b/i.test(i.name));
const onDish = (i: ReviewIssue, p: Planted) => i.dish.trim().toLowerCase() === p.dish.trim().toLowerCase();
const txt = (i: ReviewIssue) => `${i.quote} ${i.why} ${i.fix} ${i.ingredient ?? ""}`;
const mainDish = (m: CatMeal) => m.dishes.find((d) => d.steps.length >= 3) ?? m.dishes[0];
function renumber(d: CatDish) {
  d.steps.forEach((s, i) => { s.stepIndex = i; });
}

export const PLANTS: Plant[] = [
  {
    id: "rinse-chicken", cls: 5,
    fits: (m) => m.dishes.some((d) => RAW_POULTRY(d) && d.steps.length >= 2),
    apply: (m) => {
      const d = m.dishes.find((x) => RAW_POULTRY(x) && x.steps.length >= 2)!;
      d.steps.unshift({ ...d.steps[0], text: "Rinse the chicken under cold running water inside and out, then pat it dry with paper towels.", phaseType: "prep", estimatedMinutes: 3, amountRefs: [] });
      renumber(d);
      return { dish: d.title, described: "step 0 now rinses the raw chicken under running water" };
    },
    caught: (i, p) => onDish(i, p) && /rins/i.test(txt(i)),
  },
  {
    id: "tiny-teaspoon", cls: 3,
    fits: (m) => m.dishes.some((d) => d.ingredients.some((i) => /^teaspoons?$/i.test(i.unit) && i.quantity >= 0.5)),
    apply: (m) => {
      const d = m.dishes.find((x) => x.ingredients.some((i) => /^teaspoons?$/i.test(i.unit) && i.quantity >= 0.5))!;
      const ing = d.ingredients.find((i) => /^teaspoons?$/i.test(i.unit) && i.quantity >= 0.5)!;
      const was = `${ing.quantity} ${ing.unit} ${ing.name}`;
      ing.quantity = 0.06;
      return { dish: d.title, described: `${was} → 0.06 teaspoon (the screen prints "0.00 teaspoon")` };
    },
    caught: (i, p) => onDish(i, p) && /0\.0|pinch|zero|0 teaspoon/i.test(txt(i)),
  },
  {
    id: "vessel-overflow", cls: 1,
    fits: (m) => m.dishes.some((d) => d.ingredients.some((i) => /potato/i.test(i.name)) && d.steps.some((s) => /potato/i.test(s.text))),
    apply: (m) => {
      const d = m.dishes.find((x) => x.ingredients.some((i) => /potato/i.test(i.name)) && x.steps.some((s) => /potato/i.test(s.text)))!;
      const ing = d.ingredients.find((i) => /potato/i.test(i.name))!;
      ing.quantity = 5; ing.unit = "pound";
      const s = d.steps.find((x) => /potato/i.test(x.text))!;
      s.text = `${s.text.replace(/\s+$/, "")} Spread all of the potatoes in a single layer in one 8×8-inch baking dish.`;
      return { dish: d.title, described: `${ing.name} → 5 pound, and step ${s.stepIndex} spreads them all in one 8×8-inch dish` };
    },
    caught: (i, p) => onDish(i, p) && /8\s*[×x]\s*8|fit|crowd|single layer|too (many|much)|vessel|pan|dish/i.test(txt(i)) && /potato|5 pound|5 lb/i.test(txt(i)),
  },
  {
    id: "used-not-listed", cls: 2,
    fits: (m) => m.dishes.some((d) => d.ingredients.some((i) => !i.isOptional && d.steps.some((s) => s.amountRefs.some((r) => r.ingredientId === i.ingredientId)) && !/salt|pepper|water|oil/i.test(i.name))),
    apply: (m) => {
      const d = m.dishes.find((x) => x.ingredients.some((i) => !i.isOptional && x.steps.some((s) => s.amountRefs.some((r) => r.ingredientId === i.ingredientId)) && !/salt|pepper|water|oil/i.test(i.name)))!;
      const ing = d.ingredients.find((i) => !i.isOptional && d.steps.some((s) => s.amountRefs.some((r) => r.ingredientId === i.ingredientId)) && !/salt|pepper|water|oil/i.test(i.name))!;
      d.ingredients = d.ingredients.filter((i) => i !== ing);
      const head = ing.name.toLowerCase().replace(/\([^)]*\)/g, " ").split(/[^a-z]+/).filter((w) => w.length > 3).pop() ?? ing.name.toLowerCase();
      return { dish: d.title, described: `the "${ing.quantity} ${ing.unit} ${ing.name}" line is removed; its steps still use it`, token: new RegExp(head.replace(/s$/, ""), "i") };
    },
    caught: (i, p) => onDish(i, p) && !!p.token && p.token.test(txt(i)) && /list|missing|not (in|on) the|no ingredient|unlisted|add/i.test(txt(i)),
  },
  {
    id: "listed-not-used", cls: 2,
    fits: (m) => m.dishes.some((d) => d.steps.length >= 3 && !d.ingredients.some((i) => /cream|gruy/i.test(i.name))),
    apply: (m) => {
      const d = m.dishes.find((x) => x.steps.length >= 3 && !x.ingredients.some((i) => /cream|gruy/i.test(i.name)))!;
      d.ingredients.push({ ingredientId: "planted-gruyere", name: "Gruyère cheese", canonicalName: "gruyere cheese", aliases: [], quantity: 6, unit: "ounce", preparationNote: "shredded", isOptional: false, componentKey: null, pathKey: null, fromLeftovers: false });
      return { dish: d.title, described: `a "6 ounce Gruyère cheese, shredded" line is added that no step uses` };
    },
    caught: (i, p) => onDish(i, p) && /gruy/i.test(txt(i)),
  },
  {
    id: "braise-time", cls: 7,
    fits: (m) => m.dishes.some((d) => d.steps.some((s) => s.phaseType === "cook" && s.estimatedMinutes <= 15)),
    apply: (m) => {
      const d = m.dishes.find((x) => x.steps.some((s) => s.phaseType === "cook" && s.estimatedMinutes <= 15))!;
      const s = d.steps.find((x) => x.phaseType === "cook" && x.estimatedMinutes <= 15)!;
      s.text = `${s.text.replace(/\s+$/, "")} Then cover tightly and braise over low heat for 2 hours, until completely tender.`;
      m.derived = { totalMinutes: 25, activeMinutes: 15 };
      return { dish: d.title, described: `step ${s.stepIndex} (${s.estimatedMinutes} min) now ends "braise … for 2 hours", and the meal's derived total reads 25 min` };
    },
    caught: (i, p) => (onDish(i, p) || i.class === 7) && /2 hours|braise|25 min|120/i.test(txt(i)),
  },
  {
    id: "missing-prereq", cls: 4,
    fits: (m) => mainDish(m).steps.length >= 3,
    apply: (m) => {
      const d = mainDish(m);
      const s = d.steps[d.steps.length - 2];
      s.text = `${s.text.replace(/\s+$/, "")} Fold in the reserved toasted breadcrumbs.`;
      return { dish: d.title, described: `step ${s.stepIndex} now folds in "the reserved toasted breadcrumbs" — nothing makes or lists them` };
    },
    caught: (i, p) => onDish(i, p) && /breadcrumb/i.test(txt(i)),
  },
  {
    id: "unsafe-doneness", cls: 5,
    fits: (m) => m.dishes.some((d) => RAW_POULTRY(d) && d.steps.some((s) => s.phaseType === "cook")),
    apply: (m) => {
      const d = m.dishes.find((x) => RAW_POULTRY(x) && x.steps.some((s) => s.phaseType === "cook"))!;
      const s = d.steps.find((x) => x.phaseType === "cook" && /chicken/i.test(x.text)) ?? d.steps.find((x) => x.phaseType === "cook")!;
      s.text = `${s.text.replace(/\s+$/, "").replace(/\.$/, "")}, until an instant-read thermometer in the thickest piece of chicken reads 145°F.`;
      return { dish: d.title, described: `step ${s.stepIndex} now pulls the chicken at 145°F` };
    },
    caught: (i, p) => onDish(i, p) && /145|165/i.test(txt(i)),
  },
  {
    id: "self-swap", cls: 6,
    fits: (m) => m.dishes.some((d) => d.ingredients.some((i) => /\b(broth|stock|marinara|pasta sauce|salsa|pesto|tortillas?)\b/i.test(i.name))),
    apply: (m) => {
      const d = m.dishes.find((x) => x.ingredients.some((i) => /\b(broth|stock|marinara|pasta sauce|salsa|pesto|tortillas?)\b/i.test(i.name)))!;
      const ing = d.ingredients.find((i) => /\b(broth|stock|marinara|pasta sauce|salsa|pesto|tortillas?)\b/i.test(i.name))!;
      d.substitutions = [...d.substitutions, { product: `store-bought ${ing.name.toLowerCase()}`, quantity: ing.quantity, unit: ing.unit, replaces: [ing.name] }];
      return { dish: d.title, described: `a swap "store-bought ${ing.name.toLowerCase()}" replaces "${ing.name}"` };
    },
    caught: (i, p) => onDish(i, p) && (i.class === 6 || /same|itself|swap|shortcut|store-bought/i.test(txt(i))),
  },
  {
    id: "yield-mismatch", cls: 1,
    fits: (m) => m.servingsDefault === 4 && mainDish(m).servingsDefault === 4 && mainDish(m).steps.length >= 2,
    apply: (m) => {
      const d = mainDish(m);
      const s = d.steps[d.steps.length - 1];
      s.text = `${s.text.replace(/\s+$/, "")} Divide evenly among 10 plates.`;
      return { dish: d.title, described: `the last step (${s.stepIndex}) now divides a 4-serving dish among 10 plates` };
    },
    caught: (i, p) => onDish(i, p) && /10 plates|10 servings|ten|serv|yield/i.test(txt(i)),
  },
];
