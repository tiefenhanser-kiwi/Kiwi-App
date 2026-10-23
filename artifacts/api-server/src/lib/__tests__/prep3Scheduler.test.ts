// PREP-3 — the weeknight scheduler: a dish that uses another dish waits for it (R7).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dishUses, scheduleCookingSequence, titleFoods, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string) => ({ stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null });
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof st>[], ingredientNames: string[] = []): SchedulerDish => ({ dishId, title, positionIndex, roleLabel: null, steps, ingredientNames });

// hh4-mixed Friday, as dumped (dump0): the subs were filled at T−7 while the meatballs
// simmered "until cooked through" to T+0.
const MEATBALLS = dish("mb", "Beef and Pork Meatballs in Marinara", 0, [
  st(0, "prep", 3, "Combine ½ cup plain breadcrumbs and ¼ cup whole milk in a large bowl and let soak for 2 minutes."),
  st(1, "prep", 5, "Add the ground beef, ground pork, egg, garlic, parsley and Parmesan to the soaked breadcrumbs and mix gently."),
  st(2, "prep", 5, "Roll the meat mixture into 16 equal balls and set on a plate."),
  st(3, "preheat", 2, "Heat 2 tablespoons olive oil in a large, wide skillet over medium-high heat until shimmering."),
  st(4, "cook", 8, "Sear the meatballs in a single layer, turning every 1–2 minutes, until browned on all sides."),
  st(5, "cook", 1, "Push the meatballs to the side, add the sliced garlic, and sauté 30 seconds."),
  st(6, "cook", 2, "Pour in the crushed San Marzano tomatoes, stir in the basil and sugar; nestle the meatballs into the sauce."),
  st(7, "cook", 20, "Reduce heat to medium-low, cover, and simmer for 20 minutes, until cooked through and the sauce has thickened."),
], ["ground beef", "ground pork", "plain breadcrumbs", "whole milk", "egg", "garlic", "crushed San Marzano tomatoes"]);
const ROLLS = dish("rolls", "Toasted Hoagie Rolls with Melted Provolone", 1, [
  st(0, "preheat", 5, "Position an oven rack 6 inches from the broiler and preheat the broiler to high."),
  st(1, "prep", 3, "Split 4 hoagie rolls lengthwise and spread the cut sides with the softened butter."),
  st(2, "cook", 3, "Arrange the rolls cut-side up on a baking sheet and broil 2–3 minutes until golden."),
  st(3, "assemble", 3, "Spoon 3–4 meatballs with generous marinara into each toasted roll, then lay 2 slices of provolone over the meatballs."),
  st(4, "cook", 3, "Return the loaded rolls to the broiler for 2–3 minutes until the provolone is melted."),
  st(5, "assemble", 1, "Top each sub with 2 fresh basil leaves and serve immediately."),
], ["hoagie rolls", "provolone cheese", "unsalted butter", "fresh basil"]);
const SALAD = dish("salad", "Simple Arugula and Shaved Parmesan Salad", 2, [
  st(0, "prep", 3, "Shave 1 ounce of Parmesan into thin curls."),
  st(1, "prep", 2, "Whisk together the olive oil, lemon juice, salt and pepper in a large bowl."),
  st(2, "assemble", 2, "Add the baby arugula to the bowl, toss with the dressing, scatter the Parmesan over the top and serve immediately."),
], ["baby arugula", "parmesan cheese", "olive oil", "lemon juice"]);

describe("PREP-3 (R7) — a dish that uses another dish waits for it", () => {
  it("titleFoods: each part's noun", () => {
    assert.deepEqual(titleFoods("Beef and Pork Meatballs in Marinara"), ["beef", "meatball", "marinara"]);
    assert.deepEqual(titleFoods("Toasted Hoagie Rolls with Melted Provolone"), ["roll", "provolone"]);
  });

  it("the subs use the meatballs; nothing uses the subs", () => {
    const u = dishUses([MEATBALLS, ROLLS, SALAD]);
    assert.deepEqual(u.map((x) => [x.dishId, x.stepIdx, x.usesDishId, x.doneIdx]), [["rolls", 3, "mb", 7]]);
  });

  it("the meatballs are done before the subs are filled (were T−7 in, done T+0)", () => {
    const r = scheduleCookingSequence([MEATBALLS, ROLLS, SALAD]);
    const at = (d: string, i: number) => r.steps.find((e) => e.dishId === d && e.originalStepIndex === i)!.startOffsetMinutes;
    assert.ok(at("rolls", 3) >= at("mb", 7) + 20, `filled T${at("rolls", 3)}, simmer ends T${at("mb", 7) + 20}`);
    assert.ok(at("rolls", 3) - (at("mb", 7) + 20) <= 3, "and not long after: the meatballs are aligned to the filling");
  });

  it("not a use: a food of the step's own dish, an oven-mate, a time", () => {
    const RICE = dish("rice", "Steamed Jasmine Rice", 0, [st(0, "cook", 15, "Simmer the rice covered for 15 minutes.")], ["jasmine rice", "water"]);
    const FRIED = dish("fried", "Egg Fried Rice", 1, [st(0, "cook", 3, "Add the rice and press it into an even layer.")], ["cold cooked rice", "eggs"]);
    const POTATOES = dish("pot", "Crispy Roasted Potatoes", 2, [st(0, "cook", 30, "Place the potatoes in the 425°F oven alongside the chicken.")], ["potatoes"]);
    const CHICKEN = dish("ch", "Garlic and Lemon Roast Chicken", 3, [st(0, "cook", 60, "Roast the chicken.")], ["whole chicken"]);
    const WHILE = dish("w", "Toasted Rolls", 4, [st(0, "prep", 2, "Split the rolls while the meatballs simmer.")], ["rolls"]);
    assert.deepEqual(dishUses([RICE, FRIED, POTATOES, CHICKEN, WHILE, MEATBALLS]), []);
  });

  it("each uses the other: neither waits", () => {
    const A = dish("a", "Chile-Braised Goat Birria", 0, [st(0, "assemble", 2, "Ladle the consommé into bowls.")], ["goat"]);
    const B = dish("b", "Birria Consommé", 1, [st(0, "assemble", 2, "Spoon the birria into the bowls.")], ["broth"]);
    assert.deepEqual(dishUses([A, B]), []);
  });
});
