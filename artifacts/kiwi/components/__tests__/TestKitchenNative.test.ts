// Resub C1 — the Test Kitchen on a PHONE (Apple 5.1.1(v)).
//
// Each of the four app/test-kitchen routes used to open with
// `if (Platform.OS !== "web") return <Redirect href="/" />`, so on iOS and
// Android the guest flow bounced to "/" before any screen rendered. These mount
// each route with Platform.OS = "ios" and assert the SCREEN renders, not the
// bounce (the expo-router stub renders <Redirect> as a visible `expo-redirect`).
//
// The plan route goes further: all five of its doors open GuestDoorSheet, and
// the sheet's primary button goes to sign-up — where the claim rides on the
// signup body (contexts/__tests__/AuthContext.oauth.test.ts pins that half).
//
// app/** is outside the test glob (D-WS9-164), so this lives beside the
// component tests and reaches into app/test-kitchen/.

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Platform } from "react-native";
import * as ExpoRouter from "expo-router";

import { GuestProvider } from "../../contexts/GuestContext";
import { clearGuestSession, storeGuestSession } from "../../lib/guest/guestToken";
import { DOOR_NATIVE_INTRO, DOOR_PRIMARY } from "../../lib/guest/doors";
import TestKitchenRoute, { TK_TITLE } from "../../app/test-kitchen/index";
import GuestOptionsRoute, { GUEST_OPTIONS_TITLE } from "../../app/test-kitchen/options";
import GuestPlanRoute from "../../app/test-kitchen/plan";
import GuestRecipeRoute from "../../app/test-kitchen/recipe";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

const platform = Platform as unknown as { OS: string };
const router = ExpoRouter as unknown as {
  __setRouterForTests(impl: Record<string, unknown>): void;
  __resetRouterForTests(): void;
};

const SESSION = {
  guestSessionId: "gs_native",
  token: "guest-jwt",
  expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
};

const DRAFT = {
  draft: { id: "draft_1", createdAt: "2026-10-04T12:00:00.000Z" },
  expanded: {
    candidateId: "c1",
    title: "A comforting week",
    tags: ["cozy"],
    whyBullets: ["Uses one shopping trip"],
    meals: [
      {
        title: "Chicken Pho",
        description: "A quick weeknight pho",
        cuisineType: "vietnamese",
        estimatedTimeMinutes: 45,
        difficulty: "medium",
        servings: 4,
        sourceStoreMealId: "meal_abc",
        dishes: [
          {
            title: "Main",
            role: "main",
            positionIndex: 0,
            ingredients: [{ name: "rice", quantity: 1, unit: "cup" }],
            macros: {
              caloriesPerServing: 430,
              proteinGPerServing: 10,
              carbsGPerServing: 20,
              fatGPerServing: 5,
            },
          },
        ],
      },
    ],
  },
};

const realFetch = globalThis.fetch;
const realOS = platform.OS;

before(() => {
  platform.OS = "ios";
  // Every guest call stays in flight: these tests are about what renders, and
  // a fetch that never settles keeps each screen in its first, honest state.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  platform.OS = realOS;
});

let active: TestRenderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (active) {
    const r = active;
    active = null;
    await act(async () => {
      r.unmount();
    });
  }
  clearGuestSession();
  router.__resetRouterForTests();
});

async function mount(
  Route: React.ComponentType,
  seed?: (qc: QueryClient) => void,
): Promise<TestRenderer.ReactTestRenderer> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(GuestProvider, null, React.createElement(Route)),
      ),
    );
  });
  active = r;
  return r;
}

function all(node: Node | string | null, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (node == null || typeof node === "string") return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) all(c, pred, out);
  return out;
}

function tree(r: TestRenderer.ReactTestRenderer): Node | null {
  const j = r.toJSON() as unknown;
  if (Array.isArray(j)) return { type: "root", children: j as Node[] };
  return j as Node | null;
}

function textOf(node: Node | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join(" ");
}

function redirects(r: TestRenderer.ReactTestRenderer): string[] {
  return all(tree(r), (n) => n.type === "expo-redirect").map((n) => String(n.props?.href));
}

test("/test-kitchen renders the entry on iOS — no bounce to /", async () => {
  const r = await mount(TestKitchenRoute);
  assert.deepEqual(redirects(r), []);
  assert.ok(textOf(tree(r)).includes(TK_TITLE), "the Test Kitchen entry is on screen");
});

test("/test-kitchen/options renders its screen on iOS", async () => {
  storeGuestSession(SESSION);
  const r = await mount(GuestOptionsRoute);
  assert.deepEqual(redirects(r), []);
  assert.ok(textOf(tree(r)).includes(GUEST_OPTIONS_TITLE));
});

test("/test-kitchen/recipe renders its screen on iOS", async () => {
  storeGuestSession(SESSION);
  const r = await mount(GuestRecipeRoute);
  assert.deepEqual(redirects(r), []);
  assert.ok(textOf(tree(r)).includes("Recipe"));
});

test("/test-kitchen/plan renders the read-only plan on iOS", async () => {
  storeGuestSession(SESSION);
  const r = await mount(GuestPlanRoute, (qc) =>
    qc.setQueryData(["guest", "draft", SESSION.guestSessionId], DRAFT),
  );
  assert.deepEqual(redirects(r), []);
  const text = textOf(tree(r));
  assert.ok(text.includes("A comforting week"));
  assert.ok(text.includes("Chicken Pho"));
});

test("all five plan doors open the door sheet, and its primary goes to sign-up", async () => {
  const doors = [
    "guest-plan-save",
    "guest-plan-grocery",
    "guest-plan-order",
    "guest-plan-prep",
    "guest-plan-swap",
  ];
  for (const id of doors) {
    const pushed: unknown[] = [];
    router.__setRouterForTests({ push: (href: unknown) => pushed.push(href) });
    storeGuestSession(SESSION);
    const r = await mount(GuestPlanRoute, (qc) =>
      qc.setQueryData(["guest", "draft", SESSION.guestSessionId], DRAFT),
    );

    assert.equal(all(tree(r), (n) => n.type === "rn-modal").length, 0, `${id}: sheet starts closed`);
    const door = all(tree(r), (n) => n.props?.testID === id)[0];
    assert.ok(door, `${id} is on screen`);
    await act(async () => {
      (door.props!.onPress as () => void)();
    });

    const sheet = all(tree(r), (n) => n.type === "rn-modal")[0];
    assert.ok(sheet, `${id} opened the door sheet`);
    // The native door: the account is made here, not after a store trip.
    assert.ok(textOf(sheet).includes(DOOR_NATIVE_INTRO), `${id}: native door copy`);
    const signUp = all(sheet, (n) => n.props?.testID === "guest-door-signup")[0];
    assert.equal(signUp.props?.accessibilityLabel, DOOR_PRIMARY);
    await act(async () => {
      (signUp.props!.onPress as () => void)();
    });
    assert.deepEqual(pushed, ["/(auth)/sign-up"], `${id} → sign-up`);

    await act(async () => {
      r.unmount();
    });
    active = null;
    clearGuestSession();
  }
});
