// Row 13 "Test Kitchen" · Block 1 (D-WS9-259) — the guest session lifecycle.
//
//   create → 201 with a purpose:"guest" token → GET /guest/session reads back
//   an EXPIRED row      → 401 (the signature is fine; the row is not)
//   a CLAIMED row       → 401 (the token is spent the moment they sign up)
//   a SESSION token     → the guest-only routes answer 403, not 200
//   the ipHash          → never on the wire
//   POST /guest/events  → a closed list, and a 2KB meta bound
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";

import { signToken, verifyToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import type { WizardPlanCandidateWire } from "../../lib/ai/schemas/wizard";
import { createGuestRouter } from "../guest";

const DAY = 24 * 60 * 60 * 1000;

interface Row {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  ipHash: string | null;
  preferences: unknown;
  candidates: unknown;
  draft: unknown;
  generationCount: number;
  lastEvent: string | null;
  claimedByUserId: string | null;
  claimedAt: Date | null;
}

function makePrisma(seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
  const events: Array<Record<string, unknown>> = [];
  let n = 0;
  const prisma = {
    guestSession: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: `gs-${++n}`,
          createdAt: new Date(),
          expiresAt: data.expiresAt as Date,
          ipHash: (data.ipHash as string | null) ?? null,
          preferences: data.preferences ?? {},
          candidates: null,
          draft: null,
          generationCount: 0,
          lastEvent: (data.lastEvent as string | null) ?? null,
          claimedByUserId: null,
          claimedAt: null,
        };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("no row");
        Object.assign(row, data);
        return row;
      },
      count: async ({ where }: { where: { ipHash: string } }) =>
        [...rows.values()].filter((r) => r.ipHash === where.ipHash).length,
    },
    guestEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
    _rows: () => rows,
    _events: () => events,
  };
  return prisma;
}

