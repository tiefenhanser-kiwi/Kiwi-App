// WS6 6c-1 — recipeImport helpers + reformat schema tests.
// Run via: pnpm --filter @workspace/api-server test
// SDK is mocked by injecting opts.client — no network calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import {
  CanonicalRecipeSchema,
  CanonicalRecipeContentSchema,
  ImageInputSchema,
  RawRecipeInputSchema,
  URLImportFailureSchema,
} from "../schemas/reformat";
import {
  extractJsonLdRecipe,
  normalizeIngredientQuantity,
  parseIngredientLines,
  reformatRecipeForKiwi,
  fetchRecipePage,
  stripNullValues,
} from "../../recipeImport";
import { _resetClientCache } from "../runAICall";
import type {
  AIPromptRow,
  LLMCallLogCreateData,
  PrismaLike,
  SystemSettingRow,
} from "../promptRegistry";

// ── stub prisma ─────────────────────────────────────────────────────────

function makeStubPrisma(): {
  prisma: PrismaLike;
  llmCalls: () => LLMCallLogCreateData[];
} {
  const llmCalls: LLMCallLogCreateData[] = [];
  const prisma: PrismaLike = {
    aIPrompt: {
      findUnique: async (): Promise<AIPromptRow | null> => null,
    },
    systemSetting: {
      findUnique: async (): Promise<SystemSettingRow | null> => null,
    },
    lLMCallLog: {
      create: async ({ data }: { data: LLMCallLogCreateData }) => {
        llmCalls.push(data);
        return data;
      },
    },
  };
  return { prisma, llmCalls: () => llmCalls };
}

// ── fake Anthropic client ───────────────────────────────────────────────

interface QueuedResponse {
  content: Anthropic.ContentBlock[];
}

