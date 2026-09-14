// WS9 D-WS9-239 Phase 1b — firstDependent → parallelGroup derivation.
//
// The fixtures are Phase 0b's hand-checked verdict shapes (scripts/output/
// ws9-239/handcheck_b.md), reduced to the fields the rules read. Each rule has
// a fixture that goes RED when the rule is removed (§27.4 — verified by
// deliberate break, see the Phase 1b report).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADJACENCY_MAX_MINUTES,
  ADJACENCY_WINDOW_PHASES,
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
      st("rest", 10), // last step: the field is OMITTED (1b-ii)
    ];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [
      "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0", "w0",
      null, // the bake: the dependent, never a rider
      null, // the rest: dependent of the bake (adjacent → no riders); last step, no entry
    ]);
    // 1c: the inner windows (#7→9, #11→13: ≤5-min unattended cooks followed by an unattended
    // cook) are forced adjacent by the adjacency override — silently, since they were absorbed
    // by w0 and no token changes. Before 1c they showed as two nested_window_absorbed tie-breaks.
    assert.equal(r.tieBreaks, 0);
    assert.deepEqual(classes(r), []);
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
    // 1c: #8 (3-min cook → 10) is followed by an unattended cook, so the adjacency override
    // forces it adjacent — silently: it was absorbed (w5) and no token changes. #4 (5-min REST
    // → 11) is the same shape but a rest is not a window the override may close (the rest/hold
    // refinement): its declared window stands and is absorbed into w2 — one nested_window_absorbed
    // tie-break, no token changes. (Before the refinement 1c forced #4 too and this read 0 / [].)
    assert.equal(r.tieBreaks, 1);
    assert.deepEqual(classes(r), ["nested_window_absorbed"]);
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
      st("cook", 20), // last step, no entry
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

  it("1b-ii: null is REFUSED on every step — no token, `null_declared` — never a window to the end of the dish", () => {
    // The 1b gate: 9 of 9 non-final nulls meant "nothing to overlap here" and ran the window to the end.
    const r = deriveParallelGroups([st("preheat", 10, { fd: null }), st("prep", 3), st("prep", 3), st("assemble", 2)]);
    assert.deepEqual(r.tags, [null, null, null, null]);
    assert.deepEqual(classes(r), ["null_declared"]);
    // The carnitas shape: pour-in → null, then the braise and the crisp. Nothing rides the pour-in.
    const carnitas = deriveParallelGroups([st("cook", 2, { fd: null }), st("cook", 45, { fd: 2 }), st("cook", 10, { ts: true }), st("assemble", 2)]);
    assert.deepEqual(carnitas.tags, [null, null, null, null]);
    assert.deepEqual(classes(carnitas), ["null_declared"]);
    // null on the LAST step is refused too (the contract there is to omit), and counts as declared.
    const last = deriveParallelGroups([st("preheat", 10, { fd: 1 }), st("cook", 20, { fd: null })]);
    assert.deepEqual(last.tags, [null, null]);
    assert.deepEqual(classes(last), ["null_declared"]);
    assert.equal(last.declaredCount, 2);
    // Omitted on the last step: no issue at all.
    const omitted = deriveParallelGroups([st("preheat", 10, { fd: 1 }), st("cook", 20)]);
    assert.deepEqual(omitted.issues, []);
  });

  it("missing entry on an unattended step = next step depends: no token, reported; attended steps need no entry", () => {
    const r = deriveParallelGroups([st("preheat", 10), st("prep", 3), st("prep", 3), st("assemble", 2)]);
    assert.deepEqual(r.tags, [null, null, null, null]);
    assert.deepEqual(classes(r), ["missing_window"]);
    assert.equal(r.declaredCount, 0, "nothing declared — callers stay silent on this dish");
    // 1b-ii: the LAST step omits the field by contract — no missing_window there.
    const lastOmitted = deriveParallelGroups([st("preheat", 10, { fd: 1 }), st("cook", 20, { fd: 2 }), st("rest", 5)]);
    assert.deepEqual(lastOmitted.issues, []);
    const midMissing = deriveParallelGroups([st("preheat", 10, { fd: 1 }), st("cook", 20), st("rest", 5)]);
    assert.deepEqual(classes(midMissing), ["missing_window"], "a NON-final omission is still reported");
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

// ── Phase 1c — the adjacency override (variant B, N = 5) ────────────────────
// Fixtures are the dishes that moved in the 1c Phase 0 sweep (v9 seeds 240/241)
// and the ones the rule must leave alone. The discriminator is physical:
// unattended-then-UNATTENDED cook is one process continuing; unattended-then-
// ATTENDED cook is separate work done during a window.
describe("deriveParallelGroups — 1c adjacency override (≤ 5-min unattended step followed by an unattended cook)", () => {
  it("N is 5 and exported", () => {
    assert.equal(ADJACENCY_MAX_MINUTES, 5);
  });

  it("Red Beans (v9-240): 'bring to a boil' 5 min → declared #9, forced to the simmer at #8; the plating no longer rides the boil", () => {
    // #7 (5 min, unattended cook) declared →9; #8 is the 80-min simmer (unattended cook); #9 finishing (unattended cook); #10 plate.
    const steps = [st("prep", 10), st("prep", 3), st("prep", 2), st("preheat", 2, { fd: 4 }), st("cook", 4, { ts: true }), st("cook", 7, { ts: true }), st("cook", 1, { ts: true }), st("cook", 5, { fd: 9 }), st("cook", 80, { fd: 9 }), st("cook", 3, { fd: 10 }), st("assemble", 2)];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, null, null, null, null, null, null, null, null, null, null], "no window survives: every dependent is now adjacent");
    const ov = r.issues.filter((i) => i.cls === "adjacency_override");
    assert.equal(ov.length, 1);
    assert.equal(ov[0].detail, "#7 (5 min, unattended) declared →#9 but is followed by an unattended cook; forced →#8");
  });

  it("Ham (v9-240): 'brush the glaze, into the oven' 5 min → declared #5, forced to the roast at #4; the preheat window is untouched", () => {
    const steps = [st("preheat", 15, { fd: 3 }), st("prep", 4), st("prep", 5), st("cook", 5, { fd: 5 }), st("cook", 60, { fd: 5 }), st("cook", 25, { fd: 6 }), st("rest", 15, { fd: 7 }), st("assemble", 5)];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, ["w0", "w0", "w0", null, null, null, null, null]);
    assert.deepEqual(classes(r), ["adjacency_override"]);
  });

  it("GUARD — Cheesesteak: 'let the cheese melt' 2 min → #10 with 'while the cheese melts, toast the rolls' (an ATTENDED cook) next: the rule must NOT touch it", () => {
    const steps = [st("prep", 8), st("preheat", 2, { fd: 2 }), st("cook", 9, { ts: true }), st("cook", 6, { ts: true }), st("cook", 2, { fd: 6 }), st("cook", 2, { ts: true }), st("assemble", 2)];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, null, null, null, "w4", "w4", null], "the toast rides the melt — a real window, kept");
    assert.equal(r.issues.filter((i) => i.cls === "adjacency_override").length, 0, "widening B into A would fire here — it must not");
  });

  it("GUARD — Carne Asada: a 5-min rest with 'while the steak rests, warm the tortillas' (attended cook) next is kept", () => {
    const steps = [st("cook", 8, { ts: true }), st("rest", 5, { fd: 3 }), st("cook", 5, { ts: true }), st("assemble", 3)];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, "w1", "w1", null]);
    assert.equal(r.issues.length, 0);
  });

  it("the N boundary — Al Pastor's 6-minute 'warm the tortillas' with an unattended-tagged 'slice the pork' next is NOT overridden; the same shape at 5 minutes is", () => {
    const six = [st("cook", 14, { ts: true }), st("cook", 6, { fd: 3 }), st("cook", 3), st("assemble", 4)];
    const r6 = deriveParallelGroups(six);
    assert.deepEqual(r6.tags, [null, "w1", "w1", null], "6 > N: the declared window stands");
    assert.equal(r6.issues.filter((i) => i.cls === "adjacency_override").length, 0);
    const five = [st("cook", 14, { ts: true }), st("cook", 5, { fd: 3 }), st("cook", 3), st("assemble", 4)];
    const r5 = deriveParallelGroups(five);
    assert.deepEqual(r5.tags, [null, null, null, null], "5 ≤ N: forced adjacent, no riders, no token");
    assert.deepEqual(classes(r5).filter((c) => c === "adjacency_override"), ["adjacency_override"]);
  });

  it("a candidate whose override changes no token is silent (absorbed inner window), and an already-adjacent declaration is not a candidate", () => {
    // preheat w0 covers #1–#3; #1 (2-min unattended cook → 3) sits inside it and is absorbed either way.
    const absorbed = deriveParallelGroups([st("preheat", 10, { fd: 4 }), st("cook", 2, { fd: 3 }), st("cook", 5, { fd: 3 }), st("prep", 3), st("cook", 20, { fd: 5 }), st("assemble", 2)]);
    assert.deepEqual(absorbed.tags, ["w0", "w0", "w0", "w0", null, null]);
    assert.equal(absorbed.issues.filter((i) => i.cls === "adjacency_override").length, 0, "tokens unchanged → not reported");
    const adjacent = deriveParallelGroups([st("cook", 3, { fd: 1 }), st("cook", 20, { fd: 2 }), st("assemble", 2)]);
    assert.equal(adjacent.issues.length, 0);
  });
});

