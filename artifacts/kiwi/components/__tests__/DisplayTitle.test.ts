// WS9 3f-4d (D-WS9-121) — the shared title primitive. Covers field resolution
// (displayTitle ?? title ?? fallback) and the per-variant line policy.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";

import {
  DISPLAY_TITLE_FALLBACK,
  DisplayTitle,
  resolveDisplayTitle,
} from "../DisplayTitle";

// ── resolveDisplayTitle (the non-JSX resolver) ─────────────────────────────

test("resolveDisplayTitle: displayTitle wins when present", () => {
  assert.equal(
    resolveDisplayTitle({ title: "A long canonical title", displayTitle: "Short" }),
    "Short",
  );
});

test("resolveDisplayTitle: falls back to title when displayTitle absent/null", () => {
  assert.equal(resolveDisplayTitle({ title: "Canonical" }), "Canonical");
  assert.equal(
    resolveDisplayTitle({ title: "Canonical", displayTitle: null }),
    "Canonical",
  );
});

test("resolveDisplayTitle: blank/whitespace displayTitle falls through to title", () => {
  assert.equal(
    resolveDisplayTitle({ title: "Canonical", displayTitle: "   " }),
    "Canonical",
  );
});

test("resolveDisplayTitle: both absent → fallback", () => {
  assert.equal(resolveDisplayTitle({}), DISPLAY_TITLE_FALLBACK);
  assert.equal(resolveDisplayTitle({ title: "" }), DISPLAY_TITLE_FALLBACK);
  assert.equal(resolveDisplayTitle(null), DISPLAY_TITLE_FALLBACK);
  assert.equal(resolveDisplayTitle(undefined), DISPLAY_TITLE_FALLBACK);
});

test("resolveDisplayTitle: custom fallback honored", () => {
  assert.equal(resolveDisplayTitle({}, "Untitled dish"), "Untitled dish");
});

test("resolveDisplayTitle: plan `name` alias resolves, displayTitle still wins", () => {
  assert.equal(resolveDisplayTitle({ name: "My plan" }), "My plan");
  assert.equal(
    resolveDisplayTitle({ name: "My plan", displayTitle: "Short" }),
    "Short",
  );
});

test("resolveDisplayTitle: string source resolves to itself, blank → fallback", () => {
  assert.equal(resolveDisplayTitle("Just a title"), "Just a title");
  assert.equal(resolveDisplayTitle("   "), DISPLAY_TITLE_FALLBACK);
});

// ── DisplayTitle component (line policy + resolved text) ───────────────────

function renderTitle(props: React.ComponentProps<typeof DisplayTitle>) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(DisplayTitle, props));
  });
  return renderer.root.findByType(Text);
}

test("DisplayTitle: variant 'row' caps at 2 lines and renders resolved text", () => {
  const node = renderTitle({
    source: { title: "Canonical", displayTitle: "Short name" },
    variant: "row",
  });
  assert.equal(node.props.numberOfLines, 2);
  assert.equal(node.props.ellipsizeMode, "tail");
  assert.equal(node.props.children, "Short name");
});

test("DisplayTitle: variant 'slim' caps at 1 line", () => {
  const node = renderTitle({ source: { title: "Canonical" }, variant: "slim" });
  assert.equal(node.props.numberOfLines, 1);
  assert.equal(node.props.children, "Canonical");
});

test("DisplayTitle: variant 'railCard' caps at 2 lines", () => {
  const node = renderTitle({ source: "Rail title", variant: "railCard" });
  assert.equal(node.props.numberOfLines, 2);
});

test("DisplayTitle: variant 'hero' is uncapped (no numberOfLines / ellipsize)", () => {
  const node = renderTitle({ source: { title: "Canonical" }, variant: "hero" });
  assert.equal(node.props.numberOfLines, undefined);
  assert.equal(node.props.ellipsizeMode, undefined);
});

test("DisplayTitle: nameless source renders the fallback", () => {
  const node = renderTitle({ source: {}, variant: "slim" });
  assert.equal(node.props.children, DISPLAY_TITLE_FALLBACK);
});

test("DisplayTitle: passed style is forwarded verbatim (typography stays with caller)", () => {
  const style = { fontSize: 17, color: "#123456" };
  const node = renderTitle({ source: "X", variant: "row", style });
  assert.deepEqual(node.props.style, style);
});
