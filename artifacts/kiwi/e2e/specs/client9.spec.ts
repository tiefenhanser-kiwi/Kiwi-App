// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-9 A (BUG-632), D (BUG-472) and E (BUG-467), on the web. DEV ONLY.
// OPT-IN: KIWI_E2E_CLIENT9=1.
//
//   KIWI_E2E_CLIENT9=1 KIWI_E2E_RUN_ID=client9 KIWI_E2E_WEB_ORIGIN=http://localhost:9440 \
//   KIWI_E2E_CLIENT9_HANS_TOKEN=<file> pnpm exec playwright test -c e2e/playwright.config.ts client9
//
// Needs: a dev api-server on :3140 with every mail switch off (api-server
// scripts/_scratch/client-8/serve.ts writes the boot proof, copied by the caller to
// out/<run>/server/boot-proof.json, which test 0 reads), nightProxy.cjs on :9440
// (KIWI_QA_API_PORT=3140) and dist exported with EXPO_PUBLIC_API_BASE_URL=http://localhost:9440/api --clear.
// E reads Hans's dev account through a session token minted with the server's
// signToken (api-server scripts/_scratch/client-9/fixtures.ts, git-ignored), whose
// path is KIWI_E2E_CLIENT9_HANS_TOKEN.
//
//   0 — the server's boot proof (mail off) and the proxy.
//   1 — A: a new account's plan of Classic Crispy Sesame Chicken at 3 of 4 servings:
//       Prep the Week, Cook Mode and Meal Detail all say "3 tbsp all-purpose flour",
//       never "¼ cup all-purpose flour".
//   2 — D: on that plan's grocery list, press and hold a catalog row, "I always have
//       this": the row is a Pantry Staple, GET /me/staples lists it; Profile → Staples
//       shows it with Hans's copy, and its remove takes it off (the row is itself again).
//   3 — E: Hans's account, READ-ONLY (every non-GET API request is aborted and
//       counted): the Plans tab pages through every plan on scroll (page after page of
//       20, past the old 100 cap, to plan 157 and the last); a search goes to the
//       server as ?q= and finds a plan the first page does not hold.
// Each at 375 × 812 and 1280 × 800, with screenshots. The new account is deleted
// through DELETE /me and proven gone (login 401).
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { API_BASE, RUN_DIR, WEB_ORIGIN, assertDevDatabase, ensureRunDir } from "../src/env";
import { Http, settle, todayYmd } from "./qa1-shared";

test.skip(process.env.KIWI_E2E_CLIENT9 !== "1", "CLIENT-9 is opt-in — set KIWI_E2E_CLIENT9=1");
test.describe.configure({ mode: "serial" });

const VIEWPORTS = [
  { name: "375", width: 375, height: 812 },
  { name: "1280", width: 1280, height: 800 },
] as const;
const SESAME = "296ed0e4-849c-4d0b-9853-3cde74495b41"; // Classic Crispy Sesame Chicken (4 servings)
const SPOONED = /3 tbsp all-purpose flour/i;
const LADDER = /¼ cup all-purpose flour/i;
const STAPLES_COPY = "Staples are things you always have, like garlic powder or olive oil. Kiwi keeps them off your list.";

const account = { email: `client9-${Date.now().toString(36)}@example.com`, token: "" };
const password = `Kw!${randomBytes(9).toString("base64url")}`;
const verdicts: Record<string, boolean> = {};
const notes: string[] = [];
const fixture = { planId: "", itemId: "", mealId: "", listId: "", row: null as null | { id: string; name: string }, hans: {} as Record<string, unknown> };

function check(name: string, ok: boolean, note: string): void {
  verdicts[name] = ok;
  notes.push(`${name}: ${ok ? "PASS" : "FAIL"} — ${note}`);
}

const inner = (p: Page) => p.evaluate(() => document.body.innerText || "");

async function waitInner(p: Page, pred: (j: string) => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred(await inner(p).catch(() => ""))) return true;
    await p.waitForTimeout(400);
  }
  return false;
}

