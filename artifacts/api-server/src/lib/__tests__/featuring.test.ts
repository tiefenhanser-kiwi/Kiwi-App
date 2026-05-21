// WS7-3 A2 — date-windowed featuring resolution tests (PRD §15.6.3).
// Pure functions; no DB, no AI. `now` is injected.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  featuredWhere,
  hostingFeaturedWhere,
  isCurrentlyFeatured,
  isCurrentlyHostingFeatured,
  type FeaturingWindowFields,
} from "../featuring";

const NOW = new Date("2026-05-21T12:00:00Z");

function tmpl(overrides: Partial<FeaturingWindowFields>): FeaturingWindowFields {
  return {
    isFeatured: true,
    isHostingFeatured: false,
    featuredStartDate: null,
    featuredEndDate: null,
    ...overrides,
  };
}

describe("isCurrentlyFeatured", () => {
  it("no dates set → always visible", () => {
    assert.equal(isCurrentlyFeatured(tmpl({}), NOW), true);
  });

  it("flag off → never visible even inside the window", () => {
    assert.equal(isCurrentlyFeatured(tmpl({ isFeatured: false }), NOW), false);
  });

  it("before start → not yet visible (queued)", () => {
    const t = tmpl({ featuredStartDate: new Date("2026-06-01T00:00:00Z") });
    assert.equal(isCurrentlyFeatured(t, NOW), false);
  });

  it("inside the window → visible", () => {
    const t = tmpl({
      featuredStartDate: new Date("2026-05-01T00:00:00Z"),
      featuredEndDate: new Date("2026-05-31T00:00:00Z"),
    });
    assert.equal(isCurrentlyFeatured(t, NOW), true);
  });

  it("after end → retired (no longer visible)", () => {
    const t = tmpl({ featuredEndDate: new Date("2026-05-01T00:00:00Z") });
    assert.equal(isCurrentlyFeatured(t, NOW), false);
  });

  it("only start set, start in the past → visible", () => {
    const t = tmpl({ featuredStartDate: new Date("2026-01-01T00:00:00Z") });
    assert.equal(isCurrentlyFeatured(t, NOW), true);
  });

  it("only end set, end in the future → visible", () => {
    const t = tmpl({ featuredEndDate: new Date("2026-12-31T00:00:00Z") });
    assert.equal(isCurrentlyFeatured(t, NOW), true);
  });

  it("bounds are inclusive: now exactly on start → visible", () => {
    const t = tmpl({ featuredStartDate: NOW });
    assert.equal(isCurrentlyFeatured(t, NOW), true);
  });

  it("bounds are inclusive: now exactly on end → visible", () => {
    const t = tmpl({ featuredEndDate: NOW });
    assert.equal(isCurrentlyFeatured(t, NOW), true);
  });
});

describe("isCurrentlyHostingFeatured", () => {
  it("hosting flag uses the same window columns", () => {
    const visible = tmpl({
      isFeatured: false,
      isHostingFeatured: true,
      featuredStartDate: new Date("2026-05-01T00:00:00Z"),
      featuredEndDate: new Date("2026-05-31T00:00:00Z"),
    });
    assert.equal(isCurrentlyHostingFeatured(visible, NOW), true);

    const expired = tmpl({
      isFeatured: false,
      isHostingFeatured: true,
      featuredEndDate: new Date("2026-05-01T00:00:00Z"),
    });
    assert.equal(isCurrentlyHostingFeatured(expired, NOW), false);
  });

  it("hosting flag off → not visible", () => {
    assert.equal(
      isCurrentlyHostingFeatured(tmpl({ isHostingFeatured: false }), NOW),
      false,
    );
  });
});

describe("featuredWhere / hostingFeaturedWhere fragments", () => {
  it("featuredWhere pins isFeatured = true and a two-sided window", () => {
    const w = featuredWhere(NOW) as Record<string, unknown>;
    assert.equal(w.isFeatured, true);
    assert.ok(Array.isArray(w.AND));
    assert.equal((w.AND as unknown[]).length, 2);
  });

  it("hostingFeaturedWhere pins isHostingFeatured = true", () => {
    const w = hostingFeaturedWhere(NOW) as Record<string, unknown>;
    assert.equal(w.isHostingFeatured, true);
    assert.ok(Array.isArray(w.AND));
  });
});
