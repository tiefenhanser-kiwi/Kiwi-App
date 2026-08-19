// BUG-099 — ParsedIntentSchema.needsClarification tolerance.
// Run via: pnpm --filter @workspace/api-server test
// Pure schema unit tests; no SDK, no prisma, no network.
//
// The defect: `wizard.directed.parse_intent` (Haiku, text mode) is
// nondeterministic about how it spells "nothing to clarify". The prompt says
// omit the key; the model sometimes emits a bare `{}` instead. `.optional()`
// does not cover that — the key is present, so the required inner `reason`
// fails and POST /api/wizard/build-from-text returns 502 to the device.
//
// These tests pin BOTH halves of the contract: every honest "nothing to
// clarify" spelling normalises to the key being ABSENT (the one canonical
// internal form, forced by the mobile client re-validating with its own Zod
// requiring `reason`), and genuinely malformed payloads still reject.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ParsedIntentSchema } from "../schemas/tellKiwi";

// Minimal valid envelope; each test varies only `needsClarification`.
function payload(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    scenario: "vague",
    explicitMeals: [],
    intentDescriptors: ["easy"],
    mealCount: 4,
    ...extra,
  };
}

describe("BUG-099 — ParsedIntentSchema.needsClarification tolerance", () => {
  it("accepts the model's bare {} and normalises it to absent", () => {
    // The exact shape from Hans's 502 log:
    //   lastExtractedValue: {"scenario":"vague",...,"needsClarification":{}}
    const parsed = ParsedIntentSchema.safeParse(
      payload({ needsClarification: {} }),
    );
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.needsClarification, undefined);
    // And absent on the WIRE, which is the contract that actually binds.
    // zod keeps a key that was present in the input, valued `undefined`; the
    // route hands parsedIntent to res.json, and JSON.stringify drops
    // undefined-valued keys. So the device never sees the `{}` that would
    // fail its own Zod (which requires `reason`).
    assert.equal(
      "needsClarification" in JSON.parse(JSON.stringify(parsed.data)),
      false,
    );
  });

  it("accepts null and normalises it to absent", () => {
    const parsed = ParsedIntentSchema.safeParse(
      payload({ needsClarification: null }),
    );
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.needsClarification, undefined);
  });

  it("accepts the key omitted entirely (the prompt-compliant shape)", () => {
    const parsed = ParsedIntentSchema.safeParse(payload({}));
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.needsClarification, undefined);
  });

  it("normalises an object whose reason is missing or blank to absent", () => {
    for (const value of [
      { options: ["Pasta", "Soup"] }, // options but no reason
      { reason: "" },
      { reason: "   " },
      { reason: 42 },
    ]) {
      const parsed = ParsedIntentSchema.safeParse(
        payload({ needsClarification: value }),
      );
      assert.equal(
        parsed.success,
        true,
        `expected accept for ${JSON.stringify(value)}`,
      );
      assert.equal(parsed.data?.needsClarification, undefined);
    }
  });

  it("still validates a genuine `unclear` clarification unchanged", () => {
    const parsed = ParsedIntentSchema.safeParse(
      payload({
        scenario: "unclear",
        needsClarification: {
          reason: "Tell me a bit more — what kind of week do you want?",
        },
      }),
    );
    assert.equal(parsed.success, true);
    assert.equal(
      parsed.data?.needsClarification?.reason,
      "Tell me a bit more — what kind of week do you want?",
    );
  });

  it("passes a genuine `overflow` clarification's options through intact", () => {
    const parsed = ParsedIntentSchema.safeParse(
      payload({
        scenario: "overflow",
        needsClarification: {
          reason: "You named more meals than fit in 5 nights.",
          options: ["Pasta", "Soup", "Sandwiches"],
        },
      }),
    );
    assert.equal(parsed.success, true);
    assert.equal(
      parsed.data?.needsClarification?.reason,
      "You named more meals than fit in 5 nights.",
    );
    assert.deepEqual(parsed.data?.needsClarification?.options, [
      "Pasta",
      "Soup",
      "Sandwiches",
    ]);
  });

  // ── the tolerance must NOT become a swallow-everything ────────────────

  it("still rejects a non-object needsClarification", () => {
    const parsed = ParsedIntentSchema.safeParse(
      payload({ needsClarification: "nope" }),
    );
    assert.equal(parsed.success, false);
    assert.deepEqual(
      parsed.error?.issues.map((i) => i.path.join(".")),
      ["needsClarification"],
    );
  });

  it("still rejects an over-long reason (280-char cap)", () => {
    const parsed = ParsedIntentSchema.safeParse(
      payload({ needsClarification: { reason: "x".repeat(281) } }),
    );
    assert.equal(parsed.success, false);
    assert.deepEqual(
      parsed.error?.issues.map((i) => i.path.join(".")),
      ["needsClarification.reason"],
    );
  });

  it("still rejects more than 6 options and non-string options", () => {
    const tooMany = ParsedIntentSchema.safeParse(
      payload({
        needsClarification: {
          reason: "r",
          options: ["1", "2", "3", "4", "5", "6", "7"],
        },
      }),
    );
    assert.equal(tooMany.success, false);
    assert.deepEqual(
      tooMany.error?.issues.map((i) => i.path.join(".")),
      ["needsClarification.options"],
    );

    const wrongType = ParsedIntentSchema.safeParse(
      payload({ needsClarification: { reason: "r", options: [1, 2] } }),
    );
    assert.equal(wrongType.success, false);
    assert.deepEqual(
      wrongType.error?.issues.map((i) => i.path.join(".")),
      ["needsClarification.options.0", "needsClarification.options.1"],
    );
  });

  it("still rejects a malformed envelope (unknown scenario)", () => {
    const parsed = ParsedIntentSchema.safeParse(
      payload({ scenario: "banana", needsClarification: {} }),
    );
    assert.equal(parsed.success, false);
    assert.deepEqual(
      parsed.error?.issues.map((i) => i.path.join(".")),
      ["scenario"],
    );
  });
});
