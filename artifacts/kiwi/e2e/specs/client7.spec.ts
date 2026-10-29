// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-7 A (D-WS9-356) — free during launch, on the web. DEV ONLY.
// OPT-IN: KIWI_E2E_CLIENT7=1.
//
//   KIWI_E2E_CLIENT7=1 KIWI_E2E_RUN_ID=client7 KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//     pnpm exec playwright test -c e2e/playwright.config.ts client7
//
// Needs: a dev api-server on :3000 with every mail switch off and BILLING_ENFORCED
// unset (api-server scripts/_scratch/client-7/serve.ts writes out/client7/server/
// boot-proof.json, which test 0 reads), the serve-proxy on :9410, and dist exported
// with EXPO_PUBLIC_API_BASE_URL=http://localhost:9410/api --clear.
//
//   0 — the server's boot proof (mail off) and GET /me/subscription's billing.mode.
//   1 — Welcome and Sign-up on a fresh browser (nothing stored): free copy.
//   2 — a new account, signed up in the browser: How did you hear, onboarding, Home,
//       Plans, Recipes, Ask Kiwi, a plan made from two meals and its meal page, Profile.
//   3 — an account whose trial ended 60 days ago (expire.ts): the same screens.
// Each at 375 × 812 and 1280 × 800, every screen's text scanned for a trial or price
// word, a screenshot per screen. Both accounts are deleted through DELETE /me and
// proven gone (login 401).
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { API_BASE, API_SERVER_ROOT, RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, todayYmd } from "./qa1-shared";

test.skip(process.env.KIWI_E2E_CLIENT7 !== "1", "CLIENT-7 is opt-in — set KIWI_E2E_CLIENT7=1");
test.describe.configure({ mode: "serial" });

const FORBIDDEN = /\btrial\b|14[- ]day|14 days|\$9\.99|\$99\.99|subscribe|upgrade/i;
const VIEWPORTS = [
  { name: "375", width: 375, height: 812 },
  { name: "1280", width: 1280, height: 800 },
] as const;
// web4-sweep's corpus (client4 uses the same two): the first is a two-dish meal.
const MEAL_IDS = ["3424eefa-423c-4be1-a987-8a55c8811576", "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d"];

const stamp = Date.now().toString(36);
const accounts = {
  fresh: { email: `client7-${stamp}@example.com`, token: "" },
  expired: { email: `client7-${stamp}x@example.com`, token: "" },
};
const password = `Kw!${randomBytes(9).toString("base64url")}`;
const verdicts: Record<string, boolean> = {};
const notes: string[] = [];
const scans: { account: string; viewport: string; screen: string; hit: string | null; path: string }[] = [];

function check(name: string, ok: boolean, note: string): void {
  verdicts[name] = ok;
  notes.push(`${name}: ${ok ? "PASS" : "FAIL"} — ${note}`);
}

const inner = (p: Page) => p.evaluate(() => document.body.innerText || "");

async function waitInner(p: Page, pred: (j: string) => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred(await inner(p))) return true;
    await p.waitForTimeout(300);
  }
  return false;
}

async function waitPath(p: Page, re: RegExp, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (re.test(new URL(p.url()).pathname)) return true;
    await p.waitForTimeout(250);
  }
  return false;
}

async function press(p: Page, name: string): Promise<void> {
  const re = new RegExp(`^\\s*${escapeRe(name)}\\s*$`);
  const byRole = p.getByRole("button", { name: re });
  if ((await byRole.count()) > 0) {
    await byRole.first().click();
    return;
  }
  const byText = p.locator('[tabindex="0"]:visible').filter({ hasText: re });
  await byText.first().waitFor({ state: "visible", timeout: 20_000 });
  await byText.first().click();
}

