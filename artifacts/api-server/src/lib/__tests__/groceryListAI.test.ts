// WS6 6c-4 Block B — groceryListAI helper unit tests.
// Run via: pnpm --filter @workspace/api-server test
// SDK is mocked by injecting opts.client; Prisma is a hand-rolled stub.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@prisma/client";

import {
  GroceryListAIError,
  categorizeGroceryItem,
  fillPurchaseSizesWithWriteBack,
  gapFillPurchaseSize,
  generateFinalGroceryList,
  partitionForAI,
} from "../groceryListAI";
import { _resetClientCache } from "../ai/runAICall";
import { _resetRegistryCaches } from "../ai/promptRegistry";
import type {
  AIPromptRow,
  LLMCallLogCreateData,
  PrismaLike,
  SystemSettingRow,
} from "../ai/promptRegistry";
import type { ConsolidatedItem } from "../groceryList";
import { logger } from "../logger";

// ── stub prisma ────────────────────────────────────────────────────────

interface IngredientUpdateCall {
  id: string;
  data: {
    purchaseUnit: string;
    purchaseQuantity: number;
    purchaseDisplay: string;
  };
}

// Return a synthetic prompt row keyed off the supplied key. The body wraps
// the var placeholder so runAICall's renderPromptBody substitution surfaces
// the input JSON into the user message — without this, the stub falls back
// to the in-memory REGISTRY's placeholder() body, which strips the input
// and prevents tests from asserting on the forwarded shape.
const PROMPT_VARS: Record<string, string> = {
  "grocery.gap_fill_purchase_size": "gapFillInput",
  "grocery.generate_list": "generateInput",
  // 6c-6 Block B — itemText is the primary input; the other two are passed
  // through as JSON-stringified arrays/strings via runAICall's renderPromptBody.
  "grocery.recurring_item_categorize": "itemText",
};

function syntheticPromptRow(key: string): AIPromptRow | null {
  const varName = PROMPT_VARS[key];
  if (!varName) return null;
  const isSonnet = key === "grocery.generate_list";
  return {
    id: `prompt-${key}`,
    key,
    defaultModel: isSonnet ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001",
    defaultMode: "text",
    versions: [
      {
        body: `Test body for ${key}. INPUT: {{${varName}}} END.`,
        version: 1,
        isActive: true,
      },
    ],
  };
}

interface StubPrisma {
  prisma: PrismaClient;
  llmCalls: () => LLMCallLogCreateData[];
  ingredientUpdates: () => IngredientUpdateCall[];
  // WS7-5d Block 3 Fix C — assertable count of $transaction(promiseArray)
  // batched-writeback invocations.
  transactionCalls: () => number;
}

function makeStubPrisma(): StubPrisma {
  const llmCalls: LLMCallLogCreateData[] = [];
  const ingredientUpdates: IngredientUpdateCall[] = [];
  let transactionCalls = 0;
  const inner: PrismaLike & {
    ingredient: {
      update: (args: {
        where: { id: string };
        data: IngredientUpdateCall["data"];
      }) => Promise<unknown>;
    };
    $transaction: (ops: Promise<unknown>[]) => Promise<unknown[]>;
  } = {
    aIPrompt: {
      findUnique: async (args: {
        where: { key: string };
      }): Promise<AIPromptRow | null> => syntheticPromptRow(args.where.key),
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
    ingredient: {
      update: async (args) => {
        ingredientUpdates.push({ id: args.where.id, data: args.data });
        return { id: args.where.id, ...args.data };
      },
    },
    // WS7-5d Block 3 Fix C — fillPurchaseSizesWithWriteBack batches its
    // per-row update calls into a single $transaction(promiseArray) so the
    // real prisma replaces N concurrent UPDATEs with one round-trip. The
    // stub's update fn already resolves eagerly when called, so $transaction
    // is effectively `await Promise.all`; the call count is recorded so
    // tests can assert the batching contract.
    $transaction: async (ops: Promise<unknown>[]) => {
      transactionCalls++;
      return Promise.all(ops);
    },
  };
  return {
    prisma: inner as unknown as PrismaClient,
    llmCalls: () => llmCalls,
    ingredientUpdates: () => ingredientUpdates,
    transactionCalls: () => transactionCalls,
  };
}


// ── fake Anthropic client ──────────────────────────────────────────────

interface QueuedResponse {
  content: Anthropic.ContentBlock[];
  inputTokens?: number;
  outputTokens?: number;
}

interface FakeClient {
  client: Pick<Anthropic, "messages">;
  callCount: () => number;
  lastUserMessage: () => string | null;
}

function makeFakeClient(responses: QueuedResponse[]): FakeClient {
  let calls = 0;
  let lastUserMessage: string | null = null;
  const queue = [...responses];
  const client = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParams,
      ): Promise<Anthropic.Message> => {
        calls++;
        const first = params.messages[0];
        if (first && typeof first.content === "string") {
          lastUserMessage = first.content;
        } else if (first && Array.isArray(first.content)) {
          const text = first.content.find(
            (b): b is Anthropic.TextBlockParam => b.type === "text",
          );
          lastUserMessage = text ? text.text : null;
        }
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
            input_tokens: next.inputTokens ?? 100,
            output_tokens: next.outputTokens ?? 50,
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
    lastUserMessage: () => lastUserMessage,
  };
}

function textBlock(payload: unknown): Anthropic.ContentBlock {
  return {
    type: "text",
    text: typeof payload === "string" ? payload : JSON.stringify(payload),
    citations: null,
  } as Anthropic.ContentBlock;
}

// ── env hygiene ────────────────────────────────────────────────────────

let savedKey: string | undefined;
before(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
});
after(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  _resetClientCache();
  _resetRegistryCaches();
});

const TEST_USER_ID = "test-user-grocery-list-ai";

function makeItem(overrides: Partial<ConsolidatedItem> = {}): ConsolidatedItem {
  return {
    ingredientId: "ing-1",
    canonicalName: "tomato paste",
    displayName: "tomato paste",
    quantity: 3,
    unit: "tbsp",
    sectionKey: "pantry",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    sources: [
      {
        mealId: "meal-1",
        dishId: "dish-1",
        servings: 4,
        ingredientSignature: "sig-1",
      },
    ],
    purchaseUnit: null,
    purchaseQuantity: null,
    purchaseDisplay: null,
    conversionRef: null,
    preparationNote: null,
    sourceDishTitle: null,
    ...overrides,
  };
}

// ── gapFillPurchaseSize ────────────────────────────────────────────────

