// Deep Kiwi mark wiring — HomeHeader.
//
// The header's mark was an interim TEXT wordmark ("kiwi"). It is now the Deep
// Kiwi mark image (assets/images/header-mark-28.png). Two things must hold and
// neither is visible to typecheck: the image is actually mounted with an
// accessibilityLabel (it replaced a word — a screen reader must still hear the
// name), and the word itself is no longer painted as text (a stale wordmark
// beside the mark would read "kiwi kiwi" to VoiceOver and look doubled).
//
// WHY THE `require` SHIM. HomeHeader references the asset with a relative
// `require(...)` — the app's existing convention for local images (see
// app/(auth)/welcome.tsx). Under Metro that resolves to an asset-registry id.
// Under node:test the component is loaded as ESM through the sucrase hook,
// where `require` is undefined and a `.png` has no loader. The shim below
// stands in for Metro's asset registry for THIS process only (node:test runs
// each file in its own process) and records the specifier, so the test can
// assert the header asked for the right asset rather than just "some image".

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Metro asset-registry stand-in. The header's `require` runs at RENDER time
// (inside the JSX), not at module evaluation, so installing it here — after
// the hoisted imports have evaluated but before the first mount — is enough.
const MARK_ASSET_ID = 4242;
const requiredSpecifiers: string[] = [];
(globalThis as { require?: unknown }).require = (specifier: string) => {
  requiredSpecifiers.push(specifier);
  return MARK_ASSET_ID;
};

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import * as SecureStore from "expo-secure-store";

import { HomeHeader } from "../HomeHeader";
import { AuthProvider } from "@/contexts/AuthContext";

interface Node {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string>;
}

function findAll(node: Node | string | null, type: string, out: Node[] = []): Node[] {
  if (node == null || typeof node === "string") return out;
  if (node.type === type) out.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children) findAll(c, type, out);
  }
  return out;
}

function gatherText(node: Node | string | null, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) gatherText(c, out);
  }
  return out;
}

let activeRenderer: TestRenderer.ReactTestRenderer | null = null;
let activeClient: QueryClient | null = null;
const originalFetch = globalThis.fetch;

before(() => {
  // No stored token → AuthProvider never fires /auth/me, but a never-settling
  // fetch guarantees nothing escapes to the network if that ever changes.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
});

afterEach(() => {
  if (activeRenderer) {
    try {
      activeRenderer.unmount();
    } catch {
      // already unmounted
    }
    activeRenderer = null;
  }
  activeClient?.clear();
  activeClient = null;
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
});

after(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { require?: unknown }).require;
});

/** Mount the real header under the real AuthProvider (logged-out) and return its tree. */
async function mountHeader(): Promise<Node> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  activeClient = client;
  let renderer!: TestRenderer.ReactTestRenderer;
  // Wrapped in async act so AuthProvider's SecureStore read (an effect that
  // sets state after an await) commits inside act rather than warning.
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(AuthProvider, null, React.createElement(HomeHeader)),
      ),
    );
  });
  activeRenderer = renderer;
  // Let the storage read's setState land inside act (one macrotask is enough
  // for the stub's resolved promise chain).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return renderer.toJSON() as unknown as Node;
}

// ── the mark ────────────────────────────────────────────────────────────────

test("renders the Deep Kiwi mark image, labelled 'Kiwi' for screen readers", async () => {
  const tree = await mountHeader();

  const images = findAll(tree, "rn-image");
  assert.equal(images.length, 1, "exactly one <Image> — the mark — in the header");
  const mark = images[0];

  assert.equal(mark.props?.accessibilityLabel, "Kiwi");
  assert.equal(mark.props?.accessible, true);

  // The source is whatever the asset registry handed back for the header mark.
  assert.equal(mark.props?.source, MARK_ASSET_ID);
  assert.ok(
    requiredSpecifiers.some((s) => s.endsWith("/header-mark-28.png")),
    `expected a require of header-mark-28.png, saw: ${JSON.stringify(requiredSpecifiers)}`,
  );
});

test("the mark is fixed at 28×28", async () => {
  const tree = await mountHeader();
  const mark = findAll(tree, "rn-image")[0];
  const s = mark.props?.style;
  const style = Object.assign({}, ...(Array.isArray(s) ? s : [s]).filter(Boolean));
  assert.equal(style.width, 28);
  assert.equal(style.height, 28);
});

// ── the retired wordmark ────────────────────────────────────────────────────

test("the literal 'kiwi' wordmark is no longer rendered as text", async () => {
  const tree = await mountHeader();
  const text = gatherText(tree);

  assert.ok(
    !text.some((t) => t.trim().toLowerCase() === "kiwi"),
    `the text wordmark should be gone; rendered strings: ${JSON.stringify(text)}`,
  );
  // The greeting still renders — the mark replaced the WORDMARK, not the row.
  assert.ok(
    text.some((t) => /^Good (morning|afternoon|evening), there$/.test(t)),
    `expected the logged-out greeting; rendered strings: ${JSON.stringify(text)}`,
  );
});
