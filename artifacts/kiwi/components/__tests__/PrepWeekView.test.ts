// WS7-8b Block 4 (Build Block 2) — Week Prep screen render tests.
// Harness mirrors CookSessionView.test.ts (react-test-renderer + text gather).

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { PrepWeekView } from "../PrepWeekView";
import {
  buildPrepWeekModel,
  buildMealLabelLookup,
} from "@/lib/cooking/prepWeekModel";
import type { PrepWeekResult } from "@/lib/api/cooking";

interface RenderedNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<RenderedNode | string>;
}

function gatherText(
  node: RenderedNode | string | null | undefined,
  out: string[] = [],
): string[] {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.children)) for (const c of node.children) gatherText(c, out);
  return out;
}

function flat(node: RenderedNode | null): string {
  return gatherText(node).join(" ").replace(/\s+/g, " ").trim();
}

function findPressableByText(
  node: RenderedNode | string | null,
  text: string,
): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  const props = (node.props ?? {}) as { onPress?: unknown };
  if (props.onPress && gatherText(node).join(" ").includes(text)) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findPressableByText(c, text);
      if (hit) return hit;
    }
  }
  return null;
}

function findByA11yLabel(
  node: RenderedNode | string | null,
  label: string,
): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  const props = (node.props ?? {}) as { accessibilityLabel?: unknown };
  if (props.accessibilityLabel === label) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findByA11yLabel(c, label);
      if (hit) return hit;
    }
  }
  return null;
}

// ── Fixture: 4-phase result (seasonings/sauces skippable+empty; produce step
// combines 2 meals + storageNote; proteins step is skipSuggested, 1 meal). ────

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";

function result(): PrepWeekResult {
  return {
    totalEstimatedMinutes: 45,
    phases: [
      { phase: "seasonings_dry", title: "Seasonings & dry", skippable: true, steps: [] },
      { phase: "sauces_marinades", title: "Sauces & marinades", skippable: true, steps: [] },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          {
            number: 1,
            stepKey: `produce#${M1}`,
            title: "Dice onions",
            instructions: "Dice 2 cups onions for the week.",
            estimatedMinutes: 6,
            contributesToMealIds: [M1, M2],
            storageNote: "Airtight, 4 days",
          },
        ],
      },
      {
        phase: "proteins",
        title: "Proteins",
        skippable: false,
        steps: [
          {
            number: 2,
            stepKey: `proteins#${M1}`,
            title: "Trim chicken",
            instructions: "Trim 2 lb chicken thighs.",
            estimatedMinutes: 10,
            contributesToMealIds: [M1],
            skipSuggested: true,
          },
        ],
      },
    ],
  };
}

const lookup = buildMealLabelLookup([
  { mealId: M1, assignedDayOfWeek: "Tuesday", meal: { title: "Chicken Fajitas" } },
  { mealId: M2, assignedDayOfWeek: "Wednesday", meal: { title: "Veggie Risotto" } },
]);

const NOOP = () => {};

interface Overrides {
  phaseIndex?: number;
  onAdvancePhase?: () => void;
  onPrevPhase?: () => void;
  onSkipPhase?: () => void;
  onExit?: () => void;
  onToggleStep?: (stepKey: string) => void;
}

function renderView(o: Overrides = {}) {
  const vm = buildPrepWeekModel(result(), { mealLabel: lookup });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(PrepWeekView, {
        planName: "Hearty Week",
        vm,
        mealCount: 2,
        phaseIndex: o.phaseIndex ?? 2, // default to the produce phase (has a step)
        onAdvancePhase: o.onAdvancePhase ?? NOOP,
        onPrevPhase: o.onPrevPhase ?? NOOP,
        onSkipPhase: o.onSkipPhase ?? NOOP,
        onExit: o.onExit ?? NOOP,
        onToggleStep: o.onToggleStep,
      }),
    );
  });
  return renderer;
}

// ── Header / subtitle / phase indicator ───────────────────────────────────────

