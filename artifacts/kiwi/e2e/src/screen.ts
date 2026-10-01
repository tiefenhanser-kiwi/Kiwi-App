// ─────────────────────────────────────────────────────────────────────────────
// DRIVING THE SCREENS — sign-in, navigation, settling, screenshots, and text.
//
// 🔴 WHAT MADE THIS HARDER THAN IT LOOKS, recorded here because it is the
// "where the app resisted automation" list and it belongs next to the code that
// works around it:
//
//   • THERE ARE ALMOST NO testIDs. Across the three screens this pass drives,
//     the entire inventory is `grocery-stale-notice` on the grocery screen and
//     `step-<i>` in CookSessionView. Everything else is addressed by visible
//     text, which is exactly the "exact-text assertion" this pass is not
//     allowed to make about the AI parts — so selectors here only ever match
//     CHROME (a button label, a header), never generated content.
//
//   • "Sign in" IS BOTH THE HEADING AND THE BUTTON on (auth)/sign-in. A
//     getByText("Sign in") matches two nodes and throws strict-mode. The button
//     is reached by role.
//
//   • REACT NATIVE WEB RENDERS EVERY Text AS A <div>, so there are no <p>/<li>
//     landmarks and no accessible list structure to walk. Row text is recovered
//     by walking leaf text nodes in document order.
//
//   • THERE IS NO "IDLE" EVENT. RNW + React Query settle asynchronously with
//     no global flag, and `networkidle` is unreliable behind the proxy. Settling
//     is done by polling the rendered text until it stops changing, which is
//     slower but does not lie.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { RUN_DIR, WEB_ORIGIN } from "./env";
import { readCreds, redact } from "./creds";

export interface Shot {
  name: string;
  file: string;
  url: string;
}

const shots: Shot[] = [];
export function allShots(): Shot[] {
  return shots;
}

function shotDir(runLabel: string): string {
  const d = join(RUN_DIR, runLabel);
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * One screenshot per screen per flow, plus the rendered text beside it. The
 * text file is what the rule checkers and chat-Claude read; the PNG is what
 * Hans looks at.
 */
export async function capture(
  page: Page,
  runLabel: string,
  name: string,
): Promise<{ shot: Shot; text: string[] }> {
  const dir = shotDir(runLabel);
  const png = join(dir, `${name}.png`);
  await page.screenshot({ path: png, fullPage: true });
  const text = await renderedText(page);
  writeFileSync(join(dir, `${name}.txt`), redact(text.join("\n")), "utf8");
  const shot: Shot = { name, file: png, url: page.url() };
  shots.push(shot);
  return { shot, text };
}

/**
 * Every leaf text run on the page, in document order, trimmed and de-blanked.
 * This is the harness's view of "what the screen says" — the input to every
 * text-level rule and to the DOM-vs-wire cross-check.
 */
export async function renderedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el) continue;
      // Skip anything genuinely not shown. `visibility`/`display` are enough:
      // RNW positions with transforms, so offsetParent checks drop real text.
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") continue;
      const t = (n.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
    return out;
  });
}

/**
 * Wait until the rendered text stops changing. `stableFor` consecutive polls
 * with identical text is the settle signal; there is no app-level idle flag to
 * ask instead. Returns the text so a caller need not re-read it.
 */
export async function settle(
  page: Page,
  opts: { timeoutMs?: number; stableFor?: number; pollMs?: number; minLines?: number } = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const stableFor = opts.stableFor ?? 3;
  const pollMs = opts.pollMs ?? 500;
  const minLines = opts.minLines ?? 1;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let same = 0;
  let text: string[] = [];
  while (Date.now() < deadline) {
    text = await renderedText(page);
    const joined = text.join("");
    if (joined === last && text.length >= minLines) {
      if (++same >= stableFor) return text;
    } else {
      same = 0;
      last = joined;
    }
    await page.waitForTimeout(pollMs);
  }
  return text;
}

/** True when the page is showing one of the app's loading affordances. */
export function looksLoading(text: string[]): boolean {
  const j = text.join(" ").toLowerCase();
  return /loading|generating|building your|one moment|updating to match/.test(j);
}

