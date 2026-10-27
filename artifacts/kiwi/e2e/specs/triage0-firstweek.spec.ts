// ─────────────────────────────────────────────────────────────────────────────
// TRIAGE-0 — a friend's first week, walked as a brand-new user at 375 × 812.
// OPT-IN: runs only with KIWI_E2E_TRIAGE0=1. DEV ONLY (preflight's fence).
//
//   KIWI_E2E_TRIAGE0=1 KIWI_E2E_RUN_ID=triage0 pnpm exec playwright test -c e2e/playwright.config.ts triage0-firstweek
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN. Not the shared test account: step 1
// is the sign-up screen, and a returning account cannot see onboarding or the
// first Home. The address is `triage0-<base36 time>@example.com` (REAL_ACCOUNT_WHERE
// excludes @example.com, and dev has no SIGNUP_ALERT_TO, so no alert mail). The
// password is random, held in memory only, never logged or written.
//
// 💸 IT SPENDS (measured ~$0.13 on 2026-10-16): one wizard generate, grocery
// gap-fill, two find-similar, one prep narration, one Tell Kiwi parse, one
// Ask Kiwi parse. Every figure comes from LLMCallLog for the new user.
//
// Writes, all to the new account: 3 plans (wizard, featured, Tell Kiwi), their
// forked meals, one grocery list, one prep-week structure. Nothing is cleaned
// up; the account is the evidence.
//
// AN ITEM IS A VERDICT, NOT AN ASSERTION (qa1-shared's Ledger): one "meh" must
// not hide the next eight. Verdicts → out/<run>/triage0-firstweek.json,
// screenshots → out/<run>/triage0-firstweek/.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { WEB_ORIGIN, ensureRunDir } from "../src/env";
import { ledgerBetween, summarise } from "../src/spend";
import { preflight, teardown, type Preflight } from "../src/stack";
import { Http, Ledger, escapeRe, renderedText, settle, shot, skipHowHeard, waitForText } from "./qa1-shared";

const LABEL = "triage0-firstweek";
const ledger = new Ledger(LABEL);
let pf: Preflight | null = null;

test.skip(process.env.KIWI_E2E_TRIAGE0 !== "1", "TRIAGE-0 is opt-in — set KIWI_E2E_TRIAGE0=1");
test.describe.configure({ mode: "serial" });

