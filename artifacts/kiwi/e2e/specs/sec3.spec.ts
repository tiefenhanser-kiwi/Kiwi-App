// ─────────────────────────────────────────────────────────────────────────────
// SEC-3 — the web build under its own Content-Security-Policy, and the client
// halves of SEC-3 B–F. DEV ONLY. OPT-IN: KIWI_E2E_SEC3=1.
//
//   KIWI_E2E_SEC3=1 KIWI_E2E_RUN_ID=sec3 KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//     pnpm exec playwright test -c e2e/playwright.config.ts sec3
//
// The origin must serve the export WITH dist/_headers applied (Netlify does in
// production; serve-proxy.cjs does not). Every `securitypolicyviolation` event
// and every console line naming the CSP is recorded; the run fails on any.
//
//   A  — every main screen, sign-in up to the provider popup, Turnstile on the
//        Test Kitchen, the Premium sheet: zero CSP violations (csp.json).
//   B  — the email change and the delete under "Confirm it's you", against
//        SEC-2's real refusals (an API with e8c10293); only the Google/Apple-only
//        refusal (method "sign_in") is answered in the browser. Log out ends
//        every session (the old token 401s) and lands signed-out.
//   C  — Home's rotating Tell Kiwi phrases at 375: each shows whole.
//   D  — the sign-up answer carries trialDenied: "duplicate_email" (added in the
//        browser) → the paywall says so.
//   E  — "Send feedback" carries the version line (answered in the browser; no
//        email is sent).
//   F  — the Cookbook header reads "N meals".
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN (`sec3-<base36>@example.com`) and
// DELETES it at the end. Never Hans's account. AI spend: none.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, skipHowHeard, todayYmd } from "./qa1-shared";

const MEAL_IDS = [
  "3424eefa-423c-4be1-a987-8a55c8811576",
  "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d",
  "00e3a8ec-d909-466b-9c20-8f3cf5f7e544",
];

test.skip(process.env.KIWI_E2E_SEC3 !== "1", "SEC-3 is opt-in — set KIWI_E2E_SEC3=1");
test.describe.configure({ mode: "serial" });

