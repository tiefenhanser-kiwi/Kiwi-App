// CAT-QUICK-1 — images for this lane's meals only, through the image queue's own drain
// (runImageDrain on the live wiring: the house prompt, the bucket, markReady). The queue's claim is
// FIFO over every pending row on dev (120 older private rows sat ahead of ours on Oct 30), so the
// store here claims only `kq1-` catalog meals; loading, marking and releasing are the queue's own.
// One tick a minute (the org's 5 images/min). Dev only; dry unless --apply. Spend lands in
// scripts/output/cat-quick-1/images-spend.json.
//
//   node --env-file=.env --import tsx scripts/cat-quick-1/images.ts [--apply]
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { IMAGE_DRAIN_BATCH, IMAGE_MAX_ATTEMPTS, createPrismaImageQueueStore, runImageDrain, type ClaimedImageRow, type ImageQueueStore } from "../../src/lib/images/imageQueue";
import { createLiveImageDrainDeps } from "../../src/lib/images/live";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { KEY_PREFIX } from "./targets";

const OUT = "scripts/output/cat-quick-1";
const SPEND = join(OUT, "images-spend.json");
const mine = { userId: null, isArchived: false, dishFamilyKey: { startsWith: KEY_PREFIX } } as const;

function laneStore(prisma: PrismaClient): ImageQueueStore {
  const base = createPrismaImageQueueStore(prisma);
  return {
    ...base,
    async claim(batch) {
      const rows = await prisma.meal.findMany({ where: { ...mine, imageStatus: "pending", imageAttempts: { lt: IMAGE_MAX_ATTEMPTS } }, orderBy: { createdAt: "asc" }, take: batch, select: { id: true } });
      const claimed: ClaimedImageRow[] = [];
      for (const r of rows) {
        const n = await prisma.meal.updateMany({ where: { id: r.id, imageStatus: "pending" }, data: { imageStatus: "generating", imageAttempts: { increment: 1 } } });
        if (n.count !== 1) continue;
        const m = await prisma.meal.findUniqueOrThrow({ where: { id: r.id }, select: { id: true, title: true, userId: true, imageAttempts: true } });
        claimed.push(m);
      }
      return { claimed, requeuedStuck: 0, failedOutIds: [], budget: { recentSends: 0, inFlight: 0, limit: batch } };
    },
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { host, mode } = assertScriptDatabase("cat-quick-1/images");
  if (mode !== "dev") throw new Error("dev only");
  const prisma = new PrismaClient();
  const pending = await prisma.meal.count({ where: { ...mine, imageStatus: "pending" } });
  console.log(`database: ${host} (${mode}) · kq1 meals pending an image: ${pending} · ${apply ? "APPLY" : "dry run"}`);
  if (!apply) { await prisma.$disconnect(); return; }
  const deps = { ...createLiveImageDrainDeps(prisma), store: laneStore(prisma), batch: IMAGE_DRAIN_BATCH };
  let spent: { usd: number; images: number } = existsSync(SPEND) ? JSON.parse(readFileSync(SPEND, "utf8")) : { usd: 0, images: 0 };
  for (;;) {
    const t0 = Date.now();
    const s = await runImageDrain(deps);
    spent = { usd: spent.usd + s.costEstimateUsd, images: spent.images + s.ready };
    writeFileSync(SPEND, JSON.stringify(spent));
    console.log(`tick: claimed ${s.claimed} · ready ${s.ready} · retried ${s.retried} · failed ${s.failed} · deferred ${s.deferred} · $${s.costEstimateUsd.toFixed(4)} · lane images $${spent.usd.toFixed(4)}`);
    if (s.claimed === 0) break;
    await new Promise((r) => setTimeout(r, Math.max(0, 61_000 - (Date.now() - t0))));
  }
  const left = await prisma.meal.groupBy({ by: ["imageStatus"], where: mine, _count: true });
  console.log(`kq1 image status: ${left.map((g) => `${g.imageStatus} ${g._count}`).join(" · ")}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
