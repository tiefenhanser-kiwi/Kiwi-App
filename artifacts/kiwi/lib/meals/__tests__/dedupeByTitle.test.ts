// WS9 3f-4 (Thread E, §5.1) — candidate de-duplication for BUG-058's client
// half. Realistic fixtures: distinct records that share a normalized title (the
// shape the DB measurement found in real user libraries), NOT one clean row per
// dish.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dedupeMealsByTitle,
  normalizeMealTitleKey,
} from "../dedupeByTitle";

test("normalizeMealTitleKey: lowercases, trims, collapses whitespace, strips trailing punctuation", () => {
  assert.equal(normalizeMealTitleKey("  Beef   Tacos  "), "beef tacos");
  assert.equal(normalizeMealTitleKey("Beef Tacos."), "beef tacos");
  assert.equal(normalizeMealTitleKey("BEEF TACOS!"), "beef tacos");
  assert.equal(normalizeMealTitleKey("Beef Tacos"), normalizeMealTitleKey("beef tacos"));
});

test("dedupeMealsByTitle: collapses DISTINCT records that share a normalized title", () => {
  // Mirrors the measured reality: three separate ids, same dish. An id-key would
  // miss all three; dishFamilyKey is null on user meals, so title is the key.
  const meals = [
    { id: "a1", title: "Beef Tacos" },
    { id: "b2", title: "beef tacos" },
    { id: "c3", title: "Beef Tacos." },
    { id: "d4", title: "Chicken Tikka Masala" },
  ];
  const out = dedupeMealsByTitle(meals);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((m) => m.id),
    ["a1", "d4"],
    "keeps the FIRST occurrence of each dish and drops later duplicates",
  );
});

test("dedupeMealsByTitle: keeps the highest-ranked instance and never reorders survivors", () => {
  // Applied to an AI-ranked list, position == rank. Dropping a lower-ranked dup
  // must not reorder the meals that survive.
  const ranked = [
    { id: "r1", title: "Spaghetti Carbonara" }, // rank 1 — keep
    { id: "r2", title: "Cacio e Pepe" }, // rank 2 — keep
    { id: "r3", title: "spaghetti carbonara" }, // rank 3 dup of r1 — drop
    { id: "r4", title: "Bucatini Amatriciana" }, // rank 4 — keep
  ];
  const out = dedupeMealsByTitle(ranked);
  assert.deepEqual(
    out.map((m) => m.id),
    ["r1", "r2", "r4"],
    "survivors stay in rank order; only the lower-ranked dup is removed",
  );
});

test("dedupeMealsByTitle: subsumes the id-repeat case (same id ⇒ same title)", () => {
  const withRepeat = [
    { id: "x", title: "Chicken Parmesan" },
    { id: "x", title: "Chicken Parmesan" },
    { id: "x", title: "Chicken Parmesan" },
  ];
  const out = dedupeMealsByTitle(withRepeat);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "x");
});

test("dedupeMealsByTitle: no duplicates → identity (order + length preserved)", () => {
  const meals = [
    { id: "1", title: "A" },
    { id: "2", title: "B" },
    { id: "3", title: "C" },
  ];
  const out = dedupeMealsByTitle(meals);
  assert.deepEqual(out.map((m) => m.id), ["1", "2", "3"]);
});
