// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-4 — before the 1.2 build, on the web, at 375. DEV ONLY.
// OPT-IN: KIWI_E2E_CLIENT4=1.
//
//   KIWI_E2E_CLIENT4=1 KIWI_E2E_RUN_ID=client4 KIWI_E2E_WEB_ORIGIN=http://localhost:9410 \
//     pnpm exec playwright test -c e2e/playwright.config.ts client4
//
//   C (BUG-561) — a sign-up the server gave no trial (for real: the "+1" alias of an
//       inbox that had one, as sec3b does): "How did you hear about Kiwi?" shows
//       with no paywall over it; Skip, then the trial-used sheet opens. QA-8 B: that
//       is billing.mode "enforced"; in "free_launch" no trial is denied, and neither
//       screen shows a sheet or a trial, price or upgrade line.
//   A — Edit meal → + Add Dish → Save: Hans's note in the prompt; "Just this
//       time" and "Apply always" each confirm in his words.
//   B (BUG-537) — the account's own copies of the two turkeys written by count
//       (scripts/_scratch/client-4/c4Fixture.ts, no AI): the meal screen's bird
//       line at 12, 16 and the authored 14 lb, and with no weight.
//   E — Prep the Week's card says the step's labelCount (ONE real generation,
//       ~$0.10); the same payload with labelCount moved, then removed, proves
//       which number is read.
//   D (BUG-560) — /cook-session loaded directly (page.goto): advancing onto the
//       last step POSTs cook-finished once; Back leaves the page and sends no more.
//
// 🔴 IT SIGNS UP TWO NEW ACCOUNTS EVERY RUN (`client4-<base36>@example.com` and its
// "+1"), and DELETES both at the end through DELETE /me (plans and forks go with them).
// The dev server must run with the email overrides (QA-6 §0.2): no mail is sent.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import { expect, test, type Page, type Request } from "@playwright/test";

import { API_BASE, API_SERVER_ROOT, RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, escapeRe, settle, todayYmd } from "./qa1-shared";

// web4-sweep's corpus: the first is a two-dish meal.
const MEAL_IDS = ["3424eefa-423c-4be1-a987-8a55c8811576", "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d"];
const TRIAL_USED_TITLE = "Your free trial was already used with this email.";
const PROMPT_NOTE =
  "Added dishes are saved to the recipe, so they'll be there every time you cook it. Adding a dish to one meal only is in a future release.";
const JUST_THIS_TIME =
  "Your other changes are just for this meal. The new dish is saved to the recipe. Adding a dish to one meal only is in a future release.";
const APPLY_ALWAYS = "Added to the recipe. It'll be there next time too.";

test.skip(process.env.KIWI_E2E_CLIENT4 !== "1", "CLIENT-4 is opt-in — set KIWI_E2E_CLIENT4=1");
test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
// C — the first account takes the inbox's trial (made over the API); the browser's
// sign-up is its "+1" alias, which the server canonicalizes to the same inbox
// (emailCanonical.ts) and so answers with trialDeniedReason "trial_already_used".
const firstEmail = `client4-${stamp}@example.com`;
const email = `client4-${stamp}+1@example.com`;
const password = `Kw!${randomBytes(9).toString("base64url")}`;
let page: Page;
let http: Http;
const fixture = {
  userId: "",
  planId: "",
  planItemId: "",
  mealId: "",
  dishes: [`QA rice ${stamp}`, `QA beans ${stamp}`],
  thx: null as null | { planId: string; buttermilk: { mealId: string; itemId: string }; newTwist: { mealId: string; itemId: string } },
};
const notes: string[] = [];
const verdicts: Record<string, boolean> = {};
const requests: { method: string; url: string; body: string | null; status?: number; at: number; path: string }[] = [];

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
const innerAndFields = (p: Page) =>
  p.evaluate(() =>
    [document.body.innerText || "", ...Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")).map((e) => e.value)].join("\n"),
  );

async function waitInner(p: Page, pred: (joined: string) => boolean, timeoutMs: number, read: (p: Page) => Promise<string> = inner): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred(await read(p))) return true;
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

function check(name: string, ok: boolean, note: string): void {
  verdicts[name] = ok;
  notes.push(`${name}: ${ok ? "PASS" : "FAIL"} — ${note}`);
}

