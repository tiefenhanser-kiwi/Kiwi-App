// [grocery] B2 · Part E — the two D1 rows that are not obviously correct.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
for (const [a, b] of [
  ["romaine lettuce", "romaine lettuce hearts"],
  ["chicken broth", "low-sodium chicken broth"],
  ["beef broth", "low-sodium beef broth"],
  ["carrots", "shredded carrots"],
] as [string, string][]) {
  const r = await prisma.ingredientRelation.findMany({
    where: { OR: [
      { from: { canonicalName: a }, to: { canonicalName: b } },
      { from: { canonicalName: b }, to: { canonicalName: a } } ] },
    select: { label: true, confidence: true, reviewedByHuman: true,
      from: { select: { canonicalName: true, purchaseUnit: true, purchaseDisplay: true, defaultUnit: true } },
      to: { select: { canonicalName: true, purchaseUnit: true, purchaseDisplay: true, defaultUnit: true } } },
  });
  console.log(`${a} / ${b}`);
  if (r.length === 0) console.log("   NO EDGE");
  for (const x of r) {
    console.log(`   ${x.label} ${x.from.canonicalName} -> ${x.to.canonicalName} ${x.confidence}${x.reviewedByHuman ? " reviewed" : ""}`);
    console.log(`      from pack=${x.from.purchaseDisplay} [${x.from.purchaseUnit}] du=${x.from.defaultUnit}`);
    console.log(`      to   pack=${x.to.purchaseDisplay} [${x.to.purchaseUnit}] du=${x.to.defaultUnit}`);
  }
}
await prisma.$disconnect();
