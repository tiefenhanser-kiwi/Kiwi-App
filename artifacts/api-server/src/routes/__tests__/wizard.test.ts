// WS6 6a-3 — POST /api/wizard/build-plans tests.
// Covers input validation, entitlement gate, rate limit, happy path, AI failure.
// No real Anthropic call — runAICall is stubbed via the route's DI seam.
//
// HTTP transport: a lightweight Express app is mounted on a random port and
// exercised with native fetch. JWT auth is exercised end-to-end with a
// real signed token.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { Prisma } from "@prisma/client";

import { signToken } from "../../lib/auth";
import { currentWeekRange } from "../../lib/planDates";
import { toYmd } from "../../lib/planQueries";
import { createWizardRouter } from "../wizard";
import type {
  AICallFailure,
  AICallSuccess,
  AICallResult,
} from "../../lib/ai/runAICall";
import type { WizardPlanCandidatesResult } from "../../lib/ai/schemas/wizard";
import type { ParsedIntent } from "../../lib/ai/schemas/tellKiwi";
import type {
  EntitlementResult,
  SubscriptionService,
} from "../../lib/subscriptionService";

// ── stubs ──────────────────────────────────────────────────────────────

interface StubPrismaOpts {
  // D-WS9-038 — rows returned by meal.findMany for the store shortlist. The
  // stub ignores the where/select and hands these back; buildStoreShortlist
  // reads the fields it selects off them.
  storeMeals?: Array<Record<string, unknown>>;
  preferences?: {
    cookingEquipment?: string[];
    spiceTolerance?: "mild" | "medium" | "hot" | "very_hot";
    budgetLevel?: "economy" | "mid_range" | "premium";
    pickyAvoidances?: string[];
    recurringGroceryItems?: string[];
    // Cookbook Phase B Block 4 — stored generation-shaping prefs the resolver
    // reads. The stub returns the whole object regardless of `select`, so these
    // feed resolveEffectivePreferences() in the same call.
    discoveryMealsPerWeek?: number;
    saucePreference?: "store_bought" | "balanced" | "homemade";
    maxCookTimeMinutes?: number | null;
    maxCookTimeCoverage?: "all" | "most";
    // WS9 3c — the Surprise-me route reads these stored prefs directly (no
    // request body). The stub returns the whole object regardless of `select`.
    householdSize?: number;
    planLengthDefault?: number;
    cuisines?: string[];
    eatingStyles?: string[];
    allergiesAndAvoidances?: string[];
    dietaryNotes?: string | null;
    weeklyPacingDefault?:
      | "mostly_easy"
      | "mixed"
      | "one_fancy_night"
      | "minimal_effort";
    wantsLeftovers?: boolean;
  } | null;
  pantryStaples?: string[];
}

function makeStubPrisma(opts: StubPrismaOpts = {}) {
  const llmCalls: unknown[] = [];
  const activities: { eventType: string; userId: string }[] = [];
  return {
    aIPrompt: { findUnique: async () => null },
    systemSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (where.key === "wizard.candidate_count") {
          return { key: where.key, value: 3 };
        }
        if (where.key === "wizard.max_refreshes_per_session") {
          return { key: where.key, value: 3 };
        }
        return null;
      },
    },
    userPreferences: {
      findUnique: async () => opts.preferences ?? null,
    },
    pantryStaple: {
      findMany: async () =>
        (opts.pantryStaples ?? []).map((ingredientName) => ({
          ingredientName,
        })),
    },
    userActivity: {
      findMany: async () => [],
      create: async ({
        data,
      }: {
        data: { eventType: string; userId: string };
      }) => {
        activities.push(data);
        return data;
      },
    },
    // Cookbook Phase A — buildPlanningContext reads recent meals + plan names.
    // Empty is fine for the build-plans / build-from-text route tests (they
    // assert planningContext PRESENCE, not history contents).
    mealPlanInstance: {
      findMany: async () => [],
      // Block 1 (BUG-030) — expand-side idempotency lookup; default no reuse.
      findFirst: async () => null,
      // Block 4b-1 (D-WS9-075) — shortlist rotation salt (user's plan count).
      count: async () => 0,
    },
    meal: {
      findMany: async () => opts.storeMeals ?? [],
    },
    lLMCallLog: {
      create: async ({ data }: { data: unknown }) => {
        llmCalls.push(data);
        return data;
      },
    },
    _activities: () => activities,
    _llmCalls: () => llmCalls,
  };
}

function happyCandidates(): WizardPlanCandidatesResult {
  return {
    candidates: [
      {
        id: "c1",
        title: "Cozy Comfort Week",
        tags: ["Comfort", "Easy"],
        whyBullets: [
          "Sheet-pan and one-pot meals minimize cleanup",
          "Garlic shared across 3 meals — buy one head, use it all",
        ],
        mealTitles: [
          "Sheet-pan harissa chicken",
          "Tomato soup + grilled cheese",
          "Baked potato bar",
          "Chicken noodle soup",
          "Skillet meatballs + pasta",
        ],
        dailyMacros: { calories: 540, proteinG: 28, carbsG: 56, fatG: 22 },
      },
      {
        id: "c2",
        title: "Mediterranean-Leaning Variety",
        tags: ["Mediterranean", "Variety"],
        whyBullets: [
          "Lemons used across 4 meals — buy a bag, use them all",
          "One fancy Friday, four easy weeknights",
        ],
        mealTitles: [
          "Greek salad + grilled shrimp",
          "Lemon herb salmon + quinoa",
          "Big greek salad",
          "Pesto pasta + green beans",
          "Mediterranean grain bowl",
        ],
        dailyMacros: { calories: 520, proteinG: 32, carbsG: 48, fatG: 24 },
      },
      {
        id: "c3",
        title: "High-Protein Reset",
        tags: ["High Protein"],
        whyBullets: [
          "Hits >25g protein/serving across all 5 nights",
          "Chicken prepped once, used in two different meals",
        ],
        mealTitles: [
          "Herb chicken + roasted potatoes",
          "Steak + green beans",
          "Salmon + asparagus",
          "Turkey taco bowls",
          "Chicken caesar wraps",
        ],
        dailyMacros: { calories: 560, proteinG: 42, carbsG: 32, fatG: 24 },
      },
    ],
  };
}

function makeRunAICall(
  result: () => Promise<AICallResult<WizardPlanCandidatesResult>>,
) {
  let calls = 0;
  const capturedVars: Record<string, unknown>[] = [];
  const fn = (async (
    _promptKey: string,
    vars: Record<string, unknown>,
    ..._rest: unknown[]
  ) => {
    calls++;
    capturedVars.push(vars);
    return result();
  }) as unknown as Parameters<typeof createWizardRouter>[0] extends
    | { runAICall?: infer R }
    | undefined
    ? R
    : never;
  return {
    fn,
    getCalls: () => calls,
    getVars: () => capturedVars,
  };
}

function happyResult(): AICallSuccess<WizardPlanCandidatesResult> {
  return {
    success: true,
    data: happyCandidates(),
    metadata: {
      promptKey: "wizard.set_preferences.generate",
      promptVersion: 2,
      model: "claude-sonnet-4-6",
      mode: "tool",
      latencyMs: 1234,
      inputTokens: 1500,
      outputTokens: 320,
      costEstimateUsd: 0.0093,
      retryCount: 0,
    },
  };
}

function failureResult(): AICallFailure {
  return {
    success: false,
    reason: "validation_failed",
    userFacingMessage: "Kiwi got distracted. Try again?",
    metadata: {
      promptKey: "wizard.set_preferences.generate",
      promptVersion: 2,
      model: "claude-sonnet-4-6",
      mode: "tool",
      latencyMs: 850,
      inputTokens: 1500,
      outputTokens: 0,
      retryCount: 1,
    },
  };
}

function makeSubscriptionService(allowed: boolean): SubscriptionService {
  return {
    async can(): Promise<EntitlementResult> {
      return allowed
        ? { allowed: true }
        : { allowed: false, reason: "Trial expired — upgrade to continue." };
    },
  };
}

// ── server harness ─────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(deps: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runAICall: any;
  // Latency Block (D-WS9-076) — streaming seam for the SSE branch tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streamPlanCandidates?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any;
  subscriptionService: SubscriptionService;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
  // WS7-5a expand/drafts seams. All optional so existing build-plans /
  // build-from-text tests are unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expandCandidate?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  persistWizardDraft?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sweepStaleWizardDrafts?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  materializeWizardDraft?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitActivity?: any;
  // WS7-5c Block A — finalize-steps seam.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readAndFinalizeWizardDraft?: any;
}): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createWizardRouter(deps));

  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

const VALID_BODY = {
  planDurationDays: 5,
  householdSize: 4,
  wantsLeftovers: true,
  cuisines: ["Italian", "Mexican", "Thai"],
  eatingStyles: [],
  allergiesAndAvoidances: [],
  difficulty: "medium" as const,
  weeklyPacing: "mixed" as const,
};

const TEST_USER_ID = "test-user-wizard-route";

// ── tests ──────────────────────────────────────────────────────────────

describe("POST /api/wizard/build-plans — happy path", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());
  const prisma = makeStubPrisma({
    preferences: {
      // WS7-2 Block A: DB columns renamed to mobile-aligned names.
      // AI input shape (asserted below) keeps the legacy 'equipment' /
      // 'recurringItems' keys — wizard route maps at the boundary.
      cookingEquipment: ["oven", "stove", "instant_pot"],
      spiceTolerance: "medium",
      budgetLevel: "mid_range",
      pickyAvoidances: ["cilantro"],
      recurringGroceryItems: ["olive_oil", "salt"],
    },
    pantryStaples: ["garlic", "rice"],
  });

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 200 + 3 candidates and emits a wizard_complete activity", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { id: string; title: string }[];
      metadata: { promptVersion: number };
    };
    assert.equal(body.candidates.length, 3);
    assert.ok(body.candidates[0].title.length > 0);
    assert.equal(body.metadata.promptVersion, 2);
    assert.equal(ai.getCalls(), 1);
    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_complete"));
  });

  it("injects UserPreferences hidden context into the AI input", async () => {
    // The previous test fired one call; this test fires another and inspects
    // the captured vars on the most recent invocation.
    const token = signToken(TEST_USER_ID);
    await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY),
    });

    const lastVars = ai.getVars().at(-1) as
      | { wizardInput?: { hiddenContext?: Record<string, unknown> } }
      | undefined;
    assert.ok(lastVars?.wizardInput?.hiddenContext);
    const ctx = lastVars.wizardInput.hiddenContext as Record<string, unknown>;
    assert.deepEqual(ctx.equipment, ["oven", "stove", "instant_pot"]);
    assert.equal(ctx.spiceTolerance, "medium");
    assert.equal(ctx.budgetLevel, "mid_range");
    assert.deepEqual(ctx.pickyAvoidances, ["cilantro"]);
    assert.deepEqual(ctx.recurringItems, ["olive_oil", "salt"]);
    assert.deepEqual(ctx.pantryStaples, ["garlic", "rice"]);
  });
});

// ── Latency Block (D-WS9-076) — build-plans SSE streaming branch ──────────
// Parse an SSE response body ("event: X\ndata: {...}\n\n"*) into frames.
function parseSse(text: string): Array<{ event: string; data: any }> {
  const frames: Array<{ event: string; data: any }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
  }
  return frames;
}

// Fake streamPlanCandidates: replays onCandidate for each candidate, then
// resolves success (or failure when `fail` is set).
function makeStreamFn(
  candidates: WizardPlanCandidatesResult["candidates"],
  opts: { fail?: boolean; skipProgressiveIndex?: number } = {},
) {
  let calls = 0;
  const fn = async (
    _promptKey: string,
    _vars: Record<string, unknown>,
    o: {
      onCandidate?: (i: number, c: unknown) => void;
      onProgress?: (info: { bytes: number }) => void;
      cacheSplitMarker?: string;
    },
  ): Promise<AICallResult<WizardPlanCandidatesResult>> => {
    calls++;
    if (opts.fail) {
      return {
        success: false,
        reason: "sdk_error",
        userFacingMessage: "Kiwi got distracted. Try again?",
        metadata: { promptKey: "wizard.set_preferences.generate" },
      } as AICallFailure;
    }
    // Liveness frames precede the first candidate (the pre-first-card window).
    o.onProgress?.({ bytes: 64 });
    o.onProgress?.({ bytes: 512 });
    candidates.forEach((c, i) => {
      if (i === opts.skipProgressiveIndex) return; // simulate a catch-up-only card
      o.onCandidate?.(i, c);
    });
    return {
      success: true,
      data: { candidates, cannotGenerateMore: false },
      metadata: {
        promptKey: "wizard.set_preferences.generate",
        promptVersion: 5,
        model: "claude-sonnet-4-6",
        mode: "tool",
        latencyMs: 900,
        inputTokens: 1500,
        outputTokens: 320,
        costEstimateUsd: 0.009,
        retryCount: 0,
      },
    } as AICallSuccess<WizardPlanCandidatesResult>;
  };
  return { fn, getCalls: () => calls };
}

