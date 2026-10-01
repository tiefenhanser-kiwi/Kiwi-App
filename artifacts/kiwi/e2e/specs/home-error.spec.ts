// ─────────────────────────────────────────────────────────────────────────────
// THE HOME ERROR STATE — the flow a device test cannot easily reach.
//
// Getting a phone to see this means cutting the network at the right moment, or
// pointing the build at a dead server. Playwright's request routing gives it for
// free and, more usefully, DETERMINISTICALLY: abort, un-abort, and hang are
// three separate conditions here, and the third one — a request that never
// answers — is the one [design-fix] C2 says was previously unreachable:
//
//   "the apiClient layer imposes no timeout and the global QueryClient sets
//    retry: false, so a request that never settles leaves the query pending
//    forever and the 'Getting your week…' shim renders indefinitely. An error
//    state with a retry cannot fix that on its own, because nothing ever
//    reports an error."
//
// So `useHomePayload` added an AbortController ceiling of 10s. This spec proves
// all three: that a failure shows the error state, that retry recovers, and
// that a HANG becomes an error rather than a spinner forever.
//
// 🔴 WHAT IT ASSERTS AND WHY IT IS NOT AN EXACT-TEXT TEST OF AI OUTPUT. The
// three strings are Hans's copy, exported as constants from
// components/HomeErrorState.tsx precisely so a test pins the words rather than
// a paraphrase. They are chrome, not generated content — the one place where
// pinning exact text is the right thing.
// ─────────────────────────────────────────────────────────────────────────────
import { expect, test } from "@playwright/test";

import { RUN_ID, WEB_ORIGIN, ensureRunDir } from "../src/env";
import { capture, settle, signInThroughUi, tapButton } from "../src/screen";
import { preflight, teardown, type Preflight } from "../src/stack";

/** Hans's copy, from components/HomeErrorState.tsx. */
const HOME_ERROR_TITLE = "We couldn't reach Kiwi";
const HOME_ERROR_BODY = "Check your connection and try again.";
const HOME_ERROR_RETRY = "Try again";
/** useHomePayload.ts — HOME_CLIENT_TIMEOUT_MS. */
const HOME_CLIENT_TIMEOUT_MS = 10_000;

/**
 * The make-lane eyebrow, in both its states. homeSectionOrder returns
 * `["error"]` — whole-screen and exclusive — so NEITHER may be on screen beside
 * the error card. This is the "the empty or new-account layout is not shown"
 * assertion, and it is keyed on the thing that actually distinguishes them:
 * before C2, a failed load rendered `["makeLane"]` and nothing else.
 */
const MAKE_LANE_FIRST_RUN = "what do you want to eat?";
const MAKE_LANE_RETURNING = "plan something new";

let pf: Preflight | null = null;

test.beforeAll(async () => {
  ensureRunDir();
  pf = await preflight();
  for (const c of pf.checks) {
    console.log(`[preflight] ${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.note}`);
  }
  expect(pf.ok, "preflight failed").toBe(true);
});

test.afterAll(async () => {
  if (pf) teardown(pf);
});