describe("gapFillPurchaseSize", () => {
  it("returns the parsed PurchaseSizeResult on happy path", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            purchaseUnit: "can",
            purchaseQuantity: 1,
            purchaseDisplay: "1 can (6 oz)",
            confidence: "high",
          }),
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await gapFillPurchaseSize(
      { canonicalName: "tomato paste", requestedQuantity: 3, requestedUnit: "tbsp" },
      { prisma, userId: TEST_USER_ID, client: fake.client },
    );

    assert.equal(result.purchaseUnit, "can");
    assert.equal(result.purchaseQuantity, 1);
    assert.equal(result.purchaseDisplay, "1 can (6 oz)");
    assert.equal(result.confidence, "high");
    assert.equal(fake.callCount(), 1);
  });

  it("throws GroceryListAIError when AI repeatedly returns malformed JSON", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      { content: [textBlock({ purchaseUnit: "can" })] }, // missing required fields
      { content: [textBlock("not even json")] }, // retry still bad
    ]);
    const { prisma } = makeStubPrisma();

    await assert.rejects(
      () =>
        gapFillPurchaseSize(
          { canonicalName: "saffron", requestedQuantity: 0.25, requestedUnit: "tsp" },
          { prisma, userId: TEST_USER_ID, client: fake.client },
        ),
      (err: unknown) => err instanceof GroceryListAIError,
    );
  });
});

// ── fillPurchaseSizesWithWriteBack ─────────────────────────────────────

