// BUG-104 — the optimistic plan-write runner.
//
// These pin the ORDERING that closes the write-clobber race. The runner is
// pure + dep-injected, so the whole sequence is driven with fakes and no
// QueryClient: cancel-before-optimism, rollback-on-failure, and — the subtle
// half — deferring the invalidation until the LAST concurrent write settles.
//
// The deferral is the part that is easy to get wrong and impossible to see:
// cancelQueries alone kills the GET in flight when a write STARTS, but each
// write's own success invalidation starts a fresh refetch that can resolve
// mid-burst carrying pre-sibling state.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PlanDetail } from "@/lib/api/plans";

import { applyToDetail, runPlanWrite, type PlanWriteDeps } from "../planWriteRunner";

// ── Fake cache ────────────────────────────────────────────────────────────

interface Harness {
  deps: PlanWriteDeps;
  /** Every call, in order, so ORDER is assertable and not just occurrence. */
  log: string[];
  cache: { current: PlanDetail | undefined };
  depth: () => number;
}

function makeDetail(name: string): PlanDetail {
  return {
    id: "plan-1",
    name,
    status: "active",
    startDate: null,
    endDate: null,
    revisionId: 1,
    isActiveThisWeek: false,
    userId: "u-1",
    sourceType: "manual",
    prepStatus: "not_prepped",
    prepStatusIsManual: false,
    optimizationNotes: [],
    breakfastOverrides: "",
    lunchOverrides: "",
    items: [],
    macroDailyAverage: {
      caloriesPerDay: null,
      proteinGPerDay: null,
      carbsGPerDay: null,
      fatGPerDay: null,
    },
  };
}

// NOTE: no default value. An explicit `makeHarness(undefined)` must really mean
// "nothing cached" — a default parameter would silently substitute a real
// PlanDetail and the empty-cache tests would pass for the wrong reason.
function makeHarness(seed: PlanDetail | undefined): Harness {
  const log: string[] = [];
  const cache = { current: seed };
  let depth = 0;
  const deps: PlanWriteDeps = {
    cancel: () => {
      log.push("cancel");
    },
    getDetail: () => {
      log.push("get");
      return cache.current;
    },
    setDetail: (next) => {
      log.push(`set:${next?.name ?? "undefined"}`);
      cache.current = next;
    },
    invalidate: () => {
      log.push("invalidate");
    },
    beginWrite: () => {
      depth += 1;
      log.push(`begin:${depth}`);
      return depth;
    },
    endWrite: () => {
      depth = Math.max(0, depth - 1);
      log.push(`end:${depth}`);
      return depth;
    },
  };
  return { deps, log, cache, depth: () => depth };
}

const rename = (to: string) => (prev: PlanDetail): PlanDetail => ({
  ...prev,
  name: to,
});

// ── Ordering ──────────────────────────────────────────────────────────────

test("BUG-104: cancel runs BEFORE the snapshot and the optimistic write", async () => {
  const h = makeHarness(makeDetail("seed"));
  await runPlanWrite(h.deps, rename("optimistic"), async () => "ok");

  const cancelAt = h.log.indexOf("cancel");
  const getAt = h.log.indexOf("get");
  const setAt = h.log.findIndex((e) => e.startsWith("set:"));
  assert.ok(cancelAt >= 0, "cancel must be called");
  assert.ok(
    cancelAt < getAt && cancelAt < setAt,
    `cancel must precede snapshot+optimism, got: ${h.log.join(" → ")}. A GET still in flight when the optimistic write lands will overwrite it.`,
  );
});

test("BUG-104: a successful write leaves the optimistic value in the cache and invalidates once", async () => {
  const h = makeHarness(makeDetail("seed"));
  const result = await runPlanWrite(h.deps, rename("optimistic"), async () => 42);

  assert.equal(result, 42, "the write's resolved value reaches the caller");
  assert.equal(h.cache.current?.name, "optimistic");
  assert.equal(h.log.filter((e) => e === "invalidate").length, 1);
  assert.equal(h.depth(), 0, "the depth must drain");
});

