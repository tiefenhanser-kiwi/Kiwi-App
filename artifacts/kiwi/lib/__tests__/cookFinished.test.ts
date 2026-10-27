// CLIENT-3 C (LIFE-2 #9) — Cook Mode's finish reaches POST /me/activity/cook-finished:
// a signed-in member's meal cook only, never awaited, a failure dropped.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { cookFinishedBody, reportCookFinished, type CookFinishedInput } from "../cookFinished";
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
  assert.match(route, /reportCookFinished\(\{ signedIn, isGuest, mealId, dishId, planItemId \}\);/);
  assert.match(route, /const signedIn = useAuth\(\)\.isAuthenticated;/);
  assert.match(route, /const isGuest = useIsGuestSafe\(\);/);
});