// ── selectors ────────────────────────────────────────────────────────────────
//
// ROLE FIRST, everywhere a control has a role. [design-fix] A1–A4 gave the
// shared `Button` an `accessibilityRole` and an accessible name, which covers
// every primary control this harness touches. `tapButton` therefore needs no
// text fallback at all, and the one it has is a diagnostic: when it fires, the
// control it was aiming at has lost (or never had) its role, and that is a
// finding for the next UI block rather than something to paper over.
//
// WHAT STILL HAS NO ROLE, on the screens this pass drives (surveyed at
// 4ecabed, reported not fixed):
//   • components/CookSessionView.tsx — 3 Pressables, 0 roles. The timer-strip
//     "+1 min" and "dismiss" carry an accessibilityLabel but no role, so they
//     are reachable by LABEL and not by role; the step rows carry `step-<i>`
//     and neither a role nor a label.
//   • app/grocery-list/[id].tsx — 4 roles across 13 Pressables. The row's name
//     and need pressables (the inline-edit affordance) have no role, no label
//     and no testID: text is the only handle.
//   • components/Header.tsx — 1 role across 2 Pressables.

/** Tap a control by role + accessible name. Text is a reported fallback. */
export async function tapButton(
  page: Page,
  name: string | RegExp,
  opts: { fallbackNote?: string[] } = {},
): Promise<"role" | "text"> {
  const byRole = page.getByRole("button", { name, exact: typeof name === "string" });
  try {
    await byRole.first().waitFor({ state: "visible", timeout: 20_000 });
    await byRole.first().click();
    return "role";
  } catch {
    // ⚠️ REACHED ONLY WHEN THE CONTROL HAS NO ROLE. Recorded as a finding.
    const note =
      `no role="button" named ${String(name)} — fell back to a focusable-div text match; ` +
      `that control needs an accessibilityRole`;
    opts.fallbackNote?.push(note);
    const byText = page.locator('[tabindex="0"]').filter({
      hasText: typeof name === "string" ? new RegExp(`^${name}$`) : name,
    });
    await byText.first().waitFor({ state: "visible", timeout: 20_000 });
    await byText.first().click();
    return "text";
  }
}

// ── Cook Mode's own total ────────────────────────────────────────────────────
//
// 🔴 READ OFF THE SCREEN, NOT SUMMED. The bridge used to set a meal's
// `sequenceTotalMinutes` to a serial sum of step minutes whenever Cook Mode had
// no sequence — which is every single-dish meal, because §7.13 means Cook Mode
// never sequences one. `lib/cooking/stepTiming.ts` is blunt about what that
// number is: "THIS IS NOT THE WALL CLOCK, AND IT MUST NOT BE SHOWN AS ONE …
// 48 of 54 meals overstated, median 43% over". Feeding it to K-R6 produced
// four findings that were about the instrument.
//
// The footer is the user's number: `app/cook-session.tsx:281` renders
// `remainingMinutesToServe(activeSteps, safeIndex) ?? remainingMinutes(...)`
// into CookFooter's "~N min left". At step 0 that IS the total, so the harness
// parses the rendered string and uses it. No arithmetic of our own survives.
// ⚠️ IT IS THREE TEXT NODES, NOT ONE. CookFooter.tsx:54 is
// `<Text>~{remainingMins} min left</Text>` — JSX with three children, so the
// DOM holds "~", "106" and " min left" as separate text runs. The first version
// of this parser scanned the rendered-text ARRAY line by line, where no single
// entry ever contains the whole phrase, so it returned null for all 25 meals of
// the first quick check and K-R6 silently fell back to the serial sum it was
// written to replace. A detector that cannot fail loudly will fail quietly.
const COOK_TOTAL_RE = /~\s*(\d+)\s*min\s*left/i;

/**
 * Read the footer's total off the live DOM. `innerText` concatenates an
 * element's own text runs, which is exactly what the three-node phrase needs.
 */
export async function readCookModeTotalMinutes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const re = /~\s*(\d+)\s*min\s*left/i;
    const m = re.exec(document.body.innerText || "");
    return m ? Number(m[1]) : null;
  });
}

/** The array form, for re-scoring a saved capture. Joined, for the reason above. */
export function parseCookTotalMinutes(text: string[]): number | null {
  for (const line of text) {
    const m = COOK_TOTAL_RE.exec(line);
    if (m) return Number(m[1]);
  }
  // Adjacent runs, rejoined both ways: " " covers "~ 106 min left" and "" covers
  // "~106min left" after each node has been trimmed.
  for (const joined of [text.join(" "), text.join("")]) {
    const m = COOK_TOTAL_RE.exec(joined);
    if (m) return Number(m[1]);
  }
  return null;
}

// ── sign-in ──────────────────────────────────────────────────────────────────

/**
 * Sign in through the REAL form. This is deliberately not a token injection:
 * step 1 of the flow is "sign in with the dev test account", and an injected
 * sessionStorage token would skip the one screen most likely to break a user.
 *
 * The token IS read back afterwards, so the harness's own HTTP calls run as the
 * same session the browser holds rather than a second one.
 */
