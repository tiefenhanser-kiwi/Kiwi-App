// WS9 3d Part 4 (D-WS9-018) + WS9 3f-4 — SwapMealSheet behavior tests.
//   - Different mode renders the filter-chip browser, excludes the source meal,
//     picks a real row, and (3f-4 Thread B) paginates via useInfiniteMeals.
//   - Similar mode runs the AI ranking pipeline: renders AI-ordered matches,
//     drops unmatched candidates, renders the error state on AI hard-failure, and
//     (3f-4 Thread E) de-duplicates the pool by dish identity and hard-caps the
//     model payload at 60.
//   - The import chooser lives in a PINNED bar (3f-4 Thread B); its quartet is
//     reachable in BOTH modes once expanded — the lossless-merge guard.
//   - The Ask-Kiwi card mounts the creator INLINE (3f-4 Thread A); a swap-context
//     creation threads the REPLACE params into the meal-builder push.
//
// Harness: reads (useMeal source + useMeals/useInfiniteMeals pools) are primed
// into the QueryClient cache (staleTime Infinity → no network); an auth token is
// seeded; global.fetch is stubbed so only the find-similar + parse-meal calls
// hit the wire. `.test.ts` (not .tsx) with React.createElement.

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
import {
  __setRouterForTests,
  __resetRouterForTests,
} from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SwapMealSheet, type SwapMode } from "../SwapMealSheet";
import type { MealDetail, MealListResponse } from "@/lib/api/meals";
import type { MealSummary } from "@/lib/types";

const SOURCE_ID = "src-1";
// Mirrors the module-private constants in SwapMealSheet; the react-query key is
// hashed by stable JSON so a structural copy collides with the in-component key.
const SIMILAR_BUCKETS = ["my_meals", "featured", "top_rated", "hosting"];
const SIMILAR_LIMIT = 60; // SIMILAR_CANDIDATE_LIMIT
const DIFFERENT_BUCKET = ["my_meals"];
const DIFFERENT_SORT = "alpha"; // toMealSortKey("alpha")

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

const PARSE_MEAL_SUCCESS = {
  status: "success",
  meal: {
    title: "Chicken Piccata",
    cuisine: "Italian",
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 20,
    servingsDefault: 4,
    difficulty: "medium",
    tags: [],
    subDishes: [],
  },
};

interface FetchStubResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

let fetchCalls: string[] = [];
let lastFindSimilarBody: { candidates: { id: string; title: string }[] } | null =
  null;
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

function pressableWithText(
  root: TestRenderer.ReactTestInstance,
  substr: string,
): TestRenderer.ReactTestInstance | undefined {
  return root
    .findAllByType(Pressable)
    .find((p) => textLeavesOf(p).some((t) => t.includes(substr)));
}

async function expandImportBar(renderer: TestRenderer.ReactTestRenderer) {
  const toggle = pressableWithText(renderer.root, "Bring in something new");
  assert.ok(toggle, "import bar toggle not found");
  await act(async () => {
    toggle!.props.onPress();
  });
}

beforeEach(() => {
  resetSecureStore();
  __resetRouterForTests();
  seedSecureItem("kiwi_authToken", "test-token");
  fetchCalls = [];
  lastFindSimilarBody = null;
  (globalThis as { fetch?: unknown }).fetch = (async (
    url: string,
    init?: { body?: string },
  ) => {
    fetchCalls.push(String(url));
    if (String(url).includes("/meals/find-similar") && init?.body) {
      lastFindSimilarBody = JSON.parse(String(init.body));
    }
    return fetchImpl(String(url));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  resetSecureStore();
  __resetRouterForTests();
});

function primedClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["meals", "detail", SOURCE_ID, null], SOURCE_MEAL);
  // Similar mode now requests a bounded pool (limit 60).
  client.setQueryData(
    ["meals", "list", SIMILAR_BUCKETS, SIMILAR_LIMIT],
    SIMILAR_CANDIDATES,
  );
  // Different mode now uses useInfiniteMeals (server-sorted alpha).
  client.setQueryData(["meals", "list", DIFFERENT_BUCKET, DIFFERENT_SORT], {
    pages: [DIFFERENT_MEALS],
    pageParams: [undefined],
  });
  return client;
}

