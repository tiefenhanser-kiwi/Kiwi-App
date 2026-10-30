// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-8 A (BUG-627) and B (BUG-618), on the web. DEV ONLY.
// OPT-IN: KIWI_E2E_CLIENT8=1.
//
//   KIWI_E2E_CLIENT8=1 KIWI_E2E_RUN_ID=client8 KIWI_E2E_WEB_ORIGIN=http://localhost:9440 \
//     pnpm exec playwright test -c e2e/playwright.config.ts client8
//
// Needs: a dev api-server on :3140 with every mail switch off (api-server
// scripts/_scratch/client-8/serve.ts writes the boot proof, copied by the caller to
// out/<run>/server/boot-proof.json, which test 0 reads), nightProxy.cjs on :9440
// (KIWI_QA_API_PORT=3140) and dist exported with EXPO_PUBLIC_API_BASE_URL=http://localhost:9440/api --clear.
//
//   0 — the server's boot proof (mail off) and the proxy.
//   1 — A: a new account's plan holds meals with no prep steps; the one whose plan
//       item reads prepState "nothing" (isPrepped true, vacuously) opens in Cook
//       Mode with no "Already prepped", no "Skip to cooking" and no prep question.
//   2 — B: Meal Detail's servings stepper at 1 and 3 servings of two 4-serving
//       recipes: "crack in 1 egg" / "2 eggs", "cut ½ lime" / "1½ limes".
// Each at 375 × 812 and 1280 × 800, a full-page screenshot per screen. The account
// is deleted through DELETE /me and proven gone (login 401).
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { API_BASE, RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, todayYmd } from "./qa1-shared";

test.skip(process.env.KIWI_E2E_CLIENT8 !== "1", "CLIENT-8 is opt-in — set KIWI_E2E_CLIENT8=1");
test.describe.configure({ mode: "serial" });

const VIEWPORTS = [
  { name: "375", width: 375, height: 812 },
  { name: "1280", width: 1280, height: 800 },
] as const;
// Dev public meals with no prep-phase step (find-noprep.ts); the server's prepState picks.
const NO_PREP_MEALS = [
  "c7e644eb-cac7-408c-aaf0-0d4a6b7b016d", // Philly Cheesesteaks with Kettle Chips and Pickles
  "8dad908b-0deb-4350-8a59-6bdf4d71a331", // Chicken and Waffles with Hot Honey
  "60bc1eb2-ebe1-4146-973b-b7786f64d20e", // Turkey Club with Avocado and Kettle Chips
];
// 4-serving single-dish recipes with a unit-less count step (find-meals.ts).
const STEPPER_MEALS = [
  { id: "662c99a9-77ce-4808-9660-381fd998f4bb", name: "drunken-noodles", at1: /crack in 1 egg,/, at3: /crack in 2 eggs,/, bad: /crack in 1 eggs|crack in [2-9] egg,/ },
  { id: "7e8f456b-6518-47e8-b4ff-73db053f6fca", name: "fajitas", at1: /cut ½ lime into wedges/, at3: /cut 1½ limes into wedges/, bad: /cut ½ limes|cut 1½ lime into/ },
] as const;

const account = { email: `client8-${Date.now().toString(36)}@example.com`, token: "" };
const password = `Kw!${randomBytes(9).toString("base64url")}`;
const verdicts: Record<string, boolean> = {};
const notes: string[] = [];
const fixture = { planId: "", nothing: null as null | { planItemId: string; mealId: string; title: string; isPrepped: boolean }, items: [] as unknown[] };

function check(name: string, ok: boolean, note: string): void {
  verdicts[name] = ok;
  notes.push(`${name}: ${ok ? "PASS" : "FAIL"} — ${note}`);
}

const inner = (p: Page) => p.evaluate(() => document.body.innerText || "");

async function waitInner(p: Page, pred: (j: string) => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred(await inner(p).catch(() => ""))) return true;
    await p.waitForTimeout(400);
  }
  return false;
}

