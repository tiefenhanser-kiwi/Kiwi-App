// WS7-4-B c13 — promoteInstanceToTemplate.ts
//
// Hans-only CLI that takes a MealPlanInstance ID and produces a public
// MealPlanTemplate populated with copies of the Instance's MealPlanItems
// as MealPlanTemplateItems. The Template carries a stable deterministic
// id so re-runs are idempotent.
//
// Per Q-P1-3 ruling — Meals are in-place flipped to isPublic: true (NOT
// copy-published). Promotion is Hans-only; he can flip individual Meals
// back to private later if needed.
//
// Usage:
//   pnpm --filter @workspace/api-server exec tsx scripts/promoteInstanceToTemplate.ts \
//     <instanceId> [--featured] [--hosting] [--title="..."] [--description="..."]
//
// Flags:
//   --featured            sets MealPlanTemplate.isFeatured = true
//   --hosting             sets MealPlanTemplate.isHostingFeatured = true
//                         and occasionType = "holiday" (Hans can edit in DB)
//   --title="..."         overrides title (default: Instance.titleOverride)
//   --description="..."   sets description (default: empty)
//
// Exits non-zero on any failure with a diagnostic message.

import { PrismaClient } from "@prisma/client";

import { stampAllergens } from "../src/lib/allergens";

const prisma = new PrismaClient();

interface Flags {
  instanceId: string;
  featured: boolean;
  hosting: boolean;
  title: string | null;
  description: string | null;
}

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  let featured = false;
  let hosting = false;
  let title: string | null = null;
  let description: string | null = null;

  for (const a of argv) {
    if (a === "--featured") featured = true;
    else if (a === "--hosting") hosting = true;
    else if (a.startsWith("--title=")) title = a.slice("--title=".length);
    else if (a.startsWith("--description="))
      description = a.slice("--description=".length);
    else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 1) {
    console.error(
      "Usage: tsx scripts/promoteInstanceToTemplate.ts <instanceId> " +
        "[--featured] [--hosting] [--title=...] [--description=...]",
    );
    process.exit(2);
  }

  return { instanceId: positional[0], featured, hosting, title, description };
}

async function run(flags: Flags): Promise<void> {
  const instance = await prisma.mealPlanInstance.findUnique({
    where: { id: flags.instanceId },
    include: {
      items: {
        orderBy: { positionIndex: "asc" },
      },
    },
  });
  if (!instance) {
    console.error(`Instance not found: ${flags.instanceId}`);
    process.exit(1);
  }

  // Deterministic Template id so re-runs upsert the same row.
  const templateId = `template-from-${instance.id}`;
  const title = flags.title ?? instance.titleOverride ?? "Promoted Plan";
  const description = flags.description ?? "";

  const mealIds = Array.from(new Set(instance.items.map((it) => it.mealId)));

  // Q-P1-3 ruling: in-place flip. Walk every referenced Meal and ensure
  // isPublic = true. This is destructive vs. each Meal's prior state if
  // any were private; Hans can flip individual Meals back later.
  const flippedMeals: string[] = [];
  for (const mealId of mealIds) {
    const before = await prisma.meal.findUnique({
      where: { id: mealId },
      select: { id: true, title: true, isPublic: true },
    });
    if (!before) {
      console.error(`Referenced Meal missing: ${mealId} — skipping`);
      continue;
    }
    if (!before.isPublic) {
      await prisma.meal.update({
        where: { id: mealId },
        data: { isPublic: true },
      });
      flippedMeals.push(`${before.id} (${before.title})`);
    }
    // An in-place flip is a path INTO the shared pool, so it owes the pool the
    // same allergen stamp a batch-generated meal carries. Retrieval excludes
    // unstamped meals outright when a user declares an allergy, so promoting a
    // meal without stamping publishes it invisible to exactly the users the
    // filter protects. Unconditional (not only on flip): an already-public meal
    // promoted here may predate stamping.
    await stampAllergens(prisma, mealId);
  }

  // Upsert the Template + its items inside a transaction.
  await prisma.$transaction(async (tx) => {
    await tx.mealPlanTemplate.upsert({
      where: { id: templateId },
      update: {
        userId: instance.userId,
        title,
        description: description || null,
        sourceType: "manual",
        defaultDaysCount: instance.items.length,
        tags: [],
        isPublic: true,
        isFeatured: flags.featured,
        isHostingFeatured: flags.hosting,
        occasionType: flags.hosting ? "holiday" : null,
      },
      create: {
        id: templateId,
        userId: instance.userId,
        title,
        description: description || null,
        sourceType: "manual",
        defaultDaysCount: instance.items.length,
        tags: [],
        isPublic: true,
        isFeatured: flags.featured,
        isHostingFeatured: flags.hosting,
        occasionType: flags.hosting ? "holiday" : null,
      },
    });

    await tx.mealPlanTemplateItem.deleteMany({
      where: { mealPlanTemplateId: templateId },
    });
    if (instance.items.length > 0) {
      await tx.mealPlanTemplateItem.createMany({
        data: instance.items.map((it) => ({
          mealPlanTemplateId: templateId,
          mealId: it.mealId,
          positionIndex: it.positionIndex,
          assignedDayOfWeek: it.assignedDayOfWeek,
          isBreakfast: it.isBreakfast,
          isLunch: it.isLunch,
          isDinner: it.isDinner,
        })),
      });
    }
  });

  console.log(`[promote] templateId: ${templateId}`);
  console.log(`[promote] title: ${title}`);
  console.log(`[promote] items copied: ${instance.items.length}`);
  console.log(`[promote] featured: ${flags.featured}`);
  console.log(`[promote] hosting: ${flags.hosting}`);
  console.log(`[promote] meals flipped to public: ${flippedMeals.length}`);
  for (const m of flippedMeals) console.log(`  - ${m}`);
  console.log(`[promote] meals already public: ${mealIds.length - flippedMeals.length}`);
}

const flags = parseArgs(process.argv.slice(2));
run(flags)
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("[promote] failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
