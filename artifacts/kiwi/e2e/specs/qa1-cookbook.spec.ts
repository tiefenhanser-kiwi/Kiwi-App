// ─────────────────────────────────────────────────────────────────────────────
// QA-1 A — the in-app Cookbook (BOOK-1C1), items 1–13 of Hans's device script,
// at the harness's 375 × 812. OPT-IN: runs only with KIWI_E2E_QA1=1.
//
//   KIWI_E2E_QA1=1 KIWI_E2E_RUN_ID=qa1 pnpm exec playwright test -c e2e/playwright.config.ts qa1-cookbook
//
// No AI. Writes to the test account, each undone before the item ends:
//   • item 9 hearts one meal and un-hearts it (DELETE /me/favorites/:id);
//   • item 10 adds one meal to one live plan, then deletes that plan item.
//
// Verdicts land in out/<run>/qa1-cookbook.json; screenshots in
// out/<run>/qa1-cookbook/.
// ─────────────────────────────────────────────────────────────────────────────
import { expect, test, type Page } from "@playwright/test";

import { WEB_ORIGIN, ensureRunDir } from "../src/env";
import { signInThroughUi, tapButton } from "../src/screen";
import { preflight, teardown, type Preflight } from "../src/stack";
import {
  Http,
  Ledger,
  chipBackground,
  clickText,
  parseCount,
  renderedText,
  scrollAllToBottom,
  settle,
  shot,
  todayYmd,
  visibleTabCount,
  waitForText,
} from "./qa1-shared";

const LABEL = "qa1-cookbook";
const ledger = new Ledger(LABEL);
let pf: Preflight | null = null;

test.skip(process.env.KIWI_E2E_QA1 !== "1", "QA-1 is opt-in — set KIWI_E2E_QA1=1");

test.beforeAll(async () => {
  ensureRunDir();
  pf = await preflight();
  for (const c of pf.checks) console.log(`[preflight] ${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.note}`);
  expect(pf.ok, "preflight failed").toBe(true);
});

test.afterAll(async () => {
  console.log(`→ ${ledger.write()}`);
  if (pf) teardown(pf);
});

/** Every GET /api/cookbook/meals the screen made: its query and its total. */
interface CookbookCall {
  url: string;
  q: URLSearchParams;
  total: number | null;
  first: { id: string; title: string; displayTitle?: string | null; estimatedTimeMinutes: number }[];
}

/** The count row's "N meals" (not the header's "N meals that fit …"). */
async function resultCount(page: Page): Promise<number | null> {
  const t = await renderedText(page);
  const line = t.find((l) => /^[\d,]+ meals?$/.test(l));
  return line ? parseCount(line) : null;
}

async function waitCountChange(page: Page, from: number | null, timeoutMs = 20_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let n = from;
  while (Date.now() < deadline) {
    n = await resultCount(page);
    if (n !== null && n !== from) return n;
    await page.waitForTimeout(250);
  }
  return n;
}

