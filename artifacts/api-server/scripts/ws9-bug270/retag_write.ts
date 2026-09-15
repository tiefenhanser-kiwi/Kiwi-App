// WS9 BUG-270 Phase E §3.3 — WRITE the re-derived tags for the ACCEPTED dishes (retag_tags.json, hand-checked)
// and re-stamp their meals through the Phase D path: before-dump → null the dish's old tags (assert count) →
// write the new tags (assert count) → stampMealTiming in the batch transaction → per-meal assertion against
// the prediction → verify from the DB. PURE WRITE: no Anthropic import.
//   node --env-file=.env --import tsx scripts/ws9-bug270/retag_write.ts --dry     # predictions (full meal context) + before-dump, no writes
//   node --env-file=.env --import tsx scripts/ws9-bug270/retag_write.ts --apply
// ⚠️ SHARED CATALOG DATA. Revert: scripts/ws9-bug270/retag_revert.ts (restores every step's old parallelGroup
// from retag_before.json and writes the meal/dish stamps back from it — the stamps then equal the Phase D state).
import { PrismaClient, type Prisma } from "@prisma/client";
import { readFileSync, writeFileSync } from "node:fs";

import { deriveMealTiming, stampMealTiming } from "../../src/lib/mealTiming";
import type { SchedulerDish, SchedulerPhase } from "../../src/lib/cookingScheduler";

const OUT = "scripts/output/ws9-bug270";
const APPLY = process.argv.includes("--apply");
// §3.2 hand-check (see the Phase E report): REFUSED = the tag would read SHORT.
const REFUSED: Record<string, string> = {
  "7969ed9e-857d-4ed7-8eb1-100bcd7386cb": "Patty Melt — #2 (Worcestershire into the CARAMELIZED onions) rides #1 (the caramelize) from kickoff; contiguity cannot exclude it; reads 2 min short (46 vs 48)",
  "7d58167f-dbd6-4820-9ce8-4ae94c7b7a33": "Beef Pho — riders on #4 (strain the broth + season), hands-on work typed as an unattended cook: BUG-269's shape; the 33-min simmer is the real window but the strain sits between (contiguity)",
};
type R = { mealId: string; dishId: string; title: string; tags: Record<string, string>; oldTags: Record<string, string> };
const file = JSON.parse(readFileSync(`${OUT}/retag_tags.json`, "utf8")) as { model: string; derivation: string; stepFilter: string; results: R[] };
console.log(`file: ${file.results.length} dishes · model ${file.model} · derivation ${file.derivation} · filter ${file.stepFilter} · anthropic client constructed: NO (not imported)`);
const accepted = file.results.filter((r) => !(r.dishId in REFUSED));
console.log(`accepted ${accepted.length} · refused ${Object.keys(REFUSED).length}: ${Object.values(REFUSED).map((v) => v.split(" — ")[0]).join(", ")}`);
const prisma = new PrismaClient();
console.log(`DB HOST = ${new URL(process.env.DATABASE_URL!).host} · MODE = ${APPLY ? "APPLY (writes)" : "DRY (no writes)"}`);

// ── load the affected meals with EVERY dish's current tags (the prediction needs full context) ──
const mealIds = [...new Set(accepted.map((r) => r.mealId))];
const meals = await prisma.meal.findMany({ where: { id: { in: mealIds } }, select: { id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true, dishLinks: { select: { dishId: true, positionIndex: true, dish: { select: { title: true, estimatedTimeMinutes: true } } } } } });
const allDishIds = meals.flatMap((m) => m.dishLinks.map((l) => l.dishId));
const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: allDishIds } }, select: { ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true, isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true }, orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }] });
const byDish = new Map<string, typeof steps>();
for (const s of steps) byDish.set(s.ownerId, [...(byDish.get(s.ownerId) ?? []), s]);
const acceptedByDish = new Map(accepted.map((r) => [r.dishId, r]));

