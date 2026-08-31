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

interface StubOpts {
  /** canonicalName -> id. Rows that ALREADY exist; the resolver must not upsert these. */
  existing?: Record<string, string>;
  /** aliasKey -> canonicalName of the owning row (which must be in `existing`). */
  aliases?: Record<string, string>;
  /** ids whose nutritionRefPerUnit is SQL NULL (enrichment candidates). */
  nullNutrition?: string[];
}

// WS9 BUG-096 — the stub grew a real catalog.
//
// FIXTURE STRENGTH (§27.4): the pre-BUG-096 stub returned `{ id }` from upsert
// and nothing else, so `upserted.nutritionRefPerUnit === null` was
// `undefined === null` — FALSE — and the USDA enrichment branch could never
// fire in ANY test. That is a fake too weak to express the failure it was
// nominally covering. It now returns the field, models the alias table, and
// records every call so ordering can be asserted.
function makeStubPrisma(opts: StubOpts = {}): {
  prisma: PrismaClient;
  captured: CapturedUpsert[];
  calls: string[];
} {
  const captured: CapturedUpsert[] = [];
  const calls: string[] = [];
  const existing = opts.existing ?? {};
  const aliases = opts.aliases ?? {};
  const nullNutrition = new Set(opts.nullNutrition ?? []);
  const idFor = (canonicalName: string) =>
    existing[canonicalName] ?? `ing-${canonicalName.replace(/\s+/g, "-")}`;

  const stub = {
    ingredient: {
      findMany: async (args: {
        where: { canonicalName?: { in: string[] }; id?: { in: string[] } };
      }) => {
        calls.push("ingredient.findMany");
        if (args.where.canonicalName) {
          return args.where.canonicalName.in
            .filter((n) => n in existing)
            .map((n) => ({ id: existing[n], canonicalName: n }));
        }
        const wanted = args.where.id?.in ?? [];
        const byId = new Map(Object.entries(existing).map(([n, id]) => [id, n]));
        return wanted
          .filter((id) => byId.has(id))
          .map((id) => ({
            id,
            canonicalName: byId.get(id)!,
            nutritionRefPerUnit: nullNutrition.has(id) ? null : { source: "usda", matched: false },
          }));
      },
      upsert: async (args: {
        where: { canonicalName: string };
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        calls.push("ingredient.upsert");
        captured.push({
          canonicalName: args.where.canonicalName,
          create: args.create,
          update: args.update,
        });
        const id = idFor(args.where.canonicalName);
        // Real Prisma returns every column in `select`. Returning it is what
        // lets the enrichment branch be observable at all.
        // A non-null ref means "already enriched" — the USDA fire-and-forget
        // stays quiet, which is what every test here wants. Tests that need the
        // enrichment branch opt in via `nullNutrition`.
        return { id, nutritionRefPerUnit: nullNutrition.has(id) ? null : { source: "usda", matched: false } };
      },
    },
    ingredientAlias: {
      findMany: async (args: { where: { aliasKey: { in: string[] } } }) => {
        calls.push("ingredientAlias.findMany");
        return args.where.aliasKey.in
          .filter((k) => k in aliases)
          .map((k) => ({
            aliasKey: k,
            ingredient: { id: existing[aliases[k]], canonicalName: aliases[k] },
          }));
      },
    },
  };
  return { prisma: stub as unknown as PrismaClient, captured, calls };
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

// ── WS9 BUG-096 — alias awareness on the CREATING path ─────────────────
// This is the half that makes the 81-pair merge durable. Without it the
// resolver upserts "roma tomatoes" straight back into existence the next
// time a dish mentions it, and the merge is a one-time cleanup.

describe("resolveIngredients — alias awareness (BUG-096)", () => {
  it("a merged-away name resolves to the survivor and DOES NOT create a row", async () => {
    const { prisma, captured } = makeStubPrisma({
      existing: { "roma tomatoes": "ing-survivor" },
      aliases: { "roma tomato": "roma tomatoes" },
    });
    const ids = await resolveIngredients(prisma, [{ name: "Roma tomato", unit: "each" }]);
    assert.equal(captured.length, 0, "NO upsert may fire — that is the re-accumulation bug");
    assert.equal(ids.get("roma tomato"), "ing-survivor");
  });

  it("keys the returned map by the MENTION's canonical form, not the survivor's", async () => {
    // mealMaterialize.ts:392 and friends look up by
    // `ing.name.toLowerCase().trim()`. Re-keying would break every caller.
    const { prisma } = makeStubPrisma({
      existing: { "roma tomatoes": "ing-survivor" },
      aliases: { "roma tomato": "roma tomatoes" },
    });
    const ids = await resolveIngredients(prisma, [{ name: "Roma tomato", unit: "each" }]);
    assert.ok(ids.has("roma tomato"));
    assert.ok(!ids.has("roma tomatoes"));
  });

  it("a genuinely new name still upserts — the alias step is additive only", async () => {
    const { prisma, captured } = makeStubPrisma({
      existing: { "roma tomatoes": "ing-survivor" },
      aliases: { "roma tomato": "roma tomatoes" },
    });
    await resolveIngredients(prisma, [
      { name: "Roma tomato", unit: "each" },
      { name: "Dragonfruit", unit: "each" },
    ]);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].canonicalName, "dragonfruit");
  });

  it("canonical beats alias: a name that is BOTH resolves to its own row", async () => {
    const { prisma, captured } = makeStubPrisma({
      existing: { apple: "ing-apple", apples: "ing-apples" },
      aliases: { apples: "apple" },
    });
    const ids = await resolveIngredients(prisma, [{ name: "apples", unit: "each" }]);
    assert.equal(ids.get("apples"), "ing-apples", "the canonical row must win over the alias");
    assert.equal(captured.length, 0);
  });

  it("builds the enrich-candidate list FROM THE ROWS, not from the mentions", async () => {
    // With alias resolution a mention of "roma tomato" lands on the "roma
    // tomatoes" row; searching USDA for the mention would search the wrong
    // string, so the enrich list is re-read from the resolved rows. Observable
    // as a SECOND ingredient.findMany — a branch the pre-BUG-096 stub could not
    // reach at all, because its upsert returned no nutritionRefPerUnit field.
    //
    // NOT asserted here: the canonicalName actually handed to enrichIngredients.
    // That module is imported directly with no DI seam, so observing its
    // arguments would mean firing a real USDA request from a unit test. The
    // seam is worth adding; it is logged rather than faked (D-WS7-218).
    const { prisma, calls } = makeStubPrisma({
      existing: { "roma tomatoes": "ing-survivor" },
      aliases: { "roma tomato": "roma tomatoes" },
    });
    await resolveIngredients(prisma, [{ name: "Roma tomato", unit: "each" }]);
    assert.ok(
      calls.filter((c) => c === "ingredient.findMany").length === 2,
      `expected a canonical lookup + an enrich-candidate lookup; calls were ${calls.join(",")}`,
    );
  });

  it("still issues exactly one upsert per unique canonical when nothing pre-exists", async () => {
    const { prisma, captured } = makeStubPrisma();
    await resolveIngredients(prisma, [
      { name: "Chicken Thighs", unit: "lb" },
      { name: "chicken thighs", unit: "lb" },
      { name: "Garlic", unit: "clove" },
    ]);
    assert.equal(captured.length, 2);
  });
});