// ── state shared across the serial steps ─────────────────────────────────────
const email = `triage0-${Date.now().toString(36)}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
let userId = "";
let startedIso = "";
let wizardPlanId = "";
const timings: Record<string, number> = {};

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
  if (userId) spend = summarise("triage0", startedIso, ledgerBetween(userId, startedIso, new Date().toISOString()));
  // The new account's address and password never reach the ledger file.
  console.log(`→ ${ledger.write({ timings, spend })}`.split(email).join("«new-account»"));
  if (pf) teardown(pf);
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Role first (Button carries one since [design-fix] A2), then the focusable div. */
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

/** document.body.innerText as lines: visible text only, RNW's split runs rejoined. */
async function innerLines(): Promise<string[]> {
  const t = await page.evaluate(() => document.body.innerText || "");
  return t.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function waitInner(pred: (joined: string) => boolean, timeoutMs: number): Promise<{ ok: boolean }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred((await innerLines()).join("\n"))) return { ok: true };
    await page.waitForTimeout(300);
  }
  return { ok: false };
}

async function waitPath(re: RegExp, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (re.test(new URL(page.url()).pathname)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/** RNW scrolls inside a div: page the tallest scroller, one screenshot per screenful. */
async function scrollShots(name: string, shots: string[], max = 8): Promise<void> {
  for (let i = 0; i < max; i++) {
    const stuck = await page.evaluate((step) => {
      const els = Array.from(document.querySelectorAll<HTMLElement>("div")).filter((d) => {
        const s = getComputedStyle(d);
        return /(auto|scroll)/.test(s.overflowY) && d.scrollHeight > d.clientHeight + 4 && d.offsetParent !== null && d.getBoundingClientRect().width > 300;
      });
      els.sort((a, b) => b.clientHeight - a.clientHeight);
      const el = els[0];
      if (!el) return true;
      if (step === 0) {
        el.scrollTop = 0;
        return false;
      }
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.85;
      return el.scrollTop === before;
    }, i);
    if (stuck && i > 0) break;
    await page.waitForTimeout(600);
    await shot(page, LABEL, `${name}-p${i + 1}`, shots);
  }
}

/** Visible text runs whose box ends past the viewport's right edge (clipped at 375). */
async function clippedText(): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement;
      if (!el || el.offsetParent === null) continue;
      const t = (n.textContent ?? "").trim();
      if (t.length < 4) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      const b = r.getBoundingClientRect();
      if (b.width > 0 && b.top >= 0 && b.top < window.innerHeight && b.right > window.innerWidth + 1) out.push(t.slice(0, 80));
    }
    return out;
  });
}

async function planItems(planId: string): Promise<{ title: string; day: string; mealId: string }[]> {
  const r = await http.get<any>(`/plans/${planId}`);
  return r.plan.items.map((i: any) => ({ title: i.meal.displayTitle || i.meal.title, day: i.assignedDayOfWeek, mealId: i.mealId }));
}

const VOL_TO_FLOZ: Record<string, number> = { cup: 8, cups: 8, tablespoon: 0.5, tablespoons: 0.5, tbsp: 0.5, teaspoon: 1 / 6, teaspoons: 1 / 6, tsp: 1 / 6, "fl oz": 1 };
const PREP_WORDS = /\b(diced|minced|chopped|sliced|grated|shredded|fresh|large|medium|small|ripe)\b/g;

// ── 1 · sign-up and onboarding ───────────────────────────────────────────────

test("1 · sign-up → onboarding → first Home", async () => {
  test.setTimeout(4 * 60_000);
  await ledger.run("1a", "Sign-up (fresh account, no Turnstile on /auth/signup)", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 60_000, minLines: 3 });
    await shot(page, LABEL, "01-welcome", shots);
    await press("Start your 14-day free trial");
    await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
    await shot(page, LABEL, "02-signup", shots);
    await page.getByPlaceholder("First name").fill("Triage");
    await page.getByPlaceholder("Last name").fill("Zero");
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    const t0 = Date.now();
    await press("Create account");
    await skipHowHeard(page); // CLIENT-3 D — a new account's question
    const ok = await waitPath(/onboarding/, 60_000);
    timings.signupMs = Date.now() - t0;
    const token = await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? "");
    http = new Http(token);
    userId = (await http.get<any>("/auth/me")).user?.id ?? "";
    return { verdict: ok && !!userId ? "pass" : "fail", evidence: `onboarding reached=${ok} in ${timings.signupMs}ms` };
  });

  await ledger.run("1b", "Onboarding (3 cuisines, then Finish setup)", async (shots) => {
    await settle(page, { timeoutMs: 30_000 });
    await shot(page, LABEL, "03-onboarding-prefs", shots);
    for (const c of ["Italian", "Mexican", "Asian"]) await press(c);
    await press("Continue");
    await waitPath(/onboarding-step-3/, 30_000);
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "04-onboarding-step3", shots);
    const t0 = Date.now();
    await press("Finish setup");
    const home = await waitForText(page, (j) => /Create a meal plan/.test(j), 30_000);
    timings.finishSetupMs = Date.now() - t0;
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "05-home-first", shots);
    return { verdict: home.ok ? "pass" : "fail", evidence: `Home with "Create a meal plan" after ${timings.finishSetupMs}ms` };
  });
});

// ── 3 · three ways to a first plan ───────────────────────────────────────────

test("3a · wizard: Have Kiwi use my preferences → Complete plans → Use This Week", async () => {
  test.setTimeout(6 * 60_000);
  await ledger.run("3a", "Wizard plan (time to options, time to saved plan)", async (shots) => {
    await press("Have Kiwi use my preferences");
    await waitPath(/wizard/, 20_000);
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "06-wizard", shots);
    await press(/^Complete plans/);
    const t0 = Date.now();
    await press("Build my plan");
    const opts = await waitForText(page, (j) => (j.match(/Use This Week/g) ?? []).length >= 3, 180_000);
    timings.wizardOptionsMs = Date.now() - t0;
    await settle(page, { timeoutMs: 20_000 });
    await scrollShots("07-plan-options", shots, 6);
    const t1 = Date.now();
    await press("Use This Week", 0);
    const saved = await waitPath(/^\/plan\//, 180_000);
    timings.wizardUseThisWeekMs = Date.now() - t1;
    wizardPlanId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await settle(page, { timeoutMs: 30_000 });
    await scrollShots("08-plan-review", shots, 5);
    const items = await planItems(wizardPlanId);
    const order = items.map((i) => i.day).join(",");
    return {
      verdict: opts.ok && saved ? "pass" : "fail",
      evidence: `3 options in ${timings.wizardOptionsMs}ms; saved in ${timings.wizardUseThisWeekMs}ms; Plan Review day order ${order}`,
    };
  });
});

test("3b · featured plan: preview days vs saved days", async () => {
  test.setTimeout(4 * 60_000);
  await ledger.run("3b", "Featured plan (preview promise vs saved plan)", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    const t0 = Date.now();
    // The rail card is a role-less focusable div reading "FeaturedFamily Favorites".
    await press(/Family Favorites$/);
    const pv = await waitForText(page, (j) => /monday[\s\S]*Use This Week/i.test(j), 30_000);
    timings.featuredPreviewMs = Date.now() - t0;
    await shot(page, LABEL, "22-featured-preview", shots);
    // The preview's promise: DAY header, then the meal title on the next line.
    const lines = pv.text;
    const promised: Record<string, string> = {};
    lines.forEach((l, i) => {
      // The eyebrow is uppercased by CSS; the text node may be "Monday".
      if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(l) && lines[i + 1]) promised[lines[i + 1]] = l.toUpperCase();
    });
    const t1 = Date.now();
    await press("Use This Week", 0);
    await waitPath(/^\/plan\//, 60_000);
    timings.featuredUseMs = Date.now() - t1;
    const planId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "23-featured-plan-review", shots);
    const items = await planItems(planId);
    const moved = items.filter((it) => {
      const k = Object.keys(promised).find((t) => it.title.startsWith(t) || t.startsWith(it.title));
      return k && promised[k] !== it.day.toUpperCase();
    });
    return {
      verdict: moved.length === 0 ? "pass" : "fail",
      evidence: `preview ${timings.featuredPreviewMs}ms, saved ${timings.featuredUseMs}ms; ${moved.length}/${items.length} meals not on the preview's day (${moved.map((m) => `${m.title.slice(0, 24)}→${m.day}`).join("; ")})`,
    };
  });
});

