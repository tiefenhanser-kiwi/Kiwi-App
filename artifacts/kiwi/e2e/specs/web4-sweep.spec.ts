// ─────────────────────────────────────────────────────────────────────────────
// WEB-4 — the web sweep: every main screen at 1280 × 800 and 375 × 812.
// DEV ONLY. OPT-IN: runs only with KIWI_E2E_WEB4=1.
//
//   KIWI_E2E_WEB4=1 KIWI_E2E_WEB4_PHASE=before KIWI_E2E_RUN_ID=web4 \
//     KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//     pnpm exec playwright test -c e2e/playwright.config.ts web4-sweep
//
// Shots land in out/<run>/<phase>/<width>/NN-<screen>.png, with one
// probe.json per phase: per screen, the horizontal extent of the visible text
// and every visible image's rendered size — the numbers behind "stretched edge
// to edge" and "images sized to a phone".
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN: `web4-<base36>@example.com`, random
// in-memory password. Never Hans's account. AI spend: one grocery-list
// generation and one Prep the Week narration (Sonnet), on this account only.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, skipHowHeard, todayYmd } from "./qa1-shared";

const PHASE = process.env.KIWI_E2E_WEB4_PHASE ?? "before";
const WIDTHS = [
  { w: 1280, h: 800 },
  { w: 375, h: 812 },
] as const;
// The first corpus run (e2e/src/corpus.ts): a two-dish meal, egg and lime meals.
const MEAL_IDS = [
  "3424eefa-423c-4be1-a987-8a55c8811576",
  "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d",
  "00e3a8ec-d909-466b-9c20-8f3cf5f7e544",
  "085c6353-756e-43e3-a99f-4058c5a6ef9b",
  "0314d364-b8af-46c9-8f34-a73e21630470",
];

test.skip(process.env.KIWI_E2E_WEB4 !== "1", "WEB-4 sweep is opt-in — set KIWI_E2E_WEB4=1");
test.describe.configure({ mode: "serial" });

const email = `web4-${Date.now().toString(36)}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
const fixture = { planId: "", mealId: MEAL_IDS[0], listId: "", eggMealId: "" };
const probes: Record<string, unknown> = {};
const notes: string[] = [];

function phaseDir(width: number): string {
  const d = join(RUN_DIR, PHASE, String(width));
  mkdirSync(d, { recursive: true });
  return d;
}

/** Visible text extent + visible images, for the four principles. */
async function probe(): Promise<unknown> {
  return page.evaluate(() => {
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > window.innerHeight) return null;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return null;
      return r;
    };
    let left = Infinity;
    let right = -Infinity;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!(n.textContent ?? "").trim() || !n.parentElement) continue;
      const r = vis(n.parentElement);
      if (!r) continue;
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
    }
    const images = Array.from(document.querySelectorAll("img"))
      .map((img) => ({ img, r: vis(img) }))
      .filter((x) => x.r && x.r.width > 24)
      .map((x) => `${Math.round(x.r!.width)}×${Math.round(x.r!.height)}@${Math.round(x.r!.left)}`);
    return {
      viewport: window.innerWidth,
      textLeft: Math.round(left),
      textRight: Math.round(right),
      images,
    };
  });
}

let n = 0;
async function snap(width: number, name: string): Promise<void> {
  const file = join(phaseDir(width), `${String(++n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  probes[`${width}/${name}`] = await probe();
}

/** Scroll every inner scroller down by `px` (RNW lists are divs). */
async function scrollInner(px: number): Promise<void> {
  await page.evaluate((d) => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("div"))) {
      const st = getComputedStyle(el);
      if ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 10) {
        el.scrollTop += d;
      }
    }
  }, px);
  await page.waitForTimeout(500);
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

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
});

test.afterAll(async () => {
  writeFileSync(join(RUN_DIR, PHASE, "probe.json"), JSON.stringify({ fixture, notes, probes }, null, 2), "utf8");
});

test("0 · signed out: welcome, sign-in, Test Kitchen", async () => {
  test.setTimeout(4 * 60_000);
  for (const v of WIDTHS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await visit("/", (j) => /free trial/i.test(j), 60_000);
    await snap(v.w, "welcome");
    await visit("/sign-in", (j) => /Sign in/i.test(j));
    await snap(v.w, "sign-in");
    await visit("/test-kitchen", (j) => j.trim().length > 40);
    await snap(v.w, "test-kitchen");
    await scrollInner(700);
    await snap(v.w, "test-kitchen-scrolled");
  }
});

