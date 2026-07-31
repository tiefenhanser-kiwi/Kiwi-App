// WS9 3d Part 4 (D-WS9-018) — SwapMealSheet behavior tests. The merged sheet
// replaces ChangeMealSheet + FindSimilarSheet with one shell + two modes. These
// pin the LOSSLESS-MERGE contract (the recurring failure mode this block guards
// against) plus the ported FindSimilarSheet coverage:
//   - Different mode renders the filter-chip browser, excludes the source meal,
//     and picking hands a real bucket row to the caller.
//   - Similar mode runs the AI ranking pipeline: renders AI-ordered matches,
//     drops unmatched candidates, renders the error state on AI hard-failure with
//     no list and no second attempt, and hands a real candidate-pool meal on pick.
//   - The import source-quartet ("Bring in something new") is reachable from BOTH
//     modes — the explicit lossless-merge guard.
//   - The dead "Ask Kiwi — coming in WS6" premium pill is gone from both modes.
//   - Fractional server macros render rounded.
//
// Harness: reads (useMeal source + useMeals candidate/bucket pool) are primed
// into the QueryClient cache (staleTime Infinity → no network); an auth token is
// seeded; global.fetch is stubbed so only the find-similar mutation hits the
// wire. `.test.ts` (not .tsx) with React.createElement, per the sibling sheet
// tests and the package glob.
//
// NOTE (carried from the FindSimilarSheet test): the loading branch and the
// read-failure error branch are NOT unit-tested — they depend on a useQuery
// loading→settled transition being reflected in the rendered tree, which this
// harness (react-test-renderer + react-query's useSyncExternalStore) does not
// propagate. The AI-failure path below covers the mutation half of the same
// error UI; the read branches are verified by code review.

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

import { SwapMealSheet, type SwapMode } from "../SwapMealSheet";
import type { MealDetail, MealListResponse } from "@/lib/api/meals";
import type { MealSummary } from "@/lib/types";

const SOURCE_ID = "src-1";
// Mirrors FIND_SIMILAR_BUCKETS in SwapMealSheet (module-private); the react-query
// key is hashed by stable JSON so a structural copy collides with the in-
// component key and the primed cache entry is the one the hook reads.
const SIMILAR_BUCKETS = ["my_meals", "featured", "top_rated", "hosting"];
// Different mode's default chip is my_meals → useMeals(["my_meals"]).
const DIFFERENT_BUCKET = ["my_meals"];

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
    authoredServingsDefault: 2,
    calories: 500,
    protein: 20,
    carbs: 40,
    fat: 15,
    tags: [],
    image: null,
  };
}

const SIMILAR_CANDIDATES: MealListResponse = {
  meals: [
    listItem("c-1", "Cacio e Pepe"),
    listItem("c-2", "Bucatini Amatriciana"),
    listItem("c-3", "Margherita Pizza"),
  ],
  nextCursor: null,
};

// Different-mode bucket INCLUDES the source meal, to prove it is excluded.
const DIFFERENT_MEALS: MealListResponse = {
  meals: [
    listItem(SOURCE_ID, "Spaghetti Carbonara"),
    listItem("d-1", "Chicken Tacos"),
    listItem("d-2", "Veggie Stir Fry"),
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
  client.setQueryData(["meals", "detail", SOURCE_ID, null], SOURCE_MEAL);
  client.setQueryData(["meals", "list", SIMILAR_BUCKETS], SIMILAR_CANDIDATES);
  client.setQueryData(["meals", "list", DIFFERENT_BUCKET], DIFFERENT_MEALS);
  return client;
}

async function renderSheet(
  mode: SwapMode,
  opts: { onPick?: (m: MealSummary) => void; client?: QueryClient } = {},
): Promise<TestRenderer.ReactTestRenderer> {
  const client = opts.client ?? primedClient();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(SwapMealSheet, {
          visible: true,
          mode,
          sourceMealId: SOURCE_ID,
          sourceMealTitle: "Spaghetti Carbonara",
          sourceCuisine: "Italian",
          onClose: () => {},
          onPickReplacement: opts.onPick ?? (() => {}),
        }),
      ),
    );
    // Let the similar-mode open-effect fire mutate() and the stub resolve.
    await wait(100);
  });
  return renderer;
}

