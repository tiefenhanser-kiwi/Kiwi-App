// ─────────────────────────────────────────────────────────────────────────────
// WEB-4d — the feast's client half, photographed. DEV ONLY.
// OPT-IN: KIWI_E2E_WEB4D=1.
//
//   KIWI_E2E_WEB4D=1 KIWI_E2E_RUN_ID=web4d KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//     pnpm exec playwright test -c e2e/playwright.config.ts web4d
//
//   A (BUG-468 R3) — Prep the Week and Prep the feast on the same prep result:
//     "Where each goes" on the week, not in the feast.
//   B (R4) — Cook Mode on a two-dish meal, the sequencer's answer edited in the
//     browser so its last step starts AT serve (THX-3d's serve-then-dessert
//     shape, not on dev yet): the serve step reads "~N min left", the step at
//     T0 reads "After serving".
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN: `web4d-<base36>@example.com`, deleted at
// the end through DELETE /me. AI spend: none — Prep the Week's POST is answered
// in the browser (page.route), and the plan is made from catalog meals.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, skipHowHeard, todayYmd } from "./qa1-shared";

// web4-sweep's corpus: the first is a two-dish meal (so Cook Mode sequences it).
const MEAL_IDS = ["3424eefa-423c-4be1-a987-8a55c8811576", "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d"];

test.skip(process.env.KIWI_E2E_WEB4D !== "1", "WEB-4d is opt-in — set KIWI_E2E_WEB4D=1");
test.describe.configure({ mode: "serial" });

const email = `web4d-${Date.now().toString(36)}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
const fixture = { planId: "", planItemId: "", mealId: "", planMealIds: [] as string[] };
const notes: string[] = [];

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
    if (pred(await page.evaluate(() => document.body.innerText || ""))) return true;
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

const footerText = () => page.evaluate(() => document.body.innerText || "");

// Two steps feeding both plan meals, in the FIRST phase (where the screen opens).
function prepWeekStub(mealIds: string[]) {
  const step = (i: number, title: string) => ({
    number: i + 1,
    stepKey: `seasonings_dry#${mealIds[0]}#${i}`,
    title,
    instructions: "Dice 2 cups onions and mince 6 cloves garlic; pack each in its own container.",
    estimatedMinutes: 6,
    contributesToMealIds: mealIds.slice(0, 2),
    storageNote: "Airtight, 4 days",
  });
  return {
    cacheHit: true,
    result: {
      totalEstimatedMinutes: 12,
      containerCount: 2,
      phases: [
        { phase: "seasonings_dry", title: "Seasonings & dry", skippable: true, steps: [step(0, "Onions and garlic"), step(1, "Herbs")] },
        { phase: "produce", title: "Produce", skippable: false, steps: [] },
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
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
});

test.afterAll(async () => {
  // The account goes at the end, as SEC-3b's do (its plan with it).
  const deleted = http ? (await http.req<any>("DELETE", "/me", { confirm: "delete", currentPassword: password })).status : null;
  writeFileSync(join(RUN_DIR, "web4d.json"), JSON.stringify({ email, deleted, fixture, notes }, null, 2), "utf8");
});

test("1 · sign-up → onboarding, then a plan from two catalog meals", async () => {
  test.setTimeout(6 * 60_000);
  await visit("/", (j) => /free trial/i.test(j), 60_000);
  await press("Start your 14-day free trial");
  await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("First name").fill("Web");
  await page.getByPlaceholder("Last name").fill("Fourd");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press("Create account");
  await skipHowHeard(page); // CLIENT-3 D — a new account's question
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
  const detail = await http.get<any>(`/plans/${fixture.planId}`);
  const items = ((detail.instance ?? detail.plan ?? detail).items ?? []) as any[];
  fixture.planMealIds = items.map((it) => String(it.mealId)).filter(Boolean);
  // The two-dish meal's owned copy: the item whose meal has two dishes.
  for (const it of items) {
    const meal = await http.get<any>(`/meals/${it.mealId}`);
    if (((meal.dishes ?? meal.meal?.dishes ?? []) as unknown[]).length > 1) {
      fixture.mealId = String(it.mealId);
      fixture.planItemId = String(it.id);
      break;
    }
  }
  notes.push(`from-meals → ${made.status}; plan ${fixture.planId} item ${fixture.planItemId} meal ${fixture.mealId}`);
  expect(fixture.mealId, "a two-dish meal in the plan").not.toBe("");
});

test("2 · A — 'Where each goes' on the week, not in Prep the feast", async () => {
  test.setTimeout(3 * 60_000);
  await page.route("**/api/plans/*/prep-week", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(prepWeekStub(fixture.planMealIds)) })
      : route.continue(),
  );
  await visit(`/cook-session?mode=prep-week&planId=${fixture.planId}`, (j) => /Onions and garlic/.test(j), 60_000);
  const week = await footerText();
  await snap("a-prep-the-week");
  await visit(`/cook-session?mode=prep-week&planId=${fixture.planId}&session=feast`, (j) => /Onions and garlic/.test(j), 60_000);
  const feast = await footerText();
  await snap("a-prep-the-feast");
  await page.unroute("**/api/plans/*/prep-week");
  notes.push(`A week: where=${/where each goes/i.test(week)} · feast: where=${/where each goes/i.test(feast)}`);
  expect(week).toMatch(/where each goes/i);
  expect(feast).not.toMatch(/where each goes/i);
});

