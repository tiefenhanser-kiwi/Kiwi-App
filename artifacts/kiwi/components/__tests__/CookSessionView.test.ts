// WS7-8b Block 3 — Cook Mode screen render/interaction tests.

import assert from "node:assert/strict";
import { mock, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { CookSessionView } from "../CookSessionView";
import type { CookStep } from "@/lib/cooking/cookSession";

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

// ── Sept 29 design review — Cook Mode's emoji became Feather icons (D-WS9-162),
// so five assertions in this file that probed for "🟢" / "✓ done" as TEXT had to
// change. They are not weakened: a glyph in a <Text> was only ever a proxy for
// "the icon is there", and these read the icon directly.
//
// The @expo/vector-icons stub renders <icon-feather name="…">, so the NAME is
// exactly what a test should assert — it survives a tint, a size or a layout
// change and fails on the one thing that matters, the wrong glyph.
function featherNames(node: RenderedNode | string | null, out: string[] = []): string[] {
  if (node == null || typeof node === "string") return out;
  if (node.type === "icon-feather") {
    const n = (node.props as { name?: unknown } | undefined)?.name;
    if (typeof n === "string") out.push(n);
  }
  if (Array.isArray(node.children)) for (const c of node.children) featherNames(c, out);
  return out;
}

// The active-timer strip exists iff its own controls do. Keyed on the control's
// exact accessibilityLabel rather than on any glyph, so this probe is immune to
// the next icon pass as well. (The chip's labels are "Dismiss timer" /
// "Add a minute"; the strip's are the same, suffixed " (strip)".)
function hasTimerStrip(node: RenderedNode | null): boolean {
  return findByA11yLabel(node, "Dismiss timer (strip)") !== null;
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

// Post-order: returns the DEEPEST pressable whose subtree contains the text —
// needed to target the timer chip, which is nested inside the step-card
// Pressable (a pre-order search would return the outer card instead).
function findInnermostPressableByText(
  node: RenderedNode | string | null,
  text: string,
): RenderedNode | null {
  if (node == null || typeof node === "string") return null;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findInnermostPressableByText(c, text);
      if (hit) return hit;
    }
  }
  const props = (node.props ?? {}) as { onPress?: unknown };
  if (props.onPress && gatherText(node).join(" ").includes(text)) return node;
  return null;
}

// Exact-match on accessibilityLabel — used to disambiguate the per-step chip
// controls from the top-strip controls (#2), which share the same dismiss icon
// (a Feather `x` since the Sept 29 design review; previously a "✕" glyph). The
// chip labels are "Dismiss timer"/"Add a minute"; the strip labels are the same
// suffixed with " (strip)", so an EXACT match targets one surface unambiguously.
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

const STEPS: CookStep[] = [
  { key: "0", text: "Sear the chicken", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: false },
  { key: "1", text: "Add 2 cups diced tomatoes", phaseType: "cook", estimatedMinutes: 5, isTimingSensitive: false },
  { key: "2", text: "Rest 5 minutes", phaseType: "rest", estimatedMinutes: 5, isTimingSensitive: false },
];

const NOOP = () => {};

interface Overrides {
  steps?: CookStep[];
  doneInPrepKeys?: ReadonlySet<string>;
  currentIndex?: number;
  prepped?: boolean;
  showSkipBar?: boolean;
  recapHeading?: string;
  recapItems?: string[];
  remainingMins?: number;
  gatePromptVisible?: boolean;
  toastVisible?: boolean;
  onAdvance?: () => void;
  onPrevStep?: () => void;
  onSelectStep?: (i: number) => void;
  onSkipToCooking?: () => void;
  onPrepAnswer?: (p: boolean) => void;
  onExit?: () => void;
  amountMultiplier?: number;
}