test("1 · sign-up → onboarding, then the fixture", async () => {
  test.setTimeout(6 * 60_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await visit("/", (j) => /free trial/i.test(j), 60_000);
  await press("Start your 14-day free trial");
  await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("First name").fill("Web");
  await page.getByPlaceholder("Last name").fill("Four");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press("Create account");
  await skipHowHeard(page); // CLIENT-3 D — a new account's question
  expect(await waitPath(/onboarding/, 60_000), "reached onboarding").toBe(true);
  const token = await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? "");
  http = new Http(token);
  await settle(page, { timeoutMs: 30_000 });
  for (const c of ["Italian", "Mexican", "Asian"]) await press(c);
  await press("Continue");
  await waitPath(/onboarding-step-3/, 30_000);
  await settle(page, { timeoutMs: 20_000 });
  await press("Finish setup");
  await waitInner((j) => /Create a meal plan/.test(j), 30_000);

  const made = await http.req<any>("POST", "/plans/from-meals", {
    mealIds: MEAL_IDS,
    planDurationDays: 7,
    localDate: todayYmd(),
  });
  const plan = made.body.plan ?? made.body;
  fixture.planId = String(plan.id ?? made.body.planId ?? "");
  notes.push(`from-meals → ${made.status}`);
  const fav = await http.req("POST", "/me/favorites", { mealId: MEAL_IDS[1] });
  notes.push(`favorite → ${fav.status}`);
  const gl = await http.req<any>("POST", `/plans/${fixture.planId}/generate-grocery-list`, {});
  fixture.listId = String(gl.body.groceryListId ?? "");
  notes.push(`grocery → ${gl.status}`);
  const pw = await http.req<any>("POST", `/plans/${fixture.planId}/prep-week`, {});
  notes.push(`prep-week → ${pw.status}`);
  const detail = await http.get<any>(`/plans/${fixture.planId}`);
  const inst = detail.instance ?? detail.plan ?? detail;
  notes.push(`plan dates ${inst.startDate} → ${inst.endDate}; status ${inst.status}`);
  // The egg note (WEB-4 E) needs a meal with eggs: the corpus's carbonara.
  const egg = ((inst.items ?? []) as any[]).find((it) => /carbonara/i.test(it.meal?.title ?? ""));
  fixture.eggMealId = egg?.mealId ?? "";
  expect(fixture.planId).not.toBe("");
});