// ── The rest/hold refinement — the WINDOW step must be a cook or a preheat ───
// A rest/hold is a pause, not a process; nothing it does continues into the
// cook after it. Fixtures are the catalog's own adjacency fires (Phase 2 read of
// all 30: the 4 with a rest/hold window were all closed legitimate windows —
// "rest the steak → warm the tortillas" — and none a fixed continuation).
describe("deriveParallelGroups — adjacency window restricted to cook/preheat (a rest is a pause, not a continuation)", () => {
  it("the window phases are exactly cook and preheat, and exported", () => {
    assert.deepEqual([...ADJACENCY_WINDOW_PHASES], ["cook", "preheat"]);
  });

  it("REST window (catalog 3c5f32db Smoky Chipotle Carne Asada): 'rest the steak' 5 min → #7 with 'while the steak rests, warm the tortillas' (unattended cook) next — left to its declaration, the tortillas ride the rest", () => {
    const steps = [st("prep", 8, { path: "scratch" }), st("prep", 1, { path: "bought" }), st("rest", 20, { fd: 4 }), st("preheat", 3, { fd: 4 }), st("cook", 8, { ts: true }), st("rest", 5, { fd: 7 }), st("cook", 5), st("assemble", 4)];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, null, "w2", "w2", null, "w5", "w5", null], "the marinade window is untouched; the rest now carries the tortilla warm-up");
    assert.equal(r.issues.filter((i) => i.cls === "adjacency_override").length, 0, "a rest window is not a candidate");
  });

  it("HOLD window (catalog adcd1ba5 Herb Falafel in Warm Pita): 'keep the falafel warm' 5 min → #9 with 'warm the pita' (unattended cook) next — left alone, the pita rides the hold", () => {
    const steps = [st("prep", 5), st("prep", 6), st("prep", 4), st("rest", 30, { fd: 5 }), st("preheat", 5, { fd: 6 }), st("prep", 6), st("cook", 16, { ts: true }), st("hold", 5, { fd: 9 }), st("cook", 5, { fd: 9 }), st("assemble", 3)];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, null, null, "w3", "w3", null, null, "w7", "w7", null]);
    assert.equal(r.issues.filter((i) => i.cls === "adjacency_override").length, 0, "a hold window is not a candidate");
  });

  it("COOK window still fires (catalog ece9b89b Classic Sloppy Joes, one of the 7 true continuations): 'add the sauce' 2 min → #7 skipping the 10-min simmer; forced → #6, no token", () => {
    const steps = [st("prep", 6), st("prep", 3), st("cook", 7, { ts: true }), st("cook", 4, { ts: true }), st("cook", 1, { ts: true }), st("cook", 2, { fd: 7 }), st("cook", 10, { fd: 7 }), st("assemble", 2)];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, null, null, null, null, null, null, null], "the simmer is the continuation of the sauce step; nothing rides it");
    const ov = r.issues.filter((i) => i.cls === "adjacency_override");
    assert.equal(ov.length, 1);
    assert.equal(ov[0].detail, "#5 (2 min, unattended) declared →#7 but is followed by an unattended cook; forced →#6");
  });

  it("PREHEAT window still fires (catalog 075c6e9b Crispy Onion Straws): 'heat the oil' 4 min → #5 (fry) with #4 tagged an unattended cook next; forced → #4", () => {
    // A preheat CAN continue into a cook (heat the oil → fry). On the catalog this fire was a
    // loss — #4 'dredge the rings' is hands-on work mis-tagged unattended — but that is the
    // RIDER side of the rule, which this refinement does not touch; the window side keeps preheat.
    const steps = [st("prep", 5, { path: "scratch" }), st("prep", 3, { path: "scratch" }), st("prep", 1, { path: "bought" }), st("preheat", 4, { fd: 5 }), st("cook", 3, { path: "scratch" }), st("cook", 8, { ts: true, path: "scratch" })];
    const r = deriveParallelGroups(steps);
    assert.deepEqual(r.tags, [null, null, null, null, null, null]);
    const ov = r.issues.filter((i) => i.cls === "adjacency_override");
    assert.equal(ov.length, 1);
    assert.equal(ov[0].detail, "#3 (4 min, unattended) declared →#5 but is followed by an unattended cook; forced →#4");
  });
});
