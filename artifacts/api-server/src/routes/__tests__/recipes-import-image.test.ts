// WS6 6c-2 — POST /api/recipes/import-image tests.
// Covers Zod validation, decoded-byte caps (per-image + total), auth,
// rate limit, and AI result mapping (success, no_recipe_content, SDK error).
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

// Dynamic import — must run after globalThis.__prisma is set so the lib/prisma
// singleton picks up our stub instead of constructing a real PrismaClient.
const routerModule = await import("../recipes");
const recipesRouter = routerModule.default;

// ── Anthropic fetch stub ─────────────────────────────────────────────────

interface QueuedAiResponse {
  status: number;
  body: unknown;
}

interface CapturedAnthropicRequest {
  url: string;
  // Parsed JSON body of the outgoing Anthropic request, or null if parse failed.
  body: unknown;
}

const aiQueue: QueuedAiResponse[] = [];
let anthropicCallCount = 0;
const capturedAnthropicRequests: CapturedAnthropicRequest[] = [];

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
    try {
      const parsed = init?.body ? JSON.parse(String(init.body)) : null;
      capturedAnthropicRequests.push({ url, body: parsed });
    } catch {
      capturedAnthropicRequests.push({ url, body: null });
    }
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

function queueAiError(): void {
  // SDK maps non-2xx into a thrown APIError → inferSdkErrorReason → "sdk_error".
  aiQueue.push({
    status: 500,
    body: {
      type: "error",
      error: { type: "api_error", message: "simulated upstream error" },
    },
  });
}