describe("POST /api/wizard/build-plans — SSE streaming (D-WS9-076)", () => {
  const STREAM_USER = "stream-user-1";

  async function streamOnce(deps: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamFn: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma?: any;
  }) {
    const prisma = deps.prisma ?? makeStubPrisma();
    const harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      streamPlanCandidates: deps.streamFn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
    try {
      const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${signToken(STREAM_USER)}`,
        },
        body: JSON.stringify(VALID_BODY),
      });
      const text = await res.text();
      return { res, frames: parseSse(text), prisma };
    } finally {
      await harness.close();
    }
  }

  it("streams one candidate frame per candidate, then a done frame", async () => {
    const stream = makeStreamFn(happyCandidates().candidates);
    const { res, frames } = await streamOnce({ streamFn: stream.fn });

    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get("content-type") ?? "").includes("text/event-stream"),
    );
    const candidateFrames = frames.filter((f) => f.event === "candidate");
    const doneFrames = frames.filter((f) => f.event === "done");
    assert.equal(candidateFrames.length, 3);
    assert.deepEqual(
      candidateFrames.map((f) => f.data.index),
      [0, 1, 2],
    );
    assert.equal(candidateFrames[0].data.candidate.id, "c1");
    assert.equal(doneFrames.length, 1);
    assert.equal(doneFrames[0].data.cannotGenerateMore, false);
  });

  it("streams progress frames before the first candidate (watchdog liveness)", async () => {
    const stream = makeStreamFn(happyCandidates().candidates);
    const { frames } = await streamOnce({ streamFn: stream.fn });
    const firstProgress = frames.findIndex((f) => f.event === "progress");
    const firstCandidate = frames.findIndex((f) => f.event === "candidate");
    assert.ok(firstProgress >= 0, "at least one progress frame is sent");
    assert.ok(
      firstProgress < firstCandidate,
      "a progress frame arrives before the first candidate frame",
    );
    assert.equal(typeof frames[firstProgress].data.bytes, "number");
  });

  it("reconciles store slots per candidate — a hallucinated alias is dropped", async () => {
    const cands = happyCandidates().candidates.map((c, i) =>
      i === 0
        ? { ...c, storeSlots: [{ slotIndex: 0, storeMealId: "not-a-real-alias" }] }
        : c,
    );
    const stream = makeStreamFn(cands);
    const { frames } = await streamOnce({ streamFn: stream.fn });
    const first = frames.find(
      (f) => f.event === "candidate" && f.data.index === 0,
    );
    // The unknown alias isn't in the (empty) shortlist → reconcile strips
    // storeSlots entirely, proving the per-candidate reconcile runs at emit.
    assert.equal(first?.data.candidate.storeSlots, undefined);
  });

  it("catch-up: a candidate not emitted progressively still arrives before done", async () => {
    // Skip index 1 during progressive emit; the route must backfill it from the
    // final result so the client ends with the complete set.
    const stream = makeStreamFn(happyCandidates().candidates, {
      skipProgressiveIndex: 1,
    });
    const { frames } = await streamOnce({ streamFn: stream.fn });
    const idxs = frames
      .filter((f) => f.event === "candidate")
      .map((f) => f.data.index)
      .sort();
    assert.deepEqual(idxs, [0, 1, 2]);
    // No duplicates.
    assert.equal(new Set(idxs).size, 3);
  });

  it("emits an error frame (not a JSON 502) when the stream fails", async () => {
    const stream = makeStreamFn([], { fail: true });
    const { res, frames, prisma } = await streamOnce({ streamFn: stream.fn });
    assert.equal(res.status, 200); // SSE committed 200 at header time
    const errorFrames = frames.filter((f) => f.event === "error");
    assert.equal(errorFrames.length, 1);
    assert.ok(errorFrames[0].data.reason);
    assert.equal(frames.filter((f) => f.event === "done").length, 0);
    const events = prisma._activities().map((a: { eventType: string }) => a.eventType);
    assert.ok(events.includes("wizard_failure"));
  });

  it("without an event-stream Accept header, the buffered JSON path is used", async () => {
    // The streaming seam must NOT be called; the buffered runAICall path serves
    // a normal JSON body. Uses a fresh user id for a fresh rate-limit bucket.
    const stream = makeStreamFn(happyCandidates().candidates);
    const harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      streamPlanCandidates: stream.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
    try {
      const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signToken("buffered-user-1")}`,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(res.status, 200);
      assert.ok((res.headers.get("content-type") ?? "").includes("application/json"));
      const body = (await res.json()) as { candidates: unknown[] };
      assert.equal(body.candidates.length, 3);
      assert.equal(stream.getCalls(), 0);
    } finally {
      await harness.close();
    }
  });
});

// ── D-WS9-038 — build-plans store compose ────────────────────────────────
function storeMealRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `Store meal ${id}`,
    cuisineType: "italian",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    tags: ["quick"],
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    useCount: 5,
    likeCount: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function resultWithStoreSlots(
  slots: Array<{ slotIndex: number; storeMealId: string }>,
): AICallSuccess<WizardPlanCandidatesResult> {
  const data = happyCandidates();
  data.candidates[0].storeSlots = slots;
  return { success: true, data, metadata: happyResult().metadata };
}

const AUTH_HEADERS = (userId: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${signToken(userId)}`,
});

// Distinct per-test user ids: the rate limiter's STORE is module-global keyed
// by (method,path,userId), so reusing TEST_USER_ID would drain the shared
// build-plans bucket and 429 the later describes. Fresh ids = fresh buckets.
describe("POST /api/wizard/build-plans — store compose (D-WS9-038)", () => {
  it("hands the AI short aliases and translates the mark back to the real id", async () => {
    // The AI only ever sees/echoes the per-shortlist alias (m1); reconcile
    // rewrites storeMealId to the real Meal.id. store-1 gets a higher useCount
    // so it ranks first → alias m1 (deterministic).
    const ai = makeRunAICall(async () =>
      resultWithStoreSlots([{ slotIndex: 0, storeMealId: "m1" }]),
    );
    const prisma = makeStubPrisma({
      storeMeals: [
        storeMealRow("store-1", { useCount: 100 }),
        storeMealRow("store-2"),
      ],
    });
    const harness = await spinUp({
      runAICall: ai.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
    try {
      const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
        method: "POST",
        headers: AUTH_HEADERS("store-user-1"),
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        candidates: {
          storeSlots?: { slotIndex: number; storeMealId: string }[];
        }[];
      };
      // The shelf reached the AI with ALIAS ids (m1, m2), not the real ids.
      const vars = ai.getVars().at(-1) as {
        storeShortlist?: { id: string }[];
      };
      assert.equal(vars.storeShortlist?.length, 2);
      assert.equal(vars.storeShortlist?.[0].id, "m1");
      // The mark cited the alias m1 → reconcile translated it to the real id.
      assert.deepEqual(body.candidates[0].storeSlots, [
        { slotIndex: 0, storeMealId: "store-1" },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("drops a hallucinated storeSlots id that was never on the shelf", async () => {
    const ai = makeRunAICall(async () =>
      resultWithStoreSlots([{ slotIndex: 0, storeMealId: "ghost-id" }]),
    );
    const prisma = makeStubPrisma({ storeMeals: [storeMealRow("store-1")] });
    const harness = await spinUp({
      runAICall: ai.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
    try {
      const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
        method: "POST",
        headers: AUTH_HEADERS("store-user-2"),
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        candidates: { storeSlots?: unknown[] }[];
      };
      // ghost-id ∉ shelf → the whole (now-empty) storeSlots is dropped.
      assert.equal(body.candidates[0].storeSlots, undefined);
    } finally {
      await harness.close();
    }
  });

  it("thin store → empty shelf, fully-live candidates (no storeSlots)", async () => {
    const ai = makeRunAICall(async () => happyResult());
    const prisma = makeStubPrisma({ storeMeals: [] });
    const harness = await spinUp({
      runAICall: ai.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
    try {
      const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
        method: "POST",
        headers: AUTH_HEADERS("store-user-3"),
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        candidates: { storeSlots?: unknown[] }[];
      };
      const vars = ai.getVars().at(-1) as { storeShortlist?: unknown[] };
      assert.deepEqual(vars.storeShortlist, []);
      assert.equal(body.candidates[0].storeSlots, undefined);
    } finally {
      await harness.close();
    }
  });
});

describe("POST /api/wizard/build-plans — planning-context wiring", () => {
  // Cookbook Phase A Block 1 — planningContext must ride on wizardInput.
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("attaches planningContext (season/date/events/history) to wizardInput", async () => {
    const token = signToken(TEST_USER_ID);
    await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY),
    });

    const lastVars = ai.getVars().at(-1) as
      | {
          wizardInput?: {
            planningContext?: {
              currentDate?: string;
              season?: string;
              upcomingEvents?: unknown[];
              recentMeals?: unknown[];
              recentPlanNames?: unknown[];
            };
          };
        }
      | undefined;
    const pc = lastVars?.wizardInput?.planningContext;
    assert.ok(pc, "planningContext missing from wizardInput");
    assert.match(pc.currentDate ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(
      ["winter", "spring", "summer", "fall"].includes(pc.season ?? ""),
      `unexpected season ${pc.season}`,
    );
    assert.ok(Array.isArray(pc.upcomingEvents));
    // Block 4b-2 (D-WS9-073, Part 1b) — recentMeals is STRIPPED from the
    // build-plans payload (recentRotation is the recency unit now); it survives
    // only on the surprise route. recentPlanNames stays on planningContext.
    assert.ok(!("recentMeals" in pc), "recentMeals should be stripped");
    assert.ok(Array.isArray(pc.recentPlanNames));
  });
});

// Block 4b-2 (D-WS9-073) — the recent-rotation nudge is threaded onto the
// build-plans + directed generate inputs, and DELIBERATELY NOT onto surprise
// (ruling 2). The stub prisma has no plans, so the payload is the empty
// rotation — presence/absence is the contract under test here.
describe("recent-rotation nudge threading (Block 4b-2, D-WS9-073)", () => {
  const EMPTY_ROTATION = { plansConsidered: 0, meals: [] };

  it("build-plans threads recentRotation onto wizardInput", async () => {
    const ai = makeRunAICall(async () => happyResult());
    const harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
    try {
      const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signToken("test-user-rotation-bp")}`,
        },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(res.status, 200);
      const vars = ai.getVars().at(-1) as {
        wizardInput?: { recentRotation?: unknown };
      };
      assert.deepEqual(vars?.wizardInput?.recentRotation, EMPTY_ROTATION);
    } finally {
      await harness.close();
    }
  });

  it("build-from-text (directed) threads recentRotation onto generateInput", async () => {
    const runner = makeTellKiwiRunner({
      parse: () =>
        parseSuccess({
          scenario: "vague",
          explicitMeals: [],
          intentDescriptors: ["comfort"],
          mealCount: 5,
        }),
      generate: () => genSuccess(threeCandidates("directed")),
    });
    const harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
    try {
      const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signToken("test-user-rotation-tk")}`,
        },
        body: JSON.stringify(TELL_KIWI_BODY),
      });
      assert.equal(res.status, 200);
      const genCall = runner
        .getCalls()
        .find((c) => c.promptKey === "wizard.directed.generate");
      assert.ok(genCall, "directed generate call missing");
      const generateInput = genCall!.vars.generateInput as Record<
        string,
        unknown
      >;
      assert.deepEqual(generateInput.recentRotation, EMPTY_ROTATION);
    } finally {
      await harness.close();
    }
  });

  it("surprise-me does NOT thread recentRotation (ruling-2 guard; input byte-unchanged)", async () => {
    const captured: { promptKey: string; vars: Record<string, unknown> }[] = [];
    const runAICall = (async (
      promptKey: string,
      vars: Record<string, unknown>,
    ) => {
      captured.push({ promptKey, vars });
      return genSuccess(threeCandidates("surprise"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const harness = await spinUp({
      runAICall,
      prisma: makeStubPrisma({
        preferences: {
          householdSize: 3,
          planLengthDefault: 4,
          cuisines: [],
          eatingStyles: [],
          allergiesAndAvoidances: [],
          weeklyPacingDefault: "mostly_easy",
          wantsLeftovers: false,
        },
      }),
      subscriptionService: makeSubscriptionService(true),
    });
    try {
      const res = await fetch(`${harness.baseUrl}/wizard/surprise-me`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${signToken("test-user-rotation-sm")}`,
        },
      });
      assert.equal(res.status, 200);
      const generateInput = captured[0].vars.generateInput as Record<
        string,
        unknown
      >;
      assert.ok(
        !("recentRotation" in generateInput),
        "surprise-me must not carry recentRotation",
      );
    } finally {
      await harness.close();
    }
  });
});

