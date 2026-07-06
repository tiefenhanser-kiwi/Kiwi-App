// WS7-8b USDA Block 2 — catalog nutrition backfill / quarterly-refresh script.
//
// This ONE script is both the one-time catalog backfill AND the quarterly
// refresh (Hans-ruled 6b). Manual invocation only — NO scheduler, no cron.
// It writes ONLY Ingredient.nutritionRefPerUnit; it NEVER reads or writes
// Ingredient.category and NEVER calls inferCategory (Ruling 4).
//
// Two-phase, mirroring the BUG-017 backfill (Ruling 2):
//   DRY-RUN (default) — SELECT-only. For each in-scope ingredient: USDA search
//     → deterministic guardrail (selectMatch) → AI-assist pick for the leftovers
//     → emit a CSV row. ZERO DB writes.
//   --apply <csv>     — read the Hans-reviewed CSV and write nutritionRefPerUnit.
//     NO USDA and NO AI calls in apply.
//
// Hans's CSV review contract (also in --help):
//   • delete a row      → that ingredient is left entirely untouched
//   • edit decision→MISS → a miss-marker is written instead of the match
//   • otherwise          → the row applies as-is (AUTO/AI_PICK → match shape)
//
// Selection scope:
//   default             → rows with nutritionRefPerUnit == null
//   --retry-misses      → also rows carrying a miss-marker (matched === false)
//   --refresh-stale <ISO> → also matched rows with fetchedAt older than <ISO>
//   (flags combine)
//
// Run (PowerShell, from artifacts/api-server):
//   DRY-RUN:        node --env-file=.env --import tsx scripts/ws7-8b-usda-backfill.ts
//   RETRY MISSES:   node --env-file=.env --import tsx scripts/ws7-8b-usda-backfill.ts --retry-misses
//   REFRESH STALE:  node --env-file=.env --import tsx scripts/ws7-8b-usda-backfill.ts --refresh-stale 2026-04-06
//   APPLY:          node --env-file=.env --import tsx scripts/ws7-8b-usda-backfill.ts --apply scripts/output/usda-backfill-dryrun-<ts>.csv
//
// Rate limits: USDA key is 1000 req/hr. 383 rows fit comfortably; we still
// throttle (~2-3 req/s) and abort cleanly on a 429 — the partial CSV is kept,
// just re-run later.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { Prisma, PrismaClient } from "@prisma/client";

import { MODEL_HAIKU } from "../src/lib/ai/promptRegistry";
import {
  extractPer100gMacros,
  isUsdaEnabled,
  searchFoods,
  type FdcFood,
  type Per100gMacros,
} from "../src/lib/usda/fdcClient";
import {
  buildMatchedRef,
  buildMissMarker,
  isMatchedRef,
  selectMatch,
  type NutritionRefMatched,
  type NutritionRefMiss,
} from "../src/lib/usda/ingredientEnrichment";

// ── constants ─────────────────────────────────────────────────────────────

export const AI_ASSIST_TOP_N = 10;
const THROTTLE_MS = 350; // ~2.8 req/s — well under the 1000/hr ceiling
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");

export const CSV_HEADER = [
  "ingredientId",
  "ingredientName",
  "decision",
  "fdcId",
  "usdaDescription",
  "dataType",
  "cal100g",
  "protein100g",
  "carbs100g",
  "fat100g",
  "aiReason",
  "candidateCount",
] as const;

// Thrown on a USDA transport/rate-limit failure so main() can flush the
// partial CSV and exit cleanly (Ruling 6).
export class BackfillAbortError extends Error {}

// ── argument parsing ────────────────────────────────────────────────────

