// PREP-3 (R5) — RE-DERIVE EVERY STEP'S AMOUNTS with today's matcher, IN PLACE: the
// catalog's dishes and every plan's forks (a user's copy carries its own steps). Code only,
// no AI. Dry by default; --apply writes, a batch per transaction. Idempotent: a second run
// has nothing to change.
//
//   node --env-file=.env --import tsx scripts/prep3/rederive.ts           # dry run: counts by class, before → after
//   node --env-file=.env --import tsx scripts/prep3/rederive.ts --apply   # write it
//   node --env-file=.env --import tsx scripts/prep3/rederive.ts --list 40 # and the first 40 changed steps
//
// Database: assertScriptDatabase — dev, or production only when KIWI_PRODUCTION_HOST
// names the DATABASE_URL host exactly (R3-0).
//
// Per step (dish-owned, and meal-owned for a one-dish meal), from its dish's own rows:
//   1. a count with its size reads as one ("the four 6 oz skin-on salmon fillets" →
//      "the four 6-oz skin-on salmon fillets"), so the scaled count does not sit beside the
//      size's number ("the 2 6 oz …");
//   2. amountRefs re-derived (stepAmountRefs; a stored ref the matcher no longer makes is
//      kept, thx2Rows mergeRefs): the refs older matchers wrote — "½ cups"
//      units, "Add the 1½ pounds ground beef" with no ref, the size bound where the count
//      should be — are today's.
// The walk's classes (feastAmountWalk) are counted on the scratch path only (Cook Mode
// serves one path); a bought-path step is fixed all the same.
// NOT a feast's: a Thanksgiving meal's steps are patch.ts's (their refs are pinned by the
// THX walks), and no meal tagged thanksgiving-feast is read.

import { PrismaClient, type Prisma } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { deriveAmountRefs, type AmountRef } from "../../src/lib/stepAmountRefs";
import { joinSizes, PACKAGE_AFTER } from "./rederive.lib";
import { feastAmountFindings } from "../../src/lib/feastAmountWalk";
import { mergeRefs } from "../thx2/thx2Rows";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const listIdx = argv.indexOf("--list");
const LIST = listIdx >= 0 ? Number(argv[listIdx + 1] ?? 40) : 0;
const FEAST_TAG = "thanksgiving-feast";

const { host, mode } = assertScriptDatabase("prep3/rederive");
console.log(`prep3/rederive · ${mode} · ${host} · ${APPLY ? "APPLY" : "dry run"}`);
const prisma = new PrismaClient();

const sameRefs = (a: unknown, b: AmountRef[]) => {
  // (A quantity to 9 places: jsonb gives back 1.333333333333333 for 1.3333333333333333.)
  const norm = (r: AmountRef) => `${r.ingredientId}|${Number(r.quantity).toFixed(9)}|${r.unit}|${r.charStart}|${r.charEnd}`;
  const x = Array.isArray(a) ? (a as AmountRef[]).map(norm).sort() : [];
  return JSON.stringify(x) === JSON.stringify(b.map(norm).sort());
};

const feastMeals = new Set((await prisma.meal.findMany({ where: { tags: { has: FEAST_TAG } }, select: { id: true } })).map((m) => m.id));
const links = await prisma.mealDishLink.findMany({ select: { mealId: true, dishId: true } });
const feastDishes = new Set(links.filter((l) => feastMeals.has(l.mealId)).map((l) => l.dishId));
const dishesByMeal = new Map<string, string[]>();
for (const l of links) dishesByMeal.set(l.mealId, [...(dishesByMeal.get(l.mealId) ?? []), l.dishId]);

const dishIds = [...new Set(links.map((l) => l.dishId))].filter((id) => !feastDishes.has(id));
const classes = ["corrupt", "unbound", "mismatch", "count"] as const;
const before = Object.fromEntries(classes.map((k) => [k, 0])) as Record<(typeof classes)[number], number>;
const after = { ...before };
let steps = 0;
let changedText = 0;
let changedRefs = 0;
const updates: { id: string; text: string | null; refs: AmountRef[] }[] = [];
const examples: string[] = [];
const lost: string[] = [];

