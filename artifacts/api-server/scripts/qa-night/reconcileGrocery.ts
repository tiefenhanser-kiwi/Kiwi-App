// QA-NIGHT-1 — R1, R2, R3: the grocery list against the recipes.
//
// The recipe side is GET /meals/:id?planItemId (authored amounts, the item's
// recipe override applied), scaled by the server's own multiplier rule
// (types.ts dishFactor). It is NOT the server's consolidator: an oracle that
// re-runs the code under test agrees with every bug in it.
//
// Matching a recipe line to a list row is by food (units.ts sameFood), and a
// row the list attributes to that meal (mealNames) wins over one it does not.
// Amounts are compared only when both convert into one unit (units.ts); the
// rest are counted "present, amount not comparable" — a guess at a density is
// how a reconciler invents findings.
import { comparable, foodKey, normName, sameFood } from "./units";
import { dishFactor, type Finding, type GroceryRow, type PlanMeal, type RuleResult } from "./types";

/** Never on a list: the app does not buy them (groceryList.ts "never-ordered"): water in any
 *  form ("reserved pasta cooking water"), and ice. Coconut water, tonic and soda are bought. */
const NEVER_BOUGHT = /^(?!.*\b(coconut|tonic|sparkling|soda|rose|orange blossom|chestnut)\b)(.*\bwater|ice)$/i;

export interface GroceryEvidence {
  /** "after generation", "after servings 10 on Taco Night". */
  label: string;
  meals: PlanMeal[];
  rows: GroceryRow[];
}

interface Need {
  meal: PlanMeal;
  name: string;
  qty: number;
  unit: string;
  birdDish: boolean;
}

function needs(meals: PlanMeal[], opts: { optional?: boolean } = {}): (Need & { optional: boolean })[] {
  const out: (Need & { optional: boolean })[] = [];
  for (const m of meals) {
    for (const d of m.dishes) {
      const f = dishFactor(m, d);
      for (const ing of d.ingredients) {
        if ((ing.isOptional && !opts.optional) || NEVER_BOUGHT.test(ing.name.trim())) continue;
        out.push({ meal: m, name: ing.name, qty: ing.quantity * f, unit: ing.unit, birdDish: !!d.isBirdDish, optional: ing.isOptional });
      }
    }
  }
  return out;
}

const rowNames = (r: GroceryRow) => [r.displayName, r.canonicalName].filter((x): x is string => !!x);
const forMeal = (r: GroceryRow, m: PlanMeal) => r.mealNames.some((n) => m.aliases.includes(n));
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Where a recipe line lands on the list: the matching row the list attributes to that meal, else any matching row. */
export function rowFor(rows: GroceryRow[], need: { meal: PlanMeal; name: string }): GroceryRow | null {
  const matches = rows.filter((r) => rowNames(r).some((n) => sameFood(n, need.name)));
  return matches.find((r) => forMeal(r, need.meal)) ?? matches[0] ?? null;
}

