// WS9 BUG-134 — GUARD: the ingredient repoint must never create a second row
// in a bucket that already holds one.
//
// THE RISK THIS COVERS: `GroceryListItem` carries only a PK on `id` and two
// FKs — no `@@unique`, no `@@index` at all (verified against pg_indexes, not
// just the PSL). So nothing in Postgres objects when a repoint lands two rows
// on one `(groceryListId, ingredientId, unit)`. That is exactly what BUG-096's
// bare `updateMany` did: 8 groups across 6 lists. And no unique index can ever
// be added to catch it, because that tuple is legitimately non-unique in the
// domain — user "Extras" and recurring items are separate rows the user added
// deliberately (ruled; D-WS9-183). The planner IS the constraint.
//
// TWO INDEPENDENT FAILURE MODES, asserted separately on purpose:
//   (a) the bucket check itself — remove it and duplicates reappear;
//   (b) the SUM — swap it for a max and NO duplicate appears, the row count is
//       perfect, and the user is simply told to buy too little.
// A test suite that only catches (a) is not pinning the semantics. (b) is the
// one that matters more: under-ordering is the ruled-worst failure here.
//
// FIXTURE STRENGTH: ids are real uuids whose lexical order is deliberately NOT
// the array order, so a planner that "sorted" by accepting input order passes
// nothing. Quantities are distinct primes-ish values and every expectation is
// written as a LITERAL, never as `a.quantity + b.quantity` — an expectation
// derived from the same inputs the code reads moves when the code moves and
// pins nothing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  planGroceryBucketMerges,
  type GroceryRowLike,
} from "../ingredientMergeCarriers";

const LOSER = "11111111-1111-4111-8111-111111111111";
const LOSER_B = "22222222-2222-4222-8222-222222222222";
const SURVIVOR = "99999999-9999-4999-8999-999999999999";
const LIST_A = "aaaaaaaa-0000-4000-8000-000000000001";
const LIST_B = "bbbbbbbb-0000-4000-8000-000000000002";

const SURV_MAP = new Map([[LOSER, SURVIVOR]]);

function row(over: Partial<GroceryRowLike> & { id: string }): GroceryRowLike {
  return {
    groceryListId: LIST_A,
    ingredientId: LOSER,
    unit: "each",
    quantity: 1,
    isUserAdded: false,
    deletedAt: null,
    ...over,
  };
}

describe("BUG-134 planGroceryBucketMerges — occupied destination", () => {
  it("MERGES instead of repointing when the survivor already holds the bucket", () => {
    // The live `lime` shape: survivor-side row qty 7, loser-side row qty 2.
    const survivorSide = row({ id: "d0000000-0000-4000-8000-00000000000a", ingredientId: SURVIVOR, quantity: 7 });
    const loserSide = row({ id: "e0000000-0000-4000-8000-00000000000b", quantity: 2 });

    const plan = planGroceryBucketMerges([survivorSide, loserSide], SURV_MAP);

    assert.equal(plan.merges.length, 1, "the occupied bucket must produce a merge");
    assert.deepEqual(plan.repointIds, [], "an absorbed row must NOT also be repointed");
    const m = plan.merges[0]!;
    assert.equal(m.keepId, survivorSide.id, "the occupant keeps — that is what carries the survivor pack");
    assert.equal(m.absorbId, loserSide.id);
    // LITERAL 9. Not `7 + 2`, and not read back off the fixtures.
    assert.equal(m.mergedQuantity, 9, "quantities SUM; a max would give 7 and under-order");
    assert.equal(m.ingredientId, SURVIVOR, "the merge is recorded against the DESTINATION id");
    assert.equal(m.unit, "each");
    assert.equal(m.groceryListId, LIST_A);
  });

  it("repoints normally when the bucket is free", () => {
    const loserSide = row({ id: "e0000000-0000-4000-8000-00000000000b", quantity: 4 });
    const plan = planGroceryBucketMerges([loserSide], SURV_MAP);
    assert.deepEqual(plan.repointIds, [loserSide.id]);
    assert.equal(plan.merges.length, 0);
  });

  it("does NOT merge across a different unit", () => {
    const survivorSide = row({ id: "d0000000-0000-4000-8000-00000000000a", ingredientId: SURVIVOR, unit: "clove", quantity: 7 });
    const loserSide = row({ id: "e0000000-0000-4000-8000-00000000000b", unit: "each", quantity: 2 });
    const plan = planGroceryBucketMerges([survivorSide, loserSide], SURV_MAP);
    assert.equal(plan.merges.length, 0, "unit is part of the bucket key");
    assert.deepEqual(plan.repointIds, [loserSide.id]);
  });

  it("does NOT merge across a different list", () => {
    const survivorSide = row({ id: "d0000000-0000-4000-8000-00000000000a", ingredientId: SURVIVOR, groceryListId: LIST_B, quantity: 7 });
    const loserSide = row({ id: "e0000000-0000-4000-8000-00000000000b", groceryListId: LIST_A, quantity: 2 });
    const plan = planGroceryBucketMerges([survivorSide, loserSide], SURV_MAP);
    assert.equal(plan.merges.length, 0, "groceryListId is part of the bucket key");
    assert.deepEqual(plan.repointIds, [loserSide.id]);
  });

  it("sums a THIRD row into the same bucket with a running total", () => {
    // Two distinct losers folding onto one survivor, plus the survivor's own row.
    const map = new Map([[LOSER, SURVIVOR], [LOSER_B, SURVIVOR]]);
    const survivorSide = row({ id: "a0000000-0000-4000-8000-00000000000a", ingredientId: SURVIVOR, quantity: 3 });
    const first = row({ id: "b0000000-0000-4000-8000-00000000000b", ingredientId: LOSER, quantity: 6 });
    const second = row({ id: "c0000000-0000-4000-8000-00000000000c", ingredientId: LOSER_B, quantity: 10 });

    const plan = planGroceryBucketMerges([survivorSide, first, second], map);

    assert.equal(plan.merges.length, 2);
    assert.deepEqual(plan.repointIds, [], "neither absorbed row may be repointed");
    // Applied IN ORDER the keeper ends at 19. Literals, not arithmetic.
    assert.equal(plan.merges[0]!.mergedQuantity, 9);
    assert.equal(plan.merges[1]!.mergedQuantity, 19);
    assert.equal(plan.merges[0]!.keepId, survivorSide.id);
    assert.equal(plan.merges[1]!.keepId, survivorSide.id, "the second absorb targets the SAME keeper, not the first absorbed row");
  });

  it("picks a keeper deterministically when only loser-side rows collide", () => {
    // No survivor-side row at all: two loser rows land in one empty bucket.
    const later = row({ id: "f0000000-0000-4000-8000-0000000000ff", quantity: 5 });
    const earlier = row({ id: "10000000-0000-4000-8000-000000000011", quantity: 8 });

    const forward = planGroceryBucketMerges([later, earlier], SURV_MAP);
    const reversed = planGroceryBucketMerges([earlier, later], SURV_MAP);

    assert.deepEqual(forward.repointIds, [earlier.id], "the lexically lower id claims the bucket");
    assert.equal(forward.merges[0]!.keepId, earlier.id);
    assert.equal(forward.merges[0]!.absorbId, later.id);
    assert.equal(forward.merges[0]!.mergedQuantity, 13);
    // Input order must not change the outcome.
    assert.deepEqual(reversed.repointIds, forward.repointIds);
    assert.deepEqual(reversed.merges, forward.merges);
  });
});