test("BUG-104: a FAILED write rolls the cache back to the pre-write snapshot and rethrows", async () => {
  const h = makeHarness(makeDetail("before"));
  await assert.rejects(
    () =>
      runPlanWrite(h.deps, rename("optimistic"), async () => {
        throw new Error("PATCH failed");
      }),
    /PATCH failed/,
    "the rejection must reach the caller — swallowing it is BUG-112",
  );
  assert.equal(
    h.cache.current?.name,
    "before",
    "the optimistic edit must not survive a failed write",
  );
  assert.equal(
    h.log.filter((e) => e === "invalidate").length,
    1,
    "a rolled-back write still reconciles with the server",
  );
  assert.equal(h.depth(), 0, "the depth must drain even on the failure path");
});

test("BUG-104: an undefined cache (nothing fetched yet) still runs the write and does not throw", async () => {
  const h = makeHarness(undefined);
  const out = await runPlanWrite(h.deps, rename("optimistic"), async () => "ok");
  assert.equal(out, "ok");
  assert.equal(
    h.log.filter((e) => e.startsWith("set:")).length,
    0,
    "no snapshot means nothing to apply optimism to — and nothing to roll back",
  );
});

// ── The deferral (the half cancelQueries does not cover) ───────────────────

test("BUG-104 BURST LOCK: two overlapping writes invalidate ONCE, when the last one settles", async () => {
  // This is the exact shape of the reported bug. Pre-fix, write A's success
  // invalidation started a refetch that resolved carrying post-A/pre-B state
  // and reverted B. The depth counter defers every invalidation until the
  // burst drains, so the burst costs exactly one refetch and it happens after
  // BOTH writes are known to the server.
  const h = makeHarness(makeDetail("seed"));
  let releaseA!: () => void;
  let releaseB!: () => void;
  const a = new Promise<void>((r) => {
    releaseA = r;
  });
  const b = new Promise<void>((r) => {
    releaseB = r;
  });

  const pA = runPlanWrite(h.deps, rename("A"), async () => {
    await a;
    return "a";
  });
  const pB = runPlanWrite(h.deps, rename("B"), async () => {
    await b;
    return "b";
  });

  releaseA();
  await pA;
  assert.equal(
    h.log.filter((e) => e === "invalidate").length,
    0,
    "write A must NOT invalidate while write B is still in flight — that refetch is exactly what reverted B",
  );

  releaseB();
  await pB;
  assert.equal(
    h.log.filter((e) => e === "invalidate").length,
    1,
    "exactly one invalidation for the whole burst, after the last write settles",
  );
});

test("BUG-104 BURST LOCK: a FAILING write inside a burst still defers, and the burst invalidates once", async () => {
  const h = makeHarness(makeDetail("seed"));
  let releaseB!: () => void;
  const b = new Promise<void>((r) => {
    releaseB = r;
  });

  const pA = runPlanWrite(h.deps, rename("A"), async () => {
    throw new Error("A failed");
  }).catch(() => "handled");
  const pB = runPlanWrite(h.deps, rename("B"), async () => {
    await b;
    return "b";
  });

  await pA;
  assert.equal(
    h.log.filter((e) => e === "invalidate").length,
    0,
    "a failure mid-burst must not start a refetch either",
  );
  releaseB();
  await pB;
  assert.equal(h.log.filter((e) => e === "invalidate").length, 1);
  assert.equal(h.depth(), 0);
});

// ── patchCache ────────────────────────────────────────────────────────────

test("BUG-104: applyToDetail patches the cache outside the rollback window (Change Meal id repoint)", () => {
  const h = makeHarness(makeDetail("before"));
  applyToDetail(h.deps, rename("repointed"));
  assert.equal(h.cache.current?.name, "repointed");
});

test("BUG-104: applyToDetail is a no-op when nothing is cached", () => {
  const h = makeHarness(undefined);
  applyToDetail(h.deps, rename("repointed"));
  assert.equal(h.cache.current, undefined);
});