export function reconcileR1(household: string, ev: GroceryEvidence): RuleResult & { notComparable: number } {
  const findings: Finding[] = [];
  let checked = 0;
  let notComparable = 0;
  const byRow = new Map<string, { row: GroceryRow; rows: GroceryRow[]; needs: Need[] }>();
  for (const n of needs(ev.meals)) {
    checked++;
    const row = rowFor(ev.rows, n);
    if (!row) {
      findings.push({
        rule: "R1", signature: `R1:missing:${normName(n.name)}`, severity: "high", household, meal: n.meal.title,
        detail: `${ev.label}: ${n.meal.title} needs ${r2(n.qty)} ${n.unit} ${n.name}; no row on the list`,
        numbers: { need: r2(n.qty), unit: n.unit },
      });
      continue;
    }
    // One food may sit on several rows ("Kosher salt" three times): need and rows are summed per food.
    const key = foodKey(row.displayName) || row.id;
    const e = byRow.get(key) ?? { row, rows: ev.rows.filter((r) => (foodKey(r.displayName) || r.id) === key), needs: [] };
    e.needs.push(n);
    byRow.set(key, e);
  }
  // Amounts: Σ need of every recipe line for a food ≤ Σ the list's rows for it (5 % rounding slack).
  for (const { row, rows: rs, needs: ns } of byRow.values()) {
    if (ns.some((n) => n.birdDish)) {
      // The bird's dish scales by the bird weight (prepQuantity dishRowMultipliers):
      // the birds themselves are checked below, the dish's other lines by presence.
      notComparable++;
      continue;
    }
    let total = 0;
    let have = 0;
    let unit = "";
    let ok = true;
    const anchor = { qty: row.quantity, unit: row.unit };
    for (const n of ns) {
      const c = comparable({ qty: n.qty, unit: n.unit }, anchor);
      if (!c) { ok = false; break; }
      total += c.a;
      unit = c.unit;
    }
    for (const r of rs) {
      const c = ok ? comparable({ qty: r.quantity, unit: r.unit }, anchor) : null;
      if (!c) { ok = false; break; }
      have += c.a;
    }
    if (!ok) { notComparable++; continue; }
    if (have < total * 0.95 - 1e-6) {
      findings.push({
        rule: "R1", signature: `R1:shortfall:${normName(ns[0].name)}`, severity: "high", household,
        meal: [...new Set(ns.map((n) => n.meal.title))].join(" + "),
        detail: `${ev.label}: "${row.displayName}" is ${rs.map((r) => `${r.quantity} ${r.unit}`).join(" + ")}; the recipes need ${ns.map((n) => `${r2(n.qty)} ${n.unit} (${n.meal.title})`).join(" + ")} = ${r2(total)} ${unit}, the list has ${r2(have)} ${unit}`,
        numbers: { listQty: row.quantity, listUnit: row.unit, need: r2(total), have: r2(have), unit },
      });
    }
  }
  // The turkey: a chosen weight is bought (a whole bird by weight, or one bird by count).
  for (const m of ev.meals) {
    if (m.birdWeightLb === null) continue;
    checked++;
    const row = ev.rows.find((r) => rowNames(r).some((n) => /\bturkey\b/i.test(n) && !/broth|stock|gravy|neck|giblet|bacon|sausage/i.test(n)));
    const c = row ? comparable({ qty: m.birdWeightLb, unit: "lb" }, { qty: row.quantity, unit: row.unit }) : null;
    if (!row) {
      findings.push({ rule: "R1", signature: "R1:missing:turkey", severity: "high", household, meal: m.title, detail: `${ev.label}: ${m.title} has a ${m.birdWeightLb} lb bird; no turkey on the list`, numbers: { birdLb: m.birdWeightLb } });
    } else if (c && c.b < c.a * 0.95) {
      findings.push({ rule: "R1", signature: "R1:shortfall:turkey-weight", severity: "high", household, meal: m.title, detail: `${ev.label}: the bird is ${m.birdWeightLb} lb; the list buys ${row.quantity} ${row.unit} of "${row.displayName}"`, numbers: { birdLb: m.birdWeightLb, listQty: row.quantity, listUnit: row.unit } });
    }
  }
  return { rule: "R1", checked, findings, notComparable };
}

export interface R2Counts {
  traced: number;
  staples: number;
  userAdded: number;
  recurring: number;
}

