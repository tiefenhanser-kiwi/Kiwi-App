// THX-3c (D) — DEV ONLY: a real test plan per dev feast for Hans's device, built from
// COPIES the way "use this plan" / Build my week does (forkMealForUser: an owned copy
// with new meal AND dish ids), so Thursday's Cook Mode runs the real scheduler
// (POST /plans/:id/cooking-sequence 404s on the catalog meal itself — THX-3).
//
//   node --env-file=.env --import tsx scripts/thx2/devTestPlans.ts            # create what is missing
//   node --env-file=.env --import tsx scripts/thx2/devTestPlans.ts --email someone@example.com
//
// One plan per feast, "THX device · Classic / Make-Ahead / Vegetarian", Thanksgiving
// week (Mon Nov 23 – Sun Nov 29, 2026), the feast on Thursday Nov 26. Idempotent: a
// plan already there under that name (not archived) is left alone and printed. It
// REFUSES any database but dev (assertScriptDatabase + the dev host marker).
//
// Run it AFTER patch.ts --apply: a copy holds the content it was copied from.

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase, DEV_HOST_MARKER } from "../../src/lib/scripts/requireDatabaseHost";
import { forkMealForUser } from "../../src/lib/mealFork";

const argv = process.argv.slice(2);
const emailIdx = argv.indexOf("--email");
const EMAIL = emailIdx >= 0 ? argv[emailIdx + 1] : "hans.tiefenthaler+8@gmail.com";

const { host, mode } = assertScriptDatabase("thx2/devTestPlans");
if (mode !== "dev" || !host.includes(DEV_HOST_MARKER)) {
  console.error(`refusing: devTestPlans.ts is dev only (database ${host}, ${mode})`);
  process.exit(2);
}

/** The dev feasts, by their catalog key, and the plan name each gets. */
export const DEV_FEASTS: ReadonlyArray<readonly [key: string, label: string]> = [
  ["thx2-feast-classic", "Classic"],
  ["thx2-feast-make-ahead", "Make-Ahead"],
  ["thx2-feast-vegetarian", "Vegetarian"],
];
export const planTitleFor = (label: string) => `THX device · ${label}`;

const WEEK_START = new Date("2026-11-23T00:00:00Z"); // Monday
const WEEK_END = new Date("2026-11-29T00:00:00Z"); // Sunday
const FEAST_DAY = new Date("2026-11-26T00:00:00Z"); // Thursday

const prisma = new PrismaClient();
const user = await prisma.user.findFirst({ where: { email: EMAIL }, select: { id: true, email: true } });
if (!user) {
  console.error(`no dev user ${EMAIL}`);
  process.exit(2);
}
console.log(`database: ${host} (dev) · user ${user.email} ${user.id}`);

for (const [key, label] of DEV_FEASTS) {
  const title = planTitleFor(label);
  const existing = await prisma.mealPlanInstance.findFirst({
    where: { userId: user.id, titleOverride: title, isArchived: false },
    select: { id: true, items: { select: { mealId: true } } },
  });
  if (existing) {
    console.log(`= ${title}: already there — plan ${existing.id} (meal ${existing.items[0]?.mealId ?? "?"}), left alone`);
    continue;
  }
  const source = await prisma.meal.findFirst({
    where: { sourceType: "batch_generated", dishFamilyKey: key, isArchived: false },
    select: { id: true, title: true },
  });
  if (!source) {
    console.log(`▷ ${title}: ${key} is not in this database — skipped`);
    continue;
  }
  const made = await prisma.$transaction(async (tx) => {
    const fork = await forkMealForUser(tx, source.id, user.id);
    const template = await tx.mealPlanTemplate.create({
      data: { userId: user.id, title, description: null, tags: [], sourceType: "wizard", defaultDaysCount: 1, imageUrl: null, isPublic: false, isArchived: false },
      select: { id: true },
    });
    const instance = await tx.mealPlanInstance.create({
      data: {
        userId: user.id, mealPlanTemplateId: template.id, titleOverride: title, status: "draft",
        startDate: WEEK_START, endDate: WEEK_END, activatedAt: new Date(), committedAt: new Date(), isWizardDraft: false,
      },
      select: { id: true },
    });
    await tx.mealPlanItem.create({
      data: { mealPlanInstanceId: instance.id, mealId: fork.mealId, positionIndex: 0, assignedDayOfWeek: "Thursday", assignedDate: FEAST_DAY, isBreakfast: false, isLunch: false, isDinner: true },
    });
    return { planId: instance.id, mealId: fork.mealId };
  }, { timeout: 60_000, maxWait: 20_000 });
  console.log(`+ ${title}: plan ${made.planId} · copy ${made.mealId} of ${source.id} "${source.title.slice(0, 50)}" · Thursday Nov 26`);
}

await prisma.$disconnect();
