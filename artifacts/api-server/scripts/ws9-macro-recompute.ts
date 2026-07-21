// D-WS9-050 P4 — grounded macro recompute for the 44 catalog (isPublic) meals.
// DRY-RUN by default (no DB writes); --apply writes Dish.*PerServing AND rolls up
// Meal.*PerServing in lock-step via recomputeAndPersistMealMacros. SKIPS the 157
// private wizard meals. Reuses the production estimator (estimateDishMacros, now
// ref-fed) and the persisted-dish resolver (resolveEffectiveIngredients) — this
// is the SAME grounded path P1 wired, run as a catalog sweep.
//
// ⚠️ The estimator body comes from the SEEDED prompt (runAICall reads the DB), so
// the D-WS9-051 basis instruction only takes effect AFTER the prompt is re-seeded.
// Run this AFTER ratifying + seeding the new prompt for the basis-corrected CSV.
//
// CSV per meal: current vs recomputed macros + delta, grounded%, sanity flags,
// and a basis-class tag so the legume/grain rows can be inspected (the D-WS9-051
// verification gate).
//
// Run (from artifacts/api-server):
//   DRY-RUN: node --env-file=.env --import tsx scripts/ws9-macro-recompute.ts [--limit N]
//   APPLY:   node --env-file=.env --import tsx scripts/ws9-macro-recompute.ts --apply

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { estimateDishMacros } from "../src/lib/dishMacros";
import { recomputeAndPersistMealMacros } from "../src/lib/mealMacros";
import { resolveEffectiveIngredients } from "../src/lib/overrideResolver";
import { sanityMacroFlags } from "../src/lib/macroQuality";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
// D-WS9-053 §5C.1 — force-skip the AI conversion write-back even under --apply.
// The ratified median baseline was computed dry-run (skipConversionWriteback:
// true). Applying the SAME numbers faithfully requires the same path — otherwise
// --apply's write-back would ground volume/count misses mid-run (order-dependent)
// and mutate shared conversionRef data as a side effect of a MACRO recompute.
const NO_WRITEBACK = process.argv.includes("--no-writeback");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();
// D-WS9-053 §5A — N-draw median. The estimator runs at temp 0 (its default), so
// draws differ only by residual model non-determinism; the median across N draws
// rejects an outlier draw. Default 3; --draws N to override (N=1 = single draw).
const DRAWS = (() => {
  const i = process.argv.indexOf("--draws");
  const n = i >= 0 ? Number(process.argv[i + 1]) : 3;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
})();

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
// runAICall writes an LLMCallLog row FK'd to User, so the estimator needs a real
// userId. We attribute the recompute's AI calls to an existing user (log-only
// side effect; no user data is touched).
let RECOMPUTE_USER = "";
const BASIS_RE = /chickpea|bean|lentil|\brice\b|quinoa|pasta|oat|noodle|tortilla|flatbread|bread|dough/i;

