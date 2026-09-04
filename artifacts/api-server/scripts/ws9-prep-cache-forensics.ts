// WS9 §4 — READ-ONLY forensics on the prep-week cache row.
//
// SELECT-ONLY. Decides between the two explanations for the 09-03 pattern of
// three full-week regenerations with byte-identical payloads:
//   (A) revisionId really was bumped between each call (invalidation too broad)
//   (B) the cache WRITE has been failing silently (prep_week_cache_write_failed
//       is logged at warn and never bubbles) — every open regenerates forever
//
// Run: pnpm --filter @workspace/api-server exec tsx scripts/ws9-prep-cache-forensics.ts [planIdPrefix]

import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* set some other way */
  }
}

const prisma = new PrismaClient();
const prefix = process.argv[2] ?? "3d2fdff3";

async function main() {
  const plan = await prisma.mealPlanInstance.findFirst({
    where: { id: { startsWith: prefix } },
  });
  if (!plan) throw new Error(`no plan starting ${prefix}`);

  console.log(`plan ${plan.id}`);
  console.log(`  revisionId       = ${plan.revisionId}`);
  console.log(`  createdAt        = ${plan.createdAt.toISOString()}`);
  console.log(`  updatedAt        = ${plan.updatedAt.toISOString()}`);

  const row = await prisma.prepWeekStructure.findUnique({
    where: { planId: plan.id },
    select: {
      id: true,
      lastGeneratedFromPlanRevisionId: true,
      lastGeneratedAt: true,
      promptVersion: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  console.log(`\nprepWeekStructure row:`);
  if (!row) {
    console.log("  🔴 ABSENT — no cache row exists for this plan at all.");
  } else {
    console.log(`  lastGeneratedFromPlanRevisionId = ${row.lastGeneratedFromPlanRevisionId}`);
    console.log(`  lastGeneratedAt                 = ${row.lastGeneratedAt.toISOString()}`);
    console.log(`  promptVersion                   = ${row.promptVersion}`);
    console.log(`  createdAt                       = ${row.createdAt.toISOString()}`);
    console.log(`  updatedAt                       = ${row.updatedAt.toISOString()}`);
    console.log(
      `\n  VERDICT: cache ${row.lastGeneratedFromPlanRevisionId === plan.revisionId ? "WOULD HIT" : "WOULD MISS"} right now ` +
        `(row rev ${row.lastGeneratedFromPlanRevisionId} vs plan rev ${plan.revisionId})`
    );
  }

  // Fleet-wide: is the write failing generally, or only here?
  const allPlans = await prisma.mealPlanInstance.count();
  const allRows = await prisma.prepWeekStructure.count();
  console.log(`\nfleet: ${allRows} prepWeekStructure rows / ${allPlans} plans`);

  const stale = await prisma.$queryRaw<
    Array<{ planId: string; rowRev: number; planRev: number; lastGeneratedAt: Date }>
  >`
    SELECT s."planId", s."lastGeneratedFromPlanRevisionId" AS "rowRev",
           p."revisionId" AS "planRev", s."lastGeneratedAt"
    FROM prep_week_structures s
    JOIN meal_plan_instances p ON p.id = s."planId"
    ORDER BY s."lastGeneratedAt" DESC
    LIMIT 20
  `;
  console.log(`\nmost-recent 20 cache rows (rowRev vs planRev):`);
  for (const r of stale) {
    const mark = r.rowRev === r.planRev ? "hit " : "MISS";
    console.log(
      `  ${mark} plan=${r.planId.slice(0, 8)} rowRev=${String(r.rowRev).padStart(3)} planRev=${String(r.planRev).padStart(3)} at=${r.lastGeneratedAt.toISOString()}`
    );
  }

  // PrepStepCompletion rows survive only if the write path ran (it prunes).
  const completions = await prisma.prepStepCompletion.count({
    where: { planId: plan.id },
  });
  console.log(`\nprepStepCompletion rows for this plan: ${completions}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
