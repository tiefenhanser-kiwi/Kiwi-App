// WS6 6c-4 Block C — POST /api/plans/:id/generate-grocery-list and
// GET /api/grocery-lists/:id route tests.
//
// Stubs the three groceryList helpers (Block A consolidator + Block B
// gap-fill + final pass) at the deps boundary so the tests run without
// touching the DB or hitting Anthropic. Prisma calls go through an
// in-memory stub that records writes and serves canned reads.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { GroceryListAIError } from "../../lib/groceryListAI";
import type { ConsolidatedItem } from "../../lib/groceryList";
import { createGroceryListsRouter } from "../groceryLists";
import type { GenerateGroceryListResult } from "../../lib/ai/schemas/grocery";

// ── stubs ──────────────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  userId: string;
  titleOverride: string | null;
  revisionId: number;
  isActiveThisWeek: boolean;
  template: { title: string };
}

interface ListRow {
  id: string;
  userId: string;
  mealPlanInstanceId: string;
  status: "draft" | "active" | "ordered" | "archived";
  title: string;
  sourceType: string;
  lastGeneratedFromPlanRevisionId: number | null;
  lastGeneratedAt: Date | null;
  createdAt: Date;
}

interface ListItemRow {
  groceryListId: string;
  ingredientId: string | null;
  displayName: string;
  quantity: number;
  unit: string;
  storeSection: string;
  isUniversalStaple: boolean;
  isUserPantryStaple: boolean;
  isRecurringItem: boolean;
  wasAiInferred: boolean;
  isAmbiguous: boolean;
  ambiguityOptions: string[];
  notes: string | null;
}

interface ActivityRow {
  userId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  // 6c-6 Block B: metadata shape varies by event source. generate-grocery
  // emits { planId, itemCount }; add-item emits { action: "add_item", itemName }.
  metadata: Record<string, unknown> | null;
}

interface StubState {
  plans: PlanRow[];
  lists: ListRow[];
  listItems: ListItemRow[];
  activities: ActivityRow[];
  // canonicalName → ingredient id (case-insensitive lookup is emulated by
  // lowercasing both sides at compare time).
  ingredients: Map<string, string>;
  // 6c-6 Block B: ingredient id → {defaultUnit} for the POST /items
  // route's unit-default backfill (prisma.ingredient.findUnique).
  ingredientDefaultUnits: Map<string, { defaultUnit: string }>;
  txCount: number;
}

function makeState(): StubState {
  return {
    plans: [],
    lists: [],
    listItems: [],
    activities: [],
    ingredients: new Map(),
    ingredientDefaultUnits: new Map(),
    txCount: 0,
  };
}

function makeStubPrisma(state: StubState) {
  // Inner transactional client — exposes only the surfaces the route uses
  // inside $transaction. All writes route into the same in-memory state.
  const tx = {
    groceryList: {
      create: async ({ data }: { data: Partial<ListRow> }) => {
        const row: ListRow = {
          id: `list-${state.lists.length + 1}`,
          userId: data.userId!,
          mealPlanInstanceId: data.mealPlanInstanceId!,
          status: (data.status as ListRow["status"]) ?? "draft",
          title: data.title ?? "",
          sourceType: data.sourceType ?? "plan",
          lastGeneratedFromPlanRevisionId:
            data.lastGeneratedFromPlanRevisionId ?? null,
          lastGeneratedAt: data.lastGeneratedAt ?? null,
          createdAt: new Date(),
        };
        state.lists.push(row);
        return row;
      },
    },
    groceryListItem: {
      createMany: async ({ data }: { data: ListItemRow[] }) => {
        for (const row of data) state.listItems.push(row);
        return { count: data.length };
      },
    },
    ingredient: {
      findFirst: async ({
        where,
      }: {
        where: { canonicalName: string };
      }) => {
        // Mirrors the real Prisma `equals` semantics now that the route
        // normalizes via normalizeIngredientName upstream — strict equality
        // against whatever is stored in state.ingredients.
        const needle = where.canonicalName;
        for (const [name, id] of state.ingredients) {
          if (name === needle) return { id };
        }
        return null;
      },
    },
  };

  return {
    mealPlanInstance: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; userId: string };
      }) => {
        return (
          state.plans.find(
            (p) => p.id === where.id && p.userId === where.userId,
          ) ?? null
        );
      },
    },
    groceryList: {
      findFirst: async ({
        where,
        include,
      }: {
        where: {
          mealPlanInstanceId?: string;
          id?: string;
          userId?: string;
          status?: { not: string };
        };
        include?: { items?: unknown; planInstance?: unknown };
      }) => {
        if (where.mealPlanInstanceId) {
          // POST path — Case 1 existence check.
          const found = state.lists.find(
            (l) =>
              l.mealPlanInstanceId === where.mealPlanInstanceId &&
              (where.status ? l.status !== where.status.not : true),
          );
          return found ?? null;
        }
        if (where.id) {
          // GET path — single list with items.
          const list = state.lists.find(
            (l) => l.id === where.id && l.userId === where.userId,
          );
          if (!list) return null;
          const result: Record<string, unknown> = { ...list };
          if (include?.items) {
            result.items = state.listItems
              .filter((i) => i.groceryListId === list.id)
              .sort((a, b) =>
                a.storeSection === b.storeSection
                  ? a.displayName.localeCompare(b.displayName)
                  : a.storeSection.localeCompare(b.storeSection),
              );
          }
          if (include?.planInstance) {
            const plan = state.plans.find(
              (p) => p.id === list.mealPlanInstanceId,
            );
            result.planInstance = plan
              ? { id: plan.id, isActiveThisWeek: plan.isActiveThisWeek }
              : null;
          }
          return result;
        }
        return null;
      },
    },
    userActivity: {
      create: async ({ data }: { data: ActivityRow }) => {
        state.activities.push(data);
        return data;
      },
    },
    // 6c-6 Block B — outer-prisma surfaces for the POST /grocery-lists/:id/items
    // route. groceryListItem.create writes into the same in-memory state as the
    // tx variant; ingredient.findFirst + findUnique back the canonical-name
    // lookup + defaultUnit resolution.
    ingredient: {
      findFirst: async ({
        where,
      }: {
        where: { canonicalName: string };
      }) => {
        const needle = where.canonicalName;
        for (const [name, id] of state.ingredients) {
          if (name === needle) return { id };
        }
        return null;
      },
      findUnique: async ({
        where,
      }: {
        where: { id: string };
      }) => {
        return state.ingredientDefaultUnits.get(where.id) ?? null;
      },
    },
    groceryListItem: {
      create: async ({ data }: { data: ListItemRow }) => {
        const row: ListItemRow = {
          ...data,
          ambiguityOptions: data.ambiguityOptions ?? [],
        };
        state.listItems.push(row);
        return { id: `item-${state.listItems.length}`, ...row };
      },
    },
    $transaction: async <T>(fn: (txClient: typeof tx) => Promise<T>) => {
      state.txCount++;
      return fn(tx);
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────

function consolidatedItem(
  overrides: Partial<ConsolidatedItem> = {},
): ConsolidatedItem {
  return {
    ingredientId: null,
    canonicalName: "olive oil",
    displayName: "Olive oil",
    quantity: 1,
    unit: "tbsp",
    sectionKey: "pantry",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    sourceMealIds: [],
    sourceDishIds: [],
    purchaseUnit: null,
    purchaseQuantity: null,
    purchaseDisplay: null,
    preparationNote: null,
    sourceDishTitle: null,
    ...overrides,
  };
}

function finalListItem(
  overrides: Partial<GenerateGroceryListResult["items"][number]> = {},
): GenerateGroceryListResult["items"][number] {
  return {
    canonicalName: "olive oil",
    displayName: "Olive oil",
    quantity: 1,
    unit: "tbsp",
    sectionKey: "pantry",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    notes: null,
    isAmbiguous: false,
    wasAiInferred: false,
    ...overrides,
  };
}

// ── harness ────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
  state: StubState;
}

