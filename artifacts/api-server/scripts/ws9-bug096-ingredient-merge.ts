// WS9 BUG-096 (D-WS9-174) — Ingredient singular/plural collision MERGE.
//
// WHAT: folds 81 curated singular/plural Ingredient pairs (roma tomato / roma
// tomatoes, garlic clove / garlic cloves, bay leaf / bay leaves, …) down to one
// row each. Every reference on every carrier is rewritten to the survivor
// BEFORE the loser row is deleted, the loser's name is written onto the
// survivor as an alias (so `resolveIngredients` never mints it back), and the
// delete is gated on a verification query proving zero remaining references.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// The predicate is the LITERAL 81-pair FOLD list below and nothing else. It is
// hardcoded, not recomputed: the survivor ladder that produced it reads live
// reference counts, which drift, and a merge whose direction can silently flip
// between a dry-run and an apply is not reviewable.
//
// THIS IS NOT A SINGULARISING NORMALIZER AND MUST NEVER BECOME ONE. A general
// write-path normalizer was measured and REFUTED in Phase 0: 468 collateral
// renames against 67 real merges, molasses→molass, couscous→couscou, and 14 of
// 17 plural keys in INGREDIENT_CONVERSIONS with no singular twin. The 457
// plural-only catalog rows are NOT touched by this script and never should be.
//
// ── THE CARRIERS (five id, three name) ──────────────────────────────────────
// Two have a declared FK and they behave DIFFERENTLY:
//   DishIngredient.ingredientId        FK, ON DELETE RESTRICT  → blocks
//   GroceryListItem.ingredientId       FK, ON DELETE SET NULL  → SILENTLY NULLS
// Three have no FK at all and orphan without a sound:
//   RecipeInstructionStep.amountRefs[].ingredientId
//   PrepStepCompletion.stepKey         `${phase}#${ingredientId}`
//   PrepWeekStructure.structureJson    persisted stepKey strings
// Three carry the NAME, not the id:
//   Dish.substitutions (replaces[] / product)
//   GroceryListItem.displayName
//   UserPreferences.recurringGroceryItems
//   MealPlanItem.recipeOverrideJson (dish ingredient names)
//
// GroceryListItem's SET NULL is the dangerous one: 80 of 1,292 rows already
// carry a null ingredientId, so a fresh batch of silent nulls would blend into
// existing noise and never be noticed. verifyClean() asserts zero loser-side
// grocery references BEFORE the delete, never after.
//
// ── MODES ───────────────────────────────────────────────────────────────────
//   DRY-RUN (default) — zero DB writes. Enumerates every write it WOULD make,
//     per carrier, survivor-side vs loser-side, and emits two reviewable CSVs
//     to scripts/output/:
//       bug096-nutrition-<ts>.csv   the 23 groups whose two rows carry DIFFERENT
//                                   nutrition (14 one-matched + 9 both-matched-
//                                   but-different),
//                                   PRE-FILLED with a pick + reason + the
//                                   RE-FETCHED FDC description for both fdcIds
//                                   (the description is not persisted; a CSV
//                                   showing only an id and a kcal is
//                                   unreviewable — BUG-032's lesson).
//       bug096-pack-<ts>.csv        the 12 groups whose purchase packs disagree.
//   --apply --nutrition <csv> --pack <csv>
//     Reads the REVIEWED CSVs and applies. Contract mirrors
//     ws7-8b-b2-conversion-backfill.ts: delete a row → that group's field is
//     left untouched; edit the `decision` cell → the edit is what gets written.
//
// IDEMPOTENT: a group whose loser row is already gone is skipped. A second
// --apply reports zero changes on every carrier.
//
// Run (from artifacts/api-server):
//   DRY-RUN: node --env-file=.env --import tsx scripts/ws9-bug096-ingredient-merge.ts
//   APPLY:   node --env-file=.env --import tsx scripts/ws9-bug096-ingredient-merge.ts --apply \
//              --nutrition scripts/output/bug096-nutrition-<ts>.csv \
//              --pack scripts/output/bug096-pack-<ts>.csv

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  countAmountRefHits,
  countOverrideNameHits,
  countStructureJsonHits,
  countSubstitutionHits,
  rewriteAmountRefs,
  rewriteOverrideNames,
  rewriteRecurringItems,
  rewriteStepKey,
  rewriteStructureJson,
  rewriteSubstitutions,
  stepKeyTouches,
} from "../src/lib/ingredientMergeCarriers";
import { FOLD } from "../src/lib/ingredientMergeFold";
import { normalizeAliasKey } from "../src/lib/ingredientLookup";
import { getFoodsBatch, isUsdaEnabled } from "../src/lib/usda/fdcClient";

const prisma = new PrismaClient();
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");

// The curated predicate lives in src/lib/ingredientMergeFold.ts — a
// side-effect-free module so the SEED-DURABILITY guard can import it without
// standing up a PrismaClient. See that file for the ladder + scope commentary.


// ── helpers ─────────────────────────────────────────────────────────────────

interface Ref {
  fdcId: number | null;
  kcal: number | null;
  raw: unknown;
  kind: "matched" | "miss" | "null";
}

