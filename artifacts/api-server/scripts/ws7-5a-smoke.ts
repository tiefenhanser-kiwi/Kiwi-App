// WS7-5a smoke — wizard expand (Branch B) end-to-end.
//
// Exercises the server slice of the two-step wizard commit model
// (PRD §5.6 redline). Drives:
//   1. POST /api/wizard/build-plans      — generate 3 candidates (existing)
//   2. POST /api/wizard/expand           — expand 1 candidate, write hidden draft
//   3. GET  /api/wizard/drafts           — assert draft is returned
//   4. GET  /api/plans                   — assert draft is NOT in my_plans
//   5. (draft.isActiveThisWeek === false) and activeThisWeek excludes it
//
// Real Anthropic API call — hits Sonnet for build-plans + expand,
// Haiku for the per-dish macro estimator (~3-8s for expand).
//
// Run:   pnpm --filter @workspace/api-server exec tsx scripts/ws7-5a-smoke.ts
//
// Prereq: prisma:seed (for AIPrompts wizard.candidate.expand v1) AND
// migration 20260528120000_ws7_5a_wizard_draft applied. ANTHROPIC_API_KEY
// must be set.

import { PrismaClient } from "@prisma/client";
import express from "express";
import type { Server } from "node:http";

import { signToken } from "../src/lib/auth.ts";
import { createWizardRouter } from "../src/routes/wizard.ts";
import { createPlansRouter } from "../src/routes/plans.ts";

const prisma = new PrismaClient();
const SMOKE_USER_ID = "smoke-ws7-5a-user";
const SMOKE_USER_EMAIL = "smoke+ws7-5a@kiwi.dev";

interface SmokeReport {
  buildPlans: { ok: boolean; candidateCount: number; latencyMs: number };
  expand: {
    ok: boolean;
    draftId?: string;
    mealCount?: number;
    dishesTotal?: number;
    withMacros?: number;
    macroFails?: number;
    latencyMs: number;
  };
  draftsList: { ok: boolean; foundDraft: boolean; ttlDays?: number };
  myPlansExcludesDraft: { ok: boolean; planIds: string[] };
  draftIsActiveThisWeek: { ok: boolean; value?: boolean };
  activityEventEmitted: { ok: boolean };
  cleanupDraftId: string | null;
}

async function ensureSmokeUser(): Promise<void> {
  await prisma.user.upsert({
    where: { id: SMOKE_USER_ID },
    update: {},
    create: {
      id: SMOKE_USER_ID,
      email: SMOKE_USER_EMAIL,
      firstName: "Smoke",
      lastName: "WizardExpand",
      defaultHouseholdSize: 4,
    },
  });
}

