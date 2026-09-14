// D-WS9-241 D — server copy wins for the three spend-guard reasons.
//
// The server's spend guard (D-WS9-240) refuses an AI call with `reason` ∈
// { spend_cap_user, spend_cap_global, ai_disabled } and answers 429 / 503 —
// NOT 502 — with its own copy in the body. Every client surface that used to
// substitute a canned "AI hiccup" line now renders that copy VERBATIM, keyed
// on `reason`. Two guards against the ruling over-reaching: a 429/503 WITHOUT
// a guard reason still gets local copy, and a guard reason with no copy in the
// body falls through to local copy too.
//
// Covered here (the lib surfaces; the two component surfaces have their own
// render tests — PrepWeekScreenSpendGuard.test.ts, SwapMealSheet.test.ts):
//   - lib/api/errors.ts        spendGuardRefusal / spendGuardRefusalFromError
//   - lib/api/grocery.ts       generateGroceryListForPlan → `spend_guard`
//   - lib/groceryHandoff.ts    resolveGenerateResult renders result.message
//   - lib/api/recipeImport.ts  the non-2xx branch of all three imports
//   - lib/builder/askKiwiSubmit.ts + askKiwiDishSubmit.ts
//
// Body shapes follow the server: `{ error: <copy>, reason }` for builder /
// wizard / cooking / meals routes, `{ error: "ai_failed", message: <copy>,
// reason }` for the grocery routes (the copy is in `message` there), and the
// 200 `{ success:false, reason, userFacingMessage }` envelope for imports.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import {
  ApiError,
  ApiNetworkError,
  UpgradeRequiredError,
  spendGuardRefusal,
  spendGuardRefusalFromError,
} from "../errors";
import { generateGroceryListForPlan } from "../grocery";
import {
  importRecipeFromText,
  importRecipeFromUrl,
} from "../recipeImport";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";
import { resolveGenerateResult } from "@/lib/groceryHandoff";
import {
  ASK_KIWI_AI_FAILED_MESSAGE,
  runAskKiwiSubmit,
} from "@/lib/builder/askKiwiSubmit";
import {
  ASK_KIWI_DISH_AI_FAILED_MESSAGE,
  runAskKiwiDishSubmit,
} from "@/lib/builder/askKiwiDishSubmit";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// The server's copy (artifacts/api-server/src/lib/ai/errors.ts), transcribed
// so a drift there is visible here — but the assertion is "verbatim", so any
// string the server sends is what must render.
const SPEND_CAP_USER_COPY =
  "You've reached today's planning limit — Kiwi will be ready to plan again tomorrow.";
const AI_UNAVAILABLE_COPY =
  "Kiwi is taking a short break. Please try again in a little while.";

const GUARD_CASES = [
  { reason: "spend_cap_user", status: 429, copy: SPEND_CAP_USER_COPY },
  { reason: "spend_cap_global", status: 503, copy: AI_UNAVAILABLE_COPY },
  { reason: "ai_disabled", status: 503, copy: AI_UNAVAILABLE_COPY },
] as const;

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function apiError(status: number, body: unknown): ApiError {
  return new ApiError(`Request failed (${status})`, { status, body });
}

// ── Harness (fetch-backed surfaces) ───────────────────────────────────────

let nextResponse: () => Response;

