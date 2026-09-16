// WS9 Redesign Arc Block 1 (D-WS9-245) — the two dials in the resolver.
//
// A level is stored / sent; a COUNT is what the prompts consume, derived on
// the server from the plan length. All-forces-None is enforced here, once,
// for every generation path. The legacy 0..2 integer shim is covered so its
// removal in Block 2 turns exactly these tests red.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyAllForcesNone,
  discoveryLevelFromInput,
  legacyDiscoveryIntToLevel,
  levelToCount,
  resolveEffectivePreferences,
  resolvePreferences,
  type StoredPreferences,
} from "../wizardPreferences";

const STORED: StoredPreferences = {
  discoveryLevel: "some",
  playlistLevel: "none",
  saucePreference: "balanced",
  maxCookTimeMinutes: 45,
  maxCookTimeCoverage: "most",
};

describe("levelToCount — level × plan length → slots", () => {
  it("matches the D-WS9-245 first setting for a 7-day plan", () => {
    assert.equal(levelToCount("none", 7), 0);
    assert.equal(levelToCount("some", 7), 3); // ceil(2.1)
    assert.equal(levelToCount("mostly", 7), 5); // ceil(4.9)
    assert.equal(levelToCount("all", 7), 7);
  });

  it("matches for a 5-day plan and a 1-day plan", () => {
    assert.equal(levelToCount("some", 5), 2); // ceil(1.5)
    assert.equal(levelToCount("mostly", 5), 4); // ceil(3.5)
    assert.equal(levelToCount("all", 5), 5);
    assert.equal(levelToCount("some", 1), 1);
    assert.equal(levelToCount("mostly", 1), 1);
    assert.equal(levelToCount("all", 1), 1);
    assert.equal(levelToCount("none", 1), 0);
  });

  it("is 0 for a missing / non-positive size", () => {
    assert.equal(levelToCount("all", 0), 0);
    assert.equal(levelToCount("all", -3), 0);
    assert.equal(levelToCount("all", Number.NaN), 0);
  });
});

describe("legacy shim — 0..2 int → level (TEMPORARY, remove in Block 2)", () => {
  it("maps exactly as the migration did", () => {
    assert.equal(legacyDiscoveryIntToLevel(0), "none");
    assert.equal(legacyDiscoveryIntToLevel(1), "some");
    assert.equal(legacyDiscoveryIntToLevel(2), "mostly");
    assert.equal(legacyDiscoveryIntToLevel(7), "none");
  });

  it("discoveryLevelFromInput: enum key wins, legacy key folds, absent stays absent", () => {
    assert.equal(discoveryLevelFromInput({}), undefined);
    assert.equal(discoveryLevelFromInput({ discoveryMealsPerWeek: 2 }), "mostly");
    assert.equal(discoveryLevelFromInput({ discoveryLevel: "all" }), "all");
    assert.equal(
      discoveryLevelFromInput({ discoveryLevel: "none", discoveryMealsPerWeek: 2 }),
      "none",
    );
  });
});

describe("applyAllForcesNone", () => {
  it("all on one dial forces none on the other", () => {
    assert.deepEqual(applyAllForcesNone("all", "some"), {
      discoveryLevel: "all",
      playlistLevel: "none",
    });
    assert.deepEqual(applyAllForcesNone("mostly", "all"), {
      discoveryLevel: "none",
      playlistLevel: "all",
    });
  });

  it("both all → playlist wins (declared list is the more specific instruction)", () => {
    assert.deepEqual(applyAllForcesNone("all", "all"), {
      discoveryLevel: "none",
      playlistLevel: "all",
    });
  });

  it("leaves non-all pairs untouched", () => {
    assert.deepEqual(applyAllForcesNone("some", "mostly"), {
      discoveryLevel: "some",
      playlistLevel: "mostly",
    });
    assert.deepEqual(applyAllForcesNone("none", "none"), {
      discoveryLevel: "none",
      playlistLevel: "none",
    });
  });
});

