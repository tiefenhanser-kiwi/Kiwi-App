// WS7-8b Block B2 (D-WS7-197 / BUG-025-1) — Ingredient.conversionRef backfill.
//
// Populates the shared unit-conversion + purchase-size payload on the shared
// Ingredient catalog. Per the July-4 lesson (shared-catalog rows are REUSED,
// never re-inferred), a create-time-only stamp never reaches existing rows —
// this backfill is the only thing that sweeps the 441-row catalog.
//
// THREE provenance tiers (D-WS7-197, ratified July 11) — every row gets a
// conversion or an explicit miss; what varies is provenance:
//   • CURATED       — canonical is in INGREDIENT_CONVERSIONS (source:'curated').
//                     Highest precedence; apply reads the code table directly.
//   • USDA_DERIVED   — a matched USDA row (fdcId) whose FDC foodPortions yield a
//                     gramsPerCup and/or gramsPerEach (source:'usda_derived').
//   • MISS          — neither. conversionRef left null; the runtime AI-fallback
//                     (grocery/macro paths) fills it stamped 'ai_estimated'.
//
// Two-phase, mirroring ws7-8b-usda-backfill.ts (Hans's dry-run-review contract):
//   DRY-RUN (default) — SELECT + live USDA batch-fetch of the derived tier →
//     writes a reviewable CSV to scripts/output/. ZERO DB writes.
//   --apply <csv>     — reads the reviewed CSV and writes conversionRef. NO USDA
//     calls in apply. Idempotent: a second apply reports zero changes.
//
// CSV review contract (edit the dry-run CSV before --apply):
//   • delete a row          → that ingredient is left entirely untouched
//   • change decision→MISS   → conversionRef left null (no write)
//   • edit gramsPerCup/Each  → the edited value is written (USDA_DERIVED rows)
//   • CURATED rows           → applied from the code table (factor cols ignored)
//
// Run (PowerShell, from artifacts/api-server):
//   DRY-RUN:  node --env-file=.env --import tsx scripts/ws7-8b-b2-conversion-backfill.ts
//   APPLY:    node --env-file=.env --import tsx scripts/ws7-8b-b2-conversion-backfill.ts --apply "scripts/output/conversion-backfill-dryrun-<ts>.csv"

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  INGREDIENT_CONVERSIONS,
  lookupConversion,
  type IngredientConversion,
} from "../src/lib/ingredientConversions";
import { isMatchedRef } from "../src/lib/usda/ingredientEnrichment";
import {
  getFoodsBatch,
  isUsdaEnabled,
  type FdcFood,
} from "../src/lib/usda/fdcClient";
import {
  applyDeriveDenylist,
  deriveConversionFromPortions,
  isDeriveDenied,
  usdaConversionUsable,
} from "../src/lib/usda/portionConversions";
// Reuse the RFC4180-ish CSV helpers already proven by the USDA backfill.
import { encodeCsvRow, parseCsv } from "./ws7-8b-usda-backfill";

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");
// Full-format FDC records are heavy; keep batches small so a single 10s-timeout
// request stays well under budget. Retried a few times before a chunk is
// abandoned (its rows fall through to MISS rather than aborting the whole run).
const BATCH_MAX_IDS = 8;
const BATCH_RETRIES = 3;
const BATCH_PAUSE_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const CSV_HEADER = [
  "ingredientId",
  "ingredientName",
  "decision",
  "gramsPerCup",
  "gramsPerEach",
  "fdcId",
  "usdaDescription",
  "note",
] as const;

export type Decision = "CURATED" | "USDA_DERIVED" | "MISS";

// ── argument parsing ────────────────────────────────────────────────────

