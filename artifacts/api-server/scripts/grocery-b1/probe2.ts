// [grocery] B1 · Part A — PROBE 2. READ-ONLY.
// Why does the garlic group refuse? And BUG-328's step sums (probe 1 used a
// field that does not exist on Meal).
//   node --env-file=.env --import tsx scripts/grocery-b1/probe2.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { loadRelationIndex } from "../../src/lib/relationIndexLoader";
import { mergeConvertibleGroups } from "../../src/lib/groceryMerge";
import { resolveConversion, canonicalUnitToken } from "../../src/lib/ingredientConversions";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "..", "grocery-census", "out");
const prisma = new PrismaClient();

async function main() {
  const index = await loadRelationIndex(prisma);

  for (const id of ["56b03a57", "c404a3cf", "14879176", "247cd7bb", "f5556c19", "96a94410"]) {
    const j = JSON.parse(readFileSync(join(CORPUS, `live__${id}__r1.json`), "utf8"));
    type Row = { canonicalName: string; quantity: number; unit: string; conversionRef?: unknown };
    const rows = j.consolidated as Row[];
    // group exactly as mergeConvertibleGroups does
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = index.groupKey(r.canonicalName);
      const g = groups.get(k) ?? [];
      g.push(r);
      groups.set(k, g);
    }
    const multi = [...groups].filter(([, g]) => g.length > 1);
    const merged = mergeConvertibleGroups(rows as never, index);
    console.log(`\n### ${id} — ${rows.length} in / ${merged.length} out · ${multi.length} multi-row groups`);
    for (const [k, g] of multi) {
      const conv = (() => {
        for (const it of g) {
          const c = resolveConversion(it.canonicalName, it.conversionRef);
          if (c) return { from: it.canonicalName, c };
        }
        return null;
      })();
      const survived = merged.filter((m: { canonicalName: string }) => index.groupKey(m.canonicalName) === k);
      console.log(`  group "${k}" (${g.length} rows -> ${survived.length}):`);
      for (const it of g) {
        const own = resolveConversion(it.canonicalName, it.conversionRef);
        console.log(`     ${it.canonicalName} ${it.quantity} ${it.unit} [tok=${canonicalUnitToken(it.unit)}] ownSubUnit=${own?.subUnit ? JSON.stringify(own.subUnit) : "-"} ownRef=${own ? own.source : "null"}`);
      }
      console.log(`     groupConversion comes from "${conv?.from ?? "(none)"}" subUnit=${conv?.c.subUnit ? JSON.stringify(conv.c.subUnit) : "NONE"}`);
    }
  }

  console.log("\n=== BUG-328 STEP SUMS ===");
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
        sourceType: true, isPublic: true, userId: true,
        dishes: { select: { name: true, steps: { select: { durationMinutes: true, isBought: true } } } },
      },
    });
    if (meals.length === 0) console.log(`  (no meal titled "${t}")`);
    for (const m of meals) {
      let sum = 0, n = 0, nulls = 0, bought = 0;
      for (const d of m.dishes) for (const s of d.steps) {
        if (s.isBought) { bought++; continue; }
        n++;
        if (s.durationMinutes == null) nulls++; else sum += s.durationMinutes;
      }
      console.log(`  ${m.title.slice(0, 58)}`);
      console.log(`     id=${m.id.slice(0, 8)} src=${m.sourceType} public=${m.isPublic} user=${m.userId ? m.userId.slice(0, 8) : "null"} label=${m.estimatedTimeMinutes} active=${m.activeTimeMinutes} | stepSum=${sum} steps=${n} nullDur=${nulls} boughtSkipped=${bought} ratio=${(sum / m.estimatedTimeMinutes).toFixed(2)}`);
    }
  }

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
