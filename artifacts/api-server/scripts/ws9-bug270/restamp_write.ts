// WS9 BUG-270 Phase D — RE-STAMP the PUBLIC catalog (meal.userId null) from restamp_pending.json.
// Hans's ruling (2026-09-15, option B): the public population only; private batch_generated rows are
// EXCLUDED (D-WS9-230). PURE WRITE: no Anthropic import, no re-derivation under a different rule — the
// running scheduler must reproduce the file's change set IDENTICALLY or nothing is written.
//
//   node --env-file=.env --import tsx scripts/ws9-bug270/restamp_write.ts --dry     # identity proof + split + pre-write dump, no writes
//   node --env-file=.env --import tsx scripts/ws9-bug270/restamp_write.ts --apply   # batches of 100 meals, one tx each, verify from DB
//
// Mechanism reused from scripts/ws9-239/catalog_write.ts (1c Phase 3): batch loop, one $transaction per
// batch, the SHIPPED stampMealTiming, per-meal assertion vs the file (mismatch → batch rolled back →
// stop), pre-write dump, seeded random-30 re-read, DB invariants. NOT reused: the tag writes, the
// EXCLUDED_DISHES map, catalog_tags.json's shape (this file is keyed by meal id with before/after pairs).
// ⚠️ SHARED CATALOG DATA. Revert: scripts/ws9-bug270/restamp_revert.ts (writes restamp_before.json back —
// the old numbers came from the OLD scheduler and cannot be regenerated from the steps).
import { PrismaClient, type Prisma } from "@prisma/client";
import { readFileSync, writeFileSync } from "node:fs";

import { deriveMealTiming, stampMealTiming } from "../../src/lib/mealTiming";
import type { SchedulerDish, SchedulerPhase } from "../../src/lib/cookingScheduler";
import { mulberry32 } from "../ws9-239/common.js";

const OUT = "scripts/output/ws9-bug270";
const APPLY = process.argv.includes("--apply");
const SCHEDULER_PATH = "src/lib/cookingScheduler.ts (via src/lib/mealTiming.ts deriveMealTiming / stampMealTiming)";
// Phase C's 19 LONGER meals (longer_out.txt) — the DB-measured LONGER set must be exactly their public members.
const PHASE_C_LONGER = new Set("024348ea-0883-4086-be59-91861aebccb5 17b7f482-71eb-4083-9f9d-549d86b4c542 1d954fa7-1e87-425c-be96-6917e54dbc4d 23d2ffe6-5b8c-49e2-ac86-d43fe4591b81 3feb4707-d3b9-4be3-a5db-a84f1c45a455 4074ecd1-670c-415f-ae34-2bfc6172b403 43bc4656-31ae-4ada-9730-980fa3dd38b0 5d62d6d3-2373-43aa-8420-9422f7abb22b 79f01942-2ce3-4ccd-a7a9-ab4ccac484fc 86cf6dd7-4c14-456a-8ec5-0ca28e28a0d5 8b2b10e0-891b-4c3b-85cf-2c19219c41d7 8def860b-1874-4652-baa4-b83fe1b7b4f6 8fd97165-866f-490f-8475-394b70d91fae 9e212cbe-af4a-4a49-a478-ff8233bafb85 b3d2cffd-1da9-44c7-aaa2-f8c61b233836 b4ab4858-fea5-4a39-b690-7a38c455259d bab15dfa-5638-4df1-8621-e82d8d37e516 bcc86e67-701e-4e3d-a61e-aa49ec7f3b8c c3ad3eb7-da5a-4e80-bc57-c46da74eda89".split(" "));

type Pair = { before: number; after: number };
type FileMeal = { title: string; pool: string; estimatedTimeMinutes: Pair; activeTimeMinutes: Pair; stored: { estimatedTimeMinutes: number; activeTimeMinutes: number | null }; dishes: Record<string, { title: string; before: number; after: number }> };
const file = JSON.parse(readFileSync(`${OUT}/restamp_pending.json`, "utf8")) as { fixCommit: string; meals: number; changeSet: Record<string, FileMeal> };
console.log(`running module: ${SCHEDULER_PATH} · file fixCommit ${file.fixCommit} · anthropic client constructed: NO (not imported)`);
console.log(`file: ${file.meals} meals · ${Object.values(file.changeSet).reduce((a, m) => a + Object.keys(m.dishes).length, 0)} dish rows`);

