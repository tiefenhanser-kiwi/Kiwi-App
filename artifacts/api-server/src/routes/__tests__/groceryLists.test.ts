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
import type { ConsolidatedItem, GrocerySource } from "../../lib/groceryList";
import { createGroceryListsRouter } from "../groceryLists";
import type { GenerateGroceryListResult } from "../../lib/ai/schemas/grocery";

// ── stubs ──────────────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  userId: string;
  titleOverride: string | null;
  revisionId: number;
  // WS7-6 (E) Block 1 REWORK: resolveThisWeekWinnerId reads a narrow
  // covering subset (id/startDate/endDate/activatedAt/createdAt) and the
  // resolver picks the winner. The stub keeps these fields so the
  // mealPlanInstance.findMany branch below can return them.
  startDate: Date | null;
  endDate: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
  isWizardDraft: boolean;
  template: { title: string };
}

interface ListRow {
  id: string;
  userId: string;
  mealPlanInstanceId: string;
  status: "draft" | "active" | "completed" | "ordered" | "archived";
  title: string;
  sourceType: string;
  lastGeneratedFromPlanRevisionId: number | null;
  lastGeneratedAt: Date | null;
  createdAt: Date;
}

interface ListItemRow {
  // WS7-7-A Block 1: generation supplies an explicit id (so source rows can
  // reference it in-tx); POST /items lets the stub assign one.
  id?: string;
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
  // WS7-7-A Block 1: ownership discriminator. Optional on the stub so GET-path
  // seeds that don't exercise provenance stay terse; the write paths always
  // set it, so rows recorded via the route carry a concrete boolean.
  isUserAdded?: boolean;
  // WS7-7-A Block 2: mutable item state. All optional so existing seeds stay
  // terse; the mutation routes read/write them on the in-memory row.
  isChecked?: boolean;
  stapleOptedIn?: boolean;
  userResolvedTo?: string | null;
  deletedAt?: Date | null;
  notes: string | null;
}

