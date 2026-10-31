// IMPORT-2 (D-WS9-384) — POST /recipes/import-url with `html`: the page the
// cook is looking at in Kiwi's in-app browser. The server fetches nothing and
// runs the same parser over the page it was given.
//
// "Fetches nothing" is proved with an address the fetch guard refuses
// (169.254.169.254, the metadata host): if the route still fetched, the reply
// would be fetch_error. The Anthropic call is stubbed on globalThis.fetch, and
// the request body it receives shows what the parser made of the page.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createRecipesRouter, MAX_PAGE_HTML_CHARS } from "../recipes";
import { withSessionUser } from "./fixtures/sessionUserStub";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

const activityRows: Array<{ eventType: string; metadata: Record<string, unknown> }> = [];
const stubPrisma = {
  // A body that renders the parser's output, so the Anthropic request shows it.
  aIPrompt: {
    findUnique: async () => ({
      id: "p",
      key: "import.reformat_for_kiwi",
      defaultModel: "claude-sonnet-4-6",
      defaultMode: "json",
      versions: [{ body: "{{rawRecipe}}", version: 1, isActive: true }],
    }),
  },
  systemSetting: { findUnique: async () => null },
  userActivity: {
    create: async ({ data }: { data: { eventType: string; metadata: Record<string, unknown> } }) => {
      activityRows.push(data);
      return data;
    },
  },
  lLMCallLog: { create: async ({ data }: { data: unknown }) => data },
};

const anthropicBodies: string[] = [];
let aiReply: unknown = null;
const originalFetch = globalThis.fetch;
(globalThis as { fetch: typeof fetch }).fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (url.includes("api.anthropic.com")) {
    anthropicBodies.push(
      typeof init?.body === "string"
        ? init.body
        : await new Response(init?.body ?? (input instanceof Request ? await input.text() : "")).text(),
    );
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: JSON.stringify(aiReply) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 200 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return originalFetch(input, init);
}) as typeof fetch;

const RECIPE = {
  status: "success",
  recipe: {
    meal: {
      title: "Weeknight Lasagna",
      cuisineType: "Italian",
      mealType: "dinner",
      estimatedTimeMinutes: 60,
      difficulty: "medium",
      servingsDefault: 6,
    },
    dishes: [
      {
        title: "Lasagna",
        role: "main",
        positionIndex: 0,
        ingredients: [{ name: "lasagna noodles", quantity: 1, unit: "lb" }],
        steps: [
          {
            stepIndex: 0,
            stepTextRaw: "Simmer the sauce.",
            stepTextTranslated: "Simmer the sauce for 20 minutes.",
            estimatedMinutes: 20,
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
const NO_RECIPE = { status: "no_recipe_content", reason: "a list of recipes, not one recipe" };

const BLOCKED_URL = "http://169.254.169.254/recipes/weeknight-lasagna";

const JSON_LD_PAGE = `<!doctype html><html><head><title>Weeknight Lasagna</title>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Weeknight Lasagna JSONLD",
  recipeIngredient: ["1 pound lasagna noodles", "2 cups ricotta"],
  recipeInstructions: [{ "@type": "HowToStep", text: "Simmer the sauce." }],
  recipeYield: "6 servings",
})}</script></head><body><p>Weeknight Lasagna</p></body></html>`;

const TEXT_PAGE = `<!doctype html><html><head><title>Grandma</title></head><body>
<header>Signed in as cook@example.com</header>
<article><h1>Grandma Soup</h1><p>Simmer the broth with the carrots for an hour.</p></article>
</body></html>`;

describe("IMPORT-2 — import-url reads a page the cook sent", () => {
  let baseUrl = "";
  let server: Server;
  const token = signToken("import2-user");

  before(async () => {
    const router: Express = express();
    // No global parser: app.ts skips its 100 KB default for this path, so the
    // route's own parser is the only one in play (as in bug220ParserOrder).
    router.use(
      createRecipesRouter({
        prisma: withSessionUser(stubPrisma) as never,
        subscriptionService: { can: async () => ({ allowed: true }) } as never,
      }),
    );
    server = await new Promise((r) => {
      const s = router.listen(0, "127.0.0.1", () => r(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    __clearRateLimitStoreForTests();
    anthropicBodies.length = 0;
    activityRows.length = 0;
  });

  const post = (body: unknown, auth = true) =>
    fetch(`${baseUrl}/recipes/import-url`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("a page with JSON-LD: no fetch, the JSON-LD rides as hints, one AI call", async () => {
    aiReply = RECIPE;
    const res = await post({ url: BLOCKED_URL, html: JSON_LD_PAGE });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body["success"], true, JSON.stringify(body));
    assert.equal(body["source"], "structured_data");
    assert.equal(body["sourceUrl"], BLOCKED_URL);
    assert.equal(anthropicBodies.length, 1);
    assert.match(anthropicBodies[0]!, /Weeknight Lasagna JSONLD/);
    assert.match(anthropicBodies[0]!, /structuredHints/);
    await new Promise((r) => setImmediate(r));
    assert.equal(activityRows[0]?.eventType, "recipe_imported_url");
    assert.equal(activityRows[0]?.metadata["via"], "in_app_browser");
  });

  it("a page without JSON-LD: the page text, header dropped by the same parser", async () => {
    aiReply = RECIPE;
    const res = await post({ url: "https://cooking.example.com/soup", html: TEXT_PAGE });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["success"], true, JSON.stringify(body));
    assert.equal(body["source"], "ai_fallback");
    assert.equal(anthropicBodies.length, 1);
    assert.match(anthropicBodies[0]!, /Simmer the broth with the carrots/);
    assert.doesNotMatch(anthropicBodies[0]!, /cook@example\.com/);
  });

  it("a page that is not a recipe: the importer's existing couldn't-read answer", async () => {
    aiReply = NO_RECIPE;
    const res = await post({ url: "https://cooking.example.com/", html: TEXT_PAGE });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["success"], false);
    assert.equal(body["reason"], "url_parse_failed");
    assert.match(String(body["userFacingMessage"]), /couldn't read this recipe/);
  });

  it("a page past 100 KB is read (the default parser would have 413'd it)", async () => {
    aiReply = RECIPE;
    const html = JSON_LD_PAGE.replace("<body>", `<body><p>${"x".repeat(300_000)}</p>`);
    const res = await post({ url: BLOCKED_URL, html });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body["success"], true, JSON.stringify(body));
  });

  it("a page over the cap is refused before any AI call", async () => {
    const res = await post({ url: BLOCKED_URL, html: "x".repeat(MAX_PAGE_HTML_CHARS + 1) });
    assert.equal(res.status, 400);
    assert.equal(anthropicBodies.length, 0);
  });

  it("a page needs a web address to be its source", async () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
      const res = await post({ url, html: TEXT_PAGE });
      assert.equal(res.status, 400, url);
    }
    assert.equal(anthropicBodies.length, 0);
  });

  it("without html the route still fetches (the blocked host is refused as before)", async () => {
    const res = await post({ url: BLOCKED_URL });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["reason"], "fetch_error");
    assert.equal(anthropicBodies.length, 0);
  });

  it("BUG-220's rule: an oversized body with no credentials is 401, with credentials 413", async () => {
    const oversized = JSON.stringify({ url: BLOCKED_URL, html: "x".repeat(5 * 1024 * 1024) });
    assert.equal((await post(oversized, false)).status, 401);
    assert.equal((await post(oversized, true)).status, 413);
  });
});