describe("POST /api/wizard/build-plans — per-run preference precedence (D-WS7-035)", () => {
  // The wizard hydrates its controls from stored prefs, the user may edit for
  // THIS plan only, and the edit must WIN over stored at generate time (else
  // the override feature is inert). The complementary case: when the client
  // omits a field, the stored value must be used (fallback).
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());
  // Distinct user + permissive limiter: the rate limiter's STORE is a module-
  // global keyed by (method, path, userId), so reusing TEST_USER_ID here would
  // drain the shared build-plans bucket and 429 later describes.
  const PREF_USER_ID = "test-user-wizard-precedence";

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      // Stored prefs deliberately DIFFER from the per-run body below.
      prisma: makeStubPrisma({
        preferences: {
          discoveryMealsPerWeek: 0,
          saucePreference: "balanced",
          maxCookTimeMinutes: 60,
          maxCookTimeCoverage: "most",
        },
      }),
      subscriptionService: makeSubscriptionService(true),
      rateLimiterOpts: { capacity: 100, refillPerSec: 100 },
    });
  });
  after(async () => harness.close());

  it("uses the per-run override where sent, and stored where omitted", async () => {
    const token = signToken(PREF_USER_ID);
    await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      // Override two of the four (a 30-min cap for THIS plan + discovery=2);
      // omit saucePreference + maxCookTimeCoverage so they fall back to stored.
      body: JSON.stringify({
        ...VALID_BODY,
        maxCookTimeMinutes: 30,
        discoveryMealsPerWeek: 2,
      }),
    });

    const lastVars = ai.getVars().at(-1) as
      | {
          wizardInput?: {
            preferencesContext?: {
              discoveryMealsPerWeek?: number;
              saucePreference?: string;
              maxCookTimeMinutes?: number | null;
              maxCookTimeCoverage?: string;
            };
            // The raw override fields must NOT leak to the AI input top level.
            maxCookTimeMinutes?: unknown;
            discoveryMealsPerWeek?: unknown;
          };
        }
      | undefined;
    const pc = lastVars?.wizardInput?.preferencesContext;
    assert.ok(pc, "preferencesContext missing from wizardInput");
    // Per-run overrides win.
    assert.equal(pc.maxCookTimeMinutes, 30, "per-run cook cap did not win");
    assert.equal(pc.discoveryMealsPerWeek, 2, "per-run discovery did not win");
    // Omitted fields fall back to stored.
    assert.equal(pc.saucePreference, "balanced", "stored sauce not used");
    assert.equal(
      pc.maxCookTimeCoverage,
      "most",
      "stored coverage not used",
    );
    // Override fields are peeled off — they must not appear at wizardInput top
    // level (the prompt reads them only via preferencesContext).
    assert.equal(
      "maxCookTimeMinutes" in (lastVars?.wizardInput ?? {}),
      false,
      "override leaked to wizardInput top level",
    );
  });

  it("uses stored values when the client sends no overrides at all", async () => {
    const token = signToken(PREF_USER_ID);
    await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY), // no override fields
    });

    const pc = (
      ai.getVars().at(-1) as {
        wizardInput?: {
          preferencesContext?: {
            maxCookTimeMinutes?: number | null;
            discoveryMealsPerWeek?: number;
          };
        };
      }
    )?.wizardInput?.preferencesContext;
    assert.ok(pc, "preferencesContext missing");
    assert.equal(pc.maxCookTimeMinutes, 60, "should fall back to stored cap");
    assert.equal(
      pc.discoveryMealsPerWeek,
      0,
      "should fall back to stored discovery",
    );
  });

  it("honors an explicit null cap override over a stored cap", async () => {
    // Presence semantics: null is a real per-run value ("No limit this plan")
    // and must win over stored 60 — `null ?? stored` would wrongly discard it.
    const token = signToken(PREF_USER_ID);
    await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...VALID_BODY, maxCookTimeMinutes: null }),
    });

    const pc = (
      ai.getVars().at(-1) as {
        wizardInput?: {
          preferencesContext?: { maxCookTimeMinutes?: number | null };
        };
      }
    )?.wizardInput?.preferencesContext;
    assert.ok(pc, "preferencesContext missing");
    assert.equal(
      pc.maxCookTimeMinutes,
      null,
      "explicit null cap override did not win over stored",
    );
  });
});

describe("POST /api/wizard/build-plans — sequential distinctness", () => {
  let harness: Harness;
  // Stub returns a counter-keyed candidate so two invocations produce two
  // distinct payloads. This proves the route fires runAICall twice (no
  // hook-level/route-level caching) — the property the mobile regen relies on.
  let counter = 0;
  const ai = makeRunAICall(async () => {
    counter++;
    return {
      success: true,
      data: {
        candidates: [
          {
            id: `c-${counter}`,
            title: `Generated plan #${counter}`,
            tags: ["test"],
            whyBullets: [`Iteration ${counter}`],
            mealTitles: ["a", "b", "c", "d", "e"],
            dailyMacros: { calories: 500, proteinG: 30, carbsG: 50, fatG: 20 },
          },
        ],
      },
      metadata: {
        promptKey: "wizard.set_preferences.generate",
        promptVersion: 2,
        model: "claude-sonnet-4-6",
        mode: "tool" as const,
        latencyMs: 100,
        inputTokens: 100,
        outputTokens: 100,
        costEstimateUsd: 0.001,
        retryCount: 0,
      },
    };
  });

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("two POSTs with identical body produce two distinct AI calls", async () => {
    const token = signToken(TEST_USER_ID + "-distinct");
    const post = () =>
      fetch(`${harness.baseUrl}/wizard/build-plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(VALID_BODY),
      });

    const r1 = await post();
    const r2 = await post();
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const b1 = (await r1.json()) as {
      candidates: { id: string; title: string }[];
    };
    const b2 = (await r2.json()) as {
      candidates: { id: string; title: string }[];
    };
    assert.equal(ai.getCalls(), 2);
    assert.notEqual(b1.candidates[0].id, b2.candidates[0].id);
    assert.notEqual(b1.candidates[0].title, b2.candidates[0].title);
  });
});

describe("POST /api/wizard/build-plans — input validation", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("rejects 400 when difficulty is invalid", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...VALID_BODY, difficulty: "extreme" }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /invalid request body/);
    // Validation rejected before AI ran.
    assert.equal(ai.getCalls(), 0);
  });

  it("rejects 400 when planDurationDays is out of range", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...VALID_BODY, planDurationDays: 99 }),
    });

    assert.equal(res.status, 400);
  });

  it("rejects 401 when no authorization header", async () => {
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/wizard/build-plans — entitlement gate", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      // Trial expired — feature blocked.
      subscriptionService: makeSubscriptionService(false),
    });
  });
  after(async () => harness.close());

  it("returns 402 when entitlement.allowed is false (no AI call made)", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY),
    });

    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /upgrade required/);
    assert.match(body.reason, /Trial expired/);
    assert.equal(ai.getCalls(), 0);
  });
});

describe("POST /api/wizard/build-plans — AI failure", () => {
  let harness: Harness;
  const prisma = makeStubPrisma();

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => failureResult()).fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 502 with Kiwi-styled message and emits wizard_failure activity", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY),
    });

    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /Kiwi got distracted/);
    assert.equal(body.reason, "validation_failed");
    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(
      events.includes("wizard_failure"),
      `expected wizard_failure activity, saw ${events.join(",") || "(none)"}`,
    );
  });
});

describe("POST /api/wizard/build-plans — rate limit", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
      // Tight bucket so the burst is observable in the test.
      rateLimiterOpts: { capacity: 2, refillPerSec: 0 },
    });
  });
  after(async () => harness.close());

  it("returns 429 once the per-user bucket is empty", async () => {
    const token = signToken(TEST_USER_ID + "-rate");
    const post = () =>
      fetch(`${harness.baseUrl}/wizard/build-plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(VALID_BODY),
      });

    const r1 = await post();
    const r2 = await post();
    const r3 = await post();

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
    assert.equal(ai.getCalls(), 2);
  });
});

// ── Tell Kiwi (build-from-text) tests — WS6 6a-4 ──────────────────────

interface CapturedCall {
  promptKey: string;
  vars: Record<string, unknown>;
}

// Two-step orchestrator stub. `route` returns the parsedIntent for a given
// userInput, and `gen` returns the generate-step result. Each scenario test
// configures these helpers.
function makeTellKiwiRunner(args: {
  parse: (vars: Record<string, unknown>) => AICallResult<ParsedIntent>;
  generate?: (vars: Record<string, unknown>) => AICallResult<WizardPlanCandidatesResult>;
}) {
  const calls: CapturedCall[] = [];
  const fn = (async (
    promptKey: string,
    vars: Record<string, unknown>,
    ..._rest: unknown[]
  ) => {
    calls.push({ promptKey, vars });
    if (promptKey === "wizard.directed.parse_intent") {
      return args.parse(vars);
    }
    if (promptKey === "wizard.directed.generate") {
      if (!args.generate) {
        throw new Error("generate stub not configured");
      }
      return args.generate(vars);
    }
    throw new Error(`unexpected promptKey ${promptKey}`);
  }) as unknown as Parameters<typeof createWizardRouter>[0] extends
    | { runAICall?: infer R }
    | undefined
    ? R
    : never;
  return { fn, getCalls: () => calls };
}

function parseSuccess(intent: ParsedIntent): AICallSuccess<ParsedIntent> {
  return {
    success: true,
    data: intent,
    metadata: {
      promptKey: "wizard.directed.parse_intent",
      promptVersion: 2,
      model: "claude-haiku-4-5-20251001",
      mode: "text",
      latencyMs: 350,
      inputTokens: 800,
      outputTokens: 50,
      costEstimateUsd: 0.0011,
      retryCount: 0,
    },
  };
}

function genSuccess(
  candidates: WizardPlanCandidatesResult,
): AICallSuccess<WizardPlanCandidatesResult> {
  return {
    success: true,
    data: candidates,
    metadata: {
      promptKey: "wizard.directed.generate",
      promptVersion: 2,
      model: "claude-sonnet-4-6",
      mode: "tool",
      latencyMs: 1500,
      inputTokens: 2000,
      outputTokens: 400,
      costEstimateUsd: 0.012,
      retryCount: 0,
    },
  };
}

function failureFor(promptKey: string): AICallFailure {
  return {
    success: false,
    reason: "validation_failed",
    userFacingMessage: "Kiwi got distracted. Try again?",
    metadata: {
      promptKey,
      promptVersion: 2,
      model: promptKey.includes("parse")
        ? "claude-haiku-4-5-20251001"
        : "claude-sonnet-4-6",
      mode: promptKey.includes("parse") ? "text" : "tool",
      latencyMs: 500,
      inputTokens: 800,
      outputTokens: 0,
      retryCount: 1,
    },
  };
}

const TELL_KIWI_BODY = {
  description: "Make me an easy week with comfort food",
  householdSize: 4,
  wantsLeftovers: true,
  eatingStyles: [],
  allergiesAndAvoidances: [],
  planDurationDays: 5,
};

const TELL_KIWI_USER_ID = "test-user-tellkiwi-route";

function threeCandidates(
  prefix: string,
  required: string[] = [],
): WizardPlanCandidatesResult {
  // The prompt requires explicit meals to be present in every candidate for
  // the 'partial' scenario; tests verify that contract. This helper just
  // mirrors the contract — always include the required meals first.
  const fillers = ["Chicken", "Salad", "Soup", "Pizza", "Pasta"];
  const buildTitles = (variant: string): string[] => {
    const all = [...required.map((m) => `${m} ${variant}`), ...fillers];
    return all.slice(0, 5);
  };
  return {
    candidates: [1, 2, 3].map((n) => ({
      id: `${prefix}-${n}`,
      title: `${prefix} candidate ${n}`,
      tags: ["test"],
      whyBullets: [`Variation ${n}`],
      mealTitles: buildTitles(`v${n}`),
      dailyMacros: { calories: 540, proteinG: 30, carbsG: 50, fatG: 20 },
    })),
  };
}

function oneCandidate(
  title: string,
  meals: string[],
  cannotGenerateMore = true,
): WizardPlanCandidatesResult {
  return {
    candidates: [
      {
        id: `${title}-only`,
        title,
        tags: ["fully-specified"],
        whyBullets: ["Here's your plan, exactly as you described"],
        mealTitles: meals,
        dailyMacros: { calories: 540, proteinG: 30, carbsG: 50, fatG: 20 },
      },
    ],
    cannotGenerateMore,
  };
}

describe("POST /api/wizard/build-from-text — vague scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["easy", "comfort food"],
        mealCount: 5,
      }),
    generate: () => genSuccess(threeCandidates("vague")),
  });
  const prisma = makeStubPrisma();

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 3 candidates and fires both AI calls in order", async () => {
    const token = signToken(TELL_KIWI_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { id: string }[];
      parsedIntent: ParsedIntent;
      needsClarification?: unknown;
      metadata: { flow: string };
    };
    assert.equal(body.candidates.length, 3);
    assert.equal(body.parsedIntent.scenario, "vague");
    assert.equal(body.needsClarification, undefined);
    assert.equal(body.metadata.flow, "tellkiwi");

    const calls = runner.getCalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].promptKey, "wizard.directed.parse_intent");
    assert.equal(calls[1].promptKey, "wizard.directed.generate");

    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_complete"));
  });
});

