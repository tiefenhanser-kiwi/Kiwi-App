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

// ── stub prisma ────────────────────────────────────────────────────────

interface IngredientUpdateCall {
  id: string;
  data: {
    purchaseUnit: string;
    purchaseQuantity: number;
    purchaseDisplay: string;
  };
}

interface StubPrisma {
  prisma: PrismaClient;
  llmCalls: () => LLMCallLogCreateData[];
  ingredientUpdates: () => IngredientUpdateCall[];
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

function makeStubPrisma(): StubPrisma {
  const llmCalls: LLMCallLogCreateData[] = [];
  const ingredientUpdates: IngredientUpdateCall[] = [];
  const inner: PrismaLike & {
    ingredient: {
      update: (args: {
        where: { id: string };
        data: IngredientUpdateCall["data"];
      }) => Promise<unknown>;
    };
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
  };
  return {
    prisma: inner as unknown as PrismaClient,
    llmCalls: () => llmCalls,
    ingredientUpdates: () => ingredientUpdates,
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
    sourceMealIds: ["meal-1"],
    sourceDishIds: ["dish-1"],
    purchaseUnit: null,
    purchaseQuantity: null,
    purchaseDisplay: null,
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

  it("returns the parsed result and forwards the expected input shape", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            items: [
              {
                canonicalName: "yellow onion",
                displayName: "yellow onion",
                quantity: 2,
                unit: "each",
                sectionKey: "produce",
                isUniversalStaple: false,
                isUserPantryStaple: false,
                isRecurringItem: false,
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

    const items: ConsolidatedItem[] = [
      baseInputItem({
        canonicalName: "yellow onion",
        displayName: "Onion, yellow, raw",
        quantity: 2,
        unit: "each",
        sectionKey: "produce",
      }),
    ];

    const knownSections = [
      "produce",
      "meat_seafood",
      "dairy_eggs",
      "bakery_bread",
      "pantry",
      "canned",
      "frozen",
      "snacks",
      "household",
      "extras",
    ] as const;

    const result = await generateFinalGroceryList(
      "Weeknight Plan",
      items,
      [...knownSections],
      { prisma, userId: TEST_USER_ID, client: fake.client },
    );

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].displayName, "yellow onion");

    const sent = fake.lastUserMessage();
    assert.ok(sent && sent.includes("Weeknight Plan"));
    assert.ok(sent && sent.includes("yellow onion"));
    assert.ok(sent && sent.includes("produce"));
    // knownSections must be passed through verbatim.
    assert.ok(sent && sent.includes("household"));
  });

  it("preserves flags via pass-through when the AI echoes them unchanged", async () => {
    _resetClientCache();
    _resetRegistryCaches();
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

    const echoed = inputItems.map((it) => ({
      canonicalName: it.canonicalName,
      displayName: it.displayName,
      quantity: it.quantity,
      unit: it.unit,
      sectionKey: it.sectionKey,
      isUniversalStaple: it.isUniversalStaple,
      isUserPantryStaple: it.isUserPantryStaple,
      isRecurringItem: it.isRecurringItem,
      notes: null,
      isAmbiguous: false,
      wasAiInferred: false,
    }));

    const fake = makeFakeClient([
      { content: [textBlock({ items: echoed })] },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await generateFinalGroceryList(
      "Plan",
      inputItems,
      ["produce", "pantry", "extras"],
      { prisma, userId: TEST_USER_ID, client: fake.client },
    );

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

  it("trusts the AI response when it mutates a flag (Block B decision: route layer guards regressions)", async () => {
    // Documented Block B decision: this helper does NOT re-inject input flags
    // over the AI response. A flag-mutation regression should fail in the
    // route-layer smoke test, not silently here. If the AI flips a flag, the
    // helper returns the flipped value unchanged.
    _resetClientCache();
    _resetRegistryCaches();
    const inputItems: ConsolidatedItem[] = [
      baseInputItem({
        canonicalName: "salt",
        isUniversalStaple: true,
      }),
    ];
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            items: [
              {
                canonicalName: "salt",
                displayName: "salt",
                quantity: inputItems[0].quantity,
                unit: inputItems[0].unit,
                sectionKey: inputItems[0].sectionKey,
                isUniversalStaple: false, // AI mutated this — helper trusts it.
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

    const result = await generateFinalGroceryList(
      "Plan",
      inputItems,
      ["produce", "pantry", "extras"],
      { prisma, userId: TEST_USER_ID, client: fake.client },
    );

    assert.equal(result.items[0].isUniversalStaple, false);
  });

  it("throws GroceryListAIError when AI returns more items than input", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const inputItems: ConsolidatedItem[] = [
      baseInputItem({ canonicalName: "a" }),
      baseInputItem({ canonicalName: "b" }),
      baseInputItem({ canonicalName: "c" }),
    ];
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            items: [
              { canonicalName: "a", displayName: "a", quantity: 1, unit: "each", sectionKey: "pantry", isUniversalStaple: false, isUserPantryStaple: false, isRecurringItem: false, notes: null, isAmbiguous: false, wasAiInferred: false },
              { canonicalName: "b", displayName: "b", quantity: 1, unit: "each", sectionKey: "pantry", isUniversalStaple: false, isUserPantryStaple: false, isRecurringItem: false, notes: null, isAmbiguous: false, wasAiInferred: false },
              { canonicalName: "c", displayName: "c", quantity: 1, unit: "each", sectionKey: "pantry", isUniversalStaple: false, isUserPantryStaple: false, isRecurringItem: false, notes: null, isAmbiguous: false, wasAiInferred: false },
              { canonicalName: "d", displayName: "d", quantity: 1, unit: "each", sectionKey: "pantry", isUniversalStaple: false, isUserPantryStaple: false, isRecurringItem: false, notes: null, isAmbiguous: false, wasAiInferred: false },
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
          ["produce", "pantry", "extras"],
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
    const inputItems: ConsolidatedItem[] = [baseInputItem({ canonicalName: "a" })];
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            items: [
              {
                canonicalName: "a",
                displayName: "a",
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
      {
        content: [textBlock("still bad")],
      },
    ]);
    const { prisma } = makeStubPrisma();

    await assert.rejects(
      () =>
        generateFinalGroceryList(
          "Plan",
          inputItems,
          ["produce", "pantry", "extras"],
          { prisma, userId: TEST_USER_ID, client: fake.client },
        ),
      (err: unknown) => err instanceof GroceryListAIError,
    );
  });

  // ── 6c-5: prep-note + dish-title + ambiguity threading ───────────────

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

  it("threads wasAiInferred=false when the AI passes the item through unchanged", async () => {
    _resetClientCache();
    _resetRegistryCaches();
    const fake = makeFakeClient([
      {
        content: [
          textBlock({
            items: [
              {
                canonicalName: "greek yogurt",
                displayName: "plain Greek yogurt, 32oz",
                quantity: 1,
                unit: "container",
                sectionKey: "dairy_eggs",
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
        canonicalName: "greek yogurt",
        displayName: "plain Greek yogurt, 32oz",
        sectionKey: "dairy_eggs",
        unit: "container",
        quantity: 1,
      }),
    ];

    const result = await generateFinalGroceryList(
      "Weekly Plan",
      items,
      ["produce", "dairy_eggs", "extras"],
      { prisma, userId: TEST_USER_ID, client: fake.client },
    );

    assert.equal(result.items[0].isAmbiguous, false);
    assert.equal(result.items[0].wasAiInferred, false);
    assert.equal(result.items[0].ambiguityOptions, undefined);
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
