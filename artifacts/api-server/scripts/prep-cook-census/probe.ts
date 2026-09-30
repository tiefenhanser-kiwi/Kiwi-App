// [prepcook] A — corpus probe. Read-only. Resolves the candidate plan ids,
// reports meals / dishes / steps per plan, and checks the day-assignment
// columns actually carry values (P-R3 depends on whether a cook day exists at
// all, independently of whether the prep loader reads it).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DB_HOST = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!DB_HOST.includes("ep-broad-haze")) {
  throw new Error(`REFUSING: DATABASE_URL host is not the dev branch (${DB_HOST.slice(0, 8)}…)`);
}

const PREFIXES = (process.argv[process.argv.indexOf("--plans") + 1] ?? "").split(",").filter(Boolean);

async function main() {
  for (const p of PREFIXES) {
    const rows = await prisma.mealPlanInstance.findMany({
      where: { id: { startsWith: p } },
      select: {
        id: true,
        titleOverride: true,
        startDate: true,
        endDate: true,
        compostedAt: true,
        items: {
          select: {
            id: true,
            assignedDate: true,
            assignedDayOfWeek: true,
            servingsOverride: true,
            meal: {
              select: {
                id: true,
                title: true,
                estimatedTimeMinutes: true,
                activeTimeMinutes: true,
                dishLinks: { select: { dishId: true, positionIndex: true, dish: { select: { title: true } } } },
              },
            },
          },
        },
      },
    });
    if (rows.length !== 1) {
      console.log(`${p}: ${rows.length} matches — ${rows.length === 0 ? "MISSING" : "AMBIGUOUS"}`);
      continue;
    }
    const plan = rows[0];
    const dishIds = plan.items.flatMap((i) => i.meal?.dishLinks.map((d) => d.dishId) ?? []);
    const stepCount = dishIds.length
      ? await prisma.recipeInstructionStep.count({ where: { ownerType: "dish", ownerId: { in: dishIds } } })
      : 0;
    const dated = plan.items.filter((i) => i.assignedDate != null).length;
    console.log(
      [
        plan.id.slice(0, 8),
        `meals=${plan.items.length}`,
        `dishes=${dishIds.length}`,
        `steps=${stepCount}`,
        `dated=${dated}/${plan.items.length}`,
        `range=${plan.startDate?.toISOString().slice(0, 10) ?? "-"}..${plan.endDate?.toISOString().slice(0, 10) ?? "-"}`,
        plan.compostedAt ? "COMPOSTED" : "live",
        JSON.stringify(plan.titleOverride).slice(0, 40),
      ].join("  "),
    );
  }
}

main().finally(() => prisma.$disconnect());