interface HarnessOpts {
  consolidated?: ConsolidatedItem[];
  filled?: ConsolidatedItem[];
  finalItems?: GenerateGroceryListResult["items"];
  aiThrows?: Error;
  spies?: {
    consolidate: { calls: number };
    fill: { calls: number };
    finalPass: { calls: number };
  };
  // 6c-6 Block B — typeahead deps. Production wiring routes to
  // searchIngredientsByPrefix + categorizeGroceryItem; tests stub both.
  searchIngredients?: (
    prisma: unknown,
    needle: string,
    limit?: number,
  ) => Promise<
    {
      ingredientId: string;
      canonicalName: string;
      displayName: string;
      category: string;
      defaultUnit: string;
    }[]
  >;
  categorizeItem?: (
    itemText: string,
    knownSections: unknown,
    nearMatches: unknown,
    opts: unknown,
  ) => Promise<{
    itemName: string;
    sectionKey: string;
    suggestedQuantity?: string;
  }>;
  categorizeThrows?: Error;
}

async function spinUp(opts: HarnessOpts = {}): Promise<Harness> {
  const state = makeState();
  const stubPrisma = makeStubPrisma(state);
  const consolidated = opts.consolidated ?? [consolidatedItem()];
  const filled = opts.filled ?? consolidated;
  const finalItems = opts.finalItems ?? consolidated.map((c) => finalListItem({
    canonicalName: c.canonicalName,
    displayName: c.displayName,
    quantity: c.quantity,
    unit: c.unit,
    sectionKey: c.sectionKey,
    isUniversalStaple: c.isUniversalStaple,
    isUserPantryStaple: c.isUserPantryStaple,
    isRecurringItem: c.isRecurringItem,
  }));

  // 6c-6 Block B — typeahead deps default to no-op stubs so tests that don't
  // touch the lookup/add-item paths don't need to think about them.
  const defaultSearchIngredients: HarnessOpts["searchIngredients"] = async () => [];
  const defaultCategorizeItem: HarnessOpts["categorizeItem"] = async () => ({
    itemName: "unspecified",
    sectionKey: "extras",
  });
  const searchIngredientsImpl = opts.searchIngredients ?? defaultSearchIngredients;
  const categorizeItemImpl = opts.categorizeItem ?? defaultCategorizeItem;

  const router = createGroceryListsRouter({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: stubPrisma as any,
    consolidatePlanIngredients: (async () => {
      if (opts.spies) opts.spies.consolidate.calls++;
      return consolidated;
    }) as never,
    fillPurchaseSizesWithWriteBack: (async () => {
      if (opts.spies) opts.spies.fill.calls++;
      return filled;
    }) as never,
    generateFinalGroceryList: (async () => {
      if (opts.spies) opts.spies.finalPass.calls++;
      if (opts.aiThrows) throw opts.aiThrows;
      return { items: finalItems };
    }) as never,
    searchIngredients: searchIngredientsImpl as never,
    categorizeItem: (async (
      itemText: string,
      knownSections: unknown,
      nearMatches: unknown,
      deps: unknown,
    ) => {
      if (opts.categorizeThrows) throw opts.categorizeThrows;
      return categorizeItemImpl(itemText, knownSections, nearMatches, deps);
    }) as never,
  });

  const app: Express = express();
  app.use(express.json());
  app.use("/api", router);

  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        state,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

const USER = "test-user-grocerylists";
const OTHER_USER = "stranger-user-grocerylists";

function seedPlan(state: StubState, overrides: Partial<PlanRow> = {}): PlanRow {
  const plan: PlanRow = {
    id: "plan-1",
    userId: USER,
    titleOverride: null,
    revisionId: 7,
    isActiveThisWeek: false,
    template: { title: "Family Dinners" },
    ...overrides,
  };
  state.plans.push(plan);
  return plan;
}

function seedExistingList(
  state: StubState,
  overrides: Partial<ListRow> = {},
): ListRow {
  const row: ListRow = {
    id: "list-existing-1",
    userId: USER,
    mealPlanInstanceId: "plan-1",
    status: "active",
    title: "Groceries: Family Dinners",
    sourceType: "plan",
    lastGeneratedFromPlanRevisionId: 7,
    lastGeneratedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
  state.lists.push(row);
  return row;
}

// ── tests ──────────────────────────────────────────────────────────────

describe("POST /api/plans/:id/generate-grocery-list — happy path", () => {
  let harness: Harness;
  before(async () => {
    harness = await spinUp({
      consolidated: [
        consolidatedItem({ canonicalName: "tomato", displayName: "Tomato" }),
        consolidatedItem({
          canonicalName: "ground beef",
          displayName: "Ground beef",
          sectionKey: "meat_seafood",
        }),
        consolidatedItem({ canonicalName: "salt", displayName: "Salt" }),
      ],
      finalItems: [
        finalListItem({ canonicalName: "tomato", displayName: "Tomato" }),
        finalListItem({
          canonicalName: "ground beef",
          displayName: "Ground beef",
          sectionKey: "meat_seafood",
        }),
        finalListItem({ canonicalName: "salt", displayName: "Salt" }),
      ],
    });
    seedPlan(harness.state);
  });
  after(async () => harness.close());

  it("returns 200 with groceryListId; persists GroceryList with correct metadata", async () => {
    const token = signToken(USER);
    const res = await fetch(
      `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { groceryListId: string };
    assert.ok(body.groceryListId);

    assert.equal(harness.state.lists.length, 1);
    const list = harness.state.lists[0];
    assert.equal(list.userId, USER);
    assert.equal(list.mealPlanInstanceId, "plan-1");
    assert.equal(list.sourceType, "plan");
    assert.equal(list.status, "active");
    assert.equal(list.lastGeneratedFromPlanRevisionId, 7);
    assert.ok(list.lastGeneratedAt instanceof Date);
    // sanity — title derives from template.title when titleOverride is null
    assert.equal(list.title, "Groceries: Family Dinners");
    assert.equal(harness.state.txCount, 1);
  });
});

describe("POST /api/plans/:id/generate-grocery-list — flag persistence", () => {
  let harness: Harness;
  before(async () => {
    harness = await spinUp({
      consolidated: [
        consolidatedItem({ canonicalName: "tomato", displayName: "Tomato" }),
        consolidatedItem({ canonicalName: "salt", displayName: "Salt" }),
        consolidatedItem({ canonicalName: "milk", displayName: "Milk" }),
      ],
      finalItems: [
        finalListItem({
          canonicalName: "tomato",
          displayName: "Tomato",
          isUniversalStaple: false,
          isUserPantryStaple: false,
          isRecurringItem: false,
        }),
        finalListItem({
          canonicalName: "salt",
          displayName: "Salt",
          isUniversalStaple: true,
          isUserPantryStaple: false,
          isRecurringItem: false,
        }),
        finalListItem({
          canonicalName: "milk",
          displayName: "Milk",
          isUniversalStaple: false,
          isUserPantryStaple: true,
          isRecurringItem: true,
        }),
      ],
    });
    seedPlan(harness.state);
  });
  after(async () => harness.close());

  it("preserves isUniversalStaple + isUserPantryStaple + isRecurringItem flags on each item", async () => {
    const token = signToken(USER);
    const res = await fetch(
      `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assert.equal(res.status, 200);

    const items = harness.state.listItems;
    assert.equal(items.length, 3);
    const tomato = items.find((i) => i.displayName === "Tomato")!;
    const salt = items.find((i) => i.displayName === "Salt")!;
    const milk = items.find((i) => i.displayName === "Milk")!;
    assert.equal(tomato.isUniversalStaple, false);
    assert.equal(tomato.isUserPantryStaple, false);
    assert.equal(tomato.isRecurringItem, false);
    assert.equal(salt.isUniversalStaple, true);
    assert.equal(salt.isUserPantryStaple, false);
    assert.equal(salt.isRecurringItem, false);
    assert.equal(milk.isUniversalStaple, false);
    assert.equal(milk.isUserPantryStaple, true);
    assert.equal(milk.isRecurringItem, true);
    // 6c-5: wasAiInferred is now AI-determined per item, not a route default.
    // factories default wasAiInferred to false, so all three should be false.
    assert.ok(items.every((i) => i.wasAiInferred === false));
  });
});

// ── 6c-5: ambiguity + AI-determined wasAiInferred persistence ────────────

describe("POST /api/plans/:id/generate-grocery-list — 6c-5 ambiguity fields", () => {
  it("persists isAmbiguous + ambiguityOptions when AI flags an item", async () => {
    const harness = await spinUp({
      finalItems: [
        finalListItem({
          canonicalName: "chicken",
          displayName: "boneless skinless chicken breasts, 1 lb",
          isAmbiguous: true,
          ambiguityOptions: [
            "boneless skinless thighs",
            "rotisserie chicken (pulled)",
            "ground chicken",
          ],
          wasAiInferred: true,
        }),
      ],
    });
    seedPlan(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      assert.equal(harness.state.listItems.length, 1);
      const row = harness.state.listItems[0];
      assert.equal(row.isAmbiguous, true);
      assert.deepEqual(row.ambiguityOptions, [
        "boneless skinless thighs",
        "rotisserie chicken (pulled)",
        "ground chicken",
      ]);
      assert.equal(row.wasAiInferred, true);
    } finally {
      await harness.close();
    }
  });

  it("defaults ambiguityOptions to [] and isAmbiguous=false when AI passes through", async () => {
    const harness = await spinUp({
      finalItems: [
        finalListItem({
          canonicalName: "greek yogurt",
          displayName: "plain Greek yogurt, 32oz",
          isAmbiguous: false,
          wasAiInferred: false,
        }),
      ],
    });
    seedPlan(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      const row = harness.state.listItems[0];
      assert.equal(row.isAmbiguous, false);
      assert.deepEqual(row.ambiguityOptions, []);
      assert.equal(row.wasAiInferred, false);
    } finally {
      await harness.close();
    }
  });

  it("mixed list: flagged + unflagged items land their ambiguity fields per-row", async () => {
    const harness = await spinUp({
      finalItems: [
        finalListItem({
          canonicalName: "chicken",
          displayName: "boneless skinless chicken breasts, 1 lb",
          isAmbiguous: true,
          ambiguityOptions: ["boneless skinless thighs", "ground chicken"],
          wasAiInferred: true,
        }),
        finalListItem({
          canonicalName: "salt",
          displayName: "salt",
          isAmbiguous: false,
          wasAiInferred: false,
        }),
        finalListItem({
          canonicalName: "berries",
          displayName: "blueberries",
          isAmbiguous: true,
          ambiguityOptions: ["strawberries", "raspberries", "mixed berries"],
          wasAiInferred: true,
        }),
      ],
    });
    seedPlan(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      assert.equal(harness.state.listItems.length, 3);
      const chicken = harness.state.listItems.find((i) =>
        i.displayName.startsWith("boneless"),
      )!;
      const salt = harness.state.listItems.find((i) => i.displayName === "salt")!;
      const berries = harness.state.listItems.find(
        (i) => i.displayName === "blueberries",
      )!;
      assert.equal(chicken.isAmbiguous, true);
      assert.equal(chicken.ambiguityOptions.length, 2);
      assert.equal(chicken.wasAiInferred, true);
      assert.equal(salt.isAmbiguous, false);
      assert.deepEqual(salt.ambiguityOptions, []);
      assert.equal(salt.wasAiInferred, false);
      assert.equal(berries.isAmbiguous, true);
      assert.equal(berries.ambiguityOptions.length, 3);
      assert.equal(berries.wasAiInferred, true);
    } finally {
      await harness.close();
    }
  });
});

describe("POST /api/plans/:id/generate-grocery-list — activity log", () => {
  let harness: Harness;
  before(async () => {
    harness = await spinUp({
      finalItems: [
        finalListItem({ canonicalName: "a", displayName: "A" }),
        finalListItem({ canonicalName: "b", displayName: "B" }),
        finalListItem({ canonicalName: "c", displayName: "C" }),
        finalListItem({ canonicalName: "d", displayName: "D" }),
      ],
    });
    seedPlan(harness.state);
  });
  after(async () => harness.close());

  it("writes a generate_grocery UserActivity row with planId + itemCount metadata", async () => {
    const token = signToken(USER);
    const res = await fetch(
      `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assert.equal(res.status, 200);
    // Activity write is fire-and-forget — give the microtask queue a single
    // tick to flush before asserting.
    await new Promise((r) => setImmediate(r));
    assert.equal(harness.state.activities.length, 1);
    const a = harness.state.activities[0];
    assert.equal(a.eventType, "generate_grocery");
    assert.equal(a.entityType, "grocery_list");
    assert.equal(a.userId, USER);
    assert.deepEqual(a.metadata, { planId: "plan-1", itemCount: 4 });
  });
});

describe("POST /api/plans/:id/generate-grocery-list — Ingredient lookup", () => {
  it("populates ingredientId when a canonical-name match exists", async () => {
    const harness = await spinUp({
      finalItems: [
        finalListItem({ canonicalName: "tomato", displayName: "Tomato" }),
      ],
    });
    seedPlan(harness.state);
    harness.state.ingredients.set("tomato", "ing-tomato-1");
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      assert.equal(harness.state.listItems.length, 1);
      assert.equal(harness.state.listItems[0].ingredientId, "ing-tomato-1");
    } finally {
      await harness.close();
    }
  });

  it("normalizes mixed-case canonical names before equals match (AI casing drift)", async () => {
    const harness = await spinUp({
      finalItems: [
        // AI returned mixed case; route must lower/trim/article-strip
        // before the equals lookup so the seeded lowercase row still hits.
        finalListItem({ canonicalName: "Salt", displayName: "Salt" }),
      ],
    });
    seedPlan(harness.state);
    harness.state.ingredients.set("salt", "ing-salt-1");
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      assert.equal(harness.state.listItems.length, 1);
      assert.equal(harness.state.listItems[0].ingredientId, "ing-salt-1");
    } finally {
      await harness.close();
    }
  });

  it("falls back to null ingredientId (does NOT throw) on a canonical-name miss", async () => {
    const harness = await spinUp({
      finalItems: [
        finalListItem({
          canonicalName: "rare-mystery-ingredient",
          displayName: "Mystery",
        }),
      ],
    });
    seedPlan(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      assert.equal(harness.state.listItems.length, 1);
      assert.equal(harness.state.listItems[0].ingredientId, null);
    } finally {
      await harness.close();
    }
  });
});

describe("POST /api/plans/:id/generate-grocery-list — error paths", () => {
  it("returns 404 plan_not_found when the plan doesn't exist", async () => {
    const harness = await spinUp();
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/missing/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "plan_not_found");
    } finally {
      await harness.close();
    }
  });

  it("returns 404 plan_not_found when the plan belongs to another user (no existence leak)", async () => {
    const harness = await spinUp();
    seedPlan(harness.state, { userId: OTHER_USER });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "plan_not_found");
      assert.equal(harness.state.lists.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 409 list_exists with existingListId when a list already exists; creates no new list", async () => {
    const harness = await spinUp();
    seedPlan(harness.state);
    seedExistingList(harness.state, { id: "list-existing-99" });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 409);
      const body = (await res.json()) as {
        error: string;
        existingListId: string;
      };
      assert.equal(body.error, "list_exists");
      assert.equal(body.existingListId, "list-existing-99");
      // Existence check fired; no new list was created.
      assert.equal(harness.state.lists.length, 1);
    } finally {
      await harness.close();
    }
  });

  it("returns 409 without invoking any of the three AI/consolidator helpers", async () => {
    const spies = {
      consolidate: { calls: 0 },
      fill: { calls: 0 },
      finalPass: { calls: 0 },
    };
    const harness = await spinUp({ spies });
    seedPlan(harness.state);
    seedExistingList(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 409);
      assert.equal(spies.consolidate.calls, 0);
      assert.equal(spies.fill.calls, 0);
      assert.equal(spies.finalPass.calls, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 502 ai_failed when generateFinalGroceryList throws GroceryListAIError; no list created", async () => {
    const harness = await spinUp({
      aiThrows: new GroceryListAIError("Kiwi's brain hiccupped."),
    });
    seedPlan(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, "ai_failed");
      assert.equal(body.message, "Kiwi's brain hiccupped.");
      assert.equal(harness.state.lists.length, 0);
      assert.equal(harness.state.listItems.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const harness = await spinUp();
    try {
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        { method: "POST" },
      );
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── GET /grocery-lists/:id ─────────────────────────────────────────────

describe("GET /api/grocery-lists/:id", () => {
  it("returns 200 with the list + items ordered by storeSection then displayName", async () => {
    const harness = await spinUp();
    const list = seedExistingList(harness.state, { id: "list-get-1" });
    // Seed items in deliberately wrong order; expect the route to sort them.
    harness.state.listItems.push(
      {
        groceryListId: list.id,
        ingredientId: null,
        displayName: "Zucchini",
        quantity: 2,
        unit: "ct",
        storeSection: "produce",
        isUniversalStaple: false,
        isUserPantryStaple: false,
        isRecurringItem: false,
        wasAiInferred: true,
        isAmbiguous: false,
        ambiguityOptions: [],
        notes: null,
      },
      {
        groceryListId: list.id,
        ingredientId: null,
        displayName: "Apple",
        quantity: 3,
        unit: "ct",
        storeSection: "produce",
        isUniversalStaple: false,
        isUserPantryStaple: false,
        isRecurringItem: false,
        wasAiInferred: true,
        isAmbiguous: false,
        ambiguityOptions: [],
        notes: null,
      },
      {
        groceryListId: list.id,
        ingredientId: null,
        displayName: "Cheddar",
        quantity: 1,
        unit: "block",
        storeSection: "dairy_eggs",
        isUniversalStaple: false,
        isUserPantryStaple: false,
        isRecurringItem: false,
        wasAiInferred: true,
        isAmbiguous: false,
        ambiguityOptions: [],
        notes: null,
      },
    );
    try {
      const token = signToken(USER);
      const res = await fetch(`${harness.baseUrl}/grocery-lists/list-get-1`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        list: {
          id: string;
          items: { displayName: string; storeSection: string }[];
        };
      };
      assert.equal(body.list.id, "list-get-1");
      assert.equal(body.list.items.length, 3);
      // dairy_eggs < produce alphabetically; within produce, Apple < Zucchini
      assert.equal(body.list.items[0].displayName, "Cheddar");
      assert.equal(body.list.items[1].displayName, "Apple");
      assert.equal(body.list.items[2].displayName, "Zucchini");
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the list id is unknown", async () => {
    const harness = await spinUp();
    try {
      const token = signToken(USER);
      const res = await fetch(`${harness.baseUrl}/grocery-lists/nope`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "list_not_found");
    } finally {
      await harness.close();
    }
  });

  it("returns 404 (not 403) when the list belongs to a different user — no existence leak", async () => {
    const harness = await spinUp();
    seedExistingList(harness.state, {
      id: "list-stranger",
      userId: OTHER_USER,
    });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/list-stranger`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const harness = await spinUp();
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists/anything`, {
        method: "GET",
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });

  it("surfaces planInstance.isActiveThisWeek=true on the response when the linked plan is the active week", async () => {
    const harness = await spinUp();
    seedPlan(harness.state, { isActiveThisWeek: true });
    seedExistingList(harness.state, { id: "list-this-week" });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/list-this-week`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        list: {
          planInstance: { id: string; isActiveThisWeek: boolean } | null;
        };
      };
      assert.ok(body.list.planInstance);
      assert.equal(body.list.planInstance.isActiveThisWeek, true);
    } finally {
      await harness.close();
    }
  });

  it("returns planInstance=null gracefully when the list has no linked plan instance", async () => {
    const harness = await spinUp();
    // No plan seeded — list's mealPlanInstanceId points at a row that
    // doesn't exist; the stub returns planInstance: null (mirrors the
    // real relation when mealPlanInstanceId is null in the future).
    seedExistingList(harness.state, { id: "list-no-plan" });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/list-no-plan`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        list: {
          planInstance: { id: string; isActiveThisWeek: boolean } | null;
        };
      };
      assert.equal(body.list.planInstance, null);
    } finally {
      await harness.close();
    }
  });
});

// ── 6c-6 Block B — GET /api/grocery-items/lookup ────────────────────────

describe("GET /api/grocery-items/lookup", () => {
  it("returns source=lookup and candidate(s) when prefix search hits an Ingredient", async () => {
    const harness = await spinUp({
      searchIngredients: async (_p, needle) => {
        if (needle.toLowerCase().startsWith("brea") || needle.toLowerCase().startsWith("bread")) {
          return [
            {
              ingredientId: "ing-bread-uuid",
              canonicalName: "sandwich bread",
              displayName: "Sandwich bread",
              category: "Bakery",
              defaultUnit: "loaf",
            },
          ];
        }
        return [];
      },
    });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-items/lookup?q=bread`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        source: "lookup" | "ai";
        candidates: {
          ingredientId: string | null;
          canonicalName: string;
          displayName: string;
          storeSection: string;
          defaultUnit: string;
          suggestedQuantity?: string | null;
        }[];
      };
      assert.equal(body.source, "lookup");
      const sandwich = body.candidates.find(
        (c) => c.canonicalName === "sandwich bread",
      );
      assert.ok(sandwich, "expected sandwich bread candidate");
      assert.equal(sandwich.ingredientId, "ing-bread-uuid");
      assert.equal(sandwich.storeSection, "bakery_bread");
      assert.equal(sandwich.defaultUnit, "loaf");
      // 6c-6 Block C: lookup-source candidates omit suggestedQuantity
      // (or pass null). defaultUnit + qty=1 is the implicit hint there.
      assert.ok(
        sandwich.suggestedQuantity == null,
        "lookup-source candidate should omit suggestedQuantity",
      );
    } finally {
      await harness.close();
    }
  });

  it("returns source=ai with a single AI-derived candidate on zero lookup hits", async () => {
    const harness = await spinUp({
      searchIngredients: async () => [],
      categorizeItem: async (itemText) => ({
        itemName: itemText === "tp" ? "toilet paper" : itemText,
        sectionKey: "household",
        suggestedQuantity: "1 pack",
      }),
    });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-items/lookup?q=tp`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        source: "lookup" | "ai";
        candidates: {
          ingredientId: string | null;
          canonicalName: string;
          storeSection: string;
          suggestedQuantity?: string | null;
        }[];
      };
      assert.equal(body.source, "ai");
      assert.equal(body.candidates.length, 1);
      assert.equal(body.candidates[0].ingredientId, null);
      assert.equal(body.candidates[0].canonicalName, "toilet paper");
      assert.equal(body.candidates[0].storeSection, "household");
      // 6c-6 Block C: AI-fallback candidates surface the AI's
      // suggestedQuantity so the typeahead chip can render shopper
      // language (e.g. "1 pack" instead of bare "each").
      assert.equal(body.candidates[0].suggestedQuantity, "1 pack");
    } finally {
      await harness.close();
    }
  });

  it("ai-fallback candidate has suggestedQuantity=null when the AI doesn't return one", async () => {
    const harness = await spinUp({
      searchIngredients: async () => [],
      categorizeItem: async (itemText) => ({
        itemName: itemText,
        sectionKey: "extras",
        // suggestedQuantity intentionally omitted — route must pass
        // through as `null`, not undefined or a default string.
      }),
    });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-items/lookup?q=asdfgh`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        source: "lookup" | "ai";
        candidates: { suggestedQuantity?: string | null }[];
      };
      assert.equal(body.source, "ai");
      assert.equal(body.candidates[0].suggestedQuantity, null);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 on empty q query param", async () => {
    const harness = await spinUp();
    try {
      const token = signToken(USER);
      const res = await fetch(`${harness.baseUrl}/grocery-items/lookup?q=`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("returns 502 ai_failed when the AI fallback throws GroceryListAIError", async () => {
    const harness = await spinUp({
      searchIngredients: async () => [],
      categorizeThrows: new GroceryListAIError("Kiwi's brain hiccupped."),
    });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-items/lookup?q=mystery-item-zzz`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, "ai_failed");
      assert.equal(body.message, "Kiwi's brain hiccupped.");
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const harness = await spinUp();
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-items/lookup?q=tp`, {
        method: "GET",
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── 6c-6 Block B — POST /api/grocery-lists/:id/items ────────────────────

// Real-looking UUIDs so the route's UUID_RE guard passes. Multiple distinct
// IDs let one test set up an "other user's list" without colliding with the
// caller's list.
const LIST_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_LIST_UUID = "22222222-2222-4222-8222-222222222222";
const INGREDIENT_UUID = "33333333-3333-4333-8333-333333333333";

function seedListWithUUID(
  state: StubState,
  overrides: Partial<ListRow> = {},
): ListRow {
  const row: ListRow = {
    id: LIST_UUID,
    userId: USER,
    mealPlanInstanceId: "plan-1",
    status: "active",
    title: "Groceries: Family Dinners",
    sourceType: "plan",
    lastGeneratedFromPlanRevisionId: 7,
    lastGeneratedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
  state.lists.push(row);
  return row;
}

describe("POST /api/grocery-lists/:id/items", () => {
  it("creates an item with quantity/unit defaults; returns 201 with the row", async () => {
    const harness = await spinUp();
    seedListWithUUID(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${LIST_UUID}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            itemName: "Lucky Charms",
            storeSection: "pantry",
          }),
        },
      );
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        item: {
          displayName: string;
          quantity: number;
          unit: string;
          storeSection: string;
          ingredientId: string | null;
        };
      };
      assert.equal(body.item.displayName, "Lucky Charms");
      assert.equal(body.item.quantity, 1); // default
      assert.equal(body.item.unit, "each"); // default (no ingredientId hit)
      assert.equal(body.item.storeSection, "pantry");
      assert.equal(body.item.ingredientId, null);

      assert.equal(harness.state.listItems.length, 1);
      assert.equal(harness.state.listItems[0].displayName, "Lucky Charms");
    } finally {
      await harness.close();
    }
  });

  it("uses the client-supplied ingredientId verbatim when provided", async () => {
    const harness = await spinUp();
    seedListWithUUID(harness.state);
    // Pre-seed the ingredient default unit so the route's findUnique returns it.
    harness.state.ingredientDefaultUnits.set(INGREDIENT_UUID, {
      defaultUnit: "jar",
    });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${LIST_UUID}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            itemName: "peanut butter",
            storeSection: "pantry",
            ingredientId: INGREDIENT_UUID,
          }),
        },
      );
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        item: { ingredientId: string; unit: string };
      };
      assert.equal(body.item.ingredientId, INGREDIENT_UUID);
      assert.equal(body.item.unit, "jar"); // defaultUnit from ingredient row
    } finally {
      await harness.close();
    }
  });

  it("backfills ingredientId via lookupIngredientIdByCanonicalName when omitted", async () => {
    const harness = await spinUp();
    seedListWithUUID(harness.state);
    // Stub the canonical-name lookup: "salt" → ing-salt-uuid.
    harness.state.ingredients.set("salt", "ing-salt-uuid");
    harness.state.ingredientDefaultUnits.set("ing-salt-uuid", {
      defaultUnit: "container",
    });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${LIST_UUID}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            itemName: "salt",
            storeSection: "pantry",
          }),
        },
      );
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        item: { ingredientId: string; unit: string };
      };
      assert.equal(body.item.ingredientId, "ing-salt-uuid");
      // Unit defaults to ingredient.defaultUnit when client omitted it.
      assert.equal(body.item.unit, "container");
    } finally {
      await harness.close();
    }
  });

  it("respects client-supplied quantity + unit over defaults", async () => {
    const harness = await spinUp();
    seedListWithUUID(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${LIST_UUID}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            itemName: "milk",
            storeSection: "dairy_eggs",
            quantity: 2,
            unit: "gallon",
          }),
        },
      );
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        item: { quantity: number; unit: string };
      };
      assert.equal(body.item.quantity, 2);
      assert.equal(body.item.unit, "gallon");
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the list does not belong to the caller (no existence leak)", async () => {
    const harness = await spinUp();
    seedListWithUUID(harness.state, {
      id: OTHER_LIST_UUID,
      userId: OTHER_USER,
    });
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${OTHER_LIST_UUID}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            itemName: "milk",
            storeSection: "dairy_eggs",
          }),
        },
      );
      assert.equal(res.status, 404);
      assert.equal(harness.state.listItems.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 on invalid body (missing storeSection)", async () => {
    const harness = await spinUp();
    seedListWithUUID(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${LIST_UUID}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ itemName: "milk" }),
        },
      );
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 on non-UUID list id", async () => {
    const harness = await spinUp();
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/not-a-uuid/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            itemName: "milk",
            storeSection: "dairy_eggs",
          }),
        },
      );
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const harness = await spinUp();
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${LIST_UUID}/items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemName: "milk",
            storeSection: "dairy_eggs",
          }),
        },
      );
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });

  it("writes a grocery_item_added UserActivity row with itemName metadata", async () => {
    const harness = await spinUp();
    seedListWithUUID(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${LIST_UUID}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            itemName: "Lucky Charms",
            storeSection: "pantry",
          }),
        },
      );
      assert.equal(res.status, 201);
      // Activity write is fire-and-forget — give the microtask queue a single
      // tick to flush before asserting.
      await new Promise((r) => setImmediate(r));
      assert.equal(harness.state.activities.length, 1);
      const a = harness.state.activities[0];
      assert.equal(a.eventType, "grocery_item_added");
      assert.equal(a.entityType, "grocery_list");
      assert.equal(a.entityId, LIST_UUID);
      assert.equal(a.userId, USER);
      const metadata = a.metadata as { itemName: string; action?: string };
      assert.equal(metadata.itemName, "Lucky Charms");
      assert.equal(metadata.action, undefined);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-3 A2 — GET /grocery-lists (list + active/past filter) ─────────────