async function renderSheet(
  mode: SwapMode,
  opts: {
    onPick?: (m: MealSummary) => void;
    client?: QueryClient;
    planId?: string;
    planItemId?: string;
    onClose?: () => void;
  } = {},
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
          planId: opts.planId,
          planItemId: opts.planItemId,
          onClose: opts.onClose ?? (() => {}),
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
  const joined = textLeavesOf(renderer.root).join(" | ");

  assert.ok(joined.includes("Change meal"), `different-mode title: ${joined}`);
  assert.ok(joined.includes("My Meals"), `filter chips present: ${joined}`);
  assert.ok(joined.includes("Featured"), `filter chips present: ${joined}`);
  assert.ok(!joined.includes("Similar meals"), `no similar section: ${joined}`);

  assert.ok(joined.includes("Chicken Tacos"), `bucket row renders: ${joined}`);
  assert.ok(joined.includes("Veggie Stir Fry"), `bucket row renders: ${joined}`);
  assert.ok(
    !joined.includes("Spaghetti Carbonara"),
    `the source meal must be excluded from its own replacement list: ${joined}`,
  );

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

  const row = pressableWithText(renderer.root, "Chicken Tacos");
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

// ── Similar mode ────────────────────────────────────────────────────────────

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

  const row = pressableWithText(renderer.root, "Bucatini Amatriciana");
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
  client.setQueryData(
    ["meals", "list", SIMILAR_BUCKETS, SIMILAR_LIMIT],
    FRACTIONAL,
  );
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

// ── WS9 3f-4 Thread E: de-dup + bounded payload ─────────────────────────────

test("Similar mode: pool is de-duplicated by title and the payload is hard-capped at 60", async () => {
  // 65 distinct dishes + 5 exact-title duplicates = 70 rows. After title-dedup:
  // 65 unique; after the 60 hard-cap: 60 sent.
  const meals = [];
  for (let i = 1; i <= 65; i++) {
    meals.push(listItem(`u-${i}`, `Dish Number ${String(i).padStart(3, "0")}`));
  }
  for (let i = 1; i <= 5; i++) {
    meals.push(listItem(`dup-${i}`, `Dish Number ${String(i).padStart(3, "0")}`));
  }
  const BIG: MealListResponse = { meals, nextCursor: null };

  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        matches: [],
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
  client.setQueryData(["meals", "list", SIMILAR_BUCKETS, SIMILAR_LIMIT], BIG);
  const renderer = await renderSheet("similar", { client });

  assert.ok(lastFindSimilarBody, "find-similar was not called");
  const sent = lastFindSimilarBody!.candidates;
  assert.equal(sent.length, 60, `hard cap holds: sent ${sent.length}`);
  const titles = sent.map((c) => c.title.toLowerCase().trim());
  assert.equal(
    new Set(titles).size,
    titles.length,
    "no duplicate titles reach the model",
  );
  assert.ok(
    !sent.some((c) => c.id === SOURCE_ID),
    "the source meal is excluded from the payload",
  );

  renderer.unmount();
});

// ── WS9 3f-4 follow-on: rendered result count (target 8, post-dedup) ─────────

// A pool of N distinct-title candidates (c-1.., "Sim 01"..) primed under the
// Similar key, plus a QueryClient reading it.
function primedSimilarPool(n: number): {
  client: QueryClient;
  title: (i: number) => string;
  id: (i: number) => string;
} {
  const id = (i: number) => `c-${i}`;
  const title = (i: number) => `Sim ${String(i).padStart(2, "0")}`;
  const meals = [];
  for (let i = 1; i <= n; i++) meals.push(listItem(id(i), title(i)));
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["meals", "detail", SOURCE_ID, null], SOURCE_MEAL);
  client.setQueryData(
    ["meals", "list", SIMILAR_BUCKETS, SIMILAR_LIMIT],
    { meals, nextCursor: null } as MealListResponse,
  );
  return { client, title, id };
}

function renderedSimRows(root: TestRenderer.ReactTestInstance): string[] {
  return textLeavesOf(root).filter((t) => /^Sim \d\d$/.test(t));
}

test("Similar mode: renders exactly 8 even when the returned set carries duplicate ids", async () => {
  const { client, id, title } = primedSimilarPool(12);
  // 12 returned ids, but c-1 and c-2 each appear twice → 10 distinct after the
  // post-rank dedupe. The 8-cap then renders the top 8 DISTINCT dishes.
  const returnedIds = [
    id(1), id(1), id(2), id(2), id(3), id(4), id(5), id(6), id(7), id(8), id(9), id(10),
  ];
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        matches: returnedIds.map((mealId, k) => ({
          mealId,
          similarityScore: 0.9 - k * 0.01,
          reason: "x",
        })),
        metadata: { promptVersion: 1, latencyMs: 5, mode: "ai" },
      }),
  });
  const renderer = await renderSheet("similar", { client });

  const rows = renderedSimRows(renderer.root);
  assert.equal(rows.length, 8, `renders exactly 8 (got ${rows.length}: ${rows})`);
  assert.equal(new Set(rows).size, 8, "the 8 are distinct dishes (dupes collapsed)");
  // Top 8 by rank are Sim 01..08; the extras (Sim 09/10) are NOT padded in.
  for (let i = 1; i <= 8; i++) {
    assert.ok(rows.includes(title(i)), `${title(i)} rendered`);
  }
  assert.ok(!rows.includes(title(9)), "does not render beyond the 8-cap (no filler)");

  renderer.unmount();
});

