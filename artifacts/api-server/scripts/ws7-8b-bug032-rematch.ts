// WS7-8b / BUG-032 — Phase 2 re-match sweep (DRY-RUN ONLY, NO WRITES).
//
// Phase 1 (ws7-8b-bug032-nutrition-audit.ts) produced a judged CSV. Hans ruled
// it: ~95 rows are wrong-food / wrong-state pointers to FIX, 7 are accepted, and
// 13 fdcIds are DEAD (404 at FDC) covering 26 rows that must be re-searched.
//
// This script re-searches every in-scope row by canonicalName via searchFoods,
// asks an Opus judge to pick the record that describes the ingredient AS A
// RECIPE WOULD USE IT (raw/dry, whole food, macros must fit), and classifies the
// proposal into AUTO-PROPOSE / ESCALATE / MISS. It writes ONE reviewable CSV.
//
// READ-ONLY. NO Ingredient writes. --apply is Phase 4, only after Hans ratifies.
//
// Run (PowerShell, from artifacts/api-server):
//   node --env-file=.env --import tsx scripts/ws7-8b-bug032-rematch.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { Prisma, PrismaClient } from "@prisma/client";

import {
  extractPer100gMacros,
  getFood,
  isUsdaEnabled,
  searchFoods,
  type FdcFood,
  type Per100gMacros,
} from "../src/lib/usda/fdcClient";
import {
  buildMatchedRef,
  buildMissMarker,
  isMatchedRef,
} from "../src/lib/usda/ingredientEnrichment";
import { encodeCsvRow, parseCsv } from "./ws7-8b-usda-backfill";

const MODEL_OPUS = "claude-opus-4-8";
const JUDGE_CONCURRENCY = 5;
const JUDGE_RETRIES = 2;
const MAX_CANDIDATES = 20;
// Deeper page than the default 25: the plain "X, raw" record often ranks below
// processed/branded/near-token variants, and a shallow page turns a real match
// into a false MISS (verified: "sweet potato" -> raw tuber sits past the top 25).
const SEARCH_PAGE_SIZE = 50;
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");

// Hans Ruling A/B — rows accepted as close-enough; NEVER re-matched.
const ACCEPTED = new Set([
  "beef chuck roast",
  "beef brisket flat",
  "beef strip steak",
  "boneless ribeye steak",
  "boneless pork shoulder",
  "green onion",
  "olive oil spray",
]);