function renderView(o: Overrides = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(CookSessionView, {
        title: "Test Meal",
        steps: o.steps ?? STEPS,
        doneInPrepKeys: o.doneInPrepKeys,
        amountMultiplier: o.amountMultiplier ?? 1,
        currentIndex: o.currentIndex ?? 0,
        prepped: o.prepped ?? false,
        showSkipBar: o.showSkipBar ?? false,
        recapHeading: o.recapHeading,
        recapItems: o.recapItems ?? [],
        remainingMins: o.remainingMins ?? 18,
        onAdvance: o.onAdvance ?? NOOP,
        onPrevStep: o.onPrevStep ?? NOOP,
        onSelectStep: (o.onSelectStep as (i: number) => void) ?? NOOP,
        onSkipToCooking: o.onSkipToCooking ?? NOOP,
        gatePromptVisible: o.gatePromptVisible ?? false,
        onPrepAnswer: (o.onPrepAnswer as (p: boolean) => void) ?? NOOP,
        toastVisible: o.toastVisible ?? false,
        onExit: o.onExit ?? NOOP,
      }),
    );
  });
  return renderer;
}

// ── Gate ────────────────────────────────────────────────────────────────────

test("gate prompt: renders the one-tap question and fires onPrepAnswer", () => {
  const answers: boolean[] = [];
  const renderer = renderView({
    gatePromptVisible: true,
    onPrepAnswer: (p: boolean) => answers.push(p),
  });
  const texts = flat(renderer.toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Did you prep this already?"), `missing gate: ${texts}`);
  // The step engine is NOT shown while the gate blocks.
  assert.ok(!texts.includes("step 1 of"), "steps should be hidden behind the gate");

  const yes = findPressableByText(renderer.toJSON() as RenderedNode | null, "Yes, I prepped");
  assert.ok(yes, "Yes button missing");
  act(() => (yes!.props!.onPress as () => void)());
  assert.deepEqual(answers, [true]);
  renderer.unmount();
});

// ── WS7-8b BUG-006 — amountRefs render through amountMultiplier ───────────────

const REF_STEPS: CookStep[] = [
  {
    key: "0",
    text: "Add 2 cups diced tomatoes",
    phaseType: "cook",
    estimatedMinutes: 5,
   
    isTimingSensitive: false,
    // ref covers the "2 cups" span [4,10]
    amountRefs: [
      { ingredientId: "tom", quantity: 2, unit: "cups", charStart: 4, charEnd: 10 },
    ],
  },
];

test("BUG-006: a ref-bearing step scales by amountMultiplier (×1.5 → 3 cups, not 2)", () => {
  const texts = flat(
    renderView({ steps: REF_STEPS, amountMultiplier: 1.5 }).toJSON() as RenderedNode | null,
  );
  assert.ok(texts.includes("3 cups"), `expected scaled amount: ${texts}`);
  assert.ok(!texts.includes("2 cups"), `stale base amount leaked: ${texts}`);
});

test("BUG-006: multiplier 1 (no override / dishId path) renders the base amount", () => {
  const texts = flat(
    renderView({ steps: REF_STEPS, amountMultiplier: 1 }).toJSON() as RenderedNode | null,
  );
  assert.ok(texts.includes("2 cups"), `expected base amount: ${texts}`);
});

// ── Session render + engine ──────────────────────────────────────────────────

test("session: renders title, step N of M, the anchor step, and the footer advance", () => {
  const texts = flat(renderView({ currentIndex: 0 }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("step 1 of 3"), `missing section label: ${texts}`);
  assert.ok(texts.includes("Sear the chicken"), `missing anchor step: ${texts}`);
  assert.ok(texts.includes("Done — next step"), `missing advance CTA: ${texts}`);
  // "Next · {label}" preview (capitalized phase of step 2 = "Cook").
  assert.ok(texts.includes("Next · Cook"), `missing next preview: ${texts}`);
});

test("session: a step above the anchor shows the done marker", () => {
  const tree = renderView({ currentIndex: 1 }).toJSON() as RenderedNode | null;
  const texts = flat(tree);
  // WAS assert.ok(texts.includes("✓ done")). The ✓ is a Feather `check` now, so
  // the marker is two things and both are asserted — the word on its own would
  // pass against a step card that lost its tick.
  assert.ok(texts.includes("done"), `missing done marker: ${texts}`);
  assert.ok(
    featherNames(tree).includes("check"),
    "the done marker's Feather check icon is missing",
  );
  assert.ok(texts.includes("step 2 of 3"));
});

test("session: footer 'Done — next step' fires onAdvance", () => {
  let advanced = 0;
  const renderer = renderView({ onAdvance: () => (advanced += 1) });
  const btn = findPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Done — next step",
  );
  assert.ok(btn, "advance button missing");
  act(() => (btn!.props!.onPress as () => void)());
  assert.equal(advanced, 1);
  renderer.unmount();
});

test("session: advance CTA is hidden on the last step (no completion screen this block)", () => {
  const texts = flat(
    renderView({ currentIndex: 2 }).toJSON() as RenderedNode | null,
  );
  assert.ok(texts.includes("step 3 of 3"));
  assert.ok(!texts.includes("Done — next step"), "advance should hide on last step");
});

// ── Quantity highlight (full text never stripped) ────────────────────────────

test("session: step text with a quantity renders in full (8a — qualifier never stripped)", () => {
  const texts = flat(
    renderView({ currentIndex: 1 }).toJSON() as RenderedNode | null,
  );
  // The anchor is "Add 2 cups diced tomatoes" — highlighter splits it into
  // segments but the full string must still render intact.
  assert.ok(
    texts.includes("Add 2 cups diced tomatoes"),
    `step text not intact: ${texts}`,
  );
});

// ── Recap (prepped path) ─────────────────────────────────────────────────────

test("recap: prepped path renders the prep steps under the day heading, above the steps", () => {
  const texts = flat(
    renderView({
      prepped: true,
      showSkipBar: true,
      recapHeading: "Prepped on Sunday",
      recapItems: ["Onions", "Garlic"],
    }).toJSON() as RenderedNode | null,
  );
  assert.ok(texts.includes("Prepped on Sunday"), `missing recap heading: ${texts}`);
  assert.ok(texts.includes("Onions") && texts.includes("Garlic"), `missing recap item: ${texts}`);
  assert.ok(texts.includes("Skip to cooking"), `missing skip CTA: ${texts}`);
  // K-R7 — the old cook-step framing is gone.
  assert.ok(!texts.includes("get your:"), `old recap heading still renders: ${texts}`);
});

test("recap: the heading falls back to 'Already prepped' when no day is known", () => {
  const texts = flat(
    renderView({ prepped: true, recapItems: ["Onions"] }).toJSON() as RenderedNode | null,
  );
  assert.ok(texts.includes("Already prepped"), `missing fallback heading: ${texts}`);
});

test("recap: not shown on the not-prepped path", () => {
  const texts = flat(
    renderView({ prepped: false }).toJSON() as RenderedNode | null,
  );
  assert.ok(!texts.includes("Already prepped"), "recap should be absent");
  assert.ok(!texts.includes("Prepped on"), "recap should be absent");
});

// ── K-R7 — done in prep: collapsed, one tap from its full text, never dropped ──

const PREP_FLOW: CookStep[] = [
  { key: "dA#0", text: "Dice 1 onion", phaseType: "prep", estimatedMinutes: 4, isTimingSensitive: false, dishId: "dA", stepIndex: 4 },
  { key: "dA#1", text: "Mince 3 cloves garlic", phaseType: "prep", estimatedMinutes: 3, isTimingSensitive: false, dishId: "dA", stepIndex: 6 },
  { key: "dA#2", text: "Chop the cilantro", phaseType: "prep", estimatedMinutes: 2, isTimingSensitive: false, dishId: "dA", stepIndex: 7 },
  { key: "dA#3", text: "Sear the chicken", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: false, dishId: "dA", stepIndex: 9 },
];
const DONE_IN_PREP = new Set(["dA#0", "dA#1"]);

/** numberOfLines on the Text whose own content is exactly `text` (null: none). */
function linesOf(node: RenderedNode | string | null, text: string): number | null | undefined {
  if (node == null || typeof node === "string") return undefined;
  if (node.type === "rn-text" && gatherText(node).join("") === text) {
    const n = (node.props as { numberOfLines?: unknown } | undefined)?.numberOfLines;
    return typeof n === "number" ? n : null;
  }
  for (const c of node.children ?? []) {
    const hit = linesOf(c, text);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function stepRows(node: RenderedNode | string | null, out: string[] = []): string[] {
  if (node == null || typeof node === "string") return out;
  const id = (node.props as { testID?: unknown } | undefined)?.testID;
  if (typeof id === "string" && id.startsWith("step-")) out.push(id);
  for (const c of node.children ?? []) stepRows(c, out);
  return out;
}

test("K-R7: no cook step is dropped — done-in-prep rows stay in the flow and the count", () => {
  const tree = renderView({
    steps: PREP_FLOW,
    doneInPrepKeys: DONE_IN_PREP,
    currentIndex: 2,
  }).toJSON() as RenderedNode | null;
  assert.deepEqual(stepRows(tree), ["step-0", "step-1", "step-2", "step-3"]);
  assert.ok(flat(tree).includes("step 3 of 4"), `count changed: ${flat(tree)}`);
});

test("K-R7: a done-in-prep step is collapsed; a tap opens its full text and a second closes it", () => {
  const selected: number[] = [];
  const renderer = renderView({
    steps: PREP_FLOW,
    doneInPrepKeys: DONE_IN_PREP,
    currentIndex: 2,
    onSelectStep: (i: number) => selected.push(i),
  });
  const row = () => findByA11yLabel(renderer.toJSON() as RenderedNode | null, "Done in prep. Show this step");
  const texts = flat(renderer.toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Done in prep"), `missing done-in-prep marker: ${texts}`);
  // Collapsed: a one-line preview, and the uncollapsed steps render as before.
  assert.ok(row(), "the collapsed row has no open control");
  assert.equal(linesOf(renderer.toJSON() as RenderedNode | null, "Dice 1 onion"), 1);
  assert.equal(linesOf(renderer.toJSON() as RenderedNode | null, "Chop the cilantro"), null);

  act(() => (row()!.props!.onPress as () => void)());
  const opened = findByA11yLabel(
    renderer.toJSON() as RenderedNode | null,
    "Done in prep. Hide this step",
  );
  assert.ok(opened, "the row did not open");
  // Opened: the full step text, unclamped.
  assert.equal(linesOf(renderer.toJSON() as RenderedNode | null, "Dice 1 onion"), null);
  assert.deepEqual(
    (opened!.props as { accessibilityState?: unknown }).accessibilityState,
    { expanded: true },
  );
  // Opening READS the step; it does not move the anchor.
  assert.deepEqual(selected, []);

  act(() => (opened!.props!.onPress as () => void)());
  assert.equal(
    findByA11yLabel(renderer.toJSON() as RenderedNode | null, "Done in prep. Show this step") !== null,
    true,
    "the row did not close again",
  );
  renderer.unmount();
});

test("K-R7: the footer's next skips done-in-prep steps, and the last LIVE step is last", () => {
  // Anchor on the cilantro (2); next is the chicken (3), a Cook step.
  const texts = flat(
    renderView({ steps: PREP_FLOW, doneInPrepKeys: DONE_IN_PREP, currentIndex: 2 }).toJSON() as RenderedNode | null,
  );
  assert.ok(texts.includes("Next · Cook"), `next preview wrong: ${texts}`);

  // A done-in-prep step AFTER the last live one does not keep "next" alive.
  const trailing: CookStep[] = [PREP_FLOW[3], PREP_FLOW[0]];
  const last = flat(
    renderView({ steps: trailing, doneInPrepKeys: DONE_IN_PREP, currentIndex: 0 }).toJSON() as RenderedNode | null,
  );
  assert.ok(!last.includes("Done — next step"), `advance shown on the last live step: ${last}`);
  assert.ok(!last.includes("Next ·"), `next preview points at a done-in-prep step: ${last}`);
});

// ── Toast (verbatim) ─────────────────────────────────────────────────────────

test("toast: renders the locked verbatim copy when visible", () => {
  const texts = flat(
    renderView({ toastVisible: true }).toJSON() as RenderedNode | null,
  );
  assert.ok(
    texts.includes("Way to go! Nice work, you-in-the-past!"),
    `toast copy wrong/missing: ${texts}`,
  );
});

test("toast: absent when not visible", () => {
  const texts = flat(
    renderView({ toastVisible: false }).toJSON() as RenderedNode | null,
  );
  assert.ok(!texts.includes("Way to go!"), "toast should be hidden");
});

// ── Timer chip ───────────────────────────────────────────────────────────────

test("timer chip: time-bearing steps show 'Start M:00 timer'; a 0-min step shows none", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Boil 8 minutes", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: false },
    { key: "b", text: "Plate it", phaseType: "assemble", estimatedMinutes: 0, isTimingSensitive: false },
  ];
  const texts = flat(renderView({ steps }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Start 8:00 timer"), `missing chip: ${texts}`);
  // exactly one chip — the 0-min step gets none (clean absence)
  assert.equal(texts.split("Start").length - 1, 1, "0-min step must not render a chip");
});

test("timer chip: tapping start begins a visible countdown and the active-timer strip appears", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Boil pasta", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: false },
  ];
  const renderer = renderView({ steps });
  const startBtn = findInnermostPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Start 8:00 timer",
  );
  assert.ok(startBtn, "start chip missing");
  act(() => (startBtn!.props!.onPress as () => void)());

  const texts = flat(renderer.toJSON() as RenderedNode | null);
  // Fresh timer reads 8:00 (rounds up). Both the chip and the top strip show it.
  assert.ok(texts.includes("8:00"), `countdown not shown: ${texts}`);
  // The active-timer strip labels it from the step text ("Boil pasta" → "Boil pasta").
  // WAS assert.ok(texts.includes("🟢")) — the running pill's 🟢 is a Feather
  // `clock` now. The strip's PRESENCE is probed through its own control, and the
  // glyph is asserted separately so neither hides the other's failure.
  assert.ok(
    hasTimerStrip(renderer.toJSON() as RenderedNode | null),
    `active-timer strip missing: ${texts}`,
  );
  assert.ok(
    featherNames(renderer.toJSON() as RenderedNode | null).includes("clock"),
    "the running pill should carry the Feather clock",
  );
  assert.ok(!texts.includes("Start 8:00 timer"), "idle label should be replaced by the countdown");
  // Flush the passive-effect cleanup (clearInterval) synchronously, so the live
  // 1s interval is gone before any later test enables mock.timers — otherwise a
  // pending real interval would be "cleared" by the mocked clearInterval (a
  // no-op on real timers) and leak, hanging the process on exit.
  act(() => renderer.unmount());
});

// ── Sequencer parallel cue (2B) ──────────────────────────────────────────────

test("cue: a step carrying a cue renders the annotation line verbatim", () => {
  const steps: CookStep[] = [
    {
      key: "a",
      text: "Start the sauce",
      phaseType: "cook",
      estimatedMinutes: 5,
     
      isTimingSensitive: false,
      cue: "While the chicken rests, start the sauce",
    },
  ];
  const texts = flat(renderView({ steps }).toJSON() as RenderedNode | null);
  assert.ok(
    texts.includes("While the chicken rests, start the sauce"),
    `cue annotation not rendered verbatim: ${texts}`,
  );
});

test("cue: no annotation line when cue is undefined", () => {
  // STEPS carry no cue; assert no stray annotation leaks in (clean absence,
  // structurally identical to the dishTag conditional at CookSessionView.tsx:363).
  const texts = flat(renderView({ steps: STEPS }).toJSON() as RenderedNode | null);
  assert.ok(
    !texts.includes("While the chicken rests"),
    "cue line should be absent when cue is undefined",
  );
});

// ── Timer #4: Add-a-minute + dismiss ─────────────────────────────────────────

test("timer #4: 'Add a minute' on a RUNNING timer pushes the end out by a minute", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Boil pasta", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: false },
  ];
  const renderer = renderView({ steps });
  act(() =>
    (findInnermostPressableByText(renderer.toJSON() as RenderedNode | null, "Start 8:00 timer")!
      .props!.onPress as () => void)(),
  );
  assert.ok(flat(renderer.toJSON() as RenderedNode | null).includes("8:00"), "running timer should read 8:00");

  const add = findInnermostPressableByText(renderer.toJSON() as RenderedNode | null, "Add a minute");
  assert.ok(add, "'Add a minute' control missing on the running chip");
  act(() => (add!.props!.onPress as () => void)());

  const texts = flat(renderer.toJSON() as RenderedNode | null);
  // endsAt pushed out by 60s (8:00 → 9:00), rounded up by formatClock.
  assert.ok(texts.includes("9:00"), `running extend should read 9:00: ${texts}`);
  act(() => renderer.unmount()); // flush clearInterval before the mock-timers test
});