function makeFakeClient(responses: QueuedResponse[]) {
  let calls = 0;
  const queue = [...responses];
  const capturedParams: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParams,
      ): Promise<Anthropic.Message> => {
        calls++;
        capturedParams.push(params);
        const next = queue.shift();
        if (!next) throw new Error("fake client exhausted: no queued responses");
        return {
          id: `msg_test_${calls}`,
          container: null,
          content: next.content,
          model: params.model,
          role: "assistant",
          stop_details: null,
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: {
            input_tokens: 200,
            output_tokens: 400,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
          },
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return {
    client,
    callCount: () => calls,
    getLastParams: (): Anthropic.MessageCreateParams =>
      capturedParams[capturedParams.length - 1],
  };
}

// ── canned payloads ─────────────────────────────────────────────────────

const SUCCESS_PAYLOAD = {
  status: "success",
  recipe: {
    meal: {
      title: "Spaghetti Carbonara",
      description: "Classic Roman pasta.",
      cuisineType: "Italian",
      mealType: "dinner",
      estimatedTimeMinutes: 30,
      difficulty: "medium",
      servingsDefault: 4,
      sourceUrl: "https://example.com/carbonara",
      tags: ["pasta", "weeknight"],
    },
    dishes: [
      {
        title: "Spaghetti Carbonara",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "spaghetti", quantity: 1, unit: "lb" },
          { name: "eggs", quantity: 4, unit: "each" },
        ],
        steps: [
          {
            stepIndex: 0,
            stepTextRaw: "Bring water to a boil.",
            stepTextTranslated:
              "Bring a large pot of salted water to a rolling boil over high heat.",
            estimatedMinutes: 8,
            phaseType: "preheat",
            parallelGroup: "boil_water",
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

const NO_RECIPE_PAYLOAD = {
  status: "no_recipe_content",
  reason: "Source page appears to be a recipe roundup — no individual recipe.",
};

// ── Schema tests ────────────────────────────────────────────────────────

describe("CanonicalRecipeSchema — discriminated union shape", () => {
  it("accepts success-shape with recipe payload", () => {
    const result = CanonicalRecipeSchema.safeParse(SUCCESS_PAYLOAD);
    assert.equal(result.success, true);
  });

  it("accepts no_recipe_content shape with reason", () => {
    const result = CanonicalRecipeSchema.safeParse(NO_RECIPE_PAYLOAD);
    assert.equal(result.success, true);
  });

  it("rejects a recipe whose status is not in the discriminator", () => {
    const result = CanonicalRecipeSchema.safeParse({
      ...SUCCESS_PAYLOAD,
      status: "ok",
    });
    assert.equal(result.success, false);
  });

  it("rejects a success payload missing meal.title", () => {
    const malformed = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    delete malformed.recipe.meal.title;
    const result = CanonicalRecipeSchema.safeParse(malformed);
    assert.equal(result.success, false);
  });

  it("rejects a success payload with zero dishes", () => {
    const malformed = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    malformed.recipe.dishes = [];
    const result = CanonicalRecipeSchema.safeParse(malformed);
    assert.equal(result.success, false);
  });

  it("rejects a dish with zero ingredients", () => {
    const malformed = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    malformed.recipe.dishes[0].ingredients = [];
    const result = CanonicalRecipeSchema.safeParse(malformed);
    assert.equal(result.success, false);
  });

  // BUG-018 (WS7-8b B1) — the parallelGroup-type-guard test was removed with
  // the field: parallelGroup is retired from the reformat StepSchema, so there
  // is no longer a string|null constraint to violate (the schema isn't strict,
  // so an extra key is simply ignored — nothing to assert).

  it("rejects cuisineType outside the closed catalog", () => {
    const malformed = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    malformed.recipe.meal.cuisineType = "italian"; // lowercase — not in catalog
    const result = CanonicalRecipeSchema.safeParse(malformed);
    assert.equal(result.success, false);
  });

  it("rejects mealType 'dessert' (collapsed to snack)", () => {
    const malformed = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    malformed.recipe.meal.mealType = "dessert";
    const result = CanonicalRecipeSchema.safeParse(malformed);
    assert.equal(result.success, false);
  });

  it("rejects difficulty 'hard' (must be fancy)", () => {
    const malformed = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    malformed.recipe.meal.difficulty = "hard";
    const result = CanonicalRecipeSchema.safeParse(malformed);
    assert.equal(result.success, false);
  });

  // 6c-2-fix-2: caveats cap bumped 100 → 300. Cookbook-photo imports emit
  // descriptive caveats ("Last 2 ingredients may have been cut off — re-scan
  // to verify quantities") that exceeded 100 chars. 300 fits ~2 mobile lines.
  it("accepts a caveat at the 300-char boundary", () => {
    const payload = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    payload.caveats = ["x".repeat(300)];
    const result = CanonicalRecipeSchema.safeParse(payload);
    assert.equal(result.success, true);
  });

  it("rejects a caveat over the 300-char cap (301 chars)", () => {
    const payload = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    payload.caveats = ["x".repeat(301)];
    const result = CanonicalRecipeSchema.safeParse(payload);
    assert.equal(result.success, false);
  });

  // 6c-1-fix superRefine: paywall placeholders often emit a success-shape with
  // every dish.steps = []. Force the model to use no_recipe_content instead.
  it("rejects success-shape when every dish has zero cooking steps (paywall placeholder)", () => {
    const malformed = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    for (const dish of malformed.recipe.dishes) {
      dish.steps = [];
    }
    const result = CanonicalRecipeSchema.safeParse(malformed);
    assert.equal(result.success, false);
  });

  it("accepts success-shape when at least one dish has cooking steps (positive superRefine case)", () => {
    // SUCCESS_PAYLOAD already has steps; add a second dish with empty steps to
    // prove the refinement requires only one dish to carry steps, not every dish.
    const payload = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    payload.recipe.dishes.push({
      title: "Side salad",
      role: "side",
      positionIndex: 1,
      ingredients: [{ name: "arugula", quantity: 2, unit: "cup" }],
      steps: [],
    });
    const result = CanonicalRecipeSchema.safeParse(payload);
    assert.equal(result.success, true);
  });
});

describe("CanonicalRecipeContentSchema — direct content shape", () => {
  it("validates the recipe content portion of a success payload", () => {
    const result = CanonicalRecipeContentSchema.safeParse(SUCCESS_PAYLOAD.recipe);
    assert.equal(result.success, true);
  });
});

describe("URLImportFailureSchema", () => {
  it("accepts the standard failure envelope", () => {
    const result = URLImportFailureSchema.safeParse({
      success: false,
      reason: "url_parse_failed",
      userFacingMessage: "Kiwi couldn't read this recipe.",
      suggestedAction: "try_image_import",
    });
    assert.equal(result.success, true);
  });

  it("rejects unknown failure reasons", () => {
    const result = URLImportFailureSchema.safeParse({
      success: false,
      reason: "elephant",
      userFacingMessage: "x",
      suggestedAction: "try_image_import",
    });
    assert.equal(result.success, false);
  });
});

describe("RawRecipeInputSchema", () => {
  it("accepts a URL-only input", () => {
    const result = RawRecipeInputSchema.safeParse({ url: "https://example.com/r" });
    assert.equal(result.success, true);
  });

  it("accepts an input with structuredHints", () => {
    const result = RawRecipeInputSchema.safeParse({
      url: "https://example.com/r",
      structuredHints: {
        title: "Test",
        ingredients: [{ name: "flour", quantity: 1, unit: "cup" }],
      },
    });
    assert.equal(result.success, true);
  });

  // 6c-2 — image input accepted without url; url + images permitted together.
  it("accepts an images-only input (no url)", () => {
    const result = RawRecipeInputSchema.safeParse({
      images: [{ mediaType: "image/jpeg", data: "abcdef" }],
    });
    assert.equal(result.success, true);
  });

  it("accepts a url + images mixed input", () => {
    const result = RawRecipeInputSchema.safeParse({
      url: "https://example.com/r",
      images: [
        { mediaType: "image/jpeg", data: "aaa" },
        { mediaType: "image/png", data: "bbb" },
      ],
    });
    assert.equal(result.success, true);
  });

  it("rejects images array with 6 items (max 5)", () => {
    const result = RawRecipeInputSchema.safeParse({
      images: Array.from({ length: 6 }, () => ({
        mediaType: "image/jpeg" as const,
        data: "x",
      })),
    });
    assert.equal(result.success, false);
  });
});

// ── ImageInputSchema (6c-2) ────────────────────────────────────────────

describe("ImageInputSchema", () => {
  it("accepts a valid jpeg image", () => {
    const result = ImageInputSchema.safeParse({
      mediaType: "image/jpeg",
      data: "abc",
    });
    assert.equal(result.success, true);
  });

  it("rejects an unknown media type (image/heic)", () => {
    const result = ImageInputSchema.safeParse({
      mediaType: "image/heic",
      data: "abc",
    });
    assert.equal(result.success, false);
  });

  it("rejects empty data", () => {
    const result = ImageInputSchema.safeParse({
      mediaType: "image/png",
      data: "",
    });
    assert.equal(result.success, false);
  });
});

// ── extractJsonLdRecipe ────────────────────────────────────────────────

describe("extractJsonLdRecipe", () => {
  it("finds a top-level Recipe object", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Recipe",
      name: "Test Recipe",
      recipeIngredient: ["1 cup flour"],
    })}</script></head><body/></html>`;
    const found = extractJsonLdRecipe(html);
    assert.notEqual(found, null);
    assert.equal(found?.name, "Test Recipe");
  });

  it("finds a Recipe inside @graph", () => {
    const html = `<html><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", name: "Page" },
        { "@type": "Recipe", name: "Graph Recipe", recipeIngredient: ["x"] },
      ],
    })}</script></html>`;
    const found = extractJsonLdRecipe(html);
    assert.equal(found?.name, "Graph Recipe");
  });

  it("recovers when one script block is malformed JSON but another is valid", () => {
    const html = `
      <script type="application/ld+json">{not valid json</script>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Recipe",
        name: "Survived",
        recipeIngredient: ["y"],
      })}</script>
    `;
    const found = extractJsonLdRecipe(html);
    assert.equal(found?.name, "Survived");
  });

  it("returns null when no Recipe is present", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Article",
      headline: "Not a recipe",
    })}</script>`;
    assert.equal(extractJsonLdRecipe(html), null);
  });

  it("returns null for empty HTML", () => {
    assert.equal(extractJsonLdRecipe(""), null);
  });
});