async function spinUpServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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
    draftsList: { ok: false, foundDraft: false },
    myPlansExcludesDraft: { ok: false, planIds: [] },
    draftIsActiveThisWeek: { ok: false },
    activityEventEmitted: { ok: false },
    cleanupDraftId: null,
  };

  try {
    console.log("══════════════════════════════════════════════════════════");
    console.log("WS7-5a smoke — wizard expand (Branch B) end-to-end");
    console.log("══════════════════════════════════════════════════════════");

    // ── 1. build-plans ────────────────────────────────────────────────
    console.log("\n[1/5] POST /wizard/build-plans");
    const bpStart = Date.now();
    const bpRes = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        planDurationDays: 5,
        householdSize: 4,
        wantsLeftovers: true,
        cuisines: ["Italian", "Mediterranean"],
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
    for (const c of bpBody.candidates) {
      console.log(`    - "${c.title}" (${c.mealTitles.length} meals)`);
    }

    const chosen = bpBody.candidates[0];
    console.log(`\n[2/5] POST /wizard/expand  candidate="${chosen.title}"`);

    // ── 2. expand ────────────────────────────────────────────────────
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
      expanded?: {
        meals: Array<{
          title: string;
          dishes: Array<{
            ingredients: unknown[];
            steps: string[];
            macros: { caloriesPerServing: number; failed?: boolean } | null;
          }>;
        }>;
      };
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
    const withMacros = exBody.expanded.meals.reduce(
      (n, m) =>
        n + m.dishes.filter((d) => d.macros !== null && !d.macros.failed).length,
      0,
    );
    const macroFails = exBody.expanded.meals.reduce(
      (n, m) => n + m.dishes.filter((d) => d.macros?.failed).length,
      0,
    );
    const ingredientsTotal = exBody.expanded.meals.reduce(
      (n, m) => n + m.dishes.reduce((nn, d) => nn + d.ingredients.length, 0),
      0,
    );
    const stepsTotal = exBody.expanded.meals.reduce(
      (n, m) => n + m.dishes.reduce((nn, d) => nn + d.steps.length, 0),
      0,
    );
    report.expand = {
      ok: dishesTotal > 0 && ingredientsTotal > 0 && stepsTotal > 0,
      draftId: exBody.draft.id,
      mealCount: exBody.expanded.meals.length,
      dishesTotal,
      withMacros,
      macroFails,
      latencyMs: exLatency,
    };
    report.cleanupDraftId = exBody.draft.id;
    console.log(
      `  ✓ draftId=${exBody.draft.id}  meals=${exBody.expanded.meals.length}  dishes=${dishesTotal}  ingredients=${ingredientsTotal}  steps=${stepsTotal}  withMacros=${withMacros}/${dishesTotal}  fails=${macroFails}  ${exLatency}ms`,
    );

    // ── 3. /wizard/drafts returns it ─────────────────────────────────
    console.log("\n[3/5] GET /wizard/drafts");
    const dRes = await fetch(`${harness.baseUrl}/wizard/drafts`, {
      headers: auth,
    });
    const dBody = (await dRes.json()) as {
      drafts: Array<{ id: string; title: string; mealTitles: string[] }>;
      ttlDays: number;
    };
    const foundInDrafts = dBody.drafts.some((d) => d.id === exBody.draft!.id);
    report.draftsList = {
      ok: dRes.status === 200 && foundInDrafts,
      foundDraft: foundInDrafts,
      ttlDays: dBody.ttlDays,
    };
    console.log(
      `  ${foundInDrafts ? "✓" : "✗"} found=${foundInDrafts}  total=${dBody.drafts.length}  ttlDays=${dBody.ttlDays}`,
    );

    // ── 4. /plans (my_plans) does NOT return it ──────────────────────
    console.log("\n[4/5] GET /plans  — assert draft is excluded");
    const pRes = await fetch(`${harness.baseUrl}/plans`, { headers: auth });
    const pBody = (await pRes.json()) as {
      plans: Array<{ id: string; source: string }>;
      activeThisWeek: { id?: string } | null;
    };
    const planIds = pBody.plans.map((p) => p.id);
    const draftLeaked = planIds.includes(exBody.draft.id);
    report.myPlansExcludesDraft = { ok: !draftLeaked, planIds };
    console.log(
      `  ${!draftLeaked ? "✓" : "✗"} draftLeaked=${draftLeaked}  total_plans=${pBody.plans.length}`,
    );

    // ── 5. activeThisWeek != draft  +  DB-side row state ──────────────
    // WS7-6 (E) Block 1 REWORK: the isActiveThisWeek column is dropped.
    // Drafts are null-dated and the resolver never picks them as the
    // winner (covering requires non-null start/end). Assert that on
    // both: the activeThisWeek wire field excludes the draft id AND
    // the DB row remains a draft with null activatedAt.
    const activeLeaked = pBody.activeThisWeek?.id === exBody.draft.id;
    const draftRow = await prisma.mealPlanInstance.findUnique({
      where: { id: exBody.draft.id },
      select: {
        isWizardDraft: true,
        status: true,
        startDate: true,
        endDate: true,
        activatedAt: true,
      },
    });
    report.draftIsActiveThisWeek = {
      ok:
        !activeLeaked &&
        draftRow !== null &&
        draftRow.isWizardDraft === true &&
        draftRow.startDate === null &&
        draftRow.endDate === null &&
        draftRow.activatedAt === null,
      value: !activeLeaked,
    };
    console.log(
      `[5/5] DB check — isWizardDraft=${draftRow?.isWizardDraft}  status=${draftRow?.status}  dates=[${draftRow?.startDate?.toISOString() ?? "null"}..${draftRow?.endDate?.toISOString() ?? "null"}]  activatedAt=${draftRow?.activatedAt?.toISOString() ?? "null"}  activeLeaked=${activeLeaked}`,
    );

    // Activity event check.
    const lastActivity = await prisma.userActivity.findFirst({
      where: {
        userId: SMOKE_USER_ID,
        eventType: "wizard_candidate_expanded",
        entityId: exBody.draft.id,
      },
      orderBy: { createdAt: "desc" },
    });
    report.activityEventEmitted = { ok: lastActivity !== null };
    console.log(
      `       activity wizard_candidate_expanded for draftId — ${lastActivity ? "✓" : "✗"}`,
    );
  } finally {
    await harness.close();
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("REPORT");
  console.log("══════════════════════════════════════════════════════════");
  console.log(JSON.stringify(report, null, 2));

  // Cleanup — delete the draft + downstream activity rows so repeat runs
  // start clean. Keep the LLMCallLog rows; they're useful for cost audit.
  if (report.cleanupDraftId) {
    try {
      await prisma.mealPlanInstance.delete({
        where: { id: report.cleanupDraftId },
      });
      console.log(`\nCleaned up draft ${report.cleanupDraftId}.`);
    } catch (err) {
      console.warn(`Cleanup failed: ${(err as Error).message}`);
    }
  }

  const allOk =
    report.buildPlans.ok &&
    report.expand.ok &&
    report.draftsList.ok &&
    report.myPlansExcludesDraft.ok &&
    report.draftIsActiveThisWeek.ok &&
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
