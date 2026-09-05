// Does any live list carry TWO co-harvestable juice slots for one parent?
// If so, max() across them under-buys, because they are the same product.
import { PrismaClient } from "@prisma/client";
import { consolidatePlanIngredients } from "../../src/lib/groceryList";
import { buildRelationIndex, poolComponentNeedsUngated, type RelationRow } from "../../src/lib/ingredientRelations";
const prisma = new PrismaClient();
async function main() {
  const raw = await prisma.ingredientRelation.findMany({
    include: { from: { select: { canonicalName: true, defaultUnit: true } }, to: { select: { canonicalName: true } } },
  });
  const rows: RelationRow[] = raw.map((r) => ({
    label: r.label as any, fromCanonicalName: r.from.canonicalName, toCanonicalName: r.to.canonicalName,
    yieldQuantity: r.yieldQuantity, yieldUnit: r.yieldUnit, coHarvestable: r.coHarvestable,
    confidence: r.confidence as any, reviewedByHuman: r.reviewedByHuman, fromDefaultUnit: r.from.defaultUnit,
  }));
  const index = buildRelationIndex(rows);
  const lists = await prisma.groceryList.findMany({ where: { status: { not: "archived" } }, select: { id: true, userId: true, mealPlanInstanceId: true } });
  let n = 0;
  for (const l of lists) {
    if (!l.mealPlanInstanceId) continue;
    let before; try { before = await consolidatePlanIngredients({ prisma, planId: l.mealPlanInstanceId, userId: l.userId }); } catch { continue; }
    const pooled = poolComponentNeedsUngated(before.map((b) => ({ ...b })), index);
    for (const f of pooled.folds) {
      const co = f.slots.filter((s) => s.coHarvestable);
      if (co.length < 2) continue;
      n++;
      const sum = co.reduce((s, x) => s + x.parentsImplied, 0);
      const mx = Math.max(...co.map((x) => x.parentsImplied));
      console.log(`[${l.id.slice(0,8)}] parent ${f.parent}: ${co.length} co-harvestable slots`);
      for (const s of co) console.log(`      ${s.child} = ${s.demand} ${s.yieldUnit} -> ${s.parentsImplied.toFixed(3)} parents`);
      console.log(`      max()=${mx.toFixed(3)} -> BUY ${f.wholeParents};  if these are the SAME product, sum()=${sum.toFixed(3)} -> would buy ${Math.ceil(sum - 1e-9)}`);
      console.log(`      ${Math.ceil(sum - 1e-9) > f.wholeParents ? ">>> UNDER-BUY of " + (Math.ceil(sum-1e-9) - f.wholeParents) : "no difference"}`);
    }
  }
  console.log(`\npools with >=2 co-harvestable slots: ${n}`);
}
main().then(()=>prisma.$disconnect()).catch(async(e)=>{console.error(e);await prisma.$disconnect();process.exit(1);});