const prisma = new PrismaClient();
console.log(`DB HOST = ${new URL(process.env.DATABASE_URL!).host} · MODE = ${APPLY ? "APPLY (writes)" : "DRY (no writes)"}`);

// ── shared: derive every meal from the DB with the SHIPPED module (same shape as d235 --dry) ────
type Derived = { total: number; active: number; dishes: Record<string, number>; stored: { total: number; active: number | null; dishes: Record<string, number | null> }; userId: string | null; km30: boolean; title: string };
async function deriveAll(): Promise<Map<string, Derived>> {
  const meals = await prisma.meal.findMany({ select: { id: true, title: true, userId: true, isPublic: true, dishFamilyKey: true, estimatedTimeMinutes: true, activeTimeMinutes: true, dishLinks: { select: { dishId: true, positionIndex: true, dish: { select: { estimatedTimeMinutes: true } } } } }, orderBy: { id: "asc" } });
  const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish" }, select: { ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true, isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true }, orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }] });
  const byDish = new Map<string, SchedulerDish["steps"]>();
  for (const s of steps) byDish.set(s.ownerId, [...(byDish.get(s.ownerId) ?? []), { stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType as SchedulerPhase, isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey }]);
  const out = new Map<string, Derived>();
  for (const m of meals) {
    const dishes: SchedulerDish[] = m.dishLinks.filter((l) => byDish.has(l.dishId)).map((l) => ({ dishId: l.dishId, title: l.dishId, positionIndex: l.positionIndex, steps: byDish.get(l.dishId)! }));
    const t = deriveMealTiming(dishes);
    if (t.totalMinutes === null || t.activeMinutes === null) continue;
    out.set(m.id, { total: t.totalMinutes, active: t.activeMinutes, dishes: Object.fromEntries(t.dishTotals), stored: { total: m.estimatedTimeMinutes, active: m.activeTimeMinutes, dishes: Object.fromEntries(m.dishLinks.map((l) => [l.dishId, l.dish.estimatedTimeMinutes])) }, userId: m.userId, km30: m.dishFamilyKey?.startsWith("km30-") ?? false, title: m.title });
  }
  return out;
}
const movedOf = (d: Derived) => d.total !== d.stored.total || d.active !== d.stored.active || Object.entries(d.dishes).some(([id, v]) => d.stored.dishes[id] !== v);
const shelves = (vals: number[]) => `<=30 ${vals.filter((v) => v <= 30).length} · <=45 ${vals.filter((v) => v <= 45).length} · <=60 ${vals.filter((v) => v <= 60).length}`;

// ── 1. identity proof: the running module's change set == the file's ─────────────────────────────
const derived = await deriveAll();
let identical = true; const why: string[] = [];
const fileIds = new Set(Object.keys(file.changeSet));
for (const [id, d] of derived) {
  const f = file.changeSet[id];
  if (movedOf(d) !== fileIds.has(id)) { identical = false; why.push(`${id}: module says moved=${movedOf(d)}, file has it=${fileIds.has(id)}`); continue; }
  if (!f) continue;
  if (d.total !== f.estimatedTimeMinutes.after || d.active !== f.activeTimeMinutes.after) { identical = false; why.push(`${id}: after ${d.total}/${d.active} vs file ${f.estimatedTimeMinutes.after}/${f.activeTimeMinutes.after}`); }
  if (d.stored.total !== f.stored.estimatedTimeMinutes || d.stored.active !== f.stored.activeTimeMinutes) { identical = false; why.push(`${id}: DB stored ${d.stored.total}/${d.stored.active} drifted from file ${f.stored.estimatedTimeMinutes}/${f.stored.activeTimeMinutes}`); }
  const changedDishes = Object.entries(d.dishes).filter(([did, v]) => d.stored.dishes[did] !== v);
  if (changedDishes.length !== Object.keys(f.dishes).length || changedDishes.some(([did, v]) => f.dishes[did]?.after !== v)) { identical = false; why.push(`${id}: dish rows differ`); }
}
for (const id of fileIds) if (!derived.has(id)) { identical = false; why.push(`${id}: in file, not derivable now`); }
console.log(`\nIDENTITY: derivable meals=${derived.size} · module change set == file: ${identical ? "YES (same ids, same after-values, same dish rows, DB stored == file stored)" : "🔴 NO"}`);
if (!identical) { console.log(why.slice(0, 10).join("\n")); console.log("🔴 STOP — nothing written."); await prisma.$disconnect(); process.exit(2); }