test("3c · Tell Kiwi: does the shelf honour 'for two' and 'nothing too spicy'?", async () => {
  test.setTimeout(4 * 60_000);
  await ledger.run("3c", "Tell Kiwi → Meals to choose from → Build my week", async (shots) => {
    const text = "easy weeknight dinners for two, one fish night, nothing too spicy";
    await page.goto(`${WEB_ORIGIN}/tellkiwi?text=${encodeURIComponent(text)}`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    await shot(page, LABEL, "25-tellkiwi", shots);
    await press(/^Meals to choose from/);
    const t0 = Date.now();
    await press("Build my plan");
    await waitPath(/pick-meals/, 120_000);
    await waitForText(page, (j) => /Build my week/.test(j), 60_000);
    timings.tellKiwiShelfMs = Date.now() - t0;
    await settle(page, { timeoutMs: 20_000 });
    await scrollShots("26-pick-meals", shots, 3);
    const q = new URL(page.url()).searchParams;
    const household = JSON.parse(q.get("request") ?? "{}").householdSize;
    const shelf = JSON.parse(q.get("shelf") ?? '{"meals":[]}').meals as { title: string; description?: string }[];
    const spicy = shelf.filter((m) => /spicy|fiery|hot\b|chili crisp|arrabbiata/i.test(`${m.title} ${m.description ?? ""}`)).map((m) => m.title);
    for (let i = 0; i < 5; i++) await press("Pick", 0);
    const t1 = Date.now();
    await press("Build my week");
    await waitPath(/^\/plan\//, 120_000);
    timings.tellKiwiBuildMs = Date.now() - t1;
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "28-tellkiwi-plan", shots);
    const bad = household !== 2 || spicy.length > 0;
    return {
      verdict: bad ? "fail" : "pass",
      evidence: `shelf ${timings.tellKiwiShelfMs}ms, build ${timings.tellKiwiBuildMs}ms; householdSize=${household} (asked "for two"); spicy on shelf: ${spicy.join(" | ") || "none"}`,
    };
  });
});

// ── 4 · the grocery list, with Part A's grocery checks ───────────────────────

test("4 · grocery list on the wizard plan", async () => {
  test.setTimeout(5 * 60_000);
  await ledger.run("4", "Grocery list: duplicates, aisles, fl-oz packs, clipping", async (shots) => {
    expect(wizardPlanId).not.toBe("");
    await page.goto(`${WEB_ORIGIN}/plan/${wizardPlanId}`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    const t0 = Date.now();
    await press("Grocery List");
    await waitPath(/grocery-list\//, 180_000);
    await waitForText(page, (j) => /Mark Shopping Done/.test(j), 180_000);
    timings.groceryMs = Date.now() - t0;
    const listId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await settle(page, { timeoutMs: 30_000 });
    await scrollShots("09-grocery", shots, 14);
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("div"))) if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = 0;
    });
    const clipped: string[] = [];
    for (let i = 0; i < 14; i++) {
      clipped.push(...(await clippedText()));
      await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("div"))) {
          const s = getComputedStyle(el);
          if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) el.scrollTop += el.clientHeight * 0.85;
        }
      });
      await page.waitForTimeout(300);
    }
    const list = (await http.get<any>(`/grocery-lists/${listId}`)).list;
    const items: any[] = list.items.filter((i: any) => !i.deletedAt);
    // (231/123/161/210) same ingredient twice, or same name once prep words go
    const byKey = new Map<string, string[]>();
    for (const it of items) {
      const k = String(it.displayName).toLowerCase().replace(PREP_WORDS, "").replace(/s\b/g, "").replace(/\s+/g, " ").trim();
      byKey.set(k, [...(byKey.get(k) ?? []), it.displayName]);
    }
    const dupNames = [...byKey.values()].filter((v) => v.length > 1);
    const ids = new Map<string, number>();
    for (const it of items) if (it.ingredientId) ids.set(it.ingredientId, (ids.get(it.ingredientId) ?? 0) + 1);
    const dupIds = [...ids.values()].filter((n) => n > 1).length;
    // (186) eggs / cheese aisle
    const aisle = items
      .filter((it) => /\begg|cheese|parmesan|mozzarella|ricotta\b/i.test(it.displayName) && !/noodle/i.test(it.displayName))
      .filter((it) => !/dairy/i.test(String(it.storeSection)))
      .map((it) => `${it.displayName}→${it.storeSection}`);
    // (242) a fl-oz pack against a volume need
    const flOz = items.flatMap((it) => {
      const m = /\(([\d.]+)\s*fl oz\)/.exec(String(it.purchaseDisplayOverride ?? it.purchaseDisplay ?? ""));
      const per = VOL_TO_FLOZ[String(it.unit).toLowerCase()];
      if (!m || per === undefined) return [];
      const need = Number(it.quantity) * per;
      const bought = Number(m[1]) * Number(it.packCount ?? it.purchaseQuantity ?? 1);
      return need > bought + 0.01 ? [`${it.purchaseDisplay} ${it.displayName}: need ${need} fl oz, buys ${bought}`] : [];
    });
    const fails = dupNames.length + dupIds + aisle.length + flOz.length + clipped.length;
    return {
      verdict: fails === 0 ? "pass" : "fail",
      evidence:
        `${items.length} rows in ${timings.groceryMs}ms · name dups ${JSON.stringify(dupNames)} · ingredientId dups ${dupIds} · ` +
        `aisle ${JSON.stringify(aisle)} · fl-oz under-buy ${JSON.stringify(flOz)} · clipped at 375 ${JSON.stringify([...new Set(clipped)])}`,
    };
  });
});