test("Home error state: abort → retry → hang", async ({ page }) => {
  const label = "home-error";
  const notes: string[] = [];

  // Sign in BEFORE any routing is installed: the sign-in screen does not call
  // GET /home, and a route left in place during bootstrap would fail the
  // session rather than the screen under test.
  await signInThroughUi(page);

  // ── 1 — abort GET /api/home ──────────────────────────────────────────────
  //
  // `**/api/home*` and not `**/api/home`: the screen sends a query string
  // (the client's local date), so an exact match never fires and the test
  // would silently pass against a HEALTHY Home.
  let aborting = true;
  await page.route("**/api/home*", async (route) => {
    if (aborting) return route.abort("failed");
    return route.fallback();
  });

  await page.goto(`${WEB_ORIGIN}/`, { waitUntil: "domcontentloaded" });
  const errText = await settle(page, { timeoutMs: 60_000, minLines: 3 });
  await capture(page, label, "01-aborted");

  const errorCard = page.getByTestId("home-error-state");
  await expect(errorCard, "the error card is on screen").toBeVisible();
  expect(errText.join(" "), "the title is Hans's copy, verbatim").toContain(HOME_ERROR_TITLE);
  expect(errText.join(" "), "the body is Hans's copy, verbatim").toContain(HOME_ERROR_BODY);
  // The retry is reachable BY ROLE, as of [design-fix] A2.
  await expect(
    page.getByRole("button", { name: HOME_ERROR_RETRY, exact: true }),
    "the retry is a role=button with an accessible name",
  ).toBeVisible();

  // ── the empty / new-account layout must NOT be beside it ────────────────
  // homeSectionOrder: `if (opts.isError) return ["error"]`. Half a screen next
  // to "we couldn't reach Kiwi" reads as a partial success.
  const hay = errText.join("  ");
  expect(hay, "no first-run eyebrow beside the error").not.toContain(MAKE_LANE_FIRST_RUN);
  expect(hay, "no returning-user eyebrow beside the error").not.toContain(MAKE_LANE_RETURNING);

  // ── 2 — remove the route, tap Try again, Home loads ─────────────────────
  aborting = false;
  await page.unroute("**/api/home*");
  const how = await tapButton(page, HOME_ERROR_RETRY, { fallbackNote: notes });
  expect(how, "the retry was reached by role, not by a text fallback").toBe("role");

  await expect(errorCard, "the error card goes away on a successful retry").toBeHidden({
    timeout: 60_000,
  });
  const okText = await settle(page, { timeoutMs: 60_000, minLines: 5 });
  await capture(page, label, "02-after-retry");
  expect(
    okText.join(" ").toLowerCase(),
    "Home rendered something real after the retry",
  ).toMatch(/plan something new|what do you want to eat|this week|tonight|cook/i);

  // ── 3 — HANG the request: the 10s ceiling must produce an error, not a
  //        spinner forever ───────────────────────────────────────────────────
  //
  // The route never answers. Before C2 this was the unreachable second failure:
  // the query stayed pending and the "Getting your week…" shim rendered
  // indefinitely. The assertion is therefore about WHEN as much as what.
  let released: (() => void) | null = null;
  await page.route("**/api/home*", async (route) => {
    await new Promise<void>((resolve) => {
      released = resolve;
    });
    // ⚠️ "Route is already handled!" IS THE PROOF, NOT AN ERROR. By the time
    // this resolves, useHomePayload's AbortController has already cancelled the
    // request — so Playwright has handed the route to that abort and this one
    // has nothing left to do. Swallowed deliberately: the client winning the
    // race is exactly what the assertion above measured.
    try {
      await route.abort("failed");
    } catch {
      /* the client's own 10s ceiling got there first */
    }
  });

  const t0 = Date.now();
  await page.goto(`${WEB_ORIGIN}/?hang=1`, { waitUntil: "domcontentloaded" });
  // Generous ceiling, tight floor: the point is that it DOES settle, and that
  // it does not settle before the client timeout could have fired.
  await expect(errorCard, "a hung request becomes the error state").toBeVisible({
    timeout: HOME_CLIENT_TIMEOUT_MS + 20_000,
  });
  const waited = Date.now() - t0;
  await capture(page, label, "03-hung");
  // Not a spinner: the shim must be gone, not merely covered.
  const hungText = await settle(page, { timeoutMs: 20_000, minLines: 3 });
  expect(
    hungText.join(" "),
    "the loading shim is not still on screen behind the error",
  ).not.toContain("Getting your week");
  expect(hungText.join(" ")).toContain(HOME_ERROR_TITLE);
  console.log(
    `[home-error] hung request surfaced the error after ${(waited / 1000).toFixed(1)}s ` +
      `(client ceiling ${HOME_CLIENT_TIMEOUT_MS / 1000}s)`,
  );
  expect(
    waited,
    `the error must not appear before the ${HOME_CLIENT_TIMEOUT_MS / 1000}s ceiling could fire ` +
      `— appearing sooner means something OTHER than the timeout failed the query`,
  ).toBeGreaterThan(HOME_CLIENT_TIMEOUT_MS * 0.5);

  if (released) (released as () => void)();
  await page.unroute("**/api/home*");

  if (notes.length > 0) console.log(`[home-error] selector fallbacks: ${notes.join("; ")}`);
  console.log(`[home-error] screenshots under out/${RUN_ID}/${label}/`);
});