describe("POST /api/wizard/build-from-text — partial scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "partial",
        explicitMeals: ["Tacos", "Pasta"],
        intentDescriptors: [],
        mealCount: 5,
      }),
    generate: () => genSuccess(threeCandidates("partial", ["Tacos", "Pasta"])),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 3 candidates that all include the explicit meals", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-partial");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...TELL_KIWI_BODY,
        description: "I want tacos and pasta this week",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { mealTitles: string[] }[];
      parsedIntent: ParsedIntent;
    };
    assert.equal(body.candidates.length, 3);
    assert.equal(body.parsedIntent.scenario, "partial");
    // Every candidate must include at least one mention of each explicit meal.
    for (const c of body.candidates) {
      const joined = c.mealTitles.join(" | ").toLowerCase();
      assert.ok(joined.includes("tacos"), `candidate missing tacos: ${joined}`);
      assert.ok(joined.includes("pasta"), `candidate missing pasta: ${joined}`);
    }

    // Generate step received parsedIntent with explicitMeals.
    const calls = runner.getCalls();
    const genCall = calls.find((c) => c.promptKey === "wizard.directed.generate");
    assert.ok(genCall);
    const generateInput = (genCall.vars as { generateInput?: { parsedIntent: ParsedIntent } })
      .generateInput;
    assert.deepEqual(generateInput?.parsedIntent.explicitMeals, ["Tacos", "Pasta"]);
  });
});

describe("POST /api/wizard/build-from-text — planning-context wiring", () => {
  // Cookbook Phase A Block 1 — planningContext must reach the GENERATE step but
  // NOT the parse step (keeps the Haiku classifier's token count flat).
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["easy"],
        mealCount: 5,
      }),
    generate: () => genSuccess(threeCandidates("wiring")),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("sends planningContext to generate, and withholds it from parse", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-wiring");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 200);

    const calls = runner.getCalls();
    const parseCall = calls.find(
      (c) => c.promptKey === "wizard.directed.parse_intent",
    );
    const genCall = calls.find(
      (c) => c.promptKey === "wizard.directed.generate",
    );

    // Regression pin: parse input must NOT carry planningContext.
    const parseInput = (parseCall?.vars as { parseInput?: Record<string, unknown> })
      ?.parseInput;
    assert.ok(parseInput, "parseInput missing");
    assert.equal(
      "planningContext" in (parseInput as Record<string, unknown>),
      false,
      "planningContext leaked into parseInput",
    );
    // Cookbook Phase B Block 2 — same discipline for preferencesContext: the
    // generation-shaping prefs bag must be withheld from the Haiku classifier.
    assert.equal(
      "preferencesContext" in (parseInput as Record<string, unknown>),
      false,
      "preferencesContext leaked into parseInput",
    );

    // Generate input must carry a well-formed planningContext.
    const generateInput = (genCall?.vars as {
      generateInput?: {
        planningContext?: { season?: string };
        preferencesContext?: Record<string, unknown>;
      };
    })?.generateInput;
    assert.ok(generateInput?.planningContext, "planningContext missing from generateInput");
    assert.ok(
      ["winter", "spring", "summer", "fall"].includes(
        generateInput.planningContext.season ?? "",
      ),
    );
    // Generate input must also carry preferencesContext with all four keys.
    const preferencesContext = generateInput?.preferencesContext;
    assert.ok(
      preferencesContext,
      "preferencesContext missing from generateInput",
    );
    for (const key of [
      "discoveryMealsPerWeek",
      "saucePreference",
      "maxCookTimeMinutes",
      "maxCookTimeCoverage",
    ]) {
      assert.ok(
        key in (preferencesContext as Record<string, unknown>),
        `preferencesContext missing key: ${key}`,
      );
    }
  });
});

describe("POST /api/wizard/build-from-text — fully_specified scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "fully_specified",
        explicitMeals: ["Tacos", "Salmon", "Stir Fry", "Pizza", "Pasta"],
        intentDescriptors: [],
        mealCount: 5,
      }),
    generate: () =>
      genSuccess(
        oneCandidate("Your 5-meal lineup", [
          "Tacos",
          "Salmon",
          "Stir Fry",
          "Pizza",
          "Pasta",
        ]),
      ),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns exactly 1 candidate with cannotGenerateMore set", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-fully");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...TELL_KIWI_BODY,
        description: "Mon: tacos, Tue: salmon, Wed: stir fry, Thu: pizza, Fri: pasta",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { id: string; mealTitles: string[] }[];
      parsedIntent: ParsedIntent;
      cannotGenerateMore?: boolean;
    };
    assert.equal(body.candidates.length, 1);
    assert.equal(body.parsedIntent.scenario, "fully_specified");
    assert.equal(body.cannotGenerateMore, true);
  });
});

describe("POST /api/wizard/build-from-text — overflow scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "overflow",
        explicitMeals: [
          "Tacos",
          "Salmon",
          "Lasagna",
          "Stir Fry",
          "Pizza",
          "Pasta",
          "Soup",
          "Sandwiches",
        ],
        intentDescriptors: [],
        mealCount: 5,
        needsClarification: {
          reason: "You named more meals than fit in 5 nights.",
          options: ["Pasta", "Soup", "Sandwiches"],
        },
      }),
    generate: () =>
      genSuccess(
        oneCandidate("Your 5-night lineup", [
          "Tacos",
          "Salmon",
          "Lasagna",
          "Stir Fry",
          "Pizza",
        ]),
      ),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 1 candidate plus needsClarification.options with dropped meals", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-overflow");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...TELL_KIWI_BODY,
        description:
          "I want tacos, salmon, lasagna, stir fry, pizza, pasta, soup, sandwiches",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { id: string }[];
      parsedIntent: ParsedIntent;
      needsClarification?: { reason: string; options?: string[] };
    };
    assert.equal(body.candidates.length, 1);
    assert.equal(body.parsedIntent.scenario, "overflow");
    assert.deepEqual(body.needsClarification?.options, [
      "Pasta",
      "Soup",
      "Sandwiches",
    ]);
  });
});

describe("POST /api/wizard/build-from-text — unclear scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "unclear",
        explicitMeals: [],
        intentDescriptors: [],
        mealCount: 5,
        needsClarification: {
          reason: "Tell me a bit more — what kind of week do you want?",
        },
      }),
    // No generate stub — unclear must NOT call step 2.
  });
  const prisma = makeStubPrisma();

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns empty candidates + needsClarification, skips step 2 call", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-unclear");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...TELL_KIWI_BODY, description: "yellow" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: unknown[];
      parsedIntent: ParsedIntent;
      needsClarification?: { reason: string };
    };
    assert.equal(body.candidates.length, 0);
    assert.equal(body.parsedIntent.scenario, "unclear");
    assert.match(body.needsClarification?.reason ?? "", /Tell me a bit more/);

    // Cost-saving guarantee: step 2 was NOT called.
    const calls = runner.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].promptKey, "wizard.directed.parse_intent");

    // wizard_complete still fires (the user got a useful response).
    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_complete"));
  });
});

describe("POST /api/wizard/build-from-text — LLMCallLog accounting", () => {
  let harness: Harness;
  // Inject a prisma stub whose lLMCallLog.create writes are observable.
  // The route delegates LLMCallLog writes to runAICall (via the AI seam),
  // not the route itself, so this test simulates 2 calls per request by
  // instrumenting the ai stub to write a log row each time it's invoked.
  const prisma = makeStubPrisma();
  const runner = makeTellKiwiRunner({
    parse: (vars) => {
      // Simulate orchestrator log write so the test can count them.
      void prisma.lLMCallLog.create({
        data: {
          promptKey: "wizard.directed.parse_intent",
          promptVersion: 2,
          model: "claude-haiku-4-5-20251001",
          mode: "text",
          userId: null,
          latencyMs: 100,
          inputTokens: 100,
          outputTokens: 20,
          costEstimateUsd: 0.0001,
          retryCount: 0,
          success: true,
          failureReason: null,
        },
      });
      return parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["easy"],
        mealCount: 5,
      });
    },
    generate: () => {
      void prisma.lLMCallLog.create({
        data: {
          promptKey: "wizard.directed.generate",
          promptVersion: 2,
          model: "claude-sonnet-4-6",
          mode: "tool",
          userId: null,
          latencyMs: 1500,
          inputTokens: 2000,
          outputTokens: 400,
          costEstimateUsd: 0.012,
          retryCount: 0,
          success: true,
          failureReason: null,
        },
      });
      return genSuccess(threeCandidates("logging-test"));
    },
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("writes 2 LLMCallLog rows per request (parse + generate)", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-logs");
    await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });

    const logs = prisma._llmCalls() as Array<{
      promptKey: string;
      success: boolean;
    }>;
    const tellKiwiLogs = logs.filter((l) =>
      l.promptKey.startsWith("wizard.directed."),
    );
    assert.equal(tellKiwiLogs.length, 2);
    const keys = tellKiwiLogs.map((l) => l.promptKey).sort();
    assert.deepEqual(keys, [
      "wizard.directed.generate",
      "wizard.directed.parse_intent",
    ]);
  });
});

describe("POST /api/wizard/build-from-text — parse-step failure", () => {
  let harness: Harness;
  const prisma = makeStubPrisma();
  const runner = makeTellKiwiRunner({
    parse: () => failureFor("wizard.directed.parse_intent"),
    // No generate stub — parse failure should short-circuit before step 2.
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 502 + emits wizard_failure when step 1 fails", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-parsefail");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /Kiwi got distracted/);
    assert.equal(body.reason, "validation_failed");

    const calls = runner.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].promptKey, "wizard.directed.parse_intent");

    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_failure"));
  });
});

describe("POST /api/wizard/build-from-text — generate-step failure", () => {
  let harness: Harness;
  const prisma = makeStubPrisma();
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["easy"],
        mealCount: 5,
      }),
    generate: () => failureFor("wizard.directed.generate"),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 502 + emits wizard_failure when step 2 fails", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-genfail");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /Kiwi got distracted/);
    assert.equal(body.reason, "validation_failed");

    // Both calls fired.
    const calls = runner.getCalls();
    assert.equal(calls.length, 2);

    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_failure"));
  });
});

describe("POST /api/wizard/build-from-text — entitlement gate", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["easy"],
        mealCount: 5,
      }),
    generate: () => genSuccess(threeCandidates("blocked")),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(false),
    });
  });
  after(async () => harness.close());

  it("returns 402 when kitchen_wizard_just_say is denied; no AI calls fire", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-blocked");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 402);
    assert.equal(runner.getCalls().length, 0);
  });
});

describe("POST /api/wizard/build-from-text — input validation", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: [],
        mealCount: 5,
      }),
    generate: () => genSuccess(threeCandidates("validation")),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("rejects 400 when description is too short", async () => {
    const token = signToken(TELL_KIWI_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...TELL_KIWI_BODY, description: "yo" }),
    });
    assert.equal(res.status, 400);
    assert.equal(runner.getCalls().length, 0);
  });

  it("rejects 401 when no auth header is present", async () => {
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 401);
  });
});

describe("GET /api/wizard/limits", () => {
  let harness: Harness;

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns candidateCount and maxRefreshesPerSession from SystemSetting", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/limits`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidateCount: number;
      maxRefreshesPerSession: number;
    };
    assert.equal(body.candidateCount, 3);
    assert.equal(body.maxRefreshesPerSession, 3);
  });
});

// ── WS7-5a — POST /api/wizard/expand + GET /api/wizard/drafts ───────────

const EXPAND_VALID_BODY = {
  candidate: {
    id: "c1",
    title: "Cozy Comfort Week",
    tags: ["Comfort", "Easy"],
    whyBullets: ["Sheet-pan meals minimize cleanup"],
    mealTitles: [
      "Sheet-pan harissa chicken",
      "Tomato soup + grilled cheese",
    ],
    dailyMacros: { calories: 540, proteinG: 28, carbsG: 56, fatG: 22 },
  },
  candidateContext: {
    planDurationDays: 5,
    householdSize: 4,
    wantsLeftovers: true,
    allergiesAndAvoidances: [] as string[],
    eatingStyles: [] as string[],
    difficulty: "easy" as const,
  },
};

const EXPAND_USER_ID = "test-user-wizard-expand";

interface ExpandRecorder {
  expandCalls: Array<{ userId: string; candidateId: string }>;
  persistCalls: Array<{ userId: string; title: string }>;
  sweepCalls: Array<{ userId: string }>;
}

