// WS7-6 Block 2 — seam test for the shared ingredient resolver.
//
// Q3 risk guard: the upsert + category inference were extracted from
// wizardActivation.ts so the new save-canonical materializeMeal could
// reuse them. The structural risk is "did the extraction change semantics
// or the tx-boundary contract" — these tests pin both:
//
//  1. inferCategory bucket assignment is unchanged for the keyword set
//     materializeWizardDraft used in WS7-5d Block 2.
//  2. resolveIngredients dedupes by canonical name AND issues exactly one
//     upsert per unique canonical — proving it's safe to call from
//     either materializer without per-call coupling.
//  3. resolveIngredients runs against the plain PrismaClient (NOT a
//     TransactionClient) — proving the Pass 1 / Pass 2 split that
//     wizardActivation's comment block describes is preserved.
//
// Lightweight stubs (no real Prisma) — same harness convention as
// wizardActivation.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  inferCategory,
  resolveIngredients,
} from "../ingredientResolve";

interface CapturedUpsert {
  canonicalName: string;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

function makeStubPrisma(): {
  prisma: PrismaClient;
  captured: CapturedUpsert[];
} {
  const captured: CapturedUpsert[] = [];
  const stub = {
    ingredient: {
      upsert: async (args: {
        where: { canonicalName: string };
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        captured.push({
          canonicalName: args.where.canonicalName,
          create: args.create,
          update: args.update,
        });
        return { id: `ing-${args.where.canonicalName.replace(/\s+/g, "-")}` };
      },
    },
  };
  return { prisma: stub as unknown as PrismaClient, captured };
}

// ── inferCategory pin (matches wizardActivation behavior verbatim) ─────

describe("inferCategory — extracted shared helper", () => {
  it("matches the Canned bucket for the multi-token keywords Block 2 added", () => {
    assert.equal(inferCategory("diced tomatoes"), "Canned");
    assert.equal(inferCategory("crushed tomatoes"), "Canned");
    assert.equal(inferCategory("coconut milk"), "Canned");
    assert.equal(inferCategory("chicken broth"), "Canned");
    assert.equal(inferCategory("pickled jalapeño"), "Canned");
  });

  it("matches Produce / Protein / Dairy / Bakery buckets", () => {
    assert.equal(inferCategory("garlic"), "Produce");
    assert.equal(inferCategory("chicken thighs"), "Protein");
    assert.equal(inferCategory("greek yogurt"), "Dairy");
    assert.equal(inferCategory("naan"), "Bakery");
  });

  it("falls back to Pantry for unknowns", () => {
    assert.equal(inferCategory("ras el hanout"), "Pantry");
    assert.equal(inferCategory(""), "Pantry");
  });
});

// ── WS7-8b #2 — powder/granulated/dried route to Pantry, not Produce ──────
// A new Pantry rule placed BEFORE Produce so shelf-stable dry forms of
// otherwise-fresh produce stop matching the bare Produce keyword. Create-time
// only (no backfill of existing rows). Verified against fresh-produce
// non-collision: the bare names still resolve to Produce.

describe("inferCategory — WS7-8b dry-form Pantry rule (#2)", () => {
  it("routes garlic/onion powder to Pantry (was Produce via the bare keyword)", () => {
    assert.equal(inferCategory("garlic powder"), "Pantry");
    assert.equal(inferCategory("onion powder"), "Pantry");
    assert.equal(inferCategory("granulated garlic"), "Pantry");
  });

  it("routes dried herbs to Pantry (shelf-stable, not fresh Produce)", () => {
    assert.equal(inferCategory("dried thyme"), "Pantry");
    assert.equal(inferCategory("dried oregano"), "Pantry");
    assert.equal(inferCategory("dried basil"), "Pantry");
  });

  it("CORRUPTION GUARD: fresh produce names (no powder/granulated/dried) still resolve to Produce", () => {
    assert.equal(inferCategory("garlic"), "Produce");
    assert.equal(inferCategory("onion"), "Produce");
    assert.equal(inferCategory("thyme"), "Produce");
    assert.equal(inferCategory("basil"), "Produce");
  });
});

// ── BUG-017 (WS7-8b B1 Phase 1) — categorizer rule fixes ──────────────────
// Every REQUIRED outcome from the BUG-017 prompt gets a pin here. Grouped by
// the failure mode it fixes; regression pins guard the rules these overrides
// sit in front of.

describe("inferCategory — BUG-017 condiment SAUCES route to Pantry", () => {
  it("jar/bottle sauces → Pantry (beating the Protein keywords they contain)", () => {
    assert.equal(inferCategory("fish sauce"), "Pantry");
    assert.equal(inferCategory("duck sauce"), "Pantry");
    assert.equal(inferCategory("cocktail sauce"), "Pantry");
    assert.equal(inferCategory("shrimp cocktail sauce"), "Pantry");
    assert.equal(inferCategory("soy sauce"), "Pantry");
    assert.equal(inferCategory("hot sauce"), "Pantry");
    assert.equal(inferCategory("worcestershire"), "Pantry");
    assert.equal(inferCategory("worcestershire sauce"), "Pantry");
  });

  it("CANNED GUARD: the tomato-family sauces stay Canned", () => {
    assert.equal(inferCategory("tomato sauce"), "Canned");
    assert.equal(inferCategory("enchilada sauce"), "Canned");
    assert.equal(inferCategory("marinara"), "Canned");
    assert.equal(inferCategory("marinara sauce"), "Canned");
  });
});

describe("inferCategory — BUG-017 nut/seed butters route to Pantry", () => {
  it("nut/seed butters → Pantry (beating the bare 'butter' Dairy keyword)", () => {
    assert.equal(inferCategory("peanut butter"), "Pantry");
    assert.equal(inferCategory("almond butter"), "Pantry");
    assert.equal(inferCategory("cashew butter"), "Pantry");
    assert.equal(inferCategory("sunflower butter"), "Pantry");
    assert.equal(inferCategory("sunbutter"), "Pantry");
    assert.equal(inferCategory("tahini"), "Pantry");
  });

  it("DAIRY GUARD: bare butter / buttermilk stay Dairy", () => {
    assert.equal(inferCategory("butter"), "Dairy");
    assert.equal(inferCategory("unsalted butter"), "Dairy");
    assert.equal(inferCategory("buttermilk"), "Dairy");
  });
});

describe("inferCategory — BUG-017 corn tortilla routes to Bakery", () => {
  it("corn tortillas → Bakery (tortilla beats the bare 'corn' Produce keyword)", () => {
    assert.equal(inferCategory("corn tortilla"), "Bakery");
    assert.equal(inferCategory("corn tortillas"), "Bakery");
    assert.equal(inferCategory("small corn tortillas"), "Bakery");
    assert.equal(inferCategory("flour tortilla"), "Bakery");
  });

  it("PRODUCE GUARD: bare corn stays Produce", () => {
    assert.equal(inferCategory("corn"), "Produce");
    assert.equal(inferCategory("sweet corn"), "Produce");
  });

  it("SNACKS GUARD: tortilla chips stay Snacks (Snacks rule fires first)", () => {
    assert.equal(inferCategory("tortilla chips"), "Snacks");
  });
});

describe("inferCategory — BUG-017 consonant+y berries match -ies plurals", () => {
  it("berry plurals → Produce", () => {
    assert.equal(inferCategory("blueberries"), "Produce");
    assert.equal(inferCategory("strawberries"), "Produce");
    assert.equal(inferCategory("raspberries"), "Produce");
    assert.equal(inferCategory("blackberries"), "Produce");
  });

  it("PLURAL GUARD: vowel+y keywords keep their -s plural (turkey → turkeys)", () => {
    assert.equal(inferCategory("turkey"), "Protein");
    assert.equal(inferCategory("turkeys"), "Protein");
    // Regression: -oes irregular plural still works via the (?:es|s)? path.
    assert.equal(inferCategory("tomatoes"), "Produce");
    assert.equal(inferCategory("potatoes"), "Produce");
  });
});

describe("inferCategory — BUG-017 new keyword coverage", () => {
  it("edamame → Produce; frozen edamame → Frozen (Frozen rule wins)", () => {
    assert.equal(inferCategory("edamame"), "Produce");
    assert.equal(inferCategory("cooked edamame"), "Produce");
    assert.equal(inferCategory("frozen edamame"), "Frozen");
  });

  it("pizza dough → Bakery (dough keyword)", () => {
    assert.equal(inferCategory("pizza dough"), "Bakery");
    assert.equal(inferCategory("dough"), "Bakery");
    // GUARD: sourdough is not matched by the \\bdough\\b keyword (stays Bakery
    // anyway via the sourdough keyword — pinned to prove no accidental change).
    assert.equal(inferCategory("sourdough"), "Bakery");
  });

  it("bean sprouts / sprouts → Produce", () => {
    assert.equal(inferCategory("bean sprouts"), "Produce");
    assert.equal(inferCategory("bean sprout"), "Produce");
    assert.equal(inferCategory("sprouts"), "Produce");
  });

  it("san marzano → Canned", () => {
    assert.equal(inferCategory("san marzano"), "Canned");
    assert.equal(inferCategory("san marzano tomatoes"), "Canned");
  });
});

describe("inferCategory — BUG-017 regression pins (must not move)", () => {
  it("holds the existing curated buckets", () => {
    assert.equal(inferCategory("garlic powder"), "Pantry");
    assert.equal(inferCategory("chicken broth"), "Canned");
    assert.equal(inferCategory("vegetable broth"), "Canned");
    assert.equal(inferCategory("chicken breast"), "Protein");
    assert.equal(inferCategory("diced tomatoes"), "Canned");
    assert.equal(inferCategory("pickled jalapeños"), "Canned");
    assert.equal(inferCategory("olive oil"), "Pantry");
    assert.equal(inferCategory("coconut milk"), "Canned");
    assert.equal(inferCategory("milk"), "Dairy");
    assert.equal(inferCategory("eggs"), "Dairy");
    assert.equal(inferCategory("garlic"), "Produce");
    assert.equal(inferCategory("tomato"), "Produce");
  });
});

// ── resolveIngredients — dedup + upsert-shape ──────────────────────────

describe("resolveIngredients — extracted shared upsert path", () => {
  it("dedupes by canonical (lowercase + trim) so one upsert fires per unique name", async () => {
    const { prisma, captured } = makeStubPrisma();
    const ids = await resolveIngredients(prisma, [
      { name: "Chicken Thighs", unit: "lb" },
      { name: "chicken thighs", unit: "lb" },
      { name: "  Chicken Thighs  ", unit: "lb" },
      { name: "Garlic", unit: "clove" },
    ]);
    assert.equal(captured.length, 2, "exactly two upserts — one per canonical");
    assert.equal(ids.size, 2);
    assert.ok(ids.has("chicken thighs"));
    assert.ok(ids.has("garlic"));
  });

  it("writes create with the first-occurrence displayName + inferred category", async () => {
    const { prisma, captured } = makeStubPrisma();
    await resolveIngredients(prisma, [
      { name: "Crushed Tomatoes", unit: "oz" },
      { name: "garlic", unit: "clove" },
    ]);
    const crushed = captured.find((c) => c.canonicalName === "crushed tomatoes");
    assert.ok(crushed, "crushed tomatoes upsert captured");
    assert.equal(crushed.create.displayName, "Crushed Tomatoes");
    assert.equal(crushed.create.category, "Canned");
    assert.equal(crushed.create.defaultUnit, "oz");
    const garlic = captured.find((c) => c.canonicalName === "garlic");
    assert.ok(garlic, "garlic upsert captured");
    assert.equal(garlic.create.category, "Produce");
  });

  it("skips empty / whitespace-only mentions silently (Zod is the boundary)", async () => {
    const { prisma, captured } = makeStubPrisma();
    const ids = await resolveIngredients(prisma, [
      { name: "", unit: "g" },
      { name: "   ", unit: "g" },
      { name: "olive oil", unit: "tbsp" },
    ]);
    assert.equal(captured.length, 1, "only the non-empty mention upserts");
    assert.equal(ids.size, 1);
    assert.ok(ids.has("olive oil"));
  });

  it("uses update: {} so existing rows are never overwritten", async () => {
    const { prisma, captured } = makeStubPrisma();
    await resolveIngredients(prisma, [
      { name: "Garlic", unit: "clove" },
    ]);
    assert.deepEqual(captured[0].update, {});
  });
});

// ── seam: runs against a non-tx PrismaClient ──────────────────────────
// Q3 structural pin: resolveIngredients must NOT require a
// TransactionClient. The wizardActivation Pass 1 / Pass 2 split
// (wizardActivation.ts:285-298) depends on upserts committing outside
// the meal-graph tx so a rollback doesn't lose them; the new
// materializeMeal mirrors that contract. This test proves the helper's
// signature continues to accept the plain client surface.

describe("resolveIngredients — non-tx client contract", () => {
  it("accepts a stub matching the PrismaClient surface (not TransactionClient)", async () => {
    // The stub above is shaped like PrismaClient — only ingredient.upsert.
    // If the helper ever needed something tx-only (e.g. tx.$queryRaw with a
    // tx-bound connection) the cast would compile but the call would error.
    const { prisma } = makeStubPrisma();
    const ids = await resolveIngredients(prisma, [
      { name: "Olive oil", unit: "tbsp" },
    ]);
    assert.equal(ids.size, 1);
  });

  it("transaction-context smoke: calling inside an async fn that simulates the wizard's Pass 1 also works", async () => {
    // Pin the calling convention used by both materializers: build the
    // mentions list synchronously, await the resolver once, then proceed
    // into the meal-graph tx with the returned map. This test stands in
    // for the structural shape of:
    //   const map = await resolveIngredients(prisma, mentions);
    //   await prisma.$transaction(async (tx) => { ... use map ... });
    const { prisma, captured } = makeStubPrisma();
    const passOne = async () =>
      resolveIngredients(prisma, [
        { name: "Chicken thighs", unit: "lb" },
        { name: "Harissa", unit: "tbsp" },
      ]);
    const map = await passOne();
    assert.equal(captured.length, 2);
    assert.equal(map.get("chicken thighs"), "ing-chicken-thighs");
    assert.equal(map.get("harissa"), "ing-harissa");
  });
});
