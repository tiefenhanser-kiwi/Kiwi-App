// CAT-Q1 — the one edit shape Parts B and C share, applied two ways:
//   patchMeal   — in memory, to a CatMeal clone (the gate re-runs Pass 1 and the
//                 rubric on it). Pure.
//   applyEdits  — to the database inside the caller's transaction: every `old`
//                 is checked against the stored row FIRST (any mismatch throws
//                 StaleEdit and the transaction writes nothing), then the edits,
//                 then the amountRefs of every touched step re-derived the way
//                 the materializer does (deriveAmountRefs over the dish's own
//                 lines), then stampAllergens (D-WS9-211) and stampMealTiming
//                 (D-WS9-235) — the storeFill/materializer post-write seam.
//
// What an edit can touch, and nothing else: an ingredient line's quantity,
// unit, note, optional flag and (by an EXISTING Ingredient row) its name; a
// new base-path ingredient line on an existing dish; a step's text and
// minutes; one substitution removed (Part B only). Titles, servings, the dish
// set, phases and path tags are not expressible.
import { Prisma } from "@prisma/client";

import { selectDefaultPathSteps, type SchedulerPhase } from "../../../src/lib/cookingScheduler";
import { deriveAllergensFromNames, stampAllergens } from "../../../src/lib/allergens";
import { deriveMealTiming, stampMealTiming } from "../../../src/lib/mealTiming";
import { deriveAmountRefs, type MatcherIngredient } from "../../../src/lib/stepAmountRefs";
import type { AmountRef, CatDish, CatMeal } from "../cat-q0/catalogDb";
import { canon } from "./graph";

export interface IngFields {
  quantity: number;
  unit: string;
  /** Ingredient.displayName — the name the line prints. */
  name: string;
  preparationNote: string | null;
  isOptional: boolean;
}
export interface Substitution { product: string; quantity: number; unit: string; replaces: string[] }
/** An existing Ingredient row a new name resolved to (never created here). */
export interface IngRow { id: string; displayName: string; canonicalName: string; aliases: string[] }

interface Base {
  source: "B" | "C"; dishId: string; dishTitle: string; rule?: string; answers: number[];
  /** C only: 2 = the second editor round (its `old` is round 1's result). Absent = 1. */
  round?: number;
}
export type Edit =
  | (Base & { kind: "ingredient"; lineId: string; old: IngFields; new: IngFields | null; ingredient?: IngRow | null })
  | (Base & { kind: "new_ingredient"; old: null; new: IngFields; ingredient: IngRow })
  | (Base & { kind: "step"; stepId: string; stepIndex: number; old: { text: string; minutes: number }; new: { text: string; minutes: number } })
  | (Base & { kind: "swap_remove"; old: Substitution; new: null });

export class StaleEdit extends Error {
  constructor(public readonly mismatches: string[]) { super(`stale: ${mismatches.join(" | ")}`); }
}

// ── in memory ───────────────────────────────────────────────────────────────

export function cloneMeal(m: CatMeal): CatMeal {
  return { ...structuredClone({ ...m, updatedAt: m.updatedAt.toISOString() }), updatedAt: m.updatedAt } as CatMeal;
}

const matcherOf = (d: CatDish): MatcherIngredient[] =>
  d.ingredients.map((i) => ({ ingredientId: i.ingredientId, name: i.name, quantity: i.quantity, unit: i.unit }));

export function derivedTiming(dishes: CatDish[]) {
  const t = deriveMealTiming(dishes.map((d) => ({
    dishId: d.dishId, title: d.title, positionIndex: d.positionIndex,
    steps: d.allSteps.map((s) => ({
      stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType as SchedulerPhase,
      isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey,
    })),
  })));
  return { totalMinutes: t.totalMinutes, activeMinutes: t.activeMinutes };
}

