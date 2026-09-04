// BUG-201 / D-WS9-214 — the allergen field presence contract.
//
// Hans's ruling, verbatim:
//   field OMITTED                  -> the screen never loaded preferences
//                                  -> resolve from stored
//   field PRESENT, INCLUDING EMPTY -> the user's actual choice on that screen
//                                  -> honour it exactly
//   "The discriminator is whether the screen LOADED, not whether it is empty."
//
// ⚠️ THE BUG THESE PIN IS A ZOD DEFAULT, WHICH IS WHY THE SCHEMA IS TESTED HERE
// TOO AND NOT ONLY THE RESOLVER. `allergiesAndAvoidances: z.array(...)
// .default([])` rewrote an absent field to `[]` INSIDE VALIDATION, before any
// resolver could see the difference. A resolver test alone would stay green with
// the default restored — the request would simply never reach the omitted
// branch — so the parse step is asserted directly, against the real schemas.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WizardInputSchema, WizardExpandCandidateContextSchema } from "../ai/schemas/wizard";
import { DirectedInputSchema } from "../ai/schemas/tellKiwi";
import { resolveAllergenPreference } from "../wizardPreferences";

/** Minimal prisma stub — resolveAllergenPreference reads one row. */
function prismaStub(stored: string[] | null) {
  let reads = 0;
  return {
    reads: () => reads,
    client: {
      userPreferences: {
        findUnique: async () => {
          reads++;
          return stored === null ? null : { allergiesAndAvoidances: stored };
        },
      },
    },
  };
}

const ROUTE = { route: "test" };

describe("BUG-201 — the schemas must PRESERVE absence", () => {
  const bodies = {
    WizardInputSchema: {
      planDurationDays: 5,
      householdSize: 4,
      difficulty: "easy" as const,
      weeklyPacing: "mostly_easy" as const,
    },
    DirectedInputSchema: {
      description: "something quick",
      planDurationDays: 5,
      householdSize: 4,
    },
    WizardExpandCandidateContextSchema: {
      planDurationDays: 5,
      householdSize: 4,
      wantsLeftovers: false,
      difficulty: "easy" as const,
    },
  };
  const schemas = {
    WizardInputSchema,
    DirectedInputSchema,
    WizardExpandCandidateContextSchema,
  };

  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    it(`${name}: an omitted allergen field parses to undefined, NOT []`, () => {
      const parsed = schemas[name].parse(bodies[name]);
      // `=== undefined` is the entire assertion. `.default([])` makes this `[]`,
      // which is indistinguishable from a user who cleared their chips — and
      // that collapse IS BUG-201.
      assert.equal(
        parsed.allergiesAndAvoidances,
        undefined,
        "a default here erases the absence the resolver needs to see",
      );
      assert.ok(
        !("allergiesAndAvoidances" in parsed) ||
          parsed.allergiesAndAvoidances === undefined,
      );
    });

    it(`${name}: an explicitly empty allergen field survives as []`, () => {
      const parsed = schemas[name].parse({
        ...bodies[name],
        allergiesAndAvoidances: [],
      });
      assert.deepEqual(parsed.allergiesAndAvoidances, []);
    });

    it(`${name}: a populated allergen field passes through`, () => {
      const parsed = schemas[name].parse({
        ...bodies[name],
        allergiesAndAvoidances: ["Gluten-free"],
      });
      assert.deepEqual(parsed.allergiesAndAvoidances, ["Gluten-free"]);
    });
  }
});

describe("BUG-201 — resolveAllergenPreference honours the contract", () => {
  it("OMITTED resolves from stored — the fail-open that BUG-201 was", () => {
    // This is the whole bug: the wizard screen failed to hydrate prefs, sent no
    // allergen field, and a coeliac's shelf query ran with the hard filter off.
    return (async () => {
      const p = prismaStub(["Gluten-free", "Shellfish-free"]);
      const out = await resolveAllergenPreference(p.client as never, "u1", undefined, ROUTE);
      assert.deepEqual(out.allergiesAndAvoidances, ["Gluten-free", "Shellfish-free"]);
      assert.equal(out.source, "stored");
    })();
  });

  it("PRESENT-AND-EMPTY is honoured as 'no allergies this run'", async () => {
    // ⚠️ This looks like the unsafe branch and is the ruled one. Union-with-
    // stored can never drop an allergy but makes the per-run field inert — an
    // unticked chip would stay ticked forever. Hans: "maybe a user has a mild
    // gluten thing and they want to cook whatever tastes better for a party
    // this weekend. that's ok."
    const p = prismaStub(["Gluten-free"]);
    const out = await resolveAllergenPreference(p.client as never, "u1", [], ROUTE);
    assert.deepEqual(out.allergiesAndAvoidances, []);
    assert.equal(out.source, "client");
  });

  it("PRESENT-AND-POPULATED wins over stored — the per-run override", async () => {
    const p = prismaStub(["Gluten-free"]);
    const out = await resolveAllergenPreference(
      p.client as never,
      "u1",
      ["Dairy-free"],
      ROUTE,
    );
    assert.deepEqual(out.allergiesAndAvoidances, ["Dairy-free"]);
    assert.equal(out.source, "client");
  });

  it("omitted + no stored prefs row at all resolves to empty, not a throw", async () => {
    const p = prismaStub(null);
    const out = await resolveAllergenPreference(p.client as never, "new-user", undefined, ROUTE);
    assert.deepEqual(out.allergiesAndAvoidances, []);
    assert.equal(out.source, "stored");
  });

  it("the two empty cases are DISTINGUISHABLE — the point of the whole fix", async () => {
    // Same output list, different provenance. If `source` ever collapses these,
    // the contract is gone even though both calls still "work".
    const p = prismaStub([]);
    const omitted = await resolveAllergenPreference(p.client as never, "u1", undefined, ROUTE);
    const explicit = await resolveAllergenPreference(p.client as never, "u1", [], ROUTE);
    assert.deepEqual(omitted.allergiesAndAvoidances, explicit.allergiesAndAvoidances);
    assert.notEqual(omitted.source, explicit.source);
  });
});
