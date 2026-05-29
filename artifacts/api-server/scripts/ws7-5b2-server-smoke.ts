// WS7-5b2-server smoke — wizard draft "Save for Later" end-to-end.
//
// Drives the Branch B chain through the new save slice:
//   1. POST /api/wizard/build-plans              — generate candidates
//   2. POST /api/wizard/expand                   — write hidden draft
//   3. GET  /api/wizard/drafts/:id               — fetch detail
//   4. POST /api/wizard/drafts/:id/save          — materialize, NO active flip (new)
//   5. DB check — the saved plan has the materialized graph (meals / dishes /
//      DishIngredients / RecipeInstructionSteps + macros) AND:
//        isWizardDraft = false
//        isActiveThisWeek = false   ← NOT active this week (vs. activate)
//        startDate = null           ← undated (vs. activate)
//        endDate = null             ← undated (vs. activate)
//   6. GET /api/wizard/drafts — assert the saved row no longer appears
//      (isWizardDraft filter excludes it — it's now a real plan).
//   7. GET /api/plans?filter=my_plans — assert the saved row appears here
//      as an undated inactive plan (the My Plans landing).
//   8. activity check — plan_created emitted for the saved id.
//
// Run:  pnpm --filter @workspace/api-server exec tsx scripts/ws7-5b2-server-smoke.ts
//
// Real Anthropic (Sonnet for build-plans + expand, Haiku for per-dish macro
// estimator). Save itself is pure DB work (no AI), so step 4 should be fast.
//
// Prereq: prisma:seed (for AIPrompts wizard.candidate.expand v1) AND
// migrations through 20260528120000_ws7_5a_wizard_draft applied.
// ANTHROPIC_API_KEY must be set.

import { PrismaClient } from "@prisma/client";
import express from "express";
import type { Server } from "node:http";

import { signToken } from "../src/lib/auth.ts";
import { createWizardRouter } from "../src/routes/wizard.ts";
import { createPlansRouter } from "../src/routes/plans.ts";

const prisma = new PrismaClient();
const SMOKE_USER_ID = "smoke-ws7-5b2-server-user";
const SMOKE_USER_EMAIL = "smoke+ws7-5b2-server@kiwi.dev";

interface SmokeReport {
  buildPlans: { ok: boolean; candidateCount: number; latencyMs: number };
  expand: {
    ok: boolean;
    draftId?: string;
    mealCount?: number;
    dishesTotal?: number;
    latencyMs: number;
  };
  getDetail: { ok: boolean; mealCountInJson?: number };
  save: {
    ok: boolean;
    savedPlanId?: string;
    revisionId?: number;
    latencyMs: number;
  };
  dbCheck: {
    ok: boolean;
    isWizardDraft?: boolean;
    isActiveThisWeek?: boolean;
    startDate?: Date | null;
    endDate?: Date | null;
    status?: string;
    itemCount?: number;
    mealsCreated?: number;
    dishesCreated?: number;
    dishIngredientsCreated?: number;
    recipeStepsCreated?: number;
    dishesWithMacros?: number;
  };
  draftsListExcludesSaved: { ok: boolean; foundInDrafts: boolean };
  myPlansIncludesSaved: { ok: boolean; foundInMyPlans: boolean };
  activityEventEmitted: { ok: boolean };
  cleanupPlanId: string | null;
}

async function ensureSmokeUser(): Promise<void> {
  await prisma.user.upsert({
    where: { id: SMOKE_USER_ID },
    update: {},
    create: {
      id: SMOKE_USER_ID,
      email: SMOKE_USER_EMAIL,
      firstName: "Smoke",
      lastName: "WizardSave",
      defaultHouseholdSize: 4,
    },
  });
}

