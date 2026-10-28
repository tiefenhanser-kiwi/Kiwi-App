// CLIENT-3 C (LIFE-2 #9) — Cook Mode's finish reaches POST /me/activity/cook-finished:
// a signed-in member's meal cook only, never awaited, a failure dropped.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import {
  advanceFinishes,
  cookFinishedBody,
  makeCookFinish,
  onLastLiveStep,
  reportCookFinished,
  type CookFinishedInput,
} from "../cookFinished";
import type { CookStep } from "../cooking/cookSession";
import { postCookFinished } from "../api/me";
import { __resetForTests as resetAuthBridge } from "../api/auth-bridge";

const BASE: CookFinishedInput = { signedIn: true, isGuest: false, mealId: "m1", dishId: "", planItemId: "" };

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

test("C: a member's meal cook sends { mealId }, with planItemId from a plan", () => {
  assert.deepEqual(cookFinishedBody(BASE), { mealId: "m1" });
  assert.deepEqual(cookFinishedBody({ ...BASE, planItemId: "pi1" }), { mealId: "m1", planItemId: "pi1" });
});

test("C: never for a guest or without a session; never for a lone dish or a plan dish run", () => {
  assert.equal(cookFinishedBody({ ...BASE, signedIn: false }), null);
  assert.equal(cookFinishedBody({ ...BASE, isGuest: true }), null);
  assert.equal(cookFinishedBody({ ...BASE, mealId: "", dishId: "d1" }), null);
  assert.equal(cookFinishedBody({ ...BASE, dishId: "d1", planItemId: "pi1" }), null);
});

test("C: fire-and-forget: returns at once, a rejected POST is dropped", async () => {
  const sent: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ret = reportCookFinished({ ...BASE, planItemId: "pi1" }, async (body) => {
    sent.push(body);
    await gate;
    throw new Error("404");
  });
  assert.equal(ret, undefined, "nothing for the screen to await");
  assert.deepEqual(sent, [{ mealId: "m1", planItemId: "pi1" }]);
  release();
  await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run
  reportCookFinished({ ...BASE, isGuest: true }, async (body) => {
    sent.push(body);
  });
  assert.equal(sent.length, 1, "a guest sends nothing");
});

test("C: the wire: POST /me/activity/cook-finished with the body, { recorded } parsed", async () => {
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests("kiwi_authToken", "t");
  resetAuthBridge();
  let seen: { url: string; method?: string; body?: string } | null = null;
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    seen = { url, method: init?.method, body: init?.body };
    return new Response(JSON.stringify({ recorded: true }), { status: 201, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  await postCookFinished({ mealId: "m1", planItemId: "pi1" });
  const s = seen as { url: string; method?: string; body?: string } | null;
  assert.ok(s?.url.endsWith("/me/activity/cook-finished"), s?.url);
  assert.equal(s?.method, "POST");
  assert.deepEqual(JSON.parse(s?.body ?? "{}"), { mealId: "m1", planItemId: "pi1" });
});

test("C: Cook Mode sends it from onLeaveAfterLastStep, beside the review prompt, from the route's own params", () => {
  const route = readFileSync(new URL("../../app/cook-session.tsx", import.meta.url), "utf8");
  // CLIENT-4 D — through the session's once-guard.
  assert.match(route, /const finishInput = \{ signedIn, isGuest, mealId, dishId, planItemId \};/);
  assert.match(route, /onLeaveAfterLastStep=\{\(\) => \{\s*void noteCookFinished\(signupAt\);\s*finishCook\(finishInput\);/);
  assert.match(route, /const signedIn = useAuth\(\)\.isAuthenticated;/);
  assert.match(route, /const isGuest = useIsGuestSafe\(\);/);
});

// ── CLIENT-4 D (BUG-560) — however Cook Mode was entered ─────────────────────

const step = (key: string): CookStep => ({ key, text: key, phaseType: "cook", estimatedMinutes: 5, isTimingSensitive: false });
const STEPS = [step("a"), step("b"), step("c")];
const NONE: ReadonlySet<string> = new Set();

test("D: advancing onto the last live step is the finish; any other move is not", () => {
  assert.equal(advanceFinishes(STEPS, NONE, 1, 2), true);
  assert.equal(advanceFinishes(STEPS, NONE, 0, 1), false);
  // On the last step, advance stays put: not a second finish.
  assert.equal(advanceFinishes(STEPS, NONE, 2, 2), false);
  // A done-in-prep tail: the last LIVE step is the finish.
  assert.equal(advanceFinishes(STEPS, new Set(["c"]), 0, 1), true);
  assert.equal(advanceFinishes([], NONE, 0, 0), false);
});

test("D: on the last live step (for the Header back), never behind the prep gate", () => {
  assert.equal(onLastLiveStep(STEPS, NONE, 2, false), true);
  assert.equal(onLastLiveStep(STEPS, NONE, 1, false), false);
  assert.equal(onLastLiveStep(STEPS, new Set(["c"]), 1, false), true);
  assert.equal(onLastLiveStep(STEPS, NONE, 2, true), false);
  assert.equal(onLastLiveStep([], NONE, 0, false), false);
});

test("D: once per session, members only, fire-and-forget", async () => {
  const sent: unknown[] = [];
  const finish = makeCookFinish(async (body) => {
    sent.push(body);
    throw new Error("404");
  });
  // A guest's or a dish run's signal does not use up the session's send.
  finish({ ...BASE, isGuest: true });
  finish({ ...BASE, signedIn: false });
  finish({ ...BASE, dishId: "d1" });
  assert.equal(sent.length, 0);
  assert.equal(finish({ ...BASE, planItemId: "pi1" }), undefined, "nothing for the screen to await");
  // The advance, then the Header back, then the unmount: one POST.
  finish({ ...BASE, planItemId: "pi1" });
  finish({ ...BASE, planItemId: "pi1" });
  assert.deepEqual(sent, [{ mealId: "m1", planItemId: "pi1" }]);
  await new Promise((r) => setTimeout(r, 0)); // the rejected POST is dropped
  // A new session (a remount, a reload) sends again.
  const next = makeCookFinish(async (body) => void sent.push(body));
  next(BASE);
  assert.equal(sent.length, 2);
});

test("D: the route sends on the advance and on the Header back, and keeps the review prompt on leave only", () => {
  const route = readFileSync(new URL("../../app/cook-session.tsx", import.meta.url), "utf8");
  assert.match(route, /const \[finishCook\] = useState\(\(\) => makeCookFinish\(\)\);/);
  assert.match(
    route,
    /const to = nextLiveIndex\(activeSteps, doneInPrepKeys, safeIndex\);\s*setCurrentIndex\(to\);\s*if \(advanceFinishes\(activeSteps, doneInPrepKeys, safeIndex, to\)\) finishCook\(finishInput\);/,
  );
  // A tap on the current step is that advance.
  assert.match(route, /if \(i === safeIndex\) advance\(\);/);
  assert.match(
    route,
    /onExit=\{\(\) => \{\s*if \(onLastLiveStep\(activeSteps, doneInPrepKeys, safeIndex, needsGatePrompt\)\) finishCook\(finishInput\);\s*router\.back\(\);/,
  );
  assert.equal(route.match(/noteCookFinished\(/g)?.length, 1, "the review prompt counts the leave only");
  assert.doesNotMatch(route, /reportCookFinished\(/, "every send goes through the once-guard");
});