const IMPORT_CARD_TITLES = [
  "Import from URL",
  "Import from photo",
  "Import from text",
  "Create manually",
];

// ── Different mode ────────────────────────────────────────────────────────

test("Different mode: renders the filter-chip browser, excludes the source meal", async () => {
  fetchImpl = () => ({ ok: true, status: 200, text: async () => "{}" });
  const renderer = await renderSheet("different");
  const leaves = textLeavesOf(renderer.root);
  const joined = leaves.join(" | ");

  // Mode-specific header + chips.
  assert.ok(joined.includes("Change meal"), `different-mode title: ${joined}`);
  assert.ok(joined.includes("My Meals"), `filter chips present: ${joined}`);
  assert.ok(joined.includes("Featured"), `filter chips present: ${joined}`);
  // Similar-mode affordance must NOT appear.
  assert.ok(!joined.includes("Similar meals"), `no similar section: ${joined}`);

  // Bucket rows render; the source meal is excluded.
  assert.ok(joined.includes("Chicken Tacos"), `bucket row renders: ${joined}`);
  assert.ok(joined.includes("Veggie Stir Fry"), `bucket row renders: ${joined}`);
  assert.ok(
    !joined.includes("Spaghetti Carbonara"),
    `the source meal must be excluded from its own replacement list: ${joined}`,
  );

  // No AI ranking call in Different mode.
  assert.equal(
    fetchCalls.filter((u) => u.includes("/meals/find-similar")).length,
    0,
    "Different mode must not call the find-similar endpoint",
  );

  renderer.unmount();
});

test("Different mode: picking a bucket meal hands it to the caller", async () => {
  fetchImpl = () => ({ ok: true, status: 200, text: async () => "{}" });
  let picked: MealSummary | null = null;
  const renderer = await renderSheet("different", { onPick: (m) => (picked = m) });

  const row = renderer.root
    .findAllByType(Pressable)
    .find((p) => textLeavesOf(p).some((t) => t.includes("Chicken Tacos")));
  assert.ok(row, "Chicken Tacos row not found");
  await act(async () => {
    row!.props.onPress();
  });

  const result = picked as MealSummary | null;
  assert.ok(result, "onPickReplacement was not called");
  assert.equal(result!.id, "d-1");
  assert.equal(result!.title, "Chicken Tacos");

  renderer.unmount();
});

// ── Similar mode (ported FindSimilarSheet coverage) ─────────────────────────

test("Similar mode: renders AI-ordered matches from the candidate pool", async () => {
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(AI_RESPONSE),
  });
  const renderer = await renderSheet("similar");
  const leaves = textLeavesOf(renderer.root);
  const joined = leaves.join(" | ");

  assert.ok(joined.includes("Find similar"), `similar-mode title: ${joined}`);
  assert.ok(joined.includes("Similar meals"), `similar section: ${joined}`);

  const iBuc = leaves.findIndex((t) => t.includes("Bucatini Amatriciana"));
  const iCacio = leaves.findIndex((t) => t.includes("Cacio e Pepe"));
  assert.ok(iBuc >= 0 && iCacio >= 0, `both matches render: ${joined}`);
  assert.ok(iBuc < iCacio, `AI order preserved (Bucatini before Cacio): ${joined}`);
  assert.ok(
    !joined.includes("Margherita Pizza"),
    `unmatched candidate dropped: ${joined}`,
  );
  assert.equal(
    fetchCalls.filter((u) => u.includes("/meals/find-similar")).length,
    1,
    "exactly one ranking call",
  );

  renderer.unmount();
});

