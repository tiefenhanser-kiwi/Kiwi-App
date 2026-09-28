import { PrismaClient } from "@prisma/client";
import { lookupPurchaseDefault } from "../../src/lib/ingredientConversions";
const prisma = new PrismaClient();
const PACK_PLURALS = ["heads","bunches","jars","loaves","bulbs","ears","sprigs","wedges","bottles","packages","blocks","containers","boxes","bags","leaves","slices","sticks","pints"];
async function main() {
  console.log("=== grocery_list_items stored unit spellings ===");
  const gi = await prisma.groceryListItem.groupBy({ by: ["unit"], _count: { _all: true } });
  const gu = new Map(gi.map((g) => [g.unit.trim().toLowerCase(), g._count._all]));
  for (const p of PACK_PLURALS) {
    const s = p === "loaves" ? "loaf" : p === "leaves" ? "leaf" : p === "bunches" ? "bunch" : p === "boxes" ? "box" : p.slice(0, -1);
    const np = gu.get(p) ?? 0, ns = gu.get(s) ?? 0;
    if (np > 0 || ns > 0) console.log(`  ${p}(${np}) / ${s}(${ns})${np > 0 ? "   <-- PLURAL IS STORED" : ""}`);
  }
  console.log(`  ${gi.length} distinct stored spellings; ${gi.reduce((a,b)=>a+b._count._all,0)} items`);

  console.log("\n=== digest #100 — where do `lemons` / `limes` come from? ===");
  const users = await prisma.user.findMany({ select: { id: true, email: true, recurringGroceryItems: true } });
  for (const u of users) {
    const hits = u.recurringGroceryItems.filter((r) => /^(lemons|limes|lemon|lime)$/i.test(r.trim()));
    if (hits.length) console.log(`  user ${u.id.slice(0,8)} (${u.email ?? "-"}) recurring: ${JSON.stringify(hits)} · full list ${JSON.stringify(u.recurringGroceryItems)}`);
  }
  for (const n of ["lemons", "limes"]) {
    const ing = await prisma.ingredient.findFirst({ where: { canonicalName: n }, select: { id: true } });
    console.log(`  catalog row "${n}": ${ing ? "EXISTS" : "NONE"} · lookupPurchaseDefault -> ${JSON.stringify(lookupPurchaseDefault(n))}`);
  }
  const items = await prisma.groceryListItem.findMany({
    where: { displayName: { in: ["lemons", "limes", "Lemons", "Limes"] } },
    select: { displayName: true, ingredientId: true, isRecurringItem: true, unit: true, purchaseDisplay: true },
    take: 50,
  });
  console.log(`  stored grocery items named lemons/limes: ${items.length}`);
  for (const i of items.slice(0, 8)) console.log(`     ${i.displayName} ${i.unit} recurring=${i.isRecurringItem} ingredientId=${i.ingredientId ?? "null"} pack="${i.purchaseDisplay ?? "-"}"`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
