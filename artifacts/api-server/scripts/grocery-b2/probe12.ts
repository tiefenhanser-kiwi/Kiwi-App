// [grocery] B2 · Part B — BUG-330. What do the tomato rows actually carry?
import { PrismaClient } from "@prisma/client";
import { resolveConversion, rowConversion } from "../../src/lib/ingredientConversions";
const prisma = new PrismaClient();
for (const r of await prisma.ingredient.findMany({
  where: { OR: [{ canonicalName: { contains: "cherry tomato" } }, { canonicalName: { contains: "grape tomato" } }] },
  select: { id: true, canonicalName: true, displayName: true, purchaseUnit: true, purchaseQuantity: true,
    purchaseDisplay: true, packYieldUnit: true, packYieldPerPack: true, packYieldSource: true,
    packYieldReviewedByHuman: true, conversionRef: true },
})) {
  const conv = rowConversion(r as never);
  console.log(`${r.canonicalName}`);
  console.log(`   display="${r.displayName}" pack=${r.purchaseQuantity} ${r.purchaseUnit} "${r.purchaseDisplay}"`);
  console.log(`   packYield=${r.packYieldPerPack ?? "null"} ${r.packYieldUnit ?? ""} src=${r.packYieldSource ?? "-"} reviewed=${r.packYieldReviewedByHuman}`);
  console.log(`   conversion=${JSON.stringify(conv)}`);
}
await prisma.$disconnect();