// Hand-pinned fdcIds for rows where FDC's relevance ranking buries the plain
// raw/dry staple beneath processed/branded variants, so the name-search + judge
// falsely returns MISS (verified: "sweet potato" never surfaces [168482] raw
// tuber in a rankable window; "whole milk" never surfaces plain fluid milk).
// Each was recovered via a targeted query and getFood-verified below. bucket
// records whether the pin is an exact match (AUTO) or a substitution/judgment
// call (ESCALATE) Hans should rule. `fresh tarragon` is deliberately NOT pinned
// — USDA genuinely has only dried tarragon, so it stays a real MISS.
const MANUAL_PIN: Record<string, { fdcId: number; bucket: Bucket }> = {
  // ── Recall-recovery pins (FDC ranking buried the plain record) ──
  "sweet potato": { fdcId: 168482, bucket: "AUTO" }, // Sweet potato, raw, unprepared
  tomato: { fdcId: 170457, bucket: "AUTO" }, // Tomatoes, red, ripe, raw, year round average
  tomatoes: { fdcId: 170457, bucket: "AUTO" },
  spaghetti: { fdcId: 169736, bucket: "AUTO" }, // Pasta, dry, enriched
  "whole chicken": { fdcId: 171447, bucket: "AUTO" }, // Chicken, broilers or fryers, meat and skin, raw
  "whole milk": { fdcId: 171265, bucket: "AUTO" }, // Milk, whole, 3.25% milkfat, +vit D
  "brown rice": { fdcId: 169703, bucket: "AUTO" }, // Rice, brown, long-grain, raw
  "sandwich bread": { fdcId: 167532, bucket: "AUTO" }, // Bread, white wheat
  "yellow potato": { fdcId: 170026, bucket: "ESCALATE" }, // no raw yellow-flesh record → generic raw potato
  "small potato": { fdcId: 170026, bucket: "ESCALATE" }, // generic raw potato (flesh and skin)
  "mixed greens": { fdcId: 169249, bucket: "ESCALATE" }, // no salad-blend record → leaf lettuce as representative
  "ribeye steak": { fdcId: 168612, bucket: "ESCALATE" }, // Beef, rib eye, small end, lean AND fat, choice, raw
  // ── Hans rulings (Phase 2 report) ──
  apples: { fdcId: 171688, bucket: "AUTO" }, // Ruling 4: Apples, raw, WITH skin (nobody peels)
  "chicken tenderloins": { fdcId: 171077, bucket: "AUTO" }, // Ruling 4: breast MEAT ONLY (tenderloin is skinless)
  "black beans": { fdcId: 175188, bucket: "AUTO" }, // Ruling 2: cooked/canned (the can you open), not dry
  // ── Ruling 1 + "prefer the pointer that can be checked again" — every Foundation
  //    id is searchable but 404s on by-id fetch, so it must be swapped to the
  //    SR-Legacy (fetchable) equivalent or the next audit re-flags it as dead.
  "american cheese": { fdcId: 171290, bucket: "AUTO" },
  "beef hot dogs": { fdcId: 173862, bucket: "AUTO" },
  broccoli: { fdcId: 170379, bucket: "AUTO" },
  cheddar: { fdcId: 173414, bucket: "AUTO" },
  "cheddar cheese": { fdcId: 173414, bucket: "AUTO" },
  "shredded cheddar cheese": { fdcId: 173414, bucket: "AUTO" },
  "cherry tomato": { fdcId: 170457, bucket: "AUTO" }, // no SR-Legacy grape/cherry → red ripe raw as representative
  "diced tomatoes": { fdcId: 170051, bucket: "AUTO" }, // Tomatoes, red, ripe, canned, packed in tomato juice
  "canned diced tomatoes": { fdcId: 170051, bucket: "AUTO" },
  "dill pickle": { fdcId: 168558, bucket: "AUTO" },
  "dill pickle chips": { fdcId: 168558, bucket: "AUTO" },
  "dill pickle slices": { fdcId: 168558, bucket: "AUTO" },
  egg: { fdcId: 171287, bucket: "AUTO" }, // Egg, whole, raw, fresh (fixes 0-fat egg-white pointer)
  eggs: { fdcId: 171287, bucket: "AUTO" },
  "large egg": { fdcId: 171287, bucket: "AUTO" },
  "large eggs": { fdcId: 171287, bucket: "AUTO" },
  "jarred salsa": { fdcId: 174524, bucket: "AUTO" },
  "mild salsa": { fdcId: 174524, bucket: "AUTO" },
  "salsa roja": { fdcId: 174524, bucket: "AUTO" },
  salsa: { fdcId: 174524, bucket: "AUTO" },
  "low-moisture mozzarella": { fdcId: 171244, bucket: "AUTO" }, // Cheese, mozzarella, low moisture, part-skim
  "low-moisture mozzarella cheese": { fdcId: 171244, bucket: "AUTO" },
  "marinara sauce": { fdcId: 171192, bucket: "AUTO" },
  orange: { fdcId: 169097, bucket: "AUTO" }, // Oranges, raw, all commercial varieties
  oranges: { fdcId: 169097, bucket: "AUTO" },
  "swiss cheese": { fdcId: 171251, bucket: "AUTO" },
  "whole milk ricotta cheese": { fdcId: 170851, bucket: "AUTO" },
  "whole-milk ricotta": { fdcId: 170851, bucket: "AUTO" },
  "whole-milk ricotta cheese": { fdcId: 170851, bucket: "AUTO" },
  "yellow mustard": { fdcId: 172234, bucket: "AUTO" },
  "black forest ham": { fdcId: 173864, bucket: "AUTO" }, // Ham, sliced, regular (~11% fat)
  "cooked ham": { fdcId: 173864, bucket: "AUTO" },
};

const CSV_HEADER = [
  "bucket",
  "ingredientId",
  "canonicalName",
  "isDeadPointer",
  "oldFdcId",
  "oldDescription",
  "newFdcId",
  "newDescription",
  "newDataType",
  "newCal",
  "newFat",
  "newProtein",
  "newCarbs",
  "runnerUpFdcId",
  "runnerUpDescription",
  "judgeReason",
  "hansRuling",
] as const;

type Bucket = "AUTO" | "ESCALATE" | "MISS";