// ── 5 · swap for similar ─────────────────────────────────────────────────────

test("5 · Swap for Similar on two meals", async () => {
  test.setTimeout(4 * 60_000);
  const items = await planItems(wizardPlanId);
  const inPlan = new Set(items.map((i) => i.title));
  for (const nth of [0, items.length - 1]) {
    await ledger.run(`5.${nth}`, "Swap for Similar (results already in the plan · A–B share)", async (shots) => {
      await page.goto(`${WEB_ORIGIN}/plan/${wizardPlanId}`, { waitUntil: "domcontentloaded" });
      await settle(page, { timeoutMs: 30_000 });
      const t0 = Date.now();
      await press("Swap for Similar Meal", nth);
      // A result row is "title" then "Cuisine · Difficulty · N min" (innerText,
      // which drops hidden stacked screens and rejoins RNW's split text runs).
      const r = await waitInner((j) => /Best match\n.+\n.+ · .+ min/.test(j), 60_000);
      timings[`swap${nth}Ms`] = Date.now() - t0;
      await settle(page, { timeoutMs: 15_000 });
      await shot(page, LABEL, `12-swap-similar-${nth}`, shots);
      const text = await innerLines();
      const after = text.slice(text.lastIndexOf("Best match") + 1);
      const titles = after.filter((l, i) => /·/.test(after[i + 1] ?? "") && !/·/.test(l) && l.length > 8).slice(0, 8);
      const dupInPlan = titles.filter((t) => inPlan.has(t));
      const ab = titles.filter((t) => /^[AB]/i.test(t)).length;
      return {
        verdict: r.ok && dupInPlan.length === 0 && ab < titles.length ? "pass" : "fail",
        evidence: `${timings[`swap${nth}Ms`]}ms; ${titles.length} results; already in plan: ${JSON.stringify(dupInPlan)}; starting A/B: ${ab}/${titles.length}`,
      };
    });
  }
});

