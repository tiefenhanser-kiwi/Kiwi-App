// Phase 0 probe 4 — the `from`-side unit question on component edges, plus
// live grocery-list sizing. READ ONLY.
import { PrismaClient } from "@prisma/client";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
const prisma = new PrismaClient();

const NEVER = new Set(["water","warm water","cold water","ice water","ice-cold water","boiling water","pasta cooking water","reserved pasta cooking water"]);

async function main() {
  const comp = await prisma.ingredientRelation.findMany({
    where: { label: "component" },
    include: {
      from: { select: { canonicalName: true, defaultUnit: true, conversionRef: true } },
      to: { select: { canonicalName: true, defaultUnit: true } },
    },
    orderBy: [{ fromIngredientId: "asc" }],
  });
  console.log("=== all 95 component edges: from(defaultUnit) -> to  [yield]  coHarvest ===");
  const fromUnits = new Map<string, number>();
  for (const e of comp) fromUnits.set(e.from.defaultUnit, (fromUnits.get(e.from.defaultUnit) ?? 0) + 1);
  console.log(`from-side defaultUnit histogram: ${[...fromUnits].sort((a,b)=>b[1]-a[1]).map(([u,n])=>`${u}=${n}`).join("  ")}`);
  const nonEach = comp.filter((e) => e.from.defaultUnit !== "each");
  console.log(`\nedges whose PARENT defaultUnit is NOT "each" (the yield basis is ambiguous there): ${nonEach.length}`);
  for (const e of nonEach) {
    console.log(`  ${e.from.canonicalName} [${e.from.defaultUnit}] -> ${e.to.canonicalName}  [${e.yieldQuantity} ${e.yieldUnit}] co=${e.coHarvestable}`);
  }
  const inert = comp.filter((e) => NEVER.has(normalizeIngredientName(e.from.canonicalName)) || NEVER.has(normalizeIngredientName(e.to.canonicalName)));
  console.log(`\ncomponent edges made INERT by isNeverOrdered (BUG-169): ${inert.length}`);
  for (const e of inert) console.log(`  ${e.from.canonicalName} -> ${e.to.canonicalName}`);

  console.log("\n=== full component edge list ===");
  for (const e of comp) {
    console.log(`  ${e.from.canonicalName} [${e.from.defaultUnit}] -> ${e.to.canonicalName} [${e.to.defaultUnit}]  yield ${e.yieldQuantity} ${e.yieldUnit}  co=${e.coHarvestable}  ${e.confidence}${e.reviewedByHuman ? " HUMAN" : ""}`);
  }

  // ── live grocery data sizing ──
  const lists = await prisma.groceryList.count();
  const items = await prisma.groceryListItem.count();
  const plans = await prisma.mealPlanInstance.count();
  console.log(`\n=== live data ===`);
  console.log(`  groceryList rows: ${lists}`);
  console.log(`  groceryListItem rows: ${items}`);
  console.log(`  mealPlanInstance rows: ${plans}`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
