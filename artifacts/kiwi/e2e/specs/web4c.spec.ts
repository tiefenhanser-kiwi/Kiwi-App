// ─────────────────────────────────────────────────────────────────────────────
// WEB-4c — the web's scroll and bars, at 1280 × 800 (and Tell Kiwi at 375).
// DEV ONLY. OPT-IN: KIWI_E2E_WEB4C=1.
//
//   KIWI_E2E_WEB4C=1 KIWI_E2E_RUN_ID=web4c KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//     pnpm exec playwright test -c e2e/playwright.config.ts web4c
//
//   D (BUG-470) — on every scrolling screen, a Playwright WHEEL over the left
//     margin (x 100, outside the 720 column) must move the screen's scroller.
//     A screen whose content is not taller than the window is retried at
//     1280 × 480 and 1280 × 320; one that still cannot scroll is reported
//     (and photographed), not passed.
//   E (BUG-471) — Home at scroll 0 and 600, and the bars (the wizard's "Build my
//     plan", Prep the Week's footer, Pick's footer), photographed at 1280.
//   C (BUG-466) — Tell Kiwi's empty box at 375 and 1280.
//
// Shots: out/<run>/<width>/NN-<name>.png; the wheel table: out/<run>/wheel.json.
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN: `web4c-<base36>@example.com`. Never
// Hans's account. AI spend: none — Prep the Week's POST is answered in the
// browser with a fixed result (page.route), and nothing else calls a model.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, todayYmd } from "./qa1-shared";

// web4-sweep's corpus meals: the first is a two-dish meal.
const MEAL_IDS = [
  "3424eefa-423c-4be1-a987-8a55c8811576",
  "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d",
  "00e3a8ec-d909-466b-9c20-8f3cf5f7e544",
  "085c6353-756e-43e3-a99f-4058c5a6ef9b",
  "0314d364-b8af-46c9-8f34-a73e21630470",
];

test.skip(process.env.KIWI_E2E_WEB4C !== "1", "WEB-4c is opt-in — set KIWI_E2E_WEB4C=1");
test.describe.configure({ mode: "serial" });

const email = `web4c-${Date.now().toString(36)}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
const fixture = { planId: "", planItemId: "", mealId: MEAL_IDS[0], dishId: "", planMealIds: [] as string[] };
const wheel: Record<string, unknown> = {};
const notes: string[] = [];

let n = 0;
async function snap(width: number, name: string): Promise<void> {
  const d = join(RUN_DIR, String(width));
  mkdirSync(d, { recursive: true });
  await page.screenshot({ path: join(d, `${String(++n).padStart(2, "0")}-${name}.png`) });
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

async function visit(path: string, ready: (j: string) => boolean, timeoutMs = 45_000): Promise<boolean> {
  await page.goto(`${WEB_ORIGIN}${path}`, { waitUntil: "domcontentloaded" });
  const ok = await waitInner(ready, timeoutMs);
  await settle(page, { timeoutMs: 20_000 });
  return ok;
}

/** Every visible vertical scroller: its box and scrollTop, and what sits under (100, 400). */
async function scrollState(): Promise<{ tops: number[]; scrollers: number; marginHit: string; marginInScroller: boolean }> {
  return page.evaluate(() => {
    const vertical = (el: Element) => {
      const st = getComputedStyle(el);
      return (st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1;
    };
    const list = Array.from(document.querySelectorAll("div")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && vertical(el);
    });
    const hit = document.elementFromPoint(100, 400);
    let inScroller = false;
    for (let e: Element | null = hit; e; e = e.parentElement) if (vertical(e)) inScroller = true;
    return {
      tops: list.map((el) => el.scrollTop),
      scrollers: list.length,
      marginHit: hit ? `${hit.tagName}.${(hit as HTMLElement).className?.toString().slice(0, 30)}` : "none",
      marginInScroller: inScroller,
    };
  });
}

/** E — the first opaque background under (10, y), (640, y) and (1270, y): one
 *  colour when the bar's band spans the window. */
async function bandAt(y: number): Promise<string[]> {
  return page.evaluate((yy) =>
    [10, 640, 1270].map((x) => {
      for (let e = document.elementFromPoint(x, yy); e; e = e.parentElement) {
        const bg = getComputedStyle(e).backgroundColor;
        if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
      }
      return "none";
    }), y);
}

/** D — the wheel over the left margin moves the screen. */
async function wheelOverMargin(name: string): Promise<boolean> {
  for (const h of [800, 480, 320]) {
    await page.setViewportSize({ width: 1280, height: h });
    await page.waitForTimeout(400);
    const before = await scrollState();
    if (before.scrollers === 0) continue;
    await page.mouse.move(100, Math.min(400, h - 80));
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(500);
    const after = await scrollState();
    const moved = after.tops.reduce((a, b) => a + b, 0) - before.tops.reduce((a, b) => a + b, 0);
    wheel[name] = { height: h, scrollers: before.scrollers, moved, marginHit: before.marginHit, marginInScroller: before.marginInScroller };
    await page.setViewportSize({ width: 1280, height: 800 });
    return moved > 0;
  }
  wheel[name] = { scrollers: 0, note: "not taller than the window at 1280 × 800, 480 or 320" };
  await page.setViewportSize({ width: 1280, height: 800 });
  await snap(1280, `no-scroller-${name}`);
  return false;
}

// Prep the Week, answered in the browser: one phase of twelve long steps, so the
// screen is taller than the window. Meal ids are the plan's own.
function prepWeekStub(mealIds: string[]) {
  const steps = Array.from({ length: 12 }, (_, i) => ({
    number: i + 1,
    stepKey: `produce#${mealIds[i % mealIds.length]}#${i}`,
    title: `Prep step ${i + 1}`,
    instructions: "Dice 2 cups onions, mince 6 cloves garlic and slice 3 bell peppers; pack each in its own container for the week.",
    estimatedMinutes: 5,
    contributesToMealIds: [mealIds[i % mealIds.length]],
    storageNote: "Airtight, 4 days",
  }));
  return {
    cacheHit: true,
    // The client wants the four phases, in order (PrepWeekResultSchema).
    result: {
      totalEstimatedMinutes: 60,
      containerCount: 6,
      phases: [
        { phase: "seasonings_dry", title: "Seasonings & dry", skippable: true, steps: [] },
        { phase: "produce", title: "Produce", skippable: false, steps },
        { phase: "sauces_marinades", title: "Sauces & marinades", skippable: true, steps: [] },
        { phase: "proteins", title: "Proteins", skippable: false, steps: [] },
      ],
    },
    planRevisionId: 1,
    generatedAt: new Date().toISOString(),
    promptVersion: 1,
  };
}

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
});