// drift check: the dish's current tags must equal the file's oldTags (nothing moved since retag.ts ran)
for (const r of accepted) {
  const cur = Object.fromEntries((byDish.get(r.dishId) ?? []).filter((s) => s.parallelGroup).map((s) => [String(s.stepIndex), s.parallelGroup as string]));
  if (JSON.stringify(cur) !== JSON.stringify(r.oldTags)) { console.log(`🔴 ${r.dishId} tags drifted since retag.ts: DB ${JSON.stringify(cur)} vs file ${JSON.stringify(r.oldTags)} — STOP`); await prisma.$disconnect(); process.exit(2); }
}

// predictions with full context
const predict = (m: typeof meals[number]) => {
  const dishes: SchedulerDish[] = m.dishLinks.filter((l) => byDish.has(l.dishId)).map((l) => ({ dishId: l.dishId, title: l.dish.title, positionIndex: l.positionIndex, steps: byDish.get(l.dishId)!.map((s) => ({ stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType as SchedulerPhase, isTimingSensitive: s.isTimingSensitive, componentKey: s.componentKey, pathKey: s.pathKey, parallelGroup: acceptedByDish.has(l.dishId) ? (acceptedByDish.get(l.dishId)!.tags[String(s.stepIndex)] ?? null) : s.parallelGroup })) }));
  return deriveMealTiming(dishes);
};
const predictions = new Map(meals.map((m) => [m.id, predict(m)]));
console.log(`\nPREDICTIONS (full meal context):`);
for (const m of meals) {
  const p = predictions.get(m.id)!;
  const r = accepted.filter((x) => x.mealId === m.id);
  for (const x of r) { const cur = m.dishLinks.find((l) => l.dishId === x.dishId)!.dish.estimatedTimeMinutes; console.log(`  ${x.dishId.slice(0, 8)} "${x.title.slice(0, 38)}" old tags ${Object.keys(x.oldTags).length} → new ${Object.keys(x.tags).length} · dish ${cur} → ${p.dishTotals.get(x.dishId)} · meal "${m.title.slice(0, 40)}" ${m.estimatedTimeMinutes}/${m.activeTimeMinutes}a → ${p.totalMinutes}/${p.activeMinutes}a${p.ignoredTags.length ? " · ignored " + p.ignoredTags.map((t) => t.reason).join(",") : ""}`); }
}

// ── before-dump: old tags per step of the accepted dishes + meal/dish stamps of their meals ──
const before = { recordedAt: new Date().toISOString(), steps: accepted.flatMap((r) => (byDish.get(r.dishId) ?? []).map((s) => ({ dishId: r.dishId, stepIndex: s.stepIndex, parallelGroup: s.parallelGroup }))), meals: meals.map((m) => ({ id: m.id, estimatedTimeMinutes: m.estimatedTimeMinutes, activeTimeMinutes: m.activeTimeMinutes })), dishes: [...new Map(meals.flatMap((m) => m.dishLinks.map((l) => [l.dishId, { id: l.dishId, estimatedTimeMinutes: l.dish.estimatedTimeMinutes }] as const))).values()] };
if (new Set(before.steps.map((s) => `${s.dishId}#${s.stepIndex}`)).size !== before.steps.length) throw new Error("before-dump: step rows not 1:1");
writeFileSync(`${OUT}/retag_before.json`, JSON.stringify(before, null, 1));
console.log(`\nbefore-dump: ${before.steps.length} step rows (${accepted.length} dishes) · ${before.meals.length} meals · ${before.dishes.length} dishes → ${OUT}/retag_before.json · one row per id ✓`);
if (!APPLY) { console.log("DRY — nothing written. Re-run with --apply."); await prisma.$disconnect(); process.exit(0); }

