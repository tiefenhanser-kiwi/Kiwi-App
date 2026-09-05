// Isolate the REAL under-buy: two co-harvestable slots that are the SAME
// product (juice vs fresh juice), as opposed to genuinely different
// derivations (juice vs zest) where max() is correct.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const SAME_PRODUCT = /juice/;
async function main() {
  const raw = await prisma.ingredientRelation.findMany({
    include: { from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
  });
  // For each component parent, group its children by a crude product key and
  // report where >1 child shares it. Then report what label (if any) joins them.
  const comp = raw.filter((r) => r.label === "component");
  const byParent = new Map<string, string[]>();
  for (const c of comp) {
    const k = c.from.canonicalName;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(c.to.canonicalName);
  }
  console.log("=== parents whose children include >1 name matching /juice/ ===");
  const pairsToCheck: [string, string][] = [];
  for (const [p, kids] of byParent) {
    const j = kids.filter((k) => SAME_PRODUCT.test(k));
    if (j.length < 2) continue;
    console.log(`  ${p}: ${j.join("  |  ")}`);
    for (let i = 0; i < j.length; i++) for (let k = i + 1; k < j.length; k++) pairsToCheck.push([j[i], j[k]]);
  }
  console.log(`\n=== what label joins each same-product child pair? ===`);
  const names = [...new Set(pairsToCheck.flat())];
  const rows = await prisma.ingredient.findMany({ where: { canonicalName: { in: names } }, select: { id: true, canonicalName: true } });
  const id = new Map(rows.map((r) => [r.canonicalName, r.id]));
  const seen = new Set<string>();
  for (const [a, b] of pairsToCheck) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue; seen.add(key);
    const ia = id.get(a), ib = id.get(b);
    let label = "BOTH ROWS NOT FOUND";
    if (ia && ib) {
      const e = await prisma.ingredientRelation.findFirst({
        where: { OR: [{ fromIngredientId: ia, toIngredientId: ib }, { fromIngredientId: ib, toIngredientId: ia }] },
        select: { label: true, confidence: true },
      });
      label = e ? `${e.label} (${e.confidence})` : "NO EDGE AT ALL";
    }
    console.log(`  ${a}  <->  ${b}   :  ${label}`);
  }
}
main().then(()=>prisma.$disconnect()).catch(async(e)=>{console.error(e);await prisma.$disconnect();process.exit(1);});
