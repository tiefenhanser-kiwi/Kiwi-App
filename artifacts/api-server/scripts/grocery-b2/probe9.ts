import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
for (const n of ["bone-in chicken thighs", "bone-in skin-on chicken thighs",
  "bone-in, skin-on chicken thighs", "chicken thighs", "chicken breast",
  "chicken breasts", "boneless skinless chicken breasts", "bone-in, skinless chicken thighs"]) {
  const r = await prisma.ingredient.findFirst({ where: { canonicalName: n },
    select: { canonicalName: true, displayName: true, purchaseUnit: true, purchaseDisplay: true } });
  console.log(`  ${n.padEnd(36)} ${r ? `display="${r.displayName}" pu=${r.purchaseUnit} pack="${r.purchaseDisplay}"` : "NO ROW"}`);
}
console.log("\nrows whose canonical mentions skin-on:");
for (const r of await prisma.ingredient.findMany({ where: { canonicalName: { contains: "skin-on" } },
  select: { canonicalName: true } })) console.log("   " + r.canonicalName);
await prisma.$disconnect();
