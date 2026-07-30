// WS9 3d Part 3b-1 (D-WS9-013) — dietary-staleness decision boundary tests.
// The rule moved server-side; these pin it: fires only when a dietary edit
// post-dates the commit, silent on drafts, silent on null commit.

import assert from "node:assert/strict";
import { test } from "node:test";

import { computeDietaryStale } from "../planStaleness";

const commit = new Date("2026-07-01T00:00:00.000Z");

test("stale when the dietary edit post-dates the commit", () => {
  assert.equal(
    computeDietaryStale({
      isWizardDraft: false,
      committedAt: commit,
      dietaryUpdatedAt: new Date("2026-07-10T00:00:00.000Z"),
    }),
    true,
  );
});

test("not stale when the dietary edit predates the commit", () => {
  assert.equal(
    computeDietaryStale({
      isWizardDraft: false,
      committedAt: commit,
      dietaryUpdatedAt: new Date("2026-06-01T00:00:00.000Z"),
    }),
    false,
  );
});

test("never stale on a wizard draft, even with a newer dietary edit", () => {
  assert.equal(
    computeDietaryStale({
      isWizardDraft: true,
      committedAt: commit,
      dietaryUpdatedAt: new Date("2026-07-10T00:00:00.000Z"),
    }),
    false,
  );
});

test("not stale when committedAt is null (pre-migration row → silent)", () => {
  assert.equal(
    computeDietaryStale({
      isWizardDraft: false,
      committedAt: null,
      dietaryUpdatedAt: new Date("2026-07-10T00:00:00.000Z"),
    }),
    false,
  );
});

test("not stale when the user has no recorded dietary edit", () => {
  assert.equal(
    computeDietaryStale({
      isWizardDraft: false,
      committedAt: commit,
      dietaryUpdatedAt: null,
    }),
    false,
  );
});