/** The meal as it would read after `edits` (a clone; the input is untouched). */
export function patchMeal(m: CatMeal, edits: readonly Edit[]): CatMeal {
  const p = cloneMeal(m);
  const dish = (id: string) => {
    const d = p.dishes.find((x) => x.dishId === id);
    if (!d) throw new Error(`patchMeal: dish ${id} not in meal ${m.id}`);
    return d;
  };
  let namesChanged = false;
  const touchedSteps = new Set<string>();
  const changedIngredientIds = new Map<string, Set<string>>();
  const markIng = (dishId: string, ingredientId: string) => changedIngredientIds.set(dishId, (changedIngredientIds.get(dishId) ?? new Set()).add(ingredientId));
  for (const e of edits) {
    const d = dish(e.dishId);
    if (e.kind === "ingredient") {
      const i = d.ingredients.findIndex((x) => x.id === e.lineId);
      if (i < 0) throw new Error(`patchMeal: line ${e.lineId} not in dish ${d.title}`);
      markIng(d.dishId, d.ingredients[i].ingredientId);
      if (e.new === null) { d.ingredients.splice(i, 1); namesChanged = true; continue; }
      const row = d.ingredients[i];
      Object.assign(row, { quantity: e.new.quantity, unit: e.new.unit, preparationNote: e.new.preparationNote, isOptional: e.new.isOptional });
      if (e.ingredient) {
        Object.assign(row, { ingredientId: e.ingredient.id, name: e.ingredient.displayName, canonicalName: e.ingredient.canonicalName, aliases: e.ingredient.aliases });
        markIng(d.dishId, e.ingredient.id);
        namesChanged = true;
      }
    } else if (e.kind === "new_ingredient") {
      d.ingredients.push({
        id: `new:${d.ingredients.length}`, ingredientId: e.ingredient.id, name: e.ingredient.displayName, canonicalName: e.ingredient.canonicalName,
        aliases: e.ingredient.aliases, quantity: e.new.quantity, unit: e.new.unit, preparationNote: e.new.preparationNote, isOptional: e.new.isOptional,
        componentKey: null, pathKey: null, fromLeftovers: false,
      });
      markIng(d.dishId, e.ingredient.id);
      namesChanged = true;
    } else if (e.kind === "step") {
      const s = d.allSteps.find((x) => x.id === e.stepId);
      if (!s) throw new Error(`patchMeal: step ${e.stepId} not in dish ${d.title}`);
      s.text = e.new.text;
      s.estimatedMinutes = e.new.minutes;
      touchedSteps.add(e.stepId);
    } else if (e.kind === "swap_remove") {
      const k = d.substitutions.findIndex((x) => canon(x) === canon(e.old));
      if (k >= 0) d.substitutions.splice(k, 1);
    }
  }
  for (const d of p.dishes) {
    const changed = changedIngredientIds.get(d.dishId) ?? new Set<string>();
    for (const s of d.allSteps) {
      if (touchedSteps.has(s.id ?? "") || s.amountRefs.some((r) => changed.has(r.ingredientId))) {
        s.amountRefs = deriveAmountRefs(s.text, matcherOf(d)).amountRefs as AmountRef[];
      }
    }
    d.steps = selectDefaultPathSteps(d.allSteps);
  }
  p.derived = derivedTiming(p.dishes);
  if (namesChanged) p.allergens = deriveAllergensFromNames(p.dishes.flatMap((d) => d.ingredients.map((i) => i.name)));
  return p;
}

// ── in the database ─────────────────────────────────────────────────────────

const ingOf = (r: { quantity: number; unit: string; preparationNote: string | null; isOptional: boolean; ingredient: { displayName: string } }): IngFields =>
  ({ quantity: r.quantity, unit: r.unit, name: r.ingredient.displayName, preparationNote: r.preparationNote, isOptional: r.isOptional });
const sameIng = (a: IngFields, b: IngFields) => a.quantity === b.quantity && a.unit === b.unit && a.name === b.name && (a.preparationNote ?? null) === (b.preparationNote ?? null) && a.isOptional === b.isOptional;

export interface ApplyDeps {
  stamp: (tx: Prisma.TransactionClient, mealId: string) => Promise<unknown>;
  timing: (tx: Prisma.TransactionClient, mealId: string, dishIds: string[]) => Promise<unknown>;
}
export const REAL_DEPS: ApplyDeps = { stamp: (tx, id) => stampAllergens(tx, id), timing: (tx, id, ds) => stampMealTiming(tx, id, ds) };