export interface ParsedArgs {
  mode: "dryrun" | "apply";
  applyPath: string | null;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { mode: "dryrun", applyPath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--apply") {
      args.mode = "apply";
      args.applyPath = argv[++i] ?? null;
      if (!args.applyPath) throw new Error("--apply requires a path to the reviewed CSV");
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

// ── classification (pure) ─────────────────────────────────────────────────

export interface CatalogRow {
  id: string;
  canonicalName: string;
  nutritionRefPerUnit: unknown;
}

export interface Classified {
  curated: CatalogRow[];
  // usda candidates carry the fdcId to batch-fetch.
  usdaCandidates: Array<CatalogRow & { fdcId: number }>;
  plainMiss: CatalogRow[];
}

/**
 * Split the catalog into the three tiers. CURATED wins over USDA even when a
 * curated row also has a matched USDA record (curated is authoritative). A row
 * is a USDA candidate only when it is NOT curated AND carries a matched USDA
 * record with an fdcId. Everything else is a plain miss.
 */
export function classifyRows(rows: CatalogRow[]): Classified {
  const curated: CatalogRow[] = [];
  const usdaCandidates: Array<CatalogRow & { fdcId: number }> = [];
  const plainMiss: CatalogRow[] = [];

  for (const r of rows) {
    if (lookupConversion(r.canonicalName)) {
      curated.push(r);
      continue;
    }
    const ref = r.nutritionRefPerUnit;
    if (isMatchedRef(ref) && typeof ref.fdcId === "number") {
      usdaCandidates.push({ ...r, fdcId: ref.fdcId });
    } else {
      plainMiss.push(r);
    }
  }
  return { curated, usdaCandidates, plainMiss };
}

// ── conversionRef construction (pure) ──────────────────────────────────────

/** The persisted conversionRef for a curated ingredient — the code-table row
 * verbatim (already stamped source:'curated'). */
export function curatedRef(canonicalName: string): IngredientConversion | null {
  return lookupConversion(canonicalName);
}

/** Build a usda_derived conversionRef from derived factors. Returns null when
 * neither factor is present (→ the row is a derive-MISS, left null). */
export function derivedRef(
  gramsPerCup: number | null,
  gramsPerEach: number | null,
): IngredientConversion | null {
  if (gramsPerCup === null && gramsPerEach === null) return null;
  const out: IngredientConversion = { source: "usda_derived", confidence: "medium" };
  if (gramsPerCup !== null) out.gramsPerCup = gramsPerCup;
  if (gramsPerEach !== null) out.gramsPerEach = gramsPerEach;
  return out;
}

// ── CSV row shaping ─────────────────────────────────────────────────────

export interface DryRunRow {
  row: CatalogRow;
  decision: Decision;
  gramsPerCup: number | null;
  gramsPerEach: number | null;
  fdcId: number | null;
  usdaDescription: string;
  note: string;
}

export function dryRunToCsvFields(d: DryRunRow): Array<string | number> {
  return [
    d.row.id,
    d.row.canonicalName,
    d.decision,
    d.gramsPerCup ?? "",
    d.gramsPerEach ?? "",
    d.fdcId ?? "",
    d.usdaDescription,
    d.note,
  ];
}

// ── apply mapping (pure) ────────────────────────────────────────────────

export type ApplyAction =
  | { kind: "write"; ingredientId: string; ref: IngredientConversion }
  | { kind: "skip"; ingredientId: string; reason: string };

function numOrNull(s: string | undefined): number | null {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Map one reviewed CSV data row (aligned to CSV_HEADER) to a write/skip. */
export function applyActionFromCsvFields(fields: string[]): ApplyAction {
  const ingredientId = fields[0] ?? "";
  const canonicalName = fields[1] ?? "";
  const decision = (fields[2] ?? "") as Decision | "";
  if (!ingredientId) return { kind: "skip", ingredientId: "", reason: "missing ingredientId" };

  if (decision === "MISS") {
    return { kind: "skip", ingredientId, reason: "decision=MISS" };
  }
  if (decision === "CURATED") {
    const ref = curatedRef(canonicalName);
    if (!ref) return { kind: "skip", ingredientId, reason: `no curated row for "${canonicalName}"` };
    return { kind: "write", ingredientId, ref };
  }
  if (decision === "USDA_DERIVED") {
    const ref = derivedRef(numOrNull(fields[3]), numOrNull(fields[4]));
    if (!ref) return { kind: "skip", ingredientId, reason: "no usable factor" };
    return { kind: "write", ingredientId, ref };
  }
  return { kind: "skip", ingredientId, reason: `unknown decision "${decision}"` };
}

// Stable stringify for idempotency comparison (keys sorted).
export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

// ── CLI wiring ────────────────────────────────────────────────────────────

const HELP = `
WS7-8b B2 conversion backfill — populate Ingredient.conversionRef.

DRY-RUN (default): classify the catalog into CURATED / USDA_DERIVED / MISS,
batch-fetch USDA foodPortions for the derived tier, and write a reviewable CSV
to scripts/output/. No DB writes.

  node --env-file=.env --import tsx scripts/ws7-8b-b2-conversion-backfill.ts

APPLY: read the reviewed CSV and write conversionRef. No USDA calls.

  node --env-file=.env --import tsx scripts/ws7-8b-b2-conversion-backfill.ts --apply <csv-path>

CSV review contract (edit the dry-run CSV before --apply):
  • delete a row          → ingredient left untouched
  • change decision→MISS   → conversionRef left null (no write)
  • edit gramsPerCup/Each  → edited value written (USDA_DERIVED rows)
  • CURATED rows           → applied from the code table (factor cols ignored)
`;

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function runDryRun(prisma: PrismaClient): Promise<void> {
  if (!isUsdaEnabled()) {
    console.error(
      "USDA_INGREDIENTS_API_KEY is not set — the USDA_DERIVED tier cannot run. Aborting.",
    );
    process.exitCode = 1;
    return;
  }

  const all = (await prisma.ingredient.findMany({
    select: { id: true, canonicalName: true, nutritionRefPerUnit: true },
    orderBy: { canonicalName: "asc" },
  })) as CatalogRow[];

  const { curated, usdaCandidates, plainMiss } = classifyRows(all);

  console.log(`\n=== WS7-8b B2 conversion backfill (DRY-RUN) ===`);
  console.log(`  catalog rows:      ${all.length}`);
  console.log(`  curated:           ${curated.length}`);
  console.log(`  usda candidates:   ${usdaCandidates.length}`);
  console.log(`  plain miss:        ${plainMiss.length}\n`);

  // Batch-fetch the USDA candidates' full records (foodPortions). Resilient:
  // retry a chunk on timeout/network; abandon it after BATCH_RETRIES (its rows
  // fall through to MISS). A 429 rate-limit still aborts — re-run later.
  const idToFood = new Map<number, FdcFood>();
  const fdcIds = [...new Set(usdaCandidates.map((c) => c.fdcId))];
  let abandoned = 0;
  for (let i = 0; i < fdcIds.length; i += BATCH_MAX_IDS) {
    const chunk = fdcIds.slice(i, i + BATCH_MAX_IDS);
    let ok = false;
    for (let attempt = 1; attempt <= BATCH_RETRIES; attempt++) {
      const res = await getFoodsBatch(chunk);
      if (res.ok) {
        for (const f of res.data) idToFood.set(f.fdcId, f);
        ok = true;
        break;
      }
      if (res.reason === "rate_limited") {
        console.error(`\n! USDA rate-limited (429). Partial CSV NOT written — re-run later.`);
        process.exitCode = 1;
        return;
      }
      await sleep(BATCH_PAUSE_MS * attempt);
    }
    if (!ok) abandoned += chunk.length;
    process.stdout.write(
      `\r  fetched ${Math.min(i + BATCH_MAX_IDS, fdcIds.length)}/${fdcIds.length} USDA records (abandoned ${abandoned})   `,
    );
    await sleep(BATCH_PAUSE_MS);
  }
  process.stdout.write("\n");
  if (abandoned > 0) {
    console.warn(`  NOTE: ${abandoned} USDA record(s) could not be fetched and fall through to MISS.`);
  }

  const dryRows: DryRunRow[] = [];
  const counts: Record<Decision, number> = { CURATED: 0, USDA_DERIVED: 0, MISS: 0 };
  const derivedEcho: string[] = [];

  for (const r of curated) {
    dryRows.push({ row: r, decision: "CURATED", gramsPerCup: null, gramsPerEach: null, fdcId: null, usdaDescription: "", note: "curated" });
    counts.CURATED++;
  }
  for (const c of usdaCandidates) {
    const food = idToFood.get(c.fdcId);
    // Correctness gate: only derive when the USDA food is the SAME form as the
    // ingredient (rejects avocado→oil, carrot→dehydrated, etc.).
    const usable = food ? usdaConversionUsable(c.canonicalName, food.description) : false;
    // Derive, then apply the per-ingredient denylist (whole-row miss or
    // field-level drop — Hans rulings A–D).
    const derived = applyDeriveDenylist(
      c.canonicalName,
      food && usable ? deriveConversionFromPortions(food) : {},
    );
    const gc = derived.gramsPerCup ?? null;
    const ge = derived.gramsPerEach ?? null;
    if (gc === null && ge === null) {
      const note = !food
        ? "usda fetch unavailable"
        : isDeriveDenied(c.canonicalName)
          ? `denylist (wrong food/state): ${food.description}`
          : !usable
            ? `form mismatch: ${food.description}`
            : "no cup/each portion";
      dryRows.push({ row: c, decision: "MISS", gramsPerCup: null, gramsPerEach: null, fdcId: c.fdcId, usdaDescription: food?.description ?? "", note });
      counts.MISS++;
    } else {
      dryRows.push({ row: c, decision: "USDA_DERIVED", gramsPerCup: gc, gramsPerEach: ge, fdcId: c.fdcId, usdaDescription: food?.description ?? "", note: "" });
      counts.USDA_DERIVED++;
      if (derivedEcho.length < 25) {
        derivedEcho.push(`  ${c.canonicalName} → cup:${gc ?? "-"} each:${ge ?? "-"}  [${c.fdcId}] ${food?.description ?? ""}`);
      }
    }
  }
  for (const r of plainMiss) {
    dryRows.push({ row: r, decision: "MISS", gramsPerCup: null, gramsPerEach: null, fdcId: null, usdaDescription: "", note: "no curated + no usda match" });
    counts.MISS++;
  }

  // Stable output order by canonical name.
  dryRows.sort((a, b) => a.row.canonicalName.localeCompare(b.row.canonicalName));

  const csvLines = [encodeCsvRow([...CSV_HEADER])];
  for (const d of dryRows) csvLines.push(encodeCsvRow(dryRunToCsvFields(d)));

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = join(OUTPUT_DIR, `conversion-backfill-dryrun-${timestamp(new Date())}.csv`);
  writeFileSync(outPath, csvLines.join("\n") + "\n", "utf8");

  console.log(`\n--- Summary (by decision) ---`);
  console.log(`  CURATED:      ${counts.CURATED}`);
  console.log(`  USDA_DERIVED: ${counts.USDA_DERIVED}`);
  console.log(`  MISS:         ${counts.MISS}`);
  console.log(`  total rows:   ${dryRows.length}`);
  if (derivedEcho.length > 0) {
    console.log(`\n  first ${derivedEcho.length} USDA_DERIVED rows (eyeball these):`);
    for (const l of derivedEcho) console.log(l);
  }
  console.log(`\n  CSV: ${outPath}`);
  console.log(`  Review, then apply:\n    node --env-file=.env --import tsx scripts/ws7-8b-b2-conversion-backfill.ts --apply "${outPath}"\n`);
}

async function runApply(prisma: PrismaClient, applyPath: string): Promise<void> {
  const text = readFileSync(applyPath, "utf8");
  const rows = parseCsv(text);
  if (rows.length === 0) {
    console.error("empty CSV — nothing to apply.");
    return;
  }
  const [header, ...dataRows] = rows;
  if (header[0] !== CSV_HEADER[0] || header[2] !== CSV_HEADER[2]) {
    console.error(`CSV header does not look like a B2 conversion dry-run file (got: ${header.join(",")}).`);
    process.exitCode = 1;
    return;
  }

  const actions = dataRows.map((f) => applyActionFromCsvFields(f));
  const writeIds = actions.filter((a): a is Extract<ApplyAction, { kind: "write" }> => a.kind === "write").map((a) => a.ingredientId);
  const existing = new Map(
    (await prisma.ingredient.findMany({
      where: { id: { in: writeIds } },
      select: { id: true, conversionRef: true },
    })).map((r) => [r.id, r.conversionRef]),
  );

  console.log(`\n=== WS7-8b B2 conversion backfill (APPLY) ===`);
  console.log(`  CSV: ${applyPath}`);
  console.log(`  data rows: ${dataRows.length}\n`);

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  let written = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const a of actions) {
    if (a.kind === "skip") {
      skipped++;
      continue;
    }
    if (!existing.has(a.ingredientId)) {
      console.warn(`  skip (ingredient gone): ${a.ingredientId}`);
      skipped++;
      continue;
    }
    // Idempotency: skip a write whose target equals the persisted value.
    if (stableStringify(existing.get(a.ingredientId)) === stableStringify(a.ref)) {
      unchanged++;
      continue;
    }
    ops.push(
      prisma.ingredient.update({
        where: { id: a.ingredientId },
        data: { conversionRef: a.ref as unknown as Prisma.InputJsonValue },
      }),
    );
    written++;
  }
  if (ops.length > 0) await prisma.$transaction(ops);

  const withRef = await prisma.ingredient.count({ where: { NOT: { conversionRef: { equals: Prisma.DbNull } } } });
  const total = await prisma.ingredient.count();

  console.log(`--- Applied ---`);
  console.log(`  written:    ${written}`);
  console.log(`  unchanged:  ${unchanged} (idempotent)`);
  console.log(`  skipped:    ${skipped}`);
  console.log(`  catalog rows with conversionRef now: ${withRef}/${total}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const prisma = new PrismaClient();
  try {
    if (args.mode === "apply") await runApply(prisma, args.applyPath as string);
    else await runDryRun(prisma);
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