//
// Self-contained harness: GET /grocery-lists only needs `prisma`, so this
// block stubs that one surface rather than threading the shared StubState.

interface GLFix {
  id: string;
  userId: string;
  title: string;
  status: string;
  sourceType: string;
  mealPlanInstanceId: string | null;
  lastGeneratedAt: Date | null;
  createdAt: Date;
  itemCount: number;
}

function glFix(opts: Partial<GLFix> & { id: string; userId: string }): GLFix {
  return {
    title: `List ${opts.id}`,
    status: "active",
    sourceType: "plan",
    mealPlanInstanceId: null,
    lastGeneratedAt: null,
    createdAt: new Date("2026-05-20T00:00:00Z"),
    itemCount: 3,
    ...opts,
  };
}

function makeGLStub(lists: GLFix[]) {
  return {
    groceryList: {
      findMany: async (args: {
        where: {
          userId: string;
          status?: { not?: string };
          createdAt?: { gt?: Date; lte?: Date };
        };
      }) => {
        const w = args.where;
        let rows = lists.filter((l) => l.userId === w.userId);
        if (w.status?.not) rows = rows.filter((l) => l.status !== w.status!.not);
        if (w.createdAt?.gt)
          rows = rows.filter((l) => l.createdAt > w.createdAt!.gt!);
        if (w.createdAt?.lte)
          rows = rows.filter((l) => l.createdAt <= w.createdAt!.lte!);
        return rows
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((l) => ({ ...l, _count: { items: l.itemCount } }));
      },
    },
  };
}

