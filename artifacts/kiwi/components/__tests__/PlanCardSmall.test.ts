// WS7-4-B c10 — PlanCardSmall handlers tests.
// Renders the card in its expanded state and exercises Preview + Use Plan
// against injected handler props (mirroring c12 PlanDiscoveryCard wiring).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  __setRouterForTests,
  __resetRouterForTests,
} from "expo-router";

let pushedRoutes: Array<{ pathname: string; params: Record<string, string> }>;

beforeEach(() => {
  pushedRoutes = [];
  __setRouterForTests({
    push: (target: { pathname: string; params: Record<string, string> }) => {
      pushedRoutes.push(target);
    },
  });
});

afterEach(() => {
  pushedRoutes = [];
  __resetRouterForTests();
});

import { PlanCardSmall } from "../PlanCardSmall";

interface RenderedNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<RenderedNode | string>;
}

// Walk the tree and return the DEEPEST Pressable whose descendant text
// includes `label`. The outer card is itself a Pressable that wraps the
// inner action buttons, so a naive top-down search would always hit the
// outer toggle — we want the innermost action button instead.
function findPressableByLabel(
  root: RenderedNode | string | null | undefined,
  label: string,
): RenderedNode | null {
  const matches: { node: RenderedNode; depth: number }[] = [];
  function walk(n: RenderedNode | string | null | undefined, depth: number): void {
    if (n == null || typeof n === "string") return;
    if ((n.props as { onPress?: unknown } | undefined)?.onPress) {
      const texts: string[] = [];
      function gather(x: RenderedNode | string | null | undefined): void {
        if (x == null) return;
        if (typeof x === "string") texts.push(x);
        else if (Array.isArray(x.children)) x.children.forEach(gather);
      }
      gather(n);
      if (texts.includes(label)) matches.push({ node: n, depth });
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) walk(c, depth + 1);
    }
  }
  walk(root, 0);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.depth - a.depth);
  return matches[0].node;
}

function expandCard(renderer: TestRenderer.ReactTestRenderer): void {
  // The whole card is a Pressable that toggles `expanded`. Find the
  // top-level pressable (it's the root rendered node) and tap it once.
  const tree = renderer.toJSON() as RenderedNode | null;
  if (tree && (tree.props as { onPress?: () => void } | undefined)?.onPress) {
    act(() => {
      (tree.props as { onPress: () => void }).onPress();
    });
  }
}

const TEMPLATE_PLAN = {
  id: "tmpl-99",
  name: "Featured Family Week",
  description: "Crowd-pleasers",
  image: null,
  tags: ["family", "dev"],
  source: "template" as const,
  status: null,
  startDate: null,
  endDate: null,
  isActiveThisWeek: false,
};

test("PlanCardSmall: Preview button calls onPreviewTemplate(plan.id)", async () => {
  const previewed: string[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PlanCardSmall, {
        plan: TEMPLATE_PLAN,
        onPreviewTemplate: (id: string) => {
          previewed.push(id);
        },
        onUseTemplate: async () => ({ instanceId: "should-not-fire" }),
      }),
    );
  });
  expandCard(renderer);

  const tree = renderer.toJSON() as RenderedNode | null;
  const btn = findPressableByLabel(tree, "Preview");
  assert.ok(btn, "Preview button not rendered (card may not be expanded)");
  await act(async () => {
    (btn!.props!.onPress as () => void)();
  });

  assert.deepEqual(previewed, ["tmpl-99"]);
  assert.equal(pushedRoutes.length, 0, "Preview should not navigate");
  renderer.unmount();
});

test("PlanCardSmall: Use Plan calls onUseTemplate then navigates to /plan/[instanceId]", async () => {
  const usedIds: string[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PlanCardSmall, {
        plan: TEMPLATE_PLAN,
        onPreviewTemplate: () => {},
        onUseTemplate: async (id: string) => {
          usedIds.push(id);
          return { instanceId: "new-instance-77" };
        },
      }),
    );
  });
  expandCard(renderer);

  const tree = renderer.toJSON() as RenderedNode | null;
  const btn = findPressableByLabel(tree, "Use Plan");
  assert.ok(btn, "Use Plan button not rendered");
  await act(async () => {
    await (btn!.props!.onPress as () => Promise<void>)();
  });

  assert.deepEqual(usedIds, ["tmpl-99"]);
  assert.equal(pushedRoutes.length, 1);
  assert.equal(pushedRoutes[0].pathname, "/plan/[id]");
  assert.equal(pushedRoutes[0].params.id, "new-instance-77");
  renderer.unmount();
});
