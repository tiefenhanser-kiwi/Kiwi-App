import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const med = await prisma.ingredientRelation.findMany({
    where: { label: "synonym", confidence: "medium" },
    include: { from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
  });
  console.log(`medium synonym edges: ${med.length}`);
  for (const m of med.sort((a,b)=>a.from.canonicalName.localeCompare(b.from.canonicalName)))
    console.log(`  ${m.from.canonicalName}  <->  ${m.to.canonicalName}${m.reviewedByHuman ? "  HUMAN" : ""}`);
  const hum = await prisma.ingredientRelation.findMany({
    where: { label: "synonym", reviewedByHuman: true },
    include: { from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
  });
  console.log(`\nreviewedByHuman synonym edges: ${hum.length}`);
  for (const m of hum) console.log(`  ${m.from.canonicalName}  <->  ${m.to.canonicalName}  [${m.confidence}, ${m.source}]`);
}
main().then(()=>prisma.$disconnect()).catch(async(e)=>{console.error(e);await prisma.$disconnect();process.exit(1);});
