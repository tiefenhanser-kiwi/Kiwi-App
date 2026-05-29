// WS7-5b-mobile Block A — tests for lib/api/wizard.ts expand / save /
// activate wrappers. Mirrors the fetch-mock + SecureStore harness used in
// plans.test.ts so the suite stays cohesive.
//
// Pins the load-bearing contracts:
//   - expandWizardCandidate POSTs to /wizard/expand, parses { draft, expanded },
//     and threads through an AbortSignal so the §5.4 cancel button works.
//   - saveWizardDraft / activateWizardDraft POST to the right URL and parse
//     the shared { instance: { id, revisionId } } envelope.
//   - 404 on the saved draft id (the dead-tap regression) surfaces as an
//     ApiError, not a generic crash, so the Plan Details screen can recover.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import {
  activateWizardDraft,
  expandWizardCandidate,
  saveWizardDraft,
  WizardExpandedPlanSchema,
  type WizardExpandRequest,
} from "../wizard";
import { ApiError, ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

const EXPAND_REQUEST: WizardExpandRequest = {
  candidate: {
    id: "cand-1",
    title: "Cozy Tuscan Week",
    tags: ["italian", "comforting"],
    whyBullets: ["Hearty dinners", "One-pot friendly"],
    mealTitles: ["Ribollita", "Pasta e fagioli", "Risotto Milanese"],
    dailyMacros: {
      calories: 720,
      proteinG: 38,
      carbsG: 88,
      fatG: 24,
    },
  },
  candidateContext: {
    planDurationDays: 5,
    householdSize: 4,
    wantsLeftovers: true,
    allergiesAndAvoidances: [],
    eatingStyles: [],
    difficulty: "medium",
  },
};

const EXPANDED_PLAN = {
  candidateId: "cand-1",
  title: "Cozy Tuscan Week",
  tags: ["italian", "comforting"],
  whyBullets: ["Hearty dinners", "One-pot friendly"],
  meals: [
    {
      title: "Ribollita",
      cuisineType: "Italian",
      estimatedTimeMinutes: 45,
      difficulty: "medium",
      servings: 4,
      dishes: [
        {
          title: "Ribollita",
          role: "main",
          positionIndex: 0,
          ingredients: [
            {
              name: "Cannellini beans",
              quantity: 2,
              unit: "cups",
            },
            {
              name: "Tuscan kale",
              quantity: 1,
              unit: "bunch",
              preparationNote: "stems removed",
            },
          ],
          steps: ["Saute the soffritto.", "Add stock and simmer."],
          macros: {
            caloriesPerServing: 420,
            proteinGPerServing: 22,
            carbsGPerServing: 56,
            fatGPerServing: 12,
          },
        },
      ],
    },
  ],
};

const EXPAND_RESPONSE = {
  draft: {
    id: "draft-abc-123",
    createdAt: "2026-05-29T12:00:00.000Z",
  },
  expanded: EXPANDED_PLAN,
};

// ── Harness ─────────────────────────────────────────────────────────────────

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

let nextResponse: (init?: { method?: string; signal?: AbortSignal }) => Response;
let lastUrl: string | null;
let lastMethod: string | null;
let lastSignal: AbortSignal | null;
let lastBody: string | null;

beforeEach(() => {
  lastUrl = null;
  lastMethod = null;
  lastSignal = null;
  lastBody = null;
  nextResponse = () => mockJson(EXPAND_RESPONSE);
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { method?: string; signal?: AbortSignal; body?: string },
  ) => {
    lastUrl = url;
    lastMethod = init?.method ?? "GET";
    lastSignal = init?.signal ?? null;
    lastBody = init?.body ?? null;
    return nextResponse(init);
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

// ── WizardExpandedPlanSchema ────────────────────────────────────────────────

test("WizardExpandedPlanSchema parses a minimal expanded plan", () => {
  const parsed = WizardExpandedPlanSchema.parse(EXPANDED_PLAN);
  assert.equal(parsed.candidateId, "cand-1");
  assert.equal(parsed.meals.length, 1);
  assert.equal(parsed.meals[0].dishes[0].macros?.caloriesPerServing, 420);
});

test("WizardExpandedPlanSchema accepts a failed-macros dish", () => {
  const withFailedMacros = {
    ...EXPANDED_PLAN,
    meals: [
      {
        ...EXPANDED_PLAN.meals[0],
        dishes: [
          {
            ...EXPANDED_PLAN.meals[0].dishes[0],
            macros: {
              caloriesPerServing: 0,
              proteinGPerServing: 0,
              carbsGPerServing: 0,
              fatGPerServing: 0,
              failed: true,
            },
          },
        ],
      },
    ],
  };
  const parsed = WizardExpandedPlanSchema.parse(withFailedMacros);
  assert.equal(parsed.meals[0].dishes[0].macros?.failed, true);
});

// ── expandWizardCandidate ───────────────────────────────────────────────────

test("expandWizardCandidate POSTs to /wizard/expand and parses the envelope", async () => {
  const result = await expandWizardCandidate(EXPAND_REQUEST);
  assert.equal(lastMethod, "POST");
  assert.ok(lastUrl?.endsWith("/wizard/expand"), `unexpected url: ${lastUrl}`);
  assert.equal(result.draft.id, "draft-abc-123");
  assert.equal(result.expanded.title, "Cozy Tuscan Week");
  assert.equal(result.expanded.meals[0].dishes[0].title, "Ribollita");
});

test("expandWizardCandidate forwards an AbortSignal to fetch (cancel from §5.4)", async () => {
  const controller = new AbortController();
  await expandWizardCandidate(EXPAND_REQUEST, { signal: controller.signal });
  assert.equal(lastSignal, controller.signal);
});

test("expandWizardCandidate sends the candidate + candidateContext as JSON body", async () => {
  await expandWizardCandidate(EXPAND_REQUEST);
  assert.ok(lastBody, "expected a request body");
  const parsed = JSON.parse(lastBody!);
  assert.equal(parsed.candidate.id, "cand-1");
  assert.equal(parsed.candidateContext.planDurationDays, 5);
  assert.equal(parsed.candidateContext.difficulty, "medium");
});

test("expandWizardCandidate propagates a 502 ai_failed as an ApiError", async () => {
  nextResponse = () =>
    mockJson({ error: "Kiwi got distracted", reason: "ai_failed" }, 502);
  await assert.rejects(
    () => expandWizardCandidate(EXPAND_REQUEST),
    (err: unknown) => err instanceof ApiError && err.status === 502,
  );
});

test("expandWizardCandidate propagates a 401 as UnauthenticatedError", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  await assert.rejects(
    () => expandWizardCandidate(EXPAND_REQUEST),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("expandWizardCandidate rejects a malformed response body", async () => {
  // Strip `meals` from expanded so the schema parse fails.
  const { meals: _omit, ...badExpanded } = EXPANDED_PLAN;
  nextResponse = () =>
    mockJson({
      draft: EXPAND_RESPONSE.draft,
      expanded: badExpanded,
    });
  await assert.rejects(
    () => expandWizardCandidate(EXPAND_REQUEST),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── saveWizardDraft ─────────────────────────────────────────────────────────

test("saveWizardDraft POSTs to /wizard/drafts/:id/save and returns instance", async () => {
  nextResponse = () =>
    mockJson({ instance: { id: "plan-saved-1", revisionId: 1 } }, 201);
  const result = await saveWizardDraft("draft-abc-123");
  assert.equal(lastMethod, "POST");
  assert.ok(
    lastUrl?.endsWith("/wizard/drafts/draft-abc-123/save"),
    `unexpected url: ${lastUrl}`,
  );
  assert.equal(result.instance.id, "plan-saved-1");
  assert.equal(result.instance.revisionId, 1);
});

test("saveWizardDraft URL-encodes the draft id", async () => {
  nextResponse = () =>
    mockJson({ instance: { id: "plan-saved-2", revisionId: 1 } }, 201);
  await saveWizardDraft("draft id/with/slashes");
  assert.ok(
    lastUrl?.endsWith("/wizard/drafts/draft%20id%2Fwith%2Fslashes/save"),
    `unexpected url: ${lastUrl}`,
  );
});

test("saveWizardDraft propagates a 404 as ApiError (already-saved / not owned)", async () => {
  nextResponse = () => mockJson({ error: "draft not found" }, 404);
  await assert.rejects(
    () => saveWizardDraft("dead-draft"),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("saveWizardDraft propagates a 422 malformed-draft as ApiError", async () => {
  nextResponse = () =>
    mockJson({ error: "draft malformed", reason: "schema_mismatch" }, 422);
  await assert.rejects(
    () => saveWizardDraft("malformed-draft"),
    (err: unknown) => err instanceof ApiError && err.status === 422,
  );
});

// ── activateWizardDraft ─────────────────────────────────────────────────────

test("activateWizardDraft POSTs to /wizard/drafts/:id/activate and returns instance", async () => {
  nextResponse = () =>
    mockJson({ instance: { id: "plan-activated-1", revisionId: 2 } }, 201);
  const result = await activateWizardDraft("draft-abc-123");
  assert.equal(lastMethod, "POST");
  assert.ok(
    lastUrl?.endsWith("/wizard/drafts/draft-abc-123/activate"),
    `unexpected url: ${lastUrl}`,
  );
  assert.equal(result.instance.id, "plan-activated-1");
  // PRE bumps revisionId from 1 (expand persist) to 2 (activate).
  assert.equal(result.instance.revisionId, 2);
});

// WS7-5b-mobile Block A — the load-bearing post-save dead-tap regression:
// once /save has succeeded, the draft id is dead. A subsequent /activate on
// the same id MUST be observed by the caller as a 404 ApiError, not a
// generic crash, so the Plan Details screen can route around it (via the
// CTA decider's patch-plan branch). The decider test below pins the
// repurpose; this test pins the 404 surface that makes the repurpose
// necessary in the first place.
test("activateWizardDraft on a saved draft surfaces 404 as ApiError (dead-tap regression)", async () => {
  nextResponse = () => mockJson({ error: "draft not found" }, 404);
  await assert.rejects(
    () => activateWizardDraft("already-saved-draft"),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});
