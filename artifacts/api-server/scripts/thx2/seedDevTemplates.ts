// SERVER-10 G (D-WS9-349) — production's five Thanksgiving templates, seeded on DEV.
//
// Dev had no Thanksgiving template, so the night run's feast households forked a
// private copy of a feast meal for each new account (QA-NIGHT-1's fixture) instead
// of taking the route a user takes. This writes the five templates production
// carries (dev-templates.json, from production's own spec dump) so they can use
// POST /plans/use-template.
//
//   node --env-file=.env --import tsx scripts/thx2/seedDevTemplates.ts            # dry run: every change
//   node --env-file=.env --import tsx scripts/thx2/seedDevTemplates.ts --apply    # write them
//
// DEV ONLY: refuses unless the DATABASE_URL host is the dev branch (requireDatabaseHost
// — and a production match is refused too). IDEMPOTENT: templates are keyed
// featured-<slug> (production's ids), compared field by field and item by item; a
// second run reports zero changes and writes nothing. It writes only
// MealPlanTemplate and MealPlanTemplateItem rows: no meal is created, flipped
// public or edited (use-template forks each meal for the user who adopts it).
// The one dev-only difference from production is devTemplatesCore DEV_ALSO_FEATURED.
// Undo: archive the five featured-thanksgiving-* rows (revertFeaturedTemplates.ts
// takes featured-* off the rail).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { fieldChanges, OWNER, sameItems } from "../featured/featuredCore";
import { devTemplateRows, resolveDays, type DevSpec } from "./devTemplatesCore";

const APPLY = process.argv.includes("--apply");
const { host, mode } = assertScriptDatabase("thx2/seedDevTemplates");
if (mode !== "dev") {
  console.error(`🔴 REFUSING: ${host} is not the dev branch — this seed is dev only`);
  process.exit(2);
}
console.log(`database: ${host} (dev)${APPLY ? "" : " — DRY RUN"}`);

const spec = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dev-templates.json"), "utf8")) as DevSpec;
const prisma = new PrismaClient();
try {
  const ids = spec.plans.flatMap((p) => p.days.flatMap((d) => (d.mealId ? [d.mealId] : [])));
  const keys = spec.plans.flatMap((p) => p.days.flatMap((d) => (d.dishFamilyKey ? [d.dishFamilyKey] : [])));
  const meals = await prisma.meal.findMany({
    where: { OR: [{ id: { in: ids } }, { dishFamilyKey: { in: keys } }] },
    select: { id: true, dishFamilyKey: true, imageUrl: true, isArchived: true },
  });
  const { mealIdOf, problems } = resolveDays(spec, meals);
  const owner = await prisma.user.findUnique({ where: { id: OWNER.id }, select: { id: true } });
  if (!owner) problems.push(`the editorial owner ${OWNER.id} is missing (applyFeaturedTemplates.ts creates it)`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`🔴 REFUSING: ${problems.length} problem(s), nothing written`);
    process.exit(2);
  }

  const rows = devTemplateRows(spec, mealIdOf, meals);
  const have = await prisma.mealPlanTemplate.findMany({ where: { id: { in: rows.map((r) => r.id) } }, include: { items: true } });
  let changes = 0;
  for (const r of rows) {
    const old = have.find((h) => h.id === r.id) ?? null;
    const fields = fieldChanges(old, r.want);
    const itemsSame = old ? sameItems(old.items.map((i) => ({ ...i })), r.items) : false;
    console.log(`${r.id} "${r.want.title}": ${old ? (fields.length || !itemsSame ? "update" : "unchanged") : "create"}`);
    for (const f of old ? fields : []) console.log(`    ${f}`);
    if (!itemsSame) for (const i of r.items) console.log(`    item ${i.assignedDayOfWeek} ${i.mealId}${i.servingsOverride ? ` ×${i.servingsOverride}` : ""}`);
    if (!old || fields.length > 0) changes++;
    if (!itemsSame) changes++;
  }
  console.log(`${changes} change(s) across ${rows.length} template(s)`);
  if (!APPLY || changes === 0) {
    if (changes > 0) console.log("DRY — nothing changed. Re-run with --apply.");
  } else {
    await prisma.$transaction(async (tx) => {
      for (const r of rows) {
        const old = have.find((h) => h.id === r.id) ?? null;
        if (!old) await tx.mealPlanTemplate.create({ data: { id: r.id, ...r.want } });
        else if (fieldChanges(old, r.want).length > 0) await tx.mealPlanTemplate.update({ where: { id: r.id }, data: r.want });
        if (!old || !sameItems(old.items.map((i) => ({ ...i })), r.items)) {
          await tx.mealPlanTemplateItem.deleteMany({ where: { mealPlanTemplateId: r.id } });
          await tx.mealPlanTemplateItem.createMany({ data: r.items.map((i) => ({ mealPlanTemplateId: r.id, ...i })) });
        }
      }
    });
    console.log(`applied ${changes} change(s)`);
  }
} finally {
  await prisma.$disconnect();
}