function readRef(value: unknown): Ref {
  if (value === null || value === undefined) return { fdcId: null, kcal: null, raw: value, kind: "null" };
  if (typeof value !== "object") return { fdcId: null, kcal: null, raw: value, kind: "miss" };
  const r = value as Record<string, unknown>;
  const fdcId = typeof r.fdcId === "number" ? r.fdcId : null;
  const per100g = (r.per100g ?? null) as Record<string, unknown> | null;
  const kcal = per100g && typeof per100g.calories === "number" ? per100g.calories : null;
  return { fdcId, kcal, raw: value, kind: fdcId === null ? "miss" : "matched" };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}
/** Minimal RFC-4180 row splitter — handles quoted cells containing commas. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(cell); cell = ""; continue; }
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (c === "\r") continue;
    cell += c;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

function timestamp(): string {
  // Date.now() is fine here (a plain script, not a resumable workflow).
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

type IngRow = {
  id: string;
  canonicalName: string;
  displayName: string;
  nutritionRefPerUnit: unknown;
  conversionRef: unknown;
  purchaseUnit: string | null;
  purchaseQuantity: number | null;
  purchaseDisplay: string | null;
};

interface Group {
  survivorName: string;
  loserName: string;
  survivor: IngRow;
  loser: IngRow;
}

// ── carrier scan ────────────────────────────────────────────────────────────

interface CarrierCounts {
  dishIngredient: number;
  groceryListItemFk: number;
  amountRefs: number;
  amountRefSteps: number;
  prepStepCompletion: number;
  prepWeekStructure: number;
  substitutions: number;
  groceryDisplayName: number;
  recurringGroceryItems: number;
  recipeOverrideJson: number;
}

const ZERO: CarrierCounts = {
  dishIngredient: 0, groceryListItemFk: 0, amountRefs: 0, amountRefSteps: 0,
  prepStepCompletion: 0, prepWeekStructure: 0, substitutions: 0,
  groceryDisplayName: 0, recurringGroceryItems: 0, recipeOverrideJson: 0,
};

/**
 * Count EVERY reference to the given ingredient ids / names, across every
 * carrier. Used three times: for the dry-run diff, for the pre-delete
 * verification gate, and for the post-apply drift re-scan.
 */
async function scanReferences(
  ids: Set<string>,
  names: Set<string>,
): Promise<CarrierCounts> {
  const idList = [...ids];
  const out: CarrierCounts = { ...ZERO };
  if (idList.length === 0 && names.size === 0) return out;

  if (idList.length > 0) {
    out.dishIngredient = await prisma.dishIngredient.count({ where: { ingredientId: { in: idList } } });
    out.groceryListItemFk = await prisma.groceryListItem.count({ where: { ingredientId: { in: idList } } });

    const steps = await prisma.recipeInstructionStep.findMany({
      where: { NOT: { amountRefs: { equals: Prisma.DbNull } } },
      select: { id: true, amountRefs: true },
    });
    for (const s of steps) {
      const hits = countAmountRefHits(s.amountRefs, ids);
      if (hits > 0) { out.amountRefs += hits; out.amountRefSteps++; }
    }

    for (const p of await prisma.prepStepCompletion.findMany({ select: { stepKey: true } })) {
      if (stepKeyTouches(p.stepKey, ids)) out.prepStepCompletion++;
    }

    for (const s of await prisma.prepWeekStructure.findMany({ select: { structureJson: true } })) {
      out.prepWeekStructure += countStructureJsonHits(s.structureJson, ids);
    }
  }

  if (names.size > 0) {
    for (const d of await prisma.dish.findMany({
      where: { NOT: { substitutions: { equals: Prisma.DbNull } } },
      select: { substitutions: true },
    })) {
      out.substitutions += countSubstitutionHits(d.substitutions, names);
    }

    for (const g of await prisma.groceryListItem.findMany({ select: { displayName: true } })) {
      if (names.has(g.displayName.toLowerCase().trim())) out.groceryDisplayName++;
    }

    for (const p of await prisma.userPreferences.findMany({ select: { recurringGroceryItems: true } })) {
      for (const v of p.recurringGroceryItems ?? []) {
        if (names.has(v.toLowerCase().trim())) out.recurringGroceryItems++;
      }
    }

    for (const it of await prisma.mealPlanItem.findMany({
      where: { NOT: { recipeOverrideJson: { equals: Prisma.DbNull } } },
      select: { recipeOverrideJson: true },
    })) {
      out.recipeOverrideJson += countOverrideNameHits(it.recipeOverrideJson, names);
    }
  }
  return out;
}

function totalRefs(c: CarrierCounts): number {
  return c.dishIngredient + c.groceryListItemFk + c.amountRefs + c.prepStepCompletion +
    c.prepWeekStructure + c.substitutions + c.groceryDisplayName +
    c.recurringGroceryItems + c.recipeOverrideJson;
}