async function api(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function shot(p: Page, name: string, vp: string, fullPage = true): Promise<string> {
  await settle(p, { timeoutMs: 20_000 });
  await p.waitForTimeout(800);
  mkdirSync(RUN_DIR, { recursive: true });
  await p.screenshot({ path: join(RUN_DIR, `${name}-${vp}.png`), fullPage });
  return inner(p);
}

async function newPage(browser: Browser, vp: (typeof VIEWPORTS)[number], token?: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.width > 500 ? 1 : 2 });
  if (token) await ctx.addInitScript((t) => sessionStorage.setItem("kiwi_authToken", t), token);
  return ctx.newPage();
}

async function signInBrowser(p: Page): Promise<void> {
  await p.goto(`${WEB_ORIGIN}/sign-in`, { waitUntil: "domcontentloaded" });
  await waitInner(p, (j) => /Sign in/.test(j), 45_000);
  await p.getByPlaceholder("Email").fill(account.email, { timeout: 45_000 });
  await p.getByPlaceholder("Password").fill(password, { timeout: 45_000 });
  const btn = p.getByRole("button", { name: /^\s*Sign in\s*$/ });
  if ((await btn.count()) > 0) await btn.first().click();
  else await p.locator('[tabindex="0"]:visible').filter({ hasText: /^\s*Sign in\s*$/ }).first().click();
  const end = Date.now() + 45_000;
  while (Date.now() < end && /sign-in/.test(new URL(p.url()).pathname)) await p.waitForTimeout(400);
}

/** The text of `re`'s line in the page, for the notes. */
const lineOf = (text: string, re: RegExp) => (text.split("\n").find((l) => re.test(l)) ?? "").slice(0, 200);

test.beforeAll(() => {
  ensureRunDir();
  const db = assertDevDatabase();
  console.log(`[fence] ${db.ok ? "PASS" : "FAIL"} dev database — ${db.note}`);
  expect(db.ok, "not the dev database").toBe(true);
});

test.afterAll(async () => {
  let deleted: unknown = null;
  try {
    const login = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: account.email, password }) });
    if (login.body?.authToken) {
      const del = await new Http(login.body.authToken).req("DELETE", "/me", { confirm: "delete", currentPassword: password });
      const again = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: account.email, password }) });
      deleted = { email: account.email, deleteStatus: del.status, loginAfter: again.status };
    } else deleted = { email: account.email, login: login.status };
  } catch (err) {
    deleted = { email: account.email, error: String(err) };
  }
  writeFileSync(join(RUN_DIR, "client9.json"), JSON.stringify({ deleted, fixture, verdicts, notes }, null, 2), "utf8");
});

test("0 · the server: mail off (boot proof) and the proxy", async () => {
  const proof = JSON.parse(readFileSync(join(RUN_DIR, "server", "boot-proof.json"), "utf8"));
  const p = proof.proof;
  const mailOff = ["empty", "unset"].includes(p.RESEND_API_KEY) && ["empty", "unset"].includes(p.SIGNUP_ALERT_TO) && p.LIFECYCLE_EMAIL_ENABLED === "false" && p.lifecycleEmailEnabled === false && proof.lifecycleOffLine === true && p.port === "3140";
  check("0-mail-off", mailOff, JSON.stringify(p));
  const health = await fetch(`${API_BASE}/healthz`);
  check("0-proxy", health.ok, `GET ${API_BASE}/healthz → ${health.status}`);
  expect(mailOff && health.ok).toBe(true);
});