export interface ParsedArgs {
  mode: "dryrun" | "apply";
  applyPath: string | null;
  retryMisses: boolean;
  refreshStaleBefore: Date | null;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    mode: "dryrun",
    applyPath: null,
    retryMisses: false,
    refreshStaleBefore: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--retry-misses") {
      args.retryMisses = true;
    } else if (a === "--apply") {
      args.mode = "apply";
      args.applyPath = argv[++i] ?? null;
      if (!args.applyPath) throw new Error("--apply requires a path to the reviewed CSV");
    } else if (a === "--refresh-stale") {
      const raw = argv[++i];
      if (!raw) throw new Error("--refresh-stale requires an ISO date (e.g. 2026-04-06)");
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw new Error(`--refresh-stale: invalid date "${raw}"`);
      args.refreshStaleBefore = d;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

// ── selection ─────────────────────────────────────────────────────────────

export interface CatalogRow {
  id: string;
  canonicalName: string;
  displayName: string;
  nutritionRefPerUnit: unknown;
}

export interface SelectionOpts {
  retryMisses: boolean;
  refreshStaleBefore: Date | null;
}

function isMissMarker(v: unknown): v is NutritionRefMiss {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as Record<string, unknown>).source === "usda" &&
    (v as Record<string, unknown>).matched === false
  );
}

/**
 * Pure scope filter. null rows are always in scope; miss-markers only with
 * --retry-misses; matched rows only with --refresh-stale AND a fetchedAt older
 * than the cutoff. Unknown shapes are left alone.
 */
export function selectInScope(rows: CatalogRow[], opts: SelectionOpts): CatalogRow[] {
  return rows.filter((r) => {
    const ref = r.nutritionRefPerUnit;
    if (ref === null || ref === undefined) return true;
    if (isMissMarker(ref)) return opts.retryMisses;
    if (isMatchedRef(ref)) {
      if (!opts.refreshStaleBefore) return false;
      const fetched = new Date(ref.fetchedAt);
      return !Number.isNaN(fetched.getTime()) && fetched < opts.refreshStaleBefore;
    }
    return false;
  });
}

// ── decision routing (dry-run) ────────────────────────────────────────────

export type Decision = "AUTO" | "AI_PICK" | "MISS";

export interface DecisionResult {
  decision: Decision;
  food: FdcFood | null;
  per100g: Per100gMacros | null;
  aiReason: string;
  candidateCount: number;
}

export interface AiPickResult {
  pick: number | null;
  reason: string;
}

export type SearchFn = typeof searchFoods;
export type AiPickFn = (name: string, candidates: FdcFood[]) => Promise<AiPickResult>;

/**
 * Decide the outcome for ONE ingredient. Async deps are injected so this is
 * unit-testable with mocks (no live USDA, no live Anthropic).
 *
 * Routing:
 *   search fails (429/network/…) → throw BackfillAbortError (keep partial CSV)
 *   0 candidates                 → MISS
 *   selectMatch passes           → AUTO
 *   guardrail rejects, AI picks a
 *     candidate with complete macros → AI_PICK
 *   AI picks null / out-of-range / a
 *     candidate with incomplete macros → MISS  (conservative — no fall-through)
 */
export async function decideForIngredient(
  name: string,
  deps: { search: SearchFn; aiPick: AiPickFn },
): Promise<DecisionResult> {
  const res = await deps.search(name);
  if (!res.ok) {
    throw new BackfillAbortError(
      `USDA search failed for "${name}" (reason: ${res.reason}). ` +
        `Partial CSV kept — re-run later.`,
    );
  }
  const foods = res.data;
  const candidateCount = foods.length;
  if (candidateCount === 0) {
    return { decision: "MISS", food: null, per100g: null, aiReason: "no USDA candidates", candidateCount: 0 };
  }

  const auto = selectMatch(name, foods);
  if (auto) {
    return { decision: "AUTO", food: auto.food, per100g: auto.per100g, aiReason: "", candidateCount };
  }

  // Guardrail rejected — AI-assist among the top candidates.
  const top = foods.slice(0, AI_ASSIST_TOP_N);
  const pick = await deps.aiPick(name, top);
  if (pick.pick === null || pick.pick < 0 || pick.pick >= top.length) {
    return { decision: "MISS", food: null, per100g: null, aiReason: pick.reason, candidateCount };
  }
  const chosen = top[pick.pick];
  const per100g = extractPer100gMacros(chosen);
  if (!per100g) {
    return {
      decision: "MISS",
      food: null,
      per100g: null,
      aiReason: `AI picked "${chosen.description}" but its macros are incomplete`,
      candidateCount,
    };
  }
  return { decision: "AI_PICK", food: chosen, per100g, aiReason: pick.reason, candidateCount };
}

