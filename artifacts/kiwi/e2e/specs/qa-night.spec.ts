// ─────────────────────────────────────────────────────────────────────────────
// QA-NIGHT-1 — the night run's browser pass. Started ONLY by
// artifacts/api-server/scripts/qa-night/run.ts (KIWI_QA_NIGHT=1), against the
// night's own stack: the web export on :9410 (nightProxy.cjs) and the api-server
// child on :3100. It never touches :9000 / :3000.
//
// One fresh household, 375 × 812, the brief's steps 1–3, 7 and 8:
//   1  sign up through the form, skip "How did you hear", onboarding;
//   2  a template plan (setup, through the API, as flow.spec does), the plan
//      screen and the grocery list — every row the API returned is on screen;
//   7  Cook Mode on a meal never prepped — every step the API returned, none blank;
//   3  Prep the Week, every phase "Mark all complete" — the API then holds a tick
//      for every step;
//   8  Cook Mode for a prepped meal — the chips the API's read carries are on
//      the screen ("You prepped this · …"), or the step folds into "Done in prep".
// Every check is recorded, never thrown, so the result file is written and the
// account is deleted whatever happened. Console errors and API responses ≥ 400
// are collected (Ledger.watch) and become R11 findings in run.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

import { test, type Page } from "@playwright/test";

import { API_SERVER_ORIGIN, WEB_ORIGIN, assertDevDatabase } from "../src/env";
import { bR1_everyRowRendered } from "../src/renderRules";
import type { GroceryItemWire } from "../src/api";
import { Http, Ledger, escapeRe, settle, shot, skipHowHeard, waitForText } from "./qa1-shared";

const ON = process.env.KIWI_QA_NIGHT === "1";
const RESULT = process.env.KIWI_QA_UI_RESULT ?? "";
const RUN_TAG = process.env.KIWI_QA_RUN_TAG ?? "manual";
const LABEL = "qa-night-ui";

test.skip(!ON, "started only by scripts/qa-night/run.ts");
test.describe.configure({ mode: "serial" });

const ledger = new Ledger(LABEL);
const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  checks.push({ name, pass, detail });
  console.log(`[${LABEL}] ${pass ? "PASS" : "FAIL"} ${name} — ${detail}`);
};

let page: Page;
let http: Http;
let userId: string | null = null;
const email = `qa-night-${RUN_TAG}-ui-${randomBytes(3).toString("hex")}@example.com`;
const password = `Qn!${randomBytes(9).toString("base64url")}`;

/** A role button, else a focusable div with the exact text — polled together, so a
 *  screen still loading does not send the lookup down the wrong branch. */
async function press(name: string | RegExp, nth = 0, timeoutMs = 45_000): Promise<void> {
  const re = typeof name === "string" ? new RegExp(`^\\s*${escapeRe(name)}\\s*$`) : name;
  const byRole = page.getByRole("button", { name: re });
  const byText = page.locator('[tabindex="0"]').filter({ hasText: re });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await byRole.count()) > nth) return byRole.nth(nth).click();
    if ((await byText.count()) > nth && (await byText.nth(nth).isVisible())) return byText.nth(nth).click();
    await page.waitForTimeout(300);
  }
  throw new Error(`no button "${String(name)}" within ${timeoutMs / 1000} s`);
}

async function inner(): Promise<string> {
  return page.evaluate(() => document.body.innerText || "");
}

async function waitInner(pred: (j: string) => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred(await inner())) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** Nothing on screen that reads as a broken render. */
function blankish(text: string): string[] {
  const bad: string[] = [];
  for (const re of [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\bnull\b(?! *min)/]) {
    const m = re.exec(text);
    if (m) bad.push(text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\n/g, " ⏎ "));
  }
  return bad;
}

