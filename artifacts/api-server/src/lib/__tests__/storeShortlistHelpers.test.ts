// Plan-Gen Arc · Block 4b-1 (D-WS9-075) — unit tests for the shortlist helpers:
// parent-dish recovery, cuisine normalization, the allergen label→token map, and
// the seeded weighted sampler.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  lookupDishFamily,
  parentKeyForMeal,
  distinctParentCount,
  NON_CATALOG_RANK,
} from "../store/dishFamily";
import {
  normalizeCuisineTokens,
  userCuisineTokens,
  cuisineMatches,
} from "../store/cuisineNormalize";
import {
  allergenTokensForUser,
  allergenWhereConditions,
} from "../store/allergenFilter";
import {
  hashString,
  rngFromString,
  weightedSampleWithoutReplacement,
} from "../store/shortlistSampling";
import { rankWeight } from "../store/storeShortlist";

describe("dishFamily", () => {
  it("recovers parent + rank from a real dishFamilyKey (exact join)", () => {
    const info = lookupDishFamily("lemon-herb-baked-chicken-breast");
    assert.deepEqual(info, { parentKey: "baked-chicken-breast", rank: 3 });
  });

  it("returns null for a null or unknown key", () => {
    assert.equal(lookupDishFamily(null), null);
    assert.equal(lookupDishFamily("not-a-real-key"), null);
  });

  it("gives non-catalog meals a per-meal singleton parent key", () => {
    assert.equal(parentKeyForMeal("meal-1", null), "x:meal-1");
    assert.equal(parentKeyForMeal("meal-2", "unknown"), "x:meal-2");
  });

  it("spine holds the expected number of distinct parent dishes", () => {
    assert.equal(distinctParentCount(), 562);
    // Unmapped meals get the MEDIAN rank (not the tail) so the write-back loop
    // isn't starved — see dishFamily.ts.
    assert.equal(NON_CATALOG_RANK, 281);
  });
});

describe("cuisineNormalize", () => {
  it("normalizes hyphenated variants to a shared token", () => {
    assert.ok(normalizeCuisineTokens("Italian-American").has("italian"));
    assert.ok(normalizeCuisineTokens("American-Italian").has("italian"));
  });

  it("maps regional Asian cuisines to both specific and 'asian' tokens", () => {
    const t = normalizeCuisineTokens("Chinese-American");
    assert.ok(t.has("chinese"));
    assert.ok(t.has("asian"));
  });

  it("matches a meal when the token sets intersect", () => {
    assert.equal(cuisineMatches("Chinese-American", userCuisineTokens(["Asian"])), true);
    assert.equal(cuisineMatches("Italian", userCuisineTokens(["Italian"])), true);
  });

  it("does not match across unrelated cuisines", () => {
    assert.equal(cuisineMatches("Korean", userCuisineTokens(["Italian"])), false);
  });

  it("treats an empty user token set as no-match (callers special-case no-prefs)", () => {
    assert.equal(cuisineMatches("Italian", new Set()), false);
  });

  it("yields an empty set for a value that maps to nothing", () => {
    assert.equal(normalizeCuisineTokens("British").size, 0);
  });
});

