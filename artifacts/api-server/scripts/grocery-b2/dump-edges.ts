import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
const h = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!h.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();
const rows = await prisma.ingredientRelation.findMany({
  where: { label: "subsumes" },
  select: { fromIngredientId: true, toIngredientId: true, confidence: true,
    reviewedByHuman: true, rationale: true,
    from: { select: { canonicalName: true, displayName: true, category: true, purchaseDisplay: true } },
    to: { select: { canonicalName: true, displayName: true, category: true, purchaseDisplay: true } } },
});
const used = new Set((await prisma.dishIngredient.groupBy({ by: ["ingredientId"] })).map((u) => u.ingredientId));
const live = rows.filter((r) => used.has(r.fromIngredientId) && used.has(r.toIngredientId)
  && (r.reviewedByHuman || r.confidence === "high"));
writeFileSync("scripts/grocery-b2/out/live-subsumes.json", JSON.stringify(live.map((r) => ({
  generic: r.from.canonicalName, specific: r.to.canonicalName,
  confidence: r.confidence, reviewed: r.reviewedByHuman,
  genericPack: r.from.purchaseDisplay, specificPack: r.to.purchaseDisplay,
})).sort((a, b) => a.generic.localeCompare(b.generic) || a.specific.localeCompare(b.specific)), null, 1));
console.log(`wrote ${live.length} live subsumes edges`);
await prisma.$disconnect();
