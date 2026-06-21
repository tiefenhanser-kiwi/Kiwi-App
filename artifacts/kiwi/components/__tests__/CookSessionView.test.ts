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

const STEPS: CookStep[] = [
  { key: "0", text: "Sear the chicken", phaseType: "cook", estimatedMinutes: 8, isPrep: false, isTimingSensitive: false },
  { key: "1", text: "Add 2 cups diced tomatoes", phaseType: "cook", estimatedMinutes: 5, isPrep: false, isTimingSensitive: false },
  { key: "2", text: "Rest 5 minutes", phaseType: "rest", estimatedMinutes: 5, isPrep: false, isTimingSensitive: false },
];

const NOOP = () => {};

interface Overrides {
  steps?: CookStep[];
  currentIndex?: number;
  prepped?: boolean;
  showSkipBar?: boolean;
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
}

function renderView(o: Overrides = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(CookSessionView, {
        title: "Test Meal",
        steps: o.steps ?? STEPS,
        currentIndex: o.currentIndex ?? 0,
        prepped: o.prepped ?? false,
        showSkipBar: o.showSkipBar ?? false,
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
  const texts = flat(renderView({ currentIndex: 1 }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("✓ done"), `missing done marker: ${texts}`);
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

test("recap: prepped path renders the mise-en-place list above the steps", () => {
  const texts = flat(
    renderView({
      prepped: true,
      showSkipBar: true,
      recapItems: ["Mince 3 cloves garlic", "Dice 1 onion"],
    }).toJSON() as RenderedNode | null,
  );
  assert.ok(texts.includes("You already prepped this — get your:"), `missing recap: ${texts}`);
  assert.ok(texts.includes("Mince 3 cloves garlic"), `missing recap item: ${texts}`);
  assert.ok(texts.includes("Skip to cooking"), `missing skip CTA: ${texts}`);
});

test("recap: not shown on the not-prepped path", () => {
  const texts = flat(
    renderView({ prepped: false }).toJSON() as RenderedNode | null,
  );
  assert.ok(!texts.includes("You already prepped this"), "recap should be absent");
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
    { key: "a", text: "Boil 8 minutes", phaseType: "cook", estimatedMinutes: 8, isPrep: false, isTimingSensitive: false },
    { key: "b", text: "Plate it", phaseType: "assemble", estimatedMinutes: 0, isPrep: false, isTimingSensitive: false },
  ];
  const texts = flat(renderView({ steps }).toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Start 8:00 timer"), `missing chip: ${texts}`);
  // exactly one chip — the 0-min step gets none (clean absence)
  assert.equal(texts.split("Start").length - 1, 1, "0-min step must not render a chip");
});

test("timer chip: tapping start begins a visible countdown and the active-timer strip appears", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Boil pasta", phaseType: "cook", estimatedMinutes: 8, isPrep: false, isTimingSensitive: false },
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
  assert.ok(texts.includes("🟢"), `active-timer strip missing: ${texts}`);
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
      isPrep: false,
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
    { key: "a", text: "Boil pasta", phaseType: "cook", estimatedMinutes: 8, isPrep: false, isTimingSensitive: false },
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
      { key: "a", text: "Boil egg", phaseType: "cook", estimatedMinutes: 1, isPrep: false, isTimingSensitive: false },
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

test("timer #4: the '✕' dismiss control clears the timer (persists until then — no auto-dismiss)", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Boil pasta", phaseType: "cook", estimatedMinutes: 8, isPrep: false, isTimingSensitive: false },
  ];
  const renderer = renderView({ steps });
  act(() =>
    (findInnermostPressableByText(renderer.toJSON() as RenderedNode | null, "Start 8:00 timer")!
      .props!.onPress as () => void)(),
  );
  assert.ok(flat(renderer.toJSON() as RenderedNode | null).includes("🟢"), "active-timer strip should appear");

  const dismiss = findInnermostPressableByText(renderer.toJSON() as RenderedNode | null, "✕");
  assert.ok(dismiss, "'✕' dismiss control missing");
  act(() => (dismiss!.props!.onPress as () => void)());

  const texts = flat(renderer.toJSON() as RenderedNode | null);
  assert.ok(texts.includes("Start 8:00 timer"), `dismiss should return to the idle chip: ${texts}`);
  assert.ok(!texts.includes("🟢"), "active-timer strip should be gone after dismiss");
  act(() => renderer.unmount());
});

test("timer chip: timing-sensitive step renders the chip with the warm alert treatment", () => {
  const steps: CookStep[] = [
    { key: "a", text: "Pull at 9 minutes", phaseType: "cook", estimatedMinutes: 9, isPrep: false, isTimingSensitive: true },
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
