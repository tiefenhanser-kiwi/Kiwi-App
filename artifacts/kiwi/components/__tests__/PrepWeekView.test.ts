// WS7-8b Block 4 (Build Block 2) — Week Prep screen render tests.
// Harness mirrors CookSessionView.test.ts (react-test-renderer + text gather).

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet } from "react-native";

import { PrepWeekView } from "../PrepWeekView";
import { ProgressSegments } from "../cooking/ProgressSegments";
import {
  buildPrepWeekModel,
  buildMealLabelLookup,
} from "@/lib/cooking/prepWeekModel";
import type { PrepWeekResult } from "@/lib/api/cooking";
import { Colors } from "@/constants/tokens";

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
// combines 2 meals + storageNote; proteins has one KEPT step (feeds M1) and one
// demoted/skipSuggested step (feeds M2) that D-WS7-184 OMITS from render). ─────

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
          },
          {
            // D-WS7-184 — demoted: omitted from render, excluded from the total.
            number: 3,
            stepKey: `proteins#${M2}`,
            title: "Rub the steak",
            instructions: "Rub the steak and grill.",
            estimatedMinutes: 8,
            contributesToMealIds: [M2],
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
  onFinish?: () => void;
  toastVisible?: boolean;
  advanceToast?: { fromPhase: string; toPhase: string } | null;
  onExit?: () => void;
  onToggleStep?: (stepKey: string) => void;
  onSaveExit?: () => void;
  /** BUG-020 — persisted checked stepKeys, so tests can vary the doneCount. */
  checked?: Iterable<string>;
  /** BUG-020 — swap the fixture (e.g. a skippable phase that HAS a step). */
  resultOverride?: PrepWeekResult;
}

function renderView(o: Overrides = {}) {
  const vm = buildPrepWeekModel(o.resultOverride ?? result(), {
    mealLabel: lookup,
    checkedStepKeys: o.checked ? new Set(o.checked) : undefined,
  });
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
        onSaveExit: o.onSaveExit ?? NOOP,
        onFinish: o.onFinish ?? NOOP,
        toastVisible: o.toastVisible ?? false,
        advanceToast: o.advanceToast ?? null,
        onExit: o.onExit ?? NOOP,
        onToggleStep: o.onToggleStep,
      }),
    );
  });
  return renderer;
}

// ── Header / subtitle / phase indicator ───────────────────────────────────────

