// Are the live hand-map collisions REDUNDANT (both paths reach the same key)
// or CONTRADICTORY (they disagree)? Computed, not assumed.
import { PrismaClient } from "@prisma/client";
import { buildRelationIndex, handMapSynonymCollisions, type RelationRow } from "../../src/lib/ingredientRelations";
import { mergeGroupBaseName } from "../../src/lib/groceryStaples";
const prisma = new PrismaClient();
async function main() {
  const raw = await prisma.ingredientRelation.findMany({
    include: { from: { select: { canonicalName: true, defaultUnit: true } }, to: { select: { canonicalName: true } } },
  });
  const rows: RelationRow[] = raw.map((r) => ({
    label: r.label as any, fromCanonicalName: r.from.canonicalName, toCanonicalName: r.to.canonicalName,
    yieldQuantity: r.yieldQuantity, yieldUnit: r.yieldUnit, coHarvestable: r.coHarvestable,
    confidence: r.confidence as any, reviewedByHuman: r.reviewedByHuman, fromDefaultUnit: r.from.defaultUnit,
  }));
  const idx = buildRelationIndex(rows);
  console.log("variant".padEnd(32) + "handMap base".padEnd(16) + "composed groupKey".padEnd(20) + "verdict");
  console.log("-".repeat(90));
  for (const c of handMapSynonymCollisions(idx)) {
    const cluster = idx.clusters.find((x) => x.members.includes(c.variant))!;
    const keys = new Set(cluster.members.map((m) => idx.groupKey(m)));
    const base = mergeGroupBaseName(c.variant);
    const composed = idx.groupKey(c.variant);
    const redundant = composed === base && keys.size === 1;
    console.log(
      c.variant.padEnd(32) + base.padEnd(16) + composed.padEnd(20) +
      (redundant ? "REDUNDANT (both paths agree)" : "CONTRADICTORY - REVIEW"),
    );
    console.log(`    cluster {${cluster.members.join(" | ")}} -> all groupKeys: {${[...keys].join(" | ")}}`);
    console.log(`    the edge ADDS these spellings the hand map lacks: ${cluster.members.filter((m) => mergeGroupBaseName(m) === m).join(" | ") || "(none)"}`);
  }
}
main().then(()=>prisma.$disconnect()).catch(async(e)=>{console.error(e);await prisma.$disconnect();process.exit(1);});