// ── normalizeIngredientQuantity ────────────────────────────────────────

describe("normalizeIngredientQuantity", () => {
  it("converts mixed fraction '1 1/2' to 1.5", () => {
    const result = normalizeIngredientQuantity("1 1/2", "cup");
    assert.equal(result.quantity, 1.5);
    assert.equal(result.unit, "cup");
  });

  it("accepts decimal '0.5' as-is", () => {
    const result = normalizeIngredientQuantity("0.5", "tsp");
    assert.equal(result.quantity, 0.5);
    assert.equal(result.unit, "tsp");
  });

  it("maps 'to taste' to {1, 'to_taste'}", () => {
    const result = normalizeIngredientQuantity("to taste", "tsp");
    assert.equal(result.quantity, 1);
    assert.equal(result.unit, "to_taste");
  });

  it("maps 'as needed' to {1, 'to_taste'}", () => {
    const result = normalizeIngredientQuantity("as needed", "");
    assert.equal(result.quantity, 1);
    assert.equal(result.unit, "to_taste");
  });

  it("maps empty string to {1, 'to_taste'}", () => {
    const result = normalizeIngredientQuantity("", "");
    assert.equal(result.quantity, 1);
    assert.equal(result.unit, "to_taste");
  });
});

// ── parseIngredientLines ───────────────────────────────────────────────

