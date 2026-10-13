// THX-1 — the emergency undo for applyFeaturedTemplates.ts: takes every
// `featured-*` template off the Featured rail (railPosition null, both
// featuring flags off, archived). Same guard, same default: a bare run is a
// DRY RUN and writes nothing; only `--apply` writes.
//
//   # dev
//   node --env-file=.env --import tsx scripts/featured/revertFeaturedTemplates.ts
//   node --env-file=.env --import tsx scripts/featured/revertFeaturedTemplates.ts --apply
//
//   # PRODUCTION — KIWI_PRODUCTION_HOST typed into the shell, exactly as the
//   # apply (see its header)
//   $env:KIWI_PRODUCTION_HOST = "<the production hostname>"
//   node --env-file=<prod-env> --import tsx scripts/featured/revertFeaturedTemplates.ts --dry-run
//   node --env-file=<prod-env> --import tsx scripts/featured/revertFeaturedTemplates.ts --apply
//   Remove-Item Env:KIWI_PRODUCTION_HOST
//
// What it does NOT do, on purpose:
//   - bring the dev-plan-template-* seeds back. Nobody wants them; they stay
//     retired, and this script keeps no snapshot of them.
//   - delete anything. An archived template keeps every adopted plan whole
//     (instances read title/image/tags through the template link; the FK is
//     SET NULL on delete, which would blank them — archiving does not).
//   - touch the items, the allergen stamps or the Kiwi Kitchen owner row.
//
// Archived is not unreachable: GET /plans/templates/:id and use-template do
// not check isArchived, so a client holding a featured-* id can still preview
// and adopt it. Nothing in the app lists an archived template.

import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { FEATURED_ID_PREFIX, REVERTED_FEATURED, fieldChanges } from "./featuredCore";

const say = (s = "") => console.log(s);

async function main(): Promise<void> {
  const { host, mode } = assertScriptDatabase("featured/revertFeaturedTemplates");
  const APPLY = process.argv.includes("--apply");
  const prisma = new PrismaClient();
  try {
    say(`[thx-1] REVERT featured templates — ${APPLY ? "APPLY (writing)" : "DRY RUN (writes nothing)"}`);
    say(`database host: ${host} (${mode})`);
    say();
    const rows = await prisma.mealPlanTemplate.findMany({
      where: { id: { startsWith: FEATURED_ID_PREFIX } },
      select: { id: true, title: true, isPublic: true, isArchived: true, isFeatured: true, isHostingFeatured: true, railPosition: true },
      orderBy: { railPosition: "asc" },
    });
    say(`${FEATURED_ID_PREFIX}* templates: ${rows.length}`);
    const change = rows.filter((r) => fieldChanges(r, REVERTED_FEATURED).length > 0);
    for (const r of rows) {
      const c = fieldChanges(r, REVERTED_FEATURED);
      say(`  ${r.id}  "${r.title}"  rail=${r.railPosition} featured=${r.isFeatured} archived=${r.isArchived}`);
      say(`    -> ${c.length ? `TAKE OFF THE RAIL  ${c.join("; ")}` : "already off the rail"}`);
    }
    say();
    say(`SUMMARY: ${change.length} template(s) to take off the rail — ${change.length ? `${change.length} change(s)` : "ZERO CHANGES"}`);
    if (!APPLY) {
      say("DRY RUN — nothing was written. Re-run with --apply to write.");
      return;
    }
    if (!change.length) {
      say("Nothing to write.");
      return;
    }
    const res = await prisma.mealPlanTemplate.updateMany({
      where: { id: { in: change.map((r) => r.id) } },
      data: REVERTED_FEATURED,
    });
    say(`APPLIED on ${host}: ${res.count} template(s) taken off the rail.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