describe("fillPurchaseSizesWithWriteBack", () => {
  it("cache hit: skips AI call and Ingredient update when fields are populated", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([]); // no responses queued → throws if called
    const { prisma, llmCalls, ingredientUpdates } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      makeItem({
        purchaseUnit: "lb",
        purchaseQuantity: 1,
        purchaseDisplay: "1 lb pack",
      }),
    ];

    const filled = await fillPurchaseSizesWithWriteBack(items, {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(filled.length, 1);
    assert.equal(filled[0].purchaseUnit, "lb");
    assert.equal(fake.callCount(), 0);
    assert.equal(ingredientUpdates().length, 0);
    assert.equal(llmCalls().length, 0);
  });

  it("cache miss + write-back: calls AI once and updates the Ingredient row", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            purchaseUnit: "can",
            purchaseQuantity: 1,
            purchaseDisplay: "1 can (6 oz)",
            confidence: "high",
          }),
        ],
      },
    ]);
    const { prisma, ingredientUpdates } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      makeItem({ ingredientId: "ing-tomato", purchaseUnit: null }),
    ];

    const filled = await fillPurchaseSizesWithWriteBack(items, {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(fake.callCount(), 1);
    assert.equal(filled[0].purchaseUnit, "can");
    assert.equal(filled[0].purchaseQuantity, 1);
    assert.equal(filled[0].purchaseDisplay, "1 can (6 oz)");

    const updates = ingredientUpdates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "ing-tomato");
    assert.equal(updates[0].data.purchaseUnit, "can");
    assert.equal(updates[0].data.purchaseQuantity, 1);
    assert.equal(updates[0].data.purchaseDisplay, "1 can (6 oz)");
  });

  it("cache miss + ingredientId=null: calls AI and fills ephemerally, no Ingredient update", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            purchaseUnit: "each",
            purchaseQuantity: 1,
            purchaseDisplay: "1 each",
            confidence: "medium",
          }),
        ],
      },
    ]);
    const { prisma, ingredientUpdates } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      makeItem({
        ingredientId: null, // synthetic recurring entry — no Ingredient row
        canonicalName: "kombucha",
        displayName: "kombucha",
        sectionKey: "extras",
        unit: "each",
        quantity: 1,
        isRecurringItem: true,
      }),
    ];

    const filled = await fillPurchaseSizesWithWriteBack(items, {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(fake.callCount(), 1);
    assert.equal(filled[0].purchaseUnit, "each");
    assert.equal(filled[0].purchaseDisplay, "1 each");
    assert.equal(filled[0].ingredientId, null);
    assert.equal(ingredientUpdates().length, 0);
  });

  it("mixed batch: 1 cache hit + 1 miss-with-id + 1 miss-without-id → 2 AI calls, 1 Ingredient update", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            purchaseUnit: "lb",
            purchaseQuantity: 1,
            purchaseDisplay: "1 lb pack",
            confidence: "high",
          }),
        ],
      },
      {
        content: [
          textBlock({
            purchaseUnit: "each",
            purchaseQuantity: 1,
            purchaseDisplay: "1 each",
            confidence: "medium",
          }),
        ],
      },
    ]);
    const { prisma, ingredientUpdates } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      makeItem({
        canonicalName: "olive oil",
        ingredientId: "ing-olive-oil",
        purchaseUnit: "bottle",
        purchaseQuantity: 1,
        purchaseDisplay: "1 bottle (16.9 fl oz)",
      }),
      makeItem({
        canonicalName: "chicken thighs",
        ingredientId: "ing-chicken",
      }),
      makeItem({
        canonicalName: "kombucha",
        ingredientId: null,
        unit: "each",
        quantity: 1,
      }),
    ];

    const filled = await fillPurchaseSizesWithWriteBack(items, {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(filled.length, 3);
    assert.equal(fake.callCount(), 2);

    const updates = ingredientUpdates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "ing-chicken");

    // Hit: passed through unchanged.
    assert.equal(filled[0].purchaseUnit, "bottle");
    // Miss + write-back: filled and recorded.
    assert.equal(filled[1].purchaseUnit, "lb");
    // Miss + no ID: filled in-memory only.
    assert.equal(filled[2].purchaseUnit, "each");
    assert.equal(filled[2].ingredientId, null);
  });

  // ── WS7-5d Block 3 Fix C — parallel gap-fill + batched write-back ────

  it("batches all writebacks into a single $transaction call (Fix C audit response)", async () => {
    // 3 misses, all with ingredientId → 3 writebacks. Pre-Block-3 this was
    // 3 concurrent UPDATEs inside a serial for-await loop; Fix C collapses
    // them to ONE $transaction(promiseArray) envelope.
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      { content: [textBlock({ purchaseUnit: "lb", purchaseQuantity: 1, purchaseDisplay: "1 lb", confidence: "high" })] },
      { content: [textBlock({ purchaseUnit: "can", purchaseQuantity: 1, purchaseDisplay: "1 can (28 oz)", confidence: "high" })] },
      { content: [textBlock({ purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", confidence: "high" })] },
    ]);
    const { prisma, ingredientUpdates, transactionCalls } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      makeItem({ canonicalName: "chicken breast", ingredientId: "ing-a" }),
      makeItem({ canonicalName: "crushed tomatoes", ingredientId: "ing-b" }),
      makeItem({ canonicalName: "parsley", ingredientId: "ing-c" }),
    ];

    await fillPurchaseSizesWithWriteBack(items, {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(fake.callCount(), 3, "AI must be called once per miss");
    assert.equal(ingredientUpdates().length, 3, "writeback per item with ingredientId");
    assert.equal(transactionCalls(), 1, "all writebacks batched into ONE $transaction");
  });

  it("skips $transaction entirely when no items have ingredientId", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      { content: [textBlock({ purchaseUnit: "each", purchaseQuantity: 1, purchaseDisplay: "1 each", confidence: "low" })] },
      { content: [textBlock({ purchaseUnit: "each", purchaseQuantity: 1, purchaseDisplay: "1 each", confidence: "low" })] },
    ]);
    const { prisma, ingredientUpdates, transactionCalls } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      makeItem({ ingredientId: null, canonicalName: "kombucha", unit: "each", quantity: 1 }),
      makeItem({ ingredientId: null, canonicalName: "ramen", unit: "each", quantity: 1 }),
    ];

    await fillPurchaseSizesWithWriteBack(items, {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(fake.callCount(), 2);
    assert.equal(ingredientUpdates().length, 0);
    assert.equal(transactionCalls(), 0, "no $transaction when no writebacks");
  });

  it("preserves original input order in the filled output (parallel fan-out is order-preserving)", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    // Distinct purchaseUnit values per response so output order is
    // verifiable against the input order.
    const fake = makeFakeClient([
      { content: [textBlock({ purchaseUnit: "lb", purchaseQuantity: 1, purchaseDisplay: "1 lb", confidence: "high" })] },
      { content: [textBlock({ purchaseUnit: "can", purchaseQuantity: 1, purchaseDisplay: "1 can", confidence: "high" })] },
      { content: [textBlock({ purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", confidence: "high" })] },
    ]);
    const { prisma } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      // Position 0: cache HIT (pass-through).
      makeItem({
        canonicalName: "olive oil",
        purchaseUnit: "bottle",
        purchaseQuantity: 1,
        purchaseDisplay: "1 bottle (17 oz)",
      }),
      // Position 1: cache MISS.
      makeItem({ canonicalName: "chicken breast", ingredientId: "ing-a" }),
      // Position 2: cache HIT.
      makeItem({
        canonicalName: "salt",
        purchaseUnit: "container",
        purchaseQuantity: 1,
        purchaseDisplay: "1 container (26 oz)",
      }),
      // Position 3: cache MISS.
      makeItem({ canonicalName: "crushed tomatoes", ingredientId: "ing-b" }),
      // Position 4: cache MISS.
      makeItem({ canonicalName: "parsley", ingredientId: "ing-c" }),
    ];

    const filled = await fillPurchaseSizesWithWriteBack(items, {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(filled.length, 5);
    // Hits unchanged at their original positions.
    assert.equal(filled[0].purchaseUnit, "bottle");
    assert.equal(filled[2].purchaseUnit, "container");
    // Misses filled at their original positions, in input order matching
    // the queued response order.
    assert.equal(filled[1].purchaseUnit, "lb");
    assert.equal(filled[3].purchaseUnit, "can");
    assert.equal(filled[4].purchaseUnit, "bunch");
  });
});

// (formatPackDisplay moved to the client — kiwi/lib/format/grocery.ts — in
// commit 3; the pack is now persisted as data and composed at render.)

// ── partitionForAI (WS7-5d Block 3 Fix A) ──────────────────────────────

describe("partitionForAI", () => {
  function specificItem(overrides: Partial<ConsolidatedItem> = {}): ConsolidatedItem {
    // "Specific" defaults: non-vague canonical, non-extras section, fully-
    // populated purchase fields, unique unit per canonical. Items built from
    // this helper partition to the deterministic side unless overrides
    // override one of the three criteria.
    return makeItem({
      canonicalName: "olive oil",
      displayName: "olive oil",
      sectionKey: "pantry",
      purchaseUnit: "bottle",
      purchaseQuantity: 1,
      purchaseDisplay: "1 bottle (17 oz)",
      ...overrides,
    });
  }

  it("routes vague canonicals to the AI subset", () => {
    const items = [
      specificItem({ canonicalName: "chicken" }),
      specificItem({ canonicalName: "berries" }),
      specificItem({ canonicalName: "yogurt" }),
      specificItem({ canonicalName: "kale" }), // not vague
    ];
    const { deterministic, aiSubset } = partitionForAI(items);
    assert.equal(aiSubset.length, 3);
    assert.equal(deterministic.length, 1);
    assert.equal(deterministic[0].item.canonicalName, "kale");
  });

  it("routes extras-bucket items to the AI subset", () => {
    const items = [
      specificItem({ canonicalName: "chia seeds", sectionKey: "extras" }),
      specificItem({ canonicalName: "olive oil", sectionKey: "pantry" }),
    ];
    const { deterministic, aiSubset } = partitionForAI(items);
    assert.equal(aiSubset.length, 1);
    assert.equal(aiSubset[0].item.canonicalName, "chia seeds");
    assert.equal(deterministic.length, 1);
  });

  it("routes both sides of a same-canonical-different-unit pair to the AI subset", () => {
    // Rule-2 reconciliation needs both rows; partition must keep them
    // together on the AI side.
    const items = [
      specificItem({ canonicalName: "olive oil", unit: "tbsp" }),
      specificItem({ canonicalName: "olive oil", unit: "cup" }),
      specificItem({ canonicalName: "kale", unit: "bunch" }),
    ];
    const { deterministic, aiSubset } = partitionForAI(items);
    assert.equal(aiSubset.length, 2);
    assert.equal(deterministic.length, 1);
    assert.equal(deterministic[0].item.canonicalName, "kale");
  });

  it("routes all-specific-non-extras-single-unit items entirely to deterministic", () => {
    const items = [
      specificItem({ canonicalName: "kale" }),
      specificItem({ canonicalName: "olive oil" }),
      specificItem({ canonicalName: "salt" }),
    ];
    const { deterministic, aiSubset } = partitionForAI(items);
    assert.equal(aiSubset.length, 0);
    assert.equal(deterministic.length, 3);
  });

  it("preserves original positions in the index field for stable merge ordering", () => {
    const items = [
      specificItem({ canonicalName: "kale" }), // deterministic, index 0
      specificItem({ canonicalName: "chicken" }), // ai, index 1
      specificItem({ canonicalName: "olive oil" }), // deterministic, index 2
    ];
    const { deterministic, aiSubset } = partitionForAI(items);
    assert.deepEqual(
      deterministic.map((p) => p.index),
      [0, 2],
    );
    assert.deepEqual(
      aiSubset.map((p) => p.index),
      [1],
    );
  });
});

// ── generateFinalGroceryList ───────────────────────────────────────────

describe("generateFinalGroceryList", () => {
  function baseInputItem(overrides: Partial<ConsolidatedItem> = {}): ConsolidatedItem {
    return makeItem({
      purchaseUnit: "lb",
      purchaseQuantity: 1,
      purchaseDisplay: "1 lb pack",
      ...overrides,
    });
  }

  // ── deterministic path (Fix A: no AI when nothing needs AI) ──────────

  describe("deterministic path (Fix A skip + Fix B formatter)", () => {
    it("skips the Sonnet call entirely when every item partitions to deterministic", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      // No responses queued — if the helper hits the AI, the fake client
      // throws ("fake client exhausted"). That's the assertion we want.
      const fake = makeFakeClient([]);
      const { prisma } = makeStubPrisma();

      const items: ConsolidatedItem[] = [
        baseInputItem({
          canonicalName: "yellow onion",
          displayName: "yellow onion",
          quantity: 2,
          unit: "each",
          sectionKey: "produce",
          purchaseUnit: "each",
          purchaseQuantity: 2,
          purchaseDisplay: "2 onions",
        }),
        baseInputItem({
          canonicalName: "chicken breast",
          displayName: "chicken breast",
          sectionKey: "meat_seafood",
          purchaseUnit: "lb",
          purchaseQuantity: 1,
          purchaseDisplay: "1 lb",
        }),
      ];

      const result = await generateFinalGroceryList(
        "Weeknight Plan",
        items,
        ["produce", "meat_seafood", "extras"],
        { prisma, userId: TEST_USER_ID, client: fake.client },
      );

      assert.equal(fake.callCount(), 0, "Sonnet must not be called");
      assert.equal(result.items.length, 2);
      // WS7-8b B2 commit 3 — displayName is the RAW name; the pack is data.
      assert.equal(result.items[1].displayName, "chicken breast");
      assert.equal(result.items[1].purchaseDisplay, "1 lb");
      assert.equal(result.items[0].displayName, "yellow onion");
      assert.equal(result.items[0].purchaseDisplay, "2 onions");
      // wasAiInferred is false for the deterministic path.
      assert.ok(result.items.every((i) => i.wasAiInferred === false));
      assert.ok(result.items.every((i) => i.isAmbiguous === false));
    });

    it("head↔clove pack scaling lands in purchaseDisplay as DATA (BUG-025-1)", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      const fake = makeFakeClient([]); // deterministic → no AI
      const { prisma } = makeStubPrisma();

      // 30 cloves of garlic → buy 3 heads. Pack rides as a field; name is raw.
      const items: ConsolidatedItem[] = [
        baseInputItem({
          canonicalName: "garlic",
          displayName: "garlic",
          quantity: 30,
          unit: "clove",
          sectionKey: "produce",
          purchaseUnit: "head",
          purchaseQuantity: 1,
          purchaseDisplay: "1 head",
          conversionRef: { subUnit: { parent: "head", perParent: 10 }, purchaseUnit: "head", purchaseDisplay: "1 head", source: "curated" },
        }),
      ];

      const result = await generateFinalGroceryList(
        "Plan",
        items,
        ["produce", "extras"],
        { prisma, userId: TEST_USER_ID, client: fake.client },
      );

      assert.equal(fake.callCount(), 0);
      assert.equal(result.items[0].displayName, "garlic"); // raw name
      assert.equal(result.items[0].purchaseDisplay, "3 heads"); // scaled pack, as data
      assert.equal(result.items[0].purchaseQuantity, 3);
      assert.equal(result.items[0].quantity, 30); // need unchanged, fine-grained
      assert.equal(result.items[0].unit, "clove");
    });

    it("preserves flags 1:1 on the deterministic path (no AI re-emission risk)", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      const fake = makeFakeClient([]); // would throw on AI call
      const { prisma } = makeStubPrisma();

      const inputItems: ConsolidatedItem[] = [
        baseInputItem({
          canonicalName: "salt",
          displayName: "salt",
          isUniversalStaple: true,
          isUserPantryStaple: false,
          isRecurringItem: false,
        }),
        baseInputItem({
          canonicalName: "olive oil",
          displayName: "olive oil",
          isUniversalStaple: true,
          isUserPantryStaple: true,
          isRecurringItem: false,
        }),
        baseInputItem({
          canonicalName: "coffee",
          displayName: "coffee",
          isUniversalStaple: false,
          isUserPantryStaple: false,
          isRecurringItem: true,
        }),
        baseInputItem({
          canonicalName: "kale",
          displayName: "kale",
          isUniversalStaple: false,
          isUserPantryStaple: false,
          isRecurringItem: false,
        }),
      ];

      const result = await generateFinalGroceryList(
        "Plan",
        inputItems,
        ["produce", "pantry", "extras"],
        { prisma, userId: TEST_USER_ID, client: fake.client },
      );

      assert.equal(fake.callCount(), 0);
      assert.equal(result.items.length, 4);
      for (let i = 0; i < inputItems.length; i++) {
        assert.equal(
          result.items[i].isUniversalStaple,
          inputItems[i].isUniversalStaple,
          `isUniversalStaple mismatch at index ${i}`,
        );
        assert.equal(
          result.items[i].isUserPantryStaple,
          inputItems[i].isUserPantryStaple,
          `isUserPantryStaple mismatch at index ${i}`,
        );
        assert.equal(
          result.items[i].isRecurringItem,
          inputItems[i].isRecurringItem,
          `isRecurringItem mismatch at index ${i}`,
        );
      }
    });
  });

  // ── AI subset path (Fix A: only vague/extras/unit-mismatch reach AI) ─

  describe("AI subset path", () => {
    it("sends only the AI subset to Sonnet (deterministic items stay local)", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      const fake = makeFakeClient([
        {
          content: [
            textBlock({
              items: [
                {
                  canonicalName: "chicken",
                  displayName: "boneless skinless chicken breasts, 1 lb",
                  quantity: 1,
                  unit: "lb",
                  sectionKey: "meat_seafood",
                  isUniversalStaple: false,
                  isUserPantryStaple: false,
                  isRecurringItem: false,
                  notes: null,
                  isAmbiguous: true,
                  ambiguityOptions: ["thighs", "rotisserie", "ground"],
                  wasAiInferred: true,
                },
              ],
            }),
          ],
        },
      ]);
      const { prisma } = makeStubPrisma();

      const items: ConsolidatedItem[] = [
        baseInputItem({ canonicalName: "kale", displayName: "kale" }),
        baseInputItem({
          canonicalName: "chicken",
          displayName: "chicken",
          sectionKey: "meat_seafood",
        }),
        baseInputItem({ canonicalName: "olive oil", displayName: "olive oil" }),
      ];

      const result = await generateFinalGroceryList(
        "Plan",
        items,
        ["produce", "meat_seafood", "pantry", "extras"],
        { prisma, userId: TEST_USER_ID, client: fake.client },
      );

      assert.equal(fake.callCount(), 1);
      assert.equal(result.items.length, 3);

      // Sent payload must contain only the chicken item, not kale or olive oil.
      const sent = fake.lastUserMessage();
      assert.ok(sent && sent.includes("chicken"));
      assert.ok(sent && !sent.includes("\"kale\""));
      assert.ok(sent && !sent.includes("\"olive oil\""));

      // Merged output is index-ordered: kale (0), chicken (1), olive oil (2).
      assert.equal(result.items[0].canonicalName, "kale");
      assert.equal(result.items[1].canonicalName, "chicken");
      assert.equal(result.items[2].canonicalName, "olive oil");

      // AI item carries AI-derived fields; deterministic items don't.
      assert.equal(result.items[1].isAmbiguous, true);
      assert.equal(result.items[1].wasAiInferred, true);
      assert.equal(result.items[0].wasAiInferred, false);
      assert.equal(result.items[2].wasAiInferred, false);
    });

    it("re-sweeps an off-ladder AI-merged quantity onto the ⅛ ladder (BUG-031, the 3.97 fix)", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      // The AI merge path (rule 2) returns an off-ladder float — the exact
      // 3.97-oz symptom. Before B2 this reached the user verbatim; now the
      // re-sweep snaps it to 4 oz, and the purchase pack is composed on.
      const fake = makeFakeClient([
        {
          content: [
            textBlock({
              items: [
                {
                  canonicalName: "cheese",
                  displayName: "parmesan cheese",
                  quantity: 3.97,
                  unit: "oz",
                  sectionKey: "dairy_eggs",
                  isUniversalStaple: false,
                  isUserPantryStaple: false,
                  isRecurringItem: false,
                  notes: "combined 3 oz + 0.5 cup",
                  isAmbiguous: false,
                  wasAiInferred: true,
                },
              ],
            }),
          ],
        },
      ]);
      const { prisma } = makeStubPrisma();

      // "cheese" is a vague canonical → routes to the AI subset.
      const items: ConsolidatedItem[] = [
        baseInputItem({
          canonicalName: "cheese",
          displayName: "cheese",
          quantity: 3.97,
          unit: "oz",
          sectionKey: "dairy_eggs",
          purchaseUnit: "wedge",
          purchaseQuantity: 1,
          purchaseDisplay: "1 wedge (6 oz)",
        }),
      ];

      const result = await generateFinalGroceryList(
        "Plan",
        items,
        ["dairy_eggs", "extras"],
        { prisma, userId: TEST_USER_ID, client: fake.client },
      );

      assert.equal(fake.callCount(), 1);
      assert.equal(result.items.length, 1);
      // Re-swept: 3.97 oz → 4 oz (measured ladder rounds up to a whole here).
      assert.equal(result.items[0].quantity, 4);
      // WS7-8b B2 commit 3 — the pack rides as DATA (not baked into the name);
      // the client composes "1 wedge (6 oz) parmesan cheese (4 oz)" at render.
      assert.equal(result.items[0].displayName, "parmesan cheese");
      assert.equal(result.items[0].purchaseDisplay, "1 wedge (6 oz)");
    });

    it("threads preparationNote + sourceDishTitle into the AI input payload", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      const fake = makeFakeClient([
        {
          content: [
            textBlock({
              items: [
                {
                  canonicalName: "chicken",
                  displayName: "boneless skinless chicken breasts, 1 lb",
                  quantity: 1,
                  unit: "lb",
                  sectionKey: "meat_seafood",
                  isUniversalStaple: false,
                  isUserPantryStaple: false,
                  isRecurringItem: false,
                  notes: null,
                  isAmbiguous: true,
                  ambiguityOptions: [
                    "boneless skinless thighs",
                    "rotisserie chicken (pulled)",
                    "ground chicken",
                  ],
                  wasAiInferred: true,
                },
              ],
            }),
          ],
        },
      ]);
      const { prisma } = makeStubPrisma();

      const items: ConsolidatedItem[] = [
        baseInputItem({
          canonicalName: "chicken",
          displayName: "chicken",
          unit: "lb",
          quantity: 1,
          sectionKey: "meat_seafood",
          preparationNote: "shredded",
          sourceDishTitle: "Chicken Tacos",
        }),
      ];

      await generateFinalGroceryList(
        "Weeknight Plan",
        items,
        ["produce", "meat_seafood", "extras"],
        { prisma, userId: TEST_USER_ID, client: fake.client },
      );

      const sent = fake.lastUserMessage();
      assert.ok(sent, "should send a user message");
      assert.ok(sent.includes("Weeknight Plan"), "plan title must be in the prompt");
      assert.ok(sent.includes("shredded"), "prep note must be in the prompt");
      assert.ok(sent.includes("Chicken Tacos"), "dish title must be in the prompt");
    });

    it("threads isAmbiguous=true + ambiguityOptions back from the AI response", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      const fake = makeFakeClient([
        {
          content: [
            textBlock({
              items: [
                {
                  canonicalName: "berries",
                  displayName: "blueberries",
                  quantity: 2,
                  unit: "cup",
                  sectionKey: "produce",
                  isUniversalStaple: false,
                  isUserPantryStaple: false,
                  isRecurringItem: false,
                  notes: null,
                  isAmbiguous: true,
                  ambiguityOptions: ["strawberries", "raspberries", "mixed berries"],
                  wasAiInferred: true,
                },
              ],
            }),
          ],
        },
      ]);
      const { prisma } = makeStubPrisma();

      const items: ConsolidatedItem[] = [
        baseInputItem({
          canonicalName: "berries",
          displayName: "berries",
          sectionKey: "produce",
          unit: "cup",
          quantity: 2,
          sourceDishTitle: "Yogurt Parfait",
        }),
      ];

      const result = await generateFinalGroceryList(
        "Weekly Plan",
        items,
        ["produce", "extras"],
        { prisma, userId: TEST_USER_ID, client: fake.client },
      );

      assert.equal(result.items[0].isAmbiguous, true);
      assert.deepEqual(result.items[0].ambiguityOptions, [
        "strawberries",
        "raspberries",
        "mixed berries",
      ]);
      assert.equal(result.items[0].wasAiInferred, true);
    });

    it("trusts the AI response when it mutates a flag on a vague item", async () => {
      // This helper does NOT re-inject input flags over the AI response.
      // A flag-mutation regression should fail in the route-layer smoke
      // test, not silently here. If the AI flips a flag on an item that
      // legitimately reached the AI (vague canonical), the helper returns
      // the flipped value unchanged.
      _resetClientCache();
      _resetRegistryCaches();
      const inputItems: ConsolidatedItem[] = [
        baseInputItem({
          canonicalName: "chicken", // vague → goes through AI
          displayName: "chicken",
          sectionKey: "meat_seafood",
          isRecurringItem: true,
        }),
      ];
      const fake = makeFakeClient([
        {
          content: [
            textBlock({
              items: [
                {
                  canonicalName: "chicken",
                  displayName: "chicken breast, 1 lb",
                  quantity: inputItems[0].quantity,
                  unit: inputItems[0].unit,
                  sectionKey: inputItems[0].sectionKey,
                  isUniversalStaple: false,
                  isUserPantryStaple: false,
                  isRecurringItem: false, // AI mutated this — helper trusts it.
                  notes: null,
                  isAmbiguous: false,
                  wasAiInferred: true,
                },
              ],
            }),
          ],
        },
      ]);
      const { prisma } = makeStubPrisma();

      const result = await generateFinalGroceryList(
        "Plan",
        inputItems,
        ["produce", "meat_seafood", "extras"],
        { prisma, userId: TEST_USER_ID, client: fake.client },
      );

      assert.equal(result.items[0].isRecurringItem, false);
    });

    it("rejects responses where isAmbiguous=true is missing ambiguityOptions (Zod refine)", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      const fake = makeFakeClient([
        {
          content: [
            textBlock({
              items: [
                {
                  canonicalName: "chicken",
                  displayName: "chicken breast",
                  quantity: 1,
                  unit: "lb",
                  sectionKey: "meat_seafood",
                  isUniversalStaple: false,
                  isUserPantryStaple: false,
                  isRecurringItem: false,
                  notes: null,
                  isAmbiguous: true,
                  // ambiguityOptions omitted — should fail refine
                  wasAiInferred: true,
                },
              ],
            }),
          ],
        },
        { content: [textBlock("still bad")] },
      ]);
      const { prisma } = makeStubPrisma();

      await assert.rejects(
        () =>
          generateFinalGroceryList(
            "Plan",
            [baseInputItem({ canonicalName: "chicken" })],
            ["meat_seafood", "extras"],
            { prisma, userId: TEST_USER_ID, client: fake.client },
          ),
        (err: unknown) => err instanceof GroceryListAIError,
      );
    });
  });

  // ── invariants ───────────────────────────────────────────────────────

  describe("no-add invariants", () => {
    it("throws GroceryListAIError when AI returns more items than the AI subset", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      // 3 vague inputs → AI subset of 3. AI returns 4 → local guard throws.
      const inputItems: ConsolidatedItem[] = [
        baseInputItem({ canonicalName: "chicken", sectionKey: "meat_seafood" }),
        baseInputItem({ canonicalName: "berries", sectionKey: "produce" }),
        baseInputItem({ canonicalName: "cheese", sectionKey: "dairy_eggs" }),
      ];
      const fake = makeFakeClient([
        {
          content: [
            textBlock({
              items: [
                { canonicalName: "chicken", displayName: "chicken", quantity: 1, unit: "lb", sectionKey: "meat_seafood", isUniversalStaple: false, isUserPantryStaple: false, isRecurringItem: false, notes: null, isAmbiguous: false, wasAiInferred: false },
                { canonicalName: "berries", displayName: "berries", quantity: 1, unit: "cup", sectionKey: "produce", isUniversalStaple: false, isUserPantryStaple: false, isRecurringItem: false, notes: null, isAmbiguous: false, wasAiInferred: false },
                { canonicalName: "cheese", displayName: "cheese", quantity: 1, unit: "oz", sectionKey: "dairy_eggs", isUniversalStaple: false, isUserPantryStaple: false, isRecurringItem: false, notes: null, isAmbiguous: false, wasAiInferred: false },
                { canonicalName: "ghost", displayName: "ghost", quantity: 1, unit: "each", sectionKey: "extras", isUniversalStaple: false, isUserPantryStaple: false, isRecurringItem: false, notes: null, isAmbiguous: false, wasAiInferred: false },
              ],
            }),
          ],
        },
      ]);
      const { prisma } = makeStubPrisma();

      await assert.rejects(
        () =>
          generateFinalGroceryList(
            "Plan",
            inputItems,
            ["produce", "meat_seafood", "dairy_eggs", "extras"],
            { prisma, userId: TEST_USER_ID, client: fake.client },
          ),
        (err: unknown) =>
          err instanceof GroceryListAIError &&
          /item count must not increase/.test(err.message),
      );
    });

    it("throws GroceryListAIError when AI returns malformed shape (bad sectionKey)", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      const inputItems: ConsolidatedItem[] = [
        baseInputItem({ canonicalName: "chicken", sectionKey: "meat_seafood" }),
      ];
      const fake = makeFakeClient([
        {
          content: [
            textBlock({
              items: [
                {
                  canonicalName: "chicken",
                  displayName: "chicken",
                  quantity: 1,
                  unit: "each",
                  sectionKey: "not_a_real_section",
                  isUniversalStaple: false,
                  isUserPantryStaple: false,
                  isRecurringItem: false,
                  notes: null,
                  isAmbiguous: false,
                  wasAiInferred: false,
                },
              ],
            }),
          ],
        },
        { content: [textBlock("still bad")] },
      ]);
      const { prisma } = makeStubPrisma();

      await assert.rejects(
        () =>
          generateFinalGroceryList(
            "Plan",
            inputItems,
            ["produce", "meat_seafood", "extras"],
            { prisma, userId: TEST_USER_ID, client: fake.client },
          ),
        (err: unknown) => err instanceof GroceryListAIError,
      );
    });

    it("forwards knownSections to the AI when the subset is non-empty", async () => {
      _resetClientCache();
      _resetRegistryCaches();
      const fake = makeFakeClient([
        {
          content: [
            textBlock({
              items: [
                {
                  canonicalName: "chicken",
                  displayName: "chicken breast",
                  quantity: 1,
                  unit: "lb",
                  sectionKey: "meat_seafood",
                  isUniversalStaple: false,
                  isUserPantryStaple: false,
                  isRecurringItem: false,
                  notes: null,
                  isAmbiguous: false,
                  wasAiInferred: false,
                },
              ],
            }),
          ],
        },
      ]);
      const { prisma } = makeStubPrisma();
      const items: ConsolidatedItem[] = [
        baseInputItem({
          canonicalName: "chicken",
          displayName: "chicken",
          sectionKey: "meat_seafood",
        }),
      ];

      await generateFinalGroceryList(
        "Plan",
        items,
        ["produce", "meat_seafood", "household"],
        { prisma, userId: TEST_USER_ID, client: fake.client },
      );

      const sent = fake.lastUserMessage();
      // knownSections must be passed through verbatim.
      assert.ok(sent && sent.includes("household"));
      assert.ok(sent && sent.includes("produce"));
    });
  });
});

