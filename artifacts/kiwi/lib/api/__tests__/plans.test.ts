// WS7-3 Block C1 — tests for lib/api/plans.ts.
// Covers the getters + schemas (getPlans / getPlan fetch-mocked round-trips,
// the ?filter= query construction, 404 / 401 / schema-mismatch propagation)
// and the usePlans / usePlan React Query hooks (loading→data, enabled gating).
// Harness mirrors meals.test.ts (fetch mock + SecureStore stub).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import {
  getPlan,
  getPlans,
  getTemplate,
  useTemplate,
  PlanDetailSchema,
  PlanListItemSchema,
  PlanSummarySchema,
} from "../plans";
import { ApiError, ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";
import { usePlan } from "@/hooks/usePlan";
import { usePlans } from "@/hooks/usePlans";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

// An `instance`-sourced plan row — the user's own saved plan.
const INSTANCE_ROW = {
  id: "plan-1",
  name: "Spice It Up",
  description: "A bold week of cooking.",
  image: null,
  tags: ["spicy", "weeknight"],
  source: "instance",
  status: "this_week",
  startDate: "2026-05-18T00:00:00.000Z",
  endDate: "2026-05-24T00:00:00.000Z",
  isActiveThisWeek: true,
};

// A `template`-sourced plan row — a public catalog entry: null status/dates.
const TEMPLATE_ROW = {
  id: "tmpl-1",
  name: "Featured Feast",
  description: null,
  image: "https://example.com/feast.jpg",
  tags: ["featured"],
  source: "template",
  status: null,
  startDate: null,
  endDate: null,
  isActiveThisWeek: false,
};

const ACTIVE_SUMMARY = {
  id: "plan-1",
  name: "Spice It Up",
  status: "this_week",
  startDate: "2026-05-18T00:00:00.000Z",
  endDate: "2026-05-24T00:00:00.000Z",
  revisionId: 3,
};

const PLAN_LIST_RESPONSE = {
  plans: [INSTANCE_ROW, TEMPLATE_ROW],
  activeThisWeek: ACTIVE_SUMMARY,
  nextCursor: null,
};

// A full MealDetail — the per-item Meal expansion in a Plan Review payload.
const MEAL_DETAIL = {
  id: "meal-1",
  title: "Salmon Teriyaki",
  cuisine: "Japanese",
  minutes: 30,
  servings: 4,
  calories: 540,
  protein: 38,
  carbs: 32,
  fat: 24,
  tags: ["seafood"],
  image: null,
  description: "Pan-seared salmon.",
  difficulty: "easy",
  mealType: "dinner",
  sourceType: "curated",
  isPublic: true,
  userId: null,
  dishes: [
    {
      dishId: "dish-1",
      title: "Salmon",
      roleLabel: "main",
      positionIndex: 0,
      minutes: 30,
      difficulty: "easy",
      servings: 4,
      ingredients: [
        {
          name: "Salmon fillets",
          quantity: 1.5,
          unit: "lb",
          preparationNote: null,
          category: "Protein",
          isOptional: false,
        },
      ],
      steps: [
        {
          stepIndex: 0,
          text: "Sear the salmon.",
          estimatedMinutes: 5,
          phaseType: "cook",
          parallelGroup: null,
          requiresPreheat: false,
          requiresRest: false,
          requiresMarination: false,
          isTimingSensitive: true,
        },
      ],
    },
  ],
  steps: [],
  notes: null,
};

// A composite Plan Review payload — one item with a Meal, one with a null
// Meal (missing/archived meal row server-side).
const PLAN_DETAIL_RESPONSE = {
  plan: {
    id: "plan-1",
    name: "Spice It Up",
    status: "this_week",
    startDate: "2026-05-18T00:00:00.000Z",
    endDate: "2026-05-24T00:00:00.000Z",
    revisionId: 3,
    isActiveThisWeek: true,
    userId: "user-1",
    sourceType: "curated",
    prepStatus: "not_prepped" as const,
    optimizationNotes: [],
    breakfastOverrides: "",
    lunchOverrides: "",
    items: [
      {
        id: "item-1",
        mealId: "meal-1",
        positionIndex: 0,
        assignedDayOfWeek: "Monday",
        assignedDate: null,
        servingsOverride: null,
        isBreakfast: false,
        isLunch: false,
        isDinner: true,
        notes: null,
        meal: MEAL_DETAIL,
      },
      {
        id: "item-2",
        mealId: "meal-gone",
        positionIndex: 1,
        assignedDayOfWeek: null,
        assignedDate: "2026-05-20T00:00:00.000Z",
        servingsOverride: 2,
        isBreakfast: false,
        isLunch: true,
        isDinner: false,
        notes: "Use up leftovers.",
        meal: null,
      },
    ],
    macroDailyAverage: {
      caloriesPerDay: 540,
      proteinGPerDay: 38,
      carbsGPerDay: 32,
      fatGPerDay: 24,
    },
  },
};

// ── Harness ─────────────────────────────────────────────────────────────────

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

let nextResponse: () => Response;
let lastUrl: string | null;

beforeEach(() => {
  lastUrl = null;
  nextResponse = () => mockJson(PLAN_LIST_RESPONSE);
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
    lastUrl = url;
    return nextResponse();
  }) as unknown as typeof fetch;
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

// ── Schemas ─────────────────────────────────────────────────────────────────

test("PlanListItemSchema parses both instance and template rows", () => {
  assert.equal(PlanListItemSchema.parse(INSTANCE_ROW).source, "instance");
  const tmpl = PlanListItemSchema.parse(TEMPLATE_ROW);
  assert.equal(tmpl.source, "template");
  assert.equal(tmpl.status, null);
  assert.equal(tmpl.startDate, null);
});

test("PlanListItemSchema rejects an unknown source value", () => {
  const bad = { ...INSTANCE_ROW, source: "catalog" };
  assert.equal(PlanListItemSchema.safeParse(bad).success, false);
});

test("PlanSummarySchema parses the activeThisWeek shape", () => {
  const s = PlanSummarySchema.parse(ACTIVE_SUMMARY);
  assert.equal(s.revisionId, 3);
});

test("PlanDetailSchema parses items with present and null meals", () => {
  const plan = PlanDetailSchema.parse(PLAN_DETAIL_RESPONSE.plan);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].meal?.id, "meal-1");
  assert.equal(plan.items[1].meal, null);
  assert.equal(plan.macroDailyAverage.caloriesPerDay, 540);
});