const DISH_INCLUDE = {
  dishLinks: {
    orderBy: { positionIndex: "asc" as const },
    include: {
      dish: {
        include: { dishIngredients: { orderBy: { positionIndex: "asc" as const }, include: { ingredient: true } } },
      },
    },
  },
} as const;

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const firstUser = await prisma.user.findFirst({ select: { id: true } });
    if (!firstUser) throw new Error("no user row to attribute recompute AI calls to");
    RECOMPUTE_USER = firstUser.id;
    const meals = await prisma.meal.findMany({ where: { isPublic: true }, include: DISH_INCLUDE });
    const scoped = meals.slice(0, LIMIT);
    console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — ${scoped.length}/${meals.length} catalog meals (isPublic), temp 0, N=${DRAWS}-draw median. Wizard meals skipped.\n`);

    const rows: string[] = [
      ["mealId", "title", "serv", "curCal", "curP", "curC", "curF", "newCal", "newP", "newC", "newF", "dCal", "grounded%", "basisTag", "sanityFlags"].join(","),
    ];
    let touched = 0;
    for (const meal of scoped) {
      let cal = 0, p = 0, c = 0, f = 0, gTot = 0, gGround = 0, anyFail = false;
      const flags = new Set<string>();
      const perDish: Array<{ dishId: string; m: { calories: number; proteinG: number; carbsG: number; fatG: number }; groundedPct: number }> = [];
      let basis = "";
      for (const dl of meal.dishLinks) {
        const dish = dl.dish;
        const eff = resolveEffectiveIngredients({ ingredientOverrides: null, recipeOverrideJson: null }, dish);
        for (const e of eff) if (BASIS_RE.test(e.name)) basis = "LEGUME/GRAIN";
        // N draws → per-field median at the DISH level (so Dish.*PerServing and
        // the meal rollup are internally consistent: meal = sum of dish medians).
        const draws: Array<{ perServing: { calories: number; proteinG: number; carbsG: number; fatG: number }; grounding: { counted: number; grounded: number; ratio: number }; sanityFlags: string[] }> = [];
        let dishFailed = false;
        for (let d = 0; d < DRAWS; d++) {
          const res = await estimateDishMacros({
            prisma, userId: RECOMPUTE_USER, dishTitle: dish.title, servings: dish.servingsDefault, ingredients: eff,
            // Dry-run must not mutate Ingredient.conversionRef via the AI grams
            // fallback; only --apply (a real backfill) allows the write-back —
            // unless --no-writeback is set (§5C.1: apply the ratified numbers
            // faithfully, no conversion side effects).
            skipConversionWriteback: !APPLY || NO_WRITEBACK,
          });
          if (res.status === "failed") { dishFailed = true; break; }
          draws.push(res);
        }
        if (dishFailed || draws.length === 0) { anyFail = true; flags.add(`estimate_failed:${dish.title}`); continue; }
        const m = {
          calories: median(draws.map((r) => r.perServing.calories)),
          proteinG: median(draws.map((r) => r.perServing.proteinG)),
          carbsG: median(draws.map((r) => r.perServing.carbsG)),
          fatG: median(draws.map((r) => r.perServing.fatG)),
        };
        // grounding is deterministic (ref-based) — identical across draws.
        perDish.push({ dishId: dish.id, m, groundedPct: Math.round(draws[0].grounding.ratio * 100) });
        cal += m.calories; p += m.proteinG; c += m.carbsG; f += m.fatG;
        gTot += draws[0].grounding.counted; gGround += draws[0].grounding.grounded;
        // record only dish flags that fire in a MAJORITY of draws (consistent, not noise)
        const flagCount = new Map<string, number>();
        for (const r of draws) for (const fl of new Set(r.sanityFlags)) flagCount.set(fl, (flagCount.get(fl) ?? 0) + 1);
        for (const [fl, n] of flagCount) if (n * 2 > draws.length) flags.add(fl);
      }
      const groundedPct = gTot === 0 ? 100 : Math.round((100 * gGround) / gTot);
      const round1 = (x: number) => Math.round(x * 10) / 10;
      const newCal = Math.round(cal), newP = round1(p), newC = round1(c), newF = round1(f);
      // meal-level sanity too
      for (const fl of sanityMacroFlags({ calories: newCal, proteinG: newP, carbsG: newC, fatG: newF })) flags.add(`MEAL:${fl}`);
      rows.push([
        meal.id, meal.title, meal.servingsDefault,
        meal.caloriesPerServing, meal.proteinGPerServing, meal.carbsGPerServing, meal.fatGPerServing,
        anyFail ? "" : newCal, anyFail ? "" : newP, anyFail ? "" : newC, anyFail ? "" : newF,
        anyFail ? "" : newCal - meal.caloriesPerServing, groundedPct, basis, [...flags].join("; "),
      ].map(csvCell).join(","));
      console.log(`  ${basis ? "⚑" : " "} "${meal.title.slice(0, 40).padEnd(40)}" cur ${meal.caloriesPerServing}kcal → new ${anyFail ? "FAIL" : newCal + "kcal"}  grounded ${groundedPct}%${flags.size ? "  ⚠" + [...flags][0] : ""}`);

      if (APPLY && !anyFail) {
        await prisma.$transaction(async (tx) => {
          for (const pd of perDish) {
            await tx.dish.update({ where: { id: pd.dishId }, data: {
              caloriesPerServing: Math.round(pd.m.calories), proteinGPerServing: round1(pd.m.proteinG),
              carbsGPerServing: round1(pd.m.carbsG), fatGPerServing: round1(pd.m.fatG),
              macroGroundedPct: pd.groundedPct, // D-WS9-050 Phase 2 write-time stamp
            } });
          }
          await recomputeAndPersistMealMacros(tx, meal.id);
        });
        touched++;
      }
    }

    const dir = join(HERE, "output");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `ws9-macro-recompute-${APPLY ? "applied" : "dryrun"}-${scoped.length}.csv`);
    writeFileSync(path, rows.join("\n"));
    console.log(`\n${APPLY ? `APPLIED ${touched} meals.` : "DRY-RUN — no DB writes."}  CSV: ${path}`);
    console.log("⚑ = legume/grain (D-WS9-051 basis gate — inspect these). Re-seed the new prompt for basis-corrected numbers.");
  } finally {
    await prisma.$disconnect();
  }
}

void main();
