// WS7-8b Block 1 — tests for lib/api/cooking.ts (the WS7-8a B3 prep-step
// completion client). Covers the three helpers' wire shape (method + URL +
// request body reaching the wire) and round-trip parse of the server response
// builders in BOTH directions. Harness mirrors plans.test.ts (fetch mock +
// SecureStore token stub).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import {
  checkPrepStep,
  uncheckPrepStep,
  getPrepWeekCompletions,
  getCookingSequence,
  getPrepWeek,
} from "../cooking";
import { ApiError, ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures (verbatim server response builders) ──────────────────────────────

// GET response — cooking.ts:481-494. Distinct perMeal values + all three status
// fields differing (derived vs effective) so the round-trip can't be faked by a
// collapse.
const COMPLETIONS_RESPONSE = {
  completions: [
    { stepKey: "produce_wash#carrot-1", checkedAt: "2026-06-18T09:00:00.000Z" },
    { stepKey: "seasonings_dry#dish#11111111-1111-4111-8111-111111111111", checkedAt: "2026-06-18T09:05:00.000Z" },
  ],
  perMeal: { "meal-1": true, "meal-2": false },
  derivedPrepStatus: "partial" as const,
  prepStatus: "prepped" as const, // effective (manual pin) ≠ derived — proves both surface
  prepStatusIsManual: true,
};

// ── Harness ───────────────────────────────────────────────────────────────────

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

let nextResponse: () => Response;
let lastUrl: string | null;
let lastMethod: string | null;
let lastBody: string | null;

beforeEach(() => {
  lastUrl = null;
  lastMethod = null;
  lastBody = null;
  nextResponse = () => mockJson(COMPLETIONS_RESPONSE);
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { method?: string; body?: string },
  ) => {
    lastUrl = url;
    lastMethod = (init?.method ?? "GET").toUpperCase();
    lastBody = typeof init?.body === "string" ? init.body : null;
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

// ── checkPrepStep (PUT / upsert) ──────────────────────────────────────────────

test("checkPrepStep PUTs { stepKey } to the completions path and parses checked:true", async () => {
  nextResponse = () => mockJson({ stepKey: "produce_wash#carrot-1", checked: true });
  const res = await checkPrepStep("plan-1", "produce_wash#carrot-1");

  assert.equal(lastMethod, "PUT");
  assert.ok(
    lastUrl?.endsWith("/plans/plan-1/prep-week/completions"),
    `unexpected url: ${lastUrl}`,
  );
  assert.equal(lastBody, JSON.stringify({ stepKey: "produce_wash#carrot-1" }));
  assert.equal(res.stepKey, "produce_wash#carrot-1");
  assert.equal(res.checked, true);
});

test("checkPrepStep encodes the planId path segment", async () => {
  nextResponse = () => mockJson({ stepKey: "k", checked: true });
  await checkPrepStep("plan/with space", "k");
  assert.ok(
    lastUrl?.includes("/plans/plan%2Fwith%20space/prep-week/completions"),
    `unexpected url: ${lastUrl}`,
  );
});

// ── uncheckPrepStep (DELETE / delete) ─────────────────────────────────────────

// Pins the WS7-8b B1 instruction (2): the uncheck stepKey travels in the DELETE
// REQUEST BODY and the apiClient wrapper actually transmits it (no method-based
// body stripping). Verified against client.ts:138-158.
test("uncheckPrepStep sends { stepKey } in the DELETE body to the wire", async () => {
  nextResponse = () =>
    mockJson({ stepKey: "seasonings_dry#dish#11111111-1111-4111-8111-111111111111", checked: false });
  const res = await uncheckPrepStep("plan-1", "seasonings_dry#dish#11111111-1111-4111-8111-111111111111");

  assert.equal(lastMethod, "DELETE");
  assert.ok(
    lastUrl?.endsWith("/plans/plan-1/prep-week/completions"),
    `unexpected url: ${lastUrl}`,
  );
  // The body must reach the wire — this is the regression pin for DELETE bodies.
  assert.equal(lastBody, JSON.stringify({ stepKey: "seasonings_dry#dish#11111111-1111-4111-8111-111111111111" }));
  assert.equal(res.stepKey, "seasonings_dry#dish#11111111-1111-4111-8111-111111111111");
  assert.equal(res.checked, false);
});

// ── getPrepWeekCompletions (GET / resume) ─────────────────────────────────────

test("getPrepWeekCompletions GETs the completions path and round-trips the full shape", async () => {
  const res = await getPrepWeekCompletions("plan-1");

  assert.equal(lastMethod, "GET");
  assert.ok(
    lastUrl?.endsWith("/plans/plan-1/prep-week/completions"),
    `unexpected url: ${lastUrl}`,
  );
  assert.equal(lastBody, null);

  // Rows.
  assert.equal(res.completions.length, 2);
  assert.equal(res.completions[0].stepKey, "produce_wash#carrot-1");
  assert.equal(res.completions[0].checkedAt, "2026-06-18T09:00:00.000Z");

  // perMeal map — keyed by mealId.
  assert.equal(res.perMeal["meal-1"], true);
  assert.equal(res.perMeal["meal-2"], false);

  // All THREE status fields surface, not collapsed (B1 ruling): derived and
  // effective differ here, and the manual flag is carried through.
  assert.equal(res.derivedPrepStatus, "partial");
  assert.equal(res.prepStatus, "prepped");
  assert.equal(res.prepStatusIsManual, true);
});

test("getPrepWeekCompletions parses an empty resume state (no rows, all-false perMeal)", async () => {
  nextResponse = () =>
    mockJson({
      completions: [],
      perMeal: {},
      derivedPrepStatus: "not_prepped",
      prepStatus: "not_prepped",
      prepStatusIsManual: false,
    });
  const res = await getPrepWeekCompletions("plan-1");
  assert.equal(res.completions.length, 0);
  assert.deepEqual(res.perMeal, {});
  assert.equal(res.prepStatus, "not_prepped");
});

// ── Error propagation ─────────────────────────────────────────────────────────

test("getPrepWeekCompletions propagates ownership-as-404 as an ApiError", async () => {
  nextResponse = () => mockJson({ error: "plan not found" }, 404);
  await assert.rejects(
    () => getPrepWeekCompletions("ghost"),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("checkPrepStep propagates a 401 as an UnauthenticatedError", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  await assert.rejects(
    () => checkPrepStep("plan-1", "k"),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("getPrepWeekCompletions rejects a malformed response (bad status enum)", async () => {
  nextResponse = () =>
    mockJson({
      completions: [],
      perMeal: {},
      derivedPrepStatus: "in_progress", // not in the PrepStatus enum
      prepStatus: "not_prepped",
      prepStatusIsManual: false,
    });
  await assert.rejects(
    () => getPrepWeekCompletions("plan-1"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

test("getPrepWeekCompletions rejects a non-boolean perMeal value", async () => {
  nextResponse = () =>
    mockJson({
      completions: [],
      perMeal: { "meal-1": "yes" }, // must be boolean
      derivedPrepStatus: "not_prepped",
      prepStatus: "not_prepped",
      prepStatusIsManual: false,
    });
  await assert.rejects(
    () => getPrepWeekCompletions("plan-1"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── getCookingSequence (POST /meals/:mealId/cooking-sequence) ─────────────────
// WS7-8b Build Block 2B. Verbatim mirror of the server wire envelope
// (cooking.ts:128-133) + SequencedStepSchema. The fixture carries a cue
// (`reason`) on one step and omits it on another — proving the optional cue
// round-trips both present and absent.

const SEQUENCE_RESPONSE = {
  sequence: [
    {
      dishId: "dish-a",
      originalStepIndex: 0,
      sequenceIndex: 0,
      startsAtMinutes: 0,
      reason: "Lead with the protein sear.",
    },
    {
      dishId: "dish-b",
      originalStepIndex: 0,
      sequenceIndex: 1,
      startsAtMinutes: 1,
      // no reason — the optional cue must round-trip as absent
    },
  ],
  totalEstimatedMinutes: 12,
  dishCount: 2,
  usedAI: true,
};

test("getCookingSequence POSTs to the path with NO body and round-trips the envelope", async () => {
  nextResponse = () => mockJson(SEQUENCE_RESPONSE);
  const res = await getCookingSequence("meal-multi");

  assert.equal(lastMethod, "POST");
  assert.ok(
    lastUrl?.endsWith("/meals/meal-multi/cooking-sequence"),
    `unexpected url: ${lastUrl}`,
  );
  // mealId travels in the PATH — the server loads step data itself, no body.
  assert.equal(lastBody, null);

  assert.equal(res.dishCount, 2);
  assert.equal(res.usedAI, true);
  assert.equal(res.totalEstimatedMinutes, 12);
  assert.equal(res.sequence.length, 2);
  assert.equal(res.sequence[0].reason, "Lead with the protein sear.");
  assert.equal(res.sequence[0].sequenceIndex, 0);
  assert.equal(res.sequence[1].reason, undefined); // optional cue absent
});

test("getCookingSequence encodes the mealId path segment", async () => {
  nextResponse = () => mockJson(SEQUENCE_RESPONSE);
  await getCookingSequence("meal/with space");
  assert.ok(
    lastUrl?.includes("/meals/meal%2Fwith%20space/cooking-sequence"),
    `unexpected url: ${lastUrl}`,
  );
});

test("getCookingSequence propagates a 502 AI failure as an ApiError (caller degrades)", async () => {
  nextResponse = () =>
    mockJson({ error: "Kiwi got distracted. Try again?", reason: "validation_failed" }, 502);
  await assert.rejects(
    () => getCookingSequence("meal-multi"),
    (err: unknown) => err instanceof ApiError && err.status === 502,
  );
});

test("getCookingSequence propagates ownership-as-404 as an ApiError", async () => {
  nextResponse = () => mockJson({ error: "meal not found" }, 404);
  await assert.rejects(
    () => getCookingSequence("ghost"),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("getCookingSequence rejects a malformed step (non-integer originalStepIndex)", async () => {
  nextResponse = () =>
    mockJson({
      sequence: [
        { dishId: "d", originalStepIndex: 0.5, sequenceIndex: 0, startsAtMinutes: 0 },
      ],
      totalEstimatedMinutes: 5,
      dishCount: 2,
      usedAI: true,
    });
  await assert.rejects(
    () => getCookingSequence("meal-multi"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

test("getCookingSequence rejects a missing envelope field (no usedAI)", async () => {
  nextResponse = () =>
    mockJson({
      sequence: [],
      totalEstimatedMinutes: 5,
      dishCount: 2,
      // usedAI omitted
    });
  await assert.rejects(
    () => getCookingSequence("meal-multi"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── getPrepWeek (POST /plans/:planId/prep-week — GENERATE) ────────────────────
// WS7-8b Block 4 (Block 1). §27 two-direction wire mirror: parse a representative
// cache-HIT envelope (no metadata) AND a cache-MISS envelope (metadata.latencyMs
// present) — both must satisfy the same schema. 402 surfaces as a typed
// non-fatal outcome; every other failure propagates as a throw.

// Two real plan mealIds (uuid — the result schema mirrors the server's .uuid()).
const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";

// A faithful 4-phase result in the fixed order. seasonings/sauces are emitted
// empty (skippable); produce + proteins carry one combined step each. The
// proteins step exercises the optional storageNote + skipSuggested round-trip.
const PREP_RESULT = {
  totalEstimatedMinutes: 45,
  phases: [
    { phase: "seasonings_dry", title: "Seasonings & dry", skippable: true, steps: [] },
    { phase: "sauces_marinades", title: "Sauces & marinades", skippable: true, steps: [] },
    {
      phase: "produce",
      title: "Produce",
      skippable: false,
      steps: [
        {
          number: 1,
          stepKey: `produce#${M1}`,
          title: "Dice onions",
          instructions: "Dice 2 onions for the week.",
          estimatedMinutes: 6,
          contributesToMealIds: [M1, M2],
        },
      ],
    },
    {
      phase: "proteins",
      title: "Proteins",
      skippable: false,
      steps: [
        {
          number: 2,
          stepKey: `proteins#${M1}`,
          title: "Trim chicken",
          instructions: "Trim 2 lb chicken thighs.",
          estimatedMinutes: 10,
          contributesToMealIds: [M1],
          storageNote: "Airtight, 2 days max",
          skipSuggested: true,
        },
      ],
    },
  ],
};

const HIT_ENVELOPE = {
  cacheHit: true,
  result: PREP_RESULT,
  planRevisionId: 3,
  generatedAt: "2026-06-20T08:00:00.000Z",
  promptVersion: 2,
  // NO metadata — the cache-hit branch omits it.
};

const MISS_ENVELOPE = {
  cacheHit: false,
  result: PREP_RESULT,
  planRevisionId: 4,
  generatedAt: "2026-06-20T08:05:00.000Z",
  promptVersion: 2,
  metadata: { latencyMs: 1234 }, // present only on the miss branch
};

test("getPrepWeek POSTs to the prep-week path with NO body and parses the cache-HIT envelope", async () => {
  nextResponse = () => mockJson(HIT_ENVELOPE);
  const out = await getPrepWeek("plan-1");

  assert.equal(lastMethod, "POST");
  assert.ok(
    lastUrl?.endsWith("/plans/plan-1/prep-week"),
    `unexpected url: ${lastUrl}`,
  );
  assert.equal(lastBody, null); // planId is in the path; no request body

  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return; // narrow
  assert.equal(out.envelope.cacheHit, true);
  assert.equal(out.envelope.metadata, undefined); // hit branch carries none
  assert.equal(out.envelope.planRevisionId, 3);
  assert.equal(out.envelope.result.phases.length, 4);
  assert.deepEqual(
    out.envelope.result.phases.map((p) => p.phase),
    ["seasonings_dry", "sauces_marinades", "produce", "proteins"],
  );
  // optional step fields round-trip
  const protein = out.envelope.result.phases[3].steps[0];
  assert.equal(protein.skipSuggested, true);
  assert.equal(protein.storageNote, "Airtight, 2 days max");
});

test("getPrepWeek parses the cache-MISS envelope (metadata.latencyMs present)", async () => {
  nextResponse = () => mockJson(MISS_ENVELOPE);
  const out = await getPrepWeek("plan-1");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.envelope.cacheHit, false);
  assert.equal(out.envelope.metadata?.latencyMs, 1234);
});

test("getPrepWeek surfaces a 402 as a typed upgrade_required outcome (non-fatal, not thrown)", async () => {
  nextResponse = () =>
    mockJson(
      { error: "upgrade required", reason: "Prep the Week is a Premium feature" },
      402,
    );
  // Must NOT throw — the gate is recoverable, never a hard paywall.
  const out = await getPrepWeek("plan-1");
  assert.equal(out.kind, "upgrade_required");
  if (out.kind !== "upgrade_required") return;
  assert.equal(out.message, "upgrade required"); // userFacingMessage ← body.error
});

test("getPrepWeek propagates a 404 (missing/non-owned) as an ApiError — hard failure", async () => {
  nextResponse = () => mockJson({ error: "plan not found" }, 404);
  await assert.rejects(
    () => getPrepWeek("ghost"),
    (err: unknown) => err instanceof ApiError && err.status === 404,
  );
});

test("getPrepWeek propagates a 502 AI/assembly failure as an ApiError", async () => {
  nextResponse = () =>
    mockJson({ error: "Kiwi got distracted. Try again?", reason: "assembly_invalid" }, 502);
  await assert.rejects(
    () => getPrepWeek("plan-1"),
    (err: unknown) => err instanceof ApiError && err.status === 502,
  );
});

test("getPrepWeek rejects a malformed result — phases out of the fixed order (§27 both-direction)", async () => {
  // Swap produce ahead of sauces_marinades — the superRefine must reject it,
  // proving the mobile mirror enforces the same order the server does.
  const reordered = {
    ...HIT_ENVELOPE,
    result: {
      ...PREP_RESULT,
      phases: [
        PREP_RESULT.phases[0],
        PREP_RESULT.phases[2], // produce where sauces_marinades must be
        PREP_RESULT.phases[1],
        PREP_RESULT.phases[3],
      ],
    },
  };
  nextResponse = () => mockJson(reordered);
  await assert.rejects(
    () => getPrepWeek("plan-1"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

test("getPrepWeek rejects a result with the wrong phase count (not 4)", async () => {
  const threePhase = {
    ...HIT_ENVELOPE,
    result: { ...PREP_RESULT, phases: PREP_RESULT.phases.slice(0, 3) },
  };
  nextResponse = () => mockJson(threePhase);
  await assert.rejects(
    () => getPrepWeek("plan-1"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

test("getPrepWeek encodes the planId path segment", async () => {
  nextResponse = () => mockJson(HIT_ENVELOPE);
  await getPrepWeek("plan/with space");
  assert.ok(
    lastUrl?.includes("/plans/plan%2Fwith%20space/prep-week"),
    `unexpected url: ${lastUrl}`,
  );
});
