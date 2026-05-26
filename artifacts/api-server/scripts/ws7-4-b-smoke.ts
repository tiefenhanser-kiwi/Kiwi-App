// WS7-4-B c14 — Live smoke for the Use Plan flow.
//
// In-process HTTP (no separate api-server). Spins up Express with the
// production plans router, mints a JWT for the dev user, exercises the
// full preview-then-use chain against the four c2-seeded discovery
// templates on real Neon.
//
// Sequence:
//   1) GET /plans?filter=featured           — pick the first template
//   2) GET /plans/templates/:id             — assert items + meals + notes
//   3) Snapshot Template.useCount + activeThisWeek (pre)
//   4) POST /plans/use-template/:templateId — assert 201, returns instanceId
//   5) GET /plans/:newInstanceId            — assert items copied 1:1
//   6) Direct prisma                         — assert useCount + 1,
//                                              UserActivity row written
//   7) Teardown: delete the created Instance + items + Activity row, and
//      restore the user's prior active plan (the use-template demotes it).
//
// Idempotent: teardown happens at script end. Exits non-zero on any
// assertion failure.
//
// Run:
//   pnpm --filter @workspace/api-server exec tsx scripts/ws7-4-b-smoke.ts
//
// Prereq: prisma:seed (AIPrompts) AND prisma:seed:dev (Hans's user +
// discovery templates).

import { PrismaClient } from "@prisma/client";
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
    throw new Error(`[FAIL] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`[ok] ${label} = ${JSON.stringify(actual)}`);
}

function assertTrue(label: string, cond: boolean, detail = ""): void {
  if (!cond) {
    throw new Error(`[FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`[ok] ${label}`);
}

