// [grocery] B4 · Part B — THE APPLY HALF OF THE ROUND TRIP.
//
//   node --env-file=.env --import tsx scripts/grocery-b4/apply.ts --dry-run
//   node --env-file=.env --import tsx scripts/grocery-b4/apply.ts --apply
//
// Loads `proposals.ts` onto `Ingredient.packYield*`. Every row lands with
// `reviewedByHuman: true` — the OVERWRITE GUARD — and every row that ALREADY
// carries a yield is SKIPPED rather than overwritten, which is what protects
// B1's 48 and B3's five from being re-derived by this pass.
//
// IDEMPOTENT: a second run reports everything unchanged.

import { PrismaClient } from "@prisma/client";

import { YIELD_LOADS } from "./proposals";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";

const { host } = assertScriptDatabase("grocery-b4/apply");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const REVIEWED_AT = new Date("2026-09-29T18:00:00.000Z");

const note = (s: string) => console.log(s);

async function main() {
  note(`[grocery] B4 Part B — ${APPLY ? "🔴 APPLY (writing)" : "DRY RUN (nothing written)"}`);
  note(`host ${host} · ${YIELD_LOADS.length} proposed yields`);
  note("");

  let updated = 0, unchanged = 0, skippedGuard = 0, skippedMissing = 0, refused = 0;

  for (const y of YIELD_LOADS) {
    const row = await prisma.ingredient.findUnique({
      where: { canonicalName: y.canonical },
      select: {
        id: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
        packYieldUnit: true, packYieldPerPack: true, packYieldSource: true,
        packYieldReviewedByHuman: true,
      },
    });
    if (!row) { skippedMissing++; note(`  SKIP   "${y.canonical}" — no catalog row`); continue; }

    // ⚠️ THE OVERWRITE GUARD, and it is the point of the round trip. B1's 48
    // yields and B3's five were signed by a human against a source this pass
    // does not have; a label-derived figure must never silently replace one.
    if (row.packYieldPerPack !== null) {
      if (row.packYieldPerPack === y.perPack && row.packYieldUnit === y.unit) {
        unchanged++; note(`  ==     "${y.canonical}" already ${y.perPack} ${y.unit}/pack`);
      } else {
        skippedGuard++;
        note(`  GUARD  "${y.canonical}" already carries ${row.packYieldPerPack} ${row.packYieldUnit} (reviewed ${row.packYieldReviewedByHuman}) — NOT overwritten with ${y.perPack} ${y.unit}`);
      }
      continue;
    }

    // A yield whose parent is not the row's own purchase unit can never fire:
    // scalePurchaseForSubUnit requires purchaseUnit === subUnit.parent. Refuse
    // rather than load a figure that does nothing.
    if (!row.purchaseUnit) {
      refused++; note(`  REFUSE "${y.canonical}" — no purchaseUnit, so a ladder has no parent`);
      continue;
    }
    if (!(y.perPack > 0)) { refused++; note(`  REFUSE "${y.canonical}" — non-positive yield`); continue; }

    note(`  SET    "${y.canonical}" (pack ${row.purchaseQuantity} ${row.purchaseUnit} ${JSON.stringify(row.purchaseDisplay)}) -> ${y.perPack} ${y.unit} per pack`);
    note(`         ${y.source}`);
    if (APPLY) {
      await prisma.ingredient.update({
        where: { id: row.id },
        data: {
          packYieldUnit: y.unit,
          packYieldPerPack: y.perPack,
          packYieldSource: `D-WS9-286 · ${y.source}`,
          packYieldReviewedByHuman: true,
        },
      });
    }
    updated++;
  }

  note("");
  note("## totals");
  note(`  updated ${updated} · unchanged ${unchanged} · guarded (already had one) ${skippedGuard} · no row ${skippedMissing} · refused ${refused}`);
  if (!APPLY) note("\nDRY RUN — nothing was written. Re-run with --apply.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
