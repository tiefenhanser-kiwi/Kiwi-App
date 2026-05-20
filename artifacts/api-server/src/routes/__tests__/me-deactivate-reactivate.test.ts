// WS7-2 Block A — POST /me/deactivate + POST /me/reactivate.
// 7 tests: deactivate (happy + plan-instances flip / idempotent / 401 /
// blocked-or-deleted 400) + reactivate (happy / TTL expired / not-paused).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { hashPassword, signToken } from "../../lib/auth";
import { createMeRouter } from "../me";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

interface UserRow {
  id: string;
  email: string;
  passwordHash: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  zipCode: string | null;
  timezone: string;
  accountStatus: "active" | "paused" | "deleted" | "blocked";
  subscriptionStatus: string;
  defaultHouseholdSize: number;
  customerEndDate: Date | null;
  lastPlanDiscoveryFilters: string[];
  lastPlansFilters: string[];
  lastMealsFilters: string[];
  onboardingComplete: boolean;
  firstRunChoiceMade: boolean;
  createdAt: Date;
  subscription?: {
    status: string;
    planCode: string;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
  } | null;
}

interface PlanRow {
  id: string;
  userId: string;
  status: "draft" | "this_week" | "next_week" | "upcoming" | "past";
}

function baseUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u-deact",
    email: "deact@example.com",
    passwordHash: null,
    firstName: "Dee",
    lastName: "Activate",
    phone: null,
    zipCode: null,
    timezone: "America/New_York",
    accountStatus: "active",
    subscriptionStatus: "trialing",
    defaultHouseholdSize: 2,
    customerEndDate: null,
    lastPlanDiscoveryFilters: [],
    lastPlansFilters: [],
    lastMealsFilters: [],
    onboardingComplete: true,
    firstRunChoiceMade: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    subscription: {
      status: "trialing",
      planCode: "free",
      trialEndsAt: new Date("2026-12-31T00:00:00Z"),
      currentPeriodEnd: null,
    },
    ...overrides,
  };
}

function makeStubPrisma(opts: { users: UserRow[]; plans?: PlanRow[] }) {
  let users = opts.users.map((u) => ({ ...u }));
  let plans = (opts.plans ?? []).map((p) => ({ ...p }));

  const userOps = {
    findUnique: async ({
      where,
      include,
    }: {
      where: { id?: string; email?: string };
      include?: { subscription?: boolean };
      select?: unknown;
    }): Promise<UserRow | null> => {
      const u =
        users.find((x) =>
          where.id ? x.id === where.id : x.email === where.email,
        ) ?? null;
      if (!u) return null;
      // Mock `include: { subscription }` by leaving the field on the row;
      // if include is absent, strip it (matches Prisma's behavior closely
      // enough for these tests).
      if (include?.subscription) return u;
      const { subscription: _drop, ...rest } = u;
      return rest as UserRow;
    },
    update: async ({
      where,
      data,
      include,
    }: {
      where: { id: string };
      data: Partial<UserRow>;
      include?: { subscription?: boolean };
    }): Promise<UserRow> => {
      const idx = users.findIndex((x) => x.id === where.id);
      if (idx === -1) throw new Error("user not found");
      users[idx] = { ...users[idx], ...data };
      const u = users[idx];
      if (include?.subscription) return u;
      const { subscription: _d, ...rest } = u;
      return rest as UserRow;
    },
  };

  const mealPlanInstanceOps = {
    updateMany: async ({
      where,
      data,
    }: {
      where: {
        userId: string;
        status?: { in: string[] };
      };
      data: { status: string };
    }): Promise<{ count: number }> => {
      let count = 0;
      for (const p of plans) {
        if (p.userId !== where.userId) continue;
        if (where.status?.in && !where.status.in.includes(p.status)) continue;
        p.status = data.status as PlanRow["status"];
        count++;
      }
      return { count };
    },
  };

  // Minimal $transaction stub that executes the array of operations
  // sequentially. The real implementation supplies a tx PrismaClient,
  // but since we passed pre-baked promise-returning ops above, we just
  // await them in order.
  const tx = async (ops: Promise<unknown>[]) => {
    const out: unknown[] = [];
    for (const op of ops) out.push(await op);
    return out;
  };

  return {
    user: userOps,
    mealPlanInstance: mealPlanInstanceOps,
    $transaction: tx,
    _users: () => users,
    _plans: () => plans,
  };
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma: prisma as never }));
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