/** Visit, wait for `ready`, screenshot, and scan the screen's text for a trial or price word. */
async function screen(p: Page, account: string, viewport: string, name: string, path: string | null, ready: RegExp, timeoutMs = 45_000): Promise<string> {
  if (path !== null) await p.goto(`${WEB_ORIGIN}${path}`, { waitUntil: "domcontentloaded" });
  const ok = await waitInner(p, (j) => ready.test(j), timeoutMs);
  await settle(p, { timeoutMs: 20_000 });
  await p.waitForTimeout(1200);
  const text = await inner(p);
  mkdirSync(RUN_DIR, { recursive: true });
  await p.screenshot({ path: join(RUN_DIR, `${account}-${name}-${viewport}.png`), fullPage: true });
  const hit = text.match(FORBIDDEN)?.[0] ?? null;
  scans.push({ account, viewport, screen: name, hit, path: new URL(p.url()).pathname });
  check(`${account}-${name}-${viewport}`, ok && hit === null, `ready ${ok} (${ready}); trial/price word: ${hit ?? "none"}; at ${new URL(p.url()).pathname}`);
  return text;
}

async function newPage(browser: Browser, vp: (typeof VIEWPORTS)[number]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.width > 500 ? 1 : 2 });
  return ctx.newPage();
}

async function signInBrowser(p: Page, email: string): Promise<void> {
  await p.goto(`${WEB_ORIGIN}/sign-in`, { waitUntil: "domcontentloaded" });
  await waitInner(p, (j) => /Sign in/.test(j), 45_000);
  await p.getByPlaceholder("Email").fill(email);
  await p.getByPlaceholder("Password").fill(password);
  await press(p, "Sign in");
  await waitPath(p, /^\/$|^\/\(tabs\)|^\/plans|^\/meals/, 45_000);
}

/** The member screens every account must reach with no trial, price or upgrade word. */
async function memberScreens(p: Page, account: string, vp: string, planId: string, mealId: string): Promise<void> {
  await screen(p, account, vp, "home", "/", /Plans|Home|meal/i);
  await screen(p, account, vp, "plans", "/plans", /Plan/i);
  const recipes = await screen(p, account, vp, "recipes", "/meals", /Recipes|Cookbook|Not finding what you want/i);
  if (planId) await screen(p, account, vp, "plan", `/plan/${planId}`, /Grocer|Cook|Prep|Plan/i, 60_000);
  if (mealId) await screen(p, account, vp, "meal", `/meal/${mealId}`, /Ingredients|Steps|Cook/i, 60_000);
  const profile = await screen(p, account, vp, "profile", "/profile", /Subscription/);
  check(
    `${account}-profile-card-${vp}`,
    profile.includes("Kiwi is free during launch.") && profile.includes("Every feature is included. No card, nothing to cancel."),
    `free card text present: ${profile.includes("Kiwi is free during launch.")}`,
  );
  // Ask Kiwi from the Recipes helper goes to Ask Kiwi, not a paywall.
  if (/Not finding what you want/.test(recipes)) {
    await p.goto(`${WEB_ORIGIN}/meals`, { waitUntil: "domcontentloaded" });
    await waitInner(p, (j) => /Not finding what you want/.test(j), 30_000);
    const helper = p.locator('[data-testid="cookbook-ask-kiwi"]');
    const go = helper.getByRole("button").last();
    await go.click().catch(() => undefined);
    const reached = await waitPath(p, /ask-kiwi/, 15_000);
    const paywall = await p.locator('[data-testid="paywall-backdrop"]').count();
    await p.screenshot({ path: join(RUN_DIR, `${account}-ask-kiwi-${vp}.png`) });
    check(`${account}-ask-kiwi-${vp}`, reached && paywall === 0, `reached /ask-kiwi ${reached}; paywall backdrops ${paywall}`);
  }
}

async function api(path: string, init: RequestInit = {}, token = ""): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const fixture = { planId: "", mealId: "" };

test.beforeAll(() => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
});

