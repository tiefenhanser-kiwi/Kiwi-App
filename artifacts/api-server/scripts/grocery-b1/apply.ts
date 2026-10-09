// [grocery] B1 · Part B — THE APPLY HALF OF THE ROUND TRIP.
//
//   node --env-file=.env --import tsx scripts/grocery-b1/apply.ts --dry-run
//   node --env-file=.env --import tsx scripts/grocery-b1/apply.ts --apply
//
// THE REVIEWED SHEET IS `proposals.ts`. `digest.ts` renders it as the numbered
// plain text Hans ruled on; his rulings of September 28 were then written back
// into `proposals.ts` by number (the two CHANGED lines, #12 and #71, carry a
// `RULED Sept 28` comment at the constant). So the sheet and the digest cannot
// drift: there is one source and the digest is a projection of it. This is the
// A1 contract — relations -> finalise -> apply, dry-run then write, provenance on
// every row — with the CSV step collapsed because the review happened in chat
// against a generated digest rather than against a spreadsheet.
//
// 🔴 EVERY WRITE HERE IS HUMAN-REVIEWED, so every row lands with
// `source: "human"` / `reviewedByHuman: true` / `reviewedAt`. That is not
// decoration: `reviewedByHuman` is the OVERWRITE GUARD, and for the component
// edges it is also the ADMIT GATE — Part C admits a pack-basis edge only when a
// human signed it off (see ingredientRelations.ts).
//
// IDEMPOTENT. A second run must report everything unchanged. Reported per class:
// created / updated / unchanged.

import { PrismaClient, type IngredientRelationLabel } from "@prisma/client";

import { normalizeIngredientName } from "../../src/lib/groceryNormalization";
import {
  PACK_YIELDS, PACK_YIELDS_PORTION_NAMES, PART_EDGES, WIDENED_ADMIT,
  SYNONYM_EDGES, CATEGORY_FIXES, RETIME,
} from "./proposals";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";

assertScriptDatabase("grocery-b1/apply");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const REVIEWED_AT = new Date("2026-09-28T20:00:00.000Z");

type Stat = { created: number; updated: number; unchanged: number; skipped: number };
const stat = (): Stat => ({ created: 0, updated: 0, unchanged: 0, skipped: 0 });
const stats: Record<string, Stat> = {
  "Y pack yields": stat(),
  "P1 basis admissions": stat(),
  "P3 component edges": stat(),
  "P4 synonym edges": stat(),
  "X salt row": stat(),
  "X pack fixes": stat(),
  "X category fixes": stat(),
  "X BUG-328 re-times": stat(),
};
const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };

async function main() {
  note(`[grocery] B1 Part B — ${APPLY ? "🔴 APPLY (writing)" : "DRY RUN (nothing written)"}`);
  note("");

  const ings = await prisma.ingredient.findMany({
    select: {
      id: true, canonicalName: true, category: true, defaultUnit: true,
      purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
      packYieldUnit: true, packYieldPerPack: true, packYieldSource: true,
      packYieldReviewedByHuman: true, conversionRef: true,
    },
  });
  const byName = new Map(ings.map((i) => [normalizeIngredientName(i.canonicalName), i]));

  // ── Y — the pack yields ────────────────────────────────────────────────────
  note("=== Y — PACK YIELDS ===");
  for (const y of [...PACK_YIELDS, ...PACK_YIELDS_PORTION_NAMES]) {
    const s = stats["Y pack yields"];
    const row = byName.get(normalizeIngredientName(y.ingredient));
    if (!row) { s.skipped++; note(`  SKIP ${y.ingredient}: no catalog row`); continue; }
    // The ladder cannot fire without a pack noun, and inventing one is a pack
    // write this block has no ruling for. Digest #41 / #44 / #46 — report-only.
    if (!row.purchaseUnit) {
      s.skipped++;
      note(`  SKIP ${y.ingredient}: no purchaseUnit — report-only (digest #41 / #44 / #46)`);
      continue;
    }
    const same =
      row.packYieldUnit === y.unit &&
      row.packYieldPerPack === y.perPack &&
      row.packYieldSource === y.source &&
      row.packYieldReviewedByHuman === true;
    if (same) { s.unchanged++; continue; }
    const was = row.packYieldPerPack == null ? "null" : `${row.packYieldPerPack} ${row.packYieldUnit}`;
    if (APPLY) {
      await prisma.ingredient.update({
        where: { id: row.id },
        data: {
          packYieldUnit: y.unit,
          packYieldPerPack: y.perPack,
          packYieldSource: y.source,
          packYieldReviewedByHuman: true,
        },
      });
    }
    if (row.packYieldPerPack == null) s.created++; else s.updated++;
    note(`  ${row.packYieldPerPack == null ? "SET " : "UPD "}${y.ingredient}: ${was} -> ${y.perPack} ${y.unit} per ${row.purchaseUnit} [${y.source}]`);
  }

  // ── the relation helpers ───────────────────────────────────────────────────
  const idOf = (name: string) => byName.get(normalizeIngredientName(name))?.id ?? null;

  async function upsertRelation(
    fromName: string, toName: string, label: IngredientRelationLabel,
    yieldQuantity: number | null, yieldUnit: string | null, coHarvestable: boolean | null,
    rationale: string, bucket: string,
  ) {
    const s = stats[bucket];
    const fromId = idOf(fromName);
    const toId = idOf(toName);
    if (!fromId || !toId) {
      s.skipped++;
      note(`  SKIP ${fromName} -> ${toName}: ${!fromId ? `no catalog row for "${fromName}"` : `no catalog row for "${toName}"`}`);
      return;
    }
    // Symmetric labels are stored in canonical order so one pair is one row and
    // a re-run is a no-op (the model's own note). Directed labels are not.
    let a = fromId, b = toId, an = fromName, bn = toName;
    if ((label === "synonym" || label === "distinct") && fromName > toName) {
      a = toId; b = fromId; an = toName; bn = fromName;
    }
    const existing = await prisma.ingredientRelation.findFirst({
      where: { fromIngredientId: a, toIngredientId: b },
    });
    const want = {
      label, yieldQuantity, yieldUnit, coHarvestable,
      source: "human" as const, confidence: "high" as const,
      reviewedByHuman: true, reviewedAt: REVIEWED_AT, rationale,
    };
    if (
      existing &&
      existing.label === want.label &&
      existing.yieldQuantity === want.yieldQuantity &&
      existing.yieldUnit === want.yieldUnit &&
      existing.coHarvestable === want.coHarvestable &&
      existing.source === want.source &&
      existing.confidence === want.confidence &&
      existing.reviewedByHuman === true &&
      existing.rationale === rationale
    ) { s.unchanged++; return; }
    const before = existing
      ? `${existing.label} ${existing.yieldQuantity ?? "-"} ${existing.yieldUnit ?? "-"} co=${existing.coHarvestable} human=${existing.reviewedByHuman}`
      : "(absent)";
    if (APPLY) {
      if (existing) {
        await prisma.ingredientRelation.update({ where: { id: existing.id }, data: want });
      } else {
        await prisma.ingredientRelation.create({
          data: { fromIngredientId: a, toIngredientId: b, ...want },
        });
      }
    }
    if (existing) s.updated++; else s.created++;
    note(`  ${existing ? "UPD " : "NEW "}${an} --${label}--> ${bn}: ${before} -> ${label} ${yieldQuantity ?? "-"} ${yieldUnit ?? "-"} co=${coHarvestable} human=true`);
  }

  // ── P1 — the basis admissions. reviewedByHuman IS the admit gate. ──────────
  note("");
  note("=== P1 — BASIS ADMISSIONS (reviewedByHuman = the admit gate) ===");
  for (const w of WIDENED_ADMIT) {
    const p = PART_EDGES.find((e) => `${e.parent} -> ${e.child}` === w.edge);
    if (!p) { stats["P1 basis admissions"].skipped++; note(`  SKIP ${w.edge}: no figure in the sheet`); continue; }
    await upsertRelation(
      p.parent, p.child, "component", p.yieldQuantity, p.yieldUnit, p.coHarvestable,
      `reviewed 2026-09-28: pack-basis admitted — ${w.why}`, "P1 basis admissions",
    );
  }

  // ── P3 — the new / re-figured component edges ─────────────────────────────
  note("");
  note("=== P3 — COMPONENT EDGES ===");
  for (const e of PART_EDGES.filter((x) => !x.existsButRefused)) {
    await upsertRelation(
      e.parent, e.child, "component", e.yieldQuantity, e.yieldUnit, e.coHarvestable,
      `reviewed 2026-09-28: ${e.note}`, "P3 component edges",
    );
  }

  // ── P4 — the new synonym edges ────────────────────────────────────────────
  note("");
  note("=== P4 — SYNONYM EDGES ===");
  for (const s of SYNONYM_EDGES) {
    await upsertRelation(s.a, s.b, "synonym", null, null, null, `reviewed 2026-09-28: ${s.why}`, "P4 synonym edges");
  }

  // ── X #93 — the salt row ──────────────────────────────────────────────────
  note("");
  note("=== X #93 — THE COARSE-SALT ROW (D-WS9-217, permanent) ===");
  await upsertRelation(
    "coarse kosher salt", "kosher salt", "distinct", null, null, null,
    "reviewed 2026-09-28: D-WS9-217 is PERMANENT — Hans, 2026-09-05: 'we can leave that as coarse and regular as separate items. if the user wants to sub regular for coarse it's up to them.' The runtime NEVER_FOLD_PAIRS veto already refuses this pair; this stops a confidence upgrade from ever proposing it again.",
    "X salt row",
  );

  // ── X #94-98 — the pack fixes ─────────────────────────────────────────────
  note("");
  note("=== X #94-98 — PACK FIXES ===");
  const packFixes: { name: string; unit?: string; quantity?: number; display?: string; why: string }[] = [
    { name: "iceberg lettuce", quantity: 1, display: "1 head", why: "#94 — a pack of FOUR heads is why two lists ordered '4 heads iceberg lettuce (2 cup)'" },
    { name: "red cabbage", unit: "head", why: "#95 — the display already reads '1 head'; the ladder fires only when purchaseUnit is the pack noun" },
    { name: "broccoli", unit: "head", why: "#96 — display reads '1 head'" },
    { name: "radicchio", unit: "head", why: "#97 — display reads '1 head'" },
    { name: "crusty bread", unit: "loaf", why: "#98 — display reads '1 loaf (crusty bread)'" },
  ];
  for (const f of packFixes) {
    const s = stats["X pack fixes"];
    const row = byName.get(normalizeIngredientName(f.name));
    if (!row) { s.skipped++; note(`  SKIP ${f.name}: no catalog row`); continue; }
    const data: Record<string, string | number> = {};
    if (f.unit !== undefined && row.purchaseUnit !== f.unit) data.purchaseUnit = f.unit;
    if (f.quantity !== undefined && row.purchaseQuantity !== f.quantity) data.purchaseQuantity = f.quantity;
    if (f.display !== undefined && row.purchaseDisplay !== f.display) data.purchaseDisplay = f.display;
    if (Object.keys(data).length === 0) { s.unchanged++; continue; }
    // ⚠️ D-WS9-222's guard: never null a pack the group already had. This only
    // ever writes a CONCRETE value, never null, so it cannot weaken it.
    if (APPLY) await prisma.ingredient.update({ where: { id: row.id }, data });
    s.updated++;
    note(`  UPD ${f.name}: unit=${row.purchaseUnit}/${row.purchaseQuantity}/"${row.purchaseDisplay}" -> ${JSON.stringify(data)}  [${f.why}]`);
  }

  // ── X — the four category corrections ─────────────────────────────────────
  note("");
  note("=== X — CATEGORY CORRECTIONS (Pantry -> Produce) ===");
  note("  Each one moves TWO things: the perishability tier (PERISHABILITY_BY_CATEGORY,");
  note("  day assignment: Pantry tier 3 STABLE -> Produce tier 1 FRESH) and the grocery");
  note("  AISLE (CATEGORY_TO_SECTION: 'pantry' -> 'produce').");
  for (const c of CATEGORY_FIXES) {
    const s = stats["X category fixes"];
    const row = byName.get(normalizeIngredientName(c.ingredient));
    if (!row) { s.skipped++; note(`  SKIP ${c.ingredient}: no catalog row`); continue; }
    if (row.category === c.to) { s.unchanged++; continue; }
    if (row.category !== c.from) {
      s.skipped++;
      note(`  SKIP ${c.ingredient}: expected category "${c.from}", found "${row.category}" — refusing to guess`);
      continue;
    }
    if (APPLY) await prisma.ingredient.update({ where: { id: row.id }, data: { category: c.to } });
    s.updated++;
    note(`  UPD ${c.ingredient}: ${c.from} -> ${c.to} · perishability tier 3 STABLE -> 1 FRESH · aisle ${c.aisle}`);
  }

  // ── X — BUG-328, the PUBLIC rows only ────────────────────────────────────
  note("");
  note("=== X — BUG-328 RE-TIMES (PUBLIC rows only) ===");
  for (const r of RETIME) {
    const s = stats["X BUG-328 re-times"];
    const meals = await prisma.meal.findMany({
      where: { id: { startsWith: r.id } },
      select: { id: true, title: true, estimatedTimeMinutes: true, isPublic: true, userId: true },
    });
    if (meals.length !== 1) { s.skipped++; note(`  SKIP ${r.id}: matched ${meals.length} meals`); continue; }
    const m = meals[0];
    // 🔴 The three private copies are USER-OWNED and are not touched. This is the
    // guard that says so in code, not just in the plan.
    if (!m.isPublic || m.userId !== null) {
      s.skipped++;
      note(`  SKIP ${m.id.slice(0, 8)} "${m.title}": not a public catalog row (isPublic=${m.isPublic}, userId=${m.userId ? "set" : "null"}) — user-owned rows are never re-timed`);
      continue;
    }
    if (m.estimatedTimeMinutes === r.to) { s.unchanged++; continue; }
    if (m.estimatedTimeMinutes !== r.from) {
      s.skipped++;
      note(`  SKIP ${m.id.slice(0, 8)}: expected label ${r.from}, found ${m.estimatedTimeMinutes} — refusing to guess`);
      continue;
    }
    if (APPLY) {
      await prisma.meal.update({ where: { id: m.id }, data: { estimatedTimeMinutes: r.to } });
    }
    s.updated++;
    note(`  UPD ${m.id.slice(0, 8)} "${m.title}": estimatedTimeMinutes ${r.from} -> ${r.to} (the honest step sum). activeTimeMinutes is DERIVED (D-WS9-235) and is left alone.`);
  }

  // ── totals ────────────────────────────────────────────────────────────────
  note("");
  note("=== TOTALS ===");
  let anyWrite = 0;
  for (const [k, s] of Object.entries(stats)) {
    note(`  ${k.padEnd(24)} created ${s.created} · updated ${s.updated} · unchanged ${s.unchanged} · skipped ${s.skipped}`);
    anyWrite += s.created + s.updated;
  }
  note(`  ${"TOTAL".padEnd(24)} ${anyWrite} row(s) ${APPLY ? "written" : "would be written"}`);
  if (!APPLY) note("\n  (dry run — re-run with --apply to write)");

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
