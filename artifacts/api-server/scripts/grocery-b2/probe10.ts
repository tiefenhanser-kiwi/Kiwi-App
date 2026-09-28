// [grocery] B2 · A2(c) — is a DEFAULT derivable from columns that already exist?
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
for (const [g, d] of [["chicken thighs", "bone-in skin-on chicken thighs"],
                      ["chicken thighs", "bone-in, skin-on chicken thighs"],
                      ["chicken breast", "boneless skinless chicken breasts"],
                      ["chicken breasts", "boneless skinless chicken breasts"]] as [string,string][]) {
  const r = await prisma.ingredientRelation.findMany({
    where: { OR: [
      { from: { canonicalName: g }, to: { canonicalName: d } },
      { from: { canonicalName: d }, to: { canonicalName: g } } ] },
    select: { label: true, confidence: true, reviewedByHuman: true,
      from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
  });
  console.log(`${g}  /  ${d}:`);
  if (r.length === 0) console.log("    NO EDGE");
  for (const x of r) console.log(`    ${x.label}  ${x.from.canonicalName} -> ${x.to.canonicalName}  ${x.confidence}${x.reviewedByHuman ? " reviewed" : ""}`);
}
// how many generics have NO pack of their own at all?
const used = new Set((await prisma.dishIngredient.groupBy({ by: ["ingredientId"] })).map((u) => u.ingredientId));
const subs = await prisma.ingredientRelation.findMany({
  where: { label: "subsumes" },
  select: { fromIngredientId: true, toIngredientId: true, confidence: true, reviewedByHuman: true,
    from: { select: { canonicalName: true, purchaseUnit: true, purchaseDisplay: true } } },
});
const generics = new Map<string, { pu: string | null; pd: string | null }>();
for (const s of subs) {
  if (!used.has(s.fromIngredientId) || !used.has(s.toIngredientId)) continue;
  if (!(s.reviewedByHuman || s.confidence === "high")) continue;
  generics.set(s.from.canonicalName, { pu: s.from.purchaseUnit, pd: s.from.purchaseDisplay });
}
const noPack = [...generics].filter(([, v]) => !v.pu || !v.pd);
console.log(`\nlive generics: ${generics.size} · with NO pack stated: ${noPack.length}`);
for (const [n, v] of noPack.sort()) console.log(`   ${n}   pu=${v.pu} pd=${v.pd}`);
await prisma.$disconnect();
