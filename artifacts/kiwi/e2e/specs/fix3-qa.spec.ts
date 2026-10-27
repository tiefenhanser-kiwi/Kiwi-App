// ─────────────────────────────────────────────────────────────────────────────
// FIX-3 — browser QA for the small fixes before the friends-and-family invite.
// 375 × 812. DEV ONLY (preflight's fence). OPT-IN: runs only with KIWI_E2E_FIX3=1.
//
//   KIWI_E2E_FIX3=1 KIWI_E2E_RUN_ID=fix3 pnpm exec playwright test -c e2e/playwright.config.ts fix3-qa
//
// 🔴 IT SIGNS UP A NEW ACCOUNT EVERY RUN, as TRIAGE-0 and FIX-2 do:
// `fix3-<base36>@example.com`, random in-memory password. Never Hans's account.
// The one exception is item 6F (Prep the feast): the THX fixture lives on the
// shared dev test account (creds.ts), which it opens READ-ONLY ("Skip this Prep"
// is write-free) and skips when the fixture is absent.
//
// 💸 SPENDS: one grocery list and one Prep the Week narration on the new
// account's plan; Prep the feast is normally cached. 📧 SENDS ONE FEEDBACK
// EMAIL (item 8) — exactly one, to support@ on dev.
//
// Writes, all to the new account: one undated plan from a featured template,
// one this-week plan from catalog meals (their forks), one grocery list, prep
// completions on that plan. Verdicts → out/<run>/fix3-qa.json, screenshots →
// out/<run>/fix3-qa/.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { WEB_ORIGIN, ensureRunDir } from "../src/env";
import { signInThroughUi } from "../src/screen";
import { ledgerBetween, summarise } from "../src/spend";
import { preflight, teardown, type Preflight } from "../src/stack";
import { Http, Ledger, escapeRe, settle, shot, skipHowHeard, todayYmd, waitForText } from "./qa1-shared";

const LABEL = "fix3-qa";
const ledger = new Ledger(LABEL);
let pf: Preflight | null = null;

test.skip(process.env.KIWI_E2E_FIX3 !== "1", "FIX-3 QA is opt-in — set KIWI_E2E_FIX3=1");
test.describe.configure({ mode: "serial" });