test("1 · A: Sesame Chicken at 3 of 4 — prep, Cook Mode and Meal Detail say 3 tbsp flour", async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const made = await api("/auth/signup", { method: "POST", body: JSON.stringify({ email: account.email, password, firstName: "Client", lastName: "Nine" }) });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  account.token = made.body.authToken;
  const http = new Http(account.token);
  await http.req("PATCH", "/me/profile", { onboardingComplete: true, firstRunChoiceMade: true }).catch(() => undefined);
  const plan = await http.req<any>("POST", "/plans/from-meals", { mealIds: [SESAME], planDurationDays: 7, localDate: todayYmd() });
  expect(plan.status, JSON.stringify(plan.body).slice(0, 300)).toBeLessThan(300);
  fixture.planId = String((plan.body.plan ?? plan.body).id ?? plan.body.planId ?? "");
  const detail = await http.get<any>(`/plans/${fixture.planId}`);
  fixture.itemId = String(detail.plan.items[0].id);
  // A from-meals plan holds the user's copy of the meal: its id, not the catalog's.
  fixture.mealId = String(detail.plan.items[0].mealId);
  const patched = await http.req("PATCH", `/plans/${fixture.planId}/items/${fixture.itemId}`, { servingsOverride: 3 });
  check("A-servings-3", patched.status < 300, `PATCH item servingsOverride 3 → ${patched.status}`);

  // Prep the Week, server side (one narration): the dredge's flour in spoons.
  const prep = await http.req<any>("POST", `/plans/${fixture.planId}/prep-week`);
  const prepJson = JSON.stringify(prep.body ?? {});
  const prepFlour = (prepJson.match(/[^"]{0,80}all-purpose flour[^"]{0,40}/gi) ?? []).slice(0, 4);
  check("A-prep-api", prep.status < 300 && prepFlour.some((s) => SPOONED.test(s)) && !prepFlour.some((s) => LADDER.test(s)), `${prep.status}; ${JSON.stringify(prepFlour)}`);

  for (const vp of VIEWPORTS) {
    const p = await newPage(browser, vp);
    await signInBrowser(p);
    // Prep the Week (Cook Mode's prep-week mode).
    await p.goto(`${WEB_ORIGIN}/cook-session?mode=prep-week&planId=${fixture.planId}`, { waitUntil: "domcontentloaded" });
    await waitInner(p, (j) => /flour/i.test(j), 120_000);
    await p.getByText(/all-purpose flour/i).first().scrollIntoViewIfNeeded().catch(() => undefined);
    const prepText = await shot(p, "A-prep-week", vp.name);
    check(`A-prep-${vp.name}`, SPOONED.test(prepText) && !LADDER.test(prepText), lineOf(prepText, /all-purpose flour/i));
    // Cook Mode on the plan item.
    await p.goto(`${WEB_ORIGIN}/cook-session?mealId=${fixture.mealId}&planId=${fixture.planId}&planItemId=${fixture.itemId}`, { waitUntil: "domcontentloaded" });
    await waitInner(p, (j) => /cornstarch|Did you prep this already/i.test(j), 60_000);
    const gate = p.getByText("No, start from prep", { exact: true });
    if ((await gate.count()) > 0) await gate.first().click().catch(() => undefined);
    await waitInner(p, (j) => /all-purpose flour/i.test(j), 30_000);
    await p.getByText(/all-purpose flour/i).first().scrollIntoViewIfNeeded().catch(() => undefined);
    const cookText = await shot(p, "A-cook-mode", vp.name);
    check(`A-cook-${vp.name}`, SPOONED.test(cookText) && !LADDER.test(cookText), lineOf(cookText, /all-purpose flour/i));
    // Meal Detail in the plan (3 servings): the line and the step.
    await p.goto(`${WEB_ORIGIN}/meal/${fixture.mealId}?planId=${fixture.planId}&planItemId=${fixture.itemId}`, { waitUntil: "domcontentloaded" });
    await waitInner(p, (j) => /Ingredients/.test(j) && /all-purpose flour/i.test(j), 60_000);
    await p.getByText(/whisk together/i).first().scrollIntoViewIfNeeded().catch(() => undefined);
    const mealText = await shot(p, "A-meal-detail", vp.name);
    const hits = (mealText.match(/[^\n]{0,60}all-purpose flour[^\n]{0,20}/gi) ?? []).slice(0, 4);
    check(`A-meal-${vp.name}`, hits.length >= 2 && hits.every((h) => SPOONED.test(h)) && !LADDER.test(mealText), JSON.stringify(hits));
    await p.context().close();
  }
  const failed = Object.entries(verdicts).filter(([k, v]) => k.startsWith("A-") && !v);
  expect(failed, JSON.stringify(failed)).toEqual([]);
});

