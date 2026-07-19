// Plan-Gen Arc · Block 3 (R1) — materializeMeal ownership/visibility resolution.
//
// Proves the ADDITIVE-DEFAULT contract without a DB tx: a call WITHOUT a target
// resolves to the exact pre-Block-3 behavior (caller-owned, private, payload
// sourceType), and a call WITH a target resolves to the store-pool shape. The
// full graph write for existing callers is covered unchanged by the route
// integration tests (me-meals-dishes, wizardActivation, etc.); this pins the
// one new branch point.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveMaterializeOwnership } from "../mealMaterialize";

describe("resolveMaterializeOwnership — additive default (R1)", () => {
  it("NO target → legacy: caller-owned, private, payload sourceType", () => {
    const r = resolveMaterializeOwnership("user-123", "wizard", undefined);
    assert.deepEqual(r, {
      ownerUserId: "user-123",
      isPublic: false,
      sourceType: "wizard",
    });
  });

  it("NO target + undefined payload sourceType → defaults to 'manual' (legacy)", () => {
    const r = resolveMaterializeOwnership("user-123", undefined, undefined);
    assert.deepEqual(r, {
      ownerUserId: "user-123",
      isPublic: false,
      sourceType: "manual",
    });
  });

  it("WITH target → store-pool shape: userId:null, isPublic:true, batch_generated", () => {
    const r = resolveMaterializeOwnership("user-123", "wizard", {
      userId: null,
      isPublic: true,
      sourceType: "batch_generated",
    });
    assert.deepEqual(r, {
      ownerUserId: null,
      isPublic: true,
      sourceType: "batch_generated",
    });
  });

  it("target overrides the payload sourceType (target wins)", () => {
    const r = resolveMaterializeOwnership("user-123", "curated", {
      userId: null,
      isPublic: true,
      sourceType: "batch_generated",
    });
    assert.equal(r.sourceType, "batch_generated");
  });
});