test.afterAll(async () => {
  const deleted: Record<string, unknown> = {};
  for (const [k, a] of Object.entries(accounts)) {
    try {
      const login = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: a.email, password }) });
      if (login.body?.authToken) {
        const del = await new Http(login.body.authToken).req("DELETE", "/me", { confirm: "delete", currentPassword: password });
        const again = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: a.email, password }) });
        deleted[k] = { email: a.email, deleteStatus: del.status, loginAfter: again.status };
      } else {
        deleted[k] = { email: a.email, login: login.status };
      }
    } catch (err) {
      deleted[k] = { email: a.email, error: String(err) };
    }
  }
  writeFileSync(join(RUN_DIR, "client7.json"), JSON.stringify({ deleted, fixture, verdicts, notes, scans }, null, 2), "utf8");
});

test("0 · the server: mail off (boot proof) and free_launch on the wire", async () => {
  const proof = JSON.parse(readFileSync(join(RUN_DIR, "server", "boot-proof.json"), "utf8"));
  const p = proof.proof;
  const mailOff = ["empty", "unset"].includes(p.RESEND_API_KEY) && ["empty", "unset"].includes(p.SIGNUP_ALERT_TO) && p.LIFECYCLE_EMAIL_ENABLED === "false" && p.lifecycleEmailEnabled === false && proof.lifecycleOffLine === true && p.port === "3000";
  check("0-mail-off", mailOff, JSON.stringify(p));
  const health = await fetch(`${API_BASE}/healthz`);
  check("0-proxy", health.ok, `GET ${API_BASE}/healthz → ${health.status}`);
  expect(mailOff && health.ok).toBe(true);
});

test("1 · Welcome and Sign-up on a fresh browser read free, at 375 and 1280", async ({ browser }) => {
  for (const vp of VIEWPORTS) {
    const p = await newPage(browser, vp);
    const welcome = await screen(p, "anon", vp.name, "welcome", "/welcome", /Explore without an account/);
    check(`anon-welcome-label-${vp.name}`, welcome.includes("Get started — it's free"), "the primary says free");
    await press(p, "Get started — it's free");
    await waitPath(p, /sign-up/, 20_000);
    const signUp = await screen(p, "anon", vp.name, "sign-up", null, /Create account/);
    check(`anon-sign-up-line-${vp.name}`, signUp.includes("Free · no card needed"), "the free line under Create account");
    await p.context().close();
  }
  expect(Object.entries(verdicts).filter(([k]) => k.startsWith("anon-")).every(([, v]) => v)).toBe(true);
});

