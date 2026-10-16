// PREP-1 G (BUG-418) — re-stamp the derived times of the thx2-* meals.
//
// stampMealTiming now leaves a `thanksgiving-feast` meal's make-ahead runs off
// Thursday's clock; every meal stamped before that change still carries the old
// numbers. This recomputes and stores them for the thx2-* meals ONLY (by
// dishFamilyKey), through the same stampMealTiming every save path calls. A meal
// not tagged `thanksgiving-feast` re-stamps to the number it already has.
//
// Dry run by default (computes inside a transaction that is rolled back); --apply
// writes. Dev by host; production only when KIWI_PRODUCTION_HOST names the host.
//   node --env-file=.env --import tsx scripts/prep1/restampThxTimes.ts [--apply]

import { PrismaClient } from "@prisma/client";

import { stampMealTiming } from "../../src/lib/mealTiming";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";

const { host, mode } = assertScriptDatabase("prep-1 restampThxTimes");
const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();
class DryRun extends Error {}

async function main() {
  console.log(`host ${host} (${mode}) · ${APPLY ? "APPLY" : "dry run — nothing is written (add --apply)"}`);
  const meals = await prisma.meal.findMany({
    where: { dishFamilyKey: { startsWith: "thx2-" } },
    select: {
      id: true, dishFamilyKey: true, title: true, tags: true, sourceType: true,
      estimatedTimeMinutes: true, activeTimeMinutes: true,
      dishLinks: { orderBy: { positionIndex: "asc" }, select: { dishId: true } },
    },
    orderBy: [{ dishFamilyKey: "asc" }, { id: "asc" }],
  });
  let changed = 0;
  for (const m of meals) {
    const dishIds = m.dishLinks.map((l) => l.dishId);
    let after: { total: number | null; active: number | null } = { total: null, active: null };
    try {
      await prisma.$transaction(async (tx) => {
        const t = await stampMealTiming(tx, m.id, dishIds);
        after = { total: t.totalMinutes, active: t.activeMinutes };
        if (!APPLY) throw new DryRun();
      }, { timeout: 30_000 });
    } catch (err) {
      if (!(err instanceof DryRun)) throw err;
    }
    // A null derive leaves the stored numbers as they were (stampMealTiming fails open).
    const total = after.total ?? m.estimatedTimeMinutes;
    const active = after.total === null ? m.activeTimeMinutes : after.active;
    const moved = total !== m.estimatedTimeMinutes || active !== m.activeTimeMinutes;
    if (moved) changed += 1;
    console.log(
      `  ${(m.dishFamilyKey ?? "").padEnd(42)} ${m.tags.includes("thanksgiving-feast") ? "FEAST" : "     "} ` +
        `${String(m.estimatedTimeMinutes).padStart(4)} total / ${String(m.activeTimeMinutes ?? "-").padStart(4)} hands-on  →  ` +
        `${String(total).padStart(4)} / ${String(active ?? "-").padStart(4)}${moved ? "   *" : ""}  (${m.sourceType}, ${m.id})`,
    );
  }
  console.log(`${meals.length} thx2-* meals, ${changed} ${APPLY ? "re-stamped" : "would change"}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
