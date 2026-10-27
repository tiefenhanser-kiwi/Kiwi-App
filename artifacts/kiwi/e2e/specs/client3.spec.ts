// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-3 — the 1.2-bundle client lane, on the web, at 375 and 1280. DEV ONLY.
// OPT-IN: KIWI_E2E_CLIENT3=1. WRITTEN, NOT RUN.
//
//   KIWI_E2E_CLIENT3=1 KIWI_E2E_RUN_ID=client3 KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//     pnpm exec playwright test -c e2e/playwright.config.ts client3
//
//   D (ATTR) — the app is opened with ?ref=…&utm_*=…, the sign-up body carries
//       `attribution`, and the new account meets "How did you hear about Kiwi?"
//       before onboarding; "A creator" + a name goes on PATCH /me/profile. Until
//       SERVER-6's fields are deployed that PATCH is a 400 (profile is .strict());
//       the item records the status, it does not fail on it.
//   A (BUG-528) — Edit meal → + Add Dish → a saved dish → Save → Just this time:
//       the dish lands (PATCH /me/meals carries it; the re-read shows it).
//   E (BUG-534) — Prep the Week opens with "Set up your prep area". ONE real
//       Prep the Week generation (~$0.10); the 1280 pass reads the cache.
//   B (BUG-526) + F (BUG-527) — Cook Now from the Recipes tab (no plan item):
//       "Yes, I prepped" re-reads the meal with this week's planItemId and
//       prepped=1; "Skip to cooking" scrolls to the first step left to cook.
//   C (LIFE-2 #9) — leaving Cook Mode on its last step POSTs cook-finished.
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN (`client3-<base36>@example.com`), deleted
// at the end through DELETE /me.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Page, type Request } from "@playwright/test";

import { API_BASE, RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, todayYmd } from "./qa1-shared";

// web4-sweep's corpus: the first is a two-dish meal.
const MEAL_IDS = ["3424eefa-423c-4be1-a987-8a55c8811576", "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d"];
const LANDING = "/?ref=client3&utm_source=qa&utm_medium=e2e&utm_campaign=client3";

