// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-1 — the client half of PREP-3 and four account fixes, photographed at
// 375 and 1280. DEV ONLY. OPT-IN: KIWI_E2E_CLIENT1=1.
//
//   KIWI_E2E_CLIENT1=1 KIWI_E2E_RUN_ID=client1 KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//   KIWI_E2E_CLIENT1_MINT=<path to a mint script> \
//     pnpm exec playwright test -c e2e/playwright.config.ts client1
//
//   4 (BUG-504) — Home's Tell Kiwi card holds one height while the phrase rotates.
//   3 — Prep the Week: "Label N containers" first, Skip hidden until it is ticked,
//       and the held lines' day words. ONE real Prep the Week generation (the
//       narration call, ~$0.10); the 1280 pass reads the server's cache.
//   7 (BUG-507) — Cook Mode: "Next step in N minutes" under a long step.
//   D (CLIENT-2b, D-WS9-321) — Cook Mode's "You prepped this" chip; the meal
//       read is given a preppedRefs entry while the server sends none.
//   6 (BUG-500 / BUG-506) — signed out, in a fresh context: the reset screen, the
//       email-change landing, their invalid states, then both success paths.
//
// The two emailed-link tokens are minted for this run's own account by the
// script KIWI_E2E_CLIENT1_MINT names (the api-server's signToken, dev .env),
// because the dev API runs with no mailer. Without it the success paths skip.
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN: `client1-<base36>@example.com`, deleted
// at the end through DELETE /me (after the email change and the reset, with the
// new address and the new password).
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { API_BASE, API_SERVER_ROOT, RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, todayYmd } from "./qa1-shared";

// web4-sweep's corpus: the first is a two-dish meal (so Cook Mode sequences it).
const MEAL_IDS = ["3424eefa-423c-4be1-a987-8a55c8811576", "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d"];
const MINT = process.env.KIWI_E2E_CLIENT1_MINT ?? "";