function resetAiQueue(): void {
  aiQueue.length = 0;
  anthropicCallCount = 0;
  capturedAnthropicRequests.length = 0;
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

const AI_NO_RECIPE_PAYLOAD = {
  status: "no_recipe_content",
  reason: "Image contains no parseable recipe content.",
};

// ── small / large base64 helpers ────────────────────────────────────────

const SMALL_IMG = "AAAA"; // ~3 bytes decoded
const FIVE_MIB_PLUS_ONE_BASE64_LEN = 6_990_508; // decodes to 5,242,881 bytes (5 MiB + 1)
// Pre-built once; expensive to construct so all "too large" tests share it.
const OVERSIZED_IMG = "A".repeat(FIVE_MIB_PLUS_ONE_BASE64_LEN);

function jpeg(data: string) {
  return { mediaType: "image/jpeg" as const, data };
}

// ── harness ─────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(): Promise<Harness> {
  const app: Express = express();
  // No top-level express.json() — the route mounts its own 35mb parser so
  // the small global default (typically 100kb) doesn't reject image payloads.
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

const TEST_USER = "test-user-import-image";

async function postImages(
  harness: Harness,
  token: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${harness.baseUrl}/recipes/import-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// ── tests: happy path ───────────────────────────────────────────────────

describe("POST /api/recipes/import-image — happy path (1 image)", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("returns 200 with recipe + source:image + activity row", async () => {
    queueAiSuccess(AI_SUCCESS_PAYLOAD);
    const token = signToken(TEST_USER + "-1img");

    const res = await postImages(harness, token, {
      images: [jpeg(SMALL_IMG)],
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      recipe: { meal: { title: string } };
      source: string;
      sourceUrl: string | null;
      caveats: string[];
    };
    assert.equal(body.success, true);
    assert.equal(body.source, "image");
    assert.equal(body.sourceUrl, null);
    assert.equal(body.recipe.meal.title, "Grandma's Lasagna");

    // .catch() on the activity write is fire-and-forget; give the microtask
    // queue a single tick to flush.
    await new Promise((r) => setImmediate(r));
    assert.equal(activityRows.length, 1);
    assert.equal(activityRows[0].eventType, "recipe_imported_image");
    assert.equal(
      (activityRows[0].metadata as { source: string }).source,
      "image",
    );
    assert.equal(
      (activityRows[0].metadata as { imageCount: number }).imageCount,
      1,
    );
  });
});

describe("POST /api/recipes/import-image — happy path (5 images at per-image cap)", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("accepts 5 images each within the per-image cap (boundary)", async () => {
    queueAiSuccess(AI_SUCCESS_PAYLOAD);
    const token = signToken(TEST_USER + "-5img");

    // 5 small images. The per-image cap (5 MiB) and total cap (25 MiB) are
    // both satisfied; the test asserts the route accepts the array length
    // and decodes each entry without rejecting at the cap check.
    const res = await postImages(harness, token, {
      images: [
        jpeg("AAAA"),
        jpeg("BBBB"),
        jpeg("CCCC"),
        jpeg("DDDD"),
        jpeg("EEEE"),
      ],
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean };
    assert.equal(body.success, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(activityRows.length, 1);
    assert.equal(
      (activityRows[0].metadata as { imageCount: number }).imageCount,
      5,
    );
  });
});

// ── tests: validation ──────────────────────────────────────────────────

describe("POST /api/recipes/import-image — validation", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("rejects 400 with try_text_import when images array is empty", async () => {
    const token = signToken(TEST_USER + "-empty");
    const res = await postImages(harness, token, { images: [] });

    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      success: boolean;
      suggestedAction: string;
      reason: string;
    };
    assert.equal(body.success, false);
    assert.equal(body.suggestedAction, "try_text_import");
    assert.equal(body.reason, "url_parse_failed");
  });

  it("rejects 400 when images array has 6 items (over max)", async () => {
    const token = signToken(TEST_USER + "-6");
    const res = await postImages(harness, token, {
      images: Array.from({ length: 6 }, () => jpeg(SMALL_IMG)),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { suggestedAction: string };
    assert.equal(body.suggestedAction, "try_text_import");
  });

  it("rejects 400 for an unknown mime type (image/heic)", async () => {
    const token = signToken(TEST_USER + "-mime");
    const res = await postImages(harness, token, {
      images: [{ mediaType: "image/heic", data: SMALL_IMG }],
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { suggestedAction: string };
    assert.equal(body.suggestedAction, "try_text_import");
  });

  it("rejects 400 with a size-specific message for a single image >5 MiB", async () => {
    const token = signToken(TEST_USER + "-big1");
    const res = await postImages(harness, token, {
      images: [jpeg(OVERSIZED_IMG)],
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      userFacingMessage: string;
      suggestedAction: string;
    };
    assert.match(body.userFacingMessage, /5 MB each/);
    assert.equal(body.suggestedAction, "try_text_import");
  });

  // 5 images each just over the per-image cap (5 MiB + 1 byte) → also
  // exceed the 25 MiB total. The per-image check fires first; either way
  // the response is the same 400 envelope with try_text_import.
  it("rejects 400 for 5 oversized images (per-image check trips before total)", async () => {
    const token = signToken(TEST_USER + "-big5");
    const res = await postImages(harness, token, {
      images: [
        jpeg(OVERSIZED_IMG),
        jpeg(OVERSIZED_IMG),
        jpeg(OVERSIZED_IMG),
        jpeg(OVERSIZED_IMG),
        jpeg(OVERSIZED_IMG),
      ],
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { suggestedAction: string };
    assert.equal(body.suggestedAction, "try_text_import");
  });
});

// ── tests: AI result mapping ───────────────────────────────────────────

describe("POST /api/recipes/import-image — AI returns no_recipe_content", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("returns 200 URLImportFailure with try_text_import", async () => {
    queueAiSuccess(AI_NO_RECIPE_PAYLOAD);
    const token = signToken(TEST_USER + "-norec");

    const res = await postImages(harness, token, {
      images: [jpeg(SMALL_IMG)],
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      reason: string;
      suggestedAction: string;
    };
    assert.equal(body.success, false);
    assert.equal(body.reason, "url_parse_failed");
    assert.equal(body.suggestedAction, "try_text_import");
    // No activity row should be written when AI rejects.
    await new Promise((r) => setImmediate(r));
    assert.equal(activityRows.length, 0);
  });
});

describe("POST /api/recipes/import-image — AI SDK error", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("returns 200 URLImportFailure with sdk_error reason", async () => {
    queueAiError();
    const token = signToken(TEST_USER + "-sdkerr");

    const res = await postImages(harness, token, {
      images: [jpeg(SMALL_IMG)],
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      reason: string;
      suggestedAction: string;
    };
    assert.equal(body.success, false);
    assert.equal(body.reason, "sdk_error");
    assert.equal(body.suggestedAction, "try_text_import");
  });
});

// ── tests: auth + rate limit ───────────────────────────────────────────

describe("POST /api/recipes/import-image — auth", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("rejects 401 when no authorization header is sent", async () => {
    const res = await fetch(`${harness.baseUrl}/recipes/import-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: [jpeg(SMALL_IMG)] }),
    });
    assert.equal(res.status, 401);
  });
});

// ── tests: Block E smoke — multi-image edges ───────────────────────────
//
// Hans's manual smoke covered single-image cookbook photo, two-page cookbook
// recipe, and a handwritten tupperware-lid recipe. These three tests cover the
// edges his manual run didn't exercise:
//   1. multi-image request actually lands on the SDK as multi-block content
//   2. server-side 6+ image cap rejects without ever calling the AI
//   3. ingredients-only "caveats present" path round-trips cleanly

describe("POST /api/recipes/import-image — Block E smoke — multi-image edges", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    resetActivityLog();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("two-image happy path: SDK receives 2 image blocks + 1 text block; recipe parses", async () => {
    queueAiSuccess(AI_SUCCESS_PAYLOAD);
    const token = signToken(TEST_USER + "-2img");

    // Distinct base64 strings (~150 chars each). Real JPEG bytes aren't
    // required — the AI is stubbed; we're verifying transport shape.
    const img1 =
      "/9j/4AAQSkZJRgABAQEAYABgAAD" + "ABCDEFGHIJKLMNOPQRSTUVWX".repeat(5);
    const img2 =
      "/9j/4AAQSkZJRgABAQEAYABgAAD" + "ZYXWVUTSRQPONMLKJIHGFEDC".repeat(5);
    assert.notEqual(img1, img2);

    const callsBefore = anthropicCallCount;
    const res = await postImages(harness, token, {
      images: [jpeg(img1), jpeg(img2)],
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      source: string;
      recipe: {
        meal: { title: string };
        dishes: Array<{ ingredients: unknown[]; steps: unknown[] }>;
      };
    };
    assert.equal(body.success, true);
    assert.equal(body.source, "image");
    assert.equal(body.recipe.meal.title, "Grandma's Lasagna");
    // AI_SUCCESS_PAYLOAD has multiple ingredients and ≥1 step — confirm both
    // populate end-to-end through the route's CanonicalRecipeContent re-parse.
    assert.ok(
      body.recipe.dishes[0].ingredients.length >= 2,
      "expected multiple ingredients to round-trip",
    );
    assert.ok(
      body.recipe.dishes[0].steps.length >= 1,
      "expected at least one instruction step to round-trip",
    );

    // Captured SDK request: the user message must be a multi-block array with
    // exactly two image blocks (data matching each input verbatim) + one text
    // block carrying the rendered prompt body.
    assert.equal(anthropicCallCount - callsBefore, 1);
    const captured =
      capturedAnthropicRequests[capturedAnthropicRequests.length - 1];
    const sent = captured.body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    assert.equal(sent.messages.length, 1);
    assert.equal(sent.messages[0].role, "user");
    const content = sent.messages[0].content;
    assert.ok(
      Array.isArray(content),
      "user message content must be an array when images are attached",
    );
    const blocks = content as Array<{
      type: string;
      source?: { type: string; media_type: string; data: string };
      text?: string;
    }>;
    const imageBlocks = blocks.filter((b) => b.type === "image");
    const textBlocks = blocks.filter((b) => b.type === "text");
    assert.equal(imageBlocks.length, 2, "expected exactly 2 image blocks");
    assert.equal(textBlocks.length, 1, "expected exactly 1 text block");
    assert.equal(imageBlocks[0].source?.media_type, "image/jpeg");
    assert.equal(imageBlocks[1].source?.media_type, "image/jpeg");
    assert.equal(imageBlocks[0].source?.data, img1);
    assert.equal(imageBlocks[1].source?.data, img2);
  });

  it("six-image cap: server returns 400 and never calls Anthropic", async () => {
    const callsBefore = anthropicCallCount;
    const queueLenBefore = aiQueue.length;
    const token = signToken(TEST_USER + "-6cap");

    // Six distinct small images. Each is well within the per-image and total
    // byte caps; rejection must come from the array-length validator alone.
    const res = await postImages(harness, token, {
      images: Array.from({ length: 6 }, (_, i) =>
        jpeg(`AAAA${i}AAAA${i}AAAA`),
      ),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      success: boolean;
      reason: string;
      suggestedAction: string;
      userFacingMessage: string;
    };
    assert.equal(body.success, false);
    assert.equal(body.reason, "url_parse_failed");
    assert.equal(body.suggestedAction, "try_text_import");
    // The route wraps Zod's "max 5" rejection in the generic image-failure
    // message — assert the user-facing shell rather than the Zod string.
    assert.match(body.userFacingMessage, /Kiwi couldn't read this image/i);
    // Anthropic must NOT have been called: validation tripped before the AI.
    assert.equal(
      anthropicCallCount,
      callsBefore,
      "Anthropic must not be called on a validation-rejected request",
    );
    // No queued AI response should have been consumed either.
    assert.equal(aiQueue.length, queueLenBefore);
  });

  it("ingredients-only path: AI success with steps caveat round-trips end-to-end", async () => {
    const AI_INGREDIENTS_ONLY_PAYLOAD = {
      status: "success",
      recipe: {
        meal: {
          title: "Grandma's Handwritten Cookies",
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
        // No `description`, no `sourceUrl` — both optional in MealMetaSchema.
      },
      caveats: [
        "Steps not visible in photo; suggested cooking steps generated based on ingredients.",
      ],
    };

    queueAiSuccess(AI_INGREDIENTS_ONLY_PAYLOAD);
    const token = signToken(TEST_USER + "-ingonly");

    const res = await postImages(harness, token, {
      images: [jpeg(SMALL_IMG)],
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      source: string;
      recipe: {
        dishes: Array<{
          ingredients: unknown[];
          steps: unknown[];
        }>;
      };
      caveats: string[];
    };
    assert.equal(body.success, true);
    assert.equal(body.source, "image");
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
    assert.match(body.caveats[0], /generated|not visible|suggested/i);
  });
});

// ── tests: rate limit — runs LAST so the bucket drain doesn't 429 the
// other describes (the in-memory bucket is keyed by IP+method+path and is
// module-level; refill = 12/60s ≈ 5s per token, slower than test execution).
describe("POST /api/recipes/import-image — rate limit", () => {
  let harness: Harness;
  before(async () => {
    resetAiQueue();
    harness = await spinUp();
  });
  after(async () => harness.close());

  it("returns 429 after 12 calls in a single burst (capacity = 12)", async () => {
    const token = signToken(TEST_USER + "-rl");
    // Queue 13 successes so the route reaches the AI on every accepted call;
    // the 13th request should be rejected by the limiter before reaching AI.
    for (let i = 0; i < 13; i++) queueAiSuccess(AI_SUCCESS_PAYLOAD);

    let lastStatus = 0;
    for (let i = 0; i < 13; i++) {
      const res = await postImages(harness, token, {
        images: [jpeg(SMALL_IMG)],
      });
      lastStatus = res.status;
      // Drain body so the connection releases.
      await res.text();
    }
    assert.equal(lastStatus, 429);
  });
});