test.beforeAll(async ({ browser }) => {
  const db = assertDevDatabase();
  if (!db.ok) throw new Error(db.note);
  if (!/:9410$/.test(WEB_ORIGIN) || !/:3100$/.test(API_SERVER_ORIGIN)) {
    throw new Error(`refusing: the night pass runs on :9410 → :3100 only (got ${WEB_ORIGIN} → ${API_SERVER_ORIGIN})`);
  }
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  ledger.watch(page);
});

test.afterAll(async () => {
  // Delete the account through the API (client4's afterAll), then write the result.
  try {
    if (http) {
      const del = await http.req("DELETE", "/me", { confirm: "delete", currentPassword: password });
      check("account deleted", del.status === 204, `DELETE /me → ${del.status}`);
    }
  } catch (e) {
    check("account deleted", false, String((e as Error).message));
  }
  const out = {
    userId,
    checks,
    consoleErrors: ledger.consoleErrors,
    apiErrors: ledger.apiErrors
      .filter((e) => !(e.status === 401 && /\/auth\/me$/.test(e.url)))
      .map((e) => `${e.method} ${new URL(e.url).pathname} → ${e.status} ${e.body.slice(0, 160)}`),
  };
  if (RESULT) writeFileSync(RESULT, JSON.stringify(out, null, 2).split(email).join("«night-ui-account»"));
  ledger.write({ checks });
});

