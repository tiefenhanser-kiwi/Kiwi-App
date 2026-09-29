// [grocery] B2 · Part B — BUG-330's witness. A migrate/apply is not its own witness.
import { PrismaClient } from "@prisma/client";
import { rowConversion, scalePurchaseForSubUnit } from "../../src/lib/ingredientConversions";
const prisma = new PrismaClient();
const r = await prisma.ingredient.findFirstOrThrow({
  where: { canonicalName: "cherry tomatoes" },
  select: { canonicalName: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
    packYieldUnit: true, packYieldPerPack: true, packYieldSource: true,
    packYieldReviewedByHuman: true, conversionRef: true },
});
console.log(`row: pack="${r.purchaseDisplay}" [${r.purchaseUnit}] yield=${r.packYieldPerPack} ${r.packYieldUnit} src=${r.packYieldSource} reviewed=${r.packYieldReviewedByHuman}`);
const conv = rowConversion(r as never);
console.log(`conversion: ${JSON.stringify(conv)}`);
for (const need of [6, 10, 11, 12, 20, 21]) {
  const scaled = scalePurchaseForSubUnit(conv, need, "ounce", { packFloor: null, storedDisplay: r.purchaseDisplay });
  console.log(`  need ${need} ounce -> ${scaled ? `${scaled.purchaseQuantity} · "${scaled.purchaseDisplay}"` : "no scale (pack prints verbatim)"}`);
}
await prisma.$disconnect();
