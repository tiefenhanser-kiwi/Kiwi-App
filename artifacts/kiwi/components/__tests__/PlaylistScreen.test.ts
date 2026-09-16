// WS9 Redesign Arc Block 2b Part A (D-WS9-234) — the Playlist tab's screen.
//
// Mounts the real screen against a faked GET /me/playlist (the route's REAL
// shape) and pins: N rows + the header count; the "in this week's plan" chip
// when the active plan's detail is cached (and ONLY then — it never fetches);
// Remove → DELETE /me/playlist/:id and the row drops; the empty state at 0 and
// its disabled "Plan a week from these".

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

import {
  EMPTY_TITLE,
  IN_PLAN_CHIP,
  MENU_REMOVE,
  PLAYLIST_INTRO,
  PlaylistScreen,
  playlistMacroLine,
  playlistMetaLine,
  playlistPills,
} from "../PlaylistScreen";
import type { PlaylistMeal } from "@/lib/api/playlist";

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
function joined(node: Tree): string {
  return allText(node).join(" ").replace(/\s+/g, " ");
}
function byLabel(root: Tree, label: string): Json | undefined {
  return walk(root).find((n) => n.props.accessibilityLabel === label);
}
function byTestId(root: Tree, id: string): Json | undefined {
  return walk(root).find((n) => n.props.testID === id);
}

function meal(id: string, title: string, extra: Partial<PlaylistMeal> = {}): PlaylistMeal {
  return {
    id,
    title,
    description: null,
    cuisineType: "Italian",
    difficulty: "easy",
    estimatedTimeMinutes: 35,
    activeTimeMinutes: 15,
    macrosPerServing: { calories: 500, protein: 30, carbs: 40, fat: 20 },
    tags: [],
    dishCount: 2,
    isPlaylist: true,
    isNewToYou: false,
    source: "playlist",
    addedAt: "2026-09-16T10:00:00.000Z",
    ...extra,
  };
}
const THREE = [
  meal("m1", "Grandma's Lasagna"),
  meal("m2", "Miso Salmon", { cuisineType: "Japanese", activeTimeMinutes: null }),
  meal("m3", "Sunday Braise", { difficulty: "fancy", estimatedTimeMinutes: 120 }),
];

const originalFetch = globalThis.fetch;
let playlist: PlaylistMeal[] = THREE;
let calls: { path: string; method: string }[] = [];
let pushed: unknown[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  resetSecureStore();
  seedSecureItem("kiwi_authToken", "test-token");
  playlist = THREE;
  calls = [];
  pushed = [];
  __setRouterForTests({ push: (href: unknown) => pushed.push(href) });
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const path = u.slice(u.indexOf("/api") + 4);
    calls.push({ path, method });
    if (path === "/me/playlist" && method === "GET")
      return Promise.resolve(jsonResponse({ playlist, count: playlist.length }));
    if (path.startsWith("/me/playlist/") && method === "DELETE") {
      // The real route deletes the row; the refetch after onSettled sees it gone.
      const id = decodeURIComponent(path.slice("/me/playlist/".length));
      playlist = playlist.filter((m) => m.id !== id);
      return Promise.resolve(jsonResponse(null, 204));
    }
    // BUG-282 — GET /home carries ?localDate=YYYY-MM-DD.
    if (path.split("?")[0] === "/home")
      return Promise.resolve(
        jsonResponse({
          todaysMeal: null,
          activePlan: {
            id: "plan-1",
            name: "Cozy Week",
            status: "this_week",
            startDate: "2026-09-14",
            endDate: "2026-09-20",
            revisionId: 3,
            groceryListId: null,
          },
          firstPlanCreatedAt: "2026-08-01T00:00:00.000Z",
        }),
      );
    return Promise.resolve(jsonResponse({ error: "not found" }, 404));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  resetSecureStore();
  __resetRouterForTests();
  globalThis.fetch = originalFetch;
});

let screen: { renderer: TestRenderer.ReactTestRenderer; client: QueryClient } | null = null;
afterEach(async () => {
  if (screen) {
    const { renderer, client } = screen;
    await act(async () => {
      renderer.unmount();
    });
    client.clear();
    screen = null;
  }
});