test("header: renders 'Prep the Week', the plan name, and the meal-count subtitle", () => {
  const texts = flat(renderView().toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Prep the Week"), `missing header: ${texts}`);
  assert.ok(texts.includes("Hearty Week"), `missing plan name: ${texts}`);
  // "— 2 meals combined —".
  assert.ok(texts.includes("2 meals combined"), `missing subtitle meals: ${texts}`);
});

// 🔴 D-WS9-213 §3.1 — THE SUMMED TOTAL IS GONE FROM THE HEADER. A real plan
// read "over 2 hours" there; Hans: "I'd rather users go through thinking 'ha!
// I can do that in under 5 minutes' than 'oh no, I don't have 2 hours to prep
// today, this is too much, i quit'."
//
// The fixture's kept-only total is 16 (produce 6 + proteins-trim 10; the 8-min
// skipSuggested "Rub the steak" is excluded — BUG-011 / D-WS7-184). That value
// is still on the view-model, so this asserts it is not RENDERED in the
// subtitle rather than that the model stopped computing it.
test("D-WS9-213: the header carries NO summed total", () => {
  const view = renderView().toJSON() as RenderedNode | null;
  const texts = flat(view);
  assert.equal(
    buildPrepWeekModel(result(), { mealLabel: lookup }).totalEstimatedMinutes,
    16,
    "fixture drifted — the model no longer totals 16, so the check below is vacuous",
  );
  assert.ok(
    !texts.includes("16 min"),
    `the summed total is still on the glass: ${texts}`,
  );
  assert.ok(
    !texts.includes("combined · "),
    `the subtitle still carries a second clause: ${texts}`,
  );

  // ⚠️ POSITIVE CONTROL — ONLY THE SUM WENT. The per-step estimates and the
  // footer's per-phase "~N min left" are the "I can do that in under 5 minutes"
  // framing Hans is asking FOR; if this block ever deletes them too, these go
  // red. (Phase 3 = Produce, one kept 6-min step.)
  assert.ok(texts.includes("6 min"), `per-step estimate was removed too: ${texts}`);
  assert.ok(texts.includes("min left"), `per-phase remaining was removed: ${texts}`);
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

test("skipSuggested: a demoted step is OMITTED from render (D-WS7-184 reverses flag-don't-drop)", () => {
  const texts = flat(renderView({ phaseIndex: 3 }).toJSON() as RenderedNode | null);
  // The kept proteins step renders...
  assert.ok(texts.includes("Trim chicken"), `kept step should render: ${texts}`);
  // ...but the demoted "Rub the steak" is dropped from the list entirely (the
  // VM omits it, so the coupled server-exclude keeps isPrepped reachable).
  assert.ok(!texts.includes("Rub the steak"), `demoted step must be omitted: ${texts}`);
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

test("footer: primary 'Mark all complete' fires onAdvancePhase ONLY (the write channel)", () => {
  let advanced = 0;
  let skipped = 0;
  let saved = 0;
  const renderer = renderView({
    phaseIndex: 2,
    onAdvancePhase: () => (advanced += 1),
    onSkipPhase: () => (skipped += 1),
    onSaveExit: () => (saved += 1),
  });
  const btn = findPressableByText(renderer.toJSON() as RenderedNode | null, "Mark all complete");
  assert.ok(btn, "Mark all complete primary missing");
  act(() => (btn!.props!.onPress as () => void)());
  assert.equal(advanced, 1);
  assert.equal(skipped, 0, "primary must not travel the write-free skip channel");
  assert.equal(saved, 0, "primary must not travel the write-free save-exit channel");
});

test("footer: last phase keeps 'Mark all complete' and fires onFinish (writes + finish), not plain advance", () => {
  let finished = 0;
  let advanced = 0;
  const renderer = renderView({
    phaseIndex: 3,
    onFinish: () => (finished += 1),
    onAdvancePhase: () => (advanced += 1),
  });
  const texts = flat(renderer.toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Phase 4 of 4"));
  assert.ok(texts.includes("Mark all complete"), `last-phase primary must stay Mark all complete: ${texts}`);
  const btn = findPressableByText(renderer.toJSON() as RenderedNode | null, "Mark all complete");
  assert.ok(btn, "Mark all complete missing on the last phase");
  act(() => (btn!.props!.onPress as () => void)());
  assert.equal(finished, 1, "last-phase primary fires the finish (write) channel");
  assert.equal(advanced, 0);
});

test("toast: the Week-Prep completion copy renders when toastVisible (R2 — distinct from §7.12)", () => {
  const texts = flat(renderView({ toastVisible: true }).toJSON() as RenderedNode | null);
  assert.ok(
    texts.includes("Woohoo! You just made your week easier!"),
    `missing/incorrect Week-Prep toast copy: ${texts}`,
  );
  // Must NOT reuse the Cook-Mode "already prepped" (§7.12) string.
  assert.ok(
    !texts.includes("you-in-the-past"),
    "the Week-Prep finish toast must not reuse the §7.12 copy",
  );
});

test("toast: absent when not visible", () => {
  const texts = flat(renderView({ toastVisible: false }).toJSON() as RenderedNode | null);
  assert.ok(!texts.includes("Woohoo!"), "toast should be hidden by default");
});

test("advance toast: BUG-024 intermediate copy renders with the VM phase display names", () => {
  const texts = flat(
    renderView({
      advanceToast: { fromPhase: "Seasonings & dry", toPhase: "Sauces & marinades" },
    }).toJSON() as RenderedNode | null,
  );
  assert.ok(
    texts.includes("Done with Seasonings & dry, moving to Sauces & marinades"),
    `missing/incorrect advance toast copy: ${texts}`,
  );
});

test("advance toast: absent by default (null)", () => {
  const texts = flat(renderView().toJSON() as RenderedNode | null);
  assert.ok(!texts.includes("moving to"), "advance toast should be hidden by default");
});

test("advance toast: the terminal 'Woohoo!' toast takes precedence when both are set", () => {
  const texts = flat(
    renderView({
      toastVisible: true,
      advanceToast: { fromPhase: "Produce", toPhase: "Proteins" },
    }).toJSON() as RenderedNode | null,
  );
  assert.ok(texts.includes("Woohoo!"), "terminal toast must still render");
  assert.ok(
    !texts.includes("moving to Proteins"),
    "the intermediate toast must not double up with the terminal one",
  );
});

test("footer: the make-ahead note always renders", () => {
  const texts = flat(renderView({ phaseIndex: 0 }).toJSON() as RenderedNode | null);
  assert.ok(
    texts.includes("Kiwi skips the prep you did here"),
    `missing footer note: ${texts}`,
  );
});

// ── Empty phase ───────────────────────────────────────────────────────────────

test("empty phase: a phase with zero steps shows the all-set note", () => {
  const texts = flat(renderView({ phaseIndex: 0 }).toJSON() as RenderedNode | null);
  assert.ok(
    texts.includes("Nothing to prep ahead in this phase"),
    `missing empty-phase note: ${texts}`,
  );
});

// ── BUG-020 (Hans-ruled 3-action footer): Skip this Prep / Save & Exit ─────────

// A subtree has an interactive control iff any descendant carries an onPress.
function hasOnPress(node: RenderedNode | string | null): boolean {
  if (node == null || typeof node === "string") return false;
  if ((node.props ?? {}).onPress) return true;
  if (Array.isArray(node.children)) {
    for (const c of node.children) if (hasOnPress(c)) return true;
  }
  return false;
}

// Locate the deep-sage phase card by its background token (the RN stub returns
// raw style objects, so flattened style is inspectable).
function findByBg(
  node: RenderedNode | string | null,
  bg: string,
): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  const style = StyleSheet.flatten((node.props ?? {}).style as never) as {
    backgroundColor?: string;
  };
  if (style && style.backgroundColor === bg) return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findByBg(c, bg);
      if (hit) return hit;
    }
  }
  return null;
}

test("phase card: renders NO action button — all actions live in the footer (rule 1)", () => {
  const renderer = renderView({ phaseIndex: 2 });
  const card = findByBg(renderer.toJSON() as RenderedNode | null, Colors.sage[700]);
  assert.ok(card, "deep-sage phase card missing");
  assert.equal(
    hasOnPress(card),
    false,
    "the phase card must contain no action button — actions belong in the footer",
  );
});

test("skip: 'Skip this Prep' fires onSkipPhase ONLY — never write/finish/save channels", () => {
  let skipped = 0;
  let advanced = 0;
  let finished = 0;
  let saved = 0;
  const toggled: string[] = [];
  const renderer = renderView({
    phaseIndex: 2, // produce (a required phase — Skip now shows regardless of skippable)
    onSkipPhase: () => (skipped += 1),
    onAdvancePhase: () => (advanced += 1),
    onFinish: () => (finished += 1),
    onSaveExit: () => (saved += 1),
    onToggleStep: (k) => toggled.push(k),
  });
  const btn = findPressableByText(renderer.toJSON() as RenderedNode | null, "Skip this Prep");
  assert.ok(btn, "Skip this Prep missing on a non-last phase");
  act(() => (btn!.props!.onPress as () => void)());
  assert.equal(skipped, 1);
  assert.equal(advanced, 0, "skip must not fire the write/advance channel");
  assert.equal(finished, 0);
  assert.equal(saved, 0);
  assert.deepEqual(toggled, [], "skip must fire no per-step completion write");
});

test("skip: 'Skip this Prep' is HIDDEN on the last phase (2 footer actions, not 3)", () => {
  const texts = flat(renderView({ phaseIndex: 3 }).toJSON() as RenderedNode | null);
  assert.ok(!texts.includes("Skip this Prep"), `last phase must hide Skip this Prep: ${texts}`);
  // The two survivors on the last phase:
  assert.ok(texts.includes("Mark all complete"), `last phase must keep the primary: ${texts}`);
  assert.ok(texts.includes("Save & Exit"), `last phase must keep Save & Exit: ${texts}`);
});

test("save-exit: 'Save & Exit' fires onSaveExit ONLY — never write/advance/finish/skip channels", () => {
  let saved = 0;
  let advanced = 0;
  let finished = 0;
  let skipped = 0;
  const toggled: string[] = [];
  const renderer = renderView({
    phaseIndex: 2,
    onSaveExit: () => (saved += 1),
    onAdvancePhase: () => (advanced += 1),
    onFinish: () => (finished += 1),
    onSkipPhase: () => (skipped += 1),
    onToggleStep: (k) => toggled.push(k),
  });
  const btn = findPressableByText(renderer.toJSON() as RenderedNode | null, "Save & Exit");
  assert.ok(btn, "Save & Exit missing");
  act(() => (btn!.props!.onPress as () => void)());
  assert.equal(saved, 1);
  assert.equal(advanced, 0, "Save & Exit must never fire the write/advance channel");
  assert.equal(finished, 0);
  assert.equal(skipped, 0);
  assert.deepEqual(toggled, [], "Save & Exit must fire no per-step completion write");
});

test("save-exit: 'Save & Exit' is present on the last phase too", () => {
  let saved = 0;
  const renderer = renderView({ phaseIndex: 3, onSaveExit: () => (saved += 1) });
  const btn = findPressableByText(renderer.toJSON() as RenderedNode | null, "Save & Exit");
  assert.ok(btn, "Save & Exit must remain on the last phase");
  act(() => (btn!.props!.onPress as () => void)());
  assert.equal(saved, 1);
});

// ── BUG-020 (Option B): partialIndices derivation from the vm ─────────────────

function partialIndicesOf(renderer: TestRenderer.ReactTestRenderer): unknown {
  return renderer.root.findByType(ProgressSegments).props.partialIndices;
}

test("progress bar: partialIndices marks every phase with an unchecked step (nothing checked)", () => {
  // phases 0,1 empty → vacuously allDone; produce(2) + proteins(3) each have 1
  // unchecked step → partial.
  const renderer = renderView({ phaseIndex: 2 });
  assert.deepEqual(partialIndicesOf(renderer), [2, 3]);
});

test("progress bar: a fully-checked phase drops out of partialIndices", () => {
  const renderer = renderView({ phaseIndex: 3, checked: [`produce#${M1}`] });
  // produce(2) now fully done → not partial; proteins(3) still unchecked → partial.
  assert.deepEqual(partialIndicesOf(renderer), [3]);
});

test("progress bar: no unchecked steps anywhere → empty partialIndices", () => {
  const renderer = renderView({
    phaseIndex: 3,
    checked: [`produce#${M1}`, `proteins#${M1}`],
  });
  assert.deepEqual(partialIndicesOf(renderer), []);
});
