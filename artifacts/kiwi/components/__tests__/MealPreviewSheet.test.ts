// Resub C5 (Part B) — the Pick screen's meal preview sheet.
//
// Pinned: the sheet reads GET /meals/:id under the CALLER's principal (guest
// token for a guest, user token for a member), renders the recipe through the
// shared helpers (a literal formatIngredientLine line; the grouped steps
// decision of lib/meals/mealSteps.ts), flips its one primary with `picked`,
// and that primary toggles AND closes. A guest's look posts recipe_opened with
// `from: "pick"`; a member's posts nothing.
//
// Asserted on the API seam (the fetch), so lib/api/client.ts's guest allowlist
// runs for real.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  __setForTests as seedSecureItem,
  __resetForTests as resetSecureStore,
} from "expo-secure-store";

import type { ShelfMeal } from "@/lib/api/wizard";
import { clearGuestSession, storeGuestSession } from "@/lib/guest/guestToken";
import {
  MealPreviewSheet,
  PREVIEW_ADD,
  PREVIEW_REMOVE,
  previewToggleLabel,
  type MealPreviewSheetProps,
} from "../MealPreviewSheet";

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
const textNodes = (n: Tree) =>
  walk(n)
    .filter((x) => x.type === "rn-text")
    .map((x) => allText(x).join(""));
const byTestId = (root: Tree, id: string) => walk(root).find((n) => n.props.testID === id);

// ── fixtures ───────────────────────────────────────────────────────────────

const SHELF_ROW: ShelfMeal = {
  id: "m1",
  title: "Lime Chicken Tacos",
  description: "Charred thighs, lime, a quick slaw.",
  cuisineType: "Mexican",
  difficulty: "easy",
  estimatedTimeMinutes: 35,
  activeTimeMinutes: 20,
  macrosPerServing: { calories: 520, protein: 34, carbs: 41, fat: 22 },
  tags: [],
  dishCount: 2,
  isNewToYou: true,
  isPlaylist: false,
  isPinned: false,
  matchesCuisine: null,
  source: "shelf",
  imageUrl: "https://img.test/m1.jpg",
};

function step(stepIndex: number, text: string) {
  return {
    stepIndex,
    text,
    estimatedMinutes: 5,
    phaseType: "cook",
    parallelGroup: null,
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: false,
  };
}
const ing = (name: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
  name,
  quantity,
  unit,
  preparationNote,
  category: "Protein",
  isOptional: false,
});
const dish = (dishId: string, title: string, ingredients: unknown[], steps: unknown[]) => ({
  dishId,
  title,
  roleLabel: "main",
  positionIndex: 0,
  minutes: 20,
  difficulty: "easy",
  servings: 4,
  authoredServingsDefault: 4,
  ingredients,
  steps,
});
// Multi-dish, steps on the dishes (the meal-owned array empty) — the catalog
// shape that made BUG-315; mealStepsAreGrouped says "grouped".
const DETAIL = {
  meal: {
    id: "m1",
    title: "Lime Chicken Tacos",
    cuisine: "Mexican",
    minutes: 35,
    servings: 4,
    authoredServingsDefault: 4,
    effectiveServings: 4,
    calories: 520,
    protein: 34,
    carbs: 41,
    fat: 22,
    tags: [],
    image: null,
    description: "Charred thighs, lime, a quick slaw.",
    difficulty: "easy",
    mealType: "dinner",
    sourceType: "curated",
    isPublic: true,
    userId: null,
    dishes: [
      dish("d1", "Chicken", [ing("chicken thighs", 1.5, "lb", "boneless")], [step(0, "Char the thighs.")]),
      dish("d2", "Slaw", [ing("limes", 2, "whole")], [step(0, "Toss the slaw.")]),
    ],
    steps: [],
    notes: null,
  },
};

// ── the fake server ────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let calls: { path: string; method: string; body: Record<string, unknown>; auth?: string }[] = [];
let mealResponse: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  mealResponse = () => json(DETAIL);
  storeGuestSession({ guestSessionId: "gs_prev", token: "guest-token", expiresAt: "2099-01-01T00:00:00.000Z" });
  seedSecureItem("kiwi_authToken", "user-token");
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    calls.push({ path: u.slice(u.indexOf("/api") + 4), method, body, auth });
    if (u.includes("/meals/")) return Promise.resolve(mealResponse());
    if (u.endsWith("/guest/events")) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json({ error: "not found" }, 404));
  }) as unknown as typeof fetch;
});

