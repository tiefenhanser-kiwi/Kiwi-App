// WS7-5b-mobile Block B — tests for the wizard-entry resume decision.
//
// The helper drives whether the wizard inputs render immediately or are
// gated by an interstitial — these tests pin the three branches (none /
// single / multi) and the load-bearing "trust server sort" invariant.

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideWizardResumeUi } from "../resumeUi";
import type { WizardDraftSummary } from "../../api/wizard";

const D = (id: string, createdAt: string): WizardDraftSummary => ({
  id,
  title: `Plan ${id}`,
  createdAt,
  mealTitles: [`Meal A for ${id}`, `Meal B for ${id}`],
});

// ── none ──────────────────────────────────────────────────────────────

test("decideWizardResumeUi returns kind=none when no drafts (no interstitial)", () => {
  const decision = decideWizardResumeUi([]);
  assert.equal(decision.kind, "none");
});

// ── single ────────────────────────────────────────────────────────────

test("decideWizardResumeUi returns kind=single with the only draft when exactly one", () => {
  const draft = D("d1", "2026-05-29T12:00:00.000Z");
  const decision = decideWizardResumeUi([draft]);
  assert.equal(decision.kind, "single");
  if (decision.kind === "single") {
    assert.equal(decision.draft.id, "d1");
  }
});

// ── multi ─────────────────────────────────────────────────────────────

test("decideWizardResumeUi returns kind=multi with primary=most-recent + others=rest when ≥2", () => {
  // Server returns createdAt-desc; helper trusts that order. drafts[0] is
  // the most recent — primary. The rest go into others in the same order.
  const newest = D("d-new", "2026-05-29T12:00:00.000Z");
  const middle = D("d-mid", "2026-05-28T12:00:00.000Z");
  const oldest = D("d-old", "2026-05-27T12:00:00.000Z");
  const decision = decideWizardResumeUi([newest, middle, oldest]);
  assert.equal(decision.kind, "multi");
  if (decision.kind === "multi") {
    assert.equal(decision.primary.id, "d-new");
    assert.equal(decision.others.length, 2);
    assert.equal(decision.others[0].id, "d-mid");
    assert.equal(decision.others[1].id, "d-old");
  }
});

test("decideWizardResumeUi multi: primary is excluded from others (no duplicate render)", () => {
  const a = D("d-a", "2026-05-29T12:00:00.000Z");
  const b = D("d-b", "2026-05-28T12:00:00.000Z");
  const decision = decideWizardResumeUi([a, b]);
  assert.equal(decision.kind, "multi");
  if (decision.kind === "multi") {
    assert.equal(
      decision.others.find((d) => d.id === decision.primary.id),
      undefined,
      "primary must not also appear in others — the UI would render it twice",
    );
  }
});

// ── trust-server-sort invariant ───────────────────────────────────────

test("decideWizardResumeUi: primary is drafts[0] even if createdAt values say otherwise (trust server sort)", () => {
  // The server's findMany is the sort authority. If the contract drifts, we
  // want this test to FAIL loudly so the regression surfaces — re-sorting on
  // the client would silently mask it. We pass an intentionally mis-ordered
  // array (oldest first) and assert the helper still treats drafts[0] as
  // primary. If a future change adds a client-side sort, this test breaks
  // and forces a deliberate decision.
  const olderInArrayHead = D("d-old", "2026-05-01T00:00:00.000Z");
  const newerInArrayTail = D("d-new", "2026-05-29T12:00:00.000Z");
  const decision = decideWizardResumeUi([
    olderInArrayHead,
    newerInArrayTail,
  ]);
  assert.equal(decision.kind, "multi");
  if (decision.kind === "multi") {
    assert.equal(decision.primary.id, "d-old");
  }
});