test.afterAll(async () => {
  writeFileSync(join(RUN_DIR, "wheel.json"), JSON.stringify({ fixture, notes, wheel }, null, 2), "utf8");
});

test("1 · sign-up → onboarding, then the fixture plan", async () => {
  test.setTimeout(6 * 60_000);
  await visit("/", (j) => /free trial/i.test(j), 60_000);
  await press("Start your 14-day free trial");
  await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("First name").fill("Web");
  await page.getByPlaceholder("Last name").fill("Fourc");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press("Create account");
  expect(await waitPath(/onboarding/, 60_000), "reached onboarding").toBe(true);
  http = new Http(await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? ""));
  await settle(page, { timeoutMs: 30_000 });
  for (const c of ["Italian", "Mexican", "Asian"]) await press(c);
  await press("Continue");
  await waitPath(/onboarding-step-3/, 30_000);
  await settle(page, { timeoutMs: 20_000 });
  await press("Finish setup");
  await waitInner((j) => /Create a meal plan/.test(j), 30_000);

  const made = await http.req<any>("POST", "/plans/from-meals", { mealIds: MEAL_IDS, planDurationDays: 7, localDate: todayYmd() });
  const plan = made.body.plan ?? made.body;
  fixture.planId = String(plan.id ?? made.body.planId ?? "");
  notes.push(`from-meals → ${made.status}`);
  // Three more plans, so Plans is a list taller than a short window. $0 AI.
  for (let i = 0; i < 3; i++) {
    const more = await http.req<any>("POST", "/plans/from-meals", { mealIds: MEAL_IDS.slice(i, i + 2), planDurationDays: 7, localDate: todayYmd() });
    notes.push(`from-meals (extra ${i + 1}) → ${more.status}`);
  }
  const detail = await http.get<any>(`/plans/${fixture.planId}`);
  const inst = detail.instance ?? detail.plan ?? detail;
  const items = (inst.items ?? []) as any[];
  fixture.planMealIds = items.map((it) => String(it.mealId)).filter(Boolean);
  fixture.planItemId = String(items[0]?.id ?? "");
  if (items[0]?.mealId) fixture.mealId = String(items[0].mealId);
  const meal = await http.get<any>(`/meals/${fixture.mealId}`);
  fixture.dishId = String((meal.dishes ?? meal.meal?.dishes ?? [])[0]?.dishId ?? "");
  notes.push(`plan ${fixture.planId} item ${fixture.planItemId} meal ${fixture.mealId} dish ${fixture.dishId}`);
  expect(fixture.planId).not.toBe("");
});

