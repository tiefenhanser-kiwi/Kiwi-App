// Phase 0 follow-up: what label (if any) does the relation table give each of
// the 11 hand-map pairs, and each catalog-present endpoint's edges?
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const HAND_MAP: Record<string, string> = {
  "cracked black pepper": "black pepper",
  "ground black pepper": "black pepper",
  "freshly ground black pepper": "black pepper",
  "fresh ground black pepper": "black pepper",
  "cracked pepper": "black pepper",
  "ground pepper": "black pepper",
  "extra-virgin olive oil": "olive oil",
  "extra virgin olive oil": "olive oil",
  "virgin olive oil": "olive oil",
  "light olive oil": "olive oil",
  evoo: "olive oil",
};

async function main() {
  const names = [...new Set([...Object.keys(HAND_MAP), ...Object.values(HAND_MAP)])];
  const rows = await prisma.ingredient.findMany({
    where: { canonicalName: { in: names } },
    select: { id: true, canonicalName: true },
  });
  const idByName = new Map(rows.map((r) => [r.canonicalName, r.id]));
  const nameById = new Map(rows.map((r) => [r.id, r.canonicalName]));

  console.log("=== label carried by each of the 11 hand-map pairs ===");
  console.log("pair".padEnd(50) + "bothRowsExist".padEnd(16) + "label");
  for (const [v, b] of Object.entries(HAND_MAP)) {
    const vid = idByName.get(v);
    const bid = idByName.get(b);
    let label = "-";
    if (vid && bid) {
      const r = await prisma.ingredientRelation.findFirst({
        where: {
          OR: [
            { fromIngredientId: vid, toIngredientId: bid },
            { fromIngredientId: bid, toIngredientId: vid },
          ],
        },
        select: { label: true, fromIngredientId: true, toIngredientId: true, reviewedByHuman: true },
      });
      label = r
        ? `${r.label} (${nameById.get(r.fromIngredientId)} -> ${nameById.get(r.toIngredientId)})${r.reviewedByHuman ? " HUMAN" : ""}`
        : "NO ROW";
    }
    console.log(`${v} -> ${b}`.padEnd(50) + (vid && bid ? "yes" : "NO").padEnd(16) + label);
  }

  // Every edge (any label) touching the 5 catalog-present variants + 2 bases.
  console.log("\n=== all edges touching these catalog rows, any label ===");
  const ids = [...idByName.values()];
  const edges = await prisma.ingredientRelation.findMany({
    where: { OR: [{ fromIngredientId: { in: ids } }, { toIngredientId: { in: ids } }] },
    include: { from: { select: { canonicalName: true } }, to: { select: { canonicalName: true } } },
    orderBy: [{ label: "asc" }],
  });
  for (const e of edges) {
    console.log(`  [${e.label.padEnd(9)}] ${e.from.canonicalName} -> ${e.to.canonicalName}  (${e.confidence}, ${e.source}${e.reviewedByHuman ? ", HUMAN" : ""})`);
  }
  console.log(`  total ${edges.length}`);
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