let mounted: { renderer: TestRenderer.ReactTestRenderer; client: QueryClient } | null = null;
afterEach(async () => {
  if (mounted) {
    const { renderer, client } = mounted;
    await act(async () => {
      renderer.unmount();
    });
    client.clear();
    mounted = null;
  }
  clearGuestSession();
  resetSecureStore();
  globalThis.fetch = originalFetch;
});

async function mount(props: Partial<MealPreviewSheetProps>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const log: string[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(MealPreviewSheet, {
          meal: SHELF_ROW,
          picked: false,
          principal: "guest",
          onToggle: () => log.push("toggle"),
          onClose: () => log.push("close"),
          ...props,
        }),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  mounted = { renderer, client };
  return { root: () => renderer.toJSON() as unknown as Tree, log };
}

// ── tests ──────────────────────────────────────────────────────────────────

test("C5 🔴 a guest's preview reads GET /meals/:id under the GUEST token and renders the recipe through the shared helpers", async () => {
  const m = await mount({ principal: "guest" });
  const read = calls.find((c) => c.path === "/meals/m1");
  assert.ok(read, `GET /meals/m1 not sent; calls: ${JSON.stringify(calls.map((c) => c.path))}`);
  assert.equal(read!.auth, "Bearer guest-token");

  const lines = textNodes(m.root());
  // formatIngredientLine, verbatim: the fraction, the unit, the note.
  assert.ok(lines.includes("1½ lb chicken thighs (boneless)"), lines.join(" | "));
  assert.ok(lines.includes("2 whole limes"), lines.join(" | "));
  // mealSteps: a multi-dish meal with no meal-owned steps is GROUPED by dish.
  assert.ok(lines.includes("Steps · Chicken"), lines.join(" | "));
  assert.ok(lines.includes("Steps · Slaw"), lines.join(" | "));
  assert.ok(lines.includes("Char the thighs."));
  // The card's time line, the difficulty, and the servings once the detail lands.
  const meta = allText(byTestId(m.root(), "meal-preview-meta")!).join("");
  assert.equal(meta, "35 min total · 20 min active · easy · 4 servings");
});

test("C5 a guest's look posts recipe_opened with from:'pick' — once", async () => {
  await mount({ principal: "guest" });
  const events = calls.filter((c) => c.path === "/guest/events");
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0]!.body.event, "recipe_opened");
  assert.deepEqual(events[0]!.body.meta, { mealId: "m1", from: "pick" });
});

test("C5 a member's preview reads as the USER and posts no guest event", async () => {
  await mount({ principal: "user" });
  const read = calls.find((c) => c.path === "/meals/m1");
  assert.ok(read, "GET /meals/m1 not sent");
  assert.equal(read!.auth, "Bearer user-token");
  assert.equal(calls.some((c) => c.path === "/guest/events"), false);
});

test("C5 🔴 the footer's primary flips with `picked`", async () => {
  assert.equal(previewToggleLabel(false), PREVIEW_ADD);
  assert.equal(previewToggleLabel(true), PREVIEW_REMOVE);
  const off = await mount({ picked: false });
  assert.ok(textNodes(off.root()).includes(PREVIEW_ADD));
  assert.ok(!textNodes(off.root()).includes(PREVIEW_REMOVE));
  await act(async () => {
    mounted!.renderer.unmount();
  });
  mounted = null;
  const on = await mount({ picked: true });
  assert.ok(textNodes(on.root()).includes(PREVIEW_REMOVE));
  assert.ok(!textNodes(on.root()).includes(PREVIEW_ADD));
});

test("C5 'Add to my picks' toggles, then closes", async () => {
  const m = await mount({ picked: false });
  await act(async () => {
    (byTestId(m.root(), "meal-preview-toggle")!.props.onPress as () => void)();
  });
  assert.deepEqual(m.log, ["toggle", "close"]);
});

test("C5 'Close' closes without touching the pick", async () => {
  const m = await mount({ picked: true });
  await act(async () => {
    (byTestId(m.root(), "meal-preview-close")!.props.onPress as () => void)();
  });
  assert.deepEqual(m.log, ["close"]);
});

test("C5 a failed read shows the retry card; the footer still picks", async () => {
  mealResponse = () => json({ error: "meal not found" }, 404);
  const m = await mount({ picked: false });
  assert.ok(byTestId(m.root(), "meal-preview-retry"), "no retry card");
  assert.ok(textNodes(m.root()).includes(PREVIEW_ADD));
});

test("C5 closed (meal null): no sheet, no read", async () => {
  const m = await mount({ meal: null });
  assert.ok(!walk(m.root()).some((n) => n.type === "rn-modal"));
  assert.equal(calls.length, 0);
});
