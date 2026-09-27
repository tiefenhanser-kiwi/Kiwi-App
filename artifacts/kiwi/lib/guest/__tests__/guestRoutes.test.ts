// Row 13 "Test Kitchen" · Block 2 Part B — the guest allowlist.
//
// Why this is a test and not a code review: a guest token on a requireAuth route
// is a MEASURED 401 (middleware/auth.ts's verifyToken(token, "session") refuses
// the purpose claim before any DB read), and an authenticated 401 is what
// lib/api/client.ts reads as "your session died". So a path slipping onto this
// list is not a 403 the UI can shrug off — it evicts a visitor who never signed
// in. The list is pinned member-route by member-route below.

import assert from "node:assert/strict";
import { test } from "node:test";

import { isGuestAllowedPath } from "../guestRoutes";

test("the five exact guest routes are allowed", () => {
  for (const p of [
    "/guest/session",
    "/guest/draft",
    "/guest/events",
    "/wizard/build-plans",
    "/wizard/expand",
  ]) {
    assert.equal(isGuestAllowedPath(p), true, p);
  }
});

test("GET /meals/:id is allowed, with or without a query string", () => {
  assert.equal(isGuestAllowedPath("/meals/abc123"), true);
  assert.equal(isGuestAllowedPath("/meals/abc123?planItemId=xyz"), true);
});

test("the meal LIST is member-only — /meals is requireAuth on the server", () => {
  assert.equal(isGuestAllowedPath("/meals"), false);
  assert.equal(isGuestAllowedPath("/meals/"), false);
  assert.equal(isGuestAllowedPath("/meals?filter=featured"), false);
});

test("a deeper meal path is not the detail route", () => {
  assert.equal(isGuestAllowedPath("/meals/abc/dishes"), false);
});

test("every OTHER wizard route is member-only — each one is a write-shaped door", () => {
  for (const p of [
    "/wizard/shelf",
    "/wizard/limits",
    "/wizard/last-batch",
    "/wizard/drafts",
    "/wizard/drafts/d1",
    "/wizard/drafts/d1/save",
    "/wizard/drafts/d1/activate",
    "/wizard/drafts/d1/dismiss",
    "/wizard/candidates/dismiss",
    "/wizard/build-from-text",
  ]) {
    assert.equal(isGuestAllowedPath(p), false, p);
  }
});

test("the member surfaces a guest CTA could reach are all refused", () => {
  for (const p of [
    "/me/preferences",
    "/me/ui-state",
    "/me/favorites",
    "/me/meals",
    "/home",
    "/home/rail",
    "/plans",
    "/plans/p1",
    "/playlist",
    "/grocery-lists",
    "/auth/me",
    "/cooking/prep-week",
  ]) {
    assert.equal(isGuestAllowedPath(p), false, p);
  }
});

test("an unknown route is member-only — the list is an allowlist, not a denylist", () => {
  assert.equal(isGuestAllowedPath("/something/invented/next/quarter"), false);
  assert.equal(isGuestAllowedPath("/"), false);
});
