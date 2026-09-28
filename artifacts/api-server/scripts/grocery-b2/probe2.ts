// [grocery] B2 · Part A — probe 2. READ-ONLY. How big is the LIVE subsumes population?
import { PrismaClient } from "@prisma/client";
const h = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!h.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const rows = await prisma.ingredientRelation.findMany({
  where: { label: "subsumes" },
  select: {
    fromIngredientId: true, toIngredientId: true, confidence: true,
    reviewedByHuman: true,
    from: { select: { canonicalName: true } },
    to: { select: { canonicalName: true } },
  },
});

// which ingredient ids are actually reachable from a dish?
const used = await prisma.dishIngredient.groupBy({
  by: ["ingredientId"],
  _count: { _all: true },
});
const useCount = new Map(used.map((u) => [u.ingredientId, u._count._all]));
console.log(`distinct ingredientIds on dish_ingredients: ${useCount.size}`);

// restrict to PUBLIC / non-deleted dishes too
const pubRows = await prisma.$queryRawUnsafe<{ ingredientId: string; n: bigint }[]>(
  `SELECT di."ingredientId", COUNT(*)::bigint AS n
     FROM dish_ingredients di
     JOIN dishes d ON d.id = di."dishId"
    GROUP BY di."ingredientId"`,
);
console.log(`(same via raw join): ${pubRows.length}`);

const admitted = (r: typeof rows[number]) => r.reviewedByHuman || r.confidence === "high";
let bothUsed = 0, bothUsedAdmitted = 0, admittedN = 0;
const live: typeof rows = [];
for (const r of rows) {
  if (admitted(r)) admittedN++;
  const a = useCount.has(r.fromIngredientId);
  const b = useCount.has(r.toIngredientId);
  if (a && b) {
    bothUsed++;
    if (admitted(r)) { bothUsedAdmitted++; live.push(r); }
  }
}
console.log(`subsumes total ${rows.length} · admitted(gate) ${admittedN} · both endpoints used by a dish ${bothUsed} · both+admitted ${bothUsedAdmitted}`);

// how many distinct GENERICS (from side) do the live edges cover?
const byGeneric = new Map<string, string[]>();
for (const r of live) {
  const k = r.from.canonicalName;
  (byGeneric.get(k) ?? byGeneric.set(k, []).get(k)!).push(r.to.canonicalName);
}
console.log(`live generics: ${byGeneric.size}`);
for (const [g, ss] of [...byGeneric].sort()) {
  console.log(`  ${g}  ⊇  ${ss.sort().join(" | ")}`);
}
await prisma.$disconnect();
