// [grocery] B2 · Part B — do the NAME_CLEANINGS keys all exist? And the C population.
import { PrismaClient } from "@prisma/client";
import { NAME_CLEANINGS, lowercaseLead } from "./proposals";
const prisma = new PrismaClient();
const ings = await prisma.ingredient.findMany({ select: { canonicalName: true, displayName: true } });
const byName = new Map(ings.map((i) => [i.canonicalName, i]));
let miss = 0;
for (const c of NAME_CLEANINGS) {
  const hit = byName.get(c.current);
  if (!hit) { miss++; console.log(`  MISSING  ${c.current}`); }
  else if (hit.displayName === c.line) console.log(`  already  ${c.current} -> "${c.line}"`);
}
console.log(`NAME_CLEANINGS: ${NAME_CLEANINGS.length} · missing catalog rows: ${miss}`);
const changed = ings.filter((i) => {
  const cleaned = NAME_CLEANINGS.find((c) => c.current === i.canonicalName);
  const final = cleaned ? cleaned.line : lowercaseLead(i.displayName);
  return final !== i.displayName;
});
console.log(`\nrows whose displayName changes (N then C): ${changed.length}`);
const byClass = { N: 0, C: 0 };
for (const i of changed) {
  if (NAME_CLEANINGS.some((c) => c.current === i.canonicalName)) byClass.N++; else byClass.C++;
}
console.log(`   N (buy-name) ${byClass.N} · C (casing) ${byClass.C}`);
await prisma.$disconnect();