// WS7-7-A Block 1: provenance rows written alongside generation items.
interface ItemSourceRow {
  groceryListItemId: string;
  mealId: string;
  dishId: string;
  // WS7-7-A Block 5 — per-source change-signature (nullable for pre-B5 rows).
  servings?: number | null;
  ingredientSignature?: string | null;
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
  itemSources: ItemSourceRow[];
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
    itemSources: [],
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
      // WS7-7-A Block 4 — reconcile stamps the revision pointer inside the
      // same transaction as the row mutations.
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ListRow>;
      }) => {
        const row = state.lists.find((l) => l.id === where.id);
        if (!row) throw new Error("list not found");
        Object.assign(row, data);
        return row;
      },
    },
    groceryListItem: {
      createMany: async ({ data }: { data: ListItemRow[] }) => {
        for (const row of data) state.listItems.push(row);
        return { count: data.length };
      },
      // WS7-7-A Block 4 — reconcile hard-deletes superseded/removed-meal rows;
      // the in-memory stub mirrors the DB cascade onto GroceryListItemSource.
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        const before = state.listItems.length;
        state.listItems = state.listItems.filter((i) => !ids.has(i.id ?? ""));
        state.itemSources = state.itemSources.filter(
          (s) => !ids.has(s.groceryListItemId),
        );
        return { count: before - state.listItems.length };
      },
    },
    groceryListItemSource: {
      createMany: async ({ data }: { data: ItemSourceRow[] }) => {
        for (const row of data) state.itemSources.push(row);
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
      // WS7-6 (E) Block 1 REWORK — narrow covering-subset query used by
      // resolveThisWeekWinnerId. Mirrors the real Prisma shape: filters
      // on userId + isWizardDraft + startDate.lte/endDate.gte (both bounds
      // inclusive, both non-null) and returns the projected scalars.
      findMany: async (args: {
        where: {
          userId: string;
          isWizardDraft?: boolean;
          startDate?: { lte: Date; not?: null };
          endDate?: { gte: Date; not?: null };
        };
      }) => {
        return state.plans
          .filter((p) => {
            if (p.userId !== args.where.userId) return false;
            if (args.where.isWizardDraft !== undefined && p.isWizardDraft !== args.where.isWizardDraft) return false;
            if (args.where.startDate?.lte) {
              if (p.startDate === null) return false;
              if (p.startDate.getTime() > args.where.startDate.lte.getTime()) return false;
            }
            if (args.where.endDate?.gte) {
              if (p.endDate === null) return false;
              if (p.endDate.getTime() < args.where.endDate.gte.getTime()) return false;
            }
            return true;
          })
          .map((p) => ({
            id: p.id,
            startDate: p.startDate,
            endDate: p.endDate,
            activatedAt: p.activatedAt,
            createdAt: p.createdAt,
          }));
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
            // WS7-7-A Block 2 — honor include.items.where.deletedAt:null so
            // soft-deleted rows are excluded from the GET detail response.
            const itemsInclude = include.items as {
              where?: { deletedAt?: null };
            };
            const excludeDeleted =
              itemsInclude?.where?.deletedAt === null;
            result.items = state.listItems
              .filter(
                (i) =>
                  i.groceryListId === list.id &&
                  (!excludeDeleted || !i.deletedAt),
              )
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
            // WS7-6 (E) Block 1 REWORK — the route now selects only the id
            // on planInstance; the isActiveThisWeek boolean is computed
            // outside this include via resolveThisWeekWinnerId.
            result.planInstance = plan ? { id: plan.id } : null;
          }
          return result;
        }
        return null;
      },
      // WS7-7-A Block 2 — list-status PATCH surface.
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ListRow>;
      }) => {
        const row = state.lists.find((l) => l.id === where.id);
        if (!row) throw new Error("list not found");
        Object.assign(row, data);
        return row;
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
      // WS7-7-A Block 4 — reconcile reads ALL rows for the list (incl.
      // soft-deleted, the D-WS7-126 suppression signal) with their provenance
      // joined. The stub attaches each row's GroceryListItemSource rows.
      findMany: async ({
        where,
      }: {
        where: { groceryListId: string };
      }) => {
        return state.listItems
          .filter((i) => i.groceryListId === where.groceryListId)
          .map((i) => ({
            ...i,
            isUserAdded: i.isUserAdded ?? false,
            sources: state.itemSources
              .filter((s) => s.groceryListItemId === (i.id ?? ""))
              .map((s) => ({
                mealId: s.mealId,
                dishId: s.dishId,
                servings: s.servings ?? null,
                ingredientSignature: s.ingredientSignature ?? null,
              })),
          }));
      },
      // WS7-7-A Block 2 — item-mutation surfaces. findFirst resolves the
      // (item, list, owner) ownership join the PATCH/DELETE/restore routes
      // use; update merges a partial patch into the in-memory row.
      findFirst: async ({
        where,
      }: {
        where: {
          id: string;
          groceryListId: string;
          groceryList?: { userId: string };
        };
      }) => {
        const row = state.listItems.find(
          (i) => i.id === where.id && i.groceryListId === where.groceryListId,
        );
        if (!row) return null;
        if (where.groceryList?.userId) {
          const owner = state.lists.find((l) => l.id === row.groceryListId);
          if (!owner || owner.userId !== where.groceryList.userId) return null;
        }
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ListItemRow>;
      }) => {
        const row = state.listItems.find((i) => i.id === where.id);
        if (!row) throw new Error("item not found");
        Object.assign(row, data);
        return row;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = state.listItems.find((i) => i.id === where.id);
        if (!row) throw new Error("item not found");
        return row;
      },
    },
    $transaction: async <T>(fn: (txClient: typeof tx) => Promise<T>) => {
      state.txCount++;
      return fn(tx);
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────

// WS7-7-A Block 5 — default change-signature for test sources. Existing
// carry/no-drift fixtures pair a consolidator source with a seeded DB source;
// both default to these values so signaturesMatch stays true and the row
// carries. Change-detection tests override servings/ingredientSignature.
const TEST_DEFAULT_SERVINGS = 4;
const TEST_DEFAULT_SIG = "sig-default";

function consolidatedItem(
  overrides: Partial<Omit<ConsolidatedItem, "sources">> & {
    sources?: Array<
      Pick<GrocerySource, "mealId" | "dishId"> & Partial<GrocerySource>
    >;
  } = {},
): ConsolidatedItem {
  const { sources: sourceOverrides, ...rest } = overrides;
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
    purchaseUnit: null,
    purchaseQuantity: null,
    purchaseDisplay: null,
    conversionRef: null,
    preparationNote: null,
    sourceDishTitle: null,
    ...rest,
    sources: (sourceOverrides ?? []).map((s) => ({
      servings: TEST_DEFAULT_SERVINGS,
      ingredientSignature: TEST_DEFAULT_SIG,
      ...s,
    })),
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
    startDate: null,
    endDate: null,
    activatedAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    isWizardDraft: false,
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

// ── WS7-7-A Block 1: provenance (isUserAdded + GroceryListItemSource) ─────

describe("POST /api/plans/:id/generate-grocery-list — provenance", () => {
  it("marks generation rows isUserAdded:false and writes one source row per (mealId, dishId) pair", async () => {
    const harness = await spinUp({
      consolidated: [
        // Shared ingredient: garlic reaches the same consolidated line from
        // two different meals — must produce TWO source rows.
        consolidatedItem({
          canonicalName: "garlic",
          displayName: "Garlic",
          unit: "clove",
          sources: [
            { mealId: "meal-a", dishId: "dish-x" },
            { mealId: "meal-b", dishId: "dish-y" },
          ],
        }),
        // Single-source ingredient → one source row.
        consolidatedItem({
          canonicalName: "tomato",
          displayName: "Tomato",
          unit: "each",
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
      ],
      finalItems: [
        finalListItem({ canonicalName: "garlic", displayName: "Garlic", unit: "clove" }),
        finalListItem({ canonicalName: "tomato", displayName: "Tomato", unit: "each" }),
      ],
    });
    seedPlan(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(res.status, 200);

      const items = harness.state.listItems;
      assert.equal(items.length, 2);
      // Every generation row is plan-derived.
      assert.ok(items.every((i) => i.isUserAdded === false));

      const garlic = items.find((i) => i.displayName === "Garlic")!;
      const tomato = items.find((i) => i.displayName === "Tomato")!;
      const garlicSources = harness.state.itemSources.filter(
        (s) => s.groceryListItemId === garlic.id,
      );
      const tomatoSources = harness.state.itemSources.filter(
        (s) => s.groceryListItemId === tomato.id,
      );
      // Shared ingredient → two source rows, one per contributing meal.
      assert.equal(garlicSources.length, 2);
      assert.deepEqual(
        garlicSources.map((s) => s.mealId).sort(),
        ["meal-a", "meal-b"],
      );
      // Single-source ingredient → exactly one source row.
      assert.equal(tomatoSources.length, 1);
      assert.equal(tomatoSources[0].mealId, "meal-a");
      assert.equal(tomatoSources[0].dishId, "dish-x");
      assert.equal(harness.state.itemSources.length, 3);
    } finally {
      await harness.close();
    }
  });

  it("writes no source rows for an AI-tail row whose (canonical, unit) no longer joins", async () => {
    // The Sonnet pass renamed/re-unitised the row, so the persist-time
    // (normalizedCanonical, unit) join misses — conservative null-source.
    const harness = await spinUp({
      consolidated: [
        consolidatedItem({
          canonicalName: "chicken",
          displayName: "Chicken",
          unit: "lb",
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
      ],
      finalItems: [
        finalListItem({
          // Different canonical + unit than the consolidated source → no join.
          canonicalName: "chicken breast",
          displayName: "Boneless skinless chicken breast",
          unit: "each",
        }),
      ],
    });
    seedPlan(harness.state);
    try {
      const token = signToken(USER);
      const res = await fetch(
        `${harness.baseUrl}/plans/plan-1/generate-grocery-list`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(res.status, 200);
      assert.equal(harness.state.listItems.length, 1);
      assert.equal(harness.state.listItems[0].isUserAdded, false);
      // No (canonical, unit) match → conservative: zero source rows.
      assert.equal(harness.state.itemSources.length, 0);
    } finally {
      await harness.close();
    }
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
    // WS7-6 (E): "active" is now computed from [startDate, endDate] ∋ now.
    // Seed a range that bookends `now` on both sides so the helper returns
    // true regardless of clock drift during the test run.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    seedPlan(harness.state, {
      startDate: new Date(now - 3 * day),
      endDate: new Date(now + 3 * day),
    });
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
      // WS7-7-A Block 1: user-added Extras are owned by the user (isUserAdded
      // true) and carry no plan provenance.
      assert.equal(harness.state.listItems[0].isUserAdded, true);
      assert.equal(harness.state.itemSources.length, 0);
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

// WS7-6 (E) Block 2 — covering-subset fixture for resolveThisWeekWinnerId.
// The list-endpoint test now needs a winner resolution path, so the GL
// harness also accepts plan rows shaped like the resolver's narrow select
// projection.
interface GLPlanFix {
  id: string;
  userId: string;
  startDate: Date | null;
  endDate: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
  isWizardDraft: boolean;
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

function makeGLStub(lists: GLFix[], plans: GLPlanFix[] = []) {
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
        // WS7-7-A Block 6 — mirror the route's orderBy: createdAt desc with an
        // id desc tiebreaker, so same-createdAt rows order stably under the
        // keyset cursor (the route relies on this DB ordering before slicing).
        return rows
          .slice()
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .map((l) => ({ ...l, _count: { items: l.itemCount } }));
      },
    },
    // Narrow covering-subset query used by resolveThisWeekWinnerId. Mirrors
    // the real Prisma shape: filters on userId + isWizardDraft +
    // startDate.lte/endDate.gte (both bounds inclusive, both non-null).
    mealPlanInstance: {
      findMany: async (args: {
        where: {
          userId: string;
          isWizardDraft?: boolean;
          startDate?: { lte: Date; not?: null };
          endDate?: { gte: Date; not?: null };
        };
      }) => {
        return plans
          .filter((p) => {
            if (p.userId !== args.where.userId) return false;
            if (
              args.where.isWizardDraft !== undefined &&
              p.isWizardDraft !== args.where.isWizardDraft
            )
              return false;
            if (args.where.startDate?.lte) {
              if (p.startDate === null) return false;
              if (p.startDate.getTime() > args.where.startDate.lte.getTime())
                return false;
            }
            if (args.where.endDate?.gte) {
              if (p.endDate === null) return false;
              if (p.endDate.getTime() < args.where.endDate.gte.getTime())
                return false;
            }
            return true;
          })
          .map((p) => ({
            id: p.id,
            startDate: p.startDate,
            endDate: p.endDate,
            activatedAt: p.activatedAt,
            createdAt: p.createdAt,
          }));
      },
    },
  };
}

async function glSpinUp(
  lists: GLFix[],
  plans: GLPlanFix[] = [],
): Promise<Harness> {
  const router = createGroceryListsRouter({
    prisma: makeGLStub(lists, plans) as never,
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

  // WS7-6 (E) Block 2 — round-trip: exactly the list whose mealPlanInstanceId
  // matches the single This-Week winner returns isActiveThisWeek=true.
  // Lists with null mealPlanInstanceId and lists pointing at a non-winner
  // covering plan return false. Resolves D-WS7-105 (mobile date proxy
  // superseded by server field for the badge).
  it("returns isActiveThisWeek=true only for the list whose plan is the This-Week winner", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Two covering plans for the same user. `plan-winner` has the fresher
    // activatedAt so resolveThisWeekPlan picks it; `plan-loser` covers now
    // but loses the tiebreak.
    const plans: GLPlanFix[] = [
      {
        id: "plan-winner",
        userId: GL_USER,
        startDate: new Date(now - 3 * day),
        endDate: new Date(now + 3 * day),
        activatedAt: new Date(now - 1 * day),
        createdAt: new Date(now - 5 * day),
        isWizardDraft: false,
      },
      {
        id: "plan-loser",
        userId: GL_USER,
        startDate: new Date(now - 2 * day),
        endDate: new Date(now + 2 * day),
        activatedAt: new Date(now - 4 * day),
        createdAt: new Date(now - 6 * day),
        isWizardDraft: false,
      },
    ];
    const lists: GLFix[] = [
      glFix({
        id: "gl-winner",
        userId: GL_USER,
        mealPlanInstanceId: "plan-winner",
      }),
      glFix({
        id: "gl-loser",
        userId: GL_USER,
        mealPlanInstanceId: "plan-loser",
      }),
      glFix({
        id: "gl-no-plan",
        userId: GL_USER,
        mealPlanInstanceId: null,
        sourceType: "recurring",
      }),
    ];
    const harness = await glSpinUp(lists, plans);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists`, {
        headers: { Authorization: `Bearer ${signToken(GL_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        groceryLists: { id: string; isActiveThisWeek: boolean }[];
      };
      const byId = new Map(body.groceryLists.map((g) => [g.id, g]));
      assert.equal(byId.get("gl-winner")?.isActiveThisWeek, true);
      assert.equal(byId.get("gl-loser")?.isActiveThisWeek, false);
      assert.equal(byId.get("gl-no-plan")?.isActiveThisWeek, false);
      // Exactly one true across the response — the "single This-Week"
      // invariant the mobile tab depends on.
      assert.equal(
        body.groceryLists.filter((g) => g.isActiveThisWeek).length,
        1,
      );
    } finally {
      await harness.close();
    }
  });

  it("returns isActiveThisWeek=false on every list when no plan covers now", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Plan exists but its window is entirely in the past — resolver
    // returns null, so no list can be the winner.
    const plans: GLPlanFix[] = [
      {
        id: "plan-past",
        userId: GL_USER,
        startDate: new Date(now - 30 * day),
        endDate: new Date(now - 20 * day),
        activatedAt: new Date(now - 25 * day),
        createdAt: new Date(now - 30 * day),
        isWizardDraft: false,
      },
    ];
    const lists: GLFix[] = [
      glFix({
        id: "gl-past",
        userId: GL_USER,
        mealPlanInstanceId: "plan-past",
      }),
    ];
    const harness = await glSpinUp(lists, plans);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists`, {
        headers: { Authorization: `Bearer ${signToken(GL_USER)}` },
      });
      const body = (await res.json()) as {
        groceryLists: { id: string; isActiveThisWeek: boolean }[];
      };
      assert.equal(body.groceryLists[0].isActiveThisWeek, false);
    } finally {
      await harness.close();
    }
  });

  // ── WS7-7-A Block 6 (D-WS7-143) — keyset cursor pagination ──────────────
  // Mirrors the GET /me/dishes in-memory precedent: ?limit + opaque base64url
  // ?cursor, additive nextCursor envelope, every existing field preserved.

  // newest-first sequence: gl-0 (newest) … gl-(n-1) (oldest). Distinct
  // createdAt per row so the createdAt-desc order is deterministic.
  function glSeq(
    n: number,
    userId: string,
    opts: Partial<GLFix> = {},
  ): GLFix[] {
    const base = new Date("2026-05-20T00:00:00Z").getTime();
    const day = 24 * 60 * 60 * 1000;
    return Array.from({ length: n }, (_, i) =>
      glFix({
        id: `gl-${i}`,
        userId,
        createdAt: new Date(base - i * day),
        ...opts,
      }),
    );
  }

  it("page 1 returns `limit` rows + a non-null nextCursor when more remain", async () => {
    const harness = await glSpinUp(glSeq(5, GL_USER));
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists?limit=2`, {
        headers: { Authorization: `Bearer ${signToken(GL_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        groceryLists: { id: string }[];
        nextCursor: string | null;
      };
      assert.deepEqual(
        body.groceryLists.map((g) => g.id),
        ["gl-0", "gl-1"],
      );
      assert.ok(
        typeof body.nextCursor === "string" && body.nextCursor.length > 0,
        "expected a non-null nextCursor on page 1",
      );
    } finally {
      await harness.close();
    }
  });

  it("page 2 via the cursor continues with no overlap and no gap", async () => {
    const harness = await glSpinUp(glSeq(5, GL_USER));
    try {
      const auth = { Authorization: `Bearer ${signToken(GL_USER)}` };
      const p1 = (await (
        await fetch(`${harness.baseUrl}/grocery-lists?limit=2`, {
          headers: auth,
        })
      ).json()) as { groceryLists: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p1.groceryLists.map((g) => g.id),
        ["gl-0", "gl-1"],
      );
      assert.ok(p1.nextCursor);

      // Cursor round-trip: the opaque base64url nextCursor minted on page 1 is
      // handed straight back to fetch page 2 (encode → decode → next page).
      const p2 = (await (
        await fetch(
          `${harness.baseUrl}/grocery-lists?limit=2&cursor=${encodeURIComponent(
            p1.nextCursor!,
          )}`,
          { headers: auth },
        )
      ).json()) as { groceryLists: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p2.groceryLists.map((g) => g.id),
        ["gl-2", "gl-3"],
      );
      // No overlap between page 1 and page 2.
      const p1ids = new Set(p1.groceryLists.map((g) => g.id));
      assert.ok(p2.groceryLists.every((g) => !p1ids.has(g.id)));
      assert.ok(p2.nextCursor, "one row (gl-4) still remains after page 2");
    } finally {
      await harness.close();
    }
  });

  it("last page returns nextCursor: null", async () => {
    const harness = await glSpinUp(glSeq(3, GL_USER));
    try {
      const auth = { Authorization: `Bearer ${signToken(GL_USER)}` };
      const p1 = (await (
        await fetch(`${harness.baseUrl}/grocery-lists?limit=2`, {
          headers: auth,
        })
      ).json()) as { groceryLists: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p1.groceryLists.map((g) => g.id),
        ["gl-0", "gl-1"],
      );
      assert.ok(p1.nextCursor);

      const p2 = (await (
        await fetch(
          `${harness.baseUrl}/grocery-lists?limit=2&cursor=${encodeURIComponent(
            p1.nextCursor!,
          )}`,
          { headers: auth },
        )
      ).json()) as { groceryLists: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p2.groceryLists.map((g) => g.id),
        ["gl-2"],
      );
      assert.equal(p2.nextCursor, null);
    } finally {
      await harness.close();
    }
  });

  it("cross-page winner: isActiveThisWeek=true on a winner row that falls on page 2, not page 1", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const plans: GLPlanFix[] = [
      {
        id: "plan-winner",
        userId: GL_USER,
        startDate: new Date(now - 3 * day),
        endDate: new Date(now + 3 * day),
        activatedAt: new Date(now - 1 * day),
        createdAt: new Date(now - 5 * day),
        isWizardDraft: false,
      },
    ];
    // 4 lists newest→oldest: gl-0, gl-1 (page 1), gl-2 (winner, page 2), gl-3.
    const base = new Date("2026-05-20T00:00:00Z").getTime();
    const lists: GLFix[] = [
      glFix({ id: "gl-0", userId: GL_USER, createdAt: new Date(base) }),
      glFix({ id: "gl-1", userId: GL_USER, createdAt: new Date(base - day) }),
      glFix({
        id: "gl-2",
        userId: GL_USER,
        createdAt: new Date(base - 2 * day),
        mealPlanInstanceId: "plan-winner",
      }),
      glFix({ id: "gl-3", userId: GL_USER, createdAt: new Date(base - 3 * day) }),
    ];
    const harness = await glSpinUp(lists, plans);
    try {
      const auth = { Authorization: `Bearer ${signToken(GL_USER)}` };
      const p1 = (await (
        await fetch(`${harness.baseUrl}/grocery-lists?limit=2`, {
          headers: auth,
        })
      ).json()) as {
        groceryLists: { id: string; isActiveThisWeek: boolean }[];
        nextCursor: string | null;
      };
      // Winner is NOT on page 1 — and no page-1 row is falsely flagged.
      assert.deepEqual(
        p1.groceryLists.map((g) => g.id),
        ["gl-0", "gl-1"],
      );
      assert.ok(p1.groceryLists.every((g) => g.isActiveThisWeek === false));

      const p2 = (await (
        await fetch(
          `${harness.baseUrl}/grocery-lists?limit=2&cursor=${encodeURIComponent(
            p1.nextCursor!,
          )}`,
          { headers: auth },
        )
      ).json()) as {
        groceryLists: { id: string; isActiveThisWeek: boolean }[];
        nextCursor: string | null;
      };
      const winner = p2.groceryLists.find((g) => g.id === "gl-2");
      assert.ok(winner, "winner gl-2 should be on page 2");
      // The load-bearing case: the winner resolved over the full set, so it
      // still gets the flag despite not being on page 1.
      assert.equal(winner.isActiveThisWeek, true);
      assert.equal(
        p2.groceryLists.find((g) => g.id === "gl-3")?.isActiveThisWeek,
        false,
      );
    } finally {
      await harness.close();
    }
  });

  it("preserves every existing response field on a row (§27 wire-break pin)", async () => {
    const harness = await glSpinUp([
      glFix({
        id: "gl-fields",
        userId: GL_USER,
        title: "Groceries: Field Pin",
        status: "completed",
        sourceType: "plan",
        mealPlanInstanceId: "plan-x",
        lastGeneratedAt: new Date("2026-05-19T00:00:00Z"),
        createdAt: new Date("2026-05-20T00:00:00Z"),
        itemCount: 9,
      }),
    ]);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists`, {
        headers: { Authorization: `Bearer ${signToken(GL_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        groceryLists: Record<string, unknown>[];
        nextCursor: string | null;
      };
      // Default limit (20) easily fits one row → single page, no cursor.
      assert.equal(body.nextCursor, null);
      const row = body.groceryLists[0];
      // Every field the mobile GroceryListListItemSchema consumes must be
      // present — a dropped field is the §27 wire-break.
      assert.deepEqual(Object.keys(row).sort(), [
        "createdAt",
        "id",
        "isActiveThisWeek",
        "itemCount",
        "lastGeneratedAt",
        "mealPlanInstanceId",
        "sourceType",
        "status",
        "title",
      ]);
      assert.equal(row.id, "gl-fields");
      assert.equal(row.title, "Groceries: Field Pin");
      assert.equal(row.status, "completed");
      assert.equal(row.sourceType, "plan");
      assert.equal(row.mealPlanInstanceId, "plan-x");
      assert.equal(row.isActiveThisWeek, false);
      assert.equal(row.itemCount, 9);
      assert.equal(row.lastGeneratedAt, "2026-05-19T00:00:00.000Z");
      assert.equal(row.createdAt, "2026-05-20T00:00:00.000Z");
    } finally {
      await harness.close();
    }
  });

  it("filter composes with cursor: ?filter=past paginates only past rows", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const harness = await glSpinUp([
      // Recent rows — excluded by the past filter, must never appear.
      glFix({ id: "gl-recent-1", userId: GL_USER, createdAt: new Date(now - 1 * day) }),
      glFix({ id: "gl-recent-2", userId: GL_USER, createdAt: new Date(now - 2 * day) }),
      // Past rows (older than the 7-day active window), newest→oldest.
      glFix({ id: "gl-past-1", userId: GL_USER, createdAt: new Date(now - 10 * day) }),
      glFix({ id: "gl-past-2", userId: GL_USER, createdAt: new Date(now - 20 * day) }),
      glFix({ id: "gl-past-3", userId: GL_USER, createdAt: new Date(now - 30 * day) }),
    ]);
    try {
      const auth = { Authorization: `Bearer ${signToken(GL_USER)}` };
      const p1 = (await (
        await fetch(`${harness.baseUrl}/grocery-lists?filter=past&limit=2`, {
          headers: auth,
        })
      ).json()) as { groceryLists: { id: string }[]; nextCursor: string | null };
      assert.deepEqual(
        p1.groceryLists.map((g) => g.id),
        ["gl-past-1", "gl-past-2"],
      );
      assert.ok(p1.nextCursor);

      const p2 = (await (
        await fetch(
          `${harness.baseUrl}/grocery-lists?filter=past&limit=2&cursor=${encodeURIComponent(
            p1.nextCursor!,
          )}`,
          { headers: auth },
        )
      ).json()) as { groceryLists: { id: string }[]; nextCursor: string | null };
      // Only the remaining past row — the cursor did NOT bypass the filter to
      // surface recent rows.
      assert.deepEqual(
        p2.groceryLists.map((g) => g.id),
        ["gl-past-3"],
      );
      assert.equal(p2.nextCursor, null);
    } finally {
      await harness.close();
    }
  });

  it("empty list → { groceryLists: [], nextCursor: null }", async () => {
    const harness = await glSpinUp([]);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists?limit=2`, {
        headers: { Authorization: `Bearer ${signToken(GL_USER)}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        groceryLists: unknown[];
        nextCursor: string | null;
      };
      assert.deepEqual(body.groceryLists, []);
      assert.equal(body.nextCursor, null);
    } finally {
      await harness.close();
    }
  });

  it("a malformed cursor falls back to the first page (forgiving decode)", async () => {
    const harness = await glSpinUp(glSeq(3, GL_USER));
    try {
      const auth = { Authorization: `Bearer ${signToken(GL_USER)}` };
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists?limit=2&cursor=not-a-valid-cursor`,
        { headers: auth },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        groceryLists: { id: string }[];
        nextCursor: string | null;
      };
      // Same as a no-cursor first page — decodeKeysetCursor returned null.
      assert.deepEqual(
        body.groceryLists.map((g) => g.id),
        ["gl-0", "gl-1"],
      );
      assert.ok(body.nextCursor);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-7-A Block 2 — item-mutation routes ───────────────────────────────
//
// PATCH /grocery-lists/:id (status), PATCH/DELETE/restore on items. Reuses
// the rich makeStubPrisma harness (spinUp) and seeds lists + items directly
// into state. Ownership convention: missing AND cross-user both 404 (no
// existence leak) — the cross-user cases are named accordingly.
//
// Route ids must be UUID v1-5 (the routes UUID_RE-validate :id/:itemId), so
// these fixtures use real v4 uuids rather than the "list-1" shorthand the
// generate/GET seeds use.

const B2_USER = "test-user-b2";
const B2_LIST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B2_ITEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const B2_OTHER_LIST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const B2_MISSING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function seedB2List(
  state: StubState,
  overrides: Partial<ListRow> = {},
): ListRow {
  const row: ListRow = {
    id: B2_LIST,
    userId: B2_USER,
    mealPlanInstanceId: "plan-b2",
    status: "active",
    title: "Groceries: B2",
    sourceType: "plan",
    lastGeneratedFromPlanRevisionId: 1,
    lastGeneratedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
  state.lists.push(row);
  return row;
}

function seedB2Item(
  state: StubState,
  overrides: Partial<ListItemRow> = {},
): ListItemRow {
  const row: ListItemRow = {
    id: B2_ITEM,
    groceryListId: B2_LIST,
    ingredientId: null,
    displayName: "Tomato",
    quantity: 1,
    unit: "each",
    storeSection: "produce",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    wasAiInferred: false,
    isAmbiguous: false,
    ambiguityOptions: [],
    isUserAdded: false,
    isChecked: false,
    stapleOptedIn: false,
    userResolvedTo: null,
    deletedAt: null,
    notes: null,
    ...overrides,
  };
  state.listItems.push(row);
  return row;
}

function bearer(user: string): { Authorization: string; "Content-Type": string } {
  return {
    Authorization: `Bearer ${signToken(user)}`,
    "Content-Type": "application/json",
  };
}

// Fetch a single item back through the GET detail read path — the canonical
// round-trip assertion (write must surface correctly through the serializer).
async function getItemViaDetail(
  baseUrl: string,
  listId: string,
  itemId: string,
): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`${baseUrl}/grocery-lists/${listId}`, {
    headers: { Authorization: `Bearer ${signToken(B2_USER)}` },
  });
  const body = (await res.json()) as {
    list: { items: Record<string, unknown>[] };
  };
  return body.list.items.find((i) => i.id === itemId);
}

describe("PATCH /api/grocery-lists/:id — mark shopping done (§12.6.3)", () => {
  it("active→completed: 200, persists status", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists/${B2_LIST}`, {
        method: "PATCH",
        headers: bearer(B2_USER),
        body: JSON.stringify({ status: "completed" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { list: { status: string } };
      assert.equal(body.list.status, "completed");
      assert.equal(harness.state.lists[0].status, "completed");
    } finally {
      await harness.close();
    }
  });

  it("completed→active: reversible per §12.6.3", async () => {
    const harness = await spinUp();
    seedB2List(harness.state, { status: "completed" });
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists/${B2_LIST}`, {
        method: "PATCH",
        headers: bearer(B2_USER),
        body: JSON.stringify({ status: "active" }),
      });
      assert.equal(res.status, 200);
      assert.equal(harness.state.lists[0].status, "active");
    } finally {
      await harness.close();
    }
  });

  for (const bad of ["ordered", "archived", "draft", "bogus"]) {
    it(`rejects status="${bad}" with 400 (only active/completed settable)`, async () => {
      const harness = await spinUp();
      seedB2List(harness.state);
      try {
        const res = await fetch(`${harness.baseUrl}/grocery-lists/${B2_LIST}`, {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ status: bad }),
        });
        assert.equal(res.status, 400);
        // status unchanged
        assert.equal(harness.state.lists[0].status, "active");
      } finally {
        await harness.close();
      }
    });
  }

  it("404 when the list is missing", async () => {
    const harness = await spinUp();
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists/${B2_MISSING}`, {
        method: "PATCH",
        headers: bearer(B2_USER),
        body: JSON.stringify({ status: "completed" }),
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("404 by design (no existence leak) when the list belongs to another user", async () => {
    const harness = await spinUp();
    seedB2List(harness.state, { userId: "stranger-b2" });
    try {
      const res = await fetch(`${harness.baseUrl}/grocery-lists/${B2_LIST}`, {
        method: "PATCH",
        headers: bearer(B2_USER),
        body: JSON.stringify({ status: "completed" }),
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });
});

describe("PATCH /api/grocery-lists/:id/items/:itemId", () => {
  it("isChecked round-trips through GET detail (farmer's-market flow)", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2Item(harness.state);
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ isChecked: true }),
        },
      );
      assert.equal(res.status, 200);
      const read = await getItemViaDetail(harness.baseUrl, B2_LIST, B2_ITEM);
      assert.equal(read?.isChecked, true);
    } finally {
      await harness.close();
    }
  });

  it("quantity+unit round-trip", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2Item(harness.state);
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ quantity: 3, unit: "lb" }),
        },
      );
      assert.equal(res.status, 200);
      const read = await getItemViaDetail(harness.baseUrl, B2_LIST, B2_ITEM);
      assert.equal(read?.quantity, 3);
      assert.equal(read?.unit, "lb");
    } finally {
      await harness.close();
    }
  });

  it("stapleOptedIn opt-in round-trip (§12.7); leaves isUniversalStaple untouched", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    // A universal-staple classification item, opted-out by default.
    seedB2Item(harness.state, { isUniversalStaple: true, stapleOptedIn: false });
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ stapleOptedIn: true }),
        },
      );
      assert.equal(res.status, 200);
      const read = await getItemViaDetail(harness.baseUrl, B2_LIST, B2_ITEM);
      assert.equal(read?.stapleOptedIn, true);
      // Classification flag is immutable via this route.
      assert.equal(read?.isUniversalStaple, true);
    } finally {
      await harness.close();
    }
  });

  it("multi-field: displayName + storeSection together", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2Item(harness.state);
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({
            displayName: "Roma tomatoes",
            storeSection: "produce",
          }),
        },
      );
      assert.equal(res.status, 200);
      const read = await getItemViaDetail(harness.baseUrl, B2_LIST, B2_ITEM);
      assert.equal(read?.displayName, "Roma tomatoes");
      assert.equal(read?.storeSection, "produce");
    } finally {
      await harness.close();
    }
  });

  it("userResolvedTo sets isAmbiguous:false, keeps ambiguityOptions as audit (§12.5)", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2Item(harness.state, {
      isAmbiguous: true,
      ambiguityOptions: ["thighs", "breast", "ground"],
      userResolvedTo: null,
    });
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ userResolvedTo: "thighs" }),
        },
      );
      assert.equal(res.status, 200);
      const read = await getItemViaDetail(harness.baseUrl, B2_LIST, B2_ITEM);
      assert.equal(read?.userResolvedTo, "thighs");
      assert.equal(read?.isAmbiguous, false);
      assert.deepEqual(read?.ambiguityOptions, ["thighs", "breast", "ground"]);
    } finally {
      await harness.close();
    }
  });

  it("userResolvedTo:null leaves isAmbiguous as-is (clearing a resolution)", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2Item(harness.state, {
      isAmbiguous: true,
      ambiguityOptions: ["a", "b"],
      userResolvedTo: "a",
    });
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ userResolvedTo: null }),
        },
      );
      assert.equal(res.status, 200);
      const read = await getItemViaDetail(harness.baseUrl, B2_LIST, B2_ITEM);
      assert.equal(read?.userResolvedTo, null);
      // isAmbiguous untouched — caller explicitly cleared the resolution.
      assert.equal(read?.isAmbiguous, true);
    } finally {
      await harness.close();
    }
  });

  it("acknowledgeAmbiguity clears isAmbiguous WITHOUT writing userResolvedTo (B5 leave-as-is)", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2Item(harness.state, {
      isAmbiguous: true,
      ambiguityOptions: ["thighs", "breast"],
      userResolvedTo: null,
    });
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ acknowledgeAmbiguity: true }),
        },
      );
      assert.equal(res.status, 200);
      const read = await getItemViaDetail(harness.baseUrl, B2_LIST, B2_ITEM);
      // Flag dropped permanently; value left as-is (no projection).
      assert.equal(read?.isAmbiguous, false);
      assert.equal(read?.userResolvedTo, null);
    } finally {
      await harness.close();
    }
  });

  it("empty body → 400 (refine requires at least one field)", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2Item(harness.state);
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({}),
        },
      );
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("404 when the item is missing", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_MISSING}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ isChecked: true }),
        },
      );
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("404 by design (no existence leak) when the list belongs to another user", async () => {
    const harness = await spinUp();
    seedB2List(harness.state, { userId: "stranger-b2" });
    seedB2Item(harness.state);
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ isChecked: true }),
        },
      );
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("404 when the item exists but under a different list (mismatched pair)", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2List(harness.state, { id: B2_OTHER_LIST });
    // Item lives under B2_OTHER_LIST, but the request targets B2_LIST.
    seedB2Item(harness.state, { groceryListId: B2_OTHER_LIST });
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        {
          method: "PATCH",
          headers: bearer(B2_USER),
          body: JSON.stringify({ isChecked: true }),
        },
      );
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });
});

describe("DELETE + restore /api/grocery-lists/:id/items/:itemId (§12.9 soft-delete)", () => {
  it("soft-delete: 200, returns the item, stamps deletedAt, excludes from GET; restore brings it back with the SAME id", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2Item(harness.state);
    // Provenance rows that must survive the soft-delete for restore.
    harness.state.itemSources.push(
      { groceryListItemId: B2_ITEM, mealId: "m1", dishId: "d1" },
      { groceryListItemId: B2_ITEM, mealId: "m2", dishId: "d2" },
    );
    try {
      // Delete.
      const del = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        { method: "DELETE", headers: bearer(B2_USER) },
      );
      assert.equal(del.status, 200);
      const delBody = (await del.json()) as {
        item: { id: string; deletedAt: string | null };
      };
      assert.equal(delBody.item.id, B2_ITEM);
      assert.notEqual(delBody.item.deletedAt, null);

      // Excluded from GET detail.
      const gone = await getItemViaDetail(harness.baseUrl, B2_LIST, B2_ITEM);
      assert.equal(gone, undefined);

      // Source rows untouched (cascade fires on hard delete only).
      assert.equal(
        harness.state.itemSources.filter((s) => s.groceryListItemId === B2_ITEM)
          .length,
        2,
      );

      // Restore.
      const restore = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}/restore`,
        { method: "POST", headers: bearer(B2_USER) },
      );
      assert.equal(restore.status, 200);
      const restoreBody = (await restore.json()) as {
        item: { id: string; deletedAt: string | null };
      };
      assert.equal(restoreBody.item.id, B2_ITEM); // same row id
      assert.equal(restoreBody.item.deletedAt, null);

      // Present again in GET detail, same id, provenance still attached.
      const back = await getItemViaDetail(harness.baseUrl, B2_LIST, B2_ITEM);
      assert.equal(back?.id, B2_ITEM);
      assert.equal(
        harness.state.itemSources.filter((s) => s.groceryListItemId === B2_ITEM)
          .length,
        2,
      );
    } finally {
      await harness.close();
    }
  });

  it("double-delete is idempotent (does not re-stamp / shorten the undo window)", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    const firstStamp = new Date("2026-06-01T00:00:00.000Z");
    seedB2Item(harness.state, { deletedAt: firstStamp });
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        { method: "DELETE", headers: bearer(B2_USER) },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { item: { deletedAt: string } };
      assert.equal(new Date(body.item.deletedAt).getTime(), firstStamp.getTime());
    } finally {
      await harness.close();
    }
  });

  it("restore of a live (non-deleted) item is idempotent", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    seedB2Item(harness.state, { deletedAt: null });
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}/restore`,
        { method: "POST", headers: bearer(B2_USER) },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { item: { deletedAt: string | null } };
      assert.equal(body.item.deletedAt, null);
    } finally {
      await harness.close();
    }
  });

  it("DELETE 404 when the item is missing", async () => {
    const harness = await spinUp();
    seedB2List(harness.state);
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_MISSING}`,
        { method: "DELETE", headers: bearer(B2_USER) },
      );
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("DELETE 404 by design (no existence leak) when the list belongs to another user", async () => {
    const harness = await spinUp();
    seedB2List(harness.state, { userId: "stranger-b2" });
    seedB2Item(harness.state);
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}`,
        { method: "DELETE", headers: bearer(B2_USER) },
      );
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("restore 404 by design (no existence leak) when the list belongs to another user", async () => {
    const harness = await spinUp();
    seedB2List(harness.state, { userId: "stranger-b2" });
    seedB2Item(harness.state, { deletedAt: new Date() });
    try {
      const res = await fetch(
        `${harness.baseUrl}/grocery-lists/${B2_LIST}/items/${B2_ITEM}/restore`,
        { method: "POST", headers: bearer(B2_USER) },
      );
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-7-A Block 4 — GET-triggered incremental reconcile (D-WS7-079) ─────
//
// These exercise the reconcile-on-read consumer directly through GET
// /grocery-lists/:id. The consolidator + AI helpers are stubbed input-aware:
// the consolidator returns a per-test "current plan" array (the live plan
// state) and the final-pass echoes its subset 1:1 (a deterministic no-op AI).
// Existing rows + their GroceryListItemSource rows are seeded to represent the
// PRIOR generation. The delta is computed from those two — no separate plan-
// items query exists, by design (Phase 0 Q1 / Option A).

const R_USER = "recon-user-ws7-7a-b4";
const R_PLAN = "plan-recon";
const R_LIST = "list-recon";

interface ReconSpies {
  consolidate: number;
  fill: number;
  finalPass: number;
}

interface ReconHarness {
  baseUrl: string;
  state: StubState;
  spies: ReconSpies;
  close: () => Promise<void>;
}

function finalFromConsolidated(
  items: ConsolidatedItem[],
): GenerateGroceryListResult["items"] {
  return items.map((c) => ({
    canonicalName: c.canonicalName,
    displayName: c.displayName,
    quantity: c.quantity,
    unit: c.unit,
    sectionKey: c.sectionKey,
    isUniversalStaple: c.isUniversalStaple,
    isUserPantryStaple: c.isUserPantryStaple,
    isRecurringItem: c.isRecurringItem,
    notes: null,
    isAmbiguous: false,
    wasAiInferred: false,
  }));
}

async function spinUpReconcile(opts: {
  current: ConsolidatedItem[];
  aiThrows?: Error;
}): Promise<ReconHarness> {
  const state = makeState();
  const stubPrisma = makeStubPrisma(state);
  const spies: ReconSpies = { consolidate: 0, fill: 0, finalPass: 0 };

  const router = createGroceryListsRouter({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: stubPrisma as any,
    consolidatePlanIngredients: (async () => {
      spies.consolidate++;
      return opts.current;
    }) as never,
    // Echo the resolution subset through unchanged (cache-hit shape).
    fillPurchaseSizesWithWriteBack: (async (items: ConsolidatedItem[]) => {
      spies.fill++;
      return items;
    }) as never,
    generateFinalGroceryList: (async (
      _planTitle: string,
      items: ConsolidatedItem[],
    ) => {
      spies.finalPass++;
      if (opts.aiThrows) throw opts.aiThrows;
      return { items: finalFromConsolidated(items) };
    }) as never,
  });

  const app: Express = express();
  app.use(express.json());
  app.use("/api", router);

  return await new Promise<ReconHarness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        state,
        spies,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

function seedReconPlan(state: StubState, revisionId: number): void {
  seedPlan(state, { id: R_PLAN, userId: R_USER, revisionId });
}

function seedReconList(
  state: StubState,
  lastGeneratedFromPlanRevisionId: number,
): void {
  seedExistingList(state, {
    id: R_LIST,
    userId: R_USER,
    mealPlanInstanceId: R_PLAN,
    lastGeneratedFromPlanRevisionId,
  });
}

function seedReconItem(
  state: StubState,
  itemRow: Partial<ListItemRow> & { id: string },
): void {
  state.listItems.push({
    groceryListId: R_LIST,
    ingredientId: null,
    displayName: "",
    quantity: 1,
    unit: "",
    storeSection: "pantry",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    wasAiInferred: false,
    isAmbiguous: false,
    ambiguityOptions: [],
    isUserAdded: false,
    notes: null,
    ...itemRow,
  });
}

function seedReconSource(
  state: StubState,
  itemId: string,
  mealId: string,
  dishId: string,
  opts: { servings?: number | null; ingredientSignature?: string | null } = {},
): void {
  state.itemSources.push({
    groceryListItemId: itemId,
    mealId,
    dishId,
    servings: opts.servings === undefined ? TEST_DEFAULT_SERVINGS : opts.servings,
    ingredientSignature:
      opts.ingredientSignature === undefined
        ? TEST_DEFAULT_SIG
        : opts.ingredientSignature,
  });
}

async function getList(h: ReconHarness): Promise<Response> {
  return fetch(`${h.baseUrl}/grocery-lists/${R_LIST}`, {
    headers: { Authorization: `Bearer ${signToken(R_USER)}` },
  });
}

function findRow(state: StubState, id: string): ListItemRow | undefined {
  return state.listItems.find((i) => i.id === id);
}

describe("WS7-7-A B4 — reconcile: revision-equal serves as-is", () => {
  it("does zero work (no consolidator/fill/final calls) and leaves rows untouched", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
      ],
    });
    seedReconPlan(h.state, 7);
    seedReconList(h.state, 7); // equal → no drift
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      quantity: 3,
      isChecked: true,
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(
        ((await res.json()) as { reconciled: boolean }).reconciled,
        false,
      ); // fast path, no banner
      assert.equal(h.spies.consolidate, 0);
      assert.equal(h.spies.fill, 0);
      assert.equal(h.spies.finalPass, 0);
      assert.equal(h.state.lists[0].lastGeneratedFromPlanRevisionId, 7);
      assert.equal(findRow(h.state, "it-garlic")!.quantity, 3);
      assert.equal(findRow(h.state, "it-garlic")!.isChecked, true);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: unchanged meal carries row forward", () => {
  it("preserves full B2 user state byte-identical and skips re-resolution", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          displayName: "Garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          quantity: 2,
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
      ],
    });
    seedReconPlan(h.state, 8);
    seedReconList(h.state, 7); // stale
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      quantity: 3, // user-edited
      isChecked: true,
      stapleOptedIn: true,
      storeSection: "produce",
      userResolvedTo: "garlic clove",
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(h.spies.consolidate, 1);
      assert.equal(h.spies.fill, 0);
      assert.equal(h.spies.finalPass, 0);
      const g = findRow(h.state, "it-garlic")!;
      assert.equal(g.quantity, 3);
      assert.equal(g.isChecked, true);
      assert.equal(g.stapleOptedIn, true);
      assert.equal(g.storeSection, "produce");
      assert.equal(g.userResolvedTo, "garlic clove");
      assert.equal(h.state.lists[0].lastGeneratedFromPlanRevisionId, 8);
    } finally {
      await h.close();
    }
  });
});

// ── WS7-7-A Block 5 — intra-meal change-signature detection ─────────────
// These exercise the load-bearing D-WS7-134 fix: a meal STAYS in the plan
// (same mealId+dishId, so B4's meal-id-set arithmetic sees "unchanged") but
// its contribution moved — servings or ingredient set. The per-source change-
// signature is what makes reconcile re-resolve instead of no-op carrying a
// stale quantity forward.

describe("WS7-7-A B5 — reconcile: servings-only change re-resolves", () => {
  it("re-resolves a same-mealId source when effective servings moved (D-WS7-134)", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          displayName: "Garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          quantity: 6, // recomputed for the new servings
          // Same mealId+dishId, same ingredient signature, but servings 4 → 8.
          sources: [
            {
              mealId: "meal-a",
              dishId: "dish-x",
              servings: 8,
              ingredientSignature: TEST_DEFAULT_SIG,
            },
          ],
        }),
      ],
    });
    seedReconPlan(h.state, 9);
    seedReconList(h.state, 8); // stale
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      quantity: 3, // pre-edit quantity — must NOT be carried forward
      isChecked: true,
    });
    // Seeded source: servings 4 (the pre-edit value), default signature.
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x", { servings: 4 });
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(
        ((await res.json()) as { reconciled: boolean }).reconciled,
        true,
      ); // surfaced to client
      assert.equal(h.spies.finalPass, 1); // re-resolved, not carried
      assert.equal(findRow(h.state, "it-garlic"), undefined); // old row gone
      const fresh = h.state.listItems.find(
        (i) => i.displayName === "Garlic" && i.id !== "it-garlic",
      )!;
      assert.ok(fresh);
      assert.equal(fresh.quantity, 6); // reflects new servings
      const srcs = h.state.itemSources.filter(
        (s) => s.groceryListItemId === fresh.id,
      );
      assert.equal(srcs[0].servings, 8); // fresh signature persisted
      assert.equal(h.state.lists[0].lastGeneratedFromPlanRevisionId, 9);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B5 — reconcile: ingredient-only change re-resolves", () => {
  it("re-resolves a same-mealId source when the ingredient signature moved", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          displayName: "Garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          quantity: 5,
          // Same mealId+dishId+servings, but the ingredient set changed.
          sources: [
            {
              mealId: "meal-a",
              dishId: "dish-x",
              servings: TEST_DEFAULT_SERVINGS,
              ingredientSignature: "sig-changed",
            },
          ],
        }),
      ],
    });
    seedReconPlan(h.state, 9);
    seedReconList(h.state, 8);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      quantity: 2,
      isChecked: true,
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x"); // default sig
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(h.spies.finalPass, 1);
      assert.equal(findRow(h.state, "it-garlic"), undefined);
      const fresh = h.state.listItems.find(
        (i) => i.displayName === "Garlic" && i.id !== "it-garlic",
      )!;
      assert.equal(fresh.quantity, 5);
      assert.equal(h.state.lists[0].lastGeneratedFromPlanRevisionId, 9);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B5 — reconcile: truly-unchanged carries forward (signature match)", () => {
  it("matching servings AND signature carries the row with B2 user state intact", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          displayName: "Garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          quantity: 2,
          sources: [
            {
              mealId: "meal-a",
              dishId: "dish-x",
              servings: TEST_DEFAULT_SERVINGS,
              ingredientSignature: TEST_DEFAULT_SIG,
            },
          ],
        }),
      ],
    });
    seedReconPlan(h.state, 8);
    seedReconList(h.state, 7); // stale (some OTHER meal changed → revision bumped)
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      quantity: 3, // user-edited
      isChecked: true,
      stapleOptedIn: true,
      userResolvedTo: "garlic clove",
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x"); // matching defaults
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(h.spies.finalPass, 0); // carried, not re-resolved
      const g = findRow(h.state, "it-garlic")!;
      assert.equal(g.quantity, 3); // user edit preserved
      assert.equal(g.isChecked, true);
      assert.equal(g.stapleOptedIn, true);
      assert.equal(g.userResolvedTo, "garlic clove");
      assert.equal(h.state.lists[0].lastGeneratedFromPlanRevisionId, 8);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B5 — reconcile: pre-B5 null signature re-resolves once (D1)", () => {
  it("a null stored signature fails the carry test and re-resolves on first reconcile", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          displayName: "Garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          quantity: 2,
          sources: [{ mealId: "meal-a", dishId: "dish-x" }], // computed sig
        }),
      ],
    });
    seedReconPlan(h.state, 8);
    seedReconList(h.state, 7);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      quantity: 2,
    });
    // Pre-B5 row: null servings + null signature (column didn't exist yet).
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x", {
      servings: null,
      ingredientSignature: null,
    });
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(h.spies.finalPass, 1); // re-resolved once (self-heals)
      assert.equal(h.state.lists[0].lastGeneratedFromPlanRevisionId, 8);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: changed meal (swap) re-resolves", () => {
  it("re-resolves the swapped-in meal and does NOT preserve prior check-state (D-WS7-124)", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "chicken",
          displayName: "Chicken",
          ingredientId: "ing-chicken",
          unit: "lb",
          quantity: 2,
          sources: [{ mealId: "meal-b", dishId: "dish-z" }],
        }),
      ],
    });
    seedReconPlan(h.state, 9);
    seedReconList(h.state, 8);
    seedReconItem(h.state, {
      id: "it-chicken",
      ingredientId: "ing-chicken",
      displayName: "Chicken",
      unit: "lb",
      quantity: 1,
      isChecked: true, // must NOT survive re-resolution
    });
    seedReconSource(h.state, "it-chicken", "meal-a", "dish-x");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(h.spies.finalPass, 1);
      assert.equal(findRow(h.state, "it-chicken"), undefined);
      const fresh = h.state.listItems.find((i) => i.displayName === "Chicken")!;
      assert.equal(fresh.quantity, 2);
      assert.notEqual(fresh.isChecked, true);
      const srcs = h.state.itemSources.filter(
        (s) => s.groceryListItemId === fresh.id,
      );
      assert.equal(srcs.length, 1);
      assert.equal(srcs[0].mealId, "meal-b");
      assert.equal(h.state.lists[0].lastGeneratedFromPlanRevisionId, 9);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: added meal", () => {
  it("appends new rows with provenance and leaves the unchanged row alone", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
        consolidatedItem({
          canonicalName: "basil",
          displayName: "Basil",
          ingredientId: "ing-basil",
          unit: "bunch",
          quantity: 1,
          sources: [{ mealId: "meal-b", dishId: "dish-z" }],
        }),
      ],
    });
    seedReconPlan(h.state, 5);
    seedReconList(h.state, 4);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      isChecked: true,
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(findRow(h.state, "it-garlic")!.isChecked, true);
      const basil = h.state.listItems.find((i) => i.displayName === "Basil")!;
      assert.ok(basil);
      assert.equal(basil.isUserAdded, false);
      const srcs = h.state.itemSources.filter(
        (s) => s.groceryListItemId === basil.id,
      );
      assert.equal(srcs.length, 1);
      assert.equal(srcs[0].mealId, "meal-b");
      assert.equal(h.spies.finalPass, 1);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: removed meal", () => {
  it("hard-deletes the removed meal's rows (and its sources) without re-resolution", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
      ],
    });
    seedReconPlan(h.state, 6);
    seedReconList(h.state, 5);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    seedReconItem(h.state, {
      id: "it-basil",
      ingredientId: "ing-basil",
      displayName: "Basil",
      unit: "bunch",
    });
    seedReconSource(h.state, "it-basil", "meal-b", "dish-z");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.ok(findRow(h.state, "it-garlic"));
      assert.equal(findRow(h.state, "it-basil"), undefined);
      assert.equal(
        h.state.itemSources.filter((s) => s.groceryListItemId === "it-basil")
          .length,
        0,
      );
      assert.equal(h.spies.finalPass, 0);
      assert.equal(h.state.lists[0].lastGeneratedFromPlanRevisionId, 6);
    } finally {
      await h.close();
    }
  });

  it("hard-deletes a removed meal's row even when the user had checked it off", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
      ],
    });
    seedReconPlan(h.state, 6);
    seedReconList(h.state, 5);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    seedReconItem(h.state, {
      id: "it-basil",
      ingredientId: "ing-basil",
      displayName: "Basil",
      unit: "bunch",
      isChecked: true, // checked off, still removed
    });
    seedReconSource(h.state, "it-basil", "meal-b", "dish-z");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(findRow(h.state, "it-basil"), undefined);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: suppression vs resurrection (D-WS7-126)", () => {
  it("keeps a user-deleted row deleted when its source meal is unchanged (suppression)", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
      ],
    });
    seedReconPlan(h.state, 6);
    seedReconList(h.state, 5);
    const deletedAt = new Date("2026-06-10T00:00:00.000Z");
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      deletedAt,
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      const g = findRow(h.state, "it-garlic")!;
      assert.ok(g);
      assert.equal(g.deletedAt, deletedAt);
      assert.equal(h.spies.finalPass, 0);
      assert.equal(
        h.state.listItems.filter((i) => i.displayName === "Garlic").length,
        1,
      );
    } finally {
      await h.close();
    }
  });

  it("may regenerate a user-deleted row when its source meal changed (resurrection)", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          displayName: "Garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          sources: [{ mealId: "meal-b", dishId: "dish-z" }],
        }),
      ],
    });
    seedReconPlan(h.state, 6);
    seedReconList(h.state, 5);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      deletedAt: new Date("2026-06-10T00:00:00.000Z"),
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(findRow(h.state, "it-garlic"), undefined);
      const fresh = h.state.listItems.find((i) => i.displayName === "Garlic")!;
      assert.ok(fresh);
      assert.ok(!fresh.deletedAt);
      assert.equal(h.spies.finalPass, 1);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: never touches isUserAdded rows", () => {
  it("leaves a user-added (zero-source, non-recurring) row untouched across an added-meal reconcile", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
        consolidatedItem({
          canonicalName: "basil",
          displayName: "Basil",
          ingredientId: "ing-basil",
          unit: "bunch",
          sources: [{ mealId: "meal-b", dishId: "dish-z" }],
        }),
      ],
    });
    seedReconPlan(h.state, 5);
    seedReconList(h.state, 4);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    seedReconItem(h.state, {
      id: "it-extra",
      displayName: "Sea salt",
      unit: "each",
      isUserAdded: true,
      isChecked: true,
    });
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      const extra = findRow(h.state, "it-extra")!;
      assert.ok(extra);
      assert.equal(extra.isUserAdded, true);
      assert.equal(extra.isChecked, true);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: zero-source discriminator (recurring vs AI-tail)", () => {
  it("preserves a recurring zero-source row + its user state (not treated as AI tail)", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "basil",
          displayName: "Basil",
          ingredientId: "ing-basil",
          unit: "bunch",
          sources: [{ mealId: "meal-b", dishId: "dish-z" }],
        }),
      ],
    });
    seedReconPlan(h.state, 5);
    seedReconList(h.state, 4);
    seedReconItem(h.state, {
      id: "it-towels",
      displayName: "Paper towels",
      unit: "each",
      isRecurringItem: true,
      isChecked: true,
    });
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      const t = findRow(h.state, "it-towels")!;
      assert.ok(t);
      assert.equal(t.isRecurringItem, true);
      assert.equal(t.isChecked, true);
    } finally {
      await h.close();
    }
  });

  it("re-resolves an AI-tail zero-source row (isRecurringItem:false) and preserves the AI flag faithfully", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "chicken",
          displayName: "Chicken",
          ingredientId: "ing-chicken",
          unit: "lb",
          quantity: 2,
          isRecurringItem: false,
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
      ],
    });
    seedReconPlan(h.state, 5);
    seedReconList(h.state, 4);
    seedReconItem(h.state, {
      id: "it-tail",
      ingredientId: null,
      displayName: "1 lb chicken breast",
      unit: "lb",
      isRecurringItem: false,
      isChecked: true, // not preserved through re-resolution
    });
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(findRow(h.state, "it-tail"), undefined);
      const fresh = h.state.listItems.find((i) => i.displayName === "Chicken")!;
      assert.ok(fresh);
      assert.equal(fresh.isRecurringItem, false);
      assert.notEqual(fresh.isChecked, true);
      assert.equal(h.spies.finalPass, 1);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: mixed and bucket-merge edge cases", () => {
  it("re-resolves a row whose sources span unchanged + removed meals (stale-down)", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          displayName: "Garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          quantity: 2,
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
      ],
    });
    seedReconPlan(h.state, 6);
    seedReconList(h.state, 5);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      quantity: 4, // reflected both meals at gen
      isChecked: true,
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    seedReconSource(h.state, "it-garlic", "meal-b", "dish-y");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(findRow(h.state, "it-garlic"), undefined);
      const fresh = h.state.listItems.find((i) => i.displayName === "Garlic")!;
      assert.equal(fresh.quantity, 2);
      assert.notEqual(fresh.isChecked, true);
      assert.equal(h.spies.finalPass, 1);
    } finally {
      await h.close();
    }
  });

  it("loses prior user state when an unchanged-meal ingredient bucket-merges with an added meal (D-WS7-124 widened)", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          displayName: "Garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          quantity: 4,
          sources: [
            { mealId: "meal-a", dishId: "dish-x" },
            { mealId: "meal-b", dishId: "dish-z" },
          ],
        }),
      ],
    });
    seedReconPlan(h.state, 6);
    seedReconList(h.state, 5);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      quantity: 2,
      isChecked: true, // state LOST on bucket-merge re-resolve
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(findRow(h.state, "it-garlic"), undefined);
      const fresh = h.state.listItems.find((i) => i.displayName === "Garlic")!;
      assert.equal(fresh.quantity, 4);
      assert.notEqual(fresh.isChecked, true);
      const srcMeals = h.state.itemSources
        .filter((s) => s.groceryListItemId === fresh.id)
        .map((s) => s.mealId)
        .sort();
      assert.deepEqual(srcMeals, ["meal-a", "meal-b"]);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: failure path", () => {
  it("on GroceryListAIError serves prior state un-stamped (no writes, pointer not advanced)", async () => {
    const h = await spinUpReconcile({
      current: [
        consolidatedItem({
          canonicalName: "garlic",
          ingredientId: "ing-garlic",
          unit: "clove",
          sources: [{ mealId: "meal-a", dishId: "dish-x" }],
        }),
        consolidatedItem({
          canonicalName: "basil",
          displayName: "Basil",
          ingredientId: "ing-basil",
          unit: "bunch",
          sources: [{ mealId: "meal-b", dishId: "dish-z" }],
        }),
      ],
      aiThrows: new GroceryListAIError("simulated AI failure"),
    });
    seedReconPlan(h.state, 6);
    seedReconList(h.state, 5);
    seedReconItem(h.state, {
      id: "it-garlic",
      ingredientId: "ing-garlic",
      displayName: "Garlic",
      unit: "clove",
      isChecked: true,
    });
    seedReconSource(h.state, "it-garlic", "meal-a", "dish-x");
    try {
      const res = await getList(h);
      assert.equal(res.status, 200); // never 5xx on a failed background reconcile
      assert.equal(h.spies.finalPass, 1); // AI was attempted
      const g = findRow(h.state, "it-garlic")!;
      assert.equal(g.isChecked, true);
      assert.equal(
        h.state.listItems.find((i) => i.displayName === "Basil"),
        undefined,
      );
      assert.equal(h.state.lists[0].lastGeneratedFromPlanRevisionId, 5);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — reconcile: lists with no plan link skip entirely", () => {
  it("does not reconcile a null-plan list (no consolidator call)", async () => {
    const h = await spinUpReconcile({ current: [] });
    h.state.lists.push({
      id: R_LIST,
      userId: R_USER,
      mealPlanInstanceId: null as unknown as string,
      status: "active",
      title: "Recurring stock",
      sourceType: "recurring",
      lastGeneratedFromPlanRevisionId: null,
      lastGeneratedAt: null,
      createdAt: new Date(),
    });
    try {
      const res = await getList(h);
      assert.equal(res.status, 200);
      assert.equal(h.spies.consolidate, 0);
    } finally {
      await h.close();
    }
  });
});

describe("WS7-7-A B4 — 409 generate contract regression pin", () => {
  it("returns the byte-stable 409 wire shape (error/existingListId/message)", async () => {
    const h = await spinUpReconcile({ current: [] });
    seedReconPlan(h.state, 3);
    h.state.lists.push({
      id: "list-existing-pin",
      userId: R_USER,
      mealPlanInstanceId: R_PLAN,
      status: "active",
      title: "Groceries",
      sourceType: "plan",
      lastGeneratedFromPlanRevisionId: 3,
      lastGeneratedAt: new Date(),
      createdAt: new Date(),
    });
    try {
      const res = await fetch(
        `${h.baseUrl}/plans/${R_PLAN}/generate-grocery-list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${signToken(R_USER)}` },
        },
      );
      assert.equal(res.status, 409);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.error, "list_exists");
      assert.equal(body.existingListId, "list-existing-pin");
      assert.equal(body.message, "A grocery list already exists for this plan.");
    } finally {
      await h.close();
    }
  });
});
