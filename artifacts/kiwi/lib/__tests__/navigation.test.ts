// WEB-1 Part B (BUG-382) — goBack: back when there is history, a replace onto
// a real screen when there is none (a cold web entry from the marketing site
// or a shared link, where router.back() did nothing).

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { __resetRouterForTests, __setRouterForTests } from "expo-router";

import { Header } from "@/components/Header";
import { goBack } from "@/lib/navigation";

function fakeRouter(canGoBack: boolean) {
  const calls: string[] = [];
  return {
    calls,
    router: {
      canGoBack: () => canGoBack,
      back: () => calls.push("back"),
      replace: (href: unknown) => calls.push(`replace:${String(href)}`),
    },
  };
}

afterEach(() => __resetRouterForTests());

test("history → back(), no replace", () => {
  const { calls, router } = fakeRouter(true);
  goBack(router);
  assert.deepEqual(calls, ["back"]);
});

test("cold entry (canGoBack false) → replace('/'), back NOT called", () => {
  const { calls, router } = fakeRouter(false);
  goBack(router);
  assert.deepEqual(calls, ["replace:/"]);
});

test("cold entry with a fallback → replace(fallback)", () => {
  const { calls, router } = fakeRouter(false);
  goBack(router, "/test-kitchen");
  assert.deepEqual(calls, ["replace:/test-kitchen"]);
});

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };
function walk(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const kids = Array.isArray(node.children) ? node.children.flatMap((c) => walk(c)) : [];
  return [node, ...kids];
}
function pressBack(el: React.ReactElement) {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  const back = walk(r.toJSON() as Json).find((n) => n.props?.accessibilityLabel === "Go back");
  assert.ok(back, "Header renders its back button");
  act(() => (back!.props.onPress as () => void)());
}

test("Header's default back routes through goBack: cold entry → replace('/'), not back()", () => {
  const { calls, router } = fakeRouter(false);
  __setRouterForTests(router);
  pressBack(React.createElement(Header, { title: "Meal", showBack: true }));
  assert.deepEqual(calls, ["replace:/"]);
});

test("Header backFallback is the cold-entry target", () => {
  const { calls, router } = fakeRouter(false);
  __setRouterForTests(router);
  pressBack(React.createElement(Header, { title: "Pick", showBack: true, backFallback: "/test-kitchen" }));
  assert.deepEqual(calls, ["replace:/test-kitchen"]);
});

test("Header with history still goes back", () => {
  const { calls, router } = fakeRouter(true);
  __setRouterForTests(router);
  pressBack(React.createElement(Header, { title: "Meal", showBack: true }));
  assert.deepEqual(calls, ["back"]);
});

// CLIENT-5 B (BUG-564) — /cook-session's back on a direct load: the route's
// router is withBackFallback(router, cookSessionExitHref(params)).
import { cookSessionExitHref, withBackFallback } from "@/lib/navigation";

function hrefRouter(canGoBack: boolean) {
  const calls: unknown[] = [];
  return {
    calls,
    router: {
      canGoBack: () => canGoBack,
      back: () => calls.push("back"),
      replace: (href: unknown) => calls.push({ replace: href }),
      push: (href: unknown) => calls.push({ push: href }),
    },
  };
}

test("CLIENT-5 B: Cook Mode's back with no history lands on the meal, with its plan item", () => {
  const { calls, router } = hrefRouter(false);
  const href = cookSessionExitHref({ mealId: "m1", planId: "p1", planItemId: "i1" });
  withBackFallback(router, href).back();
  assert.deepEqual(calls, [{ replace: { pathname: "/meal/[id]", params: { id: "m1", planId: "p1", planItemId: "i1" } } }]);
});

test("CLIENT-5 B: with history it is still router.back(); the router's other methods are its own", () => {
  const { calls, router } = hrefRouter(true);
  const wrapped = withBackFallback(router, cookSessionExitHref({ mealId: "m1" }));
  wrapped.back();
  wrapped.push("/x");
  wrapped.replace("/y");
  assert.deepEqual(calls, ["back", { push: "/x" }, { replace: "/y" }]);
  assert.equal(wrapped.canGoBack, router.canGoBack);
});

test("CLIENT-5 B: each launch falls back to the screen that opens it", () => {
  // A meal with no plan (the Library's Cook Now).
  assert.deepEqual(cookSessionExitHref({ mealId: "m1" }), { pathname: "/meal/[id]", params: { id: "m1" } });
  // One dish of a plan's meal (a make-ahead row): that dish screen, in plan context, on its run.
  assert.deepEqual(cookSessionExitHref({ mealId: "m1", dishId: "d1", planId: "p1", planItemId: "i1", run: "r" }), {
    pathname: "/dish/[id]",
    params: { id: "d1", mealId: "m1", planId: "p1", planItemId: "i1", run: "r" },
  });
  // A dish alone.
  assert.deepEqual(cookSessionExitHref({ dishId: "d1" }), { pathname: "/dish/[id]", params: { id: "d1" } });
  // Prep the Week / Prep the feast: the Hub, on its plan when there is one.
  assert.deepEqual(cookSessionExitHref({ mode: "prep-week", planId: "p1", mealId: "ignored" }), {
    pathname: "/prep-cook",
    params: { id: "p1" },
  });
  assert.equal(cookSessionExitHref({ mode: "prep-week" }), "/prep-cook");
  // Nothing to go on, or array params (never a launch): home.
  assert.equal(cookSessionExitHref({}), "/");
  assert.equal(cookSessionExitHref({ mealId: ["a", "b"] }), "/");
});

test("CLIENT-5 B: useCookSessionRouter is that router (the stub has no params: home)", async () => {
  const { useCookSessionRouter } = await import("@/hooks/useCookSessionRouter");
  const { calls, router } = fakeRouter(false);
  __setRouterForTests(router);
  let got!: { back: () => void };
  const Probe = () => {
    got = useCookSessionRouter();
    return null;
  };
  act(() => {
    TestRenderer.create(React.createElement(Probe));
  });
  got.back();
  assert.deepEqual(calls, ["replace:/"]);
});