export function reconcileR2(household: string, ev: GroceryEvidence): RuleResult & { counts: R2Counts } {
  const findings: Finding[] = [];
  const counts: R2Counts = { traced: 0, staples: 0, userAdded: 0, recurring: 0 };
  const titles = new Set(ev.meals.flatMap((m) => m.aliases));
  // Optional lines included: a row for one is traced, and reported apart (BUG-409).
  const all = needs(ev.meals, { optional: true });
  for (const r of ev.rows) {
    if (r.isUserAdded) { counts.userAdded++; continue; }
    const offPlan = r.mealNames.filter((n) => !titles.has(n));
    if (offPlan.length > 0) {
      findings.push({
        rule: "R2", signature: "R2:row-for-meal-not-on-plan", severity: "high", household,
        detail: `${ev.label}: "${r.displayName}" (${r.quantity} ${r.unit}) is for ${offPlan.map((n) => `"${n}"`).join(", ")}, not on the plan`,
        numbers: { qty: r.quantity, unit: r.unit },
      });
      continue;
    }
    if (r.mealNames.length === 0) {
      if (r.isUniversalStaple || r.isUserPantryStaple) { counts.staples++; continue; }
      if (r.isRecurringItem) { counts.recurring++; continue; }
      findings.push({ rule: "R2", signature: `R2:row-without-meal:${normName(r.displayName)}`, severity: "medium", household, detail: `${ev.label}: "${r.displayName}" (${r.quantity} ${r.unit}) names no meal and is not a staple, a recurring item or user-added` });
      continue;
    }
    const named = ev.meals.filter((m) => forMeal(r, m));
    const lines = all.filter((n) => named.includes(n.meal) && rowNames(r).some((x) => sameFood(x, n.name)));
    const inRecipe = lines.length > 0;
    if (inRecipe && lines.every((n) => n.optional)) {
      findings.push({ rule: "R2", signature: `R2:optional-bought:${normName(r.displayName)}`, severity: "low", household, meal: named.map((m) => m.title).join(" + "),
        detail: `${ev.label}: "${r.displayName}" (${r.quantity} ${r.unit}) is on the list, but every recipe line for it is optional` });
      continue;
    }
    // A row may merge several recipe names into one food the list buys (a relation
    // fold: "garlic" for "garlic cloves"); sameFood covers those. A staple attributed
    // to a meal is still a staple.
    if (!inRecipe && !(r.isUniversalStaple || r.isUserPantryStaple)) {
      findings.push({
        rule: "R2", signature: `R2:row-not-in-recipes:${normName(r.displayName)}`, severity: "medium", household,
        meal: named.map((m) => m.title).join(" + "),
        detail: `${ev.label}: "${r.displayName}" (${r.quantity} ${r.unit}) is attributed to ${named.map((m) => m.title).join(", ")}, whose recipes name no such food`,
      });
      continue;
    }
    counts.traced++;
  }
  return { rule: "R2", checked: ev.rows.length, findings, counts };
}

export interface EditEvidence {
  edit: "servings" | "swap" | "add-dish" | "bird-weight";
  /** The meal the edit touched (after the edit). */
  mealTitle: string;
  /** Every name it goes by: grocery mealNames use one of them. */
  mealAliases: string[];
  before: GroceryEvidence;
  after: GroceryEvidence;
  /** The swapped-out meal's names: none of its rows may remain. */
  removedTitles: string[];
  /** GET after the edit said `reconciled: true`. */
  reconciled: boolean;
}

/** R1 and R2 again after the edit (as R3), the removed meal's rows gone, and the list moved at all. */
export function reconcileR3(household: string, ev: EditEvidence): RuleResult {
  const findings: Finding[] = [];
  let checked = 0;
  const relabel = (f: Finding): Finding => ({ ...f, rule: "R3", signature: `R3:${ev.edit}:${f.signature}`, detail: `after ${ev.edit} — ${f.detail}` });
  const one = reconcileR1(household, ev.after);
  const two = reconcileR2(household, ev.after);
  checked += one.checked + two.checked;
  findings.push(...one.findings.map(relabel), ...two.findings.filter((f) => f.signature !== "R2:row-for-meal-not-on-plan").map(relabel));
  for (const t of ev.removedTitles) {
    checked++;
    const left = ev.after.rows.filter((r) => !r.isUserAdded && r.mealNames.includes(t));
    if (left.length > 0) {
      findings.push({
        rule: "R3", signature: `R3:${ev.edit}:removed-meal-rows-remain`, severity: "high", household, meal: t,
        detail: `after ${ev.edit}: ${left.length} row(s) still for "${t}", which left the plan (${left.slice(0, 4).map((r) => `"${r.displayName}"`).join(", ")})`,
        numbers: { rows: left.length },
      });
    }
  }
  // Rows for a meal no longer on the plan, other than the named removal.
  for (const f of two.findings.filter((x) => x.signature === "R2:row-for-meal-not-on-plan")) {
    if (ev.removedTitles.some((t) => f.detail.includes(`"${t}"`))) continue;
    findings.push(relabel(f));
  }
  // The list followed at all: some row for the edited meal changed.
  checked++;
  const sig = (rows: GroceryRow[]) =>
    rows.filter((r) => r.mealNames.some((n) => ev.mealAliases.includes(n))).map((r) => `${normName(r.displayName)}=${r.quantity}${r.unit}`).sort().join("|");
  if (sig(ev.before.rows) === sig(ev.after.rows)) {
    findings.push({
      rule: "R3", signature: `R3:${ev.edit}:list-did-not-follow`, severity: "high", household, meal: ev.mealTitle,
      detail: `after ${ev.edit} on ${ev.mealTitle}: no row for it changed (reconciled: ${ev.reconciled})`,
    });
  }
  return { rule: "R3", checked, findings };
}
