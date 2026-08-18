// WS9-2 2e Part 2 Phase 3 (BUG-086) — FeaturedPlanCard height uniformity.
//
// The bug: rail cards showed dead white space. The cause was TWO independent
// height inputs plus a stretch coupling:
//   (1) railMeta suppresses the meta line when tags[0] merely restates the
//       occasion badge — true on THREE of the six live cards (Game Day Spread,
//       4th of July BBQ, AND Holiday Hosting Menu; the original report named
//       two);
//   (2) railCard titles wrap to TWO lines, so a long title makes a card taller
//       whether or not it has meta;
//   (3) the rail's content container is a flex row with Yoga's default
//       align-items: stretch, so every card was pulled to the tallest one's
//       height and the short ones gained a blank band inside their own border.
//
// ⚠️ THE TEST THAT MATTERS is the cross-product one: every combination of
// {short,long} title × {meta,no meta} must produce the SAME reserved heights.
// Anything that only checks "the 3 known-suppressed cards look right" encodes
// "3 short, 3 tall" — and rail membership is hand-curated railPosition integers
// in the database, so that ratio changes with no deploy.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  FeaturedPlanCard,
  RAIL_TITLE_SLOT_HEIGHT,
  RAIL_META_LINE_HEIGHT,
} from "../FeaturedPlanCard";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};

function render(props: React.ComponentProps<typeof FeaturedPlanCard>): Json {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(FeaturedPlanCard, props));
  });
  return tree.toJSON() as unknown as Json;
}

function walk(node: Json | string | null): Json[] {
  if (node == null || typeof node === "string") return [];
  const kids = Array.isArray(node.children)
    ? node.children.flatMap((c) => walk(c))
    : [];
  return [node, ...kids];
}
function flatten(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === "function"
      ? (style as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : style;
  const parts = Array.isArray(resolved) ? resolved : [resolved];
  return Object.assign({}, ...parts.filter(Boolean));
}
function allText(node: Json | string | null): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  return Array.isArray(node.children) ? node.children.flatMap(allText) : [];
}

/** Every explicitly-reserved height in the card, in render order. */
function reservedHeights(root: Json): number[] {
  return walk(root)
    .map((n) => flatten(n.props.style).height)
    .filter((h): h is number => typeof h === "number");
}

const SHORT = "Budget Bowls";
const LONG = "Family Favorites Week for the Whole Household";

const CASES = [
  { name: "short title + meta", title: SHORT, meta: "budget" },
  { name: "short title, NO meta", title: SHORT, meta: undefined },
  { name: "long title + meta", title: LONG, meta: "quick" },
  { name: "long title, NO meta", title: LONG, meta: undefined },
] as const;

// ── the load-bearing guarantee ──────────────────────────────────────────────

test("BUG-086: every title × meta combination reserves the SAME heights", () => {
  const baseline = reservedHeights(
    render({ occasion: "Hosting", title: CASES[0].title, meta: CASES[0].meta }),
  );
  for (const c of CASES) {
    const got = reservedHeights(
      render({ occasion: "Hosting", title: c.title, meta: c.meta }),
    );
    assert.deepEqual(
      got,
      baseline,
      `"${c.name}" must reserve the same heights as every other card`,
    );
  }
});

test("BUG-086: the title slot holds TWO lines whether the title uses one or two", () => {
  for (const title of [SHORT, LONG]) {
    const root = render({ occasion: "Hosting", title });
    assert.ok(
      reservedHeights(root).includes(RAIL_TITLE_SLOT_HEIGHT),
      `title slot missing for "${title}"`,
    );
  }
});

test("BUG-086: the meta slot is reserved even when the line is SUPPRESSED", () => {
  // This is the exact case that produced the dead band: railMeta returned null,
  // the slot collapsed, and the rail stretched the card back up to its
  // siblings' height with blank space.
  const withMeta = render({ occasion: "Hosting", title: SHORT, meta: "budget" });
  const without = render({ occasion: "Hosting", title: SHORT });
  assert.ok(reservedHeights(without).includes(RAIL_META_LINE_HEIGHT));
  assert.deepEqual(reservedHeights(without), reservedHeights(withMeta));
});

test("a suppressed meta renders NO text — the slot is empty, not filled with filler", () => {
  // Reserving space is the fix; inventing a placeholder string would not be.
  const root = render({ occasion: "Hosting", title: SHORT });
  const t = allText(root);
  assert.deepEqual(t, ["Hosting", SHORT], "only the badge and the title");
});

test("a present meta still renders, on one line", () => {
  const root = render({ occasion: "Featured", title: SHORT, meta: "budget" });
  assert.ok(allText(root).includes("budget"));
  const metaNode = walk(root).find(
    (n) => allText(n).join("") === "budget" && n.props.numberOfLines === 1,
  );
  assert.ok(metaNode, "meta must be clamped to one line");
});

// ── the live pool, as a smoke check only ────────────────────────────────────

test("the three live suppressed cards match the three live non-suppressed ones", () => {
  // ⚠️ This is a SANITY check on real names, NOT the guarantee — the guarantee
  // is the cross-product test above. Do not let this list become the spec:
  // curation moves cards in and out of the rail without a deploy.
  const suppressed = ["Game Day Spread", "4th of July BBQ", "Holiday Hosting Menu"];
  const shown: [string, string][] = [
    ["Quick Weeknights", "quick"],
    ["Family Favorites Week", "family"],
    ["Budget Bowls", "budget"],
  ];
  const baseline = reservedHeights(
    render({ occasion: "Hosting", title: suppressed[0] }),
  );
  for (const title of suppressed) {
    assert.deepEqual(
      reservedHeights(render({ occasion: "Hosting", title })),
      baseline,
      title,
    );
  }
  for (const [title, meta] of shown) {
    assert.deepEqual(
      reservedHeights(render({ occasion: "Featured", title, meta })),
      baseline,
      title,
    );
  }
});

test("the card still declares no fixed OUTER height — only its slots are reserved", () => {
  // A blunt `height` on the card would also make the rail uniform, but it would
  // clip a wrapped title instead of accommodating it.
  const root = render({ occasion: "Hosting", title: LONG, meta: "quick" });
  const card = walk(root)[0];
  const s = flatten(card.props.style);
  assert.equal(s.height, undefined);
  assert.equal(s.minHeight, undefined);
});