test("3 · B — the step at serve reads 'After serving'", async () => {
  test.setTimeout(3 * 60_000);
  let seqNote = "";
  await page.route("**/api/meals/*/cooking-sequence", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const seq = [...body.sequence].sort((a: any, b: any) => a.sequenceIndex - b.sequenceIndex);
    // THX-3d's shape: the last step starts AT serve (0), after the serve step.
    seq[seq.length - 1].startOffsetMinutes = 0;
    seqNote = `sequence ${seq.length} steps; last offsets ${seq.slice(-3).map((s: any) => s.startOffsetMinutes).join(", ")}`;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, sequence: seq, mergedSteps: [] }) });
  });
  await visit(
    `/cook-session?mealId=${fixture.mealId}&planId=${fixture.planId}&planItemId=${fixture.planItemId}`,
    (j) => /step 1 of|Did you prep this already/.test(j),
    60_000,
  );
  if (/Did you prep this already/.test(await footerText())) await press("No, start from prep");
  await waitInner((j) => /step 1 of (\d+)/.test(j), 30_000);
  const total = Number(/step 1 of (\d+)/.exec(await footerText())?.[1] ?? "0");
  notes.push(`B: ${seqNote}; ${total} steps on screen`);
  expect(total).toBeGreaterThan(1);
  // The step before the last: still counting down.
  await page.getByTestId(`step-${total - 2}`).click();
  await waitInner((j) => new RegExp(`step ${total - 1} of ${total}`).test(j), 10_000);
  await settle(page, { timeoutMs: 10_000 });
  const before = await footerText();
  await snap("b-step-before-serve");
  // The last: starts at serve.
  await page.getByTestId(`step-${total - 1}`).click();
  await waitInner((j) => new RegExp(`step ${total} of ${total}`).test(j), 10_000);
  await settle(page, { timeoutMs: 10_000 });
  const last = await footerText();
  await snap("b-step-at-serve");
  await page.unroute("**/api/meals/*/cooking-sequence");
  notes.push(`B before: ${/min left/.test(before) ? (/~\s*\d+ min left/.exec(before)?.[0] ?? "") : "no minutes"} · last: ${/After serving/.test(last) ? "After serving" : "missing"}`);
  expect(last).toMatch(/After serving/);
  expect(last).not.toMatch(/min left/);
});
