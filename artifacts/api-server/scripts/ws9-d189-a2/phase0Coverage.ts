// D-WS9-189 Block A2 Phase 0 — read-only coverage probe.
// Prints (a) relation label counts, (b) MERGE_GROUP_VARIANT_TO_BASE coverage
// against `synonym` rows, (c) the synonym-edge shape. Writes nothing.
import { PrismaClient } from "@prisma/client";
import { normalizeIngredientName } from "../../src/lib/groceryNormalization";

const prisma = new PrismaClient();

// The 11 entries, copied verbatim from groceryStaples.ts:214 (the module does
// not export the map itself, only mergeGroupBaseName).
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
  const byLabel = await prisma.ingredientRelation.groupBy({
    by: ["label"],
    _count: { _all: true },
  });
  console.log("=== relation rows by label ===");
  for (const r of byLabel.sort((a, b) => a.label.localeCompare(b.label))) {
    console.log(`  ${r.label.padEnd(10)} ${r._count._all}`);
  }
  const total = byLabel.reduce((s, r) => s + r._count._all, 0);
  console.log(`  ${"TOTAL".padEnd(10)} ${total}`);

  const syn = await prisma.ingredientRelation.findMany({
    where: { label: "synonym" },
    include: {
      from: { select: { canonicalName: true } },
      to: { select: { canonicalName: true } },
    },
  });
  console.log(`\n=== synonym edges: ${syn.length} ===`);
  const revd = syn.filter((s) => s.reviewedByHuman).length;
  console.log(`  reviewedByHuman: ${revd}   ai-only: ${syn.length - revd}`);
  const bySrc = new Map<string, number>();
  for (const s of syn) bySrc.set(s.source, (bySrc.get(s.source) ?? 0) + 1);
  for (const [k, v] of [...bySrc].sort()) console.log(`  source ${k}: ${v}`);
  const byConf = new Map<string, number>();
  for (const s of syn) byConf.set(s.confidence, (byConf.get(s.confidence) ?? 0) + 1);
  for (const [k, v] of [...byConf].sort()) console.log(`  confidence ${k}: ${v}`);
  console.log(`  contradictionFlag: ${syn.filter((s) => s.contradictionFlag).length}`);

  // ── coverage of the 11 hand-map entries ──
  // A hand-map entry (variant -> base) is COVERED when a synonym edge joins the
  // two catalog rows in either direction (synonym is symmetric).
  const key = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const synSet = new Set(
    syn.map((s) =>
      key(normalizeIngredientName(s.from.canonicalName), normalizeIngredientName(s.to.canonicalName)),
    ),
  );
  // Which of the 22 endpoint names even exist as catalog rows?
  const names = [...new Set([...Object.keys(HAND_MAP), ...Object.values(HAND_MAP)])];
  const rows = await prisma.ingredient.findMany({
    where: { canonicalName: { in: names } },
    select: { id: true, canonicalName: true },
  });
  const catalog = new Set(rows.map((r) => r.canonicalName));

  console.log("\n=== MERGE_GROUP_VARIANT_TO_BASE coverage (11 entries) ===");
  console.log(
    "variant".padEnd(30) + "base".padEnd(15) + "variantRow".padEnd(12) + "baseRow".padEnd(10) + "synonymEdge",
  );
  let covered = 0;
  const gaps: string[] = [];
  for (const [variant, base] of Object.entries(HAND_MAP)) {
    const vRow = catalog.has(variant);
    const bRow = catalog.has(base);
    const edge = synSet.has(key(variant, base));
    if (edge) covered++;
    else gaps.push(`${variant} -> ${base}`);
    console.log(
      variant.padEnd(30) +
        base.padEnd(15) +
        (vRow ? "yes" : "NO").padEnd(12) +
        (bRow ? "yes" : "NO").padEnd(10) +
        (edge ? "yes" : "NO"),
    );
  }
  console.log(`\ncovered ${covered}/11   gaps ${gaps.length}`);
  for (const g of gaps) console.log(`  GAP: ${g}`);

  // What synonym edges DO touch these families, so a gap is diagnosable?
  const family = ["olive oil", "pepper", "peppercorn"];
  const touching = syn.filter((s) =>
    family.some(
      (f) => s.from.canonicalName.includes(f) || s.to.canonicalName.includes(f),
    ),
  );
  console.log(`\n=== synonym edges touching olive-oil / pepper families: ${touching.length} ===`);
  for (const s of touching.sort((a, b) => a.from.canonicalName.localeCompare(b.from.canonicalName))) {
    console.log(
      `  ${s.from.canonicalName} <-> ${s.to.canonicalName}  [${s.confidence}, ${s.source}${s.reviewedByHuman ? ", HUMAN" : ""}]`,
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