// ── categorizeGroceryItem (6c-6 Block B) ──────────────────────────────

describe("categorizeGroceryItem", () => {
  it("returns the parsed ItemCategorizationResult on happy path", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            itemName: "toilet paper",
            sectionKey: "household",
            suggestedQuantity: "1 pack",
          }),
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await categorizeGroceryItem(
      "tp",
      undefined,
      undefined,
      { prisma, userId: TEST_USER_ID, client: fake.client },
    );

    assert.equal(result.itemName, "toilet paper");
    assert.equal(result.sectionKey, "household");
    assert.equal(result.suggestedQuantity, "1 pack");
    assert.equal(fake.callCount(), 1);
  });

  it("forwards itemText into the rendered prompt body", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            itemName: "doritos",
            sectionKey: "snacks",
            suggestedQuantity: "1 bag",
          }),
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    await categorizeGroceryItem(
      "Doritos",
      undefined,
      undefined,
      { prisma, userId: TEST_USER_ID, client: fake.client },
    );

    const sent = fake.lastUserMessage();
    assert.ok(sent, "should send a user message");
    assert.ok(sent.includes("Doritos"), "itemText must be substituted into the prompt");
  });

  it("rejects empty itemText via ItemCategorizationInputSchema (Zod parse throws)", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([]); // no responses queued — must not be called
    const { prisma } = makeStubPrisma();

    await assert.rejects(
      () =>
        categorizeGroceryItem("", undefined, undefined, {
          prisma,
          userId: TEST_USER_ID,
          client: fake.client,
        }),
    );
    assert.equal(fake.callCount(), 0);
  });

  it("throws GroceryListAIError when AI returns malformed JSON twice in a row", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      { content: [textBlock({ itemName: "x" })] }, // missing sectionKey
      { content: [textBlock("not even json")] },
    ]);
    const { prisma } = makeStubPrisma();

    await assert.rejects(
      () =>
        categorizeGroceryItem(
          "kombucha",
          undefined,
          undefined,
          { prisma, userId: TEST_USER_ID, client: fake.client },
        ),
      (err: unknown) => err instanceof GroceryListAIError,
    );
  });
});