describe("resolvePreferences — dials → counts (D-WS7-035 presence semantics kept)", () => {
  it("omitted discovery falls back to stored; playlist omitted = none", () => {
    const r = resolvePreferences(STORED, {}, { planDurationDays: 7 });
    assert.equal(r.discoveryLevel, "some");
    assert.equal(r.discoveryMealsPerWeek, 3);
    assert.equal(r.playlistLevel, "none");
    assert.equal(r.playlistMealsPerWeek, 0);
    // The other three still resolve as before.
    assert.equal(r.saucePreference, "balanced");
    assert.equal(r.maxCookTimeMinutes, 45);
    assert.equal(r.maxCookTimeCoverage, "most");
  });

  it("a per-run level wins over stored and becomes a count", () => {
    const r = resolvePreferences(
      STORED,
      { discoveryLevel: "mostly", playlistLevel: "some" },
      { planDurationDays: 5, playlistMealCount: 3 },
    );
    assert.equal(r.discoveryLevel, "mostly");
    assert.equal(r.discoveryMealsPerWeek, 4);
    assert.equal(r.playlistLevel, "some");
    assert.equal(r.playlistMealsPerWeek, 2);
  });

  it("All-forces-None is applied before the counts", () => {
    const r = resolvePreferences(
      STORED,
      { discoveryLevel: "all", playlistLevel: "mostly" },
      { planDurationDays: 7, playlistMealCount: 3 },
    );
    assert.equal(r.discoveryMealsPerWeek, 7);
    assert.equal(r.playlistMealsPerWeek, 0);
    const p = resolvePreferences(
      STORED,
      { playlistLevel: "all" },
      { planDurationDays: 7, playlistMealCount: 3 },
    );
    assert.equal(p.discoveryLevel, "none");
    assert.equal(p.discoveryMealsPerWeek, 0);
    assert.equal(p.playlistMealsPerWeek, 7);
  });

  it("no plan length (the expand path) → both counts 0, levels still resolved", () => {
    const r = resolvePreferences(STORED, { discoveryLevel: "all" });
    assert.equal(r.discoveryLevel, "all");
    assert.equal(r.discoveryMealsPerWeek, 0);
    assert.equal(r.playlistMealsPerWeek, 0);
  });

  it("an explicit null cap still wins (presence, not nullish)", () => {
    const r = resolvePreferences(STORED, { maxCookTimeMinutes: null });
    assert.equal(r.maxCookTimeMinutes, null);
  });
});

// WS9 Redesign Arc Block 2 (Part A) — the Playlist dial is STORED beside
// Discovery and resolves the same way (per-run ?? stored ?? none); a level is
// neutralised to `none` for a user with zero playlist meals, on the server.
describe("resolvePreferences — stored playlistLevel + the zero-playlist guard (Block 2)", () => {
  const STORED_MOSTLY: StoredPreferences = { ...STORED, playlistLevel: "mostly" };

  it("stored mostly + no per-run → a count, when the user has playlist meals", () => {
    const r = resolvePreferences(STORED_MOSTLY, {}, { planDurationDays: 7, playlistMealCount: 4 });
    assert.equal(r.playlistLevel, "mostly");
    assert.equal(r.playlistMealsPerWeek, 5); // ceil(4.9)
  });

  it("stored mostly + no per-run → none / 0 with an EMPTY playlist (the guard)", () => {
    const r = resolvePreferences(STORED_MOSTLY, {}, { planDurationDays: 7, playlistMealCount: 0 });
    assert.equal(r.playlistLevel, "none");
    assert.equal(r.playlistMealsPerWeek, 0);
    const absent = resolvePreferences(STORED_MOSTLY, {}, { planDurationDays: 7 });
    assert.equal(absent.playlistLevel, "none", "an absent count is an empty playlist");
  });

  it("a per-run level is neutralised too — the guard is not UI-only", () => {
    const r = resolvePreferences(STORED, { playlistLevel: "all" }, { planDurationDays: 7, playlistMealCount: 0 });
    assert.equal(r.playlistLevel, "none");
    assert.equal(r.playlistMealsPerWeek, 0);
    // …and with nothing to force, the discovery dial keeps its own level.
    assert.equal(r.discoveryLevel, "some");
  });

  it("per-run none overrides stored mostly", () => {
    const r = resolvePreferences(
      STORED_MOSTLY,
      { playlistLevel: "none" },
      { planDurationDays: 7, playlistMealCount: 4 },
    );
    assert.equal(r.playlistLevel, "none");
    assert.equal(r.playlistMealsPerWeek, 0);
  });
});