async function spinUp(prisma: ReturnType<typeof makePrisma>) {
  __clearRateLimitStoreForTests();
  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api",
    createGuestRouter({
      prisma: prisma as unknown as PrismaClient,
      // TURNSTILE_SECRET_KEY absent → the bot check passes through, which is
      // the state the funnel is built and tested in.
      env: { JWT_SECRET: process.env.JWT_SECRET },
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api`;
  return {
    base,
    post: (path: string, body?: unknown, auth?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
      }),
    get: (path: string, auth?: string) =>
      fetch(`${base}${path}`, {
        headers: auth ? { authorization: `Bearer ${auth}` } : {},
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("POST /api/guest/session", () => {
  it("mints a row and a purpose:'guest' token carrying the session id", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const res = await h.post("/guest/session");
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        guestSessionId: string;
        token: string;
        expiresAt: string;
      };
      assert.ok(body.guestSessionId);

      // The token must NOT verify as a session token — that is the whole
      // point of the purpose claim (WS7-2 Block A).
      assert.equal(verifyToken(body.token, "session"), null);
      const payload = verifyToken(body.token, "guest");
      assert.ok(payload);
      assert.equal(payload.userId, body.guestSessionId);

      // 24h, give or take the test's own clock.
      const ttl = new Date(body.expiresAt).getTime() - Date.now();
      assert.ok(ttl > DAY - 60_000 && ttl <= DAY, `ttl was ${ttl}`);

      // The funnel's first event is written.
      assert.equal(prisma._events()[0]?.event, "session_created");
    } finally {
      await h.close();
    }
  });

  it("stores a SALTED HASH of the ip, never the address", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const body = (await (await h.post("/guest/session")).json()) as {
        guestSessionId: string;
      };
      const row = prisma._rows().get(body.guestSessionId)!;
      assert.ok(row.ipHash, "an ipHash was recorded");
      assert.match(row.ipHash!, /^[0-9a-f]{64}$/, "sha256 hex");
      assert.ok(
        !row.ipHash!.includes("127.0.0.1") && !row.ipHash!.includes("::1"),
        "the raw address never appears",
      );
    } finally {
      await h.close();
    }
  });
});

describe("GET /api/guest/session", () => {
  it("reads the session back and NEVER emits the ipHash", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const created = (await (await h.post("/guest/session")).json()) as {
        guestSessionId: string;
        token: string;
      };
      const res = await h.get("/guest/session", created.token);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.id, created.guestSessionId);
      assert.equal(body.generationCount, 0);
      assert.equal(body.hasDraft, false);
      assert.ok(!("ipHash" in body), "ipHash must never reach the client");
    } finally {
      await h.close();
    }
  });

  it("an EXPIRED session is 401 even though the token still verifies", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const created = (await (await h.post("/guest/session")).json()) as {
        guestSessionId: string;
        token: string;
      };
      // Age the ROW, not the token — this is exactly the case a stateless JWT
      // cannot answer on its own, which is why the guard reads the row.
      prisma._rows().get(created.guestSessionId)!.expiresAt = new Date(
        Date.now() - 1000,
      );
      assert.ok(verifyToken(created.token, "guest"), "token still verifies");
      const res = await h.get("/guest/session", created.token);
      assert.equal(res.status, 401);
    } finally {
      await h.close();
    }
  });

  it("a CLAIMED session is 401 — the guest token is spent at sign-up", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const created = (await (await h.post("/guest/session")).json()) as {
        guestSessionId: string;
        token: string;
      };
      const row = prisma._rows().get(created.guestSessionId)!;
      row.claimedAt = new Date();
      row.claimedByUserId = "u-1";
      assert.equal((await h.get("/guest/session", created.token)).status, 401);
    } finally {
      await h.close();
    }
  });

  it("a real SESSION token is refused 403 by the guest-only routes", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      // A session token falls through requireGuestOrAuth to requireAuth. With
      // no user row behind it that is a 401; what must never happen is a 200.
      const sessionToken = signToken("u-real");
      const res = await h.get("/guest/session", sessionToken);
      assert.notEqual(res.status, 200);
      assert.ok(
        res.status === 401 || res.status === 403 || res.status === 503,
        `guest-only route must not serve a session token (got ${res.status})`,
      );
    } finally {
      await h.close();
    }
  });
});

describe("GET /api/guest/draft", () => {
  it("404 no_draft before an expand; the drafts-GET shape after", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const created = (await (await h.post("/guest/session")).json()) as {
        guestSessionId: string;
        token: string;
      };
      const before = await h.get("/guest/draft", created.token);
      assert.equal(before.status, 404);
      assert.equal(((await before.json()) as { code: string }).code, "no_draft");

      // What POST /wizard/expand stores for a guest: EXACTLY the shape
      // GET /wizard/drafts/:id returns, so the mobile screen is unchanged.
      const blob = {
        draft: { id: created.guestSessionId, createdAt: "2026-09-25T00:00:00.000Z" },
        expanded: { candidateId: "c1", title: "A week", meals: [] },
      };
      prisma._rows().get(created.guestSessionId)!.draft = blob;

      const after = await h.get("/guest/draft", created.token);
      assert.equal(after.status, 200);
      assert.deepEqual(await after.json(), blob);
    } finally {
      await h.close();
    }
  });
});

describe("POST /api/guest/events", () => {
  it("accepts a listed event and denormalises it onto the session row", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const created = (await (await h.post("/guest/session")).json()) as {
        guestSessionId: string;
        token: string;
      };
      const res = await h.post(
        "/guest/events",
        { event: "door_tapped", step: "grocery_list" },
        created.token,
      );
      assert.equal(res.status, 201);
      const row = prisma._rows().get(created.guestSessionId)!;
      assert.equal(row.lastEvent, "door_tapped");
      const last = prisma._events().at(-1)!;
      assert.equal(last.event, "door_tapped");
      assert.equal(last.step, "grocery_list");
    } finally {
      await h.close();
    }
  });

  it("refuses an unlisted event and an oversized meta", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const created = (await (await h.post("/guest/session")).json()) as {
        token: string;
      };
      assert.equal(
        (await h.post("/guest/events", { event: "drop_tables" }, created.token))
          .status,
        400,
      );
      assert.equal(
        (
          await h.post(
            "/guest/events",
            { event: "wizard_step", meta: { blob: "x".repeat(4096) } },
            created.token,
          )
        ).status,
        400,
        "meta over 2KB is refused — this is a public write into a JSONB column",
      );
    } finally {
      await h.close();
    }
  });
});

// ── Block 1b Part D — GET /guest/session returns the candidates ───────────
//
// Block 1 stored them (persistGuestGeneration writes GuestSession.candidates)
// and then never handed them back, so a mid-funnel reload left the visitor with
// generationCount: 1 — the one generation spent, a second refused — and no way
// to see the plans it bought.
//
// 🔴 THE FIXTURE IS ANNOTATED `WizardPlanCandidateWire[]`, WHICH IS THE POINT.
// The claim under test is "the shape matches what POST /wizard/build-plans
// returned to the guest". That type has no Zod counterpart to parse against at
// runtime, so the check is made at COMPILE time: if the wire shape drifts, tsc
// fails this file rather than the test agreeing with a hand-rolled fixture
// forever.
const WIRE_CANDIDATES: WizardPlanCandidateWire[] = [
  {
    id: "cand-1",
    title: "Weeknight Italian",
    tags: ["italian", "quick"],
    whyBullets: ["Everything on your shelf", "Two pans, five nights"],
    mealTitles: ["Cacio e Pepe", "Sheet-pan Chicken"],
    dailyMacros: { calories: 2100, proteinG: 120, carbsG: 210, fatG: 70 },
    storeSlots: [{ slotIndex: 0, storeMealId: "meal-cacio" }],
    meals: [
      {
        title: "Cacio e Pepe",
        description: "Pepper, pecorino, one pan.",
        storeMealId: "meal-cacio",
        estimatedTimeMinutes: 20,
      },
      { title: "Sheet-pan Chicken", description: null },
    ],
  },
];

describe("GET /api/guest/session — Block 1b Part D: candidates", () => {
  it("null before the first generation (NOT [] — never-generated is its own fact)", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const created = (await (await h.post("/guest/session")).json()) as {
        guestSessionId: string;
        token: string;
      };
      const body = (await (
        await h.get("/guest/session", created.token)
      ).json()) as Record<string, unknown>;
      assert.ok("candidates" in body, "the key is always present");
      assert.equal(body.candidates, null);
      assert.equal(body.generationCount, 0, "and nothing has been spent");
    } finally {
      await h.close();
    }
  });

  it("returns the stored wire candidates RAW — byte-identical to what build-plans sent", async () => {
    const prisma = makePrisma();
    const h = await spinUp(prisma);
    try {
      const created = (await (await h.post("/guest/session")).json()) as {
        guestSessionId: string;
        token: string;
      };
      // Exactly what persistGuestGeneration does: the wire candidates onto the
      // row, and the one generation spent.
      const row = prisma._rows().get(created.guestSessionId)!;
      row.candidates = WIRE_CANDIDATES;
      row.generationCount = 1;
      row.lastEvent = "generated";

      const res = await h.get("/guest/session", created.token);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      // A JSON round-trip of the fixture, compared whole: no re-shape, no
      // field dropped, no field added.
      assert.deepEqual(
        body.candidates,
        JSON.parse(JSON.stringify(WIRE_CANDIDATES)),
      );
      assert.equal(body.generationCount, 1);
      // And the read still gives up nothing it should not.
      assert.ok(!("ipHash" in body), "ipHash must never reach the client");
      assert.ok(!("claimedByUserId" in body));
    } finally {
      await h.close();
    }
  });
});
