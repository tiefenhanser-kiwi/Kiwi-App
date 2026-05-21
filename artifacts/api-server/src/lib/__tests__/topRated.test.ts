// WS7-3 A2 — Top Rated scoring tests (PRD §15.6.4).
// Pure scoring function + the SystemSettings reader (stub prisma).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeTopRatedScore,
  getTopRatedSettings,
  TOP_RATED_DEFAULTS,
  type TopRatedSettings,
} from "../topRated";

const NOW = new Date("2026-05-21T00:00:00Z");

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

describe("computeTopRatedScore", () => {
  it("zero counters → zero score regardless of age", () => {
    const s = computeTopRatedScore(
      { saveCount: 0, useCount: 0, updatedAt: daysAgo(90) },
      TOP_RATED_DEFAULTS,
      NOW,
    );
    assert.equal(s, 0);
  });

  it("no decay when the interaction is now (zero days elapsed)", () => {
    // base = 10 * 1 + 5 * 2 = 20; decay = 0.5^0 = 1.
    const s = computeTopRatedScore(
      { saveCount: 10, useCount: 5, updatedAt: NOW },
      TOP_RATED_DEFAULTS,
      NOW,
    );
    assert.equal(s, 20);
  });

  it("decay halves the score at exactly one half-life", () => {
    // base 20, updatedAt 30 days ago, half-life 30 → decay 0.5 → score 10.
    const s = computeTopRatedScore(
      { saveCount: 10, useCount: 5, updatedAt: daysAgo(30) },
      TOP_RATED_DEFAULTS,
      NOW,
    );
    assert.ok(Math.abs(s - 10) < 1e-9, `expected ~10, got ${s}`);
  });

  it("decay quarters the score at two half-lives", () => {
    const s = computeTopRatedScore(
      { saveCount: 10, useCount: 5, updatedAt: daysAgo(60) },
      TOP_RATED_DEFAULTS,
      NOW,
    );
    assert.ok(Math.abs(s - 5) < 1e-9, `expected ~5, got ${s}`);
  });

  it("applies save_weight and use_weight independently", () => {
    const onlySaves = computeTopRatedScore(
      { saveCount: 4, useCount: 0, updatedAt: NOW },
      TOP_RATED_DEFAULTS,
      NOW,
    );
    const onlyUses = computeTopRatedScore(
      { saveCount: 0, useCount: 4, updatedAt: NOW },
      TOP_RATED_DEFAULTS,
      NOW,
    );
    assert.equal(onlySaves, 4); // 4 * 1.0
    assert.equal(onlyUses, 8); // 4 * 2.0
  });

  it("a future updatedAt clamps days-elapsed to zero (no negative decay)", () => {
    const future = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    const s = computeTopRatedScore(
      { saveCount: 10, useCount: 5, updatedAt: future },
      TOP_RATED_DEFAULTS,
      NOW,
    );
    assert.equal(s, 20);
  });
});

describe("getTopRatedSettings", () => {
  function stubPrisma(rows: { key: string; value: unknown }[]) {
    return {
      systemSetting: {
        findMany: async (args: { where: { key: { in: string[] } } }) =>
          rows.filter((r) => args.where.key.in.includes(r.key)),
      },
    };
  }

  it("reads all five top_rated.* keys from SystemSetting", async () => {
    const got = await getTopRatedSettings(
      stubPrisma([
        { key: "top_rated.save_weight", value: 1.5 },
        { key: "top_rated.use_weight", value: 3 },
        { key: "top_rated.decay_half_life_days", value: 45 },
        { key: "top_rated.refresh_interval_hours", value: 12 },
        { key: "top_rated.display_count", value: 25 },
      ]),
    );
    const expected: TopRatedSettings = {
      saveWeight: 1.5,
      useWeight: 3,
      decayHalfLifeDays: 45,
      refreshIntervalHours: 12,
      displayCount: 25,
    };
    assert.deepEqual(got, expected);
  });

  it("falls back to PRD defaults for missing rows", async () => {
    const got = await getTopRatedSettings(stubPrisma([]));
    assert.deepEqual(got, TOP_RATED_DEFAULTS);
  });

  it("falls back per-key for a non-numeric row", async () => {
    const got = await getTopRatedSettings(
      stubPrisma([{ key: "top_rated.save_weight", value: "not-a-number" }]),
    );
    assert.equal(got.saveWeight, TOP_RATED_DEFAULTS.saveWeight);
  });

  it("falls back to all defaults when the read throws", async () => {
    const got = await getTopRatedSettings({
      systemSetting: {
        findMany: async () => {
          throw new Error("db down");
        },
      },
    });
    assert.deepEqual(got, TOP_RATED_DEFAULTS);
  });
});
