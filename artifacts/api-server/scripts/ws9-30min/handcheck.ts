// D-WS9-240 item 6 — hand-check material: a seeded random 10 of the km30- meals PLUS the top 3 by
// claimed saving (serial sum of every step − derived total: what the scheduler's overlap took off,
// where a bad window hurts most — the BUG-266 lesson). Read-only; writes handcheck.md.
//   node --env-file=.env --import tsx scripts/ws9-30min/handcheck.ts [seed]
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../../src/lib/cookingScheduler";

const OUT = "scripts/output/ws9-30min";
const SEED = Number(process.argv[2] ?? 244);
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const p = new PrismaClient();
const meals = await p.meal.findMany({ where: { dishFamilyKey: { startsWith: "km30-" } }, select: { id: true, title: true, description: true, dishFamilyKey: true, estimatedTimeMinutes: true, activeTimeMinutes: true, difficulty: true, cuisineType: true, dishLinks: { select: { dishId: true, positionIndex: true, roleLabel: true, dish: { select: { title: true, dishIngredients: { orderBy: { positionIndex: "asc" }, select: { quantity: true, unit: true, ingredient: { select: { canonicalName: true } } } } } } }, orderBy: { positionIndex: "asc" } } }, orderBy: { id: "asc" } });
const dishIds = meals.flatMap((m) => m.dishLinks.map((l) => l.dishId));
const steps = await p.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: dishIds } }, select: { ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true, isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true, stepTextTranslated: true }, orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }] });
await p.$disconnect();

type M = typeof meals[number];
const toDishes = (m: M): SchedulerDish[] => m.dishLinks.map((l) => ({ dishId: l.dishId, title: l.dish.title, positionIndex: l.positionIndex, steps: steps.filter((s) => s.ownerId === l.dishId).map((s) => ({ stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType as SchedulerPhase, isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey })) }));
const saving = (m: M) => steps.filter((s) => m.dishLinks.some((l) => l.dishId === s.ownerId)).reduce((a, s) => a + s.estimatedMinutes, 0) - m.estimatedTimeMinutes;

const rnd = mulberry32(SEED); const shuffled = [...meals]; for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const random10 = shuffled.slice(0, 10);
const top3 = [...meals].sort((a, b) => saving(b) - saving(a)).slice(0, 3);

const lines: string[] = [`# D-WS9-240 item 6 — hand-check material`, ``, `km30- meals in the DB: ${meals.length} · seed ${SEED} → random 10 · top 3 by claimed saving (all-steps serial − derived)`, ``];
function dump(m: M, label: string): void {
  const dishes = toDishes(m);
  const sched = scheduleCookingSequence(dishes);
  const offset = new Map(sched.steps.map((s) => [`${s.dishId}#${s.originalStepIndex}`, s.startOffsetMinutes]));
  lines.push(`## ${label} · ${m.title}`, `meal \`${m.id}\` · ${m.dishFamilyKey} · stored ${m.estimatedTimeMinutes}/${m.activeTimeMinutes} · ${m.difficulty} · ${m.cuisineType} · saving ${saving(m)} (all-steps serial ${saving(m) + m.estimatedTimeMinutes})`, `> ${m.description}`, ``);
  for (const l of m.dishLinks) {
    lines.push(`### ${l.roleLabel} · ${l.dish.title}`, `ingredients: ${l.dish.dishIngredients.map((i) => `${i.quantity} ${i.unit} ${i.ingredient.canonicalName}`).join("; ")}`, ``, `| # | phase | min | path | tag | start | text |`, `|---|---|---|---|---|---|---|`);
    for (const s of steps.filter((x) => x.ownerId === l.dishId)) lines.push(`| ${s.stepIndex} | ${s.phaseType}${s.isTimingSensitive ? "(ts)" : ""} | ${s.estimatedMinutes} | ${s.pathKey ?? ""} | ${s.parallelGroup ?? "·"} | ${offset.get(`${l.dishId}#${s.stepIndex}`) ?? "?"} | ${s.stepTextTranslated.replace(/\|/g, "/").slice(0, 150)} |`);
    lines.push(``);
  }
  if (sched.ignoredTags.length) lines.push(`ignoredTags: ${JSON.stringify(sched.ignoredTags)}`, ``);
  lines.push(`**Verdict:** _pending_`, ``);
}
lines.push(`# (a) seeded random 10`, ``); random10.forEach((m, i) => dump(m, `R${i + 1}`));
lines.push(`# (b) top 3 by claimed saving`, ``); top3.forEach((m, i) => dump(m, `S${i + 1}${random10.includes(m) ? " (also in the random 10)" : ""}`));
writeFileSync(`${OUT}/handcheck.md`, lines.join("\n"));
console.log(`wrote ${OUT}/handcheck.md · random10: ${random10.map((m) => m.dishFamilyKey!.slice(5, 11)).join(",")} · top3 by saving: ${top3.map((m) => `${m.dishFamilyKey!.slice(5, 11)}(${saving(m)})`).join(",")}`);
