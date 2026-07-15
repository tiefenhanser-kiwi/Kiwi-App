// WS7-4-B c6 — PlanPreviewModal component tests.
//
// Renders the modal via react-test-renderer using the stubbed react-native
// host components from lib/api/__tests__/_loader.mjs. The test walks the
// rendered tree (toJSON) to verify content, and exercises the Use Plan +
// close interactions by invoking handler props on the rendered <rn-pressable>
// nodes.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import { PlanPreviewModal } from "../PlanPreviewModal";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

const TEMPLATE_RESPONSE = {
  template: {
    id: "tmpl-1",
    userId: "owner-x",
    title: "Family Favorites",
    description: "Crowd-pleasers",
    image: null,
    tags: ["family", "dev"],
    sourceType: "wizard",
    defaultDaysCount: 5,
    optimizationNotes: [],
    items: [
      {
        id: "ti-1",
        mealId: "meal-a",
        positionIndex: 0,
        assignedDayOfWeek: "Monday",
        isBreakfast: false,
        isLunch: false,
        isDinner: true,
        meal: {
          id: "meal-a", title: "Meal A", cuisine: "American", minutes: 30,
          servings: 4, authoredServingsDefault: 4, effectiveServings: 4, calories: 500, protein: 30, carbs: 40, fat: 18,
          tags: [], image: null, description: null, difficulty: "easy",
          mealType: "dinner", sourceType: "curated", isPublic: true,
          userId: null, dishes: [], steps: [], notes: null,
        },
      },
      {
        id: "ti-2",
        mealId: "meal-b",
        positionIndex: 1,
        assignedDayOfWeek: "Tuesday",
        isBreakfast: false,
        isLunch: false,
        isDinner: true,
        meal: {
          id: "meal-b", title: "Meal B", cuisine: "Italian", minutes: 25,
          servings: 4, authoredServingsDefault: 4, effectiveServings: 4, calories: 600, protein: 28, carbs: 50, fat: 22,
          tags: [], image: null, description: null, difficulty: "easy",
          mealType: "dinner", sourceType: "curated", isPublic: true,
          userId: null, dishes: [], steps: [], notes: null,
        },
      },
    ],
  },
};

beforeEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = (async () =>
    mockJson(TEMPLATE_RESPONSE)) as unknown as typeof fetch;
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(
    TOKEN_KEY,
    "test-token",
  );
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

async function settle(qc: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc.isFetching() === 0) return;
    }
  });
}

interface RenderedNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<RenderedNode | string>;
}

function walkText(node: RenderedNode | string | null | undefined, out: string[]): void {
  if (node == null) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) walkText(c, out);
  }
}

function findByTestID(
  node: RenderedNode | string | null | undefined,
  id: string,
): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  if ((node.props as { testID?: string } | undefined)?.testID === id) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findByTestID(c, id);
      if (hit) return hit;
    }
  }
  return null;
}

function renderModal(props: {
  visible: boolean;
  templateId: string | null;
  onClose: () => void;
  onUsePlan: (id: string, opts: { activate: boolean }) => void | Promise<void>;
}): { renderer: TestRenderer.ReactTestRenderer; qc: QueryClient } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderer = TestRenderer.create(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(PlanPreviewModal, props),
    ),
  );
  return { renderer, qc };
}

test("renders title, description, tags, and items after the template loads", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  let qc!: QueryClient;
  await act(async () => {
    ({ renderer, qc } = renderModal({
      visible: true,
      templateId: "tmpl-1",
      onClose: () => {},
      onUsePlan: () => {},
    }));
  });
  await settle(qc);

  const tree = renderer.toJSON() as RenderedNode | RenderedNode[] | null;
  const text: string[] = [];
  if (Array.isArray(tree)) tree.forEach((n) => walkText(n, text));
  else walkText(tree, text);
  const joined = text.join(" | ");

  assert.ok(joined.includes("Family Favorites"), `missing title in: ${joined}`);
  assert.ok(joined.includes("Crowd-pleasers"), `missing description in: ${joined}`);
  assert.ok(joined.includes("Meal A"), `missing meal A in: ${joined}`);
  assert.ok(joined.includes("Meal B"), `missing meal B in: ${joined}`);
  assert.ok(joined.includes("Monday"), `missing day in: ${joined}`);
  assert.ok(joined.includes("family"), `missing tag in: ${joined}`);
  renderer.unmount();
});

