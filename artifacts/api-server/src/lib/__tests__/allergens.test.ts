// Allergen vocabulary regressions.
//
// Every case below is a MEASURED defect from the 2026-09-04 catalog audit, not a
// hypothetical. The count in each comment is how many public dinners the defect
// affected when it was found. A change that reintroduces one of these turns a
// test red rather than silently mis-stamping the catalog again.
//
// ⚠️ These assertions call the real derivation and compare against literals
// written from the FOOD, not from the vocabulary. Asserting that the vocabulary
// contains "spaghetti" would be true forever and pin nothing; asserting that a
// meal listing "dried spaghetti" comes back carrying `wheat` fails the moment
// the term is dropped, renamed, or disqualified.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveAllergens, deriveAllergensFromNames, stampAllergens } from "../allergens";
import { publishMealToStore } from "../mealFork";

describe("deriveAllergensFromNames — substring false positives (measured 2026-09-04)", () => {
  it("eggplant does NOT stamp egg — 'eggplant'.includes('egg') was true (2 meals)", () => {
    const out = deriveAllergensFromNames(["globe eggplant", "olive oil", "garlic"]);
    // NB: the `includes` checks precede deepEqual on purpose — node:assert/strict
    // declares deepEqual as `asserts actual is T`, so asserting against a literal
    // first narrows `out` to that literal's type and a later .includes() call
    // fails to typecheck against `never`.
    assert.ok(!out.includes("egg"), "eggplant must not stamp egg");
    assert.deepEqual(out, []);
  });

  it("parmigiano-reggiano stamps dairy and NOT egg — 'reggiano' contains 'egg' (29 meals)", () => {
    const out = deriveAllergensFromNames(["parmigiano-reggiano", "olive oil"]);
    assert.deepEqual(out, ["dairy"]);
  });

  it("corn tortillas do NOT stamp wheat — they are masa (82 meals)", () => {
    const out = deriveAllergensFromNames(["corn tortillas", "ground beef (80/20)"]);
    assert.deepEqual(out, []);
  });

  it("rice noodles do NOT stamp wheat (8 meals)", () => {
    const out = deriveAllergensFromNames(["dried flat rice noodles", "bean sprouts"]);
    assert.deepEqual(out, []);
  });

  it("tamarind does NOT stamp soy — 'tamarind'.includes('tamari') was true", () => {
    assert.deepEqual(deriveAllergensFromNames(["tamarind concentrate"]), []);
  });

  it("oyster mushrooms and oyster crackers do NOT stamp shellfish; oyster SAUCE does", () => {
    assert.deepEqual(deriveAllergensFromNames(["oyster mushrooms"]), []);
    assert.deepEqual(deriveAllergensFromNames(["oyster crackers"]), ["wheat"]);
    assert.deepEqual(deriveAllergensFromNames(["oyster sauce"]), ["shellfish"]);
  });

  it("butternut squash and peanut butter do NOT stamp dairy", () => {
    assert.deepEqual(deriveAllergensFromNames(["butternut squash"]), []);
    assert.deepEqual(deriveAllergensFromNames(["creamy peanut butter"]), ["peanut"]);
  });

  it("plant milks do NOT stamp dairy — coconut milk wrongly hit 13 curries", () => {
    // The cost of this one lands on exactly the group the token serves: every
    // affected meal was a Thai or Indian coconut curry, i.e. the dairy-free
    // cuisine. Real dairy names in the same shape must still stamp.
    for (const n of ["coconut milk", "full-fat coconut milk", "light coconut milk", "vegan butter"]) {
      assert.deepEqual(deriveAllergensFromNames([n]), [], `${n} must not stamp dairy`);
    }
    assert.deepEqual(deriveAllergensFromNames(["whole milk"]), ["dairy"]);
    assert.deepEqual(deriveAllergensFromNames(["whole-milk ricotta"]), ["dairy"]);
    assert.deepEqual(deriveAllergensFromNames(["sweetened condensed milk"]), ["dairy"]);
  });
});