test.skip(process.env.KIWI_E2E_CLIENT3 !== "1", "CLIENT-3 is opt-in — set KIWI_E2E_CLIENT3=1");
test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
const email = `client3-${stamp}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
const fixture = { planId: "", planItemId: "", mealId: "", dishTitle: `QA rice ${stamp}` };
const notes: string[] = [];
const requests: { method: string; url: string; body: string | null; status?: number }[] = [];

async function snap(p: Page, name: string): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true });
  await p.screenshot({ path: join(RUN_DIR, `${name}.png`) });
}

async function press(p: Page, name: string | RegExp): Promise<void> {
  const re = typeof name === "string" ? new RegExp(`^\\s*${escapeRe(name)}\\s*$`) : name;
  const byRole = p.getByRole("button", { name: re });
  if ((await byRole.count()) > 0) {
    await byRole.first().click();
    return;
  }
  const byText = p.locator('[tabindex="0"]:visible').filter({ hasText: re });
  await byText.first().waitFor({ state: "visible", timeout: 20_000 });
  await byText.first().click();
}

const inner = (p: Page) => p.evaluate(() => document.body.innerText || "");

async function waitInner(p: Page, pred: (joined: string) => boolean, timeoutMs: number): Promise<boolean> {
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

async function visit(p: Page, path: string, ready: (j: string) => boolean, timeoutMs = 45_000): Promise<boolean> {
  await p.goto(`${WEB_ORIGIN}${path}`, { waitUntil: "domcontentloaded" });
  const ok = await waitInner(p, ready, timeoutMs);
  await settle(p, { timeoutMs: 20_000 });
  return ok;
}

const seen = (method: string, re: RegExp) => requests.filter((r) => r.method === method && re.test(r.url));

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  page.on("request", (r: Request) => {
    if (r.url().startsWith(API_BASE)) requests.push({ method: r.method(), url: r.url(), body: r.postData() });
  });
  page.on("response", (res) => {
    const hit = [...requests].reverse().find((r) => r.url === res.url() && r.status === undefined);
    if (hit) hit.status = res.status();
  });
});

test.afterAll(async () => {
  let deleted: number | null = null;
  try {
    const login = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = (await login.json()) as { authToken?: string };
    if (body.authToken) {
      deleted = (await new Http(body.authToken).req("DELETE", "/me", { confirm: "delete", currentPassword: password })).status;
    }
  } catch (err) {
    notes.push(`cleanup failed: ${String(err)}`);
  }
  writeFileSync(join(RUN_DIR, "client3.json"), JSON.stringify({ email, deleted, fixture, notes }, null, 2), "utf8");
});

test("1 · D — a linked landing, sign-up with attribution, then 'How did you hear about Kiwi?' before onboarding", async () => {
  test.setTimeout(6 * 60_000);
  await visit(page, LANDING, (j) => /free trial/i.test(j), 60_000);
  const kept = await page.evaluate(() => sessionStorage.getItem("kiwi_attribution"));
  notes.push(`D: kept on landing: ${kept}`);
  expect(kept, "the landing link is kept for the tab").toContain('"ref":"client3"');
  await press(page, "Start your 14-day free trial");
  await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("First name").fill("Client");
  await page.getByPlaceholder("Last name").fill("Three");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press(page, "Create account");

  const signup = seen("POST", /\/auth\/signup$/)[0];
  const sent = JSON.parse(signup?.body ?? "{}") as { attribution?: Record<string, string> };
  notes.push(`D: signup attribution ${JSON.stringify(sent.attribution)}`);
  expect(sent.attribution).toEqual({ ref: "client3", utmSource: "qa", utmMedium: "e2e", utmCampaign: "client3", landingPath: "/" });

  expect(await waitPath(page, /how-heard/, 60_000), "the question comes before onboarding").toBe(true);
  await waitInner(page, (j) => j.includes("How did you hear about Kiwi?"), 20_000);
  await settle(page, { timeoutMs: 10_000 });
  const q = await inner(page);
  for (const s of ["Friend or family", "Instagram", "TikTok", "Reddit", "Google search", "App Store / Play Store search", "A creator", "Other", "Skip"]) {
    expect(q, s).toContain(s);
  }
  await snap(page, "D-how-heard-375");
  await press(page, "A creator");
  await page.getByLabel("Which creator").fill("@client3");
  await snap(page, "D-how-heard-creator-375");
  await press(page, "Continue");
  expect(await waitPath(page, /onboarding/, 30_000), "on to onboarding").toBe(true);
  http = new Http(await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? ""));
  await page.waitForTimeout(1500);
  const patch = seen("PATCH", /\/me\/profile$/).find((r) => (r.body ?? "").includes("howHeard"));
  notes.push(`D: PATCH /me/profile ${patch?.body} → ${patch?.status} (400 until SERVER-6's fields deploy)`);
  expect(JSON.parse(patch?.body ?? "{}")).toEqual({ howHeard: "creator", howHeardDetail: "@client3" });

  // Never again: a reload of /how-heard goes straight on.
  await page.goto(`${WEB_ORIGIN}/how-heard?next=%2Fonboarding-prefs`, { waitUntil: "domcontentloaded" });
  expect(await waitPath(page, /onboarding/, 30_000), "a second visit goes straight on").toBe(true);

  // 1280: the same screen, shown once more by clearing this device's marker.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.includes("howHeardAsked")) localStorage.removeItem(k);
  });
  await visit(page, "/how-heard?next=%2Fonboarding-prefs", (j) => j.includes("How did you hear about Kiwi?"), 30_000);
  await snap(page, "D-how-heard-1280");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll").toBe(true);
  await press(page, "Skip");
  expect(await waitPath(page, /onboarding/, 30_000)).toBe(true);
  await page.setViewportSize({ width: 375, height: 812 });

  // Onboarding, then the fixture plan (from-meals binds the user's own copies).
  await settle(page, { timeoutMs: 30_000 });
  for (const c of ["Italian", "Mexican", "Asian"]) await press(page, c);
  await press(page, "Continue");
  await waitPath(page, /onboarding-step-3/, 30_000);
  await settle(page, { timeoutMs: 20_000 });
  await press(page, "Finish setup");
  await waitInner(page, (j) => /Create a meal plan/.test(j), 30_000);
  const made = await http.req<any>("POST", "/plans/from-meals", { mealIds: MEAL_IDS, planDurationDays: 7, localDate: todayYmd() });
  const plan = made.body.plan ?? made.body;
  fixture.planId = String(plan.id ?? made.body.planId ?? "");
  const detail = await http.get<any>(`/plans/${fixture.planId}`);
  const items = ((detail.instance ?? detail.plan ?? detail).items ?? []) as any[];
  fixture.planItemId = String(items[0]?.id ?? "");
  fixture.mealId = String(items[0]?.mealId ?? "");
  notes.push(`fixture: plan ${fixture.planId} item ${fixture.planItemId} meal ${fixture.mealId}`);
  expect(fixture.mealId).not.toBe("");
});

