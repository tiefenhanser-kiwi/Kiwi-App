// WS6 6c-2-fix — integration test mounting the FULL app middleware chain.
//
// The sibling recipes-import-image.test.ts mounts only the router. That
// bypasses src/app.ts's global express.json() and so cannot catch a 413
// thrown by a default-limit global parser running before the route-scoped
// 35mb parser (the bug 6c-2-fix patches).
//
// This file imports src/app.ts so the request traverses every app-level
// middleware exactly as it does in production, then sends a body well over
// the 100KB default limit. We only assert that the request reaches the
// route handler — AI behaviour beyond that point is covered by the 159
// existing route-level tests.
//
// Same prisma + fetch stub strategy as the route-level test file
// (D-WS6-038 / D-WS6-045) since recipes.ts is not factory-shaped yet.
//
// IMPORTANT: this file must NOT import the route test file — both register
// globalThis stubs and would collide. Each is self-contained.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";

// ── prisma stub installed BEFORE the app import ─────────────────────────

const activityRows: unknown[] = [];
const llmRows: unknown[] = [];

const stubPrisma = {
  aIPrompt: { findUnique: async () => null },
  systemSetting: { findUnique: async () => null },
  userActivity: {
    create: async ({ data }: { data: unknown }) => {
      activityRows.push(data);
      return data;
    },
  },
  lLMCallLog: {
    create: async ({ data }: { data: unknown }) => {
      llmRows.push(data);
      return data;
    },
  },
};
(globalThis as { __prisma?: unknown }).__prisma = stubPrisma;

// ── Anthropic fetch stub ────────────────────────────────────────────────

interface QueuedAiResponse {
  status: number;
  body: unknown;
}
const aiQueue: QueuedAiResponse[] = [];

const originalFetch = globalThis.fetch;
(globalThis as { fetch: typeof fetch }).fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  if (url.includes("api.anthropic.com")) {
    const next = aiQueue.shift();
    if (!next) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "no queued response" },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(input, init);
}) as typeof fetch;

const AI_SUCCESS_PAYLOAD = {
  status: "success",
  recipe: {
    meal: {
      title: "Integration Lasagna",
      cuisineType: "Italian",
      mealType: "dinner",
      estimatedTimeMinutes: 60,
      difficulty: "easy",
      servingsDefault: 4,
      tags: [],
    },
    dishes: [
      {
        title: "Lasagna",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "noodles", quantity: 1, unit: "lb" },
        ],
        steps: [
          {
            stepIndex: 0,
            stepTextRaw: "Cook.",
            stepTextTranslated: "Cook the noodles per package directions.",
            estimatedMinutes: 10,
            phaseType: "cook",
            parallelGroup: null,
            requiresPreheat: false,
            requiresRest: false,
            requiresMarination: false,
            isTimingSensitive: false,
          },
        ],
      },
    ],
  },
};

function queueAiSuccess(payload: unknown): void {
  aiQueue.push({
    status: 200,
    body: {
      id: "msg_test_int",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: JSON.stringify(payload) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 200 },
    },
  });
}

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

// Dynamic import of the FULL app — must run after globalThis.__prisma is set.
const appModule = await import("../../app");
const app = appModule.default;

// ── harness ─────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(): Promise<Harness> {
  return await new Promise<Harness>((resolve, reject) => {
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

// 200 KB base64 string — comfortably above the express.json default 100KB
// limit, well below the route-scoped 35MB ceiling, and below the per-image
// 5MB decoded cap (200KB base64 decodes to ~150KB).
const PAYLOAD_BASE64 = "A".repeat(200 * 1024);

describe("POST /api/recipes/import-image — full-app integration", () => {
  let harness: Harness;
  before(async () => {
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("accepts a >100KB body via the full app middleware chain (not 413'd)", async () => {
    queueAiSuccess(AI_SUCCESS_PAYLOAD);
    const token = signToken("test-user-int-fullapp");

    const res = await fetch(`${harness.baseUrl}/recipes/import-image`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        images: [{ mediaType: "image/jpeg", data: PAYLOAD_BASE64 }],
      }),
    });

    // The single critical assertion: the request reached the route handler
    // rather than being rejected by an upstream parser. A 413 here would
    // mean the global parser (default ~100KB) intercepted before the
    // route-scoped 35mb parser — i.e. the 6c-2-fix regressed.
    assert.notEqual(
      res.status,
      413,
      "request was rejected with 413 — global json parser likely intercepting before route-scoped 35mb parser",
    );

    // Stronger signal: route handler ran to completion and returned the
    // mocked AI success payload. Proves both parsers + downstream pipeline.
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      recipe: { meal: { title: string } };
    };
    assert.equal(body.success, true);
    assert.equal(body.recipe.meal.title, "Integration Lasagna");
  });
});