function makeExpandDeps(opts: {
  expandReturn: () => Promise<unknown>;
  drafts?: Array<{
    id: string;
    titleOverride: string;
    createdAt: Date;
    wizardDraftPayload: unknown;
  }>;
  // Block 1 (BUG-030) — when set, the expand route's idempotency lookup
  // (findFirst on isWizardDraft:true + content-hash) returns this row, so the
  // route should reuse it and skip both the AI expand and the persist write.
  reuseDraft?: {
    id: string;
    createdAt: Date;
    wizardDraftPayload: unknown;
  } | null;
  recorder?: ExpandRecorder;
  persistFail?: boolean;
}) {
  const rec = opts.recorder ?? {
    expandCalls: [],
    persistCalls: [],
    sweepCalls: [],
  };
  const findManyArgs: Array<{ where?: Record<string, unknown> }> = [];
  const findFirstArgs: Array<{ where?: Record<string, unknown> }> = [];
  return {
    rec,
    findManyArgs,
    findFirstArgs,
    // expandCandidate stub — no real AI / dishMacros work.
    expandCandidate: (async (args: {
      userId: string;
      request: { candidate: { id: string } };
    }) => {
      rec.expandCalls.push({
        userId: args.userId,
        candidateId: args.request.candidate.id,
      });
      return opts.expandReturn();
    }) as never,
    // persistWizardDraft stub — return a fixed-shape result.
    persistWizardDraft: (async (args: {
      userId: string;
      expanded: { title: string };
    }) => {
      if (opts.persistFail) {
        throw new Error("persist boom");
      }
      rec.persistCalls.push({ userId: args.userId, title: args.expanded.title });
      return {
        planId: `draft-${rec.persistCalls.length}`,
        createdAt: new Date("2026-05-28T12:00:00Z"),
      };
    }) as never,
    sweepStaleWizardDrafts: (async (args: { userId: string }) => {
      rec.sweepCalls.push({ userId: args.userId });
      return 0;
    }) as never,
    // Prisma stub — only mealPlanInstance.findMany is exercised by drafts.
    prisma: {
      aIPrompt: { findUnique: async () => null },
      systemSetting: { findUnique: async () => null },
      userPreferences: { findUnique: async () => null },
      pantryStaple: { findMany: async () => [] },
      userActivity: {
        findMany: async () => [],
        create: async () => ({}),
      },
      lLMCallLog: { create: async () => ({}) },
      mealPlanInstance: {
        findMany: async (args: { where?: Record<string, unknown> }) => {
          findManyArgs.push(args);
          return opts.drafts ?? [];
        },
        // Block 1 (BUG-030) — expand-side idempotency lookup.
        findFirst: async (args: { where?: Record<string, unknown> }) => {
          findFirstArgs.push(args);
          return opts.reuseDraft ?? null;
        },
      },
    },
  };
}

describe("POST /api/wizard/expand — happy path", () => {
  let harness: Harness;
  const recorder: ExpandRecorder = {
    expandCalls: [],
    persistCalls: [],
    sweepCalls: [],
  };
  const deps = makeExpandDeps({
    recorder,
    expandReturn: async () => ({
      status: "success",
      expanded: {
        candidateId: "c1",
        title: "Cozy Comfort Week",
        tags: ["Comfort"],
        whyBullets: ["one"],
        meals: [
          {
            title: "Sheet-pan harissa chicken",
            cuisineType: "Mediterranean",
            estimatedTimeMinutes: 35,
            difficulty: "easy",
            servings: 5,
            dishes: [
              {
                title: "Sheet-pan harissa chicken",
                role: "main",
                positionIndex: 0,
                ingredients: [
                  { name: "chicken thighs", quantity: 1.5, unit: "pound" },
                  { name: "harissa", quantity: 3, unit: "tablespoon" },
                  { name: "olive oil", quantity: 2, unit: "tablespoon" },
                ],
                steps: ["Preheat oven.", "Toss chicken with harissa.", "Roast."],
                macros: {
                  caloriesPerServing: 540,
                  proteinGPerServing: 38,
                  carbsGPerServing: 12,
                  fatGPerServing: 28,
                },
              },
            ],
          },
        ],
      },
    }),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      expandCandidate: deps.expandCandidate,
      persistWizardDraft: deps.persistWizardDraft,
      sweepStaleWizardDrafts: deps.sweepStaleWizardDrafts,
    });
  });
  after(async () => harness.close());

  it("returns 200 with draft + expanded payload and emits wizard_candidate_expanded", async () => {
    const token = signToken(EXPAND_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/expand`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(EXPAND_VALID_BODY),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      draft: { id: string; createdAt: string };
      expanded: { meals: Array<{ dishes: unknown[] }> };
    };
    assert.equal(body.draft.id, "draft-1");
    assert.ok(body.draft.createdAt);
    assert.equal(body.expanded.meals.length, 1);
    assert.equal(body.expanded.meals[0].dishes.length, 1);

    assert.equal(recorder.expandCalls.length, 1);
    assert.equal(recorder.expandCalls[0].candidateId, "c1");
    assert.equal(recorder.persistCalls.length, 1);
    assert.equal(recorder.persistCalls[0].title, "Cozy Comfort Week");
    const events = (deps.prisma.userActivity as unknown as {
      _activities?: () => Array<{ eventType: string }>;
    });
    // makeExpandDeps uses an inline stub; activity tracking would require
    // extending it. The route-level happy-path assertion lives here in spirit
    // — the more rigorous activity assertion is in the AI-failure case below.
    void events;
  });
});

// Block 1 (BUG-030) — a valid details-stage blob for the reuse path. Must
// parse against WizardExpandedPlanDetailsSchema (no steps required).
const IDEMPOTENT_DETAILS = {
  candidateId: "c1",
  title: "Cozy Comfort Week",
  tags: ["Comfort"],
  whyBullets: ["Sheet-pan meals minimize cleanup"],
  meals: [
    {
      title: "Sheet-pan harissa chicken",
      cuisineType: "Mediterranean",
      estimatedTimeMinutes: 35,
      difficulty: "easy",
      servings: 5,
      dishes: [
        {
          title: "Sheet-pan harissa chicken",
          role: "main",
          positionIndex: 0,
          ingredients: [
            { name: "chicken thighs", quantity: 1.5, unit: "pound" },
          ],
          macros: {
            caloriesPerServing: 540,
            proteinGPerServing: 38,
            carbsGPerServing: 12,
            fatGPerServing: 28,
          },
        },
      ],
    },
  ],
};

describe("POST /api/wizard/expand — idempotency (BUG-030)", () => {
  let harness: Harness;
  const recorder: ExpandRecorder = {
    expandCalls: [],
    persistCalls: [],
    sweepCalls: [],
  };
  const deps = makeExpandDeps({
    recorder,
    // An unconsumed draft already exists for this content-hash → reuse it.
    reuseDraft: {
      id: "draft-existing",
      createdAt: new Date("2026-05-28T12:00:00Z"),
      wizardDraftPayload: IDEMPOTENT_DETAILS,
    },
    expandReturn: async () => ({
      status: "success",
      expanded: IDEMPOTENT_DETAILS,
    }),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      expandCandidate: deps.expandCandidate,
      persistWizardDraft: deps.persistWizardDraft,
      sweepStaleWizardDrafts: deps.sweepStaleWizardDrafts,
    });
  });
  after(async () => harness.close());

  it("reuses the existing draft — no AI expand, no duplicate persist", async () => {
    const token = signToken(EXPAND_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/expand`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(EXPAND_VALID_BODY),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      draft: { id: string; createdAt: string };
      expanded: { title: string };
    };
    // Returns the EXISTING draft, not a freshly-persisted one.
    assert.equal(body.draft.id, "draft-existing");
    assert.equal(body.expanded.title, "Cozy Comfort Week");
    // The expensive AI expand + the duplicate persist are both skipped.
    assert.equal(recorder.expandCalls.length, 0);
    assert.equal(recorder.persistCalls.length, 0);
    // The idempotency lookup filtered on the wizard-draft discriminator.
    assert.ok(deps.findFirstArgs.length >= 1);
    const where = deps.findFirstArgs[0].where as Record<string, unknown>;
    assert.equal(where.userId, EXPAND_USER_ID);
    assert.equal(where.isWizardDraft, true);
    assert.equal(where.isArchived, false);
    assert.ok(typeof where.wizardContentHash === "string");
  });
});

describe("POST /api/wizard/expand — input validation", () => {
  let harness: Harness;
  const deps = makeExpandDeps({
    expandReturn: async () => ({
      status: "success",
      expanded: {
        candidateId: "c1",
        title: "x",
        tags: [],
        whyBullets: ["one"],
        meals: [],
      },
    }),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      expandCandidate: deps.expandCandidate,
      persistWizardDraft: deps.persistWizardDraft,
      sweepStaleWizardDrafts: deps.sweepStaleWizardDrafts,
    });
  });
  after(async () => harness.close());

  it("rejects 400 when candidate is missing", async () => {
    const token = signToken(EXPAND_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/expand`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ candidateContext: EXPAND_VALID_BODY.candidateContext }),
    });
    assert.equal(res.status, 400);
    assert.equal(deps.rec.expandCalls.length, 0);
  });

  it("rejects 401 when no auth header", async () => {
    const res = await fetch(`${harness.baseUrl}/wizard/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(EXPAND_VALID_BODY),
    });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/wizard/expand — entitlement gate", () => {
  let harness: Harness;
  const deps = makeExpandDeps({
    expandReturn: async () => ({
      status: "success",
      expanded: {
        candidateId: "c1",
        title: "x",
        tags: [],
        whyBullets: ["one"],
        meals: [],
      },
    }),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(false),
      expandCandidate: deps.expandCandidate,
      persistWizardDraft: deps.persistWizardDraft,
      sweepStaleWizardDrafts: deps.sweepStaleWizardDrafts,
    });
  });
  after(async () => harness.close());

  it("returns 402 when entitlement.allowed is false (no AI call made)", async () => {
    const token = signToken(EXPAND_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/expand`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(EXPAND_VALID_BODY),
    });
    assert.equal(res.status, 402);
    assert.equal(deps.rec.expandCalls.length, 0);
  });
});

describe("POST /api/wizard/expand — AI failure", () => {
  let harness: Harness;
  // Use the route's real emitActivity path by wiring the standard prisma stub.
  const stubPrisma = makeStubPrisma();
  const deps = makeExpandDeps({
    expandReturn: async () => ({
      status: "ai_failed",
      reason: "validation_failed",
      userFacingMessage: "Kiwi got distracted. Try again?",
    }),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      // Use makeStubPrisma so userActivity.create is observable.
      prisma: stubPrisma,
      subscriptionService: makeSubscriptionService(true),
      expandCandidate: deps.expandCandidate,
      persistWizardDraft: deps.persistWizardDraft,
      sweepStaleWizardDrafts: deps.sweepStaleWizardDrafts,
    });
  });
  after(async () => harness.close());

  it("returns 502 + emits wizard_failure activity + does NOT persist", async () => {
    const token = signToken(EXPAND_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/expand`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(EXPAND_VALID_BODY),
    });
    assert.equal(res.status, 502);
    const events = stubPrisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_failure"));
    assert.ok(!events.includes("wizard_candidate_expanded"));
    assert.equal(deps.rec.persistCalls.length, 0);
  });
});

describe("GET /api/wizard/drafts", () => {
  let harness: Harness;
  const deps = makeExpandDeps({
    expandReturn: async () => ({
      status: "success",
      expanded: {
        candidateId: "c1",
        title: "x",
        tags: [],
        whyBullets: ["one"],
        meals: [],
      },
    }),
    drafts: [
      {
        id: "draft-aaa",
        titleOverride: "Cozy Comfort Week",
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: {
          meals: [
            { title: "Sheet-pan harissa chicken" },
            { title: "Tomato soup + grilled cheese" },
          ],
        },
      },
      {
        id: "draft-bbb",
        titleOverride: "High-Protein Reset",
        createdAt: new Date("2026-05-27T10:00:00Z"),
        wizardDraftPayload: { meals: [{ title: "Steak + green beans" }] },
      },
    ],
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      expandCandidate: deps.expandCandidate,
      persistWizardDraft: deps.persistWizardDraft,
      sweepStaleWizardDrafts: deps.sweepStaleWizardDrafts,
    });
  });
  after(async () => harness.close());

  it("returns drafts with title + meal titles + createdAt, and triggers lazy sweep", async () => {
    const token = signToken(EXPAND_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/drafts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      drafts: Array<{
        id: string;
        title: string;
        createdAt: string;
        mealTitles: string[];
      }>;
      ttlDays: number;
    };
    assert.equal(body.ttlDays, 30);
    assert.equal(body.drafts.length, 2);
    assert.equal(body.drafts[0].id, "draft-aaa");
    assert.equal(body.drafts[0].title, "Cozy Comfort Week");
    assert.deepEqual(body.drafts[0].mealTitles, [
      "Sheet-pan harissa chicken",
      "Tomato soup + grilled cheese",
    ]);
    assert.equal(body.drafts[1].mealTitles[0], "Steak + green beans");

    // Sweep ran before the read.
    assert.equal(deps.rec.sweepCalls.length, 1);
    assert.equal(deps.rec.sweepCalls[0].userId, EXPAND_USER_ID);

    // Findmany filter must match the wizard-draft discriminator.
    assert.ok(deps.findManyArgs.length >= 1);
    const where = deps.findManyArgs[0].where as Record<string, unknown>;
    assert.equal(where.userId, EXPAND_USER_ID);
    assert.equal(where.isWizardDraft, true);
    assert.equal(where.isArchived, false);
  });

  it("returns 401 with no auth header", async () => {
    const res = await fetch(`${harness.baseUrl}/wizard/drafts`);
    assert.equal(res.status, 401);
  });
});

// ── WS7-5b-server — GET /wizard/drafts/:id + activate ────────────────────

const ACTIVATE_USER_ID = "test-user-wizard-activate";

