// WS7-7-B — FindSimilarSheet behavior tests. Pins the post-swap contract after
// the client cuisine fallback was removed:
//   - On a successful AI ranking, the sheet renders the candidate-pool meals
//     in the AI's returned order, and drops candidates the AI didn't match.
//   - On AI hard-failure, the sheet renders the graceful error state, renders
//     NO meal list, and makes NO second ranking attempt (there is no longer a
//     client-side cuisine re-rank — the server folds its own free-tier cuisine
//     fallback into a normal success response, which flows the AI path).
//   - Picking a match hands a REAL candidate-pool MealSummary to the caller,
//     not a stub fixture.
//
// Harness: the two reads (useMeal source + useMeals candidate pool) are primed
// into the QueryClient cache (staleTime Infinity → no network), an auth token
// is seeded into the secure-store stub, and global.fetch is stubbed so only the
// find-similar mutation hits the wire — letting each test drive success/error
// deterministically. File is `.test.ts` (not `.tsx`) because the package `test`
// script only globs components/__tests__/*.test.ts; nodes are built with
// React.createElement like the sibling sheet tests.

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Pressable, Text } from "react-native";
import {
  __setForTests as seedSecureItem,
  __resetForTests as resetSecureStore,
} from "expo-secure-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { FindSimilarSheet } from "../FindSimilarSheet";
import type { MealDetail, MealListResponse } from "@/lib/api/meals";
import type { MealSummary } from "@/lib/types";

const SOURCE_ID = "src-1";
// Mirrors FIND_SIMILAR_BUCKETS in FindSimilarSheet (module-private there); the
// react-query key is hashed by stable JSON so a structural copy collides with
// the in-component key and the primed cache entry is the one the hook reads.
const BUCKETS = ["my_meals", "featured", "top_rated", "hosting"];

// Only the five fields mealDetailToCandidate reads are needed; cast past the
// full MealDetail shape rather than hand-build the whole detail envelope.
const SOURCE_MEAL = {
  id: SOURCE_ID,
  title: "Spaghetti Carbonara",
  cuisine: "Italian",
  mealType: "dinner",
  tags: ["pasta"],
} as unknown as MealDetail;

function listItem(id: string, title: string) {
  return {
    id,
    title,
    cuisine: "Italian",
    minutes: 30,
    servings: 2,
    calories: 500,
    protein: 20,
    carbs: 40,
    fat: 15,
    tags: [],
    image: null,
  };
}

const CANDIDATES: MealListResponse = {
  meals: [
    listItem("c-1", "Cacio e Pepe"),
    listItem("c-2", "Bucatini Amatriciana"),
    listItem("c-3", "Margherita Pizza"),
  ],
  nextCursor: null,
};

// AI ranks c-2 above c-1 and omits c-3 entirely.
const AI_RESPONSE = {
  matches: [
    { mealId: "c-2", similarityScore: 0.9, reason: "Roman pasta" },
    { mealId: "c-1", similarityScore: 0.8, reason: "Cheese + pepper" },
  ],
  metadata: { promptVersion: 1, latencyMs: 5, mode: "ai" },
};

interface FetchStubResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

let fetchCalls: string[] = [];
let fetchImpl: (url: string) => FetchStubResponse;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textLeavesOf(node: TestRenderer.ReactTestInstance): string[] {
  return node.findAllByType(Text).map((t) => {
    const ch = t.props.children;
    if (typeof ch === "string") return ch;
    if (Array.isArray(ch)) return ch.map((c) => String(c)).join("");
    return String(ch);
  });
}

beforeEach(() => {
  resetSecureStore();
  seedSecureItem("kiwi_authToken", "test-token");
  fetchCalls = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
    fetchCalls.push(String(url));
    return fetchImpl(String(url));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  resetSecureStore();
});

function primedClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  // useMeal(SOURCE_ID) → ["meals","detail",id,planItemId??null]
  client.setQueryData(["meals", "detail", SOURCE_ID, null], SOURCE_MEAL);
  // useMeals(BUCKETS) → ["meals","list", filter??null]
  client.setQueryData(["meals", "list", BUCKETS], CANDIDATES);
  return client;
}

async function renderSheet(
  opts: { onPick?: (m: MealSummary) => void } = {},
): Promise<TestRenderer.ReactTestRenderer> {
  const client = primedClient();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(FindSimilarSheet, {
          visible: true,
          sourceMealId: SOURCE_ID,
          sourceMealTitle: "Spaghetti Carbonara",
          sourceCuisine: "Italian",
          onClose: () => {},
          onPickReplacement: opts.onPick ?? (() => {}),
        }),
      ),
    );
    // Let the open-effect fire mutate() and the stubbed fetch resolve.
    await wait(100);
  });
  return renderer;
}

