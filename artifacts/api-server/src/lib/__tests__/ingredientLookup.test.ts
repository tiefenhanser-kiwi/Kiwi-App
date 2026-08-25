// WS9 BUG-096 (D-WS9-174) — guards for the shared alias-aware lookup.
//
// THE GUARD THAT MATTERS is "a merged-away name still resolves, via its alias,
// to the survivor". Without it the 81-pair merge is a one-time cleanup and the
// catalog re-accumulates duplicates exactly the way it did the first time.
//
// FIXTURE STRENGTH (§27.4). The stub below is a real in-memory catalog, not a
// canned return value:
//   • `ingredient.findFirst` actually filters, and honours
//     `mode: "insensitive"` — so the mealCreate path is genuinely exercised
//     rather than being handed whatever the first row is.
//   • `ingredientAlias.findUnique` enforces the UNIQUE on aliasKey by
//     construction (Map keyed by aliasKey), and the seeding helper THROWS a
//     P2002-shaped error on a duplicate — so the ambiguity test observes the
//     real failure mode instead of a hand-waved one.
//   • Every query is recorded, so "canonical beat alias" is asserted by the
//     alias table never being consulted, not merely by the returned id.
// A stub that returned a fixed row would satisfy both the right and the wrong
// implementation, which is the exact fixture failure this project has paid for.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  lookupIngredientByName,
  lookupIngredientsByName,
  normalizeAliasKey,
} from "../ingredientLookup";

interface StubIngredient {
  id: string;
  canonicalName: string;
}

class StubUniqueViolation extends Error {
  code = "P2002";
  meta = { target: ["aliasKey"] };
  constructor(aliasKey: string) {
    super(`Unique constraint failed on the fields: (\`aliasKey\`) — "${aliasKey}"`);
    this.name = "PrismaClientKnownRequestError";
  }
}

function makeCatalog(
  ingredients: StubIngredient[],
  aliasPairs: Array<[alias: string, canonicalName: string]>,
) {
  const calls: string[] = [];
  const aliasByKey = new Map<string, { alias: string; ingredient: StubIngredient }>();

  // Enforce the unique index the migration creates. Seeding two rows with the
  // same aliasKey raises here, which is what the real DB does at write time.
  for (const [alias, canonicalName] of aliasPairs) {
    const key = normalizeAliasKey(alias);
    if (aliasByKey.has(key)) throw new StubUniqueViolation(key);
    const ing = ingredients.find((i) => i.canonicalName === canonicalName);
    assert.ok(ing, `alias fixture names a missing ingredient: ${canonicalName}`);
    aliasByKey.set(key, { alias, ingredient: ing });
  }

  const stub = {
    ingredient: {
      findFirst: async (args: {
        where: { canonicalName: string | { equals: string; mode?: string } };
      }) => {
        calls.push("ingredient.findFirst");
        const w = args.where.canonicalName;
        if (typeof w === "string") {
          return ingredients.find((i) => i.canonicalName === w) ?? null;
        }
        if (w.mode === "insensitive") {
          const needle = w.equals.toLowerCase();
          return ingredients.find((i) => i.canonicalName.toLowerCase() === needle) ?? null;
        }
        return ingredients.find((i) => i.canonicalName === w.equals) ?? null;
      },
      findMany: async (args: { where: { canonicalName: { in: string[] } } }) => {
        calls.push("ingredient.findMany");
        const want = new Set(args.where.canonicalName.in);
        return ingredients.filter((i) => want.has(i.canonicalName));
      },
    },
    ingredientAlias: {
      findUnique: async (args: { where: { aliasKey: string } }) => {
        calls.push("ingredientAlias.findUnique");
        const hit = aliasByKey.get(args.where.aliasKey);
        return hit ? { ingredient: hit.ingredient } : null;
      },
      findMany: async (args: { where: { aliasKey: { in: string[] } } }) => {
        calls.push("ingredientAlias.findMany");
        return args.where.aliasKey.in
          .map((k) => {
            const hit = aliasByKey.get(k);
            return hit ? { aliasKey: k, ingredient: hit.ingredient } : null;
          })
          .filter((x): x is { aliasKey: string; ingredient: StubIngredient } => x !== null);
      },
    },
  };
  return { prisma: stub as unknown as PrismaClient, calls, seedAlias: (alias: string, canonicalName: string) => {
    const key = normalizeAliasKey(alias);
    if (aliasByKey.has(key)) throw new StubUniqueViolation(key);
    const ing = ingredients.find((i) => i.canonicalName === canonicalName)!;
    aliasByKey.set(key, { alias, ingredient: ing });
  } };
}