describe("parseIngredientLines", () => {
  it("parses typical lines with quantity, unit, name", () => {
    const result = parseIngredientLines(["1 cup flour", "2 tbsp olive oil"]);
    assert.equal(result.length, 2);
    assert.equal(result[0].name.toLowerCase().includes("flour"), true);
    assert.equal(result[0].quantity > 0, true);
    assert.equal(result[1].name.toLowerCase().includes("olive oil"), true);
  });

  it("handles a unitless count line gracefully (produces a single row)", () => {
    // recipe-ingredient-parser-v3 doesn't reliably extract bare counts without
    // a unit (e.g. "4 eggs"). We don't require it to — the AI will repair
    // quantity downstream. The contract is: every input line produces exactly
    // one output row with a non-empty name.
    const result = parseIngredientLines(["4 eggs"]);
    assert.equal(result.length, 1);
    assert.ok(result[0].name.length > 0);
    assert.ok(result[0].quantity > 0);
  });

  it("flags unparseable lines via preparationNote fallback", () => {
    const result = parseIngredientLines(["???wat"]);
    // Should still produce a row — either parser succeeded with garbage or
    // our catch-all kicked in with preparationNote=raw.
    assert.equal(result.length, 1);
    assert.ok(result[0].name.length > 0);
  });
});

// ── fetchRecipePage URL validation ─────────────────────────────────────

describe("fetchRecipePage — URL validation", () => {
  it("rejects non-http/https URLs (ftp)", async () => {
    await assert.rejects(
      () => fetchRecipePage("ftp://example.com/recipe.html"),
      /http\/https/,
    );
  });

  it("rejects localhost", async () => {
    await assert.rejects(
      () => fetchRecipePage("http://localhost/recipe"),
      /Blocked/,
    );
  });

  it("rejects link-local 169.254.x", async () => {
    await assert.rejects(
      () => fetchRecipePage("http://169.254.169.254/metadata"),
      /Blocked/,
    );
  });

  it("rejects garbage URLs", async () => {
    await assert.rejects(() => fetchRecipePage("not a url"), /Invalid URL/);
  });
});

// ── fetchRecipePage body inspection (6c-1-fix-2) ───────────────────────
// Stub globalThis.fetch directly so we can drive status codes and bodies
// without hitting the network.

function stubFetch(response: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}): () => void {
  const originalFetch = globalThis.fetch;
  const status = response.status ?? 200;
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    ...(response.headers ?? {}),
  });
  const body = response.body ?? "";
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    const buf = new TextEncoder().encode(body);
    return new Response(buf, { status, headers });
  }) as typeof fetch;
  return () => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  };
}