// ── write: one transaction (≤ 100 meals), per-dish row-count assertions, per-meal stamp assertion ──
let nulled = 0, written = 0, assertions = 0;
await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
  for (const m of meals) {
    for (const r of accepted.filter((x) => x.mealId === m.id)) {
      const oldCount = Object.keys(r.oldTags).length;
      const res = await tx.recipeInstructionStep.updateMany({ where: { ownerType: "dish", ownerId: r.dishId, parallelGroup: { not: null } }, data: { parallelGroup: null } });
      if (res.count !== oldCount) throw new Error(`${r.dishId}: nulled ${res.count} rows, expected ${oldCount} — rolled back`);
      nulled += res.count;
      for (const [si, tok] of Object.entries(r.tags)) {
        const w = await tx.recipeInstructionStep.updateMany({ where: { ownerType: "dish", ownerId: r.dishId, stepIndex: Number(si) }, data: { parallelGroup: tok } });
        if (w.count !== 1) throw new Error(`${r.dishId}#${si}: tag write touched ${w.count} rows — rolled back`);
        written++;
      }
    }
    const t = await stampMealTiming(tx, m.id, m.dishLinks.map((l) => l.dishId));
    const p = predictions.get(m.id)!;
    if (t.totalMinutes !== p.totalMinutes || t.activeMinutes !== p.activeMinutes) throw new Error(`stamp mismatch on ${m.id}: ${t.totalMinutes}/${t.activeMinutes} vs predicted ${p.totalMinutes}/${p.activeMinutes} — rolled back`);
    for (const [d, v] of t.dishTotals) if (p.dishTotals.get(d) !== v) throw new Error(`dish stamp mismatch ${m.id}/${d}: ${v} vs ${p.dishTotals.get(d)} — rolled back`);
    assertions++;
  }
}, { timeout: 120_000 });
console.log(`written: tags nulled ${nulled} · tags written ${written} · meals re-stamped ${assertions}/${meals.length} (one transaction)`);

// ── verify from the DB ──
const after = await prisma.meal.findMany({ where: { id: { in: mealIds } }, select: { id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true, dishLinks: { select: { dishId: true, dish: { select: { estimatedTimeMinutes: true } } } } } });
let ok = 0;
for (const m of after) { const p = predictions.get(m.id)!; const good = m.estimatedTimeMinutes === p.totalMinutes && m.activeTimeMinutes === p.activeMinutes && m.dishLinks.every((l) => (p.dishTotals.get(l.dishId) ?? l.dish.estimatedTimeMinutes) === l.dish.estimatedTimeMinutes); if (good) ok++; else console.log(`  🔴 ${m.id} DB ${m.estimatedTimeMinutes}/${m.activeTimeMinutes} vs predicted ${p.totalMinutes}/${p.activeMinutes}`); }
const tagsNow = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: accepted.map((r) => r.dishId) }, parallelGroup: { not: null } }, select: { ownerId: true, stepIndex: true, parallelGroup: true } });
const tagsOk = accepted.every((r) => JSON.stringify(Object.fromEntries(tagsNow.filter((t) => t.ownerId === r.dishId).sort((a, b) => a.stepIndex - b.stepIndex).map((t) => [String(t.stepIndex), t.parallelGroup]))) === JSON.stringify(r.tags));
const boughtTagged = await prisma.recipeInstructionStep.count({ where: { ownerType: "dish", ownerId: { in: accepted.map((r) => r.dishId) }, pathKey: "bought", parallelGroup: { not: null } } });
console.log(`DB re-read: meals at predicted stamps ${ok}/${after.length} · tags on DB == file for all accepted dishes: ${tagsOk ? "YES" : "🔴 NO"} · bought steps still carrying a tag: ${boughtTagged}`);
if (ok !== after.length || !tagsOk || boughtTagged) { console.log("🔴 POST-CONDITION FAILED — revert: scripts/ws9-bug270/retag_revert.ts --apply"); process.exitCode = 3; } else console.log("✅ verified from the DB.");
await prisma.$disconnect();
