// WS7-8b Block 4 (Build Block 3) — pure completion-toggle logic tests.
// The cross-screen isPrepped flip is device-verified (not harness-testable); the
// optimistic update, the revert, and the invalidation key set ARE pinned here.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  prepWeekCompletionsKey,
  prepCompletionInvalidationKeys,
  toggleCompletionRows,
  runPrepStepToggle,
  runPrepPhaseComplete,
  type PrepToggleDeps,
} from "../prepCompletionToggle";
import type { PrepCompletionRow, PrepWeekCompletions } from "@/lib/api/cooking";

const NOW = "2026-06-27T00:00:00.000Z";

// ── Query keys ────────────────────────────────────────────────────────────────

test("prepWeekCompletionsKey: distinct resume key (not the generate key)", () => {
  assert.deepEqual(prepWeekCompletionsKey("plan-1"), [
    "cooking",
    "prep-week-completions",
    "plan-1",
  ]);
});

test("prepCompletionInvalidationKeys: invalidates plans/meals/home + resume, NOT the generate key", () => {
  const flat = prepCompletionInvalidationKeys("plan-1").map((k) => k.join("/"));
  assert.ok(flat.includes("plans"), "must invalidate ['plans'] (the isPrepped gate)");
  assert.ok(flat.includes("meals/detail"), "must invalidate ['meals','detail']");
  assert.ok(flat.includes("home"), "must invalidate ['home'] (Hub indicator)");
  assert.ok(
    flat.includes("cooking/prep-week-completions/plan-1"),
    "must invalidate the resume key",
  );
  // The expensive AI generate call must NEVER be refetched by a checkbox tap.
  assert.ok(
    !flat.includes("cooking/prep-week/plan-1"),
    "must NOT invalidate the generate key (cache-collision guard)",
  );
});

// ── toggleCompletionRows (pure, idempotent) ────────────────────────────────────

test("toggleCompletionRows: check adds a row when absent", () => {
  const out = toggleCompletionRows([], "produce#a", true, NOW);
  assert.deepEqual(out, [{ stepKey: "produce#a", checkedAt: NOW }]);
});

test("toggleCompletionRows: check is idempotent and KEEPS the original checkedAt", () => {
  const rows: PrepCompletionRow[] = [{ stepKey: "produce#a", checkedAt: "2026-06-01T00:00:00.000Z" }];
  const out = toggleCompletionRows(rows, "produce#a", true, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].checkedAt, "2026-06-01T00:00:00.000Z"); // not overwritten
});

test("toggleCompletionRows: uncheck removes the row when present", () => {
  const rows: PrepCompletionRow[] = [
    { stepKey: "produce#a", checkedAt: NOW },
    { stepKey: "proteins#b", checkedAt: NOW },
  ];
  const out = toggleCompletionRows(rows, "produce#a", false, NOW);
  assert.deepEqual(out.map((r) => r.stepKey), ["proteins#b"]);
});

test("toggleCompletionRows: uncheck is a no-op when the row is absent", () => {
  const rows: PrepCompletionRow[] = [{ stepKey: "proteins#b", checkedAt: NOW }];
  const out = toggleCompletionRows(rows, "produce#a", false, NOW);
  assert.deepEqual(out, rows);
});

// ── runPrepStepToggle (optimistic → write → revert) ───────────────────────────

function completions(rows: PrepCompletionRow[]): PrepWeekCompletions {
  return {
    completions: rows,
    perMeal: {},
    derivedPrepStatus: "partial",
    prepStatus: "partial",
    prepStatusIsManual: false,
  };
}

interface Harness {
  deps: PrepToggleDeps;
  calls: {
    check: string[];
    uncheck: string[];
    cancel: number;
    invalidate: number;
    sets: number;
  };
  store: () => PrepWeekCompletions | undefined;
}

function makeHarness(
  initial: PrepWeekCompletions | undefined,
  opts: { failCheck?: boolean; failUncheck?: boolean; failCheckKey?: string } = {},
): Harness {
  let store = initial;
  const calls = {
    check: [] as string[],
    uncheck: [] as string[],
    cancel: 0,
    invalidate: 0,
    sets: 0,
  };
  const deps: PrepToggleDeps = {
    cancel: () => {
      calls.cancel++;
    },
    getCompletions: () => store,
    setCompletions: (next) => {
      store = next;
      calls.sets++;
    },
    check: async (k) => {
      calls.check.push(k);
      if (opts.failCheck || (opts.failCheckKey && k === opts.failCheckKey)) {
        throw new Error("network boom");
      }
    },
    uncheck: async (k) => {
      calls.uncheck.push(k);
      if (opts.failUncheck) throw new Error("network boom");
    },
    invalidate: () => {
      calls.invalidate++;
    },
    nowIso: () => NOW,
  };
  return { deps, calls, store: () => store };
}

