// WS9-2 2e Phase 1 (D-WS9-160) — TeachingArc.
//
// This component had NO test file and it is the first thing a brand-new user
// sees. Three things are pinned here, all of which a careless edit breaks
// silently:
//   1. the WORD ORDER, which was deliberately reversed and could be "corrected"
//      back by anyone reading the old locked-order comment in git history;
//   2. the ramp PAIRING — STEPS[i] is coloured by ramp[i], so reordering one
//      list without the other re-assigns colours with no type error;
//   3. the emphasis channel — with all five words coloured, WEIGHT is the only
//      thing distinguishing the lead word, and a "tidy-up" that unifies the
//      font faces would erase it invisibly.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { TeachingArc, STEPS, ARC_SUBLINE } from "../TeachingArc";
import { Colors, Components, Typography } from "@/constants/tokens";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

function render(): Json {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(TeachingArc));
  });
  return tree.toJSON() as unknown as Json;
}

function flatten(style: unknown): Record<string, unknown> {
  const parts = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...parts.filter(Boolean));
}

/** Every rn-text node in render order. */
function texts(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const here = node.type === "rn-text" ? [node] : [];
  const kids = Array.isArray(node.children)
    ? node.children.flatMap((c) => texts(c))
    : [];
  return [...here, ...kids];
}

function textContent(n: Json): string {
  return (Array.isArray(n.children) ? n.children : [])
    .filter((c): c is string => typeof c === "string")
    .join("");
}

/** The five word nodes, in render order (arrows and label/sub excluded). */
function wordNodes(root: Json): Json[] {
  const wanted = new Set<string>(STEPS);
  return texts(root).filter((n) => wanted.has(textContent(n)));
}

// ── order ───────────────────────────────────────────────────────────────────

test("D-WS9-160: the sequence is plans → meals → groceries → prep → cook", () => {
  // ⚠️ This REVERSES a prior lock. `meals` leading described the product
  // backwards: you get a PLAN first and the meals arrive inside it.
  assert.deepEqual(
    [...STEPS],
    ["plans", "meals", "groceries", "prep", "cook"],
  );
});

test("the rendered words match STEPS, in order", () => {
  const rendered = wordNodes(render()).map(textContent);
  assert.deepEqual(rendered, [...STEPS]);
});

test("`plans` leads and `meals` is second — not the other way round", () => {
  const rendered = wordNodes(render()).map(textContent);
  assert.equal(rendered[0], "plans");
  assert.equal(rendered[1], "meals");
});

// ── the ramp ────────────────────────────────────────────────────────────────

test("the ramp has exactly one stop per word", () => {
  // If these ever diverge, some word renders with `color: undefined` and
  // inherits — which looks like a styling accident, not a missing token.
  assert.equal(
    Components.teachingArc.ramp.length,
    STEPS.length,
    "ramp and STEPS must stay the same length",
  );
});

test("word i is painted with ramp[i] — the pairing is positional", () => {
  const nodes = wordNodes(render());
  nodes.forEach((n, i) => {
    assert.equal(
      flatten(n.props.style).color,
      Components.teachingArc.ramp[i],
      `"${textContent(n)}" must use ramp stop ${i}`,
    );
  });
});

test("the ramp runs terracotta → sage, through the three net-new bridge stops", () => {
  assert.deepEqual(Components.teachingArc.ramp, [
    Colors.terracotta[400],
    Colors.bridge.amber,
    Colors.bridge.gold,
    Colors.bridge.olive,
    Colors.sage[700],
  ]);
});

test("all five stops are DISTINCT — a progression, not a flat fill", () => {
  const unique = new Set(Components.teachingArc.ramp);
  assert.equal(unique.size, 5);
});

test("no word carries a hardcoded fallback colour under the ramp", () => {
  // styles.word deliberately omits `color`. If a default is reintroduced, a
  // missing ramp stop stops being visible as a bug.
  const nodes = wordNodes(render());
  for (const n of nodes) {
    const c = flatten(n.props.style).color;
    assert.ok(
      Components.teachingArc.ramp.includes(c as string),
      `word colour ${String(c)} is not a ramp stop`,
    );
  }
});

// ── emphasis is WEIGHT, not colour ──────────────────────────────────────────

test("D-WS9-160: the lead word is distinguished by WEIGHT", () => {
  // Colouring all five destroyed the old chromatic emphasis (4 words at
  // 14.30:1, one at 4.73:1). Weight is the replacement channel.
  const nodes = wordNodes(render());
  const lead = flatten(nodes[0].props.style);
  assert.equal(lead.fontWeight, Typography.fontWeight.bold);
  assert.equal(lead.fontFamily, Typography.face.serif[700]);
});

test("the other four words share ONE lighter weight", () => {
  const rest = wordNodes(render())
    .slice(1)
    .map((n) => flatten(n.props.style));
  for (const s of rest) {
    assert.equal(s.fontWeight, Typography.fontWeight.medium);
    assert.equal(s.fontFamily, Typography.face.serif[500]);
  }
});

test("emphasis is not smuggled back in as colour — ramp[0] is just terracotta", () => {
  // i.e. the lead word must NOT get a second, louder colour on top of its stop.
  const lead = flatten(wordNodes(render())[0].props.style);
  assert.equal(lead.color, Components.teachingArc.ramp[0]);
});

// ── the sub-line ────────────────────────────────────────────────────────────

test("the sub-line copy is unchanged", () => {
  assert.equal(ARC_SUBLINE, "One flow, start to finish. It begins below.");
  const rendered = texts(render()).map(textContent);
  assert.ok(rendered.includes(ARC_SUBLINE));
});

test("D-WS9-160: the sub-line is PROMOTED off the 11px / muted treatment", () => {
  // It was fontSize.xs at neutral[600] — 3.73:1, below AA, and the smallest
  // thing on a card whose job is explaining the product.
  const sub = texts(render()).find((n) => textContent(n) === ARC_SUBLINE);
  assert.ok(sub, "sub-line node found");
  const s = flatten(sub!.props.style);
  assert.equal(s.fontSize, Typography.fontSize.base, "14px, not 11px");
  assert.equal(s.color, Colors.neutral[800], "high-emphasis, not muted");
  assert.notEqual(
    s.color,
    Colors.neutral[600],
    "neutral[600] is the muted role that measured 3.73:1 — below AA",
  );
});
