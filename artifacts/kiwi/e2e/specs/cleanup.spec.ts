// ─────────────────────────────────────────────────────────────────────────────
// The cleanup entry point. OPT-IN ONLY: without KIWI_E2E_CLEANUP it skips, so a
// normal `pnpm run e2e` can never archive anything.
//
//   KIWI_E2E_CLEANUP=dry    — print what would be composted, change nothing
//   KIWI_E2E_CLEANUP=apply  — compost the harness's own plans
//
// No browser: it is API-only. The preflight still runs, because the one thing
// that matters here is the dev-database fence.
// ─────────────────────────────────────────────────────────────────────────────
import { expect, test } from "@playwright/test";

import { cleanup } from "../src/cleanup";
import { assertDevDatabase } from "../src/env";

const MODE = process.env.KIWI_E2E_CLEANUP;

test.skip(
  MODE !== "dry" && MODE !== "apply",
  "cleanup is opt-in — set KIWI_E2E_CLEANUP=dry or =apply",
);

test(`cleanup (${MODE ?? "skipped"})`, async () => {
  // The fence, before anything else and independently of the preflight.
  const db = assertDevDatabase();
  console.log(`[cleanup] ${db.note}`);
  expect(db.ok, "refusing to touch anything but the dev database").toBe(true);
  await cleanup(MODE === "apply");
});
