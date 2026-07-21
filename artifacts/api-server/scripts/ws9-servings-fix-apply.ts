// D-WS9-053 §5C.0 — apply ws9-servings-fix-dryrun.csv. Updates Meal.servingsDefault
// AND every child Dish.servingsDefault in LOCK-STEP (a transaction) so the
// recompute (which divides by dish.servingsDefault) uses the corrected divisor.
// Only rows where proposedServings != currentServings are written. Idempotent.
// Does NOT touch stored macros — the recompute (5C.1) recomputes per-serving.
// Run: node --env-file=.env --import tsx scripts/ws9-servings-fix-apply.ts [--apply]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseCsv } from "./ws7-8b-usda-backfill";

const APPLY = process.argv.includes("--apply");
const CSV = join(process.cwd(), "scripts", "output", "ws9-servings-fix-dryrun.csv");
const prisma = new PrismaClient();
try {
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  const [header, ...data] = rows;
  // 0 mealId,1 title,2 currentServings,3 proposedServings
  if (header[0] !== "mealId" || header[3] !== "proposedServings") throw new Error(`unexpected header: ${header.join(",")}`);
  let written = 0, unchanged = 0;
  for (const r of data) {
    const mealId = r[0], cur = Number(r[2]), prop = Number(r[3]);
    if (!mealId || !Number.isFinite(prop) || prop <= 0) continue;
    if (prop === cur) { console.log(`  (review-only, no change): ${r[1]}  servings ${cur}`); continue; }
    const meal = await prisma.meal.findUnique({ where: { id: mealId }, include: { dishLinks: { include: { dish: { select: { id: true, servingsDefault: true } } } } } });
    if (!meal) { console.warn(`  skip (meal gone): ${mealId}`); continue; }
    const dishIds = meal.dishLinks.map((dl) => dl.dish.id);
    const alreadyDone = meal.servingsDefault === prop && meal.dishLinks.every((dl) => dl.dish.servingsDefault === prop);
    if (alreadyDone) { unchanged++; console.log(`  unchanged (already ${prop}): ${meal.title} + ${dishIds.length} dishes`); continue; }
    console.log(`  ${APPLY ? "WRITE" : "would-write"}: ${meal.title}  meal ${meal.servingsDefault}→${prop}  + ${dishIds.length} child dishes [${meal.dishLinks.map((dl) => dl.dish.servingsDefault).join(",")}]→${prop}`);
    if (APPLY) {
      await prisma.$transaction([
        prisma.meal.update({ where: { id: mealId }, data: { servingsDefault: prop } }),
        ...dishIds.map((id) => prisma.dish.update({ where: { id }, data: { servingsDefault: prop } })),
      ]);
    }
    written++;
  }
  console.log(`\n--- ${APPLY ? "APPLIED" : "DRY-RUN (pass --apply)"} --- written: ${written}  unchanged: ${unchanged}`);

  if (APPLY) {
    const m = await prisma.meal.findUnique({ where: { id: "4c1a206d-d9eb-4ab4-9cbf-b2d5f9166f5e" }, include: { dishLinks: { include: { dish: { select: { title: true, servingsDefault: true } } } } } });
    console.log(`\nVERIFY Whole Chicken: meal.servingsDefault=${m!.servingsDefault}`);
    for (const dl of m!.dishLinks) console.log(`   dish "${dl.dish.title}" servingsDefault=${dl.dish.servingsDefault}`);
  }
} finally { await prisma.$disconnect(); }