async function api(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function shot(p: Page, name: string, vp: string): Promise<string> {
  await settle(p, { timeoutMs: 20_000 });
  await p.waitForTimeout(1000);
  mkdirSync(RUN_DIR, { recursive: true });
  await p.screenshot({ path: join(RUN_DIR, `${name}-${vp}.png`), fullPage: true });
  return inner(p);
}

async function newPage(browser: Browser, vp: (typeof VIEWPORTS)[number]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.width > 500 ? 1 : 2 });
  return ctx.newPage();
}

async function signInBrowser(p: Page): Promise<void> {
  await p.goto(`${WEB_ORIGIN}/sign-in`, { waitUntil: "domcontentloaded" });
  await waitInner(p, (j) => /Sign in/.test(j), 45_000);
  await p.getByPlaceholder("Email").fill(account.email, { timeout: 45_000 });
  await p.getByPlaceholder("Password").fill(password, { timeout: 45_000 });
  const btn = p.getByRole("button", { name: /^\s*Sign in\s*$/ });
  if ((await btn.count()) > 0) await btn.first().click();
  else await p.locator('[tabindex="0"]:visible').filter({ hasText: /^\s*Sign in\s*$/ }).first().click();
  const end = Date.now() + 45_000;
  while (Date.now() < end && /sign-in/.test(new URL(p.url()).pathname)) await p.waitForTimeout(400);
}

// Meal Detail's "Adjust for [−] N [+] servings" row has no accessibility labels:
// the row after the "Adjust for" text holds minus, the value and plus.
const adjuster = (p: Page) => p.getByText("Adjust for", { exact: true }).first().locator("xpath=following-sibling::*[1]");

async function servings(p: Page): Promise<number> {
  const text = await adjuster(p).innerText({ timeout: 30_000 });
  return Number(/(\d+)/.exec(text)?.[1] ?? NaN);
}

async function stepTo(p: Page, target: number): Promise<number> {
  for (let i = 0; i < 12; i++) {
    const now = await servings(p);
    if (now === target || Number.isNaN(now)) return now;
    await adjuster(p).locator(now > target ? "xpath=./*[1]" : "xpath=./*[last()]").click({ timeout: 30_000 });
    await p.waitForTimeout(250);
  }
  return servings(p);
}

test.beforeAll(() => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
});

test.afterAll(async () => {
  let deleted: unknown = null;
  try {
    const login = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: account.email, password }) });
    if (login.body?.authToken) {
      const del = await new Http(login.body.authToken).req("DELETE", "/me", { confirm: "delete", currentPassword: password });
      const again = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: account.email, password }) });
      deleted = { email: account.email, deleteStatus: del.status, loginAfter: again.status };
    } else deleted = { email: account.email, login: login.status };
  } catch (err) {
    deleted = { email: account.email, error: String(err) };
  }
  writeFileSync(join(RUN_DIR, "client8.json"), JSON.stringify({ deleted, fixture, verdicts, notes }, null, 2), "utf8");
});

test("0 · the server: mail off (boot proof) and the proxy", async () => {
  const proof = JSON.parse(readFileSync(join(RUN_DIR, "server", "boot-proof.json"), "utf8"));
  const p = proof.proof;
  const mailOff = ["empty", "unset"].includes(p.RESEND_API_KEY) && ["empty", "unset"].includes(p.SIGNUP_ALERT_TO) && p.LIFECYCLE_EMAIL_ENABLED === "false" && p.lifecycleEmailEnabled === false && proof.lifecycleOffLine === true && p.port === "3140";
  check("0-mail-off", mailOff, JSON.stringify(p));
  const health = await fetch(`${API_BASE}/healthz`);
  check("0-proxy", health.ok, `GET ${API_BASE}/healthz → ${health.status}`);
  expect(mailOff && health.ok).toBe(true);
});