test("runPrepStepToggle: check optimistically adds the row, fires checkPrepStep, invalidates", async () => {
  const h = makeHarness(completions([]));
  await runPrepStepToggle(h.deps, "produce#a", true);
  assert.deepEqual(h.calls.check, ["produce#a"]);
  assert.deepEqual(h.calls.uncheck, []);
  assert.equal(h.calls.cancel, 1, "cancels in-flight resume refetch before snapshot");
  assert.equal(h.calls.invalidate, 1);
  assert.deepEqual(
    h.store()?.completions.map((r) => r.stepKey),
    ["produce#a"],
  );
});

test("runPrepStepToggle: uncheck optimistically removes the row, fires uncheckPrepStep", async () => {
  const h = makeHarness(completions([{ stepKey: "produce#a", checkedAt: NOW }]));
  await runPrepStepToggle(h.deps, "produce#a", false);
  assert.deepEqual(h.calls.uncheck, ["produce#a"]);
  assert.deepEqual(h.store()?.completions, []);
  assert.equal(h.calls.invalidate, 1);
});

test("runPrepStepToggle: on write failure it REVERTS to the snapshot, still invalidates, and rethrows", async () => {
  const initial = completions([{ stepKey: "keep#x", checkedAt: NOW }]);
  const h = makeHarness(initial, { failCheck: true });
  await assert.rejects(() => runPrepStepToggle(h.deps, "produce#a", true));
  // reverted: the optimistic 'produce#a' is gone, original row restored
  assert.deepEqual(
    h.store()?.completions.map((r) => r.stepKey),
    ["keep#x"],
  );
  // invalidation still fires in finally (reconcile to server truth)
  assert.equal(h.calls.invalidate, 1);
});

test("runPrepStepToggle: a missing resume cache (undefined) skips the optimistic write but still calls the verb", async () => {
  const h = makeHarness(undefined);
  await runPrepStepToggle(h.deps, "produce#a", true);
  assert.deepEqual(h.calls.check, ["produce#a"]);
  assert.equal(h.store(), undefined); // nothing to optimistically write into
  assert.equal(h.calls.invalidate, 1);
});

// ── runPrepPhaseComplete (R1 — batch-check a whole phase) ─────────────────────

test("runPrepPhaseComplete: checks ONLY the not-yet-done steps (idempotent); one optimistic write, one invalidate", async () => {
  const h = makeHarness(completions([{ stepKey: "a", checkedAt: NOW }]));
  await runPrepPhaseComplete(h.deps, ["a", "b", "c"]);
  // 'a' is already checked → skipped; only 'b' and 'c' are written.
  assert.deepEqual(h.calls.check.slice().sort(), ["b", "c"]);
  assert.equal(h.calls.sets, 1, "the whole batch is ONE optimistic cache write");
  assert.equal(h.calls.invalidate, 1, "invalidated once after the batch (not per step)");
  assert.deepEqual(
    h.store()?.completions.map((r) => r.stepKey).sort(),
    ["a", "b", "c"],
  );
});

test("runPrepPhaseComplete: no-op when the whole phase is already checked (no write, no invalidate)", async () => {
  const h = makeHarness(
    completions([
      { stepKey: "a", checkedAt: NOW },
      { stepKey: "b", checkedAt: NOW },
    ]),
  );
  await runPrepPhaseComplete(h.deps, ["a", "b"]);
  assert.deepEqual(h.calls.check, []);
  assert.equal(h.calls.sets, 0, "nothing to write");
  assert.equal(h.calls.invalidate, 0, "no redundant refetch when nothing changed");
});

test("runPrepPhaseComplete: an empty phase (no steps) is a clean no-op", async () => {
  const h = makeHarness(completions([]));
  await runPrepPhaseComplete(h.deps, []);
  assert.deepEqual(h.calls.check, []);
  assert.equal(h.calls.invalidate, 0);
});

test("runPrepPhaseComplete: on ANY write failure it reverts the WHOLE batch, invalidates once, and rethrows", async () => {
  const h = makeHarness(completions([{ stepKey: "a", checkedAt: NOW }]), {
    failCheckKey: "c",
  });
  await assert.rejects(() => runPrepPhaseComplete(h.deps, ["a", "b", "c"]));
  // reverted to the pre-batch snapshot (only 'a' remains — 'b'/'c' rolled back)
  assert.deepEqual(
    h.store()?.completions.map((r) => r.stepKey),
    ["a"],
  );
  assert.equal(h.calls.invalidate, 1, "finally still reconciles to server truth");
});
