// WS9 D-WS9-189 A1 — merge `thin soy sauce` into `light soy sauce`.
//
// Hans ruled the rename ("'thin soy sauce' should be called 'light soy sauce'
// and it's a different ingredient than soy sauce"), and a `light soy sauce` row
// already existed, so the rename is a two-row MERGE. Authorised as a merge on
// 2026-09-02, separately from the rename authorisation it started as.
//
// §27.2 REUSE — the carrier list is BUG-096's, not a fresh one. That script
// enumerated NINE carriers for an ingredient id/name and documented which ones
// fail silently; re-deriving them here would be how one gets missed:
//   FK, ON DELETE RESTRICT   DishIngredient.ingredientId        (blocks loudly)
//   FK, ON DELETE SET NULL   GroceryListItem.ingredientId       (SILENTLY NULLS)
//   no FK                    RecipeInstructionStep.amountRefs[].ingredientId
//   no FK                    PrepStepCompletion.stepKey
//   no FK                    PrepWeekStructure.structureJson
//   by NAME                  Dish.substitutions
//   by NAME                  GroceryListItem.displayName
//   by NAME                  UserPreferences.recurringGroceryItems
//   by NAME                  MealPlanItem.recipeOverrideJson
// Plus one BUG-096 could not know about, because it predates it:
//   FK, ON DELETE CASCADE    IngredientRelation.from/toIngredientId
//
// ⚠️ THE COMMISSIONING PLAN NAMED THREE OF THESE (dish refs, relations,
// aliases). The other seven are scanned anyway — a merge that deletes a row
// still referenced by `GroceryListItem` does not fail, it silently nulls, and
// 80 of 1,292 rows already carry a null so a fresh one would never be noticed.
//
// Run:
//   DRY RUN:  node --env-file=.env --import tsx scripts/ws9-d189-a1-soy-merge.ts
//   APPLY:    node --env-file=.env --import tsx scripts/ws9-d189-a1-soy-merge.ts --apply

import { Prisma, PrismaClient } from "@prisma/client";

import { normalizeAliasKey } from "../src/lib/ingredientLookup";
import {
  countAmountRefHits,
  countOverrideNameHits,
  countStructureJsonHits,
  countSubstitutionHits,
  rewriteAmountRefs,
  stepKeyTouches,
} from "../src/lib/ingredientMergeCarriers";

