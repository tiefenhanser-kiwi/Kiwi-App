// WS9 Redesign Arc Block 2a Part D (D-WS9-237) — the Pick screen + its card.
//
// The card renders every field from a fixture in the shelf's REAL shape (three
// cards: playlist-flagged, new-to-you, over cap); the screen counts rounds 4 vs
// 2 by totalEligible, replaces the button with the exhausted card on
// hasMore:false, pages the shelf BY EXCLUSION, posts the picked ids + localDate
// on "Build my week" and routes on 201, and COUNTS over-cap picks rather than
// blocking them (D-WS9-235).

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

import { ToastProvider } from "@/contexts/ToastProvider";
import { Colors, Palette } from "@/constants/tokens";
import type { ShelfMeal, WizardShelfResponse } from "@/lib/api/wizard";
import { todayLocalDate } from "@/lib/dates";
import {
  MealPickCard,
  NEW_TO_YOU_PILL,
  overCapPill,
  PLAYLIST_PILL,
} from "../MealPickCard";
import {
  EXHAUSTED_TITLE,
  MORE_LABEL,
  PickMealsScreen,
  PlaylistPickScreen,
  PLAYLIST_PICK_TITLE,
  type PickMealsScreenProps,
} from "../PickMealsScreen";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};
// toJSON() returns an ARRAY once the toast mounts beside the screen — both
// helpers accept it.
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
  return allText(node).join("").replace(/\s+/g, " ");
}
function flatten(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === "function"
      ? (style as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : style;
  const parts = Array.isArray(resolved) ? resolved : [resolved];
  return Object.assign({}, ...parts.filter(Boolean));
}
function byTestId(root: Json, id: string): Json | undefined {
  return walk(root).find((n) => n.props.testID === id);
}
function byLabel(root: Json, label: string): Json | undefined {
  return walk(root).find((n) => n.props.accessibilityLabel === label);
}

// ── fixtures: the shelf's real shape ───────────────────────────────────────

function meal(id: string, extra: Partial<ShelfMeal> = {}): ShelfMeal {
  return {
    id,
    title: `Meal ${id}`,
    description: `A ${id} description`,
    cuisineType: "Italian",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    activeTimeMinutes: 15,
    macrosPerServing: { calories: 512.4, protein: 31, carbs: 44.6, fat: 18 },
    tags: ["weeknight"],
    dishCount: 2,
    isNewToYou: false,
    isPlaylist: false,
    isPinned: false,
    matchesCuisine: true,
    source: "shelf",
    ...extra,
  };
}
const PLAYLIST_MEAL = meal("p1", { title: "Grandma's Lasagna", isPlaylist: true, source: "playlist" });
const NEW_MEAL = meal("n1", { title: "Miso Salmon", isNewToYou: true, cuisineType: "Japanese" });
const OVER_CAP_MEAL = meal("o1", {
  title: "Sunday Braise",
  estimatedTimeMinutes: 120,
  activeTimeMinutes: 40,
  difficulty: "fancy",
});
const THREE = [PLAYLIST_MEAL, NEW_MEAL, OVER_CAP_MEAL];

function shelf(meals: ShelfMeal[], totalEligible: number, hasMore = true): WizardShelfResponse {
  return { meals, totalEligible, hasMore, unmatchedNames: [] };
}
const REQUEST = {
  planDurationDays: 5,
  householdSize: 4,
  cuisines: ["Italian"],
  difficulty: "medium" as const,
  weeklyPacing: "mixed" as const,
};

// ── the card ───────────────────────────────────────────────────────────────

let cardMounted: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  cardMounted?.unmount();
  cardMounted = null;
});
function renderCard(m: ShelfMeal, selected = false, capMinutes: number | null = 45) {
  let tree!: TestRenderer.ReactTestRenderer;
  const toggles: string[] = [];
  act(() => {
    tree = TestRenderer.create(
      React.createElement(MealPickCard, {
        meal: m,
        selected,
        capMinutes,
        onToggle: () => toggles.push(m.id),
      }),
    );
  });
  cardMounted = tree;
  return { root: tree.toJSON() as unknown as Json, toggles };
}

