// D-WS9-050 P3 — top unmatched-ingredient curation candidates (DRY-RUN ONLY).
//
// Phase 0 found ~204 Ingredient rows with nutritionRefPerUnit.matched:false are
// ordinary foods lost to naming variants (unsalted butter vs the matched butter;
// extra-virgin olive oil vs olive oil). The top-25 by catalog usage cover ~67%
// of catalog ingredient usage — the highest-leverage curation targets.
//
// This script ranks the unmatched rows by CATALOG usage (isPublic meals) and
// proposes an SR-Legacy fdcId for each via FDC search (D-WS7-201: SR Legacy only;
// a Foundation-only candidate is FLAGGED, never silently used). It writes a
// reviewable CSV to scripts/output/ and makes ZERO DB writes. Hans ratifies the
// CSV; apply is a SEPARATE, later step (this script has no --apply).
//
// Run (from artifacts/api-server):
//   node --env-file=.env --import tsx scripts/ws9-macro-curate-top-unmatched.ts [N]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { searchFoods } from "../src/lib/usda/fdcClient";
import { isMatchedRef } from "../src/lib/usda/ingredientEnrichment";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOP_N = Number(process.argv[2] ?? 25);

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // catalog = isPublic meals; usage = dishIngredient rows on their dishes.
    const catalogMeals = await prisma.meal.findMany({
      where: { isPublic: true },
      select: { dishLinks: { select: { dishId: true } } },
    });
    const dishIds = [...new Set(catalogMeals.flatMap((m) => m.dishLinks.map((d) => d.dishId)))];
    const dis = await prisma.dishIngredient.findMany({
      where: { dishId: { in: dishIds } },
      select: { ingredient: { select: { canonicalName: true, displayName: true, category: true, defaultUnit: true, nutritionRefPerUnit: true } } },
    });

    // count usage per canonical; keep only unmatched (matched:false or null ref).
    const usage = new Map<string, { canonical: string; display: string; category: string; unit: string; uses: number }>();
    for (const d of dis) {
      const ing = d.ingredient;
      if (isMatchedRef(ing.nutritionRefPerUnit)) continue; // already grounded
      const key = ing.canonicalName;
      const row = usage.get(key) ?? { canonical: key, display: ing.displayName, category: ing.category, unit: ing.defaultUnit, uses: 0 };
      row.uses++;
      usage.set(key, row);
    }
    const ranked = [...usage.values()].sort((a, b) => b.uses - a.uses).slice(0, TOP_N);
    console.log(`Top ${ranked.length} unmatched ingredients by catalog usage. Searching FDC (SR Legacy)…\n`);

    const out: string[] = [
      ["canonicalName", "displayName", "category", "catalogUses", "proposedFdcId", "usdaDescription", "dataType", "per100kcal", "confidence", "flag"].join(","),
    ];
    for (const r of ranked) {
      // SR Legacy only first; if none, retry incl. Foundation and FLAG it.
      const srRes = await searchFoods(r.canonical, { dataType: ["SR Legacy"], pageSize: 3 });
      let hit = srRes.ok ? srRes.data[0] : undefined;
      let flag = "";
      if (!hit) {
        const anyRes = await searchFoods(r.canonical, { dataType: ["Foundation", "SR Legacy"], pageSize: 3 });
        hit = anyRes.ok ? anyRes.data[0] : undefined;
        if (hit) flag = "FOUNDATION_OR_NONE_review";
      }
      // salt-class foods carry ~0 macros; note them so review doesn't chase a match.
      const zeroMacro = /\bsalt\b/i.test(r.canonical);
      // confidence: exact-ish token overlap heuristic.
      const desc = hit?.description ?? "";
      const overlap = r.canonical.split(/\s+/).filter((t) => desc.toLowerCase().includes(t)).length;
      const confidence = !hit ? "none" : overlap >= 2 ? "high" : overlap === 1 ? "medium" : "low";
      if (hit && hit.dataType === "Foundation") flag = flag || "FOUNDATION_review";
      if (zeroMacro) flag = flag ? `${flag};zero_macro` : "zero_macro";
      out.push(
        [r.canonical, r.display, r.category, r.uses, hit?.fdcId ?? "", desc, hit?.dataType ?? "", "", confidence, flag]
          .map(csvCell)
          .join(","),
      );
      console.log(`  ${String(r.uses).padStart(3)}x ${r.canonical.padEnd(34)} → ${hit ? `[${hit.fdcId}] ${desc} (${hit.dataType}) ${confidence}${flag ? " ⚠" + flag : ""}` : "NO MATCH"}`);
    }

    const dir = join(HERE, "output");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `ws9-curate-top-unmatched-dryrun-${TOP_N}.csv`);
    writeFileSync(path, out.join("\n"));
    console.log(`\nDRY-RUN CSV (no DB writes): ${path}`);
    console.log("Hans ratifies before any apply. SR Legacy only (D-WS7-201); Foundation candidates flagged.");
  } finally {
    await prisma.$disconnect();
  }
}

void main();
