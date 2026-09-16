// WS9 Plan-flow redesign (D-WS9-191) Block 2 Part B — the plan-options card +
// the shared ExhaustedCard + the ghostQuiet Button variant.
//
// The card renders every field from a fixture in the Block 1 wire shape (meals
// with description | null and times on store slots), a 42px ramp per row (NOT
// the Pick screen's 56), no hero image and no tags row; its three actions fire
// the right callbacks; busy shows the busy LABEL (not a spinner) and locks the
// rest; saved shows "Saved ✓" and keeps ONLY Use This Week; a legacy candidate
// without `meals` renders title-only rows. The ExhaustedCard's exits go BACK
// to the wizard via dismissTo with the params (the Pick screen's ruling).

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { __resetRouterForTests, __setRouterForTests } from "expo-router";

import { Colors, ImageTreatment, Palette } from "@/constants/tokens";
import type { WizardPlanCandidate } from "@/lib/types";
import {
  DISMISS_LABEL,
  EXHAUSTED_PLANS_TITLE,
  SAVE_BUSY_LABEL,
  SAVE_LABEL,
  SAVED_LINE,
  USE_BUSY_LABEL,
  USE_LABEL,
} from "@/lib/wizard/planOptions";
import { Button } from "../Button";
import { EXHAUSTED_REFINE, EXHAUSTED_TELL, EXHAUSTED_TITLE, ExhaustedCard } from "../ExhaustedCard";
import { PlanOptionCard, PlanOptionCardSkeleton, macrosLine } from "../PlanOptionCard";

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
function allText(node: Tree): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(allText);
  return Array.isArray(node.children) ? node.children.flatMap(allText) : [];
}
function joined(node: Tree): string {
  return allText(node).join(" ").replace(/\s+/g, " ");
}
function flatten(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === "function"
      ? (style as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : style;
  const parts = Array.isArray(resolved) ? resolved : [resolved];
  return Object.assign({}, ...parts.filter(Boolean));
}
function byTestId(root: Tree, id: string): Json | undefined {
  return walk(root).find((n) => n.props.testID === id);
}
function render(el: React.ReactElement): Json {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(el);
  });
  return tree.toJSON() as unknown as Json;
}
function press(node: Json | undefined, what: string) {
  assert.ok(node, `${what} not found`);
  assert.equal(typeof node.props.onPress, "function", `${what} has no onPress`);
  act(() => {
    (node.props.onPress as () => void)();
  });
}

afterEach(() => {
  __resetRouterForTests();
});

const WIRE: WizardPlanCandidate = {
  id: "c1",
  title: "Grill Nights",
  imageUrl: "https://example.test/hero.jpg",
  badge: "featured",
  tags: ["grill", "summer"],
  whyBullets: ["Everything on one grill", "Under 40 minutes"],
  mealTitles: ["Burgers", "Tacos", "Salmon"],
  storeSlots: [
    { slotIndex: 0, storeMealId: "m-b" },
    { slotIndex: 2, storeMealId: "m-s" },
  ],
  meals: [
    { title: "Burgers", description: "Smash patties, toasted buns.", storeMealId: "m-b", estimatedTimeMinutes: 25 },
    { title: "Tacos", description: null },
    { title: "Salmon", description: "Cedar-plank, lemon butter.", storeMealId: "m-s", estimatedTimeMinutes: 35 },
  ],
  dailyMacros: { calories: 1850.4, proteinG: 121, carbsG: 180, fatG: 61 },
};

const LEGACY: WizardPlanCandidate = {
  id: "c2",
  title: "Cozy One-Pots",
  tags: [],
  whyBullets: ["Minimal cleanup"],
  mealTitles: ["Chili", "Stew"],
  dailyMacros: { calories: 1600, proteinG: 90, carbsG: 170, fatG: 50 },
};

function card(over: Partial<React.ComponentProps<typeof PlanOptionCard>> = {}) {
  const calls = { use: 0, save: 0, dismiss: 0 };
  const el = React.createElement(PlanOptionCard, {
    candidate: WIRE,
    state: "fresh",
    householdSize: 4,
    onUseThisWeek: () => calls.use++,
    onSaveForLater: () => calls.save++,
    onNotForMe: () => calls.dismiss++,
    ...over,
  });
  return { root: render(el), calls };
}