export interface ApplyResult { applied: number; already: number }

/**
 * Apply `edits` to meal `mealId` inside `tx`. Part B edits inside a C patch are
 * idempotent (stored == new → "already", skipped); every other mismatch with
 * `old` is collected and thrown as StaleEdit BEFORE anything is written.
 */
export async function applyEdits(tx: Prisma.TransactionClient, mealId: string, edits: readonly Edit[], deps: ApplyDeps = REAL_DEPS): Promise<ApplyResult> {
  const links = await tx.mealDishLink.findMany({ where: { mealId }, select: { dishId: true } });
  const dishIds = links.map((l) => l.dishId);
  const mine = new Set(dishIds);
  // A dish another meal also links would carry this edit into that meal.
  const shared = await tx.mealDishLink.findMany({ where: { dishId: { in: dishIds }, mealId: { not: mealId } }, select: { dishId: true, mealId: true } });
  if (shared.length) throw new StaleEdit(shared.map((s) => `dish ${s.dishId} is also linked by meal ${s.mealId}`));

  const lines = await tx.dishIngredient.findMany({ where: { dishId: { in: dishIds } }, include: { ingredient: { select: { displayName: true } } } });
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const steps = await tx.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: dishIds } } });
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const dishes = await tx.dish.findMany({ where: { id: { in: dishIds } }, select: { id: true, substitutions: true } });
  const subsOf = new Map(dishes.map((d) => [d.id, (Array.isArray(d.substitutions) ? d.substitutions : []) as unknown as Substitution[]]));

  // 1. verify
  const bad: string[] = [];
  const todo: Edit[] = [];
  let already = 0;
  for (const e of edits) {
    if (!mine.has(e.dishId)) { bad.push(`${e.kind}: dish ${e.dishId} is not linked to meal ${mealId}`); continue; }
    let isOld = false, isNew = false;
    if (e.kind === "ingredient") {
      const l = lineById.get(e.lineId);
      if (l && l.dishId !== e.dishId) { bad.push(`line ${e.lineId} is in another dish`); continue; }
      isOld = !!l && sameIng(ingOf(l), e.old);
      isNew = e.new === null ? !l : !!l && sameIng(ingOf(l), e.new);
    } else if (e.kind === "new_ingredient") {
      isOld = true; // nothing stored to compare; re-applying is guarded by the B/C rule below
      isNew = lines.some((l) => l.dishId === e.dishId && l.ingredientId === e.ingredient.id && sameIng(ingOf(l), e.new));
    } else if (e.kind === "step") {
      const s = stepById.get(e.stepId);
      if (s && s.ownerId !== e.dishId) { bad.push(`step ${e.stepId} is in another dish`); continue; }
      isOld = !!s && s.stepTextRaw === e.old.text && s.estimatedMinutes === e.old.minutes;
      isNew = !!s && s.stepTextRaw === e.new.text && s.estimatedMinutes === e.new.minutes;
    } else {
      const subs = subsOf.get(e.dishId) ?? [];
      isOld = subs.some((x) => canon(x) === canon(e.old));
      isNew = !isOld;
    }
    if (isNew && (e.source === "B" || e.kind === "new_ingredient")) { already++; continue; }
    if (!isOld) { bad.push(`${e.kind} ${"lineId" in e ? e.lineId : "stepId" in e ? e.stepId : e.dishTitle}: stored value no longer equals old`); continue; }
    todo.push(e);
  }
  if (bad.length) throw new StaleEdit(bad);

  // 2. write
  const touchedSteps = new Set<string>();
  const changedIngredientIds = new Set<string>();
  for (const e of todo) {
    if (e.kind === "ingredient") {
      const l = lineById.get(e.lineId)!;
      changedIngredientIds.add(l.ingredientId);
      if (e.new === null) { await tx.dishIngredient.delete({ where: { id: e.lineId } }); continue; }
      if (e.ingredient) {
        if (!(await tx.ingredient.findUnique({ where: { id: e.ingredient.id }, select: { id: true } }))) throw new StaleEdit([`ingredient row ${e.ingredient.id} is gone`]);
        changedIngredientIds.add(e.ingredient.id);
      }
      await tx.dishIngredient.update({
        where: { id: e.lineId },
        data: { quantity: e.new.quantity, unit: e.new.unit, preparationNote: e.new.preparationNote, isOptional: e.new.isOptional, ...(e.ingredient ? { ingredientId: e.ingredient.id } : {}) },
      });
    } else if (e.kind === "new_ingredient") {
      if (!(await tx.ingredient.findUnique({ where: { id: e.ingredient.id }, select: { id: true } }))) throw new StaleEdit([`ingredient row ${e.ingredient.id} is gone`]);
      const last = await tx.dishIngredient.aggregate({ where: { dishId: e.dishId }, _max: { positionIndex: true } });
      await tx.dishIngredient.create({
        data: { dishId: e.dishId, ingredientId: e.ingredient.id, quantity: e.new.quantity, unit: e.new.unit, preparationNote: e.new.preparationNote, isOptional: e.new.isOptional, positionIndex: (last._max.positionIndex ?? -1) + 1 },
      });
      changedIngredientIds.add(e.ingredient.id);
    } else if (e.kind === "step") {
      await tx.recipeInstructionStep.update({ where: { id: e.stepId }, data: { stepTextRaw: e.new.text, stepTextTranslated: e.new.text, estimatedMinutes: e.new.minutes } });
      touchedSteps.add(e.stepId);
    } else {
      const kept = (subsOf.get(e.dishId) ?? []).filter((x) => canon(x) !== canon(e.old));
      subsOf.set(e.dishId, kept);
      await tx.dish.update({ where: { id: e.dishId }, data: { substitutions: kept.length ? (kept as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
    }
  }

  // 3. amountRefs: every edited step, and every step pointing at a changed line
  if (touchedSteps.size || changedIngredientIds.size) {
    const nowLines = await tx.dishIngredient.findMany({ where: { dishId: { in: dishIds } }, include: { ingredient: { select: { displayName: true } } }, orderBy: { positionIndex: "asc" } });
    const nowSteps = await tx.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: dishIds } } });
    for (const s of nowSteps) {
      const refs = (Array.isArray(s.amountRefs) ? s.amountRefs : []) as unknown as AmountRef[];
      if (!touchedSteps.has(s.id) && !refs.some((r) => changedIngredientIds.has(r.ingredientId))) continue;
      const matcher = nowLines.filter((l) => l.dishId === s.ownerId).map((l) => ({ ingredientId: l.ingredientId, name: l.ingredient.displayName, quantity: l.quantity, unit: l.unit }));
      const { amountRefs } = deriveAmountRefs(s.stepTextRaw, matcher);
      await tx.recipeInstructionStep.update({ where: { id: s.id }, data: { amountRefs: amountRefs as unknown as Prisma.InputJsonValue } });
    }
  }

  // 4. the post-write seam
  if (todo.length) {
    await deps.stamp(tx, mealId);
    await deps.timing(tx, mealId, dishIds);
  }
  return { applied: todo.length, already };
}

/**
 * A whole patch, in the order it was planned: Part B's edits, then the C edits
 * of round 1, then round 2 — each its own applyEdits call inside the SAME
 * transaction, because each round's `old` is the previous round's result. Any
 * StaleEdit throws out of the caller's transaction, so nothing is written.
 */
export async function applyPatch(tx: Prisma.TransactionClient, mealId: string, edits: readonly Edit[], deps: ApplyDeps = REAL_DEPS): Promise<ApplyResult[]> {
  const groups = [
    edits.filter((e) => e.source === "B"),
    edits.filter((e) => e.source === "C" && (e.round ?? 1) === 1),
    edits.filter((e) => e.source === "C" && e.round === 2),
  ];
  const out: ApplyResult[] = [];
  for (const g of groups) out.push(g.length ? await applyEdits(tx, mealId, g, deps) : { applied: 0, already: 0 });
  return out;
}