test("night UI · sign-up, plan, grocery, Cook Mode unprepped, Prep the Week, Cook Mode prepped", async () => {
  test.setTimeout(25 * 60_000);
  const shots: string[] = [];

  // ── 1 · sign up, how-heard, onboarding ────────────────────────────────────
  await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await settle(page, { timeoutMs: 90_000, minLines: 3 });
  // QA-8 (BUG-622): Welcome's primary says "Get started — it's free" in free_launch (CLIENT-7 A,
  // dev and production since Oct 28) and "Start your 14-day free trial" when billing is enforced.
  const welcome = await inner();
  check("welcome-primary", /Get started — it's free|Start your 14-day free trial/.test(welcome),
    /Get started — it's free/.test(welcome) ? "free_launch: \"Get started — it's free\"" : /Start your 14-day free trial/.test(welcome) ? "enforced: \"Start your 14-day free trial\"" : "neither label");
  await press(/^\s*(Get started — it's free|Start your 14-day free trial)\s*$/);
  await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("First name").fill("Qa");
  await page.getByPlaceholder("Last name").fill("NightUi");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press("Create account");
  const asked = await skipHowHeard(page);
  check("1 how-heard shown to a new account", asked, asked ? "Skip pressed" : "the question did not show");
  await waitInner(() => /onboarding/.test(new URL(page.url()).pathname), 60_000);
  const token = await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? "");
  http = new Http(token);
  userId = (await http.get<any>("/auth/me")).user?.id ?? null;
  await settle(page, { timeoutMs: 30_000 });
  for (const c of ["Italian", "Mexican", "Asian"]) await press(c);
  await press("Continue");
  await waitInner(() => /onboarding-step-3/.test(new URL(page.url()).pathname), 30_000);
  await settle(page, { timeoutMs: 20_000 });
  await press("Finish setup");
  if (await waitInner((j) => /Not now/.test(j), 5_000)) await press("Not now");
  const home = await waitForText(page, (j) => /Create a meal plan/.test(j), 45_000);
  check("1 onboarding lands on Home", !!home, home ? "Home shows 'Create a meal plan'" : "Home never showed");
  await shot(page, LABEL, "01-home", shots);

  // ── 2 · a template plan (API setup), the plan screen, the grocery list ────
  const featured = await http.get<any>("/plans?filter=featured");
  const tpl = (featured.plans as { id: string; name: string }[]).find((p) => p.name === "Family Favorites") ?? featured.plans[0];
  const used = await http.req("POST", `/plans/use-template/${tpl.id}`, {});
  const planId = (used.body as any).instance.id as string;
  await http.req("PATCH", `/plans/${planId}`, { isActiveThisWeek: true });
  const plan = (await http.get<any>(`/plans/${planId}`)).plan;
  const titles = (plan.items as any[]).map((i) => (i.meal?.displayTitle ?? i.meal?.title ?? "") as string).filter(Boolean);
  await page.goto(`${WEB_ORIGIN}/plan/${planId}`, { waitUntil: "domcontentloaded" });
  // "Kiwi is thinking…" first: wait for a meal, then for the screen to settle.
  await waitInner((j) => !/Kiwi is thinking/.test(j) && titles.some((t) => j.includes(t.slice(0, 24))), 90_000);
  await settle(page, { timeoutMs: 30_000 });
  const planText = await inner();
  const missingTitles = titles.filter((t) => !planText.includes(t.slice(0, 24)));
  check("2 plan screen shows every meal", missingTitles.length === 0, `${titles.length - missingTitles.length}/${titles.length} meal titles on screen${missingTitles.length ? `; missing ${missingTitles.join(" | ")}` : ""}`);
  await shot(page, LABEL, "02-plan", shots);
  await press("Grocery List");
  const onList = await waitInner(() => /grocery-list\//.test(new URL(page.url()).pathname), 180_000);
  await waitInner((j) => /Mark Shopping Done/.test(j), 180_000);
  await settle(page, { timeoutMs: 30_000 });
  const listId = onList ? new URL(page.url()).pathname.split("/").pop()! : "";
  if (listId) {
    const list = await http.get<any>(`/grocery-lists/${listId}`);
    const items = list.list.items as GroceryItemWire[];
    const text: string[] = [];
    for (let i = 0; i < 12; i++) {
      text.push(...(await inner()).split("\n"));
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(250);
    }
    const r = bR1_everyRowRendered(items, text);
    check("2 every grocery row the API returned is on screen (B-R1)", r.pass !== false, `${r.candidates - r.violations.length}/${r.candidates} rows rendered${r.violations.length ? `; missing ${r.violations.slice(0, 5).map((v) => v.where).join(", ")}` : ""}`);
    const bad = blankish(text.join("\n"));
    check("2 grocery list renders nothing blank", bad.length === 0, bad.length ? bad.join(" · ") : "no undefined / NaN / [object Object]");
    await shot(page, LABEL, "03-grocery", shots);
  } else check("2 grocery list opened", false, `stayed on ${page.url()}`);

  // ── 7 · Cook Mode on a meal never prepped ─────────────────────────────────
  const first = plan.items[0];
  const cookWalk = async (it: any, file: string) => {
    const q = new URLSearchParams({ mealId: it.mealId, planId, planItemId: it.id });
    await page.goto(`${WEB_ORIGIN}/cook-session?${q}`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 60_000 });
    if (/Did you prep this already/.test(await inner())) await press("No, start from prep");
    await settle(page, { timeoutMs: 30_000 });
    await shot(page, LABEL, file, shots);
    const seen: string[] = [];
    let total = 0;
    for (let i = 0; i < 60; i++) {
      const t = await inner();
      seen.push(t);
      const m = /step (\d+) of (\d+)/i.exec(t);
      if (m) total = Number(m[2]);
      const next = page.getByRole("button", { name: /^\s*(Done\s*—\s*next step|Next|Next step)\b/i });
      if ((await next.count()) === 0) break;
      await next.first().click();
      await page.waitForTimeout(350);
    }
    return { text: seen.join("\n"), total };
  };
  const apiStepsOf = (m: any) => (m.dishes as any[]).reduce((n, d) => n + (d.steps?.length ?? 0), 0) + (m.steps?.length ?? 0);
  const unprepped = (await http.get<any>(`/meals/${first.mealId}?planItemId=${first.id}`)).meal;
  const c7 = await cookWalk(first, "04-cook-unprepped");
  check("7 Cook Mode unprepped walks every step", c7.total === 0 || c7.total >= apiStepsOf(unprepped) - (unprepped.mergedSteps?.length ?? 0) - 2, `screen says ${c7.total} steps; the API's meal has ${apiStepsOf(unprepped)}`);
  const bad7 = blankish(c7.text);
  check("7 Cook Mode unprepped renders nothing blank", bad7.length === 0, bad7.length ? bad7.join(" · ") : "clean");
  check("7 Cook Mode unprepped shows no prepped chip", !/You prepped this/.test(c7.text), /You prepped this/.test(c7.text) ? "a chip on a never-prepped meal" : "none");

  // ── 3 · Prep the Week, every phase marked complete ────────────────────────
  const respP = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/api/plans/${planId}/prep-week`) && !r.url().includes("completions"), { timeout: 240_000 });
  await page.goto(`${WEB_ORIGIN}/cook-session?${new URLSearchParams({ mode: "prep-week", planId })}`, { waitUntil: "domcontentloaded" });
  const env = (await (await respP).json().catch(() => null)) as any;
  // "Mark all complete" ticks every step but those held for cook day ("Cremini mushrooms — cook day").
  const weekKeys: string[] = (env?.result?.phases ?? []).flatMap((p: any) => (p.steps ?? []).filter((s: any) => !s.skipSuggested && !/— cook day$/.test(s.title)).map((s: any) => s.stepKey));
  await waitInner((j) => /Phase \d+ of \d+/.test(j), 240_000);
  await settle(page, { timeoutMs: 20_000 });
  for (let p = 0; p < 8; p++) {
    const t = await inner();
    const hdr = /Phase \d+ of \d+/.exec(t)?.[0];
    if (!hdr) break;
    await shot(page, LABEL, `05-prep-${p}`, shots);
    if (!/Mark all complete/.test(t)) break;
    await press("Mark all complete");
    await waitInner((j) => !j.includes(hdr) || /all done|nice work|you're done/i.test(j), 15_000);
    await page.waitForTimeout(600);
  }
  const comp = await http.get<any>(`/plans/${planId}/prep-week/completions`);
  const have = new Set((comp.completions as any[]).map((c) => c.stepKey));
  const missing = weekKeys.filter((k) => !have.has(k));
  check("3 Prep the Week: every step ticked after Mark all complete", weekKeys.length > 0 && missing.length === 0, `${weekKeys.length - missing.length}/${weekKeys.length} steps ticked${missing.length ? `; not ticked ${missing.slice(0, 5).join(", ")}` : ""}`);

  // ── 8 · Cook Mode for a prepped meal ──────────────────────────────────────
  const prepped = (await http.get<any>(`/meals/${first.mealId}?planItemId=${first.id}`)).meal;
  const chips = (prepped.dishes as any[]).flatMap((d) => (d.steps ?? []).flatMap((s: any) => (s.preppedRefs ?? []).map((r: any) => r.label as string)));
  const c8 = await cookWalk(first, "06-cook-prepped");
  const seenChips = chips.filter((l) => c8.text.includes(l));
  const folded = /Done in prep|Already prepped|Prepped on/i.test(c8.text);
  check("8 Cook Mode prepped shows the API's chips", chips.length === 0 ? folded || /You prepped this/.test(c8.text) : /You prepped this/.test(c8.text) && seenChips.length >= Math.ceil(chips.length / 2),
    `API read carries ${chips.length} chip(s) (${[...new Set(chips)].slice(0, 6).join(", ")}); screen shows "You prepped this" ${/You prepped this/.test(c8.text)}, ${seenChips.length} of their labels, prep recap ${folded}`);
  const bad8 = blankish(c8.text);
  check("8 Cook Mode prepped renders nothing blank", bad8.length === 0, bad8.length ? bad8.join(" · ") : "clean");
  check("UI console clean", ledger.consoleErrors.length === 0, `${ledger.consoleErrors.length} console error(s)`);
});
