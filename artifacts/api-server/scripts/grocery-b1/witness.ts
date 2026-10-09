// [grocery] B1 · Part B — THE MIGRATION WITNESS. READ-ONLY.
//
// §3.1 rule 14: a migrate command is not its own witness. `migrate deploy` and
// `migrate status` both report on the _prisma_migrations ledger; neither one
// reads the column. This does, twice — through the generated client AND through
// raw SQL against information_schema, because a stale generated client would
// make the first read lie.
//
//   node --env-file=.env --import tsx scripts/grocery-b1/witness.ts

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";

assertScriptDatabase("grocery-b1/witness");
const prisma = new PrismaClient();

async function main() {
  console.log("=== information_schema — the columns exist, with their types ===");
  const cols = await prisma.$queryRaw<
    { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
  >`SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'ingredients' AND column_name LIKE 'packYield%'
     ORDER BY column_name`;
  for (const c of cols) {
    console.log(`  ${c.column_name.padEnd(26)} ${c.data_type.padEnd(18)} nullable=${c.is_nullable} default=${c.column_default ?? "-"}`);
  }
  if (cols.length !== 4) throw new Error(`expected 4 packYield columns, found ${cols.length}`);

  console.log("\n=== the generated client READS them ===");
  const rows = await prisma.ingredient.findMany({
    where: { canonicalName: { in: ["garlic", "fresh cilantro", "iceberg lettuce"] } },
    select: {
      canonicalName: true, purchaseUnit: true,
      packYieldUnit: true, packYieldPerPack: true,
      packYieldSource: true, packYieldReviewedByHuman: true,
    },
    orderBy: { canonicalName: "asc" },
  });
  for (const r of rows) {
    console.log(`  ${r.canonicalName.padEnd(18)} pack=${(r.purchaseUnit ?? "-").padEnd(7)} yield=${r.packYieldPerPack ?? "null"} ${r.packYieldUnit ?? ""} source=${r.packYieldSource ?? "null"} human=${r.packYieldReviewedByHuman}`);
  }

  const total = await prisma.ingredient.count();
  const withYield = await prisma.ingredient.count({ where: { packYieldPerPack: { not: null } } });
  const reviewed = await prisma.ingredient.count({ where: { packYieldReviewedByHuman: true } });
  console.log(`\n  ingredients ${total} · with a pack yield ${withYield} · reviewed ${reviewed}`);

  // The DEFAULT is the half a backfill would have had to write. Prove no row is
  // NULL on the boolean, which is what NOT NULL DEFAULT false bought us.
  const nullBool = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "ingredients" WHERE "packYieldReviewedByHuman" IS NULL`;
  console.log(`  rows with a NULL packYieldReviewedByHuman: ${nullBool[0].n} (must be 0)`);
  if (Number(nullBool[0].n) !== 0) throw new Error("the NOT NULL DEFAULT did not take");

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
