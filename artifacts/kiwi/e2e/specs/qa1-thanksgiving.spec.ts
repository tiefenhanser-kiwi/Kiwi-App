// ─────────────────────────────────────────────────────────────────────────────
// QA-1 B — Thanksgiving prep (PREP-1), items 14–22 of Hans's device script, on
// the three "THX test · …" weeks that scripts/_scratch/prep-1/seedThxWeeks.ts
// puts on the test account. OPT-IN: runs only with KIWI_E2E_QA1=1, and skips
// when the fixture is not seeded.
//
//   KIWI_E2E_QA1=1 KIWI_E2E_RUN_ID=qa1 pnpm exec playwright test -c e2e/playwright.config.ts qa1-thanksgiving
//
// SPENDS: Prep the feast and Prep the Week narrations (Sonnet), each about
// $0.05 — Classic feast, Classic week before and after the Monday swap, the
// Vegetarian week and feast, and the ordinary plan's week when it has no cache.
// Measured from LLMCallLog per surface (src/spend.ts) and written beside the
// verdicts.
//
// Writes: item 15 sets the feast's servings to 8 and back to 10; item 17 ticks
// one feast step and swaps Classic's Monday meal (the fixture's --revert deletes
// the plans, so neither outlives the run); item 20 ticks one Vegetarian week
// step.
// ─────────────────────────────────────────────────────────────────────────────
import { expect, test, type Page, type Response } from "@playwright/test";

import { WEB_ORIGIN, ensureRunDir } from "../src/env";
import { signInThroughUi, tapButton } from "../src/screen";
import { measured, type SurfaceSpend } from "../src/spend";
import { preflight, teardown, type Preflight } from "../src/stack";
import { Http, Ledger, renderedText, settle, shot, todayYmd, waitForText } from "./qa1-shared";

const LABEL = "qa1-thanksgiving";
const ledger = new Ledger(LABEL);
const spend: SurfaceSpend[] = [];
const timings: Record<string, number> = {};
let pf: Preflight | null = null;

test.skip(process.env.KIWI_E2E_QA1 !== "1", "QA-1 is opt-in — set KIWI_E2E_QA1=1");

test.beforeAll(async () => {
  ensureRunDir();
  pf = await preflight();
  for (const c of pf.checks) console.log(`[preflight] ${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.note}`);
  expect(pf.ok, "preflight failed").toBe(true);
});

test.afterAll(async () => {
  const total = spend.reduce((n, s) => n + s.costUsd, 0);
  console.log(`[${LABEL}] AI spend $${total.toFixed(4)} over ${spend.length} surface(s)`);
  console.log(`→ ${ledger.write({ spend, spendTotalUsd: Number(total.toFixed(6)), timings })}`);
  if (pf) teardown(pf);
});

// ── the wire ─────────────────────────────────────────────────────────────────

interface Step {
  stepKey: string;
  title: string;
  instructions: string;
  contributesToMealIds: string[];
  storageNote?: string | null;
}
interface Phase {
  phase: string;
  title?: string;
  steps: Step[];
  heldForCookDay?: string[];
}
interface PrepEnvelope {
  cacheHit: boolean;
  session?: "feast";
  sessionDay?: string;
  result: { phases: Phase[] };
}

const allSteps = (e: PrepEnvelope): Step[] => e.result.phases.flatMap((p) => p.steps);

const DAY_SHORT: Record<string, string> = {
  Sunday: "Sun", Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string | null) => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : null;
};

/** One line per makeAhead row, as data: "Fri Nov 20 · thaw · Roast Turkey (thaw 6d)". */
function describeRows(m: any): string[] {
  return (m?.rows ?? []).map((r: any) => {
    const extra =
      r.kind === "make" && r.keepsDays !== undefined ? ` (keeps ${r.keepsDays})`
      : r.kind === "thaw" && r.thawDays !== undefined ? ` (thaw ${r.thawDays}d)`
      : r.kind === "brine" && r.brineHours ? ` (${r.brineHours.min === r.brineHours.max ? r.brineHours.min : `${r.brineHours.min}–${r.brineHours.max}`} h)`
      : "";
    return `${DAY_SHORT[r.dayName] ?? r.dayName}${r.kind === "brine" ? " night" : ""} ${shortDate(r.date) ?? ""} · ${r.kind} · ${r.dishName}${extra}`;
  });
}

