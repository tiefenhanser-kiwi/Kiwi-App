// ─────────────────────────────────────────────────────────────────────────────
// SEC-3b — the guest claim with its token (SEC-2 #12) and the trial-used
// paywall from the server's own field (SEC-2 #16), against a local API running
// `next`. DEV ONLY. OPT-IN: KIWI_E2E_SEC3B=1.
//
//   KIWI_E2E_SEC3B=1 KIWI_E2E_RUN_ID=sec3b KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//     pnpm exec playwright test -c e2e/playwright.config.ts sec3b
//
// The API must run with TURNSTILE_SECRET_KEY unset (POST /guest/session then
// accepts every caller — the widget cannot be solved on localhost). The guest
// session and its plan are made with the calls the Test Kitchen makes
// (POST /guest/session, /wizard/shelf, /guest/plan-from-picks — catalog only,
// no AI); the sign-up and the claim are the real screens.
//
//   1  — A signs up from the guest plan: the body carries guestSessionId AND
//        guestToken; the plan is claimed. B is the old client (guestToken
//        stripped in the browser): 409 guest_session_invalid, the resend
//        without the claim, no plan.
//   2  — C signs up as A's "+1" alias: the server gives no trial
//        (trialDeniedReason "trial_already_used") and the paywall says so.
//
// 🔴 THREE NEW ACCOUNTS EVERY RUN (`sec3b-<base36>…@example.com`), all deleted
// at the end through DELETE /me with their passwords. AI spend: none.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { API_BASE, RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, skipHowHeard, todayYmd } from "./qa1-shared";

test.skip(process.env.KIWI_E2E_SEC3B !== "1", "SEC-3b is opt-in — set KIWI_E2E_SEC3B=1");
test.describe.configure({ mode: "serial" });

const base = `sec3b-${Date.now().toString(36)}`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
const accounts = { A: `${base}@example.com`, B: `${base}-b@example.com`, C: `${base}+1@example.com` };
const tokens: Record<string, string> = {};
const out: Record<string, unknown> = { accounts };
let page: Page;
let n = 0;

async function snap(name: string): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true });
  await page.screenshot({ path: join(RUN_DIR, `${String(++n).padStart(2, "0")}-${name}.png`) });
}

async function press(name: string): Promise<void> {
  const re = new RegExp(`^\\s*${escapeRe(name)}\\s*$`);
  const byRole = page.getByRole("button", { name: re });
  if ((await byRole.count()) > 0) return byRole.first().click();
  const byText = page.locator('[tabindex="0"]:visible').filter({ hasText: re });
  await byText.first().waitFor({ state: "visible", timeout: 20_000 });
  await byText.first().click();
}

async function waitInner(pred: (j: string) => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred(await page.evaluate(() => document.body.innerText || ""))) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function json(method: string, path: string, body: unknown, bearer?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** A guest session with a plan on it, exactly as the Test Kitchen's pick path makes one. */
async function guestWithPlan(): Promise<{ guestSessionId: string; token: string; expiresAt: string }> {
  const s = await json("POST", "/guest/session", {});
  expect(s.status, "POST /guest/session").toBe(201);
  const prefs = {
    planDurationDays: 5,
    householdSize: 4,
    cuisines: [],
    difficulty: "medium",
    weeklyPacing: "mostly_easy",
    allergiesAndAvoidances: [],
    eatingStyles: [],
    maxCookTimeMinutes: null,
  };
  const shelf = await json("POST", "/wizard/shelf", prefs, s.body.token);
  expect(shelf.status, "guest shelf").toBe(200);
  const mealIds = (shelf.body.meals as { id: string }[]).slice(0, 3).map((m) => m.id);
  const plan = await json("POST", "/guest/plan-from-picks", { mealIds, preferences: prefs, localDate: todayYmd() }, s.body.token);
  expect(plan.status, `plan-from-picks ${JSON.stringify(plan.body).slice(0, 200)}`).toBeLessThan(300);
  return s.body;
}

/** Put the guest session where the web app keeps it (lib/guest/guestToken.ts). */
async function adoptGuest(g: { guestSessionId: string; token: string; expiresAt: string }): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.evaluate((c) => {
    sessionStorage.clear();
    sessionStorage.setItem("kiwi_guestToken", c.token);
    sessionStorage.setItem("kiwi_guestSessionId", c.guestSessionId);
    sessionStorage.setItem("kiwi_guestExpiresAt", c.expiresAt);
  }, g);
}

/** Record every POST /auth/signup body (password and token shown by shape only) and its answer. */
function watchSignups(): { body: Record<string, unknown>; status: number; answer: Record<string, unknown> }[] {
  const seen: { body: Record<string, unknown>; status: number; answer: Record<string, unknown> }[] = [];
  page.on("response", async (r) => {
    if (r.request().method() !== "POST" || !r.url().endsWith("/api/auth/signup")) return;
    const b = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    let a: any = {};
    try {
      a = await r.json();
    } catch {
      /* no body */
    }
    seen.push({
      body: {
        ...b,
        password: "<typed>",
        ...(typeof b.guestToken === "string" ? { guestToken: `<jwt, ${b.guestToken.split(".").length} parts>` } : {}),
      },
      status: r.status(),
      answer: { code: a.code, claimedPlanId: a.claimedPlanId, claimRetryable: a.claimRetryable, trialDeniedReason: a.user?.subscription?.trialDeniedReason },
    });
  });
  return seen;
}

