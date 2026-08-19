// WS9-2 2e Phase 1 (D-WS9-160) — TeachingArc.
//
// This component had NO test file and it is the first thing a brand-new user
// sees. Things pinned here, all of which a careless edit breaks silently:
//   1. the WORD ORDER, which was deliberately reversed and could be "corrected"
//      back by anyone reading the old locked-order comment in git history;
//   2. the INDEX PAIRINGS — STEPS[i] takes STEP_ICONS[i] and is dotted by
//      ramp[i], so reordering one list without the others re-pairs them with no
//      type error;
//   3. the emphasis channel — WEIGHT is the only thing distinguishing the lead
//      word, and a "tidy-up" that unifies the font faces would erase it.
//
// ⚠️ WS9-2 2e Part 4 Item 5 rewrote a block of these. Colour left the WORDS and
// moved into a decorative gradient rule, so what used to be pinned as
// "word i is painted with ramp[i]" is now pinned as its inverse — no word may
// carry a ramp colour — plus the sweep, its stop positions, and the dots.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  TeachingArc,
  STEPS,
  STEP_ICONS,
  ARC_SUBLINE,
  stopLocations,
} from "../TeachingArc";
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

/** Every node of `type` in render order. */
function findAll(node: Json | string | null, type: string): Json[] {
  if (node == null || typeof node === "string") return [];
  const here = node.type === type ? [node] : [];
  const kids = Array.isArray(node.children)
    ? node.children.flatMap((c) => findAll(c, type))
    : [];
  return [...here, ...kids];
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

// ⚠️ WS9-2 2e Part 4 Item 5 — THE NEXT FOUR TESTS ARE REWRITTEN, and the
// ruling under them moved. Part 2 painted each WORD with its own ramp stop, so
// these pinned the word↔stop pairing, the exact bridge values, and the absence
// of a fallback word colour.
//
// Treatment A takes colour off the words entirely and puts it in a decorative
// gradient RULE beneath them. So the pairing being pinned is now stop↔DOT, and
// the strongest assertion available is the inverse of the old one: NO word may
// carry a ramp colour at all.

test("the ramp runs sage → terracotta — the direction is REVERSED from Part 2", () => {
  // ⚠️ Part 2's ramp ran terracotta → sage through three net-new bridge browns.
  // This is the other way round, on ordinary scale stops, and it is ruled.
  assert.deepEqual(Components.teachingArc.ramp, [
    Colors.sage[700],
    Colors.sage[400],
    Colors.sage[300],
    Colors.terracotta[300],
    Colors.terracotta[600],
  ]);
});

test("Colors.bridge is GONE — the ramp it existed for no longer exists", () => {
  // It had exactly two consumers: that ramp and this file. If it comes back,
  // something has re-imposed the AA floor that forced it into existence.
  assert.equal(
    (Colors as Record<string, unknown>).bridge,
    undefined,
    "bridge amber/gold/olive were computed to make WORDS pass AA; words are neutral now",
  );
});

test("all five stops are DISTINCT — a progression, not a flat fill", () => {
  const unique = new Set(Components.teachingArc.ramp);
  assert.equal(unique.size, 5);
});

test("Item 5: NO word carries a ramp colour — the colour left the type", () => {
  // The inverse of the assertion this replaces. Part 2's whole problem was that
  // ramp stops had to double as body-text ink; if a stop reappears on a word,
  // that constraint is back and the pale middle of the rule becomes a bug
  // report waiting to happen.
  const nodes = wordNodes(render());
  assert.equal(nodes.length, STEPS.length);
  for (const n of nodes) {
    const c = flatten(n.props.style).color;
    assert.equal(
      c,
      Colors.neutral[800],
      `"${textContent(n)}" must be neutral ink, not a ramp stop`,
    );
    assert.ok(
      !Components.teachingArc.ramp.includes(c as string),
      `ramp colour ${String(c)} leaked back onto a word`,
    );
  }
});

test("Item 5: the icons are muted NEUTRAL too, never ramp stops", () => {
  const icons = findAll(render(), "icon-feather");
  assert.equal(icons.length, STEPS.length, "one icon per stop");
  for (const i of icons) {
    assert.equal(i.props.color, Colors.neutral[600]);
    assert.ok(
      !Components.teachingArc.ramp.includes(i.props.color as string),
      "an icon must not carry a ramp stop either",
    );
  }
});

test("Item 5: each STEP owns its glyph, by name", () => {
  // ⚠️ PINNED AS A MAP, not compared against STEP_ICONS. A deepEqual of the
  // render against STEP_ICONS is a TAUTOLOGY — edit the constant and both sides
  // move together, so it stays green through exactly the re-pairing it claims
  // to catch. (Found by deliberately breaking it; the first version passed.)
  assert.equal(STEP_ICONS.length, STEPS.length);
  assert.deepEqual(
    Object.fromEntries(STEPS.map((s, i) => [s, STEP_ICONS[i]])),
    {
      plans: "calendar",
      meals: "book-open",
      groceries: "shopping-cart",
      prep: "clipboard",
      cook: "play",
    },
  );
});

test("Item 5: the five glyphs are DISTINCT — one identity per stop", () => {
  assert.equal(new Set(STEP_ICONS).size, STEPS.length);
});

test("Item 5: the component renders those glyphs, in STEPS order", () => {
  const rendered = findAll(render(), "icon-feather").map((n) => n.props.name);
  assert.deepEqual(rendered, [...STEP_ICONS]);
});

// ── the gradient rule ───────────────────────────────────────────────────────

test("Item 5: the rule is ONE gradient, not five bands", () => {
  // Five adjacent two-stop gradients would render with visible seams at every
  // join. A single sweep is the entire point of the treatment.
  const grads = findAll(render(), "rn-linear-gradient");
  assert.equal(grads.length, 1, "one continuous sweep across the whole rule");
});

test("Item 5: the sweep carries every ramp stop, in ramp order", () => {
  const g = findAll(render(), "rn-linear-gradient")[0];
  assert.ok(g, "gradient not found");
  assert.deepEqual(
    [...(g.props.colors as string[])],
    [...Components.teachingArc.ramp],
  );
  // Horizontal, left to right — a vertical sweep would be invisible on a 3px rule.
  assert.deepEqual(g.props.start, { x: 0, y: 0.5 });
  assert.deepEqual(g.props.end, { x: 1, y: 0.5 });
});

test("Item 5: each stop's colour lands on its own DOT's centre", () => {
  // The stops are laid out in five equal flex:1 cells, so cell i is centred at
  // (2i+1)/2n. If `locations` drifted off those centres the sweep would still
  // look fine and every dot would sit on the wrong colour.
  const g = findAll(render(), "rn-linear-gradient")[0];
  assert.deepEqual(
    [...(g.props.locations as number[])],
    [0.1, 0.3, 0.5, 0.7, 0.9],
  );
  assert.deepEqual(stopLocations(STEPS.length), [0.1, 0.3, 0.5, 0.7, 0.9]);
});

test("Item 5: stopLocations is DERIVED — it tracks the step count", () => {
  // Hardcoded locations would silently mis-register every dot the moment a
  // sixth step was added.
  assert.deepEqual(stopLocations(2), [0.25, 0.75]);
  assert.deepEqual(stopLocations(4), [0.125, 0.375, 0.625, 0.875]);
  assert.equal(stopLocations(6).length, 6);
});

test("Item 5: there is one DOT per stop, each carrying its own ramp colour", () => {
  const root = render();
  const dots = findAll(root, "rn-view").filter((n) => {
    const s = flatten(n.props.style);
    return (
      typeof s.borderRadius === "number" &&
      s.width === s.height &&
      typeof s.width === "number" &&
      Components.teachingArc.ramp.includes(s.backgroundColor as string)
    );
  });
  assert.equal(dots.length, STEPS.length, "one dot per stop");
  assert.deepEqual(
    dots.map((d) => flatten(d.props.style).backgroundColor),
    [...Components.teachingArc.ramp],
  );
});

test("Item 5: the arrows are GONE — the rule is the only connector", () => {
  // Keeping "→" between the words alongside the gradient would be two
  // connectors doing one job.
  const rendered = texts(render()).map(textContent);
  assert.ok(
    !rendered.some((s) => s.includes("→")),
    "an arrow survived the move to the gradient rule",
  );
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

test("emphasis is not smuggled back in as colour — every word is the SAME ink", () => {
  // ⚠️ Rewritten for Item 5. It used to assert the lead word carried ramp[0]
  // and nothing louder. There is no per-word colour left, so the equivalent
  // guarantee is that the lead word's ink is identical to its four neighbours'
  // — weight is the only thing telling them apart.
  const inks = wordNodes(render()).map((n) => flatten(n.props.style).color);
  assert.equal(new Set(inks).size, 1, `five inks found: ${JSON.stringify(inks)}`);
  assert.equal(inks[0], Colors.neutral[800]);
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