// ── split per the ruling: meal.userId null = PUBLIC ─────────────────────────────────────────────
const pub = [...fileIds].filter((id) => derived.get(id)!.userId === null);
const priv = [...fileIds].filter((id) => derived.get(id)!.userId !== null);
const dishRows = (ids: string[]) => ids.reduce((a, id) => a + Object.keys(file.changeSet[id].dishes).length, 0);
console.log(`SPLIT: PUBLIC (userId null) meals=${pub.length} dishRows=${dishRows(pub)}  [km30 ${pub.filter((id) => derived.get(id)!.km30).length}]  ·  PRIVATE (excluded) meals=${priv.length} dishRows=${dishRows(priv)}  ·  file totals ${fileIds.size}/${dishRows([...fileIds])}`);
const privTotalMoves = priv.filter((id) => derived.get(id)!.total !== derived.get(id)!.stored.total).length;
console.log(`predicted private residue after the write: ${priv.length} meals still moved (any field); ${privTotalMoves} with a TOTAL move (what d235's gaining/losing counts)`);

// ── 3. pre-write dump: every affected public meal + EVERY dish of those meals (the stamp touches all) ──
const pubMeals = await prisma.meal.findMany({ where: { id: { in: pub } }, select: { id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true, dishLinks: { select: { dishId: true, positionIndex: true, dish: { select: { id: true, title: true, estimatedTimeMinutes: true } } } } } });
const before = { recordedAt: new Date().toISOString(), fixCommit: file.fixCommit, meals: pubMeals.map((m) => ({ id: m.id, title: m.title, estimatedTimeMinutes: m.estimatedTimeMinutes, activeTimeMinutes: m.activeTimeMinutes, dishIds: m.dishLinks.map((l) => l.dishId) })), dishes: [...new Map(pubMeals.flatMap((m) => m.dishLinks.map((l) => [l.dish.id, { id: l.dish.id, title: l.dish.title, estimatedTimeMinutes: l.dish.estimatedTimeMinutes }] as const))).values()] };
if (new Set(before.meals.map((m) => m.id)).size !== before.meals.length || before.meals.length !== pub.length) throw new Error("pre-write dump: meal rows not 1:1");
if (new Set(before.dishes.map((d) => d.id)).size !== before.dishes.length) throw new Error("pre-write dump: dish rows not 1:1");
writeFileSync(`${OUT}/restamp_before.json`, JSON.stringify(before, null, 1));
console.log(`pre-write dump: ${before.meals.length} meals · ${before.dishes.length} dishes (all dishes of the affected meals; ${dishRows(pub)} of them change) → ${OUT}/restamp_before.json · one row per id ✓`);
const beforeDish = new Map(before.dishes.map((d) => [d.id, d.estimatedTimeMinutes]));

if (!APPLY) { console.log("\nDRY — nothing written. Re-run with --apply."); await prisma.$disconnect(); process.exit(0); }

