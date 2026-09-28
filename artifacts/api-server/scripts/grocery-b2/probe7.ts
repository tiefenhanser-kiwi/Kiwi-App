import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
for (const [g, s] of [["chicken thighs","boneless skinless chicken thighs"],
                      ["shredded cheddar cheese","shredded sharp cheddar cheese"],
                      ["parsley","fresh parsley"],["parsley","fresh flat-leaf parsley"],
                      ["romaine lettuce","romaine lettuce hearts"]] as [string,string][]) {
  const r = await prisma.ingredientRelation.findMany({
    where: { OR: [
      { from: { canonicalName: g }, to: { canonicalName: s } },
      { from: { canonicalName: s }, to: { canonicalName: g } } ] },
    select: { label: true, confidence: true, reviewedByHuman: true,
      from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
  });
  console.log(`${g} / ${s}: ${r.length === 0 ? "NO EDGE" : r.map((x)=>`${x.label} ${x.from.canonicalName}->${x.to.canonicalName} ${x.confidence}${x.reviewedByHuman?" reviewed":""}`).join(" | ")}`);
}
await prisma.$disconnect();