beforeEach(() => {
  nextResponse = () => mockJson({});
  (globalThis as { fetch: typeof fetch }).fetch = (async () =>
    nextResponse()) as unknown as typeof fetch;
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

// ── errors.ts — the helper ────────────────────────────────────────────────

test("spendGuardRefusal: each of the three reasons is read off the body with its copy", () => {
  for (const c of GUARD_CASES) {
    assert.deepEqual(spendGuardRefusal({ error: c.copy, reason: c.reason }), {
      reason: c.reason,
      message: c.copy,
    });
  }
});

test("spendGuardRefusal: the grocery shape carries its copy in `message`, not the `error` code", () => {
  assert.deepEqual(
    spendGuardRefusal({
      error: "ai_failed",
      message: SPEND_CAP_USER_COPY,
      reason: "spend_cap_user",
    }),
    { reason: "spend_cap_user", message: SPEND_CAP_USER_COPY },
  );
});

test("spendGuardRefusal: the import envelope shape carries its copy in `userFacingMessage`", () => {
  assert.deepEqual(
    spendGuardRefusal({
      success: false,
      reason: "ai_disabled",
      userFacingMessage: AI_UNAVAILABLE_COPY,
      suggestedAction: "try_image_import",
    }),
    { reason: "ai_disabled", message: AI_UNAVAILABLE_COPY },
  );
});

test("spendGuardRefusal: a non-guard reason, a missing reason, or a non-object body is null", () => {
  assert.equal(spendGuardRefusal({ error: "Kiwi got distracted.", reason: "sdk_error" }), null);
  assert.equal(spendGuardRefusal({ error: "Kiwi got distracted.", reason: "rate_limited" }), null);
  assert.equal(spendGuardRefusal({ error: "Too many requests" }), null);
  assert.equal(spendGuardRefusal(undefined), null);
  assert.equal(spendGuardRefusal(null), null);
  assert.equal(spendGuardRefusal("spend_cap_user"), null);
});

test("spendGuardRefusal: a guard reason with NO usable copy is null — local copy, not an empty line", () => {
  assert.equal(spendGuardRefusal({ reason: "spend_cap_user" }), null);
  assert.equal(spendGuardRefusal({ reason: "spend_cap_user", error: "   " }), null);
  assert.equal(spendGuardRefusal({ reason: "spend_cap_user", error: 42 }), null);
});

test("spendGuardRefusalFromError: only an ApiError carries a body", () => {
  assert.deepEqual(
    spendGuardRefusalFromError(
      apiError(429, { error: SPEND_CAP_USER_COPY, reason: "spend_cap_user" }),
    ),
    { reason: "spend_cap_user", message: SPEND_CAP_USER_COPY },
  );
  assert.equal(spendGuardRefusalFromError(new ApiNetworkError("offline")), null);
  assert.equal(spendGuardRefusalFromError(new Error("plain")), null);
  assert.equal(spendGuardRefusalFromError(null), null);
  // UpgradeRequiredError extends ApiError — a 402 body never carries a guard reason,
  // but the helper is shape-driven, not class-driven.
  assert.equal(
    spendGuardRefusalFromError(
      new UpgradeRequiredError({ status: 402, body: { error: "Premium" } }),
    ),
    null,
  );
});

// ── grocery.ts + groceryHandoff.ts ────────────────────────────────────────

for (const c of GUARD_CASES) {
  test(`generateGroceryListForPlan: ${c.reason} (${c.status}) → spend_guard with the server's copy verbatim`, async () => {
    nextResponse = () =>
      mockJson({ error: "ai_failed", message: c.copy, reason: c.reason }, c.status);
    const result = await generateGroceryListForPlan("plan-1");
    assert.deepEqual(result, {
      success: false,
      error: "spend_guard",
      reason: c.reason,
      message: c.copy,
    });

    // …and the handoff alerts with that copy, not "Our AI hit a hiccup".
    const action = resolveGenerateResult(result);
    assert.equal(action.kind, "alert");
    if (action.kind === "alert") {
      assert.equal(action.message, c.copy);
      assert.notEqual(action.message, "Our AI hit a hiccup. Please try again in a moment.");
    }
  });
}

test("generateGroceryListForPlan: a 429 WITHOUT a guard reason is still `unknown` (local copy)", async () => {
  nextResponse = () => mockJson({ error: "Too many requests" }, 429);
  const result = await generateGroceryListForPlan("plan-1");
  assert.deepEqual(result, { success: false, error: "unknown", status: 429 });
  assert.deepEqual(resolveGenerateResult(result), {
    kind: "alert",
    title: "Something went wrong",
    message: "Please try again in a moment.",
  });
});

test("generateGroceryListForPlan: a 502 ai_failed still maps to ai_failed (canonical local copy)", async () => {
  nextResponse = () =>
    mockJson({ error: "ai_failed", message: "Kiwi got distracted.", reason: "sdk_error" }, 502);
  const result = await generateGroceryListForPlan("plan-1");
  assert.deepEqual(result, {
    success: false,
    error: "ai_failed",
    message: "Kiwi got distracted.",
  });
  assert.deepEqual(resolveGenerateResult(result), {
    kind: "alert",
    title: "Could not generate list",
    message: "Our AI hit a hiccup. Please try again in a moment.",
  });
});

test("generateGroceryListForPlan: a 503 whose body has a guard reason but no copy falls through to unknown", async () => {
  nextResponse = () => mockJson({ reason: "ai_disabled" }, 503);
  const result = await generateGroceryListForPlan("plan-1");
  assert.deepEqual(result, { success: false, error: "unknown", status: 503 });
});

// ── recipeImport.ts — the non-2xx branch ──────────────────────────────────

for (const c of GUARD_CASES) {
  test(`importRecipeFromUrl: a ${c.status} with ${c.reason} renders the server's copy verbatim`, async () => {
    nextResponse = () => mockJson({ error: c.copy, reason: c.reason }, c.status);
    const result = await importRecipeFromUrl({ url: "https://example.com/r" });
    assert.deepEqual(result, {
      success: false,
      reason: c.reason,
      userFacingMessage: c.copy,
    });
  });
}

test("importRecipeFromText: a 503 with ai_disabled renders the server's copy verbatim", async () => {
  nextResponse = () => mockJson({ error: AI_UNAVAILABLE_COPY, reason: "ai_disabled" }, 503);
  const result = await importRecipeFromText({ rawText: "2 eggs" });
  assert.deepEqual(result, {
    success: false,
    reason: "ai_disabled",
    userFacingMessage: AI_UNAVAILABLE_COPY,
  });
});

test("importRecipeFromUrl: a plain 429 (the import rate limiter, no reason) keeps the local rate-limited copy", async () => {
  nextResponse = () => mockJson({ error: "Too many requests" }, 429);
  const result = await importRecipeFromUrl({ url: "https://example.com/r" });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.reason, "rate_limited");
    assert.equal(
      result.userFacingMessage,
      "Kiwi is catching up on imports — give it a moment and try again.",
    );
  }
});