const email = `fix3-${Date.now().toString(36)}@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
let userId = "";
let startedIso = "";
let weekPlanId = "";
let creamMealTitle = "";

// TRIAGE-0's single-dish dev meals (probe344.mjs) — unsequenced, BUG-344's class.
const SINGLE_DISH = [
  "a8fc65f4-c3e1-448e-b601-253315efb071",
  "060d8614-a6cf-460b-bc29-24e077ea5b2a",
];
// FIX-7 — FIX-5 rewrote the card (components/NoPlanThisWeekCard.tsx): Hans's
// copy, and no buttons. The old title here made items 1 and P pass vacuously
// (they assert the card is ABSENT, and the old title is absent everywhere).
const NO_PLAN_TITLE = "No plan set for this week yet";
const NO_PLAN_BODY = "Get a plan in seconds with Kiwi, choose a Featured Plan, or use one of your saved plans.";

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
  if (userId) spend = summarise("fix3", startedIso, ledgerBetween(userId, startedIso, new Date().toISOString()));
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

/** RNW scrolls inside a div: page the tallest scroller, one screenshot per screenful. */
async function scrollShots(name: string, shots: string[], max = 8): Promise<void> {
  for (let i = 0; i < max; i++) {
    const stuck = await page.evaluate((step) => {
      const els = Array.from(document.querySelectorAll<HTMLElement>("div")).filter((d) => {
        const s = getComputedStyle(d);
        return /(auto|scroll)/.test(s.overflowY) && d.scrollHeight > d.clientHeight + 4 && d.offsetParent !== null && d.getBoundingClientRect().width > 150;
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

/**
 * Text runs that end past the right edge of the box that clips them: the
 * viewport, or the nearest overflow-hidden ancestor (the grocery row). BUG-429's
 * name ran under the ✕ and past the screen's edge.
 */
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
      if (!(b.width > 0 && b.top >= 0 && b.top < window.innerHeight)) continue;
      if (b.right > window.innerWidth + 1) out.push(t.slice(0, 80));
    }
    return out;
  });
}

/** Scroll every scroller to the top, then step them all by most of a screen. */
async function scrollAll(step: number): Promise<void> {
  await page.evaluate((s) => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("div"))) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) {
        el.scrollTop = s === 0 ? 0 : el.scrollTop + el.clientHeight * 0.85;
      }
    }
  }, step);
  await page.waitForTimeout(300);
}

async function gotoTab(name: string): Promise<void> {
  const tab = page.getByRole("tab", { name: new RegExp(`^${escapeRe(name)}`, "i") });
  if ((await tab.count()) > 0) {
    await tab.first().click();
  } else {
    await page.getByText(name, { exact: true }).last().click();
  }
  await page.waitForTimeout(600);
}

const isHomePayload = (url: string) => new URL(url).pathname === "/api/home";

// ── 0 · a fresh account ──────────────────────────────────────────────────────

test("0 · sign-up → onboarding → first Home (BUG-118: new user keeps today's state)", async () => {
  test.setTimeout(4 * 60_000);
  await ledger.run("0", "Sign-up + onboarding; a NEW user's Home shows no 'no plan this week' card", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 60_000, minLines: 3 });
    await press("Start your 14-day free trial");
    await page.getByPlaceholder("First name").waitFor({ timeout: 30_000 });
    await page.getByPlaceholder("First name").fill("Fix");
    await page.getByPlaceholder("Last name").fill("Three");
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await press("Create account");
    await skipHowHeard(page); // CLIENT-3 D — a new account's question
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
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, "00-home-new-user", shots);
    const j = (await innerLines()).join("\n");
    const noCard = !j.includes(NO_PLAN_TITLE);
    return {
      verdict: ok && home.ok && !!userId && noCard ? "pass" : "fail",
      evidence: `onboarding=${ok} home=${home.ok}; card absent for a new user=${noCard}`,
    };
  });
});

// ── 2 · plans, but none this week ────────────────────────────────────────────

// FIX-7 — 2a is BUG-118's claim (plans, none this week → the card) checked
// against the card as FIX-5 left it. 2b–2d checked the card's three buttons
// (Go to Plans / See featured / Cook something up); FIX-5 removed them, so the
// items are removed too. That the card has nothing pressable, and that the make
// lane and the featured rail it points to sit below it, is FIX-5's item 1
// (e2e/specs/fix5-qa.spec.ts) — not repeated here.
test("2 · BUG-118: an undated plan → the card", async () => {
  test.setTimeout(4 * 60_000);
  // An undated plan is the "plans, none this week" state. POST /plans rather
  // than use-template, as FIX-5 did: the state is the same, and it does not
  // depend on the template fork path (BUG-435).
  const made = await http.req<any>("POST", "/plans", { name: "FIX3 2a undated" });

  await ledger.run("2a", "Home: the 'No plan set for this week yet' card, above the make lane", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    const ok = await waitInner((j) => j.includes(NO_PLAN_TITLE), 30_000);
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, "02a-home-no-plan-card", shots);
    const j = (await innerLines()).join("\n");
    const body = j.includes(NO_PLAN_BODY);
    const order = j.indexOf(NO_PLAN_TITLE) < j.toLowerCase().indexOf("plan something new");
    return {
      verdict: ok && body && order ? "pass" : "fail",
      evidence: `card=${ok}; body verbatim=${body}; card above the make lane=${order} (undated plan, POST /plans → ${made.status})`,
    };
  });
});

// ── the this-week plan everything else runs on ───────────────────────────────

test("P · a this-week plan from catalog meals (heavy cream in cups included)", async () => {
  test.setTimeout(4 * 60_000);
  await ledger.run("P", "Build a this-week plan: one heavy-cream-in-cups meal + multi-dish meals", async (shots) => {
    // Find a catalog meal whose heavy cream is measured in cups (TRIAGE-0's
    // "1 carton (8 fl oz) heavy cream (1½ cup)").
    let cream: { id: string; title: string; line: string } | null = null;
    for (const q of ["alfredo", "tuscan", "chowder", "vodka", "creamy", "cream"]) {
      const r = await http.get<any>(`/cookbook/meals?q=${encodeURIComponent(q)}`);
      for (const m of (r.meals as any[]).slice(0, 8)) {
        const d = (await http.get<any>(`/meals/${m.id}`)).meal;
        for (const dish of d.dishes ?? []) {
          const ing = (dish.ingredients as any[]).find((i) => /heavy cream|heavy whipping cream/i.test(i.name) && /^cups?$/i.test(i.unit) && i.quantity > 1);
          if (ing) {
            cream = { id: m.id, title: d.title, line: `${ing.quantity} ${ing.unit} ${ing.name}` };
            break;
          }
        }
        if (cream) break;
      }
      if (cream) break;
    }
    const others = ((await http.get<any>(`/cookbook/meals?q=${encodeURIComponent("chicken")}`)).meals as any[])
      .filter((m) => m.id !== cream?.id)
      .slice(0, 6);
    const multi: string[] = [];
    for (const m of others) {
      const d = (await http.get<any>(`/meals/${m.id}`)).meal;
      if ((d.dishes ?? []).length > 1) multi.push(m.id);
      if (multi.length === 3) break;
    }
    const ids = [...(cream ? [cream.id] : []), ...multi];
    const built = await http.req<any>("POST", "/plans/from-meals", { mealIds: ids, planDurationDays: 7, localDate: todayYmd() });
    weekPlanId = built.body.plan?.id ?? built.body.planId ?? built.body.id ?? "";
    creamMealTitle = cream?.title ?? "";
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    const thisWeek = await waitInner((j) => /this week/i.test(j) && !j.includes(NO_PLAN_TITLE), 30_000);
    await settle(page, { timeoutMs: 15_000 });
    await shot(page, LABEL, "P-home-this-week", shots);
    return {
      verdict: weekPlanId && cream && multi.length > 0 && thisWeek ? "pass" : "fail",
      evidence: `plan ${weekPlanId ? "built" : "NOT built"} (${built.status}); heavy cream: ${cream ? `${cream.title} — ${cream.line}` : "none found"}; multi-dish ${multi.length}; Home shows the this-week module and no card=${thisWeek}`,
    };
  });
});

// ── 3 · BUG-395: errors over cached data, retries, the auth 503 ──────────────

test("3 · BUG-395: a failed refresh keeps Home; a cold failure retries, then errors", async () => {
  test.setTimeout(5 * 60_000);
  let homeCalls = 0;
  // ⚠️ ONE matcher, kept: page.unroute only removes a route registered with the
  // SAME matcher, and a fresh arrow each time silently left /home failing.
  const homeMatcher = (u: URL) => isHomePayload(u.toString());
  const failHome = async () => {
    await page.route(homeMatcher, (route) => {
      homeCalls += 1;
      return route.fulfill({
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "0" },
        body: JSON.stringify({ error: "database unavailable", code: "db_unavailable", retryable: true }),
      });
    });
  };

  await ledger.run("3a", "Background refresh fails over cached data → Home stays (no full-screen error)", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await waitInner((j) => /this week/i.test(j), 30_000);
    await settle(page, { timeoutMs: 15_000 });
    // GET /home's staleTime is 60 s; a focus refetch only fires once stale.
    await page.waitForTimeout(62_000);
    homeCalls = 0;
    await failHome();
    // The trigger: React Query refetches stale queries on RECONNECT (its
    // default), which the browser announces with an "online" event. Neither a
    // tab press nor leave-and-back produced a /home refetch on web in this
    // harness (useRefetchOnFocus never fired), so the reconnect is the
    // background refresh this item needs.
    await page.context().setOffline(true);
    await page.waitForTimeout(800);
    await page.context().setOffline(false);
    await waitInner(() => homeCalls >= 3, 20_000);
    await page.waitForTimeout(1500);
    await shot(page, LABEL, "03a-refresh-failed-over-data", shots);
    const j = (await innerLines()).join("\n");
    const errorShown = j.includes("We couldn't reach Kiwi");
    const dataShown = /this week/i.test(j);
    await page.unroute(homeMatcher);
    return {
      // No /home request at all means the harness never produced a background
      // refresh (focus and reconnect both stayed silent on web) — not a verdict
      // on the fix, which homeSections.test.ts pins.
      verdict: homeCalls === 0 ? "cant-automate" : homeCalls >= 3 && !errorShown && dataShown ? "pass" : "fail",
      evidence: `failing /home calls ${homeCalls} (1 + 2 retries expected); error screen=${errorShown}; cached Home still drawn=${dataShown}`,
    };
  });

  await ledger.run("3b", "Cold load with /home failing → 3 attempts, then the error screen; Try again recovers", async (shots) => {
    homeCalls = 0;
    await failHome();
    await page.reload({ waitUntil: "domcontentloaded" });
    const err = await waitInner((j) => j.includes("We couldn't reach Kiwi"), 30_000);
    const calls = homeCalls;
    await shot(page, LABEL, "03b-cold-error-after-retries", shots);
    await page.unroute(homeMatcher);
    await press("Try again");
    const back = await waitInner((j) => /this week/i.test(j) && !j.includes("We couldn't reach Kiwi"), 30_000);
    await settle(page, { timeoutMs: 10_000 });
    await shot(page, LABEL, "03b-try-again-recovered", shots);
    return {
      verdict: err && calls === 3 && back ? "pass" : "fail",
      evidence: `error screen=${err} after ${calls} /home attempts; Try again recovered=${back}`,
    };
  });

  await ledger.run("3c", "/auth/me answers 503 once at boot → retried, Home loads (no failure screen)", async (shots) => {
    let meCalls = 0;
    await page.route("**/api/auth/me", (route) => {
      meCalls += 1;
      if (meCalls === 1) {
        return route.fulfill({
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "0" },
          body: JSON.stringify({ error: "authorization temporarily unavailable", code: "db_unavailable", retryable: true }),
        });
      }
      return route.continue();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    const home = await waitInner((j) => /this week/i.test(j), 30_000);
    await settle(page, { timeoutMs: 10_000 });
    await shot(page, LABEL, "03c-auth-me-503-once", shots);
    await page.unroute("**/api/auth/me");
    return {
      verdict: home && meCalls === 2 ? "pass" : "fail",
      evidence: `/auth/me calls ${meCalls} (503 then 200 expected); Home loaded=${home}`,
    };
  });
});

// ── 7 · Plan Review without the Breakfast/Lunch boxes ────────────────────────

test("7 · BUG-088: Plan Review shows no Breakfast/Lunch defaults", async () => {
  await ledger.run("7", "Plan Review: the two defaults boxes are gone", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/plan/${weekPlanId}`, { waitUntil: "domcontentloaded" });
    await waitInner((j) => /Grocery List/.test(j), 30_000);
    await settle(page, { timeoutMs: 15_000 });
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(...(await innerLines()));
      await scrollAll(1);
    }
    await scrollShots("07-plan-review", shots, 5);
    const hit = seen.filter((l) => /^(Breakfast|Lunch) defaults$/.test(l));
    return { verdict: hit.length === 0 ? "pass" : "fail", evidence: `defaults headers seen: ${JSON.stringify([...new Set(hit)])}` };
  });
});

