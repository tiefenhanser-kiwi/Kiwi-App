// WS7-3 Block C1 — tests for lib/api/plans.ts.
// C1.1 covers the getters + schemas: getPlans / getPlan fetch-mocked
// round-trips, the ?filter= query construction, and 404 / 401 / schema-
// mismatch error propagation. The usePlans / usePlan hook tests are appended
// in C1.2. Harness mirrors meals.test.ts (fetch mock + SecureStore stub).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import {
  getPlan,
  getPlans,
  PlanDetailSchema,
  PlanListItemSchema,
  PlanSummarySchema,
} from "../plans";
import { ApiError, ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";

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
