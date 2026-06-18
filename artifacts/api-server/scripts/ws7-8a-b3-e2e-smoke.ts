// WS7-8a B3 — end-to-end prep-completion smoke (real Anthropic + real Neon).
//
// In-process HTTP mounting BOTH the cooking router (prep-week generate +
// completion check/uncheck/read) and the plans router (GET/PATCH /plans/:id),
// against the real DB + real narration AI. Proves the full B3 loop with a
// HAND-COMPUTED known answer:
//   1. Generate a prep week → assert the expected stable stepKeys are present.
//   2. Check a subset of steps spanning MULTIPLE meals.
//   3. GET completions + GET /plans/:id → assert per-meal rollup + plan-level
//      prepStatus match the hand-computed answer.
//   4. Manual override: PATCH prepped pins; PATCH not_prepped returns to derived.
//   5. Add a meal + bump revisionId, seed a bogus completion, regenerate →
//      assert orphan pruned, still-valid completions survive, recompute correct.
//
// §27: this is a SINGLE seeded run against one fixture, not a statistical claim.
// It proves the wiring end-to-end; it does not characterise AI variability.
//
// Fixture (stable IDs; teardown at start AND end):
//   Meal1 "Tacos":    onion (diced, Produce)  + ground beef (Protein)
//   Meal2 "Stir Fry": onion (diced, Produce)  + chicken     (Protein)
//   Meal3 "Carrot Soup": carrot (diced, Produce)  — ADDED on regenerate
// Shared onion → ONE produce step → [Meal1, Meal2]. Each protein → its own step.
// Predicted stepKeys (code-owned `${phase}#${ingredientId}`):
//   produce#<onion>   → [Meal1, Meal2]
//   proteins#<beef>   → [Meal1]
//   proteins#<chicken>→ [Meal2]
//   produce#<carrot>  → [Meal3]   (after regenerate)
//
// Run: pnpm --filter @workspace/api-server exec tsx scripts/ws7-8a-b3-e2e-smoke.ts
// Prereq: prisma:seed (AIPrompts incl. prep.narrate_steps) + prisma:seed:dev.
//         ANTHROPIC_API_KEY set.

import { PrismaClient } from "@prisma/client";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../src/lib/auth";
import { createCookingRouter } from "../src/routes/cooking";
import { createPlansRouter } from "../src/routes/plans";
import type { PrepWeekResult } from "../src/lib/ai/schemas/prepWeek";

const prisma = new PrismaClient();
const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";

const TEMPLATE_ID = "00000000-b3e2-4111-8111-000000000001";
const PLAN_ID = "00000000-b3e2-4111-8111-000000000002";

const MEAL_1 = "00000000-b3e2-4222-8222-000000000001";
const MEAL_2 = "00000000-b3e2-4222-8222-000000000002";
const MEAL_3 = "00000000-b3e2-4222-8222-000000000003";
const DISH_1 = "00000000-b3e2-4333-8333-000000000001";
const DISH_2 = "00000000-b3e2-4333-8333-000000000002";
const DISH_3 = "00000000-b3e2-4333-8333-000000000003";

const ING = {
  onion: "00000000-b3e2-4444-8444-000000000001",
  beef: "00000000-b3e2-4444-8444-000000000002",
  chicken: "00000000-b3e2-4444-8444-000000000003",
  carrot: "00000000-b3e2-4444-8444-000000000004",
};
const ING_PREFIX = "smoke_b3_";

// Predicted stable stepKeys.
const KEY_ONION = `produce#${ING.onion}`;
const KEY_BEEF = `proteins#${ING.beef}`;
const KEY_CHICKEN = `proteins#${ING.chicken}`;
const KEY_CARROT = `produce#${ING.carrot}`;
const KEY_BOGUS = "produce#00000000-dead-4eee-8eee-000000000000";

const ALL_MEAL_IDS = [MEAL_1, MEAL_2, MEAL_3];
const ALL_DISH_IDS = [DISH_1, DISH_2, DISH_3];
const ALL_ING_IDS = Object.values(ING);

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`  ${cond ? "✔" : "✖"} ${label}${cond ? "" : `  →  ${JSON.stringify(detail)}`}`);
  if (!cond) failures += 1;
}

