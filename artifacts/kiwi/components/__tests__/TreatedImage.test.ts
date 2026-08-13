// WS9-2 2c Commit 2 — TreatedImage.
//
// This component had NO test file despite being the app's ONE image primitive
// and the only surface where photographs actually render (the Featured-
// plans rail). Its null-source behavior is load-bearing: every other TreatedImage in
// the app renders the gradient permanently, because Meal.imageUrl is non-null
// on 0/1471 rows and Dish.imageUrl on 0/3485.
//
// The onError signal added this commit is ADDITIVE. These tests pin that the
// rendering is byte-identical in every pre-existing case — most importantly the
// null path, which the rail depends on and which later commits must not touch.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { TreatedImage } from "../TreatedImage";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: Json[] | null;
};

function render(props: React.ComponentProps<typeof TreatedImage>) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(TreatedImage, props));
  });
  return tree;
}

function findAll(node: Json | Json[] | null, type: string): Json[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, type));
  const here = node.type === type ? [node] : [];
  return [...here, ...findAll(node.children, type)];
}

const URI = "https://images.unsplash.com/photo-1504674900247-0877df9cc836";

// ── the null path (§0.2 — load-bearing, must not change) ────────────────────

test("null source: renders the gradient placeholder and mounts NO Image", () => {
  const tree = render({ source: null, height: 74 });
  const json = tree.toJSON() as unknown as Json;

  assert.equal(
    findAll(json, "rn-linear-gradient").length,
    1,
    "the warm gradient is the fallback and must always be painted",
  );
  assert.equal(
    findAll(json, "rn-image").length,
    0,
    "no <Image> is mounted at all when there is no source — the ternary short-circuits",
  );
});

test("omitted source behaves identically to an explicit null", () => {
  const withNull = JSON.stringify(render({ source: null, height: 74 }).toJSON());
  const withUndef = JSON.stringify(render({ height: 74 }).toJSON());
  assert.equal(withNull, withUndef);
});

test("adding an onError prop does NOT change the null-source render", () => {
  // The regression this guards: wiring a handler in a way that leaks into the
  // no-photo path would alter ~95% of the app's image slots.
  const without = JSON.stringify(render({ source: null, height: 74 }).toJSON());
  const withHandler = JSON.stringify(
    render({ source: null, height: 74, onError: () => {} }).toJSON(),
  );
  assert.equal(without, withHandler);
});

// ── the photo path ──────────────────────────────────────────────────────────

test("a remote source mounts an Image OVER the gradient (gradient still painted)", () => {
  const tree = render({ source: { uri: URI }, height: 74 });
  const json = tree.toJSON() as unknown as Json;

  assert.equal(findAll(json, "rn-linear-gradient").length, 1);
  const images = findAll(json, "rn-image");
  assert.equal(images.length, 1);
  assert.deepEqual(images[0].props.source, { uri: URI });
  assert.equal(images[0].props.resizeMode, "cover");
});

// ── onError ─────────────────────────────────────────────────────────────────

test("onError fires with the failing URI when the remote image fails", () => {
  const seen: (string | null)[] = [];
  const tree = render({
    source: { uri: URI },
    height: 74,
    onError: (u) => seen.push(u),
  });
  const json = tree.toJSON() as unknown as Json;
  const image = findAll(json, "rn-image")[0];

  const warn = console.warn;
  console.warn = () => {};
  try {
    act(() => {
      (image.props.onError as () => void)();
    });
  } finally {
    console.warn = warn;
  }

  assert.deepEqual(seen, [URI]);
});

test("onError reports null for a bundled asset (a local require cannot 404)", () => {
  const seen: (string | null)[] = [];
  // A bundled asset is a number under Metro's asset registry.
  const tree = render({
    source: 42 as unknown as { uri: string },
    height: 74,
    onError: (u) => seen.push(u),
  });
  const image = findAll(tree.toJSON() as unknown as Json, "rn-image")[0];

  const warn = console.warn;
  console.warn = () => {};
  try {
    act(() => {
      (image.props.onError as () => void)();
    });
  } finally {
    console.warn = warn;
  }

  assert.deepEqual(seen, [null]);
});

test("the failure is warned even when no caller passes onError", () => {
  const tree = render({ source: { uri: URI }, height: 74 });
  const image = findAll(tree.toJSON() as unknown as Json, "rn-image")[0];

  const calls: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => calls.push(args);
  try {
    act(() => {
      (image.props.onError as () => void)();
    });
  } finally {
    console.warn = warn;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "[TreatedImage] image failed to load");
  assert.deepEqual(calls[0][1], { uri: URI });
});