/** The cards on screen, top to bottom: title + meta + heart state, from the DOM. */
async function cards(page: Page): Promise<{ title: string; meta: string; minutes: number | null; saved: boolean }[]> {
  return page.evaluate(() => {
    const out: { title: string; meta: string; minutes: number | null; saved: boolean }[] = [];
    for (const plus of Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Add to a plan"]'))) {
      const footer = plus.parentElement;
      const card = footer?.parentElement;
      if (!card) continue;
      const lines = (card.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
      const metaIdx = lines.findIndex((l) => /^\d+ min\b/.test(l));
      const heart = footer!.querySelector<HTMLElement>('[aria-label$="My Meals"]');
      out.push({
        title: metaIdx > 0 ? lines.slice(0, metaIdx).join(" ") : lines[0] ?? "",
        meta: metaIdx >= 0 ? lines[metaIdx] : "",
        minutes: metaIdx >= 0 ? Number(/^(\d+) min/.exec(lines[metaIdx])![1]) : null,
        saved: heart?.getAttribute("aria-label") === "Remove from My Meals",
      });
    }
    return out;
  });
}

async function gotoCookbook(page: Page): Promise<string[]> {
  await page.goto(`${WEB_ORIGIN}/cookbook`, { waitUntil: "domcontentloaded" });
  await waitForText(page, (j) => /^[\d,]+ meals?$/m.test(j), 60_000);
  return settle(page, { timeoutMs: 30_000, minLines: 5 });
}

test("QA-1 A — Cookbook (items 1–13)", async ({ page }) => {
  // Thirteen items in one test; the config's 4 minutes is one flow's ceiling.
  test.setTimeout(20 * 60_000);
  const calls: CookbookCall[] = [];
  page.on("response", async (res) => {
    const u = res.url();
    if (!u.includes("/api/cookbook/meals")) return;
    let total: number | null = null;
    let first: CookbookCall["first"] = [];
    try {
      const b = await res.json();
      total = typeof b.total === "number" ? b.total : null;
      first = (b.meals ?? []).map((m: any) => ({
        id: m.id,
        title: m.title,
        displayTitle: m.displayTitle,
        estimatedTimeMinutes: m.estimatedTimeMinutes,
      }));
    } catch {
      /* non-JSON */
    }
    calls.push({ url: u, q: new URL(u).searchParams, total, first });
  });

  await signInThroughUi(page);
  // Watched from here: the sign-in screen's Google button logs a 403 at this
  // origin (localhost is not an allowed origin for the GSI client id), which is
  // the harness's address, not the screens under test.
  ledger.watch(page);
  const { http } = await Http.login();
  const frictions: string[] = [];

  // ── 1 — Recipes card → /cookbook, no tab bar, back ────────────────────────
  let recipesCount: number | null = null;
  await ledger.run("A1", "Recipes card count; arrow opens /cookbook with no tab bar; Back returns", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/meals`, { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("recipes-cookbook-card");
    await card.waitFor({ state: "visible", timeout: 60_000 });
    await waitForText(page, (j) => /[\d,]+ meals? · search, filter, plan a week/.test(j), 30_000);
    const cardText = (await card.innerText()).replace(/\s+/g, " ");
    recipesCount = parseCount(cardText);
    const tabsOnRecipes = await visibleTabCount(page);
    await shot(page, LABEL, "A1-01-recipes", shots);
    await card.click();
    await page.waitForURL(/\/cookbook(\?|$)/, { timeout: 20_000 });
    await settle(page, { timeoutMs: 30_000, minLines: 5 });
    const tabsOnCookbook = await visibleTabCount(page);
    await shot(page, LABEL, "A1-02-cookbook", shots);
    await tapButton(page, "Go back");
    await page.waitForURL(/\/meals(\?|$)/, { timeout: 20_000 }).catch(() => undefined);
    await settle(page, { timeoutMs: 20_000 });
    const backUrl = new URL(page.url()).pathname;
    await shot(page, LABEL, "A1-03-back", shots);
    const ok = recipesCount !== null && tabsOnRecipes > 0 && tabsOnCookbook === 0 && backUrl === "/meals";
    return {
      verdict: ok ? "pass" : "fail",
      evidence: `card "${cardText}" → N=${recipesCount}; tabs visible on Recipes=${tabsOnRecipes}, on /cookbook=${tabsOnCookbook}; Back → ${backUrl}`,
    };
  });

  // ── 2 — Meals chips exactly My Meals + Saved; Dishes has no chip row ──────
  await ledger.run("A2", "Meals chips are exactly My Meals and Saved; Dishes has no chip row", async (shots) => {
    await page.goto(`${WEB_ORIGIN}/meals`, { waitUntil: "domcontentloaded" });
    await waitForText(page, (j) => j.includes("My Meals"), 60_000);
    await settle(page, { timeoutMs: 20_000 });
    // The chip row = the siblings of the focusable "My Meals" chip.
    const mealsChips = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('[tabindex="0"]')).find(
        (e) => (e.innerText || "").trim() === "My Meals",
      );
      return el?.parentElement ? Array.from(el.parentElement.children).map((c) => (c as HTMLElement).innerText.trim()) : null;
    });
    await shot(page, LABEL, "A2-01-meals-chips", shots);
    await clickText(page, "Dishes");
    await settle(page, { timeoutMs: 20_000 });
    const dishesText = await renderedText(page);
    const legacy = ["Featured", "Top Rated", "Hosting & Events", "My Dishes"];
    const dishesChips = await page.evaluate((labels) => {
      return Array.from(document.querySelectorAll<HTMLElement>('[tabindex="0"]'))
        .map((e) => (e.innerText || "").trim())
        .filter((t) => labels.includes(t));
    }, legacy);
    await shot(page, LABEL, "A2-02-dishes", shots);
    await clickText(page, "Meals");
    const ok =
      JSON.stringify(mealsChips) === JSON.stringify(["My Meals", "Saved"]) && dishesChips.length === 0;
    return {
      verdict: ok ? "pass" : "fail",
      evidence: `Meals chip row = ${JSON.stringify(mealsChips)}; Dishes focusable chips among ${JSON.stringify(legacy)} = ${JSON.stringify(dishesChips)}; Dishes screen mentions "My Dishes" as text: ${dishesText.includes("My Dishes")}`,
    };
  });

  // ── 3 — header subline N = Recipes card N ─────────────────────────────────
  let baseTotal: number | null = null;
  await ledger.run("A3", 'Header reads "N meals that fit your allergies", N = the Recipes card', async (shots) => {
    const t = await gotoCookbook(page);
    const sub = t.find((l) => /that fit your allergies/.test(l)) ?? "";
    const n = parseCount(sub);
    baseTotal = await resultCount(page);
    await shot(page, LABEL, "A3-01-header", shots);
    return {
      verdict: n !== null && n === recipesCount ? "pass" : "fail",
      evidence: `subline "${sub}" (N=${n}); Recipes card N=${recipesCount}; list count row ${baseTotal}`,
    };
  });

  // ── 4 — search debounce ───────────────────────────────────────────────────
  await ledger.run("A4", 'Search: "chicken" changes the list; one character does nothing', async (shots) => {
    await gotoCookbook(page);
    const before = await resultCount(page);
    const box = page.getByLabel("Search meals or ingredients");
    const callsBefore = calls.length;
    await box.fill("c");
    await page.waitForTimeout(1500);
    const afterOne = await resultCount(page);
    const oneCharCalls = calls.slice(callsBefore).filter((c) => c.q.has("q"));
    await shot(page, LABEL, "A4-01-one-char", shots);
    await box.fill("chicken");
    const afterChicken = await waitCountChange(page, before);
    await settle(page, { timeoutMs: 20_000 });
    const chickenCalls = calls.slice(callsBefore).filter((c) => c.q.get("q") === "chicken" && !c.q.has("cursor"));
    const top = (await cards(page)).slice(0, 3).map((c) => c.title);
    await shot(page, LABEL, "A4-02-chicken", shots);
    const ok = afterOne === before && oneCharCalls.length === 0 && afterChicken !== before && chickenCalls.length >= 1;
    return {
      verdict: ok ? "pass" : "fail",
      evidence: `count ${before} → "c" ${afterOne} (q requests sent: ${oneCharCalls.length}) → "chicken" ${afterChicken} (q=chicken list requests: ${chickenCalls.length}); top cards ${JSON.stringify(top)}`,
    };
  });

  // ── 5 — ≤ 30 min chip, badge 1, sheet shows ≤30 ───────────────────────────
  await ledger.run("A5", '"≤ 30 min" lowers the count; Filters badge 1; the sheet shows ≤30 selected', async (shots) => {
    await gotoCookbook(page);
    const before = await resultCount(page);
    await clickText(page, "≤ 30 min");
    const after = await waitCountChange(page, before);
    const badgeBtn = page.getByRole("button", { name: "Filters, 1 on" });
    const badgeVisible = await badgeBtn.isVisible().catch(() => false);
    const badgeText = badgeVisible ? (await badgeBtn.innerText()).replace(/\s+/g, " ").trim() : "(no 'Filters, 1 on' button)";
    await shot(page, LABEL, "A5-01-chip-on", shots);
    await badgeBtn.click();
    await waitForText(page, (j) => j.includes("Total time") && j.includes("Hands-on time"), 15_000);
    await settle(page, { timeoutMs: 15_000 });
    // Document order: the quick chip (selected), the sheet's Total-time ≤30, its Hands-on ≤30.
    const bgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[tabindex="0"]'))
        .filter((e) => (e.innerText || "").trim() === "≤ 30 min")
        .map((e) => getComputedStyle(e).backgroundColor),
    );
    await shot(page, LABEL, "A5-02-sheet", shots);
    const [quick, sheetTotal, sheetActive] = bgs;
    const ok =
      before !== null && after !== null && after < before && badgeText.includes("1") &&
      bgs.length >= 3 && sheetTotal === quick && sheetActive !== quick;
    await tapButton(page, "Close");
    return {
      verdict: ok ? "pass" : "fail",
      evidence: `count ${before} → ${after}; Filters button "${badgeText}"; ≤30 chip backgrounds [quick, sheet total, sheet hands-on] = ${JSON.stringify(bgs)}`,
    };
  });

  // ── 6 — the filter sheet ─────────────────────────────────────────────────
  await ledger.run("A6", "Filter sheet: cuisine + Easy live count, Show, Clear all, locked allergy line → Profile, eating styles disabled", async (shots) => {
    await gotoCookbook(page);
    const unfiltered = await resultCount(page);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const showRe = /^Show ([\d,]+) meals?$/;
    const showN = async () => {
      const line = (await renderedText(page)).find((l) => showRe.test(l));
      return line ? Number(showRe.exec(line)![1].replace(/,/g, "")) : null;
    };
    await waitForText(page, (j) => /Show [\d,]+ meals?/.test(j), 15_000);
    const n0 = await showN();
    // The first cuisine chip in the sheet: the first focusable after the "Cuisine" heading.
    const cuisine = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll<HTMLElement>("div")).filter(
        (d) => (d.innerText || "").trim() === "Cuisine" && d.children.length === 0,
      );
      const head = heads[heads.length - 1];
      const row = head?.nextElementSibling as HTMLElement | null;
      const chip = row?.querySelector<HTMLElement>('[tabindex="0"]');
      return chip ? (chip.innerText || "").trim() : null;
    });
    if (!cuisine) throw new Error("no cuisine chip in the sheet");
    await clickText(page, cuisine);
    let n1 = n0;
    for (let i = 0; i < 40 && n1 === n0; i++) {
      await page.waitForTimeout(250);
      n1 = await showN();
    }
    // "Easy": the quick chip is earlier in the DOM, the sheet's is last.
    await clickText(page, "Easy");
    let n2 = n1;
    for (let i = 0; i < 40 && n2 === n1; i++) {
      await page.waitForTimeout(250);
      n2 = await showN();
    }
    await shot(page, LABEL, "A6-01-cuisine-easy", shots);
    await clickText(page, showRe);
    await waitForText(page, (j) => !j.includes("Hands-on time"), 15_000);
    const applied = await waitCountChange(page, unfiltered);
    await settle(page, { timeoutMs: 15_000 });
    const shown = await cards(page);
    const pillsOk = await page.evaluate(
      ({ cuisine }) => {
        const bad: string[] = [];
        for (const plus of Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Add to a plan"]'))) {
          const footer = plus.parentElement!;
          const t = (footer.innerText || "").toLowerCase();
          if (!t.includes("easy") || !t.includes(cuisine.toLowerCase())) bad.push(footer.innerText.replace(/\n/g, " | "));
        }
        return bad;
      },
      { cuisine },
    );
    await shot(page, LABEL, "A6-02-applied", shots);

    // Clear all resets the count.
    await page.getByRole("button", { name: /^Filters, \d+ on$/ }).click();
    await waitForText(page, (j) => /Show [\d,]+ meals?/.test(j), 15_000);
    await clickText(page, "Clear all");
    let n3 = await showN();
    for (let i = 0; i < 40 && n3 !== unfiltered; i++) {
      await page.waitForTimeout(250);
      n3 = await showN();
    }
    await shot(page, LABEL, "A6-03-cleared", shots);

    // The allergy line: no editable control, and it opens the preferences.
    const sheetText = await renderedText(page);
    const allergy = sheetText.find((l) => /^Your allergies/.test(l)) ?? "(no allergy line)";
    const controls = await page.evaluate(() =>
      document.querySelectorAll('[role="switch"], [role="checkbox"], input[type="checkbox"]').length,
    );
    const soon = await page.evaluate(() =>
      ["Vegetarian", "Vegan", "Pescatarian"].map((l) => {
        const el = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
          (d) => (d.innerText || "").trim() === l && d.querySelector("div") !== null,
        ) ?? Array.from(document.querySelectorAll<HTMLElement>("div")).find((d) => (d.innerText || "").trim() === l);
        const focusable = el?.closest('[tabindex="0"]') !== null && el?.closest('[tabindex="0"]') !== undefined;
        return { l, focusable, ariaDisabled: el?.closest("[aria-disabled]")?.getAttribute("aria-disabled") ?? null };
      }),
    );
    const december = sheetText.includes("coming in December");
    await shot(page, LABEL, "A6-04-allergy-eating-styles", shots);
    await page.getByText(/^Your allergies/).click();
    await page.waitForURL(/\/preferences/, { timeout: 15_000 }).catch(() => undefined);
    const prefsUrl = new URL(page.url()).pathname;
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "A6-05-profile", shots);

    const ok =
      n0 !== null && n1 !== n0 && n2 !== n1 && applied === n2 && pillsOk.length === 0 &&
      n3 === unfiltered && controls === 0 && prefsUrl.includes("preferences") &&
      soon.every((s) => !s.focusable) && december;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `Show N: start ${n0} → +${cuisine} ${n1} → +Easy ${n2}; applied list ${applied} (${shown.length} cards rendered, ` +
        `cards missing ${cuisine}/Easy pill: ${pillsOk.length}); Clear all → ${n3} (unfiltered ${unfiltered}); ` +
        `allergy line "${allergy}", switch/checkbox controls in sheet ${controls}, tap → ${prefsUrl}; ` +
        `eating styles ${JSON.stringify(soon)}, "coming in December" ${december}`,
    };
  });

  // ── 7 — sort ─────────────────────────────────────────────────────────────
  await ledger.run("A7", "Sort: Quickest = lowest times first; A–Z alphabetical (first 10)", async (shots) => {
    await gotoCookbook(page);
    const sorted = (s: string) =>
      page.waitForResponse((r) => r.url().includes("/api/cookbook/meals") && r.url().includes(`sort=${s}`), { timeout: 20_000 });
    await clickText(page, /^Sort:/);
    const quickResp = sorted("quickest");
    await clickText(page, "Quickest");
    await quickResp;
    await page.waitForTimeout(500);
    await settle(page, { timeoutMs: 20_000 });
    const quick = (await cards(page)).slice(0, 10);
    await shot(page, LABEL, "A7-01-quickest", shots);
    const mins = quick.map((c) => c.minutes ?? -1);
    const quickOk = quick.length >= 10 && mins.every((m, i) => i === 0 || m >= mins[i - 1]);

    await clickText(page, /^Sort:/);
    const azResp = sorted("az");
    await clickText(page, "A–Z");
    await azResp;
    await page.waitForTimeout(500);
    await settle(page, { timeoutMs: 20_000 });
    const az = (await cards(page)).slice(0, 10);
    await shot(page, LABEL, "A7-02-az", shots);
    const titles = az.map((c) => c.title);
    const azOk =
      az.length >= 10 &&
      titles.every((t, i) => i === 0 || titles[i - 1].localeCompare(t, "en", { sensitivity: "base" }) <= 0);
    const azApi = calls.filter((c) => c.q.get("sort") === "az" && !c.q.has("cursor")).at(-1);
    return {
      verdict: quickOk && azOk ? "pass" : "fail",
      evidence:
        `Quickest first 10 minutes ${JSON.stringify(mins)} (${quick.map((c) => c.title).join(" / ")}); ` +
        `A–Z first 10 ${JSON.stringify(titles)}` +
        (azApi ? `; API az first 10 title/displayTitle ${JSON.stringify(azApi.first.slice(0, 10).map((m) => [m.title, m.displayTitle ?? null]))}` : ""),
    };
  });

  // ── 8 — infinite scroll, Ask Kiwi at the end, zzzz ───────────────────────
  await ledger.run("A8", "Infinite scroll loads more; Ask Kiwi card at the end; zzzz shows it prefilled and its arrow opens Ask Kiwi", async (shots) => {
    // A query with more than one page and few enough to reach the end.
    let probe: { q: string; total: number } | null = null;
    for (const q of ["salmon", "shrimp", "tofu", "pork", "lamb", "beef", "pasta", "rice"]) {
      const r = await http.get<{ total: number }>(`/cookbook/meals?q=${q}&limit=1`);
      if (r.total > 30 && r.total <= 120) {
        probe = { q, total: r.total };
        break;
      }
    }
    if (!probe) throw new Error("no probe query with 31–120 results");
    await gotoCookbook(page);
    const box = page.getByLabel("Search meals or ingredients");
    await box.fill(probe.q);
    await waitCountChange(page, null);
    await settle(page, { timeoutMs: 20_000 });
    const helper = page.getByTestId("cookbook-ask-kiwi");
    let cursorCalls = 0;
    for (let i = 0; i < 30; i++) {
      await scrollAllToBottom(page);
      await page.waitForTimeout(700);
      cursorCalls = calls.filter((c) => c.q.get("q") === probe!.q && c.q.has("cursor")).length;
      if (await helper.isVisible().catch(() => false)) break;
    }
    const helperAtEnd = await helper.isVisible().catch(() => false);
    const loaded = calls
      .filter((c) => c.q.get("q") === probe!.q && c.q.get("limit") === "30")
      .reduce((n, c) => n + c.first.length, 0);
    await shot(page, LABEL, "A8-01-end-of-list", shots);

    await box.fill("zzzz");
    await waitForText(page, (j) => j.includes("No meals match these filters"), 20_000);
    await settle(page, { timeoutMs: 15_000 });
    const cardsShown = (await cards(page)).length;
    const prefill = await page.getByLabel("Describe a meal for Kiwi").inputValue();
    await shot(page, LABEL, "A8-02-zzzz", shots);
    await tapButton(page, "Ask Kiwi");
    await page.waitForURL(/\/ask-kiwi/, { timeout: 15_000 }).catch(() => undefined);
    await settle(page, { timeoutMs: 20_000 });
    const askUrl = page.url().replace(WEB_ORIGIN, "");
    const askInputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")).map((i) => i.value),
    );
    await shot(page, LABEL, "A8-03-ask-kiwi", shots);
    const ok =
      cursorCalls >= 1 && helperAtEnd && cardsShown === 0 && prefill === "zzzz" &&
      askUrl.includes("ask-kiwi") && askInputs.includes("zzzz");
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `q="${probe.q}" total ${probe.total}: ${cursorCalls} cursor page request(s), ${loaded} meals loaded, Ask Kiwi card visible at the end: ${helperAtEnd}; ` +
        `"zzzz": ${cardsShown} cards, helper input "${prefill}"; arrow → ${askUrl}, Ask Kiwi inputs ${JSON.stringify(askInputs)}`,
    };
  });

  // ── 9 — hearts ──────────────────────────────────────────────────────────
  await ledger.run("A9", "Hearts: card ♡ fills + toast + detail filled; un-heart on detail empties card; Saved chip lists it", async (shots) => {
    await gotoCookbook(page);
    const list = await cards(page);
    const idx = list.findIndex((c) => !c.saved);
    if (idx < 0) throw new Error("every visible card is already saved");
    const target = list[idx];
    const footer = page.locator('[aria-label="Add to a plan"]').nth(idx).locator("xpath=..");
    const favReq = page.waitForRequest((r) => r.url().includes("/api/me/favorites") && r.method() !== "GET", { timeout: 15_000 });
    await footer.locator('[aria-label="Save to My Meals"]').click();
    const req = await favReq;
    let mealId: string | null = null;
    try {
      mealId = (req.postDataJSON() as { mealId?: string })?.mealId ?? null;
    } catch {
      mealId = /favorites\/([^/?]+)/.exec(req.url())?.[1] ?? null;
    }
    const toast1 = await waitForText(page, (j) => j.includes("Saved to My Meals"), 8_000);
    const cardFilled = await footer.locator('[aria-label="Remove from My Meals"]').isVisible().catch(() => false);
    await shot(page, LABEL, "A9-01-card-hearted", shots);

    // Detail: filled. Wait for the detail screen itself (its Cook Now), not the
    // URL — the toast is still up and a tap can land under it.
    await page.waitForTimeout(3500);
    await footer.locator("xpath=preceding-sibling::*[1]").click();
    await page.getByRole("button", { name: "Cook Now" }).waitFor({ state: "visible", timeout: 30_000 });
    await settle(page, { timeoutMs: 30_000, minLines: 5 });
    const detailFilled = await page
      .getByRole("button", { name: "Remove from My Meals" })
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    await shot(page, LABEL, "A9-02-detail-filled", shots);
    // Un-heart on detail.
    await page.getByRole("button", { name: "Remove from My Meals" }).click();
    const toast2 = await waitForText(page, (j) => j.includes("Removed from My Meals"), 8_000);
    await page.getByRole("button", { name: "Save to My Meals" }).waitFor({ state: "visible", timeout: 10_000 });
    await shot(page, LABEL, "A9-03-detail-unhearted", shots);
    await tapButton(page, "Go back");
    await page.waitForURL(/\/cookbook/, { timeout: 15_000 });
    await settle(page, { timeoutMs: 20_000 });
    const after = (await cards(page)).find((c) => c.title === target.title);
    await shot(page, LABEL, "A9-04-card-after", shots);

    // Saved chip: heart it again, look on Recipes → Saved, then undo.
    const footer2 = page.locator('[aria-label="Add to a plan"]').nth(
      (await cards(page)).findIndex((c) => c.title === target.title),
    ).locator("xpath=..");
    await footer2.locator('[aria-label="Save to My Meals"]').click();
    await footer2.locator('[aria-label="Remove from My Meals"]').waitFor({ state: "visible", timeout: 10_000 });
    await page.goto(`${WEB_ORIGIN}/meals`, { waitUntil: "domcontentloaded" });
    await waitForText(page, (j) => j.includes("My Meals"), 60_000);
    await clickText(page, "Saved");
    const savedList = await waitForText(page, (j) => j.includes(target.title), 20_000);
    await shot(page, LABEL, "A9-05-saved-chip", shots);
    // Leave the account as it was.
    if (mealId) await http.req("DELETE", `/me/favorites/${mealId}`);
    await clickText(page, "My Meals");

    const ok = toast1.ok && cardFilled && detailFilled && toast2.ok && after?.saved === false && savedList.ok;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `"${target.title}" (${mealId}): toast "Saved to My Meals" ${toast1.ok}, card filled ${cardFilled}, detail filled ${detailFilled}; ` +
        `detail un-heart toast ${toast2.ok}, card after back saved=${after?.saved}; Saved chip lists it: ${savedList.ok}; un-hearted again by API`,
    };
  });

  // ── 10 — + → live plans only → plan → day → lands on that day ────────────
  await ledger.run("A10", "+ lists only active/upcoming plans; plan then day; the meal lands on that day", async (shots) => {
    await gotoCookbook(page);
    const first = (await cards(page))[0];
    await page.locator('[aria-label="Add to a plan"]').first().click();
    await waitForText(page, (j) => j.includes("Add to plan") && j.includes("Create a new plan"), 15_000);
    await settle(page, { timeoutMs: 15_000 });
    const sheetLines = await renderedText(page);
    await shot(page, LABEL, "A10-01-sheet", shots);

    const today = todayYmd();
    const all = await http.allMyPlans(today);
    const live = all.filter((p) => p.source === "instance" && (p.endDate ?? p.startDate) && (p.endDate ?? p.startDate) >= today);
    const notLive = all.filter((p) => !live.includes(p));
    const nameOf = (p: any) => String(p.displayTitle ?? p.name);
    const liveShown = live.filter((p) => sheetLines.some((l) => l === nameOf(p)));
    const liveMissing = live.filter((p) => !liveShown.includes(p));
    const notLiveShown = notLive.filter((p) => sheetLines.some((l) => l === nameOf(p)) && !live.some((q) => nameOf(q) === nameOf(p)));
    const firstPage = await http.get<{ plans: any[]; nextCursor?: string | null }>(`/plans?filter=my_plans&localDate=${today}`);

    // Pick a live plan that is not a THX fixture plan.
    const pick = liveShown.find((p) => !nameOf(p).startsWith("THX test")) ?? liveShown[0];
    if (!pick) throw new Error("no live plan shown in the sheet to add to");
    const beforeItems = (await http.get<any>(`/plans/${pick.id}`)).plan.items as any[];
    await page.locator('[tabindex="0"]').filter({ hasText: nameOf(pick) }).last().click();
    await waitForText(page, (j) => j.includes("Pick a day"), 10_000);
    const dayLines = (await renderedText(page)).filter((l) => /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day · /.test(l));
    await shot(page, LABEL, "A10-02-days", shots);
    // The last day: on a THX fixture plan (the only live plans on the test
    // account) that is Sunday, which holds no meal, and the item is deleted below.
    const dayLabel = dayLines[dayLines.length - 1];
    const day = dayLabel.split(" · ")[0];
    // The row carries a chevron glyph, so its text is not exactly the label.
    await page.getByRole("button").filter({ hasText: dayLabel }).last().click();
    const toast = await waitForText(page, (j) => j.includes(`· ${day}`) && j.includes("Added to"), 15_000);
    await shot(page, LABEL, "A10-03-added", shots);
    await page.waitForTimeout(1000);
    const afterItems = (await http.get<any>(`/plans/${pick.id}`)).plan.items as any[];
    const added = afterItems.filter((i) => !beforeItems.some((b) => b.id === i.id));
    const landed = added.find((i) => i.assignedDayOfWeek === day);
    // Leave the plan as it was.
    for (const i of added) await http.req("DELETE", `/plans/${pick.id}/items/${i.id}`);

    const ok = liveMissing.length === 0 && notLiveShown.length === 0 && !!landed && toast.ok;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `account plans (all pages) ${all.length}, live ${live.length}, page one ${firstPage.plans.length} (nextCursor ${firstPage.nextCursor ? "yes" : "no"}); ` +
        `sheet shows ${liveShown.length} live [${liveShown.map(nameOf).join(" / ")}], live missing ${liveMissing.length} [${liveMissing.map(nameOf).join(" / ")}], non-live shown ${notLiveShown.length}; ` +
        `days offered ${JSON.stringify(dayLines)}; added "${first.title}" to "${nameOf(pick)}" on ${day}: toast ${toast.ok}, ` +
        `API new item(s) ${JSON.stringify(added.map((i) => [i.assignedDayOfWeek, i.meal?.title ?? i.mealId]))} (removed again)`,
      api: { liveMissing: liveMissing.map((p) => ({ id: p.id, name: nameOf(p), startDate: p.startDate, endDate: p.endDate, status: p.status })) },
    };
  });

  // ── 11 — meal detail's own Add to Plan asks for a day ────────────────────
  await ledger.run("A11", "Meal detail's Add to Plan asks for a day", async (shots) => {
    await gotoCookbook(page);
    await page.locator('[aria-label="Add to a plan"]').first().locator("xpath=../preceding-sibling::*[1]").click();
    await page.waitForURL(/\/meal\//, { timeout: 15_000 });
    await settle(page, { timeoutMs: 30_000, minLines: 5 });
    await tapButton(page, "Add to Plan");
    await waitForText(page, (j) => j.includes("Create a new plan"), 15_000);
    await settle(page, { timeoutMs: 10_000 });
    const lines = await renderedText(page);
    const today = todayYmd();
    const live = (await http.allMyPlans(today)).filter((p) => p.source === "instance" && (p.endDate ?? p.startDate) >= today);
    const plan = live.find((p) => lines.includes(String(p.displayTitle ?? p.name)));
    if (!plan) throw new Error("no live plan in the detail sheet");
    await page.locator('[tabindex="0"]').filter({ hasText: String(plan.displayTitle ?? plan.name) }).last().click();
    const dayStep = await waitForText(page, (j) => j.includes("Pick a day"), 10_000);
    await shot(page, LABEL, "A11-01-detail-day-step", shots);
    await tapButton(page, "Close");
    return {
      verdict: dayStep.ok ? "pass" : "fail",
      evidence: `detail Add to Plan → plan "${plan.displayTitle ?? plan.name}" → "Pick a day" shown: ${dayStep.ok} (closed without adding)`,
    };
  });

  // ── 12 — body opens; ♡ and + don't ──────────────────────────────────────
  await ledger.run("A12", "Card body opens the meal; ♡ and + do not", async (shots) => {
    await gotoCookbook(page);
    const list = await cards(page);
    const idx = Math.max(0, list.findIndex((c) => !c.saved));
    const footer = page.locator('[aria-label="Add to a plan"]').nth(idx).locator("xpath=..");
    // ♡ (then undone).
    const favReq = page.waitForRequest((r) => r.url().includes("/api/me/favorites") && r.method() !== "GET", { timeout: 15_000 });
    await footer.locator('[aria-label="Save to My Meals"]').click();
    const req = await favReq;
    await page.waitForTimeout(1200);
    const afterHeart = new URL(page.url()).pathname;
    let mealId: string | null = null;
    try {
      mealId = (req.postDataJSON() as { mealId?: string })?.mealId ?? null;
    } catch {
      /* none */
    }
    await footer.locator('[aria-label="Remove from My Meals"]').click();
    await page.waitForTimeout(800);
    if (mealId) await http.req("DELETE", `/me/favorites/${mealId}`);
    // +.
    await footer.locator('[aria-label="Add to a plan"]').click();
    await page.waitForTimeout(1200);
    const afterPlus = new URL(page.url()).pathname;
    const sheetOpen = (await renderedText(page)).includes("Add to plan");
    await shot(page, LABEL, "A12-01-plus-sheet", shots);
    await tapButton(page, "Close");
    await page.waitForTimeout(600);
    // Body.
    await footer.locator("xpath=preceding-sibling::*[1]").click();
    await page.waitForURL(/\/meal\//, { timeout: 15_000 }).catch(() => undefined);
    const afterBody = new URL(page.url()).pathname;
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "A12-02-body-opened", shots);
    const ok = afterHeart === "/cookbook" && afterPlus === "/cookbook" && sheetOpen && afterBody.startsWith("/meal/");
    return {
      verdict: ok ? "pass" : "fail",
      evidence: `after ♡ URL ${afterHeart}; after + URL ${afterPlus} (sheet open ${sheetOpen}); after body tap URL ${afterBody}`,
    };
  });

  // ── 13 — console ─────────────────────────────────────────────────────────
  ledger.record({
    item: "A13",
    title: "No browser console errors across A",
    verdict: ledger.consoleErrors.length === 0 ? "pass" : "fail",
    evidence: ledger.consoleErrors.length === 0 ? "0 errors" : `${ledger.consoleErrors.length} error(s): ${ledger.consoleErrors.slice(0, 8).join(" ‖ ")}`,
    shots: [],
  });
  if (frictions.length) console.log(`[${LABEL}] frictions: ${frictions.join("; ")}`);
});
