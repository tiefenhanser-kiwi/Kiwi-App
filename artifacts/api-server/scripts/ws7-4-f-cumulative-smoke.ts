// WS7-4-F — Cumulative live smoke for the WS7-4 plan-mutation surface.
//
// Proves two cross-cutting invariants that unit tests (which mock) cannot:
//   1) macrosStale envelope flag — fires when (and only when) an uncached
//      dish is involved in the plan.
//   2) revisionId-bump rule (Ruling 8) — content/structural mutations bump,
//      name-only metadata edits do NOT.
//
// In-process HTTP (in keeping with ws7-4-b/c/d smoke convention). Real Neon,
// real Anthropic for the recalc step. Idempotent teardown.
//
// HARD asserts (per Phase 0 / Phase 1 rulings):
//   - Ruling 8 name-only PATCH: revisionId unchanged, macrosStale=false.
//   - servingsOverride PATCH on a cached item: macrosStale=false
//     (F-F-3 evidence — D-WS7-061).
//   - POST /items adding the manufactured uncached Meal_U: macrosStale=true
//     (the core hybrid-recalc proof).
//   - Every structural mutation bumps revisionId by exactly 1.
//   - Post-recalc round-trip: re-reading planNeedsMacroEstimation against
//     the same plan returns false (recalc cleared what the flag claimed).
//
// OBSERVE-AND-PRINT (data-dependent; §27 honest reporting):
//   - macrosStale value on every other mutation (date PATCH, day/slot/
//     mealId-swap/promote-override/DELETE-item).
//   - G2 direct-read of planNeedsMacroEstimation on plan-level mutations
//     whose envelope omits macrosStale (use-template, compost).
//
// Run:
//   pnpm --filter @workspace/api-server exec tsx scripts/ws7-4-f-cumulative-smoke.ts
//
// Prereq: prisma:seed (AIPrompts + Ingredients) AND prisma:seed:dev (Hans's
// user, dev meals with non-zero canonical macros, discovery templates).

import { Prisma, PrismaClient } from "@prisma/client";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../src/lib/auth";
import { createPlansRouter } from "../src/routes/plans";
import { planNeedsMacroEstimation } from "../src/lib/planMacros";