test.beforeAll(async ({ browser }) => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  page.on("request", (r: Request) => {
    if (r.url().startsWith(API_BASE)) {
      let path = "";
      try {
        path = new URL(page.url()).pathname;
      } catch {
        /* about:blank */
      }
      requests.push({ method: r.method(), url: r.url(), body: r.postData(), at: Date.now(), path });
    }
  });
  page.on("response", (res) => {
    const hit = [...requests].reverse().find((r) => r.url === res.url() && r.status === undefined);
    if (hit) hit.status = res.status();
  });
});

test.afterAll(async () => {
  const deleted: Record<string, number | null> = {};
  // A tsx-watch restart of the dev server answers 502 for a while: wait it out (≤ 3 min),
  // because the password lives only in this run's memory.
  for (let i = 0; i < 90; i++) {
    const h = await fetch(`${API_BASE}/healthz`).catch(() => null);
    if (h?.ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  for (const e of [email, firstEmail]) {
    deleted[e] = null;
    try {
      const login = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: e, password }),
      });
      const body = (await login.json()) as { authToken?: string };
      if (body.authToken) {
        deleted[e] = (await new Http(body.authToken).req("DELETE", "/me", { confirm: "delete", currentPassword: password })).status;
      }
    } catch (err) {
      notes.push(`cleanup of ${e} failed: ${String(err)}`);
    }
  }
  writeFileSync(join(RUN_DIR, "client4.json"), JSON.stringify({ email, firstEmail, deleted, fixture, verdicts, notes }, null, 2), "utf8");
});

test("1 · C (BUG-561) — How did you hear comes first; the trial-used sheet opens after it", async () => {
  test.setTimeout(5 * 60_000);
  const first = await fetch(`${API_BASE}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: firstEmail, password, firstName: "Client", lastName: "Four" }),
  });
  notes.push(`C: the inbox's first account (API) → ${first.status}`);
  expect(first.status).toBe(201);
  let answer: string | null = null;
  page.on("response", async (res) => {
    if (res.request().method() === "POST" && res.url().endsWith("/api/auth/signup")) {
      try {
        answer = (await res.json())?.user?.subscription?.trialDeniedReason ?? null;
      } catch {
        /* read once */
      }
    }
  });
  await visit(page, "/sign-up", (j) => /Create account/i.test(j), 45_000);
  await page.getByPlaceholder("First name").fill("Client");
  await page.getByPlaceholder("Last name").fill("Four");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await press(page, "Create account");

  expect(await waitPath(page, /how-heard/, 60_000), "the question's route").toBe(true);
  await waitInner(page, (j) => j.includes("How did you hear about Kiwi?"), 30_000);
  // The sheet's state is set once GET /me/subscription lands: wait for it, then a beat.
  const subscribed = await (async () => {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      if (seen("GET", /\/me\/subscription$/).some((r) => r.status === 200)) return true;
      await page.waitForTimeout(250);
    }
    return false;
  })();
  await page.waitForTimeout(2500);
  const onQuestion = await inner(page);
  const backdrops = await page.locator('[data-testid="paywall-backdrop"]').count();
  await snap(page, "C-question-first-375");
  // QA-8 B (BUG-617): the server's billing mode decides what the +1 account gets. In
  // "free_launch" (enforcement off, dev today) there is no trial to deny: no
  // trialDeniedReason, no sheet, no trial, price or upgrade line. "enforced" is BUG-561's check.
  const token = await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? "");
  const sub = await new Http(token).req<any>("GET", "/me/subscription");
  const mode: string = sub.body?.billing?.mode ?? "enforced"; // no billing field: an older server, today's behaviour
  notes.push(`C: billing.mode ${mode}; the +1 sign-up's answer: trialDeniedReason ${answer}`);
  if (mode === "free_launch") {
    const NO_TRIAL_SURFACE = /\btrial\b|14[- ]day|\$9\.99|\$99\.99|\bsubscribe\b|\bupgrade\b/i;
    const hitsOn = (t: string) => t.split("\n").filter((l) => NO_TRIAL_SURFACE.test(l));
    check(
      "C-question-first",
      answer === null && !("trialDeniedReason" in (sub.body ?? {})) && subscribed && onQuestion.includes("How did you hear about Kiwi?") && hitsOn(onQuestion).length === 0 && backdrops === 0,
      `free_launch · trialDeniedReason on the sign-up: ${answer}; on /me/subscription: ${"trialDeniedReason" in (sub.body ?? {})}; subscription loaded: ${subscribed}; question shown: ${onQuestion.includes("How did you hear about Kiwi?")}; trial/price lines: ${JSON.stringify(hitsOn(onQuestion))}; paywall backdrops: ${backdrops}`,
    );
    await press(page, "Skip");
    expect(await waitPath(page, /onboarding/, 30_000), "on to onboarding").toBe(true);
    // The sheet would open within seconds of the route; give it longer than that.
    const opened = await waitInner(page, (j) => j.includes(TRIAL_USED_TITLE) || hitsOn(j).length > 0, 8_000);
    const after = await inner(page);
    const afterBackdrops = await page.locator('[data-testid="paywall-backdrop"]').count();
    await snap(page, "C-no-sheet-after-375");
    check("C-sheet-after", !opened && afterBackdrops === 0, `free_launch · on ${new URL(page.url()).pathname} after Skip: trial/price lines ${JSON.stringify(hitsOn(after))}; paywall backdrops ${afterBackdrops}`);
  } else {
    check(
      "C-question-first",
      answer === "trial_already_used" && subscribed && onQuestion.includes("How did you hear about Kiwi?") && !onQuestion.includes(TRIAL_USED_TITLE) && backdrops === 0,
      `subscription loaded on the question: ${subscribed}; question shown: ${onQuestion.includes("How did you hear about Kiwi?")}; trial-used text on screen: ${onQuestion.includes(TRIAL_USED_TITLE)}; paywall backdrops: ${backdrops}`,
    );
    await press(page, "Skip");
    expect(await waitPath(page, /onboarding/, 30_000), "on to onboarding").toBe(true);
    const opened = await waitInner(page, (j) => j.includes(TRIAL_USED_TITLE), 30_000);
    await page.waitForTimeout(800);
    await snap(page, "C-sheet-after-375");
    check("C-sheet-after", opened, `the trial-used sheet on ${new URL(page.url()).pathname} after Skip: ${opened}`);
    await press(page, "Not now");
    await page.waitForTimeout(600);
  }
  expect(verdicts["C-question-first"] && verdicts["C-sheet-after"]).toBe(true);

  http = new Http(await page.evaluate(() => sessionStorage.getItem("kiwi_authToken") ?? ""));
  fixture.userId = String((await http.get<any>("/auth/me")).user?.id ?? "");

  // Onboarding, then the plan (from-meals binds the user's own copies), then the turkeys.
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
  const fx = spawnSync(process.execPath, ["--env-file=.env", "--import", "tsx", "scripts/_scratch/client-4/c4Fixture.ts", fixture.userId], {
    cwd: API_SERVER_ROOT,
    encoding: "utf8",
  });
  notes.push(`fixture: plan ${fixture.planId} item ${fixture.planItemId} meal ${fixture.mealId}; thx exit ${fx.status} ${fx.stderr.slice(0, 300)}`);
  fixture.thx = JSON.parse(readFileSync(join(API_SERVER_ROOT, "scripts", "_scratch", "client-4", "thx-fixture.local.json"), "utf8"));
  expect(fixture.mealId).not.toBe("");
  expect(fx.status).toBe(0);
});