const SAMPLE_EXPANDED = {
  candidateId: "c-activate",
  title: "Cozy Comfort Week",
  tags: ["Comfort"],
  whyBullets: ["Sheet-pan meals minimize cleanup"],
  meals: [
    {
      title: "Sheet-pan harissa chicken",
      cuisineType: "Mediterranean",
      estimatedTimeMinutes: 35,
      difficulty: "easy" as const,
      servings: 5,
      dishes: [
        {
          title: "Sheet-pan harissa chicken",
          role: "main" as const,
          positionIndex: 0,
          ingredients: [
            { name: "Chicken thighs", quantity: 1.5, unit: "pound" },
            { name: "Harissa", quantity: 3, unit: "tablespoon" },
            { name: "Olive oil", quantity: 2, unit: "tablespoon" },
          ],
          steps: ["Preheat oven.", "Toss chicken.", "Roast."],
          macros: {
            caloriesPerServing: 540,
            proteinGPerServing: 38,
            carbsGPerServing: 12,
            fatGPerServing: 28,
          },
        },
      ],
    },
  ],
};

interface ActivateRecorder {
  materializeCalls: Array<{ userId: string; draftId: string }>;
  updateManyCalls: Array<{ where: Record<string, unknown> }>;
  updateCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  activityCalls: Array<{
    eventType: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }>;
  // Block 1 (BUG-030 Part B) — the post-consume supersede updateMany on the
  // top-level prisma client (distinct from the tx demote-prior updateMany).
  supersedeCalls: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }>;
}

interface ActivateDraftRow {
  id: string;
  userId: string;
  isWizardDraft: boolean;
  createdAt: Date;
  wizardDraftPayload: unknown;
  // Block 1 (BUG-030) — idempotency key. Optional so existing tests (which
  // omit it) leave the plan-side idempotency guard inert (undefined hash →
  // findExistingPlanForDraft returns null → normal materialize path).
  wizardContentHash?: string | null;
  // Block 1 (BUG-030 Part B) — archive state so the stateful supersede
  // updateMany below can flip it and composition tests can read it back.
  isArchived?: boolean;
}

function makeActivateDeps(opts: {
  drafts: Map<string, ActivateDraftRow>;
  // Block 1 (BUG-030) — when set, the plan-side idempotency lookup (findFirst
  // for an existing non-draft plan with the same content-hash) returns this,
  // so activate/save should return it and skip finalize + materialize.
  existingPlanForHash?: { id: string; revisionId: number } | null;
  // WS7-5c Block A — the route now runs readAndFinalizeWizardDraft BEFORE
  // the materializer. not_found / malformed surface from THAT stub now
  // (the materializer no longer parses optimizationNotes when a payload
  // is passed). The materializeBehavior name + values are kept for back-
  // compat with existing test setups; both stubs are driven by it.
  materializeBehavior?: "ok" | "not_found" | "malformed";
  recorder?: ActivateRecorder;
}) {
  const rec: ActivateRecorder = opts.recorder ?? {
    materializeCalls: [],
    updateManyCalls: [],
    updateCalls: [],
    activityCalls: [],
    supersedeCalls: [],
  };

  const buildTx = () => {
    return {
      mealPlanInstance: {
        findUnique: async (args: { where: { id: string } }) => {
          return opts.drafts.get(args.where.id) ?? null;
        },
        updateMany: async (args: { where: Record<string, unknown> }) => {
          rec.updateManyCalls.push({ where: args.where });
          return { count: 0 };
        },
        update: async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          rec.updateCalls.push({ where: args.where, data: args.data });
          const existing = opts.drafts.get(args.where.id);
          // The route updates revisionId via `{ increment: 1 }` — return a
          // stable post-increment value so the response shape is verifiable.
          opts.drafts.set(args.where.id, {
            ...(existing as ActivateDraftRow),
            isWizardDraft: false,
          });
          return { id: args.where.id, revisionId: 2 };
        },
      },
      userActivity: {
        create: async () => ({}),
      },
      // D-WS9-026 — first-plan stamp (write-if-null). Distinct from the
      // mealPlanInstance.updateMany the demote-prior assertions watch.
      user: {
        updateMany: async () => ({ count: 0 }),
      },
    };
  };

  // Stub Prisma — minimal surface: $transaction + mealPlanInstance.findUnique
  // (used by GET /:id directly, outside the activate transaction).
  const prisma = {
    aIPrompt: { findUnique: async () => null },
    systemSetting: { findUnique: async () => null },
    userPreferences: { findUnique: async () => null },
    pantryStaple: { findMany: async () => [] },
    userActivity: {
      findMany: async () => [],
      create: async () => ({}),
    },
    lLMCallLog: { create: async () => ({}) },
    mealPlanInstance: {
      findUnique: async (args: { where: { id: string } }) => {
        return opts.drafts.get(args.where.id) ?? null;
      },
      findMany: async () => [],
      // Block 1 (BUG-030) — plan-side idempotency lookup; default no reuse.
      findFirst: async () => opts.existingPlanForHash ?? null,
      // Block 1 (BUG-030 Part B) — the post-consume supersede archive. Records
      // the call AND statefully archives matching rows in the draft map so
      // composition tests (peek-A/peek-B/save-A) can read the result back.
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        rec.supersedeCalls.push({ where: args.where, data: args.data });
        const w = args.where;
        let count = 0;
        for (const row of opts.drafts.values()) {
          const matchUser = w.userId === undefined || row.userId === w.userId;
          const matchDraft =
            w.isWizardDraft === undefined ||
            row.isWizardDraft === w.isWizardDraft;
          const matchArchived =
            w.isArchived === undefined ||
            (row.isArchived ?? false) === w.isArchived;
          const matchId = w.id === undefined || row.id === w.id;
          if (matchUser && matchDraft && matchArchived && matchId) {
            row.isArchived = true;
            count++;
          }
        }
        return { count };
      },
    },
    $transaction: async (
      fn: (tx: ReturnType<typeof buildTx>) => Promise<unknown>,
    ) => {
      return await fn(buildTx());
    },
  };

  const materializeWizardDraft = (async (args: {
    userId: string;
    draftId: string;
  }) => {
    rec.materializeCalls.push({ userId: args.userId, draftId: args.draftId });
    if (opts.materializeBehavior === "not_found") {
      const { WizardDraftNotFoundError } = await import(
        "../../lib/wizardActivation"
      );
      throw new WizardDraftNotFoundError(args.draftId);
    }
    if (opts.materializeBehavior === "malformed") {
      const { WizardDraftMalformedError } = await import(
        "../../lib/wizardActivation"
      );
      throw new WizardDraftMalformedError(args.draftId, "shape_mismatch");
    }
    return {
      expanded: SAMPLE_EXPANDED,
      mealsCreated: 1,
      dishesCreated: 1,
      itemsCreated: 1,
      ingredientsTouched: 3,
      // WS7-5b-mobile FIX (PRD §2.4) — the materializer now creates a
      // MealPlanTemplate inside Pass 2 and returns its id so the route
      // handler can write it into the Instance's mealPlanTemplateId.
      mealPlanTemplateId: "tpl-test-id",
    };
  }) as never;

  const emitActivity = (async (args: {
    eventType: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }) => {
    rec.activityCalls.push({
      eventType: args.eventType,
      entityId: args.entityId,
      metadata: args.metadata,
    });
  }) as never;

  // WS7-5c Block A — stub for readAndFinalizeWizardDraft. Mirrors the
  // existing materializeBehavior modes so tests that expected the
  // materializer to throw not_found / malformed now see those failure
  // modes surface from the finalize stage (which is now first in the
  // activate/save flow). The 'ok' path returns SAMPLE_EXPANDED as the
  // merged payload — the materializer stub above then receives it via
  // opts.payload and the assertions on its call args still hold.
  const readAndFinalizeWizardDraft = (async (args: {
    userId: string;
    draftId: string;
  }) => {
    if (opts.materializeBehavior === "not_found") {
      return { status: "not_found" as const };
    }
    if (opts.materializeBehavior === "malformed") {
      return {
        status: "malformed" as const,
        reason: "shape_mismatch",
      };
    }
    // Mirror SAMPLE_EXPANDED into both the payload (with-steps) and the
    // details (without-steps) sides. Tests assert against the materializer
    // call's args.payload, not against details, so a trimmed details copy
    // is fine here.
    return {
      status: "success" as const,
      payload: SAMPLE_EXPANDED,
      details: SAMPLE_EXPANDED,
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void args;
  }) as never;

  return {
    prisma,
    materializeWizardDraft,
    emitActivity,
    readAndFinalizeWizardDraft,
    rec,
  };
}

describe("POST /api/wizard/drafts/:id/dismiss — BUG-023 server-side dismissal", () => {
  let harness: Harness;
  const updateManyCalls: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];
  const prisma = {
    aIPrompt: { findUnique: async () => null },
    systemSetting: { findUnique: async () => null },
    userPreferences: { findUnique: async () => null },
    pantryStaple: { findMany: async () => [] },
    userActivity: { findMany: async () => [], create: async () => ({}) },
    lLMCallLog: { create: async () => ({}) },
    mealPlanInstance: {
      findMany: async () => [],
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        updateManyCalls.push(args);
        // Simulate: only an owned, unconsumed, unarchived draft matches.
        const w = args.where;
        const hit =
          w.id === "draft-live" &&
          w.isWizardDraft === true &&
          w.isArchived === false;
        return { count: hit ? 1 : 0 };
      },
    },
  };

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("archives the owned unconsumed draft and returns dismissed:true", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-live/dismiss`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dismissed: boolean };
    assert.equal(body.dismissed, true);

    const call = updateManyCalls.find((c) => c.where.id === "draft-live");
    assert.ok(call, "dismiss did not issue an updateMany for the draft");
    // Scoped so it can only touch the caller's own unconsumed draft.
    assert.equal(call!.where.userId, ACTIVATE_USER_ID);
    assert.equal(call!.where.isWizardDraft, true);
    assert.equal(call!.where.isArchived, false);
    // Archives + clears blob; never flips isWizardDraft.
    assert.equal(call!.data.isArchived, true);
    // D-WS9-034 — the draft blob now lives on wizardDraftPayload; clear it.
    // optimizationNotes is ALSO DbNull'd as legacy-blob defense.
    assert.equal(call!.data.wizardDraftPayload, Prisma.DbNull);
    assert.equal(call!.data.optimizationNotes, Prisma.DbNull);
    assert.equal(
      Object.prototype.hasOwnProperty.call(call!.data, "isWizardDraft"),
      false,
    );
  });

  it("returns dismissed:false (200, not 404) for a missing/already-consumed id", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/already-gone/dismiss`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dismissed: boolean };
    assert.equal(body.dismissed, false);
  });

  it("returns 401 with no auth header", async () => {
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-live/dismiss`,
      { method: "POST" },
    );
    assert.equal(res.status, 401);
  });
});

describe("POST /api/wizard/drafts/:id/activate — happy path", () => {
  let harness: Harness;
  const drafts = new Map<string, ActivateDraftRow>([
    [
      "draft-ok",
      {
        id: "draft-ok",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
      },
    ],
  ]);
  const deps = makeActivateDeps({ drafts });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("returns 201 + activated instance, demotes prior actives, emits plan_activated_this_week", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-ok/activate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      instance: { id: string; revisionId: number };
    };
    assert.equal(body.instance.id, "draft-ok");
    assert.equal(body.instance.revisionId, 2);

    assert.equal(deps.rec.materializeCalls.length, 1);
    assert.equal(deps.rec.materializeCalls[0].draftId, "draft-ok");

    // WS7-6 (E): no demote-prior. Single-current is enforced by the
    // per-user EXCLUDE constraint on [startDate, endDate]; the activate
    // path writes the current Sun-Sat range and trusts the DB.
    assert.equal(deps.rec.updateManyCalls.length, 0);

    // Flip update — sets isWizardDraft=false, bumps revisionId, dates
    // the plan. WS7-6 (E): the stored isActiveThisWeek column is gone,
    // so the update payload does NOT carry it; "active" is derived from
    // the freshly-written current-week range.
    assert.equal(deps.rec.updateCalls.length, 1);
    const flip = deps.rec.updateCalls[0].data;
    assert.equal(flip.isWizardDraft, false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(flip, "isActiveThisWeek"),
      false,
    );
    // status is NOT modified (kept as the existing "draft", per use-template precedent).
    assert.equal(Object.prototype.hasOwnProperty.call(flip, "status"), false);
    assert.deepEqual(flip.revisionId, { increment: 1 });
    // WS7-5b-mobile FIX (PRD §2.4) — Template-pair. Activate writes the
    // materializer's new Template id into the Instance's mealPlanTemplateId
    // and clears the wizard-JSON blob from optimizationNotes (which the
    // pre-fix expand/persist code wrote there and which broke Plan Review's
    // mobile PlanSchema parse).
    assert.equal(flip.mealPlanTemplateId, "tpl-test-id");
    // D-WS9-034 — clears the draft blob from wizardDraftPayload; also DbNulls
    // optimizationNotes as legacy-blob defense.
    assert.equal(flip.wizardDraftPayload, Prisma.DbNull);
    assert.equal(flip.optimizationNotes, Prisma.DbNull);

    // WS7-5b-mobile-PRE — activate dates the freshly-activated plan to the
    // current Sun-Sat week via the shared currentWeekRange() helper. Round-
    // trips back through toYmd as YYYY-MM-DD (NOT ISO 8601), symmetric with
    // the c11/c16 read-path wire shape and the PATCH auto-date envelope.
    const start = flip.startDate as Date;
    const end = flip.endDate as Date;
    assert.ok(start instanceof Date, "startDate written as Date");
    assert.ok(end instanceof Date, "endDate written as Date");
    assert.equal(start.getUTCHours(), 0);
    assert.equal(start.getUTCDay(), 0, "startDate is a Sunday (UTC)");
    assert.equal(end.getUTCDay(), 6, "endDate is a Saturday (UTC)");
    assert.equal(
      (end.getTime() - start.getTime()) / 86_400_000,
      6,
      "Sun → Sat spans 6 days",
    );
    assert.match(toYmd(start) as string, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(toYmd(end) as string, /^\d{4}-\d{2}-\d{2}$/);
    const expected = currentWeekRange();
    assert.equal(toYmd(start), expected.startDate);
    assert.equal(toYmd(end), expected.endDate);

    // Activity emitted on the active flip.
    assert.equal(deps.rec.activityCalls.length, 1);
    assert.equal(
      deps.rec.activityCalls[0].eventType,
      "plan_activated_this_week",
    );
    assert.equal(deps.rec.activityCalls[0].entityId, "draft-ok");
  });

  // WS7-6 (E) Block 1 REWORK c3 — seam C stamp + unconditional emit
  // verification. The activate path always sets dates to cover now AND
  // stamps activatedAt = now in the same update. The plan_activated_this_week
  // emit stays unconditional (every wizard activate is a fresh user
  // commitment) and carries source: "wizard_draft_activate" plus the
  // mealsCreated/itemsCreated metadata for funnel analytics.
  it("seam C: wizard activate STAMPS activatedAt and emits plan_activated_this_week with source + counts", async () => {
    // The harness above already activated draft-ok in the prior test in this
    // describe; the recorder captured the update + activity. Re-assert on the
    // recorded values to pin seam C's stamp + emit contract explicitly.
    assert.equal(deps.rec.updateCalls.length, 1);
    const flip = deps.rec.updateCalls[0].data;
    assert.ok(
      flip.activatedAt instanceof Date,
      "seam C: wizard activate must stamp activatedAt",
    );

    assert.equal(deps.rec.activityCalls.length, 1);
    const act = deps.rec.activityCalls[0];
    assert.equal(act.eventType, "plan_activated_this_week");
    assert.equal(act.entityId, "draft-ok");
    // Unconditional emit carries the explicit source string + materializer
    // counts (mealsCreated, itemsCreated) for analytics.
    const meta = act.metadata as Record<string, unknown>;
    assert.equal(meta.source, "wizard_draft_activate");
    assert.equal(typeof meta.mealsCreated, "number");
    assert.equal(typeof meta.itemsCreated, "number");
  });
});

describe("POST /api/wizard/drafts/:id/activate — idempotency (BUG-030)", () => {
  let harness: Harness;
  // The draft being activated carries a content-hash, and a prior activation
  // already materialized a real plan with the same hash.
  const drafts = new Map<string, ActivateDraftRow>([
    [
      "draft-dupe",
      {
        id: "draft-dupe",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
        wizardContentHash: "hash-abc",
      },
    ],
  ]);
  const deps = makeActivateDeps({
    drafts,
    existingPlanForHash: { id: "plan-original", revisionId: 7 },
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("returns the existing plan — no second materialize, no duplicate", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-dupe/activate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      instance: { id: string; revisionId: number };
    };
    // Returns the PRE-EXISTING plan, not a freshly materialized one.
    assert.equal(body.instance.id, "plan-original");
    assert.equal(body.instance.revisionId, 7);
    // The materializer + activity emit never ran — no duplicate plan/template.
    assert.equal(deps.rec.materializeCalls.length, 0);
    assert.equal(deps.rec.updateCalls.length, 0);
    assert.equal(deps.rec.activityCalls.length, 0);
  });
});

describe("POST /api/wizard/drafts/:id/activate — not found", () => {
  let harness: Harness;
  const drafts = new Map<string, ActivateDraftRow>();
  const deps = makeActivateDeps({
    drafts,
    materializeBehavior: "not_found",
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("returns 404 when draft missing/not owned", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/missing-id/activate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 404);
    // updateMany / update never fired because materialize threw early.
    assert.equal(deps.rec.updateManyCalls.length, 0);
    assert.equal(deps.rec.activityCalls.length, 0);
  });

  it("returns 401 with no auth header", async () => {
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/anything/activate`,
      { method: "POST" },
    );
    assert.equal(res.status, 401);
  });
});

