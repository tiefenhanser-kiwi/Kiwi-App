// WS9 D-WS9-235 / BUG-245 — the expand prompt must not teach the model to
// shorten a number to fit a cap.
//
// BUG-245 traced a "30-minute" meatloaf with a 58-minute bake to this prompt,
// which defined the field as "total time in minutes including prep + cook",
// told the model to "keep it under the cap" with "No exceptions", and offered
// "a hands-off braise that simmers an hour" as compatible with a tight cap.
// Writing 30 was the COMPLIANT answer to that prompt.
//
// This asserts against the SEED SOURCE, not the DB: the DB serves whatever was
// last seeded, so a test reading it would pass or fail on Hans's reseed timing
// rather than on the committed body. The seed file is the single source of
// truth per kiwi_prompt_update_playbook.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEED = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../prisma/seeds/aiPrompts.ts",
);

describe("wizard.candidate.expand — time instructions (BUG-245)", () => {
  const body = fs.readFileSync(SEED, "utf8");

  it("no longer tells the model to bend the number to the cap", () => {
    for (const banned of [
      "keep it under the cap",
      "No exceptions",
      "including prep + cook",
    ]) {
      assert.equal(
        body.includes(banned),
        false,
        `the expand prompt must not contain ${JSON.stringify(banned)} — it is what produced BUG-245`,
      );
    }
  });

  it("no longer offers a long unattended braise as cap-compatible", () => {
    // The original read "a dish can be easy-but-slow (a hands-off braise that
    // simmers an hour) or fancy-but-fast". v6 keeps the braise ONLY as a
    // counter-example, so assert on the licensing construction, not the noun.
    assert.equal(
      body.includes("simmers an hour) or fancy-but-fast"),
      false,
      "the braise must not be offered as compatible with a tight cap",
    );
  });

  it("carries D-WS9-122's wall-clock definition and its worked example", () => {
    assert.ok(
      body.includes("opening the fridge to being able to plate"),
      "D-WS9-122's definition must be in the prompt that authors the number",
    );
    assert.ok(
      body.includes("20-minute bake beside a 10-minute sauté"),
      "the overlap example must be present",
    );
  });

  it("says the authored number is a pre-finalize estimate", () => {
    assert.ok(
      body.includes("PRE-FINALIZE ESTIMATE"),
      "the model must be told the app recomputes this from the steps at save",
    );
  });

  it("makes the cap a SELECTION instruction with an honest-number fallback", () => {
    assert.ok(body.includes("THE CAP CONSTRAINS WHICH RECIPES YOU PICK"));
    assert.ok(
      body.includes("PICK THE CLOSEST ONE AND STATE ITS TRUE TIME"),
      "an unmeetable cap gets an honest number, not an error and not a shortened one",
    );
  });
});