// ── AI-assist prompt (script-local — NOT the seeded prompt infra) ──────────

/**
 * The inline Haiku prompt used to pick among USDA candidates the deterministic
 * guardrail could not auto-accept. This is a one-off ops prompt; it is
 * deliberately NOT added to aiPrompts.ts / the prompt registry.
 */
export function buildAiAssistPrompt(name: string, candidateList: string): string {
  return `You are matching a recipe ingredient to the correct USDA FoodData Central food record.

Ingredient (as written in the app): "${name}"

Candidate USDA foods (index: description [dataType]):
${candidateList}

Pick the ONE candidate that is the same generic food as the ingredient. Prefer a plain, unprepared, generic form over a branded, seasoned, or heavily-processed one. If NONE of the candidates is clearly the same food, pick null. Do not guess; when unsure, choose null.

Respond with ONLY a single JSON object, no prose and no markdown fences:
{"pick": <candidate index as an integer, or null>, "reason": "<one short line>"}`;
}

function formatCandidates(candidates: FdcFood[]): string {
  return candidates
    .map((c, i) => `${i}: ${c.description ?? "(no description)"} [${c.dataType ?? "?"}]`)
    .join("\n");
}

/** Tolerant JSON extraction from a model text reply. Returns a safe MISS-shaped
 * result on any parse problem. */
export function parseAiPickReply(text: string): AiPickResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { pick: null, reason: "unparseable AI reply" };
  }
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as {
      pick?: unknown;
      reason?: unknown;
    };
    const pick =
      typeof obj.pick === "number" && Number.isInteger(obj.pick) ? obj.pick : null;
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    return { pick, reason };
  } catch {
    return { pick: null, reason: "unparseable AI reply" };
  }
}

function makeRealAiPick(anthropic: Anthropic): AiPickFn {
  return async (name, candidates) => {
    const prompt = buildAiAssistPrompt(name, formatCandidates(candidates));
    const msg = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return parseAiPickReply(text);
  };
}

// ── CSV (RFC4180-ish; descriptions contain commas) ─────────────────────────

export function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function encodeCsvRow(fields: Array<string | number>): string {
  return fields.map(csvEscape).join(",");
}

/** Parse CSV text into rows of string fields. Handles quoted fields with
 * embedded commas/quotes/newlines and CRLF (Windows). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    sawAny = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip — handled by the \n branch
    } else {
      field += c;
    }
  }
  if (sawAny && (field.length > 0 || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

export function decisionToCsvFields(
  row: CatalogRow,
  d: DecisionResult,
): Array<string | number> {
  return [
    row.id,
    row.canonicalName,
    d.decision,
    d.food?.fdcId ?? "",
    d.food?.description ?? "",
    d.food?.dataType ?? "",
    d.per100g?.calories ?? "",
    d.per100g?.protein ?? "",
    d.per100g?.carbs ?? "",
    d.per100g?.fat ?? "",
    d.aiReason,
    d.candidateCount,
  ];
}

// ── apply ─────────────────────────────────────────────────────────────────

export type ApplyAction =
  | { kind: "write-match"; ingredientId: string; record: NutritionRefMatched }
  | { kind: "write-miss"; ingredientId: string; marker: NutritionRefMiss }
  | { kind: "invalid"; ingredientId: string; reason: string };

/** Map one reviewed CSV data row (fields aligned to CSV_HEADER) to an action. */
export function applyActionFromCsvFields(
  fields: string[],
  fetchedAt: string,
): ApplyAction {
  const ingredientId = fields[0] ?? "";
  const decision = fields[2] ?? "";
  if (!ingredientId) return { kind: "invalid", ingredientId: "", reason: "missing ingredientId" };

  if (decision === "MISS") {
    return { kind: "write-miss", ingredientId, marker: buildMissMarker(fetchedAt) };
  }
  if (decision === "AUTO" || decision === "AI_PICK") {
    const per100g: Per100gMacros = {
      calories: Number(fields[6]),
      protein: Number(fields[7]),
      carbs: Number(fields[8]),
      fat: Number(fields[9]),
    };
    if (
      Number.isNaN(per100g.calories) ||
      Number.isNaN(per100g.protein) ||
      Number.isNaN(per100g.carbs) ||
      Number.isNaN(per100g.fat)
    ) {
      return { kind: "invalid", ingredientId, reason: "non-numeric macro field(s)" };
    }
    // foodCategory is metadata-only (Ruling 4) and not carried in the CSV, so
    // apply-time records set it to null (buildMatchedRef reads food.foodCategory,
    // which is undefined here → null). Reactively-enriched rows may carry it.
    const food: FdcFood = {
      fdcId: Number(fields[3]),
      description: fields[4] ?? "",
      dataType: fields[5] || undefined,
    };
    return { kind: "write-match", ingredientId, record: buildMatchedRef(food, per100g, fetchedAt) };
  }
  return { kind: "invalid", ingredientId, reason: `unknown decision "${decision}"` };
}

