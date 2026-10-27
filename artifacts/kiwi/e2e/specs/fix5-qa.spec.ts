// ─────────────────────────────────────────────────────────────────────────────
// FIX-5 — browser QA for Hans's Pixel-pass refinements. 375 × 812, DEV ONLY.
// OPT-IN: runs only with KIWI_E2E_FIX5=1.
//
//   KIWI_E2E_FIX5=1 KIWI_E2E_FIX5_PHASE=after KIWI_E2E_RUN_ID=fix5 \
//     KIWI_E2E_WEB_ORIGIN=http://localhost:9100 \
//     pnpm exec playwright test -c e2e/playwright.config.ts fix5-qa
//
// KIWI_E2E_FIX5_PHASE=before photographs the Recipes page only (item 3's
// "before"), against a bundle exported before the restyle.
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN: `fix5-<base36>@example.com`, random
// in-memory password. Never Hans's account. No AI spend: every plan is made
// through POST /plans and POST /plans/use-template.
//
// The origin is whatever KIWI_E2E_WEB_ORIGIN says, and no preflight runs: this
// lane served its own export through its own proxy to its own API (:3100),
// because the other lane restarts :3000. The dev-database fence still runs.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, Ledger, escapeRe, settle, shot, skipHowHeard, todayYmd, waitForText } from "./qa1-shared";

const PHASE = process.env.KIWI_E2E_FIX5_PHASE === "before" ? "before" : "after";
const LABEL = `fix5-qa-${PHASE}`;
const ledger = new Ledger(LABEL);

test.skip(process.env.KIWI_E2E_FIX5 !== "1", "FIX-5 QA is opt-in — set KIWI_E2E_FIX5=1");
test.describe.configure({ mode: "serial" });