test("2 · A — the add-dish copy: the prompt's note, Just this time, Apply always", async () => {
  test.setTimeout(5 * 60_000);
  for (const title of fixture.dishes) {
    const saved = await http.req<any>("POST", "/me/dishes", {
      title,
      servingsDefault: 4,
      sourceType: "manual",
      ingredients: [{ name: title.startsWith("QA rice") ? "Long-grain rice" : "Black beans", quantity: 1, unit: "cup" }],
      steps: [{ text: "Simmer 18 minutes.", estimatedMinutes: 18 }],
    });
    notes.push(`A: saved dish ${title} → ${saved.status}`);
  }
  const round = async (dishTitle: string, choice: "Just this time" | "Apply always", want: string, tag: string) => {
    await visit(page, `/meal/${fixture.mealId}?planId=${fixture.planId}&planItemId=${fixture.planItemId}`, (j) => /Cook Now/.test(j));
    await press(page, "Edit");
    await waitInner(page, (j) => /Save meal/.test(j), 30_000);
    await press(page, "+ Add Dish");
    await waitInner(page, (j) => j.includes(dishTitle), 30_000);
    // The chooser's rows are not buttons: the title's own text node is what is clicked.
    await page.waitForTimeout(800);
    await page.getByText(dishTitle, { exact: true }).first().click();
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    // The full read (GET /dishes/:id) fills THIS dish before it shows (round 1's rice is already on the meal).
    const ingredient = dishTitle.startsWith("QA rice") ? /long-grain rice/i : /black beans/i;
    const filled = await waitInner(page, (j) => ingredient.test(j), 30_000, innerAndFields);
    notes.push(`A ${tag}: picked dish filled from its read: ${filled}`);
    await page.waitForTimeout(500);
    await press(page, "Save meal");
    const prompt = await waitInner(page, (j) => j.includes(PROMPT_NOTE), 15_000);
    await snap(page, `A-prompt-${tag}-375`);
    check(`A-prompt-${tag}`, prompt, `the save prompt says Hans's note: ${prompt}`);
    await press(page, choice);
    const done = await waitInner(page, (j) => j.includes(want), 30_000);
    await snap(page, `A-saved-${tag}-375`);
    check(`A-saved-${tag}`, done, `${choice} confirms "${want.slice(0, 40)}…": ${done}`);
    await press(page, "OK");
    await page.waitForTimeout(800);
  };
  await round(fixture.dishes[0], "Just this time", JUST_THIS_TIME, "just-this-time");
  await round(fixture.dishes[1], "Apply always", APPLY_ALWAYS, "apply-always");
  const re = await http.get<any>(`/meals/${fixture.mealId}?planItemId=${fixture.planItemId}`);
  const titles = ((re.meal ?? re).dishes ?? []).map((d: any) => d.title);
  notes.push(`A: meal dishes after both saves: ${titles.join(" · ")}`);
  expect(Object.entries(verdicts).filter(([k]) => k.startsWith("A-")).every(([, v]) => v)).toBe(true);
});