function printCounts(label: string, c: CarrierCounts): void {
  console.log(`  ${label}`);
  console.log(`    DishIngredient.ingredientId        ${String(c.dishIngredient).padStart(6)}`);
  console.log(`    GroceryListItem.ingredientId       ${String(c.groceryListItemFk).padStart(6)}`);
  console.log(`    RecipeInstructionStep.amountRefs   ${String(c.amountRefs).padStart(6)}  (in ${c.amountRefSteps} steps)`);
  console.log(`    PrepStepCompletion.stepKey         ${String(c.prepStepCompletion).padStart(6)}`);
  console.log(`    PrepWeekStructure.structureJson    ${String(c.prepWeekStructure).padStart(6)}`);
  console.log(`    Dish.substitutions (by name)       ${String(c.substitutions).padStart(6)}`);
  console.log(`    GroceryListItem.displayName        ${String(c.groceryDisplayName).padStart(6)}`);
  console.log(`    UserPreferences.recurring          ${String(c.recurringGroceryItems).padStart(6)}`);
  console.log(`    MealPlanItem.recipeOverrideJson    ${String(c.recipeOverrideJson).padStart(6)}`);
  console.log(`    ── TOTAL                           ${String(totalRefs(c)).padStart(6)}`);
}

// ── CSV: nutrition ──────────────────────────────────────────────────────────

const NUTRITION_HEADER = [
  "group", "survivor", "loser", "decision",
  "reason",
  "survivor_fdcId", "survivor_kcal", "survivor_fdc_description", "survivor_dataType",
  "loser_fdcId", "loser_kcal", "loser_fdc_description", "loser_dataType",
  "kcal_divergence_pct",
];

/**
 * `decision` values the apply pass understands:
 *   SURVIVOR — keep the survivor's ref as-is (a no-op write).
 *   LOSER    — copy the loser's ref onto the survivor.
 *   MISS     — stamp a miss-marker; BUG-122's catalog re-match block re-matches
 *              it later. THE ESCAPE HATCH when BOTH records are wrong.
 * Anything else aborts the apply rather than guessing.
 *
 * NOTE the deliberate absence of a "search for a better fdcId" option. BUG-032
 * forbids a write path that mints a NEW pointer here: a bad match laundered
 * through this script would arrive in the catalog wearing a `usda_derived`
 * stamp and be indistinguishable from an audited one. Pick between the two
 * records that already exist, or stamp MISS.
 */
