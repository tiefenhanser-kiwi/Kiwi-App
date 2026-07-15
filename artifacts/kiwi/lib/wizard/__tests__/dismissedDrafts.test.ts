// BUG-023 (WS9 3c) — tests for the dismissed resume-draft set helpers.
//
// The bug was that a dismissed draft re-surfaced the "pick up where you left
// off?" interstitial after the user had moved on. These tests pin the three
// set operations that make dismissal stick across remounts while keeping the
// persisted set bounded and letting genuinely-new drafts still resume.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addDismissed,
  pruneDismissed,
  visibleDrafts,
} from "../dismissedDrafts";
import type { WizardDraftSummary } from "../../api/wizard";

const D = (id: string): WizardDraftSummary => ({
  id,
  title: `Plan ${id}`,
  createdAt: "2026-07-14T12:00:00.000Z",
  mealTitles: [`Meal A for ${id}`],
});

// ── visibleDrafts ───────────────────────────────────────────────────────

test("visibleDrafts hides dismissed ids and preserves server order", () => {
  const drafts = [D("a"), D("b"), D("c")];
  const visible = visibleDrafts(drafts, ["b"]);
  assert.deepEqual(
    visible.map((d) => d.id),
    ["a", "c"],
    "dismissed 'b' is filtered; a and c keep their order",
  );
});

test("visibleDrafts returns all drafts when none dismissed", () => {
  const drafts = [D("a"), D("b")];
  assert.equal(visibleDrafts(drafts, []).length, 2);
});

test("visibleDrafts: a fully-dismissed list yields no interstitial (empty)", () => {
  // The core BUG-023 case: the user dismissed these exact drafts on a prior
  // entry, so on remount the interstitial must NOT show them again.
  const drafts = [D("a"), D("b")];
  assert.equal(visibleDrafts(drafts, ["a", "b"]).length, 0);
});

test("visibleDrafts: a NEW draft not in the dismissed set still surfaces", () => {
  // Dismissal is per-draft, not a blanket "never show the interstitial" — a
  // draft created after the dismissal must still be resumable.
  const drafts = [D("a"), D("new")];
  const visible = visibleDrafts(drafts, ["a"]);
  assert.deepEqual(
    visible.map((d) => d.id),
    ["new"],
  );
});

// ── addDismissed ────────────────────────────────────────────────────────

test("addDismissed unions new ids without duplicating existing ones", () => {
  assert.deepEqual(addDismissed(["a"], ["a", "b"]).sort(), ["a", "b"]);
});

test("addDismissed on an empty set seeds it with the newly-dismissed ids", () => {
  assert.deepEqual(addDismissed([], ["a", "b"]).sort(), ["a", "b"]);
});

// ── pruneDismissed ──────────────────────────────────────────────────────

test("pruneDismissed drops ids the server no longer lists (swept / activated)", () => {
  // 'gone' was dismissed earlier but the server has since swept it; prune it so
  // the persisted set stays bounded.
  assert.deepEqual(pruneDismissed(["keep", "gone"], ["keep", "other"]), [
    "keep",
  ]);
});

test("pruneDismissed returns the SAME reference when nothing changed (skip write)", () => {
  const ids = ["a", "b"];
  assert.equal(
    pruneDismissed(ids, ["a", "b", "c"]),
    ids,
    "unchanged → same reference so the caller can skip a needless persist",
  );
});
