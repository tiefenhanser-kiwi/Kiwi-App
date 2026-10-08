// Resub C4 — the Pick screen under `guest` (app/test-kitchen/pick.tsx).
//
// The member screen with a set of gates, so what is pinned here is the gates:
// "Build my week" posts POST /guest/plan-from-picks under the GUEST principal
// with the visitor's whole wizard body as `preferences`, and never touches the
// member twin (POST /plans/from-meals), ["plans"] / ["home"] or /plan/[id]; its
// two 409s are doors; "Get more options" pages the guest shelf; the exhausted
// card's member exits are replaced by the thin-shelf sign-up exit; the guest's
// 7-pick cap is held client-side.
//
// Asserted on the API seam (the fetch), not on a mocked module: the allowlist
// in lib/api/client.ts runs for real, so a path a guest may not call throws
// client-side here exactly as it would on a device.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { __resetRouterForTests, __setRouterForTests } from "expo-router";

import { GuestProvider, useGuest } from "@/contexts/GuestContext";
import { ToastProvider } from "@/contexts/ToastProvider";
import type { ShelfMeal, WizardShelfResponse } from "@/lib/api/wizard";
import { todayLocalDate } from "@/lib/dates";
import { DOOR_TITLE, THIN_SHELF_CTA } from "@/lib/guest/doors";
import { clearGuestSession, storeGuestSession } from "@/lib/guest/guestToken";
import {
  buildGuestShelfRequest,
  buildGuestWizardPayload,
  type GuestWizardForm,
} from "@/lib/wizard/guestPayload";
import { EXHAUSTED_REFINE, EXHAUSTED_TELL } from "../ExhaustedCard";
import { NEW_TO_YOU_PILL } from "../MealPickCard";
import { PREVIEW_ADD, PREVIEW_REMOVE } from "../MealPreviewSheet";
import { BUILD_LABEL, MORE_LABEL, PickMealsScreen, type PickMealsScreenProps } from "../PickMealsScreen";

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
const joined = (n: Tree) => allText(n).join("").replace(/\s+/g, " ");
const byTestId = (root: Tree, id: string) => walk(root).find((n) => n.props.testID === id);
const byLabel = (root: Tree, label: string) =>
  walk(root).find((n) => n.props.accessibilityLabel === label);

// ── fixtures ───────────────────────────────────────────────────────────────

function meal(id: string, extra: Partial<ShelfMeal> = {}): ShelfMeal {
  return {
    id,
    title: `Meal ${id}`,
    description: `A ${id} description`,
    cuisineType: "Italian",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    activeTimeMinutes: 15,
    macrosPerServing: { calories: 500, protein: 30, carbs: 40, fat: 20 },
    tags: [],
    dishCount: 2,
    // G1 — every guest row is new to them.
    isNewToYou: true,
    isPlaylist: false,
    isPinned: false,
    matchesCuisine: null,
    source: "shelf",
    imageUrl: `https://img.test/${id}.jpg`,
    ...extra,
  };
}
const shelf = (meals: ShelfMeal[], totalEligible = 40, hasMore = true): WizardShelfResponse => ({
  meals,
  totalEligible,
  hasMore,
  unmatchedNames: [],
});

const FORM: GuestWizardForm = {
  planDurationDays: 3,
  householdSize: 2,
  cuisines: ["italian"],
  eatingStyles: [],
  allergies: ["peanuts"],
  dietaryNotes: "",
  difficulty: "medium",
  weeklyPacing: "mostly_easy",
  additionalNotes: "",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
};
const SESSION = { guestSessionId: "gs_pick", token: "guest-token", expiresAt: "2099-01-01T00:00:00.000Z" };

const DRAFT = {
  draft: { id: "gs_pick", createdAt: "2026-10-07T12:00:00.000Z" },
  expanded: {
    candidateId: "picks-1",
    title: "Your meals, week of Oct 5",
    tags: [],
    whyBullets: ["The meals you picked"],
    meals: [
      {
        title: "Meal b",
        cuisineType: "Italian",
        estimatedTimeMinutes: 30,
        difficulty: "easy",
        servings: 2,
        sourceStoreMealId: "b",
        dishes: [],
      },
    ],
  },
};

