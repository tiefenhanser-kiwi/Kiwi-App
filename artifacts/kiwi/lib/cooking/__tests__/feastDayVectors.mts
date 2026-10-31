// CLIENT-6 A (D-WS9-351) — THE FEAST-DAY VECTORS, SHARED WITH THE SERVER.
//
// ⚠️ .mts ON PURPOSE: artifacts/kiwi is not "type": "module", so a .ts here loads
// as CommonJS under the server's tsx and its named exports vanish. The server
// imports it by the .mjs specifier (TypeScript and tsx both map it to this file).
//
// Two readings decide which of a Thanksgiving dish's steps are the feast day's:
// lib/cooking/feastDay.ts `onTheDaySteps` (Cook Mode) and api-server
// src/lib/mealTiming.ts `onTheDaySteps` (the derived times and the Sequencer).
// They must agree step for step, so both test files read THIS list:
//
//   client  lib/cooking/__tests__/feastDay.test.ts
//   server  src/lib/__tests__/mealTimingBug418.test.ts, as
//           import { FEAST_DAY_VECTORS } from "../../../../kiwi/lib/cooking/__tests__/feastDayVectors.mjs";
//
// ⚠️ NO IMPORTS, NO PATH ALIASES, NO RUNTIME BEYOND LITERALS: the server's tsx and
// tsc load this file from outside their own package. Keep it data.
//
// Expand, then contract: both readings accept "On Thursday:" and "On feast day:"
// (case-insensitive, the same spacing) before any server writes the second.

/** Dev's Classic turkey (b8bdb2a8), up to the first clause of each step. */
export const CLASSIC_TURKEY: readonly string[] = [
  "Thaw (start Friday): If the turkey is frozen, transfer it to the fridge on Friday.",
  "Make ahead (Wednesday night): Dissolve ½ cup kosher salt and ¼ cup light brown sugar in 1 gallon cold water.",
  "Make ahead (Wednesday night): Add 1 tablespoon black peppercorns, 3 thyme sprigs, 2 rosemary sprigs.",
  "Make ahead (Wednesday night): Pat the turkey dry with paper towels and submerge the bird in the brine.",
  "Make ahead (Wednesday night): Mash 6 tablespoons softened butter with 3 minced garlic cloves.",
  "On Thursday: Remove the turkey from the brine, discard the brine, and pat the bird very dry.",
  "Preheat the oven to 325°F.",
  "Loosen the skin over the breast and thighs and rub all of the herb butter directly onto the meat.",
  "Stuff the cavity with the quartered onion; tie the legs together with kitchen twine.",
  "Place the turkey breast side up on a rack and roast at 325°F for 3 to 3½ hours.",
  "Transfer the turkey to a cutting board and let it rest.",
  "Carve the turkey and arrange on a large platter.",
];

/** Dev's Make-Ahead turkey (7bba38a8, "Dry-Brined Roast Turkey"), verbatim. */
export const MAKE_AHEAD_TURKEY: readonly string[] = [
  "Thaw (start Friday): If the turkey is frozen, transfer it to the fridge on Friday — a 14-lb bird takes 3–4 days to thaw fully, so it will be ready by Monday or Tuesday.",
  "Make ahead (Tuesday night): Mix ¼ cup kosher salt, 1 tablespoon black pepper, and 1 teaspoon baking powder in a small bowl.",
  "Make ahead (Tuesday night): Pat the turkey completely dry with paper towels — do not rinse it.",
  "Make ahead (Tuesday night): Rub the salt mixture all over the turkey, including under the breast skin and inside the cavity; set it uncovered on a rack in a roasting pan and refrigerate 36 to 48 hours.",
  "On Thursday: Remove the turkey from the fridge 1 hour before roasting to take the chill off; preheat the oven to 325°F.",
  "Mash 4 tablespoons softened butter with the 6 smashed garlic cloves and stuff the cavity with the lemon halves, quartered onion, 8 thyme sprigs, 4 rosemary sprigs, and 6 sage sprigs.",
  "Rub the outside of the turkey all over with 2 tablespoons olive oil and the garlic butter; tie the legs together with kitchen twine and tuck the wings under.",
  "Place the turkey breast-side up on a rack in the roasting pan and roast at 325°F for about 2½ hours.",
  "Raise the oven to 350°F and put in the Overnight Sage Stuffing and Mashed Potato Casserole.",
  "Keep roasting the turkey at 350°F for about 40 more minutes, until an instant-read thermometer in the thickest part of the thigh reads 165°F.",
  "Transfer the turkey to a cutting board, tent loosely with foil, and let it rest 20–30 minutes before carving; pour the pan drippings into a fat separator to use in the gravy.",
  "Carve the turkey and arrange on a warm platter to serve.",
  "Serve the Dry-Brined Roast Turkey with the Make-Ahead Turkey Gravy, Overnight Sage Stuffing, Mashed Potato Casserole, Cranberry-Orange Sauce and Green Beans with Crispy Shallots.",
];

