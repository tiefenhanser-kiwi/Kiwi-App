// WS9 Prep Selected Meals — usePrepWeek WIRING tests.
//
// 🔴 WHY THIS FILE EXISTS. lib/api/__tests__/cooking.test.ts already pins
// `prepWeekQueryKey` as a pure function (subset key never equals the full-week
// key, order-insensitive, empty falls back). Those tests DO NOT prove the hook
// calls it with the mealIds — and that is the gap that matters:
//
//   if usePrepWeek passed mealIds to getPrepWeek but NOT to prepWeekQueryKey,
//   every pure-function test stays green while a subset envelope lands under
//   ["cooking","prep-week",planId] — whose staleTime is Infinity — and is
//   served as the canonical week for the rest of the session.
//
// That is the client-side twin of the server's planId-keyed structure row, and
// it fails identically: right phases, right prose, missing meals. Nothing on
// screen looks wrong.
//
// So these tests read the LIVE QueryCache — the keys the hook actually
// registered and the data actually stored under them — rather than re-deriving
// a key and comparing it to itself.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import * as SecureStore from "expo-secure-store";

import { usePrepWeek, prepWeekQueryKey } from "../usePrepWeek";
import type { PrepWeekOutcome } from "@/lib/api/cooking";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const PLAN = "plan-1";
const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";

// A minimal but SCHEMA-VALID PrepWeekResult: 4 phases, fixed order. `mealIds`
// drives contributesToMealIds so each response is identifiably about a
// particular selection — a subset envelope and a full-week envelope are
// distinguishable by content, not just by a flag.
function prepResult(mealIds: string[]) {
  return {
    totalEstimatedMinutes: 20,
    phases: [
      { phase: "seasonings_dry", title: "Seasonings", skippable: true, steps: [] },
      { phase: "sauces_marinades", title: "Sauces", skippable: true, steps: [] },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          {
            number: 1,
            stepKey: "produce#onion",
            title: "Dice onion",
            instructions: "Dice the onion.",
            estimatedMinutes: 5,
            contributesToMealIds: mealIds,
          },
        ],
      },
      { phase: "proteins", title: "Proteins", skippable: false, steps: [] },
    ],
  };
}

function envelope(mealIds: string[], subset: boolean) {
  return {
    cacheHit: false,
    subset,
    result: prepResult(mealIds),
    planRevisionId: 4,
    generatedAt: "2026-09-03T18:14:59.000Z",
    promptVersion: 8,
    metadata: { latencyMs: 1234 },
  };
}

let requestBodies: (string | null)[];

