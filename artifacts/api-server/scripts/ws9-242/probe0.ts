// Phase 0 read-only probe for the D-WS9-242 lane.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
console.log("DB HOST =", new URL(process.env.DATABASE_URL!).host, "· READ-ONLY");
// 0.4 — three dishes with a bought path: registry runtime shape
const boughtSteps = await p.recipeInstructionStep.findMany({ where: { ownerType: "dish", pathKey: "bought" }, select: { ownerId: true }, distinct: ["ownerId"], take: 3 });
for (const b of boughtSteps) {
  const d = await p.dish.findUnique({ where: { id: b.ownerId }, select: { id: true, title: true, userId: true, componentRegistry: true, substitutions: true } });
  const steps = await p.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: b.ownerId }, orderBy: { stepIndex: "asc" }, select: { stepIndex: true, phaseType: true, estimatedMinutes: true, componentKey: true, pathKey: true, stepTextRaw: true } });
  console.log(`\nDISH ${d?.id} "${d?.title}" userId=${d?.userId}\n  componentRegistry = ${JSON.stringify(d?.componentRegistry)}\n  substitutions = ${JSON.stringify(d?.substitutions)?.slice(0, 300)}`);
  for (const s of steps) console.log(`  #${s.stepIndex} ${s.phaseType.padEnd(8)} ${String(s.estimatedMinutes).padStart(3)}m ${(s.componentKey ?? "-").padEnd(12)} ${(s.pathKey ?? "base").padEnd(7)} ${s.stepTextRaw.slice(0, 90)}`);
}
// registry shape census: array vs object, keys present
const regs = await p.dish.findMany({ where: { componentRegistry: { not: undefined } }, select: { id: true, componentRegistry: true } });
const withReg = regs.filter((r) => r.componentRegistry !== null);
let arr = 0, obj = 0, other = 0; const keySets = new Map<string, number>();
for (const r of withReg) { const v = r.componentRegistry as unknown; if (Array.isArray(v)) { arr++; for (const e of v) { const ks = Object.keys(e as object).sort().join(","); keySets.set(ks, (keySets.get(ks) ?? 0) + 1); } } else if (v && typeof v === "object") obj++; else other++; }
console.log(`\nregistry census: dishes with non-null componentRegistry=${withReg.length} · array=${arr} object=${obj} other=${other} · entry key-sets: ${[...keySets].map(([k, v]) => `{${k}}×${v}`).join(" ")}`);
// components with a bought path, whole population + splits
const bought = await p.recipeInstructionStep.findMany({ where: { ownerType: "dish", pathKey: "bought" }, select: { ownerId: true, componentKey: true }, distinct: ["ownerId", "componentKey"] });
const dishIds = [...new Set(bought.map((b) => b.ownerId))];
const dishes = await p.dish.findMany({ where: { id: { in: dishIds } }, select: { id: true, userId: true, mealLinks: { select: { meal: { select: { userId: true, dishFamilyKey: true } } } } } });
const dm = new Map(dishes.map((d) => [d.id, d]));
let pub = 0, km = 0, priv = 0;
for (const b of bought) { const d = dm.get(b.ownerId)!; const km30 = d.mealLinks.some((l) => (l.meal.dishFamilyKey ?? "").startsWith("km30-")); const isPub = d.mealLinks.some((l) => l.meal.userId === null); if (km30) km++; else if (isPub) pub++; else priv++; }
console.log(`components with a bought path (distinct dish×componentKey over RecipeInstructionStep.pathKey='bought'): ${bought.length} on ${dishIds.length} dishes · linked to a Meal.userId IS NULL meal, non-km30: ${pub} · km30- (dishFamilyKey prefix): ${km} · private-only: ${priv}`);
// km30 population facts
const kmMeals = await p.meal.findMany({ where: { dishFamilyKey: { startsWith: "km30-" } }, select: { id: true, userId: true, isPublic: true, sourceType: true } });
console.log(`km30- meals: ${kmMeals.length} · userId null: ${kmMeals.filter((m) => m.userId === null).length} · isPublic true: ${kmMeals.filter((m) => m.isPublic).length} · sourceType: ${[...new Set(kmMeals.map((m) => m.sourceType))].join(",")}`);
const shelfEx = await p.meal.findMany({ where: { userId: null, NOT: { dishFamilyKey: { startsWith: "km30-" } } }, select: { estimatedTimeMinutes: true, isArchived: true, mealType: true, activeTimeMinutes: true } });
const cnt = (xs: { estimatedTimeMinutes: number }[]) => `n=${xs.length} ≤30:${xs.filter((m) => m.estimatedTimeMinutes <= 30).length} ≤45:${xs.filter((m) => m.estimatedTimeMinutes <= 45).length} ≤60:${xs.filter((m) => m.estimatedTimeMinutes <= 60).length}`;
console.log(`shelf (Meal.userId IS NULL, excluding km30-): ${cnt(shelfEx)} · dinner+active-not-null+not-archived subset: ${cnt(shelfEx.filter((m) => m.mealType === "dinner" && m.activeTimeMinutes !== null && !m.isArchived))}`);
const shelfIn = await p.meal.findMany({ where: { userId: null }, select: { estimatedTimeMinutes: true, isArchived: true, mealType: true, activeTimeMinutes: true } });
console.log(`shelf (Meal.userId IS NULL, including km30-): ${cnt(shelfIn)} · dinner subset: ${cnt(shelfIn.filter((m) => m.mealType === "dinner" && m.activeTimeMinutes !== null && !m.isArchived))}`);
// LLMCallLog promptVersion for store prompts
const logs = await p.lLMCallLog.groupBy({ by: ["promptKey", "promptVersion"], where: { promptKey: { in: ["store.generate_meal", "store.finalize_steps"] } }, _count: { _all: true } }).catch((e) => String(e));
console.log("LLMCallLog store prompt versions:", JSON.stringify(logs));
await p.$disconnect();
