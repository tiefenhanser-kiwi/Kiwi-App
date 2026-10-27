// SERVER-6 A (ATTR) — the attribution sanitizer and the alert's "Came from" words.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ATTRIBUTION_VALUE_MAX, cameFromLine, sanitizeAttribution, SIGNUP_HOW_HEARD } from "../signupAttribution";

describe("sanitizeAttribution", () => {
  it("keeps the five keys as trimmed strings ≤ 120 and drops everything else", () => {
    assert.deepEqual(
      sanitizeAttribution({ ref: " a ", utmSource: "s", utmMedium: "m", utmCampaign: "c", landingPath: "/p", extra: "x", utm_source: "snake" }),
      { ref: "a", utmSource: "s", utmMedium: "m", utmCampaign: "c", landingPath: "/p" },
    );
    assert.equal(sanitizeAttribution({ ref: "r".repeat(500) })!.ref!.length, ATTRIBUTION_VALUE_MAX);
    assert.deepEqual(sanitizeAttribution({ ref: "line\nbreak\u007f" }), { ref: "linebreak" });
  });

  it("null for anything that carries no usable value", () => {
    for (const raw of [undefined, null, "", "ref=a", 7, [], ["a"], {}, { ref: "" }, { ref: "  " }, { ref: 3, utmSource: false }]) {
      assert.equal(sanitizeAttribution(raw), null, JSON.stringify(raw));
    }
  });

  it("the howHeard list is the eight answers, in the client's order", () => {
    assert.deepEqual([...SIGNUP_HOW_HEARD], ["friend", "instagram", "tiktok", "reddit", "google", "app_store", "creator", "other"]);
  });

  it("cameFromLine reads a stored value the same way (an old or hand-written row included)", () => {
    assert.equal(cameFromLine({ ref: "maya" }), "ref maya");
    assert.equal(cameFromLine({ utmCampaign: "fall" }), "utm - / - / fall");
    assert.equal(cameFromLine({ nope: 1 }), null);
    assert.equal(cameFromLine(null), null);
  });
});
