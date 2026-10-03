// [prepcook] Part I — probe: who owns what on dev. Read-only.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-i/probe-users.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
  throw new Error("REFUSING: not the dev branch");
}

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, createdAt: true, _count: { select: { planInstances: true } } },
    orderBy: { createdAt: "asc" },
  });
  for (const u of users) {
    console.log(`${u.id}  ${String(u.email).padEnd(40)}  plans=${u._count.planInstances}  created=${u.createdAt.toISOString().slice(0, 10)}`);
  }
  const plans = await prisma.mealPlanInstance.findMany({
    where: { isWizardDraft: false, compostedAt: null },
    select: {
      id: true, userId: true, titleOverride: true, startDate: true,
      _count: { select: { items: true, prepStepCompletions: true } },
      prepWeekStructure: { select: { lastGeneratedAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  console.log(`\n${plans.length} live committed plans`);
  for (const p of plans) {
    console.log(
      `${p.id.slice(0, 8)}  ${String(emailById.get(p.userId)).slice(0, 26).padEnd(26)}  items=${String(p._count.items).padStart(2)}  ` +
        `start=${p.startDate?.toISOString().slice(0, 10) ?? "-"}  done=${p._count.prepStepCompletions}  cache=${p.prepWeekStructure ? "y" : "-"}  ${JSON.stringify(p.titleOverride ?? "").slice(0, 40)}`,
    );
  }
}

main().finally(() => prisma.$disconnect());
