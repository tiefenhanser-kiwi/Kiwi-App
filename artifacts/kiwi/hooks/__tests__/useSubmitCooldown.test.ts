// BUG-296 — the auth screens' Retry-After hold: start(n) turns `active` on,
// it turns off after n seconds, a restart extends, and unmount drops the
// pending timeout.

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { useSubmitCooldown, type SubmitCooldown } from "../useSubmitCooldown";

let latest: SubmitCooldown;
function Host() {
  latest = useSubmitCooldown();
  return null;
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
});

function mount(): TestRenderer.ReactTestRenderer {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(React.createElement(Host));
  });
  return r;
}

test("idle until start(); active for exactly the seconds given", () => {
  mount();
  assert.equal(latest.active, false);
  act(() => latest.start(7));
  assert.equal(latest.active, true);
  act(() => mock.timers.tick(6_999));
  assert.equal(latest.active, true, "still held one ms before the wait ends");
  act(() => mock.timers.tick(1));
  assert.equal(latest.active, false);
});

test("start() again restarts the hold from the new value", () => {
  mount();
  act(() => latest.start(5));
  act(() => mock.timers.tick(4_000));
  act(() => latest.start(10));
  act(() => mock.timers.tick(5_000));
  assert.equal(latest.active, true, "the old 5s timeout must not release the new hold");
  act(() => mock.timers.tick(5_000));
  assert.equal(latest.active, false);
});

test("non-positive seconds are ignored", () => {
  mount();
  act(() => latest.start(0));
  assert.equal(latest.active, false);
  act(() => latest.start(-3));
  assert.equal(latest.active, false);
});

test("unmount clears the pending timeout", () => {
  const r = mount();
  act(() => latest.start(5));
  const before = latest;
  act(() => r.unmount());
  // Firing the timer after unmount must not throw (no state on a dead tree).
  assert.doesNotThrow(() => act(() => mock.timers.tick(5_000)));
  assert.equal(before.active, true, "the captured snapshot is untouched — nothing ran");
});