/** The day group labels the client builds (makeAheadModel.buildMakeAheadCard). */
function expectedGroups(m: any): { label: string; dishes: string[] }[] {
  const out: { key: string; label: string; dishes: string[] }[] = [];
  for (const r of m?.rows ?? []) {
    const night = r.kind === "brine";
    const key = `${r.date ?? r.dayName}${night ? "-night" : ""}`;
    let g = out.find((x) => x.key === key);
    if (!g) {
      const d = shortDate(r.date);
      g = { key, label: `${r.dayName}${night ? " night" : ""}${d ? ` · ${d}` : ""}`, dishes: [] };
      out.push(g);
    }
    g.dishes.push(r.dishName);
  }
  return out;
}

// ── the screens ──────────────────────────────────────────────────────────────

async function gotoHub(page: Page, planId: string): Promise<string[]> {
  await page.goto(`${WEB_ORIGIN}/prep-cook?id=${planId}`, { waitUntil: "domcontentloaded" });
  await waitForText(page, (j) => j.includes("Cook a meal"), 60_000);
  return settle(page, { timeoutMs: 30_000, minLines: 5 });
}

/** The text between the card's title and its button. */
function cardSlice(text: string[]): string[] {
  const a = text.indexOf("Thanksgiving make-ahead");
  if (a < 0) return [];
  const b = text.indexOf("Prep the feast", a);
  return text.slice(a, b < 0 ? a + 40 : b + 1);
}

function isPrepWeekResponse(r: Response, planId: string): boolean {
  return r.request().method() === "POST" && r.url().includes(`/api/plans/${planId}/prep-week`) && !r.url().includes("completions");
}

/**
 * Open a prep session by URL and wait for its POST to answer and the screen to
 * show a phase. Returns the envelope the screen rendered, and the wall time from
 * navigation to a rendered phase.
 */
async function openPrep(
  page: Page,
  planId: string,
  session: "feast" | null,
): Promise<{ env: PrepEnvelope | null; status: number; ms: number; respMs: number; text: string[] }> {
  const q = new URLSearchParams({ mode: "prep-week", planId });
  if (session) q.set("session", session);
  const t0 = Date.now();
  const respP = page.waitForResponse((r) => isPrepWeekResponse(r, planId), { timeout: 240_000 });
  await page.goto(`${WEB_ORIGIN}/cook-session?${q}`, { waitUntil: "domcontentloaded" });
  const resp = await respP;
  const respMs = Date.now() - t0;
  let env: PrepEnvelope | null = null;
  try {
    env = (await resp.json()) as PrepEnvelope;
  } catch {
    /* non-JSON */
  }
  // ⚠️ ON innerText, NOT THE TEXT-NODE LIST. "Phase {n} of {total}" is JSX with
  // four children, so the DOM holds "Phase ", "1", " of ", "4" as separate runs
  // and no single entry of renderedText() ever matches — the first version of
  // this wait ran out its whole 60 s on every open and reported that as latency.
  await page
    .waitForFunction(() => /Phase \d+ of \d+/.test(document.body.innerText || ""), undefined, { timeout: 60_000 })
    .catch(() => undefined);
  const ms = Date.now() - t0;
  const text = await settle(page, { timeoutMs: 20_000, minLines: 5 });
  return { env, status: resp.status(), ms, respMs, text };
}

/** Measure a prep open against the ledger. */
async function measuredPrep(
  userId: string,
  surface: string,
  page: Page,
  planId: string,
  session: "feast" | null,
) {
  const r = await measured(userId, surface, () => openPrep(page, planId, session));
  spend.push(r.spend);
  timings[surface] = r.value.ms;
  timings[`${surface} (server answered)`] = r.value.respMs;
  return r.value;
}

/** Any step checkbox on the current phase (the label is an aria-label, not text). */
const hasStepCheckbox = (page: Page) =>
  page.evaluate(() => document.querySelectorAll('[aria-label="Mark step done"], [aria-label="Mark step not done"]').length > 0);

/** Walk the phases forward ("Skip this Prep" is write-free) until `pred` holds. */
async function findPhase(
  page: Page,
  pred: (joined: string) => boolean | Promise<boolean>,
  maxPhases = 6,
): Promise<boolean> {
  for (let i = 0; i < maxPhases; i++) {
    const t = await renderedText(page);
    if (await pred(t.join("\n"))) return true;
    if (!t.includes("Skip this Prep")) return false;
    await tapButton(page, "Skip this Prep");
    await page.waitForTimeout(600);
  }
  return pred((await renderedText(page)).join("\n"));
}

