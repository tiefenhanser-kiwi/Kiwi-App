// Row 5 · Block 1 · Phase 3 (D-WS9-149's re-host obligation) — the six
// MealPlanTemplate rows whose imageUrl is an images.unsplash.com hotlink
// (the dev-plan-template-* seed fixtures, devData.ts). Each is downloaded,
// resized to 800 px, uploaded to the bucket as templates/<id>.jpg, and the
// row's imageUrl is pointed at the public bucket URL. The end-to-end proof of
// download → resize → upload → public URL → DB write on a set small enough
// to eyeball, before the pilot.
//
//   node --env-file=.env --import tsx scripts/ws9-row5/rehost_templates.ts          # dry run: lists, downloads, resizes, uploads NOTHING
//   node --env-file=.env --import tsx scripts/ws9-row5/rehost_templates.ts --apply  # upload + UPDATE
//
// ⚠️ devData.ts's upsert rewrites imageUrl on every re-seed, so the seed
// literals are changed in the same commit (templateUrls.ts is the map
// revert.ts restores from).
//
// Revert: scripts/ws9-row5/revert.ts --templates (restores the Unsplash URLs
// from templateUrls.ts; the bucket objects are left in place).

import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { downloadImageBytes } from "../../src/lib/images/imagePipeline";
import { ImageStore, templateImageKey } from "../../src/lib/images/imageStore";
import { GcsObjectWriter, liveFetch, liveImageBucket } from "../../src/lib/images/live";
import type { ObjectWriter } from "../../src/lib/images/types";
import { TEMPLATE_UNSPLASH_URLS } from "./templateUrls";

export const OUT = "scripts/_scratch/row5-b1/templates";
const APPLY = process.argv.includes("--apply");

class DryRunWriter implements ObjectWriter {
  async save(key: string, bytes: Buffer): Promise<void> {
    if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/${key.replace(/\//g, "__")}`, bytes);
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const bucket = liveImageBucket();
  const store = new ImageStore({ writer: APPLY ? new GcsObjectWriter(bucket) : new DryRunWriter(), bucket });
  const report: Array<Record<string, unknown>> = [];
  try {
    const rows = await prisma.mealPlanTemplate.findMany({
      where: { id: { in: Object.keys(TEMPLATE_UNSPLASH_URLS) } },
      select: { id: true, title: true, imageUrl: true },
      orderBy: { id: "asc" },
    });
    console.log(`${APPLY ? "APPLY" : "DRY RUN"} · bucket ${bucket} · ${rows.length} template rows found`);
    for (const row of rows) {
      const expected = TEMPLATE_UNSPLASH_URLS[row.id];
      if (row.imageUrl !== expected) {
        console.log(`  SKIP ${row.id}: imageUrl is not the seeded Unsplash URL (${row.imageUrl})`);
        report.push({ id: row.id, skipped: "url_mismatch", current: row.imageUrl });
        continue;
      }
      const bytes = await downloadImageBytes(liveFetch, expected);
      if (!bytes) {
        console.log(`  FAIL ${row.id}: download failed`);
        report.push({ id: row.id, failed: "download" });
        continue;
      }
      const key = templateImageKey(row.id);
      const stored = await store.put(key, bytes);
      let dbUpdated = false;
      if (APPLY) {
        await prisma.mealPlanTemplate.update({ where: { id: row.id }, data: { imageUrl: stored.url } });
        dbUpdated = true;
      }
      console.log(`  ${row.id} (${row.title}) · ${bytes.byteLength} B → ${stored.width}×${stored.height} ${stored.bytes} B · ${stored.url}${dbUpdated ? " · DB UPDATED" : ""}`);
      report.push({ id: row.id, title: row.title, before: expected, after: stored.url, width: stored.width, height: stored.height, bytes: stored.bytes, dbUpdated });
    }
  } finally {
    await prisma.$disconnect();
  }
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/rehost_${APPLY ? "apply" : "dry"}.json`, JSON.stringify(report, null, 2));
  console.log(`report → ${OUT}/rehost_${APPLY ? "apply" : "dry"}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