// ── 6 · Prep the Week and the Hub ────────────────────────────────────────────

test("6 · Hub → Prep the Week → phase 2", async () => {
  test.setTimeout(6 * 60_000);
  await ledger.run("6", "Prep the Week (time, visible step numbering)", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/prep-cook?id=${wizardPlanId}`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    await scrollShots("14-hub", shots, 3);
    const t0 = Date.now();
    await press("Prep the Week");
    // "Phase 1 of 4" is four RNW text runs; innerText rejoins them.
    const ok = await waitInner((j) => /Phase 1 of \d/.test(j), 240_000);
    timings.prepWeekMs = Date.now() - t0;
    await settle(page, { timeoutMs: 20_000 });
    await scrollShots("15-prep-phase1", shots, 4);
    await press("Mark all complete");
    await waitInner((j) => /Phase 2 of \d/.test(j), 30_000);
    await settle(page, { timeoutMs: 15_000 });
    await scrollShots("16-prep-phase2", shots, 10);
    // Step numbers are their own line, right before a step title.
    const text = await innerLines();
    const from = text.findIndex((l) => /^Phase 2 of/.test(l));
    const nums = text.slice(from).filter((l) => /^\d{1,2}$/.test(l)).map(Number);
    const gaps = nums.filter((n, i) => i > 0 && n !== nums[i - 1] + 1);
    return {
      verdict: ok.ok && gaps.length === 0 ? "pass" : "fail",
      evidence: `prep ${timings.prepWeekMs}ms; phase-2 step numbers ${nums.join(",")}`,
    };
  });
});

// ── 7 · Cook Mode: the footer against the card ───────────────────────────────

test("7 · Cook Mode footer vs card", async () => {
  test.setTimeout(4 * 60_000);
  // A plan meal (multi-dish: sequenced) plus three single-dish catalog meals on
  // dev (serial-sum footer, BUG-344). Ids are dev rows chosen by probe344.mjs.
  const items = await planItems(wizardPlanId);
  const targets: { mealId: string; label: string }[] = [
    { mealId: items[0].mealId, label: "plan meal" },
    { mealId: "a8fc65f4-c3e1-448e-b601-253315efb071", label: "single-dish" },
    { mealId: "060d8614-a6cf-460b-bc29-24e077ea5b2a", label: "single-dish" },
    { mealId: "75075c96-4c8e-4774-96b8-9871e9200507", label: "single-dish" },
  ];
  for (const [i, t] of targets.entries()) {
    await ledger.run(`7.${i}`, `Cook Mode footer vs card (${t.label})`, async (shots) => {
      const q = new URLSearchParams({ mealId: t.mealId });
      if (t.label === "plan meal") q.set("planId", wizardPlanId);
      await page.goto(`${WEB_ORIGIN}/cook-session?${q}`, { waitUntil: "domcontentloaded" });
      await settle(page, { timeoutMs: 60_000 });
      if (/Did you prep this already/.test((await renderedText(page)).join(" "))) await press("No, start from prep");
      await settle(page, { timeoutMs: 30_000 });
      await shot(page, LABEL, `17-cook-${i}`, shots);
      const footer = await page.evaluate(() => {
        const m = /~\s*(\d+)\s*min\s*left/i.exec(document.body.innerText || "");
        return m ? Number(m[1]) : null;
      });
      const meal = await http.get<any>(`/meals/${t.mealId}`);
      // GET /meals/:id names the card time `minutes` (Meal.estimatedTimeMinutes).
      const card = Number(meal.meal.minutes);
      const over = footer === null ? null : footer - card;
      return {
        verdict: over !== null && over <= 5 ? "pass" : "fail",
        evidence: `${meal.meal.title}: footer ~${footer} vs card ${card} (${over === null ? "?" : over >= 0 ? `+${over}` : over} min)`,
      };
    });
  }
});

// ── 8 · Profile: any way to send feedback? ───────────────────────────────────

test("8 · Profile: feedback / rate the app", async () => {
  await ledger.run("8", "Profile offers feedback or a rating path", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/profile`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    await scrollShots("19-profile", shots, 3);
    const j = (await renderedText(page)).join(" ");
    const has = /feedback|rate (the app|kiwi)|contact us|support|help/i.test(j);
    return { verdict: has ? "pass" : "fail", evidence: has ? "a feedback/support entry is present" : "no feedback, rating, contact or support entry on Profile" };
  });
});