// ── 4. write: batches of 100 meals, one transaction each, per-meal assertion against the file ──────
let assertions = 0, batches = 0;
const dishIdsByMeal = new Map(pubMeals.map((m) => [m.id, m.dishLinks.map((l) => l.dishId)]));
for (let b = 0; b < pub.length; b += 100) {
  const batch = pub.slice(b, b + 100);
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const mealId of batch) {
      const f = file.changeSet[mealId];
      const t = await stampMealTiming(tx, mealId, dishIdsByMeal.get(mealId)!);
      if (t.totalMinutes !== f.estimatedTimeMinutes.after || t.activeMinutes !== f.activeTimeMinutes.after) throw new Error(`stamp mismatch on ${mealId}: stamped ${t.totalMinutes}/${t.activeMinutes}, file ${f.estimatedTimeMinutes.after}/${f.activeTimeMinutes.after} — batch rolled back`);
      for (const [dishId, v] of t.dishTotals) {
        const want = f.dishes[dishId] ? f.dishes[dishId].after : beforeDish.get(dishId);
        if (v !== want) throw new Error(`dish stamp mismatch on ${mealId}/${dishId}: ${v} vs ${want} — batch rolled back`);
      }
      assertions++;
    }
  }, { timeout: 120_000 });
  batches++;
  console.log(`  batch ${batches}: meals ${b + 1}–${b + batch.length} re-stamped + asserted (${assertions} so far)`);
}
console.log(`written: ${assertions} meals in ${batches} transactions; per-meal assertions passed: ${assertions}/${pub.length}`);

// ── 5. verify FROM THE DB ────────────────────────────────────────────────────────────────────────
const after = await deriveAll();
const pubAll = [...after.values()].filter((d) => d.userId === null);
const privAll = [...after.values()].filter((d) => d.userId !== null);
console.log(`\nDB: moved over PUBLIC population (${pubAll.length} derivable): ${pubAll.filter(movedOf).length}  (expected 0)`);
console.log(`DB: moved over PRIVATE population (${privAll.length} derivable): ${privAll.filter(movedOf).length} any-field / ${privAll.filter((d) => d.total !== d.stored.total).length} total  (predicted ${priv.length} / ${privTotalMoves})`);
// seeded random 30 (seed 270) of the affected public meals
const rnd = mulberry32(270); const shuffled = [...pub]; for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const sample = shuffled.slice(0, 30);
const sampleOk = sample.filter((id) => { const d = after.get(id)!; return !movedOf(d) && d.total === file.changeSet[id].estimatedTimeMinutes.after; }).length;
console.log(`random-30 re-read (seed 270): stored == derived on ${sampleOk}/30`);
// shelves from the DB, Phase C's population (derivable meals)
const pubNoKm = pubAll.filter((d) => !d.km30);
console.log(`SHELVES FROM DB (stored, derivable): public-only (${pubNoKm.length}) ${shelves(pubNoKm.map((d) => d.stored.total))}  [Phase C predicted 16 · 227 · 632]`);
console.log(`SHELVES FROM DB (stored, derivable): public + km30 (${pubAll.length}) ${shelves(pubAll.map((d) => d.stored.total))}  [Phase C predicted 24 · 272 · 716]`);
// LONGER set
const longer = pub.filter((id) => file.changeSet[id].estimatedTimeMinutes.after > file.changeSet[id].estimatedTimeMinutes.before);
const dbLonger = pub.filter((id) => after.get(id)!.stored.total > before.meals.find((m) => m.id === id)!.estimatedTimeMinutes);
const expectLonger = [...PHASE_C_LONGER].filter((id) => pub.includes(id));
const sameSet = dbLonger.length === expectLonger.length && dbLonger.every((id) => PHASE_C_LONGER.has(id));
console.log(`LONGER (DB after > before): ${dbLonger.length} — public members of Phase C's 19: ${expectLonger.length} — identical set: ${sameSet ? "YES" : "🔴 NO"} (file says ${longer.length})`);
// active
const aMoves = pub.map((id) => { const b0 = before.meals.find((m) => m.id === id)!; const a = after.get(id)!; return (b0.activeTimeMinutes ?? 0) - a.stored.active!; }).filter((x) => x !== 0);
const sorted = [...aMoves].sort((a, b) => a - b); const p = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
console.log(`ACTIVE (DB, public): moved on ${aMoves.length} meals · shortening p50=${p(0.5)} p90=${p(0.9)} max=${sorted[sorted.length - 1]} · LONGER=${aMoves.filter((x) => x < 0).length}`);
const ok = pubAll.filter(movedOf).length === 0 && sampleOk === 30 && sameSet && aMoves.filter((x) => x < 0).length === 0;
console.log(ok ? "\n✅ verified from the DB." : "\n🔴 POST-CONDITION FAILED — revert path: scripts/ws9-bug270/restamp_revert.ts --apply");
if (!ok) process.exitCode = 3;
await prisma.$disconnect();