beforeEach(() => {
  requestBodies = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { body?: string },
  ) => {
    const body = typeof init?.body === "string" ? init.body : null;
    requestBodies.push(body);
    // Echo the requested selection back, so the cached payload reflects what
    // the hook actually asked for. A full-week call (no body) answers with
    // both meals.
    const parsed = body ? (JSON.parse(body) as { mealIds?: string[] }) : null;
    const ids = parsed?.mealIds ?? [M1, M2];
    return new Response(JSON.stringify(envelope(ids, !!parsed?.mealIds)), {
      status: 200,
      headers: JSON_HEADERS,
    });
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

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

// Drive the queryFn to completion and let the re-render commit. Polls rather
// than awaiting one promise, because a mount can register its query a tick
// after create() returns.
async function settle(client: QueryClient) {
  for (let i = 0; i < 50; i++) {
    const all = client.getQueryCache().getAll();
    // ⚠️ `all.length > 0` matters: a bare "nothing is pending" check passes
    // vacuously on the tick before the mount registers its query, and the probe
    // then reads a pre-fetch render. That produced a false red here.
    const ready =
      all.length > 0 && all.every((q) => q.state.status !== "pending");
    if (ready) {
      // One more tick so the success re-render commits into the probe.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      return;
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  throw new Error("usePrepWeek query never settled");
}

// Mount usePrepWeek inside a real QueryClientProvider and let the fetch settle.
// `latest()` returns the hook's PrepWeekOutcome (query `.data`), not the
// UseQueryResult wrapper.
async function mountHook(
  client: QueryClient,
  planId: string,
  mealIds?: string[],
) {
  let captured: ReturnType<typeof usePrepWeek> | null = null;
  function Probe(): null {
    captured = usePrepWeek(planId, true, mealIds);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Probe),
      ),
    );
  });
  await settle(client);
  return {
    renderer,
    latest: () => captured?.data ?? null,
    // Unmount inside act(): tearing down a subscribed useQuery flushes React
    // state, and an unwrapped teardown prints an act() warning that would go on
    // to mask a real one.
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

/** Every query key currently registered in the cache, as JSON for comparison. */
function registeredKeys(client: QueryClient): string[] {
  return client
    .getQueryCache()
    .getAll()
    .map((q) => JSON.stringify(q.queryKey))
    .sort();
}

function attributedMealIds(outcome: PrepWeekOutcome | null | undefined): string[] {
  if (!outcome || outcome.kind !== "ok") return [];
  return [
    ...new Set(
      outcome.envelope.result.phases.flatMap((p) =>
        p.steps.flatMap((s) => s.contributesToMealIds),
      ),
    ),
  ].sort();
}

// ── The wiring ──────────────────────────────────────────────────────────────

test("usePrepWeek: a full-week call registers exactly the full-week key", async () => {
  const client = makeClient();
  const { unmount } = await mountHook(client, PLAN);
  assert.deepEqual(registeredKeys(client), [
    JSON.stringify(["cooking", "prep-week", PLAN]),
  ]);
  // …and sends no body, so the server runs its unchanged full-week path.
  assert.deepEqual(requestBodies, [null]);
  unmount();
});

test("🔴 usePrepWeek: a SUBSET call registers the subset key, NOT the full-week key", async () => {
  const client = makeClient();
  const { unmount } = await mountHook(client, PLAN, [M1]);

  const keys = registeredKeys(client);
  const fullWeekKey = JSON.stringify(["cooking", "prep-week", PLAN]);
  // Read the key the hook ACTUALLY registered — this is the assertion the pure
  // prepWeekQueryKey tests cannot make.
  assert.equal(keys.length, 1);
  assert.notEqual(keys[0], fullWeekKey);
  assert.equal(keys[0], JSON.stringify(prepWeekQueryKey(PLAN, [M1])));

  // The mealIds reached the WIRE too — both halves, from one mount. If only
  // this half were wired, the test above would still catch it.
  assert.deepEqual(requestBodies, [JSON.stringify({ mealIds: [M1] })]);
  unmount();
});

test("🔴 usePrepWeek: a subset result never lands in the full-week cache slot", async () => {
  const client = makeClient();
  const { unmount, latest } = await mountHook(client, PLAN, [M1]);

  // The subset really did come back narrowed…
  assert.deepEqual(attributedMealIds(latest()), [M1]);
  // …and the full-week slot — staleTime Infinity, read by every other prep
  // surface — is still EMPTY. Not "different": empty.
  assert.equal(
    client.getQueryData(prepWeekQueryKey(PLAN)),
    undefined,
    "a subset envelope must never occupy the full-week key",
  );
  unmount();
});

test("🔴 usePrepWeek: a warm full-week cache survives a subset mount intact", async () => {
  const client = makeClient();
  // 1. Warm the full-week slot for real, through the hook.
  const full = await mountHook(client, PLAN);
  assert.deepEqual(attributedMealIds(full.latest()), [M1, M2]);
  const before = JSON.stringify(client.getQueryData(prepWeekQueryKey(PLAN)));
  // Sanity: a real payload, not undefined — otherwise the comparison below
  // would pass by both sides being empty.
  assert.notEqual(before, undefined);
  assert.ok(before.includes(M2));
  full.unmount();

  // 2. Run a subset over one meal.
  const sub = await mountHook(client, PLAN, [M1]);
  assert.deepEqual(attributedMealIds(sub.latest()), [M1]);

  // 3. The full-week entry is byte-identical — the client-side twin of the
  //    server's stored-structure guard.
  assert.equal(
    JSON.stringify(client.getQueryData(prepWeekQueryKey(PLAN))),
    before,
  );
  // Both entries coexist under distinct keys.
  assert.deepEqual(registeredKeys(client), [
    JSON.stringify(["cooking", "prep-week", PLAN]),
    JSON.stringify(prepWeekQueryKey(PLAN, [M1])),
  ].sort());
  sub.unmount();
});

test("usePrepWeek: different selections get separate cache entries", async () => {
  const client = makeClient();
  const a = await mountHook(client, PLAN, [M1]);
  a.unmount();
  const b = await mountHook(client, PLAN, [M2]);
  b.unmount();

  assert.equal(registeredKeys(client).length, 2);
  // Each entry holds ITS OWN selection — not the other's, not a merge.
  assert.deepEqual(
    attributedMealIds(
      client.getQueryData(prepWeekQueryKey(PLAN, [M1])) as PrepWeekOutcome,
    ),
    [M1],
  );
  assert.deepEqual(
    attributedMealIds(
      client.getQueryData(prepWeekQueryKey(PLAN, [M2])) as PrepWeekOutcome,
    ),
    [M2],
  );
});

test("usePrepWeek: the same two meals in either tick order share ONE entry (one paid call)", async () => {
  const client = makeClient();
  const a = await mountHook(client, PLAN, [M1, M2]);
  a.unmount();
  assert.equal(requestBodies.length, 1);

  // Opposite order → same key → served from cache (staleTime Infinity), so the
  // wire is NOT hit a second time. A subset is a live ~$0.08 AI call; ordering
  // must not double it.
  const b = await mountHook(client, PLAN, [M2, M1]);
  b.unmount();
  assert.equal(registeredKeys(client).length, 1);
  assert.equal(
    requestBodies.length,
    1,
    "re-ticking the same meals in a different order must not refetch",
  );
});

test("usePrepWeek: an EMPTY mealIds array is a full week, not an empty subset", async () => {
  const client = makeClient();
  const { unmount } = await mountHook(client, PLAN, []);
  // Guards the paid-call path from the other side: [] must never reach the wire
  // as `{"mealIds":[]}`, which the server 400s.
  assert.deepEqual(requestBodies, [null]);
  assert.deepEqual(registeredKeys(client), [
    JSON.stringify(["cooking", "prep-week", PLAN]),
  ]);
  unmount();
});
