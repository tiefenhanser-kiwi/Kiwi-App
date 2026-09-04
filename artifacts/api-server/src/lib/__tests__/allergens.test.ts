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

import {
  deriveAllergens,
  deriveAllergensFromNames,
  deriveAllergensWithSources,
  stampAllergens,
} from "../allergens";
import { publishMealToStore } from "../mealFork";

// ── D-WS9-214: the PROCESSED-PRODUCT class ───────────────────────────────────
//
// Every defect below is one shape: an ingredient made OF an allergen whose name
// contains no allergen word. The previous two rounds fixed words-in-the-name
// (`parmigiano` contains no "cheese"; `rigatoni` contains no "pasta"). These
// are not that — no amount of widening `egg` reaches `Mayonnaise` — which is
// why they were invisible to three rounds of vocabulary work and why the
// option-(c) model ceiling exists for the ones a word list cannot enumerate.
//
// ⚠️ Counts are MEASURED public dinners as of 2026-09-04, not estimates.
describe("deriveAllergensFromNames — processed products (measured 2026-09-04)", () => {
  it("mayonnaise stamps egg — 136 meals carried it with NO egg stamp", () => {
    const out = deriveAllergensFromNames(["Mayonnaise", "green cabbage", "Carrots"]);
    assert.ok(out.includes("egg"), "mayonnaise is egg");
    // And it is NOT dairy. Ruled explicitly: mayonnaise is oil and yolk.
    assert.ok(!out.includes("dairy"), "mayonnaise must not stamp dairy");
    assert.deepEqual(out, ["egg"]);
  });

  it("bare 'mayo' stamps egg too — the catalog has 'Greek yogurt or mayo'", () => {
    const out = deriveAllergensFromNames(["Greek yogurt or mayo"]);
    // Both, from one name: the yogurt half is dairy and the mayo half is egg.
    assert.deepEqual(out, ["dairy", "egg"]);
  });

  it("pizza dough stamps wheat — TWO PIZZAS WERE ON A LIVE GLUTEN-FREE SHELF", () => {
    // `Margherita Pizza Night` and `Sausage, Pepper, and Onion Pizza` both
    // reached a coeliac's shortlist: the vocabulary had `flour`, `bread` and
    // every pasta shape, but never the word for raw dough.
    assert.ok(deriveAllergensFromNames(["store-bought pizza dough"]).includes("wheat"));
    assert.ok(deriveAllergensFromNames(["Pizza dough"]).includes("wheat"));
    assert.ok(deriveAllergensFromNames(["refrigerated pie dough rounds"]).includes("wheat"));
  });

  it("brioche stamps egg AND dairy AND wheat — one ingredient, three allergens", () => {
    // ⚠️ Not a duplication to tidy up. Brioche is enriched dough: butter and egg
    // in a wheat bread. Egg and dairy are separate allergens and stay separate.
    const out = deriveAllergensFromNames(["brioche burger buns"]);
    assert.ok(out.includes("egg"), "brioche is egg");
    assert.ok(out.includes("dairy"), "brioche is dairy");
    assert.ok(out.includes("wheat"), "brioche is wheat");
  });

  it("beer stamps gluten and NOT wheat — barley, and the two chips differ", () => {
    // A coeliac must not be served it; someone merely avoiding wheat may drink
    // it. Folding beer into `wheat` would lose that distinction, which is the
    // entire reason the two tokens exist.
    const out = deriveAllergensFromNames(["lager beer"]);
    assert.ok(out.includes("gluten"), "beer is gluten");
    assert.ok(!out.includes("wheat"), "beer is barley, not wheat");
    assert.ok(deriveAllergensFromNames(["Guinness stout"]).includes("gluten"));
  });

  it("kale and guanciale never stamp gluten — the raw-mode trap for beer words", () => {
    // ⚠️ THIS TEST WAS ONCE VACUOUS AND THE BREAK-IT PASS IS WHAT CAUGHT IT.
    // It was written believing \bale\b matches `guanciale` and `Kale`, so that
    // adding `ale` to the gluten terms would turn it red. Adding `ale` left it
    // GREEN: word mode anchors both ends and the preceding letter is a word
    // character, so no boundary exists. The assertion was true for a reason
    // unrelated to what it claimed to guard.
    //
    // It is kept, rewritten, because the danger is real one layer down: the
    // `fish` token already uses `mode: "raw"`, so switching a token to raw
    // substring matching is an established move in this file — and under raw
    // mode a beer word list WOULD swallow all four of these real catalog names.
    // That is what this now pins. Verified red by flipping `gluten` to
    // `mode: "raw"`.
    for (const n of ["guanciale", "Kale", "lacinato kale", "curly kale", "fresh lacinato kale"]) {
      assert.ok(
        !deriveAllergensFromNames([n]).includes("gluten"),
        `${n} must not stamp gluten`,
      );
    }
  });

  it("root beer and ginger beer are sodas — the guard holds", () => {
    assert.deepEqual(deriveAllergensFromNames(["root beer"]), []);
    assert.deepEqual(deriveAllergensFromNames(["ginger beer"]), []);
  });

  it("teriyaki and hoisin stamp BOTH soy and wheat — they are soy sauce", () => {
    // Not a new product-knowledge claim: `soy sauce -> wheat` already shipped.
    // `Teriyaki sauce` previously derived NOTHING AT ALL.
    assert.deepEqual(deriveAllergensFromNames(["Teriyaki sauce"]), ["soy", "wheat"]);
    assert.deepEqual(deriveAllergensFromNames(["hoisin sauce"]), ["soy", "wheat"]);
  });

  it("the remaining measured gaps: cream soups, hummus, dashi, pesto, roti", () => {
    assert.ok(deriveAllergensFromNames(["condensed cream of mushroom soup"]).includes("wheat"));
    assert.ok(deriveAllergensFromNames(["store-bought hummus"]).includes("sesame"));
    assert.ok(deriveAllergensFromNames(["dashi powder"]).includes("fish"));
    assert.ok(deriveAllergensFromNames(["basil pesto"]).includes("tree_nut"));
    assert.ok(deriveAllergensFromNames(["frozen roti paratha"]).includes("wheat"));
    assert.ok(deriveAllergensFromNames(["au jus gravy mix"]).includes("wheat"));
    assert.ok(deriveAllergensFromNames(["frozen potato and cheese pierogis"]).includes("wheat"));
  });

  it("the new terms did not break the old false-positive guards", () => {
    // `dough` must not reach a gluten-free dough; `mayo` must not reach a vegan
    // one. Both guards are removal-direction rules and worth pinning.
    assert.ok(!deriveAllergensFromNames(["gluten-free pizza dough"]).includes("wheat"));
    assert.ok(!deriveAllergensFromNames(["vegan mayonnaise"]).includes("egg"));
  });
});

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

