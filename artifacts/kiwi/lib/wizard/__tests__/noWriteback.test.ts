// Cookbook Phase B Block 4 (D-WS7-035) — no-writeback guard.
//
// The wizard hydrates its controls from stored UserPreferences and lets the
// user edit them for THIS generation only. Those edits must NEVER write back
// to /me/preferences (Hans's ruling: a one-off "household 30 for Thanksgiving"
// must not silently shift the saved defaults). The wizard's ONLY outbound write
// is the per-run generate payload.
//
// Enforced structurally: the wizard must not reference patchPreferences, nor
// issue a PATCH against /me/preferences. A source-level guard is the faithful
// assertion here — if a future edit wires a write-back, this fails.
//
// WS9 Redesign Arc Block 2a Part C — /wizard and /tellkiwi are one-line mounts
// of components/WizardScreen.tsx now, so the guard runs over all three: the
// two routes (which must stay inert) and the component (which is where the
// hydration read — the positive control — lives).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "../../../app");
const componentsDir = resolve(here, "../../../components");

const SCREENS = [
  { screen: "app/wizard.tsx", path: resolve(appDir, "wizard.tsx"), hydrates: false },
  { screen: "app/tellkiwi.tsx", path: resolve(appDir, "tellkiwi.tsx"), hydrates: false },
  {
    screen: "components/WizardScreen.tsx",
    path: resolve(componentsDir, "WizardScreen.tsx"),
    hydrates: true,
  },
] as const;

for (const { screen, path, hydrates } of SCREENS) {
  test(`${screen} never writes back to /me/preferences`, () => {
    const src = readFileSync(path, "utf8");

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

    // Positive control: the merged screen DOES read preferences (hydration
    // source); the two routes mount it and read nothing themselves.
    assert.equal(
      /getPreferences/.test(src),
      hydrates,
      hydrates
        ? `${screen} should hydrate from getPreferences`
        : `${screen} is a route mount and should not read preferences itself`,
    );
    if (!hydrates) {
      assert.ok(/WizardScreen/.test(src), `${screen} should mount WizardScreen`);
    }
  });
}