async function spinUpServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.use("/api", createWizardRouter());
  app.use("/api", createPlansRouter());

  return await new Promise((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — smoke aborts.");
    process.exitCode = 1;
    return;
  }

  await ensureSmokeUser();
  const harness = await spinUpServer();
  const token = signToken(SMOKE_USER_ID);
  const auth = { Authorization: `Bearer ${token}` };
  const jsonAuth = { "Content-Type": "application/json", ...auth };

  const report: SmokeReport = {
    buildPlans: { ok: false, candidateCount: 0, latencyMs: 0 },
    expand: { ok: false, latencyMs: 0 },
    getDetail: { ok: false },
    save: { ok: false, latencyMs: 0 },
    dbCheck: { ok: false },
    draftsListExcludesSaved: { ok: false, foundInDrafts: true },
    myPlansIncludesSaved: { ok: false, foundInMyPlans: false },
    activityEventEmitted: { ok: false },
    cleanupPlanId: null,
  };

  try {
    console.log("══════════════════════════════════════════════════════════");
    console.log("WS7-5b2-server smoke — wizard draft Save for Later");
    console.log("══════════════════════════════════════════════════════════");

    // ── 1. build-plans ────────────────────────────────────────────────
    console.log("\n[1/8] POST /wizard/build-plans");
    const bpStart = Date.now();
    const bpRes = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        planDurationDays: 5,
        householdSize: 4,
        wantsLeftovers: true,
        cuisines: ["Mediterranean", "Italian"],
        eatingStyles: [],
        allergiesAndAvoidances: [],
        difficulty: "medium",
        weeklyPacing: "mixed",
      }),
    });
    const bpLatency = Date.now() - bpStart;
    const bpBody = (await bpRes.json()) as {
      candidates?: Array<{ id: string; title: string; mealTitles: string[] }>;
      error?: string;
    };
    if (bpRes.status !== 200 || !bpBody.candidates) {
      console.error(`  ✗ build-plans failed: ${bpRes.status} ${bpBody.error}`);
      throw new Error("build-plans failed");
    }
    report.buildPlans = {
      ok: true,
      candidateCount: bpBody.candidates.length,
      latencyMs: bpLatency,
    };
    console.log(
      `  ✓ ${bpBody.candidates.length} candidates  ${bpLatency}ms`,
    );

    const chosen = bpBody.candidates[0];

    // ── 2. expand ────────────────────────────────────────────────────
    console.log(`\n[2/8] POST /wizard/expand  candidate="${chosen.title}"`);
    const exStart = Date.now();
    const exRes = await fetch(`${harness.baseUrl}/wizard/expand`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        candidate: chosen,
        candidateContext: {
          planDurationDays: 5,
          householdSize: 4,
          wantsLeftovers: true,
          allergiesAndAvoidances: [],
          eatingStyles: [],
          difficulty: "medium",
        },
      }),
    });
    const exLatency = Date.now() - exStart;
    const exBody = (await exRes.json()) as {
      draft?: { id: string; createdAt: string };
      expanded?: { meals: Array<{ dishes: unknown[] }> };
      error?: string;
    };
    if (exRes.status !== 200 || !exBody.draft || !exBody.expanded) {
      console.error(`  ✗ expand failed: ${exRes.status} ${exBody.error}`);
      throw new Error("expand failed");
    }
    const dishesTotal = exBody.expanded.meals.reduce(
      (n, m) => n + m.dishes.length,
      0,
    );
    report.expand = {
      ok: true,
      draftId: exBody.draft.id,
      mealCount: exBody.expanded.meals.length,
      dishesTotal,
      latencyMs: exLatency,
    };
    console.log(
      `  ✓ draftId=${exBody.draft.id}  meals=${exBody.expanded.meals.length}  dishes=${dishesTotal}  ${exLatency}ms`,
    );

    const draftId = exBody.draft.id;
    report.cleanupPlanId = draftId;

    // ── 3. GET /wizard/drafts/:id ────────────────────────────────────
    console.log(`\n[3/8] GET /wizard/drafts/${draftId}`);
    const detailRes = await fetch(`${harness.baseUrl}/wizard/drafts/${draftId}`, {
      headers: auth,
    });
    const detailBody = (await detailRes.json()) as {
      draft?: { id: string; createdAt: string };
      expanded?: { meals: unknown[]; title: string };
      error?: string;
    };
    const detailOk =
      detailRes.status === 200 &&
      !!detailBody.expanded &&
      detailBody.expanded.meals.length === exBody.expanded.meals.length;
    report.getDetail = {
      ok: detailOk,
      mealCountInJson: detailBody.expanded?.meals.length,
    };
    console.log(
      `  ${detailOk ? "✓" : "✗"} status=${detailRes.status}  mealsInJson=${detailBody.expanded?.meals.length}`,
    );

    // ── 4. POST /wizard/drafts/:id/save ──────────────────────────────
    console.log(`\n[4/8] POST /wizard/drafts/${draftId}/save`);
    const saveStart = Date.now();
    const saveRes = await fetch(
      `${harness.baseUrl}/wizard/drafts/${draftId}/save`,
      { method: "POST", headers: jsonAuth },
    );
    const saveLatency = Date.now() - saveStart;
    const saveBody = (await saveRes.json()) as {
      instance?: { id: string; revisionId: number };
      error?: string;
      reason?: string;
    };
    if (saveRes.status !== 201 || !saveBody.instance) {
      console.error(
        `  ✗ save failed: ${saveRes.status} ${saveBody.error} ${saveBody.reason ?? ""}`,
      );
      throw new Error("save failed");
    }
    report.save = {
      ok: true,
      savedPlanId: saveBody.instance.id,
      revisionId: saveBody.instance.revisionId,
      latencyMs: saveLatency,
    };
    console.log(
      `  ✓ instanceId=${saveBody.instance.id}  revisionId=${saveBody.instance.revisionId}  ${saveLatency}ms`,
    );

    // ── 5. DB check — graph materialized AND undated/inactive flags ──
    console.log("\n[5/8] DB check — materialized rows + undated/inactive flags");
    const saved = await prisma.mealPlanInstance.findUnique({
      where: { id: saveBody.instance.id },
      select: {
        isWizardDraft: true,
        isActiveThisWeek: true,
        startDate: true,
        endDate: true,
        status: true,
        items: {
          select: {
            id: true,
            mealId: true,
            meal: {
              select: {
                id: true,
                title: true,
                dishLinks: {
                  select: {
                    dish: {
                      select: {
                        id: true,
                        title: true,
                        caloriesPerServing: true,
                        proteinGPerServing: true,
                        carbsGPerServing: true,
                        fatGPerServing: true,
                        dishIngredients: { select: { id: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!saved) {
      console.error("  ✗ saved plan row not found by id");
      throw new Error("saved row missing");
    }
    const itemCount = saved.items.length;
    const mealsCreated = new Set(saved.items.map((i) => i.mealId)).size;
    const allDishes = saved.items.flatMap((i) =>
      i.meal.dishLinks.map((l) => l.dish),
    );
    const dishesCreated = allDishes.length;
    const dishIngredientsCreated = allDishes.reduce(
      (n, d) => n + d.dishIngredients.length,
      0,
    );
    const dishesWithMacros = allDishes.filter(
      (d) =>
        d.caloriesPerServing > 0 ||
        d.proteinGPerServing > 0 ||
        d.carbsGPerServing > 0 ||
        d.fatGPerServing > 0,
    ).length;
    const dishIdSet = new Set(allDishes.map((d) => d.id));
    const recipeSteps = await prisma.recipeInstructionStep.count({
      where: { ownerType: "dish", ownerId: { in: [...dishIdSet] } },
    });

    report.dbCheck = {
      ok:
        saved.isWizardDraft === false &&
        saved.isActiveThisWeek === false &&
        saved.startDate === null &&
        saved.endDate === null &&
        itemCount > 0 &&
        dishesCreated > 0 &&
        dishIngredientsCreated > 0 &&
        recipeSteps > 0,
      isWizardDraft: saved.isWizardDraft,
      isActiveThisWeek: saved.isActiveThisWeek,
      startDate: saved.startDate,
      endDate: saved.endDate,
      status: saved.status,
      itemCount,
      mealsCreated,
      dishesCreated,
      dishIngredientsCreated,
      recipeStepsCreated: recipeSteps,
      dishesWithMacros,
    };
    console.log(
      `  ${report.dbCheck.ok ? "✓" : "✗"} isWizardDraft=${saved.isWizardDraft}  isActiveThisWeek=${saved.isActiveThisWeek}  startDate=${saved.startDate}  endDate=${saved.endDate}  status=${saved.status}`,
    );
    console.log(
      `       items=${itemCount}  meals=${mealsCreated}  dishes=${dishesCreated}  dishIngredients=${dishIngredientsCreated}  steps=${recipeSteps}  withMacros=${dishesWithMacros}/${dishesCreated}`,
    );

    // ── 6. /wizard/drafts no longer lists it ─────────────────────────
    console.log("\n[6/8] GET /wizard/drafts  — assert saved is excluded");
    const dRes = await fetch(`${harness.baseUrl}/wizard/drafts`, {
      headers: auth,
    });
    const dBody = (await dRes.json()) as {
      drafts: Array<{ id: string }>;
    };
    const foundInDrafts = dBody.drafts.some((d) => d.id === saveBody.instance!.id);
    report.draftsListExcludesSaved = {
      ok: !foundInDrafts,
      foundInDrafts,
    };
    console.log(
      `  ${!foundInDrafts ? "✓" : "✗"} excluded — drafts.length=${dBody.drafts.length}  foundSaved=${foundInDrafts}`,
    );

    // ── 7. /plans?filter=my_plans includes it (undated/inactive) ─────
    console.log("\n[7/8] GET /plans?filter=my_plans  — assert saved appears");
    const mpRes = await fetch(`${harness.baseUrl}/plans?filter=my_plans`, {
      headers: auth,
    });
    const mpBody = (await mpRes.json()) as {
      plans?: Array<{ id: string }>;
    };
    const foundInMyPlans = (mpBody.plans ?? []).some(
      (p) => p.id === saveBody.instance!.id,
    );
    report.myPlansIncludesSaved = {
      ok: foundInMyPlans,
      foundInMyPlans,
    };
    console.log(
      `  ${foundInMyPlans ? "✓" : "✗"} present — my_plans.length=${mpBody.plans?.length ?? 0}  foundSaved=${foundInMyPlans}`,
    );

    // ── 8. activity event ────────────────────────────────────────────
    console.log("\n[8/8] activity check — plan_created");
    const activity = await prisma.userActivity.findFirst({
      where: {
        userId: SMOKE_USER_ID,
        eventType: "plan_created",
        entityId: saveBody.instance.id,
      },
      orderBy: { createdAt: "desc" },
    });
    report.activityEventEmitted = { ok: activity !== null };
    console.log(`  ${activity ? "✓" : "✗"} plan_created event present`);
  } finally {
    await harness.close();
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("REPORT");
  console.log("══════════════════════════════════════════════════════════");
  console.log(JSON.stringify(report, null, 2));

  // Cleanup — delete the saved plan + cascade. Keep LLMCallLog rows for
  // cost audit. Meal/Dish/Ingredient rows persist (shared across activations).
  // Run-twice-clean: repeated runs create new draft+save graphs without
  // conflicting.
  if (report.cleanupPlanId) {
    try {
      await prisma.mealPlanInstance.delete({
        where: { id: report.cleanupPlanId },
      });
      console.log(`\nCleaned up plan ${report.cleanupPlanId}.`);
    } catch (err) {
      console.warn(`Cleanup failed: ${(err as Error).message}`);
    }
  }

  const allOk =
    report.buildPlans.ok &&
    report.expand.ok &&
    report.getDetail.ok &&
    report.save.ok &&
    report.dbCheck.ok &&
    report.draftsListExcludesSaved.ok &&
    report.myPlansIncludesSaved.ok &&
    report.activityEventEmitted.ok;
  process.exitCode = allOk ? 0 : 1;
  console.log(`\nResult: ${allOk ? "PASS" : "FAIL"}`);
}

main()
  .catch((err) => {
    console.error("Smoke crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