describe("BUG-134 planGroceryBucketMerges — exemptions (ruled legal, D-WS9-183)", () => {
  it("never absorbs a USER-ADDED row — it repoints unmerged", () => {
    // The live `lemon` shape: a generated row beside a user-entered one.
    const generated = row({ id: "d0000000-0000-4000-8000-00000000000a", ingredientId: SURVIVOR, quantity: 5.5 });
    const userAdded = row({ id: "e0000000-0000-4000-8000-00000000000b", quantity: 1, isUserAdded: true });

    const plan = planGroceryBucketMerges([generated, userAdded], SURV_MAP);

    assert.equal(plan.merges.length, 0, "a user's own row is not the merge's to absorb");
    assert.deepEqual(plan.repointIds, [userAdded.id]);
    assert.deepEqual(plan.exempt, [{ id: userAdded.id, reason: "user-added" }]);
  });

  it("a USER-ADDED occupant does not block a real merge", () => {
    // The trap: if exempt rows counted as occupancy, the user's row would
    // deflect the genuine collision and the duplicate would survive.
    const userAdded = row({ id: "a0000000-0000-4000-8000-00000000000a", ingredientId: SURVIVOR, quantity: 1, isUserAdded: true });
    const generatedSurvivor = row({ id: "b0000000-0000-4000-8000-00000000000b", ingredientId: SURVIVOR, quantity: 7 });
    const loserSide = row({ id: "c0000000-0000-4000-8000-00000000000c", quantity: 2 });

    const plan = planGroceryBucketMerges([userAdded, generatedSurvivor, loserSide], SURV_MAP);

    assert.equal(plan.merges.length, 1);
    assert.equal(plan.merges[0]!.keepId, generatedSurvivor.id, "the GENERATED occupant keeps, not the user's row");
    assert.equal(plan.merges[0]!.mergedQuantity, 9);
  });

  it("never absorbs a SOFT-DELETED row — restore reuses that id (D-WS6-082)", () => {
    const generated = row({ id: "d0000000-0000-4000-8000-00000000000a", ingredientId: SURVIVOR, quantity: 7 });
    const deleted = row({ id: "e0000000-0000-4000-8000-00000000000b", quantity: 2, deletedAt: new Date("2026-08-01T00:00:00Z") });

    const plan = planGroceryBucketMerges([generated, deleted], SURV_MAP);

    assert.equal(plan.merges.length, 0);
    assert.deepEqual(plan.repointIds, [deleted.id]);
    assert.deepEqual(plan.exempt, [{ id: deleted.id, reason: "soft-deleted" }]);
  });

  it("a SOFT-DELETED occupant does not block a real merge either", () => {
    const deletedOccupant = row({ id: "a0000000-0000-4000-8000-00000000000a", ingredientId: SURVIVOR, quantity: 99, deletedAt: new Date("2026-08-01T00:00:00Z") });
    const generatedSurvivor = row({ id: "b0000000-0000-4000-8000-00000000000b", ingredientId: SURVIVOR, quantity: 7 });
    const loserSide = row({ id: "c0000000-0000-4000-8000-00000000000c", quantity: 2 });

    const plan = planGroceryBucketMerges([deletedOccupant, generatedSurvivor, loserSide], SURV_MAP);

    assert.equal(plan.merges.length, 1);
    assert.equal(plan.merges[0]!.keepId, generatedSurvivor.id);
    assert.equal(plan.merges[0]!.mergedQuantity, 9, "the soft-deleted row's 99 must not enter the sum");
  });
});