// ── the card ────────────────────────────────────────────────────────────────

test("fresh: title, meta line, three rows (42px ramp, title, description when present), why bullets, macro line, three actions", () => {
  const { root } = card();
  const text = joined(root);
  assert.ok(text.includes("Grill Nights"));
  assert.ok(text.includes("3 dinners · serves 4 · ~30 min avg"), text);
  assert.ok(text.includes("Smash patties, toasted buns."));
  assert.ok(text.includes("Cedar-plank, lemon butter."));
  assert.ok(text.includes("Everything on one grill"));
  assert.ok(text.includes(macrosLine(WIRE.dailyMacros)));
  assert.ok(text.includes("Avg 1850 cal/day · 121g P · 180g C · 61g F"));
  assert.ok(text.includes(USE_LABEL) && text.includes(SAVE_LABEL) && text.includes(DISMISS_LABEL));

  // 42px placeholder ramps — one per row — and NO photograph anywhere.
  const ramps = walk(root).filter((n) => n.type === "rn-linear-gradient");
  assert.equal(ramps.length, 3);
  const thumbs = walk(root).filter((n) => {
    const s = flatten(n.props.style);
    return s.width === ImageTreatment.thumbSize && s.height === ImageTreatment.thumbSize;
  });
  assert.equal(thumbs.length, 3, "three 42px thumb slots");
  assert.equal(ImageTreatment.thumbSize, 42);
  assert.equal(walk(root).filter((n) => n.type === "rn-image").length, 0, "no hero, no photo");
  // No tags row — the candidate's tags are not rendered.
  assert.ok(!text.includes("summer"), "tags are not shown (spec §2)");
  assert.ok(!text.includes("Featured"), "the dead badge field is not rendered");
});

test("fresh: the three actions fire their callbacks; the card body is not a tap target", () => {
  const { root, calls } = card();
  press(byTestId(root, "plan-option-c1-use"), "Use This Week");
  press(byTestId(root, "plan-option-c1-save"), "Save for Later");
  press(byTestId(root, "plan-option-c1-dismiss"), "Not For Me");
  assert.deepEqual(calls, { use: 1, save: 1, dismiss: 1 });
  const body = byTestId(root, "plan-option-c1");
  assert.ok(body);
  assert.equal(body.props.onPress, undefined, "the card body does nothing on tap");
});

test("busy (use): the label reads 'Building your week…' (no spinner) and every action on the card is disabled", () => {
  const { root, calls } = card({ state: "busy", busyAction: "use" });
  const text = joined(root);
  assert.ok(text.includes(USE_BUSY_LABEL), text);
  assert.ok(!text.includes(USE_LABEL + " "), "the idle label is replaced");
  assert.equal(walk(root).filter((n) => n.type === "rn-activity-indicator").length, 0, "no spinner");
  for (const id of ["plan-option-c1-use", "plan-option-c1-save", "plan-option-c1-dismiss"]) {
    const b = byTestId(root, id);
    assert.ok(b);
    assert.equal(b.props.disabled, true, `${id} disabled while busy`);
  }
  press(byTestId(root, "plan-option-c1-save"), "Save while busy");
  assert.equal(calls.save, 0, "a disabled Button does not fire");
});

test("busy (save): the Save label reads 'Saving…'", () => {
  const { root } = card({ state: "busy", busyAction: "save" });
  assert.ok(joined(root).includes(SAVE_BUSY_LABEL));
});

test("disabled (another card is busy): the three actions are disabled, labels idle", () => {
  const { root } = card({ disabled: true });
  const text = joined(root);
  assert.ok(text.includes(USE_LABEL) && !text.includes(USE_BUSY_LABEL));
  assert.equal(byTestId(root, "plan-option-c1-dismiss")?.props.disabled, true);
});

test("saved: 'Saved ✓' where the actions row was, keeping ONLY Use This Week", () => {
  const { root, calls } = card({ state: "saved" });
  const text = joined(root);
  assert.ok(text.includes(SAVED_LINE), text);
  assert.ok(text.includes(USE_LABEL));
  assert.ok(!text.includes(SAVE_LABEL), "Save for Later is gone");
  assert.ok(!text.includes(DISMISS_LABEL), "Not For Me is gone");
  assert.equal(byTestId(root, "plan-option-c1-save"), undefined);
  assert.equal(byTestId(root, "plan-option-c1-dismiss"), undefined);
  press(byTestId(root, "plan-option-c1-use"), "Use on a saved card");
  assert.equal(calls.use, 1);
});

