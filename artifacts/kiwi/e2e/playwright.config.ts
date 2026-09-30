// ─────────────────────────────────────────────────────────────────────────────
// The QA harness — Playwright config. DEV ONLY.
//
// Headless Chromium at 375 × 812 against the same-origin local stack:
//   http://localhost:9000  → artifacts/kiwi/dist (expo export --platform web)
//   http://localhost:9000/api → proxied to the dev api-server on :3000
//
// The harness NEVER starts an api-server. It will start
// kiwi-local-tools/serve-proxy.cjs as a child only when :9000 is free; when
// something is already listening there it attaches to it and leaves it alone
// (Hans's own stack is expected to be up).
//
// Retries are 0 on purpose. A flake that a retry hides is exactly the signal
// this harness exists to report — "the app resisted automation" is a finding,
// not noise to be smoothed away.
// ─────────────────────────────────────────────────────────────────────────────
import { defineConfig, devices } from "@playwright/test";

import { RUN_DIR, WEB_ORIGIN } from "./src/env";

export default defineConfig({
  testDir: "./specs",
  outputDir: `${RUN_DIR}/_playwright`,
  // One worker: every flow mutates the SAME dev account (plans, grocery lists,
  // the this-week winner). Parallel flows would race on that one user's state
  // and the failures would be the harness's, not the app's.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // A prep-week generation is a Sonnet call; 4 minutes is the ceiling, not the
  // expectation.
  timeout: 4 * 60 * 1000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: `${RUN_DIR}/_playwright-report.json` }]],
  use: {
    baseURL: WEB_ORIGIN,
    ...devices["Desktop Chrome"],
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: false, // RNW listens for mouse events; touch-only drops taps
    headless: true,
    screenshot: "off", // the flow takes its own, named, per screen
    video: "off",
    trace: "retain-on-failure",
    // The web export talks to /api on its own origin, so nothing here needs a
    // CORS allowance or a second base URL.
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "chromium-375x812" }],
});
