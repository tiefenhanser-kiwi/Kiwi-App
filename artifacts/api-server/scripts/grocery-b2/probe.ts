// [grocery] B2 · Part A — probe 1. READ-ONLY. The subsumes table, end to end.
import { PrismaClient } from "@prisma/client";
const h = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!h.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const rows = await prisma.ingredientRelation.findMany({
  where: { label: "subsumes" },
  select: {
    fromIngredientId: true, toIngredientId: true, confidence: true,
    reviewedByHuman: true, source: true, rationale: true,
    from: { select: { canonicalName: true, displayName: true, category: true } },
    to: { select: { canonicalName: true, displayName: true, category: true } },
  },
});
console.log(`subsumes rows: ${rows.length}`);
const byConf = new Map<string, number>();
let reviewed = 0;
for (const r of rows) {
  byConf.set(r.confidence, (byConf.get(r.confidence) ?? 0) + 1);
  if (r.reviewedByHuman) reviewed++;
}
console.log("by confidence:", [...byConf].map(([k, v]) => `${k}=${v}`).join(" "));
console.log(`reviewedByHuman: ${reviewed}`);
const bySource = new Map<string, number>();
for (const r of rows) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
console.log("by source:", [...bySource].map(([k, v]) => `${k}=${v}`).join(" "));

// other labels, for the record
for (const lbl of ["synonym", "component", "distinct"] as const) {
  const n = await prisma.ingredientRelation.count({ where: { label: lbl } });
  console.log(`${lbl}: ${n}`);
}
await prisma.$disconnect();
