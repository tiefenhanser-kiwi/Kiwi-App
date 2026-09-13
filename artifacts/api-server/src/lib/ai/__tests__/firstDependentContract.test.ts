// WS9 D-WS9-239 Phase 1b — the `firstDependent` wire contract.
//
// Three things are pinned here, all of which the model actually sees:
//   1. the two TOOL-mode step schemas accept the field (integer / null /
//      omitted) and reject the shapes the derivation cannot use (negative,
//      fraction, string) — and NEITHER carries `parallelGroup`, which is
//      derived server-side and must never be a field the model fills;
//   2. the field's `.describe()` survives buildToolForSchema into the tool
//      JSON-schema `description` (the per-field guidance is real, not decorative);
//   3. the three prompt bodies carry the "# Overlap inside a dish" section, the
//      old prose guardrail is gone (the scheduler decides overlap from the
//      dependency — a guardrail on prose was a second source of truth), and the
//      `isTimingSensitive` paragraph's anchor on the "parallel windows" rule is
//      not orphaned.
// Prompt assertions run against the SEED SOURCE (exported bodies) and the
// compiled store-fill prefix, never the DB — see expandPromptTiming.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WIZARD_CANDIDATE_EXPAND_BODY,
  WIZARD_CANDIDATE_FINALIZE_STEPS_BODY,
} from "../../../../prisma/seeds/aiPrompts";
import { STABLE_FINALIZE_PREFIX } from "../../storeFillPrompts";
import { buildToolForSchema } from "../modes";
import {
  WizardFinalizeStepsResultSchema,
  WizardOutlineFieldSchema,
  WizardOutlineStepSchema,
  WizardStepSchema,
} from "../schemas/wizard";

const baseStep = {
  text: "Preheat the oven to 425°F.",
  phaseType: "preheat" as const,
  estimatedMinutes: 12,
  isTimingSensitive: false,
};
const baseOutline = { phaseType: "preheat" as const, estimatedMinutes: 12, isTimingSensitive: false };

describe("firstDependent — WizardStepSchema / WizardOutlineStepSchema round-trip", () => {
  it("accepts an integer, null, and omitted (omitted stays omitted)", () => {
    for (const [schema, base] of [
      [WizardStepSchema, baseStep],
      [WizardOutlineStepSchema, baseOutline],
    ] as const) {
      const n = schema.safeParse({ ...base, firstDependent: 3 });
      assert.equal(n.success, true);
      assert.equal(n.success && n.data.firstDependent, 3);
      const z = schema.safeParse({ ...base, firstDependent: 0 });
      assert.equal(z.success, true, "0 is a valid index");
      const nil = schema.safeParse({ ...base, firstDependent: null });
      assert.equal(nil.success, true);
      assert.equal(nil.success && nil.data.firstDependent, null);
      const omitted = schema.safeParse(base);
      assert.equal(omitted.success, true);
      assert.ok(omitted.success && !("firstDependent" in omitted.data), "omitted stays omitted");
    }
  });

  it("rejects negative, non-integer, and string values", () => {
    for (const [schema, base] of [
      [WizardStepSchema, baseStep],
      [WizardOutlineStepSchema, baseOutline],
    ] as const) {
      for (const bad of [-1, 1.5, "3", true]) {
        assert.equal(schema.safeParse({ ...base, firstDependent: bad }).success, false, `must reject ${JSON.stringify(bad)}`);
      }
    }
  });

  it("neither schema declares parallelGroup — a supplied token is STRIPPED, never parsed (it is derived server-side)", () => {
    const s = WizardStepSchema.safeParse({ ...baseStep, parallelGroup: "w0" });
    assert.equal(s.success, true);
    assert.ok(s.success && !("parallelGroup" in s.data));
    const o = WizardOutlineStepSchema.safeParse({ ...baseOutline, parallelGroup: "w0" });
    assert.equal(o.success, true);
    assert.ok(o.success && !("parallelGroup" in o.data));
  });

  it("a bad firstDependent on an outline entry drops the WHOLE outline (the BUG-245 catch), never fails the parse", () => {
    const r = WizardOutlineFieldSchema.safeParse([{ ...baseOutline, firstDependent: "3" }, { phaseType: "cook", estimatedMinutes: 20, isTimingSensitive: false }]);
    assert.equal(r.success, true);
    assert.equal(r.success && r.data, undefined);
  });
});

