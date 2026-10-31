// CAT-QUICK-1 — write accepted quick meals from a generate.ts run, through the same write path
// runStoreFill uses (collectMealMentions → resolveIngredients → materializeMeal with
// STORE_FILL_TARGET, one transaction per meal; materializeMeal stamps allergens and timing).
// Dev only; dry unless --apply. Per meal: the stamped total must equal generate.ts's prediction
// and be ≤30, else the meal is deleted again in its own transaction and reported. A concept that
// replaces a km30 meal archives that meal once its rebuild stamps ≤30 (Hans's rule).
//
//   node --env-file=.env --import tsx scripts/cat-quick-1/write.ts --label test10 [--ns 1,14] [--apply]
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { collectMealMentions, materializeMeal } from "../../src/lib/mealMaterialize";
import { resolveIngredients } from "../../src/lib/ingredientResolve";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { STORE_FILL_TARGET } from "../../src/lib/storeFill";
import { archiveMeals } from "./archive";
import { accepted, BUDGET, OUT, type GenRecord } from "./generate";
import { TARGETS } from "./targets";

export interface Written { n: number; key: string; label: string; mealId: string; title: string; stamped: number; active: number | null; predicted: number | null; archivedKm30?: string }

async function deleteMeal(prisma: PrismaClient, mealId: string) {
  await prisma.$transaction(async (tx) => {
    const dishIds = (await tx.mealDishLink.findMany({ where: { mealId }, select: { dishId: true } })).map((l) => l.dishId);
    await tx.recipeInstructionStep.deleteMany({ where: { ownerType: "dish", ownerId: { in: dishIds } } });
    await tx.dishIngredient.deleteMany({ where: { dishId: { in: dishIds } } });
    await tx.mealDishLink.deleteMany({ where: { mealId } });
    await tx.dish.deleteMany({ where: { id: { in: dishIds } } });
    await tx.meal.delete({ where: { id: mealId } });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const label = arg("--label");
  if (!label) throw new Error("--label <generate label>");
  const apply = argv.includes("--apply");
  const only = arg("--ns")?.split(",").map(Number);
  const { host, mode } = assertScriptDatabase("cat-quick-1/write");
  if (mode !== "dev") throw new Error("dev only");

  const recs = (JSON.parse(readFileSync(join(OUT, label, "gen.json"), "utf8")) as GenRecord[])
    .filter((r) => (only ? only.includes(r.n) : accepted(r)));
  const ledgerPath = join(OUT, "written.json");
  const ledger: Written[] = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
  const prisma = new PrismaClient();
  console.log(`database: ${host} (${mode}) · ${label}: ${recs.length} meals to write · ${apply ? "APPLY" : "dry run"}`);

  for (const r of recs) {
    const t = TARGETS.find((x) => x.n === r.n)!;
    if (await prisma.meal.findFirst({ where: { dishFamilyKey: r.key }, select: { id: true } })) { console.log(`  #${r.n} already written (${r.key}) — skipped`); continue; }
    const payload = { ...r.payload, tags: [...new Set([...(r.payload.tags ?? []), ...(t.tags ?? [])])] };
    if (!apply) { console.log(`  #${r.n} would write "${payload.title}" · predicted ${r.predicted.total} · tags ${payload.tags.join(",")}`); continue; }
    const map = await resolveIngredients(prisma, collectMealMentions(payload));
    const { mealId } = await prisma.$transaction((tx) => materializeMeal(tx, "", payload, map, STORE_FILL_TARGET), { timeout: 60_000 });
    const m = await prisma.meal.findUniqueOrThrow({ where: { id: mealId }, select: { estimatedTimeMinutes: true, activeTimeMinutes: true } });
    if (m.estimatedTimeMinutes !== r.predicted.total || m.estimatedTimeMinutes > BUDGET.totalMinutes) {
      await deleteMeal(prisma, mealId);
      console.log(`  🔴 #${r.n} stamped ${m.estimatedTimeMinutes} ≠ predicted ${r.predicted.total} (or over budget) — deleted again`);
      continue;
    }
    let archivedKm30: string | undefined;
    if (t.replacesKm30) {
      const old = await prisma.meal.findFirst({ where: { id: { startsWith: t.replacesKm30 }, dishFamilyKey: { startsWith: "km30-" }, isArchived: false }, select: { id: true } });
      if (old) { await archiveMeals(prisma, [old.id], `CAT-QUICK-1: replaced by ${r.key} (${mealId}), stamped ${m.estimatedTimeMinutes}`, true); archivedKm30 = old.id; }
    }
    const w: Written = { n: r.n, key: r.key, label, mealId, title: payload.title, stamped: m.estimatedTimeMinutes, active: m.activeTimeMinutes, predicted: r.predicted.total, ...(archivedKm30 ? { archivedKm30 } : {}) };
    ledger.push(w);
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));
    console.log(`  ✅ #${r.n} ${mealId.slice(0, 8)} stamped ${m.estimatedTimeMinutes} (${m.activeTimeMinutes} hands-on) "${payload.title}"${archivedKm30 ? ` · archived km30 ${archivedKm30.slice(0, 8)}` : ""}`);
  }
  await prisma.$disconnect();
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("cat-quick-1/write.ts")) main().catch((e) => { console.error(e); process.exit(1); });