async function signUp(email: string): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/sign-up`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("First name").fill("Sec");
  await page.getByPlaceholder("Last name").fill("Threeb");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press("Create account");
  await skipHowHeard(page); // CLIENT-3 D — a new account's question
}

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
});

test.afterAll(async () => {
  // Every account this run made goes, through the real route, with its password.
  const deleted: Record<string, number> = {};
  for (const [k, t] of Object.entries(tokens)) {
    deleted[k] = (await json("DELETE", "/me", { confirm: "delete", currentPassword: password }, t)).status;
  }
  out.deleted = deleted;
  writeFileSync(join(RUN_DIR, "sec3b.json"), JSON.stringify(out, null, 2), "utf8");
});

test("1a · A signs up from a guest plan: guestToken rides, the plan is claimed", async () => {
  test.setTimeout(4 * 60_000);
  const g = await guestWithPlan();
  await adoptGuest(g);
  await page.goto(`${WEB_ORIGIN}/test-kitchen/plan`, { waitUntil: "domcontentloaded" });
  await waitInner((j) => /Mon|Tue|Wed|Thu|Fri|Sat|Sun/.test(j), 30_000);
  await snap("1a-guest-plan");
  const seen = watchSignups();
  await signUp(accounts.A);
  await waitInner((j) => /Create a meal plan|this week/i.test(j), 45_000);
  tokens.A = (await page.evaluate(() => sessionStorage.getItem("kiwi_authToken"))) ?? "";
  await page.waitForTimeout(1500);
  await snap("1a-after-claim");
  const plans = await new Http(tokens.A).req<any>("GET", `/plans?filter=my_plans&localDate=${todayYmd()}`);
  out.A = { signups: seen, plans: (plans.body.plans ?? []).map((p: any) => ({ id: p.id, name: p.name })) };
  expect(seen.length).toBe(1);
  expect(seen[0].body.guestSessionId).toBe(g.guestSessionId);
  expect(String(seen[0].body.guestToken)).toBe("<jwt, 3 parts>");
  expect(seen[0].status).toBe(201);
  expect(seen[0].answer.claimedPlanId, "the guest plan was claimed").toBeTruthy();
  expect((plans.body.plans ?? []).some((p: any) => p.id === seen[0].answer.claimedPlanId)).toBe(true);
});

test("1b · B, the OLD client (no guestToken): 409, the resend without the claim, no plan", async () => {
  test.setTimeout(4 * 60_000);
  const g = await guestWithPlan();
  await page.evaluate(() => sessionStorage.clear());
  await adoptGuest(g);
  await page.route("**/api/auth/signup", async (route) => {
    const b = route.request().postDataJSON() ?? {};
    delete b.guestToken; // what SEC-3's build sent
    await route.continue({ postData: JSON.stringify(b) }).catch(() => {});
  });
  const seen = watchSignups();
  await signUp(accounts.B);
  await waitInner((j) => /onboarding|Set your preferences|Create a meal plan|cuisines/i.test(j), 45_000);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  tokens.B = (await page.evaluate(() => sessionStorage.getItem("kiwi_authToken"))) ?? "";
  out.B = { signups: seen };
  expect(seen.map((s) => s.status)).toEqual([409, 201]);
  expect(seen[0].answer.code).toBe("guest_session_invalid");
  expect("guestSessionId" in seen[1].body).toBe(false);
  expect(seen[1].answer.claimedPlanId ?? null).toBeNull();
});

test("2 · C signs up as A's +1 alias: no trial, and the paywall says so in the server's words", async () => {
  test.setTimeout(4 * 60_000);
  await page.evaluate(() => sessionStorage.clear());
  const seen = watchSignups();
  await signUp(accounts.C);
  const said = await waitInner(
    (j) => j.includes("Your free trial was already used with this email.") && j.includes("Subscribe to plan and cook with Kiwi."),
    30_000,
  );
  await page.waitForTimeout(800);
  await snap("2-trial-used-sheet");
  tokens.C = (await page.evaluate(() => sessionStorage.getItem("kiwi_authToken"))) ?? "";
  const sub = await json("GET", "/me/subscription", undefined, tokens.C);
  out.C = { signups: seen, subscription: { status: sub.body.status, trialDeniedReason: sub.body.trialDeniedReason }, said };
  expect(seen[0].answer.trialDeniedReason).toBe("trial_already_used");
  expect(sub.body.trialDeniedReason).toBe("trial_already_used");
  expect(said).toBe(true);
});