/** Make-Ahead's stuffing (tagged ahead-wed): the bread dries out on Tuesday. */
export const OVERNIGHT_STUFFING: readonly string[] = [
  "Make ahead (Tuesday): Cut 1½ lb rustic white bread into ¾-inch cubes and leave uncovered.",
  "Make ahead (Wednesday): Melt 8 tablespoons butter in a 12-inch skillet over medium heat.",
  "Make ahead (Wednesday): Stir in the minced garlic, ¼ cup chopped sage.",
  "Make ahead (Wednesday): Toss the dried bread cubes with the cooked vegetable mixture.",
  "Make ahead (Wednesday): Whisk 3 beaten eggs into 3 cups low-sodium stock.",
  "Make ahead (Wednesday): Butter a 9×13-inch baking dish, cover tightly with foil, and refrigerate overnight.",
  "On Thursday: Preheat the oven to 375°F.",
  "Bake the stuffing, still covered in foil, for 30 minutes; uncover and bake 20–25 minutes more.",
  "Serve the stuffing directly from the baking dish.",
];

/** A run whose simmer is unprefixed (the model prefixes only a run's first step). */
export const UNPREFIXED_RUN: readonly string[] = [
  "Make ahead (Monday): Combine the cranberries, sugar and orange juice in a saucepan.",
  "Bring to a boil, then simmer 12–15 minutes until the cranberries burst.",
  "Cool, then refrigerate up to 7 days.",
  "On Thursday: Spoon into a serving bowl.",
];

/** CLIENT-7's five steps (BUG-612): two openings that look like a prefix and are not one. */
export const BUG_612_STEPS: readonly string[] = [
  "Make ahead (Monday): Zest 2 oranges.",
  "On Thursday: Remove the turkey.",
  "Thaw (about 10 minutes) the frozen peas in warm water.",
  "Make ahead (up to 3 days) the gravy: whisk the roux.",
  "Serve.",
];

/** The same steps with every leading "On Thursday:" written "On feast day:". */
export function saidOnFeastDay(steps: readonly string[]): string[] {
  return steps.map((s) => s.replace(/^On Thursday:/, "On feast day:"));
}

export interface FeastDayVector {
  name: string;
  steps: readonly string[];
  /** The indexes `onTheDaySteps` keeps, in order. */
  onTheDay: readonly number[];
}

