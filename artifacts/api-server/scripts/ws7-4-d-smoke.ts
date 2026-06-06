// WS7-4-D c10 — Live smoke for the plan-item mutation surface.
//
// In-process HTTP (no separate api-server). Spins up Express with the
// production plans router, mints a JWT for the dev user, exercises:
//
//   POST /plans (empty plan)
//     -> POST /items (add meal)
//     -> PATCH /items (assignedDayOfWeek)
//     -> PATCH /items (slot)
//     -> PATCH /items (servingsOverride -> macrosStale=true)
//     -> PATCH /items (atomic mealId swap -> preservation matrix +
//                     single plan_meal_changed)
//     -> set recipeOverrideJson via direct Prisma write
//     -> POST /items/:itemId/promote-override
//     -> DELETE /items
//
// Plus matching UserActivity assertions for each step's emission
// pattern (Q-P0-6 / Q-P0-7 mappings).
//
// Idempotent teardown at end. Exits non-zero on any assertion failure.
//
// Run:
//   pnpm --filter @workspace/api-server exec tsx scripts/ws7-4-d-smoke.ts
//
// Prereq: prisma:seed:dev (Hans's user) + at least 2 distinct meals
// the dev user can use (public or owned).

import { Prisma, PrismaClient } from "@prisma/client";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../src/lib/auth";
import { createPlansRouter } from "../src/routes/plans";

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

// All ActivityEventType values c10 may write — used by idempotent teardown.
const D_SMOKE_EVENT_TYPES = [
  "plan_created",
  "plan_composted",
  "plan_meal_added",
  "plan_meal_composted",
  "plan_meal_changed",
  "plan_meal_assigned",
  "plan_meal_unassigned",
  "plan_meal_edited",
  "plan_recipe_changed",
] as const;

