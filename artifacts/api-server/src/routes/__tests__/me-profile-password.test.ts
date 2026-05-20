// WS7-2 Block A — PATCH /me/profile and PATCH /me/password tests.
// 8 tests: profile (happy / missing-field 400 / partial / 401) +
//          password (happy / wrong-current 400 / too-short-new 400 / 401).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { hashPassword } from "../../lib/auth";
import { signToken } from "../../lib/auth";
import { createMeRouter } from "../me";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
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

interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  zipCode: string | null;
  timezone: string;
  accountStatus: string;
  subscriptionStatus: string;
  defaultHouseholdSize: number;
  lastPlanDiscoveryFilters: string[];
  lastPlansFilters: string[];
  lastMealsFilters: string[];
  onboardingComplete: boolean;
  firstRunChoiceMade: boolean;
  passwordHash: string | null;
  createdAt: Date;
}

function baseUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u-profile",
    email: "profile@example.com",
    firstName: "Sage",
    lastName: "Tester",
    phone: null,
    zipCode: null,
    timezone: "America/New_York",
    accountStatus: "active",
    subscriptionStatus: "trialing",
    defaultHouseholdSize: 2,
    lastPlanDiscoveryFilters: [],
    lastPlansFilters: [],
    lastMealsFilters: [],
    onboardingComplete: true,
    firstRunChoiceMade: true,
    passwordHash: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeStubPrisma(initial: UserRow) {
  let row: UserRow = { ...initial };
  return {
    user: {
      findUnique: async ({
        where,
      }: {
        where: { id: string };
        select?: unknown;
      }): Promise<UserRow | null> => {
        return where.id === row.id ? row : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<UserRow>;
        select?: unknown;
      }): Promise<UserRow> => {
        if (where.id !== row.id) throw new Error("user not found");
        row = { ...row, ...data };
        return row;
      },
    },
    _row: () => row,
  };
}

const USER_ID = "u-profile";

describe("PATCH /me/profile", () => {
  it("happy: updates firstName + lastName + phone and returns the user", async () => {
    const prisma = makeStubPrisma(baseUser({ id: USER_ID }));
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/profile`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          firstName: "Kiwi",
          lastName: "Eater",
          phone: "(555) 123-4567",
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        user: { firstName: string; lastName: string; phone: string };
      };
      assert.equal(body.user.firstName, "Kiwi");
      assert.equal(body.user.lastName, "Eater");
      assert.equal(body.user.phone, "(555) 123-4567");
    } finally {
      await harness.close();
    }
  });

  it("happy: applies a partial update (only lastName)", async () => {
    const prisma = makeStubPrisma(
      baseUser({ id: USER_ID, firstName: "Hans", lastName: "Old" }),
    );
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/profile`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ lastName: "New" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        user: { firstName: string; lastName: string };
      };
      assert.equal(body.user.firstName, "Hans");
      assert.equal(body.user.lastName, "New");
    } finally {
      await harness.close();
    }
  });

  it("returns 400 when no fields are supplied", async () => {
    const prisma = makeStubPrisma(baseUser({ id: USER_ID }));
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/profile`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when no auth header is present", async () => {
    const prisma = makeStubPrisma(baseUser({ id: USER_ID }));
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName: "Anon" }),
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

describe("PATCH /me/password", () => {
  it("happy: verifies current then updates the hash", async () => {
    const passwordHash = await hashPassword("oldpass-12345");
    const prisma = makeStubPrisma(baseUser({ id: USER_ID, passwordHash }));
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/password`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          currentPassword: "oldpass-12345",
          newPassword: "newpass-67890",
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { success: boolean };
      assert.equal(body.success, true);
      // Stored hash should differ from the seed value.
      assert.notEqual(prisma._row().passwordHash, passwordHash);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 + invalid_current_password code when currentPassword is wrong", async () => {
    const passwordHash = await hashPassword("right-password-1");
    const prisma = makeStubPrisma(baseUser({ id: USER_ID, passwordHash }));
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/password`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          currentPassword: "wrong-guess-1",
          newPassword: "doesnt-matter-yet",
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as {
        error: string;
        userFacingMessage: string;
      };
      assert.equal(body.error, "invalid_current_password");
      assert.match(body.userFacingMessage, /incorrect/i);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 when newPassword is shorter than 8 chars", async () => {
    const passwordHash = await hashPassword("oldpass-12345");
    const prisma = makeStubPrisma(baseUser({ id: USER_ID, passwordHash }));
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/password`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          currentPassword: "oldpass-12345",
          newPassword: "short",
        }),
      });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when no auth header is present", async () => {
    const prisma = makeStubPrisma(baseUser({ id: USER_ID }));
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/password`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: "a",
          newPassword: "12345678",
        }),
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});
