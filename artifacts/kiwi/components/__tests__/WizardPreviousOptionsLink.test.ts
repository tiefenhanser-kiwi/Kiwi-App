// WS9 Redesign Arc Block 2c Part E — "See previous options" with both batch
// kinds stubbed on GET /wizard/last-batch: a PLANS batch pushes wizard-results
// in rehydrate mode exactly as before; a SHELF batch pushes the Pick screen
// re-hydrated from the stored cards; an empty shelf batch hides the link.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  __setForTests as seedSecureItem,
  __resetForTests as resetSecureStore,
} from "expo-secure-store";
import { __resetRouterForTests, __setRouterForTests } from "expo-router";

import { WizardPreviousOptionsLink } from "../WizardPreviousOptionsLink";

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };
type Tree = Json | string | null | (Json | string)[];
function walk(node: Tree): Json[] {
  if (node == null || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap((c) => walk(c));
  const kids = Array.isArray(node.children) ? node.children.flatMap((c) => walk(c)) : [];
  return [node, ...kids];
}
function allText(node: Tree): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(allText);
  return Array.isArray(node.children) ? node.children.flatMap(allText) : [];
}

const CANDIDATE = {
  id: "c1", title: "Cozy Week", tags: [], whyBullets: [], mealTitles: ["Soup"],
  dailyMacros: { calories: 500, proteinG: 30, carbsG: 50, fatG: 20 },
};
const CARD = {
  id: "m1", title: "Miso Salmon", description: null, cuisineType: "Japanese", difficulty: "easy",
  estimatedTimeMinutes: 30, activeTimeMinutes: 15,
  macrosPerServing: { calories: 500, protein: 30, carbs: 40, fat: 20 }, tags: [], dishCount: 2,
  isNewToYou: true, isPlaylist: false, isPinned: false, matchesCuisine: true, source: "catalog",
};
const SHELF_INPUT = {
  planDurationDays: 4, householdSize: 3, cuisines: [], difficulty: "medium",
  weeklyPacing: "mixed", maxCookTimeMinutes: null,
};

const originalFetch = globalThis.fetch;
let batch: unknown = null;
let pushed: { pathname: string; params: Record<string, string> }[] = [];

beforeEach(() => {
  resetSecureStore();
  seedSecureItem("kiwi_authToken", "test-token");
  pushed = [];
  __setRouterForTests({ push: (href: unknown) => pushed.push(href as (typeof pushed)[number]) });
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string) => {
    const headers = { "Content-Type": "application/json" };
    if (String(url).endsWith("/wizard/last-batch"))
      return Promise.resolve(new Response(JSON.stringify({ batch }), { status: 200, headers }));
    return Promise.resolve(new Response("{}", { status: 404, headers }));
  }) as unknown as typeof fetch;
});
let mounted: { renderer: TestRenderer.ReactTestRenderer; client: QueryClient } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.renderer.unmount());
    mounted.client.clear();
    mounted = null;
  }
  resetSecureStore();
  __resetRouterForTests();
  globalThis.fetch = originalFetch;
});

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(WizardPreviousOptionsLink),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  mounted = { renderer, client };
  return {
    root: () => renderer.toJSON() as Tree,
    text: () => allText(renderer.toJSON() as Tree).join(" "),
    tap: async () => {
      const link = walk(renderer.toJSON() as Tree).find(
        (n) => n.props.accessibilityRole === "button",
      );
      assert.ok(link, "link not rendered");
      await act(async () => {
        (link!.props.onPress as () => void)();
      });
    },
  };
}

test("plans batch: wizard-results in rehydrate mode (unchanged)", async () => {
  batch = {
    source: "wizard",
    candidates: [CANDIDATE],
    input: { planDurationDays: 5 },
    createdAt: "2026-09-16T00:00:00.000Z",
  };
  const m = await mount();
  assert.ok(m.text().includes("Your last generated plan"), m.text());
  await m.tap();
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].pathname, "/wizard-results");
  assert.equal(pushed[0].params.rehydrate, "1");
  assert.deepEqual(JSON.parse(pushed[0].params.rehydratedCandidates), [CANDIDATE]);
});

test("shelf batch: the Pick screen re-hydrated from the stored cards, no selection", async () => {
  batch = {
    source: "shelf",
    candidates: [],
    shelf: { meals: [CARD], totalEligible: 12, hasMore: true, unmatchedNames: [], metadata: null },
    input: SHELF_INPUT,
    createdAt: "2026-09-16T00:00:00.000Z",
  };
  const m = await mount();
  assert.ok(m.text().includes("Your last suggested meal"), m.text());
  await m.tap();
  assert.equal(pushed.length, 1);
  // THE BREAK THIS CATCHES: a shelf batch routed to the plans chooser.
  assert.equal(pushed[0].pathname, "/pick-meals");
  const shelf = JSON.parse(pushed[0].params.shelf);
  assert.deepEqual(shelf.meals.map((c: { id: string }) => c.id), ["m1"]);
  assert.equal(pushed[0].params.planDurationDays, "4");
  assert.equal(pushed[0].params.rehydratedCandidates, undefined);
});

test("empty shelf batch (the server nulls a fully-stale one): the link hides", async () => {
  batch = {
    source: "shelf",
    candidates: [],
    shelf: { meals: [], totalEligible: 0, hasMore: false, unmatchedNames: [], metadata: null },
    input: SHELF_INPUT,
    createdAt: "2026-09-16T00:00:00.000Z",
  };
  const m = await mount();
  assert.equal(m.root(), null, "nothing rendered");
});
