// WS9 Plan-flow redesign (D-WS9-191) Block 3 Part A — BUG-289 regression
// guards for "Get another plan option". Mounts a Probe around the hook, drives
// start() with fake stream / buffered impls (no network), and asserts the one
// rule that fixes the freeze: BUSY IS RELEASED WHEN THE RUN SETTLES, whether or
// not a card was delivered.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import {
  useAnotherPlanOption,
  type AnotherPlanOption,
  type AnotherRunOutcome,
  type UseAnotherPlanOptionOpts,
} from "../useAnotherPlanOption";
import type { UseBuildWizardPlansStreamingDeps } from "../useBuildWizardPlansStreaming";
import {
  appendCandidates,
  EMPTY_PLAN_OPTIONS,
  hasCandidate,
  insertAnother,
  type PlanOptionList,
} from "@/lib/wizard/planOptions";
import type { WizardPlanCandidate, WizardPreferencesInput } from "@/lib/types";

const INPUT = {} as WizardPreferencesInput;

function candidate(id: string, title: string, mealTitles: string[]): WizardPlanCandidate {
  return {
    id,
    title,
    tags: ["Easy"],
    whyBullets: ["Balanced"],
    mealTitles,
    dailyMacros: { calories: 500, proteinG: 30, carbsG: 50, fatG: 20 },
  } as WizardPlanCandidate;
}

const FIRST = candidate("plan-1", "Grill Nights", ["Burgers", "Tacos", "Kebabs"]);
// The AI re-mints the SAME id on a later single-plan call — a different plan.
const SECOND_SAME_ID = candidate("plan-1", "Cozy One-Pots", ["Chili", "Stew", "Curry"]);

type Deps = UseBuildWizardPlansStreamingDeps<WizardPreferencesInput>;