const email = `sec3-${Date.now().toString(36)}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
const fixture = { planId: "", mealId: MEAL_IDS[0] };
const csp: { where: string; kind: string; detail: string }[] = [];
const thirdPartyFrames: { where: string; kind: string; detail: string }[] = [];
const screens: Record<string, unknown> = {};
const notes: string[] = [];
let where = "start";

let n = 0;
async function snap(name: string): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true });
  await page.screenshot({ path: join(RUN_DIR, `${String(++n).padStart(2, "0")}-${name}.png`) });
}

async function press(name: string | RegExp): Promise<void> {
  const re = typeof name === "string" ? new RegExp(`^\\s*${escapeRe(name)}\\s*$`) : name;
  const byRole = page.getByRole("button", { name: re });
  if ((await byRole.count()) > 0) {
    await byRole.first().click();
    return;
  }
  const byText = page.locator('[tabindex="0"]:visible').filter({ hasText: re });
  await byText.first().waitFor({ state: "visible", timeout: 20_000 });
  await byText.first().click();
}

async function waitInner(pred: (joined: string) => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await page.evaluate(() => document.body.innerText || "");
    if (pred(t)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function waitPath(re: RegExp, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (re.test(new URL(page.url()).pathname)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function visit(name: string, path: string, ready: (j: string) => boolean, timeoutMs = 45_000): Promise<boolean> {
  where = name;
  await page.goto(`${WEB_ORIGIN}${path}`, { waitUntil: "domcontentloaded" });
  const ok = await waitInner(ready, timeoutMs);
  await settle(page, { timeoutMs: 20_000 });
  screens[name] = { path, ready: ok };
  return ok;
}

const byTestId = (id: string) => page.locator(`[data-testid="${id}"]`);

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
  // Every violation, from the page itself (survives navigations: re-installed per document).
  await page.exposeFunction("__sec3Csp", (d: string) => csp.push({ where, kind: "securitypolicyviolation", detail: d }));
  // OUR policy is the one on our own documents. A provider's iframe (Turnstile's
  // challenge frame on challenges.cloudflare.com) runs ITS OWN CSP, and its
  // violations are its business: they are recorded apart (thirdPartyFrames), and
  // only ours fail the run.
  await page.exposeFunction("__sec3Frame", (d: string) => thirdPartyFrames.push({ where, kind: "securitypolicyviolation", detail: d }));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __sec3Csp(d: string): void; __sec3Frame(d: string): void };
      const d = `${e.effectiveDirective} blocked ${e.blockedURI || "(inline)"} @ ${e.sourceFile || ""}:${e.lineNumber || ""}`;
      if (window.top === window) w.__sec3Csp(d);
      else w.__sec3Frame(`${location.origin}: ${d}`);
    });
  });
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|connect|frame|apply|evaluate)/i.test(t)) {
      const u = m.location().url;
      const ours = !u || u.startsWith(WEB_ORIGIN);
      (ours ? csp : thirdPartyFrames).push({ where, kind: `console.${m.type()} ${u.slice(0, 60)}`, detail: t.slice(0, 400) });
    }
  });
});

test.afterAll(async () => {
  writeFileSync(join(RUN_DIR, "csp.json"), JSON.stringify({ email, csp, thirdPartyFrames, screens, notes }, null, 2), "utf8");
});

// ── A (signed out) — Welcome, sign-in to the provider popup, Test Kitchen ────

test("A1 · signed-out screens load their providers without a CSP error", async () => {
  test.setTimeout(4 * 60_000);
  await visit("welcome", "/", (j) => /free trial/i.test(j), 60_000);
  await snap("welcome");

  await visit("sign-in", "/sign-in", (j) => /Sign in/i.test(j), 45_000);
  await page.waitForTimeout(4000);
  const providers = await page.evaluate(() => ({
    gis: typeof (window as any).google?.accounts?.id?.initialize === "function",
    apple: typeof (window as any).AppleID?.auth?.init === "function",
    frames: Array.from(document.querySelectorAll("iframe")).map((f) => f.src.slice(0, 80)),
    scripts: Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src.slice(0, 90)),
  }));
  screens["sign-in"] = { ...(screens["sign-in"] as object), providers };
  await snap("sign-in");

  // Apple's button opens its popup: the provider "redirect" on the web (usePopup).
  const apple = page.locator("#appleid-signin");
  if ((await apple.count()) > 0) {
    const popup = page.waitForEvent("popup", { timeout: 15_000 }).catch(() => null);
    await apple.first().click().catch((e) => notes.push(`apple click: ${String(e).slice(0, 120)}`));
    const p = await popup;
    screens["apple-popup"] = { opened: !!p, url: p ? p.url().slice(0, 60) : null };
    if (p) {
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      screens["apple-popup"] = { opened: true, url: p.url().slice(0, 60) };
      await p.close();
    }
  } else notes.push("no #appleid-signin on the sign-in screen");

  // Google's button is GIS's iframe; a click on it opens accounts.google.com.
  const gis = page.locator('iframe[src*="accounts.google.com/gsi/button"]');
  if ((await gis.count()) > 0) {
    const box = await gis.first().boundingBox();
    const popup = page.waitForEvent("popup", { timeout: 15_000 }).catch(() => null);
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const p = await popup;
    screens["google-popup"] = { opened: !!p, url: p ? p.url().slice(0, 60) : null };
    if (p) await p.close();
  } else notes.push("no GIS button iframe (GIS refuses an unregistered origin; see the console)");

  await visit("sign-up", "/sign-up", (j) => /Create account/i.test(j), 45_000);
  await page.waitForTimeout(2000);
  await snap("sign-up");

  await visit("test-kitchen", "/test-kitchen", (j) => j.trim().length > 40, 45_000);
  await page.waitForTimeout(6000);
  const ts = await page.evaluate(() => ({
    turnstile: typeof (window as any).turnstile?.render === "function",
    frames: Array.from(document.querySelectorAll("iframe")).map((f) => f.src.slice(0, 70)),
    verifying: /Verifying/i.test(document.body.innerText),
  }));
  screens["test-kitchen"] = { ...(screens["test-kitchen"] as object), ts };
  await snap("test-kitchen");
});

// ── D + sign-up — the server's answer gets trialDenied, in the browser ───────

test("D · a trial-denied sign-up opens the paywall that says so", async () => {
  test.setTimeout(5 * 60_000);
  // QA-6 — since SEC-3b the client reads user.subscription.trialDeniedReason on the sign-up
  // answer (AuthContext noteTrialDenied) and the sheet's words from GET /me/subscription
  // (sheetCopyFor); the old top-level `trialDenied` opens nothing. Both are stubbed.
  await page.route("**/api/auth/signup", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const user = { ...body.user, subscription: { ...(body.user?.subscription ?? {}), trialDeniedReason: "trial_already_used" } };
    await route.fulfill({ response: res, json: { ...body, user } });
  });
  await page.route("**/api/me/subscription", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, trialDeniedReason: "trial_already_used" } });
  });
  await visit("sign-up-form", "/sign-up", (j) => /Create account/i.test(j), 45_000);
  await page.getByPlaceholder("First name").fill("Sec");
  await page.getByPlaceholder("Last name").fill("Three");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press("Create account");
  // QA-6 — the trial-used sheet now opens OVER "How did you hear about Kiwi?" (its backdrop
  // takes the clicks), so it is read and dismissed first, then the question is skipped.
  where = "trial-used-sheet";
  const said = await waitInner((j) => j.includes("Your free trial was already used with this email."), 60_000);
  await page.waitForTimeout(800);
  screens["trial-used-sheet"] = { said, path: new URL(page.url()).pathname, overQuestion: (await page.evaluate(() => document.body.innerText || "")).includes("How did you hear about Kiwi?") };
  await snap("D-trial-used-sheet");
  expect(said, "the trial-used paywall").toBe(true);
  await press("Not now");
  await page.waitForTimeout(600);
  await skipHowHeard(page); // CLIENT-3 D — a new account's question
  expect(await waitPath(/onboarding/, 60_000), "reached onboarding").toBe(true);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  http = new Http(await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? ""));

  await settle(page, { timeoutMs: 30_000 });
  for (const c of ["Italian", "Mexican"]) await press(c);
  await press("Continue");
  await waitPath(/onboarding-step-3/, 30_000);
  await settle(page, { timeoutMs: 20_000 });
  await press("Finish setup");
  await waitInner((j) => /Create a meal plan/.test(j), 30_000);
  const made = await http.req<any>("POST", "/plans/from-meals", { mealIds: MEAL_IDS, planDurationDays: 7, localDate: todayYmd() });
  const plan = made.body.plan ?? made.body;
  fixture.planId = String(plan.id ?? made.body.planId ?? "");
  notes.push(`from-meals → ${made.status} ${fixture.planId}`);
});

// ── A (signed in) — every main screen, then the Premium sheet ────────────────

test("A2 · the signed-in screens", async () => {
  test.setTimeout(8 * 60_000);
  const { planId, mealId } = fixture;
  const list: [string, string, (j: string) => boolean][] = [
    ["home", "/", (j) => /Create a meal plan/.test(j)],
    ["plans", "/plans", (j) => j.trim().length > 40],
    ["plan-detail", `/plan/${planId}`, (j) => /Mon|Tue|Wed|Thu|Fri|Sat|Sun/.test(j)],
    ["meal", `/meal/${mealId}`, (j) => /Ingredients/i.test(j)],
    ["cookbook", "/cookbook", (j) => /\d meals?\b/.test(j)],
    ["recipes", "/meals", (j) => j.trim().length > 40],
    ["groceries", "/groceries", (j) => j.trim().length > 20],
    ["playlist", "/playlist", (j) => j.trim().length > 20],
    ["prep-cook", `/prep-cook?id=${planId}`, (j) => j.trim().length > 40],
    ["wizard", "/wizard", (j) => /Build my plan/.test(j)],
    ["tellkiwi", "/tellkiwi", (j) => /Tell Kiwi/i.test(j)],
    ["preferences", "/preferences", (j) => j.trim().length > 40],
    ["profile", "/profile", (j) => /Log Out/.test(j)],
    ["feedback", "/feedback", (j) => /What's on your mind/.test(j)],
    ["delete-account", "/delete-account", (j) => /delete/i.test(j)],
  ];
  for (const [name, path, ready] of list) {
    try {
      await visit(name, path, ready);
      await page.waitForTimeout(1200); // images
      await snap(`A-${name}`);
    } catch (err) {
      notes.push(`${name}: ${String(err).slice(0, 200)}`);
    }
  }
  // F — the Cookbook header: "N meals", no clause.
  await visit("cookbook-F", "/cookbook", (j) => /\d meals?\b/.test(j));
  const lines = (await page.evaluate(() => document.body.innerText)).split("\n").map((l) => l.trim());
  const header = lines.find((l) => /^[\d,]+ meals?$/.test(l)) ?? "";
  screens["F-cookbook-header"] = { header, clause: lines.some((l) => /fit your allergies/.test(l)) };
  expect(header, "Cookbook header reads N meals").not.toBe("");
  expect(lines.some((l) => /fit your allergies/.test(l))).toBe(false);
});

test("A3 · the Premium sheet", async () => {
  test.setTimeout(3 * 60_000);
  // The local API has no live Stripe, so Profile hides Subscribe; say it does
  // (WEB-4's harness note). Nothing here calls a billing route.
  await page.route("**/api/me/subscription", async (route) => {
    try {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, billingAvailable: true } });
    } catch {
      // unrouted mid-flight: the page has moved on
    }
  });
  await visit("profile-premium", "/profile", (j) => /Log Out/.test(j));
  const sub = byTestId("settings-subscribe");
  const prem = byTestId("settings-premium");
  if ((await sub.count()) > 0) await sub.first().click();
  else if ((await prem.count()) > 0) await prem.first().click();
  else notes.push("no Subscribe / Kiwi Premium row on Profile");
  where = "premium-sheet";
  const open = await waitInner((j) => /\$9\.99 \/ month/.test(j), 15_000);
  await page.waitForTimeout(600);
  await snap("A-premium-sheet");
  screens["premium-sheet"] = { open };
  if (open) await press("Not now");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect(open, "the Premium sheet opened").toBe(true);
});

// ── C — the rotating phrases, each whole ────────────────────────────────────

test("C · every rotating Tell Kiwi phrase shows whole at 375", async () => {
  test.setTimeout(3 * 60_000);
  await visit("home-C", "/", (j) => /Create a meal plan/.test(j), 60_000);
  const seen: Record<string, unknown> = {};
  const end = Date.now() + 20_000;
  while (Date.now() < end && Object.keys(seen).length < 5) {
    const m = await page.evaluate(() => {
      const ph = document.querySelector('[data-testid="tell-kiwi-placeholder"]') as HTMLElement | null;
      if (!ph || !ph.textContent) return null;
      const pill = ph.parentElement!.getBoundingClientRect();
      const r = ph.getBoundingClientRect();
      return {
        text: ph.textContent,
        opacity: getComputedStyle(ph).opacity,
        clipped: ph.scrollWidth > ph.clientWidth + 1 || ph.scrollHeight > ph.clientHeight + 1,
        insidePill: r.top >= pill.top - 1 && r.bottom <= pill.bottom + 1,
        lines: Math.round(r.height / parseFloat(getComputedStyle(ph).lineHeight || "22")),
        pillHeight: Math.round(pill.height),
      };
    });
    if (m && m.opacity === "1" && !seen[m.text]) {
      seen[m.text] = m;
      await snap(`C-phrase-${Object.keys(seen).length}`);
    }
    await page.waitForTimeout(250);
  }
  // The narrowest phone at normal text: the pill stays beside the label.
  await page.setViewportSize({ width: 320, height: 812 });
  await page.waitForTimeout(800);
  const narrow = await page.evaluate(() => {
    const ph = document.querySelector('[data-testid="tell-kiwi-placeholder"]') as HTMLElement | null;
    const pill = ph?.parentElement?.getBoundingClientRect();
    const label = Array.from(document.querySelectorAll("div")).find((d) => d.children.length === 0 && d.textContent === "Tell Kiwi");
    const l = label?.getBoundingClientRect();
    return pill && l ? { sameRow: pill.top < l.bottom && pill.bottom > l.top, pillWidth: Math.round(pill.width) } : null;
  });
  await snap("C-320-normal-text");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(500);
  // Max text, simulated: Android's largest font scale (2.0) on the row's text.
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('[data-testid="tell-kiwi-placeholder"], [data-testid="tell-kiwi-placeholder"] ~ *, div'))) {
      const h = el as HTMLElement;
      if (h.children.length === 0 && h.textContent && /Tell Kiwi|…/.test(h.textContent)) {
        const fs = parseFloat(getComputedStyle(h).fontSize);
        h.style.fontSize = `${fs * 2}px`;
        h.style.lineHeight = "normal";
      }
    }
  });
  // …and the pill's floor at fontScale 2 (lib/largeTextLayout.ts tellKiwiPillBasis(2, 14) = 259):
  // the web's fontScale is always 1, so the one input a phone would change is set by hand.
  await page.evaluate(() => {
    const ph = document.querySelector('[data-testid="tell-kiwi-placeholder"]') as HTMLElement | null;
    if (ph?.parentElement) ph.parentElement.style.flexBasis = "259px";
  });
  await page.waitForTimeout(400);
  const big = await page.evaluate(() => {
    const ph = document.querySelector('[data-testid="tell-kiwi-placeholder"]') as HTMLElement | null;
    if (!ph) return null;
    const pill = ph.parentElement!.getBoundingClientRect();
    const r = ph.getBoundingClientRect();
    return { text: ph.textContent, clipped: ph.scrollWidth > ph.clientWidth + 1, insidePill: r.bottom <= pill.bottom + 1, pillHeight: Math.round(pill.height) };
  });
  await snap("C-max-text-simulated");
  screens["C"] = { seen, big, narrow };
  for (const v of Object.values(seen) as { clipped: boolean; insidePill: boolean; text: string }[]) {
    expect(v.clipped, `clipped: ${v.text}`).toBe(false);
    expect(v.insidePill, `outside the pill: ${v.text}`).toBe(true);
  }
});

// ── E — feedback carries the version line ───────────────────────────────────

test("E · Send feedback attaches the version line", async () => {
  test.setTimeout(2 * 60_000);
  let sent: any = null;
  await page.route("**/api/me/feedback", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await visit("feedback-E", "/feedback", (j) => /What's on your mind/.test(j));
  await page.getByLabel("Your feedback").fill("SEC-3 check: the version line rides along.");
  await press("Send");
  await waitInner((j) => /Thank you/.test(j), 15_000);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  screens["E-feedback-body"] = sent;
  expect(sent?.message).toMatch(/\n\n—\nVersion [^\n]+ · web\nweb · Mozilla/);
});

// ── B — "Confirm it's you" on the email change and the delete ───────────────
//
// Against SEC-2's REAL server (e8c10293, #6): a password account gets 403
// reauth_required {method: "password"} with nothing typed, 403
// password_incorrect for a wrong one, and passes with the right one. The
// Google/Apple-only answer (403 reauth_required {method: "sign_in"}) cannot be
// produced by this account, so that one refusal is answered in the browser.

async function startEmailChange(newEmail: string) {
  await visit("profile-B", "/profile", (j) => /Log Out/.test(j));
  await page.getByText("Email", { exact: true }).first().click();
  const box = page.locator('input[placeholder="you@example.com"]');
  await box.waitFor({ timeout: 10_000 });
  await box.fill(newEmail);
  await box.press("Enter");
  await byTestId("email-change-confirm").waitFor({ timeout: 10_000 });
}

/** Every request to `pathEnd` with `method`: its body and the status that came back. */
function watch(method: string, pathEnd: string) {
  const seen: { body: any; status: number }[] = [];
  page.on("response", (r) => {
    const q = r.request();
    if (q.method() === method && new URL(r.url()).pathname.endsWith(pathEnd)) {
      const b = q.postDataJSON() ?? {};
      seen.push({ body: { ...b, currentPassword: b.currentPassword ? "<typed>" : undefined }, status: r.status() });
    }
  });
  return seen;
}

test("B1 · the email change asks for the password, says no plainly, then sends (real server)", async () => {
  test.setTimeout(4 * 60_000);
  const seen = watch("POST", "/api/me/email/request-change");
  await startEmailChange(`sec3-new-${Date.now().toString(36)}@example.com`);
  await snap("B1-email-confirm");

  where = "email-no-password";
  await press("Send verification link");
  await waitInner((j) => /Enter your current password to confirm/.test(j), 10_000);
  await snap("B1-email-password-needed");
  const stillSignedIn = await page.evaluate(() => !!sessionStorage.getItem("kiwi_authToken"));

  where = "email-wrong-password";
  await byTestId("reauth-password").fill("not-my-password");
  await press("Send verification link");
  await waitInner((j) => /That password isn't right/.test(j), 10_000);
  await snap("B1-email-password-incorrect");

  where = "email-ok";
  await byTestId("reauth-password").fill(password);
  await press("Send verification link");
  const ok = await waitInner((j) => /Check your email for a verification link/.test(j), 15_000);
  await snap("B1-email-sent");
  screens["B1"] = { seen, stillSignedIn, ok };
  expect(seen.map((s) => s.status)).toEqual([403, 403, 200]);
  expect(seen[0].body.currentPassword, "nothing typed → no key").toBeUndefined();
  expect(stillSignedIn, "a re-auth refusal must not sign the member out").toBe(true);
  expect(ok).toBe(true);
});

test("B1b · a Google/Apple-only account is asked to sign in again (that refusal answered in the browser)", async () => {
  test.setTimeout(3 * 60_000);
  await page.route("**/api/me/email/request-change", (route) =>
    route
      .fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ code: "reauth_required", method: "sign_in", error: "sign in again to continue" }),
      })
      .catch(() => {}),
  );
  await startEmailChange(`sec3-new2-${Date.now().toString(36)}@example.com`);
  where = "email-sign-in";
  await press("Send verification link");
  await waitInner((j) => /been a while since you signed in/.test(j), 10_000);
  await page.waitForTimeout(1500);
  await snap("B1b-email-sign-in-again");
  await byTestId("reauth-sign-in-again").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await snap("B1b-email-sign-in-again-buttons");
  const fieldGone = (await byTestId("reauth-password").count()) === 0;
  await page.unrouteAll({ behavior: "ignoreErrors" });
  screens["B1b"] = { fieldGone };
  expect(fieldGone, "no password field for an account without one").toBe(true);
});

test("B2 · log out ends EVERY session (SEC-2) and lands signed-out; sign back in", async () => {
  test.setTimeout(3 * 60_000);
  await visit("profile-logout", "/profile", (j) => /Log Out/.test(j));
  const before = await page.evaluate(() => sessionStorage.getItem("kiwi_authToken"));
  const seen = watch("POST", "/api/auth/logout");
  await page.getByText("Log Out", { exact: true }).click();
  // Signed out: Sign in (where SessionGate lands it) or Welcome.
  const out = await waitInner((j) => /free trial|Forgot your password/i.test(j) && !/Log Out/.test(j), 20_000);
  screens["B2-landed-first"] = new URL(page.url()).pathname;
  const token = await page.evaluate(() => sessionStorage.getItem("kiwi_authToken"));
  await snap("B2-after-logout");
  // The old token is dead on the server, not just forgotten here.
  const me = await fetch(`${WEB_ORIGIN}/api/auth/me`, { headers: { authorization: `Bearer ${before}` } });
  await page.goto(`${WEB_ORIGIN}/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const bounced = !/Log Out/.test(await page.evaluate(() => document.body.innerText));
  screens["B2"] = { landed: page.url(), out, tokenCleared: token === null, logout: seen, oldTokenMe: me.status, bounced };
  expect(out && token === null && bounced).toBe(true);
  expect(me.status, "the token from before logout no longer authenticates").toBe(401);

  await visit("sign-in-again", "/sign-in", (j) => /Sign in/i.test(j));
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press(/^\s*Sign in\s*$/);
  await waitInner((j) => /Create a meal plan/.test(j), 30_000);
});

