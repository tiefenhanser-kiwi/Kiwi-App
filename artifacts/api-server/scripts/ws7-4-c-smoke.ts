// WS7-4-C c7 — Live smoke for the empty-plan create / edit / compost flow.
//
// In-process HTTP (no separate api-server). Spins up Express with the
// production plans router, mints a JWT for the dev user, exercises:
//
//   POST /plans (empty plan) -> PATCH name-only -> PATCH dates + status
//     -> PATCH activate -> PATCH name again -> DELETE -> GET /plans
//
// Plus the matching UserActivity assertions for each step's emission
// pattern (Q-P0-2 mapping).
//
// Idempotent teardown at end. Exits non-zero on any assertion failure.
//
// Run:
//   pnpm --filter @workspace/api-server exec tsx scripts/ws7-4-c-smoke.ts
//
// Prereq: prisma:seed (AIPrompts) AND prisma:seed:dev (Hans's user).

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

const C7_SMOKE_EVENT_TYPES = [
  "plan_created",
  "plan_name_edited",
  "plan_date_range_edited",
  "plan_status_changed",
  "plan_activated_this_week",
  "plan_composted",
] as const;

async function main(): Promise<number> {
  const harness = await spinUp();
  let createdInstanceId: string | null = null;
  let priorActiveInstanceId: string | null = null;

  try {
    const user = await prisma.user.findUnique({
      where: { email: DEV_USER_EMAIL },
    });
    if (!user) throw new Error(`Dev user not found: ${DEV_USER_EMAIL}`);
    const token = signToken(user.id);
    const authHeader = { Authorization: `Bearer ${token}` };

    // Capture prior active so we can restore it after we demote it in step 5.
    const priorActive = await prisma.mealPlanInstance.findFirst({
      where: { userId: user.id, isActiveThisWeek: true },
      select: { id: true },
    });
    priorActiveInstanceId = priorActive?.id ?? null;
    console.log(
      `[smoke] prior active instance: ${priorActiveInstanceId ?? "(none)"}`,
    );

    // 1) POST /plans -- create an empty plan.
    const createRes = await fetch(`${harness.baseUrl}/plans`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "WS7-4-C smoke", isActiveThisWeek: false }),
    });
    assertEq("POST /plans status", createRes.status, 201);
    const createBody = (await createRes.json()) as {
      instance: { id: string; revisionId: number };
    };
    createdInstanceId = createBody.instance.id;
    assertEq("created.revisionId = 1", createBody.instance.revisionId, 1);

    // 2) Confirm DB row + plan_created activity exists.
    const createdRow = await prisma.mealPlanInstance.findUnique({
      where: { id: createdInstanceId },
      select: {
        userId: true,
        titleOverride: true,
        mealPlanTemplateId: true,
        status: true,
        isActiveThisWeek: true,
      },
    });
    assertTrue("created row present in DB", createdRow !== null);
    assertEq("created.userId matches", createdRow!.userId, user.id);
    assertEq("created.titleOverride matches", createdRow!.titleOverride, "WS7-4-C smoke");
    assertEq("created.mealPlanTemplateId is null (Q-P1-1)", createdRow!.mealPlanTemplateId, null);
    assertEq("created.status = draft", createdRow!.status, "draft");
    assertEq("created.isActiveThisWeek = false", createdRow!.isActiveThisWeek, false);
    const createdActs = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: createdInstanceId, eventType: "plan_created" },
    });
    assertEq("plan_created activity count = 1", createdActs.length, 1);

    // 3) PATCH name only -- Ruling 8 carve-out: revisionId UNCHANGED.
    const patch1 = await fetch(`${harness.baseUrl}/plans/${createdInstanceId}`, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "WS7-4-C smoke 2" }),
    });
    assertEq("PATCH name-only status", patch1.status, 200);
    const patch1Body = (await patch1.json()) as {
      instance: { revisionId: number };
      macrosStale: boolean;
    };
    assertEq(
      "name-only PATCH leaves revisionId unchanged (Ruling 8)",
      patch1Body.instance.revisionId,
      1,
    );
    assertEq("macrosStale = false (empty plan, no items)", patch1Body.macrosStale, false);
    const nameEdits = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: createdInstanceId, eventType: "plan_name_edited" },
    });
    assertEq("plan_name_edited activity count = 1", nameEdits.length, 1);

    // 4) PATCH dates + status -- revisionId BUMPED, two activities.
    const patch2 = await fetch(`${harness.baseUrl}/plans/${createdInstanceId}`, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: "2026-06-01T00:00:00.000Z",
        status: "this_week",
      }),
    });
    assertEq("PATCH dates+status status", patch2.status, 200);
    const patch2Body = (await patch2.json()) as { instance: { revisionId: number } };
    assertEq("dates+status PATCH bumps revisionId 1 -> 2", patch2Body.instance.revisionId, 2);
    const dateEdits = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: createdInstanceId, eventType: "plan_date_range_edited" },
    });
    assertEq("plan_date_range_edited count = 1", dateEdits.length, 1);
    const statusChanges = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: createdInstanceId, eventType: "plan_status_changed" },
    });
    assertEq("plan_status_changed count = 1", statusChanges.length, 1);

    // 5) PATCH isActiveThisWeek=true -- prior actives demoted, activity fires.
    const patch3 = await fetch(`${harness.baseUrl}/plans/${createdInstanceId}`, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ isActiveThisWeek: true }),
    });
    assertEq("PATCH activate status", patch3.status, 200);
    const activations = await prisma.userActivity.findMany({
      where: {
        userId: user.id,
        entityId: createdInstanceId,
        eventType: "plan_activated_this_week",
      },
    });
    assertEq("plan_activated_this_week count = 1", activations.length, 1);
    // Verify prior active (if any) was demoted.
    if (priorActiveInstanceId) {
      const priorRow = await prisma.mealPlanInstance.findUnique({
        where: { id: priorActiveInstanceId },
        select: { isActiveThisWeek: true },
      });
      assertEq(
        "prior active was demoted",
        priorRow?.isActiveThisWeek ?? null,
        false,
      );
    }

    // 6) PATCH name again -- assert macrosStale: false (empty plan, Phase 2 ruling).
    const patch4 = await fetch(`${harness.baseUrl}/plans/${createdInstanceId}`, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "WS7-4-C smoke 3" }),
    });
    assertEq("PATCH name-again status", patch4.status, 200);
    const patch4Body = (await patch4.json()) as { macrosStale: boolean };
    assertEq(
      "macrosStale = false on empty plan (Phase 2 ruling)",
      patch4Body.macrosStale,
      false,
    );

    // 7) DELETE /plans/:id -- soft-delete (compost).
    const delRes = await fetch(`${harness.baseUrl}/plans/${createdInstanceId}`, {
      method: "DELETE",
      headers: authHeader,
    });
    assertEq("DELETE /plans/:id status", delRes.status, 200);
    const compostedRow = await prisma.mealPlanInstance.findUnique({
      where: { id: createdInstanceId },
      select: {
        status: true,
        compostedAt: true,
        isArchived: true,
        isActiveThisWeek: true,
      },
    });
    assertTrue("composted row still exists (soft delete)", compostedRow !== null);
    assertEq("composted.status = past", compostedRow!.status, "past");
    assertTrue("composted.compostedAt is set", compostedRow!.compostedAt !== null);
    assertEq("composted.isArchived = true", compostedRow!.isArchived, true);
    assertEq("composted.isActiveThisWeek auto-cleared", compostedRow!.isActiveThisWeek, false);
    const composts = await prisma.userActivity.findMany({
      where: { userId: user.id, entityId: createdInstanceId, eventType: "plan_composted" },
    });
    assertEq("plan_composted activity count = 1", composts.length, 1);

    // 8) GET /plans?filter=my_plans -- soft-deleted plan NOT in results.
    const listRes = await fetch(`${harness.baseUrl}/plans?filter=my_plans`, {
      headers: authHeader,
    });
    assertEq("GET /plans?filter=my_plans status", listRes.status, 200);
    const listBody = (await listRes.json()) as { plans: Array<{ id: string }> };
    const foundComposted = listBody.plans.some((p) => p.id === createdInstanceId);
    assertEq(
      "composted plan absent from my_plans listing",
      foundComposted,
      false,
    );

    console.log("\n[smoke] ALL CHECKS PASSED");
    return 0;
  } catch (err) {
    console.error(
      `\n[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    // Teardown — remove all c7 activities, then the soft-deleted instance,
    // then restore the prior active plan if there was one.
    if (createdInstanceId) {
      await prisma.userActivity.deleteMany({
        where: {
          entityId: createdInstanceId,
          eventType: { in: [...C7_SMOKE_EVENT_TYPES] },
        },
      });
      await prisma.mealPlanItem.deleteMany({
        where: { mealPlanInstanceId: createdInstanceId },
      });
      await prisma.mealPlanInstance.delete({
        where: { id: createdInstanceId },
      });
      console.log(`[teardown] deleted instance ${createdInstanceId}`);
    }
    if (priorActiveInstanceId) {
      await prisma.mealPlanInstance.update({
        where: { id: priorActiveInstanceId },
        data: { isActiveThisWeek: true },
      });
      console.log(
        `[teardown] restored prior active instance ${priorActiveInstanceId}`,
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