// The post-merge catalog shape: the survivor row exists, the loser does NOT,
// and the loser's name is an alias on the survivor.
function postMergeCatalog() {
  return makeCatalog(
    [
      { id: "ing-roma-tomatoes", canonicalName: "roma tomatoes" },
      { id: "ing-apple", canonicalName: "apple" },
      { id: "ing-apples-basket", canonicalName: "apples basket" },
    ],
    [
      ["roma tomato", "roma tomatoes"],
      ["apples", "apple"],
    ],
  );
}

describe("normalizeAliasKey", () => {
  it("lower-cases, collapses whitespace runs, and trims", () => {
    assert.equal(normalizeAliasKey("Roma  Tomato"), "roma tomato");
    assert.equal(normalizeAliasKey("  GARLIC\tCLOVE \n"), "garlic clove");
    assert.equal(normalizeAliasKey("egg"), "egg");
  });

  it("does NOT strip a leading article — that is grocery prose, not identity", () => {
    // normalizeIngredientName strips "the "/"a ". Baking that into the alias key
    // would make "the salt" and "salt" collide and raise P2002 on a pair that is
    // not actually ambiguous.
    assert.equal(normalizeAliasKey("the salt"), "the salt");
    assert.notEqual(normalizeAliasKey("the salt"), normalizeAliasKey("salt"));
  });
});

describe("lookupIngredientByName — alias awareness (BUG-096 durability guard)", () => {
  it("a merged-away name resolves to the SURVIVOR via its alias", async () => {
    const { prisma } = postMergeCatalog();
    const hit = await lookupIngredientByName(prisma, "roma tomato");
    assert.ok(hit, "roma tomato must still resolve after the merge");
    assert.equal(hit.id, "ing-roma-tomatoes");
    assert.equal(hit.canonicalName, "roma tomatoes");
    assert.equal(hit.matchedVia, "alias");
  });

  it("an unknown name still misses — the fallback is additive, not fuzzy", async () => {
    const { prisma } = postMergeCatalog();
    assert.equal(await lookupIngredientByName(prisma, "dragonfruit"), null);
  });

  it("canonical BEATS alias, and the alias table is never even consulted", async () => {
    // "apples" is BOTH an alias of "apple" AND the prefix of a different real
    // row. The ruled precedence is canonical-first; this asserts the mechanism
    // (no alias query at all), not just the answer.
    const { prisma, calls } = makeCatalog(
      [
        { id: "ing-apple", canonicalName: "apple" },
        { id: "ing-apples", canonicalName: "apples" },
      ],
      [["apples", "apple"]],
    );
    const hit = await lookupIngredientByName(prisma, "apples");
    assert.equal(hit?.id, "ing-apples", "the canonical row must win");
    assert.equal(hit?.matchedVia, "canonical");
    assert.ok(
      !calls.includes("ingredientAlias.findUnique"),
      `alias table must not be queried on a canonical hit; calls were ${calls.join(",")}`,
    );
  });

  it("the alias key is normalized, so casing/whitespace drift still resolves", async () => {
    const { prisma } = postMergeCatalog();
    const hit = await lookupIngredientByName(prisma, "no-such-canonical", "  Roma   Tomato ");
    assert.equal(hit?.id, "ing-roma-tomatoes");
  });

  it("caseInsensitivePrimary (the mealCreate path) matches canonical case-blind", async () => {
    const { prisma, calls } = postMergeCatalog();
    const hit = await lookupIngredientByName(prisma, "ROMA TOMATOES", "ROMA TOMATOES", {
      caseInsensitivePrimary: true,
    });
    assert.equal(hit?.id, "ing-roma-tomatoes");
    assert.equal(hit?.matchedVia, "canonical");
    assert.ok(!calls.includes("ingredientAlias.findUnique"));
  });

  it("an empty raw name cannot alias-match everything", async () => {
    const { prisma } = postMergeCatalog();
    assert.equal(await lookupIngredientByName(prisma, "", ""), null);
  });
});

