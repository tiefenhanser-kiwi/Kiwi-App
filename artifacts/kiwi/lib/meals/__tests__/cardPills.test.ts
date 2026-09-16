// WS9 Redesign Arc Block 2c Part F — BUG-284 regression: the pill list is
// unique (case-insensitive, first wins), so keying on the text cannot collide.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { MealPickCard } from "@/components/MealPickCard";
import type { ShelfMeal } from "@/lib/api/wizard";
import { cardPills } from "../cardPills";

test("cardPills: the catalog's repeated difficulty / lower-cased cuisine collapse, first wins", () => {
  assert.deepEqual(
    cardPills({ cuisineType: "American", difficulty: "medium", tags: ["american", "medium", "weeknight"] }),
    ["American", "medium", "weeknight"],
  );
});

test("cardPills: blanks and nulls drop; duplicate tags within tags collapse", () => {
  assert.deepEqual(
    cardPills({ cuisineType: null, difficulty: "easy", tags: ["  ", "quick", "Quick", "easy"] }),
    ["easy", "quick"],
  );
  assert.deepEqual(cardPills({}), []);
});

test("BUG-284: a shelf card whose tags repeat its difficulty renders without a duplicate-key warning", async () => {
  const meal: ShelfMeal = {
    id: "m1",
    title: "Chicken Caesar Wrap",
    description: null,
    cuisineType: "American",
    difficulty: "medium",
    estimatedTimeMinutes: 30,
    activeTimeMinutes: 15,
    macrosPerServing: { calories: 500, protein: 30, carbs: 40, fat: 20 },
    tags: ["american", "medium"],
    dishCount: 1,
    isNewToYou: false,
    isPlaylist: false,
    isPinned: false,
    matchesCuisine: true,
    source: "catalog",
  };
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(MealPickCard, {
          meal,
          selected: false,
          capMinutes: null,
          onToggle: () => {},
        }),
      );
    });
  } finally {
    console.error = orig;
  }
  assert.equal(
    errors.filter((e) => e.includes("same key")).length,
    0,
    `duplicate-key warnings: ${errors.join(" | ")}`,
  );
  const texts: string[] = [];
  const walk = (n: unknown): void => {
    if (n == null) return;
    if (typeof n === "string") return void texts.push(n);
    if (Array.isArray(n)) return n.forEach(walk);
    const j = n as { children?: unknown[] | null };
    (j.children ?? []).forEach(walk);
  };
  walk(renderer!.toJSON());
  // The card shows ONE "medium" and ONE "American" (not "American" + "american").
  assert.equal(texts.filter((t) => t === "medium").length, 1);
  assert.equal(texts.filter((t) => t.toLowerCase() === "american").length, 1);
  await act(async () => renderer!.unmount());
});
