// WS9 Redesign Arc Block 1 — the Pick screen's composition, pure. Literal
// expectations for the dial arithmetic (D-WS9-245 first setting) and the
// three-source order (pinned → playlist → shelf).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  composeShelf,
  orderShelfByDiscovery,
  shelfRemainderFor,
} from "../store/shelfCompose";

const shelfOf = (ids: string[], fresh: string[]) =>
  ids.map((id) => ({ id, isNewToYou: fresh.includes(id) }));

describe("shelfRemainderFor — playlist level → counts against size", () => {
  it("none / omitted claims nothing", () => {
    assert.deepEqual(
      shelfRemainderFor({ size: 15, pinnedCount: 0, playlistEligibleCount: 9, playlistLevel: "none" }),
      { pinnedCount: 0, playlistCount: 0, shelfRemainder: 15 },
    );
  });
  it("some = ceil(size × 0.3), mostly = ceil(size × 0.7)", () => {
    assert.deepEqual(
      shelfRemainderFor({ size: 15, pinnedCount: 0, playlistEligibleCount: 9, playlistLevel: "some" }),
      { pinnedCount: 0, playlistCount: 5, shelfRemainder: 10 },
    );
    assert.deepEqual(
      shelfRemainderFor({ size: 15, pinnedCount: 0, playlistEligibleCount: 9, playlistLevel: "mostly" }),
      { pinnedCount: 0, playlistCount: 9, shelfRemainder: 6 }, // ceil(10.5)=11, capped by 9 eligible
    );
    assert.deepEqual(
      shelfRemainderFor({ size: 10, pinnedCount: 0, playlistEligibleCount: 20, playlistLevel: "mostly" }),
      { pinnedCount: 0, playlistCount: 7, shelfRemainder: 3 },
    );
  });
  it("all = every eligible playlist meal and NOTHING from the shelf", () => {
    assert.deepEqual(
      shelfRemainderFor({ size: 15, pinnedCount: 0, playlistEligibleCount: 4, playlistLevel: "all" }),
      { pinnedCount: 0, playlistCount: 4, shelfRemainder: 0 },
    );
    // Even when the playlist is thinner than size, the shelf stays empty.
    assert.deepEqual(
      shelfRemainderFor({ size: 15, pinnedCount: 0, playlistEligibleCount: 0, playlistLevel: "all" }),
      { pinnedCount: 0, playlistCount: 0, shelfRemainder: 0 },
    );
  });
  it("pins count against size before the playlist", () => {
    assert.deepEqual(
      shelfRemainderFor({ size: 5, pinnedCount: 2, playlistEligibleCount: 9, playlistLevel: "mostly" }),
      { pinnedCount: 2, playlistCount: 3, shelfRemainder: 0 }, // ceil(3.5)=4 wanted, room 3
    );
    assert.deepEqual(
      shelfRemainderFor({ size: 3, pinnedCount: 5, playlistEligibleCount: 9, playlistLevel: "some" }),
      { pinnedCount: 3, playlistCount: 0, shelfRemainder: 0 },
    );
  });
});

describe("orderShelfByDiscovery", () => {
  const rows = shelfOf(["a", "b", "c", "d", "e", "f"], ["c", "e", "f"]);

  it("undefined = the shelf's own order (today)", () => {
    assert.deepEqual(orderShelfByDiscovery(rows, undefined, 6).map((r) => r.id), [
      "a", "b", "c", "d", "e", "f",
    ]);
  });
  it("none = familiar first, new fills", () => {
    assert.deepEqual(orderShelfByDiscovery(rows, "none", 6).map((r) => r.id), [
      "a", "b", "d", "c", "e", "f",
    ]);
  });
  it("some = at least ceil(remainder × 0.3) new-to-you first, then the rest by rank", () => {
    // remainder 6 → 2 new lead; then a, b, d, e, f in rank order (c taken).
    assert.deepEqual(orderShelfByDiscovery(rows, "some", 6).map((r) => r.id), [
      "c", "e", "a", "b", "d", "f",
    ]);
  });
  it("mostly = ceil(remainder × 0.7) new first when available", () => {
    // remainder 6 → 5 wanted, 3 available → all three lead.
    assert.deepEqual(orderShelfByDiscovery(rows, "mostly", 6).map((r) => r.id), [
      "c", "e", "f", "a", "b", "d",
    ]);
  });
  it("all = every new-to-you first", () => {
    assert.deepEqual(orderShelfByDiscovery(rows, "all", 6).map((r) => r.id), [
      "c", "e", "f", "a", "b", "d",
    ]);
  });
});

describe("composeShelf — pinned → playlist → shelf, sized", () => {
  it("orders the three sources and trims to size", () => {
    const r = composeShelf({
      size: 6,
      pinnedIds: ["pin1"],
      playlistIds: ["pl1", "pl2", "pl3"],
      playlistLevel: "some", // ceil(6 × 0.3) = 2
      shelf: shelfOf(["s1", "s2", "s3", "s4", "s5"], ["s3"]),
      discoveryLevel: undefined,
    });
    assert.deepEqual(
      r.meals.map((m) => `${m.id}:${m.source}${m.isPinned ? ":pinned" : ""}`),
      ["pin1:shelf:pinned", "pl1:playlist", "pl2:playlist", "s1:shelf", "s2:shelf", "s3:shelf"],
    );
    assert.equal(r.pinnedCount, 1);
    assert.equal(r.playlistCount, 2);
    assert.equal(r.shelfRemainder, 3);
  });

  it("playlist all → no shelf rows even when the shelf has them", () => {
    const r = composeShelf({
      size: 10,
      pinnedIds: [],
      playlistIds: ["pl1", "pl2"],
      playlistLevel: "all",
      shelf: shelfOf(["s1", "s2"], []),
      discoveryLevel: undefined,
    });
    assert.deepEqual(r.meals.map((m) => m.id), ["pl1", "pl2"]);
    assert.equal(r.shelfRemainder, 0);
  });

  it("a pinned id that is also on the shelf is not shown twice", () => {
    const r = composeShelf({
      size: 4,
      pinnedIds: ["s2"],
      playlistIds: [],
      playlistLevel: "none",
      shelf: shelfOf(["s1", "s2", "s3", "s4"], []),
      discoveryLevel: undefined,
    });
    assert.deepEqual(r.meals.map((m) => m.id), ["s2", "s1", "s3", "s4"]);
  });

  it("discovery reorders the shelf slice only", () => {
    const r = composeShelf({
      size: 4,
      pinnedIds: [],
      playlistIds: ["pl1"],
      playlistLevel: "some", // ceil(1.2) = 2 wanted, 1 eligible → remainder 3
      shelf: shelfOf(["s1", "s2", "s3", "s4"], ["s4"]),
      discoveryLevel: "all",
    });
    assert.deepEqual(r.meals.map((m) => m.id), ["pl1", "s4", "s1", "s2"]);
  });
});
