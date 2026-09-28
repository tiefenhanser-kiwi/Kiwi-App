import { PrismaClient } from "@prisma/client";
import { lookupIngredientByName } from "../../src/lib/ingredientLookup";
const prisma = new PrismaClient();
async function main() {
  const plans = await prisma.mealPlanInstance.findMany({
    where: { id: { startsWith: "247cd7bb" } },
    select: { id: true, updatedAt: true, items: { select: { recipeOverrideJson: true, mealId: true } } },
  });
  for (const p of plans) {
    console.log(`plan ${p.id.slice(0, 8)} updatedAt=${p.updatedAt.toISOString()}`);
    for (const it of p.items) {
      const ov = it.recipeOverrideJson as { dishes?: { ingredients?: { name: string }[] }[] } | null;
      if (!ov?.dishes) continue;
      for (const d of ov.dishes) for (const g of d.ingredients ?? []) {
        if (/parsley/i.test(g.name)) console.log(`   OVERRIDE ingredient: "${g.name}"`);
      }
    }
  }
  for (const n of ["parsley", "flat-leaf parsley"]) {
    const row = await prisma.ingredient.findFirst({ where: { canonicalName: n }, select: { id: true, canonicalName: true } });
    const hit = await lookupIngredientByName(prisma, n, n);
    console.log(`  exact "${n}" -> ${row ? row.id.slice(0, 8) : "MISS"} · aliasHop -> ${hit ? hit.id.slice(0, 8) : "MISS"}`);
  }
  const al = await prisma.ingredientAlias.findMany({ where: { alias: { in: ["parsley", "flat-leaf parsley"] } }, select: { alias: true, ingredientId: true } });
  console.log("  aliases:", JSON.stringify(al));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
