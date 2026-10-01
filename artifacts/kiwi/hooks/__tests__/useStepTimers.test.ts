// D-WS9-289 — the hook half. lib/cooking/__tests__/timerNotifications.test.ts
// pins the POLICY; this pins that useStepTimers calls it on the right three
// transitions, and — the one that matters most — that it does NOT call it on a
// fourth.
//
// A recording TimerNotifier is injected, so neither expo-notifications nor the
// live wiring is in this file's module graph.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { useStepTimers, type StepTimers } from "../useStepTimers";
import type { TimerNotifier } from "@/lib/cooking/timerNotifications";

type Call =
  | { kind: "schedule"; key: string; label: string; endsAtMs: number }
  | { kind: "cancel"; key: string };

function fakeNotifier() {
  const calls: Call[] = [];
  const pending = new Set<string>();
  const notifier: TimerNotifier = {
    async schedule(key, label, endsAtMs) {
      calls.push({ kind: "schedule", key, label, endsAtMs });
      pending.add(key);
    },
    async cancel(key) {
      calls.push({ kind: "cancel", key });
      pending.delete(key);
    },
    permissionState: () => "granted",
    pendingKeys: () => [...pending],
  };
  return { calls, notifier, pending };
}

/**
 * Mounts the hook and hands back its live API plus the unmount handle.
 *
 * ⚠️ TAKES THE TEST CONTEXT AND ALWAYS UNMOUNTS. The tick effect opens a 1s
 * setInterval as soon as a timer exists, and an un-unmounted probe leaks it --
 * node:test then never exits. That is not a hypothetical: the first run of this
 * file hung for five minutes.
 *
 * Unmounting in EVERY test is safe here and is not a hole in the unmount rule
 * below: an unmount that cancelled would show up in `calls` in these tests too,
 * so the teardown reinforces the assertion rather than hiding from it.
 */
function mount(t: { after: (fn: () => void) => void }, notifier: TimerNotifier) {
  const box: { api: StepTimers | null } = { api: null };
  function Probe() {
    box.api = useStepTimers({ notifier });
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(Probe));
  });
  let unmounted = false;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    act(() => tree.unmount());
  };
  t.after(unmount);
  return {
    get api() {
      if (!box.api) throw new Error("probe did not render");
      return box.api;
    },
    unmount,
  };
}

const STEP = { key: "step-1", estimatedMinutes: 5, label: "Sear the steak" };

describe("D-WS9-289 — useStepTimers drives the notifier", () => {
  it("starting a timer schedules at the timer's own endsAt", (t) => {
    const { notifier, calls } = fakeNotifier();
    const h = mount(t, notifier);
    act(() => h.api.startTimer(STEP));

    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.kind, "schedule");
    assert.equal(c.kind === "schedule" && c.key, "step-1");
    assert.equal(c.kind === "schedule" && c.label, "Sear the steak");
    // The scheduled instant IS the chip's countdown target — one source of truth.
    assert.equal(
      c.kind === "schedule" && c.endsAtMs,
      h.api.timers["step-1"].endsAt,
    );
  });

  it("a step with no label announces its key rather than nothing", (t) => {
    const { notifier, calls } = fakeNotifier();
    const h = mount(t, notifier);
    act(() => h.api.startTimer({ key: "step-9", estimatedMinutes: 2 }));
    assert.equal(calls[0].kind === "schedule" && calls[0].label, "step-9");
  });

  it("a zero-minute step schedules nothing (it starts no timer either)", (t) => {
    const { notifier, calls } = fakeNotifier();
    const h = mount(t, notifier);
    act(() => h.api.startTimer({ key: "step-0", estimatedMinutes: 0 }));
    assert.deepEqual(calls, []);
    assert.deepEqual(Object.keys(h.api.timers), []);
  });

  it('"Add a minute" reschedules to the pushed-out end, same label', (t) => {
    const { notifier, calls } = fakeNotifier();
    const h = mount(t, notifier);
    act(() => h.api.startTimer(STEP));
    const first = h.api.timers["step-1"].endsAt;

    act(() => h.api.extendTimer("step-1"));

    assert.equal(calls.length, 2, "one schedule per transition");
    const second = calls[1];
    assert.equal(second.kind, "schedule");
    assert.equal(second.kind === "schedule" && second.label, "Sear the steak");
    // A RUNNING timer pushes its original end out by exactly 60s.
    assert.equal(second.kind === "schedule" && second.endsAtMs, first + 60_000);
    assert.equal(h.api.timers["step-1"].endsAt, first + 60_000);
  });

  it("extending an unknown key does nothing at all", (t) => {
    const { notifier, calls } = fakeNotifier();
    const h = mount(t, notifier);
    act(() => h.api.extendTimer("never-started"));
    assert.deepEqual(calls, []);
  });

  it("clearing the timer cancels its alert", (t) => {
    const { notifier, calls } = fakeNotifier();
    const h = mount(t, notifier);
    act(() => h.api.startTimer(STEP));
    act(() => h.api.clearTimer("step-1"));
    assert.deepEqual(calls.map((c) => c.kind), ["schedule", "cancel"]);
    assert.equal(calls[1].kind === "cancel" && calls[1].key, "step-1");
  });

  // ── THE RULE THIS FILE EXISTS FOR ────────────────────────────────────────
  it("leaving Cook Mode does NOT cancel a scheduled notification", (t) => {
    const { notifier, calls, pending } = fakeNotifier();
    const h = mount(t, notifier);
    act(() => h.api.startTimer(STEP));
    assert.deepEqual([...pending], ["step-1"]);

    h.unmount();

    // D-WS9-289, verbatim: "Leaving Cook Mode does NOT cancel it: the food is
    // still cooking." Walking away from the stove is the exact case the
    // notification exists to serve. An unmount cleanup that cancelled pending
    // alerts would delete the feature while looking like hygiene — which is why
    // this assertion is on the CALL LIST and not merely on the pending set: a
    // cancel that happened and was swallowed is still a cancel.
    assert.deepEqual(
      calls.map((c) => c.kind),
      ["schedule"],
      "unmount must not cancel — the food is still cooking",
    );
    assert.deepEqual([...pending], ["step-1"], "the alert is still pending");
  });

  it("unmount cancels nothing even with several timers pending", (t) => {
    const { notifier, calls, pending } = fakeNotifier();
    const h = mount(t, notifier);
    act(() => h.api.startTimer(STEP));
    act(() => h.api.startTimer({ key: "step-2", estimatedMinutes: 3, label: "Rest" }));
    h.unmount();
    assert.equal(calls.filter((c) => c.kind === "cancel").length, 0);
    assert.deepEqual([...pending].sort(), ["step-1", "step-2"]);
  });
});
