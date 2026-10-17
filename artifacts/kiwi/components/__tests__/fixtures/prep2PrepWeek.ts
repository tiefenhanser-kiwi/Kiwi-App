// PREP-2 item 5 — the Prep the Week fixture. At ordinary text the screen is pinned
// byte-for-byte to the pre-PREP-2 render (prep2PrepWeek.pre.json, written by
// genPrep2PrepWeek.ts from 5c2233b's PrepWeekView + CookFooter); the large-text
// shape is asserted in PrepWeekView.test.ts.

import type { PrepWeekResult } from "@/lib/api/cooking";
import { buildMealLabelLookup, buildPrepWeekModel } from "@/lib/cooking/prepWeekModel";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";

function result(): PrepWeekResult {
  return {
    totalEstimatedMinutes: 45,
    containerCount: 3,
    statedMinutes: 25,
    phases: [
      { phase: "seasonings_dry", title: "Seasonings & dry", skippable: true, steps: [] },
      { phase: "sauces_marinades", title: "Sauces & marinades", skippable: true, steps: [] },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          {
            number: 1,
            stepKey: `produce#${M1}`,
            title: "Dice onions",
            instructions: "Dice 2 cups onions for the week.",
            estimatedMinutes: 6,
            contributesToMealIds: [M1, M2],
            storageNote: "Airtight, 4 days",
          },
        ],
      },
      {
        phase: "proteins",
        title: "Proteins",
        skippable: false,
        steps: [
          {
            number: 2,
            stepKey: `proteins#${M1}`,
            title: "Trim chicken",
            instructions: "Trim 2 lb chicken thighs.",
            estimatedMinutes: 10,
            contributesToMealIds: [M1],
          },
        ],
      },
    ],
  } as PrepWeekResult;
}

/** The view's props, less the callbacks (the caller adds them). */
export function prepWeekFixture() {
  return {
    planName: "Hearty Week",
    title: "Prep the feast",
    notice: "For Wednesday, the day before the feast.",
    vm: buildPrepWeekModel(result(), {
      mealLabel: buildMealLabelLookup([
        { mealId: M1, assignedDayOfWeek: "Tuesday", meal: { title: "Chicken Fajitas" } },
        { mealId: M2, assignedDayOfWeek: "Wednesday", meal: { title: "Veggie Risotto" } },
      ]),
    }),
    mealCount: 2,
    phaseIndex: 2,
    toastVisible: false,
    advanceToast: null,
  };
}
