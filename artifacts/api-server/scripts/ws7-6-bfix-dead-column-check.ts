// WS7-6 B-fix Phase 0.1 — dead-column check on Dish.
//
// The Phase 0 census flagged Dish.lastUsedAt and Dish.timesCooked as columns
// with no observable write path in artifacts/api-server/src/. This script
// asks the DB directly so we don't ship a sort feature on top of dead data.
//
// Run: pnpm --filter @workspace/api-server exec tsx scripts/ws7-6-bfix-dead-column-check.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const total = await prisma.dish.count();
  const lastUsedRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "dishes" WHERE "lastUsedAt" IS NOT NULL
  `;
  const timesCookedRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "dishes" WHERE "timesCooked" > 0
  `;
  const lastUsedCount = Number(lastUsedRows[0]?.count ?? 0);
  const timesCookedCount = Number(timesCookedRows[0]?.count ?? 0);
  console.log(JSON.stringify({
    totalDishes: total,
    lastUsedAt_nonNull: lastUsedCount,
    timesCooked_gt0: timesCookedCount,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