test("Similar mode: AI hard-failure renders the error state, no list, no second attempt", async () => {
  fetchImpl = () => ({
    ok: false,
    status: 502,
    text: async () => JSON.stringify({ error: "upstream" }),
  });
  const renderer = await renderSheet("similar");
  const joined = textLeavesOf(renderer.root).join(" | ");

  assert.ok(joined.includes("Couldn't reach Kiwi"), `error state: ${joined}`);
  assert.ok(!joined.includes("Bucatini Amatriciana"), `no list on error: ${joined}`);
  assert.ok(!joined.includes("Cacio e Pepe"), `no list on error: ${joined}`);
  assert.equal(
    fetchCalls.filter((u) => u.includes("/meals/find-similar")).length,
    1,
    "no fallback re-rank — exactly one attempt",
  );

  renderer.unmount();
});

test("Similar mode: picking a match hands a real candidate-pool meal to the caller", async () => {
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(AI_RESPONSE),
  });
  let picked: MealSummary | null = null;
  const renderer = await renderSheet("similar", { onPick: (m) => (picked = m) });

  const row = renderer.root
    .findAllByType(Pressable)
    .find((p) => textLeavesOf(p).some((t) => t.includes("Bucatini Amatriciana")));
  assert.ok(row, "Bucatini row not found");
  await act(async () => {
    row!.props.onPress();
  });

  const result = picked as MealSummary | null;
  assert.ok(result, "onPickReplacement was not called");
  assert.equal(result!.id, "c-2", "hands the real candidate id from the pool");
  assert.equal(result!.title, "Bucatini Amatriciana");
  assert.equal(result!.source, "saved");

  renderer.unmount();
});

test("Similar mode: fractional server macros render rounded to whole numbers", async () => {
  const FRACTIONAL: MealListResponse = {
    meals: [
      { ...listItem("c-2", "Bucatini Amatriciana"), protein: 75.39999999999999, fat: 51.6 },
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
  client.setQueryData(["meals", "list", SIMILAR_BUCKETS], FRACTIONAL);
  const renderer = await renderSheet("similar", { client });

  const joined = textLeavesOf(renderer.root).join(" | ");
  assert.ok(joined.includes("75g P"), `protein rounds to 75g P: ${joined}`);
  assert.ok(joined.includes("52g F"), `fat rounds to 52g F: ${joined}`);
  assert.ok(
    !joined.includes("75.3") && !joined.includes("51.6"),
    `no float artifacts: ${joined}`,
  );

  renderer.unmount();
});

// ── Lossless-merge guards ───────────────────────────────────────────────────

test("LOSSLESS: the import source-quartet is reachable from BOTH modes", async () => {
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(AI_RESPONSE),
  });

  const diff = await renderSheet("different");
  const diffJoined = textLeavesOf(diff.root).join(" | ");
  assert.ok(diffJoined.includes("Bring in something new"), `quartet header (different): ${diffJoined}`);
  for (const t of IMPORT_CARD_TITLES) {
    assert.ok(diffJoined.includes(t), `"${t}" reachable in Different mode: ${diffJoined}`);
  }
  diff.unmount();

  const sim = await renderSheet("similar");
  const simJoined = textLeavesOf(sim.root).join(" | ");
  assert.ok(simJoined.includes("Bring in something new"), `quartet header (similar): ${simJoined}`);
  for (const t of IMPORT_CARD_TITLES) {
    assert.ok(simJoined.includes(t), `"${t}" reachable in Similar mode: ${simJoined}`);
  }
  sim.unmount();
});

test("the dead 'Ask Kiwi — coming in WS6' premium pill is gone from both modes", async () => {
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(AI_RESPONSE),
  });

  for (const mode of ["different", "similar"] as SwapMode[]) {
    const renderer = await renderSheet(mode);
    const joined = textLeavesOf(renderer.root).join(" | ");
    assert.ok(!joined.includes("coming in WS6"), `no dead pill copy (${mode}): ${joined}`);
    assert.ok(
      !joined.includes("Ask Kiwi for a recommendation"),
      `no dead Ask-Kiwi pill (${mode}): ${joined}`,
    );
    renderer.unmount();
  }
});
