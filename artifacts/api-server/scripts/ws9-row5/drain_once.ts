// Row 5 · Block 1c (D-WS9-248) — ONE tick of the image queue's drain from a
// dev box, without the HTTP route or Cloud Scheduler: the same runImageDrain
// the route calls, on the live wiring (real DB, real OpenAI key, real bucket
// via ADC). What a scheduler tick does, run by hand.
//
//   node --env-file=.env --import tsx scripts/ws9-row5/drain_once.ts           # claims ≤ 5 pending rows, generates, uploads, writes ready
//   node --env-file=.env --import tsx scripts/ws9-row5/drain_once.ts --dry     # the claim budget + what WOULD be claimed; writes nothing
//
// ⚠️ Spends money (≤ 5 × ~$0.009) and takes up to five of the org's 5/min
// slots — do not run it while a scheduler is draining the same database.

import { PrismaClient } from "@prisma/client";

import { createLiveImageDrainDeps } from "../../src/lib/images/live";
import { IMAGE_DRAIN_BATCH, runImageDrain } from "../../src/lib/images/imageQueue";

const DRY = process.argv.includes("--dry");

async function main() {
  const prisma = new PrismaClient();
  try {
    const pending = await prisma.meal.count({ where: { imageStatus: "pending" } });
    const generating = await prisma.meal.count({ where: { imageStatus: "generating" } });
    console.log(`queue: pending ${pending} · generating ${generating}`);
    if (DRY) {
      const next = await prisma.meal.findMany({
        where: { imageStatus: "pending" },
        orderBy: { createdAt: "asc" },
        take: IMAGE_DRAIN_BATCH,
        select: { id: true, title: true, userId: true, imageAttempts: true, sourceStoreMealId: true, createdAt: true },
      });
      console.table(next);
      console.log("DRY — nothing claimed.");
      return;
    }
    const summary = await runImageDrain(createLiveImageDrainDeps(prisma));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
