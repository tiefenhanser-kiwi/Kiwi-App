// Cookbook Phase B Block 4 (D-WS7-035) — no-writeback guard.
//
// The wizard hydrates its controls from stored UserPreferences and lets the
// user edit them for THIS generation only. Those edits must NEVER write back
// to /me/preferences (Hans's ruling: a one-off "household 30 for Thanksgiving"
// must not silently shift the saved defaults). The wizard's ONLY outbound write
// is the per-run generate payload.
//
// The mobile test harness has no screen-render capability (logic-only unit
// tests), so this is enforced structurally: the two wizard screens must not
// reference patchPreferences, nor issue a PATCH against /me/preferences. A
// source-level guard is the faithful assertion here — if a future edit wires a
// write-back, this fails.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "../../../app");

const SCREENS = ["wizard.tsx", "tellkiwi.tsx"] as const;

for (const screen of SCREENS) {
  test(`${screen} never writes back to /me/preferences`, () => {
    const src = readFileSync(resolve(appDir, screen), "utf8");

    // No import or call of the preferences mutator.
    assert.equal(
      /patchPreferences/.test(src),
      false,
      `${screen} references patchPreferences — wizard edits must not write back`,
    );

    // No PATCH against the preferences endpoint by any other path.
    assert.equal(
      /["'`]\/me\/preferences["'`][\s\S]{0,120}PATCH|PATCH[\s\S]{0,120}["'`]\/me\/preferences["'`]/.test(
        src,
      ),
      false,
      `${screen} issues a PATCH to /me/preferences — no write-back allowed`,
    );

    // Positive control: the screen DOES read preferences (hydration source).
    assert.ok(
      /getPreferences/.test(src),
      `${screen} should hydrate from getPreferences`,
    );
  });
}