interface Candidate {
  fdcId: number;
  description: string;
  dataType: string;
  per100g: Per100gMacros;
}

interface Proposal {
  ingredientId: string;
  canonicalName: string;
  isDead: boolean;
  oldFdcId: number | null;
  oldDescription: string;
  bucket: Bucket;
  pick: Candidate | null;
  runnerUp: Candidate | null;
  reason: string;
  candidates: Candidate[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function latestAuditCsv(): string {
  const files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith("bug032-nutrition-audit-") && f.endsWith(".csv"))
    .sort();
  if (files.length === 0) throw new Error("no bug032-nutrition-audit-*.csv found in output/");
  return join(OUTPUT_DIR, files[files.length - 1]);
}

// Only macro-complete candidates are usable (a nutrition pointer needs per100g).
function toCandidates(foods: FdcFood[]): Candidate[] {
  const out: Candidate[] = [];
  for (const f of foods) {
    const m = extractPer100gMacros(f);
    if (!m) continue;
    out.push({
      fdcId: f.fdcId,
      description: f.description ?? "",
      dataType: f.dataType ?? "?",
      per100g: m,
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

function formatCandidates(cands: Candidate[]): string {
  return cands
    .map(
      (c, i) =>
        `${i}: ${c.description} [${c.dataType}] — cal ${c.per100g.calories}, fat ${c.per100g.fat}, protein ${c.per100g.protein}, carbs ${c.per100g.carbs}`,
    )
    .join("\n");
}

function buildRematchPrompt(name: string, candidateList: string): string {
  return `You are RE-MATCHING a recipe ingredient to the correct USDA FoodData Central record. The previous match was WRONG and has been discarded. Choose fresh.

Ingredient (as a recipe names it): "${name}"

Candidate USDA records (index: description [dataType] — per-100g cal/fat/protein/carbs):
${candidateList}

Pick the ONE candidate that describes this ingredient AS A RECIPE WOULD ACTUALLY USE IT:
  - RAW / DRY unless the name says otherwise ("rice"/"quinoa" = dry grain; "shrimp" = raw; "potato" = raw tuber). A "cooked"/"baked"/"fried" record for a plainly-named staple is WRONG.
  - the WHOLE food, not a derivative (oil, powder, flour, juice, dried/dehydrated), not a prepared dish or branded composite (a sub sandwich, a platter), not a byproduct (skin, leaves).
  - macros must FIT: a vegetable is not ~100% fat; a broth is not 185 kcal of solid meat; lean ground beef is not the 70/30 grade. If a candidate's description and macros disagree, it is wrong.

Then classify:
  - "AUTO"     — exactly ONE candidate is clearly correct and unambiguous.
  - "ESCALATE" — more than one candidate is plausible, OR it is a real judgment call. Give your best pick AND a runnerUp index.
  - "MISS"     — NO candidate honestly matches (all are derivatives/dishes/wrong food/wrong state). pick = null.

Respond with ONLY one JSON object, no prose, no fences:
{"pick": <index or null>, "bucket": "AUTO" | "ESCALATE" | "MISS", "runnerUp": <index or null>, "reason": "<one short line>"}`;
}

interface JudgeReply {
  pick: number | null;
  bucket: Bucket;
  runnerUp: number | null;
  reason: string;
}

function parseJudgeReply(text: string, n: number): JudgeReply {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { pick: null, bucket: "MISS", runnerUp: null, reason: "unparseable judge reply" };
  }
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const inRange = (v: unknown): number | null =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v < n ? v : null;
    const b = String(o.bucket ?? "").toUpperCase();
    const bucket: Bucket = b === "AUTO" || b === "ESCALATE" || b === "MISS" ? (b as Bucket) : "ESCALATE";
    const pick = inRange(o.pick);
    return {
      pick,
      bucket: pick === null && bucket !== "MISS" ? "MISS" : bucket,
      runnerUp: inRange(o.runnerUp),
      reason: typeof o.reason === "string" ? o.reason : "",
    };
  } catch {
    return { pick: null, bucket: "MISS", runnerUp: null, reason: "unparseable judge reply" };
  }
}

async function judge(
  anthropic: Anthropic,
  name: string,
  cands: Candidate[],
): Promise<JudgeReply> {
  if (cands.length === 0) {
    return { pick: null, bucket: "MISS", runnerUp: null, reason: "no macro-complete USDA candidates" };
  }
  const prompt = buildRematchPrompt(name, formatCandidates(cands));
  for (let attempt = 0; attempt <= JUDGE_RETRIES; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model: MODEL_OPUS,
        max_tokens: 250,
        messages: [{ role: "user", content: prompt }],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      return parseJudgeReply(text, cands.length);
    } catch (err) {
      if (attempt === JUDGE_RETRIES) {
        return {
          pick: null,
          bucket: "ESCALATE",
          runnerUp: null,
          reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await sleep(500 * (attempt + 1));
    }
  }
  return { pick: null, bucket: "ESCALATE", runnerUp: null, reason: "judge exhausted retries" };
}

const BUCKET_ORDER: Record<Bucket, number> = { ESCALATE: 0, AUTO: 1, MISS: 2 };

async function runDryRun(): Promise<void> {
  if (!isUsdaEnabled()) {
    console.error("USDA_INGREDIENTS_API_KEY not set — cannot re-search. Aborting.");
    process.exitCode = 1;
    return;
  }

  // 1. Read the ratified audit CSV → in-scope names.
  const auditPath = latestAuditCsv();
  const auditRows = parseCsv(readFileSync(auditPath, "utf8")).slice(1);
  // audit CSV cols: verdict,name,fdcDescription,fdcId,...
  interface InScope { name: string; oldFdcId: number | null; oldDesc: string; isDead: boolean }
  const inScope: InScope[] = [];
  for (const r of auditRows) {
    const verdict = r[0];
    const name = r[1];
    const oldDesc = r[2] ?? "";
    const oldFdcId = r[3] ? Number(r[3]) : null;
    const isDead = oldDesc === "(FDC record not returned)";
    if (verdict === "NO" && !ACCEPTED.has(name)) inScope.push({ name, oldFdcId, oldDesc, isDead });
    else if (verdict === "UNSURE") inScope.push({ name, oldFdcId, oldDesc, isDead });
  }

  console.log(`\n=== BUG-032 Phase 2 re-match (DRY-RUN) ===`);
  console.log(`  audit CSV: ${auditPath}`);
  console.log(`  in-scope rows: ${inScope.length}  (dead pointers: ${inScope.filter((r) => r.isDead).length})\n`);

  // 2. Resolve ingredientIds by canonicalName (unique).
  const prisma = new PrismaClient();
  const proposals: Proposal[] = [];
  try {
    const dbRows = await prisma.ingredient.findMany({
      where: { canonicalName: { in: inScope.map((r) => r.name) } },
      select: { id: true, canonicalName: true, nutritionRefPerUnit: true },
    });
    const idByName = new Map(dbRows.map((r) => [r.canonicalName, r.id]));

    // 3. Re-search + judge, bounded concurrency.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let done = 0;
    let cursor = 0;
    const results: Proposal[] = new Array(inScope.length);
    async function worker(): Promise<void> {
      for (;;) {
        const idx = cursor++;
        if (idx >= inScope.length) return;
        const row = inScope[idx];
        const pin = MANUAL_PIN[row.name];
        if (pin) {
          // Recall-recovery pin: fetch the specific record, skip search+judge.
          const f = await getFood(pin.fdcId);
          const cand =
            f.ok && extractPer100gMacros(f.data)
              ? {
                  fdcId: f.data.fdcId,
                  description: f.data.description ?? "",
                  dataType: f.data.dataType ?? "?",
                  per100g: extractPer100gMacros(f.data) as Per100gMacros,
                }
              : null;
          results[idx] = {
            ingredientId: idByName.get(row.name) ?? "",
            canonicalName: row.name,
            isDead: row.isDead,
            oldFdcId: row.oldFdcId,
            oldDescription: row.oldDesc,
            bucket: cand ? pin.bucket : "MISS",
            pick: cand,
            runnerUp: null,
            reason: cand
              ? `HAND-PINNED (FDC ranking buried the plain record; recovered via targeted query): ${cand.description}`
              : `hand-pin fdcId ${pin.fdcId} did not fetch`,
            candidates: cand ? [cand] : [],
          };
          done++;
          process.stdout.write(`\r  re-matched ${done}/${inScope.length}   `);
          await sleep(120);
          continue;
        }
        const search = await searchFoods(row.name, { pageSize: SEARCH_PAGE_SIZE });
        const cands = search.ok ? toCandidates(search.data) : [];
        const jr = await judge(anthropic, row.name, cands);
        results[idx] = {
          ingredientId: idByName.get(row.name) ?? "",
          canonicalName: row.name,
          isDead: row.isDead,
          oldFdcId: row.oldFdcId,
          oldDescription: row.oldDesc,
          bucket: jr.bucket,
          pick: jr.pick !== null ? cands[jr.pick] : null,
          runnerUp: jr.runnerUp !== null ? cands[jr.runnerUp] : null,
          reason: jr.reason,
          candidates: cands,
        };
        done++;
        process.stdout.write(`\r  re-matched ${done}/${inScope.length}   `);
        await sleep(120);
      }
    }
    await Promise.all(Array.from({ length: JUDGE_CONCURRENCY }, () => worker()));
    process.stdout.write("\n");
    proposals.push(...results);
  } finally {
    await prisma.$disconnect();
  }

  // 4. Sort: ESCALATE, AUTO, MISS; dead pointers first within bucket; then name.
  proposals.sort((a, b) => {
    const bo = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (bo !== 0) return bo;
    if (a.isDead !== b.isDead) return a.isDead ? -1 : 1;
    return a.canonicalName.localeCompare(b.canonicalName);
  });

  // 5. Emit CSV.
  const csvLines = [encodeCsvRow([...CSV_HEADER])];
  for (const p of proposals) {
    csvLines.push(
      encodeCsvRow([
        p.bucket,
        p.ingredientId,
        p.canonicalName,
        p.isDead ? "DEAD" : "",
        p.oldFdcId ?? "",
        p.oldDescription,
        p.pick?.fdcId ?? "",
        p.pick?.description ?? "",
        p.pick?.dataType ?? "",
        p.pick?.per100g.calories ?? "",
        p.pick?.per100g.fat ?? "",
        p.pick?.per100g.protein ?? "",
        p.pick?.per100g.carbs ?? "",
        p.runnerUp?.fdcId ?? "",
        p.runnerUp?.description ?? "",
        p.reason,
        "",
      ]),
    );
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = join(OUTPUT_DIR, `bug032-rematch-${timestamp(new Date())}.csv`);
  writeFileSync(outPath, csvLines.join("\n") + "\n", "utf8");

  // 6. Console blocks.
  const counts: Record<Bucket, number> = { AUTO: 0, ESCALATE: 0, MISS: 0 };
  for (const p of proposals) counts[p.bucket]++;
  console.log(`--- Buckets ---`);
  console.log(`  AUTO:     ${counts.AUTO}`);
  console.log(`  ESCALATE: ${counts.ESCALATE}`);
  console.log(`  MISS:     ${counts.MISS}`);
  console.log(`  total:    ${proposals.length}`);
  const idResolveFail = proposals.filter((p) => !p.ingredientId);
  if (idResolveFail.length > 0) {
    console.warn(`  WARNING: ${idResolveFail.length} name(s) had no ingredientId: ${idResolveFail.map((p) => p.canonicalName).join(", ")}`);
  }
  console.log(`\n  CSV: ${outPath}\n`);

  const line = (p: Proposal): string =>
    `${p.isDead ? "DEAD " : ""}${p.canonicalName}\tOLD [${p.oldFdcId ?? "-"}] ${p.oldDescription}\tNEW [${p.pick?.fdcId ?? "-"}] ${p.pick?.description ?? "(none)"}${p.pick ? ` (cal ${p.pick.per100g.calories} fat ${p.pick.per100g.fat} pro ${p.pick.per100g.protein} carb ${p.pick.per100g.carbs})` : ""}\t${p.reason}`;

  console.log(`@@AUTO@@`);
  for (const p of proposals.filter((x) => x.bucket === "AUTO")) console.log(line(p));
  console.log(`@@ESCALATE@@`);
  for (const p of proposals.filter((x) => x.bucket === "ESCALATE")) {
    console.log(line(p) + `\tRUNNERUP [${p.runnerUp?.fdcId ?? "-"}] ${p.runnerUp?.description ?? "(none)"}`);
    // show all candidates for escalations
    for (const c of p.candidates)
      console.log(`     cand ${c.fdcId}: ${c.description} [${c.dataType}] — cal ${c.per100g.calories} fat ${c.per100g.fat} pro ${c.per100g.protein} carb ${c.per100g.carbs}`);
  }
  console.log(`@@MISS@@`);
  for (const p of proposals.filter((x) => x.bucket === "MISS")) {
    console.log(line(p));
    for (const c of p.candidates.slice(0, 6))
      console.log(`     cand ${c.fdcId}: ${c.description} [${c.dataType}] — cal ${c.per100g.calories} fat ${c.per100g.fat} pro ${c.per100g.protein} carb ${c.per100g.carbs}`);
  }
  console.log(`@@END@@`);
}

// ── APPLY (Phase 4, only after Hans ratifies the CSV) ──────────────────────
// Reuses buildMatchedRef / buildMissMarker (the shared shape) so re-writes can
// never drift from the reactive enrichment path. Writes ONLY nutritionRefPerUnit.
//   • bucket MISS                       → buildMissMarker (honest ai_estimated fallback)
//   • newFdcId present AND != oldFdcId  → buildMatchedRef with the new pointer + macros
//   • newFdcId == oldFdcId (no-op)      → skip (e.g. lime zest, accepted as-is)
async function runApply(csvPath: string): Promise<void> {
  const rows = parseCsv(readFileSync(csvPath, "utf8")).slice(1); // drop header
  const fetchedAt = new Date().toISOString();
  const prisma = new PrismaClient();
  try {
    const ids = rows.map((r) => r[1]).filter(Boolean);
    const existing = new Set(
      (await prisma.ingredient.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
        (r) => r.id,
      ),
    );

    console.log(`\n=== BUG-032 Phase 2 re-match (APPLY) ===`);
    console.log(`  CSV: ${csvPath}`);
    console.log(`  data rows: ${rows.length}\n`);

    let matched = 0;
    let missMarkers = 0;
    let skippedNoop = 0;
    let skippedOther = 0;
    for (const r of rows) {
      const bucket = r[0];
      const ingredientId = r[1] ?? "";
      const name = r[2] ?? "";
      const oldFdcId = r[4] ? Number(r[4]) : null;
      const newFdcId = r[6] ? Number(r[6]) : null;
      const newDesc = r[7] ?? "";
      const newDataType = r[8] || undefined;
      if (!ingredientId || !existing.has(ingredientId)) {
        console.warn(`  skip (no ingredient): ${name}`);
        skippedOther++;
        continue;
      }
      if (bucket === "MISS") {
        await prisma.ingredient.update({
          where: { id: ingredientId },
          data: {
            nutritionRefPerUnit: buildMissMarker(fetchedAt) as unknown as Prisma.InputJsonValue,
          },
        });
        missMarkers++;
        console.log(`  MISS-marker: ${name}`);
        continue;
      }
      if (newFdcId === null || Number.isNaN(newFdcId)) {
        console.warn(`  skip (no newFdcId): ${name}`);
        skippedOther++;
        continue;
      }
      if (newFdcId === oldFdcId) {
        skippedNoop++;
        console.log(`  skip (no-op, accepted as-is): ${name} [${newFdcId}]`);
        continue;
      }
      const per100g: Per100gMacros = {
        calories: Number(r[9]),
        fat: Number(r[10]),
        protein: Number(r[11]),
        carbs: Number(r[12]),
      };
      if (Object.values(per100g).some((v) => Number.isNaN(v))) {
        console.warn(`  skip (bad macros): ${name}`);
        skippedOther++;
        continue;
      }
      // foodCategory is metadata-only and not carried in the CSV → null (mirrors
      // the USDA backfill apply path). buildMatchedRef stamps source:'usda'.
      const food: FdcFood = { fdcId: newFdcId, description: newDesc, dataType: newDataType };
      await prisma.ingredient.update({
        where: { id: ingredientId },
        data: {
          nutritionRefPerUnit: buildMatchedRef(food, per100g, fetchedAt) as unknown as Prisma.InputJsonValue,
        },
      });
      matched++;
    }

    console.log(`\n--- Applied ---`);
    console.log(`  matched re-writes:   ${matched}`);
    console.log(`  miss-markers:        ${missMarkers}`);
    console.log(`  skipped (no-op):     ${skippedNoop}`);
    console.log(`  skipped (other):     ${skippedOther}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const applyIdx = argv.indexOf("--apply");
  if (applyIdx !== -1) {
    const path = argv[applyIdx + 1];
    if (!path) throw new Error("--apply requires a path to the ratified CSV");
    await runApply(path);
  } else {
    await runDryRun();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