test("3 · B (BUG-537) — a turkey by count says the chosen weight on the meal screen", async () => {
  test.setTimeout(5 * 60_000);
  const thx = fixture.thx!;
  const cases: Array<[string, { mealId: string; itemId: string }, number | null, string]> = [
    ["buttermilk", thx.buttermilk, 12, "1 whole turkey (12 lb)"],
    ["buttermilk", thx.buttermilk, 16, "1 whole turkey (16 lb)"],
    ["buttermilk", thx.buttermilk, 14, "1 whole turkey (14 lb)"],
    ["buttermilk", thx.buttermilk, null, "1 whole turkey"],
    ["newTwist", thx.newTwist, 12, "1 whole turkey (12 lb)"],
    ["newTwist", thx.newTwist, 16, "1 whole turkey (16 lb)"],
    ["newTwist", thx.newTwist, 14, "1 whole turkey (14 lb)"],
    ["newTwist", thx.newTwist, null, "1 whole turkey (12–14 lb)"],
  ];
  for (const [name, it, lb, want] of cases) {
    const patched = await http.req<any>("PATCH", `/plans/${thx.planId}/items/${it.itemId}`, { birdWeightLb: lb });
    const read = await http.get<any>(`/meals/${it.mealId}?planItemId=${it.itemId}`);
    const meal = read.meal ?? read;
    await visit(page, `/meal/${it.mealId}?planId=${thx.planId}&planItemId=${it.itemId}`, (j) => /Cook Now/.test(j) && /whole turkey/.test(j));
    const j = await inner(page);
    const line = j.split("\n").find((l) => /^\s*\d+ whole turkey/.test(l))?.trim() ?? "(no bird line)";
    // The other rows (a sample) — the brine/butter still follow chosen ÷ 14.
    const sample = j.split("\n").filter((l) => /buttermilk|unsalted butter/i.test(l)).slice(0, 2).map((l) => l.trim());
    await snap(page, `B-${name}-${lb ?? "none"}-375`);
    check(`B-${name}-${lb ?? "none"}`, line === want, `PATCH ${patched.status}, read birdWeightLb ${meal.birdWeightLb ?? null} kind ${meal.birdKind ?? null}; line "${line}" (want "${want}"); beside it: ${sample.join(" | ")}`);
  }
  await http.req("PATCH", `/plans/${thx.planId}/items/${thx.buttermilk.itemId}`, { birdWeightLb: null });
  await http.req("PATCH", `/plans/${thx.planId}/items/${thx.newTwist.itemId}`, { birdWeightLb: null });
  expect(Object.entries(verdicts).filter(([k]) => k.startsWith("B-")).every(([, v]) => v)).toBe(true);
});