test("FindSimilarSheet: renders AI-ordered matches from the candidate pool", async () => {
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(AI_RESPONSE),
  });
  const renderer = await renderSheet();
  const leaves = textLeavesOf(renderer.root);
  const joined = leaves.join(" | ");

  const iBuc = leaves.findIndex((t) => t.includes("Bucatini Amatriciana"));
  const iCacio = leaves.findIndex((t) => t.includes("Cacio e Pepe"));
  assert.ok(iBuc >= 0, `Bucatini (c-2) should render: ${joined}`);
  assert.ok(iCacio >= 0, `Cacio (c-1) should render: ${joined}`);
  // AI order is preserved (c-2 before c-1) at the default sort.
  assert.ok(
    iBuc < iCacio,
    `expected AI order — Bucatini before Cacio: ${joined}`,
  );
  // The candidate the AI didn't match (c-3) is dropped.
  assert.ok(
    !joined.includes("Margherita Pizza"),
    `unmatched candidate must not render: ${joined}`,
  );
  // Exactly one ranking call hit the wire.
  const ranking = fetchCalls.filter((u) => u.includes("/meals/find-similar"));
  assert.equal(ranking.length, 1, `expected 1 ranking call, saw ${ranking.length}`);

  renderer.unmount();
});

test("FindSimilarSheet: AI hard-failure renders the error state, no list, no second attempt", async () => {
  fetchImpl = () => ({
    ok: false,
    status: 502,
    text: async () => JSON.stringify({ error: "upstream" }),
  });
  const renderer = await renderSheet();
  const joined = textLeavesOf(renderer.root).join(" | ");

  assert.ok(
    joined.includes("Couldn't reach Kiwi"),
    `graceful error state should render: ${joined}`,
  );
  // No meal list on the error path.
  assert.ok(!joined.includes("Bucatini Amatriciana"), `no list on error: ${joined}`);
  assert.ok(!joined.includes("Cacio e Pepe"), `no list on error: ${joined}`);
  assert.ok(!joined.includes("Margherita Pizza"), `no list on error: ${joined}`);
  // The removed client cuisine fallback must NOT re-rank: still exactly one call.
  const ranking = fetchCalls.filter((u) => u.includes("/meals/find-similar"));
  assert.equal(
    ranking.length,
    1,
    `expected exactly 1 ranking attempt (no fallback re-rank), saw ${ranking.length}`,
  );

  renderer.unmount();
});

test("FindSimilarSheet: picking a match hands a real candidate-pool meal to the caller", async () => {
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(AI_RESPONSE),
  });
  let picked: MealSummary | null = null;
  const renderer = await renderSheet({
    onPick: (m) => {
      picked = m;
    },
  });

  const row = renderer.root
    .findAllByType(Pressable)
    .find((p) => textLeavesOf(p).some((t) => t.includes("Bucatini Amatriciana")));
  assert.ok(row, "Bucatini row Pressable not found");
  await act(async () => {
    row!.props.onPress();
  });

  const result = picked as MealSummary | null;
  assert.ok(result, "onPickReplacement was not called");
  // c-2 is a real GET /me/meals row mapped through mealListItemToSummary —
  // proven by the adapter-assigned `source`, which a stub fixture wouldn't set.
  assert.equal(result!.id, "c-2", "should hand the real candidate id from the pool");
  assert.equal(result!.title, "Bucatini Amatriciana");
  assert.equal(result!.source, "saved");

  renderer.unmount();
});

// NOTE: the read-failure error state (network dies before the source/candidate
// reads land → the sheet shows the SAME "Couldn't reach Kiwi" state instead of
// the empty card) is NOT unit-tested here. It depends on a useQuery transition
// from loading → error being reflected in the rendered tree, which this harness
// (react-test-renderer + react-query's useSyncExternalStore) does not propagate
// — the sibling AddMealsSheet test documents the same loading-branch limitation.
// The `showError` branch covering `sourceMealQuery.isError || candidatesQuery.
// isError` is verified by code review; the AI-failure path above covers the
// mutation half of the same error UI.

test("FindSimilarSheet: fractional server macros render rounded to whole numbers", async () => {
  // The server legitimately stores fractional per-serving macros (e.g. birria
  // tacos at 75.39999…g protein); the row must round for display.
  const FRACTIONAL: MealListResponse = {
    meals: [
      {
        ...listItem("c-2", "Bucatini Amatriciana"),
        protein: 75.39999999999999,
        fat: 51.6,
      },
    ],
    nextCursor: null,
  };
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        matches: [{ mealId: "c-2", similarityScore: 0.9, reason: "x" }],
        metadata: { promptVersion: 1, latencyMs: 5, mode: "ai" },
      }),
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["meals", "detail", SOURCE_ID, null], SOURCE_MEAL);
  client.setQueryData(["meals", "list", BUCKETS], FRACTIONAL);

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(FindSimilarSheet, {
          visible: true,
          sourceMealId: SOURCE_ID,
          sourceMealTitle: "Spaghetti Carbonara",
          sourceCuisine: "Italian",
          onClose: () => {},
          onPickReplacement: () => {},
        }),
      ),
    );
    await wait(100);
  });

  const joined = textLeavesOf(renderer.root).join(" | ");
  assert.ok(joined.includes("75g P"), `protein should round to 75g P: ${joined}`);
  assert.ok(joined.includes("52g F"), `fat should round to 52g F: ${joined}`);
  assert.ok(
    !joined.includes("75.3") && !joined.includes("51.6"),
    `no float artifacts should render: ${joined}`,
  );

  renderer.unmount();
});