describe("fetchRecipePage — body & redirect inspection", () => {
  it("throws cloudflare_challenge when body contains 2+ challenge markers", async () => {
    const restore = stubFetch({
      body: `<html><script>window._cf_chl_opt={};</script><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1/foo.js"></script></html>`,
    });
    try {
      await assert.rejects(
        () => fetchRecipePage("https://blocked.example.com/r"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal((err as { code?: string }).code, "cloudflare_challenge");
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it("does NOT throw when only a single Cloudflare marker is present (false-positive guard)", async () => {
    const restore = stubFetch({
      body: `<html><body><p>This blog post mentions _cf_chl_opt only once, in passing.</p></body></html>`,
    });
    try {
      const result = await fetchRecipePage("https://blog.example.com/r");
      assert.ok(result.html.includes("_cf_chl_opt"));
    } finally {
      restore();
    }
  });

  it("throws redirected on a 308 response", async () => {
    const restore = stubFetch({
      status: 308,
      headers: { location: "https://example.com/elsewhere" },
      body: "",
    });
    try {
      await assert.rejects(
        () => fetchRecipePage("https://example.com/recipe"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal((err as { code?: string }).code, "redirected");
          assert.match((err as Error).message, /308/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it("returns html for a clean 200 response", async () => {
    const restore = stubFetch({
      body: `<html><head><title>Recipe</title></head><body><h1>Clean recipe page</h1></body></html>`,
    });
    try {
      const result = await fetchRecipePage("https://clean.example.com/r");
      assert.ok(result.html.includes("Clean recipe page"));
    } finally {
      restore();
    }
  });
});

// ── reformatRecipeForKiwi — mocked SDK ─────────────────────────────────

describe("reformatRecipeForKiwi", () => {
  it("returns success for a happy-path AI response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(SUCCESS_PAYLOAD),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await reformatRecipeForKiwi(
      { url: "https://example.com/carbonara" },
      { prisma, userId: "u-1", client: fake.client },
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.status, "success");
    if (result.data.status !== "success") return;
    assert.equal(result.data.recipe.meal.title, "Spaghetti Carbonara");
    assert.equal(result.data.recipe.dishes.length, 1);

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].promptKey, "import.reformat_for_kiwi");
    assert.equal(logs[0].success, true);
  });

  it("returns no_recipe_content for a paywall AI response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(NO_RECIPE_PAYLOAD),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await reformatRecipeForKiwi(
      { url: "https://paywall.example.com/r" },
      { prisma, userId: "u-1", client: fake.client },
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.status, "no_recipe_content");
  });

  it("returns failure when no API key is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    _resetClientCache();
    const { prisma } = makeStubPrisma();

    const result = await reformatRecipeForKiwi(
      { url: "https://example.com/r" },
      { prisma, userId: "u-1" },
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.reason, "no_api_key");
  });

  // 6c-2 vision path — images flow through as ImageBlockParam attachments
  // on messages[0].content, alongside a single text block.
  it("vision path: passes images as image blocks in messages[0].content", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(SUCCESS_PAYLOAD),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await reformatRecipeForKiwi(
      {
        images: [
          { mediaType: "image/jpeg", data: "AAAA" },
          { mediaType: "image/png", data: "BBBB" },
        ],
      },
      { prisma, userId: "u-vision", client: fake.client },
    );

    assert.equal(result.success, true);
    const params = fake.getLastParams();
    const content = params.messages[0].content;
    assert.ok(Array.isArray(content), "content should be an array, not a string");
    if (!Array.isArray(content)) return;
    const imageBlocks = content.filter((b) => b.type === "image");
    const textBlocks = content.filter((b) => b.type === "text");
    assert.equal(imageBlocks.length, 2);
    assert.equal(textBlocks.length, 1);
    // Image blocks should carry the base64 source + media type we passed in.
    const firstImage = imageBlocks[0] as Anthropic.ImageBlockParam;
    assert.equal(firstImage.source.type, "base64");
    if (firstImage.source.type !== "base64") return;
    assert.equal(firstImage.source.media_type, "image/jpeg");
    assert.equal(firstImage.source.data, "AAAA");
  });

  it("vision path: surfaces no_recipe_content from the AI response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(NO_RECIPE_PAYLOAD),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await reformatRecipeForKiwi(
      { images: [{ mediaType: "image/jpeg", data: "AAAA" }] },
      { prisma, userId: "u-vision-empty", client: fake.client },
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.status, "no_recipe_content");
  });

  it("vision path: caveats round-trip through the success result", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const payloadWithCaveat = {
      ...SUCCESS_PAYLOAD,
      caveats: ["Steps inferred from ingredients — review carefully"],
    };
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(payloadWithCaveat),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await reformatRecipeForKiwi(
      { images: [{ mediaType: "image/jpeg", data: "AAAA" }] },
      { prisma, userId: "u-vision-caveat", client: fake.client },
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    if (result.data.status !== "success") return;
    assert.deepEqual(result.data.caveats, [
      "Steps inferred from ingredients — review carefully",
    ]);
  });

  // 6c-2-fix-2 Test B — caveats cap regression-lock. A 200-char caveat string
  // must survive the full reformat pipeline now that the limit is 300 (was 100).
  it("vision path: 200-char caveat passes validation through the full pipeline", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const longCaveat = "x".repeat(200);
    const payloadWithLongCaveat = {
      ...SUCCESS_PAYLOAD,
      caveats: [longCaveat],
    };
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(payloadWithLongCaveat),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await reformatRecipeForKiwi(
      { images: [{ mediaType: "image/jpeg", data: "AAAA" }] },
      { prisma, userId: "u-vision-200-caveat", client: fake.client },
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    if (result.data.status !== "success") return;
    assert.equal(result.data.caveats?.[0].length, 200);
  });

  // 6c-2-fix-2 Test C — null-tolerance regression-lock. AI responses with
  // explicit null for optional fields (sourceUrl, description) must validate
  // and surface as undefined on the canonical recipe.
  it("vision path: null fields in AI response are stripped and validate cleanly", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const payloadWithNulls = JSON.parse(JSON.stringify(SUCCESS_PAYLOAD));
    payloadWithNulls.recipe.meal.sourceUrl = null;
    payloadWithNulls.recipe.meal.description = null;
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(payloadWithNulls),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await reformatRecipeForKiwi(
      { images: [{ mediaType: "image/jpeg", data: "AAAA" }] },
      { prisma, userId: "u-vision-nulls", client: fake.client },
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    if (result.data.status !== "success") return;
    assert.equal(result.data.recipe.meal.sourceUrl, undefined);
    assert.equal(result.data.recipe.meal.description, undefined);
    // Sanity — the rest of the recipe still validated through the strip.
    assert.equal(result.data.recipe.meal.title, "Spaghetti Carbonara");
  });
});

// ── stripNullValues helper (6c-2-fix-2) ────────────────────────────────

describe("stripNullValues — recursive null-stripping helper", () => {
  it("returns undefined when given null at the top level", () => {
    assert.equal(stripNullValues(null), undefined);
  });

  it("drops null-valued keys from an object", () => {
    assert.deepEqual(stripNullValues({ a: null, b: "x" }), { b: "x" });
  });

  it("recurses into nested objects, dropping nulls inside", () => {
    assert.deepEqual(stripNullValues({ a: { b: null } }), { a: {} });
  });

  it("filters null elements out of arrays of primitives", () => {
    assert.deepEqual(stripNullValues({ a: [null, "x", null] }), { a: ["x"] });
  });

  it("recurses into arrays of objects, stripping nulls per element", () => {
    assert.deepEqual(
      stripNullValues({ a: [{ b: null, c: "x" }] }),
      { a: [{ c: "x" }] },
    );
  });

  it("passes non-null primitives through unchanged", () => {
    assert.equal(stripNullValues("hello"), "hello");
    assert.equal(stripNullValues(42), 42);
    assert.equal(stripNullValues(true), true);
    assert.equal(stripNullValues(undefined), undefined);
  });

  it("preserves an empty array as an empty array", () => {
    assert.deepEqual(stripNullValues([]), []);
  });
});
