// THX-4 (D-WS9-324) — useCookingSequence WIRING: from a plan, Cook Mode's
// sequence request carries the plan item (its turkey weight sets the roast and
// the clock), and the result is cached under that item's own key. Read from the
// live request body and QueryCache, as usePrepWeek.test.ts does, rather than
// re-deriving the key and comparing it to itself.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import * as SecureStore from "expo-secure-store";

import { useCookingSequence } from "../useCookingSequence";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const SEQUENCE = {
  sequence: [{ dishId: "d1", originalStepIndex: 0, sequenceIndex: 0, startOffsetMinutes: -10 }],
  totalEstimatedMinutes: 10,
  dishCount: 2,
  usedAI: false,
};

let requests: { url: string; body: string | null }[];

beforeEach(() => {
  requests = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url: String(url), body: typeof init?.body === "string" ? init.body : null });
    return new Response(JSON.stringify(SEQUENCE), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

async function mount(mealId: string, planItemId?: string): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  function Probe(): null {
    useCookingSequence(mealId, true, planItemId);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  for (let i = 0; i < 50; i++) {
    const all = client.getQueryCache().getAll();
    if (all.length > 0 && all.every((q) => q.state.status !== "pending")) break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  act(() => renderer.unmount());
  return client;
}

const keys = (c: QueryClient) => c.getQueryCache().getAll().map((q) => JSON.stringify(q.queryKey));

test("from a plan: the request carries { planItemId } and the cache keys it", async () => {
  const client = await mount("m-1", "item-1");
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith("/meals/m-1/cooking-sequence"));
  assert.deepEqual(JSON.parse(requests[0].body ?? "null"), { planItemId: "item-1" });
  assert.deepEqual(keys(client), [JSON.stringify(["cooking", "sequence", "m-1", "item-1"])]);
});

test("outside a plan: no body, the key it always had", async () => {
  const client = await mount("m-1");
  assert.equal(requests[0].body, null);
  assert.deepEqual(keys(client), [JSON.stringify(["cooking", "sequence", "m-1"])]);
});