const email = `fix5-${Date.now().toString(36)}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;

const NEW_TITLE = "No plan set for this week yet";
const NEW_BODY = "Get a plan in seconds with Kiwi, choose a Featured Plan, or use one of your saved plans.";

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  ledger.watch(page);
});

test.afterAll(async () => {
  console.log(`→ ${ledger.write()}`.split(email).join("«new-account»"));
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function press(name: string | RegExp, nth = 0): Promise<void> {
  const re = typeof name === "string" ? new RegExp(`^\\s*${escapeRe(name)}\\s*$`) : name;
  const byRole = page.getByRole("button", { name: re });
  if ((await byRole.count()) > nth) {
    await byRole.nth(nth).click();
    return;
  }
  // :visible — a pushed screen leaves the one under it mounted (hidden), and
  // the Recipes Cookbook card shares its text with the builder's option.
  const byText = page.locator('[tabindex="0"]:visible').filter({ hasText: re });
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

async function gotoTab(name: string): Promise<void> {
  const tab = page.getByRole("tab", { name: new RegExp(`^${escapeRe(name)}`, "i") });
  if ((await tab.count()) > 0) await tab.first().click();
  else await page.getByText(name, { exact: true }).last().click();
  await page.waitForTimeout(600);
}

const iso = (ymd: string) => `${ymd}T12:00:00.000Z`;
function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(y, m - 1, d + n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/** WCAG contrast of two computed rgb() strings. */
function contrast(a: string, b: string): number {
  const lum = (s: string) => {
    const [r, g, bl] = (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The colours of the Recipes page's three actions, as rendered. */
async function recipesColours(): Promise<Record<string, { bg: string; fg: string; border: string } | null>> {
  return page.evaluate(() => {
    const pick = (el: HTMLElement | null) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const label = Array.from(el.querySelectorAll<HTMLElement>("div")).find((d) => d.children.length === 0 && (d.innerText || "").trim()) ?? el;
      return { bg: cs.backgroundColor, fg: getComputedStyle(label).color, border: `${cs.borderTopWidth} ${cs.borderTopColor}` };
    };
    const focusables = Array.from(document.querySelectorAll<HTMLElement>('[tabindex="0"]'));
    const byText = (t: string) => focusables.find((e) => (e.innerText || "").trim() === t) ?? null;
    return {
      cookbook: pick(document.querySelector<HTMLElement>('[data-testid="recipes-cookbook-card"]')),
      mealsSegment: pick(byText("Meals")),
      dishesSegment: pick(byText("Dishes")),
      segmentTrack: pick((byText("Meals")?.parentElement as HTMLElement | null) ?? null),
      addMeal: pick(byText("+ Add Meal")),
      addDish: pick(byText("+ Add Dish")),
    };
  });
}

// ── 0 · a fresh account ──────────────────────────────────────────────────────

test("0 · sign-up → onboarding → first Home", async () => {
  test.setTimeout(4 * 60_000);
  await ledger.run("0", "Sign-up + onboarding (throwaway account)", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 60_000, minLines: 3 });
    await press("Start your 14-day free trial");
    await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
    await page.getByPlaceholder("First name").fill("Fix");
    await page.getByPlaceholder("Last name").fill("Five");
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await press("Create account");
    await skipHowHeard(page); // CLIENT-3 D — a new account's question
    const ok = await waitPath(/onboarding/, 60_000);
    const token = await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? "");
    http = new Http(token);
    await settle(page, { timeoutMs: 30_000 });
    for (const c of ["Italian", "Mexican", "Asian"]) await press(c);
    await press("Continue");
    await waitPath(/onboarding-step-3/, 30_000);
    await settle(page, { timeoutMs: 20_000 });
    await press("Finish setup");
    const home = await waitForText(page, (j) => /Create a meal plan/.test(j), 30_000);
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, "00-home-new-user", shots);
    return { verdict: ok && home.ok && !!token ? "pass" : "fail", evidence: `onboarding=${ok} home=${home.ok}` };
  });
});

// ── 3 · the Recipes page (both phases) ───────────────────────────────────────

test("3 · Recipes page actions: colours, both sub-tabs", async () => {
  test.setTimeout(3 * 60_000);
  await ledger.run("3", `Recipes page actions (${PHASE})`, async (shots) => {
    await gotoTab("Recipes");
    const ok = await waitInner((j) => j.includes("Browse the Kiwi Cookbook") && j.includes("+ Add Meal"), 30_000);
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, `03-${PHASE}-recipes-meals`, shots);
    const meals = await recipesColours();
    await press("Dishes");
    await waitInner((j) => j.includes("+ Add Dish"), 20_000);
    await settle(page, { timeoutMs: 10_000 });
    await shot(page, LABEL, `03-${PHASE}-recipes-dishes`, shots);
    const dishes = await recipesColours();
    await press("Meals");
    const c = (x: { bg: string; fg: string } | null | undefined) => (x ? contrast(x.fg, x.bg).toFixed(2) : "n/a");
    const ev = {
      cookbook: meals.cookbook,
      mealsActive: meals.mealsSegment,
      mealsActiveContrast: c(meals.mealsSegment),
      dishesInactive: meals.dishesSegment,
      dishesInactiveOnTrack: meals.dishesSegment && meals.segmentTrack ? contrast(meals.dishesSegment.fg, meals.segmentTrack.bg).toFixed(2) : "n/a",
      track: meals.segmentTrack?.bg,
      addMeal: meals.addMeal,
      addMealContrast: c(meals.addMeal),
      dishesActive: dishes.dishesSegment,
      addDish: dishes.addDish,
      addDishContrast: c(dishes.addDish),
    };
    return { verdict: ok ? "pass" : "fail", evidence: JSON.stringify(ev) };
  });
});

// ── everything below is the after phase only ─────────────────────────────────

let tplName = "";
const PLAN_A = "FIX5 A this week";
const PLAN_B = "FIX5 B undated";
const PLAN_C = "FIX5 C in two weeks";
let planAId = "";

test("1 · Home 'no plan this week' card: a message, no buttons, 375 px + largest text", async () => {
  test.skip(PHASE !== "after", "after phase only");
  test.setTimeout(3 * 60_000);
  // ⚠️ Not POST /plans/use-template: on dev (Oct 17) it 500s — the template's
  // meal forks overrun Prisma's 5 s interactive-transaction default
  // (mealFork.ts, "Transaction not found"). An undated plan is the same
  // "plans, none this week" state for Home.
  tplName = "FIX5 T saved for later";
  const made = await http.req<any>("POST", "/plans", { name: tplName });
  const mine = await http.get<any>(`/plans?filter=my_plans&localDate=${todayYmd()}`);
  console.log(
    `[${LABEL}] POST /plans → ${made.status}; my_plans ${JSON.stringify(
      (mine.plans as any[]).map((p) => [p.name, p.startDate, p.endDate, p.status]),
    )}`,
  );

  await ledger.run("1", "Card shows Hans's copy and nothing pressable", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    const ok = await waitInner((j) => j.includes(NEW_TITLE), 30_000);
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, "01a-home-card-375", shots);
    const j = (await innerLines()).join("\n");
    const probe = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="home-no-plan-this-week"]');
      if (!card) return null;
      const pressables = card.querySelectorAll('[role="button"], button, [tabindex="0"]').length;
      return { pressables, text: card.innerText };
    });
    const below = j.indexOf(NEW_TITLE) < j.toLowerCase().indexOf("plan something new") &&
      j.toLowerCase().includes("featured plans");
    const gone = ["Go to Plans", "See featured", "Cook something up"].filter((g) => j.includes(g));

    // Largest text: RNW's fontScale is always 1, so scale the card's computed
    // font sizes and line heights by 2 (Android's top font-size step).
    await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="home-no-plan-this-week"]');
      if (!card) return;
      for (const el of [card, ...Array.from(card.querySelectorAll<HTMLElement>("*"))]) {
        const cs = getComputedStyle(el);
        const fs = parseFloat(cs.fontSize);
        const lh = parseFloat(cs.lineHeight);
        if (fs) el.style.fontSize = `${fs * 2}px`;
        if (lh) el.style.lineHeight = `${lh * 2}px`;
      }
    });
    await page.waitForTimeout(400);
    await shot(page, LABEL, "01b-home-card-largest-text", shots);
    const clip = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="home-no-plan-this-week"]');
      if (!card) return "no card";
      const r = card.getBoundingClientRect();
      const over = Array.from(card.querySelectorAll<HTMLElement>("div")).filter((d) => d.scrollWidth > d.clientWidth + 1 || d.scrollHeight > d.clientHeight + 1);
      return `card ${Math.round(r.width)}×${Math.round(r.height)}, right edge ${Math.round(r.right)} of ${window.innerWidth}, overflowing divs ${over.length}`;
    });
    return {
      verdict: ok && probe && probe.pressables === 0 && j.includes(NEW_BODY) && gone.length === 0 && below ? "pass" : "fail",
      evidence: `card=${ok}; pressables in card=${probe?.pressables}; body verbatim=${j.includes(NEW_BODY)}; old labels present=${JSON.stringify(gone)}; above make lane + rail on page=${below}; largest text: ${clip} (undated plan "${tplName}")`,
    };
  });
});

test("2 · add-to-plan sheet: one list, newest added first", async () => {
  test.skip(PHASE !== "after", "after phase only");
  test.setTimeout(3 * 60_000);
  const today = todayYmd();
  // Created in this order: A (dated, this week), B (undated), C (dated, later).
  // Newest first is C, B, A, then item 1's plan T.
  const a = await http.req<any>("POST", "/plans", { name: PLAN_A, startDate: iso(today), endDate: iso(addDaysYmd(today, 6)) });
  planAId = a.body.instance?.id ?? "";
  await page.waitForTimeout(50);
  const b = await http.req<any>("POST", "/plans", { name: PLAN_B });
  await page.waitForTimeout(50);
  const c = await http.req<any>("POST", "/plans", { name: PLAN_C, startDate: iso(addDaysYmd(today, 14)), endDate: iso(addDaysYmd(today, 20)) });

  await ledger.run("2", "Pick an existing plan lists C, B, A, T (date added, newest first)", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/cookbook`, { waitUntil: "domcontentloaded" });
    await page.locator('[aria-label="Add to a plan"]').first().waitFor({ timeout: 45_000 });
    await settle(page, { timeoutMs: 15_000 });
    await page.locator('[aria-label="Add to a plan"]').first().click();
    const open = await waitInner((j) => j.includes("Create a new plan") && j.includes(PLAN_C), 20_000);
    await settle(page, { timeoutMs: 10_000 });
    await shot(page, LABEL, "02-add-to-plan-sheet", shots);
    const lines = await innerLines();
    const idx = (n: string) => lines.findIndex((l) => l === n || l.startsWith(n));
    const order = [PLAN_C, PLAN_B, PLAN_A, tplName].map((n) => ({ n, i: idx(n) }));
    const sorted = order.every((o, k) => o.i >= 0 && (k === 0 || o.i > order[k - 1].i));
    const bIdx = idx(PLAN_B);
    const bLabel = bIdx >= 0 ? lines.slice(bIdx, bIdx + 3).join(" / ") : "";
    await page.keyboard.press("Escape");
    return {
      verdict: open && sorted && /No dates yet/.test(bLabel) ? "pass" : "fail",
      evidence: `created A=${a.status} B=${b.status} C=${c.status}; sheet line order ${JSON.stringify(order)}; B row "${bLabel}"`,
    };
  });
});