test("timer #4: 'Add a minute' on a DONE timer re-arms a fresh 1:00 from now", () => {
  // Mock the clock so we can drive a 1-minute timer to completion deterministically.
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const steps: CookStep[] = [
      { key: "a", text: "Boil egg", phaseType: "cook", estimatedMinutes: 1, isTimingSensitive: false },
    ];
    const renderer = renderView({ steps });
    act(() =>
      (findInnermostPressableByText(renderer.toJSON() as RenderedNode | null, "Start 1:00 timer")!
        .props!.onPress as () => void)(),
    );
    // Advance past the 60s end — the 1s interval bumps nowMs past endsAt.
    act(() => {
      mock.timers.tick(61_000);
    });
    assert.ok(
      flat(renderer.toJSON() as RenderedNode | null).includes("Timer done"),
      "timer should read done after the clock passes its end",
    );

    const add = findInnermostPressableByText(renderer.toJSON() as RenderedNode | null, "Add a minute");
    assert.ok(add, "'Add a minute' control missing on the done chip");
    act(() => (add!.props!.onPress as () => void)());

    const texts = flat(renderer.toJSON() as RenderedNode | null);
    // Re-armed to now + 60s → a fresh 1:00, no longer done.
    assert.ok(texts.includes("1:00"), `done extend should re-arm to 1:00: ${texts}`);
    assert.ok(!texts.includes("Timer done"), `done extend should clear the done state: ${texts}`);
    // Unmount (flushing clearInterval) while mock.timers is still enabled, then
    // reset — so the component's interval is torn down under the mocked timers.
    act(() => renderer.unmount());
  } finally {
    mock.timers.reset();
  }
});

