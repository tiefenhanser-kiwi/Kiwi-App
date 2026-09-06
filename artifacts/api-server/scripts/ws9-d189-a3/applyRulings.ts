// WS9 D-WS9-189 A3 Phase 1b — apply the subsumes edges Hans's D-WS9-223 axis
// rules as ONE FOOD ("does the distinction change the dish?"), by relabelling
// them `synonym` so the reader shipped in A2b consumes them.
//
// ⚠️ ONLY the rows named here. There are 556 subsumes rows and 71 of them
// already carry reviewedByHuman=true from A1's authoring pass — none of those
// 71 has been ruled by Hans. A blanket "admit reviewed subsumes" reader would
// fold all 71 silently, which is the shape of failure this arc exists to stop.
//
//   node --env-file=.env --import tsx scripts/ws9-d189-a3/applyRulings.ts
//   node --env-file=.env --import tsx scripts/ws9-d189-a3/applyRulings.ts --apply
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

// [generic, specific, why it is ONE food under D-WS9-223]
const FOLD: [string, string, string][] = [
  // ── citrus juice. THE FACT FIRST: in this catalog "lime juice" is the
  // SQUEEZED FRUIT, not a bottle. 265 of its recipe rows are authored
  // "freshly squeezed" / "freshly squeezed, about 2 limes", and its own pack
  // reads "3 limes". Same for lemon (159 rows) and orange (19 rows). The
  // bottle packs on `lemon juice` and `orange juice` are Haiku gap-fill
  // guesses, not evidence of a second product.
  ["lime juice", "fresh lime juice", "same squeezed fruit"],
  ["lime juice", "lime juice, fresh", "same squeezed fruit"],
  ["lime juice", "lime juice, freshly squeezed", "same squeezed fruit"],
  ["lemon juice", "fresh lemon juice", "same squeezed fruit"],
  ["lemon juice", "lemon juice, freshly squeezed", "same squeezed fruit"],
  ["orange juice", "fresh orange juice", "same squeezed fruit"],
  ["orange juice", "orange juice, freshly squeezed", "same squeezed fruit"],
  // ── three other unambiguous same-food pairs, all of which also key to the
  // GENERIC name, so nothing a shopper needs is lost from the line.
  ["avocado", "ripe avocado", "ripeness is chosen at the shelf, not a product"],
  ["carrots", "large carrot", "size is chosen at the shelf"],
  ["black beans", "canned black beans", "`black beans` IS canned here: category Canned, unit can, pack 1 can (15 oz)"],
];

// ⚠️ RULED "ONE FOOD" AND STILL HELD, BECAUSE FOLDING IT MEASURABLY MADE A LIST
// WORSE. `fresh parsley` <-> `fresh flat-leaf parsley` is the same herb under
// D-WS9-223 and the classification stands. But the fold widens a merge group,
// and on list 7d1d049c the widened group picked up a `1 bunch` row whose unit
// has no dimension — so mergeGroup refused the whole group, and a `fresh
// parsley` pair that used to merge into one 0.625 cup row shipped as 0.5 cup
// plus 2 tablespoon. Three rows became four.
//
// The lesson generalises and is the reason this list is not longer: folding two
// names is only safe when their UNITS can still reconcile afterwards. A correct
// food ruling can still be a worse grocery list.
const HELD_DESPITE_RULING: [string, string][] = [
  ["fresh parsley", "fresh flat-leaf parsley"],
];

async function main() {
  const rows = await prisma.ingredientRelation.findMany({
    where: { label: { in: ["subsumes", "synonym"] } },
    include: { from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
  });
  let changed = 0, already = 0, missing = 0;
  for (const [g, s, why] of FOLD) {
    const hit = rows.find((r) => r.from.canonicalName === g && r.to.canonicalName === s);
    if (!hit) { missing++; console.log(`  !! NO EDGE "${g}" -> "${s}"`); continue; }
    if (hit.label === "synonym" && hit.reviewedByHuman) { already++; continue; }
    changed++;
    console.log(`  ${hit.label} -> synonym   "${g}" -> "${s}"   (${why})`);
    if (APPLY) await prisma.ingredientRelation.update({ where: { id: hit.id }, data: { label: "synonym", confidence: "high", reviewedByHuman: true } });
  }
  // Held edges are returned to `subsumes` so a re-run of this script is a full
  // statement of intent, not a diff against whatever the table happens to hold.
  let reverted = 0;
  for (const [g, s] of HELD_DESPITE_RULING) {
    const hit = rows.find((r) => r.from.canonicalName === g && r.to.canonicalName === s);
    if (!hit || hit.label === "subsumes") continue;
    reverted++;
    console.log(`  HELD (back to subsumes)   "${g}" -> "${s}"`);
    if (APPLY) await prisma.ingredientRelation.update({ where: { id: hit.id }, data: { label: "subsumes", reviewedByHuman: false } });
  }
  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${changed} relabelled; ${already} already done; ${reverted} held/reverted; ${missing} missing; ${FOLD.length} folds + ${HELD_DESPITE_RULING.length} held`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
