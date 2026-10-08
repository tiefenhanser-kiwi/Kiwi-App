// Row 13 "Test Kitchen" · Block 2 Part B — the entry's decisions (R2).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GUEST_EXPIRY_MARGIN_MS,
  deriveGuestEntryAction,
  deriveGuestStage,
  guestGenerationSpent,
  guestSessionUsable,
} from "../guestSession";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const creds = (expiresAt: string) => ({
  guestSessionId: "gs_1",
  token: "t",
  expiresAt,
});

test("no stored session → create", () => {
  assert.equal(deriveGuestEntryAction(null, NOW), "create");
});

test("a session with hours left → resume", () => {
  assert.equal(
    deriveGuestEntryAction(creds("2026-09-27T20:00:00.000Z"), NOW),
    "resume",
  );
});

test("an expired session → create, never resume", () => {
  assert.equal(
    deriveGuestEntryAction(creds("2026-09-27T11:59:00.000Z"), NOW),
    "create",
  );
});

test("inside the expiry margin → create; the next call is a generate that outlives it", () => {
  const justInside = new Date(NOW + GUEST_EXPIRY_MARGIN_MS - 1).toISOString();
  const justOutside = new Date(NOW + GUEST_EXPIRY_MARGIN_MS + 1).toISOString();
  assert.equal(guestSessionUsable(creds(justInside), NOW), false);
  assert.equal(guestSessionUsable(creds(justOutside), NOW), true);
});

test("an unparseable expiry is not a reason to trust the token", () => {
  assert.equal(guestSessionUsable(creds("whenever"), NOW), false);
  assert.equal(guestSessionUsable(creds(""), NOW), false);
});

// ── the stage ──────────────────────────────────────────────────────────

test("a fresh session lands on the wizard", () => {
  assert.equal(
    deriveGuestStage({ generationCount: 0, hasDraft: false, candidates: null }),
    "wizard",
  );
});

test("candidates but no draft → the options screen", () => {
  assert.equal(
    deriveGuestStage({ generationCount: 1, hasDraft: false, candidates: [{}, {}] }),
    "options",
  );
});

test("a draft wins over candidates — the furthest point they reached", () => {
  assert.equal(
    deriveGuestStage({ generationCount: 1, hasDraft: true, candidates: [{}] }),
    "plan",
  );
});

test("an EMPTY candidates array is not 'options' — a generation that produced nothing", () => {
  assert.equal(
    deriveGuestStage({ generationCount: 1, hasDraft: false, candidates: [] }),
    "wizard",
  );
});

test("the one-generation rule turns on generationCount, not on candidates", () => {
  assert.equal(guestGenerationSpent({ generationCount: 0 }), false);
  assert.equal(guestGenerationSpent({ generationCount: 1 }), true);
  assert.equal(guestGenerationSpent({ generationCount: 3 }), true);
});

// Resub C4 — a picks-made session: plan-from-picks writes the draft and spends
// the generation, and never writes candidates (null, not []).
test("C4: a picks session (draft, no candidates) resumes to the plan — never the options stage", () => {
  const picks = { generationCount: 1, hasDraft: true, candidates: null };
  assert.equal(deriveGuestStage(picks), "plan");
  assert.equal(guestGenerationSpent(picks), true);
});