test("timer #4: the chip '✕' dismiss control clears the timer (persists until then — no auto-dismiss)", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Boil pasta", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: false },
  ];
  const renderer = renderView({ steps });
  act(() =>
    (findInnermostPressableByText(renderer.toJSON() as RenderedNode | null, "Start 8:00 timer")!
      .props!.onPress as () => void)(),
  );
  assert.ok(hasTimerStrip(renderer.toJSON() as RenderedNode | null), "active-timer strip should appear");

  // Once a timer runs, BOTH the chip and the strip render a dismiss icon (#2);
  // target the CHIP's by its exact accessibilityLabel so this stays unambiguous.
  const dismiss = findByA11yLabel(renderer.toJSON() as RenderedNode | null, "Dismiss timer");
  assert.ok(dismiss, "chip dismiss control missing");
  act(() => (dismiss!.props!.onPress as () => void)());

  const texts = flat(renderer.toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Start 8:00 timer"), `dismiss should return to the idle chip: ${texts}`);
  assert.ok(
    !hasTimerStrip(renderer.toJSON() as RenderedNode | null),
    "active-timer strip should be gone after dismiss",
  );
  act(() => renderer.unmount());
});

// ── Timer #2: strip controls (mirror the chip's +1 / ✕ on the top strip) ──────

