// [grocery] F Part E / E4.1 (D-WS9-295) — the tomatillo synonym edge.
//
// "fold the two catalog rows with a `synonym` relation edge (R1). Not a catalog
// merge." So this writes ONE `ingredient_relations` row and touches neither
// ingredient: both keep their id, their name and every dish reference, and a
// revert is a DELETE.
//
// ⚠️ SYNONYM IS SYMMETRIC AND STORED IN CANONICAL ORDER (schema comment on
// IngredientRelation): `from.canonicalName < to.canonicalName` by ordinal
// compare, so one pair is one row and a re-run is idempotent. Readers sort the
// pair the same way rather than querying both directions. "tomatillo" sorts
// before "tomatillos", so from=tomatillo, to=tomatillos.
//
// ⚠️ MEASURED: THIS MOVES ZERO CORPUS ROWS TODAY, and that is not a reason not
// to write it. A synonym edge folds two rows when BOTH are on one plan, and
// across the 20-plan corpus they never co-occur — one plan carries `tomatillos`
// (19 dish refs) and another carries `tomatillo` (6). The edge is correct and it
// is what makes the fold available the first time a plan reaches both. The LINE
// Hans wants ("2 lb tomatillos") comes from the display-name row in
// catalog-fix.ts, not from here; the two halves are reported separately for
// exactly that reason.
//
//   node --env-file=.env --import tsx scripts/grocery-f/e4-synonym.ts
//   node --env-file=.env --import tsx scripts/grocery-f/e4-synonym.ts --apply

import { PrismaClient } from "@prisma/client";

const PAIRS: [string, string][] = [["tomatillo", "tomatillos"]];

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
  console.log("host check: PASS (dev branch)");
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient();

  for (const pair of PAIRS) {
    // canonical order — the schema's own rule for a symmetric label.
    const [a, b] = [...pair].sort();
    const rows = await prisma.ingredient.findMany({
      where: { canonicalName: { in: [a, b] } },
      select: { id: true, canonicalName: true },
    });
    const from = rows.find((r) => r.canonicalName === a);
    const to = rows.find((r) => r.canonicalName === b);
    if (!from || !to) {
      console.log(`🔴 ${a} ~ ${b} — one side is not in the catalog; skipped`);
      continue;
    }
    const existing = await prisma.ingredientRelation.findFirst({
      where: {
        OR: [
          { fromIngredientId: from.id, toIngredientId: to.id },
          { fromIngredientId: to.id, toIngredientId: from.id },
        ],
      },
      select: { id: true, label: true, fromIngredientId: true },
    });
    if (existing) {
      console.log(
        `already related: ${a} ~ ${b} — label=${existing.label}` +
          (existing.label === "synonym" ? " (no-op)" : " 🔴 a DIFFERENT label already stands; not overwritten"),
      );
      continue;
    }
    console.log(`${apply ? "WRITE" : "would write"}  synonym  ${a}  ~  ${b}`);
    if (!apply) continue;
    await prisma.ingredientRelation.create({
      data: {
        fromIngredientId: from.id,
        toIngredientId: to.id,
        label: "synonym",
        source: "human",
        confidence: "high",
        rationale:
          "D-WS9-295 (Hans, 2026-09-30): the singular and plural catalog rows are one food. " +
          "Folded with an edge rather than merged, so both rows keep their id and their dish references.",
        familyKey: "tomatillo",
        reviewedByHuman: true,
        reviewedAt: new Date(),
      },
    });
  }
  if (!apply) console.log(`\n(dry run — nothing written. Re-run with --apply)`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
