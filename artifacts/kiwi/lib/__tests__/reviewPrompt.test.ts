// 1.2-NATIVE C — when Kiwi asks for a store review.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  INITIAL_REVIEW_STATE,
  REVIEW_COOLDOWN_DAYS,
  REVIEW_NEW_ACCOUNT_DAYS,
  markReviewAsked,
  readReviewState,
  recordCookFinish,
  shouldAskForReview,
} from "../reviewPrompt.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-11-20T18:00:00.000Z");
const OLD_SIGNUP = new Date(NOW - 30 * DAY).toISOString();
const ask = (o: Partial<Parameters<typeof shouldAskForReview>[0]> = {}) =>
  shouldAskForReview({
    platform: "ios",
    state: { finishes: 2, lastAskedAt: null },
    signupAt: OLD_SIGNUP,
    now: NOW,
    ...o,
  });

test("the 2nd finish asks; the 1st does not; later ones do", () => {
  assert.equal(ask({ state: { finishes: 1, lastAskedAt: null } }), false);
  assert.equal(ask(), true);
  assert.equal(ask({ state: { finishes: 7, lastAskedAt: null } }), true);
  assert.equal(ask({ platform: "android" }), true);
});

test("at most once per 120 days", () => {
  assert.equal(ask({ state: { finishes: 5, lastAskedAt: NOW - (REVIEW_COOLDOWN_DAYS * DAY - 1) } }), false);
  assert.equal(ask({ state: { finishes: 5, lastAskedAt: NOW - REVIEW_COOLDOWN_DAYS * DAY } }), true);
});

test("never in the first 3 days after signup", () => {
  assert.equal(ask({ signupAt: new Date(NOW - (REVIEW_NEW_ACCOUNT_DAYS * DAY - 1)).toISOString() }), false);
  assert.equal(ask({ signupAt: new Date(NOW - REVIEW_NEW_ACCOUNT_DAYS * DAY).toISOString() }), true);
});

test("never on web, never without a member, never on an unreadable signup date", () => {
  assert.equal(ask({ platform: "web" }), false);
  assert.equal(ask({ signupAt: null }), false);
  assert.equal(ask({ signupAt: undefined }), false);
  assert.equal(ask({ signupAt: "not a date" }), false);
});

test("the stored state: counted, stamped, and read back from any shape", () => {
  const s1 = recordCookFinish(INITIAL_REVIEW_STATE);
  assert.deepEqual(s1, { finishes: 1, lastAskedAt: null });
  assert.deepEqual(markReviewAsked(recordCookFinish(s1), NOW), { finishes: 2, lastAskedAt: NOW });
  assert.deepEqual(readReviewState(null), INITIAL_REVIEW_STATE);
  assert.deepEqual(readReviewState({ finishes: "3", lastAskedAt: "x" }), INITIAL_REVIEW_STATE);
  assert.deepEqual(readReviewState({ finishes: 3.7, lastAskedAt: NOW }), { finishes: 3, lastAskedAt: NOW });
  assert.deepEqual(readReviewState({ finishes: -2 }), INITIAL_REVIEW_STATE);
});

test("the live half: expo-store-review only after the native check; Cook Mode passes the finish", () => {
  const live = readFileSync(new URL("../storeReview.ts", import.meta.url), "utf8");
  assert.doesNotMatch(live, /^import [^;]*from "expo-store-review"/m, "a top-level import throws on a 1.1 binary");
  assert.match(live, /if \(!hasNativeModule\("storeReview"\)\) return null;\s*try \{\s*return require\("expo-store-review"\)/);
  assert.match(live, /review\.isAvailableAsync\(\)/);
  assert.ok(live.indexOf("markReviewAsked(state, now)") < live.indexOf("review.requestReview()"), "stamped before asking");
  const route = readFileSync(new URL("../../app/cook-session.tsx", import.meta.url), "utf8");
  // CLIENT-3 C — the same finish also reports to the server (lib/cookFinished.ts).
  // CLIENT-4 D — through the session's once-guard (lib/cookFinished.ts makeCookFinish).
  assert.match(route, /onLeaveAfterLastStep=\{\(\) => \{\s*void noteCookFinished\(signupAt\);\s*finishCook\(finishInput\);/);
  assert.match(route, /const signupAt = useAuth\(\)\.user\?\.createdAt \?\? null;/);
});
