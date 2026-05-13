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
  wasAiInferred: boolean;
  notes: string | null;
}

interface ActivityRow {
  userId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  metadata: { planId: string; itemCount: number } | null;
}

interface StubState {
  plans: PlanRow[];
  lists: ListRow[];
  listItems: ListItemRow[];
  activities: ActivityRow[];
  // canonicalName → ingredient id (case-insensitive lookup is emulated by
  // lowercasing both sides at compare time).
  ingredients: Map<string, string>;
  txCount: number;
}

function makeState(): StubState {
  return {
    plans: [],
    lists: [],
    listItems: [],
    activities: [],
    ingredients: new Map(),
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
        where: { canonicalName: { equals: string; mode: string } };
      }) => {
        const needle = where.canonicalName.equals.toLowerCase();
        for (const [name, id] of state.ingredients) {
          if (name.toLowerCase() === needle) return { id };
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
        include?: { items?: unknown };
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
          if (include?.items) {
            const items = state.listItems
              .filter((i) => i.groceryListId === list.id)
              .sort((a, b) =>
                a.storeSection === b.storeSection
                  ? a.displayName.localeCompare(b.displayName)
                  : a.storeSection.localeCompare(b.storeSection),
              );
            return { ...list, items };
          }
          return list;
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

  it("preserves isUniversalStaple + isUserPantryStaple flags on each item", async () => {
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
    assert.equal(salt.isUniversalStaple, true);
    assert.equal(salt.isUserPantryStaple, false);
    assert.equal(milk.isUniversalStaple, false);
    assert.equal(milk.isUserPantryStaple, true);
    // All AI-generated items carry wasAiInferred = true.
    assert.ok(items.every((i) => i.wasAiInferred === true));
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
        wasAiInferred: true,
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
        wasAiInferred: true,
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
        wasAiInferred: true,
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
});