test("1 · A: a meal with nothing to prep opens in Cook Mode with no prep summary, at 375 and 1280", async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const made = await api("/auth/signup", { method: "POST", body: JSON.stringify({ email: account.email, password, firstName: "Client", lastName: "Eight" }) });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  account.token = made.body.authToken;
  const http = new Http(account.token);
  await http.req("PATCH", "/me/profile", { onboardingComplete: true, firstRunChoiceMade: true }).catch(() => undefined);
  const plan = await http.req<any>("POST", "/plans/from-meals", { mealIds: [...NO_PREP_MEALS, STEPPER_MEALS[0].id], planDurationDays: 7, localDate: todayYmd() });
  fixture.planId = String((plan.body.plan ?? plan.body).id ?? plan.body.planId ?? "");
  expect(plan.status, JSON.stringify(plan.body).slice(0, 300)).toBeLessThan(300);
  const detail = await http.get<any>(`/plans/${fixture.planId}`);
  const items = (detail.plan?.items ?? []) as { id: string; mealId: string; isPrepped: boolean; prepState?: string; meal?: { title?: string } }[];
  fixture.items = items.map((i) => ({ id: i.id, mealId: i.mealId, title: i.meal?.title, isPrepped: i.isPrepped, prepState: i.prepState }));
  const nothing = items.find((i) => i.prepState === "nothing");
  check("A-fixture", !!nothing && nothing.isPrepped === true, `items ${JSON.stringify(fixture.items)}`);
  expect(nothing, "no plan item reads prepState nothing").toBeTruthy();
  fixture.nothing = { planItemId: nothing!.id, mealId: nothing!.mealId, title: nothing!.meal?.title ?? "", isPrepped: nothing!.isPrepped };
  for (const vp of VIEWPORTS) {
    const p = await newPage(browser, vp);
    await signInBrowser(p);
    await p.goto(`${WEB_ORIGIN}/cook-session?mealId=${nothing!.mealId}&planId=${fixture.planId}&planItemId=${nothing!.id}`, { waitUntil: "domcontentloaded" });
    const ready = await waitInner(p, (j) => /min|Step|step/.test(j) && j.length > 200, 60_000);
    const text = await shot(p, "A-cook-nothing-to-prep", vp.name);
    const hits = ["Already prepped", "Prepped on", "Skip to cooking", "Did you prep this already?"].filter((w) => text.includes(w));
    check(`A-no-prep-summary-${vp.name}`, ready && hits.length === 0, `ready ${ready}; found: ${hits.join(", ") || "none"}`);
    await p.context().close();
  }
  const failed = Object.entries(verdicts).filter(([k, v]) => k.startsWith("A-") && !v);
  expect(failed, JSON.stringify(failed)).toEqual([]);
});

test("2 · B: Meal Detail's stepper says the noun for 1 and 3 servings, at 375 and 1280", async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  for (const vp of VIEWPORTS) {
    const p = await newPage(browser, vp);
    await signInBrowser(p);
    for (const m of STEPPER_MEALS) {
      await p.goto(`${WEB_ORIGIN}/meal/${m.id}`, { waitUntil: "domcontentloaded" });
      await waitInner(p, (j) => /Ingredients/.test(j) && /Steps|Instructions/i.test(j), 60_000);
      for (const [n, want] of [[1, m.at1], [3, m.at3]] as const) {
        const at = await stepTo(p, n);
        // The web column scrolls inside itself: bring the step into the shot.
        await p.getByText(m.name === "fajitas" ? /into wedges/ : /scramble them/).first().scrollIntoViewIfNeeded().catch(() => undefined);
        const text = await shot(p, `B-${m.name}-${n}-servings`, vp.name);
        const bad = text.match(m.bad)?.[0] ?? null;
        check(`B-${m.name}-${n}-${vp.name}`, at === n && want.test(text) && bad === null, `stepper ${at}; ${want} ${want.test(text)}; bad ${bad ?? "none"}; line: ${(text.match(new RegExp(`[^\\n]*${escapeRe(m.name === "fajitas" ? "into wedges" : "scramble them")}[^\\n]*`)) ?? [""])[0].slice(0, 160)}`);
      }
    }
    await p.context().close();
  }
  const failed = Object.entries(verdicts).filter(([k, v]) => k.startsWith("B-") && !v);
  expect(failed, JSON.stringify(failed)).toEqual([]);
});
