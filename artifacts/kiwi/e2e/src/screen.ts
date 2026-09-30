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

  // ── 🔴 THE WORST SELECTOR IN THIS HARNESS, AND WHY IT HAS TO BE ──────────
  //
  // `getByRole("button", { name: "Sign in" })` does not work, and the reason is
  // worth an app-side fix rather than a better test:
  //
  //   • components/Button.tsx wraps a bare react-native `Pressable` with no
  //     `accessibilityRole`, so react-native-web renders it as
  //     `<div tabindex="0">` with NO role at all. There is no button to find.
  //   • the one element on this screen that DOES carry `role="button"` is the
  //     password-visibility toggle inside PasswordField — and it has an empty
  //     accessible name. So a role query does not merely miss the submit
  //     control, it can select the wrong control.
  //   • and "Sign in" is the screen's heading as well as its button label, so a
  //     plain text selector matches two nodes and strict mode throws.
  //
  // What is left that is actually unambiguous: the focusable div whose own text
  // is exactly "Sign in". The heading is not focusable, so `[tabindex="0"]`
  // separates them. One `accessibilityRole="button"` on Button.tsx would retire
  // this whole comment — logged in the report, not changed here (components/**
  // belongs to the design-fix lane).
  const submit = page
    .locator('div[tabindex="0"]')
    .filter({ hasText: /^Sign in$/ });
  await submit.first().waitFor({ state: "visible", timeout: 30_000 });
  await submit.first().click();

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

export async function gotoPrepWeek(page: Page, planId: string): Promise<string[]> {
  const q = new URLSearchParams({ mode: "prep-week", planId });
  await page.goto(`${WEB_ORIGIN}/cook-session?${q}`, { waitUntil: "domcontentloaded" });
  // A cold prep-week is a Sonnet narration: minutes, not seconds.
  let text = await settle(page, { timeoutMs: 210_000, minLines: 5 });
  if (looksLoading(text)) text = await settle(page, { timeoutMs: 210_000, minLines: 5 });
  return text;
}
