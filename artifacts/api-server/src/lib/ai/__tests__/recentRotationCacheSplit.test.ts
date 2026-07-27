// Plan-Gen Arc · Block 4b-2 (D-WS9-073) — cache-split guard for the recent-
// rotation nudge.
//
// The nudge payload rides on `wizardInput` (build-plans) / `generateInput`
// (directed), both of which render BELOW the `{{storeShortlist}}` cache marker.
// The Latency Block's acceptance criterion — the cached system prefix is
// byte-identical regardless of the volatile tail — must still hold. This test
// asserts it against the REAL seeded prompt body, not a synthetic stand-in:
// adding `recentRotation` to the tail must not perturb the cached prefix by a
// single byte, and the payload must actually land in the tail.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderPromptBody,
  splitRenderedPrompt,
} from "../promptRegistry";
import {
  WIZARD_SET_PREFERENCES_GENERATE_BODY,
  WIZARD_DIRECTED_GENERATE_BODY,
} from "../../../../prisma/seeds/aiPrompts";

// Same marker the route passes to streamPlanCandidates (wizard.ts).
const MARKER = "{{storeShortlist}}";

const shortlist = [{ id: "m1", title: "Sheet-pan chicken" }];
const rotation = {
  plansConsidered: 3,
  meals: [
    {
      title: "Weeknight Chicken Fajitas",
      dishFamily: "chicken-fajitas",
      familyRank: 12,
      timesRecentlyServed: 3,
    },
    { title: "Improvised Fridge Stir-Fry", timesRecentlyServed: 1 },
  ],
};

describe("recent-rotation cache split (build-plans body)", () => {
  const baseVars = {
    storeShortlist: shortlist,
    wizardInput: {
      planDurationDays: 5,
      planningContext: { currentDate: "2026-07-27", season: "summer" },
    },
  };
  const withRotationVars = {
    ...baseVars,
    wizardInput: { ...baseVars.wizardInput, recentRotation: rotation },
  };

  it("the cached prefix is byte-identical with and without the rotation payload", () => {
    const bare = splitRenderedPrompt(
      WIZARD_SET_PREFERENCES_GENERATE_BODY,
      MARKER,
      baseVars,
    );
    const nudged = splitRenderedPrompt(
      WIZARD_SET_PREFERENCES_GENERATE_BODY,
      MARKER,
      withRotationVars,
    );
    assert.ok(bare.prefix, "expected a cached prefix (marker must be found)");
    assert.equal(nudged.prefix, bare.prefix);
    // The prefix must not carry any part of the volatile tail's payload.
    assert.ok(!nudged.prefix!.includes("recentRotation"));
    assert.ok(!nudged.prefix!.includes("Fajitas"));
  });

  it("the rotation payload lands in the volatile tail (below the marker)", () => {
    const nudged = splitRenderedPrompt(
      WIZARD_SET_PREFERENCES_GENERATE_BODY,
      MARKER,
      withRotationVars,
    );
    assert.ok(nudged.body.includes("recentRotation"));
    assert.ok(nudged.body.includes("Weeknight Chicken Fajitas"));
    assert.ok(nudged.body.includes("chicken-fajitas"));
  });

  it("preserves the split invariant: prefix + body === full render", () => {
    const nudged = splitRenderedPrompt(
      WIZARD_SET_PREFERENCES_GENERATE_BODY,
      MARKER,
      withRotationVars,
    );
    assert.equal(
      nudged.prefix! + nudged.body,
      renderPromptBody(WIZARD_SET_PREFERENCES_GENERATE_BODY, withRotationVars),
    );
  });
});

describe("recent-rotation renders in the directed body tail", () => {
  // Directed uses buffered runAICall (no cached prefix), so there is no marker
  // split at runtime — but the payload must still render inside {{generateInput}},
  // which sits after the shelf section in the body.
  it("recentRotation appears after the storeShortlist marker in the rendered body", () => {
    const rendered = renderPromptBody(WIZARD_DIRECTED_GENERATE_BODY, {
      storeShortlist: shortlist,
      generateInput: {
        planDurationDays: 5,
        recentRotation: rotation,
      },
    });
    const shelfAt = rendered.indexOf("Sheet-pan chicken"); // rendered shortlist
    const rotationAt = rendered.indexOf("recentRotation");
    assert.ok(rotationAt > -1, "recentRotation missing from directed body");
    assert.ok(
      rotationAt > shelfAt,
      "recentRotation should render below the shelf",
    );
  });
});