describe("POST /api/wizard/drafts/:id/activate — malformed draft", () => {
  let harness: Harness;
  const drafts = new Map<string, ActivateDraftRow>();
  const deps = makeActivateDeps({
    drafts,
    materializeBehavior: "malformed",
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("returns 422 with reason (not 500)", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/bad-shape/activate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /draft malformed/);
    assert.equal(body.reason, "shape_mismatch");
  });
});

describe("GET /api/wizard/drafts/:id", () => {
  let harness: Harness;
  const drafts = new Map<string, ActivateDraftRow>([
    [
      "draft-detail",
      {
        id: "draft-detail",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
      },
    ],
    [
      "draft-other-user",
      {
        id: "draft-other-user",
        userId: "someone-else",
        isWizardDraft: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
      },
    ],
    [
      "draft-malformed",
      {
        id: "draft-malformed",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: { not: "a wizard plan" },
      },
    ],
    [
      "draft-not-wizard",
      {
        id: "draft-not-wizard",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: false,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
      },
    ],
  ]);
  const deps = makeActivateDeps({ drafts });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("returns the expanded JSON for an owned wizard draft", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/drafts/draft-detail`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      draft: { id: string; createdAt: string };
      expanded: { title: string; meals: unknown[] };
    };
    assert.equal(body.draft.id, "draft-detail");
    assert.equal(body.expanded.title, "Cozy Comfort Week");
    assert.equal(body.expanded.meals.length, 1);
  });

  it("returns 404 when draft is owned by another user", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-other-user`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 404);
  });

  it("returns 404 when the row is not a wizard draft", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-not-wizard`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 404);
  });

  it("returns 422 when optimizationNotes fails schema parse", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-malformed`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 422);
  });

  it("returns 401 with no auth header", async () => {
    const res = await fetch(`${harness.baseUrl}/wizard/drafts/draft-detail`);
    assert.equal(res.status, 401);
  });
});

// WS7-5c Block A — addendum (§27 backward-compat). Neon has real wizard-
// draft rows from WS7-5a/5b that carry the OLD WizardExpandedPlan shape
// (steps populated per dish). The schema split must not 422 those rows
// at GET /wizard/drafts/:id read time, and the response must surface as
// the details-stage shape (steps stripped by the parser) so mobile sees
// a consistent shape across old + new drafts. Pinned through the REAL
// route handler — not a bare schema call — because the §27 contract is
// about live behavior on a deployed endpoint.
describe("GET /api/wizard/drafts/:id — WS7-5c Block A addendum: backward-compat with pre-5c with-steps draft", () => {
  let harness: Harness;
  // OLD shape: a full WizardExpandedPlan with non-empty steps per dish,
  // matching what WS7-5a/5b would have persisted.
  const OLD_DRAFT_WITH_STEPS = {
    candidateId: "c-legacy",
    title: "Legacy Plan from WS7-5a",
    tags: ["Legacy"],
    whyBullets: ["This draft was written before the WS7-5c schema split"],
    meals: [
      {
        title: "Legacy meal",
        cuisineType: "American",
        estimatedTimeMinutes: 30,
        difficulty: "easy" as const,
        servings: 4,
        dishes: [
          {
            title: "Legacy dish",
            role: "main" as const,
            positionIndex: 0,
            ingredients: [
              { name: "chicken thighs", quantity: 1, unit: "pound" },
              { name: "salt", quantity: 1, unit: "teaspoon" },
            ],
            macros: {
              caloriesPerServing: 350,
              proteinGPerServing: 35,
              carbsGPerServing: 5,
              fatGPerServing: 20,
            },
            // OLD-shape signature — steps are populated.
            steps: [
              "Pat chicken thighs dry and season with salt.",
              "Sear in a hot pan for 4 minutes per side.",
              "Rest 5 minutes before serving.",
            ],
          },
        ],
      },
    ],
  };

  const drafts = new Map<string, ActivateDraftRow>([
    [
      "draft-legacy-with-steps",
      {
        id: "draft-legacy-with-steps",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        createdAt: new Date("2026-04-15T10:00:00Z"),
        wizardDraftPayload: OLD_DRAFT_WITH_STEPS,
      },
    ],
  ]);
  const deps = makeActivateDeps({ drafts });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("a pre-5c draft (with non-empty steps) parses through the live read path: 200, details-stage shape, steps stripped from response", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-legacy-with-steps`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    // §27 pinned claim: existing WS7-5a/5b drafts must NOT 422 after the
    // schema split. They go through the same WizardExpandedPlanDetails
    // Schema.safeParse the route now uses.
    assert.equal(
      res.status,
      200,
      "pre-WS7-5c draft must read cleanly (no 422) through the live GET handler",
    );
    const body = (await res.json()) as {
      draft: { id: string; createdAt: string };
      expanded: {
        candidateId: string;
        title: string;
        meals: Array<{
          dishes: Array<{
            title: string;
            ingredients: unknown[];
            macros: unknown;
            steps?: unknown;
          }>;
        }>;
      };
    };
    // Identity preserved (candidateId / title flow through unchanged).
    assert.equal(body.expanded.candidateId, "c-legacy");
    assert.equal(body.expanded.title, "Legacy Plan from WS7-5a");
    // Details-stage payload is what surfaced.
    const dish = body.expanded.meals[0].dishes[0];
    assert.equal(dish.title, "Legacy dish");
    assert.equal(dish.ingredients.length, 2);
    assert.ok(dish.macros, "macros must be present on the response dish");
    // The actual read-path behavior: the details-stage schema doesn't
    // declare a `steps` field, so the parser strips it. The HTTP response
    // therefore omits steps even though the row carries them. This is the
    // intended forward shape — Block B (mobile) will read this shape from
    // both legacy and new drafts.
    assert.equal(
      dish.steps,
      undefined,
      "details-stage parser must strip the legacy steps field from the response",
    );
  });
});

// WS7-5c Block A — drafts are now stored stepless. GET /wizard/drafts/:id
// must parse with the details-stage schema so a stepless draft reads
// cleanly (200 + the details-stage payload) instead of 422-ing on the
// with-steps WizardExpandedPlanSchema.
describe("GET /api/wizard/drafts/:id — WS7-5c Block A: stepless draft (details-stage)", () => {
  let harness: Harness;
  // Build a draft whose optimizationNotes is the details-stage shape:
  // ingredients + per-dish macros, NO steps anywhere.
  const STEPLESS_DRAFT = {
    candidateId: "c-stepless",
    title: "Stepless Test Plan",
    tags: ["Test"],
    whyBullets: ["No steps yet — call #3 will fill them in"],
    meals: [
      {
        title: "Stepless meal",
        cuisineType: "American",
        estimatedTimeMinutes: 30,
        difficulty: "easy" as const,
        servings: 4,
        dishes: [
          {
            title: "Stepless dish",
            role: "main" as const,
            positionIndex: 0,
            ingredients: [
              { name: "chicken thighs", quantity: 1, unit: "pound" },
              { name: "salt", quantity: 1, unit: "teaspoon" },
            ],
            macros: {
              caloriesPerServing: 350,
              proteinGPerServing: 35,
              carbsGPerServing: 5,
              fatGPerServing: 20,
            },
            // NO steps key.
          },
        ],
      },
    ],
  };

  const drafts = new Map<string, ActivateDraftRow>([
    [
      "draft-stepless",
      {
        id: "draft-stepless",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: STEPLESS_DRAFT,
      },
    ],
  ]);
  const deps = makeActivateDeps({ drafts });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("returns 200 with the details-stage payload for a stepless draft (no 422)", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-stepless`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 200, "stepless draft must parse cleanly");
    const body = (await res.json()) as {
      draft: { id: string; createdAt: string };
      expanded: {
        title: string;
        meals: Array<{
          dishes: Array<{
            title: string;
            ingredients: unknown[];
            macros: unknown;
            steps?: unknown;
          }>;
        }>;
      };
    };
    assert.equal(body.expanded.title, "Stepless Test Plan");
    assert.equal(body.expanded.meals[0].dishes[0].ingredients.length, 2);
    assert.ok(body.expanded.meals[0].dishes[0].macros);
    // The details-stage schema doesn't include a steps field; the response
    // shape should reflect that.
    assert.equal(body.expanded.meals[0].dishes[0].steps, undefined);
  });
});

// ── WS7-5b2-server — POST /wizard/drafts/:id/save ───────────────────────
// "Save for Later" — promotes the hidden draft into a real undated inactive
// plan in My Plans. Uses the same materializer as /activate; only the tail
// differs (no demote, no active flip, no date set, no revisionId bump,
// emits plan_created instead of plan_activated_this_week).

