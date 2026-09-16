// WS9 Redesign Arc Block 2a (D-WS9-245) — the UI half of "All on one dial
// forces None on the other". The server applies the same rule when it
// resolves the levels; this pins the mirror so the chips can never show a pair
// the server would silently rewrite.

import assert from "node:assert/strict";
import { test } from "node:test";

import { setDial, type DialState } from "../dials";

const BOTH_SOME: DialState = { playlistLevel: "some", discoveryLevel: "some" };

test("setDial: an ordinary change touches ONE dial only", () => {
  assert.deepEqual(setDial(BOTH_SOME, "discoveryLevel", "mostly"), {
    playlistLevel: "some",
    discoveryLevel: "mostly",
  });
  assert.deepEqual(setDial(BOTH_SOME, "playlistLevel", "none"), {
    playlistLevel: "none",
    discoveryLevel: "some",
  });
});

test("setDial: All on discovery forces playlist to None", () => {
  assert.deepEqual(setDial(BOTH_SOME, "discoveryLevel", "all"), {
    playlistLevel: "none",
    discoveryLevel: "all",
  });
});

test("setDial: All on playlist forces discovery to None", () => {
  assert.deepEqual(setDial(BOTH_SOME, "playlistLevel", "all"), {
    playlistLevel: "all",
    discoveryLevel: "none",
  });
});

test("setDial: the two dials can never both be All on the wire", () => {
  // Tap All on one, then All on the other — the LAST tap wins its dial and
  // the first drops to None. Mirrors the server's applyAllForcesNone, whose
  // both-all tie-break therefore never has to fire for this client.
  const first = setDial(BOTH_SOME, "discoveryLevel", "all");
  const second = setDial(first, "playlistLevel", "all");
  assert.deepEqual(second, { playlistLevel: "all", discoveryLevel: "none" });
});

test("setDial: returns a new object, never mutates the input", () => {
  const next = setDial(BOTH_SOME, "playlistLevel", "all");
  assert.notEqual(next, BOTH_SOME);
  assert.deepEqual(BOTH_SOME, { playlistLevel: "some", discoveryLevel: "some" });
});
