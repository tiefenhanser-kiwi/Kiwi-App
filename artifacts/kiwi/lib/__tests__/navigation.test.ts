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
