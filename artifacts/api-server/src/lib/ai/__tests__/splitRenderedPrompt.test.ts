// Latency Block (D-WS9-076) — cache-prefix split byte-identity tests (Guard 1).
// Run via: pnpm --filter @workspace/api-server test
//
// The acceptance criterion for the cache split is byte-IDENTITY, not
// equivalence: prefix + tail must reproduce exactly what the buffered path
// renders today, and the prefix must be identical across different users (no
// per-user data leaks into the cached head).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderPromptBody, splitRenderedPrompt } from "../promptRegistry";

const MARKER = "{{storeShortlist}}";

// A realistic-shape body: a long stable instruction head with NO template vars,
// then the two volatile tail tokens ({{storeShortlist}}, {{wizardInput}}) — the
// same ordering as the seeded wizard.set_preferences.generate body.
const HEAD = `You are Kiwi's meal-plan generator.
${"Follow these rules carefully. ".repeat(400)}
Return up to 3 distinct candidates. Mark store-filled slots.`;
const BODY = `${HEAD}

SHORTLIST:
${MARKER}

USER INPUT:
{{wizardInput}}`;

const USER_A = {
  storeShortlist: [{ alias: "m1", title: "Chili" }],
  wizardInput: { userId: "user-A", cuisines: ["Italian"], householdSize: 4 },
};
const USER_B = {
  storeShortlist: [{ alias: "m9", title: "Curry" }],
  wizardInput: { userId: "user-B", cuisines: ["Thai"], householdSize: 2 },
};

describe("splitRenderedPrompt — byte identity (Guard 1)", () => {
  it("prefix + body === renderPromptBody(fullBody) for the same vars", () => {
    const { prefix, body } = splitRenderedPrompt(BODY, MARKER, USER_A);
    assert.notEqual(prefix, null);
    assert.equal(
      (prefix ?? "") + body,
      renderPromptBody(BODY, USER_A),
      "cached prefix + tail must byte-match the buffered render",
    );
  });

  it("the cached prefix is byte-identical across two different users", () => {
    const a = splitRenderedPrompt(BODY, MARKER, USER_A);
    const b = splitRenderedPrompt(BODY, MARKER, USER_B);
    assert.equal(a.prefix, b.prefix, "prefix must not carry per-user data");
    // ...while the volatile tails legitimately differ per user.
    assert.notEqual(a.body, b.body);
  });

  it("the prefix contains no template tokens (nothing left to render)", () => {
    const { prefix } = splitRenderedPrompt(BODY, MARKER, USER_A);
    assert.ok(prefix && !/\{\{\w+\}\}/.test(prefix));
    // The head is everything before the marker, verbatim.
    assert.equal(prefix, BODY.slice(0, BODY.indexOf(MARKER)));
  });
});

describe("splitRenderedPrompt — no-split fallbacks (byte-identical to today)", () => {
  it("undefined marker → prefix null, body is the full render", () => {
    const { prefix, body } = splitRenderedPrompt(BODY, undefined, USER_A);
    assert.equal(prefix, null);
    assert.equal(body, renderPromptBody(BODY, USER_A));
  });

  it("marker not found → prefix null, body is the full render", () => {
    const { prefix, body } = splitRenderedPrompt(BODY, "{{nope}}", USER_A);
    assert.equal(prefix, null);
    assert.equal(body, renderPromptBody(BODY, USER_A));
  });

  it("marker at index 0 → no prefix (nothing stable ahead of it)", () => {
    const body0 = `${MARKER} then {{wizardInput}}`;
    const { prefix, body } = splitRenderedPrompt(body0, MARKER, USER_A);
    assert.equal(prefix, null);
    assert.equal(body, renderPromptBody(body0, USER_A));
  });
});
