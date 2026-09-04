// WS9 BUG-201 — the hydration gate on the per-run generate payloads.
//
// THE CONTRACT (Hans, verbatim):
//   Field OMITTED               -> the screen never loaded preferences
//                               -> the server resolves from stored.
//   Field PRESENT, incl. empty  -> the user's actual choice
//                               -> the server honours it exactly.
//
// 🔴 THE DISCRIMINATOR IS WHETHER THE SCREEN LOADED, NOT WHETHER THE VALUE IS
// EMPTY. Both halves are pinned below, because a fix that made empty
// UNSENDABLE would be a different bug of the same family: it would stop a user
// who really has no allergies from saying so.
//
// ⚠️ EVERY ASSERTION READS THE POST-SERIALIZATION BODY. `body.x === undefined`
// is true both for a dropped key and for a key set to undefined, so an object
// lookup cannot tell "omitted" from "present and empty" — only `in` on the
// JSON round trip can, and the wire is what the server actually parses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildTellKiwiPayload,
  buildWizardPayload,
  type TellKiwiPayloadForm,
  type WizardPayloadForm,
} from "../perRunPayload";

/** What JSON.stringify actually puts on the wire. */
function onTheWire(body: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

// ⚠️ TRANSCRIBED FROM app/wizard.tsx INITIAL_FORM AND app/tellkiwi.tsx
// INITIAL_FORM — the state the screens hold BEFORE hydration, and the state
// they are still holding if the prefs read failed. The `allergies: []` and
// `eatingStyles: []` below are the exact values that used to go out claiming
// to be the user's choice.
const WIZARD_UNHYDRATED: WizardPayloadForm = {
  planDurationDays: 5,
  householdSize: 4,
  cuisines: ["American", "Mexican"],
  eatingStyles: [],
  allergies: [],
  dietaryNotes: "",
  difficulty: "medium",
  weeklyPacing: "mostly_easy",
  additionalNotes: "",
  discoveryMealsPerWeek: 0,
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
};

const TELLKIWI_UNHYDRATED: TellKiwiPayloadForm = {
  description: "something comforting",
  planDurationDays: 5,
  householdSize: 4,
  cuisines: [],
  weeklyPacing: "mostly_easy",
  eatingStyles: [],
  allergies: [],
  dietaryNotes: "",
  discoveryMealsPerWeek: 0,
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
};

/** The same form after a successful hydrate, with real stored values. */
const WIZARD_HYDRATED: WizardPayloadForm = {
  ...WIZARD_UNHYDRATED,
  allergies: ["Peanuts", "Shellfish"],
  eatingStyles: ["Vegetarian"],
  discoveryMealsPerWeek: 2,
  saucePreference: "homemade",
  maxCookTimeMinutes: 45,
  maxCookTimeCoverage: "all",
};

const TELLKIWI_HYDRATED: TellKiwiPayloadForm = {
  ...TELLKIWI_UNHYDRATED,
  allergies: ["Peanuts"],
  eatingStyles: ["Pescatarian"],
};

// ── hydrated === false: OMIT ───────────────────────────────────────────────

test("BUG-201 wizard: hydrated=false OMITS the allergen field entirely", () => {
  const wire = onTheWire(buildWizardPayload(WIZARD_UNHYDRATED, false));

  // 🔴 THE ASSERTION. Not "it is empty" — it is ABSENT. An absent field is the
  // only way to say "I do not know", and the only input the server can safely
  // resolve from stored.
  assert.equal(
    "allergiesAndAvoidances" in wire,
    false,
    `an unhydrated screen described the user's allergies: ${JSON.stringify(wire)}`,
  );
  assert.equal("eatingStyles" in wire, false);

  // The four Phase-B overrides were already gated (D-WS7-035); pinned so a
  // future edit cannot ungate them while "fixing" the two new ones.
  for (const key of [
    "discoveryMealsPerWeek",
    "saucePreference",
    "maxCookTimeMinutes",
    "maxCookTimeCoverage",
  ]) {
    assert.equal(key in wire, false, `${key} escaped the hydration gate`);
  }

  // Ungated fields still ship — the gate is scoped, not a blanket suppression.
  assert.equal(wire.planDurationDays, 5);
  assert.equal(wire.householdSize, 4);
  assert.deepEqual(wire.cuisines, ["American", "Mexican"]);
  assert.equal(wire.difficulty, "medium");
});

test("BUG-201 tellkiwi: hydrated=false OMITS the allergen field entirely", () => {
  const wire = onTheWire(buildTellKiwiPayload(TELLKIWI_UNHYDRATED, false));
  assert.equal(
    "allergiesAndAvoidances" in wire,
    false,
    `an unhydrated screen described the user's allergies: ${JSON.stringify(wire)}`,
  );
  assert.equal("eatingStyles" in wire, false);
  // The description is the whole point of this screen and is never gated.
  assert.equal(wire.description, "something comforting");
});

// ── hydrated === true: SEND, INCLUDING EMPTY ───────────────────────────────

test("BUG-201: hydrated=true sends the real values", () => {
  const wire = onTheWire(buildWizardPayload(WIZARD_HYDRATED, true));
  assert.deepEqual(wire.allergiesAndAvoidances, ["Peanuts", "Shellfish"]);
  assert.deepEqual(wire.eatingStyles, ["Vegetarian"]);
  assert.equal(wire.saucePreference, "homemade");
  assert.equal(wire.maxCookTimeMinutes, 45);

  const tk = onTheWire(buildTellKiwiPayload(TELLKIWI_HYDRATED, true));
  assert.deepEqual(tk.allergiesAndAvoidances, ["Peanuts"]);
  assert.deepEqual(tk.eatingStyles, ["Pescatarian"]);
});

test("BUG-201: a HYDRATED user with no allergies sends [] — empty stays SENDABLE", () => {
  // ⚠️ THE OTHER HALF OF THE CONTRACT, AND THE ONE A CARELESS FIX BREAKS. The
  // shape here is byte-identical to the unhydrated case above; only `hydrated`
  // differs. If this ever starts omitting, an "I have no restrictions" user can
  // no longer override stored values, which is BUG-201 pointing the other way.
  const wire = onTheWire(buildWizardPayload(WIZARD_UNHYDRATED, true));
  assert.equal("allergiesAndAvoidances" in wire, true);
  assert.deepEqual(wire.allergiesAndAvoidances, []);
  assert.equal("eatingStyles" in wire, true);
  assert.deepEqual(wire.eatingStyles, []);

  const tk = onTheWire(buildTellKiwiPayload(TELLKIWI_UNHYDRATED, true));
  assert.equal("allergiesAndAvoidances" in tk, true);
  assert.deepEqual(tk.allergiesAndAvoidances, []);
});

test("BUG-201: `hydrated` is the ONLY thing that decides presence", () => {
  // Same form object, both flags. Presence flips; nothing else about the two
  // dietary fields does. This is the discriminator stated as an experiment
  // rather than as a comment.
  const off = onTheWire(buildWizardPayload(WIZARD_HYDRATED, false));
  const on = onTheWire(buildWizardPayload(WIZARD_HYDRATED, true));
  assert.equal("allergiesAndAvoidances" in off, false);
  assert.equal("allergiesAndAvoidances" in on, true);
  // …and the ungated half of the payload is identical across both.
  for (const key of ["planDurationDays", "householdSize", "difficulty"]) {
    assert.deepEqual(off[key], on[key], `${key} moved with the gate`);
  }
});

// ── The third site — wizard-results' no-input expand fallback ──────────────
//
// app/wizard-results.tsx is outside the test glob and buildCandidateContext
// depends on a full WizardPlanCandidate, so this is a SOURCE-LEVEL guard in the
// style of noWriteback.test.ts. The literal it forbids is the exact one that
// was there: a no-input fallback asserting the user has no allergies, feeding
// the expand prompt that authors ingredients.
test("BUG-201: wizard-results' no-input expand fallback OMITS rather than sends []", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    resolve(here, "../../../app/wizard-results.tsx"),
    "utf8",
  );

  // Positive control: the guard is reading the right function.
  assert.ok(
    /function buildCandidateContext/.test(src),
    "buildCandidateContext moved — this guard is no longer reading it",
  );

  // Isolate the final (no-input) return so a legitimate `[]` elsewhere in the
  // file cannot mask a regression here, and so this cannot pass vacuously.
  const marker = "// No input at all";
  const idx = src.indexOf(marker);
  assert.ok(idx > 0, "the no-input fallback branch was not found");
  const fallback = src.slice(idx, src.indexOf("}", src.indexOf("return {", idx)));

  assert.ok(
    !/allergiesAndAvoidances\s*:\s*\[\s*\]/.test(fallback),
    `the no-input fallback still asserts an empty allergy list:\n${fallback}`,
  );
  assert.ok(
    !/eatingStyles\s*:\s*\[\s*\]/.test(fallback),
    `the no-input fallback still asserts empty eating styles:\n${fallback}`,
  );
  // It should still supply the fields it CAN legitimately know.
  assert.ok(/difficulty:/.test(fallback), "the fallback lost its other fields");
});