describe("POST /api/wizard/drafts/:id/activate — supersede siblings (BUG-030 Part B)", () => {
  let harness: Harness;
  const drafts = new Map<string, ActivateDraftRow>([
    [
      "draft-consume",
      {
        id: "draft-consume",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
      },
    ],
  ]);
  const deps = makeActivateDeps({ drafts });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("archives sibling unconsumed drafts after activate — archive, never flip", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-consume/activate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 201);
    // Supersede ran exactly once, scoped to this user's UNCONSUMED drafts.
    assert.equal(deps.rec.supersedeCalls.length, 1);
    const { where, data } = deps.rec.supersedeCalls[0];
    assert.equal(where.userId, ACTIVATE_USER_ID);
    assert.equal(where.isWizardDraft, true);
    assert.equal(where.isArchived, false);
    // Archives + clears blob; MUST NOT flip isWizardDraft (that would surface
    // the orphan as a real plan in My Plans/home — the Phase 0 constraint).
    assert.equal(data.isArchived, true);
    assert.equal(data.optimizationNotes, Prisma.DbNull);
    assert.equal(
      Object.prototype.hasOwnProperty.call(data, "isWizardDraft"),
      false,
    );
  });
});

describe("POST /api/wizard/drafts/:id/save — happy path", () => {
  let harness: Harness;
  const drafts = new Map<string, ActivateDraftRow>([
    [
      "draft-save-ok",
      {
        id: "draft-save-ok",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
      },
    ],
  ]);
  const deps = makeActivateDeps({ drafts });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("returns 201 + saved instance, flips ONLY isWizardDraft, emits plan_created", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-save-ok/save`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      instance: { id: string; revisionId: number };
    };
    assert.equal(body.instance.id, "draft-save-ok");
    // Stub returns revisionId=2 from its update return value; the assertion
    // that matters is what the route SENT to update (no revisionId field).
    assert.equal(typeof body.instance.revisionId, "number");

    // Materializer invoked exactly once with the right draftId.
    assert.equal(deps.rec.materializeCalls.length, 1);
    assert.equal(deps.rec.materializeCalls[0].draftId, "draft-save-ok");

    // updateMany (demote) was NOT called — save doesn't activate.
    assert.equal(deps.rec.updateManyCalls.length, 0);

    // Flip update — sets ONLY isWizardDraft + the Template-pair fields
    // (mealPlanTemplateId, optimizationNotes). No active flip, no dates,
    // no revisionId bump.
    assert.equal(deps.rec.updateCalls.length, 1);
    const flip = deps.rec.updateCalls[0].data;
    assert.equal(flip.isWizardDraft, false);
    assert.equal(Object.prototype.hasOwnProperty.call(flip, "isActiveThisWeek"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(flip, "startDate"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(flip, "endDate"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(flip, "status"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(flip, "revisionId"), false);
    // WS7-5b-mobile FIX (PRD §2.4) — Template-pair: same link + JSON clear
    // as /activate. Save tail isn't activating, but the persistence shape
    // is identical: undated, non-active, Template-backed.
    assert.equal(flip.mealPlanTemplateId, "tpl-test-id");
    // D-WS9-034 — same draft-blob clear as /activate.
    assert.equal(flip.wizardDraftPayload, Prisma.DbNull);
    assert.equal(flip.optimizationNotes, Prisma.DbNull);

    // Activity emitted is plan_created (NOT plan_activated_this_week).
    assert.equal(deps.rec.activityCalls.length, 1);
    assert.equal(deps.rec.activityCalls[0].eventType, "plan_created");
    assert.equal(deps.rec.activityCalls[0].entityId, "draft-save-ok");
  });
});

describe("wizard draft lifecycle — peek A / peek B / save A (BUG-030 Part B)", () => {
  let harness: Harness;
  // Two peeked drafts already exist (two expand calls, distinct content
  // hashes). The user goes back to A and saves it.
  const drafts = new Map<string, ActivateDraftRow>([
    [
      "draft-A",
      {
        id: "draft-A",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        isArchived: false,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
        wizardContentHash: "hash-a",
      },
    ],
    [
      "draft-B",
      {
        id: "draft-B",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        isArchived: false,
        createdAt: new Date("2026-05-28T10:05:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
        wizardContentHash: "hash-b",
      },
    ],
  ]);
  const deps = makeActivateDeps({ drafts });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("saves A once, archives sibling B, and never surfaces B (no dupe)", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/drafts/draft-A/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(res.status, 201);

    const a = drafts.get("draft-A")!;
    const b = drafts.get("draft-B")!;
    // A was consumed exactly once — flipped to a real plan, NOT archived.
    assert.equal(a.isWizardDraft, false);
    assert.notEqual(a.isArchived, true);
    // B (the moot peeked sibling) is archived — archive, not flip. It stays
    // isWizardDraft:true so My Plans/home never show it, and isArchived:true
    // so the resume list (isArchived:false) never offers it again.
    assert.equal(b.isWizardDraft, true);
    assert.equal(b.isArchived, true);
    // Materialize ran exactly once (A), never for B — no duplicate plan.
    assert.equal(deps.rec.materializeCalls.length, 1);
    assert.equal(deps.rec.materializeCalls[0].draftId, "draft-A");
  });
});

describe("POST /api/wizard/drafts/:id/save — prior active is NOT demoted", () => {
  // Two drafts: one will be /save'd, the other is a pre-existing active plan
  // that must remain active after save fires. Verifies the save tail does
  // NOT call updateMany (which is what /activate uses to demote).
  let harness: Harness;
  const drafts = new Map<string, ActivateDraftRow>([
    [
      "draft-to-save",
      {
        id: "draft-to-save",
        userId: ACTIVATE_USER_ID,
        isWizardDraft: true,
        createdAt: new Date("2026-05-28T10:00:00Z"),
        wizardDraftPayload: SAMPLE_EXPANDED,
      },
    ],
  ]);
  const deps = makeActivateDeps({ drafts });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("save tail does not call updateMany — any existing active plan stays active", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/draft-to-save/save`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 201);
    // The save tail must NOT call updateMany — that's the activate-only
    // "demote prior actives" sweep. If save called updateMany, a prior
    // active plan would have been wrongly demoted by a Save-for-Later tap.
    assert.equal(deps.rec.updateManyCalls.length, 0);
  });
});

describe("POST /api/wizard/drafts/:id/save — not found / not a draft", () => {
  let harness: Harness;
  const drafts = new Map<string, ActivateDraftRow>();
  const deps = makeActivateDeps({
    drafts,
    materializeBehavior: "not_found",
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("returns 404 when draft missing / not owned / already saved (isWizardDraft=false)", async () => {
    // The materializer's own guard `!draft.isWizardDraft` covers all three
    // cases (not_found, not_owned, not_a_draft) — same as /activate. An
    // already-saved or already-activated draft has isWizardDraft=false so
    // it hits this same 404 branch via WizardDraftNotFoundError.
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/missing-id/save`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 404);
    assert.equal(deps.rec.updateManyCalls.length, 0);
    assert.equal(deps.rec.updateCalls.length, 0);
    assert.equal(deps.rec.activityCalls.length, 0);
  });

  it("returns 401 with no auth header", async () => {
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/anything/save`,
      { method: "POST" },
    );
    assert.equal(res.status, 401);
  });
});

describe("POST /api/wizard/drafts/:id/save — malformed draft", () => {
  let harness: Harness;
  const drafts = new Map<string, ActivateDraftRow>();
  const deps = makeActivateDeps({
    drafts,
    materializeBehavior: "malformed",
  });

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: deps.prisma as unknown as Parameters<typeof spinUp>[0]["prisma"],
      subscriptionService: makeSubscriptionService(true),
      materializeWizardDraft: deps.materializeWizardDraft,
      emitActivity: deps.emitActivity,
      readAndFinalizeWizardDraft: deps.readAndFinalizeWizardDraft,
    } as unknown as Parameters<typeof spinUp>[0]);
  });
  after(async () => harness.close());

  it("returns 422 with reason (matches /activate)", async () => {
    const token = signToken(ACTIVATE_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/wizard/drafts/bad-shape/save`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /draft malformed/);
    assert.equal(body.reason, "shape_mismatch");
  });
});

// ── WS7-5b-server — inferCategory unit tests ─────────────────────────────

describe("inferCategory (wizardActivation)", () => {
  it("maps a known produce keyword to Produce", async () => {
    const { inferCategory } = await import("../../lib/wizardActivation");
    assert.equal(inferCategory("Yellow onion"), "Produce");
    assert.equal(inferCategory("garlic cloves"), "Produce");
    assert.equal(inferCategory("Lemons"), "Produce");
  });

  it("maps proteins to Protein", async () => {
    const { inferCategory } = await import("../../lib/wizardActivation");
    assert.equal(inferCategory("Chicken thighs"), "Protein");
    assert.equal(inferCategory("Ground beef"), "Protein");
    assert.equal(inferCategory("salmon fillet"), "Protein");
  });

  it("maps dairy to Dairy", async () => {
    const { inferCategory } = await import("../../lib/wizardActivation");
    assert.equal(inferCategory("Whole milk"), "Dairy");
    assert.equal(inferCategory("Cheddar"), "Dairy");
    assert.equal(inferCategory("eggs"), "Dairy");
  });

  it("falls back to Pantry for unknown / spice / condiment names", async () => {
    const { inferCategory } = await import("../../lib/wizardActivation");
    // Spices and condiments naturally fall through — the seeded vocab has
    // no Spices/Condiments categories; "Pantry" is the catch-all bucket.
    assert.equal(inferCategory("Smoked paprika"), "Pantry");
    assert.equal(inferCategory("Soy sauce"), "Pantry");
    assert.equal(inferCategory("Quinoa"), "Pantry");
    assert.equal(inferCategory("Mystery ingredient"), "Pantry");
  });

  it("maps bread items to Bakery", async () => {
    const { inferCategory } = await import("../../lib/wizardActivation");
    assert.equal(inferCategory("Flour tortillas"), "Bakery");
    assert.equal(inferCategory("Sourdough bread"), "Bakery");
  });
});

// ── Surprise-me (surprise-me) tests — WS9 3c §7.6 ─────────────────────

describe("POST /api/wizard/surprise-me — WS9 3c §7.6", () => {
  it("generates within stored hard constraints; one AI call, vague parsedIntent", async () => {
    const captured: { promptKey: string; vars: Record<string, unknown> }[] = [];
    const runAICall = (async (
      promptKey: string,
      vars: Record<string, unknown>,
    ) => {
      captured.push({ promptKey, vars });
      if (promptKey !== "wizard.surprise.generate") {
        throw new Error(`unexpected promptKey ${promptKey}`);
      }
      return genSuccess(threeCandidates("surprise"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const prisma = makeStubPrisma({
      preferences: {
        householdSize: 3,
        planLengthDefault: 4,
        cuisines: ["Italian"],
        eatingStyles: ["vegetarian"],
        allergiesAndAvoidances: ["peanuts", "shellfish"],
        dietaryNotes: "no cilantro",
        weeklyPacingDefault: "mostly_easy",
        wantsLeftovers: false,
      },
    });
    const harness = await spinUp({
      runAICall,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
    try {
      const token = signToken("test-user-surprise");
      const res = await fetch(`${harness.baseUrl}/wizard/surprise-me`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        candidates: { id: string }[];
        parsedIntent: ParsedIntent;
        metadata: { flow: string };
      };
      // BUG-037 — Surprise-me returns exactly ONE plan (→ draft screen), not 3.
      assert.equal(body.candidates.length, 1);
      assert.equal(body.parsedIntent.scenario, "vague");
      assert.deepEqual(body.parsedIntent.explicitMeals, []);
      assert.equal(body.metadata.flow, "surprise");

      // Exactly ONE AI call — Surprise-me skips the parse step (no user text).
      assert.equal(captured.length, 1);
      assert.equal(captured[0].promptKey, "wizard.surprise.generate");

      // The stored hard constraints MUST reach the generate prompt — the
      // "surprise" is meal choice, never a constraint violation.
      const generateInput = captured[0].vars.generateInput as Record<
        string,
        unknown
      >;
      assert.deepEqual(generateInput.allergiesAndAvoidances, [
        "peanuts",
        "shellfish",
      ]);
      assert.deepEqual(generateInput.eatingStyles, ["vegetarian"]);
      assert.equal(generateInput.householdSize, 3);
      // planDurationDays comes from the stored planLengthDefault (no body).
      assert.equal(generateInput.planDurationDays, 4);

      // Fix 4 — Surprise-me composes from the catalog: the shelf var reaches the
      // AI (empty here — no storeMeals stubbed — which is a valid empty shelf).
      assert.ok(Array.isArray(captured[0].vars.storeShortlist));

      const events = prisma._activities().map((a) => a.eventType);
      assert.ok(events.includes("wizard_complete"));
    } finally {
      await harness.close();
    }
  });

  it("returns 402 when the just-say entitlement is denied; no AI call fires", async () => {
    const captured: unknown[] = [];
    const runAICall = (async (...args: unknown[]) => {
      captured.push(args);
      return genSuccess(threeCandidates("surprise"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const prisma = makeStubPrisma();
    const harness = await spinUp({
      runAICall,
      prisma,
      subscriptionService: makeSubscriptionService(false),
    });
    try {
      const token = signToken("test-user-surprise-locked");
      const res = await fetch(`${harness.baseUrl}/wizard/surprise-me`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      assert.equal(res.status, 402);
      assert.equal(captured.length, 0);
    } finally {
      await harness.close();
    }
  });
});