// ── 9 · Ask Kiwi for one meal ────────────────────────────────────────────────

test("9 · Ask Kiwi for a meal", async () => {
  test.setTimeout(3 * 60_000);
  await ledger.run("9", "Ask Kiwi draft (time, doneness temperature, header copy)", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/ask-kiwi`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    await page.locator("textarea").first().fill("sheet-pan roast chicken thighs with potatoes and a green salad");
    const t0 = Date.now();
    await page.getByRole("button", { name: "Ask Kiwi for a meal" }).click();
    const ok = await waitPath(/meal-builder/, 120_000);
    timings.askKiwiMs = Date.now() - t0;
    await settle(page, { timeoutMs: 20_000 });
    await scrollShots("33-ask-kiwi-draft", shots, 5);
    const values = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")).map((i) => i.value).join("\n"));
    const temp = /16[05]\s*°?\s*F/.test(values);
    const saysImported = /imported recipe/i.test((await renderedText(page)).join(" "));
    const decimals = (values.match(/^\d+\.\d+$/gm) ?? []).length;
    return {
      verdict: ok && temp && !saysImported ? "pass" : "fail",
      evidence: `${timings.askKiwiMs}ms; states 165°F: ${temp}; header says "imported recipe": ${saysImported}; raw decimal quantities: ${decimals}`,
    };
  });
});