test.skip(process.env.KIWI_E2E_CLIENT1 !== "1", "CLIENT-1 is opt-in — set KIWI_E2E_CLIENT1=1");
test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
const email = `client1-${stamp}@example.com`;
const newEmail = `client1-${stamp}-new@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
const newPassword = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
let userId = "";
let emailChanged = false;
let passwordChanged = false;
const fixture = { planId: "", planItemId: "", mealId: "" };
const notes: string[] = [];

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

function mint(): { reset: string; change: string } {
  const out = join(RUN_DIR, `_mint-${randomBytes(4).toString("hex")}.json`);
  execFileSync(process.execPath, ["--env-file=.env", "--import", "tsx", MINT, userId, newEmail, out], { cwd: API_SERVER_ROOT, stdio: "ignore" });
  const t = JSON.parse(readFileSync(out, "utf8")) as { reset: string; change: string };
  writeFileSync(out, "{}", "utf8"); // the tokens do not stay on disk
  return t;
}

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
});

test.afterAll(async () => {
  // The account goes at the end, with whatever address and password it has now.
  let deleted: number | null = null;
  try {
    const login = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: emailChanged ? newEmail : email, password: passwordChanged ? newPassword : password }),
    });
    const body = (await login.json()) as { authToken?: string };
    if (body.authToken) {
      deleted = (await new Http(body.authToken).req("DELETE", "/me", { confirm: "delete", currentPassword: passwordChanged ? newPassword : password })).status;
    }
  } catch (err) {
    notes.push(`cleanup failed: ${String(err)}`);
  }
  writeFileSync(join(RUN_DIR, "client1.json"), JSON.stringify({ email, deleted, fixture, notes }, null, 2), "utf8");
});

test("1 · sign-up → onboarding, then a plan from two catalog meals", async () => {
  test.setTimeout(6 * 60_000);
  await visit(page, "/", (j) => /free trial/i.test(j), 60_000);
  await press(page, "Start your 14-day free trial");
  await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("First name").fill("Client");
  await page.getByPlaceholder("Last name").fill("One");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press(page, "Create account");
  expect(await waitPath(page, /onboarding/, 60_000), "reached onboarding").toBe(true);
  http = new Http(await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? ""));
  await settle(page, { timeoutMs: 30_000 });
  for (const c of ["Italian", "Mexican", "Asian"]) await press(page, c);
  await press(page, "Continue");
  await waitPath(page, /onboarding-step-3/, 30_000);
  await settle(page, { timeoutMs: 20_000 });
  await press(page, "Finish setup");
  await waitInner(page, (j) => /Create a meal plan/.test(j), 30_000);

  const me = await http.get<any>("/auth/me");
  userId = String(me.user?.id ?? me.id ?? "");
  const made = await http.req<any>("POST", "/plans/from-meals", { mealIds: MEAL_IDS, planDurationDays: 7, localDate: todayYmd() });
  const plan = made.body.plan ?? made.body;
  fixture.planId = String(plan.id ?? made.body.planId ?? "");
  const detail = await http.get<any>(`/plans/${fixture.planId}`);
  const items = ((detail.instance ?? detail.plan ?? detail).items ?? []) as any[];
  for (const it of items) {
    const meal = await http.get<any>(`/meals/${it.mealId}`);
    if (((meal.dishes ?? meal.meal?.dishes ?? []) as unknown[]).length > 1) {
      fixture.mealId = String(it.mealId);
      fixture.planItemId = String(it.id);
      break;
    }
  }
  notes.push(`from-meals → ${made.status}; plan ${fixture.planId} item ${fixture.planItemId} meal ${fixture.mealId}; user ${userId ? "ok" : "missing"}`);
  expect(fixture.mealId, "a two-dish meal in the plan").not.toBe("");
});

/** The Tell Kiwi card's height and showing phrase, sampled while it rotates. */
async function sampleTellKiwi(p: Page, ms: number): Promise<{ heights: number[]; pills: number[]; phrases: string[] }> {
  const heights: number[] = [];
  const pills: number[] = [];
  const phrases = new Set<string>();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await p.evaluate(() => {
      const input = document.querySelector('[data-testid="tell-kiwi-input"]') as HTMLElement | null;
      const ph = document.querySelector('[data-testid="tell-kiwi-placeholder"]') as HTMLElement | null;
      if (!input) return null;
      const pill = input.parentElement as HTMLElement;
      let card: HTMLElement | null = pill;
      while (card && !(card.innerText || "").includes("or let Kiwi take it from here")) card = card.parentElement;
      return { card: card ? card.getBoundingClientRect().height : -1, pill: pill.getBoundingClientRect().height, phrase: ph?.innerText ?? "" };
    });
    if (s) {
      heights.push(Math.round(s.card * 10) / 10);
      pills.push(Math.round(s.pill * 10) / 10);
      if (s.phrase) phrases.add(s.phrase);
    }
    await p.waitForTimeout(150);
  }
  return { heights, pills, phrases: [...phrases] };
}

test("2 · item 4 (BUG-504) — the Tell Kiwi card keeps one height through the rotation", async () => {
  test.setTimeout(3 * 60_000);
  for (const [w, h] of [[375, 812], [320, 700], [1280, 800]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await visit(page, "/", (j) => /Create a meal plan/.test(j), 45_000);
    await page.waitForTimeout(800);
    const s = await sampleTellKiwi(page, 14_000); // > 5 phrases × 2.6 s
    const distinct = [...new Set(s.heights)];
    notes.push(`4 @${w}: card heights ${distinct.join("/")} · pill ${[...new Set(s.pills)].join("/")} · ${s.phrases.length} phrases seen`);
    await snap(page, `4-tellkiwi-${w}`);
    expect(s.phrases.length, "the phrase rotated").toBeGreaterThanOrEqual(4);
    expect(distinct.length, `one card height at ${w}: ${distinct.join(", ")}`).toBe(1);
  }
  await page.setViewportSize({ width: 375, height: 812 });
});

test("3 · item 3 → CLIENT-2 B1/B2 — Prep the Week: the label step first with its reassurance line, Skip shown before and after it is ticked, the held lines", async () => {
  test.setTimeout(6 * 60_000);
  const ok = await visit(page, `/cook-session?mode=prep-week&planId=${fixture.planId}`, (j) => /Label \d+ containers|couldn.t|distracted/i.test(j), 4 * 60_000);
  const first = await inner(page);
  const label = /Label (\d+) containers/.exec(first);
  notes.push(`3: generated=${ok}; label step ${label ? `"${label[0]}"` : "MISSING"}; Skip shown: ${/Skip this Prep/.test(first)}`);
  await snap(page, "3-prep-label-375");
  expect(label, "the server's label step").not.toBeNull();
  // The label step is the phase's step 1 (the first step card's title).
  const order = /\b1\s+Label \d+ containers/.test(first) || first.indexOf("Label") < first.indexOf("Mark all complete");
  notes.push(`3: label step first: ${order}`);
  // CLIENT-2 B1 (BUG-509) — Skip at any time; B2 — the reassurance line above the label step.
  expect(first).toMatch(/Skip this Prep/);
  expect(first).toContain("Don't worry, some of these containers combine at the end of the prep session.");

  await page.getByLabel("Mark step done").first().click();
  const back = await waitInner(page, (j) => /Skip this Prep/.test(j), 15_000);
  notes.push(`3: after ticking the label step, Skip shown: ${back}`);
  await settle(page, { timeoutMs: 10_000 });
  await snap(page, "3-prep-label-ticked-375");
  expect(back).toBe(true);

  // The held lines, phase by phase (Skip is write-free).
  const held: string[] = [];
  for (let i = 0; i < 4; i++) {
    const j = await inner(page);
    const at = j.search(/On cook day/i);
    if (at >= 0) held.push(...j.slice(at).split("\n").slice(1, 8).filter((l) => /\(|morning|cook day/.test(l)));
    if (!/Skip this Prep/.test(j)) break;
    await press(page, "Skip this Prep");
    await page.waitForTimeout(800);
  }
  notes.push(`3: held lines: ${held.length ? held.map((l) => l.slice(0, 120)).join(" | ") : "none on this plan"}`);
  notes.push(`3: day words: prep day=${held.some((l) => /prep day\)/.test(l))} today=${held.some((l) => /today\)/.test(l))}`);

  // 1280: the server's cache, no second generation.
  await page.setViewportSize({ width: 1280, height: 800 });
  await visit(page, `/cook-session?mode=prep-week&planId=${fixture.planId}`, (j) => /Label \d+ containers/.test(j), 60_000);
  await snap(page, "3-prep-label-1280");
  await page.setViewportSize({ width: 375, height: 812 });
});

test("4 · item 7 (BUG-507) — Cook Mode: 'Next step in N minutes' under a long step", async () => {
  test.setTimeout(4 * 60_000);
  const url = `/cook-session?mealId=${fixture.mealId}&planId=${fixture.planId}&planItemId=${fixture.planItemId}`;
  const open = async () => {
    await visit(page, url, (j) => /step \d+ of|Did you prep this already/.test(j), 60_000);
    if (/Did you prep this already/.test(await inner(page))) await press(page, "No, start from prep");
    await waitInner(page, (j) => /step \d+ of (\d+)/.test(j), 30_000);
    await settle(page, { timeoutMs: 10_000 });
  };
  await open();
  let j = await inner(page);
  let patched = false;
  if (!/Next step (in \d+ minutes?|now)/.test(j)) {
    // No step of 20+ minutes on this meal: lengthen its longest step to 25 in the
    // meal read (the sequence's offsets stay the server's), as a long roast is.
    patched = true;
    await page.route(
      (u) => /\/api\/meals\/[^/]+$/.test(u.pathname),
      async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        const meal = body.meal ?? body;
        let best: { estimatedMinutes: number } | null = null;
        for (const d of meal.dishes ?? []) for (const s of d.steps ?? []) if (!best || s.estimatedMinutes > best.estimatedMinutes) best = s;
        if (best) best.estimatedMinutes = Math.max(25, best.estimatedMinutes);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      },
    );
    await open();
    j = await inner(page);
  }
  const lines = j.match(/Next step (in \d+ minutes?|now)/g) ?? [];
  notes.push(`7: ${patched ? "longest step lengthened to 25 in the meal read" : "a real 20+ minute step"}; lines: ${lines.join(" · ") || "NONE"}`);
  expect(lines.length).toBeGreaterThan(0);
  const line = page.getByText(/Next step (in \d+ minutes?|now)/).first();
  await line.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await snap(page, "7-next-step-375");
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await page.getByText(/Next step (in \d+ minutes?|now)/).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await snap(page, "7-next-step-1280");
  await page.setViewportSize({ width: 375, height: 812 });
  if (patched) await page.unroute((u) => /\/api\/meals\/[^/]+$/.test(u.pathname));
});

test("4b · CLIENT-2b D (D-WS9-321) — Cook Mode: the 'You prepped this' chip from preppedRefs", async () => {
  test.setTimeout(3 * 60_000);
  const url = `/cook-session?mealId=${fixture.mealId}&planId=${fixture.planId}&planItemId=${fixture.planItemId}`;
  const isMealRead = (u: URL) => /\/api\/meals\/[^/]+$/.test(u.pathname);
  // Until THX-3d round 5 deploys the server sends no preppedRefs: give the
  // meal read's first dish step one (a server that already sends them is
  // left alone and said so).
  let injected = false;
  await page.route(isMealRead, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const meal = body.meal ?? body;
    const all = [...(meal.steps ?? []), ...(meal.dishes ?? []).flatMap((d: any) => d.steps ?? [])];
    if (!all.some((st: any) => Array.isArray(st.preppedRefs) && st.preppedRefs.length > 0)) {
      const first = meal.dishes?.[0]?.steps?.[0] ?? meal.steps?.[0];
      if (first) {
        first.preppedRefs = [{ containerId: "qa-c1", label: "Taco spices" }];
        injected = true;
      }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const open = async () => {
    await visit(page, url, (j) => /step \d+ of|Did you prep this already/.test(j), 60_000);
    if (/Did you prep this already/.test(await inner(page))) await press(page, "No, start from prep");
    await waitInner(page, (j) => /step \d+ of (\d+)/.test(j), 30_000);
    await settle(page, { timeoutMs: 10_000 });
  };
  await open();
  const chip = page.locator('[data-testid^="prepped-ref-"]').first();
  const n = await page.locator('[data-testid^="prepped-ref-"]').count();
  const text = n ? ((await chip.innerText()) || "").trim() : "";
  notes.push(`D: ${injected ? "preppedRefs injected into the meal read" : "the server's own preppedRefs"}; chips ${n}; first "${text}"`);
  expect(n).toBeGreaterThan(0);
  expect(text).toMatch(/^You prepped this · .+/);
  await chip.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await snap(page, "D-prepped-chip-375");
  await page.setViewportSize({ width: 1280, height: 800 });
  await open();
  await page.locator('[data-testid^="prepped-ref-"]').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await snap(page, "D-prepped-chip-1280");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.unroute(isMealRead);
});

test("5 · item 6 (BUG-500 / BUG-506) — the emailed-link landings, signed out", async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  for (const [w, h] of [[375, 812], [1280, 800]] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    // The reset form (any token renders it; the token is spent on submit).
    await visit(p, "/reset-password?token=not-a-real-token", (j) => /Set a new password/.test(j), 45_000);
    notes.push(`6 @${w}: reset form path ${new URL(p.url()).pathname}; mark ${await p.getByTestId("kiwi-mark").count()}`);
    await snap(p, `6-reset-form-${w}`);
    await p.getByPlaceholder("New password", { exact: true }).fill("abcdefgh12");
    await p.getByPlaceholder("Confirm new password").fill("abcdefgh12");
    await press(p, "Change password");
    const invalid = await waitInner(p, (j) => /Link not valid/.test(j), 20_000);
    await settle(p, { timeoutMs: 5_000 });
    await snap(p, `6-reset-invalid-${w}`);
    expect(invalid).toBe(true);
    // The email-change landing with a bad token: it must STAY (not sign-in).
    await visit(p, "/verify-email?token=not-a-real-token", (j) => /Couldn.t verify email|invalid or expired/i.test(j), 45_000);
    await p.waitForTimeout(2_500);
    const stayed = new URL(p.url()).pathname;
    notes.push(`6 @${w}: verify-email (bad token, signed out) stays on ${stayed}`);
    await snap(p, `6-verify-invalid-${w}`);
    expect(stayed).toMatch(/verify-email/);
    await ctx.close();
  }

  test.skip(!MINT || !userId, "no mint script — the success paths need real tokens");
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const { change } = mint();
  await visit(p, `/verify-email?token=${encodeURIComponent(change)}`, (j) => /Your email is updated|Couldn.t verify/.test(j), 45_000);
  const updated = /Your email is updated/.test(await inner(p));
  emailChanged = updated;
  notes.push(`6: email change landing: ${updated ? "Your email is updated" : (await inner(p)).slice(0, 160)}`);
  await snap(p, "6-verify-updated-375");
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.waitForTimeout(600);
  await snap(p, "6-verify-updated-1280");
  expect(updated).toBe(true);
  await press(p, "Open Kiwi");
  const landed = (await waitPath(p, /sign-in|welcome/, 20_000)) ? new URL(p.url()).pathname : new URL(p.url()).pathname;
  notes.push(`6: Open Kiwi (signed out) → ${landed}`);
  await p.setViewportSize({ width: 375, height: 812 });

  // The reset, minted after the change (the change may move the token epoch).
  const { reset } = mint();
  await visit(p, `/reset-password?token=${encodeURIComponent(reset)}`, (j) => /Set a new password/.test(j), 45_000);
  await p.getByPlaceholder("New password", { exact: true }).fill(newPassword);
  await p.getByPlaceholder("Confirm new password").fill(newPassword);
  await press(p, "Change password");
  const signIn = await waitPath(p, /sign-in/, 20_000);
  const toast = await waitInner(p, (j) => /Password changed/.test(j), 5_000);
  passwordChanged = signIn;
  notes.push(`6: reset success → sign-in ${signIn}, toast ${toast}`);
  await snap(p, "6-reset-done-375");
  expect(signIn).toBe(true);
  await ctx.close();
});