describe("deriveAllergensFromNames — vocabulary gaps (measured 2026-09-04)", () => {
  it("farro stamps gluten, not wheat — Gluten-free ⊋ Wheat-free (3 meals passed the filter)", () => {
    assert.deepEqual(deriveAllergensFromNames(["pearled farro", "olive oil"]), ["gluten"]);
    assert.deepEqual(deriveAllergensFromNames(["pearl barley"]), ["gluten"]);
    // Wheat and gluten are separate tokens on purpose: a wheat-avoider may eat
    // barley, a coeliac may not.
    assert.deepEqual(deriveAllergensFromNames(["all-purpose flour"]), ["wheat"]);
  });

  it("crawfish stamps shellfish and NOT fish — it is a crustacean (2 meals)", () => {
    const out = deriveAllergensFromNames(["live or fresh-frozen crawfish"]);
    assert.ok(!out.includes("fish"), "crawfish must not stamp fish");
    assert.deepEqual(out, ["shellfish"]);
  });

  it("catfish STILL stamps fish — the raw-substring carve-out for `fish`", () => {
    // \bfish\b would not match "catfish". This is why `fish` alone stays a raw
    // substring while the other nine tokens use word matching.
    assert.deepEqual(deriveAllergensFromNames(["catfish fillets"]), ["fish"]);
    assert.deepEqual(deriveAllergensFromNames(["fish sauce"]), ["fish"]);
  });

  it("named pasta shapes stamp wheat — `pasta` alone missed 28 meals", () => {
    assert.deepEqual(deriveAllergensFromNames(["dried spaghetti"]), ["wheat"]);
    assert.deepEqual(deriveAllergensFromNames(["dried tagliatelle"]), ["wheat"]);
    assert.deepEqual(deriveAllergensFromNames(["elbow macaroni"]), ["wheat"]);
    assert.deepEqual(deriveAllergensFromNames(["rigatoni"]), ["wheat"]);
    // ...and the bakery class the pasta framing missed entirely.
    assert.deepEqual(deriveAllergensFromNames(["french baguette"]), ["wheat"]);
    assert.deepEqual(deriveAllergensFromNames(["store-bought naan"]), ["wheat"]);
  });

  it("spaghetti squash is a vegetable, not pasta — the trap the shape list creates", () => {
    assert.deepEqual(deriveAllergensFromNames(["spaghetti squash"]), []);
  });

  it("buttermilk still stamps dairy — the compensation for word-matching `butter`", () => {
    // \bbutter\b does not match "buttermilk" and \bmilk\b does not either, so
    // moving to word matching would have DROPPED it without an explicit term.
    assert.deepEqual(deriveAllergensFromNames(["buttermilk"]), ["dairy"]);
  });

  it("bare cheese varietals stamp dairy — `cheese` alone missed 7 meals", () => {
    assert.deepEqual(deriveAllergensFromNames(["sharp cheddar"]), ["dairy"]);
    assert.deepEqual(deriveAllergensFromNames(["smoked gouda"]), ["dairy"]);
    assert.deepEqual(deriveAllergensFromNames(["queso fresco"]), ["dairy"]);
  });

  it("a real measured meal: Classic Spaghetti Carbonara was stamped ['egg'] alone", () => {
    // It was missing BOTH wheat and dairy: `pasta` did not cover "spaghetti" and
    // `parmesan` did not cover "pecorino romano". A dairy-free user could be
    // served carbonara.
    const out = deriveAllergensFromNames([
      "dried spaghetti", "guanciale", "pecorino romano", "large eggs", "black pepper",
    ]);
    assert.deepEqual(out, ["dairy", "egg", "wheat"]);
  });
});

describe("deriveAllergens — payload adapter", () => {
  it("reduces a generated meal's dishes to the same tokens as the name list", () => {
    const meal = {
      dishes: [
        { ingredients: [{ name: "dried spaghetti" }, { name: "pecorino romano" }] },
        { ingredients: [{ name: "large eggs" }] },
      ],
    };
    assert.deepEqual(deriveAllergens(meal), ["dairy", "egg", "wheat"]);
    assert.deepEqual(
      deriveAllergens(meal),
      deriveAllergensFromNames(["dried spaghetti", "pecorino romano", "large eggs"]),
    );
  });
});

// ── the stamping paths ───────────────────────────────────────────────────────

/** Minimal tx stub exposing only what stampAllergens touches. */
function stampTxStub(names: string[], existing: string[] = []) {
  const writes: { id: string; allergens: string[] }[] = [];
  const tx = {
    meal: {
      findUnique: async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "allergens" in args.select) return { allergens: existing };
        return {
          dishLinks: [
            { dish: { dishIngredients: names.map((n) => ({ ingredient: { displayName: n } })) } },
          ],
        };
      },
      update: async (args: { where: { id: string }; data: { allergens: string[] } }) => {
        writes.push({ id: args.where.id, allergens: args.data.allergens });
        return {};
      },
    },
  };
  return { tx, writes };
}

