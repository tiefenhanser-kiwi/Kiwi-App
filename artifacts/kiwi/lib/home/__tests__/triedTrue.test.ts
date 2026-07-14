// WS9 Block 3a — tests for buildTriedTrueRail: Hosting-first ordering, cross-
// badge dedup (first badge wins), per-badge cap, and reduced-meta fallback.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTriedTrueRail } from "../triedTrue";
import type { PlanListItem } from "../../api/plans";

function plan(overrides: Partial<PlanListItem> & { id: string }): PlanListItem {
  return {
    name: `Plan ${overrides.id}`,
    description: null,
    image: null,
    tags: [],
    source: "template",
    status: null,
    startDate: null,
    endDate: null,
    isActiveThisWeek: false,
    ...overrides,
  };
}

test("buildTriedTrueRail: Hosting leads, then the given badge order", () => {
  const items = buildTriedTrueRail([
    { badge: "hosting_events", plans: [plan({ id: "h1" })] },
    { badge: "featured", plans: [plan({ id: "f1" })] },
    { badge: "top_rated", plans: [plan({ id: "t1" })] },
  ]);
  assert.deepEqual(
    items.map((i) => [i.id, i.occasion]),
    [
      ["h1", "Hosting"],
      ["f1", "Featured"],
      ["t1", "Top Rated"],
    ],
  );
});

test("buildTriedTrueRail: dedups a plan across badges — first (Hosting) wins", () => {
  const items = buildTriedTrueRail([
    { badge: "hosting_events", plans: [plan({ id: "shared" })] },
    { badge: "featured", plans: [plan({ id: "shared" }), plan({ id: "f2" })] },
  ]);
  assert.deepEqual(
    items.map((i) => [i.id, i.occasion]),
    [
      ["shared", "Hosting"],
      ["f2", "Featured"],
    ],
  );
});

test("buildTriedTrueRail: caps each badge's contribution", () => {
  const many = Array.from({ length: 6 }, (_, i) => plan({ id: `h${i}` }));
  const items = buildTriedTrueRail(
    [{ badge: "hosting_events", plans: many }],
    2,
  );
  assert.equal(items.length, 2);
});

test("buildTriedTrueRail: meta falls back to first tag, else null", () => {
  const items = buildTriedTrueRail([
    {
      badge: "featured",
      plans: [
        plan({ id: "withtag", tags: ["Italian", "Cozy"] }),
        plan({ id: "notag", tags: [] }),
      ],
    },
  ]);
  assert.equal(items[0].meta, "Italian");
  assert.equal(items[1].meta, null);
});
