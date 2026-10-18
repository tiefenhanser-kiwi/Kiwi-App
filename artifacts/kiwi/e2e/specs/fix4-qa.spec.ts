// ─────────────────────────────────────────────────────────────────────────────
// FIX-4 — browser QA: vegetarian plans (A) and Tell Kiwi answering the request
// in front of it (B). 375 × 812. DEV ONLY. OPT-IN: runs only with KIWI_E2E_FIX4=1.
//
//   KIWI_E2E_FIX4=1 KIWI_E2E_FIX4_PHASE=before|after KIWI_E2E_WEB_ORIGIN=http://localhost:<port> \
//     KIWI_E2E_RUN_ID=fix4 pnpm exec playwright test -c e2e/playwright.config.ts fix4-qa
//
// The origin is a same-origin page + /api proxy (FIX-4 ran one per phase: the
// HEAD bundle against a HEAD api-server, and the FIX-4 bundle against a FIX-4
// api-server). B4 needs that proxy's test switch, GET /__fix4/fail-next-shelf,
// which makes the next POST /api/wizard/shelf answer 502; without it B4 reports
// "cant-automate".
//
// 🔴 TWO NEW ACCOUNTS EVERY RUN (`fix4-qa-<veg|plain>-<base36>@example.com`),
// made through the API and handed to the page as its session token. Never
// Hans's account. 💸 SPENDS: one wizard generate (A), three Tell Kiwi parses
// on the shelf path, one Tell Kiwi generate + one "another" (B).
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Ledger, escapeRe, settle, shot } from "./qa1-shared";

const PHASE = process.env.KIWI_E2E_FIX4_PHASE === "before" ? "before" : "after";
const LABEL = `fix4-qa-${PHASE}`;
const ledger = new Ledger(LABEL);
const API = `${WEB_ORIGIN}/api`;

test.skip(process.env.KIWI_E2E_FIX4 !== "1", "FIX-4 QA is opt-in — set KIWI_E2E_FIX4=1");
test.describe.configure({ mode: "serial" });

const TEXTS = ["easy dinners for two, nothing too spicy", "something with whipped cream", "NY strip steak, medium-rare"];
const MEAT = /\b(chicken|beef|pork|bacon|ham|sausage|turkey|steak|lamb|meatballs?|chorizo|pepperoni|prosciutto|pancetta|brisket|ribs|carnitas|salmon|tuna|cod|shrimp|fish|crab|tilapia|halibut|scallops?|clams?|mussels?)\b/i;

const HIDDEN = /\b(chicken|beef|pork|fish|bone) (broth|stock|bouillon)\b|\b(oyster|fish) sauce\b|\bworcestershire\b|\banchov(y|ies)\b|\bgelatin\b/i;
const NOT_MEAT = /\b(vegetable|vegan|veggie|mushroom) (broth|stock)\b|\bvegan worcestershire\b/i;

type Account = { email: string; token: string };
async function newAccount(kind: string, prefs: Record<string, unknown>): Promise<Account> {
  const email = `fix4-qa-${kind}-${Date.now().toString(36)}@example.com`;
  const r = await fetch(`${API}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: `Kw!${randomBytes(9).toString("base64url")}`, firstName: "Fix", lastName: "Four", timezone: "America/New_York", platform: "web" }),
  });
  const j = (await r.json()) as { authToken: string };
  const p = await fetch(`${API}/me/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${j.authToken}` },
    body: JSON.stringify({ onboardingComplete: true, firstRunChoiceMade: true }),
  });
  const q = Object.keys(prefs).length
    ? await fetch(`${API}/me/preferences`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${j.authToken}` },
        body: JSON.stringify(prefs),
      })
    : null;
  if (!r.ok || !p.ok || (q && !q.ok)) throw new Error(`account ${kind}: ${r.status}/${p.status}/${q?.status}`);
  return { email, token: j.authToken };
}

async function pageFor(browser: Browser, a: Account): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => sessionStorage.setItem("kiwi_authToken", t), a.token);
  const page = await ctx.newPage();
  ledger.watch(page);
  return page;
}