async function teardown() {
  await prisma.prepStepCompletion.deleteMany({ where: { planId: PLAN_ID } });
  await prisma.prepWeekStructure.deleteMany({ where: { planId: PLAN_ID } });
  await prisma.mealPlanInstance.deleteMany({ where: { id: PLAN_ID } });
  await prisma.mealPlanTemplate.deleteMany({ where: { id: TEMPLATE_ID } });
  await prisma.mealDishLink.deleteMany({ where: { mealId: { in: ALL_MEAL_IDS } } });
  await prisma.dishIngredient.deleteMany({ where: { dishId: { in: ALL_DISH_IDS } } });
  await prisma.meal.deleteMany({ where: { id: { in: ALL_MEAL_IDS } } });
  await prisma.dish.deleteMany({ where: { id: { in: ALL_DISH_IDS } } });
  await prisma.ingredient.deleteMany({ where: { id: { in: ALL_ING_IDS } } });
}

async function createFixture(userId: string) {
  await prisma.ingredient.createMany({
    data: [
      { id: ING.onion, canonicalName: `${ING_PREFIX}onion`, displayName: "yellow onion", category: "Produce", defaultUnit: "medium" },
      { id: ING.beef, canonicalName: `${ING_PREFIX}beef`, displayName: "ground beef", category: "Protein", defaultUnit: "lb" },
      { id: ING.chicken, canonicalName: `${ING_PREFIX}chicken`, displayName: "chicken thighs", category: "Protein", defaultUnit: "lb" },
      { id: ING.carrot, canonicalName: `${ING_PREFIX}carrot`, displayName: "carrot", category: "Produce", defaultUnit: "each" },
    ],
  });
  await prisma.dish.createMany({
    data: [
      { id: DISH_1, userId, title: "Beef Tacos", servingsDefault: 4 },
      { id: DISH_2, userId, title: "Chicken Stir Fry", servingsDefault: 4 },
      { id: DISH_3, userId, title: "Carrot Soup", servingsDefault: 4 },
    ],
  });
  await prisma.dishIngredient.createMany({
    data: [
      { dishId: DISH_1, ingredientId: ING.onion, quantity: 1, unit: "medium", preparationNote: "diced", positionIndex: 0 },
      { dishId: DISH_1, ingredientId: ING.beef, quantity: 1, unit: "lb", preparationNote: null, positionIndex: 1 },
      { dishId: DISH_2, ingredientId: ING.onion, quantity: 1, unit: "medium", preparationNote: "diced", positionIndex: 0 },
      { dishId: DISH_2, ingredientId: ING.chicken, quantity: 1, unit: "lb", preparationNote: "cubed", positionIndex: 1 },
      { dishId: DISH_3, ingredientId: ING.carrot, quantity: 3, unit: "each", preparationNote: "diced", positionIndex: 0 },
    ],
  });
  await prisma.meal.createMany({
    data: [
      { id: MEAL_1, userId, title: "Beef Tacos", servingsDefault: 4 },
      { id: MEAL_2, userId, title: "Chicken Stir Fry", servingsDefault: 4 },
      { id: MEAL_3, userId, title: "Carrot Soup", servingsDefault: 4 },
    ],
  });
  await prisma.mealDishLink.createMany({
    data: [
      { mealId: MEAL_1, dishId: DISH_1, positionIndex: 0, roleLabel: "main" },
      { mealId: MEAL_2, dishId: DISH_2, positionIndex: 0, roleLabel: "main" },
      { mealId: MEAL_3, dishId: DISH_3, positionIndex: 0, roleLabel: "main" },
    ],
  });
  await prisma.mealPlanTemplate.create({
    data: { id: TEMPLATE_ID, userId, title: "Smoke B3 week", defaultDaysCount: 3 },
  });
  // Plan starts with Meal1 + Meal2 only; Meal3 is added on regenerate.
  await prisma.mealPlanInstance.create({
    data: {
      id: PLAN_ID,
      userId,
      mealPlanTemplateId: TEMPLATE_ID,
      titleOverride: "Smoke B3 week",
      items: {
        create: [
          { mealId: MEAL_1, positionIndex: 0, assignedDayOfWeek: "Mon" },
          { mealId: MEAL_2, positionIndex: 1, assignedDayOfWeek: "Tue" },
        ],
      },
    },
  });
}

