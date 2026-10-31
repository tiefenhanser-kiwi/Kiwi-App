// SERVER-13 C (D-WS9-372) — a week-only cache version. SERVER-12 B and C changed
// Prep the Week's narration input; bumping PREP_ENGINE_VERSION would also re-narrate
// every "Prep the feast" session, because it is in both gates. WEEK_SESSION_VERSION
// is in the week's gate alone: a weeknight cache written before it misses once, a
// feast session's cache still hits.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { PrepLoadedPlan } from "../prepWeekAggregation";
import { FEAST_SESSION_VERSION, feastSessionFingerprint, PREP_ENGINE_VERSION, prepCompositionFingerprint, WEEK_SESSION_VERSION } from "../prepWeekFingerprint";

const input = { planId: "p", meals: [{ mealId: "m", dishes: [] }] } as unknown as PrepLoadedPlan;
const sha = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex");

describe("SERVER-13 C — the week's own cache version", () => {
  it("is in the week's fingerprint: a cache written before the bump (no week key) misses", () => {
    assert.ok(WEEK_SESSION_VERSION >= 1);
    const before = sha({ v: 1, engine: PREP_ENGINE_VERSION, input });
    assert.equal(prepCompositionFingerprint(input), sha({ v: 1, engine: PREP_ENGINE_VERSION, week: WEEK_SESSION_VERSION, input }));
    assert.notEqual(prepCompositionFingerprint(input), before);
  });

  it("is not in the feast session's: its cache, written before the bump, still hits", () => {
    assert.equal(feastSessionFingerprint(input), sha({ v: 1, engine: PREP_ENGINE_VERSION, session: FEAST_SESSION_VERSION, input }));
  });
});