async function lines(page: Page): Promise<string[]> {
  const t = await page.evaluate(() => document.body.innerText || "");
  return t.split("\n").map((l) => l.trim()).filter(Boolean);
}
async function waitInner(page: Page, pred: (j: string) => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred((await lines(page)).join("\n"))) return true;
    await page.waitForTimeout(400);
  }
  return false;
}
async function press(page: Page, name: string, nth = 0): Promise<void> {
  const re = new RegExp(`^\\s*${escapeRe(name)}\\s*$`);
  const byRole = page.getByRole("button", { name: re });
  if ((await byRole.count()) > nth) return byRole.nth(nth).click();
  const byText = page.locator('[tabindex="0"]:visible').filter({ hasText: re });
  await byText.nth(nth).waitFor({ state: "visible", timeout: 20_000 });
  await byText.nth(nth).click();
}
async function tapId(page: Page, id: string): Promise<void> {
  const el = page.locator(`[data-testid="${id}"]:visible`);
  await el.waitFor({ timeout: 20_000 });
  await el.click();
}
async function typeRequest(page: Page, text: string): Promise<void> {
  const box = page.locator('[data-testid="wizard-text"]:visible');
  await box.waitFor({ timeout: 20_000 });
  await box.fill(text);
}
async function pickCardTitles(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="meal-pick-card-"]'))
      .map((e) => (e.innerText || "").split("\n")[0]?.trim() ?? "")
      .filter(Boolean),
  );
}

let browser_: Browser;
test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  expect(db.ok, "not the dev database").toBe(true);
  browser_ = browser;
});
test.afterAll(async () => {
  console.log(`→ ${ledger.write({ phase: PHASE, origin: WEB_ORIGIN })}`);
});

// ── A · a vegetarian's Complete plans ────────────────────────────────────────

test("A · Vegetarian saved → the wizard's plans", async () => {
  test.setTimeout(4 * 60_000);
  await ledger.run("A", `Vegetarian Complete plans (${PHASE})`, async (shots) => {
    const acct = await newAccount("veg", { eatingStyles: ["Vegetarian"] });
    const page = await pageFor(browser_, acct);
    await page.goto(`${WEB_ORIGIN}/wizard`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 60_000, minLines: 3 });
    await shot(page, LABEL, `A1-${PHASE}-wizard`, shots);
    await tapId(page, "wizard-path-plans");
    await tapId(page, "wizard-build");
    const done = await waitInner(page, (j) => /Get another plan option/.test(j), 150_000);
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, `A2-${PHASE}-plan-options`, shots);
    const r = await fetch(`${API}/wizard/last-batch`, { headers: { authorization: `Bearer ${acct.token}` } });
    const batch = ((await r.json()) as { batch?: { candidates?: { meals?: { title: string; storeMealId?: string | null }[] }[] } }).batch;
    const meals = (batch?.candidates ?? []).flatMap((c) => c.meals ?? []);
    const meat: string[] = [];
    for (const m of meals) {
      // A catalog meal is read down to its ingredient lines (the stock and the
      // sauce are where a "vegetarian-looking" dinner hides its meat); a live
      // one has only its title until the plan is opened.
      let names: string[] = [m.title];
      if (m.storeMealId) {
        const d = await fetch(`${API}/meals/${m.storeMealId}`, { headers: { authorization: `Bearer ${acct.token}` } });
        const meal = ((await d.json()) as { meal?: { dishes?: { ingredients?: { name: string }[] }[] } }).meal;
        names = [...names, ...(meal?.dishes ?? []).flatMap((x) => (x.ingredients ?? []).map((i) => i.name))];
      }
      const hit = names.find((n) => !NOT_MEAT.test(n) && (MEAT.test(n) || HIDDEN.test(n)));
      if (hit) meat.push(`${m.title} — ${hit}`);
    }
    return {
      verdict: done && meals.length > 0 && meat.length === 0 && (batch?.candidates?.length ?? 0) === 3 ? "pass" : "fail",
      evidence: `plans=${batch?.candidates?.length ?? 0} meals=${meals.length} meatOrFish=${meat.length} ${JSON.stringify(meat)}`,
    };
  });
});

// ── B · three texts in a row, then the stale error, then "another" ───────────

let plain: Account;
let page: Page;
const seen: string[][] = [];