test("strip #2: the top-strip '✕' dismisses the timer without scrolling to the step", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Boil pasta", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: false },
  ];
  const renderer = renderView({ steps });
  act(() =>
    (findInnermostPressableByText(renderer.toJSON() as RenderedNode | null, "Start 8:00 timer")!
      .props!.onPress as () => void)(),
  );
  assert.ok(hasTimerStrip(renderer.toJSON() as RenderedNode | null), "active-timer strip should appear");

  const stripDismiss = findByA11yLabel(
    renderer.toJSON() as RenderedNode | null,
    "Dismiss timer (strip)",
  );
  assert.ok(stripDismiss, "strip dismiss control missing");
  act(() => (stripDismiss!.props!.onPress as () => void)());

  const texts = flat(renderer.toJSON() as RenderedNode | null);
  assert.ok(
    !hasTimerStrip(renderer.toJSON() as RenderedNode | null),
    "strip should be gone after a strip-dismiss",
  );
  assert.ok(texts.includes("Start 8:00 timer"), `the step chip should return to idle: ${texts}`);
  act(() => renderer.unmount());
});

test("strip #2: the top-strip '+1 min' extends a running timer (8:00 → 9:00)", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Boil pasta", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: false },
  ];
  const renderer = renderView({ steps });
  act(() =>
    (findInnermostPressableByText(renderer.toJSON() as RenderedNode | null, "Start 8:00 timer")!
      .props!.onPress as () => void)(),
  );
  assert.ok(flat(renderer.toJSON() as RenderedNode | null).includes("8:00"), "running timer should read 8:00");

  const stripAdd = findByA11yLabel(
    renderer.toJSON() as RenderedNode | null,
    "Add a minute (strip)",
  );
  assert.ok(stripAdd, "strip '+1 min' control missing");
  act(() => (stripAdd!.props!.onPress as () => void)());

  // endsAt pushed out by 60s — both the strip pill and the chip now read 9:00.
  assert.ok(
    flat(renderer.toJSON() as RenderedNode | null).includes("9:00"),
    "strip extend should push the running timer to 9:00",
  );
  act(() => renderer.unmount());
});

test("timer chip: timing-sensitive step renders the chip with the warm alert treatment", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Pull at 9 minutes", phaseType: "cook", estimatedMinutes: 9, isTimingSensitive: true },
  ];
  const renderer = renderView({ steps });
  const chip = findInnermostPressableByText(
    renderer.toJSON() as RenderedNode | null,
    "Start 9:00 timer",
  );
  assert.ok(chip, "timing-sensitive chip missing");
  // Pressable style is a ({pressed}) => [...] function; the rn stub doesn't
  // invoke it, so call it here to resolve the style array, then assert the
  // cookMode.alert background token (rgba(194,79,37,…)) is applied.
  const styleFn = chip!.props!.style as (a: { pressed: boolean }) => unknown;
  const styleStr = JSON.stringify(styleFn({ pressed: false }));
  assert.ok(
    styleStr.includes("194, 79, 37"),
    `expected alert tone on timing-sensitive chip: ${styleStr}`,
  );
  renderer.unmount();
});