async function main(): Promise<number> {
  const harness = await spinUp();
  let createdInstanceId: string | null = null;
  let priorActiveInstanceId: string | null = null;
  let templateId: string | null = null;
  let useCountBefore = 0;
  try {
    const user = await prisma.user.findUnique({ where: { email: DEV_USER_EMAIL } });
    if (!user) throw new Error(`Dev user not found: ${DEV_USER_EMAIL}`);
    const token = signToken(user.id);
    const authHeader = { Authorization: `Bearer ${token}` };

    // 1) GET /plans?filter=featured — pick the first template
    const listRes = await fetch(`${harness.baseUrl}/plans?filter=featured`, {
      headers: authHeader,
    });
    assertEq("GET /plans?filter=featured status", listRes.status, 200);
    const listBody = (await listRes.json()) as {
      plans: Array<{ id: string; source: string }>;
      activeThisWeek: { id: string } | null;
    };
    assertTrue(
      "featured list has >=1 template row",
      listBody.plans.length >= 1 && listBody.plans.some((p) => p.source === "template"),
    );
    const tmplRow = listBody.plans.find((p) => p.source === "template");
    templateId = tmplRow!.id;
    priorActiveInstanceId = listBody.activeThisWeek?.id ?? null;
    console.log(`[smoke] picked template: ${templateId}`);
    console.log(`[smoke] prior active instance: ${priorActiveInstanceId ?? "(none)"}`);

    // 2) GET /plans/templates/:id
    const detailRes = await fetch(`${harness.baseUrl}/plans/templates/${templateId}`, {
      headers: authHeader,
    });
    assertEq("GET /plans/templates/:id status", detailRes.status, 200);
    const detailBody = (await detailRes.json()) as {
      template: {
        id: string;
        title: string;
        items: Array<{ id: string; mealId: string; positionIndex: number; meal: unknown }>;
        optimizationNotes: unknown[];
      };
    };
    assertEq("template id matches", detailBody.template.id, templateId);
    assertTrue("template has items", detailBody.template.items.length > 0);
    assertTrue(
      "items are ordered by positionIndex",
      detailBody.template.items.every(
        (it, i, arr) => i === 0 || it.positionIndex >= arr[i - 1].positionIndex,
      ),
    );
    assertTrue(
      "every item has a non-null meal expansion",
      detailBody.template.items.every((it) => it.meal !== null),
      "expected composeMealDetail to populate every item",
    );
    assertTrue(
      "optimizationNotes is an array",
      Array.isArray(detailBody.template.optimizationNotes),
    );
    const expectedItemCount = detailBody.template.items.length;
    const expectedMealIds = detailBody.template.items.map((it) => it.mealId);

    // 3) Snapshot Template.useCount before
    const before = await prisma.mealPlanTemplate.findUnique({
      where: { id: templateId },
      select: { useCount: true, lastUsedAt: true },
    });
    if (!before) throw new Error("template missing from prisma read");
    useCountBefore = before.useCount;
    console.log(`[smoke] useCount before: ${useCountBefore}`);

    // 4) POST /plans/use-template/:templateId
    const useRes = await fetch(`${harness.baseUrl}/plans/use-template/${templateId}`, {
      method: "POST",
      headers: authHeader,
    });
    assertEq("POST /plans/use-template/:id status", useRes.status, 201);
    const useBody = (await useRes.json()) as { instance: { id: string; revisionId: number } };
    assertTrue("instance.id is non-empty", typeof useBody.instance.id === "string" && useBody.instance.id.length > 0);
    assertEq("instance.revisionId = 1 on fresh Instance", useBody.instance.revisionId, 1);
    createdInstanceId = useBody.instance.id;
    console.log(`[smoke] created instance: ${createdInstanceId}`);

    // 5) GET /plans/:newInstanceId — assert items copied 1:1
    const newPlanRes = await fetch(`${harness.baseUrl}/plans/${createdInstanceId}`, {
      headers: authHeader,
    });
    assertEq("GET /plans/:newInstanceId status", newPlanRes.status, 200);
    const newPlanBody = (await newPlanRes.json()) as {
      plan: {
        id: string;
        revisionId: number;
        isActiveThisWeek: boolean;
        optimizationNotes: unknown[];
        items: Array<{ mealId: string; positionIndex: number }>;
      };
    };
    assertEq("new plan id matches", newPlanBody.plan.id, createdInstanceId);
    assertEq("new plan revisionId = 1", newPlanBody.plan.revisionId, 1);
    assertEq("new plan isActiveThisWeek = true (Q-P1-4 ruling)", newPlanBody.plan.isActiveThisWeek, true);
    assertEq("item count matches template", newPlanBody.plan.items.length, expectedItemCount);
    const actualMealIds = newPlanBody.plan.items
      .slice()
      .sort((a, b) => a.positionIndex - b.positionIndex)
      .map((it) => it.mealId);
    assertTrue(
      "items copied in same order with same mealIds",
      JSON.stringify(actualMealIds) === JSON.stringify(expectedMealIds),
      `expected=${JSON.stringify(expectedMealIds)} actual=${JSON.stringify(actualMealIds)}`,
    );

    // 6) Direct prisma — useCount + activity
    const after = await prisma.mealPlanTemplate.findUnique({
      where: { id: templateId },
      select: { useCount: true, lastUsedAt: true },
    });
    if (!after) throw new Error("template disappeared mid-smoke");
    assertEq("Template.useCount incremented by 1", after.useCount, useCountBefore + 1);
    assertTrue(
      "Template.lastUsedAt updated",
      after.lastUsedAt !== null && (before.lastUsedAt === null || after.lastUsedAt > before.lastUsedAt),
    );

    const activities = await prisma.userActivity.findMany({
      where: {
        userId: user.id,
        eventType: "plan_used_from_browse",
        entityId: createdInstanceId,
      },
    });
    assertEq("UserActivity rows for this use", activities.length, 1);
    const meta = activities[0].metadata as { templateId: string; itemCount: number } | null;
    assertTrue("activity metadata.templateId present", meta?.templateId === templateId);
    assertEq("activity metadata.itemCount matches", meta?.itemCount, expectedItemCount);

    console.log("\n[smoke] ALL CHECKS PASSED");
    return 0;
  } catch (err) {
    console.error(`\n[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    // Teardown — remove the created instance (cascades to items via FK
    // onDelete: Cascade on MealPlanItem.planInstance) and the activity row,
    // and re-promote the prior active plan if there was one.
    if (createdInstanceId) {
      await prisma.userActivity.deleteMany({
        where: { entityId: createdInstanceId, eventType: "plan_used_from_browse" },
      });
      await prisma.mealPlanItem.deleteMany({
        where: { mealPlanInstanceId: createdInstanceId },
      });
      await prisma.mealPlanInstance.delete({ where: { id: createdInstanceId } });
      console.log(`[teardown] deleted instance ${createdInstanceId}`);
    }
    // Roll back the useCount increment so re-running the smoke doesn't
    // monotonically inflate the seed value.
    if (templateId) {
      await prisma.mealPlanTemplate.update({
        where: { id: templateId },
        data: { useCount: useCountBefore },
      });
      console.log(`[teardown] restored Template.useCount = ${useCountBefore}`);
    }
    if (priorActiveInstanceId) {
      await prisma.mealPlanInstance.update({
        where: { id: priorActiveInstanceId },
        data: { isActiveThisWeek: true },
      });
      console.log(`[teardown] restored prior active instance ${priorActiveInstanceId}`);
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