interface StampWrite {
  id: string;
  allergens: string[];
  allergenSources: Record<string, string[]>;
  allergensStampedAt: Date;
}

/** Minimal tx stub exposing only what stampAllergens touches. */
function stampTxStub(
  names: string[],
  existing: string[] = [],
  // D-WS9-214 — the stored METADATA, which the skip now also consults. Defaults
  // to the pre-D-WS9-214 shape (no timestamp, no sources).
  meta: { stampedAt?: Date | null; sources?: Record<string, string[]> | null } = {},
) {
  const writes: StampWrite[] = [];
  const tx = {
    meal: {
      findUnique: async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "allergens" in args.select) {
          return {
            allergens: existing,
            allergenSources: meta.sources ?? null,
            allergensStampedAt: meta.stampedAt ?? null,
          };
        }
        return {
          dishLinks: [
            { dish: { dishIngredients: names.map((n) => ({ ingredient: { displayName: n } })) } },
          ],
        };
      },
      update: async (args: { where: { id: string }; data: Omit<StampWrite, "id"> }) => {
        writes.push({ id: args.where.id, ...args.data });
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
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, "m1");
    assert.deepEqual(writes[0].allergens, ["dairy", "wheat"]);
  });

  it("is idempotent — no UPDATE when the stamp AND its metadata are already correct", async () => {
    // D-WS9-214 — the skip now requires all three to match. Reproducing the
    // sources here from the real derivation rather than hand-writing the map is
    // the point: a hand-written literal would still pass if the derivation
    // stopped recording provenance.
    const names = ["dried spaghetti"];
    const { sources } = deriveAllergensWithSources(names);
    const { tx, writes } = stampTxStub(names, ["wheat"], {
      stampedAt: new Date("2026-09-04T00:00:00Z"),
      sources,
    });
    const out = await stampAllergens(tx as never, "m1");
    assert.deepEqual(out, ["wheat"]);
    assert.equal(writes.length, 0, "a correct stamp must issue no write");
  });

  it("re-stamps a row whose TOKENS are right but which has no stamp timestamp", async () => {
    // The whole pre-D-WS9-214 catalog is in this state: correct tokens, NULL
    // metadata. Skipping it would leave `allergensStampedAt` null forever, and
    // the filter clause now excludes exactly those rows — so the "already
    // correct, nothing to do" shortcut would have made every stamped meal in
    // the pool invisible.
    const { tx, writes } = stampTxStub(["dried spaghetti"], ["wheat"], { stampedAt: null });
    await stampAllergens(tx as never, "m1");
    assert.equal(writes.length, 1, "a null stampedAt must defeat the skip");
    assert.ok(writes[0].allergensStampedAt instanceof Date);
  });

  it("force re-stamps an already-correct row, refreshing the timestamp", async () => {
    // What the batch pass uses. Without it the timestamp means "when the stamp
    // last CHANGED", so a row re-verified unchanged under a new vocabulary keeps
    // its old date and a "re-stamp everything older than X" sweep never
    // converges.
    const names = ["dried spaghetti"];
    const { sources } = deriveAllergensWithSources(names);
    const old = new Date("2026-01-01T00:00:00Z");
    const { tx, writes } = stampTxStub(names, ["wheat"], { stampedAt: old, sources });
    await stampAllergens(tx as never, "m1", { force: true });
    assert.equal(writes.length, 1, "force must write even when nothing changed");
    assert.ok(
      writes[0].allergensStampedAt.getTime() > old.getTime(),
      "force must move the timestamp forward",
    );
  });

  it("records PROVENANCE — which ingredient caused which token", async () => {
    const { tx, writes } = stampTxStub([
      "store-bought pizza dough",
      "fresh mozzarella",
      "Mayonnaise",
    ]);
    await stampAllergens(tx as never, "m1");
    const src = writes[0].allergenSources;
    // Read the live value; do not restate the map as a literal.
    assert.deepEqual(Object.keys(src).sort(), writes[0].allergens);
    assert.deepEqual(src.wheat, ["store-bought pizza dough"]);
    assert.deepEqual(src.dairy, ["fresh mozzarella"]);
    assert.deepEqual(src.egg, ["Mayonnaise"]);
  });

  it("provenance records EVERY cause of a token, not just the first", async () => {
    // The token-only derivation may stop testing a token once anything has
    // matched it. If deriveAllergensWithSources inherited that short-circuit,
    // "which ingredients make this wheat" would answer with one of three.
    const { sources, tokens } = deriveAllergensWithSources([
      "dried spaghetti",
      "store-bought pizza dough",
      "panko breadcrumbs",
    ]);
    assert.deepEqual(tokens, ["wheat"]);
    assert.equal(sources.wheat.length, 3, "all three causes must be recorded");
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