test("B1–B3 · three Tell Kiwi texts in a row on 'Meals to choose from'", async () => {
  test.setTimeout(5 * 60_000);
  plain = await newAccount("plain", {});
  page = await pageFor(browser_, plain);
  for (const [i, text] of TEXTS.entries()) {
    await ledger.run(`B${i + 1}`, `Pick shelf for "${text}" (${PHASE})`, async (shots) => {
      await page.goto(`${WEB_ORIGIN}/tellkiwi`, { waitUntil: "domcontentloaded" });
      await settle(page, { timeoutMs: 60_000, minLines: 3 });
      await typeRequest(page, text);
      await tapId(page, "wizard-path-pick");
      await tapId(page, "wizard-build");
      const ok = await waitInner(page, (j) => /Build my week|Pick|choose/i.test(j) && /pick-meals/.test(page.url()), 90_000);
      // The cards land after the URL changes; wait for them, not just the route.
      const cardsEnd = Date.now() + 60_000;
      while (Date.now() < cardsEnd && (await pickCardTitles(page)).length === 0) await page.waitForTimeout(500);
      await settle(page, { timeoutMs: 15_000 });
      await shot(page, LABEL, `B${i + 1}-${PHASE}-pick`, shots);
      const titles = await pickCardTitles(page);
      const all = (await lines(page)).join("\n");
      seen.push(titles);
      const couldnt = /Couldn't find: [^\n]+/.exec(all)?.[0] ?? "";
      const same = i > 0 && JSON.stringify(seen[i]) === JSON.stringify(seen[i - 1]);
      return {
        verdict: ok ? (same && !couldnt ? "fail" : "pass") : "fail",
        evidence: `cards=${titles.length} sameAsPrevious=${same} ${couldnt} first=${JSON.stringify(titles.slice(0, 3))}`,
      };
    });
  }
});

test("B4 · an error never sticks to the next request", async () => {
  test.setTimeout(3 * 60_000);
  await ledger.run("B4", `Stale error after editing the text (${PHASE})`, async (shots) => {
    const sw = await fetch(`${WEB_ORIGIN}/__fix4/fail-next-shelf`).catch(() => null);
    if (!sw || sw.status !== 204) return { verdict: "cant-automate", evidence: "proxy has no fail-next switch" };
    await page.goto(`${WEB_ORIGIN}/tellkiwi`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 60_000, minLines: 3 });
    await typeRequest(page, TEXTS[0]);
    await tapId(page, "wizard-path-pick");
    await tapId(page, "wizard-build");
    const errShown = await waitInner(page, (j) => j.includes("Kiwi got distracted"), 30_000);
    await shot(page, LABEL, `B4a-${PHASE}-error`, shots);
    await typeRequest(page, TEXTS[1]);
    await page.waitForTimeout(800);
    const stillThere = (await lines(page)).join("\n").includes("Kiwi got distracted");
    await shot(page, LABEL, `B4b-${PHASE}-after-edit`, shots);
    return {
      verdict: errShown && !stillThere ? "pass" : "fail",
      evidence: `errorShown=${errShown} errorStillShownAfterEditingText=${stillThere}`,
    };
  });
});

test("B5 · Complete plans, then 'Get another plan option'", async () => {
  test.setTimeout(5 * 60_000);
  await ledger.run("B5", `Tell Kiwi another (${PHASE})`, async (shots) => {
    await page.goto(`${WEB_ORIGIN}/tellkiwi`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 60_000, minLines: 3 });
    await typeRequest(page, TEXTS[0]);
    await tapId(page, "wizard-path-plans");
    await tapId(page, "wizard-build");
    const shown = await waitInner(page, (j) => /Get another plan option/.test(j), 150_000);
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, `B5a-${PHASE}-plans`, shots);
    const read = async () => {
      const r = await fetch(`${API}/wizard/last-batch`, { headers: { authorization: `Bearer ${plain.token}` } });
      return (((await r.json()) as { batch?: { candidates?: { title: string; meals?: { title: string }[] }[] } }).batch?.candidates ?? []);
    };
    const first = await read();
    await press(page, "Get another plan option");
    await waitInner(page, (j) => !/Kiwi is thinking|Cooking up/i.test(j), 5_000);
    const end = Date.now() + 120_000;
    let after = first;
    while (Date.now() < end) {
      after = await read();
      if (after.length > first.length) break;
      await page.waitForTimeout(1500);
    }
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, `B5b-${PHASE}-another`, shots);
    const shownMeals = new Set(first.flatMap((c) => (c.meals ?? []).map((m) => m.title.toLowerCase())));
    const added = after.slice(first.length);
    const repeats = added.flatMap((c) => (c.meals ?? []).map((m) => m.title)).filter((t) => shownMeals.has(t.toLowerCase()));
    const toast = /couldn't find another distinct plan/i.test((await lines(page)).join("\n"));
    return {
      verdict: shown && (added.length > 0 ? repeats.length === 0 : toast) ? "pass" : "fail",
      evidence: `firstPlans=${first.length} added=${added.length} repeatedShownMeals=${repeats.length} ${JSON.stringify(repeats)} outOfNewToast=${toast}`,
    };
  });
});