test("2 · D: “I always have this” on a grocery row, and Profile → Staples", async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const http = new Http(account.token);
  const gen = await http.req<any>("POST", `/plans/${fixture.planId}/generate-grocery-list`);
  fixture.listId = String(gen.body?.groceryListId ?? "");
  expect(fixture.listId, JSON.stringify(gen.body).slice(0, 300)).not.toBe("");
  const list = await http.get<any>(`/grocery-lists/${fixture.listId}`);
  const rows = (list.list?.items ?? []) as { id: string; displayName: string; ingredientId?: string | null; isUniversalStaple: boolean; isUserPantryStaple: boolean }[];
  const pick =
    rows.find((r) => r.ingredientId && !r.isUniversalStaple && !r.isUserPantryStaple && /sesame seeds|cornstarch|sesame oil/i.test(r.displayName)) ??
    rows.find((r) => r.ingredientId && !r.isUniversalStaple && !r.isUserPantryStaple);
  check("D-fixture", !!pick, `${rows.length} rows; ${rows.filter((r) => r.ingredientId).length} with an ingredientId; picked ${pick?.displayName}`);
  expect(pick).toBeTruthy();
  fixture.row = { id: pick!.id, name: pick!.displayName };
  const rowRe = new RegExp(pick!.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  for (const vp of VIEWPORTS) {
    const p = await newPage(browser, vp);
    await signInBrowser(p);
    await p.goto(`${WEB_ORIGIN}/grocery-list/${fixture.listId}`, { waitUntil: "domcontentloaded" });
    await waitInner(p, (j) => rowRe.test(j), 60_000);
    const name = p.getByText(rowRe).first();
    await name.scrollIntoViewIfNeeded();
    await shot(p, "D-list-before", vp.name);
    // Press and hold the row's name.
    const box = await name.boundingBox();
    expect(box).toBeTruthy();
    await p.mouse.move(box!.x + Math.min(20, box!.width / 2), box!.y + box!.height / 2);
    await p.mouse.down();
    await p.waitForTimeout(900);
    await p.mouse.up();
    const asked = await waitInner(p, (j) => j.includes(STAPLES_COPY) && j.includes("I always have this"), 10_000);
    await shot(p, "D-confirm", vp.name, false);
    check(`D-confirm-${vp.name}`, asked, `dialog with the copy and "I always have this": ${asked}`);
    const posted = p.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/api/me/staples"), { timeout: 30_000 });
    await p.getByText("I always have this", { exact: true }).last().click();
    const post = await posted;
    notes.push(`D-post-${vp.name}: POST /me/staples → ${post.status()}`);
    const staples = await http.get<any>("/me/staples");
    const after = await http.get<any>(`/grocery-lists/${fixture.listId}`);
    const row = (after.list?.items ?? []).find((r: { id: string }) => r.id === pick!.id);
    await name.scrollIntoViewIfNeeded().catch(() => undefined);
    const listText = await shot(p, "D-list-marked", vp.name);
    const tagged = new RegExp(`${rowRe.source}[\\s\\S]{0,160}Pantry Staple`, "i").test(listText);
    const listed = (staples.items ?? []) as { id: string; name: string }[];
    check(
      `D-marked-${vp.name}`,
      listed.length === 1 && row?.isUserPantryStaple === true && tagged,
      `GET /me/staples ${JSON.stringify(listed.map((s) => s.name))}; row isUserPantryStaple ${row?.isUserPantryStaple}; tag beside the row ${tagged}`,
    );
    // Profile → Staples.
    await p.goto(`${WEB_ORIGIN}/profile`, { waitUntil: "domcontentloaded" });
    await waitInner(p, (j) => /Staples/.test(j), 30_000);
    await p.getByText("Staples", { exact: true }).first().click();
    await waitInner(p, (j) => j.includes(STAPLES_COPY), 30_000);
    const pageText = await shot(p, "D-staples-page", vp.name);
    const shown = listed.length === 1 && pageText.toLowerCase().includes(listed[0].name.toLowerCase());
    check(`D-staples-page-${vp.name}`, shown && pageText.includes(STAPLES_COPY), `copy ${pageText.includes(STAPLES_COPY)}; lists ${listed[0]?.name}: ${shown}`);
    // Remove it.
    const deleted = p.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname.includes("/api/me/staples/"), { timeout: 30_000 });
    await p.getByLabel(`Remove ${listed[0]?.name} from staples`).first().click();
    notes.push(`D-delete-${vp.name}: DELETE /me/staples/:id → ${(await deleted).status()}`);
    const gone = await http.get<any>("/me/staples");
    const back = await http.get<any>(`/grocery-lists/${fixture.listId}`);
    const rowBack = (back.list?.items ?? []).find((r: { id: string }) => r.id === pick!.id);
    const emptyText = await shot(p, "D-staples-removed", vp.name);
    check(
      `D-removed-${vp.name}`,
      (gone.items ?? []).length === 0 && rowBack?.isUserPantryStaple === false && /No staples yet/.test(emptyText),
      `GET /me/staples ${(gone.items ?? []).length}; row isUserPantryStaple ${rowBack?.isUserPantryStaple}; empty state ${/No staples yet/.test(emptyText)}`,
    );
    await p.context().close();
  }
  const failed = Object.entries(verdicts).filter(([k, v]) => k.startsWith("D-") && !v);
  expect(failed, JSON.stringify(failed)).toEqual([]);
});