// ── 4 + 5 · the grocery list ─────────────────────────────────────────────────

test("4/5 · grocery: heavy cream buys enough (BUG-242); names wrap at 375 (BUG-429)", async () => {
  test.setTimeout(6 * 60_000);
  let listId = "";
  await ledger.run("4", "Heavy cream (fl oz pack vs a cup need) buys enough", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/plan/${weekPlanId}`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    await press("Grocery List");
    await waitPath(/grocery-list\//, 180_000);
    await waitForText(page, (j) => /Mark Shopping Done/.test(j), 180_000);
    listId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await settle(page, { timeoutMs: 30_000 });
    // Scroll until the heavy cream row is on screen; read its rendered line.
    let line = "";
    await scrollAll(0);
    for (let i = 0; i < 16 && !line; i++) {
      line = (await innerLines()).find((l) => /heavy (whipping )?cream/i.test(l) && /fl oz/i.test(l)) ?? "";
      if (!line) await scrollAll(1);
    }
    if (line) {
      await page.getByText(line, { exact: false }).first().scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(400);
    }
    await shot(page, LABEL, "04-heavy-cream-row", shots);
    const list = (await http.get<any>(`/grocery-lists/${listId}`)).list;
    const row = (list.items as any[]).find((it) => !it.deletedAt && /heavy (whipping )?cream/i.test(it.displayName));
    const lines = await innerLines();
    const idx = lines.indexOf(line);
    const need = idx >= 0 ? lines.slice(idx, idx + 4).find((l) => /\(.*\)/.test(l) && /cup/.test(l)) ?? "" : "";
    const m = /^(\d+)\s+\w+\s*\(([\d.]+)\s*fl oz\)/i.exec(line);
    const glyph: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
    const needCups = row ? Number(row.quantity) * (/cup/i.test(row.unit) ? 1 : NaN) : NaN;
    const boughtFlOz = m ? Number(m[1]) * Number(m[2]) : NaN;
    const enough = Number.isFinite(needCups) && Number.isFinite(boughtFlOz) && boughtFlOz + 0.01 >= needCups * 8;
    void glyph;
    return {
      verdict: line && enough ? "pass" : "fail",
      evidence:
        `rendered "${line}"${need ? ` / "${need}"` : ""}; stored row: quantity ${row?.quantity} ${row?.unit}, purchaseDisplay "${row?.purchaseDisplay}", packCount ${row?.packCount ?? "null"}; ` +
        `need ${needCups * 8} fl oz vs buys ${boughtFlOz} fl oz (meal "${creamMealTitle}")`,
    };
  });

  await ledger.run("5", "No grocery name clipped at 375 px, at normal and doubled text", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/grocery-list/${listId}`, { waitUntil: "domcontentloaded" });
    await waitForText(page, (j) => /Mark Shopping Done/.test(j), 60_000);
    await settle(page, { timeoutMs: 20_000 });
    const scan = async (tag: string): Promise<string[]> => {
      const clipped: string[] = [];
      await scrollAll(0);
      for (let i = 0; i < 16; i++) {
        clipped.push(...(await clippedText()));
        if (i < 6) await shot(page, LABEL, `05-${tag}-p${i + 1}`, shots);
        await scrollAll(1);
      }
      return [...new Set(clipped)];
    };
    const normal = await scan("normal");
    // A stand-in for the phone's largest text: the whole page at 2× zoom, so the
    // row has half the width for the same words. The Pixel pass is the real one.
    await page.evaluate(() => {
      (document.documentElement.style as unknown as { zoom: string }).zoom = "2";
    });
    await page.waitForTimeout(800);
    const big = await scan("zoom2");
    await page.evaluate(() => {
      (document.documentElement.style as unknown as { zoom: string }).zoom = "";
    });
    const longNames = (await innerLines()).filter((l) => /short-grain|pizza dough/i.test(l));
    return {
      verdict: normal.length === 0 && big.length === 0 ? "pass" : "fail",
      evidence: `clipped at 375: ${JSON.stringify(normal)}; clipped at 2× zoom: ${JSON.stringify(big)}; long names seen: ${JSON.stringify(longNames)}`,
    };
  });
});

