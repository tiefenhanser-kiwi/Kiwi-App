// [prepcook] B2 Part B — the vessel count, from the SHIPPED engine.
//
// READ-ONLY, no AI. `components.ts` measured what a derivation COULD do from a
// probe; this measures what `buildStepPlan` now actually emits, so the before
// and after are the same code path rather than a model and its subject.
//
// A VESSEL is one container the cook ends up with:
//   • a COMPONENT step is one vessel per dish, whatever its member count —
//     that is the entire point of a named bowl;
//   • a BLEND or per-dish SAUCE step is one vessel per dish (a mixture);
//   • any other step is one vessel per (ingredient, dish) portion.
// A DEMOTED step is no vessel at all: it is render-omitted and never made.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/vessels.ts \
//     --plans b4aa6fee,… [--sequences]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { loadPrepWeekInput } from "../../src/lib/prepWeekAggregation";
import { buildPrepCombineInput } from "../../src/lib/prepCombineAdapter";
import { combinePrep } from "../../src/lib/prepCombineEngine";
import { buildStepPlan, type PlannedStep } from "../../src/lib/prepWeekAssembly";

const prisma = new PrismaClient();
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
  throw new Error("REFUSING: not the dev branch");
}
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const HAS = (n: string) => process.argv.includes(`--${n}`);
const PREFIXES = arg("plans").split(",").map((s) => s.trim()).filter(Boolean);

/** Vessels a kept step produces. */
function vesselsOf(st: PlannedStep): number {
  if (st.demoted) return 0;
  if (st.bowlName) return 1; // one named bowl, however many members
  if (st.isBlend || st.stepKey.startsWith("sauces_marinades#dish#")) {
    return new Set(st.components.flatMap((c) => c.measures.map((m) => m.forDish))).size;
  }
  return st.components.reduce(
    (n, c) => n + new Set(c.measures.map((m) => m.forDish)).size,
    0,
  );
}

async function main() {
  const rows: {
    plan: string; meals: number; steps: number; kept: number; demoted: number;
    vessels: number; bowls: number; cookDay: number;
  }[] = [];
  const demotedTitles: string[] = [];
  const sequences: string[] = [];
  const allBowls: string[] = [];

  for (const prefix of PREFIXES) {
    const found = await prisma.mealPlanInstance.findMany({
      where: { id: { startsWith: prefix } },
      select: { id: true, userId: true },
    });
    if (found.length !== 1) { console.error(`${prefix}: ${found.length} matches, skipped`); continue; }
    const { input, cookDays } = await loadPrepWeekInput({
      planId: found[0].id, userId: found[0].userId, prisma,
    });
    const sp = buildStepPlan(
      combinePrep(buildPrepCombineInput(input)),
      input.planName,
      new Map(),
      cookDays.lagByMealId,
    );
    const kept = sp.steps.filter((s) => !s.demoted);
    rows.push({
      plan: found[0].id.slice(0, 8),
      meals: input.meals.length,
      steps: sp.steps.length,
      kept: kept.length,
      demoted: sp.steps.length - kept.length,
      vessels: sp.steps.reduce((n, s) => n + vesselsOf(s), 0),
      bowls: kept.filter((s) => s.bowlName).length,
      cookDay: kept.filter((s) => s.cookDaySentence).length,
    });
    for (const s of kept) if (s.bowlName) allBowls.push(s.bowlName);

    // D-WS9-299 asks for every demoted title on b4aa6fee specifically.
    if (found[0].id.startsWith("b4aa6fee")) {
      for (const s of sp.steps.filter((x) => x.demoted)) {
        demotedTitles.push(
          `  ${(s.bowlName ?? s.components.map((c) => c.ingredientName).join(" + ")).slice(0, 52).padEnd(53)} ${s.phase.padEnd(17)} ${s.demoted!.reason}`,
        );
      }
    }

    if (HAS("sequences")) {
      for (const meal of input.meals) {
        if (!/Carne Asada Tacos|Teriyaki Salmon/i.test(meal.mealName)) continue;
        const dishIds = new Set(meal.dishes.map((d) => d.dishId));
        const mine = sp.steps.filter((s) =>
          s.components.some((c) => c.measures.some((m) => meal.dishes.some((d) => d.dishName === m.forDish))),
        );
        sequences.push(`── ${meal.mealName} ──`);
        for (const s of mine) {
          const head = s.bowlName ?? (s.cookDaySentence ? "(cook day)" : "(its own container)");
          sequences.push(`  ${head}${s.demoted ? `   [DEMOTED — ${s.demoted.reason}]` : ""}`);
          if (s.cookDaySentence) sequences.push(`      ${s.cookDaySentence}`);
          for (const c of s.components) {
            for (const m of c.measures) {
              if (!meal.dishes.some((d) => d.dishName === m.forDish)) continue;
              sequences.push(
                `      ${m.amount} ${c.ingredientName}${m.preparationNote ? `, ${m.preparationNote}` : ""}` +
                  `${m.fromSource ? `  [from ${m.fromSource}]` : ""}  ·  ${s.phase}`,
              );
            }
          }
        }
        sequences.push("");
        void dishIds;
      }
    }
  }

  const L: string[] = [];
  L.push(`D-WS9-296 / D-WS9-299 — the SHIPPED engine, over ${rows.length} plans`);
  L.push("");
  L.push("   plan      meals  steps  kept  demoted  vessels  bowls  cook-day");
  for (const r of rows) {
    L.push(
      `   ${r.plan}  ${String(r.meals).padStart(5)}  ${String(r.steps).padStart(5)}  ${String(r.kept).padStart(4)}  ${String(r.demoted).padStart(7)}  ${String(r.vessels).padStart(7)}  ${String(r.bowls).padStart(5)}  ${String(r.cookDay).padStart(8)}`,
    );
  }
  const sum = (k: keyof (typeof rows)[0]) => rows.reduce((n, r) => n + (r[k] as number), 0);
  L.push(
    `   TOTAL            ${String(sum("steps")).padStart(5)}  ${String(sum("kept")).padStart(4)}  ${String(sum("demoted")).padStart(7)}  ${String(sum("vessels")).padStart(7)}  ${String(sum("bowls")).padStart(5)}  ${String(sum("cookDay")).padStart(8)}`,
  );
  if (demotedTitles.length > 0) {
    L.push("");
    L.push("── D-WS9-299 — every demoted step on b4aa6fee ─────────────────────");
    L.push(...demotedTitles);
  }
  L.push("");
  L.push(`── BOWLS (${new Set(allBowls).size} distinct) ────────────────────────────────`);
  for (const b of [...new Set(allBowls)].slice(0, 30)) L.push(`  ${b}`);
  if (sequences.length > 0) { L.push(""); L.push(...sequences); }

  const text = L.join("\n");
  writeFileSync(join(OUT, "vessels.txt"), text);
  console.log(text);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
