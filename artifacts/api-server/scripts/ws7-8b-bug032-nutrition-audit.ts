// WS7-8b / BUG-032 — nutrition-pointer audit sweep (PHASE 1: DRY-RUN ONLY).
//
// The nutrition arc joined catalog ingredients to USDA records using a LOOSE
// containment guardrail (nameMatches). Phase 0 proved that guardrail passes the
// bug's core class STRUCTURALLY — every wrong-food row shares the head noun and
// carries no form disqualifier (sweet potato -> "Sweet potato leaves, raw" is
// usable=TRUE). So the string matcher cannot audit itself.
//
// This sweep replaces the matcher with an AI JUDGE (Opus, Hans Ruling 1): for
// each of the ~329 matched rows it asks whether the stored USDA record describes
// the ingredient AS A RECIPE WOULD USE IT, feeding the judge THREE channels —
// canonicalName, FDC description, and the stored per-100g macros (Ruling 2).
//
// READ-ONLY. It fetches descriptions (getFoodsBatch) and writes ONE CSV to
// scripts/output/. It NEVER writes Ingredient. The judge has NO write path: a
// YES leaves the row untouched (Ruling 4). --apply is Phase 2, not here.
//
// Run (PowerShell, from artifacts/api-server):
//   node --env-file=.env --import tsx scripts/ws7-8b-bug032-nutrition-audit.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";

import {
  getFoodsBatch,
  isUsdaEnabled,
  type FdcFood,
} from "../src/lib/usda/fdcClient";
import {
  isMatchedRef,
  tokenizeForMatch,
  type NutritionRefMatched,
} from "../src/lib/usda/ingredientEnrichment";
import { usdaConversionUsable } from "../src/lib/usda/portionConversions";
import { encodeCsvRow } from "./ws7-8b-usda-backfill";

// Hans Ruling 1 — Opus, deliberately. The judge does the exact work the string
// matcher failed at; capability converts directly into fewer poisoned survivors.
const MODEL_OPUS = "claude-opus-4-8";
const JUDGE_CONCURRENCY = 5;
const JUDGE_RETRIES = 2;
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");

const CSV_HEADER = [
  "verdict",
  "canonicalName",
  "fdcDescription",
  "fdcId",
  "calories",
  "fat",
  "protein",
  "carbs",
  "judgeReason",
  "guardrailVerdict",
  "overlapRatio",
  "hansRuling",
] as const;

// Known-answer check (Hans) — confirmed-bad rows. If the judge does not return
// NO on ALL of these the pipeline is miscalibrated; abort rather than ship.
const KNOWN_BAD = new Set([
  "sweet potato",
  "chicken broth",
  "frozen peas",
  "lime zest",
  "avocado",
]);

type Verdict = "YES" | "NO" | "UNSURE";

interface AuditRow {
  canonicalName: string;
  fdcId: number;
  description: string;
  per100g: NutritionRefMatched["per100g"];
  verdict: Verdict;
  judgeReason: string;
  guardrailPass: boolean;
  overlapRatio: number;
}

// Ordering metric ONLY (Phase 0: the detector is boolean, no score). Shared
// content tokens between name and description, divided by the description's
// token count — a low ratio means the FDC record carries many qualifier tokens
// the ingredient lacks ("...leaves", "canned, no broth"), i.e. a looser match.
function overlapRatio(name: string, description: string): number {
  const nameTokens = tokenizeForMatch(name);
  const descTokens = tokenizeForMatch(description);
  if (descTokens.size === 0) return 0;
  let shared = 0;
  for (const t of nameTokens) if (descTokens.has(t)) shared++;
  return Math.round((shared / descTokens.size) * 100) / 100;
}

function buildJudgePrompt(
  name: string,
  description: string,
  per100g: NutritionRefMatched["per100g"],
): string {
  return `You are auditing a nutrition database join. A recipe ingredient was matched to a USDA FoodData Central record by a loose string matcher; some matches are wrong. Judge THIS one.

Ingredient (as a recipe names it): "${name}"
Matched USDA record: "${description}"
Stored per-100g macros from that USDA record: calories ${per100g.calories}, fat ${per100g.fat} g, protein ${per100g.protein} g, carbs ${per100g.carbs} g

Question: does this USDA record describe this ingredient AS A RECIPE WOULD ACTUALLY USE IT?

Answer NO when the record is:
  - a DIFFERENT food that merely shares a word — e.g. "sweet potato" matched to "Sweet potato LEAVES" (the tuber vs the plant's greens), "chicken broth" matched to "Chicken, canned, NO broth", "frozen peas" matched to "Peas and CARROTS", "lime zest" matched to a whole "Limes, raw", "avocado" matched to "Oil, avocado".
  - the RIGHT food in the WRONG STATE for how a recipe names it — e.g. a recipe's "1 cup rice / quinoa / wild rice" means DRY, so a USDA "cooked" grain row is WRONG (cooked grams are largely water; both density and per-quantity macros are off).

Use the macros as an INDEPENDENT second channel: a record that is ~100% fat with ~0 protein and ~0 carbs cannot be a vegetable, no matter how its description reads.

Answer YES when the record is the same food in a usable state.

CALIBRATION — do not flag pedantry. Only flag differences that can actually move a MACRO or a DENSITY in a way that matters. Negligible differences are YES: "flaky sea salt" -> "Salt, table" (salt is sodium, not macros); "pearl onion" -> "Onions, raw" (a rounding error by weight). When a difference cannot change any macro or density meaningfully, it is YES.

Answer UNSURE only when you genuinely cannot tell from the three inputs.

Respond with ONLY a single JSON object, no prose, no markdown fences:
{"verdict": "YES" | "NO" | "UNSURE", "reason": "<one short line>"}`;
}