/** A screen-shaped harness: a list, a press count, and the hook wired the way plan-options.tsx wires it. */
function mount(deps: Deps, initial: PlanOptionList = EMPTY_PLAN_OPTIONS) {
  let list = initial;
  let presses = 0;
  const settled: AnotherRunOutcome[] = [];
  let captured: AnotherPlanOption<WizardPreferencesInput> | null = null;
  const opts: UseAnotherPlanOptionOpts<WizardPreferencesInput> = {
    ...deps,
    onCard: (fresh) => {
      if (hasCandidate(list, fresh)) return false;
      list = insertAnother(list, fresh, null);
      presses += 1;
      return true;
    },
    onSettled: (o) => settled.push(o),
  };
  function Probe(): null {
    captured = useAnotherPlanOption(opts);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  return {
    renderer,
    latest: () => captured!,
    list: () => list,
    presses: () => presses,
    settled,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** One card set per run (the last repeats), each delivered twice — the catch-up re-delivery a real stream does before `done`. */
function streamOf(...perRun: WizardPlanCandidate[][]): Deps["streamImpl"] {
  let run = 0;
  return async (_input, onCandidate) => {
    const cards = perRun[Math.min(run, perRun.length - 1)];
    run += 1;
    cards.forEach((c, i) => onCandidate(i, c));
    cards.forEach((c, i) => onCandidate(i, c));
    return {
      cannotGenerateMore: cards.length === 0,
      reason: cards.length === 0 ? "exhausted" : undefined,
    };
  };
}
const noBuffered: Deps["bufferedImpl"] = async () => {
  throw new Error("buffered should not be called");
};

async function press(h: ReturnType<typeof mount>) {
  await act(async () => {
    h.latest().start(INPUT);
    await flush();
  });
}

test("a delivered card: inserted once (catch-up re-delivery deduped), one press, busy released", async () => {
  const h = mount({ streamImpl: streamOf([FIRST]), bufferedImpl: noBuffered });
  assert.equal(h.latest().busy, false);
  await press(h);
  assert.equal(h.latest().busy, false);
  assert.equal(h.list().length, 1);
  assert.equal(h.presses(), 1);
  assert.deepEqual(
    h.settled.map((o) => [o.delivered, o.error]),
    [[true, null]],
  );
});

test("BUG-289: the SECOND press, whose candidate re-uses the first's id, is delivered AND busy is released", async () => {
  const h = mount({ streamImpl: streamOf([FIRST], [SECOND_SAME_ID]), bufferedImpl: noBuffered });
  await press(h);
  await press(h);
  assert.equal(h.latest().busy, false, "the freeze: busy never cleared on the second press");
  assert.deepEqual(
    h.list().map((c) => c.candidate.title),
    [FIRST.title, SECOND_SAME_ID.title],
  );
  assert.equal(h.presses(), 2);
  assert.equal(h.settled.length, 2);
  assert.ok(h.settled.every((o) => o.delivered && o.error === null));
});

test("BUG-289 regression guard: a run that yields a DUPLICATE (already on the list) still clears busy; not a press", async () => {
  const seeded = appendCandidates(EMPTY_PLAN_OPTIONS, [FIRST]);
  const reminted = candidate("some-other-id", FIRST.title, [...FIRST.mealTitles].reverse());
  const h = mount({ streamImpl: streamOf([reminted]), bufferedImpl: noBuffered }, seeded);
  await press(h);
  assert.equal(h.latest().busy, false, "busy must be released by the settle, not the insert");
  assert.equal(h.list().length, 1);
  assert.equal(h.presses(), 0);
  assert.deepEqual(
    h.settled.map((o) => o.delivered),
    [false],
  );
});

test("BUG-289 regression guard: a run that yields NO card (cannotGenerateMore) clears busy with the reason; not a press", async () => {
  const h = mount({ streamImpl: streamOf([]), bufferedImpl: noBuffered });
  await press(h);
  assert.equal(h.latest().busy, false);
  assert.equal(h.presses(), 0);
  assert.deepEqual(
    h.settled.map((o) => [o.delivered, o.reason]),
    [[false, "exhausted"]],
  );
});

test("a failed run (stream + buffered both throw) clears busy and reports the error", async () => {
  const streamImpl: Deps["streamImpl"] = async () => {
    throw new Error("stream died");
  };
  const bufferedImpl: Deps["bufferedImpl"] = async () => {
    throw new Error("buffered died");
  };
  const h = mount({ streamImpl, bufferedImpl });
  await press(h);
  assert.equal(h.latest().busy, false);
  assert.equal(h.presses(), 0);
  assert.equal(h.settled.length, 1);
  assert.equal(h.settled[0].delivered, false);
  assert.equal(h.settled[0].error?.message, "buffered died");
});

test("busy holds while the run is in flight; hasCard flips at the first card, before done", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const streamImpl: Deps["streamImpl"] = async (_input, onCandidate) => {
    onCandidate(0, FIRST);
    await gate;
    return {};
  };
  const h = mount({ streamImpl, bufferedImpl: noBuffered });
  await act(async () => {
    h.latest().start(INPUT);
    await flush();
  });
  assert.equal(h.latest().busy, true);
  assert.equal(h.latest().hasCard, true);
  assert.equal(h.list().length, 1, "the card renders before done (progressive)");
  assert.equal(h.settled.length, 0);
  await act(async () => {
    release();
    await flush();
  });
  assert.equal(h.latest().busy, false);
  assert.equal(h.settled.length, 1);
});

test("the dedupe set is per run: a second run re-delivering the first's plan reaches onCard (the LIST refuses it) and busy still clears", async () => {
  const h = mount({ streamImpl: streamOf([FIRST]), bufferedImpl: noBuffered });
  await press(h);
  assert.equal(h.presses(), 1);
  await press(h);
  assert.equal(h.latest().busy, false);
  assert.equal(h.presses(), 1);
  assert.deepEqual(
    h.settled.map((o) => o.delivered),
    [true, false],
  );
});