async function mount(seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(QueryClientProvider, { client }, React.createElement(PlaylistScreen)),
    );
  });
  // Two reads (playlist + home) must settle before the cache-only plan read
  // can resolve its key; give the fake server a full turn under a loaded suite.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
  screen = { renderer, client };
  return {
    root: () => renderer.toJSON() as unknown as Tree,
    text: () => joined(renderer.toJSON() as unknown as Tree),
  };
}
async function tap(node: Json | undefined, what: string) {
  assert.ok(node, `${what} not found`);
  await act(async () => {
    (node!.props.onPress as () => void)();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
}

test("renders N rows from the route's real shape, the count in the subline, the intro", async () => {
  const m = await mount();
  const t = m.text();
  assert.ok(t.includes("your go-to favorites · 3"), t);
  assert.ok(t.includes(PLAYLIST_INTRO));
  for (const title of ["Grandma's Lasagna", "Miso Salmon", "Sunday Braise"]) {
    assert.ok(byLabel(m.root(), title), `row ${title} missing`);
  }
  // Meta line — derived times AS SENT; a null active time renders "—". Block
  // 2c Part D: cuisine is a pill now (the My-Meals convention), not on the line.
  assert.ok(t.includes("35 min · 15 min hands-on · easy"), t);
  assert.ok(t.includes("35 min · — min hands-on · easy"), t);
  assert.ok(t.includes("Italian") && t.includes("Japanese"), "cuisine pills");
  assert.ok(!/last cooked/i.test(t), "BUG-275: no 'last cooked' anywhere");
  assert.ok(!byTestId(m.root(), "playlist-plan")!.props.disabled, "Plan a week enabled at 3");
});

test("playlistMetaLine drops an empty cuisine and keeps the order", () => {
  assert.equal(
    playlistMetaLine(meal("x", "X", { cuisineType: null })),
    "35 min · 15 min hands-on · easy",
  );
});

test("the 'in this week's plan' chip renders ONLY when the active plan's detail is cached — and never fetches it", async () => {
  // Cold cache: no chip, and GET /plans/plan-1 is NOT called.
  const cold = await mount();
  assert.ok(!cold.text().includes(IN_PLAN_CHIP), "chip rendered without a cached plan");
  assert.equal(calls.some((c) => c.path === "/plans/plan-1"), false, "the chip must never fetch the plan");
  await act(async () => {
    screen!.renderer.unmount();
  });
  screen!.client.clear();
  screen = null;
  calls = [];

  // Warm cache: the plan detail was opened this session → chip on m2 only.
  const warm = await mount((client) => {
    client.setQueryData(["plans", "detail", "plan-1"], {
      id: "plan-1",
      items: [{ mealId: "m2" }],
    });
  });
  const rows = walk(warm.root()).filter((n) => typeof n.props.accessibilityLabel === "string" && ["Grandma's Lasagna", "Miso Salmon", "Sunday Braise"].includes(n.props.accessibilityLabel as string));
  const withChip = rows.filter((r) => allText(r).includes(IN_PLAN_CHIP)).map((r) => r.props.accessibilityLabel);
  assert.deepEqual(withChip, ["Miso Salmon"]);
  assert.equal(calls.some((c) => c.path === "/plans/plan-1"), false);
});

test("Remove from playlist → DELETE /me/playlist/:id and the row drops (optimistic)", async () => {
  const m = await mount();
  // Open the row's menu, choose Remove (the sheet defers the handler ~150ms).
  await tap(byLabel(m.root(), "More for Miso Salmon"), "⋯ trigger");
  await tap(byLabel(m.root(), MENU_REMOVE), "Remove item");
  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del, "DELETE not called");
  assert.equal(del!.path, "/me/playlist/m2");
  assert.equal(byLabel(m.root(), "Miso Salmon"), undefined, "the row should be gone");
  assert.ok(byLabel(m.root(), "Grandma's Lasagna"));
});

test("empty state at 0: the intro, the card, 'Add meals', and 'Plan a week from these' disabled", async () => {
  playlist = [];
  const m = await mount();
  const t = m.text();
  assert.ok(t.includes("your go-to favorites · 0"));
  assert.ok(t.includes(PLAYLIST_INTRO));
  assert.ok(t.includes(EMPTY_TITLE));
  assert.equal(byTestId(m.root(), "playlist-plan")!.props.disabled, true);
  await tap(byTestId(m.root(), "playlist-add"), "Add meals");
  assert.deepEqual(pushed, [{ pathname: "/meal-builder", params: { toPlaylist: "1" } }]);
});

test("'Plan a week from these' routes to the Pick screen in playlist mode", async () => {
  const m = await mount();
  await tap(byTestId(m.root(), "playlist-plan"), "Plan a week");
  assert.deepEqual(pushed, [{ pathname: "/pick-meals", params: { source: "playlist" } }]);
});

// ── Block 2c Part D — the row is the My-Meals shape, and the whole row taps ─

test("the whole row taps through to Meal Detail; the menu keeps View meal beside Remove", async () => {
  const m = await mount();
  await tap(byLabel(m.root(), "Miso Salmon"), "row");
  assert.deepEqual(pushed, [{ pathname: "/meal/[id]", params: { id: "m2" } }]);
  const menu = byLabel(m.root(), "More for Miso Salmon");
  assert.ok(menu, "the ⋯ menu stays");
  await tap(menu, "⋯ trigger");
  assert.ok(byLabel(m.root(), "View meal"), "View meal still in the menu");
  assert.ok(byLabel(m.root(), MENU_REMOVE));
});

test("row shape: description (two lines) + macros line + cuisine/tag pills when the card carries them", async () => {
  playlist = [
    meal("m9", "Weeknight Ramen", {
      description: "Quick miso broth with soft eggs and greens.",
      cuisineType: "Japanese",
      tags: ["japanese", "quick", "easy"],
      macrosPerServing: { calories: 520.4, protein: 28, carbs: 61, fat: 17 },
    }),
  ];
  const m = await mount();
  const row = byLabel(m.root(), "Weeknight Ramen")!;
  const desc = walk(row).find((n) => allText(n).join("") === "Quick miso broth with soft eggs and greens.");
  assert.ok(desc, "description renders");
  assert.equal(desc!.props.numberOfLines, 2);
  const t = joined(row);
  assert.ok(t.includes("520 cal · 28g P · 61g C · 17g F"), t);
  // Pills: cuisine first, tags de-duped against it and the difficulty (BUG-284).
  assert.deepEqual(playlistPills(playlist[0]), ["Japanese", "quick"]);
  assert.equal(allText(row).filter((x) => x.toLowerCase() === "japanese").length, 1, "one Japanese pill");
  assert.equal(allText(row).filter((x) => x === "easy").length, 0, "no difficulty pill");
  assert.ok(t.includes("hands-on · easy"), "difficulty on the meta line");
});

test("row shape: no description and all-zero macros → neither line renders (the pre-widening shape)", async () => {
  playlist = [
    meal("m8", "Plain Toast", {
      description: null,
      cuisineType: null,
      tags: [],
      macrosPerServing: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    }),
  ];
  const m = await mount();
  const row = byLabel(m.root(), "Plain Toast")!;
  const t = joined(row);
  assert.ok(!t.includes(" cal ·"), "no macros line for zeros");
  assert.equal(playlistMacroLine({}), null, "absent field tolerated");
  assert.equal(playlistMacroLine({ macrosPerServing: undefined }), null);
  assert.ok(t.includes("35 min · 15 min hands-on · easy"));
  assert.deepEqual(playlistPills(playlist[0]), []);
});

// ── Block 2c Part A — the bulk intake's review sheet over the tab ───────────

test("review sheet: staged saves show the sheet with Hans's copy; Review › hides it and opens the editor with reviewReturn; the editor's save flips the row; Done clears", async () => {
  const { stageImportReview, markImportReviewed, getImportReview } = await import(
    "@/lib/builder/playlistImportReview"
  );
  const { IMPORT_REVIEW_TITLE, IMPORT_REVIEW_BODY, IMPORT_REVIEWED } = await import(
    "../PlaylistImportReviewSheet"
  );
  stageImportReview([
    { mealId: "m1", title: "Grandma's Lasagna" },
    { mealId: "m2", title: "Miso Salmon" },
  ]);
  const m = await mount();
  const sheet = () => walk(m.root()).find((n) => n.type === "rn-modal");
  // The Modal stub renders nothing while !visible — presence IS visibility.
  assert.ok(sheet(), "the sheet shows over the tab");
  const t = m.text();
  assert.ok(t.includes(IMPORT_REVIEW_TITLE) && t.includes(IMPORT_REVIEW_BODY), t);
  assert.ok(byLabel(m.root(), "Imported Grandma's Lasagna") && byLabel(m.root(), "Imported Miso Salmon"));
  // Done is live with nothing reviewed — nothing is required.
  assert.ok(!byTestId(m.root(), "playlist-import-done")!.props.disabled);

  await tap(byLabel(m.root(), "Review Miso Salmon"), "Review ›");
  assert.deepEqual(pushed, [
    { pathname: "/meal-builder", params: { mealId: "m2", reviewReturn: "playlist" } },
  ]);
  assert.equal(sheet(), undefined, "hidden while the editor is open above the tab");

  // The editor saved (meal-builder calls this on a reviewReturn=playlist save).
  await act(async () => {
    markImportReviewed("m2");
  });
  assert.ok(sheet(), "shown again");
  assert.ok(byTestId(m.root(), "import-reviewed-m2"), "the row flipped to Reviewed ✓");
  assert.ok(m.text().includes(IMPORT_REVIEWED));
  assert.ok(byLabel(m.root(), "Review Grandma's Lasagna"), "the other row still offers Review");

  await tap(byTestId(m.root(), "playlist-import-done"), "Done");
  assert.equal(sheet(), undefined);
  assert.deepEqual(getImportReview().items, []);
});