describe("resolveEffectivePreferences — reads discoveryLevel, falls back to column defaults", () => {
  it("reads the stored enum column and derives the count", async () => {
    const prisma = {
      userPreferences: {
        findUnique: async (args: { select: Record<string, boolean> }) => {
          assert.equal(args.select.discoveryLevel, true, "must select the enum column");
          assert.equal("discoveryMealsPerWeek" in args.select, false, "legacy column selected");
          assert.equal(args.select.playlistLevel, true, "must select the playlist column");
          return {
            discoveryLevel: "mostly",
            playlistLevel: "none",
            saucePreference: "homemade",
            maxCookTimeMinutes: null,
            maxCookTimeCoverage: "all",
          };
        },
      },
      playlistMeal: { count: async () => 0 },
    } as unknown as Parameters<typeof resolveEffectivePreferences>[0];
    const r = await resolveEffectivePreferences(prisma, "u1", {}, { planDurationDays: 3 });
    assert.equal(r.discoveryLevel, "mostly");
    assert.equal(r.discoveryMealsPerWeek, 3); // ceil(2.1)
    assert.equal(r.saucePreference, "homemade");
  });

  it("Block 2: a stored playlist level counts the user's playlist rows — > 0 with meals, none without", async () => {
    const make = (playlistRows: number) => {
      let counted = 0;
      const prisma = {
        userPreferences: {
          findUnique: async () => ({
            discoveryLevel: "none",
            playlistLevel: "mostly",
            saucePreference: "balanced",
            maxCookTimeMinutes: null,
            maxCookTimeCoverage: "most",
          }),
        },
        playlistMeal: {
          count: async ({ where }: { where: { userId: string } }) => {
            counted++;
            assert.equal(where.userId, "u1");
            return playlistRows;
          },
        },
      } as unknown as Parameters<typeof resolveEffectivePreferences>[0];
      return { prisma, counted: () => counted };
    };
    const withMeals = make(3);
    const r = await resolveEffectivePreferences(withMeals.prisma, "u1", {}, { planDurationDays: 7 });
    assert.equal(r.playlistLevel, "mostly");
    assert.ok(r.playlistMealsPerWeek > 0);
    assert.equal(withMeals.counted(), 1);
    const empty = make(0);
    const e = await resolveEffectivePreferences(empty.prisma, "u1", {}, { planDurationDays: 7 });
    assert.equal(e.playlistLevel, "none");
    assert.equal(e.playlistMealsPerWeek, 0);
    // A per-run none skips the read altogether — nothing to neutralise.
    const skipped = make(3);
    const n = await resolveEffectivePreferences(skipped.prisma, "u1", { playlistLevel: "none" }, { planDurationDays: 7 });
    assert.equal(n.playlistLevel, "none");
    assert.equal(skipped.counted(), 0);
  });

  it("no prefs row → none / 0", async () => {
    const prisma = {
      userPreferences: { findUnique: async () => null },
    } as unknown as Parameters<typeof resolveEffectivePreferences>[0];
    const r = await resolveEffectivePreferences(prisma, "u1", {}, { planDurationDays: 7 });
    assert.equal(r.discoveryLevel, "none");
    assert.equal(r.discoveryMealsPerWeek, 0);
    assert.equal(r.playlistLevel, "none");
  });
});
