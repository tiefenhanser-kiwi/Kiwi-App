// WS9 row 5 Block 3 Part D — the two PLAN image slots render through
// TreatedImage: a url mounts ONE expo-image element carrying that uri over the
// gradient (memory-disk cache); null mounts NO image element and the gradient
// alone. ~4.7% of plans carry an image (D-WS9-144), so the ramp is the usual
// render and the ruled interim — not a loading state, not an error.
//
// ⚠️ These are NOT meal thumbs. The sizes pinned here are the plan surfaces'
// own literals (PlanRow 56, the Hub's promote card 48), unchanged by this
// block, and deliberately NOT ImageTreatment.thumb.* — D-WS9-252 named the
// meal roles and moved them; a plan slot must not ride along.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { PlanListItem } from "@/lib/api/plans";
import type { HubModel } from "@/lib/cooking/hubModel";
import { PlanRow } from "../PlanRow";
import { PrepCookHubView } from "../PrepCookHubView";

const here = dirname(fileURLToPath(import.meta.url));

const IMAGE_HOST = "expo-image";
const GRADIENT_HOST = "rn-linear-gradient";

type Json = {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[] | null;
};
type Tree = Json | string | null | (Json | string)[];

function walk(node: Tree): Json[] {
  if (node == null || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap((c) => walk(c));
  const kids = Array.isArray(node.children) ? node.children.flatMap((c) => walk(c)) : [];
  return [node, ...kids];
}

function render(el: React.ReactElement): Json[] {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(el);
  });
  return walk(tree.toJSON() as unknown as Tree);
}

const images = (nodes: Json[]) => nodes.filter((n) => n.type === IMAGE_HOST);
const gradients = (nodes: Json[]) => nodes.filter((n) => n.type === GRADIENT_HOST);
const rnImages = (nodes: Json[]) => nodes.filter((n) => n.type === "rn-image");

function wrapWidths(nodes: Json[]): number[] {
  const out: number[] = [];
  for (const n of nodes) {
    const style = n.props.style;
    const flat = Array.isArray(style) ? style.flat(Infinity) : [style];
    for (const s of flat) {
      if (s && typeof s === "object" && typeof (s as { width?: unknown }).width === "number") {
        out.push((s as { width: number }).width);
      }
    }
  }
  return out;
}

const URL = "https://example.test/plans/template-1.jpg";
const PLAN_ROW_THUMB = 56;
const HUB_PLAN_CARD_THUMB = 48;

function planItem(overrides: Partial<PlanListItem> = {}): PlanListItem {
  return {
    id: "inst-1",
    name: "Spice It Up",
    description: null,
    image: null,
    tags: [],
    source: "instance",
    status: "this_week",
    startDate: null,
    endDate: null,
    isActiveThisWeek: true,
    ...overrides,
  };
}

const NOOP = () => {};
function hubEmpty(model: HubModel) {
  return render(
    React.createElement(PrepCookHubView, {
      model,
      onPrepWeek: NOOP,
      onPrepSelected: NOOP,
      onToggleMealSelected: NOOP,
      selectedMealIds: new Set<string>(),
      onSelectMeal: NOOP,
      onMakePlan: NOOP,
      onCookThisWeek: NOOP,
      promotingPlanId: null,
    }),
  );
}

// The guard against a meal token leaking onto a plan surface. A size pin alone
// cannot prove it: the Hub card's 48 numerically equals thumb.dense after
// D-WS9-252 (72/60/48), so the source is checked — the plan slots name their
// own constants and never read ImageTreatment.thumb.*.
test("Part D: the plan slots read their own size constants, not a meal role", () => {
  const planRow = readFileSync(resolve(here, "../PlanRow.tsx"), "utf8");
  const hub = readFileSync(resolve(here, "../PrepCookHubView.tsx"), "utf8");
  const stripComments = (src: string) => src.replace(/\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.ok(!/ImageTreatment\.thumb/.test(stripComments(planRow)), "PlanRow code (comments stripped) never reads a meal role");
  assert.match(planRow, /width=\{PLAN_THUMB\}\s+height=\{PLAN_THUMB\}/);
  assert.match(hub, /width=\{PLAN_CARD_THUMB\}\s+height=\{PLAN_CARD_THUMB\}/);
  // The Hub's ONE ImageTreatment.thumb read is the meal row (Block 2), not the plan card.
  assert.equal((stripComments(hub).match(/ImageTreatment\.thumb\./g) ?? []).length, 2, "width+height on the meal row only");
  assert.ok(!planRow.includes("ImageTreatment.thumbSize") && !hub.includes("ImageTreatment.thumbSize"));
});

test("PlanRow: url → one expo-image at the row's own 56 over the gradient; no raw rn-image", () => {
  const nodes = render(React.createElement(PlanRow, { plan: planItem({ image: URL }) }));
  assert.equal(images(nodes).length, 1);
  assert.deepEqual(images(nodes)[0].props.source, { uri: URL });
  assert.equal(gradients(nodes).length, 1);
  assert.equal(rnImages(nodes).length, 0, "the raw <Image> is gone");
  assert.ok(wrapWidths(nodes).includes(PLAN_ROW_THUMB), `sized 56: ${wrapWidths(nodes)}`);
});

test("PlanRow: null image → the ramp alone, still at 56", () => {
  const nodes = render(React.createElement(PlanRow, { plan: planItem() }));
  assert.equal(images(nodes).length, 0);
  assert.equal(gradients(nodes).length, 1);
  assert.ok(wrapWidths(nodes).includes(PLAN_ROW_THUMB));
});

test("Hub promote card: url → one expo-image at the card's own 48; null → ramp alone", () => {
  const withUrl = hubEmpty({
    kind: "empty",
    plans: [{ id: "p1", name: "Backyard Classics", dateRangeLabel: null, thumbnailUrl: URL }],
  });
  assert.equal(images(withUrl).length, 1);
  assert.deepEqual(images(withUrl)[0].props.source, { uri: URL });
  assert.equal(rnImages(withUrl).length, 0, "the raw <Image> is gone");
  assert.ok(wrapWidths(withUrl).includes(HUB_PLAN_CARD_THUMB), `sized 48: ${wrapWidths(withUrl)}`);

  const without = hubEmpty({
    kind: "empty",
    plans: [{ id: "p1", name: "Backyard Classics", dateRangeLabel: null }],
  });
  assert.equal(images(without).length, 0);
  assert.equal(gradients(without).length, 1);
  assert.ok(wrapWidths(without).includes(HUB_PLAN_CARD_THUMB));
});