const prisma = new PrismaClient();
const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createPlansRouter());
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("smoke: server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

function assertEq<T>(label: string, actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(
      `[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  console.log(`[ok] ${label} = ${JSON.stringify(actual)}`);
}

function assertTrue(label: string, cond: boolean, detail = ""): void {
  if (!cond) {
    throw new Error(`[FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`[ok] ${label}`);
}

// Print an observed-but-not-asserted macrosStale value, tagged by source
// (envelope vs G2 direct-read).
type MacrosStaleEntry = {
  step: string;
  value: boolean;
  source: "envelope" | "direct-read (G2)";
};
const macrosStaleMap: MacrosStaleEntry[] = [];
function recordMacrosStale(
  step: string,
  value: boolean,
  source: MacrosStaleEntry["source"],
): void {
  macrosStaleMap.push({ step, value, source });
  console.log(`[observed] ${step}: macrosStale=${value} (${source})`);
}

// All ActivityEventType values the smoke may emit — used by idempotent teardown.
const F_SMOKE_EVENT_TYPES = [
  "plan_used_from_browse",
  "plan_name_edited",
  "plan_date_range_edited",
  "plan_status_changed",
  "plan_activated_this_week",
  "plan_meal_added",
  "plan_meal_composted",
  "plan_meal_changed",
  "plan_meal_assigned",
  "plan_meal_unassigned",
  "plan_meal_edited",
  "plan_recipe_changed",
  "plan_composted",
  "dish_macros_estimated",
  "plan_macros_recalculated",
] as const;

function dishHasStoredMacros(d: {
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
}): boolean {
  return (
    d.caloriesPerServing > 0 ||
    d.proteinGPerServing > 0 ||
    d.carbsGPerServing > 0 ||
    d.fatGPerServing > 0
  );
}

async function main(): Promise<number> {
  const harness = await spinUp();
  let createdPlanId: string | null = null;
  let priorActiveInstanceId: string | null = null;
  let mealU_id: string | null = null;
  let dishU_id: string | null = null;
  let dishU_ingredientRowId: string | null = null;
  let mealU_linkId: string | null = null;
  let promotedMealId: string | null = null;

  try {
    const user = await prisma.user.findUnique({
      where: { email: DEV_USER_EMAIL },
    });
    if (!user) throw new Error(`Dev user not found: ${DEV_USER_EMAIL}`);
    const token = signToken(user.id);
    const authHeader = { Authorization: `Bearer ${token}` };

    // WS7-6 (E) Block 1 REWORK — capture prior covering plan via date
    // range. Logged for parity; this smoke doesn't activate the new
    // plan with dates that cover now, so nothing needs restoration.
    const now = new Date();
    const priorActive = await prisma.mealPlanInstance.findFirst({
      where: {
        userId: user.id,
        isWizardDraft: false,
        startDate: { lte: now, not: null },
        endDate: { gte: now, not: null },
      },
      orderBy: { activatedAt: { sort: "desc", nulls: "last" } },
      select: { id: true },
    });
    priorActiveInstanceId = priorActive?.id ?? null;
    console.log(
      `[smoke] prior active instance: ${priorActiveInstanceId ?? "(none)"}`,
    );

    // ── SETUP: use-template against the first featured discovery template ──
    const listRes = await fetch(`${harness.baseUrl}/plans?filter=featured`, {
      headers: authHeader,
    });
    assertEq("setup: GET /plans?filter=featured status", listRes.status, 200);
    const listBody = (await listRes.json()) as {
      plans: Array<{ id: string; source: string }>;
    };
    const tmplRow = listBody.plans.find((p) => p.source === "template");
    if (!tmplRow) throw new Error("no template row in featured list");
    const templateId = tmplRow.id;
    console.log(`[smoke] using template: ${templateId}`);

    const useRes = await fetch(
      `${harness.baseUrl}/plans/use-template/${templateId}`,
      { method: "POST", headers: authHeader },
    );
    assertEq("setup: POST /plans/use-template status", useRes.status, 201);
    const useBody = (await useRes.json()) as {
      instance: { id: string; revisionId: number };
    };
    createdPlanId = useBody.instance.id;
    assertEq("setup: fresh plan revisionId = 1", useBody.instance.revisionId, 1);

    // G2 — direct-read predicate after use-template (envelope has no
    // macrosStale field for this path).
    const postUseTemplateStale = await planNeedsMacroEstimation({
      planId: createdPlanId,
    });
    recordMacrosStale(
      "setup: use-template (post)",
      postUseTemplateStale,
      "direct-read (G2)",
    );
    assertEq(
      "setup: predicate=false after use-template (template items all cached)",
      postUseTemplateStale,
      false,
    );

    // Snapshot the new plan's items for downstream targeting.
    const planGetRes = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}`,
      { headers: authHeader },
    );
    assertEq("setup: GET /plans/:id status", planGetRes.status, 200);
    const planGetBody = (await planGetRes.json()) as {
      plan: {
        items: Array<{ id: string; mealId: string; positionIndex: number }>;
      };
    };
    const planItems = planGetBody.plan.items;
    if (planItems.length < 3) {
      throw new Error(
        `template '${templateId}' yielded only ${planItems.length} items; smoke needs >=3`,
      );
    }
    // Anchor by positionIndex so the assignment is deterministic regardless of
    // canonical-sort (Sun-Sat) ordering.
    const sortedByPos = [...planItems].sort(
      (a, b) => a.positionIndex - b.positionIndex,
    );
    const itemC1 = sortedByPos[0]; // servings + recipeOverride + promote target
    let itemC2 = sortedByPos[1]; // assignedDay + slot + mealId-swap target
    const itemC3 = sortedByPos[2]; // unassign + delete
    console.log(
      `[smoke] items: C1=${itemC1.id} (meal=${itemC1.mealId}), C2=${itemC2.id} (meal=${itemC2.mealId}), C3=${itemC3.id} (meal=${itemC3.mealId})`,
    );

    // Cached swap target — a public meal != itemC2.mealId whose dishes all
    // have stored macros. The dev seed guarantees plenty.
    const swapCandidates = await prisma.meal.findMany({
      where: {
        isArchived: false,
        isPublic: true,
        id: { not: itemC2.mealId },
      },
      include: {
        dishLinks: {
          include: {
            dish: {
              select: {
                caloriesPerServing: true,
                proteinGPerServing: true,
                carbsGPerServing: true,
                fatGPerServing: true,
              },
            },
          },
        },
      },
      take: 20,
    });
    const swapTargetMeal = swapCandidates.find(
      (m) =>
        m.dishLinks.length > 0 &&
        m.dishLinks.every((l) => dishHasStoredMacros(l.dish)),
    );
    if (!swapTargetMeal) {
      throw new Error("no cached public meal available for the swap target");
    }
    console.log(`[smoke] swap target meal: ${swapTargetMeal.id}`);

    // Sample Ingredient for the override JSON + Dish_U ingredient row.
    const sampleIng = await prisma.ingredient.findFirst({
      orderBy: { canonicalName: "asc" },
      select: { id: true, canonicalName: true },
    });
    if (!sampleIng) throw new Error("need at least 1 Ingredient row");

    // ── Manufacture the uncached private Meal_U ────────────────────────────
    const dishU = await prisma.dish.create({
      data: {
        userId: user.id,
        title: "WS7-4-F uncached dish",
        servingsDefault: 4,
        // All four macros zero — this is what makes the predicate fire.
        caloriesPerServing: 0,
        proteinGPerServing: 0,
        carbsGPerServing: 0,
        fatGPerServing: 0,
      },
      select: { id: true },
    });
    dishU_id = dishU.id;
    const ing = await prisma.dishIngredient.create({
      data: {
        dishId: dishU_id,
        ingredientId: sampleIng.id,
        quantity: 1,
        unit: "cup",
        positionIndex: 0,
      },
      select: { id: true },
    });
    dishU_ingredientRowId = ing.id;
    const mealU = await prisma.meal.create({
      data: {
        userId: user.id,
        title: "WS7-4-F uncached meal",
        isPublic: false,
        servingsDefault: 4,
      },
      select: { id: true },
    });
    mealU_id = mealU.id;
    const link = await prisma.mealDishLink.create({
      data: { mealId: mealU_id, dishId: dishU_id, positionIndex: 0 },
      select: { id: true },
    });
    mealU_linkId = link.id;
    console.log(`[smoke] manufactured Meal_U=${mealU_id} Dish_U=${dishU_id}`);

    // ── PHASE 1 — cached-only state ────────────────────────────────────────

    // Step 1 — name-only PATCH (Ruling 8 carve-out)
    let revBefore = useBody.instance.revisionId;
    const step1 = await fetch(`${harness.baseUrl}/plans/${createdPlanId}`, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "WS7-4-F smoke" }),
    });
    assertEq("step 1: PATCH name-only status", step1.status, 200);
    const step1Body = (await step1.json()) as {
      instance: { revisionId: number };
      macrosStale: boolean;
    };
    assertEq(
      "step 1 (Ruling 8): name-only PATCH leaves revisionId unchanged",
      step1Body.instance.revisionId,
      revBefore,
    );
    assertEq(
      "step 1: macrosStale=false on cached-only plan (HARD)",
      step1Body.macrosStale,
      false,
    );
    recordMacrosStale("step 1: PATCH name-only", step1Body.macrosStale, "envelope");

    // Step 2 — date-range PATCH (bump; data-dependent macrosStale)
    revBefore = step1Body.instance.revisionId;
    const step2 = await fetch(`${harness.baseUrl}/plans/${createdPlanId}`, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: "2026-06-01",
        endDate: "2026-06-07",
      }),
    });
    assertEq("step 2: PATCH date-range status", step2.status, 200);
    const step2Body = (await step2.json()) as {
      instance: { revisionId: number };
      macrosStale: boolean;
    };
    assertEq(
      "step 2: date-range PATCH bumps revisionId by 1",
      step2Body.instance.revisionId,
      revBefore + 1,
    );
    recordMacrosStale("step 2: PATCH date-range", step2Body.macrosStale, "envelope");

    // Step 3 — PATCH Item_C2 assignedDayOfWeek (bump; data-dependent)
    revBefore = step2Body.instance.revisionId;
    const step3 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemC2.id}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ assignedDayOfWeek: "Saturday" }),
      },
    );
    assertEq("step 3: PATCH assignedDayOfWeek status", step3.status, 200);
    const step3Body = (await step3.json()) as {
      revisionId: number;
      macrosStale: boolean;
    };
    assertEq(
      "step 3: assignedDayOfWeek PATCH bumps revisionId",
      step3Body.revisionId,
      revBefore + 1,
    );
    recordMacrosStale("step 3: PATCH assignedDayOfWeek", step3Body.macrosStale, "envelope");

    // Step 4 — PATCH Item_C2 slot (bump; data-dependent)
    revBefore = step3Body.revisionId;
    const step4 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemC2.id}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ slot: "lunch" }),
      },
    );
    assertEq("step 4: PATCH slot status", step4.status, 200);
    const step4Body = (await step4.json()) as {
      revisionId: number;
      macrosStale: boolean;
    };
    assertEq("step 4: slot PATCH bumps revisionId", step4Body.revisionId, revBefore + 1);
    recordMacrosStale("step 4: PATCH slot", step4Body.macrosStale, "envelope");

    // Step 5 — PATCH Item_C1 servingsOverride (bump; HARD: macrosStale=false)
    revBefore = step4Body.revisionId;
    const step5 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemC1.id}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ servingsOverride: 6 }),
      },
    );
    assertEq("step 5: PATCH servingsOverride status", step5.status, 200);
    const step5Body = (await step5.json()) as {
      revisionId: number;
      macrosStale: boolean;
    };
    assertEq(
      "step 5: servingsOverride PATCH bumps revisionId",
      step5Body.revisionId,
      revBefore + 1,
    );
    assertEq(
      "step 5 (F-F-3 / D-WS7-061): servingsOverride on cached item → macrosStale=false (HARD)",
      step5Body.macrosStale,
      false,
    );
    recordMacrosStale("step 5: PATCH servingsOverride (cached)", step5Body.macrosStale, "envelope");

    // Step 6 — PATCH Item_C1 recipeOverrideJson (bump; F-F-2 evidence)
    revBefore = step5Body.revisionId;
    const overridePayload = {
      titleOverride: "WS7-4-F smoke override",
      dishes: [
        {
          name: "Smoke override dish",
          ingredients: [
            { name: sampleIng.canonicalName, quantity: 1, unit: "tsp" },
          ],
        },
      ],
      steps: ["Combine all"],
      createdAt: new Date().toISOString(),
    };
    const step6 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemC1.id}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ recipeOverrideJson: overridePayload }),
      },
    );
    assertEq("step 6: PATCH recipeOverrideJson status", step6.status, 200);
    const step6Body = (await step6.json()) as {
      revisionId: number;
      macrosStale: boolean;
    };
    assertEq(
      "step 6: recipeOverrideJson PATCH bumps revisionId",
      step6Body.revisionId,
      revBefore + 1,
    );
    recordMacrosStale("step 6: PATCH recipeOverrideJson (F-F-2 evidence)", step6Body.macrosStale, "envelope");

    // Step 7 — PATCH Item_C2 atomic mealId-swap (bump; new item id)
    revBefore = step6Body.revisionId;
    const oldItemC2Id = itemC2.id;
    const step7 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${oldItemC2Id}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ mealId: swapTargetMeal.id }),
      },
    );
    assertEq("step 7: PATCH mealId-swap status", step7.status, 200);
    const step7Body = (await step7.json()) as {
      item: { id: string; mealId: string };
      revisionId: number;
      macrosStale: boolean;
    };
    assertEq(
      "step 7: mealId-swap PATCH bumps revisionId",
      step7Body.revisionId,
      revBefore + 1,
    );
    assertTrue(
      "step 7: mealId-swap produces a new item id",
      step7Body.item.id !== oldItemC2Id,
    );
    assertEq(
      "step 7: item.mealId rebound to swap target",
      step7Body.item.mealId,
      swapTargetMeal.id,
    );
    itemC2 = { id: step7Body.item.id, mealId: step7Body.item.mealId, positionIndex: itemC2.positionIndex };
    recordMacrosStale("step 7: PATCH mealId-swap (cached → cached)", step7Body.macrosStale, "envelope");

    // ── PHASE 2 — introduce the uncached dish ──────────────────────────────

    // Step 8 — POST /items add Meal_U (bump; HARD: macrosStale=true)
    revBefore = step7Body.revisionId;
    const step8 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items`,
      {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          mealId: mealU_id,
          slot: "dinner",
          assignedDayOfWeek: "Friday",
        }),
      },
    );
    assertEq("step 8: POST /items (Meal_U) status", step8.status, 201);
    const step8Body = (await step8.json()) as {
      item: { id: string; mealId: string };
      revisionId: number;
      macrosStale: boolean;
    };
    const itemU_id = step8Body.item.id;
    assertEq(
      "step 8: POST /items bumps revisionId",
      step8Body.revisionId,
      revBefore + 1,
    );
    assertEq(
      "step 8 (CORE PROOF): adding uncached Meal_U → macrosStale=true (HARD)",
      step8Body.macrosStale,
      true,
    );
    recordMacrosStale("step 8: POST /items (Meal_U) [CORE PROOF]", step8Body.macrosStale, "envelope");

    // ── PHASE 3 — mutations with Meal_U in plan ────────────────────────────

    // Step 9 — POST promote-override on Item_C1 (bump; new mealId)
    revBefore = step8Body.revisionId;
    const step9 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemC1.id}/promote-override`,
      { method: "POST", headers: authHeader },
    );
    assertEq("step 9: POST promote-override status", step9.status, 200);
    const step9Body = (await step9.json()) as {
      item: { id: string; mealId: string };
      newMealId: string;
      revisionId: number;
      macrosStale: boolean;
    };
    promotedMealId = step9Body.newMealId;
    assertEq(
      "step 9: promote-override bumps revisionId",
      step9Body.revisionId,
      revBefore + 1,
    );
    assertEq(
      "step 9: item rebound to newly-promoted meal",
      step9Body.item.mealId,
      promotedMealId,
    );
    recordMacrosStale("step 9: POST promote-override", step9Body.macrosStale, "envelope");

    // Step 10 — PATCH Item_C3 unassign (assignedDayOfWeek=null; bump)
    revBefore = step9Body.revisionId;
    const step10 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemC3.id}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ assignedDayOfWeek: null }),
      },
    );
    assertEq("step 10: PATCH unassign status", step10.status, 200);
    const step10Body = (await step10.json()) as {
      revisionId: number;
      macrosStale: boolean;
    };
    assertEq(
      "step 10: unassign PATCH bumps revisionId",
      step10Body.revisionId,
      revBefore + 1,
    );
    recordMacrosStale("step 10: PATCH unassign day", step10Body.macrosStale, "envelope");

    // Step 11 — DELETE Item_C3 (bump)
    revBefore = step10Body.revisionId;
    const step11 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemC3.id}`,
      { method: "DELETE", headers: authHeader },
    );
    assertEq("step 11: DELETE /items status", step11.status, 200);
    const step11Body = (await step11.json()) as {
      revisionId: number;
      macrosStale: boolean;
    };
    assertEq(
      "step 11: DELETE /items bumps revisionId",
      step11Body.revisionId,
      revBefore + 1,
    );
    recordMacrosStale("step 11: DELETE /items", step11Body.macrosStale, "envelope");

    // Sanity — Meal_U still in plan, so predicate should still be true here.
    const preRecalcStale = await planNeedsMacroEstimation({ planId: createdPlanId });
    assertEq(
      "step 11 (sanity): predicate=true pre-recalc (Meal_U still uncached in plan)",
      preRecalcStale,
      true,
    );

    // ── PHASE 4 — live recalc + round-trip ─────────────────────────────────

    // Step 12 — POST /plans/:id/recalc-macros (real Anthropic call)
    const step12 = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/recalc-macros`,
      { method: "POST", headers: authHeader },
    );
    assertEq("step 12: POST /recalc-macros status", step12.status, 200);
    const step12Body = (await step12.json()) as {
      dailyAverages: {
        caloriesPerDay: number;
        proteinGPerDay: number;
        carbsGPerDay: number;
        fatGPerDay: number;
      };
      perDay: Array<{ day: string; totals: unknown; mealCount: number }>;
      perMeal: Array<{
        mealPlanItemId: string;
        dishMacros: Array<{ status: "cached" | "computed" | "failed" }>;
      }>;
      computedAt: string;
      hasEstimatedMacros: boolean;
      estimationCaveats: string[];
    };
    assertTrue(
      "step 12: dailyAverages.caloriesPerDay is finite number",
      Number.isFinite(step12Body.dailyAverages.caloriesPerDay),
    );
    assertTrue(
      "step 12: dailyAverages.proteinGPerDay is finite number",
      Number.isFinite(step12Body.dailyAverages.proteinGPerDay),
    );
    assertTrue(
      "step 12: dailyAverages.carbsGPerDay is finite number",
      Number.isFinite(step12Body.dailyAverages.carbsGPerDay),
    );
    assertTrue(
      "step 12: dailyAverages.fatGPerDay is finite number",
      Number.isFinite(step12Body.dailyAverages.fatGPerDay),
    );
    assertTrue(
      "step 12: hasEstimatedMacros is boolean",
      typeof step12Body.hasEstimatedMacros === "boolean",
    );
    assertTrue(
      "step 12: perMeal is non-empty array",
      Array.isArray(step12Body.perMeal) && step12Body.perMeal.length > 0,
    );
    const statusOk = step12Body.perMeal.every((m) =>
      m.dishMacros.every(
        (d) => d.status === "cached" || d.status === "computed" || d.status === "failed",
      ),
    );
    assertTrue(
      "step 12: every dishMacros[*].status ∈ {cached,computed,failed}",
      statusOk,
    );
    console.log(
      `[smoke] recalc: dailyAverages=${JSON.stringify(step12Body.dailyAverages)} hasEstimatedMacros=${step12Body.hasEstimatedMacros} perMealCount=${step12Body.perMeal.length}`,
    );

    // Confirm Anthropic was actually invoked: at least one dish in the
    // recalc result must have status='computed' (Dish_U was at zero macros,
    // so its entry must have been freshly computed by Anthropic — unless the
    // call failed, in which case status='failed' surfaces and the test below
    // exposes that case explicitly).
    const computedCount = step12Body.perMeal.reduce(
      (n, m) => n + m.dishMacros.filter((d) => d.status === "computed").length,
      0,
    );
    const failedCount = step12Body.perMeal.reduce(
      (n, m) => n + m.dishMacros.filter((d) => d.status === "failed").length,
      0,
    );
    console.log(
      `[smoke] recalc dish breakdown: computed=${computedCount} failed=${failedCount}`,
    );
    assertTrue(
      "step 12: Anthropic invoked — at least one dish computed (status='computed')",
      computedCount >= 1,
      `computed=${computedCount} failed=${failedCount}`,
    );

    // Step 13 — round-trip honesty: predicate now returns false (HARD)
    const postRecalcStale = await planNeedsMacroEstimation({ planId: createdPlanId });
    recordMacrosStale("step 13: predicate post-recalc", postRecalcStale, "direct-read (G2)");
    assertEq(
      "step 13 (ROUND-TRIP): predicate=false after recalc — staleness resolved (HARD)",
      postRecalcStale,
      false,
    );
    // Confirm Dish_U was persisted back with non-zero macros.
    const dishUAfter = await prisma.dish.findUnique({
      where: { id: dishU_id! },
      select: {
        caloriesPerServing: true,
        proteinGPerServing: true,
        carbsGPerServing: true,
        fatGPerServing: true,
      },
    });
    assertTrue(
      "step 13: Dish_U persisted with non-zero macros after recalc",
      dishUAfter !== null && dishHasStoredMacros(dishUAfter),
      `dishU after = ${JSON.stringify(dishUAfter)}`,
    );

    // ── PHASE 5 — compost + final direct-read ──────────────────────────────

    // Step 14 — DELETE /plans/:id (compost; bump; G2 direct-read predicate)
    revBefore = step11Body.revisionId; // last envelope-known mutation revisionId
    // recalc does NOT bump revisionId, so revBefore is still the prior bump.
    const step14 = await fetch(`${harness.baseUrl}/plans/${createdPlanId}`, {
      method: "DELETE",
      headers: authHeader,
    });
    assertEq("step 14: DELETE /plans/:id status", step14.status, 200);
    const step14Body = (await step14.json()) as {
      instance: { revisionId: number };
    };
    assertEq(
      "step 14: compost bumps revisionId",
      step14Body.instance.revisionId,
      revBefore + 1,
    );
    const compostRow = await prisma.mealPlanInstance.findUnique({
      where: { id: createdPlanId },
      select: { status: true, isArchived: true, compostedAt: true },
    });
    assertEq("step 14: compost.status=past", compostRow?.status ?? null, "past");
    assertEq("step 14: compost.isArchived=true", compostRow?.isArchived ?? null, true);
    // WS7-6 (E) Block 1 REWORK: under Model 2, isArchived:true rows are
    // excluded from my_plans + the resolver's covering subset, so the
    // composted plan cannot be the winner regardless of its activatedAt.
    assertTrue(
      "step 14: compost.compostedAt set",
      compostRow?.compostedAt != null,
    );
    // G2 — direct-read predicate on the composted plan (envelope has no field).
    const composedStale = await planNeedsMacroEstimation({ planId: createdPlanId });
    recordMacrosStale("step 14: compost (post)", composedStale, "direct-read (G2)");

    // ── Map summary ─────────────────────────────────────────────────────────
    console.log("\n[smoke] macrosStale-per-mutation map:");
    for (const e of macrosStaleMap) {
      console.log(`  ${e.step.padEnd(50)} -> ${e.value} [${e.source}]`);
    }

    console.log("\n[smoke] ALL CHECKS PASSED");
    return 0;
  } catch (err) {
    console.error(
      `\n[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return 1;
  } finally {
    // ── Idempotent teardown ────────────────────────────────────────────────
    try {
      if (createdPlanId) {
        const itemsForPlan = await prisma.mealPlanItem.findMany({
          where: { mealPlanInstanceId: createdPlanId },
          select: { id: true },
        });
        const itemIds = itemsForPlan.map((i) => i.id);
        await prisma.userActivity.deleteMany({
          where: {
            eventType: { in: [...F_SMOKE_EVENT_TYPES] },
            OR: [
              { entityId: createdPlanId },
              { entityId: { in: itemIds.length > 0 ? itemIds : ["__none__"] } },
            ],
          },
        });
        await prisma.mealPlanItem.deleteMany({
          where: { mealPlanInstanceId: createdPlanId },
        });
        await prisma.mealPlanInstance.delete({ where: { id: createdPlanId } });
        console.log(`[teardown] deleted plan ${createdPlanId}`);
      }

      // Activities tied to the promoted meal's dish_macros_estimated row
      // reference the promoted Dish ids; clean those up before deleting dishes.
      if (promotedMealId) {
        const promotedLinks = await prisma.mealDishLink.findMany({
          where: { mealId: promotedMealId },
          select: { dishId: true },
        });
        const promotedDishIds = promotedLinks.map((l) => l.dishId);
        if (promotedDishIds.length > 0) {
          await prisma.userActivity.deleteMany({
            where: {
              eventType: "dish_macros_estimated",
              entityId: { in: promotedDishIds },
            },
          });
        }
        await prisma.dishIngredient.deleteMany({
          where: { dishId: { in: promotedDishIds } },
        });
        await prisma.mealDishLink.deleteMany({
          where: { mealId: promotedMealId },
        });
        await prisma.dish.deleteMany({
          where: { id: { in: promotedDishIds } },
        });
        await prisma.meal.delete({ where: { id: promotedMealId } });
        console.log(`[teardown] deleted promoted meal ${promotedMealId}`);
      }

      if (mealU_id && dishU_id) {
        // Recalc may have written a dish_macros_estimated row for Dish_U.
        await prisma.userActivity.deleteMany({
          where: {
            eventType: "dish_macros_estimated",
            entityId: dishU_id,
          },
        });
      }
      if (mealU_linkId) {
        await prisma.mealDishLink.delete({ where: { id: mealU_linkId } });
      }
      if (dishU_ingredientRowId) {
        await prisma.dishIngredient.delete({ where: { id: dishU_ingredientRowId } });
      }
      if (dishU_id) {
        await prisma.dish.delete({ where: { id: dishU_id } });
      }
      if (mealU_id) {
        await prisma.meal.delete({ where: { id: mealU_id } });
        console.log(`[teardown] deleted Meal_U/Dish_U`);
      }

      // WS7-6 (E) Block 1 REWORK: nothing to restore. use-template creates
      // undated rows that never become the resolver winner; the prior
      // covering plan's activatedAt was never modified.
      if (priorActiveInstanceId) {
        console.log(`[teardown] no-op: prior covering plan ${priorActiveInstanceId} was not modified (Model 2)`);
      }
    } catch (terr) {
      console.error(
        `[teardown] WARNING — error during teardown: ${terr instanceof Error ? terr.message : String(terr)}`,
      );
    }
    await harness.close();
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error("[smoke] uncaught:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