// ── 6 · Prep the Week: numbers do not skip ───────────────────────────────────

interface PhaseNumbers {
  phase: number;
  rendered: number[];
  server: number[];
  omitted: number;
}

async function walkPrep(
  planId: string,
  session: "feast" | null,
  file: string,
  shots: string[],
  opts: { writes: boolean } = { writes: true },
): Promise<PhaseNumbers[]> {
  const q = new URLSearchParams({ mode: "prep-week", planId });
  if (session) q.set("session", session);
  const respP = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes(`/api/plans/${planId}/prep-week`) && !r.url().includes("completions"),
    { timeout: 240_000 },
  );
  await page.goto(`${WEB_ORIGIN}/cook-session?${q}`, { waitUntil: "domcontentloaded" });
  const env = (await (await respP).json().catch(() => null)) as any;
  const phases: any[] = env?.result?.phases ?? env?.phases ?? [];
  await waitInner((j) => /Phase \d+ of \d+/.test(j), 120_000);
  await settle(page, { timeoutMs: 20_000 });
  const out: PhaseNumbers[] = [];
  for (let p = 0; p < 6; p++) {
    const lines = await innerLines();
    const hdr = lines.find((l) => /^Phase \d+ of \d+/.test(l)) ?? "";
    const n = Number(/^Phase (\d+)/.exec(hdr)?.[1] ?? 0);
    const from = lines.indexOf(hdr);
    // Collect every step number on this phase, scrolling to its end.
    const nums: number[] = [];
    for (let s = 0; s < 6; s++) {
      const l2 = await innerLines();
      const f2 = l2.findIndex((l) => /^Phase \d+ of \d+/.test(l));
      for (const l of l2.slice(f2 >= 0 ? f2 : from)) if (/^\d{1,2}$/.test(l)) nums.push(Number(l));
      await scrollAll(1);
    }
    const rendered = [...new Set(nums)].sort((a, b) => a - b);
    const ph = phases.find((x: any) => x.steps?.length && phases.filter((y: any) => y.steps?.length).indexOf(x) === p) ?? null;
    out.push({
      phase: n,
      rendered,
      server: (ph?.steps ?? []).map((s: any) => s.number),
      omitted: (ph?.steps ?? []).filter((s: any) => s.skipSuggested === true).length,
    });
    await scrollAll(0);
    await shot(page, LABEL, `${file}-phase${n}`, shots);
    const now = (await innerLines()).join("\n");
    if (now.includes("Skip this Prep")) await press("Skip this Prep");
    else if (opts.writes && now.includes("Mark all complete")) await press("Mark all complete");
    else break;
    const moved = await waitInner((j) => !j.includes(hdr) || /all done|nice work|you're done/i.test(j), 15_000);
    if (!moved) break;
    await page.waitForTimeout(500);
    if (!/Phase \d+ of \d+/.test((await innerLines()).join("\n"))) break;
  }
  return out;
}