test("B3 · the delete asks for the password, says no plainly, then deletes (real server)", async () => {
  test.setTimeout(4 * 60_000);
  const seen = watch("DELETE", "/api/me");
  await visit("delete-B", "/delete-account", (j) => /Type 'delete' to confirm/.test(j));
  await page.getByPlaceholder("delete", { exact: true }).fill("delete");
  await page.waitForTimeout(300);
  await snap("B3-delete-confirm");

  where = "delete-no-password";
  await press("Delete my account");
  await waitInner((j) => /Enter your current password to confirm/.test(j), 10_000);
  await snap("B3-delete-password-needed");

  where = "delete-wrong-password";
  await byTestId("reauth-password").fill("wrong-one");
  await press("Delete my account");
  await waitInner((j) => /That password isn't right/.test(j), 10_000);
  await snap("B3-delete-password-incorrect");
  const stillHere = /Delete my account/.test(await page.evaluate(() => document.body.innerText));
  screens["B3-refusal-kept-session"] = stillHere;

  where = "delete-real";
  await byTestId("reauth-password").fill(password);
  await press("Delete my account");
  // Signed out, on Sign in (or Welcome); and the account no longer signs in.
  const gone =
    (await waitInner((j) => /free trial|Forgot your password/i.test(j) && !/Delete my account/.test(j), 30_000)) &&
    (await page.evaluate(() => sessionStorage.getItem("kiwi_authToken"))) === null;
  const login = await fetch(`${WEB_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  screens["B3-login-after-delete"] = login.status;
  await snap("B3-deleted");
  screens["B3"] = { seen, gone };
  expect(seen.map((s) => s.status)).toEqual([403, 403, 204]);
  expect(seen.every((s) => s.body.confirm === "delete")).toBe(true);
  expect(stillHere).toBe(true);
  expect(gone).toBe(true);
  expect(login.status, "the deleted account no longer signs in").not.toBe(200);
});

test("Z · zero CSP violations across the run", async () => {
  console.log(`[csp] ${csp.length} violation(s) of OUR policy; ${thirdPartyFrames.length} inside third-party frames (their own CSP)`);
  for (const v of thirdPartyFrames) console.log(`  (frame) ${v.where} · ${v.kind} · ${v.detail.slice(0, 160)}`);
  for (const v of csp) console.log(`  ${v.where} · ${v.kind} · ${v.detail}`);
  expect(csp, JSON.stringify(csp, null, 2)).toEqual([]);
});
