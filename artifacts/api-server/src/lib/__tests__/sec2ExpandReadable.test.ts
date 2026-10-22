// SEC-2 #3 — POST /wizard/expand composes only meals the caller may read.
//
// The candidate (with its storeSlots) is echoed by the client. Before this,
// expandCandidate handed every echoed id to composeStoreMealDetails, which
// loads a meal by id with no owner test — so any meal id, another member's
// private recipe or an archived one, came back composed on the wire.
//
// The stub's meal.findMany EVALUATES the where clause over a small table, so a
// wrong predicate (or none) shows up as a composed private meal.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { expandCandidate } from "../wizardExpansion";
import type { runAICall as RunAICall } from "../ai/runAICall";
import type { WizardExpandRequest } from "../ai/schemas/wizard";

interface Row {
  id: string;
  userId: string | null;
  isPublic: boolean;
  isArchived: boolean;
}
const TABLE: Row[] = [
  { id: "catalog", userId: null, isPublic: true, isArchived: false },
  { id: "a-own-private", userId: "user-a", isPublic: false, isArchived: false },
  { id: "b-private", userId: "user-b", isPublic: false, isArchived: false },
  { id: "b-published", userId: "user-b", isPublic: true, isArchived: false },
  { id: "archived-public", userId: null, isPublic: true, isArchived: true },
];

type Where = {
  id: { in: string[] };
  isArchived?: boolean;
  isPublic?: boolean;
  userId?: string | null;
  OR?: Array<{ isPublic?: boolean; userId?: string }>;
};
function matches(r: Row, w: Where): boolean {
  if (!w.id.in.includes(r.id)) return false;
  if (w.isArchived !== undefined && r.isArchived !== w.isArchived) return false;
  if (w.isPublic !== undefined && r.isPublic !== w.isPublic) return false;
  if (w.userId !== undefined && r.userId !== w.userId) return false;
  if (w.OR && !w.OR.some((c) => (c.isPublic === undefined || r.isPublic === c.isPublic) && (c.userId === undefined || r.userId === c.userId))) return false;
  return true;
}

let composed: string[] = [];
function composableMeal(id: string) {
  return {
    id,
    title: `Meal ${id}`,
    description: `The recipe of ${id}`,
    cuisineType: "italian",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    servingsDefault: 2,
    dishLinks: [
      {
        positionIndex: 0,
        roleLabel: "main",
        dish: {
          title: `Dish ${id}`,
          caloriesPerServing: 500,
          proteinGPerServing: 30,
          carbsGPerServing: 40,
          fatGPerServing: 20,
          dishIngredients: [
            { quantity: 1, unit: "cup", preparationNote: null, isOptional: false, ingredient: { displayName: "tomato" } },
          ],
        },
      },
    ],
  };
}

const prisma = {
  userPreferences: { findUnique: async () => null },
  playlistMeal: { count: async () => 0 },
  meal: {
    findMany: async ({ where }: { where: Where }) =>
      TABLE.filter((r) => matches(r, where)).map(({ id, userId, isPublic }) => ({ id, userId, isPublic })),
    // composeStoreMealDetails' read: it has no owner test of its own, which is
    // the whole finding. Record what it was asked for.
    findUnique: async ({ where }: { where: { id: string } }) => {
      composed.push(where.id);
      return TABLE.some((r) => r.id === where.id) ? composableMeal(where.id) : null;
    },
  },
  ingredient: { findMany: async () => [] },
  ingredientAlias: { findMany: async () => [] },
} as unknown as PrismaClient;

// A live slot (a dropped store slot, for a member) reaches the model; answer
// as runAICall does with no key, so the expand ends without one.
const failingAI = (async () => ({
  success: false,
  reason: "no_api_key",
  userFacingMessage: "no model in this test",
  internalError: "no model in this test",
})) as unknown as typeof RunAICall;

const ALL = TABLE.map((r) => r.id);
function request(): WizardExpandRequest {
  return {
    candidate: {
      id: "cand-sec2",
      title: "Echoed candidate",
      mealTitles: ALL.map((id) => `Title ${id}`),
      tags: [],
      whyBullets: ["because"],
      storeSlots: ALL.map((id, slotIndex) => ({ slotIndex, storeMealId: id })),
    },
    candidateContext: {
      householdSize: 2,
      planDurationDays: ALL.length,
      difficulty: "easy",
      weeklyPacing: "mostly_easy",
      cuisines: [],
      eatingStyles: [],
      allergiesAndAvoidances: [],
    },
  } as unknown as WizardExpandRequest;
}

beforeEach(() => {
  composed = [];
});

describe("SEC-2 #3 — expand composes only readable store meals", () => {
  it("a member composes their own and pool meals; another member's private and archived ids are never read", async () => {
    await expandCandidate({
      prisma,
      userId: "user-a",
      request: request(),
      runAICall: failingAI,
      estimateDishMacrosImpl: (async () => {
        throw new Error("no model");
      }) as never,
    });
    assert.deepEqual(composed.sort(), ["a-own-private", "b-published", "catalog"]);
  });

  it("a guest composes catalog rows only — the dropped slots become the thin-shelf door", async () => {
    const result = await expandCandidate({
      prisma,
      userId: "gs-1",
      guestSessionId: "gs-1",
      catalogOnly: true,
      request: request(),
      runAICall: failingAI,
    });
    assert.deepEqual(composed, ["catalog"]);
    assert.equal(result.status, "catalog_only_gap");
    if (result.status === "catalog_only_gap") {
      assert.deepEqual(
        result.liveSlotTitles.sort(),
        ["Title a-own-private", "Title archived-public", "Title b-private", "Title b-published"],
      );
    }
  });
});