test("header: renders 'Prep the Week', the plan name, and the meals/min subtitle", () => {
  const texts = flat(renderView().toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Prep the Week"), `missing header: ${texts}`);
  assert.ok(texts.includes("Hearty Week"), `missing plan name: ${texts}`);
  // "— 2 meals combined · ~45 min —"
  assert.ok(texts.includes("2 meals combined"), `missing subtitle meals: ${texts}`);
  assert.ok(texts.includes("45 min"), `missing subtitle minutes: ${texts}`);
});

test("phase indicator: shows 'Phase X of 4' for the current pointer", () => {
  assert.ok(flat(renderView({ phaseIndex: 0 }).toJSON() as RenderedNode | null).includes("Phase 1 of 4"));
  assert.ok(flat(renderView({ phaseIndex: 2 }).toJSON() as RenderedNode | null).includes("Phase 3 of 4"));
});

// ── Current-phase card ────────────────────────────────────────────────────────

test("phase card: renders the server phase title + a static blurb", () => {
  const texts = flat(renderView({ phaseIndex: 2 }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Produce"), `missing phase title: ${texts}`);
  assert.ok(texts.includes("chopping"), `missing produce blurb: ${texts}`);
});

// ── Step cards ────────────────────────────────────────────────────────────────

test("step card: number, title, minutes, and full instructions render (quantity intact)", () => {
  const texts = flat(renderView({ phaseIndex: 2 }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Dice onions"), `missing step title: ${texts}`);
  assert.ok(texts.includes("10 min") || texts.includes("6 min"), `missing minutes: ${texts}`);
  // highlighter splits "2 cups" but the full string must remain intact
  assert.ok(
    texts.includes("Dice 2 cups onions for the week."),
    `instructions not intact: ${texts}`,
  );
});

test("combines pill: shown when a step feeds >1 meal", () => {
  const texts = flat(renderView({ phaseIndex: 2 }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("combines 2 meals"), `missing combines pill: ${texts}`);
});

test("combines pill: suppressed when a step feeds exactly 1 meal", () => {
  // proteins phase (index 3): its single step combines only M1
  const texts = flat(renderView({ phaseIndex: 3 }).toJSON() as RenderedNode | null);
  assert.ok(!texts.includes("combines 1 meals"), `pill should be suppressed: ${texts}`);
  assert.ok(!texts.includes("combines"), `no combines pill expected on a 1-meal step: ${texts}`);
});

test("where each goes: renders one display-only label row per destination (name · day)", () => {
  const texts = flat(renderView({ phaseIndex: 2 }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Where each goes"), `missing where-card heading: ${texts}`);
  assert.ok(texts.includes("Chicken Fajitas · Tuesday"), `missing M1 label: ${texts}`);
  assert.ok(texts.includes("Veggie Risotto · Wednesday"), `missing M2 label: ${texts}`);
});

test("storageNote: rendered when present", () => {
  const texts = flat(renderView({ phaseIndex: 2 }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Airtight, 4 days"), `missing storage note: ${texts}`);
});

test("skipSuggested: a flagged step renders the 'optional' affordance (not hidden)", () => {
  const texts = flat(renderView({ phaseIndex: 3 }).toJSON() as RenderedNode | null);
  // the step is still shown...
  assert.ok(texts.includes("Trim chicken"), `skipSuggested step should still render: ${texts}`);
  // ...with an optional cue
  assert.ok(texts.includes("optional"), `missing optional affordance: ${texts}`);
});

// ── Checkbox (display-only this block) ─────────────────────────────────────────

test("checkbox: display-only when no onToggleStep is supplied (no interactive control)", () => {
  const renderer = renderView({ phaseIndex: 2 }); // no onToggleStep
  const box = findByA11yLabel(renderer.toJSON() as RenderedNode | null, "Mark step done");
  assert.equal(box, null, "checkbox must be non-interactive without onToggleStep");
});

test("checkbox: becomes interactive when onToggleStep is supplied (Block 3 wiring point)", () => {
  const toggled: string[] = [];
  const renderer = renderView({
    phaseIndex: 2,
    onToggleStep: (k) => toggled.push(k),
  });
  const box = findByA11yLabel(renderer.toJSON() as RenderedNode | null, "Mark step done");
  assert.ok(box, "checkbox should be interactive with onToggleStep");
  act(() => (box!.props!.onPress as () => void)());
  assert.deepEqual(toggled, [`produce#${M1}`]); // keyed on the step's stepKey
});

// ── Footer / phase progression ────────────────────────────────────────────────

test("footer: 'Done with phase ✓' advances the phase pointer (not the last phase)", () => {
  let advanced = 0;
  const renderer = renderView({ phaseIndex: 2, onAdvancePhase: () => (advanced += 1) });
  const btn = findPressableByText(renderer.toJSON() as RenderedNode | null, "Done with phase");
  assert.ok(btn, "advance button missing");
  act(() => (btn!.props!.onPress as () => void)());
  assert.equal(advanced, 1);
});

test("footer: the advance CTA is hidden on the last phase (proteins)", () => {
  const texts = flat(renderView({ phaseIndex: 3 }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Phase 4 of 4"));
  assert.ok(!texts.includes("Done with phase"), "advance should hide on the last phase");
});

test("footer: the make-ahead note always renders", () => {
  const texts = flat(renderView({ phaseIndex: 0 }).toJSON() as RenderedNode | null);
  assert.ok(
    texts.includes("Kiwi skips the prep you did here"),
    `missing footer note: ${texts}`,
  );
});

// ── Skip (skippable phases only) ──────────────────────────────────────────────

test("skip: skippable phases show 'Skip this phase' and it fires onSkipPhase", () => {
  let skipped = 0;
  const renderer = renderView({ phaseIndex: 0, onSkipPhase: () => (skipped += 1) }); // seasonings_dry
  const btn = findPressableByText(renderer.toJSON() as RenderedNode | null, "Skip this phase");
  assert.ok(btn, "skip button missing on a skippable phase");
  act(() => (btn!.props!.onPress as () => void)());
  assert.equal(skipped, 1);
});

test("skip: non-skippable phases (produce/proteins) show NO skip button", () => {
  const texts = flat(renderView({ phaseIndex: 2 }).toJSON() as RenderedNode | null);
  assert.ok(!texts.includes("Skip this phase"), "produce is not skippable — no skip button");
});

// ── Empty phase ───────────────────────────────────────────────────────────────

test("empty phase: a phase with zero steps shows the all-set note", () => {
  const texts = flat(renderView({ phaseIndex: 0 }).toJSON() as RenderedNode | null);
  assert.ok(
    texts.includes("Nothing to prep ahead in this phase"),
    `missing empty-phase note: ${texts}`,
  );
});