type Row = { ingredientId: string; name: string; quantity: number; unit: string; preparationNote: string | null; pathKey: string | null };
async function work(ownerType: "dish" | "meal", ownerIds: string[], rowsOf: (ownerId: string) => Promise<Row[]> | Row[]) {
  for (let i = 0; i < ownerIds.length; i += 200) {
    const chunk = ownerIds.slice(i, i + 200);
    const rowsBy = new Map<string, Row[]>();
    for (const id of chunk) rowsBy.set(id, await rowsOf(id));
    const all = await prisma.recipeInstructionStep.findMany({ where: { ownerType, ownerId: { in: chunk } }, orderBy: { stepIndex: "asc" }, select: { id: true, ownerId: true, stepIndex: true, stepTextTranslated: true, stepTextRaw: true, amountRefs: true, pathKey: true } });
    for (const ownerId of chunk) {
      const rows = rowsBy.get(ownerId) ?? [];
      if (rows.length === 0) continue;
      const own = all.filter((s) => s.ownerId === ownerId);
      const matcher = rows.map((r) => ({ ingredientId: r.ingredientId, name: r.name, quantity: r.quantity, unit: r.unit }));
      const next = own.map((s) => {
        const text = joinSizes(s.stepTextTranslated);
        // A stored ref the matcher no longer makes is kept (never a corrupt or by-design one)…
        const merged = mergeRefs(text, deriveAmountRefs(text, matcher).amountRefs, s.amountRefs);
        // …and a package's size keeps its ref however it is read today: Cook Mode's package
        // display ("1 can (15 oz) — use 7½ oz", WEB-4d) reads it.
        for (const r of (Array.isArray(s.amountRefs) ? s.amountRefs : []) as AmountRef[]) {
          if (merged.some((x) => x.charStart < r.charEnd && r.charStart < x.charEnd) || r.charEnd > text.length) continue;
          if (PACKAGE_AFTER.test(text.slice(r.charEnd, r.charEnd + 24)) && !/[\d½¼¾⅓⅔]/.test(r.unit ?? "")) merged.push(r);
        }
        return { s, text, refs: merged.sort((a, b) => a.charStart - b.charStart) };
      });
      // The walk's classes, scratch path only, before → after.
      const scratch = rows.filter((r) => r.pathKey !== "bought");
      const live = next.filter((n) => n.s.pathKey !== "bought");
      for (const f of feastAmountFindings(scratch, live.map((n) => ({ stepIndex: n.s.stepIndex, text: n.s.stepTextTranslated, amountRefs: n.s.amountRefs })))) before[f.kind]++;
      for (const f of feastAmountFindings(scratch, live.map((n) => ({ stepIndex: n.s.stepIndex, text: n.text, amountRefs: n.refs })))) after[f.kind]++;
      for (const n of next) {
        steps++;
        const textMoved = n.text !== n.s.stepTextTranslated;
        const refsMoved = !sameRefs(n.s.amountRefs, n.refs);
        if (!textMoved && !refsMoved) continue;
        if (textMoved) changedText++;
        if (refsMoved) changedRefs++;
        // A stored ref the new set no longer covers: printed, every one, to be read.
        for (const r of (Array.isArray(n.s.amountRefs) ? n.s.amountRefs : []) as AmountRef[]) {
          if (n.refs.some((x) => x.charStart <= r.charStart && x.charEnd >= r.charEnd)) continue;
          lost.push(`${ownerType} ${ownerId.slice(0, 8)} #${n.s.stepIndex} "${n.s.stepTextTranslated.slice(r.charStart, r.charEnd)}" (${r.unit}) in "${n.s.stepTextTranslated.slice(Math.max(0, r.charStart - 40), r.charEnd + 40)}"`);
        }
        updates.push({ id: n.s.id, text: textMoved ? n.text : null, refs: n.refs });
        if (examples.length < LIST) examples.push(`${ownerType} ${ownerId.slice(0, 8)} #${n.s.stepIndex}${textMoved ? ` TEXT "${n.s.stepTextTranslated.slice(0, 90)}" → "${n.text.slice(0, 90)}"` : ""}${refsMoved ? ` REFS ${JSON.stringify((n.s.amountRefs as AmountRef[] | null ?? []).map((r) => n.s.stepTextTranslated.slice(r.charStart, r.charEnd)))} → ${JSON.stringify(n.refs.map((r) => n.text.slice(r.charStart, r.charEnd)))}` : ""}`);
      }
    }
  }
}

const dishRows = async (dishId: string): Promise<Row[]> =>
  (await prisma.dishIngredient.findMany({ where: { dishId }, orderBy: { positionIndex: "asc" }, select: { ingredientId: true, quantity: true, unit: true, preparationNote: true, pathKey: true, ingredient: { select: { canonicalName: true } } } }))
    .map((r) => ({ ingredientId: r.ingredientId, name: r.ingredient.canonicalName, quantity: Number(r.quantity), unit: r.unit, preparationNote: r.preparationNote, pathKey: r.pathKey ?? null }));
await work("dish", dishIds, dishRows);
// A one-dish meal's meal-owned steps are its dish's.
const mealOwners = [...dishesByMeal].filter(([mealId, ds]) => ds.length === 1 && !feastMeals.has(mealId)).map(([mealId]) => mealId);
await work("meal", mealOwners, async (mealId) => dishRows(dishesByMeal.get(mealId)![0]));

console.log(`steps read: ${steps} · to change: ${updates.length} (text ${changedText}, refs ${changedRefs}) · feast dishes left to patch.ts: ${feastDishes.size}`);
console.log(`walk (scratch path), before → after: ${classes.map((k) => `${k} ${before[k]} → ${after[k]}`).join(" · ")}`);
for (const e of examples) console.log(`  ${e}`);
console.log(`refs no longer made: ${lost.length}${argv.includes("--lost") ? "" : " (--lost lists them)"}`);
if (argv.includes("--lost")) for (const l of lost) console.log(`  − ${l}`);

if (APPLY && updates.length > 0) {
  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);
    await prisma.$transaction(batch.map((u) => prisma.recipeInstructionStep.update({
      where: { id: u.id },
      data: { amountRefs: u.refs as unknown as Prisma.InputJsonValue, ...(u.text !== null ? { stepTextTranslated: u.text, stepTextRaw: u.text } : {}) },
    })));
  }
  console.log(`applied ${updates.length} steps`);
}
await prisma.$disconnect();