test("4 · E — the prep-area card reads the step's labelCount, else its title", async () => {
  test.setTimeout(8 * 60_000);
  const PREP = `/cook-session?mode=prep-week&planId=${fixture.planId}`;
  const ready = (j: string) => /Set up your prep area|couldn.t|distracted/i.test(j);
  const labelStep = (body: any) =>
    (body?.result?.phases ?? []).flatMap((p: any) => p.steps ?? []).find((s: any) => s.stepKey === "week-labels");
  let served: any = null;
  page.on("response", async (res) => {
    if (res.request().method() === "POST" && /\/plans\/[^/]+\/prep-week$/.test(res.url()) && res.ok()) {
      try {
        served = await res.json();
      } catch {
        /* a body read twice */
      }
    }
  });
  await visit(page, PREP, ready, 5 * 60_000);
  const fill = async () => /you'll fill (\d+) containers?\./.exec(await inner(page))?.[1] ?? null;
  const step = labelStep(served);
  const live = await fill();
  await snap(page, "E-live-375");
  check("E-live", step?.labelCount !== undefined && live === String(step.labelCount), `served "${step?.title}" labelCount ${step?.labelCount}; card "fill ${live}"`);

  // The same payload (a cache hit), its labelCount moved: the card follows the number.
  const rewrite = async (edit: (s: any) => void) => {
    await page.route("**/api/plans/*/prep-week", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const res = await route.fetch();
      const body = await res.json();
      const s = labelStep(body);
      if (s) edit(s);
      await route.fulfill({ response: res, json: body });
    });
  };
  const n = Number(step?.labelCount ?? 0);
  await rewrite((s) => {
    s.labelCount = n + 5;
  });
  await visit(page, PREP, ready, 60_000);
  const moved = await fill();
  await snap(page, "E-moved-375");
  check("E-reads-number", moved === String(n + 5), `labelCount ${n + 5} under the title "${step?.title}": card "fill ${moved}"`);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  await rewrite((s) => {
    delete s.labelCount;
  });
  await visit(page, PREP, ready, 60_000);
  const fallback = await fill();
  const titleN = /^Label (\d+) containers?$/.exec(String(step?.title ?? ""))?.[1] ?? null;
  await snap(page, "E-fallback-375");
  check("E-fallback-title", fallback !== null && fallback === titleN, `no labelCount: card "fill ${fallback}", title's N ${titleN}`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect(Object.entries(verdicts).filter(([k]) => k.startsWith("E-")).every(([, v]) => v)).toBe(true);
});

test("5 · D (BUG-560) — a direct load of /cook-session: the finish is sent on reaching the last step", async () => {
  test.setTimeout(4 * 60_000);
  const finishes = () => seen("POST", /\/me\/activity\/cook-finished$/);
  const before = finishes().length;
  // A direct load: the tab's previous entry is the meal screen, a separate document.
  await visit(page, `/meal/${fixture.mealId}?planId=${fixture.planId}&planItemId=${fixture.planItemId}`, (j) => /Cook Now/.test(j));
  await visit(page, `/cook-session?mealId=${fixture.mealId}&planId=${fixture.planId}&planItemId=${fixture.planItemId}`, (j) => /— step \d+ of \d+ —/.test(j), 90_000);
  let steps = 0;
  for (let i = 0; i < 60; i++) {
    const next = page.getByRole("button", { name: /^\s*(Done\s*—\s*next step|Next|Next step)\b/i });
    if ((await next.count()) === 0) break;
    const sentSoFar = finishes().length - before;
    if (sentSoFar !== 0) notes.push(`D: a finish was sent before the last step (after ${steps} advances)`);
    await next.first().click();
    steps++;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(1500);
  const label = /— step \d+ of \d+ —/.exec(await inner(page))?.[0] ?? "(no step label)";
  const atLast = finishes().slice(before);
  await snap(page, "D-last-step-375");
  check(
    "D-sent-on-last",
    atLast.length === 1 && JSON.stringify(JSON.parse(atLast[0].body ?? "{}")) === JSON.stringify({ mealId: fixture.mealId, planItemId: fixture.planItemId }),
    `${steps} advances to ${label}; cook-finished ${atLast.map((f) => `${f.body} → ${f.status}`).join(" ; ") || "NOT SENT"}`,
  );
  await page.getByRole("button", { name: "Go back" }).first().click();
  await page.waitForTimeout(2500);
  const after = finishes().slice(before);
  check("D-once", after.length === 1, `after Back: ${after.length} POST(s); now on ${page.url().replace(WEB_ORIGIN, "")}`);
  expect(verdicts["D-sent-on-last"] && verdicts["D-once"]).toBe(true);
});