// ── the fake server ────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let calls: { path: string; method: string; body: Record<string, unknown>; auth?: string }[] = [];
let replaced: unknown[] = [];
let dismissed: unknown[] = [];
let picksResponse: () => Response;
let moreResponse: () => WizardShelfResponse;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  storeGuestSession(SESSION);
  calls = [];
  replaced = [];
  dismissed = [];
  picksResponse = () => json(DRAFT);
  moreResponse = () => shelf([meal("x1"), meal("x2")]);
  __setRouterForTests({
    replace: (href: unknown) => replaced.push(href),
    dismissTo: (href: unknown) => dismissed.push(href),
  });
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    calls.push({ path: u.slice(u.indexOf("/api") + 4), method, body, auth });
    if (u.endsWith("/wizard/shelf")) return Promise.resolve(json(moreResponse()));
    if (u.endsWith("/guest/plan-from-picks")) return Promise.resolve(picksResponse());
    // Resub C5 — the preview's read; the body is not what these tests pin
    // (components/__tests__/MealPreviewSheet.test.ts does), so a 404 is fine.
    if (u.includes("/meals/")) return Promise.resolve(json({ error: "meal not found" }, 404));
    if (u.endsWith("/guest/events")) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json({ error: "not found" }, 404));
  }) as unknown as typeof fetch;
});

let screen: { renderer: TestRenderer.ReactTestRenderer; client: QueryClient } | null = null;
// BUG-366 — what the plan screen will read for the pick path's thumbnails.
let lastPickedImages: Record<string, string> | null = null;
function ContextProbe() {
  lastPickedImages = useGuest().pickedMealImages;
  return null;
}
let invalidated: unknown[][] = [];

afterEach(async () => {
  if (screen) {
    const { renderer, client } = screen;
    await act(async () => {
      renderer.unmount();
    });
    client.clear();
    screen = null;
  }
  clearGuestSession();
  __resetRouterForTests();
  globalThis.fetch = originalFetch;
});

