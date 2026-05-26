// WS7-4-B c9 — PlanRow source dispatcher tests.
// Renders the row and asserts that tapping Open routes to:
//   - the preview modal (via onPreviewTemplate) when plan.source === "template"
//   - the Plan Review screen (via router.push) when plan.source === "instance"

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// Stub expo-router's useRouter so PlanRow's import works in node:test.
// We can't reach into the loader for ad-hoc per-test stubs, so stash a
// module-level recorder that the route navigation captures into.
let pushedRoutes: Array<{ pathname: string; params: Record<string, string> }>;

beforeEach(() => {
  pushedRoutes = [];
  installRouterRecorder();
});

// Use the same module-level fetch/secure-store reset hooks already wired by
// _setup.mjs — PlanRow doesn't issue any network calls itself.
afterEach(() => {
  pushedRoutes = [];
  __resetRouterForTests();
});

// Use the loader's expo-router stub. __setRouterForTests installs a
// per-test router whose .push() captures the navigation target into our
// pushedRoutes recorder.
import {
  __setRouterForTests,
  __resetRouterForTests,
} from "expo-router";

import { PlanRow } from "../PlanRow";

function installRouterRecorder() {
  __setRouterForTests({
    push: (target: { pathname: string; params: Record<string, string> }) => {
      pushedRoutes.push(target);
    },
  });
}

interface RenderedNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<RenderedNode | string>;
}

function findByText(
  node: RenderedNode | string | null | undefined,
  text: string,
): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      if (typeof c === "string" && c === text) return node;
      const hit = findByText(c, text);
      if (hit) return hit;
    }
  }
  return null;
}

function findOpenButton(tree: RenderedNode | null): RenderedNode | null {
  // The Open label sits inside a Pressable that has an onPress prop.
  const labelHost = findByText(tree, "Open");
  if (!labelHost) return null;
  // Walk up: pressable is the parent host that has an onPress prop. We don't
  // have parent refs from toJSON, so do a top-down search for a node whose
  // children eventually contain the "Open" label AND that has an onPress prop.
  function find(node: RenderedNode | string | null): RenderedNode | null {
    if (node == null || typeof node === "string") return null;
    if ((node.props as { onPress?: unknown } | undefined)?.onPress) {
      // Does any descendant text contain "Open"?
      const texts: string[] = [];
      function gather(n: RenderedNode | string | null | undefined): void {
        if (n == null) return;
        if (typeof n === "string") texts.push(n);
        else if (Array.isArray(n.children)) n.children.forEach(gather);
      }
      gather(node);
      if (texts.includes("Open")) return node;
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) {
        const hit = find(c);
        if (hit) return hit;
      }
    }
    return null;
  }
  return find(tree);
}

const TEMPLATE_PLAN = {
  id: "tmpl-1",
  name: "Featured Feast",
  description: null,
  image: null,
  tags: ["featured"],
  source: "template" as const,
  status: null,
  startDate: null,
  endDate: null,
  isActiveThisWeek: false,
};

const INSTANCE_PLAN = {
  id: "inst-1",
  name: "Spice It Up",
  description: "A spicy week",
  image: null,
  tags: ["spicy"],
  source: "instance" as const,
  status: "this_week",
  startDate: "2026-05-18T00:00:00.000Z",
  endDate: "2026-05-24T00:00:00.000Z",
  isActiveThisWeek: true,
};

test("PlanRow: template source — Open calls onPreviewTemplate, not router.push", async () => {
  const previewed: string[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PlanRow, {
        plan: TEMPLATE_PLAN,
        onPreviewTemplate: (id: string) => {
          previewed.push(id);
        },
      }),
    );
  });

  const tree = renderer.toJSON() as RenderedNode | null;
  const btn = findOpenButton(tree);
  assert.ok(btn, "Open button not found");
  await act(async () => {
    (btn!.props!.onPress as () => void)();
  });

  assert.deepEqual(previewed, ["tmpl-1"]);
  assert.equal(pushedRoutes.length, 0, "router.push should NOT fire for template rows");
  renderer.unmount();
});

test("PlanRow: instance source — Open routes to /plan/[id], not onPreviewTemplate", async () => {
  const previewed: string[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(PlanRow, {
        plan: INSTANCE_PLAN,
        onPreviewTemplate: (id: string) => {
          previewed.push(id);
        },
      }),
    );
  });

  const tree = renderer.toJSON() as RenderedNode | null;
  const btn = findOpenButton(tree);
  assert.ok(btn, "Open button not found");
  await act(async () => {
    (btn!.props!.onPress as () => void)();
  });

  assert.equal(previewed.length, 0, "onPreviewTemplate should NOT fire for instance rows");
  assert.equal(pushedRoutes.length, 1);
  assert.equal(pushedRoutes[0].pathname, "/plan/[id]");
  assert.equal(pushedRoutes[0].params.id, "inst-1");
  renderer.unmount();
});
