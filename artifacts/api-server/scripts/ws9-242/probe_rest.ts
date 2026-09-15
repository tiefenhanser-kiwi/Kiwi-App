// read-only: the rest-only cooking-class components + the ≤2-min-cook cooking-class components + the 41 craft
import { Prisma, PrismaClient } from "@prisma/client";
import { classifyEffort, type StepPhaseName } from "../../src/lib/effortClass";
const p = new PrismaClient();
const dishes = (await p.dish.findMany({ where: { componentRegistry: { not: Prisma.DbNull } }, select: { id: true, title: true, componentRegistry: true } })).filter((d) => Array.isArray(d.componentRegistry));
const steps = await p.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: dishes.map((d) => d.id) }, pathKey: "scratch" }, select: { ownerId: true, stepIndex: true, phaseType: true, estimatedMinutes: true, componentKey: true, stepTextRaw: true }, orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }] });
const by = new Map<string, typeof steps>(); for (const s of steps) by.set(s.ownerId, [...(by.get(s.ownerId) ?? []), s]);
const restOnly: string[] = [], shortCook: string[] = [], craft: string[] = [];
for (const d of dishes) for (const e of d.componentRegistry as { key: string; label?: string }[]) {
  const sc = (by.get(d.id) ?? []).filter((s) => s.componentKey === e.key); if (!sc.length) continue;
  const r = classifyEffort(e, sc.map((s) => ({ phaseType: s.phaseType as StepPhaseName, estimatedMinutes: s.estimatedMinutes, text: s.stepTextRaw })));
  const line = `"${d.title.slice(0, 34)}" ${e.key}/${e.label ?? ""}: ${sc.map((s) => `[${s.phaseType} ${s.estimatedMinutes}m] ${s.stepTextRaw.slice(0, 70)}`).join(" | ")}`;
  if (r.effortClass === "cooking" && r.cookPhases.every((x) => x === "rest")) restOnly.push(line);
  if (r.effortClass === "cooking" && sc.filter((s) => s.phaseType !== "prep" && s.phaseType !== "assemble").reduce((a, s) => a + s.estimatedMinutes, 0) <= 2) shortCook.push(line);
  if (r.effortClass === "craft") craft.push(`"${d.title.slice(0, 40)}" ${e.key}/${e.label ?? ""} [${r.craftBy.join("+")}]`);
}
console.log(`REST-ONLY cooking (${restOnly.length}):`); for (const l of restOnly) console.log("  " + l);
console.log(`\nCOOKING with ≤2 non-prep minutes (${shortCook.length}):`); for (const l of shortCook) console.log("  " + l);
console.log(`\nCRAFT (${craft.length}):`); for (const l of craft) console.log("  " + l);
await p.$disconnect();