test("3 · E: Hans's account, read-only — the Plans tab reaches every plan; search is server side", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const tokenPath = process.env.KIWI_E2E_CLIENT9_HANS_TOKEN;
  expect(tokenPath, "KIWI_E2E_CLIENT9_HANS_TOKEN not set").toBeTruthy();
  const token = readFileSync(tokenPath!, "utf8").trim();
  for (const vp of VIEWPORTS) {
    const p = await newPage(browser, vp, token);
    // READ-ONLY: every API request that is not a GET is aborted (and counted).
    const blocked: string[] = [];
    await p.route(/\/api\//, (route) => {
      if (route.request().method() === "GET") return route.continue();
      blocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.abort();
    });
    const pages: { q: string | null; cursor: string | null; ids: string[]; titles: string[]; next: string | null }[] = [];
    p.on("response", async (res) => {
      const u = new URL(res.url());
      if (!u.pathname.endsWith("/api/plans") || u.searchParams.get("limit") !== "20") return;
      const b = await res.json().catch(() => null);
      const items = (b?.items ?? b?.plans ?? []) as { id: string; name: string; displayTitle?: string | null }[];
      if (u.searchParams.get("filter") !== "my_plans") return;
      pages.push({ q: u.searchParams.get("q"), cursor: u.searchParams.get("cursor"), ids: items.map((i) => i.id), titles: items.map((i) => i.displayTitle ?? i.name), next: b?.nextCursor ?? null });
    });
    await p.goto(`${WEB_ORIGIN}/plans`, { waitUntil: "domcontentloaded" });
    await waitInner(p, (j) => /Search plans/.test(j) || /Plans/.test(j), 60_000);
    await p.waitForTimeout(2500);
    // Hans's tab opens on his last filter (Featured). "My Plans" switches it here; the
    // chip's sync of lastPlansFilters (PATCH /me/profile) is aborted above, so his
    // account keeps Featured.
    await p.getByText("My Plans", { exact: true }).first().click();
    await waitInner(p, () => pages.length > 0, 30_000);
    await p.waitForTimeout(2500);
    await shot(p, "E-plans-top", vp.name, false);
    // Scroll to the end, again and again, until the last page has come in.
    const box = await p.getByPlaceholder("Search plans…").boundingBox();
    await p.mouse.move((box?.x ?? 100) + 40, Math.min(vp.height - 60, (box?.y ?? 200) + 300));
    for (let i = 0; i < 80; i++) {
      const done = pages.some((pg) => pg.q === null && pg.next === null);
      if (done && i > 2) break;
      await p.mouse.wheel(0, 4000);
      await p.waitForTimeout(700);
    }
    await p.mouse.wheel(0, 20000);
    await p.waitForTimeout(1500);
    const unsearched = pages.filter((pg) => pg.q === null);
    const ids = [...new Set(unsearched.flatMap((pg) => pg.ids))];
    const order = unsearched.flatMap((pg) => pg.ids.map((id, k) => ({ id, title: pg.titles[k] })));
    const at157 = order[156];
    const bottomText = await shot(p, "E-plans-bottom", vp.name, false);
    const reached = ids.length >= 157 && unsearched.some((pg) => pg.next === null) && !!at157 && bottomText.includes("Plans");
    // The 157th plan's row is on the page (A–Z on screen; any position).
    const rowShown = at157 ? (await p.getByText(at157.title, { exact: true }).count()) > 0 : false;
    check(
      `E-reach-${vp.name}`,
      reached && rowShown,
      `${unsearched.length} pages, ${ids.length} plans; last page reached ${unsearched.some((pg) => pg.next === null)}; plan 157 "${at157?.title}" on the page ${rowShown}`,
    );
    // A search goes to the server: a plan past the old 100 cap, by a word few titles
    // hold. The first page's rows that do not match must leave the screen.
    const has = (t: string, w: string) => t.toLowerCase().includes(w.toLowerCase());
    let target = order[order.length - 1];
    let term = "";
    for (const cand of order.slice(100).reverse()) {
      const words = (cand.title ?? "").split(/[^A-Za-z]+/).filter((w) => w.length >= 5);
      const rare = words.find((w) => order.filter((o) => has(o.title ?? "", w)).length <= 3);
      if (rare) { target = cand; term = rare; break; }
    }
    const answered = p.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/api/plans") && new URL(r.url()).searchParams.get("q") === term, { timeout: 30_000 }).catch(() => null);
    await p.getByPlaceholder("Search plans…").fill(term);
    await answered;
    await waitInner(p, (j) => j.includes(target?.title ?? "\u0000"), 20_000);
    await p.waitForTimeout(1500);
    const searched = pages.filter((pg) => pg.q === term);
    const searchText = await shot(p, "E-plans-search", vp.name, false);
    const firstPage = unsearched[0]?.ids ?? [];
    const results = searched.flatMap((pg) => pg.titles);
    const stale = (unsearched[0]?.titles ?? []).filter((t) => !has(t, term) && !results.some((r) => r.includes(t)) && searchText.includes(t));
    check(
      `E-search-${vp.name}`,
      !!term && searched.length > 0 && searched.some((pg) => pg.ids.includes(target!.id)) && !firstPage.includes(target!.id) && searchText.includes(target!.title) && stale.length === 0,
      `?q=${term}: ${searched.length} request(s), results ${JSON.stringify(results)}; "${target?.title}" (plan ${order.indexOf(target!) + 1} of ${order.length}) in them and on screen, not on the first page; first-page rows still on screen: ${stale.length}`,
    );
    // Every write was stopped in the browser: none reached the server. The only one
    // expected is the chip's lastPlansFilters sync.
    const unexpected = blocked.filter((b) => b !== "PATCH /api/me/ui-state" && b !== "PATCH /api/me/profile");
    check(`E-read-only-${vp.name}`, unexpected.length === 0, `non-GET requests, all aborted before the server: ${blocked.length ? blocked.join(", ") : "none"}`);
    fixture.hans[vp.name] = { pages: unsearched.length, plans: ids.length, at157: at157?.title, target: target?.title, term, blocked };
    await p.context().close();
  }
  const failed = Object.entries(verdicts).filter(([k, v]) => k.startsWith("E-") && !v);
  expect(failed, JSON.stringify(failed)).toEqual([]);
});