test("importRecipeFromUrl: a 502 keeps the local sdk_error copy", async () => {
  nextResponse = () => mockJson({ error: "upstream", reason: "sdk_error" }, 502);
  const result = await importRecipeFromUrl({ url: "https://example.com/r" });
  assert.deepEqual(result, {
    success: false,
    reason: "sdk_error",
    userFacingMessage: "Kiwi couldn't read this recipe. Try again in a moment.",
  });
});

test("importRecipeFromUrl: the 200 envelope path passes a guard reason + copy through (unchanged)", async () => {
  nextResponse = () =>
    mockJson({
      success: false,
      reason: "spend_cap_user",
      userFacingMessage: SPEND_CAP_USER_COPY,
      suggestedAction: "try_image_import",
    });
  const result = await importRecipeFromUrl({ url: "https://example.com/r" });
  assert.deepEqual(result, {
    success: false,
    reason: "spend_cap_user",
    userFacingMessage: SPEND_CAP_USER_COPY,
  });
});

// ── askKiwiSubmit.ts / askKiwiDishSubmit.ts ───────────────────────────────

function mealDeps(parseMeal: () => Promise<never>) {
  return {
    parseMeal,
    navigateToDraft: () => {
      throw new Error("must not navigate");
    },
    routeToUpgrade: () => {
      throw new Error("must not route to upgrade");
    },
  };
}

for (const c of GUARD_CASES) {
  test(`runAskKiwiSubmit: ${c.reason} (${c.status}) → the server's copy verbatim`, async () => {
    const outcome = await runAskKiwiSubmit(
      { freeText: "tacos", servings: 4 },
      mealDeps(async () => {
        throw apiError(c.status, { error: c.copy, status: "failed", reason: c.reason });
      }),
    );
    assert.deepEqual(outcome, { status: "error", message: c.copy });
  });

  test(`runAskKiwiDishSubmit: ${c.reason} (${c.status}) → the server's copy verbatim`, async () => {
    const outcome = await runAskKiwiDishSubmit(
      { freeText: "salsa", servings: 4 },
      {
        parseDish: async () => {
          throw apiError(c.status, { error: c.copy, status: "failed", reason: c.reason });
        },
        navigateToDraft: () => {
          throw new Error("must not navigate");
        },
        routeToUpgrade: () => {
          throw new Error("must not route to upgrade");
        },
      },
    );
    assert.deepEqual(outcome, { status: "error", message: c.copy });
  });
}

test("runAskKiwiSubmit: a 429 WITHOUT a guard reason keeps the local copy", async () => {
  const outcome = await runAskKiwiSubmit(
    { freeText: "tacos", servings: 4 },
    mealDeps(async () => {
      throw apiError(429, { error: "Too many requests" });
    }),
  );
  assert.deepEqual(outcome, { status: "error", message: ASK_KIWI_AI_FAILED_MESSAGE });
});

test("runAskKiwiSubmit: a 502 with the server's generic copy still renders the LOCAL copy", async () => {
  // The ruling is scoped to the three guard reasons; a plain AI failure's
  // "Kiwi got distracted" stays replaced by the builder's own line.
  const outcome = await runAskKiwiSubmit(
    { freeText: "tacos", servings: 4 },
    mealDeps(async () => {
      throw apiError(502, {
        error: "Kiwi got distracted. Try again?",
        status: "failed",
        reason: "sdk_error",
      });
    }),
  );
  assert.deepEqual(outcome, { status: "error", message: ASK_KIWI_AI_FAILED_MESSAGE });
});

test("runAskKiwiDishSubmit: a 503 WITHOUT a guard reason keeps the local copy", async () => {
  const outcome = await runAskKiwiDishSubmit(
    { freeText: "salsa", servings: 4 },
    {
      parseDish: async () => {
        throw apiError(503, { error: "Service Unavailable" });
      },
      navigateToDraft: () => {},
      routeToUpgrade: () => {},
    },
  );
  assert.deepEqual(outcome, { status: "error", message: ASK_KIWI_DISH_AI_FAILED_MESSAGE });
});

test("runAskKiwiSubmit: a 402 still routes to upgrade — the guard check does not shadow it", async () => {
  let upgraded = 0;
  const outcome = await runAskKiwiSubmit(
    { freeText: "tacos", servings: 4 },
    {
      parseMeal: async () => {
        throw new UpgradeRequiredError({ status: 402, body: { error: "Premium" } });
      },
      navigateToDraft: () => {},
      routeToUpgrade: () => {
        upgraded += 1;
      },
    },
  );
  assert.deepEqual(outcome, { status: "upgrade" });
  assert.equal(upgraded, 1);
});