const contiguous = (ns: number[]) => ns.every((x, i) => x === i + 1);

test("6 · BUG-013 leftover: Prep the Week step numbers run 1..n in every phase", async () => {
  test.setTimeout(8 * 60_000);
  await ledger.run("6", "Prep the Week: no skipped step numbers (new account's plan)", async (shots) => {
    const phases = await walkPrep(weekPlanId, null, "06-prep-week", shots);
    const bad = phases.filter((p) => !contiguous(p.rendered));
    const omitted = phases.reduce((n, p) => n + p.omitted, 0);
    return {
      verdict: phases.length > 0 && bad.length === 0 ? "pass" : "fail",
      evidence: `${JSON.stringify(phases)}; omitted (skipSuggested) steps in the payload: ${omitted}${omitted === 0 ? " — the renumber had nothing to close on this plan" : ""}`,
    };
  });
});

// ── 1 · Cook Mode's footer ───────────────────────────────────────────────────

test("1 · BUG-344: footer time on a sequenced meal, none on a single-dish meal", async () => {
  test.setTimeout(5 * 60_000);
  const plan = (await http.get<any>(`/plans/${weekPlanId}`)).plan;
  const items = plan.items as any[];
  let multiItem: any = null;
  for (const it of items) {
    const d = (await http.get<any>(`/meals/${it.mealId}`)).meal;
    if ((d.dishes ?? []).length > 1) {
      multiItem = it;
      break;
    }
  }
  const targets = [
    ...(multiItem ? [{ mealId: multiItem.mealId, planItemId: multiItem.id, kind: "sequenced" as const }] : []),
    ...SINGLE_DISH.map((mealId) => ({ mealId, planItemId: null, kind: "single" as const })),
  ];
  for (const [i, t] of targets.entries()) {
    await ledger.run(`1.${i}`, `Cook Mode footer (${t.kind})`, async (shots) => {
      const d = (await http.get<any>(`/meals/${t.mealId}`)).meal;
      const q = new URLSearchParams({ mealId: t.mealId });
      if (t.planItemId) {
        q.set("planId", weekPlanId);
        q.set("planItemId", t.planItemId);
      }
      await page.goto(`${WEB_ORIGIN}/cook-session?${q}`, { waitUntil: "domcontentloaded" });
      await settle(page, { timeoutMs: 60_000 });
      if (/Did you prep this already/.test((await innerLines()).join(" "))) await press("No, start from prep");
      await settle(page, { timeoutMs: 30_000 });
      await shot(page, LABEL, `01-cook-${t.kind}-${i}`, shots);
      const footer = await page.evaluate(() => {
        const m = /~\s*(\d+)\s*min\s*left/i.exec(document.body.innerText || "");
        return m ? Number(m[1]) : null;
      });
      const hasNext = /Next|Done|Finish/i.test((await innerLines()).join(" "));
      const dishes = (d.dishes ?? []).length;
      const ok = t.kind === "sequenced" ? footer !== null : footer === null && dishes === 1;
      return {
        verdict: ok && hasNext ? "pass" : "fail",
        evidence: `${d.title} (${dishes} dish${dishes === 1 ? "" : "es"}, card ${d.minutes} min): footer ${footer === null ? "no time shown" : `~${footer} min left`}; rest of the footer present=${hasNext}`,
      };
    });
  }
});