export async function signInThroughUi(page: Page): Promise<{ token: string }> {
  const { email, password } = readCreds();
  await page.goto(`${WEB_ORIGIN}/(auth)/sign-in`, { waitUntil: "domcontentloaded" });
  await settle(page, { timeoutMs: 60_000, minLines: 2 });

  // Placeholders, because there are no testIDs on this screen.
  const emailBox = page.getByPlaceholder("Email", { exact: true });
  const passBox = page.getByPlaceholder("Password", { exact: true });
  await emailBox.waitFor({ state: "visible", timeout: 30_000 });
  await emailBox.fill(email);
  await passBox.fill(password);

  // ── ✅ A ROLE QUERY, AS OF [design-fix] A2 ───────────────────────────────
  //
  // This used to be the worst selector in the harness. `components/Button.tsx`
  // wrapped a bare `Pressable` with no `accessibilityRole`, so react-native-web
  // rendered `<div tabindex="0">` with no role — and the ONE element on this
  // screen that did carry `role="button"` was the password-visibility toggle,
  // with an empty accessible name, so a role query could select the wrong
  // control. The harness had to fall back to
  // `div[tabindex="0"]` filtered on exact text.
  //
  // `9fbd65b` ([design-fix] A2) gave Button both `accessibilityRole="button"`
  // and `accessibilityLabel={accessibilityLabel ?? label}`, and gave the
  // PasswordField toggle a real name. Both halves of the problem are gone, so
  // the role query is exact and the heading/button ambiguity ("Sign in" is
  // both) no longer matters — a heading is not a button.
  await tapButton(page, "Sign in");

  // The app replaces the auth stack on success. Wait for the token rather than
  // for a URL: expo-router's web history rewrites are not atomic with the
  // store, and a URL check races them.
  await page.waitForFunction(
    () => {
      try {
        return !!window.sessionStorage.getItem("kiwi_authToken");
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 60_000 },
  );
  const token = await page.evaluate(() => window.sessionStorage.getItem("kiwi_authToken") ?? "");
  if (!token) throw new Error("signed in but sessionStorage kiwi_authToken was empty");
  await settle(page, { timeoutMs: 60_000, minLines: 2 });
  return { token };
}

// ── navigation ───────────────────────────────────────────────────────────────
//
// Every destination is a deep link, not a tap path. The tap paths are worth
// testing and they are a LATER block's job: Part A is about the grocery, Cook
// Mode and Prep-the-Week RENDERS, and reaching them through four screens each
// would make a picker regression look like a render regression.

export async function gotoGroceryList(page: Page, listId: string): Promise<string[]> {
  await page.goto(`${WEB_ORIGIN}/grocery-list/${listId}`, { waitUntil: "domcontentloaded" });
  let text = await settle(page, { timeoutMs: 120_000, minLines: 5 });
  // Reconcile-on-read can re-render the whole list once, after the first paint.
  if (looksLoading(text)) text = await settle(page, { timeoutMs: 120_000, minLines: 5 });
  return text;
}

export async function gotoCookMode(
  page: Page,
  args: { mealId: string; planId: string; planItemId?: string },
): Promise<string[]> {
  const q = new URLSearchParams({ mealId: args.mealId, planId: args.planId });
  if (args.planItemId) q.set("planItemId", args.planItemId);
  await page.goto(`${WEB_ORIGIN}/cook-session?${q}`, { waitUntil: "domcontentloaded" });
  let text = await settle(page, { timeoutMs: 120_000, minLines: 5 });
  if (looksLoading(text)) text = await settle(page, { timeoutMs: 120_000, minLines: 5 });
  return text;
}

/** The plan detail screen — where PlanReviewMealRow's "Remove from plan" lives. */
export async function gotoPlanDetail(page: Page, planId: string): Promise<string[]> {
  await page.goto(`${WEB_ORIGIN}/plan/${planId}`, { waitUntil: "domcontentloaded" });
  let text = await settle(page, { timeoutMs: 120_000, minLines: 5 });
  if (looksLoading(text)) text = await settle(page, { timeoutMs: 120_000, minLines: 5 });
  return text;
}

export async function gotoPrepWeek(page: Page, planId: string): Promise<string[]> {
  const q = new URLSearchParams({ mode: "prep-week", planId });
  await page.goto(`${WEB_ORIGIN}/cook-session?${q}`, { waitUntil: "domcontentloaded" });
  // A cold prep-week is a Sonnet narration: minutes, not seconds.
  let text = await settle(page, { timeoutMs: 210_000, minLines: 5 });
  if (looksLoading(text)) text = await settle(page, { timeoutMs: 210_000, minLines: 5 });
  return text;
}