// ── WS9 BUG-191 ─────────────────────────────────────────────────────────────
//
// Each cluster below is a case that FAILED before BUG-191 and is the direct
// cause of a BUG-186 mis-filed aisle. See ingredientResolve.ts for the rules.
describe("inferCategory — BUG-191 cheeses without a 'cheese' token", () => {
  it("routes Italian/Spanish/Indian cheese names to Dairy, not the Pantry fallback", () => {
    // Was "Pantry" (INGREDIENT_CATEGORY_FALLBACK — matched no rule at all).
    assert.equal(inferCategory("parmigiano-reggiano"), "Dairy");
    assert.equal(inferCategory("pecorino romano"), "Dairy");
    assert.equal(inferCategory("queso fresco"), "Dairy");
    assert.equal(inferCategory("paneer"), "Dairy");
    assert.equal(inferCategory("fontina"), "Dairy");
    assert.equal(inferCategory("gorgonzola dolce"), "Dairy");
    assert.equal(inferCategory("cotija cheese"), "Dairy");
    assert.equal(inferCategory("shaved parmigiano-reggiano"), "Dairy");
  });

  it("does not sweep in non-cheese names that merely look similar", () => {
    assert.equal(inferCategory("roma tomatoes"), "Produce");
    assert.equal(inferCategory("romaine lettuce"), "Produce");
  });
});

describe("inferCategory — BUG-191 egg PASTA is Pantry, not Dairy", () => {
  it("beats the bare 'egg' Dairy keyword on every spelling", () => {
    // All four were "Dairy" — the collision that mis-filed them (BUG-186).
    assert.equal(inferCategory("wide egg noodles"), "Pantry");
    assert.equal(inferCategory("egg noodles"), "Pantry");
    assert.equal(inferCategory("fresh chow mein egg noodles"), "Pantry");
    assert.equal(inferCategory("fresh lo mein egg noodles"), "Pantry");
  });

  it("leaves real eggs in Dairy", () => {
    assert.equal(inferCategory("large eggs"), "Dairy");
    assert.equal(inferCategory("egg"), "Dairy");
    assert.equal(inferCategory("egg yolks"), "Dairy");
    assert.equal(inferCategory("hard-boiled eggs"), "Dairy");
  });

  it("leaves egg-free noodles on their existing Pantry fallback", () => {
    assert.equal(inferCategory("fresh lo mein noodles"), "Pantry");
  });
});

describe("inferCategory — BUG-191 tofu routes to Dairy", () => {
  it("moves tofu out of Protein per the BUG-186 ruling", () => {
    assert.equal(inferCategory("extra-firm tofu"), "Dairy");
    assert.equal(inferCategory("firm tofu"), "Dairy");
    assert.equal(inferCategory("silken tofu"), "Dairy");
  });

  it("leaves the un-ruled plant proteins in Protein", () => {
    assert.equal(inferCategory("tempeh"), "Protein");
    assert.equal(inferCategory("seitan"), "Protein");
  });
});
