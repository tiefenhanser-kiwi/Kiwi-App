// [grocery] B1 · Part A — PROBE. READ-ONLY.
//
// Four questions the survey could not answer from columns alone:
//   1. does the relation index actually fold the garlic spellings (the A3 note
//      claims BUG-200 is closed; the corpus still shows three garlic rows)?
//   2. what does poolComponentNeeds DO on the two lists where it should have
//      fired — 56b03a57 (garlic ×3) and f5556c19 (cilantro ×3)?
//   3. the pack/default/category facts for the jalapeño + iceberg rows.
//   4. BUG-328 — the honest step-sum minutes for the three meals.
//
//   node --env-file=.env --import tsx scripts/grocery-b1/probe.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
import { poolComponentNeedsUngated } from "../../src/lib/ingredientRelations";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "..", "grocery-census", "out");

const prisma = new PrismaClient();

async function main() {
  const index = await loadRelationIndex(prisma);
  console.log(`index: ${index.clusters.length} clusters · ${index.componentParents.length} component parents · declined ${index.declined.length}`);

  console.log("\n=== 1 — GARLIC FOLD KEYS ===");
  for (const n of ["garlic", "garlic cloves", "garlic head", "head of garlic", "whole garlic head", "garlic clove, minced", "garlic cloves, minced"]) {
    console.log(`  groupKey("${n}") = "${index.groupKey(n)}"  synonymFold = "${index.synonymFold(n)}"`);
  }
  console.log("\n  component parents mentioning garlic:");
  for (const cp of index.componentParents) {
    if (!/garlic/.test(cp.parent)) continue;
    console.log(`    ${cp.parent} [basis ${cp.basisUnit}] slots: ${cp.slots.map((s) => `${s.child}=${s.yieldQuantity}${s.yieldUnit}${s.coHarvestable ? " co" : ""}`).join(", ")}`);
  }
  console.log("\n  cilantro / parsley / lime parents:");
  for (const cp of index.componentParents) {
    if (!/cilantro|parsley|^lime$|^lemon$|basil|thyme/.test(cp.parent)) continue;
    console.log(`    ${cp.parent} [basis ${cp.basisUnit}] slots: ${cp.slots.map((s) => `${s.child}=${s.yieldQuantity}${s.yieldUnit}${s.coHarvestable ? " co" : ""}`).join(", ")}`);
  }

  console.log("\n=== 2 — POOL ON THE TWO LISTS ===");
  for (const id of ["56b03a57", "f5556c19", "96a94410", "31c7a885"]) {
    const j = JSON.parse(readFileSync(join(CORPUS, `live__${id}__r1.json`), "utf8"));
    const res = poolComponentNeedsUngated(j.consolidated, index);
    console.log(`\n-- ${id} (${j.planTitle}) — in ${j.consolidated.length} out ${res.items.length}`);
    for (const f of res.folds) {
      console.log(`   FOLD ${f.parent} raw=${f.rawPool.toFixed(3)} whole=${f.wholeParents} toppedUp=${f.toppedUpExisting} absorbed=[${f.absorbed.map((a: { name: string; quantity: number; unit: string }) => `${a.name} ${a.quantity} ${a.unit}`).join(" | ")}]`);
    }
    for (const d of res.declines) console.log(`   DECLINE ${d.parent} <- ${d.child}: ${d.reason}`);
  }

  console.log("\n=== 3 — JALAPENO / ICEBERG / CABBAGE FACTS ===");
  const names = [
    "pickled jalapeños", "pickled jalapeño slices", "pickled jalapeño brine",
    "jalapeño", "fresh jalapeño", "iceberg lettuce", "shredded iceberg lettuce",
    "iceberg lettuce leaves", "green cabbage", "red cabbage", "lemon", "lemons",
    "lime", "limes", "lime wedges", "fresh lime wedges", "lemon wedges",
    "fresh cilantro", "cilantro", "fresh cilantro leaves", "fresh cilantro stems",
    "fresh flat-leaf parsley", "fresh parsley", "parsley", "flat-leaf parsley",
    "garlic", "garlic cloves", "garlic head", "fennel", "fennel fronds",
  ];
  const rows = await prisma.ingredient.findMany({
    where: { canonicalName: { in: names } },
    select: { id: true, canonicalName: true, category: true, defaultUnit: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true, conversionRef: true },
  });
  for (const n of names) {
    const r = rows.find((x) => x.canonicalName === n);
    if (!r) { console.log(`  ${n}: NO CATALOG ROW`); continue; }
    console.log(`  ${r.canonicalName} [${r.category}] default=${r.defaultUnit} pack=${r.purchaseUnit}/${r.purchaseQuantity}/"${r.purchaseDisplay}" ref=${r.conversionRef ? JSON.stringify(r.conversionRef) : "null"} groupKey="${index.groupKey(r.canonicalName)}"`);
  }

  console.log("\n=== 4 — BUG-328 STEP SUMS ===");
  const titles = [
    "Cheese Ravioli with Marinara and Garlic Bread",
    "Spicy Chicken Scampi with Cherry Tomatoes over Linguine",
    "Sausage and Kale Orecchiette with Crusty Bread",
  ];
  for (const t of titles) {
    const meals = await prisma.meal.findMany({
      where: { title: t },
      select: {
        id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true,
        isTemplate: true, userId: true,
        dishes: { select: { name: true, steps: { select: { durationMinutes: true, instruction: true, isBought: true } } } },
      },
    });
    for (const m of meals) {
      let sum = 0; let n = 0; let nulls = 0;
      for (const d of m.dishes) for (const s of d.steps) {
        if (s.isBought) continue;
        n++;
        if (s.durationMinutes == null) nulls++; else sum += s.durationMinutes;
      }
      console.log(`  ${m.title.slice(0, 55)} | id=${m.id.slice(0, 8)} template=${m.isTemplate} userId=${m.userId ? m.userId.slice(0, 8) : "null"} label=${m.estimatedTimeMinutes} active=${m.activeTimeMinutes} stepSum=${sum} steps=${n} nullDur=${nulls} ratio=${(sum / m.estimatedTimeMinutes).toFixed(2)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