function parseJudgeReply(text: string): { verdict: Verdict; reason: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { verdict: "UNSURE", reason: "unparseable judge reply" };
  }
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as {
      verdict?: unknown;
      reason?: unknown;
    };
    const v = String(obj.verdict ?? "").toUpperCase();
    const verdict: Verdict =
      v === "YES" || v === "NO" || v === "UNSURE" ? (v as Verdict) : "UNSURE";
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    return { verdict, reason: reason || (verdict === "UNSURE" ? "no reason given" : "") };
  } catch {
    return { verdict: "UNSURE", reason: "unparseable judge reply" };
  }
}

async function judgeOne(
  anthropic: Anthropic,
  name: string,
  description: string,
  per100g: NutritionRefMatched["per100g"],
): Promise<{ verdict: Verdict; reason: string }> {
  const prompt = buildJudgePrompt(name, description, per100g);
  for (let attempt = 0; attempt <= JUDGE_RETRIES; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model: MODEL_OPUS,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      });
      const text = msg.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      return parseJudgeReply(text);
    } catch (err) {
      if (attempt === JUDGE_RETRIES) {
        return {
          verdict: "UNSURE",
          reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await sleep(500 * (attempt + 1));
    }
  }
  return { verdict: "UNSURE", reason: "judge exhausted retries" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const VERDICT_ORDER: Record<Verdict, number> = { NO: 0, UNSURE: 1, YES: 2 };

async function main(): Promise<void> {
  if (!isUsdaEnabled()) {
    console.error("USDA_INGREDIENTS_API_KEY not set — cannot fetch descriptions. Aborting.");
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    // 1. Load matched pointers (the 329-row audit surface).
    const all = await prisma.ingredient.findMany({
      select: { canonicalName: true, nutritionRefPerUnit: true },
      orderBy: { canonicalName: "asc" },
    });
    const matched: Array<{ canonicalName: string; ref: NutritionRefMatched }> = [];
    for (const r of all) {
      const ref = r.nutritionRefPerUnit;
      if (isMatchedRef(ref) && typeof ref.fdcId === "number") {
        matched.push({ canonicalName: r.canonicalName, ref });
      }
    }
    console.log(`\n=== BUG-032 nutrition-pointer audit (DRY-RUN) ===`);
    console.log(`  catalog rows:        ${all.length}`);
    console.log(`  matched (fdcId):     ${matched.length}  <- audit surface\n`);

    // 2. Fetch descriptions for every stored fdcId (dedup — some are shared).
    // Full-format records are heavy (they carry foodPortions), so a 20-id chunk
    // can blow the 10s timeout. Fetch in small chunks with per-chunk retries
    // (mirroring the B2 conversion backfill); a chunk that never lands is left
    // unfetched (its rows judge as UNSURE) rather than aborting the whole run.
    // A 429 rate-limit still aborts — re-run later.
    const FETCH_CHUNK = 8;
    const FETCH_RETRIES = 3;
    const fdcIds = [...new Set(matched.map((m) => m.ref.fdcId))];
    console.log(`  unique fdcIds to fetch: ${fdcIds.length}`);
    const descById = new Map<number, FdcFood>();
    let fetchAbandoned = 0;
    for (let i = 0; i < fdcIds.length; i += FETCH_CHUNK) {
      const chunk = fdcIds.slice(i, i + FETCH_CHUNK);
      let ok = false;
      for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
        const res = await getFoodsBatch(chunk);
        if (res.ok) {
          for (const f of res.data) descById.set(f.fdcId, f);
          ok = true;
          break;
        }
        if (res.reason === "rate_limited") {
          console.error(`\n! USDA rate-limited (429). Re-run later.`);
          process.exitCode = 1;
          return;
        }
        await sleep(300 * attempt);
      }
      if (!ok) fetchAbandoned += chunk.length;
      process.stdout.write(
        `\r  fetched ${Math.min(i + FETCH_CHUNK, fdcIds.length)}/${fdcIds.length} (abandoned ${fetchAbandoned})   `,
      );
      await sleep(150);
    }
    process.stdout.write("\n");
    const unfetched = fdcIds.filter((id) => !descById.has(id));
    if (unfetched.length > 0) {
      console.warn(`  WARNING: ${unfetched.length} fdcId(s) returned no record: ${unfetched.join(", ")}`);
    }
    console.log(`  fetched descriptions:   ${descById.size}/${fdcIds.length}\n`);

    // 3. Judge every row (Opus, bounded concurrency). Independent per Ruling 1.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const rows: AuditRow[] = new Array(matched.length);
    let done = 0;
    let cursor = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const idx = cursor++;
        if (idx >= matched.length) return;
        const m = matched[idx];
        const food = descById.get(m.ref.fdcId);
        const description = food?.description ?? "(FDC record not returned)";
        const { verdict, reason } = food
          ? await judgeOne(anthropic, m.canonicalName, description, m.ref.per100g)
          : { verdict: "UNSURE" as Verdict, reason: "FDC description unavailable" };
        rows[idx] = {
          canonicalName: m.canonicalName,
          fdcId: m.ref.fdcId,
          description,
          per100g: m.ref.per100g,
          verdict,
          judgeReason: reason,
          guardrailPass: usdaConversionUsable(m.canonicalName, food?.description ?? null),
          overlapRatio: overlapRatio(m.canonicalName, description),
        };
        done++;
        process.stdout.write(`\r  judged ${done}/${matched.length}   `);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(JUDGE_CONCURRENCY, matched.length) }, () => worker()),
    );
    process.stdout.write("\n");

    // 4. Sort: NO, UNSURE, YES; within each block loosest overlap first.
    rows.sort((a, b) => {
      const vo = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
      if (vo !== 0) return vo;
      if (a.overlapRatio !== b.overlapRatio) return a.overlapRatio - b.overlapRatio;
      return a.canonicalName.localeCompare(b.canonicalName);
    });

    // 5. Emit CSV.
    const csvLines = [encodeCsvRow([...CSV_HEADER])];
    for (const r of rows) {
      csvLines.push(
        encodeCsvRow([
          r.verdict,
          r.canonicalName,
          r.description,
          r.fdcId,
          r.per100g.calories,
          r.per100g.fat,
          r.per100g.protein,
          r.per100g.carbs,
          r.judgeReason,
          r.guardrailPass ? "pass" : "fail",
          r.overlapRatio,
          "", // hansRuling — Hans fills this in
        ]),
      );
    }
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const outPath = join(OUTPUT_DIR, `bug032-nutrition-audit-${timestamp(new Date())}.csv`);
    writeFileSync(outPath, csvLines.join("\n") + "\n", "utf8");

    // 6. Summary + known-answer check.
    const counts: Record<Verdict, number> = { NO: 0, UNSURE: 0, YES: 0 };
    for (const r of rows) counts[r.verdict]++;
    console.log(`--- Verdict counts ---`);
    console.log(`  NO:     ${counts.NO}`);
    console.log(`  UNSURE: ${counts.UNSURE}`);
    console.log(`  YES:    ${counts.YES}`);
    console.log(`  total:  ${rows.length}\n`);

    console.log(`--- Known-answer check (must all be NO) ---`);
    let kaFail = 0;
    for (const name of KNOWN_BAD) {
      const r = rows.find((x) => x.canonicalName === name);
      const status = !r ? "MISSING" : r.verdict === "NO" ? "NO  ok" : `${r.verdict}  <-- MISCALIBRATED`;
      if (!r || r.verdict !== "NO") kaFail++;
      console.log(`  ${name.padEnd(16)} ${status}  ${r ? `[${r.fdcId}] ${r.description}` : ""}`);
    }
    console.log(
      kaFail === 0
        ? `\n  known-answer check PASSED — CSV is trustworthy.`
        : `\n  known-answer check FAILED (${kaFail}) — judge miscalibrated, DO NOT trust the CSV.`,
    );

    console.log(`\n  CSV: ${outPath}\n`);

    // Machine-readable tail for the report (parsed by nothing; eyeballed by CC).
    console.log(`@@NO_BLOCK_START@@`);
    for (const r of rows.filter((x) => x.verdict === "NO")) {
      console.log(`NO\t${r.overlapRatio}\t${r.canonicalName}\t[${r.fdcId}] ${r.description}\tcal=${r.per100g.calories} fat=${r.per100g.fat} pro=${r.per100g.protein} carb=${r.per100g.carbs}\tguard=${r.guardrailPass ? "pass" : "fail"}\t${r.judgeReason}`);
    }
    console.log(`@@UNSURE_BLOCK_START@@`);
    for (const r of rows.filter((x) => x.verdict === "UNSURE")) {
      console.log(`UNSURE\t${r.overlapRatio}\t${r.canonicalName}\t[${r.fdcId}] ${r.description}\tcal=${r.per100g.calories} fat=${r.per100g.fat} pro=${r.per100g.protein} carb=${r.per100g.carbs}\tguard=${r.guardrailPass ? "pass" : "fail"}\t${r.judgeReason}`);
    }
    console.log(`@@YES_SAMPLE_START@@`);
    for (const r of rows.filter((x) => x.verdict === "YES").slice(0, 15)) {
      console.log(`YES\t${r.overlapRatio}\t${r.canonicalName}\t[${r.fdcId}] ${r.description}\tcal=${r.per100g.calories} fat=${r.per100g.fat} pro=${r.per100g.protein} carb=${r.per100g.carbs}\tguard=${r.guardrailPass ? "pass" : "fail"}\t${r.judgeReason}`);
    }
    console.log(`@@END@@`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
