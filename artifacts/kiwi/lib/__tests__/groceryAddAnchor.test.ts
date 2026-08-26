// WS9 BUG-140 — the in-list "+ Add item" anchor.
//
// ⚠️ TESTED BY DESTINATION, NOT BY TAP. The defect was `onPress={() => {}}`: a
// control that is wired to *something* and does nothing. A test that asserts
// "the handler fired" passes on the dead version the moment anyone hangs any
// callback on it. So every guard below asserts what the user actually gets —
// the top input receives focus, and it is scrolled back into view first.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { focusAddItemInput } from "../groceryAddAnchor";

function stubInput() {
  const calls: string[] = [];
  return { calls, ref: { focus: () => calls.push("focus") } };
}

function stubScroll() {
  const calls: Array<{ y: number; animated: boolean }> = [];
  return {
    calls,
    ref: { scrollTo: (o: { y: number; animated: boolean }) => calls.push(o) },
  };
}

describe("BUG-140: the inline add control anchors to the top add surface", () => {
  it("guard A1 — the TOP INPUT RECEIVES FOCUS (the whole point)", () => {
    const input = stubInput();
    const scroll = stubScroll();
    focusAddItemInput(input.ref, scroll.ref);
    assert.deepEqual(
      input.calls,
      ["focus"],
      "the add input must be focused exactly once",
    );
  });

  it("guard A2 — it is scrolled back into view, to the top, animated", () => {
    const input = stubInput();
    const scroll = stubScroll();
    focusAddItemInput(input.ref, scroll.ref);
    assert.equal(scroll.calls.length, 1);
    assert.deepEqual(scroll.calls[0], { y: 0, animated: true });
  });

  it("guard A3 — ORDER: scroll happens BEFORE focus", () => {
    // Focusing an off-screen input lets the keyboard-avoiding view choose the
    // scroll position, which can land the field under the keyboard. Scrolling
    // first makes the resting position deterministic. Order is behaviour here,
    // not style, so it is pinned.
    const seq: string[] = [];
    focusAddItemInput(
      { focus: () => seq.push("focus") },
      { scrollTo: () => seq.push("scroll") },
    );
    assert.deepEqual(seq, ["scroll", "focus"]);
  });

  it("guard A4 — null/undefined refs are tolerated and do NOT throw", () => {
    // A ref is null on first render and after unmount. Throwing here would put
    // the control straight back to doing nothing, which is the bug.
    assert.doesNotThrow(() => focusAddItemInput(null, null));
    assert.doesNotThrow(() => focusAddItemInput(undefined, undefined));
    // A half-mounted pair still does the half it can.
    const input = stubInput();
    assert.doesNotThrow(() => focusAddItemInput(input.ref, null));
    assert.deepEqual(input.calls, ["focus"]);
    const scroll = stubScroll();
    assert.doesNotThrow(() => focusAddItemInput(null, scroll.ref));
    assert.deepEqual(scroll.calls, [{ y: 0, animated: true }]);
  });

  it("guard A5 — every entry point reaches the SAME surface", () => {
    // Several sections, one add surface: N presses must all land on the one
    // input rather than N of them growing their own handler over time.
    const input = stubInput();
    const scroll = stubScroll();
    for (let i = 0; i < 4; i++) focusAddItemInput(input.ref, scroll.ref);
    assert.deepEqual(input.calls, ["focus", "focus", "focus", "focus"]);
    assert.equal(scroll.calls.length, 4);
  });
});