describe("ambiguity — the unique index is what makes a collision RAISE", () => {
  it("two ingredients claiming one alias throws P2002 rather than picking", () => {
    // Ruling 2: a collision must raise, not silently resolve. Enforced by the
    // UNIQUE on ingredient_aliases.aliasKey; the stub models that index.
    assert.throws(
      () =>
        makeCatalog(
          [
            { id: "ing-a", canonicalName: "scallions" },
            { id: "ing-b", canonicalName: "green onions" },
          ],
          [
            ["spring onion", "scallions"],
            ["spring onion", "green onions"],
          ],
        ),
      (err: unknown) => (err as { code?: string }).code === "P2002",
      "a duplicate aliasKey must raise P2002",
    );
  });

  it("the collision is on the NORMALIZED key, not the raw string", () => {
    assert.throws(
      () =>
        makeCatalog(
          [
            { id: "ing-a", canonicalName: "scallions" },
            { id: "ing-b", canonicalName: "green onions" },
          ],
          [
            ["Spring Onion", "scallions"],
            ["  spring   onion  ", "green onions"],
          ],
        ),
      (err: unknown) => (err as { code?: string }).code === "P2002",
    );
  });

  it("an alias that is ALSO another row's canonicalName is legal (20 exist today)", () => {
    // Precedence is canonical-beats-alias, so this overlap is unambiguous. A
    // constraint spanning canonical ∪ alias would have failed on 20 live rows.
    assert.doesNotThrow(() =>
      makeCatalog(
        [
          { id: "ing-kosher-salt", canonicalName: "kosher salt" },
          { id: "ing-salt", canonicalName: "salt" },
        ],
        [["salt", "kosher salt"]],
      ),
    );
  });
});

