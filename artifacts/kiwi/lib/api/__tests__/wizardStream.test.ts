// Latency Block (D-WS9-076) — streamWizardPlans (SSE client) tests.
// Run via the kiwi `test` script (uses the _loader.mjs Expo stubs).
//
// No real network + no expo/fetch: a fetchImpl is injected returning a Web
// ReadableStream of SSE bytes, so the real frame parsing, candidate validation,
// stall watchdog, and error routing are all exercised.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import * as SecureStore from "expo-secure-store";

import { streamWizardPlans } from "../wizardStream";
import { ApiError, ApiNetworkError, UpgradeRequiredError } from "../errors";
import type { WizardPlanCandidate, WizardPreferencesInput } from "../../types";

const TOKEN_KEY = "kiwi_authToken";

function setToken() {
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
}
function resetStore() {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
}

const INPUT = {
  planDurationDays: 5,
  householdSize: 4,
  wantsLeftovers: true,
  cuisines: ["Italian"],
  eatingStyles: [],
  allergiesAndAvoidances: [],
  difficulty: "medium",
  weeklyPacing: "mixed",
} as unknown as WizardPreferencesInput;

function candidate(id: string): WizardPlanCandidate {
  return {
    id,
    title: `Plan ${id}`,
    tags: ["Easy"],
    whyBullets: ["Balanced week"],
    mealTitles: ["A", "B", "C"],
    dailyMacros: { calories: 540, proteinG: 28, carbsG: 56, fatG: 22 },
  } as WizardPlanCandidate;
}

// A fetch returning an SSE ReadableStream built from raw byte chunks (chunks may
// split frames — exercises the rolling buffer).
function sseFetch(
  chunks: string[],
  opts: { ok?: boolean; status?: number; noBody?: boolean; errorBody?: unknown } = {},
) {
  return async (_url: string, _init: { signal?: AbortSignal }) => {
    const body = opts.noBody
      ? null
      : new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            for (const c of chunks) controller.enqueue(enc.encode(c));
            controller.close();
          },
        });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      async json() {
        return opts.errorBody ?? {};
      },
      body,
    } as unknown as Awaited<ReturnType<typeof fetch>>;
  };
}

// A fetch that returns a body that never emits, and errors its stream when the
// caller's abort signal fires (simulating a real stalled connection).
function stallingFetch() {
  return async (_url: string, init: { signal?: AbortSignal }) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener("abort", () =>
          controller.error(new Error("aborted")),
        );
      },
    });
    return { ok: true, status: 200, async json() {return {};}, body } as unknown as Awaited<
      ReturnType<typeof fetch>
    >;
  };
}

describe("streamWizardPlans", () => {
  beforeEach(() => setToken());
  afterEach(() => resetStore());

  it("dispatches each candidate in order and returns the done metadata", async () => {
    const c0 = candidate("c0");
    const c1 = candidate("c1");
    const chunks = [
      `event: candidate\ndata: ${JSON.stringify({ index: 0, candidate: c0 })}\n\n`,
      // split the second candidate frame across two chunks to test buffering
      `event: candidate\ndata: ${JSON.stringify({ index: 1, candidate: c1 }).slice(0, 20)}`,
      `${JSON.stringify({ index: 1, candidate: c1 }).slice(20)}\n\n`,
      `event: done\ndata: ${JSON.stringify({ cannotGenerateMore: false, reason: "ok" })}\n\n`,
    ];
    const got: Array<{ i: number; id: string }> = [];
    const done = await streamWizardPlans(
      INPUT,
      (i, c) => got.push({ i, id: c.id }),
      { fetchImpl: sseFetch(chunks) as never },
    );

    assert.deepEqual(got, [
      { i: 0, id: "c0" },
      { i: 1, id: "c1" },
    ]);
    assert.equal(done.cannotGenerateMore, false);
    assert.equal(done.reason, "ok");
  });

  it("ignores progress frames (liveness) and still delivers candidates + done", async () => {
    const chunks = [
      `event: progress\ndata: ${JSON.stringify({ bytes: 64 })}\n\n`,
      `event: progress\ndata: ${JSON.stringify({ bytes: 300 })}\n\n`,
      `event: candidate\ndata: ${JSON.stringify({ index: 0, candidate: candidate("c0") })}\n\n`,
      `event: progress\ndata: ${JSON.stringify({ bytes: 900 })}\n\n`,
      `event: candidate\ndata: ${JSON.stringify({ index: 1, candidate: candidate("c1") })}\n\n`,
      `event: done\ndata: {}\n\n`,
    ];
    const got: string[] = [];
    const done = await streamWizardPlans(INPUT, (_i, c) => got.push(c.id), {
      fetchImpl: sseFetch(chunks) as never,
    });
    assert.deepEqual(got, ["c0", "c1"]); // progress frames didn't count as candidates
    assert.ok(done);
  });

  it("drops an invalid candidate frame instead of throwing", async () => {
    const chunks = [
      `event: candidate\ndata: ${JSON.stringify({ index: 0, candidate: { id: "bad" } })}\n\n`,
      `event: candidate\ndata: ${JSON.stringify({ index: 1, candidate: candidate("c1") })}\n\n`,
      `event: done\ndata: {}\n\n`,
    ];
    const got: string[] = [];
    await streamWizardPlans(INPUT, (_i, c) => got.push(c.id), {
      fetchImpl: sseFetch(chunks) as never,
    });
    assert.deepEqual(got, ["c1"]); // the malformed one is skipped
  });

  it("throws ApiError on a server error frame", async () => {
    const chunks = [
      `event: error\ndata: ${JSON.stringify({ error: "Kiwi got distracted. Try again?", reason: "sdk_error" })}\n\n`,
    ];
    await assert.rejects(
      streamWizardPlans(INPUT, () => {}, { fetchImpl: sseFetch(chunks) as never }),
      (err: unknown) => err instanceof ApiError && !(err instanceof UpgradeRequiredError),
    );
  });

  it("maps a 402 to UpgradeRequiredError (no fallback wanted)", async () => {
    await assert.rejects(
      streamWizardPlans(INPUT, () => {}, {
        fetchImpl: sseFetch([], {
          ok: false,
          status: 402,
          errorBody: { error: "Upgrade required" },
        }) as never,
      }),
      (err: unknown) => err instanceof UpgradeRequiredError,
    );
  });

  it("throws when the body is not streamable (platform without streaming)", async () => {
    await assert.rejects(
      streamWizardPlans(INPUT, () => {}, {
        fetchImpl: sseFetch([], { noBody: true }) as never,
      }),
      (err: unknown) => err instanceof ApiNetworkError,
    );
  });

  it("throws when the stream ends with no done frame", async () => {
    const chunks = [
      `event: candidate\ndata: ${JSON.stringify({ index: 0, candidate: candidate("c0") })}\n\n`,
    ];
    await assert.rejects(
      streamWizardPlans(INPUT, () => {}, { fetchImpl: sseFetch(chunks) as never }),
      (err: unknown) => err instanceof ApiNetworkError,
    );
  });

  it("aborts and throws when the stream stalls", async () => {
    await assert.rejects(
      streamWizardPlans(INPUT, () => {}, {
        fetchImpl: stallingFetch() as never,
        stallMs: 30,
      }),
      (err: unknown) =>
        err instanceof ApiNetworkError && /stall/i.test(err.message),
    );
  });
});