describe("stampAllergens — reads the persisted graph", () => {
  it("derives from ingredient rows and writes the stamp", async () => {
    const { tx, writes } = stampTxStub(["dried spaghetti", "pecorino romano"]);
    const out = await stampAllergens(tx as never, "m1");
    assert.deepEqual(out, ["dairy", "wheat"]);
    assert.deepEqual(writes, [{ id: "m1", allergens: ["dairy", "wheat"] }]);
  });

  it("is idempotent — no UPDATE when the stamp is already correct", async () => {
    const { tx, writes } = stampTxStub(["dried spaghetti"], ["wheat"]);
    const out = await stampAllergens(tx as never, "m1");
    assert.deepEqual(out, ["wheat"]);
    assert.equal(writes.length, 0, "a correct stamp must issue no write");
  });

  it("returns null for a missing meal", async () => {
    const tx = { meal: { findUnique: async () => null } };
    assert.equal(await stampAllergens(tx as never, "ghost"), null);
  });
});

describe("publishMealToStore — the write-back path stamps (the six-week hole)", () => {
  it("stamps the CLONE from its own graph, not by copying the source's empty array", async () => {
    // Every live_writeback meal in the pool carried allergens:[] because the
    // clone copied `tags` and macros but never allergens, and the source it
    // clones from is itself unstamped. Under the conservative retrieval rule an
    // unstamped meal is excluded, so all 55 were invisible to every allergic
    // user — and it was the only growing source in the catalog.
    const source = {
      id: "src-meal", title: "Carbonara", displayTitle: null, description: null,
      mealType: "dinner", sourceType: "wizard", cuisineType: "Italian",
      difficulty: "medium", estimatedTimeMinutes: 30, imageUrl: null,
      servingsDefault: 4, authoredServingsDefault: 4, tags: [],
      allergens: [], // <- the source is unstamped; copying would propagate []
      caloriesPerServing: null, proteinGPerServing: null,
      carbsGPerServing: null, fatGPerServing: null,
      dishLinks: [
        {
          positionIndex: 0,
          dish: {
            id: "src-dish-0", title: "Carbonara", description: null,
            cuisineType: "Italian", estimatedPrepMinutes: 5,
            estimatedCookMinutes: 20, servingsDefault: 4, isPublic: false,
            sourceType: "wizard", imageUrl: null, tags: [], substitutions: null,
            componentRegistry: null,
            dishIngredients: [
              { ingredientId: "i1", quantity: 1, unit: "pound", preparationNote: null, isOptional: false, positionIndex: 0, componentKey: null, pathKey: null },
              { ingredientId: "i2", quantity: 1, unit: "cup", preparationNote: null, isOptional: false, positionIndex: 1, componentKey: null, pathKey: null },
            ],
          },
        },
      ],
    };
    const stamped: string[][] = [];
    let cloned = false;
    const tx = {
      userPreferences: { findUnique: async () => ({ householdSize: 2 }) },
      meal: {
        findUnique: async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
          if (args.where.id === "src-meal") return source;
          // the CLONE's graph — the ingredient rows resolve to real names
          if (args.select && "allergens" in args.select) return { allergens: [] };
          return {
            dishLinks: [
              { dish: { dishIngredients: [
                { ingredient: { displayName: "dried spaghetti" } },
                { ingredient: { displayName: "pecorino romano" } },
              ] } },
            ],
          };
        },
        create: async () => { cloned = true; return { id: "new-meal" }; },
        update: async (args: { data: { allergens: string[] } }) => {
          stamped.push(args.data.allergens);
          return {};
        },
      },
      dish: { create: async () => ({ id: "new-dish-1" }) },
      mealDishLink: { create: async () => ({ id: "link" }) },
      dishIngredient: { createMany: async () => ({ count: 2 }) },
      recipeInstructionStep: { findMany: async () => [], createMany: async () => ({ count: 0 }) },
    };

    const out = await publishMealToStore(tx as never, "src-meal");

    assert.equal(cloned, true, "the clone still happens");
    assert.equal(out.mealId, "new-meal");
    assert.deepEqual(stamped, [["dairy", "wheat"]], "the published pool copy is stamped");
  });
});