async function glSpinUp(lists: GLFix[]): Promise<Harness> {
  const router = createGroceryListsRouter({
    prisma: makeGLStub(lists) as never,
  });
  const app: Express = express();
  app.use(express.json());
  app.use(router);
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        state: makeState(),
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

const GL_USER = "test-user-gl-list";

describe("GET /grocery-lists", () => {
  it("returns the user's lists with itemCount, newest first", async () => {
    const harness = await glSpinUp([
      glFix({ id: "gl-old", userId: GL_USER, createdAt: new Date("2026-05-01T00:00:00Z"), itemCount: 2 }),
      glFix({ id: "gl-new", userId: GL_USER, createdAt: new Date("2026-05-20T00:00:00Z"), itemCount: 7 }),
      glFix({ id: "gl-stranger", userId: "other-user" }),
    ]);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists`, {
        headers: { Authorization: `Bearer ${signToken(GL_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        groceryLists: { id: string; itemCount: number }[];
      };
      assert.deepEqual(
        body.groceryLists.map((g) => g.id),
        ["gl-new", "gl-old"],
      );
      assert.equal(body.groceryLists[0].itemCount, 7);
    } finally {
      await harness.close();
    }
  });

  it("?filter=active returns only recent, non-archived lists", async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const harness = await glSpinUp([
      glFix({ id: "gl-active", userId: GL_USER, status: "active", createdAt: recent }),
      glFix({ id: "gl-archived", userId: GL_USER, status: "archived", createdAt: recent }),
      glFix({ id: "gl-stale", userId: GL_USER, status: "active", createdAt: old }),
    ]);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists?filter=active`, {
        headers: { Authorization: `Bearer ${signToken(GL_USER)}` },
      });
      const body = (await res.json()) as { groceryLists: { id: string }[] };
      assert.deepEqual(
        body.groceryLists.map((g) => g.id),
        ["gl-active"],
      );
    } finally {
      await harness.close();
    }
  });

  it("?filter=past returns only lists older than the active window", async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const harness = await glSpinUp([
      glFix({ id: "gl-recent", userId: GL_USER, createdAt: recent }),
      glFix({ id: "gl-old", userId: GL_USER, createdAt: old }),
    ]);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists?filter=past`, {
        headers: { Authorization: `Bearer ${signToken(GL_USER)}` },
      });
      const body = (await res.json()) as { groceryLists: { id: string }[] };
      assert.deepEqual(
        body.groceryLists.map((g) => g.id),
        ["gl-old"],
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects an unknown filter value with 400", async () => {
    const harness = await glSpinUp([]);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists?filter=bogus`, {
        headers: { Authorization: `Bearer ${signToken(GL_USER)}` },
      });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const harness = await glSpinUp([]);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists`);
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});
