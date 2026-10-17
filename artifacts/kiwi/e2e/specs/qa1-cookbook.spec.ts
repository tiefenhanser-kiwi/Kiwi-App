// ─────────────────────────────────────────────────────────────────────────────
// QA-1 A — the in-app Cookbook (BOOK-1C1), items 1–13 of Hans's device script,
// at the harness's 375 × 812. OPT-IN: runs only with KIWI_E2E_QA1=1.
//
//   KIWI_E2E_QA1=1 KIWI_E2E_RUN_ID=qa1 pnpm exec playwright test -c e2e/playwright.config.ts qa1-cookbook
//
// No AI. Writes to the test account, each undone before the item ends:
//   • item 9 saves one meal and un-saves it (DELETE /me/favorites/:id);
//   • item 10 adds one meal to one live plan, then deletes that plan item.
//
// BOOK-1C2 — the heart is the Save chip ("Save to My Meals" / "Saved to My
// Meals"), and these items were added for Hans's Pixel findings:
//   • B1  one sage on the Recipes page (computed colours);
//   • B3  the filter race: a delayed response for the filters just left, the
//         "updating" state on the count and on the sheet's Show N;
//   • B4  photos after a fast fling (web);
//   • B6  a plan made from the + flow is in the next + (the plan is composted
//         again at the end);
//   • B7  system tags never on detail; detail's Save follows the card's
//         lineage rule. On the user's own Playlist copy of a catalog meal:
//         its tags are changed and put back, it is hearted and un-hearted.
//         The first run leaves that one copy on the Playlist (no route
//         deletes a meal); later runs reuse it.
//   • A10/A11 make an upcoming plan when the account has no live one, and
//         compost it after A11.
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
  first: {
    id: string;
    title: string;
    displayTitle?: string | null;
    estimatedTimeMinutes: number;
    imageUrl?: string | null;
  }[];
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
      // BOOK-1C2 — the Save chip: "Save to My Meals" → "Saved to My Meals".
      const chip = footer!.querySelector<HTMLElement>('[aria-label$="to My Meals"]');
      out.push({
        title: metaIdx > 0 ? lines.slice(0, metaIdx).join(" ") : lines[0] ?? "",
        meta: metaIdx >= 0 ? lines[metaIdx] : "",
        minutes: metaIdx >= 0 ? Number(/^(\d+) min/.exec(lines[metaIdx])![1]) : null,
        saved: chip?.getAttribute("aria-label") === "Saved to My Meals",
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

test("QA-1 A — Cookbook (items 1–13) + BOOK-1C2 B1–B7", async ({ page }) => {
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
        imageUrl: m.imageUrl ?? null,
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
    // BOOK-1C2 — one disabled line, no named styles.
    const soon = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="cookbook-eating-styles"]');
      return {
        text: (el?.innerText ?? "").trim(),
        ariaDisabled: el?.getAttribute("aria-disabled") ?? null,
        focusable: el?.closest('[tabindex="0"]') != null,
      };
    });
    const namedStyles = ["Vegetarian", "Vegan", "Pescatarian"].filter((l) => sheetText.some((t) => t === l));
    const december = soon.text === "Eating styles: coming in December";
    await shot(page, LABEL, "A6-04-allergy-eating-styles", shots);
    await page.getByText(/^Your allergies/).click();
    await page.waitForURL(/\/preferences/, { timeout: 15_000 }).catch(() => undefined);
    const prefsUrl = new URL(page.url()).pathname;
    await settle(page, { timeoutMs: 20_000 });
    await shot(page, LABEL, "A6-05-profile", shots);

    const ok =
      n0 !== null && n1 !== n0 && n2 !== n1 && applied === n2 && pillsOk.length === 0 &&
      n3 === unfiltered && controls === 0 && prefsUrl.includes("preferences") &&
      !soon.focusable && soon.ariaDisabled === "true" && namedStyles.length === 0 && december;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `Show N: start ${n0} → +${cuisine} ${n1} → +Easy ${n2}; applied list ${applied} (${shown.length} cards rendered, ` +
        `cards missing ${cuisine}/Easy pill: ${pillsOk.length}); Clear all → ${n3} (unfiltered ${unfiltered}); ` +
        `allergy line "${allergy}", switch/checkbox controls in sheet ${controls}, tap → ${prefsUrl}; ` +
        `eating styles line ${JSON.stringify(soon)}, named styles shown ${JSON.stringify(namedStyles)}`,
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
    // BOOK-1C2 — the count above can be the previous query's, held and
    // dimmed while this one loads; scroll only once the list is this query's.
    await waitForText(page, (j) => j.includes(`${probe!.total} meals`), 30_000);
    await page
      .locator('[data-testid="cookbook-count-updating"]')
      .waitFor({ state: "detached", timeout: 30_000 })
      .catch(() => undefined);
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

  // ── 9 — the Save chip (BOOK-1C2: it replaced the heart) ──────────────────
  await ledger.run("A9", "Save chip: Save → Saved (dark) + toast ON TAP, ~4 s; detail shows Saved; un-save on detail clears the card; Saved chip lists it", async (shots) => {
    await gotoCookbook(page);
    const list = await cards(page);
    const idx = list.findIndex((c) => !c.saved);
    if (idx < 0) throw new Error("every visible card is already saved");
    const target = list[idx];
    const footer = page.locator('[aria-label="Add to a plan"]').nth(idx).locator("xpath=..");
    const chip = footer.locator('[aria-label="Save to My Meals"]');
    const box = await chip.boundingBox();
    const bgBefore = await chip.evaluate((el) => getComputedStyle(el.firstElementChild as HTMLElement).backgroundColor);
    // BOOK-1C2 item 5 — hold the POST 2 s: an on-tap toast is up before it answers.
    let favAnsweredAt = 0;
    await page.route("**/api/me/favorites", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue().catch(() => undefined);
      favAnsweredAt = Date.now();
    });
    const favReq = page.waitForRequest((r) => r.url().includes("/api/me/favorites") && r.method() !== "GET", { timeout: 15_000 });
    const tappedAt = Date.now();
    await chip.click();
    const req = await favReq;
    let mealId: string | null = null;
    try {
      mealId = (req.postDataJSON() as { mealId?: string })?.mealId ?? null;
    } catch {
      mealId = /favorites\/([^/?]+)/.exec(req.url())?.[1] ?? null;
    }
    const toast1 = await waitForText(page, (j) => j.includes("Saved to My Meals"), 8_000);
    const toastAt = Date.now();
    const savedChip = footer.locator('[aria-label="Saved to My Meals"]');
    const cardFilled = await savedChip.isVisible().catch(() => false);
    const chipState = await savedChip
      .evaluate((el) => ({
        // The last line: the icon glyph is a text node of its own (QA-1 trap).
        text: (((el as HTMLElement).innerText || "").split("\n").pop() ?? "").trim(),
        selected: el.getAttribute("aria-selected"),
        bg: getComputedStyle(el.firstElementChild as HTMLElement).backgroundColor,
      }))
      .catch(() => null);
    await shot(page, LABEL, "A9-01-card-saved", shots);
    // The toast's life: gone ~4 s after it showed.
    const gone = await waitForText(page, (j) => !j.includes("Saved to My Meals"), 8_000);
    const toastLifeMs = Date.now() - toastAt;
    await page.unroute("**/api/me/favorites");
    // On tap = seen well inside the 2 s hold, before the POST was even let through.
    const toastDelayMs = toastAt - tappedAt;
    const onTap = toast1.ok && toastDelayMs < 1500 && (favAnsweredAt === 0 || favAnsweredAt > toastAt);

    // Detail: Saved. Wait for the detail screen itself (its Cook Now), not the
    // URL. The toast is already gone (above), so a tap cannot land under it.
    await page.waitForTimeout(300);
    await footer.locator("xpath=preceding-sibling::*[1]").click();
    await page.getByRole("button", { name: "Cook Now" }).waitFor({ state: "visible", timeout: 30_000 });
    await settle(page, { timeoutMs: 30_000, minLines: 5 });
    const detailFilled = await page
      .getByRole("button", { name: "Saved to My Meals", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    await shot(page, LABEL, "A9-02-detail-saved", shots);
    // Un-save on detail.
    await page.getByRole("button", { name: "Saved to My Meals", exact: true }).click();
    const toast2 = await waitForText(page, (j) => j.includes("Removed from My Meals"), 8_000);
    await page.getByRole("button", { name: "Save to My Meals", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await shot(page, LABEL, "A9-03-detail-unsaved", shots);
    await tapButton(page, "Go back");
    await page.waitForURL(/\/cookbook/, { timeout: 15_000 });
    await settle(page, { timeoutMs: 20_000 });
    const after = (await cards(page)).find((c) => c.title === target.title);
    await shot(page, LABEL, "A9-04-card-after", shots);

    // Saved chip: save it again, look on Recipes → Saved, then undo.
    const footer2 = page.locator('[aria-label="Add to a plan"]').nth(
      (await cards(page)).findIndex((c) => c.title === target.title),
    ).locator("xpath=..");
    await footer2.locator('[aria-label="Save to My Meals"]').click();
    await footer2.locator('[aria-label="Saved to My Meals"]').waitFor({ state: "visible", timeout: 10_000 });
    await page.goto(`${WEB_ORIGIN}/meals`, { waitUntil: "domcontentloaded" });
    await waitForText(page, (j) => j.includes("My Meals"), 60_000);
    await clickText(page, "Saved");
    const savedList = await waitForText(page, (j) => j.includes(target.title), 20_000);
    await shot(page, LABEL, "A9-05-saved-chip", shots);
    // Leave the account as it was.
    if (mealId) await http.req("DELETE", `/me/favorites/${mealId}`);
    await clickText(page, "My Meals");

    const hitOk = !!box && box.width >= 44 && box.height >= 44;
    const faceOk =
      chipState?.text === "Saved" && chipState.selected === "true" && chipState.bg !== bgBefore;
    const lifeOk = gone.ok && toastLifeMs >= 3300 && toastLifeMs <= 4700;
    const ok =
      onTap && lifeOk && cardFilled && faceOk && hitOk && detailFilled && toast2.ok &&
      after?.saved === false && savedList.ok;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `"${target.title}" (${mealId}): chip hit area ${box ? `${Math.round(box.width)}×${Math.round(box.height)}` : "?"}; ` +
        `toast "Saved to My Meals" seen ${toastDelayMs} ms after the tap with the POST held 2 s (on tap: ${onTap}), on screen ~${toastLifeMs} ms; ` +
        `card chip ${JSON.stringify(chipState)} (was bg ${bgBefore}); detail Saved ${detailFilled}; ` +
        `detail un-save toast ${toast2.ok}, card after back saved=${after?.saved}; Saved chip lists it: ${savedList.ok}; un-saved again by API`,
    };
  });

  // BOOK-1C2 — A10/A11 need a live dated plan on the account. QA-1 leaned on
  // the THX fixture plans; when there are none, make an UPCOMING one (a month
  // out, so it never covers today and never becomes this week's plan) and
  // compost it after A11.
  let tempPlanId: string | null = null;
  {
    const t = todayYmd();
    const ymd = (days: number) => {
      const d = new Date(`${t}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      // POST /plans takes ISO datetimes (z.string().datetime()), midnight UTC.
      return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
    };
    const all = await http.allMyPlans(t);
    if (!all.some((p) => p.source === "instance" && (p.endDate ?? p.startDate) && (p.endDate ?? p.startDate) >= t)) {
      const r = await http.req<any>("POST", "/plans", { name: "QA 1C2 upcoming", startDate: ymd(30), endDate: ymd(34) });
      tempPlanId = r.body?.instance?.id ?? null;
      console.log(`[${LABEL}] no live plan on the account: made ${tempPlanId} (${r.status}) for A10/A11`);
    }
  }

  // ── 10 — + → live plans only → plan → day → lands on that day ────────────
  await ledger.run("A10", "+ lists active/upcoming plans and (BOOK-1C2) undated ones, never past; plan then day; the meal lands on that day", async (shots) => {
    await gotoCookbook(page);
    const first = (await cards(page))[0];
    await page.locator('[aria-label="Add to a plan"]').first().click();
    await waitForText(page, (j) => j.includes("Add to plan") && j.includes("Create a new plan"), 15_000);
    await settle(page, { timeoutMs: 15_000 });
    const sheetLines = await renderedText(page);
    await shot(page, LABEL, "A10-01-sheet", shots);

    const today = todayYmd();
    const all = await http.allMyPlans(today);
    const firstPage = await http.get<{ plans: any[]; nextCursor?: string | null }>(`/plans?filter=my_plans&localDate=${today}`);
    const isDatedLive = (p: any) => p.source === "instance" && (p.endDate ?? p.startDate) && (p.endDate ?? p.startDate) >= today;
    const isUndated = (p: any) => p.source === "instance" && !p.startDate && !p.endDate;
    // BOOK-1C2 — undated plans are offered too. The sheet reads page one of
    // my_plans (newest first), so an undated plan is expected only from there.
    const firstIds = new Set(firstPage.plans.map((p) => p.id));
    const live = all.filter((p) => isDatedLive(p) || (isUndated(p) && firstIds.has(p.id)));
    const notLive = all.filter((p) => !isDatedLive(p) && !isUndated(p));
    const nameOf = (p: any) => String(p.displayTitle ?? p.name);
    const liveShown = live.filter((p) => sheetLines.some((l) => l === nameOf(p)));
    const liveMissing = live.filter((p) => !liveShown.includes(p));
    const notLiveShown = notLive.filter((p) => sheetLines.some((l) => l === nameOf(p)) && !live.some((q) => nameOf(q) === nameOf(p)));
    const undatedShown = liveShown.filter(isUndated).length;

    // Pick a dated live plan that is not a THX fixture plan and whose name is
    // unique on the sheet (several undated plans can share "Untitled plan").
    const unique = (p: any) => liveShown.filter((q) => nameOf(q) === nameOf(p)).length === 1;
    const pick =
      liveShown.find((p) => isDatedLive(p) && unique(p) && !nameOf(p).startsWith("THX test")) ??
      liveShown.find((p) => isDatedLive(p) && unique(p)) ??
      liveShown.find(unique);
    if (!pick) throw new Error("no live plan shown in the sheet to add to");
    const beforeItems = (await http.get<any>(`/plans/${pick.id}`)).plan.items as any[];
    await page.locator('[tabindex="0"]').filter({ hasText: nameOf(pick) }).last().click();
    await waitForText(page, (j) => j.includes("Pick a day"), 10_000);
    const dayLines = (await renderedText(page)).filter((l) => /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day( · |$)/.test(l));
    await shot(page, LABEL, "A10-02-days", shots);
    // The last day: on a THX fixture plan (the only live plans on the test
    // account) that is Sunday, which holds no meal, and the item is deleted below.
    const dayLabel = dayLines[dayLines.length - 1];
    const day = dayLabel.split(" · ")[0];
    // The row carries a chevron glyph, so its text is not exactly the label.
    // BOOK-1C2 — the toast now shows ON TAP, before the add answers (~3 s: the
    // catalog meal is forked), so read the plan after the POST, not after the toast.
    const addDone = page.waitForResponse(
      (r) => r.url().includes(`/api/plans/${pick.id}/items`) && r.request().method() === "POST",
      { timeout: 60_000 },
    );
    await page.getByRole("button").filter({ hasText: dayLabel }).last().click();
    const toast = await waitForText(page, (j) => j.includes(`· ${day}`) && j.includes("Added to"), 15_000);
    await shot(page, LABEL, "A10-03-added", shots);
    const addStatus = (await addDone).status();
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
        `sheet shows ${liveShown.length} live (${undatedShown} undated) [${liveShown.map(nameOf).join(" / ")}], live missing ${liveMissing.length} [${liveMissing.map(nameOf).join(" / ")}], non-live shown ${notLiveShown.length}; ` +
        `days offered ${JSON.stringify(dayLines)}; added "${first.title}" to "${nameOf(pick)}" on ${day}: toast ${toast.ok}, POST ${addStatus}, ` +
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

  if (tempPlanId) {
    const del = await http.req("DELETE", `/plans/${tempPlanId}`);
    console.log(`[${LABEL}] composted the A10/A11 plan ${tempPlanId} → ${del.status}`);
  }

  // ── 12 — body opens; the Save chip and + don't ──────────────────────────
  await ledger.run("A12", "Card body opens the meal; the Save chip and + do not", async (shots) => {
    await gotoCookbook(page);
    const list = await cards(page);
    const idx = Math.max(0, list.findIndex((c) => !c.saved));
    const footer = page.locator('[aria-label="Add to a plan"]').nth(idx).locator("xpath=..");
    // The Save chip (then undone).
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
    await footer.locator('[aria-label="Saved to My Meals"]').click();
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
      evidence: `after Save chip URL ${afterHeart}; after + URL ${afterPlus} (sheet open ${sheetOpen}); after body tap URL ${afterBody}`,
    };
  });

  // ══ BOOK-1C2 — Hans's Pixel findings ═════════════════════════════════════

  // ── B1 — one sage on the Recipes page ────────────────────────────────────
  await ledger.run("B1", "Recipes page: Meals/Dishes switch, + Add Meal/Dish and Cook Now share the Cookbook card's sage; label contrast ≥ 4.5", async (shots) => {
    const rgb = (s: string | null) => (s ? (/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s)?.slice(1, 4).map(Number) ?? null) : null);
    const lum = ([r, g, b]: number[]) => {
      const c = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    /** bg + label colour of the first focusable whose text is exactly `label`. */
    const look = (label: string) =>
      page.evaluate((l) => {
        const el = Array.from(document.querySelectorAll<HTMLElement>('[tabindex="0"]')).find(
          (e) => (e.innerText || "").trim() === l,
        );
        if (!el) return null;
        const text = Array.from(el.querySelectorAll<HTMLElement>("*")).find((c) => (c.innerText || "").trim() === l) ?? el;
        return { bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(text).color };
      }, label);

    await page.goto(`${WEB_ORIGIN}/meals`, { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("recipes-cookbook-card");
    await card.waitFor({ state: "visible", timeout: 60_000 });
    await settle(page, { timeoutMs: 20_000 });
    const cardBg = await card.evaluate((e) => getComputedStyle(e).backgroundColor);
    const seen: Record<string, { bg: string; fg: string } | null> = {
      "Meals (active)": await look("Meals"),
      "+ Add Meal": await look("+ Add Meal"),
      "Cook Now (meal)": await look("Cook Now"),
    };
    await shot(page, LABEL, "B1-01-recipes-meals", shots);
    await clickText(page, "Dishes");
    await settle(page, { timeoutMs: 20_000 });
    seen["Dishes (active)"] = await look("Dishes");
    seen["+ Add Dish"] = await look("+ Add Dish");
    seen["Cook Now (dish)"] = await look("Cook Now");
    await shot(page, LABEL, "B1-02-recipes-dishes", shots);
    await clickText(page, "Meals");

    const want = rgb(cardBg);
    const rows = Object.entries(seen).map(([k, v]) => {
      const bg = rgb(v?.bg ?? null);
      const fg = rgb(v?.fg ?? null);
      return {
        k,
        bg: v?.bg ?? "(not on screen)",
        same: !!bg && !!want && bg.join() === want.join(),
        contrast: bg && fg ? Number(ratio(bg, fg).toFixed(2)) : null,
      };
    });
    const present = rows.filter((r) => r.bg !== "(not on screen)");
    const ok = !!want && present.length >= 4 && present.every((r) => r.same && (r.contrast ?? 0) >= 4.5);
    return {
      verdict: ok ? "pass" : "fail",
      evidence: `Cookbook card ${cardBg}; ${rows.map((r) => `${r.k}: ${r.bg}${r.same ? " =" : " ≠"} card, label ${r.contrast ?? "?"}:1`).join("; ")}`,
    };
  });

  // ── B3 — the filter race ─────────────────────────────────────────────────
  await ledger.run("B3", "Filters: a held response for the filters just left never shows as final; updating state on the count, the cards and the sheet's Show N", async (shots) => {
    await gotoCookbook(page);
    const base = await resultCount(page);
    const failed: string[] = [];
    const onFail = (r: import("@playwright/test").Request) => {
      if (r.url().includes("/api/cookbook/meals")) failed.push(`${new URL(r.url()).search} ${r.failure()?.errorText ?? ""}`);
    };
    page.on("requestfailed", onFail);
    const held: string[] = [];
    const hold = (pred: (u: URL) => boolean, ms: number) =>
      page.route("**/api/cookbook/meals?*", async (route) => {
        const u = new URL(route.request().url());
        if (pred(u)) {
          held.push(u.search);
          await new Promise((r) => setTimeout(r, ms));
        }
        await route.continue().catch(() => undefined);
      });
    const updatingNow = () =>
      page.evaluate(() => {
        const plus = document.querySelector<HTMLElement>('[aria-label="Add to a plan"]');
        const wrapper = plus?.parentElement?.parentElement?.parentElement ?? null;
        const countText = document.querySelector<HTMLElement>('[data-testid="cookbook-count"] > div');
        return {
          spinner: !!document.querySelector('[data-testid="cookbook-count-updating"]'),
          cardOpacity: wrapper ? getComputedStyle(wrapper).opacity : null,
          countOpacity: countText ? getComputedStyle(countText).opacity : null,
        };
      });

    // A = Easy (held 3 s); B = Easy + High protein, tapped while A is held.
    const isA = (u: URL) =>
      u.searchParams.get("difficulty") === "easy" && !u.searchParams.has("highProtein") && u.searchParams.get("limit") === "30" && !u.searchParams.has("cursor");
    await hold(isA, 3000);
    await clickText(page, "Easy");
    await page.waitForTimeout(500);
    const during = await updatingNow();
    const countDuring = await resultCount(page);
    await shot(page, LABEL, "B3-01-updating", shots);
    await clickText(page, "High protein");
    let after = await updatingNow();
    for (let i = 0; i < 60 && after.spinner; i++) {
      await page.waitForTimeout(250);
      after = await updatingNow();
    }
    const final = await resultCount(page);
    // A's held answer would land about now if it were still alive.
    const later: (number | null)[] = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(400);
      later.push(await resultCount(page));
    }
    await shot(page, LABEL, "B3-02-settled", shots);
    await page.unroute("**/api/cookbook/meals?*");
    const aTotal = (await http.get<{ total: number }>("/cookbook/meals?difficulty=easy&limit=1")).total;
    const bTotal = (await http.get<{ total: number }>("/cookbook/meals?difficulty=easy&highProtein=true&limit=1")).total;

    // The sheet: a held count for the new draft.
    await page.getByRole("button", { name: /^Filters/ }).click();
    const showRe = /^Show ([\d,]+) meals?$/;
    await waitForText(page, (j) => /Show [\d,]+ meals?/.test(j), 15_000);
    await hold((u) => u.searchParams.get("limit") === "1" && u.searchParams.get("maxActiveMinutes") === "15", 2500);
    await clickText(page, "≤ 15 min");
    await page.waitForTimeout(500);
    const sheetDuring = await page.evaluate(() => !!document.querySelector('[data-testid="cookbook-show-updating"]'));
    await shot(page, LABEL, "B3-03-sheet-updating", shots);
    let sheetBusy = sheetDuring;
    for (let i = 0; i < 60 && sheetBusy; i++) {
      await page.waitForTimeout(250);
      sheetBusy = await page.evaluate(() => !!document.querySelector('[data-testid="cookbook-show-updating"]'));
    }
    const showLine = (await renderedText(page)).find((l) => showRe.test(l)) ?? null;
    const showN = showLine ? Number(showRe.exec(showLine)![1].replace(/,/g, "")) : null;
    const cTotal = (await http.get<{ total: number }>("/cookbook/meals?difficulty=easy&highProtein=true&maxActiveMinutes=15&limit=1")).total;
    await shot(page, LABEL, "B3-04-sheet-settled", shots);
    await page.unroute("**/api/cookbook/meals?*");
    await tapButton(page, "Close");
    page.off("requestfailed", onFail);

    const ok =
      during.spinner && during.cardOpacity === "0.45" && during.countOpacity === "0.45" && countDuring === base &&
      !after.spinner && final === bTotal && later.every((n) => n === bTotal) &&
      sheetDuring && !sheetBusy && showN === cTotal;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `start ${base}; Easy held 3 s → while held: count shows ${countDuring} at opacity ${during.countOpacity}, spinner ${during.spinner}, cards opacity ${during.cardOpacity}; ` +
        `+High protein → settled ${final} (API easy+protein ${bTotal}; easy alone ${aTotal}), next 4 s ${JSON.stringify(later)}; ` +
        `held requests ${JSON.stringify(held)}; aborted/failed cookbook requests ${JSON.stringify(failed)}; ` +
        `sheet ≤15 hands-on held 2.5 s → spinner ${sheetDuring}, then "${showLine}" (API ${cTotal})`,
    };
  });

  // ── B4 — photos after a fast fling ───────────────────────────────────────
  await ledger.run("B4", "Photos: after a fast fling every on-screen card's photo loads in place (no scroll-away needed); a card with no photo has none in the API", async (shots) => {
    await gotoCookbook(page);
    await page.waitForTimeout(1500);
    const survey = () =>
      page.evaluate(() => {
        const vh = window.innerHeight;
        const out: { title: string; img: "none" | "loaded" | "pending" | "broken" }[] = [];
        for (const plus of Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Add to a plan"]'))) {
          const card = plus.parentElement?.parentElement;
          if (!card) continue;
          const r = card.getBoundingClientRect();
          if (r.bottom < 0 || r.top > vh) continue;
          const img = card.querySelector("img");
          let state: "none" | "loaded" | "pending" | "broken" = "none";
          if (img) state = img.complete ? (img.naturalWidth > 0 ? "loaded" : "broken") : "pending";
          out.push({ title: (card.innerText || "").split("\n")[0], img: state });
        }
        return out;
      });
    await page.mouse.move(187, 500);
    const passes: { right: string; settled: string }[] = [];
    const bad: string[] = [];
    for (let pass = 1; pass <= 3; pass++) {
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(150);
      const right = await survey();
      await page.waitForTimeout(6000);
      const settled = await survey();
      passes.push({
        right: right.map((c) => c.img).join(","),
        settled: settled.map((c) => c.img).join(","),
      });
      for (const c of settled) {
        if (c.img === "pending" || c.img === "broken") bad.push(`${c.title}: ${c.img}`);
        if (c.img === "none") {
          const api = calls.flatMap((x) => x.first).find((m) => (m.displayTitle ?? m.title) === c.title || m.title === c.title);
          if (!api || api.imageUrl) bad.push(`${c.title}: no photo on the card, API imageUrl ${api ? api.imageUrl : "(not found)"}`);
        }
      }
      await shot(page, LABEL, `B4-0${pass}-after-fling`, shots);
    }
    return {
      verdict: bad.length === 0 ? "pass" : "fail",
      evidence: `three flings (12 × 1600 px wheel each): on-screen photo states right after → 6 s later ${passes.map((p) => `[${p.right}] → [${p.settled}]`).join("; ")}; problems ${JSON.stringify(bad)}`,
    };
  });

  // ── B6 — a plan made from the + flow is in the next + ────────────────────
  await ledger.run("B6", "+ → Create a new plan; the next + lists that plan (undated, 'No dates yet') with a 7-weekday day step", async (shots) => {
    await gotoCookbook(page);
    await page.locator('[aria-label="Add to a plan"]').first().click();
    await waitForText(page, (j) => j.includes("Create a new plan") && j.includes("Pick an existing plan"), 15_000);
    await clickText(page, /Start a new plan with this meal/);
    await page.waitForURL(/\/plan\/[^/?]+/, { timeout: 30_000 });
    const planId = /\/plan\/([^/?]+)/.exec(page.url())![1];
    const created = (await http.get<any>(`/plans/${planId}`)).plan;
    const name = `QA 1C2 ${Date.now().toString(36)}`;
    const renamed = await http.req("PATCH", `/plans/${planId}`, { name });
    await shot(page, LABEL, "B6-01-new-plan", shots);
    try {
      await gotoCookbook(page);
      await page.locator('[aria-label="Add to a plan"]').first().click();
      const listed = await waitForText(page, (j) => j.includes(name), 20_000);
      const noDates = listed.text.includes("No dates yet");
      await shot(page, LABEL, "B6-02-next-plus", shots);
      let weekdays: string[] = [];
      if (listed.ok) {
        await page.locator('[tabindex="0"]').filter({ hasText: name }).last().click();
        await waitForText(page, (j) => j.includes("Pick a day"), 10_000);
        weekdays = (await renderedText(page)).filter((l) => /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day$/.test(l));
        await shot(page, LABEL, "B6-03-weekdays", shots);
      }
      await tapButton(page, "Close");
      const ok = listed.ok && noDates && weekdays.length === 7 && renamed.status === 200;
      return {
        verdict: ok ? "pass" : "fail",
        evidence:
          `created ${planId}: status ${created?.status}, startDate ${created?.startDate ?? null}, endDate ${created?.endDate ?? null}; ` +
          `renamed "${name}" (${renamed.status}); next + lists it: ${listed.ok}, "No dates yet" ${noDates}; day step ${JSON.stringify(weekdays)}`,
      };
    } finally {
      // Leave the account as it was: compost the plan this item made.
      const del = await http.req("DELETE", `/plans/${planId}`);
      console.log(`[${LABEL}] B6 composted ${planId} → ${del.status}`);
    }
  });

  // ── B7 — BUG-416 + BUG-417 on meal detail ────────────────────────────────
  //
  // Both run on the test user's own COPY of a catalog meal. The copy comes
  // from POST /me/playlist (fork-on-acquire, idempotent by lineage): a meal
  // already on the Playlist is reused, else the first unsaved card is added
  // and LEFT on the Playlist so the next run reuses it instead of forking
  // again (there is no route that deletes a meal).
  //   BUG-416 — the copy's tags gain system tags for the item, then are put
  //             back exactly as they were;
  //   BUG-417 — the copy is hearted, the CATALOG meal's detail must read
  //             Saved; the heart is removed again.
  await ledger.run("B7", "Detail: no system tag chips (BUG-416); a meal saved only through the user's copy reads Saved on detail and on its card (BUG-417)", async (shots) => {
    const SYSTEM = /^(thanksgiving(-.+)?|course-.+|dev)$/i;
    let target: any = null;
    let fallback: any = null;
    let cursor: string | null = null;
    for (let i = 0; i < 30 && !target; i++) {
      const r: { meals: any[]; nextCursor: string | null } = await http.get(
        `/cookbook/meals?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      target = r.meals.find((m) => m.isInPlaylist && !m.isSaved) ?? null;
      fallback ??= r.meals.find((m) => !m.isSaved && !m.isInPlaylist) ?? null;
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    target ??= fallback;
    if (!target) throw new Error("no unsaved catalog meal to copy");
    const pl = await http.req<any>("POST", "/me/playlist", { mealId: target.id });
    const copyId: string | undefined = pl.body?.playlistMeal?.mealId;
    const forked = !!pl.body?.playlistMeal?.forked;
    if (!copyId || copyId === target.id) throw new Error(`POST /me/playlist gave no copy: ${pl.status} ${JSON.stringify(pl.body).slice(0, 200)}`);
    const openDetail = async (id: string) => {
      await page.goto(`${WEB_ORIGIN}/meal/${id}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Cook Now" }).waitFor({ state: "visible", timeout: 30_000 });
      await settle(page, { timeoutMs: 20_000, minLines: 5 });
    };

    // BUG-416.
    const orig = ((await http.get<any>(`/meals/${copyId}`)).tags ?? []) as string[];
    const human = orig.find((t) => !SYSTEM.test(t)) ?? null;
    const withSystem = [...orig.filter((t) => !SYSTEM.test(t)).slice(0, 7), "thanksgiving", "thanksgiving-alternate", "course-turkey"];
    let tagsPart = "";
    let tagsOk = false;
    const patched = await http.req("PATCH", `/me/meals/${copyId}`, { tags: withSystem });
    try {
      await openDetail(copyId);
      const lines = (await renderedText(page)).map((l) => l.trim());
      const shownSystem = lines.filter((l) => SYSTEM.test(l));
      const humanShown = human ? lines.includes(human) : null;
      await shot(page, LABEL, "B7-01-detail-tags", shots);
      tagsOk = patched.status === 200 && shownSystem.length === 0 && humanShown !== false;
      tagsPart = `copy tags set to ${JSON.stringify(withSystem)} (${patched.status}) → system tags on screen ${JSON.stringify(shownSystem)}, a person's tag "${human}" shown ${humanShown}`;
    } finally {
      const back = await http.req("PATCH", `/me/meals/${copyId}`, { tags: orig });
      tagsPart += `; tags restored ${JSON.stringify(orig)} (${back.status})`;
    }

    // BUG-417.
    let lineagePart = "";
    let lineageOk = false;
    await http.req("POST", "/me/favorites", { mealId: copyId });
    try {
      const fav = await http.get<{ favorites: string[]; savedViaCopy?: string[] }>("/me/favorites");
      await openDetail(target.id);
      const detailSaved = await page
        .getByRole("button", { name: "Saved to My Meals", exact: true })
        .isVisible()
        .catch(() => false);
      await shot(page, LABEL, "B7-02-detail-saved-via-copy", shots);
      const card = await http.get<{ meals: any[] }>(`/cookbook/meals?q=${encodeURIComponent(String(target.title).slice(0, 40))}&limit=50`);
      const cardSaved = card.meals.find((m) => m.id === target.id)?.isSaved ?? null;
      const viaCopy = (fav.savedViaCopy ?? []).includes(target.id);
      lineageOk = detailSaved && cardSaved === true && viaCopy;
      lineagePart =
        `"${target.title}" (copy ${copyId}${forked ? ", forked by this run and left on the Playlist" : ", reused"}): ` +
        `GET /me/favorites savedViaCopy has it ${viaCopy}; catalog detail chip Saved ${detailSaved}; card isSaved ${cardSaved}`;
    } finally {
      await http.req("DELETE", `/me/favorites/${copyId}`);
    }
    return {
      verdict: tagsOk && lineageOk ? "pass" : "fail",
      evidence: `BUG-416: ${tagsPart}. BUG-417: ${lineagePart}; heart removed again`,
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