test("close button fires onClose", async () => {
  let closeCalls = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  let qc!: QueryClient;
  await act(async () => {
    ({ renderer, qc } = renderModal({
      visible: true,
      templateId: "tmpl-1",
      onClose: () => {
        closeCalls += 1;
      },
      onUsePlan: () => {},
    }));
  });
  await settle(qc);

  const tree = renderer.toJSON() as RenderedNode | null;
  const closeNode = findByTestID(tree, "plan-preview-close");
  assert.ok(closeNode, "close node not rendered");
  const onPress = (closeNode!.props as { onPress?: () => void }).onPress;
  assert.equal(typeof onPress, "function");
  await act(async () => {
    onPress!();
  });
  assert.equal(closeCalls, 1);
  renderer.unmount();
});

test("Use This Week calls onUsePlan(templateId, {activate:true}) then onClose", async () => {
  let closeCalls = 0;
  const calls: Array<{ id: string; activate: boolean }> = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  let qc!: QueryClient;
  await act(async () => {
    ({ renderer, qc } = renderModal({
      visible: true,
      templateId: "tmpl-1",
      onClose: () => {
        closeCalls += 1;
      },
      onUsePlan: async (id, opts) => {
        calls.push({ id, activate: opts.activate });
      },
    }));
  });
  await settle(qc);

  const tree = renderer.toJSON() as RenderedNode | null;
  const useNode = findByTestID(tree, "plan-preview-use");
  assert.ok(useNode, "use-this-week node not rendered");
  const onPress = (useNode!.props as { onPress?: () => Promise<void> }).onPress;
  assert.equal(typeof onPress, "function");
  await act(async () => {
    await onPress!();
  });

  assert.deepEqual(calls, [{ id: "tmpl-1", activate: true }]);
  assert.equal(closeCalls, 1);
  renderer.unmount();
});

test("Save for Later calls onUsePlan(templateId, {activate:false}) then onClose", async () => {
  let closeCalls = 0;
  const calls: Array<{ id: string; activate: boolean }> = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  let qc!: QueryClient;
  await act(async () => {
    ({ renderer, qc } = renderModal({
      visible: true,
      templateId: "tmpl-1",
      onClose: () => {
        closeCalls += 1;
      },
      onUsePlan: async (id, opts) => {
        calls.push({ id, activate: opts.activate });
      },
    }));
  });
  await settle(qc);

  const tree = renderer.toJSON() as RenderedNode | null;
  const saveNode = findByTestID(tree, "plan-preview-save");
  assert.ok(saveNode, "save-for-later node not rendered");
  const onPress = (saveNode!.props as { onPress?: () => Promise<void> }).onPress;
  assert.equal(typeof onPress, "function");
  await act(async () => {
    await onPress!();
  });

  assert.deepEqual(calls, [{ id: "tmpl-1", activate: false }]);
  assert.equal(closeCalls, 1);
  renderer.unmount();
});

// BUG-036 (rail-dupe half): a double-tap must not fire onUsePlan twice. The
// first tap flips `pending`; the re-rendered button both disables and, via the
// handler guard, no-ops a second tap until the first settles.
test("in-flight guard: a second tap while the first is pending does not double-fire", async () => {
  let calls = 0;
  let releaseFirst!: () => void;
  const gate = new Promise<void>((r) => {
    releaseFirst = r;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  let qc!: QueryClient;
  await act(async () => {
    ({ renderer, qc } = renderModal({
      visible: true,
      templateId: "tmpl-1",
      onClose: () => {},
      onUsePlan: async () => {
        calls += 1;
        await gate;
      },
    }));
  });
  await settle(qc);

  // First tap — starts the pending action (does not resolve; gated).
  const firstTree = renderer.toJSON() as RenderedNode | null;
  const firstNode = findByTestID(firstTree, "plan-preview-use");
  const firstPress = (firstNode!.props as { onPress?: () => void }).onPress;
  await act(async () => {
    firstPress!();
  });
  assert.equal(calls, 1, "first tap should fire once");

  // Re-read after the pending re-render: the button is now disabled, and the
  // handler guard rejects a second tap.
  const pendingTree = renderer.toJSON() as RenderedNode | null;
  const secondNode = findByTestID(pendingTree, "plan-preview-use");
  assert.equal(
    (secondNode!.props as { disabled?: boolean }).disabled,
    true,
    "primary CTA should be disabled while pending",
  );
  const secondPress = (secondNode!.props as { onPress?: () => void }).onPress;
  await act(async () => {
    secondPress!();
  });
  assert.equal(calls, 1, "guarded second tap must not double-fire");

  // Release so the pending promise settles cleanly.
  await act(async () => {
    releaseFirst();
    await Promise.resolve();
  });
  renderer.unmount();
});
