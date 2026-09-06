// WS9 D-WS9-189 A3 Phase 1a — apply the 17 yield-magnitude corrections derived
// blind in A3-prep. Matched on the FOLDED parent/child key, so every raw
// relation row behind a slot is corrected together. Idempotent.
//   node --env-file=.env --import tsx scripts/ws9-d189-a3/fixYields.ts        (dry run)
//   node --env-file=.env --import tsx scripts/ws9-d189-a3/fixYields.ts --apply
import { PrismaClient } from "@prisma/client";
import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

// [foldedParent, foldedChild, newYieldQuantity, newYieldUnit, one-line reason]
const FIX: [string, string, number, string, string][] = [
  ["broccoli", "broccoli florets", 4, "cup", "a crown trims to ~4 cups of florets, not 3"],
  ["butter lettuce", "butter lettuce leaves", 16, "each", "a head of Bibb carries 12-20 usable leaves"],
  ["chipotle chile in adobo", "adobo sauce", 1, "tbsp", "a 7 oz can is ~7 chiles and ~7 tbsp of sauce"],
  ["chipotle chiles in adobo", "adobo sauce", 1, "tbsp", "a 7 oz can is ~7 chiles and ~7 tbsp of sauce"],
  ["chipotle pepper in adobo sauce", "adobo sauce", 1, "tbsp", "a 7 oz can is ~7 chiles and ~7 tbsp of sauce"],
  ["cilantro", "fresh cilantro leaves", 2, "cup", "a supermarket bunch picks to ~2 cups of leaves"],
  ["cilantro", "fresh cilantro sprigs", 50, "each", "a bunch is 40-60 sprigs, not 20"],
  ["cilantro", "fresh cilantro stems", 0.75, "cup", "stems are roughly a third of the bunch"],
  ["fresh basil", "fresh basil leaves", 2, "cup", "a bunch picks to ~2 cups loosely packed"],
  ["fresh thyme", "fresh thyme leaves", 3, "tbsp", "~30 sprigs at ~1/3 tsp each is ~3 tbsp"],
  ["fresh thyme", "fresh thyme sprigs", 30, "each", "a bunch or clamshell is 20-40 sprigs"],
  ["leeks", "leeks, white and light green parts only", 1, "each",
    "trimming does not halve the COUNT: one leek yields one trimmed leek. 0.5 was a discard fraction wearing a count unit"],
  ["orange", "fresh orange juice", 0.25, "cup", "a medium orange gives 4-5 tbsp"],
  ["orange", "orange juice", 0.25, "cup", "a medium orange gives 4-5 tbsp"],
  ["orange", "orange juice, freshly squeezed", 0.25, "cup", "a medium orange gives 4-5 tbsp"],
  ["orange", "orange zest", 1, "tbsp", "one orange zests to ~1 tbsp, not 2"],
  ["pepperoncini", "pepperoncini brine", 0.75, "tbsp",
    "the brine belongs to the JAR, not to one pepper. 1 cup per single pepper was ~20x too generous"],
];

async function main() {
  const idx = await loadRelationIndex(prisma);
  const rows = await prisma.ingredientRelation.findMany({
    where: { label: "component" },
    include: { from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
  });
  let touched = 0, alreadyRight = 0, unmatched = 0;
  for (const [p, c, q, u, why] of FIX) {
    const hits = rows.filter((r) => idx.groupKey(r.from.canonicalName) === p && idx.groupKey(r.to.canonicalName) === c);
    if (hits.length === 0) { unmatched++; console.log(`  !! NO ROW for "${p}" -> "${c}"`); continue; }
    for (const h of hits) {
      const same = h.yieldQuantity === q && h.yieldUnit === u;
      if (same) { alreadyRight++; continue; }
      touched++;
      console.log(`  "${h.from.canonicalName}" -> "${h.to.canonicalName}": ${h.yieldQuantity} ${h.yieldUnit}  ==>  ${q} ${u}   (${why})`);
      if (APPLY) await prisma.ingredientRelation.update({ where: { id: h.id }, data: { yieldQuantity: q, yieldUnit: u, reviewedByHuman: true } });
    }
  }
  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: rows to change ${touched}; already correct ${alreadyRight}; unmatched slots ${unmatched}; slots in the fix list ${FIX.length}`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