// ── BUG-095 — AI output is matched back to source rows by IDENTITY ────────
//
// generateFinalGroceryList used to zip Sonnet's output back onto the input
// subset by ARRAY INDEX (`aiSubset[i]`), and because `...pack` is spread last
// the purchase pack — and the row's final `index` — came from position rather
// than identity. The prompt explicitly permits both reordering ("a stable
// input order is also acceptable") and merging (rule 2), and the only guard
// was a length comparison. That is how `1 bunch eggs` and `1 dozen milk` reach
// a real list.
//
// These tests drive the model's output ORDER, which is the only thing the old
// code was sensitive to.
describe("BUG-095 — generateFinalGroceryList output→source matching", () => {
  // sectionKey "extras" routes an item to the AI subset (partitionForAI
  // rule 2) without needing a vague canonical, so each row can carry a
  // distinct, recognisable name.
  function aiItem(overrides: Partial<ConsolidatedItem> = {}): ConsolidatedItem {
    return makeItem({ sectionKey: "extras", ...overrides });
  }

  function aiOut(
    canonicalName: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      canonicalName,
      displayName: canonicalName,
      quantity: 1,
      unit: "each",
      sectionKey: "extras",
      isUniversalStaple: false,
      isUserPantryStaple: false,
      isRecurringItem: false,
      notes: null,
      isAmbiguous: false,
      wasAiInferred: false,
      ...overrides,
    };
  }

  it("REORDERED output: every row keeps its OWN purchase pack and its OWN position", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    // The model returns the three rows in reverse order — permitted by the
    // prompt's grocery-store-flow clause. Pre-fix, eggs got bread's pack.
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            items: [aiOut("bread"), aiOut("milk"), aiOut("eggs")],
          }),
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      aiItem({
        canonicalName: "eggs",
        displayName: "eggs",
        purchaseUnit: "dozen",
        purchaseQuantity: 1,
        purchaseDisplay: "1 dozen",
      }),
      aiItem({
        canonicalName: "milk",
        displayName: "milk",
        purchaseUnit: "bottle",
        purchaseQuantity: 1,
        purchaseDisplay: "1 bottle (1 quart)",
      }),
      aiItem({
        canonicalName: "bread",
        displayName: "bread",
        purchaseUnit: "loaf",
        purchaseQuantity: 1,
        purchaseDisplay: "1 loaf",
      }),
    ];

    const result = await generateFinalGroceryList("Plan", items, ["extras"], {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(result.items.length, 3);
    const byName = new Map(result.items.map((r) => [r.canonicalName, r]));
    assert.equal(byName.get("eggs")?.purchaseDisplay, "1 dozen");
    assert.equal(byName.get("milk")?.purchaseDisplay, "1 bottle (1 quart)");
    assert.equal(byName.get("bread")?.purchaseDisplay, "1 loaf");
    // The final index is identity-derived too: the list comes back in the
    // ORIGINAL input order, not the order the model chose.
    assert.deepEqual(
      result.items.map((r) => r.canonicalName),
      ["eggs", "milk", "bread"],
    );
  });

  it("MERGED output (rule 2): the merged row takes the LOWEST source index and that source's pack", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    // Two olive-oil rows at different units partner into the AI subset
    // (partitionForAI rule 3); the model merges them into one output. A third
    // row sits BETWEEN them in the input so the merged row's landing position
    // is observable.
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            // Merged row returned SECOND — the model reordered, which is
            // exactly what the positional zip could not survive.
            items: [
              aiOut("paprika"),
              aiOut("olive oil", {
                quantity: 0.625,
                unit: "cup",
                notes: "combined 2 tbsp + 0.5 cup",
                wasAiInferred: true,
              }),
            ],
          }),
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      aiItem({
        canonicalName: "olive oil",
        displayName: "olive oil",
        quantity: 2,
        unit: "tbsp",
        purchaseUnit: "bottle",
        purchaseQuantity: 1,
        purchaseDisplay: "FIRST-SOURCE-PACK",
      }),
      aiItem({
        canonicalName: "paprika",
        displayName: "paprika",
        purchaseUnit: "jar",
        purchaseQuantity: 1,
        purchaseDisplay: "1 jar",
      }),
      aiItem({
        canonicalName: "olive oil",
        displayName: "olive oil",
        quantity: 0.5,
        unit: "cup",
        purchaseUnit: "bottle",
        purchaseQuantity: 2,
        purchaseDisplay: "SECOND-SOURCE-PACK",
      }),
    ];

    const result = await generateFinalGroceryList("Plan", items, ["extras"], {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(result.items.length, 2, "the merge decreased the count by one");
    // DEFINED behaviour: the merged row lands where the FIRST of its parts was
    // (index 0), ahead of paprika (index 1) — not where the model put it.
    assert.deepEqual(
      result.items.map((r) => r.canonicalName),
      ["olive oil", "paprika"],
    );
    assert.equal(
      result.items[0].purchaseDisplay,
      "FIRST-SOURCE-PACK",
      "a merged output takes its pack basis from the lowest-index source that carried its canonicalName",
    );
    assert.equal(result.items[1].purchaseDisplay, "1 jar");
  });

  it("AMBIGUOUS duplicate canonicals that were NOT merged: outputs claim sources in original-index order", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    // Two rows share a canonicalName (BUG-096's singular/plural collisions can
    // produce this) and the model returns BOTH rather than merging. The
    // tie-break is FIFO over the source queue: first output → first source.
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            // Both duplicates returned FIRST, with the unrelated basil row
            // pushed to the end. Under the positional zip out[1] lands on the
            // basil source and wears basil pack.
            items: [
              aiOut("roma tomato", { quantity: 7, unit: "each" }),
              aiOut("roma tomato", { quantity: 4, unit: "each" }),
              aiOut("basil"),
            ],
          }),
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      aiItem({
        canonicalName: "roma tomato",
        displayName: "roma tomato",
        quantity: 7,
        unit: "each",
        purchaseDisplay: "PACK-A",
        purchaseUnit: "each",
        purchaseQuantity: 6,
      }),
      aiItem({
        canonicalName: "basil",
        displayName: "basil",
        purchaseDisplay: "BASIL-PACK",
        purchaseUnit: "bunch",
        purchaseQuantity: 1,
      }),
      aiItem({
        canonicalName: "roma tomato",
        displayName: "roma tomato",
        quantity: 4,
        unit: "lb",
        purchaseDisplay: "PACK-B",
        purchaseUnit: "each",
        purchaseQuantity: 3,
      }),
    ];

    const result = await generateFinalGroceryList("Plan", items, ["extras"], {
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
    });

    assert.equal(result.items.length, 3);
    // Original input order restored: tomato(A) @0, basil @1, tomato(B) @2 —
    // each carrying its own pack.
    assert.deepEqual(
      result.items.map((r) => r.purchaseDisplay),
      ["PACK-A", "BASIL-PACK", "PACK-B"],
    );
    assert.deepEqual(
      result.items.map((r) => r.canonicalName),
      ["roma tomato", "basil", "roma tomato"],
    );
  });

  it("UNMATCHED output: null pack + a warn — never a neighbour's pack", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    // The model renames canonicalName (against the prompt) so the row matches
    // no source. Fail closed: nulls, not the pack of whatever sat in that slot.
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            items: [aiOut("bananas"), aiOut("white onion")],
          }),
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const items: ConsolidatedItem[] = [
      aiItem({
        canonicalName: "white onion",
        displayName: "white onion",
        purchaseUnit: "bag",
        purchaseQuantity: 1,
        purchaseDisplay: "ONION-PACK",
      }),
      aiItem({
        canonicalName: "shallot",
        displayName: "shallot",
        purchaseUnit: "each",
        purchaseQuantity: 3,
        purchaseDisplay: "SHALLOT-PACK",
      }),
    ];

    const warns: Array<Record<string, unknown>> = [];
    const realWarn = logger.warn.bind(logger);
    (logger as unknown as { warn: (...a: unknown[]) => void }).warn = ((
      obj: unknown,
      ...rest: unknown[]
    ) => {
      if (obj && typeof obj === "object") {
        warns.push(obj as Record<string, unknown>);
      }
      return realWarn(obj as never, ...(rest as [never]));
    }) as never;

    let result;
    try {
      result = await generateFinalGroceryList("Plan", items, ["extras"], {
        prisma,
        userId: TEST_USER_ID,
        client: fake.client,
      });
    } finally {
      (logger as unknown as { warn: unknown }).warn = realWarn;
    }

    const bananas = result.items.find((r) => r.canonicalName === "bananas");
    assert.ok(bananas, "the unmatched row still ships");
    assert.equal(bananas.purchaseUnit, null);
    assert.equal(bananas.purchaseQuantity, null);
    assert.equal(
      bananas.purchaseDisplay,
      null,
      "an unmatched output must never inherit a neighbour's pack",
    );
    // The matched sibling is unaffected.
    const onion = result.items.find((r) => r.canonicalName === "white onion");
    assert.equal(onion?.purchaseDisplay, "ONION-PACK");
    // And the mismatch is observable in the logs.
    const hit = warns.find((w) => w["event"] === "grocery_ai_output_unmatched");
    assert.ok(hit, "an unmatched output must be logged");
    assert.deepEqual(hit["unmatchedNames"], ["bananas"]);
  });
});