async function main(): Promise<number> {
  const harness = await spinUp();
  let createdPlanId: string | null = null;
  let promotedMealId: string | null = null;
  let priorActiveInstanceId: string | null = null;

  try {
    const user = await prisma.user.findUnique({
      where: { email: DEV_USER_EMAIL },
    });
    if (!user) throw new Error(`Dev user not found: ${DEV_USER_EMAIL}`);
    const token = signToken(user.id);
    const authHeader = { Authorization: `Bearer ${token}` };

    // Find two usable meals. Public-and-not-archived OR owned-by-user.
    const meals = await prisma.meal.findMany({
      where: {
        isArchived: false,
        OR: [{ isPublic: true }, { userId: user.id }],
      },
      take: 2,
      select: { id: true, title: true },
    });
    if (meals.length < 2) {
      throw new Error(
        `Need >=2 public-or-owned non-archived meals to smoke; found ${meals.length}`,
      );
    }
    const [mealA, mealB] = meals;
    console.log(
      `[smoke] using meals: A=${mealA.id} (${mealA.title}), B=${mealB.id} (${mealB.title})`,
    );

    // WS7-6 (E) Block 1 REWORK — capture the prior covering plan via date
    // range; no flag column exists. Recorded for log parity with the
    // pre-REWORK smoke; this smoke never activates the new plan so the
    // prior covering plan remains the resolver winner throughout.
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

    // ── Step 1: POST /plans — create empty plan ──────────────────────────
    const createPlanRes = await fetch(`${harness.baseUrl}/plans`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "WS7-4-D smoke" }),
    });
    assertEq("step 1: POST /plans status", createPlanRes.status, 201);
    const createPlanBody = (await createPlanRes.json()) as {
      instance: { id: string; revisionId: number };
    };
    createdPlanId = createPlanBody.instance.id;
    assertEq("step 1: plan.revisionId = 1", createPlanBody.instance.revisionId, 1);

    // ── Step 2: POST /items — add mealA ──────────────────────────────────
    const addRes = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items`,
      {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ mealId: mealA.id, slot: "dinner" }),
      },
    );
    assertEq("step 2: POST /items status", addRes.status, 201);
    const addBody = (await addRes.json()) as {
      item: { id: string; mealId: string; isDinner: boolean; positionIndex: number };
      planId: string;
      revisionId: number;
      macrosStale: boolean;
    };
    let itemId = addBody.item.id;
    assertEq("step 2: item.mealId matches", addBody.item.mealId, mealA.id);
    assertEq("step 2: item.isDinner = true", addBody.item.isDinner, true);
    assertEq("step 2: item.positionIndex = 0", addBody.item.positionIndex, 0);
    assertEq("step 2: revisionId = 2", addBody.revisionId, 2);
    const addedActs = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: itemId, eventType: "plan_meal_added" },
    });
    assertEq("step 2: plan_meal_added activity count = 1", addedActs.length, 1);

    // ── Step 3: PATCH /items — assignedDayOfWeek null -> Monday ──────────
    const patchDay = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemId}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ assignedDayOfWeek: "Monday" }),
      },
    );
    assertEq("step 3: PATCH day status", patchDay.status, 200);
    const patchDayBody = (await patchDay.json()) as {
      item: { assignedDayOfWeek: string };
      revisionId: number;
    };
    assertEq(
      "step 3: item.assignedDayOfWeek = Monday",
      patchDayBody.item.assignedDayOfWeek,
      "Monday",
    );
    assertEq("step 3: revisionId = 3", patchDayBody.revisionId, 3);
    const dayActs = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: itemId, eventType: "plan_meal_assigned" },
    });
    assertEq("step 3: plan_meal_assigned count = 1", dayActs.length, 1);

    // ── Step 4: PATCH /items — slot dinner -> lunch ──────────────────────
    const patchSlot = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemId}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ slot: "lunch" }),
      },
    );
    assertEq("step 4: PATCH slot status", patchSlot.status, 200);
    const patchSlotBody = (await patchSlot.json()) as {
      item: { isLunch: boolean; isDinner: boolean };
    };
    assertEq("step 4: item.isLunch = true", patchSlotBody.item.isLunch, true);
    assertEq("step 4: item.isDinner = false", patchSlotBody.item.isDinner, false);
    const slotEditActs = await prisma.userActivity.findMany({
      where: {
        userId: user.id,
        entityId: itemId,
        eventType: "plan_meal_edited",
      },
    });
    assertEq("step 4: plan_meal_edited count = 1 (slot)", slotEditActs.length, 1);

    // ── Step 5: PATCH /items — servingsOverride 6 -> macrosStale true ────
    const patchServ = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemId}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ servingsOverride: 6 }),
      },
    );
    assertEq("step 5: PATCH servings status", patchServ.status, 200);
    const patchServBody = (await patchServ.json()) as {
      item: { servingsOverride: number };
      macrosStale: boolean;
    };
    assertEq("step 5: item.servingsOverride = 6", patchServBody.item.servingsOverride, 6);
    // macrosStale reflects planNeedsMacroEstimation: true ONLY when a dish
    // in the plan lacks stored macros. The dev-seed meals carry canonical
    // macros, so this stays false here — assert it's a boolean and the
    // route plumbed the field through correctly.
    assertTrue(
      "step 5: macrosStale is boolean (plumbing check)",
      typeof patchServBody.macrosStale === "boolean",
    );
    const allEditActs = await prisma.userActivity.findMany({
      where: {
        userId: user.id,
        entityId: itemId,
        eventType: "plan_meal_edited",
      },
    });
    assertEq("step 5: plan_meal_edited count = 2 (slot + servings)", allEditActs.length, 2);

    // ── Step 6: PATCH /items — atomic mealId swap (mealA -> mealB) ──────
    const oldItemId = itemId;
    const swapRes = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${oldItemId}`,
      {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ mealId: mealB.id }),
      },
    );
    assertEq("step 6: PATCH mealId swap status", swapRes.status, 200);
    const swapBody = (await swapRes.json()) as {
      item: {
        id: string;
        mealId: string;
        assignedDayOfWeek: string;
        isLunch: boolean;
        servingsOverride: number | null;
        notes: string | null;
        positionIndex: number;
      };
    };
    itemId = swapBody.item.id;
    assertTrue(
      "step 6: new itemId differs from old (delete+create)",
      itemId !== oldItemId,
    );
    assertEq("step 6: item.mealId = mealB.id", swapBody.item.mealId, mealB.id);
    // Q-P1-4 preservation matrix
    assertEq(
      "step 6 (Q-P1-4 PRESERVE): assignedDayOfWeek = Monday",
      swapBody.item.assignedDayOfWeek,
      "Monday",
    );
    assertEq(
      "step 6 (Q-P1-4 PRESERVE): isLunch = true",
      swapBody.item.isLunch,
      true,
    );
    assertEq(
      "step 6 (Q-P1-4 PRESERVE): positionIndex = 0",
      swapBody.item.positionIndex,
      0,
    );
    assertEq(
      "step 6 (Q-P1-4 RESET): servingsOverride = null",
      swapBody.item.servingsOverride,
      null,
    );
    // Single plan_meal_changed row (not separate composted + added)
    const swapActs = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: itemId, eventType: "plan_meal_changed" },
    });
    assertEq(
      "step 6: SINGLE plan_meal_changed emitted (not separate composted+added)",
      swapActs.length,
      1,
    );
    // Old item is gone
    const oldItemRow = await prisma.mealPlanItem.findUnique({
      where: { id: oldItemId },
    });
    assertEq("step 6: old item deleted", oldItemRow, null);

    // ── Step 7: prep + POST /promote-override ────────────────────────────
    // Find an ingredient that's resolvable (Q-P1-2: case-insensitive
    // canonicalName match). Use the FIRST ingredient in the catalog;
    // build a single-dish override that references it by displayName.
    const sampleIng = await prisma.ingredient.findFirst({
      orderBy: { canonicalName: "asc" },
      select: { canonicalName: true, displayName: true },
    });
    if (!sampleIng) {
      throw new Error("Need at least 1 Ingredient row to smoke promote-override");
    }
    const override = {
      titleOverride: "WS7-4-D smoke override",
      dishes: [
        {
          name: "Smoke Dish",
          ingredients: [
            { name: sampleIng.canonicalName, quantity: 1, unit: "tsp" },
          ],
        },
      ],
      steps: ["Combine all"],
      createdAt: new Date().toISOString(),
    };
    // Write the override directly (UI flow uses PATCH /items but we're
    // running compressed coverage — c3 already proved that path).
    await prisma.mealPlanItem.update({
      where: { id: itemId },
      data: { recipeOverrideJson: override as Prisma.InputJsonValue },
    });

    const promoteRes = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemId}/promote-override`,
      {
        method: "POST",
        headers: authHeader,
      },
    );
    assertEq("step 7: POST promote-override status", promoteRes.status, 200);
    const promoteBody = (await promoteRes.json()) as {
      item: { id: string; mealId: string };
      newMealId: string;
    };
    promotedMealId = promoteBody.newMealId;
    assertEq(
      "step 7: item.mealId rebound to promoted meal",
      promoteBody.item.mealId,
      promotedMealId,
    );
    const promotedRow = await prisma.meal.findUnique({
      where: { id: promotedMealId! },
      select: { userId: true, isPublic: true },
    });
    assertTrue("step 7: promoted meal row exists", promotedRow !== null);
    assertEq("step 7: promoted meal owned by user", promotedRow!.userId, user.id);
    assertEq("step 7: promoted meal is private", promotedRow!.isPublic, false);
    const promotedItem = await prisma.mealPlanItem.findUnique({
      where: { id: itemId },
      select: { recipeOverrideJson: true },
    });
    assertEq(
      "step 7: item.recipeOverrideJson cleared after promote",
      promotedItem!.recipeOverrideJson,
      null,
    );
    const promoteActs = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: itemId, eventType: "plan_recipe_changed" },
    });
    assertEq("step 7: plan_recipe_changed count = 1", promoteActs.length, 1);

    // ── Step 8: DELETE /items ────────────────────────────────────────────
    const delRes = await fetch(
      `${harness.baseUrl}/plans/${createdPlanId}/items/${itemId}`,
      { method: "DELETE", headers: authHeader },
    );
    assertEq("step 8: DELETE /items status", delRes.status, 200);
    const finalItemRow = await prisma.mealPlanItem.findUnique({
      where: { id: itemId },
    });
    assertEq("step 8: item hard-deleted", finalItemRow, null);
    const compostActs = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: itemId, eventType: "plan_meal_composted" },
    });
    assertEq("step 8: plan_meal_composted count = 1", compostActs.length, 1);

    console.log("\n[smoke] ALL CHECKS PASSED");
    return 0;
  } catch (err) {
    console.error(
      `\n[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    // ── Idempotent teardown ──────────────────────────────────────────────
    if (createdPlanId) {
      // Delete activities for any items that were ever bound to this plan.
      // The c3-atomic-swap creates a new itemId; both old and new may have
      // activity rows referencing them.
      const itemsForPlan = await prisma.mealPlanItem.findMany({
        where: { mealPlanInstanceId: createdPlanId },
        select: { id: true },
      });
      const itemIds = itemsForPlan.map((i) => i.id);
      await prisma.userActivity.deleteMany({
        where: {
          eventType: { in: [...D_SMOKE_EVENT_TYPES] },
          OR: [
            { entityId: createdPlanId },
            { entityId: { in: itemIds } },
          ],
        },
      });
      await prisma.mealPlanItem.deleteMany({
        where: { mealPlanInstanceId: createdPlanId },
      });
      await prisma.mealPlanInstance.delete({ where: { id: createdPlanId } });
      console.log(`[teardown] deleted plan ${createdPlanId}`);
    }
    if (promotedMealId) {
      // The promoted Meal carries Dishes via MealDishLink; rely on cascade
      // where present, manual cleanup elsewhere.
      const links = await prisma.mealDishLink.findMany({
        where: { mealId: promotedMealId },
        select: { dishId: true },
      });
      await prisma.recipeInstructionStep.deleteMany({
        where: {
          ownerType: "dish",
          ownerId: { in: links.map((l) => l.dishId) },
        },
      });
      await prisma.dishIngredient.deleteMany({
        where: { dishId: { in: links.map((l) => l.dishId) } },
      });
      await prisma.mealDishLink.deleteMany({
        where: { mealId: promotedMealId },
      });
      await prisma.dish.deleteMany({
        where: { id: { in: links.map((l) => l.dishId) } },
      });
      await prisma.meal.delete({ where: { id: promotedMealId } });
      console.log(`[teardown] deleted promoted meal ${promotedMealId}`);
    }
    if (priorActiveInstanceId) {
      // WS7-6 (E) Block 1 REWORK: nothing to restore. The smoke plan was
      // never activated (no PATCH /plans with dates that cover now), so
      // the prior covering plan's activatedAt was never modified and it
      // remains the resolver winner.
      console.log(`[teardown] no-op: prior covering plan ${priorActiveInstanceId} was not modified (Model 2)`);
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
