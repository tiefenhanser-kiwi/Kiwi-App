// WS7-5b-server smoke — wizard draft activation ("Save and use") end-to-end.
//
// Drives the full Branch B chain through the new activation slice:
//   1. POST /api/wizard/build-plans              — generate candidates
//   2. POST /api/wizard/expand                   — write hidden draft
//   3. GET  /api/wizard/drafts/:id               — fetch detail (new)
//   4. POST /api/wizard/drafts/:id/activate      — materialize + flip (new)
//   5. DB check — draft is now a real plan: isWizardDraft=false,
//      activatedAt non-null AND dates cover `now` (Model 2 → freshest
//      activatedAt makes this the resolver winner), has MealPlanItem
//      + Meal + Dish + DishIngredient + RecipeInstructionStep rows,
//      and per-dish *PerServing macros are populated from the wizard
//      expand pass.
//   6. GET  /api/wizard/drafts                   — assert the activated row
//      no longer appears in the drafts list (isWizardDraft filter holds).
//   7. activity check — plan_activated_this_week emitted for the activated id.
//
// Real Anthropic API call — hits Sonnet for build-plans + expand, Haiku for
// the per-dish macro estimator (~3-8s for expand). Activation itself is
// pure DB work (no AI), so step 4 should be fast.
//
// Run:   pnpm --filter @workspace/api-server exec tsx scripts/ws7-5b-server-smoke.ts
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
const SMOKE_USER_ID = "smoke-ws7-5b-server-user";
const SMOKE_USER_EMAIL = "smoke+ws7-5b-server@kiwi.dev";

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
  activate: {
    ok: boolean;
    activatedPlanId?: string;
    revisionId?: number;
    latencyMs: number;
  };
  dbCheck: {
    ok: boolean;
    isWizardDraft?: boolean;
    activatedAt?: string | null;
    coversNow?: boolean;
    status?: string;
    itemCount?: number;
    mealsCreated?: number;
    dishesCreated?: number;
    dishIngredientsCreated?: number;
    recipeStepsCreated?: number;
    dishesWithMacros?: number;
  };
  draftsListExcludesActivated: { ok: boolean; foundInDrafts: boolean };
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
      lastName: "WizardActivate",
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
    activate: { ok: false, latencyMs: 0 },
    dbCheck: { ok: false },
    draftsListExcludesActivated: { ok: false, foundInDrafts: true },
    activityEventEmitted: { ok: false },
    cleanupPlanId: null,
  };

  try {
    console.log("══════════════════════════════════════════════════════════");
    console.log("WS7-5b-server smoke — wizard draft activation end-to-end");
    console.log("══════════════════════════════════════════════════════════");

    // ── 1. build-plans ────────────────────────────────────────────────
    console.log("\n[1/7] POST /wizard/build-plans");
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
    console.log(`\n[2/7] POST /wizard/expand  candidate="${chosen.title}"`);
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
    console.log(`\n[3/7] GET /wizard/drafts/${draftId}`);
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

    // ── 4. POST /wizard/drafts/:id/activate ──────────────────────────
    console.log(`\n[4/7] POST /wizard/drafts/${draftId}/activate`);
    const actStart = Date.now();
    const actRes = await fetch(
      `${harness.baseUrl}/wizard/drafts/${draftId}/activate`,
      { method: "POST", headers: jsonAuth },
    );
    const actLatency = Date.now() - actStart;
    const actBody = (await actRes.json()) as {
      instance?: { id: string; revisionId: number };
      error?: string;
      reason?: string;
    };
    if (actRes.status !== 201 || !actBody.instance) {
      console.error(
        `  ✗ activate failed: ${actRes.status} ${actBody.error} ${actBody.reason ?? ""}`,
      );
      throw new Error("activate failed");
    }
    report.activate = {
      ok: true,
      activatedPlanId: actBody.instance.id,
      revisionId: actBody.instance.revisionId,
      latencyMs: actLatency,
    };
    console.log(
      `  ✓ instanceId=${actBody.instance.id}  revisionId=${actBody.instance.revisionId}  ${actLatency}ms`,
    );

    // ── 5. DB check — meal graph materialized + draft flag cleared ───
    console.log("\n[5/7] DB check — materialized rows + flipped flags");
    const activated = await prisma.mealPlanInstance.findUnique({
      where: { id: actBody.instance.id },
      select: {
        isWizardDraft: true,
        // WS7-6 (E) Block 1 REWORK: isActiveThisWeek column dropped; the
        // activate seam now stamps activatedAt + sets covering dates.
        activatedAt: true,
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
    if (!activated) {
      console.error("  ✗ activated plan row not found by id");
      throw new Error("activated row missing");
    }
    const itemCount = activated.items.length;
    const mealsCreated = new Set(activated.items.map((i) => i.mealId)).size;
    const allDishes = activated.items.flatMap((i) =>
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

    // WS7-6 (E) Block 1 REWORK — Model 2 activate assertion: the row must
    // have isWizardDraft=false, activatedAt set (seam C stamp), and the
    // dates covering `now` (current Sun-Sat week). Together these make
    // the row the resolver winner (freshest activatedAt among covering
    // rows) so the wire boolean ships true wherever it appears.
    const nowAtCheck = new Date();
    const coversNow =
      activated.startDate !== null &&
      activated.endDate !== null &&
      activated.startDate.getTime() <= nowAtCheck.getTime() &&
      nowAtCheck.getTime() <= activated.endDate.getTime();
    report.dbCheck = {
      ok:
        activated.isWizardDraft === false &&
        activated.activatedAt !== null &&
        coversNow &&
        itemCount > 0 &&
        dishesCreated > 0 &&
        dishIngredientsCreated > 0 &&
        recipeSteps > 0,
      isWizardDraft: activated.isWizardDraft,
      activatedAt: activated.activatedAt?.toISOString() ?? null,
      coversNow,
      status: activated.status,
      itemCount,
      mealsCreated,
      dishesCreated,
      dishIngredientsCreated,
      recipeStepsCreated: recipeSteps,
      dishesWithMacros,
    };
    console.log(
      `  ${report.dbCheck.ok ? "✓" : "✗"} isWizardDraft=${activated.isWizardDraft}  activatedAt=${activated.activatedAt?.toISOString() ?? "null"}  coversNow=${coversNow}  status=${activated.status}`,
    );
    console.log(
      `       items=${itemCount}  meals=${mealsCreated}  dishes=${dishesCreated}  dishIngredients=${dishIngredientsCreated}  steps=${recipeSteps}  withMacros=${dishesWithMacros}/${dishesCreated}`,
    );

    // ── 6. /wizard/drafts no longer lists it ─────────────────────────
    console.log("\n[6/7] GET /wizard/drafts  — assert activated is excluded");
    const dRes = await fetch(`${harness.baseUrl}/wizard/drafts`, {
      headers: auth,
    });
    const dBody = (await dRes.json()) as {
      drafts: Array<{ id: string }>;
    };
    const found = dBody.drafts.some((d) => d.id === actBody.instance!.id);
    report.draftsListExcludesActivated = { ok: !found, foundInDrafts: found };
    console.log(
      `  ${!found ? "✓" : "✗"} excluded — drafts.length=${dBody.drafts.length}  foundActivated=${found}`,
    );

    // ── 7. activity event ────────────────────────────────────────────
    console.log("\n[7/7] activity check — plan_activated_this_week");
    const activity = await prisma.userActivity.findFirst({
      where: {
        userId: SMOKE_USER_ID,
        eventType: "plan_activated_this_week",
        entityId: actBody.instance.id,
      },
      orderBy: { createdAt: "desc" },
    });
    report.activityEventEmitted = { ok: activity !== null };
    console.log(`  ${activity ? "✓" : "✗"} plan_activated_this_week event present`);
  } finally {
    await harness.close();
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("REPORT");
  console.log("══════════════════════════════════════════════════════════");
  console.log(JSON.stringify(report, null, 2));

  // Cleanup — delete the activated plan + cascade. Keep LLMCallLog rows
  // for cost audit. Note: cascading delete also clears MealPlanItem rows,
  // but Meal / Dish / Ingredient rows persist (intentional — Ingredient
  // upserts are shared, Meal/Dish may be referenced by other future plans).
  // The smoke is single-user so this is fine; repeat runs will create new
  // Meal/Dish/MealPlanItem rows each time without conflicting.
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
    report.activate.ok &&
    report.dbCheck.ok &&
    report.draftsListExcludesActivated.ok &&
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
