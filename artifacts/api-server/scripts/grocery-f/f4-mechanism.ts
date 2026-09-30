// [grocery] F Part A / F4 — WHICH mechanism filed each misfiled row.
//
// Three candidates: the catalog's own `Ingredient.category`, `inferCategory`
// (the create-time classifier), or the Sonnet final-polish pass. Read-only.
//
//   node --env-file=.env --import tsx scripts/grocery-f/f4-mechanism.ts

import { PrismaClient } from "@prisma/client";

const NAMES = [
  "apple cider vinegar", "red wine vinegar", "white vinegar", "rice vinegar",
  "balsamic vinegar", "worcestershire sauce", "hot sauce", "soy sauce",
  "poblano pepper", "tomatillo", "tomatillos", "serrano chile", "jalapeño",
  "pickled jalapeños", "pickled jalapeño slices",
  "cream of chicken soup", "cream of mushroom soup",
  "fresh green beans", "green beans",
  "chicken broth", "beef broth", "chicken stock",
];

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
  console.log("host check: PASS (dev branch)");
  const prisma = new PrismaClient();
  const rows = await prisma.ingredient.findMany({
    where: { OR: NAMES.map((n) => ({ canonicalName: { contains: n, mode: "insensitive" as const } })) },
    select: { id: true, canonicalName: true, displayName: true, category: true },
    orderBy: { canonicalName: "asc" },
  });
  console.log(`\ncatalog rows matching the misfiled names: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`  ${(r.category ?? "(null)").padEnd(10)}  ${r.canonicalName}`);
  }

  // the whole category histogram, for scale
  const all = await prisma.ingredient.groupBy({
    by: ["category"],
    _count: { _all: true },
  });
  console.log(`\ncatalog category histogram:`);
  for (const a of all.sort((x, y) => y._count._all - x._count._all)) {
    console.log(`  ${String(a._count._all).padStart(5)}  ${a.category ?? "(null)"}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