async function mount(props: Partial<PickMealsScreenProps> & { shelf: WizardShelfResponse }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidated = [];
  const original = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
    invalidated.push(filters?.queryKey ?? []);
    return original(filters);
  }) as typeof client.invalidateQueries;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          GuestProvider,
          null,
          React.createElement(ContextProbe),
          React.createElement(
            ToastProvider,
            null,
            React.createElement(PickMealsScreen, {
              request: buildGuestShelfRequest(FORM),
              mode: "prefs",
              planDurationDays: FORM.planDurationDays,
              householdSize: FORM.householdSize,
              capMinutes: null,
              guest: true,
              guestForm: FORM,
              ...props,
            }),
          ),
        ),
      ),
    );
  });
  screen = { renderer, client };
  return {
    root: () => renderer.toJSON() as unknown as Tree,
    text: () => joined(renderer.toJSON() as unknown as Tree),
    client,
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

// ── Build my week ──────────────────────────────────────────────────────────

test("C4 🔴 'Build my week' posts /guest/plan-from-picks (guest token, picks in order, the whole wizard body) — never /plans/from-meals", async () => {
  const m = await mount({ shelf: shelf([meal("a"), meal("b"), meal("c")]) });
  await tap(byLabel(m.root(), "Meal b"), "card b");
  await tap(byLabel(m.root(), "Meal a"), "card a");
  await tap(byTestId(m.root(), "pick-build"), "Build my week");

  const call = calls.find((c) => c.path === "/guest/plan-from-picks");
  // The allowlist runs for real: off it, the call throws client-side and the
  // screen renders the throw — quoted here so a red run names it.
  assert.ok(call, `POST /guest/plan-from-picks not sent; the screen says: ${m.text()}`);
  assert.equal(call!.method, "POST");
  assert.equal(call!.auth, "Bearer guest-token");
  assert.deepEqual(call!.body.mealIds, ["b", "a"], "pick order is the plan's order");
  assert.deepEqual(call!.body.preferences, JSON.parse(JSON.stringify(buildGuestWizardPayload(FORM))));
  assert.deepEqual((call!.body.preferences as Record<string, unknown>).allergiesAndAvoidances, ["peanuts"]);
  assert.equal(call!.body.localDate, todayLocalDate());

  assert.equal(calls.some((c) => c.path === "/plans/from-meals"), false, "the member twin must never be called");
  assert.deepEqual(replaced, ["/test-kitchen/plan"]);
  // Resub C5 — a 200 is the plan screen and nothing else: no door, no sheet.
  assert.ok(!walk(m.root()).some((n) => n.type === "rn-modal"), "a built plan must not open a door");
  assert.ok(!m.text().includes(DOOR_TITLE));
  for (const k of invalidated) {
    assert.notEqual(k[0], "plans", "a guest owns no plan rows");
    assert.notEqual(k[0], "home");
  }
  assert.ok(invalidated.some((k) => k[0] === "guest" && k[1] === "session"), "the session read must learn the plan is spent");
  // BUG-366 — the picked cards' images, for the plan rows (the draft has none).
  assert.deepEqual(lastPickedImages, { a: "https://img.test/a.jpg", b: "https://img.test/b.jpg" });
  // The plan screen's query is seeded with the very envelope GET /guest/draft returns.
  assert.equal(
    (m.client.getQueryData(["guest", "draft", "gs_pick"]) as typeof DRAFT | undefined)?.expanded.title,
    DRAFT.expanded.title,
  );
});

// Resub C5 — the preview is a sheet over this screen; its primary is the very
// toggle the circle calls, so the picks (and their ORDER) come out the same.
test("C5 🔴 tap a card body → the preview; 'Add to my picks' picks exactly as the circle does (same ids, same order)", async () => {
  const m = await mount({ shelf: shelf([meal("a"), meal("b"), meal("c")]) });
  await tap(byTestId(m.root(), "meal-pick-open-b"), "card b body");
  assert.ok(walk(m.root()).some((n) => n.type === "rn-modal"), "the preview did not open");
  assert.ok(m.text().includes(PREVIEW_ADD), m.text());
  assert.deepEqual(byLabel(m.root(), "Meal b")!.props.accessibilityState, { checked: false }, "a look is not a pick");
  assert.ok(
    calls.some((c) => c.path === "/meals/b" && c.auth === "Bearer guest-token"),
    "the preview reads the catalog meal under the guest token",
  );

  await tap(byTestId(m.root(), "meal-preview-toggle"), "Add to my picks");
  assert.ok(!walk(m.root()).some((n) => n.type === "rn-modal"), "Add must close the sheet");
  assert.deepEqual(byLabel(m.root(), "Meal b")!.props.accessibilityState, { checked: true });

  await tap(byLabel(m.root(), "Meal a"), "circle a");
  await tap(byTestId(m.root(), "pick-build"), "Build my week");
  const call = calls.find((c) => c.path === "/guest/plan-from-picks");
  assert.ok(call, m.text());
  // The C4 test above picks b then a with the circle: the same body.
  assert.deepEqual(call!.body.mealIds, ["b", "a"]);
});

test("C5 a picked card's preview says 'Remove from my picks', and removing unpicks it", async () => {
  const m = await mount({ shelf: shelf([meal("a"), meal("b")]) });
  await tap(byLabel(m.root(), "Meal b"), "circle b");
  await tap(byTestId(m.root(), "meal-pick-open-b"), "card b body");
  assert.ok(m.text().includes(PREVIEW_REMOVE), m.text());
  await tap(byTestId(m.root(), "meal-preview-toggle"), "Remove from my picks");
  assert.deepEqual(byLabel(m.root(), "Meal b")!.props.accessibilityState, { checked: false });
  assert.equal(byTestId(m.root(), "pick-build")!.props.disabled, true, "no picks left");
});

test("C4 409 guest_generation_used → the sign-up door, no navigation", async () => {
  picksResponse = () => json({ code: "guest_generation_used" }, 409);
  const m = await mount({ shelf: shelf([meal("a")]) });
  await tap(byLabel(m.root(), "Meal a"), "card a");
  await tap(byTestId(m.root(), "pick-build"), "Build my week");
  assert.ok(walk(m.root()).some((n) => n.type === "rn-modal"), "the door sheet did not open");
  assert.ok(m.text().includes(DOOR_TITLE));
  assert.deepEqual(replaced, []);
});

test("C4 409 catalog_only_gap → the thin-shelf card with the titles and a sign-up exit, no navigation", async () => {
  picksResponse = () =>
    json({ code: "catalog_only_gap", liveSlotTitles: ["Meal a"], storeSlotCount: 0 }, 409);
  const m = await mount({ shelf: shelf([meal("a")]) });
  await tap(byLabel(m.root(), "Meal a"), "card a");
  await tap(byTestId(m.root(), "pick-build"), "Build my week");
  assert.ok(m.text().includes("Kiwi couldn't put together Meal a in the Test Kitchen."), m.text());
  const exit = byTestId(m.root(), "exhausted-guest-exit");
  assert.ok(exit, "no guest exit on the card");
  assert.ok(joined(exit!).includes(THIN_SHELF_CTA));
  await tap(exit, "Sign up");
  assert.ok(m.text().includes(DOOR_TITLE), "the exit must open the door");
  assert.deepEqual(replaced, []);
});

test("C4 any other error renders the screen's error line", async () => {
  picksResponse = () => json({ error: "meal not found", code: "meal_not_found" }, 404);
  const m = await mount({ shelf: shelf([meal("a")]) });
  await tap(byLabel(m.root(), "Meal a"), "card a");
  await tap(byTestId(m.root(), "pick-build"), "Build my week");
  assert.deepEqual(replaced, []);
  assert.ok(!walk(m.root()).some((n) => n.type === "rn-modal"), "a 404 is not a door");
  const line = byTestId(m.root(), "pick-build-error");
  assert.ok(line && joined(line).length > 0, "the error line did not render");
  assert.equal(byTestId(m.root(), "exhausted-guest-exit"), undefined, "a 404 is not the thin shelf");
});

test("C4 more than 7 picks: the button is disabled and the footer says how many to unpick", async () => {
  const eight = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => meal(id));
  const m = await mount({ shelf: shelf(eight) });
  for (const x of eight) await tap(byLabel(m.root(), x.title), x.id);
  assert.equal(byTestId(m.root(), "pick-build")!.props.disabled, true);
  assert.ok(m.text().includes("The Test Kitchen plan holds up to 7 meals — unpick 1"), m.text());
  await tap(byLabel(m.root(), "Meal h"), "unpick h");
  assert.ok(!byTestId(m.root(), "pick-build")!.props.disabled);
});