/** The DB update payload for an action — ONLY ever touches nutritionRefPerUnit
 * (Ruling 4 invariant, unit-tested). Returns null for invalid actions. */
export function applyDataForAction(a: ApplyAction): Prisma.IngredientUpdateInput | null {
  if (a.kind === "write-match") {
    return { nutritionRefPerUnit: a.record as unknown as Prisma.InputJsonValue };
  }
  if (a.kind === "write-miss") {
    return { nutritionRefPerUnit: a.marker as unknown as Prisma.InputJsonValue };
  }
  return null;
}

// ── CLI wiring (only runs when executed directly, not on import) ────────────

const HELP = `
WS7-8b USDA catalog backfill / quarterly-refresh.

DRY-RUN (default): SELECT-only. Searches USDA per in-scope ingredient, applies
the deterministic guardrail, AI-assists the leftovers, and writes a CSV to
scripts/output/. No DB writes.

  node --env-file=.env --import tsx scripts/ws7-8b-usda-backfill.ts [--retry-misses] [--refresh-stale <ISO-date>]

APPLY: reads the reviewed CSV and writes nutritionRefPerUnit. No USDA/AI calls.

  node --env-file=.env --import tsx scripts/ws7-8b-usda-backfill.ts --apply <csv-path>

CSV review contract (edit the dry-run CSV before --apply):
  • delete a row       → the ingredient is left entirely untouched
  • change decision→MISS → a miss-marker is written instead of the match
  • otherwise           → the row applies as-is

Scope flags (dry-run): default = null rows only; --retry-misses adds
miss-marker rows; --refresh-stale <ISO> adds matched rows fetched before <ISO>.
`;

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDryRun(prisma: PrismaClient, args: ParsedArgs): Promise<void> {
  if (!isUsdaEnabled()) {
    console.error(
      "USDA_INGREDIENTS_API_KEY is not set — cannot run a dry-run. Aborting.",
    );
    process.exitCode = 1;
    return;
  }

  const all = await prisma.ingredient.findMany({
    select: { id: true, canonicalName: true, displayName: true, nutritionRefPerUnit: true },
    orderBy: { canonicalName: "asc" },
  });
  const scope = selectInScope(all as CatalogRow[], {
    retryMisses: args.retryMisses,
    refreshStaleBefore: args.refreshStaleBefore,
  });

  console.log(`\n=== WS7-8b USDA backfill (DRY-RUN) ===`);
  console.log(`  catalog rows:        ${all.length}`);
  console.log(`  in scope:            ${scope.length}`);
  console.log(`    (retry-misses=${args.retryMisses}, refresh-stale=${args.refreshStaleBefore?.toISOString().slice(0, 10) ?? "off"})\n`);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const deps = { search: searchFoods, aiPick: makeRealAiPick(anthropic) };

  const csvLines: string[] = [encodeCsvRow([...CSV_HEADER])];
  const counts: Record<Decision, number> = { AUTO: 0, AI_PICK: 0, MISS: 0 };
  const aiPickEcho: string[] = [];
  let aborted = false;

  for (let i = 0; i < scope.length; i++) {
    const row = scope[i];
    let result: DecisionResult;
    try {
      result = await decideForIngredient(row.canonicalName, deps);
    } catch (err) {
      if (err instanceof BackfillAbortError) {
        console.error(`\n! ${err.message}`);
        aborted = true;
        break;
      }
      throw err;
    }
    counts[result.decision]++;
    csvLines.push(encodeCsvRow(decisionToCsvFields(row, result)));
    if (result.decision === "AI_PICK" && aiPickEcho.length < 15) {
      aiPickEcho.push(
        `  ${row.canonicalName} → [${result.food?.fdcId}] ${result.food?.description}  (${result.aiReason})`,
      );
    }
    process.stdout.write(
      `\r  processed ${i + 1}/${scope.length}  (AUTO ${counts.AUTO} · AI_PICK ${counts.AI_PICK} · MISS ${counts.MISS})   `,
    );
    await sleep(THROTTLE_MS);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = join(OUTPUT_DIR, `usda-backfill-dryrun-${timestamp(new Date())}.csv`);
  writeFileSync(outPath, csvLines.join("\n") + "\n", "utf8");

  console.log(`\n\n--- Summary ---`);
  console.log(`  AUTO:    ${counts.AUTO}`);
  console.log(`  AI_PICK: ${counts.AI_PICK}`);
  console.log(`  MISS:    ${counts.MISS}`);
  console.log(`  rows written to CSV: ${csvLines.length - 1}${aborted ? " (PARTIAL — aborted)" : ""}`);
  if (aiPickEcho.length > 0) {
    console.log(`\n  first ${aiPickEcho.length} AI_PICK rows (eyeball these):`);
    for (const line of aiPickEcho) console.log(line);
  }
  console.log(`\n  CSV: ${outPath}`);
  console.log(
    `  Review it, then apply:\n    node --env-file=.env --import tsx scripts/ws7-8b-usda-backfill.ts --apply "${outPath}"\n`,
  );
}

async function runApply(prisma: PrismaClient, args: ParsedArgs): Promise<void> {
  const path = args.applyPath as string;
  const text = readFileSync(path, "utf8");
  const rows = parseCsv(text);
  if (rows.length === 0) {
    console.error("empty CSV — nothing to apply.");
    return;
  }
  const [header, ...dataRows] = rows;
  if (header[0] !== CSV_HEADER[0] || header[2] !== CSV_HEADER[2]) {
    console.error(
      `CSV header does not look like a backfill dry-run file (got: ${header.join(",")}).`,
    );
    process.exitCode = 1;
    return;
  }

  const fetchedAt = new Date().toISOString();
  const actions = dataRows.map((f) => applyActionFromCsvFields(f, fetchedAt));

  // Ownership / existence guard: skip rows whose ingredient no longer exists.
  const ids = actions.map((a) => a.ingredientId).filter(Boolean);
  const existing = new Set(
    (await prisma.ingredient.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
      (r) => r.id,
    ),
  );

  console.log(`\n=== WS7-8b USDA backfill (APPLY) ===`);
  console.log(`  CSV: ${path}`);
  console.log(`  data rows: ${dataRows.length}\n`);

  let matches = 0;
  let missMarkers = 0;
  let skipped = 0;
  for (const a of actions) {
    if (a.kind === "invalid") {
      console.warn(`  skip (invalid): ${a.ingredientId || "<no id>"} — ${a.reason}`);
      skipped++;
      continue;
    }
    if (!existing.has(a.ingredientId)) {
      console.warn(`  skip (ingredient gone): ${a.ingredientId}`);
      skipped++;
      continue;
    }
    const data = applyDataForAction(a);
    if (!data) {
      skipped++;
      continue;
    }
    await prisma.ingredient.update({ where: { id: a.ingredientId }, data });
    if (a.kind === "write-match") matches++;
    else missMarkers++;
  }

  const remainingNull = await prisma.ingredient.count({
    where: { nutritionRefPerUnit: { equals: Prisma.DbNull } },
  });

  console.log(`\n--- Applied ---`);
  console.log(`  matches written:      ${matches}`);
  console.log(`  miss-markers written: ${missMarkers}`);
  console.log(`  skipped:              ${skipped}`);
  console.log(`  catalog rows still null after apply: ${remainingNull}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const prisma = new PrismaClient();
  try {
    if (args.mode === "apply") await runApply(prisma, args);
    else await runDryRun(prisma, args);
  } finally {
    await prisma.$disconnect();
  }
}

// Only execute when run directly (so tests can import the pure exports above).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
