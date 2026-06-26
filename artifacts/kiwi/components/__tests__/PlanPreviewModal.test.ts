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
  onUsePlan: (id: string) => void | Promise<void>;
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

test("Use Plan button calls onUsePlan(templateId) then onClose", async () => {
  let closeCalls = 0;
  const usedIds: string[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  let qc!: QueryClient;
  await act(async () => {
    ({ renderer, qc } = renderModal({
      visible: true,
      templateId: "tmpl-1",
      onClose: () => {
        closeCalls += 1;
      },
      onUsePlan: async (id: string) => {
        usedIds.push(id);
      },
    }));
  });
  await settle(qc);

  const tree = renderer.toJSON() as RenderedNode | null;
  const useNode = findByTestID(tree, "plan-preview-use");
  assert.ok(useNode, "use-plan node not rendered");
  const onPress = (useNode!.props as { onPress?: () => Promise<void> }).onPress;
  assert.equal(typeof onPress, "function");
  await act(async () => {
    await onPress!();
  });

  assert.deepEqual(usedIds, ["tmpl-1"]);
  assert.equal(closeCalls, 1);
  renderer.unmount();
});