function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createCookingRouter());
  app.use("/api", createPlansRouter());
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) return reject(new Error("no bind"));
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

async function main() {
  console.log("WS7-8a B3 — end-to-end prep-completion smoke (real AI + Neon)\n");
  const user = await prisma.user.findUnique({ where: { email: DEV_USER_EMAIL }, select: { id: true } });
  if (!user) throw new Error(`dev user ${DEV_USER_EMAIL} not found — run prisma:seed:dev`);
  const userId = user.id;

  await teardown();
  await createFixture(userId);
  const server = await startServer();
  const token = signToken(userId);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    // ── 1. Generate the prep week ──────────────────────────────────────
    console.log("══ 1. generate prep week (real narration AI) ══");
    const genRes = await fetch(`${server.baseUrl}/plans/${PLAN_ID}/prep-week`, { method: "POST", headers: auth });
    const gen = (await genRes.json()) as PrepWeekResponseLite;
    check("POST prep-week 200", genRes.status === 200, { status: genRes.status, body: gen });
    const keys = stepKeysOf(gen.result);
    console.log("    generated stepKeys:", keys);
    check("structure carries produce#onion", keys.includes(KEY_ONION), keys);
    check("structure carries proteins#beef", keys.includes(KEY_BEEF), keys);
    check("structure carries proteins#chicken", keys.includes(KEY_CHICKEN), keys);
    check("onion step contributes to BOTH meals", mealsOfKey(gen.result, KEY_ONION).sort().join() === [MEAL_1, MEAL_2].sort().join(), mealsOfKey(gen.result, KEY_ONION));

    // ── 2. Check a subset spanning multiple meals: onion (M1+M2) + beef (M1) ──
    console.log("\n══ 2. check onion + beef (spans both meals) ══");
    await put(`${server.baseUrl}/plans/${PLAN_ID}/prep-week/completions`, auth, KEY_ONION);
    await put(`${server.baseUrl}/plans/${PLAN_ID}/prep-week/completions`, auth, KEY_BEEF);

    // ── 3. Read completions + plan detail; compare to hand-computed answer ──
    console.log("\n══ 3. derived per-meal + rollup vs known answer ══");
    // Hand-computed: M1 steps {onion,beef} both checked → prepped.
    //                M2 steps {onion,chicken}; chicken UNCHECKED → not prepped.
    //                rollup: 1 of 2 meals prepped → partial.
    const comp = await getJson(`${server.baseUrl}/plans/${PLAN_ID}/prep-week/completions`, token);
    console.log("    completions perMeal:", comp.perMeal, "prepStatus:", comp.prepStatus);
    check("M1 prepped (onion+beef checked)", comp.perMeal[MEAL_1] === true, comp.perMeal);
    check("M2 NOT prepped (chicken unchecked)", comp.perMeal[MEAL_2] === false, comp.perMeal);
    check("rollup = partial", comp.prepStatus === "partial", comp);
    check("prepStatusIsManual = false (derived)", comp.prepStatusIsManual === false, comp);

    const plan1 = await getJson(`${server.baseUrl}/plans/${PLAN_ID}`, token);
    const itemPrepped = Object.fromEntries(plan1.plan.items.map((i: PlanItem) => [i.mealId, i.isPrepped]));
    console.log("    GET /plans/:id item.isPrepped:", itemPrepped, "plan.prepStatus:", plan1.plan.prepStatus);
    check("plan-detail M1 isPrepped true", itemPrepped[MEAL_1] === true, itemPrepped);
    check("plan-detail M2 isPrepped false", itemPrepped[MEAL_2] === false, itemPrepped);
    check("plan-detail prepStatus partial", plan1.plan.prepStatus === "partial", plan1.plan.prepStatus);

    // ── 4. Manual override pins, then un-mark returns to derived ──────────
    console.log("\n══ 4. manual override (pin → un-mark) ══");
    await patch(`${server.baseUrl}/plans/${PLAN_ID}`, auth, { prepStatus: "prepped" });
    const pinned = await getJson(`${server.baseUrl}/plans/${PLAN_ID}`, token);
    check("manual 'Done' pins prepped despite incomplete checks", pinned.plan.prepStatus === "prepped" && pinned.plan.prepStatusIsManual === true, pinned.plan);
    await patch(`${server.baseUrl}/plans/${PLAN_ID}`, auth, { prepStatus: "not_prepped" });
    const unmarked = await getJson(`${server.baseUrl}/plans/${PLAN_ID}`, token);
    check("un-mark returns control to derived (partial)", unmarked.plan.prepStatus === "partial" && unmarked.plan.prepStatusIsManual === false, unmarked.plan);

    // ── 5. Add a meal + bump revision + seed orphan, then regenerate ──────
    console.log("\n══ 5. regenerate after adding a meal — prune + recompute ══");
    // Seed a bogus completion that the fresh assembly will NOT re-emit.
    await prisma.prepStepCompletion.create({ data: { planId: PLAN_ID, stepKey: KEY_BOGUS } });
    // Add Meal3 to the plan and bump revisionId so the cache goes stale.
    await prisma.mealPlanItem.create({ data: { mealPlanInstanceId: PLAN_ID, mealId: MEAL_3, positionIndex: 2, assignedDayOfWeek: "Wed" } });
    await prisma.mealPlanInstance.update({ where: { id: PLAN_ID }, data: { revisionId: { increment: 1 } } });

    const regenRes = await fetch(`${server.baseUrl}/plans/${PLAN_ID}/prep-week`, { method: "POST", headers: auth });
    const regen = (await regenRes.json()) as PrepWeekResponseLite;
    check("regenerate 200 + cacheHit=false", regenRes.status === 200 && regen.cacheHit === false, { status: regenRes.status, cacheHit: regen.cacheHit });
    const keys2 = stepKeysOf(regen.result);
    console.log("    regenerated stepKeys:", keys2);
    check("new structure carries produce#carrot (added meal)", keys2.includes(KEY_CARROT), keys2);

    const rows = await prisma.prepStepCompletion.findMany({ where: { planId: PLAN_ID }, select: { stepKey: true } });
    const survivingKeys = rows.map((r) => r.stepKey).sort();
    console.log("    surviving completion rows:", survivingKeys);
    check("orphan (bogus) was pruned", !survivingKeys.includes(KEY_BOGUS), survivingKeys);
    check("still-valid onion completion survived", survivingKeys.includes(KEY_ONION), survivingKeys);
    check("still-valid beef completion survived", survivingKeys.includes(KEY_BEEF), survivingKeys);

    const comp2 = await getJson(`${server.baseUrl}/plans/${PLAN_ID}/prep-week/completions`, token);
    console.log("    recomputed perMeal:", comp2.perMeal, "prepStatus:", comp2.prepStatus);
    // Hand-computed after add: M1 prepped (onion+beef), M2 not (chicken), M3 not
    // (carrot unchecked) → 1 of 3 prepped → partial.
    check("post-regen M1 prepped", comp2.perMeal[MEAL_1] === true, comp2.perMeal);
    check("post-regen M2 not prepped", comp2.perMeal[MEAL_2] === false, comp2.perMeal);
    check("post-regen M3 (new meal) not prepped", comp2.perMeal[MEAL_3] === false, comp2.perMeal);
    check("post-regen rollup = partial", comp2.prepStatus === "partial", comp2);

    console.log(`\n§27: single seeded run against one fixture — wiring proof, not a statistical claim.`);
    console.log(`\n${failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`}`);
  } finally {
    await server.close();
  }
}

// ── small helpers ─────────────────────────────────────────────────────
interface PrepWeekResponseLite { cacheHit: boolean; result: PrepWeekResult }
interface PlanItem { mealId: string; isPrepped: boolean }
function stepKeysOf(r: PrepWeekResult): string[] {
  return r.phases.flatMap((p) => p.steps.map((s) => s.stepKey));
}
function mealsOfKey(r: PrepWeekResult, key: string): string[] {
  for (const p of r.phases) for (const s of p.steps) if (s.stepKey === key) return s.contributesToMealIds;
  return [];
}
async function put(url: string, headers: Record<string, string>, stepKey: string) {
  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ stepKey }) });
  if (res.status !== 200) console.log(`    [warn] PUT ${stepKey} → ${res.status}`);
}
async function patch(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });
  if (res.status !== 200) console.log(`    [warn] PATCH → ${res.status}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getJson(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    await teardown().catch(() => {});
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
