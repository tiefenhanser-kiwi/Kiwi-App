// TRIAGE-0 — BUG-344, read-only (dev only). For single-dish public meals:
// footer at step 1 = serial sum of the dish's non-bought step minutes (what
// cook-session shows when it does not sequence: stepTiming.ts remainingMinutes);
// card = Meal.estimatedTimeMinutes (scheduler wall clock). Prints a fixed
// 10-meal sample (ordered by md5(id), so it is reproducible) plus the
// population distribution.
// Run from artifacts/api-server: node --env-file=.env scripts/_scratch/triage-0/probe344.mjs
import { PrismaClient } from "@prisma/client";

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const p = new PrismaClient();

const rows = await p.$queryRawUnsafe(`
  WITH single AS (
    SELECT l."mealId", MIN(l."dishId") AS "dishId"
    FROM meal_dish_links l
    GROUP BY l."mealId" HAVING COUNT(DISTINCT l."dishId") = 1
  ), mealsteps AS (
    SELECT "ownerId" AS "mealId", COUNT(*) AS n FROM recipe_instruction_steps
    WHERE "ownerType" = 'meal' GROUP BY "ownerId"
  )
  SELECT m.id, m.title, m."estimatedTimeMinutes" AS card,
         SUM(s."estimatedMinutes") FILTER (WHERE s."pathKey" IS DISTINCT FROM 'bought')::int AS footer,
         COUNT(*) FILTER (WHERE s."pathKey" IS DISTINCT FROM 'bought')::int AS steps,
         COUNT(*) FILTER (WHERE s."parallelGroup" IS NOT NULL AND s."pathKey" IS DISTINCT FROM 'bought')::int AS tagged
  FROM meals m
  JOIN single sg ON sg."mealId" = m.id
  JOIN recipe_instruction_steps s ON s."ownerType" = 'dish' AND s."ownerId" = sg."dishId"
  LEFT JOIN mealsteps ms ON ms."mealId" = m.id
  WHERE m."isPublic" = true AND m."isArchived" = false AND ms."mealId" IS NULL
  GROUP BY m.id, m.title, m."estimatedTimeMinutes"
  ORDER BY md5(m.id)
`);

const fmt = (r) => {
  const over = r.footer - r.card;
  return `${String(r.card).padStart(4)} card | ${String(r.footer).padStart(4)} footer | +${over} min (${r.card ? Math.round((100 * over) / r.card) : "-"}%) | ${r.steps} steps, ${r.tagged} tagged | ${r.title.slice(0, 60)} | ${r.id}`;
};
console.log("== sample of 10 (md5 order) ==");
for (const r of rows.slice(0, 10)) console.log(fmt(r));

const overs = rows.map((r) => r.footer - r.card);
const pct = rows.filter((r) => r.card > 0).map((r) => (r.footer - r.card) / r.card).sort((a, b) => a - b);
const sorted = [...overs].sort((a, b) => a - b);
const q = (a, f) => a[Math.floor(f * (a.length - 1))];
console.log("== population: single-dish public meals, dish-owned steps ==");
console.log(`n=${rows.length} overstated=${overs.filter((o) => o > 0).length} equal=${overs.filter((o) => o === 0).length} under=${overs.filter((o) => o < 0).length}`);
console.log(`minutes over: median ${q(sorted, 0.5)} p75 ${q(sorted, 0.75)} p90 ${q(sorted, 0.9)} max ${sorted.at(-1)}`);
console.log(`percent over: median ${Math.round(100 * q(pct, 0.5))}% p75 ${Math.round(100 * q(pct, 0.75))}% p90 ${Math.round(100 * q(pct, 0.9))}%`);
console.log(`>=15 min over: ${overs.filter((o) => o >= 15).length} · >=30 min over: ${overs.filter((o) => o >= 30).length}`);
await p.$disconnect();