test("Similar mode: renders FEWER than 8 when the model returns fewer distinct — no padding", async () => {
  const { client, id, title } = primedSimilarPool(12);
  // The model deems only 5 candidates similar (quality gate) — render 5, not 8.
  const returnedIds = [id(1), id(2), id(3), id(4), id(5)];
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        matches: returnedIds.map((mealId, k) => ({
          mealId,
          similarityScore: 0.9 - k * 0.05,
          reason: "x",
        })),
        metadata: { promptVersion: 1, latencyMs: 5, mode: "ai" },
      }),
  });
  const renderer = await renderSheet("similar", { client });

  const rows = renderedSimRows(renderer.root);
  assert.equal(rows.length, 5, `renders the 5 good matches, not padded to 8 (got ${rows.length})`);
  assert.ok(!rows.includes(title(6)), "no lower-ranked filler added to reach 8");

  renderer.unmount();
});

// ── Lossless-merge guards ───────────────────────────────────────────────────

test("LOSSLESS: the import quartet is reachable from BOTH modes (pinned bar, expanded)", async () => {
  fetchImpl = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(AI_RESPONSE),
  });

  for (const mode of ["different", "similar"] as SwapMode[]) {
    const renderer = await renderSheet(mode);
    // The pinned bar's label is always present; the quartet appears on expand.
    const collapsed = textLeavesOf(renderer.root).join(" | ");
    assert.ok(
      collapsed.includes("Bring in something new"),
      `pinned bar label (${mode}): ${collapsed}`,
    );
    await expandImportBar(renderer);
    const expanded = textLeavesOf(renderer.root).join(" | ");
    for (const t of IMPORT_CARD_TITLES) {
      assert.ok(expanded.includes(t), `"${t}" reachable in ${mode} mode: ${expanded}`);
    }
    renderer.unmount();
  }
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

// ── WS9 3f-4 Thread A: inline Ask-Kiwi creator ──────────────────────────────

test("Thread A: the Ask-Kiwi card mounts the creator INLINE (does not route away)", async () => {
  fetchImpl = () => ({ ok: true, status: 200, text: async () => "{}" });
  const pushes: unknown[] = [];
  __setRouterForTests({ push: (a: unknown) => pushes.push(a) });

  const renderer = await renderSheet("different");
  await expandImportBar(renderer);

  const askCard = pressableWithText(renderer.root, "Ask Kiwi for a meal");
  assert.ok(askCard, "Ask-Kiwi card not found in expanded bar");
  await act(async () => {
    askCard!.props.onPress();
  });

  // Inline creator is now mounted (the input testID appears); no navigation fired.
  const input = renderer.root.findAll(
    (n) => n.props?.testID === "ask-kiwi-input",
  );
  assert.ok(input.length >= 1, "the inline Ask-Kiwi input is mounted in-sheet");
  assert.equal(pushes.length, 0, "opening the creator must not route away");

  renderer.unmount();
});

test("Thread A: a swap-context creation threads the REPLACE params (not append)", async () => {
  fetchImpl = (url: string) =>
    url.includes("/builder/parse-meal")
      ? { ok: true, status: 200, text: async () => JSON.stringify(PARSE_MEAL_SUCCESS) }
      : { ok: true, status: 200, text: async () => "{}" };
  const pushes: { pathname?: string; params?: Record<string, unknown> }[] = [];
  __setRouterForTests({
    push: (a: unknown) =>
      pushes.push(a as { pathname?: string; params?: Record<string, unknown> }),
  });
  let closed = false;

  const renderer = await renderSheet("different", {
    planId: "plan-1",
    planItemId: "item-1",
    onClose: () => (closed = true),
  });
  await expandImportBar(renderer);

  const askCard = pressableWithText(renderer.root, "Ask Kiwi for a meal");
  assert.ok(askCard, "Ask-Kiwi card not found");
  await act(async () => {
    askCard!.props.onPress();
  });

  const input = renderer.root.find((n) => n.props?.testID === "ask-kiwi-input");
  await act(async () => {
    input.props.onChangeText("chicken piccata");
  });
  const submitBtn = renderer.root
    .findAll(
      (n) =>
        n.props?.testID === "ask-kiwi-submit" &&
        typeof n.props?.onPress === "function",
    )[0];
  await act(async () => {
    await submitBtn.props.onPress();
    await wait(250); // past the 150ms close→push defer
  });

  assert.equal(closed, true, "the sheet closes before navigating");
  const mbPush = pushes.find((p) => p.pathname === "/meal-builder");
  assert.ok(mbPush, `expected a /meal-builder push, got: ${JSON.stringify(pushes)}`);
  assert.equal(mbPush!.params?.planId, "plan-1", "REPLACE: planId threaded");
  assert.equal(mbPush!.params?.planItemId, "item-1", "REPLACE: planItemId threaded");
  assert.equal(
    mbPush!.params?.addToPlanId,
    undefined,
    "REPLACE must NOT thread addToPlanId (that would append, not replace)",
  );
  assert.equal(mbPush!.params?.draftSource, "text");
  assert.ok(mbPush!.params?.draftJson, "the parsed draft rides along");

  renderer.unmount();
});