test("4 · Add Meal: 'Browse the Kiwi Cookbook' above the imports; from a plan, what the Cookbook's + does", async () => {
  test.skip(PHASE !== "after", "after phase only");
  test.setTimeout(4 * 60_000);
  await ledger.run("4a", "Recipes → + Add Meal shows the Cookbook option between Ask Kiwi and the imports; it opens /cookbook", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 20_000 });
    await gotoTab("Recipes");
    await waitInner((j) => j.includes("+ Add Meal"), 30_000);
    await press("+ Add Meal");
    const ok = await waitInner((j) => j.includes("Browse the Kiwi Cookbook") && j.includes("Import from URL"), 20_000);
    await settle(page, { timeoutMs: 10_000 });
    await shot(page, LABEL, "04a-add-meal-picker", shots);
    const lines = await innerLines();
    const i = (t: string) => lines.findIndex((l) => l === t);
    const order = ["Ask Kiwi for a meal", "Browse the Kiwi Cookbook", "Import from URL", "Import from photo", "Import from text", "Create manually", "Combine dishes you've saved"].map((t) => i(t));
    const inOrder = order.every((v, k) => v >= 0 && (k === 0 || v > order[k - 1]));
    await press(/Browse the Kiwi Cookbook/);
    const landed = await waitPath(/^\/cookbook$/, 20_000);
    await waitInner((j) => /meals/.test(j), 20_000);
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, "04b-cookbook-from-add-meal", shots);
    return {
      verdict: ok && inOrder && landed ? "pass" : "fail",
      evidence: `picker=${ok}; option line indices ${JSON.stringify(order)}; landed on ${new URL(page.url()).pathname}`,
    };
  });

  await ledger.run("4c", "From a plan (addToPlanId): the Cookbook's + does NOT target that plan (report)", async (shots) => {
    // The plan's Add-a-meal sheet → "Create manually" pushes exactly this.
    await page.goto(`${WEB_ORIGIN}/meal-builder?addToPlanId=${planAId}`, { waitUntil: "domcontentloaded" });
    const ok = await waitInner((j) => j.includes("Browse the Kiwi Cookbook"), 30_000);
    await settle(page, { timeoutMs: 10_000 });
    await press(/Browse the Kiwi Cookbook/);
    await waitPath(/^\/cookbook$/, 20_000);
    const url = page.url();
    await page.locator('[aria-label="Add to a plan"]').first().waitFor({ timeout: 45_000 });
    await settle(page, { timeoutMs: 15_000 });
    await page.locator('[aria-label="Add to a plan"]').first().click();
    const sheet = await waitInner((j) => j.includes("Create a new plan"), 20_000);
    await settle(page, { timeoutMs: 10_000 });
    await shot(page, LABEL, "04c-cookbook-plus-from-plan-context", shots);
    const j = (await innerLines()).join("\n");
    const listsAll = [PLAN_A, PLAN_B, PLAN_C].every((n) => j.includes(n));
    const dayStepFirst = /Which day|Pick a day/i.test(j) && !j.includes(PLAN_C);
    await page.keyboard.press("Escape");
    return {
      verdict: ok && sheet ? "pass" : "fail",
      evidence: `builder had the option=${ok}; Cookbook url ${new URL(url).pathname}${new URL(url).search || " (no params)"}; + opened the plan picker=${sheet}; lists every live plan=${listsAll}; skipped to the origin plan's days=${dayStepFirst}`,
    };
  });
});