test("card: every field renders from the shelf shape — name, description, times, macros, tags", () => {
  const { root } = renderCard(PLAYLIST_MEAL);
  const t = joined(root);
  assert.ok(t.includes("Grandma's Lasagna"));
  assert.ok(t.includes("A p1 description"));
  // Times AS SENT (derived), never computed.
  assert.ok(t.includes("30 min total"), t);
  assert.ok(t.includes("15 min active"), t);
  // Macros per serving, rounded at render.
  assert.ok(t.includes("512 kcal"), t);
  assert.ok(t.includes("31g protein"), t);
  assert.ok(t.includes("45g carbs"), t);
  assert.ok(t.includes("18g fat"), t);
  // Tags: cuisine · difficulty · attributes.
  for (const tag of ["Italian", "easy", "weeknight"]) assert.ok(t.includes(tag), tag);
});

test("card: the playlist pill renders only on a playlist meal, in sage", () => {
  const { root } = renderCard(PLAYLIST_MEAL);
  const pill = walk(root).find(
    (n) => n.type === "rn-text" && allText(n).join("") === PLAYLIST_PILL,
  );
  assert.ok(pill, "playlist pill missing");
  assert.equal(flatten(pill!.props.style).color, Colors.sage[700]);
  assert.ok(!joined(renderCard(NEW_MEAL).root).includes(PLAYLIST_PILL));
});

test("card: 'new to you' renders on the flagged meal in the gold badge pair", () => {
  const { root } = renderCard(NEW_MEAL);
  const pill = walk(root).find(
    (n) => n.type === "rn-text" && allText(n).join("") === NEW_TO_YOU_PILL,
  );
  assert.ok(pill, "new-to-you pill missing");
  assert.equal(flatten(pill!.props.style).color, Palette.badge.trial.text);
  assert.ok(!joined(renderCard(PLAYLIST_MEAL).root).includes(NEW_TO_YOU_PILL));
});

test("card: over the cap → the pill + a terracotta bold total, and the card STILL toggles", () => {
  const { root, toggles } = renderCard(OVER_CAP_MEAL, false, 45);
  const t = joined(root);
  assert.ok(t.includes(overCapPill(45)), t);
  const total = walk(root).find(
    (n) => n.type === "rn-text" && allText(n).join("") === "120 min total",
  );
  assert.ok(total, "terracotta total not found");
  assert.equal(flatten(total!.props.style).color, Colors.terracotta[600]);
  // D-WS9-235 — allowed, never blocked.
  act(() => {
    (byLabel(root, "Sunday Braise")!.props.onPress as () => void)();
  });
  assert.deepEqual(toggles, ["o1"]);
  // No cap → no pill.
  assert.ok(!joined(renderCard(OVER_CAP_MEAL, false, null).root).includes("over your"));
});

test("card: selected → sage-600 1.4px border on a sage-50 surface", () => {
  const { root } = renderCard(NEW_MEAL, true);
  const card = byLabel(root, "Miso Salmon")!;
  const st = flatten(card.props.style);
  assert.equal(st.borderColor, Colors.sage[600]);
  assert.equal(st.borderWidth, 1.4);
  assert.equal(st.backgroundColor, Colors.sage[50]);
});

// ── the screen ─────────────────────────────────────────────────────────────

const PREFS_FIXTURE = {
  spiceTolerance: "mild", budgetLevel: "economy", cookingSkill: "intermediate", stovetopType: "gas",
  defaultRetailer: null, cuisines: ["Italian"], allergiesAndAvoidances: ["Peanuts"], otherAllergies: [],
  cookingEquipment: [], recurringGroceryItems: [], eatingStyles: [], healthGoals: [], pickyAvoidances: [],
  householdSize: 3, kidsCount: 0, pickyEaterCount: 0, planLengthDefault: 4, wantsLeftovers: false,
  weeklyPacingDefault: "mixed", dietaryNotes: null, discoveryLevel: "none", playlistLevel: "some",
  saucePreference: "balanced", maxCookTimeMinutes: 45, maxCookTimeCoverage: "most",
};