// ── the rest of the screen ─────────────────────────────────────────────────

test("C4 'Get more options' pages the GUEST shelf by exclusion — no text, no source", async () => {
  const m = await mount({ shelf: shelf([meal("a"), meal("b")]) });
  await tap(byLabel(m.root(), MORE_LABEL), "Get more options");
  const call = calls.find((c) => c.path === "/wizard/shelf");
  assert.ok(call, `shelf not paged; the screen says: ${m.text()}`);
  assert.equal(call!.auth, "Bearer guest-token");
  assert.deepEqual(call!.body.excludeMealIds, ["a", "b"]);
  assert.equal("text" in call!.body, false);
  assert.equal("source" in call!.body, false);
  assert.deepEqual(call!.body.allergiesAndAvoidances, ["peanuts"]);
  assert.ok(m.text().includes("Meal x1"));
});

test("C4 an exhausted guest shelf: the thin-shelf sign-up exit, never Refine / Tell Kiwi (member routes)", async () => {
  const m = await mount({ shelf: shelf([meal("a")], 3, false) });
  assert.ok(byTestId(m.root(), "exhausted-guest-exit"), "guest exit missing");
  assert.ok(!m.text().includes(EXHAUSTED_REFINE));
  assert.ok(!m.text().includes(EXHAUSTED_TELL));
  assert.deepEqual(dismissed, []);
});

test("C4 every guest row is isNewToYou, so the pill is suppressed (the 'new user' rule) — the screen still reads", async () => {
  const m = await mount({ shelf: shelf([meal("a"), meal("b")]) });
  assert.ok(!m.text().includes(NEW_TO_YOU_PILL), m.text());
  assert.ok(m.text().includes("40 fit your preferences"));
  assert.ok(m.text().includes(BUILD_LABEL));
});
