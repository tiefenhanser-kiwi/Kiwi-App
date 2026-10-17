// ─────────────────────────────────────────────────────────────────────────────
// FIX-2 — browser QA for Swap for Similar, the wizard's bullets and short set,
// and Tell Kiwi's household and spice. 375 × 812. DEV ONLY (preflight's fence).
// OPT-IN: runs only with KIWI_E2E_FIX2=1.
//
//   KIWI_E2E_FIX2=1 KIWI_E2E_RUN_ID=fix2 pnpm exec playwright test -c e2e/playwright.config.ts fix2-qa
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN, as TRIAGE-0 does: `fix2-<base36>@example.com`
// (REAL_ACCOUNT_WHERE excludes @example.com; dev has no SIGNUP_ALERT_TO). The
// password is random and in memory only. Never the shared or Hans's account.
//
// 💸 IT SPENDS: six find-similar calls (Haiku), two Tell Kiwi parses (Haiku), one
// Tell Kiwi generate and one wizard generate (Sonnet). The short-set step stubs
// the stream in the browser and spends nothing.
//
// Writes, all to the new account: one plan from six catalog meals (their forks)
// and one plan from Tell Kiwi picks. Verdicts → out/<run>/fix2-qa.json,
// screenshots → out/<run>/fix2-qa/.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { WEB_ORIGIN, ensureRunDir } from "../src/env";
import { ledgerBetween, summarise } from "../src/spend";
import { preflight, teardown, type Preflight } from "../src/stack";
import { Http, Ledger, escapeRe, settle, shot, waitForText } from "./qa1-shared";

const LABEL = "fix2-qa";
const ledger = new Ledger(LABEL);
let pf: Preflight | null = null;

test.skip(process.env.KIWI_E2E_FIX2 !== "1", "FIX-2 QA is opt-in — set KIWI_E2E_FIX2=1");
test.describe.configure({ mode: "serial" });