export const FEAST_DAY_VECTORS: readonly FeastDayVector[] = [
  { name: "Classic turkey, On Thursday:", steps: CLASSIC_TURKEY, onTheDay: [5, 6, 7, 8, 9, 10, 11] },
  { name: "Classic turkey, On feast day:", steps: saidOnFeastDay(CLASSIC_TURKEY), onTheDay: [5, 6, 7, 8, 9, 10, 11] },
  { name: "Make-Ahead turkey, On Thursday:", steps: MAKE_AHEAD_TURKEY, onTheDay: [4, 5, 6, 7, 8, 9, 10, 11, 12] },
  { name: "Make-Ahead turkey, On feast day:", steps: saidOnFeastDay(MAKE_AHEAD_TURKEY), onTheDay: [4, 5, 6, 7, 8, 9, 10, 11, 12] },
  { name: "overnight stuffing, On Thursday:", steps: OVERNIGHT_STUFFING, onTheDay: [6, 7, 8] },
  { name: "overnight stuffing, On feast day:", steps: saidOnFeastDay(OVERNIGHT_STUFFING), onTheDay: [6, 7, 8] },
  { name: "an unprefixed simmer, On Thursday:", steps: UNPREFIXED_RUN, onTheDay: [3] },
  { name: "an unprefixed simmer, On feast day:", steps: saidOnFeastDay(UNPREFIXED_RUN), onTheDay: [3] },
  {
    // A Sunday feast's sauce is made on Thursday: that is a make day, never the token.
    name: "a run made on Thursday (a Sunday feast)",
    steps: [
      "Make ahead (Thursday): Combine the cranberries, sugar and orange juice in a saucepan.",
      "Bring to a boil, then simmer 12–15 minutes until the cranberries burst.",
      "On feast day: Spoon into a serving bowl.",
    ],
    onTheDay: [2],
  },
  {
    // CLIENT-7 C (SERVER-8's ask) — as a Sunday feast is served in release #6: SERVER-8 A
    // shifts "Make ahead (Monday):" three days on to Thursday and keeps the token literal.
    name: "a Sunday feast's Thursday make day beside the literal On Thursday: token",
    steps: [
      "Make ahead (Thursday): cook, stirring occasionally; cover and refrigerate until feast day.",
      "Cook 12 minutes.",
      "On Thursday: Remove the turkey from the brine, discard the brine, and pat the turkey thoroughly dry.",
    ],
    onTheDay: [2],
  },
  {
    // CLIENT-7 C (SERVER-8's ask) — only a step OPENING "Thaw (…):" starts a run. A thaw
    // later in a step is an ordinary step: on the feast day here, so it ends nothing.
    name: "a thaw that is not the step's opening clause",
    steps: [
      "Make ahead (Monday): Zest 2 oranges.",
      "On Thursday: Remove the turkey from the fridge 1 hour before roasting.",
      "If the turkey is still icy inside, thaw (in cold water, breast down): 30 minutes more.",
      "Pat it dry. Thaw (start Friday): a 14-lb bird takes about 4 days to thaw fully before Wednesday's brine.",
      "Roast at 325°F for about 3 hours.",
    ],
    onTheDay: [1, 2, 3, 4],
  },
  {
    // CLIENT-9 C (BUG-612) — CLIENT-7's five steps (api-server scripts/_scratch/client-7/
    // diverge.ts): a run starts at a day prefix only. "Thaw (about 10 minutes) the peas" and
    // "Make ahead (up to 3 days) the gravy:" are ordinary steps on the day. The server read
    // them as runs until SEQ-1 (0effaca5).
    name: "BUG-612: a parenthesis that is not a day starts no run",
    steps: BUG_612_STEPS,
    onTheDay: [1, 2, 3, 4],
  },
  { name: "BUG-612, On feast day:", steps: saidOnFeastDay(BUG_612_STEPS), onTheDay: [1, 2, 3, 4] },
  { name: "no prefixes at all (the Wellington)", steps: ["Chop the mushrooms.", "Bake 30 minutes."], onTheDay: [0, 1] },
  {
    name: "case and leading space, like Thursday's",
    steps: ["Make ahead (Monday): Zest 2 oranges.", "  ON FEAST DAY: Spoon into a bowl.", "Make ahead (Monday): Chill.", "on Thursday: Serve."],
    onTheDay: [1, 3],
  },
  {
    name: "not the prefix: a run goes on through them",
    steps: ["Make ahead (Monday): Zest 2 oranges.", "On feast-day: Spoon into a bowl.", "On the feast day: Serve.", "Feast day: Garnish."],
    onTheDay: [],
  },
];
