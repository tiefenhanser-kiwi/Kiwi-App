// [grocery] B2 · A2 — the two counts the go-ahead asks for by name.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// N #400-#402: how many rows say skin-on?
const skinOn = await prisma.ingredient.findMany({
  where: { canonicalName: { contains: "skin-on" } },
  select: { id: true, canonicalName: true },
});
const used = new Set((await prisma.dishIngredient.groupBy({ by: ["ingredientId"] })).map((u) => u.ingredientId));
console.log(`Ingredient rows whose canonical says skin-on: ${skinOn.length} (on a dish: ${skinOn.filter((r) => used.has(r.id)).length})`);
for (const r of skinOn) console.log(`   ${used.has(r.id) ? "*" : " "} ${r.canonicalName}`);

// how many DishIngredient rows reach them, i.e. how many recipe lines say skin-on
const ids = skinOn.map((r) => r.id);
const di = await prisma.dishIngredient.groupBy({ by: ["ingredientId"], where: { ingredientId: { in: ids } }, _count: { _all: true } });
console.log(`\nDishIngredient rows pointing at a skin-on name: ${di.reduce((a, b) => a + b._count._all, 0)}`);

// S.1 #298: every row that is a cooking by-product, for the never-order list
console.log(`\ncooking by-product candidates in the catalog:`);
for (const r of await prisma.ingredient.findMany({
  where: { OR: [
    { canonicalName: { contains: "reserved" } },
    { canonicalName: { contains: "cooking water" } },
    { canonicalName: { contains: "braising liquid" } },
    { canonicalName: { contains: "pasta water" } },
  ] },
  select: { id: true, canonicalName: true },
})) console.log(`   ${used.has(r.id) ? "*" : " "} ${r.canonicalName}`);
await prisma.$disconnect();
