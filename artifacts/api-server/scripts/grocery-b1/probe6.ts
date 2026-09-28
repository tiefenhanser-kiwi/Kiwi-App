import { PrismaClient } from "@prisma/client";
import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
const prisma = new PrismaClient();
async function main() {
  const idx = await loadRelationIndex(prisma);
  for (const n of ["parsley", "fresh parsley", "flat-leaf parsley", "fresh flat-leaf parsley", "fresh flat-leaf parsley leaves"]) {
    console.log(`  groupKey("${n}") = "${idx.groupKey(n)}"   synonymFold = "${idx.synonymFold(n)}"`);
  }
  for (const cp of idx.componentParents) {
    if (!/parsley|lime/.test(cp.parent)) continue;
    console.log(`  PARENT ${cp.parent} [${cp.basisUnit}] slots: ${cp.slots.map((s) => `${s.child}=${s.yieldQuantity}${s.yieldUnit}${s.coHarvestable ? " co" : ""} <- [${s.childNames.join(", ")}]`).join(" ; ")}`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
