// ─────────────────────────────────────────────────────────────────────────────
// WEB-4b E — the screens WEB-4's sweep did not photograph, at 1280 × 800 and
// 375 × 812: dish detail (standalone and in a plan), the wizard, Tell Kiwi,
// plan options and the meal builder. DEV ONLY. OPT-IN: KIWI_E2E_WEB4B=1.
//
//   KIWI_E2E_WEB4B=1 KIWI_E2E_RUN_ID=web4b KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//     pnpm exec playwright test -c e2e/playwright.config.ts web4b-shots
//
// Shots land in out/<run>/<width>/NN-<screen>.png with one probe.json (visible
// text extent + rendered image sizes per screen, as web4-sweep.spec.ts).
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN: `web4b-<base36>@example.com`. Never
// Hans's account. AI spend: none — plan options renders a build-plans stream
// stubbed in the browser (three fixed cards); Tell Kiwi is shown, not sent.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, todayYmd } from "./qa1-shared";

const WIDTHS = [
  { w: 1280, h: 800 },
  { w: 375, h: 812 },
] as const;
// web4-sweep's corpus meals: the first is a two-dish meal.
const MEAL_IDS = [
  "3424eefa-423c-4be1-a987-8a55c8811576",
  "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d",
  "00e3a8ec-d909-466b-9c20-8f3cf5f7e544",
  "085c6353-756e-43e3-a99f-4058c5a6ef9b",
  "0314d364-b8af-46c9-8f34-a73e21630470",
];

test.skip(process.env.KIWI_E2E_WEB4B !== "1", "WEB-4b shots are opt-in — set KIWI_E2E_WEB4B=1");
test.describe.configure({ mode: "serial" });