// ── 8 · LIFE-1's feedback screen ─────────────────────────────────────────────

test("8 · Profile → Help us improve Kiwi → Send feedback (ONE message)", async () => {
  test.setTimeout(3 * 60_000);
  await ledger.run("8", "Feedback: Send disabled when empty; one message → thank-you; no Rate Kiwi on web", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/profile`, { waitUntil: "domcontentloaded" });
    await settle(page, { timeoutMs: 30_000 });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(...(await innerLines()));
      if (seen.some((l) => /^Send feedback$/.test(l))) break;
      await scrollAll(1);
    }
    await page.getByText("Send feedback", { exact: true }).first().scrollIntoViewIfNeeded().catch(() => undefined);
    await shot(page, LABEL, "08a-profile-help-us-improve", shots);
    const section = seen.some((l) => /help us improve kiwi/i.test(l));
    const rate = seen.some((l) => /^Rate Kiwi$/.test(l));
    // LegalRow is neither a role=button nor a tabindex div here: click its text.
    await page.getByText("Send feedback", { exact: true }).first().click();
    await waitPath(/feedback/, 20_000);
    await settle(page, { timeoutMs: 15_000 });
    const send = page.getByRole("button", { name: /^\s*Send\s*$/ });
    const disabledEmpty =
      (await send.count()) > 0 &&
      ((await send.first().isDisabled()) || (await send.first().getAttribute("aria-disabled")) === "true");
    await shot(page, LABEL, "08b-feedback-empty-send-disabled", shots);
    await page.getByPlaceholder("Type your feedback").fill("FIX-3 browser QA: one test message from a throwaway dev account. Please ignore.");
    await page.getByPlaceholder("e.g. Grocery list").fill("FIX-3 QA");
    const enabledFilled = !((await send.first().isDisabled()) || (await send.first().getAttribute("aria-disabled")) === "true");
    await shot(page, LABEL, "08c-feedback-filled", shots);
    let posts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/(me\/)?feedback/.test(r.url())) posts += 1;
    });
    await send.first().click();
    const thanks = await waitInner((j) => /Thank you/.test(j), 30_000);
    await settle(page, { timeoutMs: 5_000 });
    await shot(page, LABEL, "08d-feedback-thank-you", shots);
    return {
      verdict: section && !rate && disabledEmpty && enabledFilled && thanks && posts === 1 ? "pass" : "fail",
      evidence: `"Help us improve Kiwi" section=${section}; Rate Kiwi on web=${rate}; Send disabled when empty=${disabledEmpty}, enabled with text=${enabledFilled}; POST /feedback ${posts}×; thank-you=${thanks}`,
    };
  });
});

// ── 6F · Prep the feast (shared dev test account, READ-ONLY) ─────────────────

test("6F · Prep the feast: step numbers run 1..n (THX fixture, read-only)", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const p2 = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  const prev = page;
  page = p2;
  try {
    await signInThroughUi(page);
    const { http: h2 } = await Http.login();
    const plans = await h2.allMyPlans(todayYmd());
    const classic = plans.find((p) => /^THX test · Classic$/.test(String(p.displayTitle ?? p.name)));
    test.skip(!classic, "the THX test fixture is not seeded on the shared test account");
    await ledger.run("6F", "Prep the feast: no skipped step numbers (feast session)", async (shots) => {
      const phases = await walkPrep(classic.id, "feast", "06F-prep-feast", shots, { writes: false });
      const bad = phases.filter((x) => !contiguous(x.rendered));
      const omitted = phases.reduce((n, x) => n + x.omitted, 0);
      return {
        verdict: phases.length > 0 && bad.length === 0 ? "pass" : "fail",
        evidence: `${JSON.stringify(phases)}; omitted steps in the payload: ${omitted}`,
      };
    });
  } finally {
    page = prev;
    await p2.close();
  }
});