const USER_ID = "u-deact";

describe("POST /me/deactivate", () => {
  it("happy: flips accountStatus to paused, sets customerEndDate, flips active plans to past", async () => {
    const prisma = makeStubPrisma({
      users: [baseUser({ id: USER_ID })],
      plans: [
        { id: "p1", userId: USER_ID, status: "this_week" },
        { id: "p2", userId: USER_ID, status: "upcoming" },
        { id: "p3", userId: USER_ID, status: "past" }, // already past — untouched
        { id: "p4", userId: USER_ID, status: "draft" }, // draft — untouched
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/deactivate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const u = prisma._users().find((x) => x.id === USER_ID)!;
      assert.equal(u.accountStatus, "paused");
      assert.ok(u.customerEndDate);

      const statuses = prisma._plans().map((p) => p.status);
      assert.deepEqual(statuses, ["past", "past", "past", "draft"]);
    } finally {
      await harness.close();
    }
  });

  it("idempotent: deactivating an already-paused account returns success", async () => {
    const prisma = makeStubPrisma({
      users: [
        baseUser({
          id: USER_ID,
          accountStatus: "paused",
          customerEndDate: new Date("2026-04-01T00:00:00Z"),
        }),
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/deactivate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      // customerEndDate was preserved (not overwritten on the no-op path).
      const u = prisma._users().find((x) => x.id === USER_ID)!;
      assert.equal(
        u.customerEndDate?.toISOString(),
        "2026-04-01T00:00:00.000Z",
      );
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when no auth header is present", async () => {
    const prisma = makeStubPrisma({ users: [baseUser({ id: USER_ID })] });
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/deactivate`, {
        method: "POST",
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 cannot_deactivate when the account is already deleted", async () => {
    const prisma = makeStubPrisma({
      users: [baseUser({ id: USER_ID, accountStatus: "deleted" })],
    });
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/deactivate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "cannot_deactivate");
    } finally {
      await harness.close();
    }
  });
});

describe("POST /me/reactivate", () => {
  it("happy: flips paused -> active within 6mo, returns user + authToken", async () => {
    const passwordHash = await hashPassword("right-password-1");
    const prisma = makeStubPrisma({
      users: [
        baseUser({
          id: USER_ID,
          email: "deact@example.com",
          passwordHash,
          accountStatus: "paused",
          // Deactivated 30 days ago — well inside the 6mo window.
          customerEndDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        }),
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/reactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "deact@example.com",
          password: "right-password-1",
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        user: {
          id: string;
          accountStatus: string;
          subscription: { planCode: string };
        };
        authToken: string;
      };
      assert.equal(body.user.accountStatus, "active");
      assert.equal(body.user.subscription.planCode, "free");
      assert.ok(body.authToken);
      const u = prisma._users().find((x) => x.id === USER_ID)!;
      assert.equal(u.accountStatus, "active");
      assert.equal(u.customerEndDate, null);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 reactivation_window_expired past the 6mo TTL", async () => {
    const passwordHash = await hashPassword("right-password-2");
    const prisma = makeStubPrisma({
      users: [
        baseUser({
          id: USER_ID,
          email: "stale@example.com",
          passwordHash,
          accountStatus: "paused",
          // 200 days ago — past 6mo (~183 days).
          customerEndDate: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
        }),
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/reactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "stale@example.com",
          password: "right-password-2",
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "reactivation_window_expired");
      // Account remains paused.
      assert.equal(
        prisma._users().find((x) => x.id === USER_ID)!.accountStatus,
        "paused",
      );
    } finally {
      await harness.close();
    }
  });

  it("returns 400 not_paused when the account is not in the paused state", async () => {
    const passwordHash = await hashPassword("right-password-3");
    const prisma = makeStubPrisma({
      users: [
        baseUser({
          id: USER_ID,
          email: "active@example.com",
          passwordHash,
          accountStatus: "active",
        }),
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/reactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "active@example.com",
          password: "right-password-3",
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "not_paused");
    } finally {
      await harness.close();
    }
  });
});