async function buildNutritionCsv(groups: Group[]): Promise<{ path: string; rows: number }> {
  const contested: Array<{ g: Group; s: Ref; l: Ref; decision: string; reason: string; div: string }> = [];
  for (const g of groups) {
    const s = readRef(g.survivor.nutritionRefPerUnit);
    const l = readRef(g.loser.nutritionRefPerUnit);
    if (s.kind !== "matched" && l.kind !== "matched") continue;          // nothing to choose
    if (s.kind === "matched" && l.kind === "matched" && s.fdcId === l.fdcId) continue; // identical

    let decision: string;
    let reason: string;
    let div = "";
    if (s.kind !== "matched") {
      decision = "LOSER";
      reason = "survivor ref is unmatched, loser carries a matched record";
    } else if (l.kind !== "matched") {
      decision = "SURVIVOR";
      reason = "survivor already carries the only matched record";
    } else {
      const rel = s.kcal != null && l.kcal != null && Math.max(s.kcal, l.kcal) > 0
        ? Math.abs(s.kcal - l.kcal) / Math.max(s.kcal, l.kcal)
        : null;
      div = rel == null ? "n/a" : (rel * 100).toFixed(1);
      if (rel != null && rel <= 0.10) {
        decision = "SURVIVOR";
        reason = `both matched, kcal agree within 10% (${div}%) — no material difference`;
      } else {
        decision = "REVIEW";
        reason = `both matched but kcal diverge ${div}% — CHECK THE DESCRIPTIONS, then set SURVIVOR / LOSER / MISS`;
      }
    }
    contested.push({ g, s, l, decision, reason, div });
  }

  // Re-fetch the FDC description for every id in the sheet. It is NOT persisted
  // on the row (BUG-032), and an fdcId + a kcal with no description is exactly
  // how a wrong pick gets waved through review.
  const wantedIds = [...new Set(contested.flatMap((c) => [c.s.fdcId, c.l.fdcId]).filter((x): x is number => x != null))];
  const descById = new Map<number, { description: string; dataType: string }>();
  if (wantedIds.length > 0) {
    if (!isUsdaEnabled()) {
      console.log("\n  !! USDA key absent — descriptions will be blank and the sheet is NOT reviewable.");
    } else {
      const res = await getFoodsBatch(wantedIds);
      if (!res.ok) {
        console.log(`\n  !! FDC batch fetch failed (${res.reason}) — descriptions blank, sheet NOT reviewable.`);
      } else {
        for (const f of res.data) descById.set(f.fdcId, { description: f.description, dataType: f.dataType ?? "" });
        const missing = wantedIds.filter((id) => !descById.has(id));
        if (missing.length > 0) {
          // Foundation Foods 404 on by-id fetch — a known BUG-032 finding. The
          // sheet still ships; the missing rows are flagged rather than faked.
          console.log(`  !! ${missing.length} fdcId(s) returned no record (Foundation Foods 404 by id): ${missing.join(", ")}`);
        }
      }
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `bug096-nutrition-${timestamp()}.csv`);
  const lines = [csvLine(NUTRITION_HEADER)];
  for (const c of contested) {
    const sd = c.s.fdcId != null ? descById.get(c.s.fdcId) : undefined;
    const ld = c.l.fdcId != null ? descById.get(c.l.fdcId) : undefined;
    lines.push(csvLine([
      c.g.survivorName, c.g.survivorName, c.g.loserName, c.decision, c.reason,
      c.s.fdcId, c.s.kcal, sd?.description ?? "", sd?.dataType ?? "",
      c.l.fdcId, c.l.kcal, ld?.description ?? "", ld?.dataType ?? "",
      c.div,
    ]));
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return { path, rows: contested.length };
}

// ── CSV: purchase pack ──────────────────────────────────────────────────────

const PACK_HEADER = [
  "group", "survivor", "loser", "decision", "reason",
  "survivor_display", "survivor_quantity", "survivor_unit",
  "loser_display", "loser_quantity", "loser_unit",
];

function hasPack(r: IngRow): boolean {
  return r.purchaseUnit != null || r.purchaseQuantity != null || r.purchaseDisplay != null;
}

/**
 * `decision`: SURVIVOR (keep) | LOSER (copy the loser's pack onto the survivor).
 *
 * Pre-fill rule and WHY it is not simply "the survivor's": the pack is a
 * SEMANTIC value, not a count. `egg` survives with `[2 eggs]` while the loser
 * `eggs` carries `[1 dozen]` — and the dozen is the thing you actually buy.
 * The heuristic prefers the side that names a real retail package over a bare
 * count, which is the archetype Hans named.
 *
 * It scans purchaseUnit AND purchaseDisplay, because the retail word often
 * lives only in the display: carrots' pack is unit="lb" display="1 lb bag", and
 * garlic's is unit="each" display="1 head of garlic". Reading the unit alone
 * scored both of those as bare counts and pre-filled the wrong side — measured
 * on the first dry-run. Every row still carries its reason, so a tie ("both are
 * the same KIND of unit") is visibly a default rather than a judgement.
 */
const RETAIL_WORDS = [
  "dozen", "package", "pack", "bag", "box", "bunch", "container", "jar", "bottle",
  "can", "loaf", "head", "pint", "quart", "block", "gallon", "carton", "tub",
];

/** Does this pack name a buyable package, or is it a bare count of the item? */
function namesRetailPack(r: IngRow): string | null {
  const hay = `${r.purchaseUnit ?? ""} ${r.purchaseDisplay ?? ""}`.toLowerCase();
  // \\b in a template literal, not \b — the latter is a backspace character and
  // the word-boundary match would silently never fire.
  return RETAIL_WORDS.find((w) => new RegExp(`\\b${w}s?\\b`).test(hay)) ?? null;
}

function buildPackCsv(groups: Group[]): { path: string; rows: number } {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `bug096-pack-${timestamp()}.csv`);
  const lines = [csvLine(PACK_HEADER)];
  let rows = 0;
  for (const g of groups) {
    const s = g.survivor, l = g.loser;
    if (!hasPack(s) || !hasPack(l)) continue;
    if (s.purchaseUnit === l.purchaseUnit && s.purchaseQuantity === l.purchaseQuantity && s.purchaseDisplay === l.purchaseDisplay) continue;
    const sRetail = namesRetailPack(s);
    const lRetail = namesRetailPack(l);
    let decision: string, reason: string;
    if (lRetail && !sRetail) {
      decision = "LOSER";
      reason = `loser names a retail package ("${lRetail}"), survivor's "${s.purchaseDisplay}" is a bare count of the item`;
    } else if (sRetail && !lRetail) {
      decision = "SURVIVOR";
      reason = `survivor names a retail package ("${sRetail}"), loser's "${l.purchaseDisplay}" is a bare count of the item`;
    } else {
      decision = "SURVIVOR";
      reason = "both packs are the same KIND of unit; survivor's is the default — override to LOSER if its size is the one you'd buy";
    }
    lines.push(csvLine([
      g.survivorName, g.survivorName, g.loserName, decision, reason,
      s.purchaseDisplay, s.purchaseQuantity, s.purchaseUnit,
      l.purchaseDisplay, l.purchaseQuantity, l.purchaseUnit,
    ]));
    rows++;
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return { path, rows };
}

// ── main ────────────────────────────────────────────────────────────────────

async function loadGroups(): Promise<{ groups: Group[]; skipped: string[] }> {
  const wanted = [...new Set(FOLD.flat())];
  const rows = (await prisma.ingredient.findMany({
    where: { canonicalName: { in: wanted } },
    select: {
      id: true, canonicalName: true, displayName: true,
      nutritionRefPerUnit: true, conversionRef: true,
      purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
    },
  })) as unknown as IngRow[];
  const byName = new Map(rows.map((r) => [r.canonicalName, r]));

  const groups: Group[] = [];
  const skipped: string[] = [];
  for (const [survivorName, loserName] of FOLD) {
    const survivor = byName.get(survivorName);
    const loser = byName.get(loserName);
    if (!survivor && !loser) { skipped.push(`${survivorName} :: BOTH rows absent`); continue; }
    if (!survivor) { skipped.push(`${survivorName} :: SURVIVOR ABSENT but loser "${loserName}" present — REFUSING`); continue; }
    // Idempotence: loser already merged away.
    if (!loser) { skipped.push(`${survivorName} :: already merged (loser "${loserName}" gone)`); continue; }
    groups.push({ survivorName, loserName, survivor, loser });
  }
  return { groups, skipped };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const nutritionCsv = argv[argv.indexOf("--nutrition") + 1];
  const packCsv = argv[argv.indexOf("--pack") + 1];

  console.log(`\n=== WS9 BUG-096 ingredient merge (${apply ? "APPLY" : "DRY-RUN"}) ===\n`);
  console.log(`  curated fold pairs: ${FOLD.length}`);

  const { groups, skipped } = await loadGroups();
  console.log(`  groups live (loser still present): ${groups.length}`);
  console.log(`  groups skipped:                    ${skipped.length}`);
  for (const s of skipped) console.log(`     - ${s}`);

  const refusals = skipped.filter((s) => s.includes("REFUSING"));
  if (refusals.length > 0) {
    console.log(`\n  ABORT: ${refusals.length} group(s) have a loser but no survivor. The catalog is in a state`);
    console.log(`  this predicate does not describe. Nothing written.\n`);
    process.exitCode = 1;
    return;
  }

  if (groups.length === 0) {
    console.log(`\n  Nothing to do — every fold pair is already merged. (idempotent)\n`);
    return;
  }

  const loserIds = new Set(groups.map((g) => g.loser.id));
  const survivorIds = new Set(groups.map((g) => g.survivor.id));
  const loserNames = new Set(groups.map((g) => g.loserName));
  const survivorNames = new Set(groups.map((g) => g.survivorName));

  console.log(`\n--- reference census ---`);
  const loserRefs = await scanReferences(loserIds, loserNames);
  const survivorRefs = await scanReferences(survivorIds, survivorNames);
  printCounts("LOSER-side (these all get rewritten):", loserRefs);
  printCounts("survivor-side (untouched, shown for scale):", survivorRefs);

  if (!apply) {
    const nut = await buildNutritionCsv(groups);
    const pack = buildPackCsv(groups);
    console.log(`\n--- review sheets ---`);
    console.log(`  nutrition: ${nut.rows} contested group(s) -> ${nut.path}`);
    console.log(`  pack:      ${pack.rows} contested group(s) -> ${pack.path}`);
    console.log(`\n  Per-group fold (survivor <- loser):`);
    for (const g of groups) console.log(`    ${g.survivorName}  <-  ${g.loserName}`);
    console.log(`\nDRY-RUN — nothing written. Review both CSVs, then re-run with:`);
    console.log(`  --apply --nutrition <csv> --pack <csv>\n`);
    return;
  }

  if (!nutritionCsv || !packCsv) {
    console.log(`\n  ABORT: --apply requires --nutrition <csv> and --pack <csv>. Nothing written.\n`);
    process.exitCode = 1;
    return;
  }

  // ── read the REVIEWED sheets ──────────────────────────────────────────────
  // Contract (mirrors ws7-8b-b2-conversion-backfill.ts): a row DELETED from the
  // CSV means "leave that group's field entirely untouched"; an edited
  // `decision` cell is what gets written. An unrecognised decision ABORTS —
  // never guesses.
  const nutritionDecisions = new Map<string, string>();
  for (const r of parseCsv(readFileSync(nutritionCsv, "utf8"))) {
    const d = (r.decision ?? "").toUpperCase();
    if (!["SURVIVOR", "LOSER", "MISS"].includes(d)) {
      console.log(`\n  ABORT: nutrition CSV row "${r.group}" has decision "${r.decision}".`);
      console.log(`  Allowed: SURVIVOR | LOSER | MISS. "REVIEW" means it is still unreviewed.`);
      console.log(`  Nothing written.\n`);
      process.exitCode = 1;
      return;
    }
    nutritionDecisions.set(r.group, d);
  }
  const packDecisions = new Map<string, string>();
  for (const r of parseCsv(readFileSync(packCsv, "utf8"))) {
    const d = (r.decision ?? "").toUpperCase();
    if (!["SURVIVOR", "LOSER"].includes(d)) {
      console.log(`\n  ABORT: pack CSV row "${r.group}" has decision "${r.decision}". Allowed: SURVIVOR | LOSER.\n`);
      process.exitCode = 1;
      return;
    }
    packDecisions.set(r.group, d);
  }
  console.log(`\n  reviewed decisions: nutrition=${nutritionDecisions.size}  pack=${packDecisions.size}`);

  const survivorByLoserId = new Map(groups.map((g) => [g.loser.id, g.survivor.id]));
  const groupByLoserId = new Map(groups.map((g) => [g.loser.id, g]));
  const groupByLoserName = new Map(groups.map((g) => [g.loserName, g]));
  const survivorNameByLoserName = new Map(groups.map((g) => [g.loserName, g.survivorName]));
  const displayNameByLoserName = new Map(groups.map((g) => [g.loserName, g.survivor.displayName]));

  // ── PASS 1: read everything the rewrites need. OUTSIDE the transaction. ────
  // The amountRefs scan alone reads 23k step rows; doing it inside the tx would
  // burn the budget on reads before a single write landed (the P2028 shape that
  // bit WS7-5d Block 4 and WS7-5b activate).
  const stepsToRewrite: Array<{ id: string; refs: unknown[]; changed: number }> = [];
  for (const s of await prisma.recipeInstructionStep.findMany({
    where: { NOT: { amountRefs: { equals: Prisma.DbNull } } },
    select: { id: true, amountRefs: true },
  })) {
    const out = rewriteAmountRefs(s.amountRefs, survivorByLoserId);
    if (out) stepsToRewrite.push({ id: s.id, refs: out.refs, changed: out.changed });
  }

  // PrepStepCompletion: `${phase}#${ingredientId}` with @@unique([planId, stepKey]).
  // Rewriting a loser key can COLLIDE with a survivor key the same plan already
  // has checked. A checked step is a checked step, so the union is "checked":
  // on collision we DELETE the loser row instead of updating it. Both counts
  // are reported — a silent swallow here would look identical to a no-op.
  const pscAll = await prisma.prepStepCompletion.findMany({ select: { id: true, planId: true, stepKey: true } });
  const pscExisting = new Set(pscAll.map((p) => `${p.planId}|${p.stepKey}`));
  const pscUpdate: Array<{ id: string; stepKey: string }> = [];
  const pscDelete: string[] = [];
  const pscClaimed = new Set<string>();
  for (const p of pscAll) {
    const nextKey = rewriteStepKey(p.stepKey, survivorByLoserId);
    if (nextKey === null) continue;
    const target = `${p.planId}|${nextKey}`;
    if (pscExisting.has(target) || pscClaimed.has(target)) pscDelete.push(p.id);
    else { pscUpdate.push({ id: p.id, stepKey: nextKey }); pscClaimed.add(target); }
  }

  // PrepWeekStructure: loser ids live inside persisted `stepKey` strings in the
  // blob. Ids are uuids, so a whole-blob string replace cannot hit anything else.
  const pwsToRewrite: Array<{ id: string; json: unknown; hits: number }> = [];
  for (const s of await prisma.prepWeekStructure.findMany({ select: { id: true, structureJson: true } })) {
    const out = rewriteStructureJson(s.structureJson, survivorByLoserId);
    if (out) pwsToRewrite.push({ id: s.id, json: out.json, hits: out.hits });
  }

  // Dish.substitutions — rewrite ONLY the name strings, in place. The 1,447
  // existing rows keep their validated shape; nothing else in the blob moves.
  const subsToRewrite: Array<{ id: string; json: unknown; hits: number }> = [];
  for (const d of await prisma.dish.findMany({
    where: { NOT: { substitutions: { equals: Prisma.DbNull } } },
    select: { id: true, substitutions: true },
  })) {
    const out = rewriteSubstitutions(d.substitutions, survivorNameByLoserName);
    if (out) subsToRewrite.push({ id: d.id, json: out.json, hits: out.hits });
  }

  // GroceryListItem.displayName — only rows whose display text IS exactly a
  // loser canonical name. A user-edited label never matches that, so this
  // cannot overwrite someone's own wording.
  const gliNameRewrite: Array<{ id: string; displayName: string }> = [];
  for (const g of await prisma.groceryListItem.findMany({ select: { id: true, displayName: true } })) {
    const grp = groupByLoserName.get(g.displayName.toLowerCase().trim());
    if (grp) gliNameRewrite.push({ id: g.id, displayName: grp.survivor.displayName });
  }

  // UserPreferences.recurringGroceryItems — preserve the user's capitalization
  // pattern ("Eggs" -> "Egg", not "egg"); this list is rendered in preferences.
  const prefRewrite: Array<{ id: string; items: string[] }> = [];
  for (const p of await prisma.userPreferences.findMany({ select: { id: true, recurringGroceryItems: true } })) {
    const out = rewriteRecurringItems(p.recurringGroceryItems ?? [], survivorNameByLoserName);
    if (out) prefRewrite.push({ id: p.id, items: out.items });
  }

  // MealPlanItem.recipeOverrideJson — dish ingredient `name` fields.
  const overrideRewrite: Array<{ id: string; json: unknown; hits: number }> = [];
  for (const it of await prisma.mealPlanItem.findMany({
    where: { NOT: { recipeOverrideJson: { equals: Prisma.DbNull } } },
    select: { id: true, recipeOverrideJson: true },
  })) {
    const out = rewriteOverrideNames(it.recipeOverrideJson, displayNameByLoserName);
    if (out) overrideRewrite.push({ id: it.id, json: out.json, hits: out.hits });
  }

  // Aliases. The merge OWNS the loser-name alias: if that aliasKey already
  // exists (the 6c-6 seed claimed "eggs" for "large eggs") it is RE-POINTED at
  // the survivor, deliberately and reportably, not skipped.
  const existingAliases = await prisma.ingredientAlias.findMany({
    select: { id: true, aliasKey: true, ingredientId: true },
  });
  const aliasByKey = new Map(existingAliases.map((a) => [a.aliasKey, a]));
  const aliasCreate: Array<{ ingredientId: string; alias: string; aliasKey: string }> = [];
  const aliasRepoint: Array<{ id: string; ingredientId: string; alias: string; from: string }> = [];
  const aliasDropSelf: string[] = [];
  for (const g of groups) {
    const key = normalizeAliasKey(g.loserName);
    const existing = aliasByKey.get(key);
    if (!existing) aliasCreate.push({ ingredientId: g.survivor.id, alias: g.loser.displayName, aliasKey: key });
    else if (existing.ingredientId !== g.survivor.id) {
      aliasRepoint.push({ id: existing.id, ingredientId: g.survivor.id, alias: g.loser.displayName, from: existing.ingredientId });
    }
  }
  // Alias rows the LOSER owns move to the survivor — unless that would make a
  // self-alias (aliasKey === the survivor's own canonicalName), which is noise.
  for (const a of existingAliases) {
    const g = groupByLoserId.get(a.ingredientId);
    if (!g) continue;
    if (a.aliasKey === normalizeAliasKey(g.survivorName)) { aliasDropSelf.push(a.id); continue; }
    if (aliasByKey.get(a.aliasKey)?.ingredientId === g.survivor.id) continue;
    aliasRepoint.push({ id: a.id, ingredientId: g.survivor.id, alias: a.aliasKey, from: a.ingredientId });
  }

  // ── the enumerated write plan ─────────────────────────────────────────────
  console.log(`\n--- write plan (every write, counted) ---`);
  console.log(`  DishIngredient.ingredientId    : ${loserRefs.dishIngredient} row(s) across ${groups.length} updateMany`);
  console.log(`  GroceryListItem.ingredientId   : ${loserRefs.groceryListItemFk} row(s)`);
  console.log(`  RecipeInstructionStep.amountRefs: ${stepsToRewrite.reduce((a, s) => a + s.changed, 0)} ref(s) in ${stepsToRewrite.length} step(s)`);
  console.log(`  PrepStepCompletion             : ${pscUpdate.length} rekeyed, ${pscDelete.length} deleted as duplicate-of-survivor`);
  console.log(`  PrepWeekStructure.structureJson: ${pwsToRewrite.reduce((a, s) => a + s.hits, 0)} id(s) in ${pwsToRewrite.length} row(s)`);
  console.log(`  Dish.substitutions             : ${subsToRewrite.reduce((a, s) => a + s.hits, 0)} name(s) in ${subsToRewrite.length} dish(es)`);
  console.log(`  GroceryListItem.displayName    : ${gliNameRewrite.length} row(s)`);
  console.log(`  UserPreferences.recurring      : ${prefRewrite.length} row(s)`);
  console.log(`  MealPlanItem.recipeOverrideJson: ${overrideRewrite.reduce((a, s) => a + s.hits, 0)} name(s) in ${overrideRewrite.length} item(s)`);
  console.log(`  IngredientAlias                : ${aliasCreate.length} created, ${aliasRepoint.length} re-pointed, ${aliasDropSelf.length} self-alias dropped`);
  console.log(`  Ingredient (survivor field writes): nutrition=${nutritionDecisions.size} pack=${packDecisions.size} conversionRef=${groups.filter((g) => !g.survivor.conversionRef && g.loser.conversionRef).length}`);
  console.log(`  Ingredient DELETE (losers)     : ${groups.length}`);

  // ── PASS 2: one transaction. ──────────────────────────────────────────────
  // WHY ONE: a half-merged catalog — some carriers rewritten, losers still
  // present — is a worse state than either end. Everything here is a write; all
  // reads happened above.
  // WHY 180s: nothing raises Prisma's 5000ms default globally (measured, Phase 0
  // §2.6 — every raise in this repo is per-call: 15s me.ts, 30s seeds, 60s
  // wizard). This pass issues roughly 1,100 statements over Neon; 60s is the
  // largest precedent and this is a bigger unit of work, so 180s with a 30s
  // maxWait for connection acquisition.
  const result = await prisma.$transaction(
    async (tx) => {
      let diUpdated = 0, gliFkUpdated = 0;
      for (const g of groups) {
        diUpdated += (await tx.dishIngredient.updateMany({
          where: { ingredientId: g.loser.id },
          data: { ingredientId: g.survivor.id },
        })).count;
        gliFkUpdated += (await tx.groceryListItem.updateMany({
          where: { ingredientId: g.loser.id },
          data: { ingredientId: g.survivor.id },
        })).count;
      }

      for (const s of stepsToRewrite) {
        await tx.recipeInstructionStep.update({
          where: { id: s.id },
          data: { amountRefs: s.refs as unknown as Prisma.InputJsonValue },
        });
      }
      for (const p of pscUpdate) {
        await tx.prepStepCompletion.update({ where: { id: p.id }, data: { stepKey: p.stepKey } });
      }
      if (pscDelete.length > 0) {
        await tx.prepStepCompletion.deleteMany({ where: { id: { in: pscDelete } } });
      }
      for (const s of pwsToRewrite) {
        await tx.prepWeekStructure.update({
          where: { id: s.id },
          data: { structureJson: s.json as Prisma.InputJsonValue },
        });
      }
      for (const s of subsToRewrite) {
        await tx.dish.update({
          where: { id: s.id },
          data: { substitutions: s.json as Prisma.InputJsonValue },
        });
      }
      for (const g of gliNameRewrite) {
        await tx.groceryListItem.update({ where: { id: g.id }, data: { displayName: g.displayName } });
      }
      for (const p of prefRewrite) {
        await tx.userPreferences.update({ where: { id: p.id }, data: { recurringGroceryItems: p.items } });
      }
      for (const o of overrideRewrite) {
        await tx.mealPlanItem.update({
          where: { id: o.id },
          data: { recipeOverrideJson: o.json as Prisma.InputJsonValue },
        });
      }

      // Survivor field writes, from the REVIEWED sheets only.
      let nutritionWritten = 0, packWritten = 0, conversionWritten = 0;
      for (const g of groups) {
        const data: Prisma.IngredientUpdateInput = {};
        const nut = nutritionDecisions.get(g.survivorName);
        if (nut === "LOSER") {
          data.nutritionRefPerUnit = g.loser.nutritionRefPerUnit as Prisma.InputJsonValue;
          nutritionWritten++;
        } else if (nut === "MISS") {
          // BUG-032's escape hatch: BOTH records are wrong. Stamp a miss-marker
          // and let BUG-122's catalog re-match block find a real one. We do NOT
          // search for a third fdcId here — a new pointer minted by this script
          // would enter the catalog wearing a `usda_derived` stamp it has not
          // earned.
          data.nutritionRefPerUnit = {
            source: "usda",
            matched: false,
            fetchedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue;
          nutritionWritten++;
        }
        if (packDecisions.get(g.survivorName) === "LOSER") {
          data.purchaseUnit = g.loser.purchaseUnit;
          data.purchaseQuantity = g.loser.purchaseQuantity;
          data.purchaseDisplay = g.loser.purchaseDisplay;
          packWritten++;
        }
        // conversionRef: 6 groups have it ONLY on the loser side. Take it — no
        // conflict is possible, and losing it would silently degrade every
        // unit conversion for that ingredient.
        if (!g.survivor.conversionRef && g.loser.conversionRef) {
          data.conversionRef = g.loser.conversionRef as Prisma.InputJsonValue;
          conversionWritten++;
        }
        if (Object.keys(data).length > 0) {
          await tx.ingredient.update({ where: { id: g.survivor.id }, data });
        }
      }

      // Aliases — the loser's name becomes findable on the survivor. THIS is
      // what stops resolveIngredients minting the duplicate back tomorrow.
      if (aliasDropSelf.length > 0) {
        await tx.ingredientAlias.deleteMany({ where: { id: { in: aliasDropSelf } } });
      }
      for (const a of aliasRepoint) {
        await tx.ingredientAlias.update({
          where: { id: a.id },
          data: { ingredientId: a.ingredientId, alias: a.alias },
        });
      }
      for (const a of aliasCreate) {
        await tx.ingredientAlias.create({ data: a });
      }

      return { diUpdated, gliFkUpdated, nutritionWritten, packWritten, conversionWritten };
    },
    { timeout: 180_000, maxWait: 30_000 },
  );

  console.log(`\n--- carriers rewritten ---`);
  console.log(`  DishIngredient rows moved to survivor : ${result.diUpdated}`);
  console.log(`  GroceryListItem rows moved to survivor: ${result.gliFkUpdated}`);
  console.log(`  survivor nutrition writes             : ${result.nutritionWritten}`);
  console.log(`  survivor pack writes                  : ${result.packWritten}`);
  console.log(`  survivor conversionRef adoptions      : ${result.conversionWritten}`);

  // ── THE GATE. Re-scan from scratch; the delete only happens at zero. ──────
  // GroceryListItem's FK is ON DELETE SET NULL — it will NOT stop a bad delete,
  // it will quietly null the column, and 80 rows are already null so the damage
  // would blend into existing noise. This assertion is the only thing standing
  // between a missed carrier and silent data loss.
  const remaining = await scanReferences(loserIds, loserNames);
  console.log(`\n--- pre-delete verification ---`);
  printCounts("remaining LOSER-side references (must be all zero):", remaining);
  if (totalRefs(remaining) !== 0) {
    console.log(`\n  ABORT BEFORE DELETE: ${totalRefs(remaining)} reference(s) survive the rewrite.`);
    console.log(`  The carrier rewrites are COMMITTED; the loser rows are NOT deleted, so`);
    console.log(`  nothing is orphaned. Fix the carrier above and re-run — the merge is`);
    console.log(`  idempotent and will resume.\n`);
    process.exitCode = 1;
    return;
  }

  const deleted = await prisma.ingredient.deleteMany({ where: { id: { in: [...loserIds] } } });
  console.log(`\n  losers deleted: ${deleted.count} (expected ${loserIds.size})`);

  // ── post-apply drift re-scan (the ws7-8b-b1 idempotence proof) ────────────
  const { groups: after, skipped: afterSkipped } = await loadGroups();
  console.log(`\n--- final ---`);
  console.log(`  fold pairs still live (expect 0):     ${after.length}`);
  console.log(`  fold pairs reported already-merged:   ${afterSkipped.length} (expect ${FOLD.length})`);
  const catalog = await prisma.ingredient.count();
  const aliases = await prisma.ingredientAlias.count();
  console.log(`  catalog rows: ${catalog}   alias rows: ${aliases}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