/**
 * Tag the checkbox of the step card whose header contains `title`; returns its
 * state. Read from the LABEL ("Mark step not done" once done): react-native-web
 * does not reliably emit aria-checked from accessibilityState here, and the
 * first version read every box as unchecked, including one the screenshot shows
 * ticked.
 */
async function stepCheckbox(page: Page, title: string): Promise<"checked" | "unchecked" | null> {
  return page.evaluate((t) => {
    for (const cb of Array.from(document.querySelectorAll<HTMLElement>('[role="checkbox"]'))) {
      const header = cb.parentElement;
      if (header && (header.innerText || "").includes(t)) {
        cb.setAttribute("data-qa", "target-step");
        return cb.getAttribute("aria-label") === "Mark step not done" ? "checked" : "unchecked";
      }
    }
    return null;
  }, title);
}

test("QA-1 B — Thanksgiving prep (items 14–22)", async ({ page }) => {
  // Nine items and up to seven narrations in one test.
  test.setTimeout(45 * 60_000);
  await signInThroughUi(page);
  // Watched from here: the sign-in screen's Google button logs a 403 at this
  // origin (localhost is not an allowed origin for the GSI client id), which is
  // the harness's address, not the screens under test.
  ledger.watch(page);
  const { http, userId } = await Http.login();

  const plans = await http.allMyPlans(todayYmd());
  const byName = (n: string) => plans.find((p) => String(p.name) === `THX test · ${n}` || String(p.displayTitle) === `THX test · ${n}`);
  const classic = byName("Classic");
  const makeAhead = byName("Make-Ahead");
  const veg = byName("Vegetarian");
  test.skip(!classic || !makeAhead || !veg, "the THX test fixture is not seeded on this account");

  const planOf = async (id: string) => (await http.get<any>(`/plans/${id}`)).plan;
  const classicPlan = await planOf(classic.id);
  const feastMealId: string = classicPlan.makeAhead?.feastMealId;
  const feastItem = classicPlan.items.find((i: any) => i.mealId === feastMealId);

  // ── 14 — the Hub card, against makeAhead ─────────────────────────────────
  await ledger.run("B14", 'Hub shows "Thanksgiving make-ahead" for Thu Nov 26; rows vs GET /plans/:id makeAhead', async (shots) => {
    const text = await gotoHub(page, classic.id);
    const slice = cardSlice(text);
    await shot(page, LABEL, "B14-01-hub-classic", shots);
    const m = classicPlan.makeAhead;
    const groups = expectedGroups(m);
    const missing: string[] = [];
    for (const g of groups) {
      if (!slice.includes(g.label)) missing.push(`group "${g.label}"`);
      for (const d of g.dishes) if (!slice.includes(d)) missing.push(`dish "${d}"`);
    }
    const feastLine = slice.find((l) => l.startsWith("Thanksgiving is")) ?? "(none)";
    const ok = !!m && slice.length > 0 && missing.length === 0 && feastLine === "Thanksgiving is Thursday, Nov 26.";
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `renders: ${JSON.stringify(slice)}; makeAhead rows: ${JSON.stringify(describeRows(m))}; ` +
        `render-vs-API gaps: ${missing.length ? missing.join(", ") : "none"}`,
      api: m,
    };
  });

  // ── 15 — a row opens the feast at 10; set 8; back to 10 ──────────────────
  await ledger.run("B15", "A row opens the feast in plan context at 10 servings; 8 through the stepper shows 8; restore 10", async (shots) => {
    const servingsOnScreen = async () => {
      const t = await renderedText(page);
      // The stepper's glyphs are text runs too: the value is the first number after the label.
      const i = t.indexOf("Adjust for");
      const v = i >= 0 ? t.slice(i + 1, i + 6).find((l) => /^\d+$/.test(l)) : undefined;
      return v === undefined ? null : Number(v);
    };
    const tagStepper = () =>
      page.evaluate(() => {
        const label = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
          (d) => (d.innerText || "").trim() === "Adjust for" && d.children.length === 0,
        );
        const btns = label?.parentElement?.querySelectorAll<HTMLElement>('[tabindex="0"]') ?? [];
        btns[0]?.setAttribute("data-qa", "servings-minus");
        btns[1]?.setAttribute("data-qa", "servings-plus");
        return btns.length;
      });
    const openRow = async () => {
      await gotoHub(page, classic.id);
      await page.getByRole("link", { name: /Open the recipe\.$/ }).first().click();
      await page.waitForURL(/\/meal\//, { timeout: 20_000 });
      await waitForText(page, (j) => j.includes("Adjust for"), 60_000);
      await settle(page, { timeoutMs: 20_000, minLines: 5 });
    };
    const save = async (expect: number) => {
      const patch = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/items/`), { timeout: 20_000 });
      await tapButton(page, "Save changes");
      const r = await patch;
      await page.waitForTimeout(800);
      const item = (await planOf(classic.id)).items.find((i: any) => i.id === feastItem.id);
      return { status: r.status(), override: item?.servingsOverride ?? null, ok: item?.servingsOverride === expect };
    };

    await openRow();
    const url = new URL(page.url());
    const ctx = `${url.pathname}?planId=${url.searchParams.get("planId") === classic.id ? "✓" : "✗"}&planItemId=${url.searchParams.get("planItemId") === feastItem?.id ? "✓" : "✗"}`;
    const opened = await servingsOnScreen();
    await shot(page, LABEL, "B15-01-feast-at-open", shots);
    if ((await tagStepper()) < 2) throw new Error("servings stepper not found");
    await page.locator('[data-qa="servings-minus"]').click();
    await page.locator('[data-qa="servings-minus"]').click();
    const stepped = await servingsOnScreen();
    const s8 = await save(8);
    await shot(page, LABEL, "B15-02-saved-8", shots);
    await openRow();
    const reopened = await servingsOnScreen();
    await shot(page, LABEL, "B15-03-row-reopened", shots);
    await tagStepper();
    await page.locator('[data-qa="servings-plus"]').click();
    await page.locator('[data-qa="servings-plus"]').click();
    const s10 = await save(10);
    const restored = await servingsOnScreen();
    await shot(page, LABEL, "B15-04-restored-10", shots);
    const ok =
      url.pathname === `/meal/${feastMealId}` && ctx.endsWith("planId=✓&planItemId=✓") && opened === 10 &&
      stepped === 8 && s8.ok && reopened === 8 && s10.ok && restored === 10;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `row → ${ctx} (feast meal ${url.pathname === `/meal/${feastMealId}` ? "✓" : "✗"}); servings at open ${opened}; ` +
        `stepper → ${stepped}, Save PATCH ${s8.status}, API override ${s8.override}; row reopened shows ${reopened}; ` +
        `restore PATCH ${s10.status}, API override ${s10.override}, screen ${restored}`,
    };
  });

  // ── 16 — Prep the feast: title, Wednesday line, feast-only, no cook-day ──
  let feastEnv: PrepEnvelope | null = null;
  await ledger.run("B16", "Prep the feast: title + Wednesday line, only feast food, no 'leave it for cook day'; first vs cached open", async (shots) => {
    await gotoHub(page, classic.id);
    await shot(page, LABEL, "B16-00-hub-before", shots);
    const first = await measuredPrep(userId, "classic-feast-first", page, classic.id, "feast");
    feastEnv = first.env;
    await shot(page, LABEL, "B16-01-feast-first", shots);
    const second = await measuredPrep(userId, "classic-feast-second", page, classic.id, "feast");
    await shot(page, LABEL, "B16-02-feast-cached", shots);
    const env = first.env;
    if (!env) throw new Error(`prep-week (feast) answered ${first.status} with no JSON`);
    const steps = allSteps(env);
    const foreign = steps.filter((s) => s.contributesToMealIds.some((id) => id !== feastMealId));
    const wire = JSON.stringify(env.result);
    const cookDayWire = /leave it for cook day/i.test(wire);
    const cookDayScreen = first.text.some((l) => /leave it for cook day/i.test(l));
    const title = first.text.includes("Prep the feast");
    const notice = first.text.find((l) => /^For \w+, the day before the feast\.$/.test(l)) ?? null;
    const ok =
      first.status === 200 && title && notice === "For Wednesday, the day before the feast." &&
      env.session === "feast" && foreign.length === 0 && !cookDayWire && !cookDayScreen && second.env?.cacheHit === true;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `status ${first.status}, session ${env.session}, sessionDay ${env.sessionDay}; title "Prep the feast" ${title}; notice "${notice}"; ` +
        `${steps.length} steps over ${env.result.phases.length} phases, steps feeding a non-feast meal ${foreign.length}` +
        (foreign.length ? ` [${foreign.map((s) => s.title).join(" / ")}]` : "") +
        `; "leave it for cook day" on wire ${cookDayWire}, on screen ${cookDayScreen}; ` +
        `first open ${(first.ms / 1000).toFixed(1)}s to a rendered phase, server ${(first.respMs / 1000).toFixed(1)}s (cacheHit ${first.env?.cacheHit}); ` +
        `second ${(second.ms / 1000).toFixed(1)}s, server ${(second.respMs / 1000).toFixed(1)}s (cacheHit ${second.env?.cacheHit})`,
    };
  });

  // ── 17 — a feast tick survives a week regeneration ───────────────────────
  let weekBefore: PrepEnvelope | null = null;
  let weekAfter: PrepEnvelope | null = null;
  let weekAfterText: string[] = [];
  await ledger.run("B17", "Tick a feast step; swap Monday so the week regenerates; the tick survives", async (shots) => {
    await openPrep(page, classic.id, "feast");
    const found = await findPhase(page, () => hasStepCheckbox(page));
    if (!found) throw new Error("no tickable step in Prep the feast");
    const putP = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes("/prep-week/completions"), { timeout: 15_000 });
    await page.getByRole("checkbox", { name: "Mark step done" }).first().click();
    const put = await putP;
    const stepKey = (put.postDataJSON() as { stepKey: string }).stepKey;
    const step = feastEnv ? allSteps(feastEnv).find((s) => s.stepKey === stepKey) : undefined;
    await page.waitForTimeout(800);
    await shot(page, LABEL, "B17-01-feast-ticked", shots);

    // The week, before the swap.
    const before = await measuredPrep(userId, "classic-week-before-swap", page, classic.id, null);
    weekBefore = before.env;
    await shot(page, LABEL, "B17-02-week-before-swap", shots);

    // Swap Monday — the PATCH the app's swap sheet sends ({ mealId }).
    const plan = await planOf(classic.id);
    const monday = plan.items.find((i: any) => i.assignedDayOfWeek === "Monday");
    const inPlan = new Set(plan.items.map((i: any) => i.mealId));
    const cand = (await http.get<any>(`/cookbook/meals?q=chicken&limit=10`)).meals.find((m: any) => !inPlan.has(m.id));
    const swap = await http.req("PATCH", `/plans/${classic.id}/items/${monday.id}`, { mealId: cand.id });

    const after = await measuredPrep(userId, "classic-week-after-swap", page, classic.id, null);
    weekAfter = after.env;
    weekAfterText = after.text;
    await shot(page, LABEL, "B17-03-week-after-swap", shots);

    const comps = await http.get<any>(`/plans/${classic.id}/prep-week/completions`);
    const kept = comps.completions.some((c: any) => c.stepKey === stepKey);
    const feastAgain = await measuredPrep(userId, "classic-feast-after-swap", page, classic.id, "feast");
    let screenState: string | null = null;
    if (step) {
      await findPhase(page, (j) => j.includes(step.title));
      screenState = await stepCheckbox(page, step.title);
    }
    await shot(page, LABEL, "B17-04-feast-after-swap", shots);
    const ok = swap.status < 300 && after.env?.cacheHit === false && kept && screenState === "checked";
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `ticked ${stepKey} ("${step?.title ?? "?"}"); swap Monday "${monday.meal?.title ?? monday.mealId}" → "${cand.title}" PATCH ${swap.status}; ` +
        `week before cacheHit ${before.env?.cacheHit}, after swap cacheHit ${after.env?.cacheHit} (regenerated: ${after.env?.cacheHit === false}); ` +
        `completions still hold the key: ${kept}; feast reopened (cacheHit ${feastAgain.env?.cacheHit}) shows the step ${screenState ?? "not found"}`,
      api: { completions: comps.completions },
    };
  });

  // ── 18 — Prep the Week with a feast ──────────────────────────────────────
  await ledger.run("B18", "Prep the Week: the feast line; covers Mon, Tue, Wed, Fri only; the feast row has no Prep This Meal tick", async (shots) => {
    const plan = await planOf(classic.id);
    const dayOf = new Map<string, string>(plan.items.map((i: any) => [i.mealId, i.assignedDayOfWeek]));
    const days = (e: PrepEnvelope | null) =>
      e ? [...new Set(allSteps(e).flatMap((s) => s.contributesToMealIds.map((id) => DAY_SHORT[dayOf.get(id) ?? ""] ?? `?${id.slice(0, 8)}`)))].sort() : [];
    const feastIn = (e: PrepEnvelope | null) => (e ? allSteps(e).filter((s) => s.contributesToMealIds.includes(feastMealId)).length : -1);
    const line = weekAfterText.includes("The feast has its own prep. See Thanksgiving make-ahead.");
    const title = weekAfterText.includes("Prep the Week");
    await gotoHub(page, classic.id);
    const feastTitle = plan.items.find((i: any) => i.mealId === feastMealId)?.meal?.title as string;
    const ticks = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="checkbox"]')).map((e) => e.getAttribute("aria-label") ?? ""),
    );
    const feastTick = ticks.some((l) => feastTitle && l.includes(feastTitle));
    const otherTicks = ticks.filter((l) => /to the prep selection$/.test(l)).length;
    await shot(page, LABEL, "B18-01-hub-ticks", shots);
    const allowed = new Set(["Mon", "Tue", "Wed", "Fri"]);
    const dAfter = days(weekAfter);
    const ok = line && title && feastIn(weekAfter) === 0 && dAfter.every((d) => allowed.has(d)) && !feastTick && otherTicks === plan.items.length - 1;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `week screen title ${title}, feast line ${line}; days fed: before swap ${JSON.stringify(days(weekBefore))}, after ${JSON.stringify(dAfter)}; ` +
        `steps feeding the feast ${feastIn(weekAfter)}; Hub Prep-This-Meal ticks ${otherTicks} for ${plan.items.length} meals, one on the feast "${feastTitle}": ${feastTick}`,
    };
  });

  // ── 19 — Make-Ahead week ─────────────────────────────────────────────────
  await ledger.run("B19", "Make-Ahead: Tuesday-night brine (48 h); gravy + cranberry Monday; pie Tuesday", async (shots) => {
    const m = (await planOf(makeAhead.id)).makeAhead;
    const text = await gotoHub(page, makeAhead.id);
    const slice = cardSlice(text);
    await shot(page, LABEL, "B19-01-hub-make-ahead", shots);
    const rows: any[] = m?.rows ?? [];
    const brine = rows.find((r) => r.kind === "brine");
    const on = (re: RegExp, day: string) => rows.some((r) => r.kind === "make" && re.test(r.dishName) && r.dayName === day);
    const brineOk = brine?.dayName === "Tuesday" && brine?.brineHours?.min === 48 && brine?.brineHours?.max === 48;
    const ok = brineOk && on(/gravy/i, "Monday") && on(/cranberr/i, "Monday") && on(/pie/i, "Tuesday") &&
      slice.some((l) => l.startsWith("Tuesday night")) && slice.some((l) => /48 h/.test(l));
    return {
      verdict: ok ? "pass" : "fail",
      evidence: `makeAhead rows ${JSON.stringify(describeRows(m))}; renders ${JSON.stringify(slice)}`,
      api: m,
    };
  });

  // ── 20 — Vegetarian week ─────────────────────────────────────────────────
  await ledger.run("B20", "Vegetarian: no thaw/brine rows; ticking the week's onion leaves the feast's onion unticked", async (shots) => {
    const vplan = await planOf(veg.id);
    const m = vplan.makeAhead;
    const text = await gotoHub(page, veg.id);
    await shot(page, LABEL, "B20-01-hub-veg", shots);
    const kinds = (m?.rows ?? []).map((r: any) => r.kind);
    const noMeat = !kinds.includes("thaw") && !kinds.includes("brine");

    const week = await measuredPrep(userId, "veg-week", page, veg.id, null);
    // The onion the week and the feast SHARE: one food identity, two keys (the
    // feast's under `feast#`). The structure route is free and names both; a
    // week onion that only the week has (the burgers' white onion) would prove
    // nothing about the two sessions keeping their ticks apart.
    const structure = await http.get<any>(`/plans/${veg.id}/prep-week/structure`);
    const feastOnionKeys = new Set<string>(
      structure.steps
        .filter((s: any) => s.stepKey.startsWith("feast#") && /onion/i.test(s.title))
        .map((s: any) => s.stepKey.slice("feast#".length)),
    );
    const weekOnions = week.env ? allSteps(week.env).filter((s) => /onion/i.test(`${s.title} ${s.instructions}`)) : [];
    const onion = weekOnions.find((s) => feastOnionKeys.has(s.stepKey)) ?? weekOnions[0];
    if (!onion) throw new Error("no onion step in the Vegetarian week");
    const shared = feastOnionKeys.has(onion.stepKey);
    await findPhase(page, (j) => j.includes(onion.title));
    const state0 = await stepCheckbox(page, onion.title);
    if (state0 === "unchecked") await page.locator('[data-qa="target-step"]').click();
    await page.waitForTimeout(1000);
    const state1 = await stepCheckbox(page, onion.title);
    await shot(page, LABEL, "B20-02-week-onion-ticked", shots);

    const feast = await measuredPrep(userId, "veg-feast", page, veg.id, "feast");
    const feastOnions = feast.env ? allSteps(feast.env).filter((s) => /onion/i.test(`${s.title} ${s.instructions}`)) : [];
    const comps = await http.get<any>(`/plans/${veg.id}/prep-week/completions`);
    const ticked = new Set(comps.completions.map((c: any) => c.stepKey));
    const feastOnionTicked = feastOnions.filter((s) => ticked.has(s.stepKey));
    let feastScreen: string | null = null;
    if (feastOnions[0]) {
      await findPhase(page, (j) => j.includes(feastOnions[0].title));
      feastScreen = await stepCheckbox(page, feastOnions[0].title);
    }
    await shot(page, LABEL, "B20-03-feast-onion", shots);
    const ok = noMeat && state1 === "checked" && ticked.has(onion.stepKey) && feastOnions.length > 0 && feastOnionTicked.length === 0 && feastScreen === "unchecked";
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `makeAhead kinds ${JSON.stringify(kinds)} (rows ${JSON.stringify(describeRows(m))}); Hub card shown ${text.includes("Thanksgiving make-ahead")}; ` +
        `week onion step "${onion.title}" (${onion.stepKey}, shares its food with the feast: ${shared}) ${state0} → ${state1}, ` +
        `in completions ${ticked.has(onion.stepKey)}; feast onion steps ${feastOnions.length} ` +
        `[${feastOnions.map((s) => s.stepKey).join(", ")}], ticked ${feastOnionTicked.length}, on screen ${feastScreen}`,
    };
  });

  // ── 21 — an ordinary plan ───────────────────────────────────────────────
  await ledger.run("B21", "An ordinary plan: no make-ahead card; Prep the Week unchanged (no feast line)", async (shots) => {
    // A live ordinary plan when the account has one; the test account's are all
    // past (the Part I census plans), and the Hub opens any plan by id.
    const today = todayYmd();
    const others = plans.filter((p) => p.source === "instance" && !String(p.name).startsWith("THX test"));
    const ordinary = others.find((p) => (p.endDate ?? p.startDate) >= today) ?? others[0];
    if (!ordinary) throw new Error("no ordinary plan on the account");
    const op = await planOf(ordinary.id);
    const text = await gotoHub(page, ordinary.id);
    await shot(page, LABEL, "B21-01-hub-ordinary", shots);
    const card = text.includes("Thanksgiving make-ahead") || text.includes("Prep the feast");
    const week = await measuredPrep(userId, "ordinary-week", page, ordinary.id, null);
    await shot(page, LABEL, "B21-02-week-ordinary", shots);
    const line = week.text.some((l) => /feast has its own prep/i.test(l));
    const title = week.text.includes("Prep the Week");
    const ok = !card && op.makeAhead === undefined && week.status === 200 && title && !line;
    return {
      verdict: ok ? "pass" : "fail",
      evidence:
        `plan "${ordinary.name}": makeAhead on wire ${op.makeAhead !== undefined}, card/feast button on Hub ${card}; ` +
        `Prep the Week status ${week.status} (cacheHit ${week.env?.cacheHit}), title ${title}, feast line ${line}`,
    };
  });

  // ── 22 — console ────────────────────────────────────────────────────────
  ledger.record({
    item: "B22",
    title: "No browser console errors across B",
    verdict: ledger.consoleErrors.length === 0 ? "pass" : "fail",
    evidence: ledger.consoleErrors.length === 0 ? "0 errors" : `${ledger.consoleErrors.length} error(s): ${ledger.consoleErrors.slice(0, 8).join(" ‖ ")}`,
    shots: [],
  });
});
