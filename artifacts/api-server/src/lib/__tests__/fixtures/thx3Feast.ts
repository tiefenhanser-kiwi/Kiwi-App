// THX-3 — a small Thanksgiving feast for the prep tests, shaped on dev's Classic
// and Make-Ahead rows: a wet-brined turkey (salt, sugar, a gallon of cold water and
// a brining bag), a pumpkin pie whose purée is filed Pantry (Make-Ahead's row) with
// its vanilla, and a cranberry sauce with fresh cranberries filed Pantry.
// `makeAhead` on a dish is what the loader sets from its `ahead-*` / `brine-*` tags.

const M = "f0000000-0000-4000-8000-000000000001";
const D = (n: number) => `fd000000-0000-4000-8000-00000000000${n}`;
const I = (n: number) => `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ing = (n: number, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
  ingredientId: I(n), ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});
const step = (stepIndex: number, phaseType: string, text: string, ids: number[]) => ({
  stepIndex, phaseType, text, componentKey: null, ingredientIds: ids.map(I),
});
const dish = (n: number, dishName: string, ingredients: ReturnType<typeof ing>[], componentSteps: ReturnType<typeof step>[], makeAhead?: string[]) => ({
  dishId: D(n), dishName, dishRole: "side" as const, baseServings: 10, authoredBaseServings: 10, ingredients,
  stepTexts: componentSteps.map((s) => s.text), componentSteps,
  ...(makeAhead ? { makeAheadDays: makeAhead } : {}),
});

export const FEAST_MEAL = M;
export const TURKEY = D(1);
export const PIE = D(2);
export const CRANBERRY = D(3);

export interface FeastOpts {
  /** Tag the dishes make-ahead as the generator does (turkey brine-wed, pie ahead-wed, sauce ahead-mon). */
  makeAhead?: boolean;
  servings?: number | null;
  feast?: boolean;
}

/** The loader result for a plan holding only the feast, Thursday, read on Sunday (lag 4). */
export function thx3Feast(o: FeastOpts = {}): unknown {
  const ma = (days: string[]) => (o.makeAhead ? days : undefined);
  return {
    input: {
      planId: "f2000000-0000-4000-8000-000000000001",
      planName: "THX-3 feast",
      meals: [{
        mealId: M, mealName: "THX-3 Thanksgiving", cuisine: null, servingsOverride: o.servings ?? null,
        ...(o.feast === false ? {} : { feast: true as const }),
        dishes: [
          dish(1, "Herb-Roasted Whole Turkey", [
            ing(1, "whole turkey", "Protein", 14, "pound", "neck and giblets reserved"),
            ing(2, "kosher salt", "Pantry", 0.5, "cup", "for brine"),
            ing(3, "cold water", "Pantry", 1, "gallon", "for brine"),
            ing(4, "light brown sugar", "Pantry", 0.25, "cup", "for brine"),
            ing(5, "large brining bag", "Pantry", 1, "each", "food-safe"),
            ing(6, "black peppercorns", "Pantry", 1, "tablespoon", "for brine"),
            ing(7, "bay leaves", "Pantry", 3, "each", "for brine"),
            ing(8, "black pepper", "Pantry", 1, "teaspoon", "for herb butter"),
            ing(9, "fresh thyme", "Produce", 6, "sprig", "3 for brine, 3 for herb butter"),
          ], [
            step(0, "prep", "Make ahead (Wednesday night): Dissolve ½ cup kosher salt and ¼ cup light brown sugar in 1 gallon cold water in a large brining bag.", [2, 4, 3, 5]),
            step(1, "prep", "Make ahead (Wednesday night): Add 1 tablespoon black peppercorns, 3 thyme sprigs and 3 bay leaves to the brine.", [6, 9, 7]),
            step(2, "prep", "Make ahead (Wednesday night): Mash the softened butter with 1 teaspoon black pepper and the chopped thyme.", [8]),
            step(3, "cook", "On Thursday: Roast the turkey at 325°F for 3 hours.", [1]),
          ], ma(["wed"])),
          dish(2, "Pumpkin Pie", [
            ing(10, "pumpkin purée", "Pantry", 30, "ounce", "two 15-oz cans"),
            ing(11, "large eggs", "Dairy", 4, "each"),
            ing(12, "heavy cream", "Dairy", 1.5, "cup"),
            ing(13, "packed light brown sugar", "Pantry", 1, "cup"),
            ing(14, "ground cinnamon", "Pantry", 2, "teaspoon"),
            ing(15, "ground nutmeg", "Pantry", 0.5, "teaspoon"),
            ing(16, "ground cloves", "Pantry", 0.25, "teaspoon"),
            ing(17, "kosher salt", "Pantry", 0.5, "teaspoon"),
            ing(18, "vanilla extract", "Pantry", 2, "teaspoon"),
          ], [
            step(0, "preheat", "Make ahead (Wednesday): Preheat the oven to 425°F.", []),
            step(1, "prep", "Make ahead (Wednesday): In a large bowl, whisk together 30 oz pumpkin purée, 4 eggs, 1½ cups heavy cream, 1 cup brown sugar, 2 teaspoons cinnamon, ½ teaspoon nutmeg, ¼ teaspoon cloves, ½ teaspoon salt and 2 teaspoons vanilla extract.", [10, 11, 12, 13, 14, 15, 16, 17, 18]),
            step(2, "cook", "Make ahead (Wednesday): Bake 55 minutes, until the center barely jiggles.", []),
          ], ma(["wed"])),
          dish(3, "Cranberry-Orange Sauce", [
            ing(20, "fresh cranberries", "Pantry", 24, "ounce", "rinsed and picked over"),
            ing(21, "granulated sugar", "Pantry", 1.5, "cup"),
            ing(22, "orange", "Produce", 2, "each", "zested and juiced"),
            ing(23, "water", "Pantry", 0.5, "cup"),
            ing(24, "cinnamon stick", "Pantry", 1, "each"),
            ing(25, "kosher salt", "Pantry", 1, "pinch"),
          ], [
            step(0, "prep", "Make ahead (Monday): Zest and juice 2 oranges.", [22]),
            step(1, "cook", "Make ahead (Monday): Combine 24 oz cranberries, 1½ cups sugar, the orange juice and zest, ½ cup water, 1 cinnamon stick and a pinch of salt in a saucepan.", [20, 21, 23, 24, 25]),
            step(2, "cook", "Make ahead (Monday): Simmer 15 minutes until the berries burst.", []),
          ], ma(["mon"])),
        ],
      }],
    },
    cookDays: {
      prepDay: null,
      lagByMealId: new Map([[M, 4]]),
      dayNameByMealId: new Map([[M, "Thursday"]]),
    },
    identity: undefined,
  };
}
