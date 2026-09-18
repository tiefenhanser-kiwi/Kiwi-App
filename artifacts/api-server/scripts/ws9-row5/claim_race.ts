// Row 5 · Block 1c (D-WS9-248 step 3) — PROOF of the atomic claim against
// the real database. The hermetic suite cannot exercise pg_advisory_xact_lock
// or FOR UPDATE SKIP LOCKED, so this does:
//
//   1. inserts 12 throwaway `pending` meals (title prefixed so they are
//      unmistakable), userId = the dev user (so nothing here is catalog data)
//   2. runs TWO claims CONCURRENTLY on two separate PrismaClient instances
//      (two connections, two transactions) with the real
//      createPrismaImageQueueStore().claim()
//   3. asserts: the two claimed sets are DISJOINT, and together they hold at
//      most IMAGE_DRAIN_BATCH rows — the second claimer saw the first
//      claimer's rows as in-flight and got the remainder (0 when the budget
//      was already spent). Also asserts FIFO: the claimed ids are the oldest
//      pending rows in createdAt order.
//   4. ALWAYS deletes the throwaway rows (finally) — they must never reach
//      the real drain.
//
//   node --env-file=.env --import tsx scripts/ws9-row5/claim_race.ts
//
// Read-only otherwise: no OpenAI call, no bucket write. The budget it reports
// includes any real generation sent in the last 60 s (the shared ledger).

import { PrismaClient } from "@prisma/client";

import { createPrismaImageQueueStore, IMAGE_DRAIN_BATCH } from "../../src/lib/images/imageQueue";

const PREFIX = "[claim_race throwaway]";

async function main() {
  const a = new PrismaClient();
  const b = new PrismaClient();
  const ids: string[] = [];
  try {
    const owner = await a.user.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
    if (!owner) throw new Error("no user row to own the throwaway meals");
    // Distinct createdAt so FIFO is testable; oldest first.
    const base = Date.now() - 60_000;
    for (let i = 0; i < 12; i++) {
      const m = await a.meal.create({
        data: { userId: owner.id, title: `${PREFIX} ${i}`, imageStatus: "pending", createdAt: new Date(base + i * 1000) },
        select: { id: true },
      });
      ids.push(m.id);
    }
    console.log(`inserted ${ids.length} throwaway pending meals`);

    // Sanity: the store claims from EVERYTHING pending, so report what else
    // is pending right now (should be 0 on the dev DB after the 1c backfill).
    const otherPending = await a.meal.count({ where: { imageStatus: "pending", id: { notIn: ids } } });
    const generating = await a.meal.count({ where: { imageStatus: "generating" } });
    console.log(`other pending rows in the DB: ${otherPending} · generating: ${generating}`);

    const storeA = createPrismaImageQueueStore(a);
    const storeB = createPrismaImageQueueStore(b);
    const t0 = Date.now();
    const [ra, rb] = await Promise.all([storeA.claim(IMAGE_DRAIN_BATCH), storeB.claim(IMAGE_DRAIN_BATCH)]);
    const ms = Date.now() - t0;
    const setA = new Set(ra.claimed.map((r) => r.id));
    const setB = new Set(rb.claimed.map((r) => r.id));
    const overlap = [...setA].filter((id) => setB.has(id));
    console.log(`claim A: ${setA.size} rows · budget ${JSON.stringify(ra.budget)}`);
    console.log(`claim B: ${setB.size} rows · budget ${JSON.stringify(rb.budget)}`);
    console.log(`overlap: ${overlap.length} · total: ${setA.size + setB.size} · wall ${ms} ms`);

    const problems: string[] = [];
    if (overlap.length > 0) problems.push(`DOUBLE CLAIM: ${overlap.join(", ")}`);
    if (setA.size + setB.size > IMAGE_DRAIN_BATCH) problems.push(`CAP EXCEEDED: ${setA.size + setB.size} > ${IMAGE_DRAIN_BATCH}`);
    // FIFO: whichever claim ran first must hold the oldest rows.
    const claimedIds = [...setA, ...setB];
    const expectedOldest = ids.slice(0, claimedIds.length);
    const fifo = claimedIds.every((id) => expectedOldest.includes(id));
    if (!fifo) problems.push(`NOT FIFO: claimed ${claimedIds.join(",")} vs oldest ${expectedOldest.join(",")}`);
    // Every claimed row is now `generating` with attempts = 1.
    const after = await a.meal.findMany({ where: { id: { in: claimedIds } }, select: { id: true, imageStatus: true, imageAttempts: true } });
    for (const r of after) {
      if (r.imageStatus !== "generating" || r.imageAttempts !== 1) problems.push(`row ${r.id} is ${r.imageStatus}/${r.imageAttempts}`);
    }
    // A third claim with everything in flight gets 0 (the budget counts in-flight rows).
    const rc = await storeA.claim(IMAGE_DRAIN_BATCH);
    console.log(`claim C (after A+B, same minute): ${rc.claimed.length} rows · budget ${JSON.stringify(rc.budget)}`);
    if (rc.claimed.length !== Math.max(0, IMAGE_DRAIN_BATCH - rc.budget.recentSends - rc.budget.inFlight)) problems.push("claim C did not honour the budget");

    if (problems.length) {
      console.log("RESULT: FAIL\n  " + problems.join("\n  "));
      process.exitCode = 1;
    } else {
      console.log(`RESULT: PASS — disjoint, ≤ ${IMAGE_DRAIN_BATCH} total, FIFO, generating/attempts=1, third claim honoured the budget`);
    }
  } finally {
    const del = await a.meal.deleteMany({ where: { id: { in: ids } } });
    const leftovers = await a.meal.count({ where: { title: { startsWith: PREFIX } } });
    console.log(`deleted ${del.count} throwaway rows · leftovers with the prefix: ${leftovers}`);
    await a.$disconnect();
    await b.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