// ── getPlans ────────────────────────────────────────────────────────────────

test("getPlans parses the discovery-list response", async () => {
  nextResponse = () => mockJson(PLAN_LIST_RESPONSE);
  const res = await getPlans();
  assert.equal(res.plans.length, 2);
  assert.equal(res.activeThisWeek?.id, "plan-1");
  assert.equal(res.nextCursor, null);
});

test("getPlans with no filter omits the query param", async () => {
  await getPlans();
  assert.ok(lastUrl?.endsWith("/plans"), `unexpected url: ${lastUrl}`);
});

test("getPlans serializes a multi-select filter into ?filter=", async () => {
  await getPlans(["my_plans", "featured"]);
  assert.ok(
    lastUrl?.endsWith("/plans?filter=my_plans%2Cfeatured"),
    `unexpected url: ${lastUrl}`,
  );
});

test("getPlans parses a null activeThisWeek", async () => {
  nextResponse = () =>
    mockJson({ plans: [], activeThisWeek: null, nextCursor: null });
  const res = await getPlans();
  assert.equal(res.activeThisWeek, null);
});

test("getPlans propagates a 401 as an UnauthenticatedError", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  await assert.rejects(
    () => getPlans(),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("getPlans rejects a malformed response body", async () => {
  nextResponse = () => mockJson({ plans: [{ id: "x" }], nextCursor: null });
  await assert.rejects(
    () => getPlans(),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── getPlan ─────────────────────────────────────────────────────────────────

test("getPlan unwraps and parses the plan envelope", async () => {
  nextResponse = () => mockJson(PLAN_DETAIL_RESPONSE);
  const plan = await getPlan("plan-1");
  assert.equal(plan.id, "plan-1");
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].meal?.dishes.length, 1);
});

test("getPlan encodes the id into the path", async () => {
  nextResponse = () => mockJson(PLAN_DETAIL_RESPONSE);
  await getPlan("plan/with slash");
  assert.ok(
    lastUrl?.endsWith("/plans/plan%2Fwith%20slash"),
    `unexpected url: ${lastUrl}`,
  );
});

test("getPlan propagates a 404 as an ApiError", async () => {
  nextResponse = () => mockJson({ error: "plan not found" }, 404);
  await assert.rejects(
    () => getPlan("missing"),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("getPlan rejects a malformed response body", async () => {
  const { items: _omit, ...badPlan } = PLAN_DETAIL_RESPONSE.plan;
  nextResponse = () => mockJson({ plan: badPlan });
  await assert.rejects(
    () => getPlan("plan-1"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── usePlans / usePlan ──────────────────────────────────────────────────────

// Drains in-flight React Query fetches inside an act() pass.
async function settle(qc: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc.isFetching() === 0) return;
    }
  });
}

test("usePlans transitions from loading to data", async () => {
  nextResponse = () => mockJson(PLAN_LIST_RESPONSE);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof usePlans> | null = null;
  let sawLoading = false;
  function Probe(): null {
    const q = usePlans(["my_plans"]);
    if (q.isLoading) sawLoading = true;
    latest = q;
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Probe),
      ),
    );
  });

  assert.equal(sawLoading, true);
  await settle(qc);

  assert.equal(latest!.isLoading, false);
  assert.equal(latest!.isError, false);
  assert.equal(latest!.data?.plans.length, 2);
  assert.equal(latest!.data?.activeThisWeek?.id, "plan-1");
  renderer.unmount();
});

// ── WS7-4-B c5 — getTemplate / useTemplate ──────────────────────────────────

const TEMPLATE_DETAIL_RESPONSE = {
  template: {
    id: "tmpl-1",
    userId: "owner-x",
    title: "Family Favorites",
    description: "Crowd-pleasers",
    image: "https://example.com/fam.jpg",
    tags: ["family", "dev"],
    sourceType: "wizard",
    defaultDaysCount: 5,
    optimizationNotes: [{ type: "prep" as const, text: "Batch sauce" }],
    items: [
      {
        id: "ti-1",
        mealId: "meal-1",
        positionIndex: 0,
        assignedDayOfWeek: "Monday",
        isBreakfast: false,
        isLunch: false,
        isDinner: true,
        meal: MEAL_DETAIL,
      },
      {
        id: "ti-2",
        mealId: "meal-gone",
        positionIndex: 1,
        assignedDayOfWeek: null,
        isBreakfast: false,
        isLunch: false,
        isDinner: true,
        meal: null,
      },
    ],
  },
};

test("getTemplate unwraps and parses the template envelope", async () => {
  nextResponse = () => mockJson(TEMPLATE_DETAIL_RESPONSE);
  const t = await getTemplate("tmpl-1");
  assert.equal(t.id, "tmpl-1");
  assert.equal(t.userId, "owner-x");
  assert.equal(t.defaultDaysCount, 5);
  assert.equal(t.items.length, 2);
  assert.equal(t.items[0].meal?.id, "meal-1");
  assert.equal(t.items[1].meal, null);
  assert.equal(t.optimizationNotes[0].text, "Batch sauce");
});

test("getTemplate propagates a 404 as an ApiError", async () => {
  nextResponse = () => mockJson({ error: "template not found" }, 404);
  await assert.rejects(
    () => getTemplate("missing"),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("getTemplate rejects a malformed response body", async () => {
  // strip `userId` so the schema parse fails
  const { userId: _omit, ...badTemplate } = TEMPLATE_DETAIL_RESPONSE.template;
  nextResponse = () => mockJson({ template: badTemplate });
  await assert.rejects(
    () => getTemplate("tmpl-1"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

test("useTemplate POSTs and returns instanceId", async () => {
  let capturedMethod: string | null = null;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { method?: string },
  ) => {
    lastUrl = url;
    capturedMethod = init?.method ?? "GET";
    return mockJson({ instance: { id: "new-instance-7", revisionId: 1 } }, 201);
  }) as unknown as typeof fetch;
  const out = await useTemplate("tmpl-1");
  assert.equal(out.instanceId, "new-instance-7");
  assert.equal(capturedMethod, "POST");
  assert.ok(lastUrl?.endsWith("/plans/use-template/tmpl-1"), `unexpected url: ${lastUrl}`);
});

test("useTemplate propagates a 429 as an ApiError", async () => {
  nextResponse = () => mockJson({ error: "rate limited" }, 429);
  await assert.rejects(
    () => useTemplate("tmpl-1"),
    (err: unknown) => err instanceof ApiError && err.status === 429,
  );
});

test("usePlan is disabled for an empty id", async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof usePlan> | null = null;
  function Probe(): null {
    latest = usePlan("");
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Probe),
      ),
    );
  });

  await settle(qc);

  // enabled:false — the query never fetches; it stays idle with no data.
  assert.equal(latest!.fetchStatus, "idle");
  assert.equal(latest!.data, undefined);
  renderer.unmount();
});

// ── WS7-4-C c5/c6 — patchPlan ───────────────────────────────────────────────

test("patchPlan PATCHes /plans/:id and returns the parsed envelope", async () => {
  let capturedMethod: string | null = null;
  let capturedBody: string | null = null;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { method?: string; body?: string },
  ) => {
    lastUrl = url;
    capturedMethod = init?.method ?? "GET";
    capturedBody = init?.body ?? null;
    return mockJson({ instance: { id: "plan-1", revisionId: 5 }, macrosStale: false });
  }) as unknown as typeof fetch;

  const { patchPlan } = await import("../plans");
  const out = await patchPlan("plan-1", { name: "Renamed" });
  assert.equal(out.instance.id, "plan-1");
  assert.equal(out.instance.revisionId, 5);
  assert.equal(out.macrosStale, false);
  assert.equal(capturedMethod, "PATCH");
  assert.ok(lastUrl?.endsWith("/plans/plan-1"), `unexpected url: ${lastUrl}`);
  assert.equal(capturedBody, JSON.stringify({ name: "Renamed" }));
});