test("2 · A (BUG-528) — Edit meal → + Add Dish → a saved dish → Just this time: the dish lands", async () => {
  test.setTimeout(4 * 60_000);
  const saved = await http.req<any>("POST", "/me/dishes", {
    title: fixture.dishTitle,
    servingsDefault: 4,
    sourceType: "manual",
    ingredients: [{ name: "Long-grain rice", quantity: 1, unit: "cup" }],
    steps: [{ text: "Simmer the rice 18 minutes.", estimatedMinutes: 18 }],
  });
  notes.push(`A: saved dish → ${saved.status}`);
  for (const [w, h] of [[375, 812], [1280, 800]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await visit(page, `/meal/${fixture.mealId}?planId=${fixture.planId}&planItemId=${fixture.planItemId}`, (j) => /Cook Now/.test(j));
    if (w === 1280) {
      // The 1280 pass only photographs the builder with the dish already on the meal.
      await press(page, "Edit");
      await waitInner(page, (j) => j.includes(fixture.dishTitle), 30_000);
      await snap(page, `A-builder-after-${w}`);
      break;
    }
    await press(page, "Edit");
    await waitInner(page, (j) => /Save meal/.test(j), 30_000);
    await press(page, "+ Add Dish");
    await waitInner(page, (j) => j.includes(fixture.dishTitle), 30_000);
    await snap(page, `A-chooser-${w}`);
    await press(page, new RegExp(escapeRe(fixture.dishTitle)));
    // The full read (GET /dishes/:id) fills the dish before it shows.
    const filled = await waitInner(page, (j) => j.includes("Long-grain rice"), 20_000);
    notes.push(`A: picked dish filled from its read: ${filled}`);
    expect(filled).toBe(true);
    await press(page, "Save meal");
    await waitInner(page, (j) => /Added dishes are saved to the recipe\./.test(j), 15_000);
    await snap(page, `A-save-prompt-${w}`);
    await press(page, "Just this time");
    await waitInner(page, (j) => /Saved for this plan/.test(j), 30_000);
    const meals = seen("PATCH", /\/me\/meals\//);
    notes.push(`A: PATCH /me/meals → ${meals.map((m) => m.status).join(",")}`);
    expect(meals.length, "the added dish goes to the recipe").toBeGreaterThan(0);
    expect(meals[meals.length - 1].body ?? "").toContain(fixture.dishTitle);
    await press(page, "OK");
  }
  const re = await http.get<any>(`/meals/${fixture.mealId}?planItemId=${fixture.planItemId}`);
  const titles = ((re.meal ?? re).dishes ?? []).map((d: any) => d.title);
  notes.push(`A: meal dishes after save: ${titles.join(" · ")}`);
  expect(titles).toContain(fixture.dishTitle);
  await page.setViewportSize({ width: 375, height: 812 });
});

test("3 · E (BUG-534) — Prep the Week opens with the prep-area card", async () => {
  test.setTimeout(6 * 60_000);
  for (const [w, h] of [[375, 812], [1280, 800]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await visit(page, `/cook-session?mode=prep-week&planId=${fixture.planId}`, (j) => /Set up your prep area|couldn.t|distracted/i.test(j), 4 * 60_000);
    const j = await inner(page);
    notes.push(`E @${w}: ${/you'll fill \d+ containers?/.exec(j)?.[0] ?? "card MISSING"}`);
    await snap(page, `E-prep-area-${w}`);
    expect(j).toContain("Set up your prep area");
    expect(j).toMatch(/As you chop and measure in this session, you'll fill \d+ containers?\. Set them out however works for you \(tape and a pen work well for labels\):/);
    expect(j).not.toMatch(/Label \d+ containers|write these on tape|Don't worry, some of these containers/i);
  }
  await page.setViewportSize({ width: 375, height: 812 });
});

test("4 · B + F + C — Cook Now with no plan item: 'Yes, I prepped' reads through this week's plan, Skip to cooking scrolls, the finish is sent", async () => {
  test.setTimeout(4 * 60_000);
  const before = requests.length;
  await visit(page, `/cook-session?mealId=${fixture.mealId}`, (j) => /Did you prep this already\?/.test(j), 45_000);
  await press(page, "Yes, I prepped");
  await waitInner(page, (j) => /Skip to cooking/.test(j), 30_000);
  await page.waitForTimeout(3000); // the plans list, the plan, then the re-read
  const reads = requests.slice(before).filter((r) => r.method === "GET" && /\/meals\/[^/?]+\?/.test(r.url)).map((r) => r.url);
  notes.push(`F: meal reads after "yes": ${reads.join(" , ")}`);
  expect(reads.some((u) => u.includes(`planItemId=${fixture.planItemId}`) && u.includes("prepped=1")), "the read carries this week's item").toBe(true);
  const chips = (await inner(page)).match(/You prepped this/g)?.length ?? 0;
  notes.push(`F: chips on screen: ${chips}`);
  await snap(page, "BF-recap-375");

  const scrollTop = () =>
    page.evaluate(() =>
      Math.max(0, ...Array.from(document.querySelectorAll("div")).map((d) => (d.scrollHeight > d.clientHeight ? d.scrollTop : 0))),
    );
  const top0 = await scrollTop();
  await press(page, "Skip to cooking");
  await page.waitForTimeout(1200);
  const top1 = await scrollTop();
  notes.push(`B: scrollTop ${top0} → ${top1}`);
  await snap(page, "B-after-skip-375");
  expect(top1, "Skip to cooking moved the list").toBeGreaterThan(top0);

  // C — step to the last live step, then leave: the finish is posted.
  for (let i = 0; i < 40; i++) {
    const next = page.getByRole("button", { name: /^\s*(Next|Next step)\b/i });
    if ((await next.count()) === 0) break;
    await next.first().click();
    await page.waitForTimeout(150);
  }
  await page.goBack();
  await page.waitForTimeout(1500);
  const finished = seen("POST", /\/me\/activity\/cook-finished$/);
  notes.push(`C: cook-finished ${finished.map((f) => `${f.body} → ${f.status}`).join(" ; ") || "NOT SENT"}`);
  expect(finished.length, "one finish, on leaving at the last step").toBe(1);
  expect(JSON.parse(finished[0].body ?? "{}")).toEqual({ mealId: fixture.mealId });
});