test("legacy candidate (no meals): title-only rows, no description lines, no crash; household unknown → no 'serves'", () => {
  const { root } = card({ candidate: LEGACY, householdSize: null });
  const text = joined(root);
  assert.ok(text.includes("2 dinners"), text);
  assert.ok(!text.includes("serves"));
  assert.ok(text.includes("Chili") && text.includes("Stew"));
  assert.equal(walk(root).filter((n) => n.type === "rn-linear-gradient").length, 2);
});

test("Not For Me is the ghostQuiet variant (text2 ink); Use This Week is tint", () => {
  const { root } = card();
  const dismiss = byTestId(root, "plan-option-c1-dismiss");
  assert.ok(dismiss);
  const dismissLabel = walk(dismiss).find((n) => n.type === "rn-text");
  assert.equal(flatten(dismissLabel?.props.style).color, Palette.button.ghostQuiet.text);
  assert.equal(Palette.button.ghostQuiet.text, Colors.neutral[700]);
  const use = byTestId(root, "plan-option-c1-use");
  assert.equal(flatten(use?.props.style).backgroundColor, Palette.button.tint.background);
});

test("skeleton: card-shaped, three 42px ramps, no text content", () => {
  const root = render(React.createElement(PlanOptionCardSkeleton));
  assert.ok(byTestId(root, "plan-option-skeleton"));
  assert.equal(walk(root).filter((n) => n.type === "rn-linear-gradient").length, 3);
  assert.equal(joined(root).trim(), "");
});

// ── the Button variant ──────────────────────────────────────────────────────

test("Button ghostQuiet: the ghost's fill and edge, the secondary text tier as label; ghost itself untouched", () => {
  const quiet = render(React.createElement(Button, { label: "Not For Me", variant: "ghostQuiet" }));
  const ghost = render(React.createElement(Button, { label: "Not For Me", variant: "ghost" }));
  const qs = flatten(quiet.props.style);
  const gs = flatten(ghost.props.style);
  assert.equal(qs.backgroundColor, gs.backgroundColor);
  assert.equal(qs.borderColor, gs.borderColor);
  const ql = walk(quiet).find((n) => n.type === "rn-text");
  const gl = walk(ghost).find((n) => n.type === "rn-text");
  assert.equal(flatten(ql?.props.style).color, Colors.neutral[700]);
  assert.equal(flatten(gl?.props.style).color, Palette.button.ghost.text);
  assert.equal(Palette.button.ghost.text, Colors.neutral[900]);
});

// ── the shared ExhaustedCard ────────────────────────────────────────────────

test("ExhaustedCard: the Pick screen's copy by default; the plan-options title when passed; exits dismissTo the wizard / tellkiwi with the params", () => {
  const dismissed: unknown[] = [];
  __setRouterForTests({ dismissTo: (href: unknown) => dismissed.push(href) });

  const pick = render(React.createElement(ExhaustedCard));
  assert.ok(joined(pick).includes(EXHAUSTED_TITLE));
  assert.ok(joined(pick).includes("Not many meals fit"));

  const plans = render(React.createElement(ExhaustedCard, { title: EXHAUSTED_PLANS_TITLE }));
  const text = joined(plans);
  assert.ok(text.includes("Not many plans fit your preferences and restrictions."), text);
  assert.ok(text.includes(EXHAUSTED_REFINE) && text.includes(EXHAUSTED_TELL));

  press(walk(plans).find((n) => n.props.onPress && allText(n).join("") === EXHAUSTED_REFINE), "Refine");
  press(walk(plans).find((n) => n.props.onPress && allText(n).join("") === EXHAUSTED_TELL), "Tell Kiwi");
  assert.equal(dismissed.length, 2);
  const [refine, tell] = dismissed as { pathname: string; params: Record<string, string> }[];
  assert.equal(refine.pathname, "/wizard");
  assert.equal(refine.params.adjust, "1");
  assert.ok(refine.params.nonce);
  assert.equal(tell.pathname, "/tellkiwi");
  assert.equal(tell.params.focus, "1");
});