test("2 · D — a wheel over the margin scrolls every screen (1280)", async () => {
  test.setTimeout(15 * 60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const { planId, planItemId, mealId, dishId } = fixture;
  await page.route("**/api/plans/*/prep-week", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(prepWeekStub(fixture.planMealIds)) })
      : route.continue(),
  );
  const screens: [name: string, open: () => Promise<unknown>][] = [
    ["home", () => visit("/", (j) => /Good (morning|afternoon|evening)/.test(j), 60_000)],
    ["plans", () => visit("/plans", (j) => j.trim().length > 40)],
    ["plan-detail", () => visit(`/plan/${planId}`, (j) => /Mon|Tue|Wed|Thu|Fri|Sat|Sun/.test(j))],
    ["meal", () => visit(`/meal/${mealId}?planId=${planId}&planItemId=${planItemId}`, (j) => /Ingredients/i.test(j))],
    ["dish", () => visit(`/dish/${dishId}`, (j) => /Ingredients|Steps/i.test(j))],
    ["cookbook", () => visit("/cookbook", (j) => j.trim().length > 80)],
    ["recipes", () => visit("/meals", (j) => j.trim().length > 40)],
    ["groceries", () => visit("/groceries", (j) => j.trim().length > 20)],
    ["prep-cook", () => visit(`/prep-cook?id=${planId}`, (j) => j.trim().length > 40)],
    ["prep-the-week", () => visit(`/cook-session?mode=prep-week&planId=${planId}`, (j) => /Prep step 1/.test(j), 60_000)],
    ["profile", () => visit("/profile", (j) => j.trim().length > 40)],
    ["wizard", () => visit("/wizard", (j) => /Build my plan/.test(j))],
    [
      "sheet-ingredients",
      async () => {
        await visit(`/meal/${mealId}?planId=${planId}&planItemId=${planItemId}`, (j) => /Ingredients/i.test(j));
        await page.getByLabel("View all ingredients").first().click();
        await page.waitForTimeout(800);
      },
    ],
  ];
  const failed: string[] = [];
  for (const [name, open] of screens) {
    try {
      await open();
      if (!(await wheelOverMargin(name))) failed.push(name);
    } catch (err) {
      notes.push(`${name}: ${String(err).slice(0, 200)}`);
      failed.push(name);
    }
  }
  await page.unroute("**/api/plans/*/prep-week");
  console.log(`[wheel] ${JSON.stringify(wheel)}`);
  expect(failed, `screens the margin wheel did not scroll: ${failed.join(", ")}`).toEqual([]);
});

test("3 · E — Home's header and the bars, at 1280", async () => {
  test.setTimeout(6 * 60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await visit("/", (j) => /Good (morning|afternoon|evening)/.test(j), 60_000);
  await snap(1280, "home-scroll-0");
  await page.mouse.move(100, 400);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(700);
  await snap(1280, "home-scroll-600");
  const homeBand = await bandAt(50);
  wheel["home-header-band"] = homeBand;
  await visit("/wizard", (j) => /Build my plan/.test(j));
  await snap(1280, "wizard-bar");
  const wizardBand = await bandAt(140);
  wheel["wizard-cta-band"] = wizardBand;
  await page.route("**/api/plans/*/prep-week", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(prepWeekStub(fixture.planMealIds)) })
      : route.continue(),
  );
  await visit(`/cook-session?mode=prep-week&planId=${fixture.planId}`, (j) => /Prep step 1/.test(j), 60_000);
  await snap(1280, "prep-week-footer");
  await page.unroute("**/api/plans/*/prep-week");
  await visit("/pick-meals", (j) => j.trim().length > 40);
  await snap(1280, "pick-footer");
  for (const [name, b] of [["Home's header", homeBand], ["the wizard's CTA bar", wizardBand]] as const) {
    expect(new Set(b).size, `${name} is one colour across the window: ${JSON.stringify(b)}`).toBe(1);
  }
});

test("4 · C — Tell Kiwi's placeholder, whole, at 375 and 1280", async () => {
  for (const w of [375, 1280]) {
    await page.setViewportSize({ width: w, height: 812 });
    await visit("/tellkiwi", (j) => /What do you want to eat/.test(j));
    await snap(w, "tell-kiwi");
    const fit = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="wizard-text"]') as HTMLTextAreaElement | null;
      return box ? { scroll: box.scrollHeight, client: box.clientHeight } : null;
    });
    wheel[`tell-kiwi-${w}`] = fit;
    expect(fit && fit.scroll <= fit.client + 1, `placeholder fits its box at ${w}: ${JSON.stringify(fit)}`).toBe(true);
  }
});
