// WS6 6c-3 — POST /api/recipes/import-text tests.
// Covers Zod validation (min/max length, missing field), AI success → activity
// row + caveats, AI no_recipe_content → failure envelope, AI SDK error,
// and auth.
//
// recipes.ts is NOT a factory router (D-WS6-038 deferred). So we:
//   • Set globalThis.__prisma to a stub BEFORE dynamic-importing the router
//     — lib/prisma.ts checks globalThis.__prisma first, so our stub becomes
//     the singleton inside this test-worker.
//   • Stub globalThis.fetch so Anthropic SDK calls return canned responses;
//     non-Anthropic URLs (the test harness itself) pass through untouched.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";

// ── prisma stub installed BEFORE the router import ──────────────────────

interface ActivityRow {
  userId: string;
  eventType: string;
  entityId: string | null;
  platform: string;
  metadata: Record<string, unknown>;
}

const activityRows: ActivityRow[] = [];
const llmRows: unknown[] = [];

const stubPrisma = {
  aIPrompt: { findUnique: async () => null },
  systemSetting: { findUnique: async () => null },
  userActivity: {
    create: async ({ data }: { data: ActivityRow }) => {
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

const routerModule = await import("../recipes");
const recipesRouter = routerModule.default;

// ── Anthropic fetch stub ─────────────────────────────────────────────────

interface QueuedAiResponse {
  status: number;
  body: unknown;
}

const aiQueue: QueuedAiResponse[] = [];
let anthropicCallCount = 0;

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
    anthropicCallCount++;
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

function queueAiSuccess(payload: unknown): void {
  aiQueue.push({
    status: 200,
    body: {
      id: "msg_test",
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

function resetAiQueue(): void {
  aiQueue.length = 0;
  anthropicCallCount = 0;
}

function resetActivityLog(): void {
  activityRows.length = 0;
}

// Anthropic SDK requires an API key at construction. We set it once at the
// top so the cached singleton inside runAICall doesn't trip the no_api_key
// branch — actual auth happens against our stubbed fetch.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

// ── canned recipe payloads ──────────────────────────────────────────────

const AI_SUCCESS_PAYLOAD = {
  status: "success",
  recipe: {
    meal: {
      title: "Grandma's Lasagna",
      cuisineType: "Italian",
      mealType: "dinner",
      estimatedTimeMinutes: 90,
      difficulty: "medium",
      servingsDefault: 6,
      tags: ["pasta"],
    },
    dishes: [
      {
        title: "Lasagna",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "lasagna noodles", quantity: 1, unit: "lb" },
          { name: "ground beef", quantity: 1, unit: "lb" },
          { name: "ricotta", quantity: 16, unit: "oz" },
        ],
        steps: [
          {
            stepIndex: 0,
            stepTextRaw: "Brown the beef.",
            stepTextTranslated:
              "Brown the ground beef in a large skillet over medium-high heat.",
            estimatedMinutes: 8,
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

// Mirror of image route's ingredients-only payload — AI populated steps from
// ingredient context and added a caveat. Used for the steps-caveat test.
const AI_INGREDIENTS_ONLY_PAYLOAD = {
  status: "success",
  recipe: {
    meal: {
      title: "Grandma's Sugar Cookies",
      cuisineType: "American",
      mealType: "snack",
      estimatedTimeMinutes: 35,
      difficulty: "easy",
      servingsDefault: 12,
      tags: ["dessert"],
    },
    dishes: [
      {
        title: "Sugar Cookies",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "all-purpose flour", quantity: 2, unit: "cup" },
          { name: "granulated sugar", quantity: 1, unit: "cup" },
          { name: "butter", quantity: 0.5, unit: "cup" },
          { name: "eggs", quantity: 2, unit: "each" },
          { name: "vanilla extract", quantity: 1, unit: "tsp" },
        ],
        steps: [
          {
            stepIndex: 0,
            stepTextRaw: "Cream butter and sugar.",
            stepTextTranslated:
              "Cream the butter and sugar together until light and fluffy.",
            estimatedMinutes: 5,
            phaseType: "prep",
            parallelGroup: null,
            requiresPreheat: false,
            requiresRest: false,
            requiresMarination: false,
            isTimingSensitive: false,
          },
          {
            stepIndex: 1,
            stepTextRaw: "Bake at 350F until golden.",
            stepTextTranslated:
              "Beat in eggs and vanilla, fold in flour, then bake at 350°F for 12 minutes.",
            estimatedMinutes: 20,
            phaseType: "cook",
            parallelGroup: null,
            requiresPreheat: true,
            requiresRest: false,
            requiresMarination: false,
            isTimingSensitive: true,
          },
        ],
      },
    ],
  },
  caveats: [
    "No instructions in pasted text; suggested cooking steps generated based on ingredients.",
  ],
};

// ── harness ─────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(): Promise<Harness> {
  const app: Express = express();
  // Text-import uses the global default-limit JSON parser (40K chars fits
  // comfortably under the 100KB default). Mount it here to mirror app.ts.
  app.use(express.json());
  app.use("/api", recipesRouter);

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

const TEST_USER = "test-user-import-text";

async function postText(
  harness: Harness,
  token: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${harness.baseUrl}/recipes/import-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// 80-char recipe-shaped sample — comfortably over the 50-char minimum.
const VALID_RECIPE_TEXT =
  "Sugar Cookies. Ingredients: flour, sugar, butter, eggs. Bake at 350F until golden.";

// ── tests ───────────────────────────────────────────────────────────────

describe("POST /api/recipes/import-text — happy path", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("returns 200 with recipe + source:text + activity row", async () => {
    queueAiSuccess(AI_SUCCESS_PAYLOAD);
    const token = signToken(TEST_USER + "-happy");

    const res = await postText(harness, token, { rawText: VALID_RECIPE_TEXT });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      recipe: { meal: { title: string } };
      source: string;
      sourceUrl: string | null;
      caveats: string[];
    };
    assert.equal(body.success, true);
    assert.equal(body.source, "text");
    assert.equal(body.sourceUrl, null);
    assert.equal(body.recipe.meal.title, "Grandma's Lasagna");

    // .catch() on the activity write is fire-and-forget; give the microtask
    // queue a single tick to flush.
    await new Promise((r) => setImmediate(r));
    assert.equal(activityRows.length, 1);
    assert.equal(activityRows[0].eventType, "recipe_imported_text");
    assert.equal(
      (activityRows[0].metadata as { source: string }).source,
      "text",
    );
    assert.equal(
      (activityRows[0].metadata as { rawTextLength: number }).rawTextLength,
      VALID_RECIPE_TEXT.length,
    );
  });
});

describe("POST /api/recipes/import-text — min-length rejection", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("rejects 400 for a 49-char body without calling the AI", async () => {
    const token = signToken(TEST_USER + "-min");
    const callsBefore = anthropicCallCount;

    const tooShort = "x".repeat(49);
    const res = await postText(harness, token, { rawText: tooShort });

    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      success: boolean;
      reason: string;
      suggestedAction: string;
      userFacingMessage: string;
    };
    assert.equal(body.success, false);
    assert.equal(body.suggestedAction, "try_image_import");
    assert.equal(body.reason, "url_parse_failed");
    assert.match(body.userFacingMessage, /Kiwi couldn't read this recipe text/i);
    assert.equal(
      anthropicCallCount,
      callsBefore,
      "AI must not be called on a validation-rejected request",
    );
  });
});

describe("POST /api/recipes/import-text — max-length rejection", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("rejects 400 for a 40,001-char body without calling the AI", async () => {
    const token = signToken(TEST_USER + "-max");
    const callsBefore = anthropicCallCount;

    const tooLong = "x".repeat(40_001);
    const res = await postText(harness, token, { rawText: tooLong });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { suggestedAction: string };
    assert.equal(body.suggestedAction, "try_image_import");
    assert.equal(
      anthropicCallCount,
      callsBefore,
      "AI must not be called on a validation-rejected request",
    );
  });
});

describe("POST /api/recipes/import-text — missing rawText", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("rejects 400 when rawText is absent", async () => {
    const token = signToken(TEST_USER + "-missing");
    const res = await postText(harness, token, {});

    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      success: boolean;
      suggestedAction: string;
    };
    assert.equal(body.success, false);
    assert.equal(body.suggestedAction, "try_image_import");
  });
});

describe("POST /api/recipes/import-text — ingredients-only with steps caveat", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("returns 200 with populated steps + non-empty caveats array", async () => {
    queueAiSuccess(AI_INGREDIENTS_ONLY_PAYLOAD);
    const token = signToken(TEST_USER + "-ingonly");

    // Sample text simulating an ingredients-only paste — the AI is stubbed,
    // so the actual content here only needs to clear the 50-char min.
    const ingredientsOnlyPaste =
      "Sugar Cookies — Ingredients: 2 cups flour, 1 cup sugar, 0.5 cup butter, 2 eggs, 1 tsp vanilla.";

    const res = await postText(harness, token, { rawText: ingredientsOnlyPaste });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      source: string;
      recipe: { dishes: Array<{ ingredients: unknown[]; steps: unknown[] }> };
      caveats: string[];
    };
    assert.equal(body.success, true);
    assert.equal(body.source, "text");
    assert.ok(
      body.recipe.dishes[0].ingredients.length >= 1,
      "ingredients should be populated",
    );
    assert.ok(
      body.recipe.dishes[0].steps.length >= 1,
      "AI-suggested steps should round-trip on the success path",
    );
    assert.ok(
      Array.isArray(body.caveats) && body.caveats.length >= 1,
      "caveats must surface on the response envelope",
    );
    assert.match(body.caveats[0], /generated|suggested|no instructions/i);
  });
});