const email = `fix2-${Date.now().toString(36)}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
let userId = "";
let startedIso = "";

// The FIX-2 measurement set — the same six sources as the before/after table.
const SOURCES = [
  "Crispy Baked Chicken Parmesan with Spaghetti and Garlic Green Beans",
  "Slow-Cooker Chicken and Dumplings",
  "Chicken Piccata with Lemon-Caper Sauce and Angel Hair Pasta",
  "Al Pastor Tacos with Black Bean and Avocado Salad",
  "Baked Lemon-Herb Salmon with White Bean and Tomato Ragout",
  "Pesto Pasta with Cherry Tomatoes and Mozzarella",
];
// The words store/spice.ts treats as real heat (the subset a shelf title shows).
const HOT = /\b(spicy|fiery|arrabbiata|diablo|kung pao|szechuan|sichuan|vindaloo|buffalo|sriracha|habanero|firecracker|gochujang|nashville hot|red curry|green curry)\b/i;

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  pf = await preflight();
  for (const c of pf.checks) console.log(`[preflight] ${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.note}`);
  expect(pf.ok, "preflight failed").toBe(true);
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  ledger.watch(page);
  startedIso = new Date().toISOString();
});

test.afterAll(async () => {
  let spend: unknown = null;
  if (userId) spend = summarise("fix2", startedIso, ledgerBetween(userId, startedIso, new Date().toISOString()));
  console.log(`→ ${ledger.write({ spend })}`.split(email).join("«new-account»"));
  if (pf) teardown(pf);
});

// ── helpers (TRIAGE-0's) ─────────────────────────────────────────────────────

async function press(name: string | RegExp, nth = 0): Promise<void> {
  const re = typeof name === "string" ? new RegExp(`^\\s*${escapeRe(name)}\\s*$`) : name;
  const byRole = page.getByRole("button", { name: re });
  if ((await byRole.count()) > nth) {
    await byRole.nth(nth).click();
    return;
  }
  const byText = page.locator('[tabindex="0"]').filter({ hasText: re });
  await byText.nth(nth).waitFor({ state: "visible", timeout: 20_000 });
  await byText.nth(nth).click();
}

async function innerLines(): Promise<string[]> {
  const t = await page.evaluate(() => document.body.innerText || "");
  return t.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function waitInner(pred: (joined: string) => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred((await innerLines()).join("\n"))) return true;
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

const norm = (t: string) => t.toLowerCase().trim().replace(/\s+/g, " ");

// ── 1 · a fresh account ──────────────────────────────────────────────────────

test("1 · sign-up → onboarding", async () => {
  test.setTimeout(4 * 60_000);
  await ledger.run("1", "Sign-up + onboarding (fresh @example.com account)", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 60_000, minLines: 3 });
    await press("Start your 14-day free trial");
    await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
    await page.getByPlaceholder("First name").fill("Fix");
    await page.getByPlaceholder("Last name").fill("Two");
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await press("Create account");
    const ok = await waitPath(/onboarding/, 60_000);
    const token = await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? "");
    http = new Http(token);
    userId = (await http.get<any>("/auth/me")).user?.id ?? "";
    await settle(page, { timeoutMs: 30_000 });
    for (const c of ["Italian", "Mexican", "Asian"]) await press(c);
    await press("Continue");
    await waitPath(/onboarding-step-3/, 30_000);
    await settle(page, { timeoutMs: 20_000 });
    await press("Finish setup");
    const home = await waitForText(page, (j) => /Create a meal plan/.test(j), 30_000);
    await shot(page, LABEL, "01-home", shots);
    return { verdict: ok && home.ok && !!userId ? "pass" : "fail", evidence: `onboarding=${ok} home=${home.ok}` };
  });
});

// ── A · Swap for Similar, on the six measurement sources ─────────────────────

let swapPlanId = "";

test("A · Swap for Similar: no plan meal, no duplicate, every source", async () => {
  test.setTimeout(8 * 60_000);
  const ids: string[] = [];
  for (const t of SOURCES) {
    const r = await http.get<any>(`/cookbook/meals?q=${encodeURIComponent(t)}`);
    const hit = (r.meals as any[]).find((m) => norm(m.title) === norm(t));
    if (hit) ids.push(hit.id);
  }
  const built = await http.req<any>("POST", "/plans/from-meals", { mealIds: ids, planDurationDays: 7 });
  swapPlanId = built.body.plan?.id ?? built.body.planId ?? built.body.id ?? "";
  const plan = await http.get<any>(`/plans/${swapPlanId}`);
  const inPlan = new Set<string>((plan.plan.items as any[]).map((i) => norm(i.meal.title)));

  for (let nth = 0; nth < ids.length; nth++) {
    await ledger.run(`A.${nth}`, "Swap for Similar (results in the plan · duplicates · time)", async (shots) => {
      await page.goto(`${WEB_ORIGIN}/plan/${swapPlanId}`, { waitUntil: "domcontentloaded" });
      await settle(page, { timeoutMs: 30_000 });
      // The row's own title: the line above its "Swap for Similar Meal" button.
      const t0 = Date.now();
      await press("Swap for Similar Meal", nth);
      const ok = await waitInner((j) => /Best match\n.+\n.+ · .+ min/.test(j), 60_000);
      const ms = Date.now() - t0;
      await settle(page, { timeoutMs: 15_000 });
      await shot(page, LABEL, `A${nth}-swap-similar`, shots);
      const text = await innerLines();
      const after = text.slice(text.lastIndexOf("Best match") + 1);
      const titles = after.filter((l, i) => /·/.test(after[i + 1] ?? "") && !/·/.test(l) && l.length > 8).slice(0, 8);
      const dupInPlan = titles.filter((t) => inPlan.has(norm(t)));
      const dups = titles.length - new Set(titles.map(norm)).size;
      return {
        verdict: ok && titles.length > 0 && dupInPlan.length === 0 && dups === 0 ? "pass" : "fail",
        evidence: `${ms}ms; ${titles.length} results; in plan ${JSON.stringify(dupInPlan)}; duplicates ${dups}; top 5 ${JSON.stringify(titles.slice(0, 5))}`,
      };
    });
  }
});

// ── D · Tell Kiwi, TRIAGE-0's sentence, both paths ───────────────────────────

test("D1 · Tell Kiwi → Meals to choose from: 'for two', 'nothing too spicy'", async () => {
  test.setTimeout(5 * 60_000);
  await ledger.run("D1", "Tell Kiwi → Pick → Build my week (household, spice, plan servings)", async (shots) => {
    const text = "easy weeknight dinners for two, one fish night, nothing too spicy";
    await page.goto(`${WEB_ORIGIN}/tellkiwi?text=${encodeURIComponent(text)}`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    await shot(page, LABEL, "D1-tellkiwi", shots);
    await press(/^Meals to choose from/);
    await press("Build my plan");
    await waitPath(/pick-meals/, 120_000);
    await waitForText(page, (j) => /Build my week/.test(j), 60_000);
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "D1-pick-meals", shots);
    const q = new URL(page.url()).searchParams;
    const household = Number(q.get("householdSize"));
    const requestHousehold = JSON.parse(q.get("request") ?? "{}").householdSize;
    const shelf = JSON.parse(q.get("shelf") ?? '{"meals":[]}').meals as { title: string; description?: string }[];
    const spicy = shelf.filter((m) => HOT.test(`${m.title} ${m.description ?? ""}`)).map((m) => m.title);
    for (let i = 0; i < 5; i++) await press("Pick", 0);
    await press("Build my week");
    await waitPath(/^\/plan\//, 120_000);
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "D1-plan", shots);
    const planId = new URL(page.url()).pathname.split("/").pop() ?? "";
    const plan = await http.get<any>(`/plans/${planId}`);
    const servings = (plan.plan.items as any[]).map((i) => i.meal.servings);
    const profile = (await http.get<any>("/me/preferences")).preferences?.householdSize;
    const ok = household === 2 && requestHousehold === 2 && spicy.length === 0 && servings.every((s) => s === 2) && profile !== 2;
    return {
      verdict: ok ? "pass" : "fail",
      evidence: `householdSize param=${household}, request=${requestHousehold}; spicy on shelf: ${spicy.join(" | ") || "none"} (of ${shelf.length}); plan servings ${JSON.stringify(servings)}; profile household still ${profile}`,
    };
  });
});

test("D2 · Tell Kiwi → Complete plans: 'serves 2', no hot meals", async () => {
  test.setTimeout(5 * 60_000);
  await ledger.run("D2", "Tell Kiwi → Complete plans (card household, spice)", async (shots) => {
    const text = "easy dinners for two, nothing too spicy";
    await page.goto(`${WEB_ORIGIN}/tellkiwi?text=${encodeURIComponent(text)}`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    await press(/^Complete plans/);
    await press("Build my plan");
    await waitPath(/plan-options/, 180_000);
    const ok = await waitInner((j) => /Use This Week/.test(j), 120_000);
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "D2-plan-options", shots);
    const lines = await innerLines();
    const serves = lines.filter((l) => /serves \d/.test(l));
    const hot = lines.filter((l) => HOT.test(l) && !/nothing too spicy|no spicy|not spicy|mild/i.test(l));
    return {
      verdict: ok && serves.length > 0 && serves.every((l) => /serves 2\b/.test(l)) && hot.length === 0 ? "pass" : "fail",
      evidence: `${serves.join(" | ")}; hot lines: ${JSON.stringify(hot)}`,
    };
  });
});

// ── B · the wizard: bullets name only the card's meals ───────────────────────

test("B · wizard: 'Why this works' names only the card's meals", async () => {
  test.setTimeout(6 * 60_000);
  await ledger.run("B", "Wizard plan options (bullets vs the card's meals, the count line)", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    await press("Have Kiwi use my preferences");
    await waitPath(/wizard/, 20_000);
    await settle(page, { timeoutMs: 20_000 });
    await press(/^Complete plans/);
    await press("Build my plan");
    const ok = await waitInner((j) => (j.match(/Use This Week/g) ?? []).length >= 3, 180_000);
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "B-plan-options", shots);
    // Per card: the meal rows and the bullets, from the rendered text.
    const lines = await innerLines();
    const cards: { meals: string[]; why: string[] }[] = [];
    let cur: { meals: string[]; why: string[] } | null = null;
    let inWhy = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\d dinners · serves/.test(l)) { cur = { meals: [], why: [] }; cards.push(cur); inWhy = false; continue; }
      if (!cur) continue;
      if (/^why this works$/i.test(l)) { inWhy = true; continue; }
      if (/^Avg \d+ cal/.test(l)) { inWhy = false; cur = null; continue; }
      if (inWhy) cur.why.push(l);
      else if (/^\d+ min$/.test(lines[i + 1] ?? "")) cur.meals.push(l);
    }
    const subline = lines.find((l) => /plans? Kiwi cooked up/.test(l)) ?? "";
    const shortLine = lines.find((l) => /^Kiwi made \d of \d plans/.test(l)) ?? null;
    return {
      verdict: ok && cards.length === 3 && !shortLine ? "pass" : "fail",
      evidence: `${subline}; short-set line: ${shortLine ?? "none"}; cards ${JSON.stringify(cards)}`,
    };
  });
});

// ── C · a short set is announced (the stream stubbed in the browser: $0) ─────

test("C · a stream that dies after 1 card says 'Kiwi made 1 of 3 plans'", async () => {
  test.setTimeout(4 * 60_000);
  await ledger.run("C", "Short wizard set (stubbed: 1 card, then an error frame)", async (shots) => {
    const card = {
      id: "stub-1",
      title: "Cozy Weeknight Classics",
      tags: ["cozy"],
      mealTitles: ["Chicken Piccata", "Beef Stew", "Shrimp Tacos", "Pesto Pasta", "Baked Salmon"],
      meals: ["Chicken Piccata", "Beef Stew", "Shrimp Tacos", "Pesto Pasta", "Baked Salmon"].map((title) => ({ title, description: null })),
      dailyMacros: { calories: 600, proteinG: 35, carbsG: 55, fatG: 22 },
      whyBullets: ["Five different dinners for the week"],
    };
    const body =
      `event: candidate\ndata: ${JSON.stringify({ index: 0, candidate: card })}\n\n` +
      `event: error\ndata: ${JSON.stringify({ error: "Kiwi got distracted. Try again?", reason: "validation_failed", delivered: 1, requested: 3 })}\n\n`;
    await page.route("**/api/wizard/build-plans", (route) =>
      route.fulfill({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body }),
    );
    try {
      await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
      await settle(page, { timeoutMs: 30_000 });
      await press("Have Kiwi use my preferences");
      await waitPath(/wizard/, 20_000);
      await settle(page, { timeoutMs: 20_000 });
      await press(/^Complete plans/);
      await press("Build my plan");
      const ok = await waitInner((j) => /Kiwi made 1 of 3 plans\. Try again for more options\./.test(j), 60_000);
      await settle(page, { timeoutMs: 10_000 });
      await shot(page, LABEL, "C-short-set", shots);
      const lines = await innerLines();
      const tryAgain = lines.includes("Try again");
      return { verdict: ok && tryAgain ? "pass" : "fail", evidence: `line shown=${ok}; Try again button=${tryAgain}` };
    } finally {
      await page.unroute("**/api/wizard/build-plans");
    }
  });
});