const originalFetch = globalThis.fetch;
let calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
let replaced: unknown[] = [];
let pushed: unknown[] = [];
let dismissed: unknown[] = [];
let moreResponse: () => WizardShelfResponse = () => shelf([meal("x1"), meal("x2")], 40, true);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  resetSecureStore();
  seedSecureItem("kiwi_authToken", "test-token");
  calls = [];
  replaced = [];
  pushed = [];
  dismissed = [];
  __setRouterForTests({
    replace: (href: unknown) => replaced.push(href),
    push: (href: unknown) => pushed.push(href),
    dismissTo: (href: unknown) => dismissed.push(href),
  });
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path: u.slice(u.indexOf("/api") + 4), method, body });
    if (u.endsWith("/wizard/shelf")) return Promise.resolve(jsonResponse(moreResponse()));
    if (u.endsWith("/me/preferences"))
      return Promise.resolve(jsonResponse({ preferences: PREFS_FIXTURE }));
    if (u.endsWith("/plans/from-meals"))
      return Promise.resolve(
        jsonResponse(
          {
            planId: "plan-new",
            instance: { id: "plan-new", revisionId: 1 },
            demoted: { id: "plan-old", name: "Cozy Week" },
            startDate: "2026-09-17",
            endDate: "2026-09-21",
            days: [],
          },
          201,
        ),
      );
    // D-WS9-191 Block 2 Part C — the demotion toast names the plan as the SERVER
    // named it (lib/planTitle.ts), read off the plan detail after the 201.
    if (method === "GET" && u.endsWith("/plans/plan-new"))
      return Promise.resolve(
        jsonResponse({
          plan: {
            id: "plan-new",
            name: "Hans's meals, week of Sep 17",
            status: "this_week",
            startDate: "2026-09-17T00:00:00.000Z",
            endDate: "2026-09-21T00:00:00.000Z",
            revisionId: 1,
            isActiveThisWeek: true,
            userId: "user-1",
            sourceType: "directed",
            prepStatus: "not_prepped",
            prepStatusIsManual: false,
            optimizationNotes: [],
            breakfastOverrides: "",
            lunchOverrides: "",
            items: [],
            macroDailyAverage: { caloriesPerDay: 0, proteinGPerDay: 0, carbsGPerDay: 0, fatGPerDay: 0 },
          },
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

async function mount(props: Partial<PickMealsScreenProps> & { shelf: WizardShelfResponse }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(PickMealsScreen, {
            request: REQUEST,
            mode: "prefs",
            planDurationDays: 5,
            householdSize: 4,
            capMinutes: 45,
            ...props,
          }),
        ),
      ),
    );
  });
  screen = { renderer, client };
  return {
    root: () => renderer.toJSON() as unknown as Json,
    text: () => joined(renderer.toJSON() as unknown as Json),
  };
}
async function tap(node: Json | undefined, what: string) {
  assert.ok(node, `${what} not found`);
  await act(async () => {
    (node!.props.onPress as () => void)();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

test("screen: header N = totalEligible; rounds caption reads 4 on a normal shelf, 2 on a thin one", async () => {
  const normal = await mount({ shelf: shelf(THREE, 40) });
  assert.ok(normal.text().includes("40 fit your preferences · per serving · tap to add"));
  assert.ok(normal.text().includes("3 to 5 more meals · 4 rounds left"), normal.text());
  await act(async () => {
    screen!.renderer.unmount();
  });
  screen!.client.clear();
  screen = null;

  const thin = await mount({ shelf: shelf(THREE, 9) });
  assert.ok(thin.text().includes("9 fit your preferences"));
  assert.ok(thin.text().includes("3 to 5 more meals · 2 rounds left"), thin.text());
});

test("screen: hasMore:false → the exhausted card replaces 'Get more options'; a ZERO shelf shows it at once", async () => {
  const m = await mount({ shelf: shelf(THREE, 40, false) });
  assert.ok(m.text().includes(EXHAUSTED_TITLE));
  assert.equal(byLabel(m.root(), MORE_LABEL), undefined, "the button must be gone");
  await act(async () => {
    screen!.renderer.unmount();
  });
  screen!.client.clear();
  screen = null;

  const z = await mount({ shelf: shelf([], 0, false) });
  assert.ok(z.text().includes("0 fit your preferences"));
  assert.ok(z.text().includes(EXHAUSTED_TITLE));
});

test("screen: the exhausted card's two exits go BACK to the wizard on the stack (dismissTo, never push) with the params", async () => {
  const m = await mount({ shelf: shelf([], 0, false) });
  await tap(walk(m.root()).find((n) => n.props.onPress && allText(n).join("") === "Refine preferences"), "Refine");
  await tap(walk(m.root()).find((n) => n.props.onPress && allText(n).join("") === "Tell Kiwi"), "Tell Kiwi");
  // Block 2b (2a CANDIDATE-4, ruled) — no stack growth.
  assert.equal(pushed.length, 0, "the exits must not push a fresh wizard");
  const hrefs = dismissed as { pathname: string; params: Record<string, string> }[];
  assert.equal(hrefs.length, 2);
  assert.equal(hrefs[0].pathname, "/wizard");
  assert.equal(hrefs[0].params.adjust, "1");
  assert.match(hrefs[0].params.nonce, /^\d+$/);
  assert.equal(hrefs[1].pathname, "/tellkiwi");
  assert.equal(hrefs[1].params.focus, "1");
});

test("screen: 'Get more options' re-posts the shelf with EVERY shown id excluded and appends, keeping picks", async () => {
  const m = await mount({ shelf: shelf(THREE, 40) });
  await tap(byLabel(m.root(), "Miso Salmon"), "card n1");
  await tap(byLabel(m.root(), MORE_LABEL), "Get more options");
  const more = calls.find((c) => c.path === "/wizard/shelf");
  assert.ok(more, "the more-call did not hit /wizard/shelf");
  assert.equal(more!.method, "POST");
  // 🔴 THE BREAK THIS CATCHES: dropping excludeMealIds from the more-call.
  assert.deepEqual(more!.body.excludeMealIds, ["p1", "n1", "o1"]);
  assert.equal(more!.body.planDurationDays, 5, "the per-run body rides along");
  const t = m.text();
  assert.ok(t.includes("Meal x1") && t.includes("Meal x2"), "new cards appended");
  assert.ok(t.includes("3 rounds left"), t);
  assert.ok(t.includes("1 picked · 5-day plan"), "selection survived the round");
});

test("screen: 'Build my week' is disabled at 0 picks; with picks it POSTs the ids IN ORDER + localDate and routes on 201", async () => {
  const m = await mount({ shelf: shelf(THREE, 40) });
  assert.equal(byTestId(m.root(), "pick-build")!.props.disabled, true);
  await tap(byLabel(m.root(), "Sunday Braise"), "card o1");
  await tap(byLabel(m.root(), "Grandma's Lasagna"), "card p1");
  assert.ok(!byTestId(m.root(), "pick-build")!.props.disabled);
  await tap(byTestId(m.root(), "pick-build"), "Build my week");
  const post = calls.find((c) => c.path === "/plans/from-meals");
  assert.ok(post, "POST /plans/from-meals not called");
  assert.equal(post!.method, "POST");
  assert.deepEqual(post!.body.mealIds, ["o1", "p1"], "order picked, not display order");
  assert.equal(post!.body.planDurationDays, 5);
  assert.equal(post!.body.householdSize, 4);
  assert.equal(post!.body.localDate, todayLocalDate());
  assert.match(String(post!.body.localDate), /^\d{4}-\d{2}-\d{2}$/);
  // D-WS9-191 Block 2 Part C — the SERVER names the plan; no client title.
  assert.equal("title" in post!.body, false, "the 'Your picks' sentinel is no longer sent");
  assert.deepEqual(replaced, [{ pathname: "/plan/[id]", params: { id: "plan-new" } }]);
  // D-WS9-011a — the EXISTING demotion toast, off the response's `demoted`,
  // naming the plan as the server named it (read off GET /plans/:id).
  assert.ok(
    m.text().includes("Now cooking: Hans's meals, week of Sep 17. Cozy Week taken off this week."),
    `demotion toast missing: ${m.text()}`,
  );
});

test("screen: over-cap picks are COUNTED in the footer, never blocked", async () => {
  const m = await mount({ shelf: shelf(THREE, 40) });
  await tap(byLabel(m.root(), "Sunday Braise"), "card o1 (120 min, cap 45)");
  await tap(byLabel(m.root(), "Miso Salmon"), "card n1");
  const t = m.text();
  assert.ok(t.includes("2 picked · 5-day plan"), t);
  assert.ok(t.includes("fewer or more than 5 is fine · 1 over your 45-min cap"), t);
  assert.ok(!byTestId(m.root(), "pick-build")!.props.disabled, "an over-cap pick must not disable the build");
});

// ── Block 2b Part C — "Plan a week from these" (playlist mode) ──────────────

test("playlist mode: 'Pick from your playlist', '{N} in your playlist', NO more-button, NO exhausted card, Build still works", async () => {
  const m = await mount({ shelf: shelf(THREE, 3, false), source: "playlist" });
  const t = m.text();
  assert.ok(t.includes(PLAYLIST_PICK_TITLE), t);
  assert.ok(t.includes("3 in your playlist · per serving · tap to add"), t);
  assert.equal(byLabel(m.root(), MORE_LABEL), undefined, "no Get more options in playlist mode");
  assert.ok(!t.includes(EXHAUSTED_TITLE), "no exhausted card in playlist mode (hasMore:false is the norm here)");
  await tap(byLabel(m.root(), "Miso Salmon"), "card n1");
  await tap(byTestId(m.root(), "pick-build"), "Build my week");
  const post = calls.find((c) => c.path === "/plans/from-meals");
  assert.ok(post, "from-meals not called");
  assert.deepEqual(post!.body.mealIds, ["n1"]);
  assert.equal(calls.some((c) => c.path === "/wizard/shelf"), false, "playlist mode never re-posts the shelf");
});

test("PlaylistPickScreen: builds the shelf request from STORED prefs with source:'playlist' and NO exclusions", async () => {
  moreResponse = () => shelf(THREE.map((mm) => ({ ...mm, isPlaylist: true, source: "playlist" })), 3, false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(ToastProvider, null, React.createElement(PlaylistPickScreen)),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  screen = { renderer, client };
  const post = calls.find((c) => c.path === "/wizard/shelf");
  assert.ok(post, "the playlist shelf was not requested");
  assert.equal(post!.body.source, "playlist");
  assert.equal("excludeMealIds" in post!.body, false, "playlist mode sends no exclusions");
  // The server schema's required fields ride from stored prefs (hydrated=true).
  assert.equal(post!.body.planDurationDays, 4);
  assert.equal(post!.body.householdSize, 3);
  assert.equal(post!.body.difficulty, "medium");
  assert.equal(post!.body.weeklyPacing, "mixed");
  assert.deepEqual(post!.body.allergiesAndAvoidances, ["Peanuts"]);
  const t = joined(renderer.toJSON() as unknown as Tree);
  assert.ok(t.includes(PLAYLIST_PICK_TITLE), t);
  assert.ok(t.includes("3 in your playlist"), t);
  assert.equal(byLabel(renderer.toJSON() as unknown as Tree, MORE_LABEL), undefined);
  // The cap comes from stored prefs (45) → the 120-min braise is flagged, not blocked.
  assert.ok(t.includes("over your 45-min cap"), t);
});

// ── Block 2c Part C — the "new to you" pill is suppressed when it is on more
// than half the cards on screen, recomputed as "Get more options" appends ──

function countNewPills(root: Json): number {
  return walk(root).filter(
    (n) => n.type === "rn-text" && allText(n).join("") === NEW_TO_YOU_PILL,
  ).length;
}
function tenWith(fresh: number): ShelfMeal[] {
  return Array.from({ length: 10 }, (_, i) => meal(`t${i}`, { isNewToYou: i < fresh }));
}

test("new-to-you: 6 of 10 cards new → NO pills; 3 of 10 → three pills", async () => {
  const six = await mount({ shelf: shelf(tenWith(6), 40) });
  assert.equal(countNewPills(six.root()), 0);
  await act(async () => screen!.renderer.unmount());
  screen!.client.clear();
  screen = null;
  const three = await mount({ shelf: shelf(tenWith(3), 40) });
  assert.equal(countNewPills(three.root()), 3);
});

test("new-to-you: a round that appends two new cards flips 2-of-4 (shown) to 4-of-6 (hidden), and back", async () => {
  const m = await mount({ shelf: shelf(tenWith(2).slice(0, 4), 40) });
  assert.equal(countNewPills(m.root()), 2, "2 of 4 is exactly half → shown");
  moreResponse = () => shelf([meal("x1", { isNewToYou: true }), meal("x2", { isNewToYou: true })], 40, true);
  await tap(byLabel(m.root(), MORE_LABEL), "Get more options");
  assert.ok(m.text().includes("Meal x1"), "round appended");
  assert.equal(countNewPills(m.root()), 0, "4 of 6 → suppressed");
  moreResponse = () => shelf([meal("y1"), meal("y2"), meal("y3")], 40, true);
  await tap(byLabel(m.root(), MORE_LABEL), "Get more options again");
  assert.equal(countNewPills(m.root()), 4, "4 of 9 → shown again");
});