describe("firstDependent — the tool schema the model sees", () => {
  it("carries the field as integer|null with its description, and is NOT required", () => {
    const tool = buildToolForSchema(WizardFinalizeStepsResultSchema, "x")[0];
    const schema = tool.input_schema as {
      properties: { dishSteps: { items: { properties: { steps: { items: { properties: Record<string, unknown>; required: string[] } } } } } };
    };
    const step = schema.properties.dishSteps.items.properties.steps.items;
    const fd = step.properties.firstDependent as { anyOf?: unknown[]; description?: string };
    assert.ok(fd, "firstDependent must be on the tool schema");
    assert.deepEqual(fd.anyOf, [{ type: "integer", minimum: 0 }, { type: "null" }]);
    assert.ok(fd.description?.startsWith("UNATTENDED steps only"), "the .describe() text must survive into the tool schema");
    assert.ok(!step.required.includes("firstDependent"), "optional on the wire — omitted on attended steps");
    assert.ok(!("parallelGroup" in step.properties), "parallelGroup is never a field the model fills");
  });
});

describe("firstDependent — the three prompt bodies", () => {
  const bodies: [string, string][] = [
    ["wizard.candidate.finalize_steps", WIZARD_CANDIDATE_FINALIZE_STEPS_BODY],
    ["store.finalize_steps (compiled prefix)", STABLE_FINALIZE_PREFIX],
  ];

  for (const [name, body] of bodies) {
    it(`${name}: carries the overlap section with the END-explicit definition and the safe-direction rule`, () => {
      assert.ok(body.includes("# Overlap inside a dish — `firstDependent`"), "section header");
      assert.ok(
        body.includes(
          "carries `firstDependent`: the 0-based index, within this dish's `steps`, of the FIRST later step that cannot start until this one is completely done.",
        ),
        "the Encoding B question, verbatim",
      );
      assert.ok(body.includes("choose the EARLIER candidate — waiting is always safe; starting too early is not."), "the safe direction");
      assert.ok(body.includes("Attended steps (searing, sautéing, stir-frying, anything needing constant attention) never carry `firstDependent`"));
      assert.ok(body.includes('say "While the X bakes, …" only on a step that sits inside that window by `firstDependent`'), "text follows structure");
      assert.ok(body.includes('"firstDependent": 3 }, { "text": "Cut the potatoes'), "the prep-ahead example: preheat → the step that puts the tray in");
      assert.ok(body.includes('cook on low 8 hours.", "phaseType": "cook", "estimatedMinutes": 480, "isTimingSensitive": false, "firstDependent": null }'), "the slow-cooker step carries null");
      assert.ok(body.includes("plus `firstDependent` on every UNATTENDED step"), "the field list names it");
    });

    it(`${name}: the prose guardrail is gone; the hands-off definition and its isTimingSensitive anchor stay`, () => {
      assert.ok(!body.includes("Guardrail: only overlap into a cook step with at least ~20 minutes"), "the prose guardrail was a second source of truth");
      assert.ok(!body.includes("~2x the prep length"));
      assert.ok(body.includes("- Mention parallel windows ONLY when the cooking step is genuinely hands-off"), "the bullet the isTimingSensitive paragraph anchors on");
      assert.ok(body.includes("When in doubt, sequence the prep before cooking starts rather than overlapping it."), "the bullet's closing sentence survives the trim");
      assert.ok(body.includes('the SAME hands-off vs. NOT-hands-off split as the "parallel windows" rule in # Step rules above'), "the anchor is not orphaned");
    });
  }

  it("wizard.candidate.expand: outline entries gain firstDependent under the same rule; the roast-chicken example carries it", () => {
    const body = WIZARD_CANDIDATE_EXPAND_BODY;
    assert.ok(body.includes("- `firstDependent` — on every UNATTENDED entry (`preheat`, `rest`, `hold`, or a `cook` with `isTimingSensitive` false): the 0-based index, within this dish's `outline`, of the FIRST later entry that cannot start until this one is completely done"));
    assert.ok(body.includes("when unsure, choose the EARLIER candidate (waiting is always safe; starting too early is not)"));
    assert.ok(body.includes("Omit it on attended entries."));
    assert.ok(
      body.includes(
        '{ "phaseType": "preheat", "estimatedMinutes": 10, "isTimingSensitive": false, "firstDependent": 3 }, { "phaseType": "cook", "estimatedMinutes": 35, "isTimingSensitive": false, "firstDependent": 4 }, { "phaseType": "rest", "estimatedMinutes": 5, "isTimingSensitive": false, "firstDependent": 5 }, { "phaseType": "assemble", "estimatedMinutes": 3, "isTimingSensitive": false }',
      ),
      "preheat → the roast, roast → the rest, rest → the plate",
    );
    assert.ok(body.includes("the preheat's dependent is the roast, the roast's is the rest, the rest's is the plate."));
  });
});
