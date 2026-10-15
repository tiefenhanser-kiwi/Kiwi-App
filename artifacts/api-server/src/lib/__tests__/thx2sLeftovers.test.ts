// THX-2S Part F (D-WS9-311) — Friday's leftovers are never bought.
//
// The Classic Friday (turkey, cranberry & stuffing sandwiches) carries three
// fromLeftovers lines; grocery generation skips them and the list carries one
// note instead.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  consolidatePlanIngredients,
  leftoversNote,
  leftoversNoteForPlan,
} from "../groceryList";

const USER = "thx2s-f-user";

function line(id: string, name: string, quantity: number, unit: string, fromLeftovers: boolean) {
  return {
    id, quantity, unit, preparationNote: null, isOptional: false, fromLeftovers,
    ingredient: {
      id: `ing-${id}`, canonicalName: name, displayName: name, category: "Pantry",
      purchaseUnit: null, purchaseQuantity: null, purchaseDisplay: null,
      conversionRef: null, packYieldUnit: null, packYieldPerPack: null,
    },
  };
}

const FRIDAY_PLAN = {
  id: "plan-fri",
  userId: USER,
  items: [
    {
      id: "pi-fri",
      mealId: "m-fri",
      positionIndex: 0,
      servingsOverride: null,
      recipeOverrideJson: null,
      meal: {
        id: "m-fri",
        dishLinks: [
          {
            positionIndex: 0,
            dish: {
              id: "d-sandwich",
              title: "Turkey, Cranberry and Stuffing Sandwiches",
              servingsDefault: 4,
              authoredServingsDefault: 4,
              dishIngredients: [
                line("t", "cooked leftover turkey", 24, "ounce", true),
                line("c", "leftover cranberry-orange sauce", 0.75, "cup", true),
                line("s", "leftover stuffing", 2, "cup", true),
                line("b", "sandwich bread", 8, "slice", false),
              ],
            },
          },
        ],
      },
    },
  ],
  user: { pantryStaples: [], preferences: null },
};

describe("grocery generation skips fromLeftovers lines", () => {
  it("the Classic Friday buys the bread, not the turkey, cranberry sauce or stuffing", async () => {
    const prisma = { mealPlanInstance: { findUnique: async () => FRIDAY_PLAN } } as unknown as PrismaClient;
    const out = await consolidatePlanIngredients({ prisma, planId: "plan-fri", userId: USER });
    assert.deepEqual(out.map((i) => i.canonicalName), ["sandwich bread"]);
  });
});

describe("the leftovers note", () => {
  it("names each leftover once, without the 'cooked leftover' prefix", () => {
    assert.equal(
      leftoversNote(["cooked leftover turkey", "leftover cranberry-orange sauce", "leftover stuffing", "Leftover Turkey"]),
      "Uses Thursday's leftovers: turkey, cranberry-orange sauce, stuffing.",
    );
    assert.equal(leftoversNote([]), null);
  });

  it("leftoversNoteForPlan reads only fromLeftovers lines of THIS plan's meals", async () => {
    let where: unknown;
    const prisma = {
      dishIngredient: {
        findMany: async (args: { where: unknown }) => {
          where = args.where;
          return [{ ingredient: { canonicalName: "cooked leftover turkey" } }];
        },
      },
    };
    assert.equal(await leftoversNoteForPlan(prisma as never, "plan-fri"), "Uses Thursday's leftovers: turkey.");
    assert.deepEqual(where, {
      fromLeftovers: true,
      dish: { mealLinks: { some: { meal: { planItems: { some: { mealPlanInstanceId: "plan-fri" } } } } } },
    });
  });
});
