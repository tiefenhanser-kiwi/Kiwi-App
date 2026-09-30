// 🔴 BUG-339 — the wizard's internal scenario marker must not reach a tag chip.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isInternalTag, publicTags } from "../internalTags";

describe("BUG-339 — internal tags", () => {
  it("🔴 the literal from the browser pass", () => {
    // The Prep & Cook header rendered:
    //   fully-specified · family-friendly · mexican · asian · classic
    assert.deepEqual(
      publicTags(["fully-specified", "family-friendly", "mexican", "asian", "classic"]),
      ["family-friendly", "mexican", "asian", "classic"],
    );
  });

  it("every scenario value, in every spelling the model can emit", () => {
    // `parsedIntent.scenario` is authored with underscores and the tag arrived
    // hyphenated, so the normaliser folds both rather than listing both.
    for (const t of [
      "vague",
      "fully_specified",
      "fully-specified",
      "Fully-Specified",
      "  FULLY SPECIFIED  ",
      "partial",
      "unclear",
      "overflow",
    ]) {
      assert.equal(isInternalTag(t), true, `"${t}" is internal`);
    }
  });

  it("🔴 EXACT-STRING, never a substring — the vocabulary is open", () => {
    // `tags` is free text the model writes, so a substring rule is one plausible
    // tag away from eating a real one. These all contain a scenario word and all
    // must survive.
    for (const t of [
      "partially-prepped",
      "overflowing-with-flavor",
      "unclear-broth", // absurd, and exactly the kind of thing an open field gets
      "fully-loaded",
      "vaguely-italian",
      "specified",
    ]) {
      assert.equal(isInternalTag(t), false, `"${t}" must survive`);
    }
  });

  it("the ordinary case is unchanged, and null/empty are safe", () => {
    const ordinary = ["italian", "weeknight", "one-pan"];
    assert.deepEqual(publicTags(ordinary), ordinary);
    assert.deepEqual(publicTags([]), []);
    assert.deepEqual(publicTags(null), []);
    assert.deepEqual(publicTags(undefined), []);
  });

  it("does not mutate the caller's array — the column stays stored", () => {
    // Ruled: filter at READ, leave the value in the database. A mapper that
    // mutated its input would defeat that on any path that re-reads the row.
    const stored = ["fully-specified", "mexican"];
    const shown = publicTags(stored);
    assert.deepEqual(stored, ["fully-specified", "mexican"]);
    assert.deepEqual(shown, ["mexican"]);
  });
});
