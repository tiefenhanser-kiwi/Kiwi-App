// WS9-2 2c (D-WS9-154) — Tried & True rail view-model. Replaces
// triedTrue.test.ts, whose subject (a three-query client-side merge) no longer
// exists: the server now returns one ordered list.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RailPlanItem } from "@/lib/api/home";
import {
  BADGE_FEATURED,
  BADGE_HOSTING,
  BADGE_TOP_RATED,
  buildRailItems,
  railBadge,
  railMeta,
} from "../rail";

function row(over: Partial<RailPlanItem> = {}): RailPlanItem {
  return {
    id: "t-1",
    name: "Game Day Spread",
    image: "https://images.unsplash.com/photo-1504674900247",
    tags: ["hosting", "game-day"],
    isFeatured: false,
    isHostingFeatured: true,
    ...over,
  };
}

// ── badge ───────────────────────────────────────────────────────────────────

test("railBadge: Hosting leads — a row with BOTH flags shows as Hosting", () => {
  // Preserves the retired first-badge-wins dedupe, where TRIED_TRUE_BADGES led
  // with hosting_events.
  assert.equal(
    railBadge({ isFeatured: true, isHostingFeatured: true }),
    BADGE_HOSTING,
  );
});

test("railBadge: featured-only → Featured", () => {
  assert.equal(
    railBadge({ isFeatured: true, isHostingFeatured: false }),
    BADGE_FEATURED,
  );
});

test("railBadge: neither flag → Top Rated (an unbadged row still reaches the rail)", () => {
  // railPosition is the membership test, not the flags — so a row with no
  // featuring flag at all is a legitimate rail member. It keeps the label the
  // old ungated top_rated bucket gave it.
  assert.equal(
    railBadge({ isFeatured: false, isHostingFeatured: false }),
    BADGE_TOP_RATED,
  );
});

// ── meta ────────────────────────────────────────────────────────────────────

test("railMeta: suppressed when tags[0] merely restates the badge", () => {
  // Live data: three of six cards rendered the literal word "hosting" directly
  // under a pill reading "Hosting".
  assert.equal(railMeta(["hosting", "game-day"], BADGE_HOSTING), null);
});

test("railMeta: comparison is case-insensitive and trims", () => {
  assert.equal(railMeta(["  HOSTING "], BADGE_HOSTING), null);
  assert.equal(railMeta(["Featured"], BADGE_FEATURED), null);
});

test("railMeta: a distinct first tag survives", () => {
  assert.equal(railMeta(["quick", "weeknight"], BADGE_FEATURED), "quick");
});

test("railMeta: no tags → null (the card omits the line entirely)", () => {
  assert.equal(railMeta([], BADGE_FEATURED), null);
  assert.equal(railMeta(["   "], BADGE_FEATURED), null);
});

test("railMeta: suppression checks ONLY tags[0], it does not scan for a survivor", () => {
  // Deliberate: the meta line is "the plan's first tag", not "the first tag
  // that isn't the badge". Promoting tags[1] would silently reorder meaning.
  assert.equal(railMeta(["hosting", "bbq"], BADGE_HOSTING), null);
});

// ── buildRailItems ──────────────────────────────────────────────────────────

test("buildRailItems: emits the pinned 5-field shape", () => {
  const [item] = buildRailItems([row({ tags: ["bbq"] })]);
  assert.deepEqual(Object.keys(item).sort(), [
    "id",
    "image",
    "meta",
    "occasion",
    "title",
  ]);
});

test("buildRailItems: image passes through verbatim (the rail is the ONLY surface where photos render)", () => {
  const uri = "https://images.unsplash.com/photo-1547592180-85f173990554";
  assert.equal(buildRailItems([row({ image: uri })])[0].image, uri);
});

test("buildRailItems: a null image stays null (TreatedImage paints its gradient)", () => {
  assert.equal(buildRailItems([row({ image: null })])[0].image, null);
});

test("buildRailItems: PRESERVES server order — it must never re-sort", () => {
  // Curation lives in railPosition. Re-sorting here would silently override a
  // hand-curated order, which is the entire point of the column.
  const items = buildRailItems([
    row({ id: "a", name: "Alpha" }),
    row({ id: "z", name: "Zulu" }),
    row({ id: "m", name: "Mike" }),
  ]);
  assert.deepEqual(
    items.map((i) => i.id),
    ["a", "z", "m"],
  );
});

test("buildRailItems: empty input → empty rail (homeSectionOrder then omits the section)", () => {
  assert.deepEqual(buildRailItems([]), []);
});

test("buildRailItems: reproduces the six live cards, badges and metas included", () => {
  // The live pool, in backfilled railPosition order. This is the regression pin
  // for 'the rail renders the same six cards after the rewrite'.
  const items = buildRailItems([
    row({ id: "1", name: "Game Day Spread", tags: ["hosting", "game-day"], isHostingFeatured: true }),
    row({ id: "2", name: "4th of July BBQ", tags: ["hosting", "bbq"], isHostingFeatured: true }),
    row({ id: "3", name: "Holiday Hosting Menu", tags: ["hosting", "holiday"], isHostingFeatured: true }),
    row({ id: "4", name: "Quick Weeknights", tags: ["quick", "weeknight"], isFeatured: true, isHostingFeatured: false }),
    row({ id: "5", name: "Family Favorites Week", tags: ["family", "kid-friendly"], isFeatured: true, isHostingFeatured: false }),
    row({ id: "6", name: "Budget Bowls", tags: ["budget", "meal-prep"], isFeatured: false, isHostingFeatured: false }),
  ]);

  assert.deepEqual(
    items.map((i) => [i.title, i.occasion, i.meta]),
    [
      ["Game Day Spread", "Hosting", null],
      ["4th of July BBQ", "Hosting", null],
      ["Holiday Hosting Menu", "Hosting", null],
      ["Quick Weeknights", "Featured", "quick"],
      ["Family Favorites Week", "Featured", "family"],
      ["Budget Bowls", "Top Rated", "budget"],
    ],
  );
  assert.ok(items.every((i) => i.image !== null), "every live card carries a photo");
});