const LOSER = "thin soy sauce";
const SURVIVOR = "light soy sauce";
/** The plan says 2. A different number means the world moved; stop. */
const EXPECTED_DISH_REFS = 2;

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const stop: string[] = [];

  const rows = await prisma.ingredient.findMany({
    where: { canonicalName: { in: [LOSER, SURVIVOR] } },
  });
  const loser = rows.find((r) => r.canonicalName === LOSER);
  const survivor = rows.find((r) => r.canonicalName === SURVIVOR);
  if (!loser || !survivor) {
    console.error(`\n🔴 one side is missing — loser=${Boolean(loser)} survivor=${Boolean(survivor)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== MERGE ${apply ? "(APPLY)" : "(DRY RUN)"} ===`);
  console.log(`  loser    "${loser.canonicalName}"    ${loser.id}`);
  console.log(`  survivor "${survivor.canonicalName}"  ${survivor.id}`);

  // ── scan every carrier for the loser ────────────────────────────────────
  const ids = new Set([loser.id]);
  const names = new Set([LOSER.toLowerCase()]);

  const dishIngredient = await prisma.dishIngredient.count({ where: { ingredientId: loser.id } });
  const groceryFk = await prisma.groceryListItem.count({ where: { ingredientId: loser.id } });

  let amountRefs = 0;
  for (const s of await prisma.recipeInstructionStep.findMany({
    where: { NOT: { amountRefs: { equals: Prisma.DbNull } } },
    select: { amountRefs: true },
  })) {
    amountRefs += countAmountRefHits(s.amountRefs, ids);
  }
  let prepStepCompletion = 0;
  for (const p of await prisma.prepStepCompletion.findMany({ select: { stepKey: true } })) {
    if (stepKeyTouches(p.stepKey, ids)) prepStepCompletion += 1;
  }
  let prepWeekStructure = 0;
  for (const s of await prisma.prepWeekStructure.findMany({ select: { structureJson: true } })) {
    prepWeekStructure += countStructureJsonHits(s.structureJson, ids);
  }
  let substitutions = 0;
  for (const d of await prisma.dish.findMany({
    where: { NOT: { substitutions: { equals: Prisma.DbNull } } },
    select: { substitutions: true },
  })) {
    substitutions += countSubstitutionHits(d.substitutions, names);
  }
  const groceryDisplayName = (
    await prisma.groceryListItem.findMany({ select: { displayName: true } })
  ).filter((g) => g.displayName.toLowerCase().trim() === LOSER).length;
  let recurring = 0;
  for (const p of await prisma.userPreferences.findMany({ select: { recurringGroceryItems: true } })) {
    for (const v of p.recurringGroceryItems ?? []) if (v.toLowerCase().trim() === LOSER) recurring += 1;
  }
  let overrideJson = 0;
  for (const it of await prisma.mealPlanItem.findMany({
    where: { NOT: { recipeOverrideJson: { equals: Prisma.DbNull } } },
    select: { recipeOverrideJson: true },
  })) {
    overrideJson += countOverrideNameHits(it.recipeOverrideJson, names);
  }

  console.log(`\n  LOSER references, all ten carriers:`);
  const carriers: Array<[string, number]> = [
    ["DishIngredient.ingredientId (FK RESTRICT)", dishIngredient],
    ["GroceryListItem.ingredientId (FK SET NULL)", groceryFk],
    ["RecipeInstructionStep.amountRefs[]", amountRefs],
    ["PrepStepCompletion.stepKey", prepStepCompletion],
    ["PrepWeekStructure.structureJson", prepWeekStructure],
    ["Dish.substitutions (name)", substitutions],
    ["GroceryListItem.displayName (name)", groceryDisplayName],
    ["UserPreferences.recurringGroceryItems (name)", recurring],
    ["MealPlanItem.recipeOverrideJson (name)", overrideJson],
  ];
  for (const [label, n] of carriers) {
    console.log(`    ${n > 0 ? "→" : " "} ${label.padEnd(46)} ${n}`);
  }

  // ── relations ───────────────────────────────────────────────────────────
  const loserRels = await prisma.ingredientRelation.findMany({
    where: { OR: [{ fromIngredientId: loser.id }, { toIngredientId: loser.id }] },
  });
  const survivorRels = await prisma.ingredientRelation.findMany({
    where: { OR: [{ fromIngredientId: survivor.id }, { toIngredientId: survivor.id }] },
  });
  const nameById = new Map(
    (
      await prisma.ingredient.findMany({ select: { id: true, canonicalName: true } })
    ).map((i) => [i.id, i.canonicalName]),
  );
  const show = (r: (typeof loserRels)[number]): string =>
    `"${nameById.get(r.fromIngredientId)}" -> "${nameById.get(r.toIngredientId)}" = ${r.label}${r.reviewedByHuman ? " [human]" : ""}`;

  console.log(`\n  IngredientRelation — loser ${loserRels.length}, survivor ${survivorRels.length}`);
  for (const r of loserRels) console.log(`    loser:    ${show(r)}`);
  for (const r of survivorRels) console.log(`    survivor: ${show(r)}`);

  // Re-point each loser relation onto the survivor; detect duplicates and,
  // among duplicates, LABEL DISAGREEMENT — which is a stop, not a pick.
  const plan: Array<{ rel: (typeof loserRels)[number]; action: "repoint" | "drop"; note: string }> = [];
  for (const r of loserRels) {
    const from = r.fromIngredientId === loser.id ? survivor.id : r.fromIngredientId;
    const to = r.toIngredientId === loser.id ? survivor.id : r.toIngredientId;
    if (from === to) {
      plan.push({ rel: r, action: "drop", note: "self-edge after re-pointing (loser related to survivor)" });
      continue;
    }
    const dup = survivorRels.find(
      (s) =>
        (s.fromIngredientId === from && s.toIngredientId === to) ||
        (s.fromIngredientId === to && s.toIngredientId === from),
    );
    if (!dup) {
      plan.push({ rel: r, action: "repoint", note: "no survivor row for this pair" });
      continue;
    }
    if (dup.label !== r.label) {
      stop.push(
        `relation labels DISAGREE for the same pair after re-pointing: survivor says ${dup.label}, loser says ${r.label} — ${show(r)}`,
      );
      continue;
    }
    plan.push({ rel: r, action: "drop", note: `duplicate of survivor's row, same label (${dup.label}) — survivor's kept` });
  }
  console.log(`\n  relation plan:`);
  for (const p of plan) console.log(`    ${p.action.toUpperCase().padEnd(8)} ${show(p.rel)}  — ${p.note}`);

  // ── data the survivor would lose ────────────────────────────────────────
  const dataFields: Array<[string, unknown, unknown]> = [
    ["nutritionRefPerUnit", loser.nutritionRefPerUnit, survivor.nutritionRefPerUnit],
    ["conversionRef", loser.conversionRef, survivor.conversionRef],
    ["purchaseUnit", loser.purchaseUnit, survivor.purchaseUnit],
    ["purchaseQuantity", loser.purchaseQuantity, survivor.purchaseQuantity],
    ["purchaseDisplay", loser.purchaseDisplay, survivor.purchaseDisplay],
    ["subcategory", loser.subcategory, survivor.subcategory],
  ];
  console.log(`\n  data comparison (survivor's own values are PRESERVED, never overwritten):`);
  for (const [f, l, s] of dataFields) {
    const lHas = l !== null && l !== undefined;
    const sHas = s !== null && s !== undefined;
    console.log(`    ${f.padEnd(20)} loser=${lHas ? "set" : "—"}  survivor=${sHas ? "set" : "—"}`);
    if (lHas && !sHas) {
      stop.push(`loser carries ${f} and the survivor does not — merging would DISCARD it`);
    }
  }

  // ── alias ───────────────────────────────────────────────────────────────
  //
  // ⚠️ THE COMMISSIONING PLAN SAID "add to the survivor's `aliases`". That
  // ARRAY IS DEAD: schema.prisma marks `Ingredient.aliases` superseded by the
  // `ingredient_aliases` table and says nothing reads or writes it. Writing
  // there would look done and resolve nothing. The alias goes in the TABLE,
  // which carries the @unique that makes a collision a P2002 rather than a
  // coin flip.
  const aliasKey = normalizeAliasKey(LOSER);
  const aliasClash = await prisma.ingredientAlias.findUnique({ where: { aliasKey } });
  console.log(`\n  alias: "${LOSER}" -> aliasKey "${aliasKey}"`);
  if (aliasClash) {
    console.log(`    already exists on ingredient ${aliasClash.ingredientId} — would be re-pointed to the survivor`);
  } else {
    console.log(`    free — would be created on the survivor`);
  }

  if (dishIngredient !== EXPECTED_DISH_REFS) {
    stop.push(`dish-ref count is ${dishIngredient}, expected ${EXPECTED_DISH_REFS} — the world moved since the plan`);
  }

  if (stop.length > 0) {
    console.error(`\n🔴 STOPPING — ${stop.length} condition(s) the plan said to stop on:`);
    for (const s of stop) console.error(`   · ${s}`);
    console.error(`\n   NOTHING WRITTEN.`);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --apply.`);
    return;
  }

  // ── apply, in one transaction ───────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    await tx.dishIngredient.updateMany({
      where: { ingredientId: loser.id },
      data: { ingredientId: survivor.id },
    });
    if (groceryFk > 0) {
      await tx.groceryListItem.updateMany({
        where: { ingredientId: loser.id },
        data: { ingredientId: survivor.id },
      });
    }

    // ⚠️ `amountRefs` HAS NO FOREIGN KEY, so deleting the loser leaves these
    // pointing at an id that no longer exists — silently, with no error. The
    // commissioning plan did not mention this carrier and the scan found 2 live
    // references, so this rewrite is the difference between a clean merge and
    // two orphaned refs nobody would see until a cook step rendered wrong.
    const survivorByLoserId = new Map([[loser.id, survivor.id]]);
    for (const s of await tx.recipeInstructionStep.findMany({
      where: { NOT: { amountRefs: { equals: Prisma.DbNull } } },
      select: { id: true, amountRefs: true },
    })) {
      const rewritten = rewriteAmountRefs(s.amountRefs, survivorByLoserId);
      if (!rewritten) continue;
      await tx.recipeInstructionStep.update({
        where: { id: s.id },
        data: { amountRefs: rewritten.refs as Prisma.InputJsonValue },
      });
    }
    for (const p of plan) {
      if (p.action === "drop") {
        await tx.ingredientRelation.delete({ where: { id: p.rel.id } });
      } else {
        await tx.ingredientRelation.update({
          where: { id: p.rel.id },
          data: {
            fromIngredientId: p.rel.fromIngredientId === loser.id ? survivor.id : p.rel.fromIngredientId,
            toIngredientId: p.rel.toIngredientId === loser.id ? survivor.id : p.rel.toIngredientId,
          },
        });
      }
    }
    if (aliasClash) {
      await tx.ingredientAlias.update({
        where: { aliasKey },
        data: { ingredientId: survivor.id },
      });
    } else {
      await tx.ingredientAlias.create({
        data: { ingredientId: survivor.id, alias: LOSER, aliasKey },
      });
    }
    // Gate the delete on zero remaining id references, exactly as BUG-096 does.
    const remaining = await tx.dishIngredient.count({ where: { ingredientId: loser.id } });
    const remainingGrocery = await tx.groceryListItem.count({ where: { ingredientId: loser.id } });
    if (remaining > 0 || remainingGrocery > 0) {
      throw new Error(
        `refusing to delete: ${remaining} dish + ${remainingGrocery} grocery references still point at the loser`,
      );
    }
    await tx.ingredient.delete({ where: { id: loser.id } });
  });

  console.log(`\n  ✅ MERGED.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