describe("allergenFilter", () => {
  it("maps UI labels to stamp tokens (incl. Nut-free → peanut + tree_nut)", () => {
    assert.deepEqual(
      allergenTokensForUser(["Dairy-free", "Nut-free"]).sort(),
      ["dairy", "peanut", "tree_nut"],
    );
  });

  // 2026-09-04 — this test previously asserted BOTH map to ["wheat"]. That was
  // the defect, not the contract: gluten ⊋ wheat, so a barley or farro dish
  // carrying no wheat stamp passed a Gluten-free filter (3 such meals measured
  // in the live catalog). Wheat-free is now a strict SUBSET of Gluten-free.
  it("maps Gluten-free to BOTH tokens and Wheat-free to wheat alone", () => {
    assert.deepEqual(allergenTokensForUser(["Gluten-free"]).sort(), ["gluten", "wheat"]);
    assert.deepEqual(allergenTokensForUser(["Wheat-free"]), ["wheat"]);
    // The asymmetry is the point: someone avoiding wheat may still eat barley.
    const wheatOnly = allergenTokensForUser(["Wheat-free"]);
    const gluten = allergenTokensForUser(["Gluten-free"]);
    assert.ok(wheatOnly.every((t) => gluten.includes(t)), "Wheat-free ⊂ Gluten-free");
    assert.ok(!wheatOnly.includes("gluten"), "Wheat-free must NOT exclude barley/rye");
  });

  it("drops free-text avoidances (not hard allergens)", () => {
    assert.deepEqual(allergenTokensForUser(["Mushrooms", "Strong cheese"]), []);
  });

  it("builds no conditions at all when the user has no mapped allergy", () => {
    assert.deepEqual(allergenWhereConditions([]), []);
  });

  // ── D-WS9-214: verified-clean vs never-stamped ─────────────────────────────
  //
  // ⚠️ THESE ASSERT BEHAVIOUR, NOT THE CLAUSE LITERAL. The previous version of
  // this test deepEqual'd the emitted objects, which pinned the spelling and
  // nothing else — it would have stayed green through any rewrite that kept the
  // same shape and gone red on a purely cosmetic one. What matters is which
  // MEALS survive, so the conditions are evaluated against candidate rows.
  //
  // A deliberately tiny interpreter for the two clause shapes this function
  // emits. If a future change emits a third shape it throws rather than
  // silently passing everything, which is the failure mode that would make
  // these tests worthless.
  const admits = (
    conditions: ReturnType<typeof allergenWhereConditions>,
    meal: { allergens: string[]; allergensStampedAt: Date | null },
  ): boolean =>
    conditions.every((c) => {
      const cond = c as Record<string, unknown>;
      if (cond.NOT) {
        const tokens = (cond.NOT as { allergens: { hasSome: string[] } }).allergens.hasSome;
        return !meal.allergens.some((a) => tokens.includes(a));
      }
      if (cond.allergensStampedAt) return meal.allergensStampedAt !== null;
      throw new Error(`unrecognized clause shape: ${JSON.stringify(c)}`);
    });

  const STAMPED = new Date("2026-09-04T00:00:00Z");

  it("a stamped-but-EMPTY meal passes — verified clean is not unknown", () => {
    // The 64 pool dinners this unblocks. Before D-WS9-214 the clause was
    // `allergens.isEmpty === false`, which excluded them: derived, carrying no
    // allergen, and invisible to every allergic user anyway. A Coconut Chickpea
    // Curry was among them — the exact meal a dairy-free user opens the app for.
    const conds = allergenWhereConditions(["dairy"]);
    assert.equal(
      admits(conds, { allergens: [], allergensStampedAt: STAMPED }),
      true,
      "a meal derived to no allergens must reach an allergic user",
    );
  });

  it("a NEVER-stamped meal is still excluded — the conservative rule survives", () => {
    const conds = allergenWhereConditions(["dairy"]);
    assert.equal(
      admits(conds, { allergens: [], allergensStampedAt: null }),
      false,
      "unknown is not safe; an unstamped meal must stay excluded",
    );
  });

  it("a meal carrying the user's allergen is excluded even when stamped", () => {
    const conds = allergenWhereConditions(["dairy"]);
    assert.equal(admits(conds, { allergens: ["dairy"], allergensStampedAt: STAMPED }), false);
    assert.equal(admits(conds, { allergens: ["wheat"], allergensStampedAt: STAMPED }), true);
  });

  it("is STRICTLY SAFER than the old clause on a cleared stamp", () => {
    // A row whose allergens array was emptied by a bad write used to read as
    // "clean and empty" and pass. With no timestamp it now reads as never
    // stamped and fails closed.
    const conds = allergenWhereConditions(["dairy"]);
    assert.equal(admits(conds, { allergens: [], allergensStampedAt: null }), false);
  });

  it("Gluten-free excludes a barley meal AND a beer meal", () => {
    // End-to-end through the mapping: the chip resolves to two tokens, and the
    // D-WS9-214 `beer -> gluten` term is what makes the second one work.
    const conds = allergenWhereConditions(allergenTokensForUser(["Gluten-free"]));
    assert.equal(admits(conds, { allergens: ["gluten"], allergensStampedAt: STAMPED }), false);
    assert.equal(admits(conds, { allergens: ["wheat"], allergensStampedAt: STAMPED }), false);
    // …while Wheat-free admits the barley dish. The asymmetry is the point.
    const wheatOnly = allergenWhereConditions(allergenTokensForUser(["Wheat-free"]));
    assert.equal(admits(wheatOnly, { allergens: ["gluten"], allergensStampedAt: STAMPED }), true);
  });
});

