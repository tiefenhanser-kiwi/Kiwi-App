// CAT-Q0 B — which usage fields carry data (read-only), and the step-less dishes.
//   node --env-file=.env --import tsx scripts/_scratch/cat-q0/probeUsage.ts
import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { CATALOG_WHERE } from "./catalogDb";

const { host, mode } = assertScriptDatabase("cat-q0/probeUsage");
console.log(`database: ${host} (${mode})`);
const prisma = new PrismaClient();
const rows = await prisma.meal.findMany({
  where: CATALOG_WHERE,
  select: {
    id: true, title: true, sourceType: true, dishFamilyKey: true, userId: true, createdAt: true, useCount: true, saveCount: true, likeCount: true, timesCooked: true,
    _count: { select: { planItems: true, templateItems: true, favorites: true, playlistMeals: true } },
    dishLinks: { select: { dish: { select: { id: true, title: true, sourceType: true, createdAt: true } } } },
  },
});
const stepOwners = new Set((await prisma.recipeInstructionStep.findMany({
  where: { ownerType: "dish", ownerId: { in: rows.flatMap((r) => r.dishLinks.map((l) => l.dish.id)) } },
  select: { ownerId: true }, distinct: ["ownerId"],
})).map((s) => s.ownerId));
await prisma.$disconnect();
const nz = (f: (r: (typeof rows)[number]) => number) => {
  const xs = rows.map(f);
  return `nonzero ${xs.filter((x) => x > 0).length}, max ${Math.max(...xs)}, sum ${xs.reduce((a, b) => a + b, 0)}`;
};
console.log(`useCount ${nz((r) => r.useCount)} · saveCount ${nz((r) => r.saveCount)} · likeCount ${nz((r) => r.likeCount)} · timesCooked ${nz((r) => r.timesCooked)}`);
console.log(`planItems ${nz((r) => r._count.planItems)} · templateItems ${nz((r) => r._count.templateItems)} · favorites ${nz((r) => r._count.favorites)} · playlistMeals ${nz((r) => r._count.playlistMeals)}`);
console.log(`\nstep-less dishes in catalog meals:`);
for (const r of rows) for (const l of r.dishLinks) if (!stepOwners.has(l.dish.id)) {
  console.log(`  meal ${r.id} "${r.title}" (meal ${r.sourceType}, key ${r.dishFamilyKey ?? "-"}, owner ${r.userId ?? "null"}, created ${r.createdAt.toISOString().slice(0, 10)}, dishes ${r.dishLinks.length}, planItems ${r._count.planItems}) · dish ${l.dish.id} "${l.dish.title}" (${l.dish.sourceType}, created ${l.dish.createdAt.toISOString().slice(0, 10)})`);
}
