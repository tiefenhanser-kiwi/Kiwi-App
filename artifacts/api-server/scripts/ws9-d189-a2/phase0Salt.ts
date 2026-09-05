// Phase 0 probe 6 — does the synonym set fold SALTS or PEPPERCORNS, the two
// families BUG-168 / Hans's LOCKED device-item-8 ruling deliberately withdrew
// from merge folding? READ ONLY.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const FAMILIES = ["salt", "peppercorn", "sugar", "oil", "onion", "butter"];
async function main() {
  const syn = await prisma.ingredientRelation.findMany({
    where: { label: "synonym" },
    include: { from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
  });
  for (const f of FAMILIES) {
    const hits = syn.filter((s) => s.from.canonicalName.includes(f) || s.to.canonicalName.includes(f));
    console.log(`\n=== synonym edges touching "${f}": ${hits.length} ===`);
    for (const h of hits.sort((a, b) => a.from.canonicalName.localeCompare(b.from.canonicalName))) {
      console.log(`  ${h.from.canonicalName}  <->  ${h.to.canonicalName}   [${h.confidence}, ${h.source}${h.reviewedByHuman ? ", HUMAN" : ""}]`);
    }
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