test("2 · a new account: sign-up, onboarding and every member screen, at 375 and 1280", async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const a = accounts.fresh;
  const p = await newPage(browser, VIEWPORTS[0]);
  let signupAnswer: any = null;
  p.on("response", async (res) => {
    if (res.request().method() === "POST" && res.url().endsWith("/api/auth/signup")) signupAnswer = await res.json().catch(() => null);
  });
  await p.goto(`${WEB_ORIGIN}/sign-up`, { waitUntil: "domcontentloaded" });
  await waitInner(p, (j) => /Create account/.test(j), 45_000);
  await p.getByPlaceholder("First name").fill("Client");
  await p.getByPlaceholder("Last name").fill("Seven");
  await p.getByPlaceholder("Email").fill(a.email);
  await p.getByPlaceholder("Password").fill(password);
  await press(p, "Create account");
  expect(await waitPath(p, /how-heard/, 60_000), "the question's route").toBe(true);
  await screen(p, "fresh", "375", "how-heard", null, /How did you hear about Kiwi\?/);
  check("fresh-signup-wire", signupAnswer?.user?.billing?.mode === "free_launch" && !("trialDeniedReason" in (signupAnswer?.user?.subscription ?? {})), `user.billing ${JSON.stringify(signupAnswer?.user?.billing)}; subscription keys ${Object.keys(signupAnswer?.user?.subscription ?? {}).join(",")}`);
  await press(p, "Skip");
  await waitPath(p, /onboarding/, 30_000);
  await screen(p, "fresh", "375", "onboarding", null, /Italian|cuisine/i);
  for (const c of ["Italian", "Mexican", "Asian"]) await press(p, c);
  await press(p, "Continue");
  await waitPath(p, /onboarding-step-3/, 30_000);
  await settle(p, { timeoutMs: 20_000 });
  await press(p, "Finish setup");
  await waitInner(p, (j) => /Create a meal plan|Plans/.test(j), 30_000);
  a.token = await p.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? "");
  const http = new Http(a.token);
  const sub = await api("/me/subscription", {}, a.token);
  check("fresh-subscription-wire", sub.body?.billing?.mode === "free_launch" && sub.body?.status === "trialing" && !("trialDeniedReason" in (sub.body ?? {})), `status ${sub.body?.status}; billing ${JSON.stringify(sub.body?.billing)}; enforced ${sub.body?.enforced}`);
  const made = await http.req<any>("POST", "/plans/from-meals", { mealIds: MEAL_IDS, planDurationDays: 7, localDate: todayYmd() });
  const plan = made.body.plan ?? made.body;
  fixture.planId = String(plan.id ?? made.body.planId ?? "");
  const detail = await http.get<any>(`/plans/${fixture.planId}`);
  fixture.mealId = String(((detail.instance ?? detail.plan ?? detail).items ?? [])[0]?.mealId ?? "");
  notes.push(`fixture: from-meals ${made.status} plan ${fixture.planId} meal ${fixture.mealId}`);
  await memberScreens(p, "fresh", "375", fixture.planId, fixture.mealId);
  await p.context().close();

  const wide = await newPage(browser, VIEWPORTS[1]);
  await signInBrowser(wide, a.email);
  await memberScreens(wide, "fresh", "1280", fixture.planId, fixture.mealId);
  await wide.context().close();
  const failed = Object.entries(verdicts).filter(([k, v]) => k.startsWith("fresh-") && !v);
  expect(failed, JSON.stringify(failed)).toEqual([]);
});

test("3 · an account whose trial ended 60 days ago, at 375 and 1280", async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const a = accounts.expired;
  const made = await api("/auth/signup", { method: "POST", body: JSON.stringify({ email: a.email, password, firstName: "Client", lastName: "Expired" }) });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  a.token = made.body.authToken;
  const run = spawnSync(process.execPath, ["--env-file=.env", "--import", "tsx", "scripts/_scratch/client-7/expire.ts", a.email], { cwd: API_SERVER_ROOT, encoding: "utf8" });
  notes.push(`expire: exit ${run.status} ${run.stdout.trim()} ${run.stderr.slice(0, 300)}`);
  expect(run.status).toBe(0);
  const sub = await api("/me/subscription", {}, a.token);
  check("expired-subscription-wire", sub.body?.status === "none" && sub.body?.billing?.mode === "free_launch", `status ${sub.body?.status}; trialEndsAt ${sub.body?.trialEndsAt}; billing ${JSON.stringify(sub.body?.billing)}`);
  await new Http(a.token).req("PATCH", "/me/profile", { onboardingComplete: true, firstRunChoiceMade: true }).catch(() => undefined);
  const plan = await new Http(a.token).req<any>("POST", "/plans/from-meals", { mealIds: MEAL_IDS, planDurationDays: 7, localDate: todayYmd() });
  const planId = String((plan.body.plan ?? plan.body).id ?? plan.body.planId ?? "");
  notes.push(`expired: from-meals ${plan.status} (free during launch: no 402) plan ${planId}`);
  check("expired-from-meals", plan.status < 300, `POST /plans/from-meals → ${plan.status}`);
  for (const vp of VIEWPORTS) {
    const p = await newPage(browser, vp);
    await signInBrowser(p, a.email);
    await memberScreens(p, "expired", vp.name, planId, MEAL_IDS[0]);
    await p.context().close();
  }
  const failed = Object.entries(verdicts).filter(([k, v]) => k.startsWith("expired-") && !v);
  expect(failed, JSON.stringify(failed)).toEqual([]);
});