test("patchPlan throws ApiSchemaError when the response shape is malformed", async () => {
  nextResponse = () =>
    mockJson({ instance: { id: "plan-1" /* missing revisionId */ } });
  const { patchPlan } = await import("../plans");
  await assert.rejects(
    () => patchPlan("plan-1", { name: "X" }),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

test("patchPlan propagates a 404 as an ApiError", async () => {
  nextResponse = () => mockJson({ error: "plan not found" }, 404);
  const { patchPlan } = await import("../plans");
  await assert.rejects(
    () => patchPlan("ghost", { name: "X" }),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

// patchPlan covers updatePlanDateRange too (single helper, different body
// subset). These tests assert the wire shape for the date-range case.

test("patchPlan with startDate-only body sends just startDate (Q-P1-2 optional fields)", async () => {
  let capturedBody: string | null = null;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { method?: string; body?: string },
  ) => {
    lastUrl = url;
    capturedBody = init?.body ?? null;
    return mockJson({ instance: { id: "plan-1", revisionId: 2 } });
  }) as unknown as typeof fetch;

  const { patchPlan } = await import("../plans");
  const out = await patchPlan("plan-1", { startDate: "2026-06-01T00:00:00.000Z" });
  assert.equal(out.instance.revisionId, 2);
  assert.equal(capturedBody, JSON.stringify({ startDate: "2026-06-01T00:00:00.000Z" }));
});

test("patchPlan with both startDate and endDate sends both fields", async () => {
  let capturedBody: string | null = null;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { method?: string; body?: string },
  ) => {
    lastUrl = url;
    capturedBody = init?.body ?? null;
    return mockJson({ instance: { id: "plan-1", revisionId: 3 } });
  }) as unknown as typeof fetch;

  const { patchPlan } = await import("../plans");
  await patchPlan("plan-1", {
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-06-07T00:00:00.000Z",
  });
  assert.equal(
    capturedBody,
    JSON.stringify({
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: "2026-06-07T00:00:00.000Z",
    }),
  );
});

test("patchPlan date-range body propagates a 404 as an ApiError", async () => {
  nextResponse = () => mockJson({ error: "plan not found" }, 404);
  const { patchPlan } = await import("../plans");
  await assert.rejects(
    () => patchPlan("ghost", { startDate: "2026-06-01T00:00:00.000Z" }),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});
