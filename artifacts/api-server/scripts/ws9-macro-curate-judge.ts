// D-WS9-050 Phase 2 D — REBUILT top-unmatched curation (DRY-RUN ONLY).
//
// Phase 1's naive top-1 FDC search was unusable (kosher salt→"dill pickles").
// This reuses the BUG-028 AI-JUDGE pipeline (decideForIngredient: FDC search →
// deterministic guardrail → Haiku candidate-pick) from ws7-8b-usda-backfill.ts,
// scoped to the MACRO-RELEVANT unmatched set (zero-macro salt/spices/herbs are
// excluded and reported separately — they don't move a macro). SR Legacy ONLY
// (D-WS7-201): the injected search restricts dataType, and any Foundation is
// flagged. Writes a reviewable CSV; ZERO DB writes; Hans ratifies row by row.
//
// Run: node --env-file=.env --import tsx scripts/ws9-macro-curate-judge.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";

import {
  searchFoods,
  getFood,
  extractPer100gMacros,
  type FdcFood,
  type FdcResult,
} from "../src/lib/usda/fdcClient";
import { isMatchedRef } from "../src/lib/usda/ingredientEnrichment";
import { normalizeUsdaQuery } from "../src/lib/usda/usdaQueryNormalize";
import {
  decideForIngredient,
  buildAiAssistPrompt,
  parseAiPickReply,
  type AiPickResult,
} from "./ws7-8b-usda-backfill";

const HERE = dirname(fileURLToPath(import.meta.url));

// Zero-macro: salt / pepper / leavening / dried & fresh herbs & spices. These
// contribute ~0 kcal at recipe quantities, so grounding them doesn't move a
// macro — excluded from the curation and reported separately. NB: "garlic
// cloves" is NOT a spice (it's produce) and stays in scope.
const ZERO_MACRO = /\b(salt|pepper|baking soda|baking powder|yeast|water|ice)\b|\b(oregano|basil|thyme|rosemary|dill|cilantro|parsley|cumin|coriander|paprika|cinnamon|nutmeg|cayenne|turmeric|allspice|bay lea|garam masala|chili powder|garlic powder|onion powder|red pepper flakes|italian season|herbes de|sesame seeds?)\b/i;
// S3.1 (BUG-044): the \bpepper\b alternative also swept in "bell pepper" and
// "chipotle pepper in adobo" — foods with REAL macros (~31 kcal/100g, carbs,
// fiber). Exclude those two from the zero-macro set so they flow into curation.
// Still excluded: black/white pepper, peppercorns, red pepper flakes (matched by
// their own terms), plus garlic cloves (produce, not a spice).
const isZeroMacro = (n: string): boolean =>
  ZERO_MACRO.test(n) &&
  !/garlic clove/i.test(n) &&
  !/\bbell pepper\b/i.test(n) &&
  !/\bchipotle\b/i.test(n);

// Retrieval query is normalized for RETRIEVAL only — decideForIngredient still
// judges against the FULL original name (S2.3).
type FallbackTier = "normalized" | "base" | "forced" | "miss";

// R4/R5 (P3-REBUILD-2) — Hans-ruled FORCED matches. Each REPLACES the judge's
// outcome with a specific SR-Legacy fdcId Hans ratified, because the generic
// record's macros are validated-CLOSE (not merely convenient):
//   • dijon mustard → yellow mustard: mustard contributes ~0 macro at 1-2 tsp;
//     Grey Poupon vs French's macros don't diverge materially. (Was a MISS.)
//   • low-sodium chicken stock → ready-to-serve low-sodium broth: the apter
//     cooking-liquid macro than the CONDENSED concentrate the judge picked
//     (16 kcal ready-to-serve vs 31 kcal condensed). (Was an AI_PICK regression.)
// This is NOT "force every miss" — the R7 genuine gaps (prosciutto, kalamata,
// pizza dough, …) stay MISSes because their substitutes' macros DO diverge.
const FORCED_MATCH: Record<string, { fdcId: number; note: string }> = {
  "dijon mustard": {
    fdcId: 172234,
    note: "R4 Hans-ruled: generic prepared yellow mustard; ~0 macro at recipe qty; grounding 8 rows beats an honest gap",
  },
  "low-sodium chicken stock": {
    fdcId: 171609,
    note: "R5 Hans-ruled: revert to ready-to-serve low-sodium chicken broth (16 kcal), apter than condensed concentrate (31 kcal)",
  },
};

