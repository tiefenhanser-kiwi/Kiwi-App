// Row 5 · Block 1 — revert. DRY RUN BY DEFAULT. Nulls out everything the
// image pipeline wrote to Meal rows, and/or restores the six template
// Unsplash URLs that rehost_templates.ts replaced. Bucket objects are left in
// place unless `--delete-objects` (Block 1b): they are inert once no row
// points at them, but generate.ts --report reconciles bucket vs rows, so a
// revert that leaves objects behind shows up there as orphans.
//
// Block 1b scoping (first exercised 2026-09-18 on the 25 gate rows, which
// were stored at 800 px before Hans ruled native 1024²):
//   --ids a,b,c          only these meal ids (still AND imageSource selector)
//   --ids-file path      one id per line (e.g. the ok ids out of run/run.json)
//   --delete-objects     also delete meals/<id>.jpg for every row reverted
//
//   node --env-file=.env --import tsx scripts/ws9-row5/revert.ts                       # dry run: counts + the first 20 ids per group
//   node --env-file=.env --import tsx scripts/ws9-row5/revert.ts --meals --apply       # Meal rows: imageUrl/imageSource/imageAttribution/imageSourceUrl/imageGeneratedAt → NULL
//   node --env-file=.env --import tsx scripts/ws9-row5/revert.ts --meals --source ai_generated --apply   # only rows with that imageSource (a bad batch)
//   node --env-file=.env --import tsx scripts/ws9-row5/revert.ts --templates --apply   # the six template rows → their Unsplash URLs
//   node --env-file=.env --import tsx scripts/ws9-row5/revert.ts --all --apply
//   node --env-file=.env --import tsx scripts/ws9-row5/revert.ts --meals --ids-file ids.txt --delete-objects --apply
//
// The meal selector is `imageSource IS NOT NULL` — the provenance column the
// Block 1 migration added, which nothing but this pipeline writes — so a
// hand-set imageUrl on a row the pipeline never touched is never cleared.
// (In Block 1 itself the pilot writes nothing; the meal branch is here for
// Block 1b / 1c, ready before the first write.)

import { PrismaClient, type MealImageSource } from "@prisma/client";
import { readFileSync } from "node:fs";

import { mealImageKey } from "../../src/lib/images/imageStore";
import { GcsObjectWriter, liveImageBucket } from "../../src/lib/images/live";
import { TEMPLATE_UNSPLASH_URLS } from "./templateUrls";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALL = argv.includes("--all");
const MEALS = ALL || argv.includes("--meals");
const TEMPLATES = ALL || argv.includes("--templates");
const sourceIdx = argv.indexOf("--source");
const SOURCE = sourceIdx >= 0 ? (argv[sourceIdx + 1] as MealImageSource) : null;
const idsIdx = argv.indexOf("--ids");
const idsFileIdx = argv.indexOf("--ids-file");
const IDS: string[] | null =
  idsIdx >= 0
    ? argv[idsIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : idsFileIdx >= 0
      ? readFileSync(argv[idsFileIdx + 1], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : null;
const DELETE_OBJECTS = argv.includes("--delete-objects");

async function main(): Promise<void> {
  if (!MEALS && !TEMPLATES) {
    console.log("nothing selected — pass --meals, --templates, or --all (dry run unless --apply)");
  }
  const prisma = new PrismaClient();
  try {
    console.log(`${APPLY ? "APPLY" : "DRY RUN"}${SOURCE ? ` · source=${SOURCE}` : ""}${IDS ? ` · ids=${IDS.length}` : ""}${DELETE_OBJECTS ? " · delete-objects" : ""}`);

    if (MEALS) {
      const where = { imageSource: SOURCE ? SOURCE : { not: null }, ...(IDS ? { id: { in: IDS } } : {}) } as const;
      const rows = await prisma.meal.findMany({ where, select: { id: true, title: true, imageSource: true, imageUrl: true }, orderBy: { id: "asc" } });
      const bySource = new Map<string, number>();
      for (const r of rows) bySource.set(String(r.imageSource), (bySource.get(String(r.imageSource)) ?? 0) + 1);
      console.log(`meals with imageSource set: ${rows.length} · ${[...bySource].map(([k, v]) => `${k}=${v}`).join(" ")}`);
      for (const r of rows.slice(0, 20)) console.log(`  ${r.id} · ${r.imageSource} · ${r.title}`);
      if (rows.length > 20) console.log(`  … ${rows.length - 20} more`);
      if (APPLY && rows.length > 0) {
        const res = await prisma.meal.updateMany({
          where,
          data: { imageUrl: null, imageSource: null, imageAttribution: null, imageSourceUrl: null, imageGeneratedAt: null },
        });
        console.log(`  UPDATED ${res.count} meal rows → image fields NULL`);
        if (DELETE_OBJECTS) {
          // Only the objects the reverted rows pointed at, by their own key —
          // a fork's row points at its CATALOG source's object, which is not
          // this row's to delete; skip any imageUrl that is not its own key.
          const bucket = liveImageBucket();
          const writer = new GcsObjectWriter(bucket);
          let deleted = 0;
          let skipped = 0;
          for (const r of rows) {
            const key = mealImageKey(r.id);
            if (r.imageUrl !== `https://storage.googleapis.com/${bucket}/${key}`) {
              skipped++;
              continue;
            }
            try {
              await writer.delete(key);
              deleted++;
            } catch (err) {
              console.log(`  delete ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          console.log(`  DELETED ${deleted} bucket objects (${skipped} rows pointed at another row's object — left)`);
        }
      } else if (DELETE_OBJECTS) {
        console.log(`  would delete ${rows.filter((r) => r.imageUrl === `https://storage.googleapis.com/${liveImageBucket()}/${mealImageKey(r.id)}`).length} bucket objects`);
      }
    }

    if (TEMPLATES) {
      const ids = Object.keys(TEMPLATE_UNSPLASH_URLS);
      const rows = await prisma.mealPlanTemplate.findMany({ where: { id: { in: ids } }, select: { id: true, imageUrl: true }, orderBy: { id: "asc" } });
      let changed = 0;
      for (const r of rows) {
        const target = TEMPLATE_UNSPLASH_URLS[r.id];
        const same = r.imageUrl === target;
        console.log(`  ${r.id} · ${same ? "already Unsplash" : `${r.imageUrl} → ${target}`}`);
        if (!same && APPLY) {
          await prisma.mealPlanTemplate.update({ where: { id: r.id }, data: { imageUrl: target } });
          changed++;
        }
      }
      console.log(`templates: ${rows.length} rows · ${APPLY ? `${changed} restored` : `${rows.filter((r) => r.imageUrl !== TEMPLATE_UNSPLASH_URLS[r.id]).length} would be restored`}`);
      if (APPLY && changed > 0) console.log("  ⚠️ devData.ts still carries the bucket URLs — revert that file too or the next prisma:seed:dev re-applies them.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