test("2 · signed in: every main screen at both widths", async () => {
  test.setTimeout(12 * 60_000);
  const { planId, mealId, listId } = fixture;
  for (const v of WIDTHS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        notes.push(`${v.w}/${name}: ${String(err).slice(0, 200)}`);
      }
    };
    await step("home", async () => {
      await visit("/", (j) => /Featured/i.test(j), 60_000);
      await snap(v.w, "home");
      await scrollInner(600);
      await snap(v.w, "home-scrolled");
    });
    await step("plans", async () => {
      await visit("/plans", (j) => /plan/i.test(j));
      await snap(v.w, "plans-list");
    });
    await step("plan-detail", async () => {
      await visit(`/plan/${planId}`, (j) => /Sun|Mon|Tue|Wed|Thu|Fri|Sat/.test(j));
      await snap(v.w, "plan-detail");
      await scrollInner(700);
      await snap(v.w, "plan-detail-scrolled");
      await scrollInner(700);
      await snap(v.w, "plan-detail-scrolled-2");
    });
    await step("meal-detail", async () => {
      await visit(`/meal/${mealId}`, (j) => /Ingredients/i.test(j));
      await snap(v.w, "meal-detail");
      await scrollInner(700);
      await snap(v.w, "meal-detail-scrolled");
    });
    await step("cookbook", async () => {
      await visit("/cookbook", (j) => /meals/.test(j));
      await page.locator('[aria-label="Add to a plan"]').first().waitFor({ timeout: 45_000 });
      await settle(page, { timeoutMs: 15_000 });
      await snap(v.w, "cookbook");
      await page.locator('[aria-label="Add to a plan"]').first().click();
      await waitInner((j) => /Create a new plan/.test(j), 20_000);
      await settle(page, { timeoutMs: 10_000 });
      await snap(v.w, "add-to-plan-sheet");
      await page.keyboard.press("Escape");
    });
    await step("grocery", async () => {
      await visit(`/grocery-list/${listId}`, (j) => /item|Produce|Pantry/i.test(j), 60_000);
      await snap(v.w, "grocery-list");
      await scrollInner(700);
      await snap(v.w, "grocery-list-scrolled");
    });
    await step("prep-cook", async () => {
      await visit(`/prep-cook?id=${planId}`, (j) => /Prep the Week/i.test(j));
      await snap(v.w, "prep-cook-hub");
      await press(/Prep the Week/);
      await waitInner((j) => /Phase|prepped|Mark step/i.test(j), 120_000);
      await settle(page, { timeoutMs: 20_000 });
      await snap(v.w, "prep-the-week");
      await scrollInner(700);
      await snap(v.w, "prep-the-week-scrolled");
    });
    await step("cook-mode", async () => {
      await visit(`/cook-session?mealId=${mealId}`, (j) => /prep this already|Step/i.test(j), 90_000);
      await snap(v.w, "cook-mode-gate");
      await press(/No, start from prep/);
      await waitInner((j) => /Step \d|of \d/i.test(j), 30_000);
      await settle(page, { timeoutMs: 15_000 });
      await snap(v.w, "cook-mode");
    });
    await step("profile", async () => {
      // The local API has no Stripe config, so `billingAvailable` is false and
      // the web card (Subscribe) never renders. Flip that one field on the
      // real GET, in the browser only — no server write — to reach the sheet.
      await page.route("**/api/me/subscription", async (route) => {
        try {
          const res = await route.fetch();
          const body = await res.json();
          await route.fulfill({ response: res, json: { ...body, billingAvailable: true } });
        } catch {
          /* a request still in flight when the route is removed */
        }
      });
      await visit("/profile", (j) => /Log Out/i.test(j));
      await snap(v.w, "profile");
      await scrollInner(900);
      await snap(v.w, "profile-scrolled");
      await scrollInner(-5000);
      await press(/^\s*Subscribe/);
      await waitInner((j) => /month|year/i.test(j), 20_000);
      await settle(page, { timeoutMs: 10_000 });
      await snap(v.w, "premium-sheet");
      await page.keyboard.press("Escape");
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });
  }
});

// ── the build items' own surfaces (WEB-4 B, C, E) ───────────────────────────

/** Meal detail's servings stepper: the first / second focusable after "Adjust for". */
async function stepServings(direction: "minus" | "plus"): Promise<void> {
  await page.evaluate((dir) => {
    const label = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
      (d) => d.children.length === 0 && (d.innerText || "").trim() === "Adjust for",
    );
    const row = label?.parentElement;
    const buttons = row ? Array.from(row.querySelectorAll<HTMLElement>('[tabindex="0"]')) : [];
    buttons[dir === "minus" ? 0 : 1]?.click();
  }, direction);
  await page.waitForTimeout(500);
}

test("3 · the build items: Ingredients toggle + egg note, Recipes list, hub at 320", async () => {
  test.setTimeout(6 * 60_000);
  const { planId, eggMealId } = fixture;
  for (const v of WIDTHS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        notes.push(`${v.w}/${name}: ${String(err).slice(0, 200)}`);
      }
    };
    await step("egg-note", async () => {
      await visit(`/meal/${eggMealId}`, (j) => /Adjust for/.test(j));
      const heading = page.locator('[data-testid="meal-ingredients-heading"]');
      await heading.scrollIntoViewIfNeeded();
      await stepServings("minus"); // 4 → 3: eggs and yolks stop being whole
      await page.waitForTimeout(400);
      await heading.scrollIntoViewIfNeeded();
      await snap(v.w, "meal-detail-3-servings");
      await heading.click();
      await waitInner((j) => /Everything you need/.test(j), 15_000);
      await settle(page, { timeoutMs: 10_000 });
      await snap(v.w, "ingredients-sheet-3-servings");
      await page.keyboard.press("Escape");
    });
    await step("recipes", async () => {
      await visit("/meals", (j) => /Cookbook|Add Meal/i.test(j));
      await snap(v.w, "recipes-list");
    });
  }
  await step320();
  async function step320() {
    await page.setViewportSize({ width: 320, height: 700 });
    try {
      await visit(`/prep-cook?id=${planId}`, (j) => /Prep the Week/i.test(j));
      await scrollInner(600);
      await snap(320, "prep-cook-hub-320");
    } catch (err) {
      notes.push(`320/hub: ${String(err).slice(0, 200)}`);
    }
  }
});
