// CLIENT-2b C (BUG-512) — print the spec applyFeaturedTemplates.ts would turn
// back into the featured templates a database holds. READ-ONLY: it reads
// MealPlanTemplate, its items and their meals, and writes nothing to the
// database.
//
// Why: the spec the Oct 16 production run applied (the Thanksgiving plans) is
// not on the laptop. Dump it from production, edit the flags, apply it.
//
// Run from artifacts/api-server. The spec goes to stdout (or to --out <path>,
// UTF-8 without a BOM); the host, the notes and the round-trip check go to
// stderr. ⚠️ On Windows PowerShell 5.1 use --out: `>` writes UTF-16, which
// JSON.parse in the apply cannot read.
//
//   # dev
//   node --env-file=.env --import tsx scripts/featured/dumpFeaturedSpec.ts --out scripts/_scratch/featured-dev.json
//
//   # PRODUCTION — KIWI_PRODUCTION_HOST typed into the shell, exactly as the
//   # apply (see its header)
//   $env:KIWI_PRODUCTION_HOST = "<the production hostname>"
//   node --env-file=<prod-env> --import tsx scripts/featured/dumpFeaturedSpec.ts --out <path>
//   Remove-Item Env:KIWI_PRODUCTION_HOST
//
// What it dumps: every public, unarchived `featured-*` template, in rail
// order (featuredCore.ts specFromTemplates says how off-rail rows are placed);
// per day the meal's `thx2Key` in place of its mealId when its dishFamilyKey
// is a thx2- key that resolves back to that meal alone; `anchorDate`,
// `featuredFrom` / `featuredUntil` (zoned ISO, UTC), `servingsOverride`, and
// the `featured` / `hosting` flags as they stand.
//
// The proof it is faithful is the apply's own dry run on the same database:
//   node --env-file=.env --import tsx scripts/featured/applyFeaturedTemplates.ts --spec <path>
// must print ZERO CHANGES. The dump runs the same comparison itself first
// (desiredTemplate / desiredItems against the rows it read) and prints any
// field a spec cannot carry.

import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import {
  FEATURED_ID_PREFIX,
  THX2_KEY_RE,
  coverMealIdFor,
  desiredItems,
  desiredTemplate,
  fieldChanges,
  sameItems,
  specFromTemplates,
  templateIdFor,
  type DumpMealRow,
} from "./featuredCore";

const err = (s = "") => console.error(s);

async function main(): Promise<void> {
  const { host, mode } = assertScriptDatabase("featured/dumpFeaturedSpec");
  const outArg = process.argv.indexOf("--out");
  const outPath = outArg >= 0 && process.argv[outArg + 1] ? resolvePath(process.argv[outArg + 1]) : null;
  const prisma = new PrismaClient();
  try {
    err(`[client-2b] featured spec dump — READ-ONLY`);
    err(`database host: ${host} (${mode})`);

    const templates = await prisma.mealPlanTemplate.findMany({
      where: { id: { startsWith: FEATURED_ID_PREFIX }, isPublic: true, isArchived: false },
      include: { items: true },
      orderBy: { id: "asc" },
    });
    err(`templates: ${templates.length} public, unarchived ${FEATURED_ID_PREFIX}*`);

    const mealIds = [...new Set(templates.flatMap((t) => t.items.map((i) => i.mealId)))];
    const meals = await prisma.meal.findMany({
      where: { id: { in: mealIds } },
      select: { id: true, title: true, imageUrl: true, dishFamilyKey: true },
    });
    // A thx2- key stands in for the id only when the apply's own lookup
    // (batch_generated + dishFamilyKey) finds this meal and no other.
    const keys = [
      ...new Set(meals.map((m) => m.dishFamilyKey).filter((k): k is string => !!k && THX2_KEY_RE.test(k))),
    ];
    const keyed = keys.length
      ? await prisma.meal.findMany({
          where: { sourceType: "batch_generated", dishFamilyKey: { in: keys } },
          select: { id: true, dishFamilyKey: true },
        })
      : [];
    const holders = new Map<string, string[]>();
    for (const k of keyed) holders.set(k.dishFamilyKey as string, [...(holders.get(k.dishFamilyKey as string) ?? []), k.id]);
    const mealMap = new Map<string, DumpMealRow>();
    for (const m of meals) {
      const k = m.dishFamilyKey;
      const ids = k ? holders.get(k) : undefined;
      const unique = !!ids && ids.length === 1 && ids[0] === m.id;
      if (k && THX2_KEY_RE.test(k) && !unique) {
        err(`  note: ${m.id} "${m.title}" keeps its mealId — ${k} resolves to ${ids?.length ?? 0} batch_generated meal(s) [${ids?.join(", ") ?? ""}]`);
      }
      mealMap.set(m.id, { id: m.id, title: m.title, imageUrl: m.imageUrl, thx2Key: unique ? k : null });
    }

    const { spec, notes } = specFromTemplates(templates, mealMap);
    for (const n of notes) err(`  note: ${n}`);

    // The round trip, in process: what the apply would write from this spec
    // against what the rows hold. thx2Keys resolve to the meals they came from.
    let differ = 0;
    const byId = new Map(templates.map((t) => [t.id, t]));
    const idForKey = new Map([...mealMap.values()].filter((m) => m.thx2Key).map((m) => [m.thx2Key as string, m.id]));
    for (const [i, p] of spec.plans.entries()) {
      const resolved = { ...p, days: p.days.map((d) => (d.thx2Key ? { ...d, mealId: idForKey.get(d.thx2Key)! } : d)) };
      const row = byId.get(templateIdFor(p.slug))!;
      const want = desiredTemplate(resolved, i, mealMap.get(coverMealIdFor(resolved))?.imageUrl ?? null);
      const changes = fieldChanges(row, want);
      const items = sameItems(row.items, desiredItems(resolved));
      if (changes.length || !items) differ += 1;
      err(
        `  ${String(i + 1).padStart(2)}. ${row.id}  rail=${row.railPosition} featured=${row.isFeatured} hosting=${row.isHostingFeatured}` +
          `  ${changes.length || !items ? `WOULD CHANGE: ${[...changes, ...(items ? [] : ["items"])].join("; ")}` : "round-trips"}`,
      );
    }
    err(`round trip: ${differ === 0 ? "every template round-trips (the apply's dry run should report ZERO CHANGES)" : `${differ} template(s) would change — see above`}`);

    const json = `${JSON.stringify(spec, null, 2)}\n`;
    if (outPath) {
      writeFileSync(outPath, json, "utf8");
      err(`spec written to ${outPath} (the only file written; the database was only read)`);
    } else {
      process.stdout.write(json);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Exact entry-point check: importing this module must never run it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
