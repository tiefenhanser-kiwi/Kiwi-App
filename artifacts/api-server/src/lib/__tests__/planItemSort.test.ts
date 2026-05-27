// WS7-4-D c15 — tests for the server-canonical plan-item sort comparator.
// Locked spec (Hans 2026-05-27 device-test, PRD §8.3.6 redline at WS7-4-D
// close): assigned items sort Sun → Sat by assignedDayOfWeek, tiebreaker
// positionIndex ASC; unscheduled items (assignedDayOfWeek === null) pin to
// the bottom and sort by positionIndex ASC among themselves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sortPlanItemsCanonical,
  type SortableItem,
} from "../planItemSort";

interface Item extends SortableItem {
  id: string;
}

function item(
  id: string,
  day: string | null,
  positionIndex: number,
): Item {
  return { id, assignedDayOfWeek: day, positionIndex };
}

function ids(items: Item[]): string[] {
  return items.map((i) => i.id);
}

describe("sortPlanItemsCanonical", () => {
  it("orders all-7-days populated Sun → Sat", () => {
    // Input intentionally shuffled to prove the sort, not echo input order.
    const out = sortPlanItemsCanonical<Item>([
      item("wed", "Wednesday", 2),
      item("sat", "Saturday", 5),
      item("sun", "Sunday", 0),
      item("fri", "Friday", 4),
      item("tue", "Tuesday", 1),
      item("thu", "Thursday", 3),
      item("mon", "Monday", 6),
    ]);
    assert.deepEqual(ids(out), [
      "sun",
      "mon",
      "tue",
      "wed",
      "thu",
      "fri",
      "sat",
    ]);
  });

  it("pins unscheduled items to the bottom in positionIndex order", () => {
    const out = sortPlanItemsCanonical<Item>([
      item("mon-a", "Monday", 0),
      item("uns-z", null, 5),
      item("tue-b", "Tuesday", 1),
      item("uns-a", null, 2),
      item("wed-c", "Wednesday", 2),
    ]);
    assert.deepEqual(ids(out), [
      "mon-a",
      "tue-b",
      "wed-c",
      // Unscheduled pinned to bottom, positionIndex ASC: 2 < 5.
      "uns-a",
      "uns-z",
    ]);
  });

  it("returns all items by positionIndex when every item is unscheduled", () => {
    const out = sortPlanItemsCanonical<Item>([
      item("c", null, 5),
      item("a", null, 1),
      item("b", null, 3),
    ]);
    assert.deepEqual(ids(out), ["a", "b", "c"]);
  });

  it("breaks ties within the same day by positionIndex ASC", () => {
    const out = sortPlanItemsCanonical<Item>([
      item("sun-late", "Sunday", 5),
      item("sun-mid", "Sunday", 2),
      item("sun-early", "Sunday", 0),
    ]);
    assert.deepEqual(ids(out), ["sun-early", "sun-mid", "sun-late"]);
  });

  it("survives a Saturday → Sunday relocation: a Saturday meal moved to Sunday now sorts higher", () => {
    // Pre-move plan, all on Saturday.
    const before = sortPlanItemsCanonical<Item>([
      item("a", "Saturday", 0),
      item("b", "Saturday", 1),
    ]);
    assert.deepEqual(ids(before), ["a", "b"]);

    // Hans moves "b" to Sunday — c15 spec says it now sorts above the still-
    // Saturday item.
    const after = sortPlanItemsCanonical<Item>([
      item("a", "Saturday", 0),
      item("b", "Sunday", 1),
    ]);
    assert.deepEqual(ids(after), ["b", "a"]);
  });

  it("handles an empty input without error", () => {
    assert.deepEqual(sortPlanItemsCanonical<Item>([]), []);
  });

  it("does not mutate the input array", () => {
    const input: Item[] = [
      item("b", "Tuesday", 1),
      item("a", "Sunday", 0),
    ];
    const snapshot = ids(input);
    sortPlanItemsCanonical(input);
    assert.deepEqual(ids(input), snapshot);
  });

  it("sorts an unknown day string with the unscheduled cluster (defensive)", () => {
    // Shouldn't ever happen — the schema's enum constrains assignedDayOfWeek
    // — but the comparator must not throw if a row sneaks through.
    const out = sortPlanItemsCanonical<Item>([
      item("mon", "Monday", 0),
      item("alien", "Sploonsday", 1),
      item("uns", null, 2),
    ]);
    // "Sploonsday" maps to ordinal 7 (same as null); tiebreaker by
    // positionIndex puts "alien" (pi=1) before "uns" (pi=2).
    assert.deepEqual(ids(out), ["mon", "alien", "uns"]);
  });
});
