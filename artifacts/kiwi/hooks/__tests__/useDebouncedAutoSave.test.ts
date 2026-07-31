// WS9 3d Part 3c-2 (B4) — the entire auto-save interaction, tested at the
// extracted-hook boundary (preferences.tsx renders a large native tree the
// node:test strip-types runner can't cheaply mount, so the debounce + flush
// state machine lives in useDebouncedAutoSave and is exercised here directly —
// same extract-for-testability move as dropComposedPlanFromListCache).
//
// Covers, per the block prompt: rapid successive edits collapse to ONE save,
// the seed is not saved, unmount-with-a-pending-edit flushes (the device bug),
// no double-save when the timer already fired, and the error path (onSave owns
// its failure; the hook fire-and-forgets and stays functional).

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { useDebouncedAutoSave } from "../useDebouncedAutoSave";

const DELAY = 800;

function Host({
  value,
  onSave,
}: {
  value: string | null;
  onSave: (v: string) => void | Promise<void>;
}) {
  useDebouncedAutoSave({ value, onSave, delayMs: DELAY });
  return null;
}

const el = (value: string | null, onSave: (v: string) => void | Promise<void>) =>
  React.createElement(Host, { value, onSave });

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
});

test("does not save the initial seed (first non-null value)", () => {
  const saves: string[] = [];
  const onSave = (v: string) => void saves.push(v);
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el(null, onSave));
  });
  act(() => {
    r.update(el("seed", onSave)); // server row → form: not an edit
  });
  act(() => {
    mock.timers.tick(DELAY);
  });
  assert.deepEqual(saves, [], "seed must not trigger a PATCH");
  act(() => {
    r.unmount();
  });
});

test("rapid successive edits collapse to a single save with the last value", () => {
  const saves: string[] = [];
  const onSave = (v: string) => void saves.push(v);
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el("seed", onSave)); // seed (skipped)
  });
  act(() => {
    r.update(el("a", onSave));
  });
  act(() => {
    mock.timers.tick(300); // < DELAY: no fire
  });
  act(() => {
    r.update(el("b", onSave));
  });
  act(() => {
    mock.timers.tick(300);
  });
  act(() => {
    r.update(el("c", onSave));
  });
  act(() => {
    mock.timers.tick(DELAY);
  });
  assert.deepEqual(saves, ["c"], "only the last settled value is written once");
  act(() => {
    r.unmount();
  });
});

test("flushes a still-pending edit on unmount (fast swipe-back)", () => {
  const saves: string[] = [];
  const onSave = (v: string) => void saves.push(v);
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el("seed", onSave));
  });
  act(() => {
    r.update(el("edited", onSave));
  });
  act(() => {
    mock.timers.tick(300); // still inside the debounce window
  });
  act(() => {
    r.unmount(); // used to drop the edit; must now flush it
  });
  assert.deepEqual(saves, ["edited"], "the pending edit is written on unmount");
});

test("no double-save: a fired save is not re-sent on unmount", () => {
  const saves: string[] = [];
  const onSave = (v: string) => void saves.push(v);
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el("seed", onSave));
  });
  act(() => {
    r.update(el("edited", onSave));
  });
  act(() => {
    mock.timers.tick(DELAY); // fires the save
  });
  assert.deepEqual(saves, ["edited"]);
  act(() => {
    r.unmount(); // pending was nulled on fire → no-op
  });
  assert.deepEqual(saves, ["edited"], "unmount must not re-send an already-saved value");
});

test("error path: onSave owns its failure; the hook fire-and-forgets without throwing", async () => {
  // Mirrors persistPreferences, which catches its own error (and shows the
  // error toast) so it never rejects back to the hook. Here we assert the hook
  // dispatches the failing save and stays functional for the next edit.
  const events: string[] = [];
  let fail = true;
  const onSave = async (v: string) => {
    try {
      if (fail) throw new Error("PATCH 500");
      events.push(`ok:${v}`);
    } catch {
      events.push(`error:${v}`);
    }
  };
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el("seed", onSave));
  });
  act(() => {
    r.update(el("x", onSave));
  });
  await act(async () => {
    mock.timers.tick(DELAY);
    await Promise.resolve();
  });
  assert.deepEqual(events, ["error:x"], "the failing save was handled by onSave");

  // A subsequent edit still saves — the prior failure didn't wedge the hook.
  fail = false;
  act(() => {
    r.update(el("y", onSave));
  });
  await act(async () => {
    mock.timers.tick(DELAY);
    await Promise.resolve();
  });
  assert.deepEqual(events, ["error:x", "ok:y"], "later edits still save after a failure");
  act(() => {
    r.unmount();
  });
});