describe("shortlistSampling", () => {
  it("hashString is stable and non-zero", () => {
    assert.equal(hashString("user-a:0"), hashString("user-a:0"));
    assert.notEqual(hashString("user-a:0"), 0);
    assert.notEqual(hashString("user-a:0"), hashString("user-b:0"));
  });

  it("sampling is deterministic for a given seed", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const a = weightedSampleWithoutReplacement(items, () => 1, 8, rngFromString("s"));
    const b = weightedSampleWithoutReplacement(items, () => 1, 8, rngFromString("s"));
    assert.deepEqual(a, b);
  });

  it("strongly favors high-weight items", () => {
    const items = [{ id: "heavy", w: 1000 }, { id: "light", w: 0.001 }];
    const [pick] = weightedSampleWithoutReplacement(
      items,
      (x) => x.w,
      1,
      rngFromString("seed"),
    );
    assert.equal(pick.id, "heavy");
  });

  it("skips non-positive weights and caps at k", () => {
    const items = [{ w: 1 }, { w: 0 }, { w: 2 }, { w: -1 }];
    const out = weightedSampleWithoutReplacement(items, (x) => x.w, 10, rngFromString("s"));
    assert.equal(out.length, 2, "only the two positive-weight items are eligible");
  });
});

// Regression guard for the NON_CATALOG_RANK decision (563 → median 281). A
// live_writeback / non-batch pool meal carries no dishFamilyKey and is ranked at
// NON_CATALOG_RANK; if a future ranking change re-pushed that toward the tail, the
// write-back loop would starve with NOTHING else failing. This asserts the PROPERTY
// — non-catalog meals sample like a mid-catalog dish, not at tail frequency —
// against the REAL rankWeight curve + NON_CATALOG_RANK constant, so a change to
// either trips it. Loosely pinned (not the 1.04 point estimate) since sampling is
// seeded-stochastic.
describe("non-catalog rank — tail-starvation regression (D-WS9-075)", () => {
  const TAIL_RANK = distinctParentCount(); // 562 — the true tail

  it("NON_CATALOG_RANK sits mid-catalog, clearly above the tail", () => {
    // Deterministic: the median decision, not head (1) and not tail (562).
    assert.ok(
      NON_CATALOG_RANK > TAIL_RANK * 0.25 && NON_CATALOG_RANK < TAIL_RANK * 0.75,
      `NON_CATALOG_RANK ${NON_CATALOG_RANK} must be mid-band of ${TAIL_RANK}`,
    );
    assert.ok(
      rankWeight(NON_CATALOG_RANK) > rankWeight(TAIL_RANK),
      "a non-catalog meal must outweigh a tail meal",
    );
  });

  it("samples a non-catalog meal like a mid dish, not at tail frequency", () => {
    // Pool: one non-catalog probe (NON_CATALOG_RANK), one genuine mid dish, one
    // tail dish, plus mid-rank fillers so selection is competitive.
    const MID_RANK = 300;
    type Probe = { tag: "nonCatalog" | "mid" | "tail" | "filler"; rank: number };
    const pool: Probe[] = [
      { tag: "nonCatalog", rank: NON_CATALOG_RANK },
      { tag: "mid", rank: MID_RANK },
      { tag: "tail", rank: TAIL_RANK },
      ...Array.from({ length: 24 }, () => ({ tag: "filler" as const, rank: MID_RANK })),
    ];
    const weightOf = (p: Probe) => rankWeight(p.rank);

    const M = 3000;
    const k = 12;
    const seen = { nonCatalog: 0, mid: 0, tail: 0 };
    for (let i = 0; i < M; i++) {
      const picked = weightedSampleWithoutReplacement(
        pool,
        weightOf,
        k,
        rngFromString(`seed-${i}`),
      );
      for (const p of picked) {
        if (p.tag === "nonCatalog") seen.nonCatalog++;
        else if (p.tag === "mid") seen.mid++;
        else if (p.tag === "tail") seen.tail++;
      }
    }

    // Consistent with a mid dish (both ~median): ratio near 1, loosely bounded.
    const midRatio = seen.nonCatalog / seen.mid;
    assert.ok(
      midRatio > 0.75 && midRatio < 1.3,
      `non-catalog vs mid frequency ratio ${midRatio.toFixed(2)} should be ~1`,
    );
    // NOT tail-starved: clearly more frequent than the tail dish.
    assert.ok(
      seen.nonCatalog > seen.tail * 1.15,
      `non-catalog (${seen.nonCatalog}) must beat tail (${seen.tail}) by a clear margin`,
    );
  });
});