describe("lookupIngredientsByName — batch", () => {
  it("keys the result by the CALLER's primary key, never the survivor's name", async () => {
    // Consumers look the map up by `ing.name.toLowerCase().trim()`
    // (mealMaterialize.ts:392 et al). Alias-awareness must change the VALUE,
    // never the KEY, or every caller breaks.
    const { prisma } = postMergeCatalog();
    const map = await lookupIngredientsByName(prisma, [
      { primaryKey: "roma tomato", rawName: "Roma tomato" },
      { primaryKey: "apple", rawName: "Apple" },
    ]);
    assert.ok(map.has("roma tomato"), "keyed by the mention's own form");
    assert.ok(!map.has("roma tomatoes"), "must NOT be re-keyed to the survivor");
    assert.equal(map.get("roma tomato")?.id, "ing-roma-tomatoes");
    assert.equal(map.get("roma tomato")?.matchedVia, "alias");
    assert.equal(map.get("apple")?.matchedVia, "canonical");
  });

  it("omits genuine misses so the caller can still create them", async () => {
    const { prisma } = postMergeCatalog();
    const map = await lookupIngredientsByName(prisma, [
      { primaryKey: "roma tomato", rawName: "roma tomato" },
      { primaryKey: "dragonfruit", rawName: "dragonfruit" },
    ]);
    assert.equal(map.size, 1);
    assert.ok(!map.has("dragonfruit"));
  });

  it("runs two queries regardless of input size", async () => {
    const { prisma, calls } = postMergeCatalog();
    await lookupIngredientsByName(
      prisma,
      Array.from({ length: 50 }, (_, i) => ({ primaryKey: `x${i}`, rawName: `x${i}` })).concat([
        { primaryKey: "roma tomato", rawName: "roma tomato" },
      ]),
    );
    assert.equal(calls.filter((c) => c.startsWith("ingredient.")).length, 1);
    assert.equal(calls.filter((c) => c.startsWith("ingredientAlias.")).length, 1);
  });

  it("skips the alias query entirely when every name hit canonically", async () => {
    const { prisma, calls } = postMergeCatalog();
    await lookupIngredientsByName(prisma, [{ primaryKey: "apple", rawName: "apple" }]);
    assert.ok(!calls.some((c) => c.startsWith("ingredientAlias.")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WS9 BUG-135 — the shadowing-pair resolver guard.
//
// ⚠️ THE ASSERTION THIS BLOCK DELIBERATELY DOES NOT MAKE: "no aliasKey may
// equal any canonicalName". That is the INVERSE of a standing ruling. Both
// ingredientLookup.ts and schema.prisma declare such pairs legal and
// deliberate, and 16 of them exist in the live catalog right now — a test
// asserting none would be red on day one, by design.
//
// What actually protects callers is PRECEDENCE: when an aliasKey collides with
// some other row's canonicalName, the canonical row wins, unconditionally. So
// that is what is pinned here, and it is pinned the strong way — by asserting
// the alias table is NEVER CONSULTED, not merely that the returned id happens
// to be right. An implementation that read both and preferred canonical would
// pass an id-only assertion while doing twice the queries and being one
// refactor away from a coin flip.
//
// ⚠️ THE DRIFT GUARD ("this set is exactly these 16") IS NOT HERE, and cannot
// be: measured, ZERO of the 16 shadowed canonical rows exist in prisma/seed.ts
// — the aliases come from the seed, the rows they shadow were minted by AI dish
// generation. A fixture holds only one half of every live pair. That guard has
// to read the database. Logged as D-WS9-187.
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-135: a shadowing alias never beats a canonical row", () => {
  /**
   * The live shape, in miniature: "salt" is an ALIAS on "kosher salt" AND the
   * canonicalName of its own row. Same shape as egg/large eggs, lettuce/romaine
   * lettuce, sugar/granulated sugar — 16 pairs in the catalog today.
   */
  function shadowedCatalog() {
    return makeCatalog(
      [
        { id: "ing-kosher-salt", canonicalName: "kosher salt" },
        { id: "ing-salt", canonicalName: "salt" },
        { id: "ing-large-eggs", canonicalName: "large eggs" },
        { id: "ing-egg", canonicalName: "egg" },
      ],
      [
        ["salt", "kosher salt"], // alias "salt" -> kosher salt, shadowing row "salt"
        ["egg", "large eggs"], // alias "egg"  -> large eggs, shadowing row "egg"
      ],
    );
  }

  it("guard B1 — the shadowed CANONICAL row wins, and the alias table is never read", async () => {
    const { prisma, calls } = shadowedCatalog();
    const hit = await lookupIngredientByName(prisma, "salt");
    assert.equal(hit?.id, "ing-salt"); // NOT ing-kosher-salt
    assert.equal(hit?.canonicalName, "salt");
    assert.equal(hit?.matchedVia, "canonical");
    // The load-bearing half: precedence is structural (return before the alias
    // step), not a preference applied after reading both.
    assert.ok(
      !calls.some((c) => c.startsWith("ingredientAlias.")),
      `alias table was consulted: ${calls.join(", ")}`,
    );
  });

  it("guard B2 — the same, for the second live shape (egg / large eggs)", async () => {
    const { prisma, calls } = shadowedCatalog();
    const hit = await lookupIngredientByName(prisma, "egg");
    assert.equal(hit?.id, "ing-egg");
    assert.equal(hit?.matchedVia, "canonical");
    assert.ok(!calls.some((c) => c.startsWith("ingredientAlias.")));
  });

  it("guard B3 — the alias STILL resolves for a name that is nobody's canonical", async () => {
    // Precedence must not be implemented by disabling aliases. "kosher salt"
    // resolves canonically; a non-canonical alias must still work.
    const { prisma } = makeCatalog(
      [{ id: "ing-bacon", canonicalName: "bacon" }],
      [["bacon strips", "bacon"]],
    );
    const hit = await lookupIngredientByName(prisma, "bacon strips");
    assert.equal(hit?.id, "ing-bacon");
    assert.equal(hit?.matchedVia, "alias");
  });

  it("guard B4 — the BATCH path obeys the same precedence", async () => {
    // lookupIngredientsByName resolves canonical and alias in two separate
    // queries and merges them. A shadowing key must take the canonical row from
    // the first, and must not be handed to the alias query at all.
    const { prisma, calls } = shadowedCatalog();
    const out = await lookupIngredientsByName(prisma, [
      { primaryKey: "salt", rawName: "salt" },
      { primaryKey: "egg", rawName: "egg" },
    ]);
    assert.equal(out.get("salt")?.id, "ing-salt");
    assert.equal(out.get("egg")?.id, "ing-egg");
    assert.equal(out.get("salt")?.matchedVia, "canonical");
    // Both keys hit canonically, so the alias query is skipped outright.
    assert.ok(
      !calls.some((c) => c.startsWith("ingredientAlias.")),
      `alias table was consulted: ${calls.join(", ")}`,
    );
  });

  it("guard B5 — a shadowing pair is LEGAL: seeding one must not raise", () => {
    // The inverse assertion, made explicit so nobody re-derives it as a bug.
    // Two rows claiming ONE alias is the P2002 this table exists to force; an
    // alias that equals a DIFFERENT row's canonicalName is neither, and the
    // ruling says so. If this ever throws, someone has confused the two.
    assert.doesNotThrow(() => {
      const { seedAlias } = makeCatalog(
        [
          { id: "ing-granulated-sugar", canonicalName: "granulated sugar" },
          { id: "ing-sugar", canonicalName: "sugar" },
        ],
        [],
      );
      seedAlias("sugar", "granulated sugar");
    });
  });
});
