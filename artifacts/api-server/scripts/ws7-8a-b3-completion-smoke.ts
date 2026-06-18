// WS7-8a B3 — PrepStepCompletion Prisma-layer smoke (no AI, no HTTP).
//
// Validates the exact query shapes the completion endpoints + orphan-prune use
// against real Neon, which the stubbed route tests cannot prove:
//   1. compound-unique upsert  where: { planId_stepKey: { planId, stepKey } }
//   2. idempotent re-check (checkedAt preserved)
//   3. findMany ordered by checkedAt
//   4. orphan-prune  deleteMany where: { planId, stepKey: { notIn: [...] } }
//   5. exact uncheck deleteMany where: { planId, stepKey }
//   6. FK cascade — deleting the plan removes its completion rows
//
// Synthetic throwaway user+plan (fixed IDs); teardown at start AND end.
//
// Run: pnpm --filter @workspace/api-server exec tsx scripts/ws7-8a-b3-completion-smoke.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const USER_ID = "00000000-b300-4111-8111-000000000001";
const PLAN_ID = "00000000-b300-4111-8111-000000000002";
const USER_EMAIL = "smoke-ws7-8a-b3@example.invalid";

const K1 = "produce#11111111-1111-4111-8111-111111111111";
const K2 = "proteins#22222222-2222-4222-8222-222222222222";
const K_ORPHAN = "seasonings_dry#blend";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  const mark = cond ? "✔" : "✖";
  if (!cond) failures += 1;
  console.log(`  ${mark} ${label}${cond ? "" : `  →  ${JSON.stringify(detail)}`}`);
}

async function teardown() {
  // Completions cascade with the plan, but delete explicitly in case the plan
  // row was already gone from a prior partial run.
  await prisma.prepStepCompletion.deleteMany({ where: { planId: PLAN_ID } });
  await prisma.mealPlanInstance.deleteMany({ where: { id: PLAN_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

async function main() {
  console.log("WS7-8a B3 — PrepStepCompletion Prisma smoke\n");
  await teardown();

  await prisma.user.create({
    data: { id: USER_ID, email: USER_EMAIL, firstName: "Smoke", lastName: "B3" },
  });
  await prisma.mealPlanInstance.create({
    data: { id: PLAN_ID, userId: USER_ID },
  });

  // 1 + 2 — upsert twice; second is a no-op that keeps the original checkedAt.
  const first = await prisma.prepStepCompletion.upsert({
    where: { planId_stepKey: { planId: PLAN_ID, stepKey: K1 } },
    create: { planId: PLAN_ID, stepKey: K1 },
    update: {},
  });
  const reCheck = await prisma.prepStepCompletion.upsert({
    where: { planId_stepKey: { planId: PLAN_ID, stepKey: K1 } },
    create: { planId: PLAN_ID, stepKey: K1 },
    update: {},
  });
  check("compound-unique upsert creates a row", !!first.id, first);
  check(
    "idempotent re-check keeps original checkedAt",
    first.checkedAt.getTime() === reCheck.checkedAt.getTime(),
    { first: first.checkedAt, reCheck: reCheck.checkedAt },
  );

  await prisma.prepStepCompletion.upsert({
    where: { planId_stepKey: { planId: PLAN_ID, stepKey: K2 } },
    create: { planId: PLAN_ID, stepKey: K2 },
    update: {},
  });
  await prisma.prepStepCompletion.upsert({
    where: { planId_stepKey: { planId: PLAN_ID, stepKey: K_ORPHAN } },
    create: { planId: PLAN_ID, stepKey: K_ORPHAN },
    update: {},
  });

  // 3 — findMany ordered.
  const all = await prisma.prepStepCompletion.findMany({
    where: { planId: PLAN_ID },
    orderBy: { checkedAt: "asc" },
    select: { stepKey: true, checkedAt: true },
  });
  check("findMany returns all 3 rows", all.length === 3, all.map((r) => r.stepKey));

  // 4 — orphan-prune: keep K1 + K2, drop K_ORPHAN.
  const pruned = await prisma.prepStepCompletion.deleteMany({
    where: { planId: PLAN_ID, stepKey: { notIn: [K1, K2] } },
  });
  const afterPrune = await prisma.prepStepCompletion.findMany({
    where: { planId: PLAN_ID },
    select: { stepKey: true },
  });
  const keysAfter = afterPrune.map((r) => r.stepKey).sort();
  check("notIn prune removed exactly the orphan", pruned.count === 1, pruned);
  check(
    "prune kept the two still-valid keys",
    keysAfter.length === 2 && keysAfter.includes(K1) && keysAfter.includes(K2),
    keysAfter,
  );

  // 5 — exact uncheck.
  await prisma.prepStepCompletion.deleteMany({ where: { planId: PLAN_ID, stepKey: K1 } });
  const afterUncheck = await prisma.prepStepCompletion.findMany({
    where: { planId: PLAN_ID },
    select: { stepKey: true },
  });
  check(
    "exact deleteMany unchecks just that key",
    afterUncheck.length === 1 && afterUncheck[0].stepKey === K2,
    afterUncheck.map((r) => r.stepKey),
  );

  // 6 — FK cascade on plan delete.
  await prisma.mealPlanInstance.delete({ where: { id: PLAN_ID } });
  const afterCascade = await prisma.prepStepCompletion.findMany({
    where: { planId: PLAN_ID },
  });
  check("deleting the plan cascade-deletes its completions", afterCascade.length === 0, afterCascade);

  await prisma.user.deleteMany({ where: { id: USER_ID } });

  console.log(`\n${failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    await teardown().catch(() => {});
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
