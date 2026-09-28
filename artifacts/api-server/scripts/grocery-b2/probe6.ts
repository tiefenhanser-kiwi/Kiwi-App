// [grocery] B2 · Part A — probe 6. READ-ONLY. The R7 parts-as-buy: why each one
// still buys its own line, and whether `fennel` has a bulb row under any name.
import { PrismaClient } from "@prisma/client";
import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
const h = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!h.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();
const idx = await loadRelationIndex(prisma);

const NAMES = ["bay leaves", "fresh basil leaves", "fresh sage leaves",
  "iceberg lettuce leaves", "fennel fronds"];
for (const n of NAMES) {
  const row = await prisma.ingredient.findFirst({
    where: { canonicalName: n },
    select: { id: true, canonicalName: true, displayName: true, category: true,
              defaultUnit: true, purchaseUnit: true, purchaseDisplay: true,
              packYieldUnit: true, packYieldPerPack: true },
  });
  console.log(`\n### ${n}`);
  if (!row) { console.log("   NO CATALOG ROW"); continue; }
  console.log(`   ${JSON.stringify(row)}`);
  const edges = await prisma.ingredientRelation.findMany({
    where: { OR: [{ fromIngredientId: row.id }, { toIngredientId: row.id }] },
    select: { label: true, yieldQuantity: true, yieldUnit: true, coHarvestable: true,
      confidence: true, reviewedByHuman: true,
      from: { select: { canonicalName: true, defaultUnit: true, purchaseUnit: true } },
      to: { select: { canonicalName: true } } },
  });
  for (const e of edges) console.log(`   edge ${e.label}: ${e.from.canonicalName} [du=${e.from.defaultUnit} pu=${e.from.purchaseUnit}] -> ${e.to.canonicalName}  ${e.yieldQuantity ?? "-"} ${e.yieldUnit ?? ""} coH=${e.coHarvestable} ${e.confidence}${e.reviewedByHuman ? " reviewed" : ""}`);
  const asChild = idx.componentParents.filter((p) => p.slots.some((s) => s.childNames.includes(n) || s.child === n));
  console.log(`   admitted as a pool child of: ${asChild.map((p) => p.parent).join(", ") || "(none)"}`);
}

console.log(`\n### does a FENNEL BULB row exist under any name?`);
const fen = await prisma.ingredient.findMany({
  where: { canonicalName: { contains: "fennel" } },
  select: { canonicalName: true, displayName: true, category: true, defaultUnit: true, purchaseUnit: true, purchaseDisplay: true },
});
for (const f of fen) console.log(`   ${JSON.stringify(f)}`);

console.log(`\n### the corpus pairs §3.3 names`);
for (const n of ["chicken thighs", "boneless skinless chicken thighs", "shredded cheddar",
                 "shredded sharp cheddar", "shredded cheddar cheese", "shredded sharp cheddar cheese",
                 "bell peppers", "red bell pepper", "parsley", "fresh flat-leaf parsley"]) {
  const r = await prisma.ingredient.findFirst({ where: { canonicalName: n },
    select: { id: true, canonicalName: true, displayName: true, purchaseDisplay: true } });
  console.log(`   ${n.padEnd(36)} ${r ? `${r.id.slice(0,8)} display="${r.displayName}" pack="${r.purchaseDisplay}"` : "NO ROW"}`);
}
await prisma.$disconnect();