// Wrap a pre-fetched SR-Legacy result as a no-op search dep so we can reuse the
// BUG-028 decideForIngredient() routing (AUTO / AI_PICK / MISS) unchanged.
const cachedSearch = (result: FdcResult<FdcFood[]>) =>
  (async () => result) as typeof searchFoods;

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    // catalog-unmatched by usage
    const catalogMeals = await prisma.meal.findMany({ where: { isPublic: true }, select: { dishLinks: { select: { dishId: true } } } });
    const dishIds = [...new Set(catalogMeals.flatMap((m) => m.dishLinks.map((d) => d.dishId)))];
    const dis = await prisma.dishIngredient.findMany({ where: { dishId: { in: dishIds } }, select: { ingredient: { select: { canonicalName: true, category: true, nutritionRefPerUnit: true } } } });
    const uses = new Map<string, { name: string; cat: string; n: number }>();
    for (const d of dis) {
      const ing = d.ingredient;
      if (isMatchedRef(ing.nutritionRefPerUnit)) continue;
      const r = uses.get(ing.canonicalName) ?? { name: ing.canonicalName, cat: ing.category, n: 0 };
      r.n++; uses.set(ing.canonicalName, r);
    }
    const ranked = [...uses.values()].sort((a, b) => b.n - a.n);
    const zeroMacro = ranked.filter((r) => isZeroMacro(r.name));
    const macroRelevant = ranked.filter((r) => !isZeroMacro(r.name));

    // Haiku judge (BUG-028 reuse). SR-Legacy-only is enforced inside
    // resolveWithFallback (D-WS7-201); decideForIngredient's own search dep is a
    // no-op closure that returns the already-resolved (fallback-picked) result.
    const aiPick = async (name: string, candidates: FdcFood[]): Promise<AiPickResult> => {
      const list = candidates.map((f, i) => `${i}: ${f.description} [${f.dataType}] (fdcId ${f.fdcId})`).join("\n");
      const msg = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 200, temperature: 0, messages: [{ role: "user", content: buildAiAssistPrompt(name, list) }] });
      const txt = (msg.content.find((b) => b.type === "text") as { text?: string } | undefined)?.text ?? "";
      return parseAiPickReply(txt);
    };

    console.log(`macro-relevant unmatched: ${macroRelevant.length}  |  zero-macro excluded: ${zeroMacro.length}\n`);
    const rows: string[] = [["canonicalName", "normalizedQuery", "fallbackTier", "category", "catalogUses", "decision", "proposedFdcId", "usdaDescription", "dataType", "per100kcal", "confidence", "flag", "judgeReasoning"].join(",")];
    const dec = { AUTO: 0, AI_PICK: 0, MISS: 0 };
    // Tier attribution: where the WINS came from, and why the MISSes missed.
    const tiers = { normalizedWin: 0, baseWin: 0, forced: 0, judgeMiss: 0, retrievalMiss: 0 };
    for (const r of macroRelevant) {
      const norm = normalizeUsdaQuery(r.name, r.cat);

      // Tier 1 — normalized query. SR-Legacy-only (D-WS7-201).
      const r1 = await searchFoods(norm.normalized, { dataType: ["SR Legacy"] });
      let d = await decideForIngredient(r.name, { search: cachedSearch(r1), aiPick });
      let queryUsed = norm.normalized;
      let hitTier: FallbackTier =
        d.decision === "MISS" ? "miss" : "normalized";

      // Progressive fallback (S1.5, extended). S1.5 falls back on 0 results; the
      // spot-check found variety tokens return JUNK (not 0), so the tier-1 judge
      // MISS is the real signal. Retry the base noun on ANY tier-1 miss when a
      // distinct base exists — a strict superset (0-result misses fall back too).
      // Only ever upgrades a MISS to a base-noun WIN; tier-1 wins are untouched.
      if (d.decision === "MISS" && norm.hasFallback) {
        const r2 = await searchFoods(norm.baseNoun, { dataType: ["SR Legacy"] });
        const d2 = await decideForIngredient(r.name, { search: cachedSearch(r2), aiPick });
        queryUsed = norm.baseNoun;
        if (d2.decision !== "MISS") {
          d = d2;
          hitTier = "base";
        }
      }

      // R4/R5 — Hans-ruled forced override: REPLACE the judge's outcome with a
      // specific ratified SR-Legacy record. Retrieval-agnostic; per-100 macros
      // come from the record itself so the CSV row stays complete.
      const forced = FORCED_MATCH[r.name];
      if (forced) {
        const f = await getFood(forced.fdcId);
        if (f.ok) {
          d = {
            decision: "AI_PICK",
            food: f.data,
            per100g: extractPer100gMacros(f.data),
            aiReason: forced.note,
            candidateCount: d.candidateCount,
          };
          hitTier = "forced";
          queryUsed = `[forced fdcId ${forced.fdcId}]`;
        } else {
          console.warn(`  ! FORCED getFood(${forced.fdcId}) failed for ${r.name}: ${f.reason}`);
        }
      }

      dec[d.decision]++;
      if (hitTier === "normalized") tiers.normalizedWin++;
      else if (hitTier === "base") tiers.baseWin++;
      else if (hitTier === "forced") tiers.forced++;
      else if (d.candidateCount > 0) tiers.judgeMiss++;
      else tiers.retrievalMiss++;

      const conf =
        hitTier === "forced" ? "forced" : d.decision === "AUTO" ? "high" : d.decision === "AI_PICK" ? "medium" : "none";
      const nonSr = d.food && d.food.dataType !== "SR Legacy" ? `NON_SR_LEGACY:${d.food.dataType}` : "";
      const flag = hitTier === "forced" ? ["FORCED", nonSr].filter(Boolean).join(";") : nonSr;
      rows.push([r.name, queryUsed, hitTier, r.cat, r.n, d.decision, d.food?.fdcId ?? "", d.food?.description ?? "", d.food?.dataType ?? "", d.per100g?.calories ?? "", conf, flag, d.aiReason].map(csvCell).join(","));
      console.log(`  ${String(r.n).padStart(3)}x ${r.name.padEnd(34)} [${hitTier.padEnd(10)} q="${queryUsed}"] → ${d.decision.padEnd(7)} ${d.food ? `[${d.food.fdcId}] ${d.food.description}` : "MISS: " + d.aiReason}`);
      await new Promise((res) => setTimeout(res, 150)); // gentle USDA throttle
    }

    const dir = join(HERE, "output");
    mkdirSync(dir, { recursive: true });
    // NEW path — the -normalized CSV is preserved as the 15% baseline.
    const path = join(dir, `ws9-curate-judge-p3rebuild2-dryrun.csv`);
    writeFileSync(path, rows.join("\n"));
    // zero-macro exclusion audit (reflects the S3.1 bell-pepper correction)
    const zpath = join(dir, `ws9-curate-zero-macro-excluded-p3rebuild2.csv`);
    writeFileSync(zpath, ["canonicalName,category,catalogUses", ...zeroMacro.map((r) => `${csvCell(r.name)},${csvCell(r.cat)},${r.n}`)].join("\n"));

    const total = macroRelevant.length;
    const hits = dec.AUTO + dec.AI_PICK;
    const pct = (x: number) => `${((x / total) * 100).toFixed(0)}%`;
    console.log(`\n=== AFTER (P3-REBUILD-2) ===`);
    console.log(`  total macro-relevant: ${total}`);
    console.log(`  AUTO ${dec.AUTO} · AI_PICK ${dec.AI_PICK} · MISS ${dec.MISS}`);
    console.log(`  hit rate: ${hits}/${total} (${pct(hits)})   miss rate: ${dec.MISS}/${total} (${pct(dec.MISS)})`);
    console.log(`  tier breakdown — wins: normalized ${tiers.normalizedWin}, base-noun ${tiers.baseWin}, forced ${tiers.forced}  |  misses: judge-rejected ${tiers.judgeMiss}, retrieval-0 ${tiers.retrievalMiss}`);
    console.log(`\nDRY-RUN CSV: ${path}`);
    console.log(`Zero-macro EXCLUDED (post S3.1 correction): ${zpath}`);
    console.log(`  excluded: ${zeroMacro.map((r) => `${r.name}(${r.n})`).join(", ")}`);
    console.log("SR Legacy only (D-WS7-201); any Foundation flagged. Hans ratifies row by row. Not applied.");
  } finally {
    await prisma.$disconnect();
  }
}

void main();