const email = `web4b-${Date.now().toString(36)}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
const fixture = { planId: "", planItemId: "", mealId: MEAL_IDS[0], dishId: "", planDishId: "" };
const probes: Record<string, unknown> = {};
const notes: string[] = [];

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
    return { viewport: window.innerWidth, textLeft: Math.round(left), textRight: Math.round(right), images };
  });
}

let n = 0;
async function snap(width: number, name: string): Promise<void> {
  const d = join(RUN_DIR, String(width));
  mkdirSync(d, { recursive: true });
  await page.screenshot({ path: join(d, `${String(++n).padStart(2, "0")}-${name}.png`) });
  probes[`${width}/${name}`] = await probe();
}

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

// Three fixed plan-option cards, as the build-plans stream sends them (fix2-qa's shape).
function stubCard(i: number, title: string, meals: string[]) {
  return {
    id: `stub-${i}`,
    title,
    tags: ["cozy"],
    mealTitles: meals,
    meals: meals.map((t) => ({ title: t, description: null })),
    dailyMacros: { calories: 600 + i * 20, proteinG: 35, carbsG: 55, fatG: 22 },
    whyBullets: ["Five different dinners for the week", "Two nights under 30 minutes"],
  };
}
const STUB_STREAM = [
  stubCard(0, "Cozy Weeknight Classics", ["Chicken Piccata", "Beef Stew", "Shrimp Tacos", "Pesto Pasta", "Baked Salmon"]),
  stubCard(1, "Bright and Quick", ["Lemon Herb Chicken", "Black Bean Tacos", "Miso Salmon", "Caprese Pasta", "Thai Basil Pork"]),
  stubCard(2, "Big Flavour, Little Fuss", ["Chicken Tikka Masala", "Carnitas Bowls", "Garlic Shrimp", "Mushroom Risotto", "Teriyaki Tofu"]),
]
  .map((candidate, index) => `event: candidate\ndata: ${JSON.stringify({ index, candidate })}\n\n`)
  .join("") + `event: done\ndata: ${JSON.stringify({ delivered: 3, requested: 3 })}\n\n`;

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
});

test.afterAll(async () => {
  writeFileSync(join(RUN_DIR, "probe.json"), JSON.stringify({ fixture, notes, probes }, null, 2), "utf8");
});

test("1 · sign-up → onboarding, then the fixture plan", async () => {
  test.setTimeout(6 * 60_000);
  await visit("/", (j) => /free trial/i.test(j), 60_000);
  await press("Start your 14-day free trial");
  await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("First name").fill("Web");
  await page.getByPlaceholder("Last name").fill("Fourb");
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
  const detail = await http.get<any>(`/plans/${fixture.planId}`);
  const inst = detail.instance ?? detail.plan ?? detail;
  const meal = await http.get<any>(`/meals/${fixture.mealId}`);
  // The plan holds an owned COPY of the catalog meal (a new id): match by title.
  const title = meal.title ?? meal.meal?.title;
  const item = ((inst.items ?? []) as any[]).find((it) => it.mealId === fixture.mealId || it.meal?.title === title);
  fixture.planItemId = String(item?.id ?? "");
  fixture.dishId = String((meal.dishes ?? meal.meal?.dishes ?? [])[0]?.dishId ?? "");
  if (item?.mealId) {
    fixture.mealId = String(item.mealId);
    const copy = await http.get<any>(`/meals/${fixture.mealId}`);
    fixture.planDishId = String((copy.dishes ?? copy.meal?.dishes ?? [])[0]?.dishId ?? "");
  }
  notes.push(`plan ${fixture.planId} item ${fixture.planItemId} dish ${fixture.dishId} (copy ${fixture.planDishId})`);
  expect(fixture.planId).not.toBe("");
  expect(fixture.dishId).not.toBe("");
});

test("2 · the unphotographed screens at both widths", async () => {
  test.setTimeout(12 * 60_000);
  const { planId, planItemId, mealId, dishId, planDishId } = fixture;
  for (const v of WIDTHS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        notes.push(`${v.w}/${name}: ${String(err).slice(0, 200)}`);
      }
    };
    await step("dish-detail", async () => {
      await visit(`/dish/${dishId}`, (j) => /Ingredients|Steps/i.test(j));
      await snap(v.w, "dish-detail");
      await scrollInner(700);
      await snap(v.w, "dish-detail-scrolled");
    });
    await step("dish-detail-plan", async () => {
      await visit(`/dish/${planDishId}?mealId=${mealId}&planId=${planId}&planItemId=${planItemId}`, (j) => /Ingredients|Steps/i.test(j));
      await snap(v.w, "dish-detail-in-plan");
    });
    await step("wizard", async () => {
      await visit("/", (j) => /Featured|Create a meal plan/i.test(j), 60_000);
      await press("Have Kiwi use my preferences");
      await waitPath(/wizard/, 20_000);
      await settle(page, { timeoutMs: 20_000 });
      await snap(v.w, "wizard");
      await scrollInner(700);
      await snap(v.w, "wizard-scrolled");
    });
    await step("plan-options", async () => {
      await page.route("**/api/wizard/build-plans", (route) =>
        route.fulfill({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body: STUB_STREAM }),
      );
      try {
        await scrollInner(-5000);
        await press(/^Complete plans/);
        await press("Build my plan");
        await waitInner((j) => (j.match(/Use This Week/g) ?? []).length >= 3, 60_000);
        await settle(page, { timeoutMs: 15_000 });
        await snap(v.w, "plan-options");
        await scrollInner(700);
        await snap(v.w, "plan-options-scrolled");
      } finally {
        await page.unroute("**/api/wizard/build-plans");
      }
    });
    await step("tellkiwi", async () => {
      await visit("/tellkiwi", (j) => j.trim().length > 40);
      await snap(v.w, "tell-kiwi");
    });
    await step("meal-builder", async () => {
      await visit("/meal-builder", (j) => j.trim().length > 40);
      await snap(v.w, "meal-builder");
      await scrollInner(700);
      await snap(v.w, "meal-builder-scrolled");
    });
  }
});
