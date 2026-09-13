// WS9 D-WS9-239 Phase 1b — firstDependent → parallelGroup derivation.
//
// The fixtures are Phase 0b's hand-checked verdict shapes (scripts/output/
// ws9-239/handcheck_b.md), reduced to the fields the rules read. Each rule has
// a fixture that goes RED when the rule is removed (§27.4 — verified by
// deliberate break, see the Phase 1b report).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveParallelGroups,
  type DeriveStep,
} from "../parallelGroupDerive";

type P = DeriveStep["phaseType"];
const st = (
  phaseType: P,
  min: number,
  o: { ts?: boolean; fd?: number | null; path?: "scratch" | "bought"; comp?: string } = {},
): DeriveStep => ({
  phaseType,
  estimatedMinutes: min,
  isTimingSensitive: o.ts ?? false,
  ...(o.fd !== undefined ? { firstDependent: o.fd } : {}),
  ...(o.path ? { pathKey: o.path } : {}),
  ...(o.comp ? { componentKey: o.comp } : {}),
});
const classes = (r: ReturnType<typeof deriveParallelGroups>) => r.issues.map((i) => i.cls);

describe("deriveParallelGroups — the Phase 0b rule set on generator output", () => {
  it("filling rides the preheat (v239 #4 Turkey Pot Pie): preheat → the bake tags every step between", () => {
    // preheat(0) → bake(14); inner windows (#5→6, #7→9, #11→13) are absorbed.
    const steps = [
      st("preheat", 15, { fd: 14 }),
      st("prep", 12, { path: "scratch" }),
      st("prep", 5, { path: "bought" }),
      st("prep", 2),
      st("cook", 6, { ts: true, path: "scratch" }),
      st("cook", 2, { fd: 6, path: "bought" }),
      st("cook", 5, { ts: true }),
      st("cook", 3, { fd: 9, path: "scratch" }),
      st("cook", 2, { fd: 9, path: "bought" }),
      st("cook", 2, { ts: true }),
      st("cook", 7, { ts: true }),
      st("cook", 2, { fd: 13, path: "scratch" }),
      st("cook", 2, { fd: 13, path: "bought" }),
      st("assemble", 5),
      st("cook", 30, { fd: 15 }),
      st("rest", 10, { fd: null }),
    ];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [
      "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0",
      null, // the bake: the dependent, never a rider
      null, // the rest: dependent of the bake (adjacent → no riders); its own null window has no riders
    ]);
    // Inner windows with riders (#5→6 has none; #7→9 and #11→13 have one each) are absorbed.
    assert.equal(r.tieBreaks, 2);
    assert.deepEqual(classes(r), ["nested_window_absorbed", "nested_window_absorbed"]);
  });

  it("pasta INTO the water (v239 #19 Chicken Alfredo): the boil's dependent is the step that uses it; riders between", () => {
    const steps = [
      st("prep", 6),
      st("prep", 4),
      st("preheat", 8, { fd: 5 }), // bring the water to a boil → #5 puts the pasta in
      st("cook", 12, { ts: true }), // grill — rides the boil
      st("rest", 5, { fd: 11 }), // rest → topped at #11; absorbed into w2
      st("cook", 12, { fd: 10 }), // pasta in the water → #10 tosses it
      st("cook", 3, { ts: true, path: "scratch" }),
      st("cook", 5, { ts: true, path: "scratch" }),
      st("cook", 3, { fd: 10, path: "scratch" }),
      st("cook", 4, { fd: 10, path: "bought" }),
      st("assemble", 3),
      st("assemble", 3),
    ];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, null, "w2", "w2", "w2", "w5", "w5", "w5", "w5", "w5", null, null]);
    assert.equal(r.tags[5], "w5", "the pasta step is w2's DEPENDENT, not its rider — it opens its own window");
    // #4 (rest→11, 6 riders) and #8 (→10, 1 rider) are absorbed; #9→10 has no riders and is silent.
    assert.equal(r.tieBreaks, 2);
    assert.deepEqual(classes(r), ["nested_window_absorbed", "nested_window_absorbed"]);
  });

  it("rule (b): a rest/hold immediately after a cook window closes the window AT the rest", () => {
    // cook(1) → 4 skips the rest at 2: closed at 2 → no riders → no token.
    // The rest's own window (2 → 4) still forms over the prep at 3.
    const steps = [st("prep", 5), st("cook", 30, { fd: 4 }), st("rest", 10, { fd: 4 }), st("prep", 3), st("assemble", 2)];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, null, "w2", "w2", null]);
    assert.ok(classes(r).includes("rest_rides_cook"));
    // A `hold` closes the same way.
    const held = deriveParallelGroups([st("prep", 5), st("cook", 30, { fd: 4 }), st("hold", 10, { fd: 4 }), st("prep", 3), st("assemble", 2)]);
    assert.deepEqual(held.tags, [null, null, "w2", "w2", null]);
  });

  it("rule (b) report-only: a rest riding a NON-adjacent cook window is reported, not closed", () => {
    const steps = [st("cook", 30, { fd: 4 }), st("prep", 3), st("rest", 5, { fd: 4 }), st("prep", 2), st("assemble", 2)];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, ["w0", "w0", "w0", "w0", null]);
    assert.ok(classes(r).includes("rest_rides_cook_nonadjacent"));
  });

  it("path hole breaks contiguity (v239 #24 White Supreme Pizza): the roast group collapses, the preheat group forms", () => {
    const steps = [
      st("cook", 22, { fd: 5, path: "scratch" }), // roast the pepper (scratch) → used at #5
      st("prep", 3, { path: "bought" }), // the bought path: cannot ride a scratch window
      st("preheat", 30, { fd: 6 }), // oven → the bake at #6
      st("prep", 8),
      st("prep", 3),
      st("assemble", 3),
      st("cook", 14, { fd: 7 }),
      st("assemble", 4),
    ];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, null, "w2", "w2", "w2", "w2", null, null]);
    const cls = classes(r);
    for (const c of ["path_mismatch", "reopened_group", "lone_token", "window_collapsed"]) {
      assert.ok(cls.includes(c as never), `expected ${c} in ${cls.join(",")}`);
    }
  });

  it("rule (d): base (no pathKey) rides anything; scratch never rides bought", () => {
    const r = deriveParallelGroups([
      st("preheat", 10, { fd: 4, path: "bought" }),
      st("prep", 3), // base → rides
      st("prep", 3, { path: "bought" }), // same path → rides
      st("prep", 3, { path: "scratch" }), // other path → hole
      st("cook", 20),
    ]);
    assert.deepEqual(r.tags, ["w0", "w0", "w0", null, null]);
    assert.ok(classes(r).includes("path_mismatch"));
  });

  it("rule (a): an attended step never opens a window — its firstDependent is ignored and reported", () => {
    const r = deriveParallelGroups([st("prep", 5), st("cook", 6, { ts: true, fd: 3 }), st("prep", 2), st("assemble", 2)]);
    assert.deepEqual(r.tags, [null, null, null, null]);
    assert.deepEqual(classes(r), ["attended_window"]);
    // prep / assemble with a firstDependent: same class.
    const p = deriveParallelGroups([st("prep", 5, { fd: 2 }), st("prep", 2), st("assemble", 2, { fd: null })]);
    assert.deepEqual(p.tags, [null, null, null]);
    assert.deepEqual(classes(p), ["attended_window", "attended_window"]);
  });

  it("shares the scheduler's predicate: an unattended `cook` is a window, a timing-sensitive one is not (BUG-018)", () => {
    const braise = deriveParallelGroups([st("cook", 30, { fd: 3 }), st("prep", 3), st("prep", 3), st("assemble", 2)]);
    assert.deepEqual(braise.tags, ["w0", "w0", "w0", null]);
    const sear = deriveParallelGroups([st("cook", 30, { ts: true, fd: 3 }), st("prep", 3), st("prep", 3), st("assemble", 2)]);
    assert.deepEqual(sear.tags, [null, null, null, null]);
  });

  it("nested window absorbed: a step inside two open windows goes to the EARLIEST, and the tie-break is counted", () => {
    const r = deriveParallelGroups([
      st("preheat", 10, { fd: 4 }),
      st("cook", 5, { fd: 3 }), // its own window would cover #2; absorbed by w0
      st("prep", 3),
      st("prep", 3),
      st("cook", 20, { fd: null }),
    ]);
    assert.deepEqual(r.tags, ["w0", "w0", "w0", "w0", null]);
    assert.equal(r.tieBreaks, 1);
    assert.deepEqual(classes(r), ["nested_window_absorbed"]);
  });

  it("rider-level tie-break: a rider an earlier window already claimed stays claimed, even when a path hole let the later window open", () => {
    // w0 (scratch) skips the bought steps #1 and #2 but claims the base steps #3–#4; #2 (bought preheat)
    // opens its own window and finds #3–#4 taken. Both groups then collapse under contiguity
    // (w0 has a hole at #1, w2 is left alone) — the conservative outcome the probe measured.
    const r = deriveParallelGroups([
      st("cook", 20, { fd: 5, path: "scratch" }),
      st("prep", 3, { path: "bought" }),
      st("preheat", 10, { fd: 5, path: "bought" }),
      st("prep", 3),
      st("prep", 3),
      st("cook", 5, { ts: true }),
    ]);
    assert.deepEqual(r.tags, [null, null, null, null, null, null]);
    // tieBreaks is the FINAL fixpoint pass (both windows gone → 0); the collapse is what is pinned.
    assert.equal(classes(r).filter((c) => c === "window_collapsed").length, 2);
  });

  it("null runs to the end of the dish", () => {
    const r = deriveParallelGroups([st("preheat", 10, { fd: null }), st("prep", 3), st("prep", 3), st("assemble", 2)]);
    assert.deepEqual(r.tags, ["w0", "w0", "w0", "w0"]);
    assert.deepEqual(r.issues, []);
  });

  it("missing entry on an unattended step = next step depends: no token, reported; attended steps need no entry", () => {
    const r = deriveParallelGroups([st("preheat", 10), st("prep", 3), st("prep", 3), st("assemble", 2)]);
    assert.deepEqual(r.tags, [null, null, null, null]);
    assert.deepEqual(classes(r), ["missing_window"]);
    assert.equal(r.declaredCount, 0, "nothing declared — callers stay silent on this dish");
    const half = deriveParallelGroups([st("preheat", 10, { fd: 2 }), st("prep", 3), st("cook", 20), st("assemble", 2)]);
    assert.equal(half.declaredCount, 1, "one declaration (the cook has none) — callers report the missing one");
    assert.deepEqual(classes(half), ["missing_window"]);
  });

  it("a dependent that is not later, out of range, or not an integer: reported, no token", () => {
    const notLater = deriveParallelGroups([st("prep", 3), st("preheat", 10, { fd: 1 }), st("prep", 3), st("cook", 5, { ts: true })]);
    assert.deepEqual(notLater.tags, [null, null, null, null]);
    assert.deepEqual(classes(notLater), ["dependent_not_later"]);
    const earlier = deriveParallelGroups([st("prep", 3), st("preheat", 10, { fd: 0 }), st("prep", 3), st("cook", 5, { ts: true })]);
    assert.deepEqual(classes(earlier), ["dependent_not_later"]);
    const range = deriveParallelGroups([st("preheat", 10, { fd: 9 }), st("prep", 3), st("cook", 5, { ts: true })]);
    assert.deepEqual(range.tags, [null, null, null]);
    assert.deepEqual(classes(range), ["dependent_out_of_range"]);
    const frac = deriveParallelGroups([st("preheat", 10, { fd: 1.5 }), st("prep", 3), st("cook", 5, { ts: true })]);
    assert.deepEqual(classes(frac), ["dependent_out_of_range"]);
  });

  it("a window whose dependent is the very next step emits no token (nothing rides)", () => {
    const r = deriveParallelGroups([st("preheat", 10, { fd: 1 }), st("cook", 20, { fd: 2 }), st("assemble", 2)]);
    assert.deepEqual(r.tags, [null, null, null]);
    assert.deepEqual(r.issues, []);
  });

  it("is pure: does not mutate its input and returns one tag per step", () => {
    const steps = [st("preheat", 10, { fd: 3 }), st("prep", 3), st("prep", 3), st("cook", 20)];
    const before = JSON.stringify(steps);
    const r = deriveParallelGroups(steps);
    assert.equal(JSON.stringify(steps), before);
    assert.equal(r.tags.length, steps.length);
    assert.deepEqual(deriveParallelGroups([]).tags, []);
  });
});
